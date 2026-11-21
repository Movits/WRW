// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI, sem .env.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { generateMatchesForUser, dismissMatch } from "./matching";
import { users, userProfiles, matches, conexoesParticipantes, conexoesRegistradas } from "../drizzle/schema";
import { apagarPelaChave } from "./test/apagar-pela-chave";

/**
 * Prova comportamental contra um banco real DE TESTE: a regeneração faz UPSERT
 * (não duplica) e preserva a decisão de dispensar. Roda no CI, que tem um
 * MariaDB de serviço em DATABASE_URL_TESTES; pulado quando essa variável não
 * existe (server/test/setup-banco.ts já trocou DATABASE_URL por ela, então o
 * .env de trabalho, que pode ser produção, nunca é usado aqui). Semeia dois
 * perfis próprios, exercita, e limpa tudo no fim.
 */
const A = 990001;
const B = 990002;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

describe.skipIf(!temBanco)("Match — regeneração não duplica (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await limpar(db);
    // Dois perfis desenhados para casar: mesmo setor + mesmo objetivo buscado
    // dão score ~49 (>= 40), abaixo de 70 para não chamar o LLM.
    for (const id of [A, B]) {
      await db.insert(users).values({ id, openId: `teste-dup-${id}`, isActive: true } as never);
      await db.insert(userProfiles).values({
        userId: id, sector: "tecnologia", seekingTypes: ["investimento"], primarySpecialty: `esp-${id}`,
      } as never);
    }
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) await limpar(db);
  });

  const contarDe = async (userId: number) => {
    const db = (await getDb())!;
    return (await db.select({ id: matches.id }).from(matches).where(eq(matches.userId, userId))).length;
  };

  it("regenerar duas vezes não cria linhas novas", async () => {
    await generateMatchesForUser(A);
    const depoisDa1a = await contarDe(A);
    expect(depoisDa1a).toBeGreaterThan(0); // o par A→B casou

    await generateMatchesForUser(A);
    const depoisDa2a = await contarDe(A);
    expect(depoisDa2a).toBe(depoisDa1a); // upsert: mesmo número, não o dobro
  });

  it("dispensar sobrevive à regeneração e não vira linha nova", async () => {
    const db = (await getDb())!;
    const [par] = await db.select().from(matches).where(and(eq(matches.userId, A), eq(matches.matchedUserId, B)));
    expect(par).toBeDefined();

    await dismissMatch(A, par.id);
    const antes = await contarDe(A);

    await generateMatchesForUser(A);

    const [depois] = await db.select().from(matches).where(and(eq(matches.userId, A), eq(matches.matchedUserId, B)));
    expect(depois.userDismissed).toBe(true);      // decisão preservada
    expect(depois.id).toBe(par.id);               // é a MESMA linha, não uma nova
    expect(await contarDe(A)).toBe(antes);        // nenhuma linha acrescentada
  });
});

async function limpar(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  // A rodada também registra o par como PLATFORM_MATCH (network-registro.ts).
  await apagarPelaChave(db, conexoesRegistradas, eq(conexoesRegistradas.chaveDoPar, `PLATFORM_MATCH|membro:${A}|membro:${B}`));
  for (const id of [A, B]) {
    await apagarPelaChave(db, conexoesParticipantes, eq(conexoesParticipantes.userId, id));
    await apagarPelaChave(db, matches, eq(matches.userId, id));
    await apagarPelaChave(db, matches, eq(matches.matchedUserId, id));
    await apagarPelaChave(db, userProfiles, eq(userProfiles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
