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
 * a gravação do envio único que vira parte, as reuniões que saem (com a agenda,
 * os avisos do sino e a gravação a mais), os nomes, o link desligado (e a
 * senha dele), o que a IA gerou do alvo, a auditoria na transação (com a prova
 * do aviso de gravação de cada reunião) e, depois, a montagem pela fila: a
 * retranscrição de outra reunião sem o contexto da anterior, e o idioma das
 * falas de todas as reuniões.
 */
const transcreverFatia = vi.hoisted(() => vi.fn());
vi.mock("./transcricao-de-fatia", async original => ({ ...(await original<typeof import("./transcricao-de-fatia")>()), transcreverFatia: (...a: unknown[]) => transcreverFatia(...a) }));
const storageGetBytes = vi.hoisted(() => vi.fn());
const storageApagarTodasAsVersoes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageGetBytes: (...a: unknown[]) => storageGetBytes(...a),
  storageApagarTodasAsVersoes: (...a: unknown[]) => storageApagarTodasAsVersoes(...a),
}));
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...a) }));

const { getDb } = await import("./db");
const {
  agendaReunioes, auditLogs, meetingAudioSlices, meetingRecordings, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts,
  platformNotifications, proximasAcoes, users,
} = await import("../drizzle/schema");
const fila = await import("./fila-de-transcricao");
const { appRouter } = await import("./routers");
const { tetoDaJuncao } = await import("./routers/meetings");
const { iniciarReprocessamento, limparGravacoesVencidas } = await import("./meeting-service");
const { ObjetoAusenteNoStorageError } = await import("./storage");
const { MARCA_DE_OUTRA_REUNIAO } = await import("./transcricao-de-fatia");
const { rotaDaReuniao } = await import("@shared/rotas");
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

/** Uma reunião pronta do envio único: uma gravação só, sem falas por voz (com `aMais`, outra gravação mais velha, a que o player não toca). */
async function envioUnico(ownerId: string, opcoes: { aMais?: boolean; extra?: Record<string, unknown> } = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const criadaEm = AGORA() - 30_000;
  await banco.insert(meetings).values({
    id, ownerId, title: "Envio único", status: "ready", consentGranted: true, consentAt: criadaEm, language: "pt-BR",
    audioPipeline: "single", createdAt: criadaEm, updatedAt: criadaEm, ...opcoes.extra,
  });
  const velha = opcoes.aMais ? crypto.randomUUID() : null;
  if (velha) {
    await banco.insert(meetingRecordings).values({
      id: velha, meetingId: id, ownerId, storageKey: `meetings/${ownerId}/${id}/recording-antiga.webm`, storageUrl: `/manus-storage/meetings/${ownerId}/${id}/recording-antiga.webm`,
      mimeType: "audio/webm", sizeBytes: 2048, durationSeconds: 300, expiresAt: PRAZO(), createdAt: criadaEm - 10_000,
    });
  }
  const gravacao = crypto.randomUUID();
  await banco.insert(meetingRecordings).values({
    id: gravacao, meetingId: id, ownerId, storageKey: `meetings/${ownerId}/${id}/recording.webm`, storageUrl: `/manus-storage/meetings/${ownerId}/${id}/recording.webm`,
    mimeType: "audio/webm", sizeBytes: 2048, durationSeconds: 300, expiresAt: PRAZO(), createdAt: criadaEm,
  });
  await banco.insert(meetingTranscripts).values({ id: crypto.randomUUID(), meetingId: id, ownerId, transcript: "Texto corrido do envio único.", segments: [], language: "pt-BR", createdAt: criadaEm, updatedAt: criadaEm });
  return { id, gravacao, velha };
}

async function idDaConta(openId: string) {
  const [conta] = await (await db()).select({ id: users.id }).from(users).where(eq(users.openId, openId));
  return conta.id;
}

const reuniaoDe = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];
const partesDe = async (id: string) => (await db()).select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, id)).orderBy(meetingAudioSlices.seq);

