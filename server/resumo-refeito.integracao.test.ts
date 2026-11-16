import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os modelos do resumo e o "Refazer como…" (H4d) contra um banco real DE
 * TESTE (sem DATABASE_URL_TESTES, se pula). A IA é dublê: o que se prova é o
 * banco — o pedido no modelo escolhido, o refazer que guarda os itens
 * confirmados e os feitos e troca os pendentes e os ignorados (renumerados,
 * sem repetir o que ficou), a versão anterior intacta enquanto a nova é
 * escrita ou se ela falha (para a dona e para o link), as decisões recusadas
 * no meio e de volta depois da falha, o link que não reabre o refazer e a
 * dona no WHERE.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const servico = await import("./resumo-guardado");
const { FalhaDaIA } = await import("./ia-em-json");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-refeito-${crypto.randomUUID()}`;
const OUTRA = `teste-refeito-outra-${crypto.randomUUID()}`;
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

const SEGMENTOS = [
  { inicio: 0, fim: 5, falante: "F1", texto: "Bom dia. Vamos falar da exportação de café." },
  { inicio: 5, fim: 12, falante: "F2", texto: "Decidimos não renovar o contrato com a transportadora." },
];

async function reuniaoPronta(extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: "Reunião do resumo refeito", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  await (await db()).insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: SEGMENTOS.map(s => s.texto).join("\n"), segments: SEGMENTOS,
    language: "pt-BR", durationSeconds: 12, createdAt: AGORA(), updatedAt: AGORA(),
  });
  return id;
}

const item = (section: string, text: string, startSeconds: number | null = 5) =>
  ({ section, subject: null, text, assignee: null, due: null, excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds, confidence: 0.8 });
// O primeiro resumo, no Geral.
const GERAL = {
  emoji: "☕", modelo: "gemini-teste-1", recebidos: 5,
  itens: [
    item("action", "Avisar a transportadora"),
    item("action", "Pedir três cotações de frete"),
    item("action", "Ligar para o despachante"),
    item("decision", "Não renovar com a transportadora"),
    item("question", "Quem paga o seguro da carga?"),
  ],
};
// A versão nova, em Vendas: a 1ª ação repete uma confirmada (outra caixa).
const VENDAS = {
  emoji: "💼", modelo: "gemini-teste-2", recebidos: 4,
  itens: [
    item("action", "avisar a TRANSPORTADORA"),
    item("action", "Enviar a proposta comercial"),
    item("focus", "Venda de café para a Alemanha"),
    item("decision", "Desconto de 5% no primeiro pedido"),
  ],
};

const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const itensDe = async (meetingId: string) => (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, meetingId)).orderBy(meetingSummaryItems.position);
const vaga = vi.fn();
const porTexto = async (meetingId: string) => Object.fromEntries((await itensDe(meetingId)).map(linha => [linha.text, linha]));
const tokenDe = async (meetingId: string) => (await (await db()).select({ shareToken: meetings.shareToken }).from(meetings).where(eq(meetings.id, meetingId)))[0].shareToken!;

/** O resumo Geral pronto, com uma ação confirmada, uma feita e uma decisão ignorada. */
async function resumoDecidido() {
  const id = await reuniaoPronta({ shareToken: crypto.randomBytes(24).toString("base64url") });
  await servico.pedirResumoDaDona(DONA, id, vaga);
  await rodar();
  const itens = await porTexto(id);
  await servico.decidirItemDoResumo(DONA, itens["Avisar a transportadora"].id, "confirmed");
  await servico.marcarAcaoFeita(DONA, itens["Pedir três cotações de frete"].id, true);
  await servico.decidirItemDoResumo(DONA, itens["Não renovar com a transportadora"].id, "ignored");
  vaga.mockClear();
  gerarResumoDaReuniao.mockClear();
  return { id, antes: await porTexto(id) };
}

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await banco.delete(meetingSummaryItems).where(eq(meetingSummaryItems.ownerId, dona));
    await banco.delete(meetingSummaries).where(eq(meetingSummaries.ownerId, dona));
    await banco.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, dona));
    await banco.delete(meetings).where(eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Modelos do resumo e o refazer (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    fila.religarParaTestes();
    gerarResumoDaReuniao.mockReset();
    gerarResumoDaReuniao.mockResolvedValue(GERAL);
    vaga.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("pedir com modelo: a reunião ganha o resumo no modelo escolhido, e a IA o recebe", async () => {
    const id = await reuniaoPronta();
    const pedido = await servico.pedirResumoDaDona(DONA, id, vaga, "mentoring");
    expect(pedido).toMatchObject({ estado: "pendente", modelo: "mentoring", itens: [] });
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", template: "mentoring" });
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({ modelo: "mentoring", itensQueFicam: [] }));
    expect(await servico.resumoGuardadoDaDona(DONA, id)).toMatchObject({ estado: "pronto", modelo: "mentoring" });
  });

  it("refazer como Vendas: os confirmados e os feitos ficam (renumerados); os pendentes e os ignorados são trocados; o que repete um que ficou não entra", async () => {
    const { id, antes } = await resumoDecidido();
    const pedido = await servico.refazerResumoDaDona(DONA, id, "sales", vaga);
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(pedido).toMatchObject({ estado: "pendente", modelo: "sales" });
    // Até a versão nova ser gravada, a anterior fica inteira, para a tela mostrar.
    expect(pedido.itens).toHaveLength(5);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", template: "sales", attempts: 0, lastError: null, version: 1 });

    gerarResumoDaReuniao.mockResolvedValue(VENDAS);
    await rodar();

    // A IA recebe o modelo e os itens que ficam (para não repeti-los), na ordem do resumo.
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({
      modelo: "sales",
      itensQueFicam: [
        { section: "action", subject: null, text: "Avisar a transportadora" },
        { section: "action", subject: null, text: "Pedir três cotações de frete" },
      ],
    }));
    const depois = await itensDe(id);
    expect(depois.map(linha => [linha.position, linha.section, linha.text, linha.status, linha.done])).toEqual([
      [0, "action", "Avisar a transportadora", "confirmed", false],
      [1, "action", "Pedir três cotações de frete", "confirmed", true],
      [2, "action", "Enviar a proposta comercial", "pending", false],
      [3, "focus", "Venda de café para a Alemanha", "pending", false],
      [4, "decision", "Desconto de 5% no primeiro pedido", "pending", false],
    ]);
    // Os que ficam são as mesmas linhas, com a decisão e a marca de feito de antes.
    expect(depois[0].id).toBe(antes["Avisar a transportadora"].id);
    expect(depois[1]).toMatchObject({ id: antes["Pedir três cotações de frete"].id, doneAt: antes["Pedir três cotações de frete"].doneAt });
    expect(Number(depois[1].doneAt)).toBeGreaterThan(0);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "sales", version: 2, emoji: "💼", model: "gemini-teste-2", lockToken: null });
    expect(await servico.resumoGuardadoDaDona(DONA, id)).toMatchObject({ estado: "pronto", modelo: "sales", emoji: "💼" });
  });

  it("durante o refazer: decidir é conflito, e o link segue mostrando a versão anterior (sem os ignorados), marcada como anterior", async () => {
    const { id, antes } = await resumoDecidido();
    const token = await tokenDe(id);
    expect(await servico.resumoGuardadoPeloLink(token)).toMatchObject({ estado: "pronto", versaoAnterior: false });
    await servico.refazerResumoDaDona(DONA, id, "networking", vaga);
    await expect(servico.decidirItemDoResumo(DONA, antes["Ligar para o despachante"].id, "confirmed")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(servico.marcarAcaoFeita(DONA, antes["Avisar a transportadora"].id, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(servico.confirmarItensDoResumo(DONA, id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await servico.resumoGuardadoDaDona(DONA, id)).toMatchObject({ estado: "pendente", versaoAnterior: true });
    const peloLink = await servico.resumoGuardadoPeloLink(token);
    expect(peloLink).toMatchObject({ estado: "pendente", emoji: "☕", versaoAnterior: true });
    expect(peloLink.itens.map(i => [i.text, i.status])).toEqual([
      ["Avisar a transportadora", "confirmed"],
      ["Pedir três cotações de frete", "confirmed"],
      ["Ligar para o despachante", "pending"],
      ["Quem paga o seguro da carga?", "pending"],
    ]);
    expect(peloLink.itens[0]).not.toHaveProperty("id");
    expect(peloLink.itens[0]).not.toHaveProperty("done");
  });

  it("o refazer falhou: o link segue com a versão anterior e não o reabre; a dona volta a decidir, e o 'Tentar de novo' guarda o que ela confirmou", async () => {
    const { id, antes } = await resumoDecidido();
    const token = await tokenDe(id);
    await servico.refazerResumoDaDona(DONA, id, "sales", vaga);
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", template: "sales", version: 1 });

    // O link não perde o que via antes do refazer.
    const peloLink = await servico.resumoGuardadoPeloLink(token);
    expect(peloLink).toMatchObject({ estado: "falhou", emoji: "☕", versaoAnterior: true });
    expect(peloLink.itens.map(i => i.text)).toEqual(["Avisar a transportadora", "Pedir três cotações de frete", "Ligar para o despachante", "Quem paga o seguro da carga?"]);
    // Quem tem o link não reabre o refazer da dona: nem gasta vaga, nem muda a linha.
    const vagaDoLink = vi.fn();
    expect(await servico.pedirResumoPeloLink(token, vagaDoLink)).toMatchObject({ estado: "falhou", versaoAnterior: true });
    expect(vagaDoLink).not.toHaveBeenCalled();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", template: "sales", lastError: "RESPOSTA_CORTADA" });

    // A dona decide sobre a versão anterior: nenhuma geração está em curso.
    expect(await servico.resumoGuardadoDaDona(DONA, id)).toMatchObject({ estado: "falhou", versaoAnterior: true });
    await servico.decidirItemDoResumo(DONA, antes["Ligar para o despachante"].id, "confirmed");
    await servico.marcarAcaoFeita(DONA, antes["Avisar a transportadora"].id, true);
    expect(await servico.confirmarItensDoResumo(DONA, id)).toBe(1);
    expect((await itensDe(id)).map(linha => [linha.text, linha.status, linha.done])).toEqual([
      ["Avisar a transportadora", "confirmed", true],
      ["Pedir três cotações de frete", "confirmed", true],
      ["Ligar para o despachante", "confirmed", false],
      ["Não renovar com a transportadora", "ignored", false],
      ["Quem paga o seguro da carga?", "confirmed", false],
    ]);

    // "Tentar de novo" (o da dona, sem modelo): refaz em Vendas e guarda o que ela confirmou.
    vaga.mockClear();
    await servico.pedirResumoDaDona(DONA, id, vaga);
    expect(vaga).toHaveBeenCalledTimes(1);
    gerarResumoDaReuniao.mockReset();
    gerarResumoDaReuniao.mockResolvedValue(VENDAS);
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({
      modelo: "sales",
      itensQueFicam: [
        { section: "action", subject: null, text: "Avisar a transportadora" },
        { section: "action", subject: null, text: "Pedir três cotações de frete" },
        { section: "action", subject: null, text: "Ligar para o despachante" },
        { section: "question", subject: null, text: "Quem paga o seguro da carga?" },
      ],
    }));
    expect((await itensDe(id)).map(linha => [linha.position, linha.text, linha.status])).toEqual([
      [0, "Avisar a transportadora", "confirmed"],
      [1, "Pedir três cotações de frete", "confirmed"],
      [2, "Ligar para o despachante", "confirmed"],
      [3, "Enviar a proposta comercial", "pending"],
      [4, "Venda de café para a Alemanha", "pending"],
      [5, "Desconto de 5% no primeiro pedido", "pending"],
      [6, "Quem paga o seguro da carga?", "confirmed"],
    ]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "sales", version: 2 });
    expect(await servico.resumoGuardadoPeloLink(token)).toMatchObject({ estado: "pronto", emoji: "💼", versaoAnterior: false });
  });

  it("a versão nova falhou: a anterior fica inteira; tentar de novo refaz no mesmo modelo", async () => {
    const { id } = await resumoDecidido();
    const antes = await itensDe(id);
    await servico.refazerResumoDaDona(DONA, id, "networking", vaga);
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    await rodar();

    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", template: "networking", lastError: "RESPOSTA_CORTADA", version: 1 });
    expect(await itensDe(id)).toEqual(antes);
    const lido = await servico.resumoGuardadoDaDona(DONA, id);
    expect(lido).toMatchObject({ estado: "falhou", modelo: "networking", erro: "RESPOSTA_CORTADA" });
    expect(lido.itens.map(i => i.status)).toEqual(["confirmed", "confirmed", "pending", "ignored", "pending"]);

    vaga.mockClear();
    await servico.pedirResumoDaDona(DONA, id, vaga);
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", template: "networking", attempts: 0 });
    gerarResumoDaReuniao.mockReset();
    gerarResumoDaReuniao.mockResolvedValue(VENDAS);
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({ modelo: "networking" }));
    expect((await itensDe(id)).map(linha => linha.text)).toEqual([
      "Avisar a transportadora", "Pedir três cotações de frete", "Enviar a proposta comercial", "Venda de café para a Alemanha", "Desconto de 5% no primeiro pedido",
    ]);
  });

  it("refazer de novo o que já está na fila: no mesmo modelo nada muda nem gasta vaga; em outro, é conflito", async () => {
    const { id } = await resumoDecidido();
    await servico.refazerResumoDaDona(DONA, id, "sales", vaga);
    await servico.refazerResumoDaDona(DONA, id, "sales", vaga);
    expect(vaga).toHaveBeenCalledTimes(1);
    await expect(servico.refazerResumoDaDona(DONA, id, "mentoring", vaga)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", template: "sales" });
  });

  it("refazer no mesmo modelo dá uma versão nova, guardando o que a dona decidiu", async () => {
    const { id } = await resumoDecidido();
    await servico.refazerResumoDaDona(DONA, id, "general", vaga);
    await rodar();
    // O Geral de novo traz as mesmas ações: as que ficaram não se repetem; as outras voltam pendentes.
    expect((await itensDe(id)).map(linha => [linha.text, linha.status])).toEqual([
      ["Avisar a transportadora", "confirmed"],
      ["Pedir três cotações de frete", "confirmed"],
      ["Ligar para o despachante", "pending"],
      ["Não renovar com a transportadora", "pending"],
      ["Quem paga o seguro da carga?", "pending"],
    ]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "general", version: 2 });
  });

  it("só a dona refaz, e só a reunião pronta", async () => {
    const { id } = await resumoDecidido();
    await expect(servico.refazerResumoDaDona(OUTRA, id, "sales", vaga)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await (await db()).update(meetings).set({ status: "processing" }).where(eq(meetings.id, id));
    await expect(servico.refazerResumoDaDona(DONA, id, "sales", vaga)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(vaga).not.toHaveBeenCalled();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "general" });
  });

  it("o teto que recusa impede o refazer: o resumo pronto fica como estava", async () => {
    const { id } = await resumoDecidido();
    await expect(servico.refazerResumoDaDona(DONA, id, "sales", () => { throw new Error("teto"); })).rejects.toThrow("teto");
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "general", version: 1 });
  });
});
