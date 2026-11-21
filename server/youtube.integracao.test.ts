import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O vídeo do YouTube (H13) contra um banco real DE TESTE (migração 0022; sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê (o pedido ao Gemini e a
 * extração): o que se prova é o banco — a reunião que nasce com a origem, a
 * URL canônica e o aviso; o trabalho que grava pelo caminho de sempre; o teto
 * de 5 vídeos por dona a cada 24 h, contado na auditoria, com a trava da
 * conta; a falha com o código; o "Tentar de novo"; a exclusão e a varredura no
 * meio, arbitradas pela ficha; e o link aberto com o id do vídeo.
 *
 * Donas com id aleatório: a limpeza no fim só alcança o que este arquivo criou.
 */
const geminiPost = vi.hoisted(() => vi.fn());
vi.mock("./gemini", async original => ({ ...(await original<typeof import("./gemini")>()), geminiPost: (...a: unknown[]) => geminiPost(...a) }));
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...a) }));
// O bucket é dublê: a reunião do YouTube não tem áudio, e nada aqui pode falar com um bucket de verdade.
const apagarAudio = vi.hoisted(() => vi.fn(async (_chave: string) => {}));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: (...args: unknown[]) => apagarAudio(...(args as [string])),
}));

const { getDb } = await import("./db");
const { auditLogs, meetingContactSuggestions, meetingEntities, meetingSummaries, meetingTranscripts, meetings, users } = await import("../drizzle/schema");
const youtube = await import("./youtube");
const { GeminiRecusouChamadaError } = await import("./gemini");
const { deletePrivateMeeting, getPrivateMeeting } = await import("./meeting-service");
const { gerarTokenDoLink, verReuniaoPeloLink } = await import("./link-aberto-da-reuniao");
const { appRouter } = await import("./routers");
const { VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE, VIDEOS_DO_YOUTUBE_POR_DIA } = await import("@shared/youtube");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const ID = "dQw4w9WgXcQ";
const CANONICA = `https://www.youtube.com/watch?v=${ID}`;
const AVISO = VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE;

type Conta = { userId: number; openId: string; ipAddress: string; userAgent: string };
const donas: Conta[] = [];

async function db() { return (await getDb())!; }

/** Uma dona nova, com a linha da conta (a trava do teto é nela). */
async function novaDona(): Promise<Conta> {
  const openId = `teste-youtube-${crypto.randomUUID()}`;
  const banco = await db();
  await banco.insert(users).values({ openId, onboardingCompleted: true });
  const [linha] = await banco.select({ id: users.id }).from(users).where(eq(users.openId, openId)).limit(1);
  const conta = { userId: linha.id, openId, ipAddress: "203.0.113.9", userAgent: "vitest-youtube" };
  donas.push(conta);
  return conta;
}

const resposta = (segmentos: unknown[]) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ segmentos }) }] } }] });
const FALAS = [
  { inicio: "00:05", fim: "00:20", falante: "F1", texto: "Boas-vindas ao painel sobre exportação." },
  { inicio: "07:30", fim: "07:45", falante: "F2", texto: "Obrigada pelo convite." },
];

/** Uma resposta do Gemini que só chega quando o teste mandar. */
function respostaSegurada() {
  let soltar!: (valor: unknown) => void;
  const promessa = new Promise(resolve => { soltar = resolve; });
  geminiPost.mockImplementationOnce(() => promessa);
  return () => soltar(resposta(FALAS));
}

const pedir = (conta: Conta, url = `https://youtu.be/${ID}?si=rastreio`) =>
  youtube.pedirResumoDoVideo(conta, { titulo: "Painel de exportação", url, idioma: "pt-BR", versaoDoAviso: AVISO });

const reuniaoDe = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];
const transcricaoDe = async (id: string) => (await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id)))[0];
const pedidosDe = async (conta: Conta) => (await db()).select().from(auditLogs)
  .where(and(eq(auditLogs.userId, conta.userId), eq(auditLogs.action, youtube.ACAO_DO_VIDEO_DO_YOUTUBE)));

async function recusaDe(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof youtube.RecusaDoVideo) return erro;
    throw erro;
  }
  throw new Error("era para recusar");
}

