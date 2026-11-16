import crypto from "crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } from "../drizzle/schema";
import { idiomaDaReuniao, IDIOMA_DA_REUNIAO_PADRAO } from "@shared/idioma-da-reuniao";
import { MODELO_DE_RESUMO_PADRAO, modeloDeResumo } from "@shared/modelos-de-resumo";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { FalhaDaIA } from "./ia-em-json";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { gerarResumoDaReuniao } from "./resumo-da-reuniao";
import { numeracaoDoResumoRefeito } from "./resumo-refeito";

/**
 * A fila do resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), no próprio MySQL, no molde da
 * fila de transcrição (server/fila-de-transcricao.ts).
 *
 * Cada linha 'pending' de meeting_summaries é um trabalho: a rodada reserva uma
 * (UPDATE condicional com o token da execução), pede o resumo à IA e grava os
 * itens numa transação que confere a reunião (pronta, da dona) e a reserva.
 * Excluir ou reprocessar a reunião no meio apaga a linha do resumo: a gravação
 * acha zero linhas e descarta tudo, sem item órfão. Um deploy no meio não perde
 * o trabalho: a reserva vence e outra rodada o retoma. Laço e temporizador
 * próprios: o resumo nunca segura a fila de transcrição.
 */

const INTERVALO_DA_RODADA_MS = 5_000;
// Cobre a pior geração (gerarResumoDaReuniao: 180 s por chamada, 200 s de
// orçamento, e na reunião longa uma chamada por janela mais a junção) com folga.
const DURACAO_DA_RESERVA_MS = 15 * 60_000;
export const TENTATIVAS_DO_RESUMO = 3;

type Banco = Awaited<ReturnType<typeof exigirDb>>;
// Os testes rodam a fila só sobre as reuniões de uma dona: o Vitest roda os
// arquivos em paralelo no mesmo banco.
type Escopo = { ownerId?: string };

// Os tokens das reservas desta instância: o SIGTERM devolve exatamente estes.
const tokensVivos = new Set<string>();
let parada = false;

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/** Código curto para last_error: nunca o texto da IA ou do driver. */
function codigoDoErro(erro: unknown): string {
  return erro instanceof FalhaDaIA ? erro.codigo : "ERRO";
}

/**
 * Resumo pendente vencido o prazo das tentativas, sem reserva viva (o processo
 * caiu em todas, sem o SIGTERM): ninguém mais o reservaria. Vira falha, e a
 * tela oferece tentar de novo.
 */
