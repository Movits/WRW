import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * As próximas ações (H5a) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). Prova o que o dublê não prova: a ação nasce e
 * morre na mesma transação da decisão no resumo, o índice único (dona, item)
 * segura a repetição, o backfill da leitura é idempotente, a data do prazo vai
 * e volta como "AAAA-MM-DD", e a reunião excluída, a reprocessada e o contato
 * excluído soltam a ação sem apagá-la. Tudo com a dona no WHERE. E a corrida
 * entre a decisão no resumo e a exclusão, com duas conexões: a decisão trava a
 * reunião, e a exclusão a espera.
 */

const { getDb, createPrivateContact, deletePrivateContact } = await import("./db");
const {
  consumoDeMinutos, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, privateContacts, proximasAcoes, users,
} = await import("../drizzle/schema");
const resumo = await import("./resumo-guardado");
const acoes = await import("./proximas-acoes");
const { deletePrivateMeeting, gravarResultadoDaReuniao } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-acoes-${crypto.randomUUID()}`;
const OUTRA = `teste-acoes-outra-${crypto.randomUUID()}`;
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

type Item = { section: "action" | "task" | "decision"; subject?: string | null; text: string; assignee?: string | null; due?: string | null; status?: "pending" | "confirmed" | "ignored" };

/** Uma reunião pronta da dona com o resumo pronto e os itens dados, na ordem. */
async function reuniaoComResumo(itens: Item[], extra: Record<string, unknown> = {}) {
  const banco = await db();
  const meetingId = crypto.randomUUID();
  const summaryId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id: meetingId, ownerId: DONA, title: "Reunião das ações", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), ...extra,
  });
  await banco.insert(meetingSummaries).values({ id: summaryId, meetingId, ownerId: DONA, status: "ready", createdAt: AGORA(), updatedAt: AGORA() });
  const ids: string[] = [];
  for (const [position, item] of itens.entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    await banco.insert(meetingSummaryItems).values({
      id, summaryId, meetingId, ownerId: DONA, section: item.section, position, subject: item.subject ?? null, text: item.text,
      assignee: item.assignee ?? null, due: item.due ?? null, excerpt: `trecho de ${item.text}`, startSeconds: 10 * position,
      confidence: "0.900", status: item.status ?? "pending", decidedAt: item.status === "confirmed" ? AGORA() : null,
      createdAt: AGORA(), updatedAt: AGORA(),
    });
  }
  return { meetingId, summaryId, ids };
}

const acoesDa = async (ownerId: string) => (await db()).select().from(proximasAcoes).where(eq(proximasAcoes.ownerId, ownerId));
const acaoDoItem = async (itemId: string) => (await (await db()).select().from(proximasAcoes)
  .where(and(eq(proximasAcoes.ownerId, DONA), eq(proximasAcoes.itemId, itemId))))[0];
const itemPorId = async (itemId: string) => (await (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.id, itemId)))[0];

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await banco.delete(proximasAcoes).where(eq(proximasAcoes.ownerId, dona));
    await banco.delete(meetingSummaryItems).where(eq(meetingSummaryItems.ownerId, dona));
    await banco.delete(meetingSummaries).where(eq(meetingSummaries.ownerId, dona));
    await banco.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, dona));
    await banco.delete(meetings).where(eq(meetings.ownerId, dona));
    await banco.delete(privateContacts).where(eq(privateContacts.ownerId, dona));
    await banco.delete(consumoDeMinutos).where(eq(consumoDeMinutos.ownerId, dona));
  }
}

/**
 * Espera, com prazo, um comando de outra conexão parado numa trava. Os comandos
 * destes testes levam menos de um milissegundo: o parado há um segundo ou mais
 * está esperando a trava. O molde é o de chaves-de-acesso.integracao.test.ts: a
 * espera se vê em information_schema.PROCESSLIST, e não em INNODB_TRX, porque
 * no MariaDB o SELECT ... FOR UPDATE espera antes de a transação aparecer lá.
 */
async function esperarParadoNaTrava(padrao: string, falha: string) {
  const banco = await db();
  const prazo = Date.now() + 10_000;
  while (Date.now() < prazo) {
    const [linhas] = (await banco.execute(sql`
      SELECT COUNT(*) AS esperando FROM information_schema.PROCESSLIST
      WHERE ID <> CONNECTION_ID() AND COMMAND IN ('Query', 'Execute') AND TIME >= 1
        AND INFO LIKE ${padrao}`)) as unknown as [Array<{ esperando: number | string }>, unknown];
    if (Number(linhas[0]?.esperando ?? 0) > 0) return;
    await new Promise(resolver => setTimeout(resolver, 50));
  }
  throw new Error(falha);
}

describe.skipIf(!temBanco)("Próximas ações no banco (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("confirmar a ação cria a próxima ação junto; confirmar de novo não duplica; decisão não vira ação; desconfirmar apaga", async () => {
    const { ids: [acao, tarefa, decisao] } = await reuniaoComResumo([
      { section: "action", text: "{F2} envia a proposta", assignee: "{F2}", due: "até sexta" },
      { section: "task", subject: "Contrato", text: "{F1} fecha o contrato" },
      { section: "decision", text: "Não renovar" },
    ]);
    await resumo.decidirItemDoResumo(DONA, acao, "confirmed");
    await resumo.decidirItemDoResumo(DONA, acao, "confirmed");
    await resumo.decidirItemDoResumo(DONA, tarefa, "confirmed");
    await resumo.decidirItemDoResumo(DONA, decisao, "confirmed");
    const linhas = await acoesDa(DONA);
    expect(linhas).toHaveLength(2);
    expect(await acaoDoItem(acao)).toMatchObject({
      origem: "reuniao", texto: "{F2} envia a proposta", detalhe: null, responsavel: "{F2}", prazoDito: "até sexta", prazo: null,
      trecho: "trecho de {F2} envia a proposta", feita: false, contactId: null,
    });
    expect(await acaoDoItem(tarefa)).toMatchObject({ texto: "Contrato", detalhe: "{F1} fecha o contrato" });

    await resumo.decidirItemDoResumo(DONA, acao, "ignored");
    await resumo.decidirItemDoResumo(DONA, tarefa, "pending");
    expect(await acoesDa(DONA)).toEqual([]);
  });

  it("'Confirmar todos' cria as ações das ações e tarefas, e também a de um item confirmado antes da H5a", async () => {
    const { meetingId, ids: [antiga, nova, decisao] } = await reuniaoComResumo([
      { section: "action", text: "Confirmada antes", status: "confirmed" },
      { section: "task", subject: "Logística", text: "Cotar o frete" },
      { section: "decision", text: "Fechar com a transportadora" },
    ]);
    expect(await resumo.confirmarItensDoResumo(DONA, meetingId)).toBe(2);
    expect((await acoesDa(DONA)).map(a => a.itemId).sort()).toEqual([antiga, nova].sort());
    expect(await acaoDoItem(decisao)).toBeUndefined();
  });

  it("feita é uma escrita só: a caixa do resumo cria a ação já feita, e a lista desmarca o item junto", async () => {
    const { ids: [acao] } = await reuniaoComResumo([{ section: "action", text: "Reservar a sala" }]);
    await resumo.marcarAcaoFeita(DONA, acao, true);
    const criada = await acaoDoItem(acao);
    expect(criada).toMatchObject({ feita: true });
    expect(Number(criada.feitaEm)).toBeGreaterThan(0);
    expect(await itemPorId(acao)).toMatchObject({ status: "confirmed", done: true });

    await acoes.marcarProximaAcaoFeita(DONA, criada.id, false);
    expect(await acaoDoItem(acao)).toMatchObject({ feita: false, feitaEm: null });
    expect(await itemPorId(acao)).toMatchObject({ status: "confirmed", done: false, doneAt: null });
  });

  it("a leitura completa as ações que faltam (itens confirmados antes da H5a) uma vez só, e lista as abertas por prazo", async () => {
    await reuniaoComResumo([
      { section: "action", text: "Antiga 1", status: "confirmed" },
      { section: "task", subject: "Antiga 2", text: "detalhe", status: "confirmed" },
      { section: "action", text: "Pendente", status: "pending" },
    ]);
    await acoes.criarProximaAcao(DONA, { texto: "Com prazo", prazo: "2026-12-01" });
    await acoes.criarProximaAcao(DONA, { texto: "Prazo antes", prazo: "2026-11-20" });
    const primeira = await acoes.listarProximasAcoes(DONA, "abertas");
    await acoes.proximasAcoesDoPainel(DONA);
    expect(await acoesDa(DONA)).toHaveLength(4);
    // As com prazo primeiro, pela data; as sem prazo no fim. A data volta como texto AAAA-MM-DD.
    expect(primeira.acoes.slice(0, 2).map(a => [a.texto, a.prazo])).toEqual([["Prazo antes", "2026-11-20"], ["Com prazo", "2026-12-01"]]);
    // As duas do backfill nascem no mesmo INSERT, com a mesma data: a ordem entre elas é a do id.
    expect(primeira.acoes.slice(2).map(a => [a.texto, a.prazo]).sort()).toEqual([["Antiga 1", null], ["Antiga 2", null]]);
    expect(primeira.abertas).toBe(4);
    const painel = await acoes.proximasAcoesDoPainel(DONA);
    expect(painel.acoes).toHaveLength(4);
    expect(painel.abertas).toBe(4);
  });

  it("excluir a reunião solta a ação: o nome da voz vira texto, e reunião, item e trecho saem; a ação continua na lista", async () => {
    const { meetingId, ids: [acao] } = await reuniaoComResumo(
      [{ section: "action", text: "{F2} envia a proposta para {F3}", assignee: "{F2}" }],
      { speakerNames: { F2: "Carla" } },
    );
    await resumo.decidirItemDoResumo(DONA, acao, "confirmed");
    // Enquanto presa ao item, a tela recebe os nomes e o link do item.
    const antes = (await acoes.listarProximasAcoes(DONA, "abertas")).acoes[0];
    expect(antes).toMatchObject({ vozes: { F2: "Carla" }, reuniao: { id: meetingId, itemId: acao } });

    expect(await deletePrivateMeeting(DONA, meetingId)).toBe(true);
    const [solta] = await acoesDa(DONA);
    expect(solta).toMatchObject({
      texto: "Carla envia a proposta para {F3}", responsavel: "Carla", meetingId: null, itemId: null, trecho: null, origem: "reuniao",
    });
    const depois = (await acoes.listarProximasAcoes(DONA, "abertas")).acoes[0];
    expect(depois).toMatchObject({ reuniao: null, vozes: {}, trecho: null });
  });

  it("reprocessar solta a ação presa ao item com os nomes de antes; ela fica com a reunião e o trecho", async () => {
    const banco = await db();
    const { meetingId, ids: [acao] } = await reuniaoComResumo(
      [{ section: "action", text: "{F1} liga para o importador", assignee: "{F1}" }],
      { speakerNames: { F1: "Ana" } },
    );
    await resumo.decidirItemDoResumo(DONA, acao, "confirmed");
    const ficha = AGORA() + 1_000;
    await banco.update(meetings).set({ status: "processing", updatedAt: ficha }).where(eq(meetings.id, meetingId));
    await gravarResultadoDaReuniao(banco, {
      meetingId, ownerId: DONA, ficha, limparAntes: true, durationSeconds: 12,
      transcription: { text: "Fala nova.", segments: [], language: "pt-BR" }, extraction: { entities: [], contacts: [] } as never,
    });
    const [solta] = await acoesDa(DONA);
    expect(solta).toMatchObject({ texto: "Ana liga para o importador", responsavel: "Ana", itemId: null, meetingId, trecho: "trecho de {F1} liga para o importador" });
    // O reprocesso zera os nomes; a ação solta não os relê.
    const [reuniao] = await banco.select({ speakerNames: meetings.speakerNames }).from(meetings).where(eq(meetings.id, meetingId));
    expect(reuniao.speakerNames).toBeNull();
    expect((await acoes.listarProximasAcoes(DONA, "abertas")).acoes[0]).toMatchObject({ reuniao: { id: meetingId, itemId: null }, vozes: {} });
  });

  it("ligar contato confere a posse; excluir o contato anula o ponteiro e a ação fica", async () => {
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Mandar o catálogo", responsavel: "Carla" });
    const daOutra = await createPrivateContact(OUTRA, { fullName: "Carla da Outra" });
    await expect(acoes.ligarContato(DONA, id, daOutra)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const carla = await createPrivateContact(DONA, { fullName: "Carla Mendes" });
    // O responsável aponta a Carla da rede: a sugestão vem sem IA.
    expect((await acoes.listarProximasAcoes(DONA, "abertas")).acoes[0].contatoSugerido).toEqual({ id: carla, nome: "Carla Mendes" });
    await acoes.ligarContato(DONA, id, carla);
    expect((await acoes.listarProximasAcoes(DONA, "abertas")).acoes[0]).toMatchObject({ contato: { id: carla, nome: "Carla Mendes" }, contatoSugerido: null });

    expect(await deletePrivateContact(DONA, carla)).toBe(true);
    const [ficou] = await acoesDa(DONA);
    expect(ficou).toMatchObject({ id, contactId: null, texto: "Mandar o catálogo" });
  });

  it("apagar a ação da reunião devolve o item a 'para conferir', e a leitura não a recria", async () => {
    const { ids: [acao] } = await reuniaoComResumo([{ section: "action", text: "Enviar a ata" }]);
    await resumo.decidirItemDoResumo(DONA, acao, "confirmed");
    const criada = await acaoDoItem(acao);
    await acoes.apagarProximaAcao(DONA, criada.id);
    expect(await itemPorId(acao)).toMatchObject({ status: "pending", decidedAt: null });
    await acoes.listarProximasAcoes(DONA, "todas");
    expect(await acoesDa(DONA)).toEqual([]);
  });

  it("só a dona: a outra conta não lê, não marca, não edita, não liga e não apaga", async () => {
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Da dona" });
    expect((await acoes.listarProximasAcoes(OUTRA, "todas")).acoes).toEqual([]);
    expect((await acoes.proximasAcoesDoPainel(OUTRA)).abertas).toBe(0);
    await expect(acoes.marcarProximaAcaoFeita(OUTRA, id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(acoes.editarProximaAcao(OUTRA, id, { texto: "Mudou" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(acoes.ligarContato(OUTRA, id, null)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(acoes.apagarProximaAcao(OUTRA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await acoesDa(DONA)).toMatchObject([{ id, texto: "Da dona", feita: false }]);
  });

  it("decidir na reunião excluída é 'não encontrada' e não cria ação", async () => {
    const { meetingId, ids: [acao] } = await reuniaoComResumo([{ section: "action", text: "Tarde demais" }]);
    await (await db()).update(meetings).set({ status: "deleted" }).where(eq(meetings.id, meetingId));
    await expect(resumo.decidirItemDoResumo(DONA, acao, "confirmed")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await acoesDa(DONA)).toEqual([]);
  });

  it("editar muda só o que veio, e o prazo vazio apaga a data", async () => {
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Antes", detalhe: "Fica", prazo: "2026-11-30" });
    await acoes.editarProximaAcao(DONA, id, { texto: "Depois", prazo: null });
    expect((await acoesDa(DONA))[0]).toMatchObject({ texto: "Depois", detalhe: "Fica", prazo: null });
  });

  // A exclusão marca a reunião 'deleted' e logo solta as ações dela. A decisão
  // no resumo que já tinha travado a reunião (SELECT ... FOR UPDATE) faz a
  // exclusão esperar o COMMIT dela, e a ação que acabou de nascer sai solta
  // junto com as outras. Sem a trava, a exclusão soltaria as ações antes de a
  // nova existir, e ela ficaria com a reunião, o item e o trecho apagados.
  it.each([
    ["decidir (confirmar o item)", (itemId: string) => resumo.decidirItemDoResumo(DONA, itemId, "confirmed")],
    ["marcar a ação feita", (itemId: string) => resumo.marcarAcaoFeita(DONA, itemId, true)],
    ["confirmar todos", (_itemId: string, meetingId: string) => resumo.confirmarItensDoResumo(DONA, meetingId)],
  ])("%s com a exclusão no meio: a exclusão espera a decisão e solta a ação nova, sem reunião, item nem trecho", async (_nome, decidir) => {
    const banco = await db();
    const { meetingId, ids: [itemId] } = await reuniaoComResumo(
      [{ section: "action", text: "{F2} envia a proposta", assignee: "{F2}" }],
      { speakerNames: { F2: "Carla" } },
    );
    let decisao: Promise<unknown> | undefined;
    let exclusao: Promise<boolean> | undefined;
    await banco.transaction(async tx => {
      // A alavanca: o item preso por esta conexão. A decisão trava a reunião e o
      // resumo e para no UPDATE do item, ainda com a reunião presa.
      await tx.select({ id: meetingSummaryItems.id }).from(meetingSummaryItems).where(eq(meetingSummaryItems.id, itemId)).for("update");
      decisao = decidir(itemId, meetingId);
      decisao.catch(() => {});
      await esperarParadoNaTrava("%update `meeting_summary_items` set%", "a decisão não parou no item preso por este teste");
      exclusao = deletePrivateMeeting(DONA, meetingId);
      exclusao.catch(() => {});
      // Sem o FOR UPDATE da reunião na decisão, a exclusão marcaria 'deleted' na
      // hora, sem esperar ninguém, e o prazo acabaria aqui.
      await esperarParadoNaTrava("%update `meetings` set `status`%", "a exclusão não esperou a decisão: a leitura da reunião perdeu o FOR UPDATE?");
    });
    await decisao;
    expect(await exclusao).toBe(true);
    expect(await acoesDa(DONA)).toMatchObject([{
      texto: "Carla envia a proposta", responsavel: "Carla", meetingId: null, itemId: null, trecho: null, origem: "reuniao",
    }]);
    expect(await itemPorId(itemId)).toBeUndefined();
  }, 30_000);

  it("a decisão espera a exclusão que marcou a reunião (a trava da linha) e, depois dela, é 'não encontrada' e não cria ação", async () => {
    const banco = await db();
    const { meetingId, ids: [itemId] } = await reuniaoComResumo([{ section: "action", text: "Tarde demais" }]);
    let decisao: Promise<unknown> | undefined;
    await banco.transaction(async tx => {
      // A exclusão parada logo depois de marcar 'deleted', sem confirmar.
      await tx.update(meetings).set({ status: "deleted" }).where(eq(meetings.id, meetingId));
      decisao = resumo.decidirItemDoResumo(DONA, itemId, "confirmed");
      decisao.catch(() => {});
      // Sem o FOR UPDATE, a decisão leria a reunião ainda pronta (a versão
      // confirmada), criaria a ação sem esperar, e o prazo acabaria aqui.
      await esperarParadoNaTrava("%from `meetings`%for update%", "a decisão não parou na trava da reunião: a leitura dela perdeu o FOR UPDATE?");
    });
    await expect(decisao).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await acoesDa(DONA)).toEqual([]);
    expect(await itemPorId(itemId)).toMatchObject({ status: "pending" });
  }, 30_000);
});
