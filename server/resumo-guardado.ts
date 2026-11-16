import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, max, ne, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { exigirReuniaoDoLink } from "./link-aberto-da-reuniao";
import { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { ITENS_DO_RESUMO_MAX, secaoTemAssunto, secaoTemResponsavel, type SecaoDoItem } from "@shared/item-do-resumo";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { MENSAGEM_SEM_TRANSCRICAO } from "./reuniao-com-ia";

/**
 * O resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), como a tela o lê e o decide. Quem
 * gera é a fila do resumo (server/fila-do-resumo.ts); aqui só se pede, lê e
 * decide. Toda consulta leva a dona no WHERE: reunião de outra dona é "não
 * encontrada". Banco fora do ar sobe como erro, nunca vira "sem resumo".
 */

export type EstadoDoResumo = "sem_resumo" | "pendente" | "gerando" | "pronto" | "falhou";
type Banco = Awaited<ReturnType<typeof exigirDb>>;

// As frases das recusas moram em shared/const.ts: a tela as reconhece pelo
// texto exato para traduzi-las.
export { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA };

// "Gerando" só com uma reserva viva: na espera depois de uma falha passageira a
// linha também tem prazo no futuro, mas ninguém está gerando.
function estadoDe(linha: { status: string; lockedUntil: number | null; lockToken: string | null } | undefined, agora: number): EstadoDoResumo {
  if (!linha) return "sem_resumo";
  if (linha.status === "ready") return "pronto";
  if (linha.status === "failed") return "falhou";
  return linha.lockToken && linha.lockedUntil !== null && Number(linha.lockedUntil) > agora ? "gerando" : "pendente";
}

const COLUNAS_DO_RESUMO = {
  id: meetingSummaries.id,
  status: meetingSummaries.status,
  lockedUntil: meetingSummaries.lockedUntil,
  lockToken: meetingSummaries.lockToken,
  emoji: meetingSummaries.emoji,
  language: meetingSummaries.language,
  lastError: meetingSummaries.lastError,
};

/** A reunião da dona, não apagada, ou NOT_FOUND. */
async function reuniaoDaDona(db: Banco, ownerId: string, meetingId: string) {
  const [reuniao] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"))).limit(1);
  if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  return reuniao;
}

async function linhaDoResumo(db: Banco, ownerId: string, meetingId: string) {
  const [linha] = await db.select(COLUNAS_DO_RESUMO).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1);
  return linha;
}

/**
 * O resumo da reunião para a dona: o estado e, pronto, todos os itens, na
 * ordem do formato (os ignorados também, que a tela recolhe e deixa desfazer).
 */
export async function resumoGuardadoDaDona(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  await reuniaoDaDona(db, ownerId, meetingId);
  const linha = await linhaDoResumo(db, ownerId, meetingId);
  const estado = estadoDe(linha, Date.now());
  const itens = linha && estado === "pronto"
    ? await db.select({
      id: meetingSummaryItems.id,
      section: meetingSummaryItems.section,
      position: meetingSummaryItems.position,
      subject: meetingSummaryItems.subject,
      text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee,
      due: meetingSummaryItems.due,
      excerpt: meetingSummaryItems.excerpt,
      startSeconds: meetingSummaryItems.startSeconds,
      status: meetingSummaryItems.status,
      done: meetingSummaryItems.done,
      // Quem escreveu e se a dona editou (H4f): a tela marca o que é dela.
      origin: meetingSummaryItems.origin,
      editedAt: meetingSummaryItems.editedAt,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, ownerId)))
      .orderBy(asc(meetingSummaryItems.position))
    : [];
  return { estado, emoji: linha?.emoji ?? null, idioma: linha?.language ?? null, erro: estado === "falhou" ? linha?.lastError ?? null : null, itens };
}

/**
 * Pede o resumo de uma reunião pronta: cria o trabalho para a fila, ou reabre
 * o que falhou. Resumo pendente ou pronto não muda. `antesDeCriar` roda só
 * quando há trabalho novo (é o teto de pedidos à IA, que pode recusar
 * lançando, e devolve como soltar a vaga): pedir de novo o que já está na fila
 * não gasta vaga, e o pedido que perdeu a corrida para outro igual a devolve.
 */
