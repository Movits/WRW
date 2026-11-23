import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O mapa mental editável (H10b) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê. O que se prova: a edição
 * guardada ao lado do mapa da IA, a revisão, a auditoria na transação, a
 * conferência com o código, o "Voltar ao da IA", o "Refazer em outro estilo"
 * pela fila (com o mapa de antes à vista e o estilo no pedido à IA), o mapa
 * editado que o resumo refeito não apaga, a tradução dos rótulos editados, o
 * link que vê o mapa que vale sem o que é da edição, e a dona no WHERE.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));

const { getDb } = await import("./db");
const { auditLogs, consumoDeMinutos, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const resumoGuardado = await import("./resumo-guardado");
const guardado = await import("./mapa-mental-guardado");
const edicao = await import("./mapa-mental-edicao");
const { lerResumoParaTraduzir } = await import("./traducao-do-resumo-banco");
const { FalhaDaIA } = await import("./ia-em-json");
const { ACAO_MAPA_EDITADO, ACAO_MAPA_REFEITO, RECUSAS_DO_MAPA, REFAZERES_DO_MAPA_POR_JANELA, renomearNo, moverNo, apagarNo } = await import("@shared/mapa-mental-edicao");
const { appRouter } = await import("./routers");
const { tetoDaIADaReuniao, tetoDoRefazerDoMapa } = await import("./routers/meetings");
type TrpcContext = import("./_core/context").TrpcContext;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-mapa-ed-${crypto.randomUUID()}`;
const OUTRA = `teste-mapa-ed-outra-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_100_000_000 + Math.floor(Math.random() * 40_000_000);
const PROVA = { userId: ID_DA_DONA, ipAddress: "127.0.0.1, 10.0.0.1", userAgent: "vitest" };
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();
async function db() { return (await getDb())!; }
function contexto(openId: string): TrpcContext {
  return {
    user: { id: ID_DA_DONA, openId, role: "user", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: { "user-agent": "vitest-mapa" }, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const peloRouter = () => appRouter.createCaller(contexto(DONA));

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
const EDITADO = moverNo(renomearNo(MAPA, [0], "Café para exportar"), [1], [0]);
const LINHA_DO_TEMPO = {
  ramos: [{ rotulo: "Abertura", folhas: [{ rotulo: "Exportação de café", filhos: [] }] }, { rotulo: "Decisão", folhas: [{ rotulo: "Transportadora", filhos: [] }] }],
};

async function reuniaoComMapa(extra: Record<string, unknown> = {}, dona = DONA) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: dona, title: "Reunião do mapa", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  await (await db()).insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId: dona, transcript: TEXTO, segments: SEGMENTOS,
    language: "pt-BR", durationSeconds: 12, createdAt: AGORA(), updatedAt: AGORA(),
  });
  if (dona === DONA) {
    await resumoGuardado.pedirResumoDaDona(DONA, id, () => undefined);
    await rodar();
  }
  return id;
}

const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const auditoriasDe = async (meetingId: string, acao: string) => (await db()).select().from(auditLogs)
  .where(and(eq(auditLogs.resourceId, meetingId), eq(auditLogs.action, acao)));
const salvar = (id: string, revisao: number, mapa: unknown) => edicao.mudarMapaDaDona(DONA, id, { tipo: "salvar", revisao, mapa }, PROVA);
const voltar = (id: string, revisao: number) => edicao.mudarMapaDaDona(DONA, id, { tipo: "voltar", revisao }, PROVA);
const soltar = vi.fn();
const refazer = (id: string, revisao: number, estilo: "overview" | "hierarchical" | "timeline" | "concept") =>
  edicao.refazerMapaNoEstilo(DONA, id, { revisao, estilo }, PROVA, () => soltar);

async function limpar() {
  const banco = await db();
  await apagarPelaChave(banco, auditLogs, eq(auditLogs.userId, ID_DA_DONA));
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
    await apagarPelaChave(banco, consumoDeMinutos, eq(consumoDeMinutos.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("O mapa mental editável (integração)", () => {
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
    soltar.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("o mapa novo da IA é o da H10: sem edição nem estilo na tela, revisão 1 guardada", async () => {
    const id = await reuniaoComMapa();
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapStatus: "ready", mindMapRevision: 1, mindMapEdited: null, mindMapStyle: null });
    expect(await guardado.mapaMentalDaDona(DONA, id)).toEqual({
      estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA, versaoAnterior: false,
      edicao: { revisao: 1, editado: false, editadoEm: null, refazendo: false, erroDoRefazer: null },
    });
  });

  it("salvar guarda a edição ao lado do mapa da IA, sobe a revisão e audita na transação, sem rótulos; o link vê o editado, sem a edição", async () => {
    const token = crypto.randomBytes(24).toString("base64url");
    const id = await reuniaoComMapa({ shareToken: token });
    expect(await salvar(id, 1, EDITADO)).toEqual({ mudou: true, revisao: 2, editado: true });

    const linha = await linhaDoResumo(id);
    expect(linha.mindMap).toEqual(MAPA);
    expect(linha.mindMapEdited).toEqual(EDITADO);
    expect(Number(linha.mindMapEditedAt)).toBeGreaterThan(0);
    const daDona = await guardado.mapaMentalDaDona(DONA, id);
    expect(daDona.mapa).toEqual(EDITADO);
    expect(daDona.edicao).toMatchObject({ revisao: 2, editado: true, refazendo: false });
    expect(await guardado.mapaMentalPeloLink(token)).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: EDITADO, versaoAnterior: false });

    const [auditoria] = await auditoriasDe(id, ACAO_MAPA_EDITADO);
    expect(auditoria).toMatchObject({ userId: ID_DA_DONA, ipAddress: "127.0.0.1", status: "success" });
    expect(auditoria.details).toEqual({ operacao: "salvar", ramos: 2, nos: 5, revisao: 2, voltouAoDaIA: false });
    expect(JSON.stringify(auditoria.details)).not.toContain("Café");

    // O mesmo mapa de novo não grava nem audita.
    expect(await salvar(id, 2, EDITADO)).toEqual({ mudou: false, revisao: 2, editado: true });
    expect(await auditoriasDe(id, ACAO_MAPA_EDITADO)).toHaveLength(1);
  });

  it("a revisão velha (outra aba) é MAPA_MUDOU, sem gravar", async () => {
    const id = await reuniaoComMapa();
    await salvar(id, 1, EDITADO);
    await expect(salvar(id, 1, MAPA)).rejects.toMatchObject({ codigoTrpc: "CONFLICT", message: RECUSAS_DO_MAPA.mudou });
    expect((await linhaDoResumo(id)).mindMapEdited).toEqual(EDITADO);
  });

  it("o mapa fora das regras é recusado com o código e não grava nada", async () => {
    const id = await reuniaoComMapa();
    await expect(salvar(id, 1, renomearNo(MAPA, [0, 0], "{F2} vai mandar"))).rejects.toMatchObject({ codigoTrpc: "BAD_REQUEST", message: RECUSAS_DO_MAPA.rotulo });
    await expect(salvar(id, 1, apagarNo(MAPA, [1]))).rejects.toMatchObject({ message: RECUSAS_DO_MAPA.poucosRamos });
    await expect(salvar(id, 1, renomearNo(MAPA, [1], "exportacao de cafe"))).rejects.toMatchObject({ message: RECUSAS_DO_MAPA.repetido });
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapEdited: null, mindMapRevision: 1 });
    expect(await auditoriasDe(id, ACAO_MAPA_EDITADO)).toHaveLength(0);
  });

  it("voltar ao da IA apaga a edição; salvar o mesmo mapa da IA também volta a ele", async () => {
    const id = await reuniaoComMapa();
    await salvar(id, 1, EDITADO);
    expect(await voltar(id, 2)).toEqual({ mudou: true, revisao: 3, editado: false });
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapEdited: null, mindMapEditedAt: null, mindMap: MAPA });
    await salvar(id, 3, EDITADO);
    expect(await salvar(id, 4, MAPA)).toEqual({ mudou: true, revisao: 5, editado: false });
    expect((await linhaDoResumo(id)).mindMapEdited).toBeNull();
    const detalhes = (await auditoriasDe(id, ACAO_MAPA_EDITADO)).map(a => (a.details as { operacao: string; voltouAoDaIA: boolean }));
    expect(detalhes.map(d => [d.operacao, d.voltouAoDaIA])).toEqual(expect.arrayContaining([["voltar", true], ["salvar", true], ["salvar", false]]));
  });

  it("outra dona, reunião na lixeira e reunião sem mapa: NOT_FOUND ou SEM_MAPA, sem gravar", async () => {
    const id = await reuniaoComMapa();
    await expect(edicao.mudarMapaDaDona(OUTRA, id, { tipo: "salvar", revisao: 1, mapa: EDITADO }, PROVA)).rejects.toMatchObject({ codigoTrpc: "NOT_FOUND" });
    await expect(edicao.refazerMapaNoEstilo(OUTRA, id, { revisao: 1, estilo: "timeline" }, PROVA, () => soltar)).rejects.toMatchObject({ codigoTrpc: "NOT_FOUND" });
    expect(soltar).toHaveBeenCalledTimes(1);
    await (await db()).update(meetings).set({ trashedAt: AGORA() }).where(eq(meetings.id, id));
    await expect(salvar(id, 1, EDITADO)).rejects.toMatchObject({ codigoTrpc: "NOT_FOUND" });
    const semMapa = await reuniaoComMapa({}, OUTRA);
    await expect(edicao.mudarMapaDaDona(OUTRA, semMapa, { tipo: "salvar", revisao: 0, mapa: EDITADO }, PROVA)).rejects.toMatchObject({ message: RECUSAS_DO_MAPA.semMapa });
    expect((await linhaDoResumo(id)).mindMapEdited).toBeNull();
  });

  it("refazer em outro estilo: o mapa editado segue à vista enquanto a IA refaz; a edição espera; o novo chega no estilo e substitui a edição", async () => {
    const id = await reuniaoComMapa();
    await salvar(id, 1, EDITADO);
    expect(await refazer(id, 2, "timeline")).toEqual({ revisao: 3 });
    expect(soltar).not.toHaveBeenCalled();
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapStatus: "pending", mindMapStyle: "timeline", mindMapEdited: EDITADO });
    const durante = await guardado.mapaMentalDaDona(DONA, id);
    expect(durante).toMatchObject({ estado: "pronto", mapa: EDITADO, estilo: "timeline", edicao: { refazendo: true, editado: true, erroDoRefazer: null } });
    await expect(salvar(id, 3, MAPA)).rejects.toMatchObject({ codigoTrpc: "CONFLICT", message: RECUSAS_DO_MAPA.refazendo });
    await expect(refazer(id, 3, "concept")).rejects.toMatchObject({ message: RECUSAS_DO_MAPA.refazendo });
    expect(soltar).toHaveBeenCalledTimes(1);
    const [auditoria] = await auditoriasDe(id, ACAO_MAPA_REFEITO);
    expect(auditoria.details).toEqual({ estilo: "timeline", estiloAnterior: "overview", tinhaEdicao: true, revisao: 3 });

    gerarMapaMental.mockResolvedValue(LINHA_DO_TEMPO);
    await rodar();
    expect(gerarMapaMental).toHaveBeenLastCalledWith({ transcricao: TEXTO, idioma: "pt-BR", estilo: "timeline" });
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapStatus: "ready", mindMap: LINHA_DO_TEMPO, mindMapEdited: null, mindMapEditedAt: null, mindMapRevision: 4 });
    expect(await guardado.mapaMentalDaDona(DONA, id)).toMatchObject({ estado: "pronto", mapa: LINHA_DO_TEMPO, estilo: "timeline", edicao: { editado: false, refazendo: false } });
  });

  it("o refazer que falha deixa o mapa de antes à vista, com o erro; pedir de novo o refaz no mesmo estilo", async () => {
    const id = await reuniaoComMapa();
    await refazer(id, 1, "concept");
    gerarMapaMental.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA", "cortada"));
    await rodar();
    expect(await guardado.mapaMentalDaDona(DONA, id)).toMatchObject({ estado: "pronto", mapa: MAPA, estilo: "concept", edicao: { refazendo: false, erroDoRefazer: "RESPOSTA_CORTADA" } });
    // Editar o mapa de antes continua possível: ele não está na fila.
    expect((await salvar(id, 2, EDITADO)).mudou).toBe(true);
    gerarMapaMental.mockResolvedValue(LINHA_DO_TEMPO);
    await guardado.pedirMapaDaDona(DONA, id, () => undefined);
    await rodar();
    expect(gerarMapaMental).toHaveBeenLastCalledWith(expect.objectContaining({ estilo: "concept" }));
    expect((await linhaDoResumo(id)).mindMap).toEqual(LINHA_DO_TEMPO);
  });

  it("o resumo refeito sobre a transcrição editada refaz o mapa da IA, mas não apaga o que a dona editou", async () => {
    const semEdicao = await reuniaoComMapa();
    const comEdicao = await reuniaoComMapa();
    await salvar(comEdicao, 1, EDITADO);
    for (const id of [semEdicao, comEdicao]) {
      await (await db()).update(meetingTranscripts).set({ editedAt: AGORA() + 1000, revision: 1 }).where(eq(meetingTranscripts.meetingId, id));
      await resumoGuardado.refazerResumoDaDona(DONA, id, { modelo: "general" }, () => undefined);
    }
    gerarMapaMental.mockClear();
    // Uma rodada da fila pega um resumo por vez: roda até os dois ficarem prontos.
    for (let i = 0; i < 6; i++) await rodar();
    expect((await linhaDoResumo(semEdicao)).status).toBe("ready");
    expect(await linhaDoResumo(comEdicao)).toMatchObject({ status: "ready", version: 2 });
    // Só o mapa da reunião sem edição foi refeito.
    expect(gerarMapaMental).toHaveBeenCalledTimes(1);
    expect((await linhaDoResumo(comEdicao)).mindMapEdited).toEqual(EDITADO);
    expect((await guardado.mapaMentalDaDona(DONA, comEdicao)).mapa).toEqual(EDITADO);
  });

  it("a tradução do resumo (H11) lê os rótulos do mapa que vale: o editado", async () => {
    const id = await reuniaoComMapa();
    await salvar(id, 1, EDITADO);
    const leitura = await lerResumoParaTraduzir(DONA, id, "en");
    expect(leitura.estado).toBe("pronto");
    if (leitura.estado !== "pronto") return;
    expect(leitura.rotulosDoMapa).toContain("Café para exportar");
    expect(leitura.rotulosDoMapa).not.toContain("Exportação de café");
  });

  it("pelo router: a recusa sai com o código traduzível; o refazer gasta uma vaga de cada teto, e o recusado devolve as duas", async () => {
    const id = await reuniaoComMapa();
    tetoDoRefazerDoMapa.esquecer();
    tetoDaIADaReuniao.esquecer();
    try {
      await expect(peloRouter().meetings.editarMapa({ meetingId: id, revisao: 0, operacao: { tipo: "salvar", mapa: EDITADO } }))
        .rejects.toMatchObject({ code: "CONFLICT", message: RECUSAS_DO_MAPA.mudou });
      expect(await peloRouter().meetings.editarMapa({ meetingId: id, revisao: 1, operacao: { tipo: "salvar", mapa: EDITADO } })).toEqual({ mudou: true, revisao: 2, editado: true });
      // O recusado (revisão velha) não gasta: o teto inteiro de recusas e o pedido de verdade ainda entra.
      for (let i = 0; i < REFAZERES_DO_MAPA_POR_JANELA; i++) {
        await expect(peloRouter().meetings.refazerMapa({ meetingId: id, revisao: 1, estilo: "concept" })).rejects.toMatchObject({ code: "CONFLICT" });
      }
      expect(await peloRouter().meetings.refazerMapa({ meetingId: id, revisao: 2, estilo: "concept" })).toEqual({ revisao: 3 });
      // As vagas gastas: as que restam do teto do refazer e uma do teto comum.
      for (let i = 1; i < REFAZERES_DO_MAPA_POR_JANELA; i++) tetoDoRefazerDoMapa.reservar(DONA);
      await expect(peloRouter().meetings.refazerMapa({ meetingId: id, revisao: 3, estilo: "timeline" }))
        .rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_MAPA.refazeresDemais });
    } finally {
      tetoDoRefazerDoMapa.esquecer();
      tetoDaIADaReuniao.esquecer();
    }
  });

  it("pelo router: a reunião na lixeira é recusada pela guarda antes do serviço", async () => {
    const id = await reuniaoComMapa();
    await (await db()).update(meetings).set({ trashedAt: AGORA() }).where(eq(meetings.id, id));
    await expect(peloRouter().meetings.editarMapa({ meetingId: id, revisao: 1, operacao: { tipo: "voltar" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(peloRouter().meetings.refazerMapa({ meetingId: id, revisao: 1, estilo: "timeline" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
