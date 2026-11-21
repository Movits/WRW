import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { meetingAudioSlices, meetingTranscripts, meetings, users } from "../drizzle/schema";
import { appRouter } from "./routers";
import { iniciarReuniaoEmPartes } from "./fatias-de-reuniao";
import { PARTES_COM_TEXTO_POR_CONSULTA, transcricaoDuranteAGravacao } from "./transcricao-durante-a-gravacao";
import { tetoDaIADaReuniao } from "./routers/meetings";

/**
 * A transcrição durante a gravação (G15a) contra um banco real DE TESTE: o
 * andamento e o texto das partes que a fila já transcreveu, só para a dona, e
 * a pergunta à IA sobre o que já foi dito (a IA dublada). Sem
 * DATABASE_URL_TESTES o teste se pula (server/test/setup-banco.ts). Donas com
 * id aleatório: a limpeza só alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-durante-${crypto.randomUUID()}`;
const OUTRA = `teste-durante-${crypto.randomUUID()}`;

const duble = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => duble.invokeLLM(...args) }));

const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = DONA) => appRouter.createCaller(contexto(openId));
const respostaDaIA = (dados: unknown) => ({ choices: [{ message: { content: JSON.stringify(dados) } }] });

const iniciar = (dona = DONA) => iniciarReuniaoEmPartes(dona, { title: "Reunião gravando", language: "pt-BR", consentNoticeVersion: "2026-11-14", origem: "gravacao" });

/** Uma parte gravada direto no banco, no estado que a fila deixaria. */
async function parte(meetingId: string, seq: number, campos: Partial<typeof meetingAudioSlices.$inferInsert> & { status: "uploading" | "received" | "transcribed" | "failed" }, dona = DONA) {
  const agora = Date.now();
  const id = crypto.randomUUID();
  await (await getDb())!.insert(meetingAudioSlices).values({
    id, meetingId, ownerId: dona, seq, storageKey: `meetings/${dona}/${meetingId}/partes/${seq}-${id.slice(0, 8)}.m4a`,
    storageUrl: `/manus-storage/meetings/${dona}/${meetingId}/partes/${seq}.m4a`, mimeType: "audio/mp4", sizeBytes: 1000,
    sha256: crypto.createHash("sha256").update(id).digest("hex"), durationMs: 600_000, expiresAt: agora + 86_400_000,
    createdAt: agora, updatedAt: agora, ...campos,
  });
}

const FALAS_0 = [
  { inicio: 3, fim: 9, falante: "F1", texto: "Bom dia, vamos começar pela proposta da feira." },
  { inicio: 12, fim: 20, falante: "F2", texto: "O estande fica pronto em março." },
];
const FALAS_1 = [
  { inicio: 605, fim: 612, falante: "F1", texto: "Combinado: o contrato sai até sexta-feira." },
];

