import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A fila da reunião em partes (G7) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA e o bucket são dublês: o que se prova é o
 * banco — a reserva atômica, a ordem das partes, a montagem pelo mesmo caminho
 * do envio único, as falhas e a devolução das reservas no SIGTERM.
 */
const transcreverFatia = vi.hoisted(() => vi.fn());
vi.mock("./transcricao-de-fatia", async original => ({ ...(await original<typeof import("./transcricao-de-fatia")>()), transcreverFatia: (...a: unknown[]) => transcreverFatia(...a) }));
const storageGetBytes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({ ...(await original<typeof import("./storage")>()), storageGetBytes: (...a: unknown[]) => storageGetBytes(...a) }));
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...a) }));

const { getDb } = await import("./db");
const { meetingAudioSlices, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const fila = await import("./fila-de-transcricao");
const { ObjetoAusenteNoStorageError } = await import("./storage");
const { GeminiIndisponivelError } = await import("./gemini");
const { TemposForaDaParteError } = await import("./transcricao-de-fatia");
const { marcarReunioesInterrompidas, iniciarReprocessamento, REGRA_DOS_ROTULOS_NA_EXTRACAO, ReprocessamentoRecusado } = await import("./meeting-service");
const { terminaComALinhaPresa: comALinhaPresa } = await import("./test/linha-presa");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
// A rodada só olha as reuniões desta dona: o Vitest roda os arquivos em
// paralelo no mesmo banco, e outro arquivo cria reuniões em partes também.
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const DONA = `teste-fila-${crypto.randomUUID()}`;
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

async function reuniao(status: "recording" | "uploading", esperadas: number | null, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: "Reunião da fila", status, consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    audioPipeline: "slices", expectedSlices: esperadas, createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  return id;
}

const linhaDaParte = (meetingId: string, seq: number, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), meetingId, ownerId: DONA, seq, status: "received" as const, storageKey: `meetings/${DONA}/${meetingId}/partes/${seq}.m4a`,
  storageUrl: `/manus-storage/meetings/${DONA}/${meetingId}/partes/${seq}.m4a`, mimeType: "audio/mp4", sizeBytes: 10,
  sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), durationMs: 600_000, expiresAt: AGORA() + 86_400_000,
  createdAt: AGORA() + seq, updatedAt: AGORA(), ...extra,
});

async function parte(meetingId: string, seq: number, extra: Record<string, unknown> = {}) {
  await (await db()).insert(meetingAudioSlices).values(linhaDaParte(meetingId, seq, extra));
}

type Transacao = import("./test/linha-presa").Transacao;
/** O trabalho terminou com a linha de `segurar` presa por outra transação, sem commit (server/test/linha-presa.ts)? */
const terminaComALinhaPresa = async (segurar: (tx: Transacao) => Promise<unknown>, trabalho: () => Promise<unknown>) =>
  comALinhaPresa(await db(), segurar, trabalho);

const partesDe = async (meetingId: string) => (await db()).select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId)).orderBy(meetingAudioSlices.seq);
const reuniaoDe = async (meetingId: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, meetingId)))[0];