type AntesDeCriar = () => (() => void) | void;
async function pedirResumoDaReuniao(db: Banco, ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar) {
  const [transcricao] = await db.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  if (!transcricao) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  const linha = await linhaDoResumo(db, ownerId, meetingId);
  const agora = Date.now();
  if (!linha) {
    const soltarVaga = antesDeCriar();
    try {
      await db.insert(meetingSummaries).values({ id: crypto.randomUUID(), meetingId, ownerId, status: "pending", createdAt: agora, updatedAt: agora });
    } catch (erro) {
      // Outro pedido criou o trabalho entre a leitura e aqui (índice único por
      // reunião): o trabalho existe, que é o que se queria, e a vaga volta.
      if (!ehChaveRepetida(erro)) throw erro;
      soltarVaga?.();
    }
  } else if (linha.status === "failed") {
    const soltarVaga = antesDeCriar();
    const r = await db.update(meetingSummaries).set({ status: "pending", attempts: 0, lastError: null, lockedUntil: null, lockToken: null, updatedAt: agora })
      .where(and(eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId), eq(meetingSummaries.status, "failed")));
    // Outro pedido reabriu antes: a vaga volta.
    if (!linhasAfetadas(r)) soltarVaga?.();
  }
}

/** O MySQL recusou por índice único (ER_DUP_ENTRY), no erro ou na causa dele (o drizzle embrulha o do driver). */
function ehChaveRepetida(erro: unknown): boolean {
  for (let atual: unknown = erro, i = 0; atual && i < 5; atual = (atual as { cause?: unknown }).cause, i++) {
    if ((atual as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

/** A dona pede (ou pede de novo, depois de uma falha) o resumo de uma reunião pronta. */
export async function pedirResumoDaDona(ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar) {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  if (reuniao.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  await pedirResumoDaReuniao(db, ownerId, meetingId, antesDeCriar);
  return resumoGuardadoDaDona(ownerId, meetingId);
}

/**
 * O item da dona e o estado do resumo dele. Só se decide sobre resumo pronto
 * de reunião pronta: enquanto o resumo é refeito, os itens vão ser trocados.
 */
async function itemParaDecidir(db: Banco, ownerId: string, itemId: string) {
  const [item] = await db.select({
    id: meetingSummaryItems.id,
    section: meetingSummaryItems.section,
    status: meetingSummaryItems.status,
    origin: meetingSummaryItems.origin,
    editedAt: meetingSummaryItems.editedAt,
    statusDoResumo: meetingSummaries.status,
    statusDaReuniao: meetings.status,
  }).from(meetingSummaryItems)
    .innerJoin(meetingSummaries, and(eq(meetingSummaries.id, meetingSummaryItems.summaryId), eq(meetingSummaries.ownerId, meetingSummaryItems.ownerId)))
    .innerJoin(meetings, and(eq(meetings.id, meetingSummaryItems.meetingId), eq(meetings.ownerId, meetingSummaryItems.ownerId)))
    .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
  if (!item || item.statusDaReuniao === "deleted") throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  if (item.statusDoResumo !== "ready" || item.statusDaReuniao !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  return item;
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * O item que a dona escreveu, acrescentado ou editado (H4f), não volta a
 * "para conferir": não há o que conferir na palavra dela, e o link aberto
 * mostraria o aviso de que a IA o gerou. Desfazer o ignorar o devolve
 * confirmado.
 */
function escritoPelaDona(item: { origin: string; editedAt: number | null }): boolean {
  return item.origin === "owner" || item.editedAt !== null;
}

/**
 * Confirma, ignora ou volta a pendente um item do resumo. Item que deixa de
 * estar confirmado perde também a marca de feito: só ação confirmada se marca.
 */
export async function decidirItemDoResumo(ownerId: string, itemId: string, pedido: "pending" | "confirmed" | "ignored") {
  const db = await exigirDb();
  const item = await itemParaDecidir(db, ownerId, itemId);
  const status = pedido === "pending" && escritoPelaDona(item) ? "confirmed" : pedido;
  const agora = Date.now();
  const r = await db.update(meetingSummaryItems).set({
    status,
    decidedAt: status === "pending" ? null : agora,
    ...(status === "confirmed" ? {} : { done: false, doneAt: null }),
    updatedAt: agora,
  }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
  if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
}

/** Confirma de uma vez os itens ainda pendentes do resumo pronto da reunião. */
export async function confirmarItensDoResumo(ownerId: string, meetingId: string): Promise<number> {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  const linha = await linhaDoResumo(db, ownerId, meetingId);
  if (!linha || linha.status !== "ready" || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  const agora = Date.now();
  const r = await db.update(meetingSummaryItems).set({ status: "confirmed", decidedAt: agora, updatedAt: agora })
    .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.status, "pending")));
  return linhasAfetadas(r);
}

/**
 * Marca ou desmarca a caixa de uma ação do resumo. Marcar como feita também a
 * confirma: quem marca que fez está dizendo que a ação existiu.
 */
export async function marcarAcaoFeita(ownerId: string, itemId: string, feito: boolean) {
  const db = await exigirDb();
  const item = await itemParaDecidir(db, ownerId, itemId);
  if (item.section !== "action") throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGEM_SO_ACAO_TEM_CAIXA });
  const agora = Date.now();
  const r = await db.update(meetingSummaryItems).set({
    done: feito,
    doneAt: feito ? agora : null,
    ...(feito ? { status: "confirmed" as const, decidedAt: sql`coalesce(${meetingSummaryItems.decidedAt}, ${agora})` } : {}),
    updatedAt: agora,
  }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
  if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
}

/**
 * O que a dona escreve num item (H4f), já aparado e validado pela entrada do
 * procedimento: o texto é obrigatório; o assunto, o responsável e o prazo vêm
 * nulos quando vazios. Os rótulos de voz ({F2}) chegam prontos da tela
 * (shared/vozes-na-edicao.ts): o servidor nunca resolve nem desfaz um nome.
 */
export type CamposDoItem = { texto: string; assunto: string | null; responsavel: string | null; prazo: string | null };

/**
 * Os campos como a seção os guarda: só as tarefas têm assunto, e só as ações
 * e as tarefas têm responsável e prazo (o formato da cliente). O que a seção
 * não tem fica nulo, venha o que vier.
 */
function camposDaSecao(secao: SecaoDoItem, campos: CamposDoItem) {
  return {
    text: campos.texto,
    subject: secaoTemAssunto(secao) ? campos.assunto : null,
    assignee: secaoTemResponsavel(secao) ? campos.responsavel : null,
    due: secaoTemResponsavel(secao) ? campos.prazo : null,
  };
}

type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/**
 * Dentro da transação, trava a reunião e o resumo, nesta ordem (a mesma da
 * gravação do resumo, server/fila-do-resumo.ts), e exige os dois prontos. A
 * exclusão, que marca 'deleted' antes de apagar, espera a transação e leva
 * junto o que ela gravou: nunca sobra item de reunião apagada.
 */
async function travarResumoPronto(tx: Transacao, ownerId: string, meetingId: string, naoAchou: string) {
  const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1).for("update");
  if (!reuniao || reuniao.status === "deleted") throw new TRPCError({ code: "NOT_FOUND", message: naoAchou });
  const [resumo] = await tx.select({ id: meetingSummaries.id, status: meetingSummaries.status }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1).for("update");
  if (!resumo || resumo.status !== "ready" || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  return resumo;
}

/** O conteúdo do resumo mudou: a versão sobe (a tradução da H11 é refeita). */
async function subirVersao(tx: Transacao, ownerId: string, summaryId: string, agora: number) {
  await tx.update(meetingSummaries).set({ version: sql`${meetingSummaries.version} + 1`, updatedAt: agora })
    .where(and(eq(meetingSummaries.id, summaryId), eq(meetingSummaries.ownerId, ownerId)));
}

/**
 * A dona edita o texto, o assunto (das tarefas), o responsável e o prazo de um
 * item do resumo pronto (H4f). O item editado vale como confirmado: é a palavra
 * dela, e o link aberto o mostra assim, sem o aviso de que a IA o gerou. A
 * origem não muda; o edited_at marca a edição, só quando algo mudou (salvar
 * sem mudar nada é confirmar). A marca de feito da ação fica como estava.
 */
export async function editarItemDoResumo(ownerId: string, itemId: string, campos: CamposDoItem) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [item] = await tx.select({
      summaryId: meetingSummaryItems.summaryId,
      meetingId: meetingSummaryItems.meetingId,
      section: meetingSummaryItems.section,
      status: meetingSummaryItems.status,
      subject: meetingSummaryItems.subject,
      text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee,
      due: meetingSummaryItems.due,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    const resumo = await travarResumoPronto(tx, ownerId, item.meetingId, MENSAGEM_ITEM_NAO_ENCONTRADO);
    // O item é de outro resumo da mesma reunião (o resumo foi refeito entre a
    // leitura e a trava): não existe mais.
    if (resumo.id !== item.summaryId) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    const novos = camposDaSecao(item.section, campos);
    const mudou = novos.text !== item.text || novos.subject !== item.subject || novos.assignee !== item.assignee || novos.due !== item.due;
    const agora = Date.now();
    const r = await tx.update(meetingSummaryItems).set({
      ...novos,
      status: "confirmed",
      ...(item.status === "confirmed" ? {} : { decidedAt: agora }),
      ...(mudou ? { editedAt: agora } : {}),
      updatedAt: agora,
    }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
    if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    if (mudou) await subirVersao(tx, ownerId, resumo.id, agora);
  });
}

/**
 * A dona acrescenta um item à mão ao resumo pronto (H4f): no fim da seção,
 * confirmado, com a origem 'owner', sem trecho, sem tempo e sem confiança. O
 * resumo guarda até ITENS_DO_RESUMO_MAX itens. Devolve o id do item novo.
 */
export async function acrescentarItemDoResumo(ownerId: string, meetingId: string, secao: SecaoDoItem, campos: CamposDoItem): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    const resumo = await travarResumoPronto(tx, ownerId, meetingId, MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const [contagem] = await tx.select({ itens: count(), ultima: max(meetingSummaryItems.position) }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, resumo.id), eq(meetingSummaryItems.ownerId, ownerId)));
    if (Number(contagem?.itens ?? 0) >= ITENS_DO_RESUMO_MAX) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_CHEIO });
    const agora = Date.now();
    // A tela agrupa por seção na ordem da posição: o último do resumo é o último da seção.
    const ultima = contagem?.ultima ?? null;
    await tx.insert(meetingSummaryItems).values({
      id, summaryId: resumo.id, meetingId, ownerId, section: secao, position: ultima === null ? 0 : Number(ultima) + 1,
      ...camposDaSecao(secao, campos), excerpt: "", startSeconds: null,
      origin: "owner", status: "confirmed", done: false, decidedAt: agora, createdAt: agora, updatedAt: agora,
    });
    await subirVersao(tx, ownerId, resumo.id, agora);
  });
  return id;
}

