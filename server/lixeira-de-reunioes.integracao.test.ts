import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// O bucket é dublê: apagar de vez tira o áudio com todas as versões, e este
// arquivo não pode falar com um bucket de verdade.
const apagarAudio = vi.hoisted(() => vi.fn(async (_chave: string) => {}));
// A parte de áudio que chega (receberParte) sobe por aqui: o dublê diz se algo subiu.
const subirAudio = vi.hoisted(() => vi.fn(async (_chave: string) => ({ key: "x", url: "/manus-storage/x" })));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: (...args: unknown[]) => apagarAudio(...(args as [string])),
  storagePut: (...args: unknown[]) => subirAudio(...(args as [string])),
}));
// A IA do resumo é dublê: o que se prova é que a fila não pega a reunião da lixeira.
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));

const { getDb } = await import("./db");
const {
  agendaReunioes, auditLogs, meetingAudioSlices, meetingDocuments, meetingFolders, meetingRecordings, meetings, meetingSummaries, meetingSummaryItems,
  meetingTranscripts, networkSugestoes, platformNotifications, privateContacts, proximasAcoes, users,
} = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const lixeira = await import("./lixeira-de-reunioes");
const { buscarNasReunioes } = await import("./busca-de-reunioes");
const { listarPendencias } = await import("./network-extracao");
const { listarAgendaDaDona } = await import("./agenda-de-reunioes");
const { listarProximasAcoes } = await import("./proximas-acoes");
const filaDoResumo = await import("./fila-do-resumo");
const { gerarTokenDoLink } = await import("./link-aberto-da-reuniao");
const { rotaDaReuniao } = await import("@shared/rotas");
const { PRAZO_DA_LIXEIRA_MS, RECUSAS_DA_LIXEIRA } = await import("@shared/lixeira-de-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * A lixeira das reuniões (H7d) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). Exclusão ADIADA: a reunião na lixeira sai da
 * lista, da busca, do link aberto, das pendências, da agenda, do sino e da
 * fila, e cada procedimento pelo id a trata como "não encontrada"; restaurar a
 * devolve como estava (com o link desligado); apagar de vez e o fim dos 30
 * dias excluem pelo caminho de sempre. Donas com id aleatório: a limpeza só
 * alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-lixeira-${crypto.randomUUID()}`;
const OUTRA = `teste-lixeira-outra-${crypto.randomUUID()}`;
// userId fora de qualquer conta real (a coluna é int): a limpeza da auditoria vai por ele.
const ID_DA_DONA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;

function contexto(openId: string, id = ID_DA_DONA): TrpcContext {
  return {
    user: { id, openId, role: "silver", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: { "user-agent": "vitest-lixeira" }, ip: "203.0.113.31", socket: { remoteAddress: "203.0.113.31" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const daDona = () => appRouter.createCaller(contexto(DONA));
const daOutra = () => appRouter.createCaller(contexto(OUTRA, ID_DA_DONA + 1));
const publico = () => appRouter.createCaller({ user: null, req: { headers: {}, ip: "203.0.113.32", socket: { remoteAddress: "203.0.113.32" } }, res: {} } as unknown as TrpcContext);

async function db() { return (await getDb())!; }
const linha = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(() => null, e => e);
  expect(erro).toBeInstanceOf(TRPCError);
  return erro as TRPCError;
}

/** Uma reunião pronta da dona, com transcrição; o link aberto ligado quando pedido. */
async function reuniaoPronta(ownerId: string, opcoes: { titulo?: string; transcricao?: string; link?: boolean; extra?: Record<string, unknown> } = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const token = opcoes.link ? gerarTokenDoLink() : null;
  await banco.insert(meetings).values({
    id, ownerId, title: opcoes.titulo ?? "Reunião da lixeira", status: "ready", consentGranted: true, consentAt: AGORA, language: "pt-BR",
    origem: "gravacao", shareToken: token, createdAt: AGORA, updatedAt: AGORA, ...opcoes.extra,
  });
  await banco.insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId: id, ownerId, transcript: opcoes.transcricao ?? "Combinamos a exportação de café para março.",
    language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
  });
  return { id, token };
}

describe.skipIf(!temBanco)("Lixeira das reuniões (integração)", () => {
  let contaDaDona = 0;

  beforeAll(async () => {
    const banco = await db();
    await banco.insert(users).values([{ openId: DONA, name: "Dona Lixeira" }, { openId: OUTRA }]);
    contaDaDona = (await banco.select({ id: users.id }).from(users).where(eq(users.openId, DONA)))[0].id;
  });

  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    const donas = [DONA, OUTRA];
    await apagarPelaChave(banco, networkSugestoes, inArray(networkSugestoes.ownerId, donas));
    await apagarPelaChave(banco, proximasAcoes, inArray(proximasAcoes.ownerId, donas));
    await apagarPelaChave(banco, agendaReunioes, inArray(agendaReunioes.ownerId, donas));
    await apagarPelaChave(banco, meetingSummaryItems, inArray(meetingSummaryItems.ownerId, donas));
    await apagarPelaChave(banco, meetingSummaries, inArray(meetingSummaries.ownerId, donas));
    await apagarPelaChave(banco, meetingRecordings, inArray(meetingRecordings.ownerId, donas));
    await apagarPelaChave(banco, meetingAudioSlices, inArray(meetingAudioSlices.ownerId, donas));
    await apagarPelaChave(banco, meetingDocuments, inArray(meetingDocuments.ownerId, donas));
    await apagarPelaChave(banco, meetingTranscripts, inArray(meetingTranscripts.ownerId, donas));
    await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, donas));
    await apagarPelaChave(banco, meetingFolders, inArray(meetingFolders.ownerId, donas));
    await apagarPelaChave(banco, privateContacts, inArray(privateContacts.ownerId, donas));
    if (contaDaDona) await apagarPelaChave(banco, platformNotifications, eq(platformNotifications.userId, contaDaDona));
    await apagarPelaChave(banco, auditLogs, inArray(auditLogs.userId, [ID_DA_DONA, ID_DA_DONA + 1]));
    await banco.delete(users).where(inArray(users.openId, donas));
  });

  it("mandar para a lixeira: some da lista, da busca e do link aberto, o detalhe é 'não encontrada', o link desliga e o aviso sai do sino", async () => {
    const { id, token } = await reuniaoPronta(DONA, { titulo: "Reunião do café", link: true });
    const banco = await db();
    await banco.insert(platformNotifications).values({ userId: contaDaDona, type: "reuniao_pronta", title: "Pronta", actionUrl: rotaDaReuniao(id), isRead: false });
    // Antes: tudo aparece.
    expect((await daDona().meetings.list()).map(r => r.id)).toContain(id);
    expect((await buscarNasReunioes(DONA, "exportação", {})).resultados.map(r => r.meetingId)).toContain(id);
    await expect(publico().reuniaoAberta.ver({ token: token! })).resolves.toMatchObject({ titulo: "Reunião do café" });
    const antes = await linha(id);

    await expect(daDona().meetings.mandarParaALixeira({ meetingIds: [id] })).resolves.toEqual({ naLixeira: 1, linksDesligados: 1 });

    const depois = await linha(id);
    expect(depois.trashedAt).toBeGreaterThanOrEqual(AGORA);
    // Nada sai da reunião, e o updated_at (a ficha de quem a processa) não muda.
    expect(depois.status).toBe("ready");
    expect(Number(depois.updatedAt)).toBe(Number(antes.updatedAt));
    expect(depois.shareToken).toBeNull();
    expect((await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id))).length).toBe(1);
    expect((await daDona().meetings.list()).map(r => r.id)).not.toContain(id);
    expect((await buscarNasReunioes(DONA, "exportação", {})).resultados.map(r => r.meetingId)).not.toContain(id);
    expect((await recusa(daDona().meetings.get({ meetingId: id }))).code).toBe("NOT_FOUND");
    expect((await recusa(publico().reuniaoAberta.ver({ token: token! }))).code).toBe("NOT_FOUND");
    expect(await banco.select().from(platformNotifications).where(and(eq(platformNotifications.userId, contaDaDona), eq(platformNotifications.actionUrl, rotaDaReuniao(id))))).toEqual([]);
    // A lixeira da dona a mostra, com a hora em que foi para lá.
    const naLixeira = await daDona().meetings.lixeira();
    expect(naLixeira.find(r => r.id === id)).toMatchObject({ title: "Reunião do café", trashedAt: Number(depois.trashedAt) });
    // A prova vai na mesma transação: só ids.
    const [prova] = await banco.select().from(auditLogs).where(and(eq(auditLogs.userId, ID_DA_DONA), eq(auditLogs.action, "MEETINGS_TRASHED"), eq(auditLogs.resourceId, id)));
    expect(prova.details).toEqual({ reunioes: [id], linksDesligados: [id] });
    expect(JSON.stringify(prova.details)).not.toContain("café");
  });

  it("o link que escapou do desligar (a corrida com o 'mandar para a lixeira') não abre a reunião da lixeira, nem com a senha", async () => {
    // A reunião na lixeira com o token ainda gravado: é a defesa da consulta do
    // link, que não depende de o "mandar" ter desligado o link.
    const { id, token } = await reuniaoPronta(DONA, { titulo: "Reunião escapada", link: true, extra: { trashedAt: AGORA } });
    expect((await linha(id)).shareToken).toBe(token);
    expect((await recusa(publico().reuniaoAberta.ver({ token: token! }))).code).toBe("NOT_FOUND");
    expect((await recusa(publico().reuniaoAberta.resumoGuardado({ token: token! }))).code).toBe("NOT_FOUND");
    const { chaveDoAudioDoLink } = await import("./link-aberto-da-reuniao");
    expect(await chaveDoAudioDoLink(token!)).toBeNull();
    // Com senha: a entrada nem confere a senha, e o link continua "não existe".
    const { hashDaSenhaDoLink } = await import("./senha-do-link-aberto");
    await (await db()).update(meetings).set({ sharePasswordHash: await hashDaSenhaDoLink("482913") }).where(eq(meetings.id, id));
    await expect(publico().reuniaoAberta.entrar({ token: token!, senha: "482913" })).resolves.toMatchObject({ entrou: false });
    // E ligar o link de novo, pela dona, também é "não encontrada".
    expect((await recusa(daDona().meetings.novaSenhaDoLink({ meetingId: id }))).code).toBe("NOT_FOUND");
  });

  it("todo procedimento pelo id trata a reunião da lixeira como 'não encontrada': o item, a entidade, o link e os detalhes", async () => {
    const { id } = await reuniaoPronta(DONA);
    const banco = await db();
    const resumo = crypto.randomUUID();
    const item = crypto.randomUUID();
    await banco.insert(meetingSummaries).values({ id: resumo, meetingId: id, ownerId: DONA, status: "ready", createdAt: AGORA, updatedAt: AGORA });
    await banco.insert(meetingSummaryItems).values({
      id: item, summaryId: resumo, meetingId: id, ownerId: DONA, section: "action", position: 0, text: "Mandar a proposta", excerpt: "mandar a proposta", status: "pending", createdAt: AGORA, updatedAt: AGORA,
    });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });

    // Uma de cada vez (cada uma só começa quando a anterior foi recusada).
    const chamadas: Array<() => Promise<unknown>> = [
      () => daDona().meetings.resumoGuardado({ meetingId: id }),
      () => daDona().meetings.atualizarDetalhes({ meetingId: id, titulo: "Outro título" }),
      () => daDona().meetings.decidirItemDoResumo({ itemId: item, status: "confirmed" }),
      () => daDona().meetings.ligarLinkAberto({ meetingId: id, autorizacaoDasPessoas: true, idioma: "pt-BR", textoExibido: "Confirmo." }),
      () => daDona().meetings.nomearFalante({ meetingId: id, falante: "F1", nome: "Ana" }),
      () => daDona().meetings.moverParaPasta({ meetingIds: [id], pastaId: null }),
      () => daDona().meetings.juntar({ meetingIds: [id, crypto.randomUUID()] }),
      () => daDona().meetings.delete({ meetingId: id }),
    ];
    for (const chamada of chamadas) expect((await recusa(chamada())).code).toBe("NOT_FOUND");
    // Nada mudou nela.
    const depois = await linha(id);
    expect(depois.title).toBe("Reunião da lixeira");
    expect(depois.shareToken).toBeNull();
    expect((await banco.select().from(meetingSummaryItems).where(eq(meetingSummaryItems.id, item)))[0].status).toBe("pending");
  });

  it("a gravação em partes ainda no ar não vai para a lixeira (CONFLICT, com o código), e o pedido é todo ou nada", async () => {
    const banco = await db();
    const gravando = crypto.randomUUID();
    await banco.insert(meetings).values({
      id: gravando, ownerId: DONA, title: "Gravando", status: "recording", audioPipeline: "slices", consentGranted: true, consentAt: AGORA,
      createdAt: AGORA, updatedAt: AGORA,
    });
    const { id: pronta } = await reuniaoPronta(DONA);
    const erro = await recusa(daDona().meetings.mandarParaALixeira({ meetingIds: [pronta, gravando] }));
    expect(erro).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_LIXEIRA.gravando });
    expect((await linha(pronta)).trashedAt).toBeNull();
    expect((await linha(gravando)).trashedAt).toBeNull();
    // A gravação de envio único em 'recording' (sem parte nenhuma no servidor) pode.
    const unica = crypto.randomUUID();
    await banco.insert(meetings).values({ id: unica, ownerId: DONA, title: "Envio único", status: "recording", consentGranted: true, createdAt: AGORA, updatedAt: AGORA });
    await expect(daDona().meetings.mandarParaALixeira({ meetingIds: [unica] })).resolves.toMatchObject({ naLixeira: 1 });
  });

  it("a reunião de outra conta é 'não encontrada' em todos os passos da lixeira, e nada dela nem da dona muda", async () => {
    const { id: daOutraConta } = await reuniaoPronta(OUTRA);
    const { id: minha } = await reuniaoPronta(DONA);
    for (const acao of [
      () => daDona().meetings.mandarParaALixeira({ meetingIds: [minha, daOutraConta] }),
      () => daDona().meetings.restaurarDaLixeira({ meetingIds: [daOutraConta] }),
      () => daDona().meetings.apagarDeVez({ meetingIds: [daOutraConta] }),
    ]) expect((await recusa(acao())).code).toBe("NOT_FOUND");
    expect((await linha(minha)).trashedAt).toBeNull();
    expect((await linha(daOutraConta)).trashedAt).toBeNull();
    // Na lixeira da dona, a de outra conta nunca aparece.
    await daOutra().meetings.mandarParaALixeira({ meetingIds: [daOutraConta] });
    expect((await daDona().meetings.lixeira()).map(r => r.id)).not.toContain(daOutraConta);
    expect((await recusa(daDona().meetings.restaurarDaLixeira({ meetingIds: [daOutraConta] }))).code).toBe("NOT_FOUND");
  });

  it("restaurar devolve a reunião como estava, na pasta dela e com o link desligado; mandar de novo não recomeça o prazo de quem já estava lá", async () => {
    const banco = await db();
    const pasta = (await daDona().meetings.criarPasta({ nome: `Clientes ${crypto.randomUUID().slice(0, 6)}`, icone: "maleta", cor: "azul" })).id;
    const { id } = await reuniaoPronta(DONA, { link: true, extra: { folderId: pasta } });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });
    const primeira = Number((await linha(id)).trashedAt);
    // De novo, com ela já na lixeira: nada muda.
    await expect(daDona().meetings.mandarParaALixeira({ meetingIds: [id] })).resolves.toEqual({ naLixeira: 0, linksDesligados: 0 });
    expect(Number((await linha(id)).trashedAt)).toBe(primeira);
    // A pasta não conta a reunião da lixeira.
    expect((await daDona().meetings.pastas()).find(p => p.id === pasta)?.reunioes).toBe(0);

    await expect(daDona().meetings.restaurarDaLixeira({ meetingIds: [id] })).resolves.toEqual({ restauradas: 1 });
    const volta = await linha(id);
    expect(volta.trashedAt).toBeNull();
    expect(volta.folderId).toBe(pasta);
    expect(volta.shareToken).toBeNull();
    expect((await daDona().meetings.list()).find(r => r.id === id)).toMatchObject({ folderId: pasta });
    expect((await daDona().meetings.pastas()).find(p => p.id === pasta)?.reunioes).toBe(1);
    await expect(daDona().meetings.get({ meetingId: id })).resolves.toMatchObject({ meeting: { id } });
    const [prova] = await banco.select().from(auditLogs).where(and(eq(auditLogs.userId, ID_DA_DONA), eq(auditLogs.action, "MEETINGS_RESTORED"), eq(auditLogs.resourceId, id)));
    expect(prova.details).toEqual({ reunioes: [id] });
  });

  it("passados os 30 dias, restaurar é recusado (LIXEIRA_VENCIDA) e a lixeira já não a mostra", async () => {
    const { id } = await reuniaoPronta(DONA, { extra: { trashedAt: AGORA - PRAZO_DA_LIXEIRA_MS - DIA } });
    const erro = await recusa(daDona().meetings.restaurarDaLixeira({ meetingIds: [id] }));
    expect(erro).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_LIXEIRA.vencida });
    expect((await linha(id)).trashedAt).not.toBeNull();
    expect((await daDona().meetings.lixeira()).map(r => r.id)).not.toContain(id);
  });

  it("apagar de vez só toma a reunião que está na lixeira, e leva a transcrição e o áudio pelo caminho de sempre", async () => {
    const banco = await db();
    const { id: fora } = await reuniaoPronta(DONA);
    expect((await recusa(daDona().meetings.apagarDeVez({ meetingIds: [fora] }))).code).toBe("NOT_FOUND");
    expect(await linha(fora)).toBeDefined();

    const { id } = await reuniaoPronta(DONA);
    const chave = `meetings/${DONA}/${id}/recording.webm`;
    await banco.insert(meetingRecordings).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, storageKey: chave, storageUrl: `/manus-storage/${chave}`, mimeType: "audio/webm",
      sizeBytes: 10, durationSeconds: 5, expiresAt: AGORA + DIA, createdAt: AGORA,
    });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });
    apagarAudio.mockClear();
    await expect(daDona().meetings.apagarDeVez({ meetingIds: [id] })).resolves.toEqual({ apagadas: 1 });
    expect(await linha(id)).toBeUndefined();
    expect(await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id))).toEqual([]);
    expect(await banco.select().from(meetingRecordings).where(eq(meetingRecordings.meetingId, id))).toEqual([]);
    expect(apagarAudio).toHaveBeenCalledWith(chave);
  });

  it("esvaziar a lixeira leva só as reuniões da dona que estão lá, e diz se ainda resta alguma", async () => {
    const { id: a } = await reuniaoPronta(DONA);
    const { id: b } = await reuniaoPronta(DONA);
    const { id: fora } = await reuniaoPronta(DONA);
    const { id: daOutraConta } = await reuniaoPronta(OUTRA);
    await daDona().meetings.mandarParaALixeira({ meetingIds: [a, b] });
    await daOutra().meetings.mandarParaALixeira({ meetingIds: [daOutraConta] });
    let rodada = await daDona().meetings.esvaziarLixeira();
    while (rodada.restam) rodada = await daDona().meetings.esvaziarLixeira();
    expect(await linha(a)).toBeUndefined();
    expect(await linha(b)).toBeUndefined();
    expect(await linha(fora)).toBeDefined();
    expect(await linha(daOutraConta)).toBeDefined();
    expect(await daDona().meetings.lixeira()).toEqual([]);
  });

  it("o fim dos 30 dias: a varredura exclui de vez a reunião vencida e deixa a que ainda está no prazo e a restaurada", async () => {
    const { id: vencida } = await reuniaoPronta(DONA, { extra: { trashedAt: AGORA - PRAZO_DA_LIXEIRA_MS - 1 } });
    const { id: noPrazo } = await reuniaoPronta(DONA, { extra: { trashedAt: AGORA - PRAZO_DA_LIXEIRA_MS + DIA } });
    const { id: fora } = await reuniaoPronta(DONA);
    const resultado = await lixeira.esvaziarLixeiraVencida({ agora: AGORA, limite: 1000 });
    expect(resultado.apagadas).toBeGreaterThanOrEqual(1);
    expect(await linha(vencida)).toBeUndefined();
    expect(await linha(noPrazo)).toBeDefined();
    expect(await linha(fora)).toBeDefined();
    // A exclusão vinda da varredura só toma a que está lá desde antes do corte:
    // a restaurada no meio fica.
    const { deletePrivateMeeting } = await import("./meeting-service");
    expect(await deletePrivateMeeting(DONA, fora, { naLixeiraAte: AGORA - PRAZO_DA_LIXEIRA_MS })).toBe(false);
    expect(await deletePrivateMeeting(DONA, fora, { soDaLixeira: true })).toBe(false);
    expect(await linha(fora)).toBeDefined();
  });

  it("o que nasceu da reunião some enquanto ela está na lixeira: a pendência, a gravação na agenda e o atalho da próxima ação", async () => {
    const banco = await db();
    const { id } = await reuniaoPronta(DONA, { extra: { speakerNames: { F1: "Ana" } } });
    const pendencia = crypto.randomUUID();
    await banco.insert(networkSugestoes).values({
      id: pendencia, ownerId: DONA, meetingId: id, origem: "reuniao", campo: "preciso", valor: "Transportadora para café", alvo: "perfil",
      trecho: "precisamos de uma transportadora", createdAt: AGORA, updatedAt: AGORA,
    });
    const agenda = crypto.randomUUID();
    await banco.insert(agendaReunioes).values({
      id: agenda, ownerId: DONA, titulo: "Reunião marcada", inicioEm: AGORA + DIA, duracaoMinutos: 30, fuso: "America/Sao_Paulo", participantes: [],
      meetingId: id, createdAt: AGORA, updatedAt: AGORA,
    });
    const acao = crypto.randomUUID();
    await banco.insert(proximasAcoes).values({ id: acao, ownerId: DONA, texto: "{F1} manda a proposta", meetingId: id, origem: "reuniao", createdAt: AGORA, updatedAt: AGORA });
    const gravacaoNaAgenda = async () => [...(await listarAgendaDaDona(DONA)).proximas].find(r => r.id === agenda)?.gravacao ?? null;
    expect((await listarPendencias(DONA, {})).map(p => p.id)).toContain(pendencia);
    expect(await gravacaoNaAgenda()).toMatchObject({ id });

    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });

    expect((await listarPendencias(DONA, {})).map(p => p.id)).not.toContain(pendencia);
    expect((await daDona().networkInteligente.pendenciasDoPerfil()).map(p => p.id)).not.toContain(pendencia);
    expect(await gravacaoNaAgenda()).toBeNull();
    // A próxima ação é da dona e fica (como fica depois da exclusão), sem o atalho para a reunião.
    const naLista = (await listarProximasAcoes(DONA, "todas")).acoes.find(a => a.id === acao);
    expect(naLista?.reuniao).toBeNull();
    // Volta tudo ao restaurar.
    await daDona().meetings.restaurarDaLixeira({ meetingIds: [id] });
    expect((await listarPendencias(DONA, {})).map(p => p.id)).toContain(pendencia);
    expect(await gravacaoNaAgenda()).toMatchObject({ id });
    expect((await listarProximasAcoes(DONA, "todas")).acoes.find(a => a.id === acao)?.reuniao).toMatchObject({ id });
  });

  it("a fila do resumo não pega a reunião da lixeira: o resumo espera e sai depois de restaurar", async () => {
    const banco = await db();
    const { id } = await reuniaoPronta(DONA);
    await banco.insert(meetingSummaries).values({ id: crypto.randomUUID(), meetingId: id, ownerId: DONA, status: "pending", createdAt: AGORA - DIA, updatedAt: AGORA - DIA });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });
    gerarResumoDaReuniao.mockReset();
    gerarResumoDaReuniao.mockRejectedValue(new Error("não era para chamar a IA"));
    await filaDoResumo.rodarUmaVez({ ownerId: DONA });
    expect(gerarResumoDaReuniao).not.toHaveBeenCalled();
    expect((await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id)))[0]).toMatchObject({ status: "pending", attempts: 0 });

    await daDona().meetings.restaurarDaLixeira({ meetingIds: [id] });
    // Restaurada, a fila a pega (a IA dublê recusa, e a falha volta à fila: só importa que foi chamada).
    const silencio = vi.spyOn(console, "error").mockImplementation(() => {});
    const silencioAviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await filaDoResumo.rodarUmaVez({ ownerId: DONA });
    expect(gerarResumoDaReuniao).toHaveBeenCalled();
    silencio.mockRestore();
    silencioAviso.mockRestore();
  });

  it("a parte atrasada da reunião em 'uploading' que foi para a lixeira é recusada como 'não encontrada', e nada sobe ao bucket", async () => {
    const { receberParte, RecusaDaParte } = await import("./fatias-de-reuniao");
    const banco = await db();
    const id = crypto.randomUUID();
    // O fim já veio (2 partes), e a segunda ainda está no aparelho (a retomada a manda depois).
    await banco.insert(meetings).values({
      id, ownerId: DONA, title: "Enviando as partes", status: "uploading", audioPipeline: "slices", expectedSlices: 2, consentGranted: true, consentAt: AGORA,
      language: "pt-BR", origem: "gravacao", createdAt: AGORA, updatedAt: AGORA,
    });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });
    subirAudio.mockClear();
    const parte = () => receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wavSintetico(2) });
    const erro = await parte().then(() => null, e => e);
    expect(erro).toBeInstanceOf(RecusaDaParte);
    expect((erro as InstanceType<typeof RecusaDaParte>).codigo).toBe("SEM_REUNIAO");
    expect(subirAudio).not.toHaveBeenCalled();
    expect(await banco.select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, id))).toEqual([]);
    // Restaurada, a mesma parte entra: a recusa era a lixeira.
    await daDona().meetings.restaurarDaLixeira({ meetingIds: [id] });
    await expect(parte()).resolves.toMatchObject({ seq: 1 });
    expect(subirAudio).toHaveBeenCalledTimes(1);
  });

  it("decidir a pendência da reunião na lixeira (a do contato e a do perfil) é 'não encontrada', e nada muda; restaurada, a decisão vale", async () => {
    const banco = await db();
    const { id } = await reuniaoPronta(DONA);
    await banco.insert(privateContacts).values({ ownerId: DONA, fullName: "Contato da lixeira", createdAt: AGORA, updatedAt: AGORA });
    const [contato] = await banco.select({ id: privateContacts.id }).from(privateContacts)
      .where(and(eq(privateContacts.ownerId, DONA), eq(privateContacts.fullName, "Contato da lixeira")));
    const doContato = crypto.randomUUID();
    const doPerfil = crypto.randomUUID();
    await banco.insert(networkSugestoes).values([
      { id: doContato, ownerId: DONA, contactId: contato.id, meetingId: id, origem: "reuniao", campo: "cargo", valor: "Diretora comercial", alvo: "contato", createdAt: AGORA, updatedAt: AGORA },
      { id: doPerfil, ownerId: DONA, meetingId: id, origem: "reuniao", campo: "preciso", valor: "Transportadora refrigerada para frutas", alvo: "perfil", createdAt: AGORA, updatedAt: AGORA },
    ]);
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });

    for (const decisao of [
      () => daDona().networkInteligente.confirmarPendencia({ id: doContato }),
      () => daDona().networkInteligente.ignorarPendencia({ id: doContato }),
      () => daDona().networkInteligente.confirmarPendencia({ id: doPerfil }),
      () => daDona().networkInteligente.ignorarPendencia({ id: doPerfil }),
    ]) expect((await recusa(decisao())).code).toBe("NOT_FOUND");
    const status = async () => (await banco.select({ id: networkSugestoes.id, status: networkSugestoes.status }).from(networkSugestoes)
      .where(inArray(networkSugestoes.id, [doContato, doPerfil]))).map(linha => linha.status);
    expect(await status()).toEqual(["pendente", "pendente"]);
    const cargo = async () => (await banco.select({ cargo: privateContacts.jobTitle }).from(privateContacts).where(eq(privateContacts.id, contato.id)))[0].cargo;
    expect(await cargo()).toBeNull();

    await daDona().meetings.restaurarDaLixeira({ meetingIds: [id] });
    await expect(daDona().networkInteligente.confirmarPendencia({ id: doContato })).resolves.toMatchObject({ alvo: "contato" });
    expect(await cargo()).toBe("Diretora comercial");
    await expect(daDona().networkInteligente.ignorarPendencia({ id: doPerfil })).resolves.toMatchObject({ ok: true, alvo: "perfil" });
  });

  it("o reprocesso do documento não toma a reunião que está na lixeira, mesmo quando quem chama a leu antes de ela ir para lá", async () => {
    const { iniciarReprocessamentoDoDocumento } = await import("./documento-da-reuniao");
    const banco = await db();
    const id = crypto.randomUUID();
    await banco.insert(meetings).values({
      id, ownerId: DONA, title: "Contrato em PDF", status: "failed", consentGranted: true, consentAt: AGORA, language: "pt-BR", origem: "pdf",
      trashedAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
    });
    const chave = `meetings/${DONA}/${id}/documento-abcd1234.pdf`;
    await banco.insert(meetingDocuments).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, storageKey: chave, storageUrl: `/manus-storage/${chave}`, mimeType: "application/pdf",
      sizeBytes: 1000, sha256: "a".repeat(64), expiresAt: AGORA + 10 * DIA, createdAt: AGORA,
    });
    // A leitura de quem chama (iniciarReprocessamento) é anterior: o que decide é a tomada.
    const erro = await iniciarReprocessamentoDoDocumento(banco, { id, ownerId: DONA, updatedAt: AGORA, language: "pt-BR", processingError: null }).then(() => null, e => e);
    expect(erro).toMatchObject({ name: "ReprocessamentoRecusado", codigo: "NOT_FOUND" });
    expect(await linha(id)).toMatchObject({ status: "failed", updatedAt: AGORA });
  });
});

/** Um WAV mínimo e sintético de `segundos` (mono, 8 bits, 1 kHz, silêncio): o servidor mede a duração pelo cabeçalho. */
function wavSintetico(segundos: number): Buffer {
  const dados = Buffer.alloc(Math.round(segundos * 1000), 128);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(1, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(1000, 24); cabecalho.writeUInt32LE(1000, 28); cabecalho.writeUInt16LE(1, 32); cabecalho.writeUInt16LE(8, 34);
  cabecalho.write("data", 36); cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}
