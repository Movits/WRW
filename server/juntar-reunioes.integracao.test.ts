import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Juntar reuniões (H17) contra um banco real DE TESTE (sem DATABASE_URL_TESTES,
 * se pula). A IA e o bucket são dublês, como no teste da fila: o que se prova é
 * o banco — as partes que mudam de reunião (posição, início, falas e rótulos),
 * a gravação do envio único que vira parte, as reuniões que saem, os nomes, o
 * link desligado, a auditoria na transação e, depois, a montagem pela fila.
 */
const transcreverFatia = vi.hoisted(() => vi.fn());
vi.mock("./transcricao-de-fatia", async original => ({ ...(await original<typeof import("./transcricao-de-fatia")>()), transcreverFatia: (...a: unknown[]) => transcreverFatia(...a) }));
const storageGetBytes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({ ...(await original<typeof import("./storage")>()), storageGetBytes: (...a: unknown[]) => storageGetBytes(...a) }));
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...a) }));

const { getDb } = await import("./db");
const {
  auditLogs, meetingAudioSlices, meetingRecordings, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, proximasAcoes, users,
} = await import("../drizzle/schema");
const fila = await import("./fila-de-transcricao");
const { appRouter } = await import("./routers");
const { tetoDaJuncao } = await import("./routers/meetings");
const { iniciarReprocessamento } = await import("./meeting-service");
const { RECUSAS_DA_JUNCAO, JUNCOES_POR_JANELA } = await import("@shared/juntar-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-juncao-${crypto.randomUUID()}`;
const OUTRA = `teste-juncao-outra-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_050_000_000 + Math.floor(Math.random() * 10_000_000);
const AGORA = () => Date.now();
const PRAZO = () => AGORA() + 20 * 24 * 60 * 60_000;

function contexto(openId: string, id = ID_DA_DONA): TrpcContext {
  return {
    user: { id, openId, role: "user", name: "Dona Teste" },
    req: { headers: { "user-agent": "teste" }, ip: "203.0.113.30", socket: { remoteAddress: "203.0.113.30" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const juntar = (ids: string[], openId = DONA, id = ID_DA_DONA) => appRouter.createCaller(contexto(openId, id)).meetings.juntar({ meetingIds: ids });

async function db() { return (await getDb())!; }
const fala = (inicio: number, falante: string, texto: string) => ({ inicio, fim: inicio + 4, falante, texto });

/** Uma reunião pronta em partes, cada parte já transcrita com as falas dadas. */
async function emPartes(ownerId: string, falasPorParte: Array<ReturnType<typeof fala>[]>, extra: Record<string, unknown> = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const criadaEm = AGORA() - 60_000;
  await banco.insert(meetings).values({
    id, ownerId, title: `Reunião ${id.slice(0, 4)}`, status: "ready", consentGranted: true, consentAt: criadaEm, language: "pt-BR",
    audioPipeline: "slices", origem: "gravacao", expectedSlices: falasPorParte.length, createdAt: criadaEm, updatedAt: criadaEm, ...extra,
  });
  for (const [seq, falas] of falasPorParte.entries()) {
    await banco.insert(meetingAudioSlices).values({
      id: crypto.randomUUID(), meetingId: id, ownerId, seq, status: "transcribed",
      storageKey: `meetings/${ownerId}/${id}/partes/${seq}.m4a`, storageUrl: `/manus-storage/meetings/${ownerId}/${id}/partes/${seq}.m4a`,
      mimeType: "audio/mp4", sizeBytes: 10, sha256: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), durationMs: 600_000, offsetMs: seq * 600_000,
      result: { segmentos: falas, contexto: { falantes: Array.from(new Set(falas.map(f => f.falante))), ultimasFalas: falas.slice(-1) } },
      model: "gemini-teste", expiresAt: PRAZO(), createdAt: criadaEm, updatedAt: criadaEm,
    });
  }
  // A transcrição montada e um resumo com item, que a junção refaz.
  await banco.insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId, transcript: falasPorParte.flat().map(f => f.texto).join("\n"),
    segments: falasPorParte.flat(), language: "pt-BR", createdAt: criadaEm, updatedAt: criadaEm,
  });
  const resumo = crypto.randomUUID();
  await banco.insert(meetingSummaries).values({ id: resumo, meetingId: id, ownerId, status: "ready", createdAt: criadaEm, updatedAt: criadaEm });
  const itemId = crypto.randomUUID();
  await banco.insert(meetingSummaryItems).values({
    id: itemId, summaryId: resumo, meetingId: id, ownerId, section: "action", position: 0, text: "{F1} liga para o importador",
    assignee: "{F1}", excerpt: "trecho", status: "confirmed", createdAt: criadaEm, updatedAt: criadaEm,
  } as typeof meetingSummaryItems.$inferInsert);
  return { id, itemId };
}

/** Uma reunião pronta do envio único: uma gravação só, sem falas por voz. */
async function envioUnico(ownerId: string) {
  const banco = await db();
  const id = crypto.randomUUID();
  const criadaEm = AGORA() - 30_000;
  await banco.insert(meetings).values({
    id, ownerId, title: "Envio único", status: "ready", consentGranted: true, consentAt: criadaEm, language: "pt-BR",
    audioPipeline: "single", createdAt: criadaEm, updatedAt: criadaEm,
  });
  const gravacao = crypto.randomUUID();
  await banco.insert(meetingRecordings).values({
    id: gravacao, meetingId: id, ownerId, storageKey: `meetings/${ownerId}/${id}/recording.webm`, storageUrl: `/manus-storage/meetings/${ownerId}/${id}/recording.webm`,
    mimeType: "audio/webm", sizeBytes: 2048, durationSeconds: 300, expiresAt: PRAZO(), createdAt: criadaEm,
  });
  await banco.insert(meetingTranscripts).values({ id: crypto.randomUUID(), meetingId: id, ownerId, transcript: "Texto corrido do envio único.", segments: [], language: "pt-BR", createdAt: criadaEm, updatedAt: criadaEm });
  return { id, gravacao };
}

const reuniaoDe = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];
const partesDe = async (id: string) => (await db()).select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, id)).orderBy(meetingAudioSlices.seq);

async function limpar() {
  const banco = await db();
  const donas = [DONA, OUTRA];
  for (const tabela of [meetingSummaryItems, meetingSummaries, meetingTranscripts, meetingAudioSlices, meetingRecordings, proximasAcoes] as const) {
    await apagarPelaChave(banco, tabela, inArray(tabela.ownerId, donas));
  }
  await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, donas));
  await banco.delete(auditLogs).where(and(eq(auditLogs.action, "MEETINGS_JOINED"), inArray(auditLogs.userId, [ID_DA_DONA, ID_DA_DONA + 1])));
}

describe.skipIf(!temBanco)("Juntar reuniões (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  beforeEach(async () => {
    await limpar();
    fila.religarParaTestes();
    transcreverFatia.mockReset();
    storageGetBytes.mockReset();
    storageGetBytes.mockResolvedValue(Buffer.from("audio"));
    invokeLLM.mockReset();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tetoDaJuncao.esquecer();
  });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await limpar();
    await banco.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("junta duas reuniões em partes: as partes da segunda entram depois, com as falas e os rótulos deslocados, e a segunda sai", async () => {
    const banco = await db();
    const a = await emPartes(DONA, [[fala(5, "F1", "Ana abre"), fala(300, "F2", "Bia comenta")], [fala(700, "F1", "Ana fecha")]], {
      speakerNames: { F1: "Ana", F2: "Bia" }, shareToken: crypto.randomBytes(24).toString("base64url"), etiquetas: ["Clientes"],
    });
    const b = await emPartes(DONA, [[fala(3, "F1", "Caio começa"), fala(50, "F2", "Duda pergunta")]], { speakerNames: { F1: "Caio" }, ondeFoi: "Zoom", etiquetas: ["clientes", "Vendas"] });
    // Uma próxima ação presa a um item da segunda: solta, com o nome resolvido.
    await banco.insert(proximasAcoes).values({
      id: crypto.randomUUID(), ownerId: DONA, texto: "{F1} liga para o importador", responsavel: "{F1}", meetingId: b.id, itemId: b.itemId,
      origem: "reuniao", createdAt: AGORA(), updatedAt: AGORA(),
    } as typeof proximasAcoes.$inferInsert);

    const resposta = await juntar([a.id, b.id]);
    expect(resposta).toEqual({ meetingId: a.id, partes: 3, duracaoSegundos: 1800, retranscreve: false, linkAbertoDesligado: true });

    expect(await reuniaoDe(a.id)).toMatchObject({
      status: "uploading", audioPipeline: "slices", expectedSlices: 3, attempts: 0, shareToken: null,
      speakerNames: { F1: "Ana", F2: "Bia", F3: "Caio" }, etiquetas: ["Clientes", "Vendas"], ondeFoi: "Zoom",
    });
    expect(await reuniaoDe(b.id)).toBeUndefined();
    const partes = await partesDe(a.id);
    expect(partes.map(p => [p.seq, p.status, Number(p.offsetMs)])).toEqual([[0, "transcribed", 0], [1, "transcribed", 600_000], [2, "transcribed", 1_200_000]]);
    expect((partes[2].result as { segmentos: unknown[] }).segmentos).toEqual([fala(1203, "F3", "Caio começa"), fala(1250, "F4", "Duda pergunta")]);
    expect(await partesDe(b.id)).toEqual([]);
    // O que a IA gerou da segunda saiu com ela; a ação ficou, solta e com o nome.
    expect(await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, b.id))).toEqual([]);
    expect(await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, b.id))).toEqual([]);
    const [acao] = await banco.select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    expect(acao).toMatchObject({ texto: "Caio liga para o importador", responsavel: "Caio", meetingId: null, itemId: null });
    // A auditoria, só com ids e contagens.
    const [prova] = await banco.select().from(auditLogs).where(and(eq(auditLogs.action, "MEETINGS_JOINED"), eq(auditLogs.resourceId, a.id)));
    expect(prova).toMatchObject({ userId: ID_DA_DONA, resource: "meetings", status: "success" });
    expect(prova.details).toEqual({ juntadas: [b.id], partes: 3, duracaoSegundos: 1800, retranscreve: false, linkAbertoDesligado: true });

    // A fila monta a reunião juntada pelo caminho de sempre, sem transcrever de novo, e os nomes ficam.
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(transcreverFatia).not.toHaveBeenCalled();
    const pronta = await reuniaoDe(a.id);
    expect(pronta).toMatchObject({ status: "ready", speakerNames: { F1: "Ana", F2: "Bia", F3: "Caio" } });
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.transcript).toBe("Ana abre\nBia comenta\nAna fecha\nCaio começa\nDuda pergunta");
    expect((transcricao.segments as Array<{ falante: string; inicio: number }>).map(s => [s.falante, s.inicio])).toEqual([["F1", 5], ["F2", 300], ["F1", 700], ["F3", 1203], ["F4", 1250]]);
    // O resumo antigo saiu, e o novo espera a fila do resumo.
    expect((await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, a.id))).map(r => r.status)).toEqual(["pending"]);
    expect(await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, a.id))).toEqual([]);
  });

  it("a reunião do envio único: a gravação vira uma parte que a fila transcreve, com o contexto da anterior", async () => {
    const banco = await db();
    const a = await emPartes(DONA, [[fala(5, "F1", "Ana abre")]], { speakerNames: { F1: "Ana" } });
    const b = await envioUnico(DONA);

    const resposta = await juntar([a.id, b.id]);
    expect(resposta).toMatchObject({ meetingId: a.id, partes: 2, retranscreve: true, linkAbertoDesligado: false });
    expect(await banco.select().from(meetingRecordings).where(eq(meetingRecordings.meetingId, b.id))).toEqual([]);
    const partes = await partesDe(a.id);
    expect(partes.map(p => [p.seq, p.status, p.durationMs])).toEqual([[0, "transcribed", 600_000], [1, "received", 300_000]]);
    expect(partes[1]).toMatchObject({ storageKey: `meetings/${DONA}/${b.id}/recording.webm`, mimeType: "audio/webm", offsetMs: null, result: null });
    expect((await reuniaoDe(a.id)).speakerNames).toEqual({ F1: "Ana" });

    transcreverFatia.mockImplementation(async ({ inicioSegundos }: { inicioSegundos: number }) => ({
      segmentos: [fala(inicioSegundos + 2, "F2", "Bia no envio único")], idioma: "pt-BR", modelo: "gemini-teste",
    }));
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(transcreverFatia).toHaveBeenCalledTimes(1);
    expect(transcreverFatia.mock.calls[0][0]).toMatchObject({ inicioSegundos: 600, mimeType: "audio/webm", anterior: { falantes: ["F1"] } });
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", speakerNames: { F1: "Ana" } });
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.transcript).toBe("Ana abre\nBia no envio único");
  });

  it("a lacuna de uma reunião de origem segue lacuna, e a fila monta na hora, sem esperar por ela de novo", async () => {
    const banco = await db();
    // A primeira teve 2 partes, e a segunda nunca chegou (a montagem dela já esperou as 24 h).
    const a = await emPartes(DONA, [[fala(5, "F1", "Ana abre")]], { expectedSlices: 2 });
    const b = await emPartes(DONA, [[fala(3, "F1", "Caio começa")]]);
    expect(await juntar([a.id, b.id])).toMatchObject({ partes: 3, duracaoSegundos: 1800 });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "uploading", expectedSlices: 2 });
    await fila.rodarUmaVez({ ownerId: DONA });
    expect((await reuniaoDe(a.id)).status).toBe("ready");
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect((transcricao.segments as Array<{ inicio: number; fim: number; falante: string; lacuna?: boolean }>).map(s => [s.falante, s.inicio, s.lacuna ?? false]))
      .toEqual([["F1", 5, false], ["", 600, true], ["F2", 1203, false]]);
  });

  it("a reunião de outra conta é NOT_FOUND, e nada muda", async () => {
    const a = await emPartes(DONA, [[fala(1, "F1", "x")]]);
    const daOutra = await emPartes(OUTRA, [[fala(1, "F1", "y")]]);
    const erro = await juntar([a.id, daOutra.id]).then(() => null, e => e);
    expect((erro as TRPCError).code).toBe("NOT_FOUND");
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", expectedSlices: 1 });
    expect(await reuniaoDe(daOutra.id)).toMatchObject({ status: "ready", ownerId: OUTRA });
    expect((await partesDe(daOutra.id)).length).toBe(1);
  });

  it("recusas com o código que a tela traduz: fora do estado, documento, repetida, e o teto", async () => {
    const pronta = await emPartes(DONA, [[fala(1, "F1", "x")]]);
    const processando = await emPartes(DONA, [[fala(1, "F1", "y")]], { status: "processing" });
    const documento = await emPartes(DONA, [[fala(1, "F1", "z")]], { origem: "pdf" });
    const motivo = async (ids: string[]) => { const e = await juntar(ids).then(() => null, x => x) as TRPCError; return [e.code, e.message]; };
    expect(await motivo([pronta.id, processando.id])).toEqual(["CONFLICT", RECUSAS_DA_JUNCAO.foraDoEstado]);
    expect(await motivo([pronta.id, documento.id])).toEqual(["PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.soAudio]);
    expect((await motivo([pronta.id, pronta.id]))[0]).toBe("BAD_REQUEST");
    expect(await reuniaoDe(pronta.id)).toMatchObject({ status: "ready" });
    // As recusas devolveram a vaga: o teto conta só as junções que entraram.
    for (let i = 0; i < JUNCOES_POR_JANELA; i++) tetoDaJuncao.reservar(DONA);
    const outra = await emPartes(DONA, [[fala(1, "F1", "w")]]);
    expect(await motivo([pronta.id, outra.id])).toEqual(["TOO_MANY_REQUESTS", RECUSAS_DA_JUNCAO.demais]);
  });

  it("a montagem mantém os nomes, mas o reprocesso das partes ainda os zera, agora na tomada", async () => {
    const a = await emPartes(DONA, [[fala(1, "F1", "x")]], { speakerNames: { F1: "Ana" }, status: "failed" });
    await (await db()).update(meetingAudioSlices).set({ status: "failed", lastError: "IA_INDISPONIVEL" }).where(eq(meetingAudioSlices.meetingId, a.id));
    await iniciarReprocessamento(DONA, a.id);
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "uploading", speakerNames: null });
  });

  it("a auditoria vai na transação: se ela falha, nada da junção fica", async () => {
    const a = await emPartes(DONA, [[fala(1, "F1", "x")]], { speakerNames: { F1: "Ana" } });
    const b = await emPartes(DONA, [[fala(1, "F1", "y")]]);
    // userId acima do INT da coluna: a linha da auditoria é recusada pelo banco.
    const erro = await juntar([a.id, b.id], DONA, 3_000_000_000).then(() => null, e => e);
    expect(erro).toBeTruthy();
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", expectedSlices: 1, speakerNames: { F1: "Ana" } });
    expect(await reuniaoDe(b.id)).toMatchObject({ status: "ready" });
    expect((await partesDe(b.id)).length).toBe(1);
    expect((await partesDe(a.id)).length).toBe(1);
  });
});
