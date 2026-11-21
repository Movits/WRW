// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI, sem .env.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import crypto from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { generateMatchesForUser, dismissMatch } from "./matching";
import { chaveDoPar } from "./network-registro";
import { users, userProfiles, matches, conexoesParticipantes, conexoesRegistradas } from "../drizzle/schema";
import { apagarPelaChave } from "./test/apagar-pela-chave";

/**
 * Prova comportamental contra um banco real DE TESTE: a regeneração faz UPSERT
 * (não duplica) e preserva a decisão de dispensar. Roda no CI, que tem um
 * MariaDB de serviço em DATABASE_URL_TESTES; pulado quando essa variável não
 * existe (server/test/setup-banco.ts já trocou DATABASE_URL por ela, então o
 * .env de trabalho, que pode ser produção, nunca é usado aqui). Semeia dois
 * perfis próprios, exercita, e limpa tudo no fim.
 *
 * As duas contas têm o id que o banco der, lido de volta pelo openId (com
 * prefixo só desta execução). Com id fixo (990001 e 990002), o INSERT levava o
 * AUTO_INCREMENT de users junto, e quem gravasse com id automático ao mesmo
 * tempo, noutro arquivo, podia pegar o id que este gravaria em seguida.
 */
const PREFIXO = `teste-dup-${crypto.randomUUID()}`;
const OPEN_ID_A = `${PREFIXO}-a`;
const OPEN_ID_B = `${PREFIXO}-b`;
let A = 0;
let B = 0;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

describe.skipIf(!temBanco)("Match — regeneração não duplica (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: OPEN_ID_A, isActive: true }, { openId: OPEN_ID_B, isActive: true }]);
    const contas = await contasDoArquivo(db);
    A = contas.get(OPEN_ID_A)!;
    B = contas.get(OPEN_ID_B)!;
    // Dois perfis desenhados para casar: mesmo setor + mesmo objetivo buscado
    // dão score ~49 (>= 40), abaixo de 70 para não chamar o LLM.
    for (const id of [A, B]) {
      await db.insert(userProfiles).values({
        userId: id, sector: "tecnologia", seekingTypes: ["investimento"], primarySpecialty: `esp-${id}`,
      } as never);
    }
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) await limpar(db);
  });

  // Só as linhas do par deste arquivo. A rodada lê todos os perfis ativos do
  // banco compartilhado, e A (perfil quase vazio, que tira 41 com quase todo
  // mundo) casa com as contas que os outros arquivos de integração criam e apagam
  // ao mesmo tempo: contar todas as linhas de A fazia o resultado depender de
  // quando cada arquivo roda (revisão do pacote do match, 20/11).
  const contarOPar = async () => {
    const db = (await getDb())!;
    return (await db.select({ id: matches.id }).from(matches).where(and(eq(matches.userId, A), eq(matches.matchedUserId, B)))).length;
  };

  it("regenerar duas vezes não cria linhas novas", async () => {
    await generateMatchesForUser(A);
    expect(await contarOPar()).toBe(1); // o par A→B casou

    await generateMatchesForUser(A);
    expect(await contarOPar()).toBe(1); // upsert: a mesma linha, não outra
  });

  it("dispensar sobrevive à regeneração e não vira linha nova", async () => {
    const db = (await getDb())!;
    const [par] = await db.select().from(matches).where(and(eq(matches.userId, A), eq(matches.matchedUserId, B)));
    expect(par).toBeDefined();

    await dismissMatch(A, par.id);

    await generateMatchesForUser(A);

    const [depois] = await db.select().from(matches).where(and(eq(matches.userId, A), eq(matches.matchedUserId, B)));
    expect(depois.userDismissed).toBe(true);      // decisão preservada
    expect(depois.id).toBe(par.id);               // é a MESMA linha, não uma nova
    expect(await contarOPar()).toBe(1);           // nenhuma linha acrescentada ao par
  });
});

type Banco = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** As contas deste arquivo (openId → o id que o banco deu). */
async function contasDoArquivo(db: Banco) {
  const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [OPEN_ID_A, OPEN_ID_B]));
  return new Map(linhas.map(conta => [conta.openId, conta.id]));
}

// Pelo openId desta execução e pela chave, nunca por id fixo.
async function limpar(db: Banco) {
  const contas = await contasDoArquivo(db);
  const [a, b] = [contas.get(OPEN_ID_A), contas.get(OPEN_ID_B)];
  // A rodada também registra o par como PLATFORM_MATCH (network-registro.ts). A chave ordena
  // os dois lados como texto ("membro:10" vem antes de "membro:9"): sai da mesma função.
  if (a !== undefined && b !== undefined) {
    const chave = chaveDoPar("PLATFORM_MATCH", { tipo: "membro", userId: a }, { tipo: "membro", userId: b });
    await apagarPelaChave(db, conexoesRegistradas, eq(conexoesRegistradas.chaveDoPar, chave));
  }
  for (const id of contas.values()) {
    await apagarPelaChave(db, conexoesParticipantes, eq(conexoesParticipantes.userId, id));
    await apagarPelaChave(db, matches, eq(matches.userId, id));
    await apagarPelaChave(db, matches, eq(matches.matchedUserId, id));
    await apagarPelaChave(db, userProfiles, eq(userProfiles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
