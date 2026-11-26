import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// Os vetores dublados: a IA não é chamada, e todo documento tem o mesmo
// vetor (a busca devolve todos, e o teste olha quais).
vi.mock("./gemini", async original => ({
  ...(await original<typeof import("./gemini")>()),
  embedWithGemini: async () => [1, 0, 0],
  embedManyWithGemini: async (textos: string[]) => textos.map(() => [1, 0, 0]),
}));

/**
 * O resumo confirmado na Memória (grupo voz, item 1) contra um banco real DE
 * TESTE (sem DATABASE_URL_TESTES, se pula):
 * - entra só depois de a dona confirmar: o item "para conferir" e o ignorado
 *   ficam de fora, e o complemento pela busca (H4i) só entra confirmado;
 * - sai (ou muda) quando o resumo muda: desfazer a confirmação refaz o
 *   documento, e sem item confirmado ele sai na rodada;
 * - sai quando a reunião vai para a lixeira, e quando é excluída;
 * - a busca o devolve como "meeting_summary", que a resposta cita como resumo.
 */
const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, memoryDocuments, users } = await import("../drizzle/schema");
const memoria = await import("./memory-service");
const { deletePrivateMeeting } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-resumo-memoria-${crypto.randomUUID()}`;
const AGORA = () => Date.now();
async function db() { return (await getDb())!; }

async function reuniaoComResumo() {
  const banco = await db();
  const id = crypto.randomUUID();
  const resumoId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id, ownerId: DONA, title: "Reunião com a importadora", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), speakerNames: { F2: "Ana" },
  });
  await banco.insert(meetingSummaries).values({ id: resumoId, meetingId: id, ownerId: DONA, status: "ready", version: 1, language: "pt-BR", createdAt: AGORA(), updatedAt: AGORA() });
  const itens = [
    { section: "action", text: "{F2} manda a proposta de frete", assignee: "{F2}", due: "sexta", status: "confirmed" },
    { section: "decision", text: "Seguir a lei catorze mil", assignee: null, due: null, status: "confirmed" },
    { section: "question", text: "Item para conferir sobre o seguro", assignee: null, due: null, status: "pending" },
    { section: "blocker", text: "Item ignorado sobre a alfândega", assignee: null, due: null, status: "ignored" },
  ] as const;
  const ids = itens.map(() => crypto.randomUUID());
  await banco.insert(meetingSummaryItems).values(itens.map((item, position) => ({
    ...item, id: ids[position], subject: null, summaryId: resumoId, meetingId: id, ownerId: DONA, position, excerpt: "trecho", startSeconds: null,
    confidence: "0.900", done: false, createdAt: AGORA(), updatedAt: AGORA(),
  })));
  return { id, ids };
}

const documentoDoResumo = async (meetingId: string) => (await (await db()).select().from(memoryDocuments)
  .where(and(eq(memoryDocuments.ownerId, DONA), eq(memoryDocuments.sourceType, "meeting_summary"), eq(memoryDocuments.sourceId, meetingId))))[0];

async function limpar() {
  const banco = await db();
  await apagarPelaChave(banco, memoryDocuments, eq(memoryDocuments.ownerId, DONA));
  await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, DONA));
  await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
  await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA));
}

describe.skipIf(!temBanco)("O resumo confirmado na Memória (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA]));
  });
  beforeEach(async () => {
    await limpar();
    memoria.esquecerAssinaturasDeIndexacao();
  });

  it("indexa só os itens confirmados, com o nome da voz; o pendente, o ignorado e o complemento pendente ficam de fora", async () => {
    const { id, ids } = await reuniaoComResumo();
    await (await db()).update(meetingSummaryItems).set({
      complementText: "Lei nº 14.133/2021", complementSourceUrl: "https://fonte.example/lei", complementStatus: "pending", complementAt: AGORA(),
    }).where(eq(meetingSummaryItems.id, ids[1]));
    await memoria.indexOwnerMemory(DONA, { forcar: true });
    const documento = await documentoDoResumo(id);
    expect(documento?.content).toContain("Resumo confirmado da reunião: Reunião com a importadora");
    expect(documento?.content).toContain("Ana manda a proposta de frete (responsável: Ana; prazo: sexta)");
    expect(documento?.content).toContain("Seguir a lei catorze mil");
    expect(documento?.content).not.toContain("seguro");
    expect(documento?.content).not.toContain("alfândega");
    expect(documento?.content).not.toContain("14.133");

    // Confirmado, o complemento entra marcado como de fora da reunião, com a fonte.
    await (await db()).update(meetingSummaryItems).set({ complementStatus: "confirmed", updatedAt: AGORA() + 1 }).where(eq(meetingSummaryItems.id, ids[1]));
    await memoria.indexOwnerMemory(DONA);
    expect((await documentoDoResumo(id))?.content).toContain("Complemento de fora da reunião (busca na web, fonte: https://fonte.example/lei): Lei nº 14.133/2021");
  });

  it("o resumo que muda refaz o documento; sem item confirmado, ele sai", async () => {
    const { id, ids } = await reuniaoComResumo();
    await memoria.indexOwnerMemory(DONA, { forcar: true });
    const antes = await documentoDoResumo(id);
    // A dona desfaz a confirmação de um item: o documento perde o item.
    await (await db()).update(meetingSummaryItems).set({ status: "pending", updatedAt: AGORA() + 1 }).where(eq(meetingSummaryItems.id, ids[1]));
    await memoria.indexOwnerMemory(DONA);
    const depois = await documentoDoResumo(id);
    expect(depois?.contentHash).not.toBe(antes?.contentHash);
    expect(depois?.content).not.toContain("lei catorze");
    // E do último: sem item confirmado, o documento sai na rodada.
    await (await db()).update(meetingSummaryItems).set({ status: "pending", updatedAt: AGORA() + 2 }).where(eq(meetingSummaryItems.id, ids[0]));
    await memoria.indexOwnerMemory(DONA);
    expect(await documentoDoResumo(id)).toBeUndefined();
  });

  it("a reunião na lixeira some da busca na hora e da Memória na rodada; excluída, também", async () => {
    const { id } = await reuniaoComResumo();
    await memoria.indexOwnerMemory(DONA, { forcar: true });
    const achados = await memoria.semanticSearch(DONA, "proposta de frete");
    expect(achados.hits.some(hit => hit.sourceType === "meeting_summary" && hit.sourceId === id)).toBe(true);

    await (await db()).update(meetings).set({ trashedAt: AGORA(), updatedAt: AGORA() + 1 }).where(eq(meetings.id, id));
    expect((await memoria.semanticSearch(DONA, "proposta de frete")).hits.some(hit => hit.sourceType === "meeting_summary")).toBe(false);
    expect(await documentoDoResumo(id)).toBeUndefined();

    // Restaurada, volta; excluída, sai.
    await (await db()).update(meetings).set({ trashedAt: null, updatedAt: AGORA() + 2 }).where(eq(meetings.id, id));
    await memoria.indexOwnerMemory(DONA);
    expect(await documentoDoResumo(id)).toBeDefined();
    await deletePrivateMeeting(DONA, id);
    await memoria.indexOwnerMemory(DONA);
    expect(await documentoDoResumo(id)).toBeUndefined();
  });
});
