// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI, sem .env.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { and, asc, between, desc, eq, or } from "drizzle-orm";
import { getDb } from "./db";
import { users, userProfiles, matches } from "../drizzle/schema";

// O termo e o registro PLATFORM_MATCH têm testes próprios; aqui o assunto é a
// leitura dos perfis no banco de verdade (página, ordem, contas ativas).
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));
vi.mock("./network-registro", () => ({ registrarConexoesEntreMembrasDepoisDoCalculo: async () => undefined }));

const { generateMatchesForUser, PERFIS_POR_PAGINA } = await import("./matching");

/**
 * Prova contra um banco real DE TESTE (DATABASE_URL_TESTES; pulado sem ela):
 * a rodada do motor de perfis lê TODAS as páginas de perfis, na ordem do id,
 * só de contas ativas, e quem casa depois dos primeiros 50 (aqui, depois de
 * mais de duas páginas que não casam) aparece. Antes, a leitura tinha
 * `.limit(50)` sem ordem. Semeia os próprios perfis num intervalo de ids só
 * dele e limpa tudo no fim.
 */
const DONA = 993000;
const PRIMEIRA = DONA + 1;
const QUE_NAO_CASAM = PERFIS_POR_PAGINA * 2 + 95;
const QUE_CASAM = 5;
const INATIVA = PRIMEIRA + QUE_NAO_CASAM + QUE_CASAM;
const ULTIMA = INATIVA;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

// Todos os perfis semeados só oferecem SERVIÇO: o portão da demanda expressa os bloqueia diante de quem não
// declarou precisar dele. É o que os deixa invisíveis às rodadas dos outros arquivos de integração, que rodam ao
// mesmo tempo no mesmo banco (matching-duplicacao.integracao.test.ts conta TODAS as linhas da usuária dele).
const perfilDaDona = {
  userId: DONA, whatIHave: ["Advocacia tributária"], whatINeed: ["consultoria"], sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"],
};
// Cada uma tem o serviço que a outra declarou precisar.
const complementar = (userId: number, city: string) => ({
  userId, whatIHave: ["Consultoria em internacionalização"], whatINeed: ["Advogado tributarista"], sector: "Jurídico", country: "BR", city, values: ["innovation"],
});
// Oferece serviço que a dona não declarou precisar, e precisa do que a dona não tem.
const queNaoCasa = (userId: number) => ({
  userId, whatIHave: ["Tradução juramentada"], whatINeed: ["fornecedores"], sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"],
});

describe.skipIf(!temBanco)("Motor de perfis — a rodada compara com todos os perfis (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await limpar(db);
    const ids = Array.from({ length: ULTIMA - DONA + 1 }, (_, i) => DONA + i);
    await db.insert(users).values(ids.map(id => ({ id, openId: `teste-todos-${id}`, isActive: id !== INATIVA })) as never);
    const perfis = ids.map(id => {
      if (id === DONA) return perfilDaDona;
      if (id < PRIMEIRA + QUE_NAO_CASAM) return queNaoCasa(id);
      // As que casam alternam a cidade da dona e outra: notas diferentes, para a ordem guardada ter o que provar.
      return complementar(id, id % 2 ? "Brasília" : "São Paulo");
    });
    await db.insert(userProfiles).values(perfis as never);
  }, 60_000);

  afterAll(async () => {
    const db = await getDb();
    if (db) await limpar(db);
  }, 60_000);

  const guardadasDaDona = async () => {
    const db = (await getDb())!;
    const linhas = await db.select({ matchedUserId: matches.matchedUserId, overallScore: matches.overallScore })
      .from(matches)
      .where(and(eq(matches.userId, DONA), between(matches.matchedUserId, PRIMEIRA, ULTIMA)))
      .orderBy(desc(matches.overallScore), asc(matches.matchedUserId));
    return linhas;
  };

  it("lê as páginas inteiras: o que casa depois de mais de duas páginas que não casam aparece, a conta inativa não", async () => {
    await generateMatchesForUser(DONA);

    const guardadas = await guardadasDaDona();
    const queCasam = Array.from({ length: QUE_CASAM }, (_, i) => PRIMEIRA + QUE_NAO_CASAM + i);
    expect(guardadas.map(linha => linha.matchedUserId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(queCasam);
    expect(guardadas.map(linha => linha.matchedUserId)).not.toContain(INATIVA);
  }, 60_000);

  // Roda as duas rodadas ele mesmo: lia a primeira do teste de cima, e sozinho
  // (`-t`, ou com a ordem embaralhada) comparava as 5 linhas com nada. A ORDEM da
  // rodada está provada no teste unitário (matching-todos-os-perfis.test.ts);
  // aqui, as notas e o conjunto guardados.
  it("as notas guardadas não mudam entre rodadas", async () => {
    await generateMatchesForUser(DONA);
    const primeira = await guardadasDaDona();
    await generateMatchesForUser(DONA);
    const segunda = await guardadasDaDona();

    expect(primeira).toHaveLength(QUE_CASAM);
    expect(segunda).toEqual(primeira);
    // Notas diferentes de verdade: a comparação não é só a dos ids.
    expect(new Set(primeira.map(linha => linha.overallScore)).size).toBeGreaterThan(1);
  }, 60_000);
});

async function limpar(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  await db.delete(matches).where(or(between(matches.userId, DONA, ULTIMA), between(matches.matchedUserId, DONA, ULTIMA)));
  await db.delete(userProfiles).where(between(userProfiles.userId, DONA, ULTIMA));
  await db.delete(users).where(between(users.id, DONA, ULTIMA));
}
