import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * As próximas ações no perfil do contato (H5b) contra um banco real DE TESTE
 * (sem DATABASE_URL_TESTES, se pula). Prova o que o dublê não prova: a leitura
 * por (dona, contato) no SQL de verdade, com os joins da lista; a ação de outro
 * contato, a sem contato e a de outra conta não entram; a ação presa ao item da
 * reunião leva o link do item e os nomes das vozes, e, com a reunião excluída,
 * fica no perfil solta, com os nomes no texto; e os eventos da linha do tempo
 * (a anotada e a feita). O perfil só lê: não cria ação nenhuma.
 */

const { getDb, createPrivateContact } = await import("./db");
const {
  consumoDeMinutos, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, privateContacts, proximasAcoes, users,
} = await import("../drizzle/schema");
const resumo = await import("./resumo-guardado");
const acoes = await import("./proximas-acoes");
const { perfilDoContato } = await import("./network-perfil-do-contato");
const { deletePrivateMeeting } = await import("./meeting-service");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-acoes-perfil-${crypto.randomUUID()}`;
const OUTRA = `teste-acoes-perfil-outra-${crypto.randomUUID()}`;
const AGORA = () => Date.now();
// O perfil só usa o id da conta para as conexões, que ficam de fora (sem o termo).
const SOLICITANTE = { id: 0, openId: DONA };
const SEM_TERMO = { termoSmartMatch: false };

async function db() { return (await getDb())!; }

/**
 * Uma reunião pronta da dona, com o resumo pronto, uma ação do resumo e os
 * nomes das vozes dados; `contactId` grava a reunião já apontando o contato.
 */
async function reuniaoComAcao(texto: string, nomes: Record<string, string>, contactId: number | null = null) {
  const banco = await db();
  const meetingId = crypto.randomUUID();
  const summaryId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id: meetingId, ownerId: DONA, title: "Café na feira", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    speakerNames: nomes, contactId, createdAt: AGORA(), updatedAt: AGORA(),
  });
  await banco.insert(meetingSummaries).values({ id: summaryId, meetingId, ownerId: DONA, status: "ready", createdAt: AGORA(), updatedAt: AGORA() });
  await banco.insert(meetingSummaryItems).values({
    id: itemId, summaryId, meetingId, ownerId: DONA, section: "action", position: 0, subject: null, text: texto,
    assignee: "{F2}", due: null, excerpt: `trecho de ${texto}`, startSeconds: 10, confidence: "0.900", status: "pending",
    createdAt: AGORA(), updatedAt: AGORA(),
  });
  // A dona confirma no resumo: a ação nasce, ainda sem contato.
  await resumo.decidirItemDoResumo(DONA, itemId, "confirmed");
  const [acao] = await banco.select({ id: proximasAcoes.id }).from(proximasAcoes)
    .where(and(eq(proximasAcoes.ownerId, DONA), eq(proximasAcoes.itemId, itemId)));
  return { meetingId, itemId, acaoId: acao.id };
}

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

describe.skipIf(!temBanco)("Próximas ações no perfil do contato (integração)", () => {
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

  it("o perfil lê só as ações da dona ligadas a este contato, as abertas antes das feitas, e as põe na linha do tempo", async () => {
    const maria = await createPrivateContact(DONA, { fullName: "Maria Silva" });
    const bia = await createPrivateContact(DONA, { fullName: "Bia Lima" });
    const daReuniao = await reuniaoComAcao("{F2} envia a proposta", { F2: "Carla" });
    await acoes.ligarContato(DONA, daReuniao.acaoId, maria);
    const { id: catalogo } = await acoes.criarProximaAcao(DONA, { texto: "Mandar o catálogo", contactId: maria });
    await acoes.marcarProximaAcaoFeita(DONA, catalogo, true);
    await acoes.criarProximaAcao(DONA, { texto: "Ligar para a Bia", contactId: bia });
    await acoes.criarProximaAcao(DONA, { texto: "Sem contato" });
    // Um ponteiro de outra conta para o mesmo id de contato (ligarContato o
    // recusaria; aqui entra direto no banco): não é da dona e não aparece.
    await (await db()).insert(proximasAcoes).values({
      id: crypto.randomUUID(), ownerId: OUTRA, origem: "manual", texto: "Da outra conta", contactId: maria, feita: false,
      createdAt: AGORA(), updatedAt: AGORA(),
    });
    const contarAcoes = async () => (await (await db()).select({ id: proximasAcoes.id }).from(proximasAcoes)
      .where(inArray(proximasAcoes.ownerId, [DONA, OUTRA]))).length;
    const antes = await contarAcoes();

    const perfil = (await perfilDoContato(SOLICITANTE, maria, SEM_TERMO))!;
    expect(perfil.proximasAcoes.lista.map(a => [a.texto, a.feita])).toEqual([["{F2} envia a proposta", false], ["Mandar o catálogo", true]]);
    expect(perfil.proximasAcoes.lista[0]).toMatchObject({
      origem: "reuniao", reuniao: { id: daReuniao.meetingId, titulo: "Café na feira", itemId: daReuniao.itemId },
      vozes: { F2: "Carla" }, contato: { id: maria, nome: "Maria Silva" },
    });
    expect(perfil.proximasAcoes.lista[1]).toMatchObject({ origem: "manual", reuniao: null, contato: { id: maria, nome: "Maria Silva" } });

    const eventos = perfil.linhaDoTempo.filter(e => e.tipo === "proxima_acao" || e.tipo === "proxima_acao_feita");
    expect(eventos.map(e => [e.tipo, "acaoId" in e ? e.acaoId : null]).sort()).toEqual([
      ["proxima_acao", catalogo], ["proxima_acao", daReuniao.acaoId], ["proxima_acao_feita", catalogo],
    ].sort());
    // O texto vai com o rótulo, e o mapa dos nomes junto: quem troca é a tela.
    expect(eventos.find(e => "acaoId" in e && e.acaoId === daReuniao.acaoId)).toMatchObject({ texto: "{F2} envia a proposta", vozes: { F2: "Carla" } });

    // A Bia tem a dela; a ação sem contato não está em perfil nenhum.
    expect((await perfilDoContato(SOLICITANTE, bia, SEM_TERMO))!.proximasAcoes.lista.map(a => a.texto)).toEqual(["Ligar para a Bia"]);
    // O perfil só lê: nenhuma ação a mais.
    expect(await contarAcoes()).toBe(antes);
    // O contato da dona não abre para a outra conta.
    expect(await perfilDoContato({ id: 0, openId: OUTRA }, maria, SEM_TERMO)).toBeNull();
  });

  it("tirar o vínculo tira a ação do perfil; a ação fica na lista da dona", async () => {
    const maria = await createPrivateContact(DONA, { fullName: "Maria Silva" });
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Mandar o catálogo", contactId: maria });
    expect((await perfilDoContato(SOLICITANTE, maria, SEM_TERMO))!.proximasAcoes.lista).toHaveLength(1);
    await acoes.ligarContato(DONA, id, null);
    const perfil = (await perfilDoContato(SOLICITANTE, maria, SEM_TERMO))!;
    expect(perfil.proximasAcoes.lista).toEqual([]);
    expect(perfil.linhaDoTempo.some(e => e.tipo === "proxima_acao")).toBe(false);
    expect((await acoes.listarProximasAcoes(DONA, "todas")).acoes.map(a => a.id)).toEqual([id]);
  });

  it("excluir a reunião deixa a ação no perfil, solta: os nomes no texto, sem a reunião nem o item", async () => {
    const maria = await createPrivateContact(DONA, { fullName: "Maria Silva" });
    const daReuniao = await reuniaoComAcao("{F2} envia a proposta para {F3}", { F2: "Carla" }, maria);
    await acoes.ligarContato(DONA, daReuniao.acaoId, maria);
    const antes = (await perfilDoContato(SOLICITANTE, maria, SEM_TERMO))!;
    expect(antes.reunioes.map(r => r.id)).toEqual([daReuniao.meetingId]);
    expect(antes.proximasAcoes.lista[0]).toMatchObject({ reuniao: { id: daReuniao.meetingId, itemId: daReuniao.itemId }, vozes: { F2: "Carla" } });

    expect(await deletePrivateMeeting(DONA, daReuniao.meetingId)).toBe(true);
    const perfil = (await perfilDoContato(SOLICITANTE, maria, SEM_TERMO))!;
    expect(perfil.proximasAcoes.lista).toMatchObject([{
      id: daReuniao.acaoId, texto: "Carla envia a proposta para {F3}", reuniao: null, vozes: {}, trecho: null,
      contato: { id: maria, nome: "Maria Silva" },
    }]);
    // A reunião excluída sai das vinculadas, e o evento da ação fica, já com o nome no texto.
    expect(perfil.reunioes).toEqual([]);
    expect(perfil.linhaDoTempo).toContainEqual(expect.objectContaining({
      tipo: "proxima_acao", acaoId: daReuniao.acaoId, texto: "Carla envia a proposta para {F3}", vozes: {},
    }));
  });
});
