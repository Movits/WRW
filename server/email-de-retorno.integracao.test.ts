import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O rascunho de e-mail de retorno (H20) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê: o que se prova é o SQL — só os
 * itens confirmados do resumo pronto da dona, na ordem, vão à IA; reunião de
 * outra dona ou apagada é NOT_FOUND; reunião ou resumo que não estão prontos e
 * resumo sem item confirmado são recusados; nada é gravado.
 */
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, users } = await import("../drizzle/schema");
const { rascunharEmailDeRetorno } = await import("./email-de-retorno");
const { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO, MENSAGEM_EMAIL_SEM_RESUMO_PRONTO } = await import("@shared/email-de-retorno");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-email-${crypto.randomUUID()}`;
const OUTRA = `teste-email-outra-${crypto.randomUUID()}`;
const PEDIDO = { relacao: "external", tom: "professional", idioma: "pt-BR" } as const;
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

type ItemSemeado = { section: "action" | "focus" | "task" | "decision" | "blocker" | "question"; text: string; status: "pending" | "confirmed" | "ignored"; done?: boolean; assignee?: string | null; subject?: string | null };

/** Uma reunião com resumo e itens, gravada como a fila do resumo grava. */
async function reuniaoComResumo(dona: string, itens: ItemSemeado[], opcoes: { reuniao?: string; resumo?: "pending" | "ready" | "failed" } = {}) {
  const banco = await db();
  const id = crypto.randomUUID(), resumoId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id, ownerId: dona, title: "Reunião do e-mail", status: (opcoes.reuniao ?? "ready") as "ready", consentGranted: true, consentAt: AGORA(),
    language: "pt-BR", speakerNames: { F1: "Nome que nunca vai à IA" }, createdAt: AGORA(), updatedAt: AGORA(),
  });
  await banco.insert(meetingSummaries).values({ id: resumoId, meetingId: id, ownerId: dona, status: opcoes.resumo ?? "ready", language: "pt-BR", createdAt: AGORA(), updatedAt: AGORA() });
  // Gravados de trás para a frente: a leitura é que ordena pela posição.
  for (const [i, item] of Array.from(itens.entries()).reverse()) {
    await banco.insert(meetingSummaryItems).values({
      id: crypto.randomUUID(), summaryId: resumoId, meetingId: id, ownerId: dona, section: item.section, position: i,
      subject: item.subject ?? null, text: item.text, assignee: item.assignee ?? null, due: null, excerpt: "trecho literal da reunião", startSeconds: 3,
      status: item.status, done: item.done ?? false, createdAt: AGORA(), updatedAt: AGORA(),
    });
  }
  return id;
}

const itensNoPrompt = () => {
  const usuario = (invokeLLM.mock.calls.at(-1)![0].messages as Array<{ content: string }>)[1].content;
  return JSON.parse(usuario.slice(usuario.indexOf("["))) as Array<Record<string, unknown>>;
};

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Rascunho de e-mail de retorno no banco (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    invokeLLM.mockReset();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ assunto: "Retorno", corpo: "Olá, {DESTINATARIO}. {F2} avisa a transportadora." }) }, finish_reason: "stop" }], model: "gemini-teste" });
  });

  it("só os itens confirmados do resumo da dona vão à IA, na ordem da posição; os nomes das vozes não", async () => {
    const id = await reuniaoComResumo(DONA, [
      { section: "action", text: "Mandar a minuta do contrato", status: "confirmed", done: true, assignee: "{F1}" },
      { section: "task", subject: "Exportação", text: "Item ainda para conferir", status: "pending" },
      { section: "decision", text: "Item que a dona ignorou", status: "ignored" },
      { section: "question", text: "{F2} avisa a transportadora?", status: "confirmed" },
    ]);
    // Outra dona com item confirmado: nada dela entra.
    await reuniaoComResumo(OUTRA, [{ section: "action", text: "Item de outra dona", status: "confirmed" }]);

    await expect(rascunharEmailDeRetorno(DONA, id, PEDIDO)).resolves.toEqual({ assunto: "Retorno", corpo: "Olá, {DESTINATARIO}. {F2} avisa a transportadora." });
    expect(itensNoPrompt()).toEqual([
      { secao: "ação", texto: "Mandar a minuta do contrato", responsavel: "{F1}", feita: true },
      { secao: "questão em aberto", texto: "{F2} avisa a transportadora?" },
    ]);
    expect(JSON.stringify(invokeLLM.mock.calls)).not.toContain("Nome que nunca vai à IA");
  });

  it("reunião de outra dona, ou apagada: NOT_FOUND, sem chamar a IA", async () => {
    const daOutra = await reuniaoComResumo(OUTRA, [{ section: "action", text: "Item de outra dona", status: "confirmed" }]);
    const apagada = await reuniaoComResumo(DONA, [{ section: "action", text: "Item", status: "confirmed" }], { reuniao: "deleted" });
    await expect(rascunharEmailDeRetorno(DONA, daOutra, PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rascunharEmailDeRetorno(DONA, apagada, PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("reunião em processamento, resumo sendo refeito ou com falha: PRECONDITION_FAILED, sem chamar a IA", async () => {
    const processando = await reuniaoComResumo(DONA, [{ section: "action", text: "Item", status: "confirmed" }], { reuniao: "processing" });
    const refeito = await reuniaoComResumo(DONA, [{ section: "action", text: "Item", status: "confirmed" }], { resumo: "pending" });
    const falhou = await reuniaoComResumo(DONA, [{ section: "action", text: "Item", status: "confirmed" }], { resumo: "failed" });
    for (const id of [processando, refeito, falhou]) {
      await expect(rascunharEmailDeRetorno(DONA, id, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EMAIL_SEM_RESUMO_PRONTO });
    }
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("resumo pronto sem item confirmado: PRECONDITION_FAILED com a frase própria", async () => {
    const id = await reuniaoComResumo(DONA, [
      { section: "action", text: "Para conferir", status: "pending" },
      { section: "decision", text: "Ignorado", status: "ignored" },
    ]);
    await expect(rascunharEmailDeRetorno(DONA, id, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("nada é gravado: o resumo e os itens ficam como estavam", async () => {
    const id = await reuniaoComResumo(DONA, [{ section: "action", text: "Mandar a minuta", status: "confirmed" }]);
    const antes = await (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, id));
    const resumoAntes = await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id));
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ assunto: "Retorno", corpo: "Olá, {DESTINATARIO}." }) }, finish_reason: "stop" }] });
    await rascunharEmailDeRetorno(DONA, id, PEDIDO);
    expect(await (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, id))).toEqual(antes);
    expect(await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id))).toEqual(resumoAntes);
  });
});