/**
 * O resumo guardado pelo link aberto (decisão do Roberto de 12/11/2026): só
 * leitura, sem ids, sem a caixa de feito e sem os itens que a dona ignorou.
 * Os pendentes vão com o estado, para a tela avisar que a dona ainda não os
 * conferiu. Os rótulos de voz ({F2}) vão crus: a tela do link mostra
 * "Falante 2", e os nomes que a dona deu às vozes não saem por aqui.
 */
export async function resumoGuardadoPeloLink(token: string) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  const linha = await linhaDoResumo(db, reuniao.ownerId, reuniao.id);
  const estado = estadoDe(linha, Date.now());
  const itens = linha && estado === "pronto"
    ? await db.select({
      section: meetingSummaryItems.section,
      subject: meetingSummaryItems.subject,
      text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee,
      due: meetingSummaryItems.due,
      excerpt: meetingSummaryItems.excerpt,
      startSeconds: meetingSummaryItems.startSeconds,
      status: meetingSummaryItems.status,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, reuniao.ownerId), ne(meetingSummaryItems.status, "ignored")))
      .orderBy(asc(meetingSummaryItems.position))
    : [];
  return { estado, emoji: linha?.emoji ?? null, itens };
}

/** Quem tem o link pede o resumo que a reunião ainda não tem (ou que falhou). */
export async function pedirResumoPeloLink(token: string, antesDeCriar: (reuniaoId: string) => (() => void) | void) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  await pedirResumoDaReuniao(db, reuniao.ownerId, reuniao.id, () => antesDeCriar(reuniao.id));
  return resumoGuardadoPeloLink(token);
}
