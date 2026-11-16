import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A fila do resumo guardado (H4) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê: o que se prova é o banco — a
 * reserva atômica, a gravação que confere a reunião e a reserva, as falhas, a
 * devolução das reservas no SIGTERM, a dona no WHERE e o que o link aberto vê.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
// O mapa mental (H10) é a segunda fase do mesmo trabalho e segue na mesma
// rodada: dublado aqui, para a rodada nunca chamar a IA de verdade. O que é
// do mapa está em mapa-mental.integracao.test.ts.
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));
const MAPA = { ramos: [{ rotulo: "Exportação de café", folhas: [] }, { rotulo: "Transportadora", folhas: [] }] };

const { getDb } = await import("./db");
const { consumoDeMinutos, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, platformNotifications, proximasAcoes, users } = await import("../drizzle/schema");
const fila = await import("./fila-do-resumo");
const servico = await import("./resumo-guardado");
const acoes = await import("./proximas-acoes");
const { FalhaDaIA } = await import("./ia-em-json");
const { deletePrivateMeeting, gravarResultadoDaReuniao } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-resumo-${crypto.randomUUID()}`;
const OUTRA = `teste-resumo-outra-${crypto.randomUUID()}`;
const rodar = () => fila.rodarUmaVez({ ownerId: DONA });
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

const SEGMENTOS = [
  { inicio: 0, fim: 5, falante: "F1", texto: "Bom dia. Vamos falar da exportação de café." },
  { inicio: 5, fim: 12, falante: "F2", texto: "Decidimos não renovar o contrato com a transportadora." },
];

async function reuniaoPronta(extra: Record<string, unknown> = {}, comTranscricao = true) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: "Reunião do resumo", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  if (comTranscricao) {
    await (await db()).insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: SEGMENTOS.map(s => s.texto).join("\n"), segments: SEGMENTOS,
      language: "pt-BR", durationSeconds: 12, createdAt: AGORA(), updatedAt: AGORA(),
    });
  }
  return id;
}

const ITENS = [
  { section: "action", subject: null, text: "Avisar a transportadora", assignee: "{F2}", due: null, excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds: 5, confidence: 0.9 },
  { section: "decision", subject: null, text: "Não renovar com a transportadora", assignee: null, due: null, excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds: 5, confidence: 1 },
] as const;
const RESUMO = { emoji: "☕", modelo: "gemini-teste-1", itens: ITENS, recebidos: 2 };

const linhaDoResumo = async (meetingId: string) => (await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, meetingId)))[0];
const itensDe = async (meetingId: string) => (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.meetingId, meetingId)).orderBy(meetingSummaryItems.position);
const vaga = vi.fn();
const pedir = (meetingId: string) => servico.pedirResumoDaDona(DONA, meetingId, vaga);

/** Os avisos de reunião pronta (H15) da conta da dona. */
async function avisosDaDona(meetingId?: string) {
  const banco = await db();
  const [conta] = await banco.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
  const avisos = await banco.select().from(platformNotifications).where(eq(platformNotifications.userId, conta.id));
  return avisos.filter(aviso => !meetingId || aviso.actionUrl === `/meetings/${meetingId}`);
}

async function limpar() {
  const banco = await db();
  // A fila avisa no sino quando o resumo fica pronto ou falha de vez (H15).
  const contas = await banco.select({ id: users.id }).from(users).where(inArray(users.openId, [DONA, OUTRA]));
  if (contas.length) await banco.delete(platformNotifications).where(inArray(platformNotifications.userId, contas.map(conta => conta.id)));
  for (const dona of [DONA, OUTRA]) {
    // Confirmar uma ação no resumo cria a próxima ação dela (H5a).
    await banco.delete(proximasAcoes).where(eq(proximasAcoes.ownerId, dona));
    await banco.delete(meetingSummaryItems).where(eq(meetingSummaryItems.ownerId, dona));
    await banco.delete(meetingSummaries).where(eq(meetingSummaries.ownerId, dona));
    await banco.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, dona));
    await banco.delete(meetings).where(eq(meetings.ownerId, dona));
    // gravarResultadoDaReuniao (o disparo automático) conta os minutos da reunião.
    await banco.delete(consumoDeMinutos).where(eq(consumoDeMinutos.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Fila do resumo guardado no banco (integração)", () => {
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
    gerarMapaMental.mockResolvedValue(MAPA);
    vaga.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("pedir cria o trabalho; a rodada grava os itens pendentes, com o tempo, e o resumo fica pronto", async () => {
    const id = await reuniaoPronta();
    expect((await pedir(id)).estado).toBe("pendente");
    expect(vaga).toHaveBeenCalledTimes(1);

    await rodar();

    // O primeiro resumo, no modelo padrão e sem item que fique (os modelos e o
    // refazer da H4d estão em server/resumo-refeito.integracao.test.ts).
    expect(gerarResumoDaReuniao).toHaveBeenCalledWith({ transcricao: SEGMENTOS.map(s => s.texto).join("\n"), segmentos: SEGMENTOS, idioma: "pt-BR", modelo: "general", itensQueFicam: [] });
    const resumo = await servico.resumoGuardadoDaDona(DONA, id);
    expect(resumo).toMatchObject({ estado: "pronto", emoji: "☕", idioma: "pt-BR", erro: null });
    expect(resumo.itens.map(i => [i.section, i.position, i.status, i.done, i.startSeconds, i.assignee])).toEqual([
      ["action", 0, "pending", false, 5, "{F2}"],
      ["decision", 1, "pending", false, 5, null],
    ]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", version: 1, attempts: 1, lockToken: null, lockedUntil: null, model: "gemini-teste-1" });
    // O mapa mental (H10) veio na mesma rodada, sem mexer no resumo.
    expect(await linhaDoResumo(id)).toMatchObject({ mindMapStatus: "ready", mindMapError: null });
    // O aviso no sino (H15), na mesma transação: o tipo, o link da reunião e
    // os parâmetros que a tela traduz.
    const avisos = await avisosDaDona(id);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ type: "reuniao_pronta", title: "Reunião do resumo", body: null, isRead: false, parametros: { titulo: "Reunião do resumo", resumo: "pronto" } });
  });

  it("o resumo refeito troca o aviso de pronta: um por reunião; excluir a reunião o apaga (H15)", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await rodar();
    await (await db()).update(meetingSummaries).set({ status: "pending", attempts: 0 }).where(eq(meetingSummaries.meetingId, id));
    await rodar();
    expect(await avisosDaDona(id)).toHaveLength(1);
    await deletePrivateMeeting(DONA, id);
    expect(await avisosDaDona(id)).toEqual([]);
  });

  it("pedir de novo o que já está na fila, ou pronto, não gasta vaga nem duplica", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await pedir(id);
    expect(vaga).toHaveBeenCalledTimes(1);
    await rodar();
    await pedir(id);
    expect(vaga).toHaveBeenCalledTimes(1);
    expect(await (await db()).select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id))).toHaveLength(1);
  });

  it("de duas rodadas ao mesmo tempo, só uma reserva e gera", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return RESUMO; });
    await Promise.all([rodar(), rodar()]);
    expect(gerarResumoDaReuniao).toHaveBeenCalledTimes(1);
    expect(await itensDe(id)).toHaveLength(2);
  });

  it("falha passageira volta à fila com espera; na 3ª tentativa vira falha, e pedir de novo reabre", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL"));

    await rodar();
    let linha = await linhaDoResumo(id);
    expect(linha).toMatchObject({ status: "pending", attempts: 1, lastError: "IA_INDISPONIVEL", lockToken: null });
    expect(Number(linha.lockedUntil)).toBeGreaterThan(AGORA());
    // Enquanto espera, nenhuma rodada pega.
    await rodar();
    expect(gerarResumoDaReuniao).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 2; i++) {
      await (await db()).update(meetingSummaries).set({ lockedUntil: AGORA() - 1 }).where(eq(meetingSummaries.meetingId, id));
      await rodar();
    }
    linha = await linhaDoResumo(id);
    expect(linha).toMatchObject({ status: "failed", attempts: 3, lastError: "IA_INDISPONIVEL" });
    expect((await servico.resumoGuardadoDaDona(DONA, id)).estado).toBe("falhou");
    // Só a falha de vez avisa (H15): pronta, sem o resumo. As passageiras, não.
    expect((await avisosDaDona(id)).map(aviso => aviso.parametros)).toEqual([{ titulo: "Reunião do resumo", resumo: "falhou" }]);

    await pedir(id);
    expect(vaga).toHaveBeenCalledTimes(2);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  });

  it("resposta cortada no teto de saída é falha de vez, sem nova tentativa", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", attempts: 1, lastError: "RESPOSTA_CORTADA" });
  });

  it("a conferência tirou tudo: o resumo fica pronto e vazio, com o registro", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockResolvedValue({ emoji: null, modelo: "gemini-teste-1", itens: [], recebidos: 3 });
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", lastError: "CONFERENCIA_TIROU_TUDO" });
    expect(await itensDe(id)).toEqual([]);
  });

  it("reunião excluída enquanto a IA responde: nada é gravado e nada sobra", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockImplementation(async () => {
      await deletePrivateMeeting(DONA, id);
      return RESUMO;
    });
    await rodar();
    expect(await itensDe(id)).toEqual([]);
    expect(await linhaDoResumo(id)).toBeUndefined();
    // Nem o aviso de pronta (H15).
    expect(await avisosDaDona(id)).toEqual([]);
  });

  it("transcrição trocada durante a geração (reprocesso): o resumo da antiga não é gravado, e a reserva volta sem gastar tentativa", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockImplementation(async () => {
      await (await db()).update(meetingTranscripts).set({ id: crypto.randomUUID() }).where(eq(meetingTranscripts.meetingId, id));
      return RESUMO;
    });
    await rodar();
    expect(await itensDe(id)).toEqual([]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", lockToken: null, lockedUntil: null, attempts: 0 });
  });

  it("reserva vencida retomada por outra rodada: a primeira não grava e não mexe na reserva da outra", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    const daOutra = crypto.randomUUID();
    gerarResumoDaReuniao.mockImplementation(async () => {
      await (await db()).update(meetingSummaries).set({ lockToken: daOutra, lockedUntil: AGORA() + 600_000 }).where(eq(meetingSummaries.meetingId, id));
      return RESUMO;
    });
    await rodar();
    expect(await itensDe(id)).toEqual([]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", lockToken: daOutra });
  });

  it("três tentativas gastas e sem reserva viva: desiste e vira falha sem chamar a IA; com reserva viva, espera", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await (await db()).update(meetingSummaries).set({ attempts: 3, lockedUntil: AGORA() + 600_000, lockToken: crypto.randomUUID() }).where(eq(meetingSummaries.meetingId, id));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", attempts: 3 });
    await (await db()).update(meetingSummaries).set({ lockedUntil: null, lockToken: null }).where(eq(meetingSummaries.meetingId, id));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS" });
    expect(gerarResumoDaReuniao).not.toHaveBeenCalled();
  });

  it("conta desativada: a fila não gera o resumo dela", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await (await db()).update(users).set({ isActive: false }).where(eq(users.openId, DONA));
    try {
      await rodar();
      expect(gerarResumoDaReuniao).not.toHaveBeenCalled();
    } finally {
      await (await db()).update(users).set({ isActive: true }).where(eq(users.openId, DONA));
    }
  });

  it("a transcrição sumiu depois do pedido: falha de vez, com o código", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await (await db()).delete(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", lastError: "SEM_TRANSCRICAO" });
    expect(gerarResumoDaReuniao).not.toHaveBeenCalled();
  });

  it("na espera depois de uma falha passageira o estado é 'pendente', não 'gerando'", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL"));
    await rodar();
    expect((await servico.resumoGuardadoDaDona(DONA, id)).estado).toBe("pendente");
    await (await db()).update(meetingSummaries).set({ lockToken: crypto.randomUUID(), lockedUntil: AGORA() + 600_000 }).where(eq(meetingSummaries.meetingId, id));
    expect((await servico.resumoGuardadoDaDona(DONA, id)).estado).toBe("gerando");
  });

  it("o teto que recusa impede o trabalho de nascer", async () => {
    const id = await reuniaoPronta();
    await expect(servico.pedirResumoDaDona(DONA, id, () => { throw new Error("teto"); })).rejects.toThrow("teto");
    expect(await linhaDoResumo(id)).toBeUndefined();
  });

  it("decidir com o resumo sendo refeito é conflito", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await rodar();
    const [acao] = await itensDe(id);
    await (await db()).update(meetingSummaries).set({ status: "pending" }).where(eq(meetingSummaries.meetingId, id));
    await expect(servico.decidirItemDoResumo(DONA, acao.id, "confirmed")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(servico.confirmarItensDoResumo(DONA, id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(servico.marcarAcaoFeita(DONA, acao.id, true)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("o resumo refeito (H4d) guarda o item confirmado com a próxima ação presa a ele, com o prazo; a leitura seguinte não cria outra (H5a)", async () => {
    const id = await reuniaoPronta({ speakerNames: { F2: "Carla" } });
    await pedir(id);
    await rodar();
    const [acao] = await itensDe(id);
    await servico.decidirItemDoResumo(DONA, acao.id, "confirmed");
    const [proxima] = await (await db()).select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    await (await db()).update(proximasAcoes).set({ prazo: "2026-11-20" }).where(eq(proximasAcoes.id, proxima.id));
    // "Refazer como…": o resumo volta à fila com os itens ainda lá, e a rodada grava os novos.
    await (await db()).update(meetingSummaries).set({ status: "pending" }).where(eq(meetingSummaries.meetingId, id));
    await rodar();
    expect((await itensDe(id)).map(item => item.id)).toContain(acao.id);
    // A lista e o Dashboard completam as ações que faltam antes de ler: nenhuma falta.
    await acoes.listarProximasAcoes(DONA, "todas");
    expect(await (await db()).select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA))).toMatchObject([{
      id: proxima.id, itemId: acao.id, meetingId: id, prazo: "2026-11-20", texto: "Avisar a transportadora", responsavel: "{F2}",
    }]);
  });

  it("o resumo refeito solta só a ação presa a um item que sai: o nome da voz vai para o texto, e a reunião e o trecho ficam (H5a)", async () => {
    const id = await reuniaoPronta({ speakerNames: { F2: "Carla" } });
    await pedir(id);
    await rodar();
    const [acao] = await itensDe(id);
    // A ação de um item que não está confirmado (a regra não deixa nascer; um
    // dado antigo, por exemplo): o item sai, e ela se solta dele.
    await (await db()).insert(proximasAcoes).values({
      id: crypto.randomUUID(), ownerId: DONA, origem: "reuniao", meetingId: id, itemId: acao.id, texto: acao.text, responsavel: acao.assignee,
      trecho: acao.excerpt, feita: false, createdAt: AGORA(), updatedAt: AGORA(),
    });
    await (await db()).update(meetingSummaries).set({ status: "pending" }).where(eq(meetingSummaries.meetingId, id));
    await rodar();
    expect((await itensDe(id)).map(item => item.id)).not.toContain(acao.id);
    expect(await (await db()).select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA))).toMatchObject([{
      texto: "Avisar a transportadora", responsavel: "Carla", itemId: null, meetingId: id,
      trecho: "Decidimos não renovar o contrato com a transportadora",
    }]);
  });

  it("a falha de vez do mapa (H10) e a do resumo refeito (H4d) não trocam o aviso de pronta; a do primeiro resumo, sim (H15)", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    gerarMapaMental.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "ready", mindMapStatus: "failed", mindMapError: "RESPOSTA_CORTADA" });
    expect((await avisosDaDona(id)).map(aviso => aviso.parametros)).toEqual([{ titulo: "Reunião do resumo", resumo: "pronto" }]);

    // O refazer que falha de vez: a versão anterior segue na tela, e o sino segue dizendo que a reunião está pronta.
    await (await db()).update(meetingSummaries).set({ status: "pending", attempts: 0 }).where(eq(meetingSummaries.meetingId, id));
    gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    await rodar();
    expect(await linhaDoResumo(id)).toMatchObject({ status: "failed", version: 1, lastError: "RESPOSTA_CORTADA" });
    expect((await avisosDaDona(id)).map(aviso => aviso.parametros)).toEqual([{ titulo: "Reunião do resumo", resumo: "pronto" }]);

    // O primeiro resumo de outra reunião que falha de vez avisa que ela ficou sem o resumo.
    const outra = await reuniaoPronta();
    await pedir(outra);
    await rodar();
    expect((await avisosDaDona(outra)).map(aviso => aviso.parametros)).toEqual([{ titulo: "Reunião do resumo", resumo: "falhou" }]);
  });

  it("o desligamento devolve a reserva sem gastar a tentativa, e a geração em curso não grava", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    let devolvidas = -1;
    gerarResumoDaReuniao.mockImplementation(async () => {
      devolvidas = (await fila.pararFilaDoResumo()).resumos;
      return RESUMO;
    });
    await rodar();
    expect(devolvidas).toBe(1);
    expect(await itensDe(id)).toEqual([]);
    expect(await linhaDoResumo(id)).toMatchObject({ status: "pending", attempts: 0, lockToken: null, lockedUntil: null });
  });

  it("decidir, confirmar todos e marcar a ação feita; só ação tem caixa", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await rodar();
    const [acao, decisao] = await itensDe(id);

    await servico.decidirItemDoResumo(DONA, decisao.id, "ignored");
    await servico.marcarAcaoFeita(DONA, acao.id, true);
    let [a, d] = await itensDe(id);
    expect(d.status).toBe("ignored");
    expect(a).toMatchObject({ status: "confirmed", done: true });
    expect(Number(a.decidedAt)).toBeGreaterThan(0);
    // A ação marcada como feita vira próxima ação já feita (H5a).
    const acoesDaDona = async () => (await db()).select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA));
    expect(await acoesDaDona()).toMatchObject([{ itemId: acao.id, feita: true }]);

    // Voltar a pendente tira a marca de feito, e a próxima ação sai.
    await servico.decidirItemDoResumo(DONA, acao.id, "pending");
    [a] = await itensDe(id);
    expect(a).toMatchObject({ status: "pending", done: false, doneAt: null, decidedAt: null });
    expect(await acoesDaDona()).toEqual([]);

    await expect(servico.marcarAcaoFeita(DONA, decisao.id, true)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await servico.confirmarItensDoResumo(DONA, id)).toBe(1);
    expect((await itensDe(id)).map(i => i.status)).toEqual(["confirmed", "ignored"]);
  });

  it("só a dona: outra conta recebe NOT_FOUND para ler, pedir e decidir", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await rodar();
    const [acao] = await itensDe(id);
    await expect(servico.resumoGuardadoDaDona(OUTRA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.pedirResumoDaDona(OUTRA, id, vaga)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.decidirItemDoResumo(OUTRA, acao.id, "ignored")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.marcarAcaoFeita(OUTRA, acao.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.confirmarItensDoResumo(OUTRA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await itensDe(id))[0].status).toBe("pending");
  });

  it("reunião que não está pronta, ou sem transcrição, não pede resumo", async () => {
    const processando = await reuniaoPronta({ status: "processing" });
    await expect(pedir(processando)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const semTexto = await reuniaoPronta({}, false);
    await expect(pedir(semTexto)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(vaga).not.toHaveBeenCalled();
  });

  it("o link aberto vê o resumo sem ids, sem a caixa e sem os ignorados; os pendentes vão com o estado", async () => {
    const token = crypto.randomBytes(24).toString("base64url");
    const id = await reuniaoPronta({ shareToken: token });
    const vagaDoLink = vi.fn();
    expect((await servico.pedirResumoPeloLink(token, vagaDoLink)).estado).toBe("pendente");
    expect(vagaDoLink).toHaveBeenCalledWith(id);
    await rodar();
    const [, decisao] = await itensDe(id);
    await servico.decidirItemDoResumo(DONA, decisao.id, "ignored");

    const visto = await servico.resumoGuardadoPeloLink(token);
    expect(visto.estado).toBe("pronto");
    // O idioma em que o resumo foi escrito: a página do link o traduz (H11), e
    // "Ouvir o resumo" (H19) escolhe a voz por ele.
    expect(visto.idioma).toBe("pt-BR");
    expect(visto.itens).toEqual([{
      section: "action", subject: null, text: "Avisar a transportadora", assignee: "{F2}", due: null,
      excerpt: "Decidimos não renovar o contrato com a transportadora", startSeconds: 5, status: "pending", escritoPelaDona: false,
    }]);
    await expect(servico.resumoGuardadoPeloLink("x".repeat(32))).rejects.toMatchObject({ codigo: "NOT_FOUND" });
  });

  it("o link de reunião sem resumo diz 'sem_resumo'; sem transcrição, não pede", async () => {
    const token = crypto.randomBytes(24).toString("base64url");
    await reuniaoPronta({ shareToken: token }, false);
    expect(await servico.resumoGuardadoPeloLink(token)).toEqual({ estado: "sem_resumo", emoji: null, idioma: null, versaoAnterior: false, itens: [] });
    await expect(servico.pedirResumoPeloLink(token, vi.fn())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("excluir a reunião apaga o resumo e os itens", async () => {
    const id = await reuniaoPronta();
    await pedir(id);
    await rodar();
    expect(await itensDe(id)).toHaveLength(2);
    await deletePrivateMeeting(DONA, id);
    expect(await itensDe(id)).toEqual([]);
    expect(await linhaDoResumo(id)).toBeUndefined();
  });

  describe("o disparo automático (H4c): toda reunião que fica pronta ganha o pedido do resumo", () => {
    const TRANSCRICAO = { text: SEGMENTOS.map(s => s.texto).join("\n"), segments: SEGMENTOS, language: "pt-BR" };
    const SEM_EXTRACAO = { entities: [], contacts: [] } as never;

    async function reuniaoProcessando(ficha: number) {
      const id = crypto.randomUUID();
      await (await db()).insert(meetings).values({
        id, ownerId: DONA, title: "Reunião que fica pronta", status: "processing", consentGranted: true, consentAt: ficha, language: "pt-BR",
        createdAt: ficha, updatedAt: ficha,
      });
      return id;
    }
    const transcricaoDe = async (meetingId: string) => (await (await db()).select({ id: meetingTranscripts.id }).from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId)))[0];

    it("gravarResultadoDaReuniao cria a linha pendente da transcrição gravada; a fila a gera; o reprocesso a recria do zero", async () => {
      const banco = await db();
      const ficha = AGORA();
      const id = await reuniaoProcessando(ficha);
      await gravarResultadoDaReuniao(banco, { meetingId: id, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 12, transcription: TRANSCRICAO, extraction: SEM_EXTRACAO });

      const primeira = await transcricaoDe(id);
      const pedido = await linhaDoResumo(id);
      expect(pedido).toMatchObject({ ownerId: DONA, status: "pending", transcriptId: primeira.id, attempts: 0, lockToken: null, version: 0 });
      expect((await servico.resumoGuardadoDaDona(DONA, id)).estado).toBe("pendente");

      await rodar();
      expect((await servico.resumoGuardadoDaDona(DONA, id)).estado).toBe("pronto");
      const [acao] = await itensDe(id);
      await servico.decidirItemDoResumo(DONA, acao.id, "confirmed");

      // O reprocesso toma a reunião com ficha nova e passa de novo por aqui, limpando antes.
      const fichaNova = ficha + 1_000;
      await banco.update(meetings).set({ status: "processing", updatedAt: fichaNova }).where(eq(meetings.id, id));
      await gravarResultadoDaReuniao(banco, { meetingId: id, ownerId: DONA, ficha: fichaNova, limparAntes: true, durationSeconds: 12, transcription: TRANSCRICAO, extraction: SEM_EXTRACAO });

      const segunda = await transcricaoDe(id);
      expect(segunda.id).not.toBe(primeira.id);
      const refeito = await linhaDoResumo(id);
      expect(refeito.id).not.toBe(pedido.id);
      expect(refeito).toMatchObject({ status: "pending", transcriptId: segunda.id, version: 0, emoji: null, generatedAt: null });
      expect(await itensDe(id)).toEqual([]);
      expect(await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id))).toHaveLength(1);
    });

    it("a linha que já existir fica como está, inteira: o insert é idempotente, uma linha por reunião, e a reunião fica pronta", async () => {
      const banco = await db();
      const ficha = AGORA();
      const id = await reuniaoProcessando(ficha);
      // Diferente em tudo do que o pedido gravaria (status, tentativas, erro,
      // transcrição e datas): qualquer coluna que o conflito mudasse apareceria.
      await banco.insert(meetingSummaries).values({
        id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcriptId: crypto.randomUUID(), status: "failed",
        attempts: 3, lastError: "IA_INDISPONIVEL", createdAt: ficha - 60_000, updatedAt: ficha - 30_000,
      });
      const antes = await linhaDoResumo(id);

      await gravarResultadoDaReuniao(banco, { meetingId: id, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 12, transcription: TRANSCRICAO, extraction: SEM_EXTRACAO });

      expect(await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id))).toEqual([antes]);
      const [reuniao] = await banco.select({ status: meetings.status }).from(meetings).where(eq(meetings.id, id));
      expect(reuniao.status).toBe("ready");
    });
  });
});
