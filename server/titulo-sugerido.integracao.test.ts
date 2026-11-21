import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O título que a IA sugere com o resumo, e o idioma do resumo com "Detectar
 * sozinho" (G16), contra um banco real DE TESTE (sem DATABASE_URL_TESTES, se
 * pula). A IA é dublê: o que se prova é o banco — a fila grava a sugestão à
 * espera da dona; só a dona a vê (o link não); "Usar este título" troca o
 * título sem mexer na ficha da reunião; "Manter o atual" só registra; a
 * decisão dupla e a de outra dona não passam; o resumo refeito com o mesmo
 * título não pede de novo; e o resumo sai no idioma da transcrição, também
 * fora dos 10 da tela.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const servico = await import("./resumo-guardado");
const { decidirTituloSugerido } = await import("./decidir-titulo-sugerido");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-titulo-${crypto.randomUUID()}`;
const OUTRA = `teste-titulo-outra-${crypto.randomUUID()}`;
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();
const vaga = vi.fn();

async function db() { return (await getDb())!; }

const SEGMENTOS = [
  { inicio: 0, fim: 5, falante: "F1", texto: "Bom dia. Vamos falar do aplicativo nas lojas." },
  { inicio: 5, fim: 12, falante: "F2", texto: "Decidimos mandar a versão para a análise da loja esta semana." },
];
const resumoCom = (titulo: string | null) => ({
  emoji: "📱", titulo, modelo: "gemini-teste-1", recebidos: 1,
  itens: [{ section: "decision", subject: null, text: "Mandar a versão para a análise", assignee: null, due: null, excerpt: "Decidimos mandar a versão para a análise da loja esta semana", startSeconds: 5, confidence: 0.9 }],
});

async function reuniaoPronta(extra: { title?: string; idioma?: string } = {}) {
  const id = crypto.randomUUID();
  const criadaEm = AGORA() - 60_000;
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: extra.title ?? "Reunião de terça", status: "ready", consentGranted: true, consentAt: criadaEm, language: "auto",
    shareToken: crypto.randomBytes(24).toString("base64url"), createdAt: criadaEm, updatedAt: criadaEm,
  });
  await (await db()).insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: SEGMENTOS.map(s => s.texto).join("\n"), segments: SEGMENTOS,
    language: extra.idioma ?? "pt-BR", durationSeconds: 12, createdAt: criadaEm, updatedAt: criadaEm,
  });
  return id;
}

async function comResumoPronto(titulo: string | null, extra: { title?: string; idioma?: string } = {}) {
  gerarResumoDaReuniao.mockResolvedValue(resumoCom(titulo));
  const id = await reuniaoPronta(extra);
  await servico.pedirResumoDaDona(DONA, id, vaga);
  await rodar();
  return id;
}

const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const reuniao = async (meetingId: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, meetingId)))[0];

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("O título sugerido pela IA e o idioma do resumo (integração)", () => {
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
    gerarMapaMental.mockReset();
    gerarMapaMental.mockResolvedValue({ ramos: [{ rotulo: "App", folhas: [] }, { rotulo: "Lojas", folhas: [] }] });
    vaga.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("a fila grava a sugestão à espera da dona, e só a dona a vê: o link não recebe", async () => {
    const id = await comResumoPronto("Preparação do aplicativo para as lojas");
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", suggestedTitle: "Preparação do aplicativo para as lojas", suggestedTitleStatus: "pending", emoji: "📱" });
    expect(await servico.resumoGuardadoDaDona(DONA, id)).toMatchObject({ estado: "pronto", tituloSugerido: "Preparação do aplicativo para as lojas" });
    const peloLink = await servico.resumoGuardadoPeloLink((await reuniao(id)).shareToken!);
    expect(peloLink).not.toHaveProperty("tituloSugerido");
    expect(JSON.stringify(peloLink)).not.toContain("Preparação do aplicativo");
    // O título da reunião não muda sozinho.
    expect((await reuniao(id)).title).toBe("Reunião de terça");
  });

  it("\"Usar este título\" troca o título pela sugestão, sem mexer na ficha da reunião, e a sugestão some", async () => {
    const id = await comResumoPronto("Preparação do aplicativo para as lojas");
    const antes = await reuniao(id);
    expect(await decidirTituloSugerido(DONA, id, true)).toEqual({ titulo: "Preparação do aplicativo para as lojas" });
    const depois = await reuniao(id);
    expect(depois.title).toBe("Preparação do aplicativo para as lojas");
    expect(depois.updatedAt).toBe(antes.updatedAt);
    expect(await linhaDoResumo(id)).toMatchObject({ suggestedTitleStatus: "confirmed" });
    expect((await servico.resumoGuardadoDaDona(DONA, id)).tituloSugerido).toBeNull();
  });

  it("\"Manter o atual\" só registra a decisão: o título fica, e a sugestão some", async () => {
    const id = await comResumoPronto("Preparação do aplicativo para as lojas");
    expect(await decidirTituloSugerido(DONA, id, false)).toEqual({ titulo: "Reunião de terça" });
    expect((await reuniao(id)).title).toBe("Reunião de terça");
    expect(await linhaDoResumo(id)).toMatchObject({ suggestedTitleStatus: "ignored" });
    expect((await servico.resumoGuardadoDaDona(DONA, id)).tituloSugerido).toBeNull();
  });

  it("a decisão dupla é CONFLICT, sem efeito; a de outra dona é NOT_FOUND, e nada muda", async () => {
    const id = await comResumoPronto("Preparação do aplicativo para as lojas");
    await expect(decidirTituloSugerido(OUTRA, id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await reuniao(id)).title).toBe("Reunião de terça");
    expect(await linhaDoResumo(id)).toMatchObject({ suggestedTitleStatus: "pending" });
    await decidirTituloSugerido(DONA, id, false);
    await expect(decidirTituloSugerido(DONA, id, true)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await reuniao(id)).title).toBe("Reunião de terça");
  });

  it("sem sugestão (a IA não viu assunto) não há o que decidir; a sugestão igual ao título de agora não aparece", async () => {
    const semSugestao = await comResumoPronto(null);
    expect(await linhaDoResumo(semSugestao)).toMatchObject({ suggestedTitle: null, suggestedTitleStatus: null });
    await expect(decidirTituloSugerido(DONA, semSugestao, true)).rejects.toMatchObject({ code: "CONFLICT" });
    const igual = await comResumoPronto("reunião de TERÇA");
    expect((await servico.resumoGuardadoDaDona(DONA, igual)).tituloSugerido).toBeNull();
  });

  it("o resumo refeito com o mesmo título não pede de novo o que a dona decidiu; com outro título, volta a esperar", async () => {
    const id = await comResumoPronto("Preparação do aplicativo para as lojas");
    await decidirTituloSugerido(DONA, id, false);
    gerarResumoDaReuniao.mockResolvedValue(resumoCom("Preparação do aplicativo para as lojas"));
    await servico.refazerResumoDaDona(DONA, id, "sales", vaga);
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", template: "sales", suggestedTitleStatus: "ignored" });
    expect((await servico.resumoGuardadoDaDona(DONA, id)).tituloSugerido).toBeNull();
    gerarResumoDaReuniao.mockResolvedValue(resumoCom("Lançamento nas lojas"));
    await servico.refazerResumoDaDona(DONA, id, "networking", vaga);
    await rodar();
    expect((await servico.resumoGuardadoDaDona(DONA, id)).tituloSugerido).toBe("Lançamento nas lojas");
  });

  it("G16: o resumo sai no idioma da transcrição, também fora dos 10 da tela (italiano), e o resumo grava esse idioma", async () => {
    const id = await comResumoPronto("Preparazione dell'app", { idioma: "it" });
    expect(gerarResumoDaReuniao.mock.calls[0][0]).toMatchObject({ idioma: "it" });
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", language: "it" });
  });
});
