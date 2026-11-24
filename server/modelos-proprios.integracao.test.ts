import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os modelos de resumo da dona e as preferências dela (H4e) contra um banco
 * real DE TESTE (sem DATABASE_URL_TESTES, se pula). A IA é dublê: o resumo, o
 * mapa e a escolha do modelo. O que se prova é o banco: o CRUD com a dona no
 * WHERE, o teto e o nome repetido, apagar que solta o que apontava, o pedido
 * antes de gravar (e fora de hora), o primeiro resumo com o pedido ou as
 * preferências, a fila que leva o modelo da dona, o estilo, o ajuste e as
 * instruções à IA, "a IA escolhe" gravado como escolha dela, a resposta do
 * tamanho e o teto do refazer.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));
const escolherModeloDoResumo = vi.hoisted(() => vi.fn());
vi.mock("./escolha-do-modelo", async original => ({ ...(await original<typeof import("./escolha-do-modelo")>()), escolherModeloDoResumo: (...a: unknown[]) => escolherModeloDoResumo(...a) }));

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, modelosDeResumoProprios, preferenciasDoResumo, resumosRefeitos, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const servico = await import("./resumo-guardado");
const proprios = await import("./modelos-proprios");
const { MODELOS_PROPRIOS_MAX, RECUSAS_DOS_MODELOS, REFAZERES_POR_DIA } = await import("@shared/modelos-de-resumo");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-mp-${crypto.randomUUID()}`;
const OUTRA = `teste-mp-outra-${crypto.randomUUID()}`;
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();
async function db() { return (await getDb())!; }

const SEGMENTOS = [
  { inicio: 0, fim: 5, falante: "F1", texto: "Bom dia. Vamos falar da vaga de analista." },
  { inicio: 5, fim: 12, falante: "F2", texto: "Eu trabalhei cinco anos com logística de exportação." },
];
const RESUMO = {
  emoji: "🎤", titulo: null, modelo: "gemini-teste", recebidos: 1,
  itens: [{ section: "action", subject: null, text: "Mandar o retorno à candidata", assignee: null, due: null, excerpt: "Eu trabalhei cinco anos com logística de exportação", startSeconds: 5, confidence: 0.8 }],
};

async function reuniao(dona = DONA, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: dona, title: "Entrevista", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  await (await db()).insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId: dona, transcript: SEGMENTOS.map(s => s.texto).join("\n"), segments: SEGMENTOS,
    language: "pt-BR", durationSeconds: 12, createdAt: AGORA(), updatedAt: AGORA(),
  });
  return id;
}
const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const criar = (nome = "Entrevista de emprego", dona = DONA) => proprios.criarModeloProprio(dona, { nome, icone: "🎤", instrucoes: "Destaque as perguntas e as respostas da candidata." });
const vaga = () => undefined;

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
    await apagarPelaChave(banco, modelosDeResumoProprios, eq(modelosDeResumoProprios.ownerId, dona));
    await apagarPelaChave(banco, resumosRefeitos, eq(resumosRefeitos.ownerId, dona));
    await banco.delete(preferenciasDoResumo).where(eq(preferenciasDoResumo.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Modelos de resumo da dona e preferências (H4e, integração)", () => {
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
    gerarResumoDaReuniao.mockResolvedValue(RESUMO);
    gerarMapaMental.mockReset();
    gerarMapaMental.mockResolvedValue(null);
    escolherModeloDoResumo.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("criar, listar e editar só os da dona; outra dona leva NOT_FOUND; nome repetido (sem caixa nem acento) é conflito", async () => {
    const { id } = await criar();
    await expect(criar("ENTREVISTA  de  Emprégo")).rejects.toMatchObject({ code: "CONFLICT", message: RECUSAS_DOS_MODELOS.nomeRepetido });
    await criar("Entrevista de emprego", OUTRA);
    const lista = await proprios.modelosEPreferenciasDaDona(DONA);
    expect(lista.proprios).toEqual([{ id, nome: "Entrevista de emprego", icone: "🎤", instrucoes: "Destaque as perguntas e as respostas da candidata." }]);
    expect(lista).toMatchObject({ padrao: "general", estilo: "balanced", ajusteDoTamanho: 0 });
    await proprios.editarModeloProprio(DONA, id, { nome: "Entrevistas", icone: "📚", instrucoes: "Só as perguntas." });
    expect((await proprios.modelosEPreferenciasDaDona(DONA)).proprios[0]).toMatchObject({ nome: "Entrevistas", icone: "📚", instrucoes: "Só as perguntas." });
    await expect(proprios.editarModeloProprio(OUTRA, id, { nome: "X", icone: "📚", instrucoes: "Y" })).rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DOS_MODELOS.naoEncontrado });
    await expect(proprios.apagarModeloProprio(OUTRA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(proprios.editarModeloProprio(DONA, id, { nome: "  ", icone: "📚", instrucoes: "Y" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("o teto de modelos por dona", async () => {
    for (let i = 0; i < MODELOS_PROPRIOS_MAX; i++) await criar(`Modelo ${i}`);
    await expect(criar("Mais um")).rejects.toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DOS_MODELOS.demais });
    await expect(criar("Mais um", OUTRA)).resolves.toBeDefined();
  });

  it("apagar o modelo solta o resumo feito com ele (fica no Geral) e o padrão que o citava", async () => {
    const { id } = await criar();
    await proprios.definirPreferencias(DONA, { padrao: `proprio:${id}`, estilo: "concise" });
    expect(await proprios.modelosEPreferenciasDaDona(DONA)).toMatchObject({ padrao: `proprio:${id}`, estilo: "concise" });
    const meetingId = await reuniao();
    await servico.pedirResumoDaDona(DONA, meetingId, vaga, { modelo: `proprio:${id}` });
    await rodar();
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ modeloProprio: { id, nome: "Entrevista de emprego", icone: "🎤" }, escolha: `proprio:${id}` });
    await proprios.apagarModeloProprio(DONA, id);
    expect(await linhaDoResumo(meetingId)).toMatchObject({ customTemplateId: null, template: "general" });
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ modeloProprio: null, escolha: "general", modelo: "general" });
    expect(await proprios.modelosEPreferenciasDaDona(DONA)).toMatchObject({ padrao: "general", estilo: "concise", proprios: [] });
  });

  it("o modelo de outra dona não serve: nem no padrão, nem no pedido, nem no refazer", async () => {
    const { id } = await criar("Da outra", OUTRA);
    const meetingId = await reuniao();
    await expect(proprios.definirPreferencias(DONA, { padrao: `proprio:${id}`, estilo: "balanced" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.pedirResumoDaDona(DONA, meetingId, vaga, { modelo: `proprio:${id}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(proprios.definirPedidoDoResumo(DONA, meetingId, { modelo: `proprio:${id}`, estilo: "balanced", instrucoes: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await linhaDoResumo(meetingId)).toBeUndefined();
  });

  it("a fila leva à IA o modelo da dona, o estilo, o ajuste do tamanho e as instruções do pedido", async () => {
    const { id } = await criar();
    const meetingId = await reuniao();
    await (await db()).insert(preferenciasDoResumo).values({ ownerId: DONA, ajusteDoTamanho: -1, updatedAt: AGORA() });
    await servico.pedirResumoDaDona(DONA, meetingId, vaga, { modelo: `proprio:${id}`, estilo: "detailed", instrucoes: "  Cite a vaga.  " });
    expect(await linhaDoResumo(meetingId)).toMatchObject({ template: "general", customTemplateId: id, aiTemplate: null, style: "detailed", instructions: "Cite a vaga." });
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({
      modelo: "general",
      preferencias: { modeloProprio: { nome: "Entrevista de emprego", instrucoes: "Destaque as perguntas e as respostas da candidata." }, estilo: "detailed", ajusteDoTamanho: -1, instrucoesDoPedido: "Cite a vaga." },
    }));
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ estado: "pronto", estilo: "detailed", instrucoes: "Cite a vaga.", escolhidoPelaIA: false });
  });

  it("'a IA escolhe': a fila pede a escolha com os modelos da dona e grava o que ela escolheu, como escolha da IA", async () => {
    const { id } = await criar();
    const meetingId = await reuniao();
    escolherModeloDoResumo.mockResolvedValue({ tipo: "proprio", id });
    await servico.pedirResumoDaDona(DONA, meetingId, vaga, { modelo: "ia" });
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ iaVaiEscolher: true, escolha: "ia" });
    await rodar();
    expect(escolherModeloDoResumo).toHaveBeenCalledWith(expect.objectContaining({ proprios: [expect.objectContaining({ id })] }));
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({ preferencias: expect.objectContaining({ modeloProprio: expect.objectContaining({ nome: "Entrevista de emprego" }) }) }));
    expect(await linhaDoResumo(meetingId)).toMatchObject({ template: "general", customTemplateId: id, aiTemplate: "chosen" });
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ escolhidoPelaIA: true, iaVaiEscolher: false, modeloProprio: { id } });
  });

  it("'a IA escolhe' que falha fica no Geral, e o resumo sai assim mesmo", async () => {
    const meetingId = await reuniao();
    escolherModeloDoResumo.mockRejectedValue(new Error("IA fora"));
    await servico.pedirResumoDaDona(DONA, meetingId, vaga, { modelo: "ia" });
    await rodar();
    expect(await linhaDoResumo(meetingId)).toMatchObject({ status: "ready", template: "general", customTemplateId: null, aiTemplate: "chosen" });
  });

  it("o pedido antes de gravar: vale na reunião que ainda não ficou pronta; pronta, é fora de hora; na lixeira ou de outra dona, NOT_FOUND", async () => {
    const gravando = await reuniao(DONA, { status: "recording" });
    expect(await proprios.definirPedidoDoResumo(DONA, gravando, { modelo: "sales", estilo: "concise", instrucoes: " Preço e prazo. " }))
      .toEqual({ pedido: { modelo: "sales", estilo: "concise", instrucoes: "Preço e prazo." } });
    const pronta = await reuniao();
    await expect(proprios.definirPedidoDoResumo(DONA, pronta, null)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_MODELOS.pedidoForaDeHora });
    const naLixeira = await reuniao(DONA, { status: "recording", trashedAt: AGORA() });
    await expect(proprios.definirPedidoDoResumo(DONA, naLixeira, null)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(proprios.definirPedidoDoResumo(OUTRA, gravando, null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("o primeiro resumo nasce com o pedido de antes de gravar; sem ele, com as preferências; o modelo apagado cai no padrão", async () => {
    const banco = await db();
    await proprios.definirPreferencias(DONA, { padrao: "mentoring", estilo: "detailed" });
    const semPedido = await reuniao(DONA, { status: "processing" });
    expect(await proprios.colunasDoPrimeiroResumo(banco, DONA, semPedido)).toEqual({ template: "mentoring", customTemplateId: null, aiTemplate: null, style: "detailed", instructions: null });
    const comPedido = await reuniao(DONA, { status: "recording" });
    await proprios.definirPedidoDoResumo(DONA, comPedido, { modelo: "ia", estilo: "concise", instrucoes: "Só o essencial." });
    expect(await proprios.colunasDoPrimeiroResumo(banco, DONA, comPedido)).toEqual({ template: "general", customTemplateId: null, aiTemplate: "pending", style: "concise", instructions: "Só o essencial." });
    const { id } = await criar();
    await proprios.definirPedidoDoResumo(DONA, comPedido, { modelo: `proprio:${id}`, estilo: "balanced", instrucoes: null });
    await proprios.apagarModeloProprio(DONA, id);
    expect(await proprios.colunasDoPrimeiroResumo(banco, DONA, comPedido)).toMatchObject({ template: "mentoring", customTemplateId: null, style: "balanced" });
    // Pedido com forma errada (gravado por fora) é ignorado: valem as preferências.
    await banco.update(meetings).set({ summaryRequest: { modelo: "vendas", estilo: "longo" } }).where(eq(meetings.id, comPedido));
    expect(await proprios.colunasDoPrimeiroResumo(banco, DONA, comPedido)).toMatchObject({ template: "mentoring", style: "detailed" });
  });

  it("'O resumo teve o tamanho certo?': a resposta muda o ajuste, trocar de ideia não soma, o refazer zera a resposta e o próximo resumo leva o ajuste", async () => {
    const meetingId = await reuniao();
    await expect(proprios.responderTamanhoDoResumo(DONA, meetingId, "short")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await servico.pedirResumoDaDona(DONA, meetingId, vaga);
    await rodar();
    expect(await proprios.responderTamanhoDoResumo(DONA, meetingId, "long")).toEqual({ resposta: "long", ajusteDoTamanho: -1 });
    expect(await proprios.responderTamanhoDoResumo(DONA, meetingId, "short")).toEqual({ resposta: "short", ajusteDoTamanho: 1 });
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ tamanho: "short" });
    await expect(proprios.responderTamanhoDoResumo(OUTRA, meetingId, "short")).rejects.toMatchObject({ code: "NOT_FOUND" });
    gerarResumoDaReuniao.mockClear();
    await servico.refazerResumoDaDona(DONA, meetingId, { modelo: "general" }, vaga);
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({ preferencias: expect.objectContaining({ ajusteDoTamanho: 1 }) }));
    expect(await servico.resumoGuardadoDaDona(DONA, meetingId)).toMatchObject({ tamanho: null });
  });

  it("o teto de custo do refazer: 20 por dona em 24 h, contado no banco; a vaga volta quando o refazer não cria trabalho", async () => {
    const meetingId = await reuniao();
    await servico.pedirResumoDaDona(DONA, meetingId, vaga);
    await rodar();
    const banco = await db();
    await banco.insert(resumosRefeitos).values(Array.from({ length: REFAZERES_POR_DIA - 1 }, () => ({ id: crypto.randomUUID(), ownerId: DONA, createdAt: AGORA() })));
    // Uma linha de mais de 24 h não conta.
    await banco.insert(resumosRefeitos).values({ id: crypto.randomUUID(), ownerId: DONA, createdAt: AGORA() - 25 * 60 * 60_000 });
    expect(await proprios.refazeresQueRestam(DONA)).toBe(1);
    await servico.refazerResumoDaDona(DONA, meetingId, { modelo: "sales" }, vaga);
    expect(await proprios.refazeresQueRestam(DONA)).toBe(0);
    await rodar();
    await expect(servico.refazerResumoDaDona(DONA, meetingId, { modelo: "general" }, vaga)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DOS_MODELOS.refazeresDemais });
    expect(await linhaDoResumo(meetingId)).toMatchObject({ status: "ready", template: "sales" });
    // A outra dona não divide o teto.
    expect(await proprios.refazeresQueRestam(OUTRA)).toBe(REFAZERES_POR_DIA);
    // A vaga reservada que não chegou a criar trabalho volta.
    const soltar = await proprios.reservarRefazer(banco, OUTRA);
    expect(await proprios.refazeresQueRestam(OUTRA)).toBe(REFAZERES_POR_DIA - 1);
    await soltar();
    await soltar();
    expect(await proprios.refazeresQueRestam(OUTRA)).toBe(REFAZERES_POR_DIA);
  });
});