async function limpar() {
  const banco = await db();
  const donas = [DONA, OUTRA];
  for (const tabela of [meetingSummaryItems, meetingSummaries, meetingTranscripts, meetingAudioSlices, meetingRecordings, proximasAcoes, agendaReunioes] as const) {
    await apagarPelaChave(banco, tabela, inArray(tabela.ownerId, donas));
  }
  await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, donas));
  const contas = await banco.select({ id: users.id }).from(users).where(inArray(users.openId, donas));
  if (contas.length) await banco.delete(platformNotifications).where(inArray(platformNotifications.userId, contas.map(c => c.id)));
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
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
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
    expect((partes[2].result as { segmentos: unknown[] }).segmentos).toEqual([
      { ...fala(1203, "F3", "Caio começa"), idioma: "pt-BR" }, { ...fala(1250, "F4", "Duda pergunta"), idioma: "pt-BR" },
    ]);
    expect(await partesDe(b.id)).toEqual([]);
    // O que a IA gerou da segunda saiu com ela; a ação ficou, solta e com o nome.
    expect(await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, b.id))).toEqual([]);
    expect(await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, b.id))).toEqual([]);
    const [acao] = await banco.select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    expect(acao).toMatchObject({ texto: "Caio liga para o importador", responsavel: "Caio", meetingId: null, itemId: null });
    // A auditoria, só com ids e contagens.
    const [prova] = await banco.select().from(auditLogs).where(and(eq(auditLogs.action, "MEETINGS_JOINED"), eq(auditLogs.resourceId, a.id)));
    expect(prova).toMatchObject({ userId: ID_DA_DONA, resource: "meetings", status: "success" });
    const [linhaDeA] = await banco.select({ consentAt: meetings.consentAt }).from(meetings).where(eq(meetings.id, a.id));
    expect(prova.details).toEqual({
      juntadas: [b.id], partes: 3, duracaoSegundos: 1800, retranscreve: false, linkAbertoDesligado: true,
      avisosDeGravacao: [{ id: a.id, consentAt: Number(linhaDeA.consentAt), consentNoticeVersion: null }, expect.objectContaining({ id: b.id })],
    });

    // A fila monta a reunião juntada pelo caminho de sempre, sem transcrever de novo, e os nomes ficam.
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(transcreverFatia).not.toHaveBeenCalled();
    const pronta = await reuniaoDe(a.id);
    expect(pronta).toMatchObject({ status: "ready", speakerNames: { F1: "Ana", F2: "Bia", F3: "Caio" } });
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.transcript).toBe("Ana abre\nBia comenta\nAna fecha\nCaio começa\nDuda pergunta");
    expect((transcricao.segments as Array<{ falante: string; inicio: number }>).map(s => [s.falante, s.inicio])).toEqual([["F1", 5], ["F2", 300], ["F1", 700], ["F3", 1203], ["F4", 1250]]);
    // O resumo antigo saiu (já na junção), e o novo espera a fila do resumo.
    expect((await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, a.id))).map(r => r.status)).toEqual(["pending"]);
    expect(await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, a.id))).toEqual([]);
  });

  it("a reunião do envio único: a gravação vira uma parte que a fila transcreve como outra conversa, sem o contexto nem os nomes da anterior", async () => {
    const banco = await db();
    const a = await emPartes(DONA, [[fala(5, "F1", "Ana abre")]], { speakerNames: { F1: "Ana" } });
    const b = await envioUnico(DONA);

    const resposta = await juntar([a.id, b.id]);
    expect(resposta).toMatchObject({ meetingId: a.id, partes: 2, retranscreve: true, linkAbertoDesligado: false });
    expect(await banco.select().from(meetingRecordings).where(eq(meetingRecordings.meetingId, b.id))).toEqual([]);
    const partes = await partesDe(a.id);
    expect(partes.map(p => [p.seq, p.status, p.durationMs])).toEqual([[0, "transcribed", 600_000], [1, "received", 300_000]]);
    expect(partes[1]).toMatchObject({ storageKey: `meetings/${DONA}/${b.id}/recording.webm`, mimeType: "audio/webm", offsetMs: null, result: { [MARCA_DE_OUTRA_REUNIAO]: true } });
    expect((await reuniaoDe(a.id)).speakerNames).toEqual({ F1: "Ana" });

    // Sem o contexto, a IA rotula as vozes do zero: a primeira voz da outra reunião é F1 para ela.
    transcreverFatia.mockImplementation(async ({ inicioSegundos }: { inicioSegundos: number }) => ({
      segmentos: [fala(inicioSegundos + 2, "F1", "Carla no envio único")], idioma: "pt-BR", modelo: "gemini-teste",
    }));
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(transcreverFatia).toHaveBeenCalledTimes(1);
    // Nada de "este trecho continua o anterior" com as vozes e as falas da Ana.
    expect(transcreverFatia.mock.calls[0][0]).toMatchObject({ inicioSegundos: 600, mimeType: "audio/webm" });
    expect(transcreverFatia.mock.calls[0][0].anterior).toBeUndefined();
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", speakerNames: { F1: "Ana" } });
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.transcript).toBe("Ana abre\nCarla no envio único");
    // A Carla ganhou o rótulo depois dos da reunião de antes: o nome "Ana" fica só nas falas da Ana.
    expect((transcricao.segments as Array<{ falante: string }>).map(s => s.falante)).toEqual(["F1", "F2"]);
    const [transcrita] = (await partesDe(a.id)).filter(p => p.seq === 1);
    expect(transcrita.result).toMatchObject({ [MARCA_DE_OUTRA_REUNIAO]: true, contexto: { falantes: ["F1", "F2"] } });
  });

  it("o alvo de envio único: as duas gravações viram partes, a fila transcreve as duas e a reunião fica pronta (não presa em 'uploading')", async () => {
    const banco = await db();
    const a = await envioUnico(DONA);
    const b = await envioUnico(DONA);
    expect(await juntar([a.id, b.id])).toMatchObject({ meetingId: a.id, partes: 2, retranscreve: true });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "uploading", audioPipeline: "slices", expectedSlices: 2 });
    expect((await partesDe(a.id)).map(p => [p.seq, p.status, p.storageKey])).toEqual([
      [0, "received", `meetings/${DONA}/${a.id}/recording.webm`], [1, "received", `meetings/${DONA}/${b.id}/recording.webm`],
    ]);
    transcreverFatia.mockImplementation(async ({ inicioSegundos }: { inicioSegundos: number }) => ({
      segmentos: [fala(inicioSegundos + 1, "F1", `fala em ${inicioSegundos}`)], idioma: "pt-BR", modelo: "gemini-teste",
    }));
    for (let i = 0; i < 4 && (await reuniaoDe(a.id)).status !== "ready"; i++) await fila.rodarUmaVez({ ownerId: DONA });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", audioPipeline: "slices" });
    expect(transcreverFatia).toHaveBeenCalledTimes(2);
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.transcript).toBe("fala em 0\nfala em 300");
    // A segunda reunião é outra conversa: a voz dela não vira a F1 da primeira.
    expect((transcricao.segments as Array<{ falante: string }>).map(s => s.falante)).toEqual(["F1", "F2"]);
  });

  it("a primeira parte de outra reunião que falha de vez: a seguinte também começa outra conversa", async () => {
    const banco = await db();
    const a = await envioUnico(DONA);
    const c = await emPartes(DONA, [[fala(5, "F1", "Caio abre")], [fala(605, "F1", "Caio fecha")]]);
    await juntar([a.id, c.id]);
    const chaveQueFalta = `meetings/${DONA}/${c.id}/partes/0.m4a`;
    storageGetBytes.mockImplementation(async (chave: string) => {
      if (chave === chaveQueFalta) throw new ObjetoAusenteNoStorageError(chave);
      return Buffer.from("audio");
    });
    transcreverFatia.mockImplementation(async ({ inicioSegundos }: { inicioSegundos: number }) => ({
      segmentos: [fala(inicioSegundos + 1, "F1", `fala em ${inicioSegundos}`)], idioma: "pt-BR", modelo: "gemini-teste",
    }));
    for (let i = 0; i < 6 && (await reuniaoDe(a.id)).status !== "ready"; i++) await fila.rodarUmaVez({ ownerId: DONA });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready" });
    const partes = await partesDe(a.id);
    expect(partes.map(p => [p.seq, p.status])).toEqual([[0, "transcribed"], [1, "failed"], [2, "transcribed"]]);
    // A parte 2 não herdou a conversa da parte 0 (outra reunião): foi sem contexto, e com o rótulo depois do F1 dela.
    const chamadas = transcreverFatia.mock.calls.map(c => c[0] as { inicioSegundos: number; anterior?: unknown });
    expect(chamadas.map(c => [c.inicioSegundos, c.anterior])).toEqual([[0, undefined], [900, undefined]]);
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect((transcricao.segments as Array<{ falante: string; lacuna?: boolean }>).filter(s => !s.lacuna).map(s => s.falante)).toEqual(["F1", "F2"]);
  });

  it("G16: com o alvo em \"Detectar sozinho\", o idioma da reunião juntada conta também as falas da reunião com idioma escolhido", async () => {
    const banco = await db();
    // O alvo: 10 s em italiano, com o idioma que a IA marcou em cada fala.
    const a = await emPartes(DONA, [[{ ...fala(1, "F1", "Ciao a tutti"), fim: 11, idioma: "it" } as ReturnType<typeof fala>]], { language: "auto" });
    // A segunda: inglês escolhido, bem mais longa, sem idioma em cada fala (a G16 só marca no "Detectar sozinho").
    const b = await emPartes(DONA, [[{ ...fala(1, "F1", "Hello everyone"), fim: 300 }, { ...fala(300, "F2", "Thanks for joining"), fim: 590 }]], { language: "en" });
    await juntar([a.id, b.id]);
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(await reuniaoDe(a.id)).toMatchObject({ status: "ready", language: "auto" });
    const [transcricao] = await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id));
    expect(transcricao.language).toBe("en");
  });

  it("o que a IA gerou do alvo sai já na junção; as próximas ações dele se soltam com os nomes de antes", async () => {
    const banco = await db();
    const a = await emPartes(DONA, [[fala(5, "F1", "Ana abre")]], { speakerNames: { F1: "Ana" } });
    const b = await envioUnico(DONA);
    await banco.insert(proximasAcoes).values({
      id: crypto.randomUUID(), ownerId: DONA, texto: "{F1} liga para o importador", responsavel: "{F1}", meetingId: a.id, itemId: a.itemId,
      origem: "reuniao", createdAt: AGORA(), updatedAt: AGORA(),
    } as typeof proximasAcoes.$inferInsert);
    await juntar([a.id, b.id]);
    // Antes da montagem: nada do conteúdo antigo da primeira reunião.
    expect(await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, a.id))).toEqual([]);
    expect(await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, a.id))).toEqual([]);
    expect(await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, a.id))).toEqual([]);
    const [acao] = await banco.select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    expect(acao).toMatchObject({ texto: "Ana liga para o importador", responsavel: "Ana", meetingId: a.id, itemId: null });
    // O detalhe mostra o andamento das partes (a reunião em 'uploading', sem a transcrição antiga).
    const detalhe = await appRouter.createCaller(contexto(DONA)).meetings.get({ meetingId: a.id });
    expect(detalhe?.transcript).toBeNull();
    expect(detalhe?.meeting.status).toBe("uploading");
  });

  it("o alvo de envio único com nomes: a próxima ação dele se solta com o nome que a dona deu, antes de a junção zerar os nomes", async () => {
    const banco = await db();
    const a = await envioUnico(DONA, { extra: { speakerNames: { F1: "Ana" } } });
    const b = await emPartes(DONA, [[fala(1, "F1", "y")]]);
    const resumo = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await banco.insert(meetingSummaries).values({ id: resumo, meetingId: a.id, ownerId: DONA, status: "ready", createdAt: AGORA(), updatedAt: AGORA() });
    await banco.insert(meetingSummaryItems).values({
      id: itemId, summaryId: resumo, meetingId: a.id, ownerId: DONA, section: "action", position: 0, text: "{F1} manda a proposta",
      assignee: "{F1}", excerpt: "trecho", status: "confirmed", createdAt: AGORA(), updatedAt: AGORA(),
    } as typeof meetingSummaryItems.$inferInsert);
    await banco.insert(proximasAcoes).values({
      id: crypto.randomUUID(), ownerId: DONA, texto: "{F1} manda a proposta", responsavel: "{F1}", meetingId: a.id, itemId,
      origem: "reuniao", createdAt: AGORA(), updatedAt: AGORA(),
    } as typeof proximasAcoes.$inferInsert);
    await juntar([a.id, b.id]);
    // A junção que retranscreve desde o alvo zera os nomes dele; a ação já levou o nome no texto.
    expect((await reuniaoDe(a.id)).speakerNames).toBeNull();
    const [acao] = await banco.select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    expect(acao).toMatchObject({ texto: "Ana manda a proposta", responsavel: "Ana", itemId: null });
  });

  it("a reunião que sai leva junto o ponteiro da agenda e os avisos do sino; o alvo sem contato nem contexto fica com os dela", async () => {
    const banco = await db();
    const a = await emPartes(DONA, [[fala(1, "F1", "x")]]);
    const contextoDaSegunda = crypto.randomUUID();
    const b = await emPartes(DONA, [[fala(1, "F1", "y")]], { contactId: 424_242, contextId: contextoDaSegunda });
    const agendaId = crypto.randomUUID();
    await banco.insert(agendaReunioes).values({
      id: agendaId, ownerId: DONA, titulo: "Marcada", inicioEm: AGORA(), duracaoMinutos: 60, fuso: "America/Sao_Paulo", participantes: [],
      meetingId: b.id, createdAt: AGORA(), updatedAt: AGORA(),
    } as typeof agendaReunioes.$inferInsert);
    const conta = await idDaConta(DONA);
    await banco.insert(platformNotifications).values({ userId: conta, type: "reuniao_pronta", title: "Reunião", actionUrl: rotaDaReuniao(b.id) });
    await juntar([a.id, b.id]);
    expect((await banco.select().from(agendaReunioes).where(eq(agendaReunioes.id, agendaId)))[0].meetingId).toBeNull();
    expect(await banco.select().from(platformNotifications).where(and(eq(platformNotifications.userId, conta), eq(platformNotifications.actionUrl, rotaDaReuniao(b.id))))).toEqual([]);
    const alvo = await reuniaoDe(a.id);
    expect({ contactId: alvo.contactId === null ? null : Number(alvo.contactId), contextId: alvo.contextId }).toEqual({ contactId: 424_242, contextId: contextoDaSegunda });
  });

  it("a gravação a mais do envio único vence na hora, e a varredura a tira do bucket", async () => {
    const banco = await db();
    const a = await envioUnico(DONA, { aMais: true });
    const b = await emPartes(DONA, [[fala(1, "F1", "y")]]);
    const antes = AGORA();
    await juntar([a.id, b.id]);
    const [velha] = await banco.select().from(meetingRecordings).where(eq(meetingRecordings.id, a.velha!));
    expect(Number(velha.expiresAt)).toBeGreaterThanOrEqual(antes - 1);
    expect(Number(velha.expiresAt)).toBeLessThanOrEqual(AGORA());
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(storageApagarTodasAsVersoes.mock.calls.map(chamada => chamada[0])).toContain(`meetings/${DONA}/${a.id}/recording-antiga.webm`);
  });

  it("o link com senha (H23) sai desligado de vez: sem token, sem a senha e com o freio zerado", async () => {
    const a = await emPartes(DONA, [[fala(1, "F1", "x")]], {
      shareToken: crypto.randomBytes(24).toString("base64url"), sharePasswordHash: "scrypt$hash-de-teste", sharePasswordFailures: 3,
      sharePasswordFailedAt: AGORA(), sharePasswordLockedUntil: AGORA() + 60_000,
    });
    const b = await emPartes(DONA, [[fala(1, "F1", "y")]]);
    expect(await juntar([a.id, b.id])).toMatchObject({ linkAbertoDesligado: true });
    expect(await reuniaoDe(a.id)).toMatchObject({
      shareToken: null, sharePasswordHash: null, sharePasswordFailures: 0, sharePasswordFailedAt: null, sharePasswordLockedUntil: null,
    });
  });

  it("a prova do aviso de gravação de cada reunião fica na auditoria da junção, também a da reunião que sai", async () => {
    const banco = await db();
    const horaDaAntiga = AGORA() - 11 * 24 * 60 * 60_000;
    const horaDaNova = AGORA() - 60_000;
    const antiga = await envioUnico(DONA, { extra: { consentAt: horaDaAntiga, consentNoticeVersion: null } });
    const nova = await emPartes(DONA, [[fala(1, "F1", "y")]], { consentAt: horaDaNova, consentNoticeVersion: "2026-11-14" });
    await juntar([nova.id, antiga.id]);
    // A reunião que fica não muda a hora nem a versão dela, e a da que saiu não se perde.
    expect(await reuniaoDe(nova.id)).toMatchObject({ consentAt: horaDaNova, consentNoticeVersion: "2026-11-14" });
    expect(await reuniaoDe(antiga.id)).toBeUndefined();
    const [prova] = await banco.select().from(auditLogs).where(and(eq(auditLogs.action, "MEETINGS_JOINED"), eq(auditLogs.resourceId, nova.id)));
    expect((prova.details as { avisosDeGravacao: unknown }).avisosDeGravacao).toEqual([
      { id: nova.id, consentAt: horaDaNova, consentNoticeVersion: "2026-11-14" },
      { id: antiga.id, consentAt: horaDaAntiga, consentNoticeVersion: null },
    ]);
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
