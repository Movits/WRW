import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A dona edita e acrescenta itens do resumo guardado (H4f) contra um banco real
 * DE TESTE (sem DATABASE_URL_TESTES, se pula). Prova o que só o banco prova:
 * as colunas novas (origin e edited_at, e as do estado de antes do Ignorar)
 * com o padrão nas linhas da IA, a
 * transação que trava a reunião e o resumo (duas inclusões ao mesmo tempo não
 * repetem a posição), o teto, a dona no WHERE, o que o link aberto vê e que
 * excluir a reunião leva junto o que a dona escreveu. A lógica fina está em
 * server/resumo-guardado-edicao.test.ts, com o banco dublado.
 */
const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, users } = await import("../drizzle/schema");
const servico = await import("./resumo-guardado");
const { deletePrivateMeeting } = await import("./meeting-service");
const { ITENS_DO_RESUMO_MAX } = await import("@shared/item-do-resumo");
const { MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO } = await import("@shared/const");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-h4f-${crypto.randomUUID()}`;
const OUTRA = `teste-h4f-outra-${crypto.randomUUID()}`;
const AGORA = () => Date.now();

async function db() { return (await getDb())!; }

// Os itens como a fila do resumo os grava: sem origem nem edição, que vêm do padrão das colunas.
const DA_IA = [
  { section: "action", subject: null, text: "{F2} avisa a transportadora", assignee: "{F2}", due: "até sexta-feira", excerpt: "eu aviso a transportadora até sexta-feira", startSeconds: 5 },
  { section: "decision", subject: null, text: "Não renovar com a transportadora", assignee: null, due: null, excerpt: "decidimos não renovar o contrato", startSeconds: 9 },
] as const;

async function reuniaoComResumo({ statusDoResumo = "ready", shareToken = null as string | null } = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const resumoId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id, ownerId: DONA, title: "Reunião do H4f", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), shareToken,
  });
  await banco.insert(meetingSummaries).values({ id: resumoId, meetingId: id, ownerId: DONA, status: statusDoResumo as "ready", version: 1, createdAt: AGORA(), updatedAt: AGORA() });
  await banco.insert(meetingSummaryItems).values(DA_IA.map((item, position) => ({
    ...item, id: crypto.randomUUID(), summaryId: resumoId, meetingId: id, ownerId: DONA, position,
    confidence: "0.900", status: "pending" as const, done: false, createdAt: AGORA(), updatedAt: AGORA(),
  })));
  return { id, resumoId };
}

const itensDe = async (meetingId: string) => (await db()).select().from(meetingSummaryItems)
  .where(eq(meetingSummaryItems.meetingId, meetingId)).orderBy(asc(meetingSummaryItems.position));
const versaoDe = async (meetingId: string) => (await (await db()).select({ version: meetingSummaries.version }).from(meetingSummaries)
  .where(eq(meetingSummaries.meetingId, meetingId)))[0]?.version;
const NOVO = { texto: "Ligar para o importador", assunto: null, responsavel: null, prazo: "amanhã" };

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Editar e acrescentar itens do resumo no banco (H4f, integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => { await limpar(); });

  it("a linha que a fila grava nasce com a origem 'ai' e sem edição, pelo padrão das colunas", async () => {
    const { id } = await reuniaoComResumo();
    expect((await itensDe(id)).map(item => [item.origin, item.editedAt])).toEqual([["ai", null], ["ai", null]]);
  });

  it("editar confirma e marca a edição, sem subir a versão; salvar sem mudar nada só confirma", async () => {
    const { id } = await reuniaoComResumo();
    const [acao, decisao] = await itensDe(id);
    await servico.editarItemDoResumo(DONA, acao.id, { texto: "{F2} avisa a transportadora hoje", assunto: null, responsavel: "{F2}", prazo: "hoje" });
    await servico.editarItemDoResumo(DONA, decisao.id, { texto: decisao.text, assunto: null, responsavel: null, prazo: null });
    const [a, d] = await itensDe(id);
    expect(a).toMatchObject({ text: "{F2} avisa a transportadora hoje", due: "hoje", status: "confirmed", origin: "ai", excerpt: "eu aviso a transportadora até sexta-feira", startSeconds: 5 });
    expect(Number(a.editedAt)).toBeGreaterThan(0);
    expect(Number(a.decidedAt)).toBeGreaterThan(0);
    expect(d).toMatchObject({ status: "confirmed", editedAt: null });
    // A versão marca a geração da fila: editar não a sobe, e a tradução (H11) não se perde.
    expect(await versaoDe(id)).toBe(1);
    // A leitura da dona traz a origem e a edição, para a tela marcar.
    const lido = await servico.resumoGuardadoDaDona(DONA, id);
    expect(lido.itens.map(item => [item.origin, item.editedAt !== null])).toEqual([["ai", true], ["ai", false]]);
  });

  it("acrescentar entra no fim, confirmado, com a origem da dona, sem trecho e sem tempo; a versão não sobe", async () => {
    const { id, resumoId } = await reuniaoComResumo();
    const novoId = await servico.acrescentarItemDoResumo(DONA, id, "action", NOVO);
    const itens = await itensDe(id);
    expect(itens).toHaveLength(3);
    expect(itens[2]).toMatchObject({
      id: novoId, summaryId: resumoId, ownerId: DONA, section: "action", position: 2, text: "Ligar para o importador", due: "amanhã",
      excerpt: "", startSeconds: null, origin: "owner", status: "confirmed", done: false, editedAt: null,
    });
    expect(Number(itens[2].confidence)).toBe(0);
    expect(await versaoDe(id)).toBe(1);
  });

  it("duas inclusões ao mesmo tempo: a trava do resumo as põe em fila, e as posições não se repetem", async () => {
    const { id } = await reuniaoComResumo();
    await Promise.all([
      servico.acrescentarItemDoResumo(DONA, id, "action", { ...NOVO, texto: "Primeiro" }),
      servico.acrescentarItemDoResumo(DONA, id, "action", { ...NOVO, texto: "Segundo" }),
    ]);
    expect((await itensDe(id)).map(item => item.position)).toEqual([0, 1, 2, 3]);
    expect(await versaoDe(id)).toBe(1);
  });

  it("o teto conta todos os itens do resumo, ignorados inclusive", async () => {
    const { id, resumoId } = await reuniaoComResumo();
    const faltam = ITENS_DO_RESUMO_MAX - DA_IA.length - 1;
    await (await db()).insert(meetingSummaryItems).values(Array.from({ length: faltam }, (_, i) => ({
      id: crypto.randomUUID(), summaryId: resumoId, meetingId: id, ownerId: DONA, section: "question" as const, position: DA_IA.length + i,
      text: `Questão ${i}`, excerpt: "trecho", status: "ignored" as const, createdAt: AGORA(), updatedAt: AGORA(),
    })));
    await servico.acrescentarItemDoResumo(DONA, id, "action", NOVO);
    await expect(servico.acrescentarItemDoResumo(DONA, id, "action", NOVO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_CHEIO });
    expect(await itensDe(id)).toHaveLength(ITENS_DO_RESUMO_MAX);
  });

  it("só a dona: outra conta recebe NOT_FOUND para editar e acrescentar, e nada muda", async () => {
    const { id } = await reuniaoComResumo();
    const [acao] = await itensDe(id);
    await expect(servico.editarItemDoResumo(OUTRA, acao.id, NOVO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.acrescentarItemDoResumo(OUTRA, id, "action", NOVO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await itensDe(id)).map(item => [item.text, item.status])).toEqual(DA_IA.map(item => [item.text, "pending"]));
    expect(await versaoDe(id)).toBe(1);
  });

  it("com o resumo na fila (sendo refeito), editar e acrescentar são conflito", async () => {
    const { id } = await reuniaoComResumo({ statusDoResumo: "pending" });
    const [acao] = await itensDe(id);
    await expect(servico.editarItemDoResumo(DONA, acao.id, NOVO)).rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    await expect(servico.acrescentarItemDoResumo(DONA, id, "action", NOVO)).rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    expect(await itensDe(id)).toHaveLength(DA_IA.length);
  });

  it("o item da dona ignorado volta confirmado no Desfazer; o da IA sem edição volta a pendente", async () => {
    const { id } = await reuniaoComResumo();
    const novoId = await servico.acrescentarItemDoResumo(DONA, id, "action", NOVO);
    const [acao] = await itensDe(id);
    for (const item of [novoId, acao.id]) await servico.decidirItemDoResumo(DONA, item, "ignored");
    for (const item of [novoId, acao.id]) await servico.decidirItemDoResumo(DONA, item, "pending");
    const itens = await itensDe(id);
    expect(itens.find(item => item.id === novoId)?.status).toBe("confirmed");
    expect(itens.find(item => item.id === acao.id)?.status).toBe("pending");
  });

  it("a ação confirmada e feita: o Ignorar guarda o estado nas colunas, e o Desfazer a devolve confirmada e feita", async () => {
    const { id } = await reuniaoComResumo();
    const [acao] = await itensDe(id);
    expect(acao).toMatchObject({ statusBeforeIgnore: null, doneAtBeforeIgnore: null });
    await servico.marcarAcaoFeita(DONA, acao.id, true);
    const [feita] = await itensDe(id);
    await servico.decidirItemDoResumo(DONA, acao.id, "ignored");
    const [ignorada] = await itensDe(id);
    expect(ignorada).toMatchObject({ status: "ignored", done: false, doneAt: null, statusBeforeIgnore: "confirmed" });
    expect(Number(ignorada.doneAtBeforeIgnore)).toBe(Number(feita.doneAt));
    await servico.decidirItemDoResumo(DONA, acao.id, "pending");
    const [desfeita] = await itensDe(id);
    expect(desfeita).toMatchObject({ status: "confirmed", done: true, statusBeforeIgnore: null, doneAtBeforeIgnore: null });
    expect(Number(desfeita.doneAt)).toBe(Number(feita.doneAt));
  });

  it("o link aberto vê o que a dona escreveu como confirmado, sem ids, sem a origem e sem a hora da edição: só a marca de que foi ela", async () => {
    const token = crypto.randomBytes(24).toString("base64url");
    const { id } = await reuniaoComResumo({ shareToken: token });
    const [acao] = await itensDe(id);
    await servico.editarItemDoResumo(DONA, acao.id, { texto: "{F2} avisa a transportadora hoje", assunto: null, responsavel: "{F2}", prazo: "hoje" });
    await servico.acrescentarItemDoResumo(DONA, id, "action", NOVO);
    const visto = await servico.resumoGuardadoPeloLink(token);
    expect(visto.itens).toEqual([
      { section: "action", subject: null, text: "{F2} avisa a transportadora hoje", assignee: "{F2}", due: "hoje", excerpt: "eu aviso a transportadora até sexta-feira", startSeconds: 5, status: "confirmed", escritoPelaDona: true, trechoForaDaTranscricao: false },
      { section: "decision", subject: null, text: "Não renovar com a transportadora", assignee: null, due: null, excerpt: "decidimos não renovar o contrato", startSeconds: 9, status: "pending", escritoPelaDona: false, trechoForaDaTranscricao: false },
      { section: "action", subject: null, text: "Ligar para o importador", assignee: null, due: "amanhã", excerpt: "", startSeconds: null, status: "confirmed", escritoPelaDona: true, trechoForaDaTranscricao: false },
    ]);
  });

  it("excluir a reunião leva junto o que a dona escreveu", async () => {
    const { id } = await reuniaoComResumo();
    await servico.acrescentarItemDoResumo(DONA, id, "task", { texto: "Revisar o contrato", assunto: "Contrato", responsavel: "{F1}", prazo: null });
    expect(await itensDe(id)).toHaveLength(3);
    await deletePrivateMeeting(DONA, id);
    expect(await itensDe(id)).toEqual([]);
  });
});
