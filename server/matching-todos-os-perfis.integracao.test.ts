// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI, sem .env.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import crypto from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { users, userProfiles, matches } from "../drizzle/schema";
import { apagarPelaChave } from "./test/apagar-pela-chave";

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
 * `.limit(50)` sem ordem. Semeia as próprias contas com o id que o banco dá
 * (openId com prefixo só desta execução) e limpa tudo no fim pelo openId.
 *
 * Id fixo, não: os arquivos de integração rodam ao mesmo tempo no mesmo banco,
 * e o INSERT com id dado leva o AUTO_INCREMENT de users junto, linha a linha.
 * Quem gravava com id automático no meio dele pegava um id que este arquivo
 * gravaria em seguida (ER_DUP_ENTRY "Duplicate entry '993570'" no
 * nomes-dos-falantes, CI da #230), e a limpeza pela faixa de ids apagava as
 * contas dos outros arquivos que caíssem nela.
 */
const QUE_NAO_CASAM = PERFIS_POR_PAGINA * 2 + 95;
const QUE_CASAM = 5;
const PREFIXO = `teste-todos-${crypto.randomUUID()}`;
// A dona, as que não casam, as que casam e a inativa.
const openIds = Array.from({ length: 1 + QUE_NAO_CASAM + QUE_CASAM + 1 }, (_, i) => `${PREFIXO}-${i}`);

// Os ids que o banco deu, repartidos no beforeAll.
let dona = 0;
let inativa = 0;
let queCasam: number[] = [];
let semeadas: number[] = []; // todas menos a dona

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

// Todos os perfis semeados só oferecem SERVIÇO: o portão da demanda expressa os bloqueia diante de quem não
// declarou precisar dele. É o que os deixa invisíveis às rodadas dos outros arquivos de integração, que rodam ao
// mesmo tempo no mesmo banco (matching-duplicacao.integracao.test.ts conta TODAS as linhas da usuária dele).
const perfilDaDona = (userId: number) => ({
  userId, whatIHave: ["Advocacia tributária"], whatINeed: ["consultoria"], sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"],
});
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
    await db.insert(users).values(openIds.map(openId => ({ openId, isActive: true })));
    // Os papéis seguem a ordem do id que o banco deu, lida de volta (e não a ordem das linhas do INSERT): a dona,
    // as QUE_NAO_CASAM que não casam (mais de duas páginas), as QUE_CASAM que casam e, por último, a inativa.
    const ids = (await db.select({ id: users.id }).from(users).where(inArray(users.openId, openIds)).orderBy(asc(users.id)))
      .map(conta => conta.id);
    expect(ids).toHaveLength(openIds.length);
    dona = ids[0];
    semeadas = ids.slice(1);
    const naoCasam = ids.slice(1, 1 + QUE_NAO_CASAM);
    queCasam = ids.slice(1 + QUE_NAO_CASAM, 1 + QUE_NAO_CASAM + QUE_CASAM);
    inativa = ids[ids.length - 1];
    await db.update(users).set({ isActive: false }).where(eq(users.id, inativa));
    await db.insert(userProfiles).values([
      perfilDaDona(dona),
      ...naoCasam.map(queNaoCasa),
      // As que casam alternam a cidade da dona e outra: notas diferentes, para a ordem guardada ter o que provar.
      ...[...queCasam, inativa].map((id, i) => complementar(id, i % 2 ? "São Paulo" : "Brasília")),
    ] as never);
  }, 60_000);

  afterAll(async () => {
    const db = await getDb();
    if (db) await limpar(db);
  }, 60_000);

  const guardadasDaDona = async () => {
    const db = (await getDb())!;
    const linhas = await db.select({ matchedUserId: matches.matchedUserId, overallScore: matches.overallScore })
      .from(matches)
      .where(and(eq(matches.userId, dona), inArray(matches.matchedUserId, semeadas)))
      .orderBy(desc(matches.overallScore), asc(matches.matchedUserId));
    return linhas;
  };

  it("lê as páginas inteiras: o que casa depois de mais de duas páginas que não casam aparece, a conta inativa não", async () => {
    await generateMatchesForUser(dona);

    const guardadas = await guardadasDaDona();
    expect(guardadas.map(linha => linha.matchedUserId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(queCasam);
    expect(guardadas.map(linha => linha.matchedUserId)).not.toContain(inativa);
  }, 60_000);

  // Roda as duas rodadas ele mesmo: lia a primeira do teste de cima, e sozinho
  // (`-t`, ou com a ordem embaralhada) comparava as 5 linhas com nada. A ORDEM da
  // rodada está provada no teste unitário (matching-todos-os-perfis.test.ts);
  // aqui, as notas e o conjunto guardados.
  it("as notas guardadas não mudam entre rodadas", async () => {
    await generateMatchesForUser(dona);
    const primeira = await guardadasDaDona();
    await generateMatchesForUser(dona);
    const segunda = await guardadasDaDona();

    expect(primeira).toHaveLength(QUE_CASAM);
    expect(segunda).toEqual(primeira);
    // Notas diferentes de verdade: a comparação não é só a dos ids.
    expect(new Set(primeira.map(linha => linha.overallScore)).size).toBeGreaterThan(1);
  }, 60_000);
});

// Pelo openId desta execução e pela chave (server/test/apagar-pela-chave.ts), nunca pela faixa de ids. Só as linhas
// de `matches` destas contas: a de outra dona que aponte para elas é da rodada dela.
async function limpar(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  const contas = (await db.select({ id: users.id }).from(users).where(inArray(users.openId, openIds))).map(conta => conta.id);
  if (!contas.length) return;
  await apagarPelaChave(db, matches, inArray(matches.userId, contas));
  // Perfis e contas também saem um por um, pela chave, mas num commit só: são 2.204 linhas, e um commit para cada uma
  // deixava a limpeza duas a três vezes mais lenta e enchia de commits o banco que os outros arquivos usam ao mesmo
  // tempo. Cada DELETE trava só a linha dele, e nenhum outro arquivo trava as contas deste.
  const perfis = (await db.select({ id: userProfiles.id }).from(userProfiles).where(inArray(userProfiles.userId, contas)))
    .map(perfil => perfil.id);
  await db.transaction(async tx => {
    for (const id of perfis) await tx.delete(userProfiles).where(eq(userProfiles.id, id));
    for (const id of contas) await tx.delete(users).where(eq(users.id, id));
  });
}
