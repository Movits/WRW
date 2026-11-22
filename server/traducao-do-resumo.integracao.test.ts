import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A tradução do resumo guardado (H11) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê; o que se prova é o banco: a
 * linha por dona, reunião e idioma, a dona no WHERE, o que o link recebe, a
 * versão do resumo e a impressão digital de cada item, a gravação que confere
 * o resumo na transação e a exclusão que leva as traduções. A edição da dona
 * (H4f) e o refazer (H4d) vão pelos caminhos de verdade (server/resumo-guardado.ts).
 */
const pedirJsonAIA = vi.hoisted(() => vi.fn());
vi.mock("./ia-em-json", async original => ({ ...(await original<typeof import("./ia-em-json")>()), pedirJsonAIA: (...a: unknown[]) => pedirJsonAIA(...a) }));

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, meetingSummaryTranslations, users } = await import("../drizzle/schema");
const traducao = await import("./traducao-do-resumo");
const guardado = await import("./resumo-guardado");
const { deletePrivateMeeting } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-traducao-${crypto.randomUUID()}`;
const OUTRA = `teste-traducao-outra-${crypto.randomUUID()}`;
const AGORA = () => Date.now();
async function db() { return (await getDb())!; }

type Pedido = { usuario: string };
type Enviado = { itens: Array<{ chave: string; assunto: string | null; texto: string; prazo: string | null }>; rotulos: Array<{ chave: string; rotulo: string }> };
const enviadoEm = (pedido: Pedido): Enviado => JSON.parse(pedido.usuario.slice(pedido.usuario.indexOf("{")));
const paraIngles = async (pedido: Pedido) => {
  const { itens, rotulos } = enviadoEm(pedido);
  return {
    dados: {
      itens: itens.map(i => ({ chave: i.chave, assunto: i.assunto && `EN ${i.assunto}`, texto: `EN ${i.texto}`, prazo: i.prazo && `EN ${i.prazo}` })),
      rotulos: rotulos.map(r => ({ chave: r.chave, rotulo: `EN ${r.rotulo}` })),
    },
    modelo: "gemini-teste-1",
  };
};

const ITENS = [
  { id: "", section: "action", subject: null, text: "{F2} avisa a transportadora", assignee: "{F2}", due: "até sexta", excerpt: "Decidimos não renovar o contrato com a transportadora", status: "pending" },
  { id: "", section: "task", subject: "Lojas", text: "Publicar o app com {F1}", assignee: null, due: null, excerpt: "a gente publica o app nas lojas", status: "confirmed" },
  { id: "", section: "question", subject: null, text: "Quem paga o frete?", assignee: null, due: null, excerpt: "e quem paga o frete disso", status: "ignored" },
] as const;

/** Uma reunião pronta, com o resumo pronto em pt-BR, versão 1, e os itens; devolve os ids. */
async function reuniaoComResumo(extra: { status?: "ready" | "processing" } = {}) {
  const banco = await db();
  const meetingId = crypto.randomUUID();
  const resumoId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id: meetingId, ownerId: DONA, title: "Reunião traduzida", status: extra.status ?? "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(),
  });
  await banco.insert(meetingSummaries).values({
    id: resumoId, meetingId, ownerId: DONA, status: "ready", language: "pt-BR", emoji: "☕", model: "gemini-teste-1", version: 1, generatedAt: AGORA(),
    createdAt: AGORA(), updatedAt: AGORA(),
  });
  const ids = ITENS.map(() => crypto.randomUUID());
  await banco.insert(meetingSummaryItems).values(ITENS.map((item, position) => ({
    ...item, id: ids[position], summaryId: resumoId, meetingId, ownerId: DONA, position, startSeconds: 5 * position, confidence: "0.900",
    done: false, createdAt: AGORA(), updatedAt: AGORA(),
  })));
  return { meetingId, resumoId, ids };
}

const traducoesDe = async (meetingId: string) => (await db()).select().from(meetingSummaryTranslations).where(eq(meetingSummaryTranslations.meetingId, meetingId));

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryTranslations, eq(meetingSummaryTranslations.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Tradução do resumo guardado no banco (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    traducao._paraTestes.limpar();
    pedirJsonAIA.mockReset();
    pedirJsonAIA.mockImplementation(paraIngles);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a dona recebe os textos traduzidos pelo id; a linha fica guardada por dona, reunião e idioma, sem o trecho", async () => {
    const { meetingId, resumoId, ids } = await reuniaoComResumo();

    const resposta = await traducao.traduzirResumoDaDona(DONA, meetingId, "en");

    expect(resposta).toEqual({
      estado: "pronta", idioma: "en", mapa: {},
      itens: [
        { id: ids[0], subject: null, text: "EN {F2} avisa a transportadora", due: "EN até sexta" },
        { id: ids[1], subject: "EN Lojas", text: "EN Publicar o app com {F1}", due: null },
        { id: ids[2], subject: null, text: "EN Quem paga o frete?", due: null },
      ],
    });
    const [linha, ...outras] = await traducoesDe(meetingId);
    expect(outras).toEqual([]);
    expect(linha).toMatchObject({ ownerId: DONA, meetingId, language: "en", summaryId: resumoId, sourceVersion: 1, model: "gemini-teste-1" });
    // O trecho é a prova, no idioma original: nem vai à IA, nem fica na tradução.
    expect(JSON.stringify(linha.content)).not.toContain("Decidimos");
    expect(pedirJsonAIA.mock.calls.map(([p]) => (p as Pedido).usuario).join("")).not.toContain("Decidimos");
  });

  it("o mapa mental pronto (H10) vai junto: o mapa que fica pronto depois manda à IA só os rótulos dele, que voltam no mapa da resposta", async () => {
    const { meetingId } = await reuniaoComResumo();
    expect(await traducao.traduzirResumoDaDona(DONA, meetingId, "en")).toMatchObject({ estado: "pronta", mapa: {} });
    pedirJsonAIA.mockClear();
    const MAPA = { ramos: [{ rotulo: "Transportadora", folhas: [{ rotulo: "Contrato", filhos: [] }] }, { rotulo: "Lojas", folhas: [] }] };
    await (await db()).update(meetingSummaries).set({ mindMap: MAPA, mindMapStatus: "ready", mindMapGeneratedAt: AGORA() })
      .where(eq(meetingSummaries.meetingId, meetingId));

    const resposta = await traducao.traduzirResumoDaDona(DONA, meetingId, "en");

    expect(resposta).toMatchObject({ estado: "pronta", mapa: { Transportadora: "EN Transportadora", Contrato: "EN Contrato", Lojas: "EN Lojas" } });
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    const enviado = enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido);
    expect(enviado.itens).toEqual([]);
    expect(enviado.rotulos.map(r => r.rotulo).sort()).toEqual(["Contrato", "Lojas", "Transportadora"]);
    // O mapa ainda na fila não manda rótulo nenhum.
    await (await db()).update(meetingSummaries).set({ mindMapStatus: "pending" }).where(eq(meetingSummaries.meetingId, meetingId));
    pedirJsonAIA.mockClear();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "es");
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).rotulos).toEqual([]);
  });

  it("guardada, volta sem IA; outro idioma é outra linha", async () => {
    const { meetingId } = await reuniaoComResumo();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    pedirJsonAIA.mockClear();
    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en")).resolves.toMatchObject({ estado: "pronta" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "es");
    expect((await traducoesDe(meetingId)).map(l => l.language).sort()).toEqual(["en", "es"]);
  });

  it("outra dona: NOT_FOUND, sem IA e sem linha", async () => {
    const { meetingId } = await reuniaoComResumo();
    await expect(traducao.traduzirResumoDaDona(OUTRA, meetingId, "en")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(await traducoesDe(meetingId)).toEqual([]);
  });

  it("o link recebe o resumo traduzido sem ids e sem os ignorados, e só gasta vaga quando chama a IA", async () => {
    const { meetingId } = await reuniaoComResumo();
    const antes = vi.fn();

    const resposta = await traducao.traduzirResumoPeloLink({ id: meetingId, ownerId: DONA }, "en", antes);
    expect(resposta).toEqual({
      estado: "pronta", idioma: "en", mapa: {},
      itens: [
        { section: "action", subject: null, text: "EN {F2} avisa a transportadora", assignee: "{F2}", due: "EN até sexta", excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds: 0, status: "pending", escritoPelaDona: false, trechoForaDaTranscricao: false },
        { section: "task", subject: "EN Lojas", text: "EN Publicar o app com {F1}", assignee: null, due: null, excerpt: "a gente publica o app nas lojas", startSeconds: 5, status: "confirmed", escritoPelaDona: false, trechoForaDaTranscricao: false },
      ],
    });
    expect(antes).toHaveBeenCalledTimes(1);
    await traducao.traduzirResumoPeloLink({ id: meetingId, ownerId: DONA }, "en", antes);
    expect(antes).toHaveBeenCalledTimes(1);
  });

  it("o resumo já no idioma pedido é 'original'; reunião fora de 'ready' é 'sem_resumo': nada vai à IA", async () => {
    const pronta = await reuniaoComResumo();
    await expect(traducao.traduzirResumoDaDona(DONA, pronta.meetingId, "pt-BR")).resolves.toEqual({ estado: "original", idioma: "pt-BR" });
    const processando = await reuniaoComResumo({ status: "processing" });
    await expect(traducao.traduzirResumoDaDona(DONA, processando.meetingId, "en")).resolves.toEqual({ estado: "sem_resumo", idioma: "en" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
  });

  it("G16: o resumo escrito num idioma fora dos 10 da tela (italiano) é traduzido para o pt-BR, e a IA sabe de que idioma", async () => {
    const pronta = await reuniaoComResumo();
    await (await db()).update(meetingSummaries).set({ language: "it" }).where(eq(meetingSummaries.id, pronta.resumoId));
    pedirJsonAIA.mockImplementation(paraIngles);
    const resposta = await traducao.traduzirResumoDaDona(DONA, pronta.meetingId, "pt-BR");
    expect(resposta.estado === "traduzindo" || resposta.estado === "pronta").toBe(true);
    await vi.waitFor(() => expect(pedirJsonAIA).toHaveBeenCalled());
    expect(String(pedirJsonAIA.mock.calls[0][0].sistema)).toContain("escritas em italiano");
  });

  it("a dona edita um item pelo caminho de verdade (H4f): só ele vai à IA, sem o resto do resumo nem o mapa, e a vaga sai uma vez", async () => {
    const { meetingId, ids } = await reuniaoComResumo();
    const MAPA = { ramos: [{ rotulo: "Transportadora", folhas: [{ rotulo: "Contrato", filhos: [] }] }, { rotulo: "Lojas", folhas: [] }] };
    await (await db()).update(meetingSummaries).set({ mindMap: MAPA, mindMapStatus: "ready", mindMapGeneratedAt: AGORA() }).where(eq(meetingSummaries.meetingId, meetingId));
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    pedirJsonAIA.mockClear();
    const antes = vi.fn();

    await guardado.editarItemDoResumo(DONA, ids[2], { texto: "Quem paga o frete e o seguro?", assunto: null, responsavel: null, prazo: null });
    const editada = await traducao.traduzirResumoDaDona(DONA, meetingId, "en", antes);

    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido)).toEqual({ itens: [{ chave: "i1", assunto: null, texto: "Quem paga o frete e o seguro?", prazo: null }], rotulos: [] });
    expect(antes).toHaveBeenCalledTimes(1);
    expect(editada).toMatchObject({ estado: "pronta", mapa: { Transportadora: "EN Transportadora", Contrato: "EN Contrato", Lojas: "EN Lojas" } });
    expect(editada.estado === "pronta" && editada.itens.map(i => i.text)).toEqual(["EN {F2} avisa a transportadora", "EN Publicar o app com {F1}", "EN Quem paga o frete e o seguro?"]);

    // Só o responsável mudou: nenhum texto traduzido mudou, e nada vai à IA.
    pedirJsonAIA.mockClear();
    await guardado.editarItemDoResumo(DONA, ids[0], { texto: "{F2} avisa a transportadora", assunto: null, responsavel: "{F1}", prazo: "até sexta" });
    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en", antes)).resolves.toMatchObject({ estado: "pronta" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(antes).toHaveBeenCalledTimes(1);
  });

  it("a dona acrescenta um item (H4f): só ele vai à IA; pelo link, ele sai com a marca do que a dona escreveu", async () => {
    const { meetingId } = await reuniaoComResumo();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    pedirJsonAIA.mockClear();

    await guardado.acrescentarItemDoResumo(DONA, meetingId, "action", { texto: "Ligar para o importador", assunto: null, responsavel: null, prazo: "amanhã" });
    const acrescentada = await traducao.traduzirResumoPeloLink({ id: meetingId, ownerId: DONA }, "en", vi.fn());

    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).itens).toEqual([{ chave: "i1", assunto: null, texto: "Ligar para o importador", prazo: "amanhã" }]);
    expect(acrescentada.estado === "pronta" && acrescentada.itens.map(i => [i.text, i.escritoPelaDona])).toEqual([
      ["EN {F2} avisa a transportadora", false], ["EN Publicar o app com {F1}", false], ["EN Ligar para o importador", true],
    ]);
  });

  it("o resumo refeito pela fila (outra versão) é traduzido de novo, e a linha fica só com os itens novos", async () => {
    const { meetingId, resumoId } = await reuniaoComResumo();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    const banco = await db();

    // A fila refaz o resumo: itens novos e a versão sobe.
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.summaryId, resumoId));
    const novo = crypto.randomUUID();
    await banco.insert(meetingSummaryItems).values({
      id: novo, summaryId: resumoId, meetingId, ownerId: DONA, section: "decision", position: 0, text: "Renovar com outra transportadora",
      excerpt: "vamos renovar com outra", status: "pending", done: false, confidence: "1.000", createdAt: AGORA(), updatedAt: AGORA(),
    });
    await banco.update(meetingSummaries).set({ version: 2 }).where(eq(meetingSummaries.id, resumoId));
    const refeita = await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    expect(refeita.estado === "pronta" && refeita.itens).toEqual([{ id: novo, subject: null, text: "EN Renovar com outra transportadora", due: null }]);
    const [linha] = await traducoesDe(meetingId);
    expect(linha.sourceVersion).toBe(2);
    expect(Object.keys((linha.content as { itens: object }).itens)).toEqual([novo]);
  });

  it("no refazer que falhou (H4d), a tradução guardada da versão anterior volta, e a dona a corrige; enquanto o refazer está em curso, só a guardada, sem IA", async () => {
    const { meetingId, resumoId, ids } = await reuniaoComResumo();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    const banco = await db();
    // A última falha do refazer: 'failed', a mesma versão e os mesmos itens.
    await banco.update(meetingSummaries).set({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS" }).where(eq(meetingSummaries.id, resumoId));
    pedirJsonAIA.mockClear();
    const antes = vi.fn();

    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en", antes)).resolves.toMatchObject({ estado: "pronta", itens: [{ text: "EN {F2} avisa a transportadora" }, {}, {}] });
    const peloLink = await traducao.traduzirResumoPeloLink({ id: meetingId, ownerId: DONA }, "en", antes);
    expect(peloLink.estado === "pronta" && peloLink.itens.map(i => i.text)).toEqual(["EN {F2} avisa a transportadora", "EN Publicar o app com {F1}"]);
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(antes).not.toHaveBeenCalled();

    // A dona corrige um item da versão que vale: só ele vai à IA, e a tradução fica guardada.
    await guardado.editarItemDoResumo(DONA, ids[1], { texto: "Publicar o app nas duas lojas", assunto: "Lojas", responsavel: null, prazo: null });
    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en", antes)).resolves.toMatchObject({ estado: "pronta", itens: [{}, { text: "EN Publicar o app nas duas lojas" }, {}] });
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).itens.map(i => i.texto)).toEqual(["Publicar o app nas duas lojas"]);
    pedirJsonAIA.mockClear();

    // A dona pede de novo: o refazer está em curso. A versão anterior segue na tela, traduzida, sem IA.
    await banco.update(meetingSummaries).set({ status: "pending", lastError: null }).where(eq(meetingSummaries.id, resumoId));
    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en", antes)).resolves.toMatchObject({ estado: "pronta", itens: [{}, { text: "EN Publicar o app nas duas lojas" }, {}] });
    // Outro idioma, sem nada guardado: espera a versão nova, sem IA.
    await expect(traducao.traduzirResumoPeloLink({ id: meetingId, ownerId: DONA }, "es", antes)).resolves.toEqual({ estado: "traduzindo", idioma: "es" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(antes).toHaveBeenCalledTimes(1);
  });

  it("o resumo refeito enquanto a IA traduzia: a tradução velha não é gravada", async () => {
    const { meetingId, resumoId } = await reuniaoComResumo();
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      await (await db()).update(meetingSummaries).set({ version: 2 }).where(eq(meetingSummaries.id, resumoId));
      return paraIngles(pedido);
    });
    await expect(traducao.traduzirResumoDaDona(DONA, meetingId, "en")).resolves.toEqual({ estado: "traduzindo", idioma: "en" });
    expect(await traducoesDe(meetingId)).toEqual([]);
  });

  it("excluir a reunião apaga as traduções do resumo", async () => {
    const { meetingId } = await reuniaoComResumo();
    await traducao.traduzirResumoDaDona(DONA, meetingId, "en");
    expect(await traducoesDe(meetingId)).toHaveLength(1);
    await deletePrivateMeeting(DONA, meetingId);
    expect(await traducoesDe(meetingId)).toEqual([]);
  });
});
