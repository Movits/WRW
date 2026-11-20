import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, or } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * U3, "matches possíveis", contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula): a Bronze vê quantas conexões são possíveis e
 * não vê quem; promovida a Prata, vê a lista, do tamanho do número que via.
 *
 * As linhas de `matches` da Bronze são gravadas aqui, como o motor as teria
 * gravado, e não por uma rodada do motor: a rodada lê como candidatas todas as
 * contas ativas do banco, e as contas dos arquivos que rodam ao mesmo tempo
 * entrariam na conta. A LEITURA é a de verdade: o portão da demanda expressa lê
 * os perfis gravados, e a linha dispensada sai pelo SQL.
 *
 * Contas com openId aleatório: a limpeza no fim só alcança o que este arquivo criou.
 */
const { getDb } = await import("./db");
const { users, userProfiles, matches, conexoesParticipantes, conexoesRegistradas } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const PREFIXO = `teste-u3-${crypto.randomUUID()}`;

/** As outras membras, com dados-sentinela: nada disto pode chegar à Bronze. */
const OUTRAS = {
  // Tem o que a Bronze declarou precisar: par legítimo.
  distribuidora: { role: "silver", nome: "Nome-sentinela-Distribuidora", cidade: "Cidade-sentinela-Porto", whatIHave: ["Rede de distribuidores na Europa"], whatINeed: ["Vinho do Porto"] },
  // Produto, sem serviço: par legítimo (as seis dimensões, sem bloqueio).
  armazem: { role: "silver", nome: "Nome-sentinela-Armazem", cidade: "Cidade-sentinela-Santos", whatIHave: ["Armazém em Santos"], whatINeed: [] },
  // Só serviço, e a Bronze não o declarou: a linha antiga, de nota alta, o portão esconde.
  advocacia: { role: "silver", nome: "Nome-sentinela-Advocacia", cidade: "Cidade-sentinela-Recife", whatIHave: ["Advocacia tributária"], whatINeed: [], sector: "Jurídico" },
  // Par legítimo que a dona já tinha dispensado: não conta.
  vidro: { role: "silver", nome: "Nome-sentinela-Vidro", cidade: "Cidade-sentinela-Curitiba", whatIHave: ["Embalagens de vidro"], whatINeed: [] },
} as const;
type Chave = keyof typeof OUTRAS;

const ids = {} as Record<Chave | "bronze", number>;
const banco = async () => (await getDb())!;

const rota = (role: string) => appRouter.createCaller({
  user: { id: ids.bronze, openId: `${PREFIXO}-bronze`, role, onboardingCompleted: true, isActive: true, email: null },
  req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
  res: { cookie: () => {} },
} as never);

/** Todas as chaves de uma resposta, em qualquer nível. */
function chavesDe(valor: unknown, saida = new Set<string>()): Set<string> {
  if (Array.isArray(valor)) for (const item of valor) chavesDe(item, saida);
  else if (valor && typeof valor === "object") {
    for (const [chave, dentro] of Object.entries(valor)) {
      saida.add(chave);
      chavesDe(dentro, saida);
    }
  }
  return saida;
}

async function limpar() {
  const db = await getDb();
  if (!db) return;
  const contas = await db.select({ id: users.id }).from(users).where(inArray(users.openId, [
    `${PREFIXO}-bronze`, ...Object.keys(OUTRAS).map(chave => `${PREFIXO}-${chave}`),
  ]));
  const contaIds = contas.map(conta => conta.id);
  if (!contaIds.length) return;
  // Uma rodada do motor de outro arquivo pode ter cruzado estas contas e registrado o par.
  const participacoes = await db.select({ conexaoId: conexoesParticipantes.conexaoId }).from(conexoesParticipantes)
    .where(inArray(conexoesParticipantes.userId, contaIds));
  if (participacoes.length) {
    const conexaoIds = participacoes.map(p => p.conexaoId);
    await db.delete(conexoesParticipantes).where(inArray(conexoesParticipantes.conexaoId, conexaoIds));
    await db.delete(conexoesRegistradas).where(inArray(conexoesRegistradas.id, conexaoIds));
  }
  await db.delete(matches).where(or(inArray(matches.userId, contaIds), inArray(matches.matchedUserId, contaIds)));
  await db.delete(userProfiles).where(inArray(userProfiles.userId, contaIds));
  await db.delete(users).where(inArray(users.id, contaIds));
}

