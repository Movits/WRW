import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { exigirReuniaoDoLink } from "./link-aberto-da-reuniao";
import { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { MENSAGEM_SEM_TRANSCRICAO } from "./reuniao-com-ia";
import { apagarAcaoDoItem, criarDoItem, escreverFeita, garantirAcoesDosItensConfirmados, type Executor } from "./proximas-acoes";

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
export { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA };

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

/**
 * A reunião da dona, não apagada, ou NOT_FOUND. `travar`: numa transação, a
 * linha fica presa até o fim dela, e o estado lido é o mais novo.
 */
async function reuniaoDaDona(db: Executor, ownerId: string, meetingId: string, travar = false) {
  const consulta = db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"))).limit(1);
  const [reuniao] = await (travar ? consulta.for("update") : consulta);
  if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  return reuniao;
}

async function linhaDoResumo(db: Executor, ownerId: string, meetingId: string, travar = false) {
  const consulta = db.select(COLUNAS_DO_RESUMO).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1);
  const [linha] = await (travar ? consulta.for("update") : consulta);
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
 *
 * Roda na transação da decisão e trava a reunião e o resumo até o fim dela,
 * nesta ordem (a da fila do resumo, server/fila-do-resumo.ts). A exclusão, que
 * marca a reunião 'deleted' antes de apagar, espera a decisão, e a próxima ação
 * que a decisão criar (H5a) se solta com os outros derivados. Os estados vêm
 * das leituras travadas, que leem a versão mais nova da linha.
 */
async function itemParaDecidir(db: Executor, ownerId: string, itemId: string) {
  const [item] = await db.select({
    id: meetingSummaryItems.id,
    section: meetingSummaryItems.section,
    summaryId: meetingSummaryItems.summaryId,
    meetingId: meetingSummaryItems.meetingId,
  }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  const [reuniao] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, item.meetingId), eq(meetings.ownerId, ownerId))).for("update");
  const [resumo] = await db.select({ status: meetingSummaries.status }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.id, item.summaryId), eq(meetingSummaries.ownerId, ownerId))).for("update");
  if (!reuniao || !resumo || reuniao.status === "deleted") throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  if (resumo.status !== "ready" || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  return item;
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * Confirma, ignora ou volta a pendente um item do resumo. Item que deixa de
 * estar confirmado perde também a marca de feito: só ação confirmada se marca.
 *
 * A próxima ação (H5a) acompanha a decisão, na mesma transação: confirmar uma
 * ação ou tarefa a cria, e desconfirmar a apaga (a tela pede confirmação antes).
 */
export async function decidirItemDoResumo(ownerId: string, itemId: string, status: "pending" | "confirmed" | "ignored") {
  const db = await exigirDb();
  await db.transaction(async tx => {
    await itemParaDecidir(tx, ownerId, itemId);
    const agora = Date.now();
    const r = await tx.update(meetingSummaryItems).set({
      status,
      decidedAt: status === "pending" ? null : agora,
      ...(status === "confirmed" ? {} : { done: false, doneAt: null }),
      updatedAt: agora,
    }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
    if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    if (status === "confirmed") await criarDoItem(tx, ownerId, itemId, agora);
    else await apagarAcaoDoItem(tx, ownerId, itemId);
  });
}

/**
 * Confirma de uma vez os itens ainda pendentes do resumo pronto da reunião. As
 * ações e tarefas confirmadas ganham a próxima ação na mesma transação, e as
 * confirmadas antes da H5a também.
 */
export async function confirmarItensDoResumo(ownerId: string, meetingId: string): Promise<number> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    // A reunião e o resumo travados até o fim, nesta ordem, como em itemParaDecidir.
    const reuniao = await reuniaoDaDona(tx, ownerId, meetingId, true);
    const linha = await linhaDoResumo(tx, ownerId, meetingId, true);
    if (!linha || linha.status !== "ready" || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    const agora = Date.now();
    const r = await tx.update(meetingSummaryItems).set({ status: "confirmed", decidedAt: agora, updatedAt: agora })
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.status, "pending")));
    await garantirAcoesDosItensConfirmados(tx, ownerId, meetingId, agora);
    return linhasAfetadas(r);
  });
}

/**
 * Marca ou desmarca a caixa de uma ação do resumo. Marcar como feita também a
 * confirma: quem marca que fez está dizendo que a ação existiu. A próxima ação
 * dela nasce, se ainda não existia, e a marca de feita vai para as duas pela
 * mesma escrita (escreverFeita), na mesma transação.
 */
export async function marcarAcaoFeita(ownerId: string, itemId: string, feito: boolean) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const item = await itemParaDecidir(tx, ownerId, itemId);
    if (item.section !== "action") throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGEM_SO_ACAO_TEM_CAIXA });
    const agora = Date.now();
    if (feito) {
      const r = await tx.update(meetingSummaryItems).set({
        status: "confirmed" as const, decidedAt: sql`coalesce(${meetingSummaryItems.decidedAt}, ${agora})`, updatedAt: agora,
      }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
      if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
      await criarDoItem(tx, ownerId, itemId, agora);
    }
    await escreverFeita(tx, ownerId, { itemId }, feito, agora);
  });
}

/**
 * O resumo guardado pelo link aberto (decisão do Roberto de 12/11/2026): só
 * leitura, sem ids, sem a caixa de feito e sem os itens que a dona ignorou.
 * Os pendentes vão com o estado, para a tela avisar que a dona ainda não os
 * conferiu. Os rótulos de voz ({F2}) vão crus: a página do link os troca pelo
 * nome com o `vozes` de reuniaoAberta.ver (H3b), que só traz os nomes quando o
 * link foi ligado com a confirmação que fala deles; sem nome, "Falante 2".
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
