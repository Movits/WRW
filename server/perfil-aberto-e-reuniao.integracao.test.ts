import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O Meu Perfil aberto e o item que uma reunião confirma no meio (nota da
 * validação da N5, PR #220), contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). Os dois salvamentos vão pelos procedimentos
 * de verdade: a confirmação do "Sou eu" (networkInteligente.confirmarPendencia)
 * e o salvar do Perfil (profile.update, com a versão que o profile.get deu).
 *
 * - O item confirmado com o Perfil aberto fica, e a edição do Perfil também.
 * - Os dois ao mesmo tempo, várias vezes: o item nunca se perde.
 * - Duas abas do Perfil: a que salva com a versão velha leva CONFLICT, e nada dela é gravado.
 * - O Perfil antigo em cache (sem a versão) grava como antes.
 *
 * Dona com openId aleatório: a limpeza no fim só alcança o que este arquivo criou.
 */
const motor = vi.hoisted(() => ({ rodadas: 0 }));
vi.mock("./matching", async original => {
  const real = await original<typeof import("./matching")>();
  return { ...real, generateMatchesForUser: async () => { motor.rodadas += 1; return 0; } };
});

const { getDb } = await import("./db");
const { networkSugestoes, userProfiles, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { MENSAGEM_PERFIL_MUDOU_NO_MEIO } = await import("@shared/const");
const { lerDemandas } = await import("@shared/o-que-preciso");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-perfil-aberto-${crypto.randomUUID()}`;

const DEMANDA = { id: "d-investidor", category: "investidores", description: "Investidor anjo para a fábrica de cacau" };
const LISTAS_INICIAIS = { whatIHave: ["industria", "Exportar vinho"], whatINeed: ["investidores"], whatINeedDetails: [DEMANDA] };

let idDaDona = 0;
const rota = () => appRouter.createCaller({
  user: { id: idDaDona, openId: DONA, role: "silver", onboardingCompleted: true, email: null },
} as never);
const banco = async () => (await getDb())!;

async function perfilDaDona() {
  const [perfil] = await (await banco()).select().from(userProfiles).where(eq(userProfiles.userId, idDaDona));
  return perfil;
}

/** Uma pendência do "Sou eu" esperando a dona: vai ao PERFIL dela quando ela confirma. */
async function pendenciaDoPerfil(campo: "tenho" | "preciso", valor: string) {
  const id = crypto.randomUUID();
  const agora = Date.now();
  await (await banco()).insert(networkSugestoes).values({
    id, ownerId: DONA, origem: "reuniao", campo, valor, alvo: "perfil", status: "pendente", confianca: "0.900", createdAt: agora, updatedAt: agora,
  });
  return id;
}

/** O que a tela do Perfil manda ao salvar: as listas que ELA carregou, com a edição, e a versão delas. */
function salvarDoPerfil(carregado: Awaited<ReturnType<ReturnType<typeof rota>["profile"]["get"]>>, edicao: { bio: string; whatIHave?: string[] }) {
  const perfil = carregado.profile as Record<string, unknown>;
  return rota().profile.update({
    bio: edicao.bio,
    whatIHave: edicao.whatIHave ?? (perfil.whatIHave as string[]),
    whatINeed: perfil.whatINeed as string[],
    whatINeedDetails: lerDemandas(perfil.whatINeedDetails),
    versaoDasListas: carregado.versaoDasListas,
  });
}

describe.skipIf(!temBanco)("O Meu Perfil aberto e o item que a reunião confirma no meio (integração)", () => {
  beforeAll(async () => {
    const db = await banco();
    await db.insert(users).values({ openId: DONA, name: "Ana Lima", email: null });
    const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
    idDaDona = conta.id;
    await db.insert(userProfiles).values({ userId: idDaDona, displayName: "Ana Lima", ...LISTAS_INICIAIS });
  });

  beforeEach(async () => {
    const db = await banco();
    await db.update(userProfiles).set({ bio: "Bio inicial", ...LISTAS_INICIAIS }).where(eq(userProfiles.userId, idDaDona));
    await apagarPelaChave(db, networkSugestoes, eq(networkSugestoes.ownerId, DONA));
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await apagarPelaChave(db, networkSugestoes, eq(networkSugestoes.ownerId, DONA));
    await apagarPelaChave(db, userProfiles, eq(userProfiles.userId, idDaDona));
    await db.delete(users).where(eq(users.openId, DONA));
  });

  it("o 'tenho' e o 'preciso' confirmados com o Perfil aberto ficam, e a edição do Perfil também", async () => {
    const tenho = await pendenciaDoPerfil("tenho", "Exportar café");
    const preciso = await pendenciaDoPerfil("preciso", "Distribuidor no Chile");
    const aberto = await rota().profile.get();

    // Em outra aba, a dona confirma os dois itens da reunião.
    expect(await rota().networkInteligente.confirmarPendencia({ id: tenho })).toMatchObject({ alvo: "perfil", mudouPerfil: true });
    expect(await rota().networkInteligente.confirmarPendencia({ id: preciso })).toMatchObject({ alvo: "perfil", mudouPerfil: true });

    // De volta ao Perfil aberto: tira "industria", põe "fazenda", troca a bio e salva o que tinha carregado.
    await salvarDoPerfil(aberto, { bio: "Bio editada com o Perfil aberto", whatIHave: ["Exportar vinho", "fazenda"] });

    const perfil = await perfilDaDona();
    expect(perfil.bio).toBe("Bio editada com o Perfil aberto");
    expect(perfil.whatIHave).toEqual(["Exportar vinho", "fazenda", "Exportar café"]);
    expect(perfil.whatINeed).toEqual(["investidores", "outra_necessidade"]);
    expect(perfil.whatINeedDetails).toEqual([DEMANDA, expect.objectContaining({ category: "outra_necessidade", description: "Distribuidor no Chile" })]);

    // A tela relida mostra os dois, e uma nova edição parte da versão nova sem conflito.
    const relido = await rota().profile.get();
    expect(relido.versaoDasListas).not.toBe(aberto.versaoDasListas);
    await salvarDoPerfil(relido, { bio: "Segunda edição" });
    expect((await perfilDaDona()).whatIHave).toEqual(["Exportar vinho", "fazenda", "Exportar café"]);
  });

  it("a confirmação e o salvar ao mesmo tempo, várias vezes: o item da reunião nunca se perde", async () => {
    for (let vez = 1; vez <= 5; vez += 1) {
      const valor = `Item da reunião ${vez}`;
      const pendencia = await pendenciaDoPerfil("tenho", valor);
      const aberto = await rota().profile.get();
      await Promise.all([
        rota().networkInteligente.confirmarPendencia({ id: pendencia }),
        salvarDoPerfil(aberto, { bio: `Bio da vez ${vez}` }),
      ]);
      const perfil = await perfilDaDona();
      expect(perfil.whatIHave).toContain(valor);
      expect(perfil.bio).toBe(`Bio da vez ${vez}`);
    }
  });

  it("duas abas do Perfil: a que salva com a versão velha leva CONFLICT, e nada dela é gravado", async () => {
    const primeira = await rota().profile.get();
    const segunda = await rota().profile.get();
    // A primeira troca um item sem mudar a contagem: só o conteúdo denuncia a mudança.
    await salvarDoPerfil(primeira, { bio: "Bio da primeira aba", whatIHave: ["fazenda", "Exportar vinho"] });

    await expect(salvarDoPerfil(segunda, { bio: "Bio da segunda aba", whatIHave: ["industria", "Exportar vinho", "licencas"] }))
      .rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_PERFIL_MUDOU_NO_MEIO });
    const perfil = await perfilDaDona();
    expect(perfil.bio).toBe("Bio da primeira aba");
    expect(perfil.whatIHave).toEqual(["fazenda", "Exportar vinho"]);
  });

  it("o Perfil antigo em cache (sem a versão) grava o que manda, como antes", async () => {
    await rota().profile.update({ bio: "Bio do Perfil antigo", whatIHave: ["licencas"] });
    expect(await perfilDaDona()).toMatchObject({ bio: "Bio do Perfil antigo", whatIHave: ["licencas"], whatINeed: ["investidores"] });
  });

  it("a versão fora do formato é recusada pela validação, sem gravar", async () => {
    await expect(rota().profile.update({ bio: "Não grava", versaoDasListas: "qualquer-coisa" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await perfilDaDona()).bio).toBe("Bio inicial");
  });
});
