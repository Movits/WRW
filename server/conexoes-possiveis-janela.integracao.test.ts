import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  // server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança).
  process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";
});

/**
 * A janela da leitura das conexões sugeridas contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). Achado 1 da revisão do pacote do match (20/11/2026).
 *
 * A lista da Prata e o número da Bronze (U3) liam só as 50 linhas de nota mais
 * alta da dona e SÓ DEPOIS aplicavam as travas da leitura (o termo dos dois lados
 * e o portão da demanda expressa). O motor não regrava nem apaga o par que o
 * portão passou a bloquear (para a dispensa da dona sobreviver), e a linha velha
 * fica com a nota alta para sempre: com 50 dessas no topo, as válidas da 51ª em
 * diante sumiam da lista e do número, e "Buscar" não resolvia. Desde que o motor
 * guarda as 100 melhores por rodada, a dona passa de 50 linhas com facilidade.
 *
 * Aqui: 50 linhas de nota 90 que o portão esconde (serviço que a dona não
 * declarou precisar) e 10 válidas de nota 60 (o serviço que ela declarou). O
 * número e a lista dão 10. As linhas de `matches` são gravadas aqui, como o motor
 * as teria gravado: a rodada leria as contas dos arquivos que rodam ao mesmo
 * tempo. A LEITURA é a de verdade.
 *
 * As outras contas só oferecem serviço: o portão as esconde de quem não declarou
 * precisar dele, e as rodadas dos outros arquivos não casam com elas.
 */
const { getDb } = await import("./db");
const { users, userProfiles, matches } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { calculateCompatibilityScore } = await import("./matching");
const { apagarPelaChave } = await import("./test/apagar-pela-chave");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const PREFIXO = `teste-janela-${crypto.randomUUID()}`;
const ESCONDIDAS = 50;
const VALIDAS = 10;

const PERFIL_DA_DONA = { displayName: "Dona da janela", city: "Lisboa", whatIHave: ["Vinho do Porto"], whatINeed: ["Tradução juramentada"], whatINeedDetails: [] };
const escondida = (indice: number) => ({ displayName: `Escondida ${indice}`, city: `Cidade-escondida-${indice}`, whatIHave: ["Consultoria em marketing"], whatINeed: [], whatINeedDetails: [] });
const valida = (indice: number) => ({ displayName: `Válida ${indice}`, city: `Cidade-valida-${String(indice).padStart(2, "0")}`, whatIHave: ["Tradução juramentada"], whatINeed: [], whatINeedDetails: [] });

const openIds = [
  `${PREFIXO}-dona`,
  ...Array.from({ length: ESCONDIDAS }, (_, i) => `${PREFIXO}-escondida-${i}`),
  ...Array.from({ length: VALIDAS }, (_, i) => `${PREFIXO}-valida-${i}`),
];
const ids = new Map<string, number>();
const dona = () => ids.get(`${PREFIXO}-dona`)!;

const rota = (role: string) => appRouter.createCaller({
  user: { id: dona(), openId: `${PREFIXO}-dona`, role, onboardingCompleted: true, isActive: true, email: null },
  req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
  res: { cookie: () => {} },
} as never);

async function limpar() {
  const db = await getDb();
  if (!db) return;
  const contas = (await db.select({ id: users.id }).from(users).where(inArray(users.openId, openIds))).map(conta => conta.id);
  if (!contas.length) return;
  // Só as linhas DESTE arquivo, pela chave: as de outra dona que apontem para estas contas são dela.
  await apagarPelaChave(db, matches, inArray(matches.userId, contas));
  await apagarPelaChave(db, userProfiles, inArray(userProfiles.userId, contas));
  await apagarPelaChave(db, users, inArray(users.id, contas));
}

describe.skipIf(!temBanco)("Conexões sugeridas — as travas da leitura vêm antes da janela (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await limpar();
    await db.insert(users).values(openIds.map(openId => ({ openId, name: openId.slice(-14), email: null, role: "bronze" as const, onboardingCompleted: true })));
    for (const conta of await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, openIds))) {
      ids.set(conta.openId, conta.id);
    }
    const escondidas = Array.from({ length: ESCONDIDAS }, (_, i) => ids.get(`${PREFIXO}-escondida-${i}`)!);
    const validas = Array.from({ length: VALIDAS }, (_, i) => ids.get(`${PREFIXO}-valida-${i}`)!);
    await db.insert(userProfiles).values([
      { userId: dona(), ...PERFIL_DA_DONA },
      ...escondidas.map((userId, i) => ({ userId, ...escondida(i) })),
      ...validas.map((userId, i) => ({ userId, ...valida(i) })),
    ]);
    // As linhas que as rodadas teriam deixado: as escondidas de antes da regra (ou de antes de o perfil mudar), com a
    // nota alta de então; as válidas abaixo.
    await db.insert(matches).values([
      ...escondidas.map(matchedUserId => ({ userId: dona(), matchedUserId, overallScore: 90 })),
      ...validas.map(matchedUserId => ({ userId: dona(), matchedUserId, overallScore: 60 })),
    ]);
  }, 60_000);

  afterAll(limpar, 60_000);

  it("pré-condição: o portão esconde as de nota 90 e deixa passar as de nota 60", () => {
    const comoPerfil = (perfil: object) => perfil as Parameters<typeof calculateCompatibilityScore>[0];
    expect(calculateCompatibilityScore(comoPerfil(PERFIL_DA_DONA), comoPerfil(escondida(0))).bloqueio).toBe("servico-sem-demanda-expressa");
    expect(calculateCompatibilityScore(comoPerfil(PERFIL_DA_DONA), comoPerfil(valida(0))).bloqueio).toBeUndefined();
  });

  it("o número da Bronze conta as 10 válidas, embora as 50 linhas de cima sejam escondidas", async () => {
    expect(await rota("bronze").matches.conexoesPossiveis()).toEqual({ total: VALIDAS, listaLiberada: false });
  });

  it("a lista da Prata traz as 10, na ordem do motor (nota, e na mesma nota o id menor), e o corte vem depois das travas", async () => {
    const lista = await rota("silver").matches.list({ limit: 50 });
    expect(lista.map(cartao => cartao.city)).toEqual(Array.from({ length: VALIDAS }, (_, i) => valida(i).city));
    expect((await rota("silver").matches.list({ limit: 5 })).map(cartao => cartao.city)).toEqual(Array.from({ length: 5 }, (_, i) => valida(i).city));
    expect(await rota("silver").matches.conexoesPossiveis()).toEqual({ total: VALIDAS, listaLiberada: true });
  });

  it("a dispensa continua valendo: a válida dispensada sai do número", async () => {
    const db = (await getDb())!;
    await db.update(matches).set({ userDismissed: true })
      .where(and(eq(matches.userId, dona()), eq(matches.matchedUserId, ids.get(`${PREFIXO}-valida-0`)!)));
    expect(await rota("bronze").matches.conexoesPossiveis()).toEqual({ total: VALIDAS - 1, listaLiberada: false });
  });
});