describe.skipIf(!temBanco)("Fila de transcrição no banco (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values({ openId: DONA }); });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    // A reunião que fica pronta ganha o pedido do resumo guardado (H4c).
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, DONA));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
    await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(banco, meetingAudioSlices, eq(meetingAudioSlices.ownerId, DONA));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA));
    await banco.delete(users).where(eq(users.openId, DONA));
  });
  beforeEach(async () => {
    const banco = await db();
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, DONA));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
    await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(banco, meetingAudioSlices, eq(meetingAudioSlices.ownerId, DONA));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA));
    fila.religarParaTestes();
    transcreverFatia.mockReset();
    storageGetBytes.mockReset();
    storageGetBytes.mockResolvedValue(Buffer.from("audio"));
    invokeLLM.mockReset();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("transcreve na ordem: a parte 1 espera a 0, e leva o contexto e o início dela", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0);
    await parte(id, 1);
    transcreverFatia.mockImplementation(async ({ inicioSegundos }: { inicioSegundos: number }) => ({
      segmentos: [{ inicio: inicioSegundos + 1, fim: inicioSegundos + 2, falante: "F1", texto: `fala em ${inicioSegundos}` }], idioma: "pt-BR", modelo: "gemini-teste",
    }));

    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(1);
    expect((await partesDe(id)).map(p => p.status)).toEqual(["transcribed", "received"]);

    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(2);
    const segunda = transcreverFatia.mock.calls[1][0];
    expect(segunda.inicioSegundos).toBe(600);
    expect(segunda.anterior).toMatchObject({ falantes: ["F1"], ultimasFalas: [{ texto: "fala em 0" }] });
    const [p0, p1] = await partesDe(id);
    expect(p1).toMatchObject({ status: "transcribed", offsetMs: 600_000, model: "gemini-teste", lockToken: null, attempts: 1 });
    expect(p0.result).toMatchObject({ segmentos: [{ texto: "fala em 0" }] });
  });

  it("reunião encerrada com tudo transcrito: monta, grava pelo caminho do envio único, fica pronta e chama o gancho", async () => {
    const id = await reuniao("uploading", 2);
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Bom dia." }] } });
    await parte(id, 1, { status: "transcribed", offsetMs: 600_000, result: { segmentos: [{ inicio: 601, fim: 602, falante: "F2", texto: "Combinado." }] } });
    const gancho = vi.fn();
    const soltar = fila.aoFicarPronta(gancho);
    try {
      await rodar();
    } finally {
      soltar();
    }
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", lockToken: null, processingError: null });
    const [transcricao] = await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    expect(transcricao).toMatchObject({ transcript: "Bom dia.\nCombinado.", language: "pt-BR", durationSeconds: 1200 });
    expect(transcricao.segments).toEqual([
      { inicio: 1, fim: 2, falante: "F1", texto: "Bom dia." },
      { inicio: 601, fim: 602, falante: "F2", texto: "Combinado." },
    ]);
    expect(gancho).toHaveBeenCalledWith({ meetingId: id, ownerId: DONA });
    // A extração lê as falas com o rótulo da voz, e o prompt explica os rótulos
    // (revisão do pacote P2B): sem eles, a presença de quem fala sem dizer o
    // nome era chute. A transcrição gravada, acima, segue sem rótulos.
    const extracao = invokeLLM.mock.calls.map(([pedido]) => pedido as { funcao?: string; messages: Array<{ content: string }> })
      .find(pedido => pedido.funcao === "extracao")!;
    expect(extracao.messages[1].content).toContain("{F1}: Bom dia.\n{F2}: Combinado.");
    expect(extracao.messages[0].content).toContain(REGRA_DOS_ROTULOS_NA_EXTRACAO);
    // Pronta, a reunião em partes ganha o pedido do resumo guardado, da
    // transcrição montada: a fila do resumo o gera em segundo plano (H4c).
    const resumos = await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id));
    expect(resumos).toEqual([expect.objectContaining({ ownerId: DONA, status: "pending", transcriptId: transcricao.id, attempts: 0, lockToken: null })]);
  });

  it("G16: com \"Detectar sozinho\", a parte vai à IA como \"auto\" e a transcrição montada fica com o idioma que mais aparece, com o de cada fala", async () => {
    const id = await reuniao("recording", null, { language: "auto" });
    await parte(id, 0);
    transcreverFatia.mockResolvedValue({ segmentos: [{ inicio: 1, fim: 100, falante: "F1", texto: "Good morning, let's review the contract.", idioma: "en" }], idioma: "auto", modelo: "gemini-teste" });
    await rodar();
    expect(transcreverFatia.mock.calls[0][0]).toMatchObject({ idioma: "auto" });
    await (await db()).update(meetings).set({ status: "uploading", expectedSlices: 2 }).where(eq(meetings.id, id));
    await parte(id, 1, { status: "transcribed", offsetMs: 600_000, result: { segmentos: [
      { inicio: 601, fim: 640, falante: "F2", texto: "Então combinado, eu mando hoje.", idioma: "pt-BR" },
    ] } });
    await rodar();
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", language: "auto" });
    const [transcricao] = await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    // 99 s em inglês contra 39 s em português: o resumo sai em inglês.
    expect(transcricao.language).toBe("en");
    expect((transcricao.segments as Array<{ idioma?: string }>).map(segmento => segmento.idioma)).toEqual(["en", "pt-BR"]);
  });

  it("G16: com \"Detectar sozinho\" e nenhum idioma reconhecido, a transcrição fica com o padrão; com o idioma escolhido, com ele", async () => {
    const auto = await reuniao("uploading", 1, { language: "auto" });
    await parte(auto, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Oi." }] } });
    const italiano = await reuniao("uploading", 1, { language: "it" });
    await parte(italiano, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Ciao.", idioma: "en" }] } });
    await rodar();
    const idiomaDe = async (meetingId: string) => (await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId)))[0]?.language;
    expect(await idiomaDe(auto)).toBe("pt-BR");
    expect(await idiomaDe(italiano)).toBe("it");
  });

  it("áudio que sumiu do bucket é falha definitiva: a parte vira lacuna, e a reunião monta com o que chegou", async () => {
    const id = await reuniao("uploading", 2);
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Antes." }] } });
    await parte(id, 1);
    storageGetBytes.mockRejectedValue(new ObjetoAusenteNoStorageError("x"));
    await rodar();
    expect((await partesDe(id))[1]).toMatchObject({ status: "failed", lastError: "AUDIO_AUSENTE", lockToken: null });
    await rodar();
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready" });
    const [transcricao] = await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    expect(transcricao.segments).toEqual([
      { inicio: 1, fim: 2, falante: "F1", texto: "Antes." },
      { inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true },
    ]);
  });

  it("IA fora é passageira: a parte volta à fila com espera e tentativa somada; na terceira, vira falha", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0);
    transcreverFatia.mockRejectedValue(new GeminiIndisponivelError(503));
    await rodar();
    let [p] = await partesDe(id);
    expect(p).toMatchObject({ status: "received", attempts: 1, lastError: "IA_INDISPONIVEL", lockToken: null });
    expect(Number(p.lockedUntil)).toBeGreaterThan(AGORA());
    // A espera vence; mais duas tentativas.
    for (let i = 0; i < 2; i++) {
      await (await db()).update(meetingAudioSlices).set({ lockedUntil: AGORA() - 1 }).where(eq(meetingAudioSlices.meetingId, id));
      await rodar();
    }
    [p] = await partesDe(id);
    expect(p).toMatchObject({ status: "failed", attempts: 3 });
    expect(transcreverFatia).toHaveBeenCalledTimes(3);
  });

  it("tempos quase todos fora da parte: volta à fila antes da última tentativa; na última, entra transcrita com as contagens no result", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0);
    const tempos = { presasNoFim: 3, semTempo: 0, total: 3 };
    // O dublê faz o que a G6 faz: lança antes da última tentativa e, na última,
    // devolve as falas empilhadas no fim, com as contagens.
    transcreverFatia.mockImplementation(async ({ ultimaTentativa }: { ultimaTentativa?: boolean }) => {
      if (!ultimaTentativa) throw new TemposForaDaParteError(tempos);
      return { segmentos: [{ inicio: 602, fim: 602, falante: "F1", texto: "Empilhada no fim." }], idioma: "pt-BR", modelo: "gemini-teste", tempos };
    });
    await rodar();
    let [p] = await partesDe(id);
    expect(p).toMatchObject({ status: "received", attempts: 1, lastError: "TEMPOS_FORA_DA_PARTE", lockToken: null });
    for (let i = 0; i < 2; i++) {
      await (await db()).update(meetingAudioSlices).set({ lockedUntil: AGORA() - 1 }).where(eq(meetingAudioSlices.meetingId, id));
      await rodar();
    }
    [p] = await partesDe(id);
    expect(transcreverFatia.mock.calls.map(([entrada]) => entrada.ultimaTentativa)).toEqual([false, false, true]);
    expect(p).toMatchObject({ status: "transcribed", attempts: 3, lastError: null });
    // Uma consulta acha a parte degradada pelas contagens no result.
    expect(p.result).toEqual({ segmentos: [{ inicio: 602, fim: 602, falante: "F1", texto: "Empilhada no fim." }], contexto: expect.any(Object), tempos });
  });

  it("a extração recebe o texto montado inteiro, e o contador cobra só o transcrito (a lacuna não)", async () => {
    const id = await reuniao("uploading", 2);
    await parte(id, 0, { status: "transcribed", offsetMs: 0, durationMs: 300_000, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Primeira fala." }] } });
    await parte(id, 1, { status: "failed", durationMs: 600_000 });
    await rodar();
    const extracao = invokeLLM.mock.calls.find(c => JSON.stringify(c[0]).includes("Extraia"));
    expect(JSON.stringify(extracao?.[0])).toContain("Primeira fala.");
    const [transcricao] = await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    expect(transcricao.durationSeconds).toBe(300);
  });

  it("falha passageira na montagem (IA da extração fora) volta a 'uploading' com espera; sem texto nenhum, vira falha com frase para a dona", async () => {
    const passageira = await reuniao("uploading", 1);
    await parte(passageira, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Fala." }] } });
    invokeLLM.mockRejectedValue(new Error("IA fora"));
    await rodar();
    const r = await reuniaoDe(passageira);
    expect(r).toMatchObject({ status: "uploading", attempts: 1, lockToken: null });
    expect(Number(r.lockedUntil)).toBeGreaterThan(AGORA());

    const vazia = await reuniao("uploading", 1);
    await parte(vazia, 0, { status: "failed" });
    await rodar();
    expect(await reuniaoDe(vazia)).toMatchObject({ status: "failed", processingError: "Não foi possível transcrever o áudio desta reunião." });
  });

  it("parte que não chegou: a seguinte espera; passadas 24 h da última chegada, anda, e a reunião monta com a lacuna", async () => {
    const id = await reuniao("uploading", 3);
    const antigo = AGORA() - fila.ESPERA_PELA_PARTE_QUE_FALTA_MS - 60_000;
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Zero." }] }, createdAt: antigo });
    await parte(id, 2, { createdAt: AGORA() });
    transcreverFatia.mockResolvedValue({ segmentos: [{ inicio: 1201, fim: 1202, falante: "F1", texto: "Dois." }], idioma: "pt-BR", modelo: "m" });
    await rodar();
    expect(transcreverFatia).not.toHaveBeenCalled();
    await (await db()).update(meetingAudioSlices).set({ createdAt: antigo + 1 }).where(and(eq(meetingAudioSlices.meetingId, id), eq(meetingAudioSlices.seq, 2)));
    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(1);
    expect(transcreverFatia.mock.calls[0][0].inicioSegundos).toBe(1200);
    await rodar();
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready" });
  });

  it("parte que ficou 'uploading' (o objeto nunca subiu) vira lacuna depois da espera", async () => {
    const id = await reuniao("uploading", 1);
    await parte(id, 0, { status: "uploading", createdAt: AGORA() - fila.ESPERA_PELA_PARTE_QUE_FALTA_MS - 60_000 });
    await rodar();
    expect((await partesDe(id))[0]).toMatchObject({ status: "failed", lastError: "NAO_RECEBIDA" });
  });

  it("parte com as tentativas esgotadas e sem reserva viva (o processo caiu três vezes) vira falha, e a reunião não fica presa", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0, { attempts: 3, lockToken: crypto.randomUUID(), lockedUntil: AGORA() - 1 });
    await rodar();
    expect((await partesDe(id))[0]).toMatchObject({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS" });
    expect(transcreverFatia).not.toHaveBeenCalled();
  });

  it("um gancho que lança não impede os seguintes nem desfaz a reunião pronta", async () => {
    const id = await reuniao("uploading", 1);
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Fala." }] } });
    const quebrado = vi.fn(async () => { throw new Error("gancho quebrou"); });
    const bom = vi.fn();
    const soltar = [fila.aoFicarPronta(quebrado), fila.aoFicarPronta(bom)];
    try {
      await rodar();
    } finally {
      soltar.forEach(s => s());
    }
    expect(bom).toHaveBeenCalledWith({ meetingId: id, ownerId: DONA });
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready" });
  });

  it("no máximo 2 chamadas de IA ao mesmo tempo", async () => {
    const ids = await Promise.all([0, 1, 2, 3].map(() => reuniao("recording", null)));
    for (const id of ids) await parte(id, 0);
    let simultaneas = 0;
    let pico = 0;
    // A primeira chamada da rodada só termina quando a segunda já entrou, sem
    // prazo fixo: com os 30 ms de antes, a primeira terminava antes de a
    // segunda começar quando outro CI rodava na mesma máquina ("expected 1 to
    // be 2", 18/11). Se a fila deixasse uma só, a primeira esperaria a segunda
    // para sempre e o teste venceria o prazo, em vez de passar.
    let abrir = () => {};
    let segundaEntrou = Promise.resolve();
    transcreverFatia.mockImplementation(async () => {
      if (simultaneas === 0) segundaEntrou = new Promise<void>(resolve => { abrir = resolve; });
      simultaneas += 1;
      pico = Math.max(pico, simultaneas);
      if (simultaneas === 2) abrir();
      await segundaEntrou;
      simultaneas -= 1;
      return { segmentos: [], idioma: "pt-BR", modelo: "m" };
    });
    // A segunda leitura do áudio de cada rodada demora, como com a máquina
    // carregada: com o prazo fixo de antes, este teste falhava sempre assim.
    let leituras = 0;
    storageGetBytes.mockImplementation(async () => {
      leituras += 1;
      if (leituras % 2 === 0) await new Promise(resolve => setTimeout(resolve, 100));
      return Buffer.from("audio");
    });
    // Duas por rodada (as vagas de IA), e nunca mais de duas ao mesmo tempo.
    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(2);
    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(4);
    expect(pico).toBe(2);
  });

  it("reprocessar a reunião em partes que falhou: volta à fila; a parte da IA é refeita, a sem áudio segue lacuna", async () => {
    const id = await reuniao("uploading", 2, { status: "failed", attempts: 3, processingError: "x" });
    await parte(id, 0, { status: "failed", lastError: "IA_INDISPONIVEL", attempts: 3 });
    await parte(id, 1, { status: "failed", lastError: "AUDIO_AUSENTE", attempts: 1 });
    await iniciarReprocessamento(DONA, id);
    expect(await reuniaoDe(id)).toMatchObject({ status: "uploading", attempts: 0, processingError: null });
    expect((await partesDe(id)).map(p => [p.status, p.attempts])).toEqual([["received", 0], ["failed", 1]]);

    const semPartes = await reuniao("recording", null, { status: "failed" });
    const recusa = await iniciarReprocessamento(DONA, semPartes).catch(e => e);
    expect(recusa).toBeInstanceOf(ReprocessamentoRecusado);
    expect(recusa.codigo).toBe("PRECONDITION_FAILED");
  });

  it("reserva viva de outra execução não é tomada", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0, { lockToken: "outra-instancia-".padEnd(36, "x"), lockedUntil: AGORA() + 60_000, attempts: 1 });
    await rodar();
    expect(transcreverFatia).not.toHaveBeenCalled();
  });

  it("gravação abandonada no meio: encerra com as partes que chegaram; sem parte nenhuma, vira falha", async () => {
    const velha = AGORA() - fila.ABANDONO_DA_GRAVACAO_MS - 60_000;
    const comPartes = await reuniao("recording", null, { updatedAt: velha });
    await parte(comPartes, 0, { createdAt: velha });
    await parte(comPartes, 1, { createdAt: velha + 1 });
    const semPartes = await reuniao("recording", null, { updatedAt: velha });
    transcreverFatia.mockResolvedValue({ segmentos: [], idioma: "pt-BR", modelo: "gemini-teste" });
    await rodar();
    expect(await reuniaoDe(comPartes)).toMatchObject({ status: "uploading", expectedSlices: 2 });
    expect(await reuniaoDe(semPartes)).toMatchObject({ status: "failed" });
  });

  it("SIGTERM: pararFila devolve as reservas desta instância (partes e montagem) sem gastar tentativa, e a fila para", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0, { lockToken: fila._paraTestes.novoToken(), lockedUntil: AGORA() + 600_000, attempts: 1 });
    const montando = await reuniao("uploading", 1, { status: "processing", lockToken: fila._paraTestes.novoToken(), lockedUntil: AGORA() + 600_000, attempts: 1 });
    // A reserva de OUTRA instância não é devolvida por esta.
    const deOutra = await reuniao("recording", null);
    await parte(deOutra, 0, { lockToken: crypto.randomUUID(), lockedUntil: AGORA() + 600_000, attempts: 1 });
    const devolvidas = await fila.pararFila();
    expect(devolvidas).toEqual({ partes: 1, reunioes: 1 });
    expect((await partesDe(id))[0]).toMatchObject({ lockToken: null, lockedUntil: null, attempts: 0, status: "received" });
    expect(await reuniaoDe(montando)).toMatchObject({ status: "uploading", lockToken: null, attempts: 0 });
    expect((await partesDe(deOutra))[0].lockToken).not.toBeNull();
    await rodar();
    expect(transcreverFatia).not.toHaveBeenCalled();
  });

  // Os três abaixo provam que as varreduras da fila travam só pela chave das
  // linhas delas. Os arquivos de integração rodam em paralelo no mesmo banco, e
  // os UPDATEs por intervalo do índice travavam partes e reuniões de outras
  // reuniões e donas (deadlock da desistência das partes no laço de 19/11).
  it("a desistência das partes esgotadas vai pela chave: não espera pela parte que outra transação acabou de criar", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0, { attempts: fila.TENTATIVAS_POR_PARTE });
    const outra = await reuniao("recording", null);
    expect(await terminaComALinhaPresa(tx => tx.insert(meetingAudioSlices).values(linhaDaParte(outra, 0)), rodar)).toBe(true);
    expect((await partesDe(id))[0]).toMatchObject({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS" });
    expect(transcreverFatia).not.toHaveBeenCalled();
  });

  it("a montagem presa volta pela chave: não espera pela reunião em montagem que outra transação acabou de criar", async () => {
    const presa = await reuniao("uploading", null, { status: "processing", lockToken: "processo-morto".padEnd(36, "x"), lockedUntil: AGORA() - 1, attempts: 1 });
    const outra = {
      id: crypto.randomUUID(), ownerId: DONA, title: "Outra em montagem", status: "processing" as const, consentGranted: true, audioPipeline: "slices" as const,
      lockedUntil: AGORA() - 1, attempts: 1, createdAt: AGORA(), updatedAt: AGORA(),
    };
    expect(await terminaComALinhaPresa(tx => tx.insert(meetings).values(outra), rodar)).toBe(true);
    expect(await reuniaoDe(presa)).toMatchObject({ status: "uploading", lockToken: null, lockedUntil: null });
    // A da outra transação foi desfeita, e nada dela ficou.
    expect(await reuniaoDe(outra.id)).toBeUndefined();
  });

  it("o desligamento devolve as reservas pela chave: não espera pela parte que outra transação acabou de criar", async () => {
    const id = await reuniao("recording", null);
    await parte(id, 0, { lockToken: fila._paraTestes.novoToken(), lockedUntil: AGORA() + 600_000, attempts: 1 });
    const outra = await reuniao("recording", null);
    const reservadaPorOutra = linhaDaParte(outra, 0, { lockToken: crypto.randomUUID(), lockedUntil: AGORA() + 600_000, attempts: 1 });
    let devolvidas: unknown;
    expect(await terminaComALinhaPresa(tx => tx.insert(meetingAudioSlices).values(reservadaPorOutra), async () => { devolvidas = await fila.pararFila(); })).toBe(true);
    expect(devolvidas).toEqual({ partes: 1, reunioes: 0 });
    expect((await partesDe(id))[0]).toMatchObject({ lockToken: null, lockedUntil: null, attempts: 0, status: "received" });
  });

  it("montagem presa (o processo caiu sem SIGTERM e a reserva venceu) volta a 'uploading' e é retomada", async () => {
    const id = await reuniao("uploading", 1, { status: "processing", lockToken: "processo-morto".padEnd(36, "x"), lockedUntil: AGORA() - 1 });
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Retomada." }] } });
    await rodar();
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready" });
  });

  it("a varredura do envio único não marca como falha a reunião em partes que a fila está montando", async () => {
    const id = await reuniao("uploading", 1, { status: "processing", updatedAt: AGORA() - 60 * 60_000, lockedUntil: AGORA() + 600_000 });
    await marcarReunioesInterrompidas();
    expect(await reuniaoDe(id)).toMatchObject({ status: "processing" });
    await (await db()).update(meetings).set({ status: "failed" }).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
  });

  it("a reunião na lixeira (H7d) fica fora da fila: a parte dela não vai à IA e a reunião não é montada; restaurada, a fila a retoma", async () => {
    const naLixeira = AGORA();
    // A parte que chegou (a retomada do aparelho manda a parte atrasada mesmo
    // com a reunião na lixeira) e a reunião já toda transcrita, à espera da montagem.
    const comParte = await reuniao("uploading", 1, { trashedAt: naLixeira });
    await parte(comParte, 0);
    const paraMontar = await reuniao("uploading", 1, { trashedAt: naLixeira });
    await parte(paraMontar, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Fechado o frete." }] } });
    transcreverFatia.mockResolvedValue({ segmentos: [{ inicio: 1, fim: 2, falante: "F1", texto: "Bom dia." }], idioma: "pt-BR", modelo: "gemini-teste" });

    await rodar();
    expect(transcreverFatia).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
    expect((await partesDe(comParte))[0]).toMatchObject({ status: "received", attempts: 0, lockToken: null });
    expect(await reuniaoDe(paraMontar)).toMatchObject({ status: "uploading", attempts: 0, lockToken: null });

    // A tomada confere a lixeira de novo: a reunião que foi para lá entre a
    // seleção e a tomada não é tomada (a seleção acima já a deixou de fora).
    await fila._paraTestes.montarUmaReuniao(await db(), { id: paraMontar, ownerId: DONA, esperadas: 1 });
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(await reuniaoDe(paraMontar)).toMatchObject({ status: "uploading", attempts: 0, lockToken: null });

    // Restauradas, a fila transcreve a parte e monta a reunião.
    await (await db()).update(meetings).set({ trashedAt: null }).where(and(eq(meetings.ownerId, DONA), inArray(meetings.id, [comParte, paraMontar])));
    await rodar();
    expect(transcreverFatia).toHaveBeenCalledTimes(1);
    expect((await partesDe(comParte))[0]).toMatchObject({ status: "transcribed" });
    expect(await reuniaoDe(paraMontar)).toMatchObject({ status: "ready" });
  });
});