async function desistirDosEsgotados(db: Banco, agora: number, escopo: Escopo) {
  await db.update(meetingSummaries).set({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS", lockToken: null, lockedUntil: null, updatedAt: agora })
    .where(and(
      eq(meetingSummaries.status, "pending"),
      sql`${meetingSummaries.attempts} >= ${TENTATIVAS_DO_RESUMO}`,
      or(isNull(meetingSummaries.lockedUntil), lt(meetingSummaries.lockedUntil, agora)),
      escopo.ownerId ? eq(meetingSummaries.ownerId, escopo.ownerId) : undefined,
    ));
}

/** O resumo pendente mais antigo, sem reserva viva, de reunião pronta de conta ativa. */
async function proximoResumo(db: Banco, agora: number, escopo: Escopo) {
  const [alvo] = await db.select({ id: meetingSummaries.id, meetingId: meetingSummaries.meetingId, ownerId: meetingSummaries.ownerId, template: meetingSummaries.template })
    .from(meetingSummaries)
    .innerJoin(meetings, and(eq(meetings.id, meetingSummaries.meetingId), eq(meetings.ownerId, meetingSummaries.ownerId)))
    .innerJoin(users, eq(users.openId, meetingSummaries.ownerId))
    .where(and(
      eq(meetingSummaries.status, "pending"),
      or(isNull(meetingSummaries.lockedUntil), lt(meetingSummaries.lockedUntil, agora)),
      lt(meetingSummaries.attempts, TENTATIVAS_DO_RESUMO),
      eq(meetings.status, "ready"),
      eq(users.isActive, true),
      escopo.ownerId ? eq(meetingSummaries.ownerId, escopo.ownerId) : undefined,
    ))
    .orderBy(asc(meetingSummaries.updatedAt))
    .limit(1);
  return alvo;
}

async function reservar(db: Banco, id: string, agora: number): Promise<string | null> {
  const token = crypto.randomUUID();
  tokensVivos.add(token);
  const r = await db.update(meetingSummaries).set({
    lockToken: token, lockedUntil: agora + DURACAO_DA_RESERVA_MS,
    attempts: sql`${meetingSummaries.attempts} + 1`, updatedAt: agora,
  }).where(and(
    eq(meetingSummaries.id, id), eq(meetingSummaries.status, "pending"),
    or(isNull(meetingSummaries.lockedUntil), lt(meetingSummaries.lockedUntil, agora)),
    lt(meetingSummaries.attempts, TENTATIVAS_DO_RESUMO),
  ));
  if (linhas(r)) return token;
  tokensVivos.delete(token);
  return null;
}

/**
 * Devolve a reserva sem gastar a tentativa: a geração não chegou a ser gravada
 * por um motivo que não é falha dela (desligamento, reunião fora de 'ready',
 * transcrição trocada). Sem isto, a linha ficaria presa até a reserva vencer.
 */
async function devolverReserva(db: Banco, id: string, token: string) {
  await db.update(meetingSummaries).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingSummaries.attempts} - 1, 0)` })
    .where(and(eq(meetingSummaries.id, id), eq(meetingSummaries.lockToken, token)));
}

/** Falha com a reserva ainda viva: espera curta e crescente, ou falha de vez. */
async function registrarFalha(db: Banco, alvo: { id: string }, token: string, codigo: string, definitiva: boolean) {
  const [linha] = await db.select({ attempts: meetingSummaries.attempts }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token))).limit(1);
  if (!linha) return;
  const deVez = definitiva || linha.attempts >= TENTATIVAS_DO_RESUMO;
  await db.update(meetingSummaries).set({
    status: deVez ? "failed" : "pending", lastError: codigo, lockToken: null,
    lockedUntil: deVez ? null : Date.now() + linha.attempts * 60_000, updatedAt: Date.now(),
  }).where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token)));
}

/**
 * O item que fica quando o resumo é refeito com outro modelo (H4d, "Refazer
 * como…"): o que a dona confirmou e a ação que ela marcou como feita. Os
 * pendentes e os ignorados são trocados pelos novos.
 */
const itemQueFica = (item: { status: string; done: boolean }) => item.status === "confirmed" || item.done;

async function gerarUm(db: Banco, alvo: { id: string; meetingId: string; ownerId: string; template: string }, token: string) {
  const [transcricao] = await db.select({
    id: meetingTranscripts.id, texto: meetingTranscripts.transcript, segmentos: meetingTranscripts.segments, idioma: meetingTranscripts.language,
  }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
  if (!transcricao) return registrarFalha(db, alvo, token, "SEM_TRANSCRICAO", true);
  const idioma = idiomaDaReuniao(transcricao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  // O resumo refeito (H4d) leva à IA os itens que ficam, para ela não os
  // escrever de novo. No primeiro resumo não há item nenhum.
  const itensAtuais = await db.select({
    section: meetingSummaryItems.section, subject: meetingSummaryItems.subject, text: meetingSummaryItems.text,
    status: meetingSummaryItems.status, done: meetingSummaryItems.done,
  }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.summaryId, alvo.id), eq(meetingSummaryItems.ownerId, alvo.ownerId)))
    .orderBy(asc(meetingSummaryItems.position));
  const itensQueFicam = itensAtuais.filter(itemQueFica).map(({ section, subject, text }) => ({ section, subject, text }));

  let resumo: Awaited<ReturnType<typeof gerarResumoDaReuniao>>;
  try {
    resumo = await gerarResumoDaReuniao({
      transcricao: transcricao.texto, segmentos: segmentosDoContrato(transcricao.segmentos), idioma,
      modelo: modeloDeResumo(alvo.template) ?? MODELO_DE_RESUMO_PADRAO, itensQueFicam,
    });
  } catch (erro) {
    // Resposta cortada no teto de saída se repetiria com a mesma entrada: é
    // falha de vez. O resto (IA fora, JSON inválido) tenta de novo.
    const definitiva = erro instanceof FalhaDaIA && erro.codigo === "RESPOSTA_CORTADA";
    // Erro que não é da IA é bug ou banco: vai a pilha ao log, não só o código.
    console.error(`[Resumo] a geração falhou (${definitiva ? "sem nova tentativa" : "volta à fila"}):`, erro instanceof FalhaDaIA ? erro.codigo : erro instanceof Error ? erro.stack ?? descreverErroDeBanco(erro) : descreverErroDeBanco(erro));
    return registrarFalha(db, alvo, token, codigoDoErro(erro), definitiva);
  }
  // O desligamento chegou durante a chamada à IA: as reservas já foram
  // devolvidas, e o próximo processo refaz o resumo.
  if (parada) return;

  const agora = Date.now();
  let resultado: "gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada";
  try {
    resultado = await gravarResumo(db, alvo, token, transcricao, idioma, resumo, agora);
  } catch (erro) {
    // A IA já respondeu e o banco recusou (queda, deadlock): conta como falha
    // passageira, com espera, em vez de prender a linha até a reserva vencer.
    console.error("[Resumo] o resumo não foi gravado:", descreverErroDeBanco(erro));
    try {
      await registrarFalha(db, alvo, token, "ERRO_GRAVACAO", false);
    } catch (erroAoRegistrar) {
      console.error("[Resumo] nem a falha foi registrada; a reserva vence sozinha:", descreverErroDeBanco(erroAoRegistrar));
    }
    return;
  }
  if (resultado === "reuniao_fora" || resultado === "transcricao_trocada") {
    console.warn(`[Resumo] descartado: ${resultado === "reuniao_fora" ? "a reunião saiu de 'ready'" : "a transcrição foi trocada"} durante a geração; a reserva volta à fila.`);
    await devolverReserva(db, alvo.id, token);
  } else if (resultado === "sem_reserva") {
    console.warn("[Resumo] descartado: a reserva não é mais desta rodada (reunião excluída ou reprocessada, ou outra rodada a retomou).");
  }
}

/**
 * Grava os itens e marca o resumo como pronto, numa transação. A reunião fica
 * travada até o fim: a exclusão (que marca 'deleted' antes de apagar) espera
 * esta transação, e o que ela gravar sai junto. No resumo refeito (H4d), os
 * itens que a dona confirmou e as ações feitas ficam, renumerados, e só os
 * pendentes e os ignorados são trocados.
 */
async function gravarResumo(
  db: Banco, alvo: { id: string; meetingId: string; ownerId: string }, token: string,
  transcricao: { id: string }, idioma: string, resumo: Awaited<ReturnType<typeof gerarResumoDaReuniao>>, agora: number,
): Promise<"gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada"> {
  return db.transaction(async tx => {
    // A reunião travada até o fim: a exclusão (que marca 'deleted' antes de
    // apagar) espera esta transação, e o que ela gravar sai junto.
    const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, alvo.meetingId), eq(meetings.ownerId, alvo.ownerId))).for("update");
    const [ainda] = await tx.select({ id: meetingSummaries.id }).from(meetingSummaries)
      .where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token))).for("update");
    // Sem a linha com o meu token: a reunião foi reprocessada ou excluída, ou a
    // reserva venceu e outra rodada a tomou.
    if (!ainda) return "sem_reserva";
    if (reuniao?.status !== "ready") return "reuniao_fora";
    // A transcrição tem de ser a mesma que a IA leu.
    const [atual] = await tx.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
    if (atual?.id !== transcricao.id) return "transcricao_trocada";
    // Os itens de agora, lidos sem trava, e os que saem apagados pela chave:
    // travar a faixa do resumo no índice prende também o vão vizinho, e duas
    // gravações de resumos vizinhos se travam uma à outra (deadlock). A linha
    // do resumo, travada acima, já faz desta a única gravação dele, e a dona
    // não decide enquanto ele está na fila; mesmo assim, o item que alguém
    // confirmou ou marcou como feito no meio não é apagado.
    const itensAtuais = await tx.select({
      id: meetingSummaryItems.id, section: meetingSummaryItems.section, position: meetingSummaryItems.position,
      text: meetingSummaryItems.text, status: meetingSummaryItems.status, done: meetingSummaryItems.done,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, alvo.id), eq(meetingSummaryItems.ownerId, alvo.ownerId)));
    const queFicam = itensAtuais.filter(itemQueFica);
    const queSaem = itensAtuais.filter(item => !itemQueFica(item)).map(item => item.id);
    if (queSaem.length) {
      await tx.delete(meetingSummaryItems).where(and(
        inArray(meetingSummaryItems.id, queSaem), eq(meetingSummaryItems.ownerId, alvo.ownerId),
        ne(meetingSummaryItems.status, "confirmed"), eq(meetingSummaryItems.done, false),
      ));
    }
    const numeracao = numeracaoDoResumoRefeito(queFicam, resumo.itens);
    for (const { id, position } of numeracao.queFicam) {
      if (queFicam.find(item => item.id === id)?.position === position) continue;
      await tx.update(meetingSummaryItems).set({ position })
        .where(and(eq(meetingSummaryItems.id, id), eq(meetingSummaryItems.ownerId, alvo.ownerId)));
    }
    if (numeracao.novos.length) {
      await tx.insert(meetingSummaryItems).values(numeracao.novos.map(item => ({
        id: crypto.randomUUID(), summaryId: alvo.id, meetingId: alvo.meetingId, ownerId: alvo.ownerId,
        section: item.section, position: item.position, subject: item.subject, text: item.text, assignee: item.assignee, due: item.due,
        excerpt: item.excerpt, startSeconds: item.startSeconds, confidence: item.confidence.toFixed(3),
        status: "pending" as const, done: false, createdAt: agora, updatedAt: agora,
      })));
    }
    const r = await tx.update(meetingSummaries).set({
      status: "ready", transcriptId: transcricao.id, language: idioma, emoji: resumo.emoji, model: resumo.modelo,
      version: sql`${meetingSummaries.version} + 1`, generatedAt: agora,
      // A IA devolveu itens e a conferência tirou todos: fica registrado, e a
      // tela mostra o resumo vazio sem fingir que a reunião não teve conteúdo.
      lastError: !resumo.itens.length && resumo.recebidos ? "CONFERENCIA_TIROU_TUDO" : null,
      lockToken: null, lockedUntil: null, updatedAt: agora,
    }).where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token)));
    return linhas(r) > 0 ? "gravou" : "sem_reserva";
  });
}

/**
 * Uma rodada: desiste dos esgotados, reserva o resumo pendente mais antigo e o
 * gera. Exportada para os testes; em produção é o laço de iniciarFilaDoResumo.
 */
export async function rodarUmaVez(escopo: Escopo = {}): Promise<void> {
  if (parada) return;
  const db = await exigirDb();
  const agora = Date.now();
  await desistirDosEsgotados(db, agora, escopo);
  const alvo = await proximoResumo(db, agora, escopo);
  if (!alvo || parada) return;
  const token = await reservar(db, alvo.id, agora);
  if (!token) return;
  try {
    // O desligamento pode ter tirado a foto das reservas antes desta: devolve
    // na hora, sem chamar a IA.
    if (parada) return await devolverReserva(db, alvo.id, token);
    await gerarUm(db, alvo, token);
  } finally {
    tokensVivos.delete(token);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Liga o laço da fila do resumo (no boot do servidor, com banco). */
export function iniciarFilaDoResumo(intervaloMs = INTERVALO_DA_RODADA_MS) {
  parada = false;
  const proxima = () => {
    if (parada) return;
    timer = setTimeout(() => {
      // Uma rodada por vez, e ela nunca rejeita solta (derrubaria o processo):
      // todo erro vira log, e a reserva vence sozinha.
      rodarUmaVez()
        .catch(erro => console.error("[Resumo] a rodada falhou:", descreverErroDeBanco(erro)))
        .finally(proxima);
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/**
 * Desligamento (SIGTERM do Render, SIGINT no dev): para de reservar e devolve
 * as reservas desta instância, sem gastar a tentativa, para o próximo processo
 * retomar na hora. O trabalho em curso é abandonado: a gravação dele confere o
 * token, que já não vale.
 */
export async function pararFilaDoResumo(): Promise<{ resumos: number }> {
  parada = true;
  clearTimeout(timer);
  const tokens = Array.from(tokensVivos);
  if (!tokens.length) return { resumos: 0 };
  let db: Banco;
  try {
    db = await exigirDb();
  } catch (erro) {
    console.error("[Resumo] sem banco no desligamento; as reservas vencem sozinhas:", descreverErroDeBanco(erro));
    return { resumos: 0 };
  }
  const r = await db.update(meetingSummaries).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingSummaries.attempts} - 1, 0)` })
    .where(and(inArray(meetingSummaries.lockToken, tokens), eq(meetingSummaries.status, "pending")));
  tokensVivos.clear();
  return { resumos: linhas(r) };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}

export const _paraTestes = { tokensVivos };