describe.skipIf(!temBanco)("A transcrição durante a gravação, no banco (integração)", () => {
  beforeAll(async () => {
    await (await getDb())!.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    for (const dona of [DONA, OUTRA]) {
      await apagarPelaChave(db, meetingAudioSlices, eq(meetingAudioSlices.ownerId, dona));
      await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, dona));
      await apagarPelaChave(db, meetings, eq(meetings.ownerId, dona));
      await db.delete(users).where(eq(users.openId, dona));
    }
  });
  beforeEach(() => {
    duble.invokeLLM.mockReset();
    tetoDaIADaReuniao.esquecer();
  });

  it("o andamento de cada parte (transcrita, na fila, sendo transcrita, subindo, sem texto) e o atraso da transcrita, com o texto só das prontas", async () => {
    const { id } = await iniciar();
    const chegou = Date.now() - 200_000;
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0, contexto: { falantes: ["F1", "F2"], ultimasFalas: [] } }, createdAt: chegou, updatedAt: chegou + 75_000 });
    await parte(id, 1, { status: "transcribed", offsetMs: 600_000, result: { segmentos: FALAS_1 }, createdAt: chegou + 1000, updatedAt: chegou + 61_000 });
    await parte(id, 2, { status: "failed", lastError: "IA_RECUSOU" });
    await parte(id, 3, { status: "received", lockedUntil: Date.now() + 600_000, lockToken: crypto.randomUUID() });
    await parte(id, 4, { status: "received" });
    await parte(id, 5, { status: "uploading", durationMs: 300_000 });
    const dados = (await transcricaoDuranteAGravacao(DONA, id, 0))!;
    expect(dados).toMatchObject({ status: "recording", emPartes: true });
    expect(dados.partes.map(p => [p.seq, p.estado, p.inicioSegundos, p.duracaoSegundos, p.atrasoSegundos])).toEqual([
      [0, "transcrita", 0, 600, 75],
      [1, "transcrita", 600, 600, 60],
      [2, "falhou", 1200, 600, null],
      [3, "transcrevendo", 1800, 600, null],
      [4, "na_fila", 2400, 600, null],
      [5, "enviando", 3000, 300, null],
    ]);
    expect(dados.falas).toEqual([{ seq: 0, segmentos: FALAS_0 }, { seq: 1, segmentos: FALAS_1 }]);
    // `desde`: a tela que já tem as duas primeiras recebe só o andamento.
    const depois = (await transcricaoDuranteAGravacao(DONA, id, 2))!;
    expect(depois.falas).toEqual([]);
    expect(depois.partes).toHaveLength(6);
  });

  it("a parte do meio que não chegou não desloca as seguintes: conta a duração padrão no lugar dela", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0 } });
    await parte(id, 2, { status: "received" });
    const dados = (await transcricaoDuranteAGravacao(DONA, id, 0))!;
    expect(dados.partes.map(p => [p.seq, p.inicioSegundos])).toEqual([[0, 0], [2, 1200]]);
  });

  it(`no máximo ${PARTES_COM_TEXTO_POR_CONSULTA} partes com texto por pedido: o resto vem no pedido seguinte`, async () => {
    const { id } = await iniciar();
    for (let seq = 0; seq < PARTES_COM_TEXTO_POR_CONSULTA + 2; seq++) {
      await parte(id, seq, { status: "transcribed", offsetMs: seq * 600_000, result: { segmentos: [{ inicio: seq * 600 + 1, fim: seq * 600 + 5, falante: "F1", texto: `fala ${seq}` }] } });
    }
    const primeira = (await transcricaoDuranteAGravacao(DONA, id, 0))!;
    expect(primeira.falas.map(f => f.seq)).toEqual(Array.from({ length: PARTES_COM_TEXTO_POR_CONSULTA }, (_, i) => i));
    const segunda = (await transcricaoDuranteAGravacao(DONA, id, PARTES_COM_TEXTO_POR_CONSULTA))!;
    expect(segunda.falas.map(f => f.seq)).toEqual([PARTES_COM_TEXTO_POR_CONSULTA, PARTES_COM_TEXTO_POR_CONSULTA + 1]);
  });

  it("só a dona: a reunião de outra dona é nula aqui e NOT_FOUND pela rota, sem nada dela", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0 } });
    expect(await transcricaoDuranteAGravacao(OUTRA, id, 0)).toBeNull();
    await expect(rota(OUTRA).meetings.transcricaoDaGravacao({ meetingId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const daDona = await rota(DONA).meetings.transcricaoDaGravacao({ meetingId: id });
    expect(daDona.falas).toHaveLength(1);
  });

  it("fora do andamento (a reunião pronta) e no envio único, vem sem partes: vale a transcrição de sempre", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0 } });
    await (await getDb())!.update(meetings).set({ status: "ready" }).where(eq(meetings.id, id));
    expect(await transcricaoDuranteAGravacao(DONA, id, 0)).toMatchObject({ status: "ready", partes: [], falas: [] });
    const unico = crypto.randomUUID();
    const agora = Date.now();
    await (await getDb())!.insert(meetings).values({ id: unico, ownerId: DONA, title: "Envio único", status: "recording", consentGranted: true, consentAt: agora, createdAt: agora, updatedAt: agora });
    expect(await transcricaoDuranteAGravacao(DONA, unico, 0)).toMatchObject({ emPartes: false, partes: [], falas: [] });
  });

  it("a pergunta durante a gravação: a IA lê só o texto das partes transcritas, sabendo que a reunião segue, e a resposta vem conferida", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0 } });
    await parte(id, 1, { status: "received" });
    duble.invokeLLM.mockResolvedValue(respostaDaIA({
      respondida: true, resposta: "{F2} disse que o estande fica pronto em março.", citacoes: [{ trecho: "O estande fica pronto em março." }],
    }));
    const resposta = await rota().meetings.perguntarDuranteAGravacao({ meetingId: id, idioma: "pt-BR", pergunta: "Quando fica pronto o estande?" });
    expect(resposta).toMatchObject({ respondida: true, citacoes: [{ trecho: "O estande fica pronto em março.", inicioSegundos: 12 }] });
    const [{ messages }] = duble.invokeLLM.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const sistema = messages.find(m => m.role === "system")!.content;
    const usuario = messages.find(m => m.role === "user")!.content;
    expect(sistema).toContain("A reunião ainda está em andamento");
    expect(usuario).toContain("{F1}: Bom dia, vamos começar pela proposta da feira.");
    expect(usuario).toContain("{F2}: O estande fica pronto em março.");
  });

  it("a pergunta durante a gravação sem nenhuma parte transcrita é recusada antes da IA (PRECONDITION_FAILED)", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "received" });
    await expect(rota().meetings.perguntarDuranteAGravacao({ meetingId: id, idioma: "pt-BR", pergunta: "O que foi dito?" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
  });

  it("a pergunta durante a gravação na reunião de outra dona é NOT_FOUND, sem chamar a IA", async () => {
    const { id } = await iniciar();
    await parte(id, 0, { status: "transcribed", offsetMs: 0, result: { segmentos: FALAS_0 } });
    await expect(rota(OUTRA).meetings.perguntarDuranteAGravacao({ meetingId: id, idioma: "pt-BR", pergunta: "O que foi dito?" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
  });

  it("a reunião que ficou pronta no meio responde pela transcrição final", async () => {
    const { id } = await iniciar();
    const agora = Date.now();
    await (await getDb())!.update(meetings).set({ status: "ready" }).where(eq(meetings.id, id));
    await (await getDb())!.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: "Fechamos o patrocínio da feira.",
      segments: [{ inicio: 1, fim: 4, falante: "F1", texto: "Fechamos o patrocínio da feira." }], language: "pt-BR", createdAt: agora, updatedAt: agora,
    });
    duble.invokeLLM.mockResolvedValue(respostaDaIA({ respondida: true, resposta: "O patrocínio foi fechado.", citacoes: [{ trecho: "Fechamos o patrocínio da feira." }] }));
    const resposta = await rota().meetings.perguntarDuranteAGravacao({ meetingId: id, idioma: "pt-BR", pergunta: "E o patrocínio?" });
    expect(resposta).toMatchObject({ respondida: true });
    const [{ messages }] = duble.invokeLLM.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    expect(messages.find(m => m.role === "system")!.content).not.toContain("em andamento");
  });
});