/** O router não espera o trabalho em segundo plano: o teste espera as reuniões saírem de 'processing'. */
async function esperarTerminarem(conta: Conta) {
  for (let volta = 0; volta < 100; volta++) {
    const emCurso = await (await db()).select({ id: meetings.id }).from(meetings)
      .where(and(eq(meetings.ownerId, conta.openId), eq(meetings.status, "processing")));
    if (!emCurso.length) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("as reuniões não terminaram");
}

function contexto(conta: Conta) {
  return {
    user: { id: conta.userId, openId: conta.openId, role: "bronze", isActive: true, onboardingCompleted: true },
    req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as never;
}

describe.skipIf(!temBanco)("Vídeo do YouTube no banco (integração)", () => {
  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    const banco = await getDb();
    if (!banco || !donas.length) return;
    const openIds = donas.map(d => d.openId);
    await banco.delete(meetingContactSuggestions).where(inArray(meetingContactSuggestions.ownerId, openIds));
    await banco.delete(meetingEntities).where(inArray(meetingEntities.ownerId, openIds));
    await banco.delete(meetingSummaries).where(inArray(meetingSummaries.ownerId, openIds));
    await banco.delete(meetingTranscripts).where(inArray(meetingTranscripts.ownerId, openIds));
    await banco.delete(meetings).where(inArray(meetings.ownerId, openIds));
    await banco.delete(auditLogs).where(inArray(auditLogs.userId, donas.map(d => d.userId)));
    await banco.delete(users).where(inArray(users.openId, openIds));
  });

  beforeEach(() => {
    geminiPost.mockReset();
    invokeLLM.mockReset();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });
  });

  it("o vídeo vira reunião: nasce em 'processing' com a origem, a URL canônica e o aviso, e fica pronta pelo caminho de sempre", async () => {
    const dona = await novaDona();
    const soltar = respostaSegurada();
    const { id, trabalho } = await pedir(dona);

    const nascida = await reuniaoDe(id);
    expect(nascida).toMatchObject({
      ownerId: dona.openId, status: "processing", origem: "youtube", sourceUrl: CANONICA, audioPipeline: "single",
      consentGranted: true, consentNoticeVersion: AVISO, language: "pt-BR", title: "Painel de exportação",
    });
    // O link colado nunca vai ao banco: só a URL canônica, sem o "si" de rastreio.
    expect(JSON.stringify(nascida)).not.toContain("rastreio");

    soltar();
    await trabalho;

    expect((await reuniaoDe(id))).toMatchObject({ status: "ready", processingError: null });
    // O Gemini recebeu o vídeo pela URL canônica, cortado na primeira hora.
    const [caminho, corpo] = geminiPost.mock.calls[0] as [string, any];
    expect(caminho).toBe("/models/gemini-3.5-flash:generateContent");
    expect(corpo.contents[0].parts[0]).toMatchObject({ file_data: { file_uri: CANONICA }, video_metadata: { start_offset: "0s", end_offset: "3600s" } });
    // A transcrição no contrato das partes: tempos em segundos, falantes F1/F2.
    const transcricao = await transcricaoDe(id);
    expect(transcricao.segments).toEqual([
      { inicio: 5, fim: 20, falante: "F1", texto: "Boas-vindas ao painel sobre exportação." },
      { inicio: 450, fim: 465, falante: "F2", texto: "Obrigada pelo convite." },
    ]);
    expect(transcricao.transcript).toBe("Boas-vindas ao painel sobre exportação.\nObrigada pelo convite.");
    expect(transcricao).toMatchObject({ language: "pt-BR", durationSeconds: 465 });
    // A extração lê as falas com o rótulo da voz, como a montagem das partes.
    expect(JSON.stringify(invokeLLM.mock.calls[0][0].messages)).toContain("{F1}: Boas-vindas");
    // O resumo guardado nasce pedido: a fila do resumo o gera, e o mapa depois.
    const [resumo] = await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id));
    expect(resumo).toMatchObject({ status: "pending", transcriptId: transcricao.id });
    // A prova do pedido: a versão do aviso, IP e user-agent, e nada do vídeo.
    const [prova] = await pedidosDe(dona);
    expect(prova).toMatchObject({ resourceId: id, resource: "meetings", ipAddress: "203.0.113.9", userAgent: "vitest-youtube", status: "success" });
    expect(prova.details).toEqual({ origem: "youtube", consentNoticeVersion: AVISO, refazer: false });
    expect(JSON.stringify(prova.details)).not.toContain(ID);

    // O detalhe da dona leva a origem e a URL; o link aberto, só o id do vídeo.
    const detalhe = await getPrivateMeeting(dona.openId, id);
    expect(detalhe?.meeting).toMatchObject({ origem: "youtube", sourceUrl: CANONICA });
    const token = gerarTokenDoLink();
    await (await db()).update(meetings).set({ shareToken: token }).where(eq(meetings.id, id));
    const peloLink = await verReuniaoPeloLink(token);
    expect(peloLink.videoDoYoutube).toBe(ID);
    expect(JSON.stringify(peloLink)).not.toContain(CANONICA);
  });

  it("o link que não é de vídeo é recusado antes de tudo: nenhuma reunião, nenhuma vaga gasta", async () => {
    const dona = await novaDona();
    const recusa = await recusaDe(pedir(dona, "https://vimeo.com/123456"));
    expect(recusa).toMatchObject({ codigoTrpc: "BAD_REQUEST", message: "YOUTUBE_LINK_INVALIDO" });
    expect(await (await db()).select().from(meetings).where(eq(meetings.ownerId, dona.openId))).toHaveLength(0);
    expect(await pedidosDe(dona)).toHaveLength(0);
    expect(geminiPost).not.toHaveBeenCalled();
  });

  it(`o teto: ${VIDEOS_DO_YOUTUBE_POR_DIA} vídeos por dona a cada 24 h, e excluir a reunião não devolve a vaga`, async () => {
    const dona = await novaDona();
    geminiPost.mockResolvedValue(resposta(FALAS));
    const trabalhos: Promise<void>[] = [];
    for (let i = 0; i < VIDEOS_DO_YOUTUBE_POR_DIA; i++) trabalhos.push((await pedir(dona)).trabalho);
    await Promise.all(trabalhos);

    const recusa = await recusaDe(pedir(dona));
    expect(recusa).toMatchObject({ codigoTrpc: "TOO_MANY_REQUESTS", message: "YOUTUBE_TETO_DIARIO" });
    const reunioes = await (await db()).select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, dona.openId));
    expect(reunioes).toHaveLength(VIDEOS_DO_YOUTUBE_POR_DIA);

    // Excluir a reunião não devolve a vaga: o vídeo já foi à IA.
    expect(await deletePrivateMeeting(dona.openId, reunioes[0].id)).toBe(true);
    expect((await recusaDe(pedir(dona))).message).toBe("YOUTUBE_TETO_DIARIO");

    // Outra dona tem o teto dela.
    const outra = await novaDona();
    await (await pedir(outra)).trabalho;

    // O que passou de 24 h sai da conta: dois pedidos de ontem liberam duas vagas.
    const ids = (await pedidosDe(dona)).map(p => p.id).slice(0, 2);
    await (await db()).update(auditLogs).set({ createdAt: sql`(now() - interval 25 hour)` }).where(inArray(auditLogs.id, ids));
    expect(await youtube.videosDasUltimas24h(await db(), dona.userId)).toBe(VIDEOS_DO_YOUTUBE_POR_DIA - 2);
    await (await pedir(dona)).trabalho;
    await (await pedir(dona)).trabalho;
    expect((await recusaDe(pedir(dona))).message).toBe("YOUTUBE_TETO_DIARIO");
  });

  it("pedidos ao mesmo tempo não furam o teto: a trava da conta os enfileira", async () => {
    const dona = await novaDona();
    geminiPost.mockResolvedValue(resposta(FALAS));
    const resultados = await Promise.allSettled(Array.from({ length: VIDEOS_DO_YOUTUBE_POR_DIA + 2 }, () => pedir(dona)));
    const aceitos = resultados.filter((r): r is PromiseFulfilledResult<{ id: string; trabalho: Promise<void> }> => r.status === "fulfilled");
    const recusados = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(aceitos).toHaveLength(VIDEOS_DO_YOUTUBE_POR_DIA);
    expect(recusados.map(r => (r.reason as Error).message)).toEqual(["YOUTUBE_TETO_DIARIO", "YOUTUBE_TETO_DIARIO"]);
    await Promise.all(aceitos.map(r => r.value.trabalho));
    expect(await pedidosDe(dona)).toHaveLength(VIDEOS_DO_YOUTUBE_POR_DIA);
  });

  it("o vídeo privado falha com o código, e o \"Tentar de novo\" lê o vídeo outra vez e gasta uma vaga", async () => {
    const dona = await novaDona();
    geminiPost.mockRejectedValueOnce(new GeminiRecusouChamadaError(400, "Request contains an invalid argument."));
    const { id, trabalho } = await pedir(dona);
    await trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "YOUTUBE_VIDEO_PRIVADO" });
    expect(await transcricaoDe(id)).toBeUndefined();

    geminiPost.mockResolvedValueOnce(resposta(FALAS));
    const { trabalho: deNovo } = await youtube.refazerResumoDoVideo(dona, id);
    await deNovo;
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", processingError: null });
    expect((await transcricaoDe(id)).segments).toHaveLength(2);
    const pedidos = await pedidosDe(dona);
    expect(pedidos).toHaveLength(2);
    expect(pedidos.map(p => (p.details as { refazer: boolean }).refazer).sort()).toEqual([false, true]);

    // Pronta, não se refaz.
    expect(await recusaDe(youtube.refazerResumoDoVideo(dona, id))).toMatchObject({ codigoTrpc: "CONFLICT" });
  });

  it("G16: com \"Detectar sozinho\", a transcrição grava o idioma que mais aparece nas falas (e a reunião segue em \"auto\"), também no \"Tentar de novo\"", async () => {
    const dona = await novaDona();
    // 40 s em inglês e 9 s em português: o idioma da transcrição é o inglês, e não o "auto".
    const FALAS_COM_IDIOMA = [
      { inicio: "00:00", fim: "00:40", falante: "F1", texto: "Welcome to the export panel.", idioma: "en" },
      { inicio: "00:40", fim: "00:49", falante: "F2", texto: "Obrigada pelo convite.", idioma: "pt" },
    ];
    geminiPost.mockResolvedValueOnce(resposta(FALAS_COM_IDIOMA));
    const { id, trabalho } = await youtube.pedirResumoDoVideo(dona, { titulo: "Painel", url: `https://youtu.be/${ID}`, idioma: "auto", versaoDoAviso: AVISO });
    await trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", language: "auto" });
    expect(await transcricaoDe(id)).toMatchObject({ language: "en" });

    // O "Tentar de novo" passa pelo mesmo caminho.
    await (await db()).update(meetings).set({ status: "failed", processingError: "YOUTUBE_FALHOU" }).where(eq(meetings.id, id));
    geminiPost.mockResolvedValueOnce(resposta(FALAS_COM_IDIOMA));
    const { trabalho: deNovo } = await youtube.refazerResumoDoVideo(dona, id);
    await deNovo;
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", language: "auto" });
    expect(await transcricaoDe(id)).toMatchObject({ language: "en" });
  });

  it("o \"Tentar de novo\" só vale para a reunião do YouTube da própria dona, e a recusa não gasta vaga", async () => {
    const dona = await novaDona();
    const outra = await novaDona();
    geminiPost.mockRejectedValueOnce(new GeminiRecusouChamadaError(400, "Request contains an invalid argument."));
    const { id, trabalho } = await pedir(dona);
    await trabalho;

    expect(await recusaDe(youtube.refazerResumoDoVideo(outra, id))).toMatchObject({ codigoTrpc: "NOT_FOUND" });
    expect(await recusaDe(youtube.refazerResumoDoVideo(dona, crypto.randomUUID()))).toMatchObject({ codigoTrpc: "NOT_FOUND" });
    const gravada = crypto.randomUUID();
    await (await db()).insert(meetings).values({
      id: gravada, ownerId: dona.openId, title: "Gravação com falha", status: "failed", consentGranted: true,
      origem: "gravacao", createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await recusaDe(youtube.refazerResumoDoVideo(dona, gravada))).toMatchObject({ codigoTrpc: "PRECONDITION_FAILED" });
    expect(await pedidosDe(dona)).toHaveLength(1);
    expect(await pedidosDe(outra)).toHaveLength(0);
  });

  it.each([
    ["YOUTUBE_LONGO_DEMAIS", { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"segmentos":[' }] } }] }],
    ["YOUTUBE_SEM_FALA", resposta([{ inicio: "00:00", fim: "03:00", falante: "F1", texto: "[música]" }])],
  ])("a falha que se repete com o mesmo vídeo (%s) não se refaz: a recusa sai com o código, sem gastar vaga nem ir à IA", async (codigo, respostaDoGemini) => {
    const dona = await novaDona();
    geminiPost.mockResolvedValueOnce(respostaDoGemini);
    const { id, trabalho } = await pedir(dona);
    await trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: codigo });

    expect(await recusaDe(youtube.refazerResumoDoVideo(dona, id))).toMatchObject({ codigoTrpc: "PRECONDITION_FAILED", message: codigo });
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: codigo });
    expect(await pedidosDe(dona)).toHaveLength(1);
    expect(geminiPost).toHaveBeenCalledTimes(1);
  });

  it("vídeo sem fala: a reunião falha com YOUTUBE_SEM_FALA, sem transcrição", async () => {
    const dona = await novaDona();
    geminiPost.mockResolvedValueOnce(resposta([{ inicio: "00:00", fim: "03:00", falante: "F1", texto: "[música]" }]));
    const { id, trabalho } = await pedir(dona);
    await trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "YOUTUBE_SEM_FALA" });
    expect(await transcricaoDe(id)).toBeUndefined();
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("excluída enquanto a IA lê o vídeo: nada é gravado depois", async () => {
    const dona = await novaDona();
    const soltar = respostaSegurada();
    const { id, trabalho } = await pedir(dona);
    expect(await deletePrivateMeeting(dona.openId, id)).toBe(true);
    soltar();
    await trabalho;
    expect(await reuniaoDe(id)).toBeUndefined();
    expect(await transcricaoDe(id)).toBeUndefined();
    expect(await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id))).toHaveLength(0);
  });

  it("tomada pela varredura de interrompidas no meio: o trabalho velho sai sem escrever", async () => {
    const dona = await novaDona();
    const soltar = respostaSegurada();
    const { id, trabalho } = await pedir(dona);
    await (await db()).update(meetings).set({ status: "failed", processingError: "ERRO_INTERROMPIDO", updatedAt: Date.now() + 5 }).where(eq(meetings.id, id));
    soltar();
    await trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "ERRO_INTERROMPIDO" });
    expect(await transcricaoDe(id)).toBeUndefined();
  });

  it("pelo router: a conta da sessão vira a dona, o IP e o user-agent vão à prova, e as recusas saem com o código", async () => {
    const dona = await novaDona();
    const caller = appRouter.createCaller(contexto(dona));
    geminiPost.mockResolvedValue(resposta(FALAS));
    const entrada = { title: "Palestra", url: `https://www.youtube.com/shorts/${ID}`, language: "pt-BR", consentGranted: true as const, consentNoticeVersion: AVISO };

    const { id } = await caller.meetings.resumirVideoDoYoutube(entrada);
    expect(await reuniaoDe(id)).toMatchObject({ ownerId: dona.openId, origem: "youtube", sourceUrl: CANONICA });
    const [prova] = await pedidosDe(dona);
    expect(prova).toMatchObject({ resourceId: id, ipAddress: "127.0.0.1", userAgent: "Vitest/1.0" });

    const invalido = await caller.meetings.resumirVideoDoYoutube({ ...entrada, url: "https://exemplo.com/video" }).catch(erro => erro);
    expect(invalido).toBeInstanceOf(TRPCError);
    expect(invalido).toMatchObject({ code: "BAD_REQUEST", message: "YOUTUBE_LINK_INVALIDO" });

    // Esgota o teto pelo router, e a recusa sai com o código.
    for (let i = 1; i < VIDEOS_DO_YOUTUBE_POR_DIA; i++) await caller.meetings.resumirVideoDoYoutube(entrada);
    const teto = await caller.meetings.resumirVideoDoYoutube(entrada).catch(erro => erro);
    expect(teto).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "YOUTUBE_TETO_DIARIO" });
    await esperarTerminarem(dona);
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready" });
    // Pronta, a reunião não está com falha: CONFLICT, nunca outra tentativa.
    const refazer = await caller.meetings.refazerVideoDoYoutube({ meetingId: id }).catch(erro => erro);
    expect(refazer).toMatchObject({ code: "CONFLICT" });
  });
});