describe.skipIf(!temBanco)("U3 — conexões possíveis (integração)", () => {
  beforeAll(async () => {
    const db = await banco();
    await limpar();
    const criar = async (sufixo: string, role: "bronze" | "silver", nome: string) => {
      await db.insert(users).values({ openId: `${PREFIXO}-${sufixo}`, name: nome, email: null, role, onboardingCompleted: true });
      const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, `${PREFIXO}-${sufixo}`));
      return conta.id;
    };
    // A Bronze: cadastro concluído, perfil sem apresentação (não qualifica a Prata).
    ids.bronze = await criar("bronze", "bronze", "Ana U3");
    await db.insert(userProfiles).values({
      userId: ids.bronze, displayName: "Ana U3", city: "Lisboa", whatIHave: ["Vinho do Porto"], whatINeed: ["distribuidores"], whatINeedDetails: [],
    });
    for (const [chave, outra] of Object.entries(OUTRAS) as [Chave, (typeof OUTRAS)[Chave]][]) {
      ids[chave] = await criar(chave, outra.role, outra.nome);
      await db.insert(userProfiles).values({
        userId: ids[chave], displayName: outra.nome, city: outra.cidade, whatIHave: [...outra.whatIHave], whatINeed: [...outra.whatINeed],
        whatINeedDetails: [], sector: "sector" in outra ? outra.sector : null,
      });
    }
    // As linhas que o motor teria gravado para a Bronze.
    await db.insert(matches).values([
      { userId: ids.bronze, matchedUserId: ids.advocacia, overallScore: 95, aiInsight: "Insight-sentinela-Advocacia" },
      { userId: ids.bronze, matchedUserId: ids.distribuidora, overallScore: 85, aiInsight: "Insight-sentinela-Distribuidora" },
      { userId: ids.bronze, matchedUserId: ids.vidro, overallScore: 70, userDismissed: true },
      { userId: ids.bronze, matchedUserId: ids.armazem, overallScore: 60 },
    ]);
  });

  afterAll(limpar);

  it("a Bronze vê o número e não vê quem: matches.list vazio", async () => {
    expect(await rota("bronze").matches.conexoesPossiveis()).toEqual({ total: 2, listaLiberada: false });
    expect(await rota("bronze").matches.list({ limit: 50 })).toEqual([]);
  });

  it("a resposta para a Bronze não traz campo pessoal, id nem nome", async () => {
    const resposta = await rota("bronze").matches.conexoesPossiveis();
    expect([...chavesDe(resposta)].sort()).toEqual(["listaLiberada", "total"]);
    const texto = JSON.stringify(resposta);
    expect(texto).not.toMatch(/sentinela|Lisboa|Ana U3/);
    for (const [chave, id] of Object.entries(ids)) {
      if (id !== resposta.total) expect(texto, chave).not.toContain(String(id));
    }
  });

  it("promovida a Prata, a lista tem o tamanho exato do número que ela via", async () => {
    const { total } = await rota("bronze").matches.conexoesPossiveis();
    await (await banco()).update(users).set({ role: "silver" }).where(eq(users.id, ids.bronze));

    const lista = await rota("silver").matches.list({ limit: 50 });
    expect(lista).toHaveLength(total);
    // A ordem é a da nota; o serviço sem demanda e a dispensada ficaram de fora.
    expect(lista.map(cartao => cartao.city)).toEqual(["Cidade-sentinela-Porto", "Cidade-sentinela-Santos"]);
    // A lista da Prata continua anônima: sem o id da outra membra, sem nome antes do aceite.
    expect(lista.every(cartao => !("matchedUserId" in cartao) && cartao.displayName === null)).toBe(true);
    expect(await rota("silver").matches.conexoesPossiveis()).toEqual({ total, listaLiberada: true });
  });
});
