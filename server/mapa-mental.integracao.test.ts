import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O mapa mental (H10) contra um banco real DE TESTE (sem DATABASE_URL_TESTES,
 * se pula). A IA é dublê: o que se prova é o banco — o mapa como segunda fase
 * do mesmo trabalho da fila do resumo, a falha do mapa que não derruba o
 * resumo, o pedido da reunião resumida antes do mapa, a exclusão e o
 * reprocesso no meio, a dona no WHERE e o que o link aberto vê.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));

const { getDb } = await import("./db");
const { consumoDeMinutos, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const resumoGuardado = await import("./resumo-guardado");
const servico = await import("./mapa-mental-guardado");
const { FalhaDaIA } = await import("./ia-em-json");
const { deletePrivateMeeting, gravarResultadoDaReuniao } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-mapa-${crypto.randomUUID()}`;
const OUTRA = `teste-mapa-outra-${crypto.randomUUID()}`;
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

const SEGMENTOS = [
  { inicio: 0, fim: 5, falante: "F1", texto: "Bom dia. Vamos falar da exportação de café." },
  { inicio: 5, fim: 12, falante: "F2", texto: "Decidimos não renovar o contrato com a transportadora." },
];
const TEXTO = SEGMENTOS.map(s => s.texto).join("\n");
const RESUMO = {
  emoji: "☕", modelo: "gemini-teste-1", recebidos: 1,
  itens: [{ section: "decision", subject: null, text: "Não renovar com a transportadora", assignee: null, due: null, excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds: 5, confidence: 1 }],
};
const MAPA = {
  ramos: [
    { rotulo: "Exportação de café", folhas: [{ rotulo: "Contêiner sai de Santos", filhos: ["12 de março"] }] },
    { rotulo: "Transportadora", folhas: [{ rotulo: "Contrato não será renovado", filhos: [] }] },
  ],
};

async function reuniaoPronta(extra: Record<string, unknown> = {}, comTranscricao = true) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: "Reunião do mapa", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  if (comTranscricao) {
    await (await db()).insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: TEXTO, segments: SEGMENTOS,
      language: "pt-BR", durationSeconds: 12, createdAt: AGORA(), updatedAt: AGORA(),
    });
  }
  return id;
}

const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const itensDe = async (meetingId: string) => (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, meetingId)).orderBy(meetingSummaryItems.position);
const vaga = vi.fn();
const pedirResumo = (meetingId: string) => resumoGuardado.pedirResumoDaDona(DONA, meetingId, vaga);
const pedirMapa = (meetingId: string) => servico.pedirMapaDaDona(DONA, meetingId, vaga);
const vencerAEspera = async (meetingId: string) => (await db()).update(meetingSummaries).set({ lockedUntil: AGORA() - 1 }).where(eq(meetingSummaries.meetingId, meetingId));

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await banco.delete(meetingSummaryItems).where(eq(meetingSummaryItems.ownerId, dona));
    await banco.delete(meetingSummaries).where(eq(meetingSummaries.ownerId, dona));
    await banco.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, dona));
    await banco.delete(meetings).where(eq(meetings.ownerId, dona));
    await banco.delete(consumoDeMinutos).where(eq(consumoDeMinutos.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("O mapa mental na fila do resumo (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    fila.religarParaTestes();
    gerarResumoDaReuniao.mockReset().mockResolvedValue(RESUMO);
    gerarMapaMental.mockReset().mockResolvedValue(MAPA);
    vaga.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("o resumo e o mapa saem na mesma rodada; a dona lê o mapa pronto, com o idioma do resumo", async () => {
    const id = await reuniaoPronta();
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("sem_mapa");
    await pedirResumo(id);
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pendente");

    await rodar();

    expect(gerarMapaMental).toHaveBeenCalledWith({ transcricao: TEXTO, idioma: "pt-BR" });
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", version: 1, attempts: 1, lockToken: null, lockedUntil: null, mindMapStatus: "ready", mindMapError: null });
    expect(Number((await linhaDoResumo(id)).mindMapGeneratedAt)).toBeGreaterThan(0);
    expect(await servico.mapaMentalDaDona(DONA, id)).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA, versaoAnterior: false });
    expect((await resumoGuardado.resumoGuardadoDaDona(DONA, id)).estado).toBe("pronto");
  });

  it("o mapa que falha não derruba o resumo: a falha passageira espera; na 3ª, falha; pedir de novo o reabre e gasta a vaga", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    vaga.mockClear();
    gerarMapaMental.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL"));

    await rodar();
    let linha = await linhaDoResumo(id);
    expect(linha).toMatchObject({ status: "ready", lastError: null, mindMapStatus: "pending", mindMapError: "IA_INDISPONIVEL", attempts: 1, lockToken: null });
    expect(Number(linha.lockedUntil)).toBeGreaterThan(AGORA());
    expect((await resumoGuardado.resumoGuardadoDaDona(DONA, id)).itens).toHaveLength(1);
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pendente");
    // Enquanto espera, nenhuma rodada pega.
    await rodar();
    expect(gerarMapaMental).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 2; i++) {
      await vencerAEspera(id);
      await rodar();
    }
    linha = await linhaDoResumo(id);
    expect(linha).toMatchObject({ status: "ready", mindMapStatus: "failed", mindMapError: "IA_INDISPONIVEL", attempts: 3 });
    expect(await servico.mapaMentalDaDona(DONA, id)).toMatchObject({ estado: "falhou", erro: "IA_INDISPONIVEL", mapa: null });
    expect(gerarResumoDaReuniao).toHaveBeenCalledTimes(1);

    gerarMapaMental.mockResolvedValue(MAPA);
    expect((await pedirMapa(id)).estado).toBe("pendente");
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapStatus: "pending", mindMapError: null, attempts: 0 });
    await rodar();
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pronto");
    expect(gerarResumoDaReuniao).toHaveBeenCalledTimes(1);
  });

  it("o mapa que a conferência não aceita falha de vez, com o código que a tela traduz", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    gerarMapaMental.mockResolvedValue(null);
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", mindMapStatus: "failed", mindMapError: "MAPA_INVALIDO", attempts: 1 });
    expect(await servico.mapaMentalDaDona(DONA, id)).toMatchObject({ estado: "falhou", erro: "MAPA_INVALIDO" });
  });

  it("a reunião resumida antes do mapa: 'sem mapa'; pedir põe só o mapa na fila, sem refazer o resumo nem mexer nos itens decididos", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    await rodar();
    const [item] = await itensDe(id);
    await resumoGuardado.decidirItemDoResumo(DONA, item.id, "confirmed");
    // O resumo de antes do mapa: a linha pronta, com as colunas do mapa vazias.
    await (await db()).update(meetingSummaries).set({ mindMap: null, mindMapStatus: null, mindMapGeneratedAt: null }).where(eq(meetingSummaries.meetingId, id));
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("sem_mapa");
    gerarResumoDaReuniao.mockClear();
    gerarMapaMental.mockClear();
    vaga.mockClear();

    expect((await pedirMapa(id)).estado).toBe("pendente");
    expect(vaga).toHaveBeenCalledTimes(1);
    // Pedir de novo o que já está na fila não gasta vaga.
    await pedirMapa(id);
    expect(vaga).toHaveBeenCalledTimes(1);
    await rodar();

    expect(gerarResumoDaReuniao).not.toHaveBeenCalled();
    expect(gerarMapaMental).toHaveBeenCalledTimes(1);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", version: 1, mindMapStatus: "ready" });
    expect((await itensDe(id)).map(i => [i.id, i.status])).toEqual([[item.id, "confirmed"]]);
    // Pronto, pedir de novo não muda nada nem gasta vaga.
    await pedirMapa(id);
    expect(vaga).toHaveBeenCalledTimes(1);
  });

  it("sem resumo, pedir o mapa pede o resumo, e o mapa vem com ele", async () => {
    const id = await reuniaoPronta();
    expect((await pedirMapa(id)).estado).toBe("pendente");
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending" });
    await rodar();
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pronto");
  });

  it("reunião excluída enquanto o mapa é gerado: nada fica", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    gerarMapaMental.mockImplementation(async () => {
      await deletePrivateMeeting(DONA, id);
      return MAPA;
    });
    await rodar();
    expect(await linhaDoResumo(id)).toBeUndefined();
    expect(await itensDe(id)).toEqual([]);
  });

  it("transcrição trocada durante o mapa: o mapa não é gravado, e a reserva volta sem gastar a tentativa", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    gerarMapaMental.mockImplementation(async () => {
      await (await db()).update(meetingTranscripts).set({ id: crypto.randomUUID() }).where(eq(meetingTranscripts.meetingId, id));
      return MAPA;
    });
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", mindMapStatus: "pending", mindMap: null, lockToken: null, lockedUntil: null, attempts: 0 });
  });

  it("o desligamento durante o mapa devolve a reserva sem gastar a tentativa; o resumo fica gravado", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    let devolvidas = -1;
    gerarMapaMental.mockImplementation(async () => {
      devolvidas = (await fila.pararFilaDoResumo()).resumos;
      return MAPA;
    });
    await rodar();
    expect(devolvidas).toBe(1);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", mindMapStatus: "pending", mindMap: null, attempts: 0, lockToken: null, lockedUntil: null });
    expect(await itensDe(id)).toHaveLength(1);
  });

  it("três tentativas do mapa gastas e sem reserva viva: desiste sem chamar a IA; o resumo continua pronto", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    await rodar();
    await (await db()).update(meetingSummaries).set({ mindMapStatus: "pending", mindMap: null, attempts: 3, lockToken: null, lockedUntil: null }).where(eq(meetingSummaries.meetingId, id));
    gerarMapaMental.mockClear();
    await rodar();
    expect(gerarMapaMental).not.toHaveBeenCalled();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", mindMapStatus: "failed", mindMapError: "TENTATIVAS_ESGOTADAS" });
    expect((await resumoGuardado.resumoGuardadoDaDona(DONA, id)).estado).toBe("pronto");
  });

  it("o reprocesso recria a linha: o mapa antigo sai com ela, e o novo vem com o resumo novo", async () => {
    const banco = await db();
    const ficha = AGORA();
    const id = crypto.randomUUID();
    await banco.insert(meetings).values({
      id, ownerId: DONA, title: "Reunião que fica pronta", status: "processing", consentGranted: true, consentAt: ficha, language: "pt-BR", createdAt: ficha, updatedAt: ficha,
    });
    const TRANSCRICAO = { text: TEXTO, segments: SEGMENTOS, language: "pt-BR" };
    const SEM_EXTRACAO = { entities: [], contacts: [] } as never;
    await gravarResultadoDaReuniao(banco, { meetingId: id, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 12, transcription: TRANSCRICAO, extraction: SEM_EXTRACAO });
    await rodar();
    expect((await linhaDoResumo(id)).mindMapStatus).toBe("ready");

    const fichaNova = ficha + 1_000;
    await banco.update(meetings).set({ status: "processing", updatedAt: fichaNova }).where(eq(meetings.id, id));
    await gravarResultadoDaReuniao(banco, { meetingId: id, ownerId: DONA, ficha: fichaNova, limparAntes: true, durationSeconds: 12, transcription: TRANSCRICAO, extraction: SEM_EXTRACAO });
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", mindMap: null, mindMapStatus: null, mindMapGeneratedAt: null, mindMapError: null });
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pendente");
    await rodar();
    expect((await servico.mapaMentalDaDona(DONA, id)).estado).toBe("pronto");
  });

  it("só a dona: outra conta recebe NOT_FOUND para ler e pedir o mapa", async () => {
    const id = await reuniaoPronta();
    await pedirResumo(id);
    await rodar();
    await expect(servico.mapaMentalDaDona(OUTRA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.pedirMapaDaDona(OUTRA, id, vaga)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reunião que não está pronta, ou sem transcrição, não pede o mapa", async () => {
    const processando = await reuniaoPronta({ status: "processing" });
    await expect(pedirMapa(processando)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const semTexto = await reuniaoPronta({}, false);
    await expect(pedirMapa(semTexto)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(vaga).not.toHaveBeenCalled();
  });

  it("o link aberto lê o mapa no mesmo formato e pede o da reunião resumida antes do mapa, com a vaga da reunião", async () => {
    const token = crypto.randomBytes(24).toString("base64url");
    const id = await reuniaoPronta({ shareToken: token });
    await pedirResumo(id);
    await rodar();
    expect(await servico.mapaMentalPeloLink(token)).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA, versaoAnterior: false });

    await (await db()).update(meetingSummaries).set({ mindMap: null, mindMapStatus: null }).where(eq(meetingSummaries.meetingId, id));
    const vagaDoLink = vi.fn();
    expect((await servico.pedirMapaPeloLink(token, vagaDoLink)).estado).toBe("pendente");
    expect(vagaDoLink).toHaveBeenCalledWith(id);
    await expect(servico.mapaMentalPeloLink("x".repeat(32))).rejects.toMatchObject({ codigo: "NOT_FOUND" });
  });
});
