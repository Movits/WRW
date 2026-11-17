import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { meetingAudioSlices, meetings } from "../drizzle/schema";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError } from "./gemini";
import { extrairDadosDaReuniao, gravarResultadoDaReuniao, mensagemDaFalha, ReuniaoExcluidaDuranteProcessamento, ReuniaoTomadaPorOutraExecucao } from "./meeting-service";
import { ObjetoAusenteNoStorageError, storageGetBytes } from "./storage";
import { entradaDoResumo } from "./resumo-da-reuniao";
import { TAMANHO_MAXIMO_DA_PARTE } from "./fatias-de-reuniao";
import { contextoParaAProxima, DURACAO_DA_FATIA_SEGUNDOS, montarTranscricao, TemposForaDaParteError, transcreverFatia, type ContextoDaFatiaAnterior, type Segmento } from "./transcricao-de-fatia";

/**
 * A fila de transcrição da reunião gravada em partes (G7 do desenho do
 * gravador, docs/arquitetura/gravador-de-reunioes.md), no próprio MySQL.
 *
 * Quem faz a fila andar é o servidor, nunca o polling da tela: a cada poucos
 * segundos ele reserva trabalho e o executa, então um deploy no meio não derruba
 * a reunião — a reserva vence e outra rodada a retoma.
 *
 * Dois tipos de trabalho, cada um com reserva atômica (UPDATE condicional com o
 * token da execução, conferido em toda escrita):
 * 1. a PARTE 'received': transcrita pela G6 (transcreverFatia), na ordem, com o
 *    contexto da anterior (vozes e últimas falas), e marcada 'transcribed' (a
 *    que volta com os tempos quase todos fora dela tenta de novo, e na última
 *    tentativa entra com as contagens em result.tempos);
 * 2. a REUNIÃO encerrada ('uploading') com todas as partes resolvidas: monta a
 *    transcrição, extrai (em janelas, G8), grava pelo mesmo caminho do envio
 *    único (gravarResultadoDaReuniao) e avisa quem se pendurou em aoFicarPronta.
 *
 * Um semáforo limita as chamadas de IA simultâneas do processo. No SIGTERM a
 * fila para de reservar e devolve as reservas (pararFila), para o próximo
 * processo retomar na hora em vez de esperar a reserva vencer.
 */

const INTERVALO_DA_RODADA_MS = 5_000;
// A reserva cobre a pior chamada da parte (gerarComAudioNoGemini: 5 min por
// chamada, 8 de orçamento, mais a reserva do modelo) com folga.
const DURACAO_DA_RESERVA_MS = 15 * 60_000;
export const TENTATIVAS_POR_PARTE = 3;
export const TENTATIVAS_POR_REUNIAO = 3;
// Parte que não chegou: depois do fim da gravação, a fila espera este tanto e
// transcreve o que chegou, com uma lacuna no lugar da que falta.
export const ESPERA_PELA_PARTE_QUE_FALTA_MS = 24 * 60 * 60_000;
// Reunião em partes sem parte nova nem fim por este tempo (aba fechada no meio,
// celular sem bateria): é encerrada com as partes que chegaram.
export const ABANDONO_DA_GRAVACAO_MS = 6 * 60 * 60_000;
const CHAMADAS_DE_IA_AO_MESMO_TEMPO = 2;

type Banco = Awaited<ReturnType<typeof exigirDb>>;

// ─── Gancho: reunião pronta ──────────────────────────────────────────────────
type AoFicarPronta = (reuniao: { meetingId: string; ownerId: string }) => Promise<void> | void;
const ganchos: AoFicarPronta[] = [];
/** O resumo (H4) e quem mais precisar se penduram aqui sem editar a fila. */
export function aoFicarPronta(gancho: AoFicarPronta): () => void {
  ganchos.push(gancho);
  return () => {
    const i = ganchos.indexOf(gancho);
    if (i >= 0) ganchos.splice(i, 1);
  };
}

// ─── Semáforo da IA ──────────────────────────────────────────────────────────
let emUso = 0;
const esperando: Array<() => void> = [];
async function comVagaDeIA<T>(trabalho: () => Promise<T>): Promise<T> {
  // Sem vaga, espera; a vaga de quem termina passa DIRETO a quem espera (sem
  // descer o contador), para um chamador novo não passar na frente e somar 3.
  if (emUso >= CHAMADAS_DE_IA_AO_MESMO_TEMPO) await new Promise<void>(resolve => esperando.push(resolve));
  else emUso += 1;
  try {
    return await trabalho();
  } finally {
    const proximo = esperando.shift();
    if (proximo) proximo();
    else emUso -= 1;
  }
}

/** Só para os testes: quantas chamadas de IA estão em curso agora. */
export function chamadasDeIAEmCurso() {
  return emUso;
}

// ─── Reservas desta instância ────────────────────────────────────────────────
// Cada reserva tem token PRÓPRIO (lock_token é varchar 36: um uuid), para uma
// execução velha desta mesma instância — a montagem que passou da reserva e
// foi retomada — não escrever sobre a reserva nova da mesma linha. Os tokens
// vivos ficam aqui, e o SIGTERM devolve exatamente estes.
const tokensVivos = new Set<string>();
const novoToken = () => {
  const token = crypto.randomUUID();
  tokensVivos.add(token);
  return token;
};
let parada = false;
const emCurso = new Set<Promise<unknown>>();

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/** Erro que não melhora repetindo: a parte vira 'failed' na hora. */
function ehDefinitivo(erro: unknown) {
  return erro instanceof ObjetoAusenteNoStorageError || erro instanceof GeminiRecusouChamadaError;
}

/** Código curto para last_error: nunca o texto do driver nem o da IA. */
function codigoDoErro(erro: unknown): string {
  if (erro instanceof ObjetoAusenteNoStorageError) return "AUDIO_AUSENTE";
  if (erro instanceof GeminiRecusouChamadaError) return "IA_RECUSOU";
  if (erro instanceof GeminiRespostaCortadaError) return "IA_CORTOU";
  if (erro instanceof GeminiIndisponivelError) return "IA_INDISPONIVEL";
  if (erro instanceof TemposForaDaParteError) return "TEMPOS_FORA_DA_PARTE";
  if (ehErroDeBancoIndisponivel(erro)) return "BANCO_INDISPONIVEL";
  return "ERRO";
}

// ─── 1. Partes ───────────────────────────────────────────────────────────────

/**
 * As partes que podem ser transcritas agora: 'received', sem reserva viva, com
 * tentativas sobrando, de reunião em partes ainda viva, e cuja anterior já está
 * resolvida (transcrita ou falha definitiva) — a ordem importa, porque a parte
 * leva o contexto da anterior. A anterior que não chegou só é pulada depois da
 * espera, contada do fim da gravação.
 */
type Escopo = { ownerId?: string };
const daDona = <T>(coluna: T, escopo: Escopo) => (escopo.ownerId ? eq(coluna as never, escopo.ownerId) : undefined);

async function partesProntasParaTranscrever(db: Banco, agora: number, escopo: Escopo, limite = 10) {
  const candidatas = await db.select({
    id: meetingAudioSlices.id, meetingId: meetingAudioSlices.meetingId, seq: meetingAudioSlices.seq,
    statusDaReuniao: meetings.status,
  }).from(meetingAudioSlices)
    .innerJoin(meetings, and(eq(meetings.id, meetingAudioSlices.meetingId), eq(meetings.ownerId, meetingAudioSlices.ownerId)))
    .where(and(
      eq(meetingAudioSlices.status, "received"),
      or(isNull(meetingAudioSlices.lockedUntil), lt(meetingAudioSlices.lockedUntil, agora)),
      lt(meetingAudioSlices.attempts, TENTATIVAS_POR_PARTE),
      eq(meetings.audioPipeline, "slices"),
      inArray(meetings.status, ["recording", "uploading"]),
      daDona(meetingAudioSlices.ownerId, escopo),
    ))
    .orderBy(asc(meetingAudioSlices.createdAt), asc(meetingAudioSlices.seq))
    // Janela larga: muitas partes de uma reunião longa esperam a anterior, e só
    // a primeira de cada reunião está pronta; com uma janela curta, elas
    // tomariam as vagas e as partes prontas de outras reuniões ficariam sem vez.
    .limit(200);
  const prontas: typeof candidatas = [];
  // Só a primeira parte pendente de cada reunião pode estar pronta (as outras
  // esperam a anterior): uma consulta por reunião, não por parte.
  const vistas = new Set<string>();
  for (const parte of [...candidatas].sort((a, b) => a.seq - b.seq)) {
    if (prontas.length >= limite) break;
    if (vistas.has(parte.meetingId)) continue;
    vistas.add(parte.meetingId);
    if (parte.seq === 0) { prontas.push(parte); continue; }
    const [anterior] = await db.select({ status: meetingAudioSlices.status }).from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.meetingId, parte.meetingId), eq(meetingAudioSlices.seq, parte.seq - 1))).limit(1);
    if (anterior && (anterior.status === "transcribed" || anterior.status === "failed")) { prontas.push(parte); continue; }
    if (!anterior && parte.statusDaReuniao === "uploading" && agora - await ultimaChegada(db, parte.meetingId) > ESPERA_PELA_PARTE_QUE_FALTA_MS) prontas.push(parte);
  }
  return prontas;
}

async function reservarParte(db: Banco, id: string, agora: number): Promise<string | null> {
  const token = novoToken();
  const r = await db.update(meetingAudioSlices).set({
    lockToken: token, lockedUntil: agora + DURACAO_DA_RESERVA_MS,
    attempts: sql`${meetingAudioSlices.attempts} + 1`, updatedAt: agora,
  }).where(and(
    eq(meetingAudioSlices.id, id), eq(meetingAudioSlices.status, "received"),
    or(isNull(meetingAudioSlices.lockedUntil), lt(meetingAudioSlices.lockedUntil, agora)),
    lt(meetingAudioSlices.attempts, TENTATIVAS_POR_PARTE),
  ));
  if (!linhas(r)) tokensVivos.delete(token);
  return linhas(r) ? token : null;
}

/**
 * Quando chegou a última parte da reunião: é daí que conta a espera pela parte
 * que falta. Não é o updated_at da reunião, que a tomada, a falha passageira e o
 * SIGTERM regravam — com ele, a espera de 24 h recomeçaria a cada tentativa.
 */
async function ultimaChegada(db: Banco, meetingId: string): Promise<number> {
  const [r] = await db.select({ ms: sql<number | null>`max(${meetingAudioSlices.createdAt})` })
    .from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId));
  return Number(r?.ms ?? 0);
}

/**
 * Parte 'received' sem tentativa sobrando e sem reserva viva (o processo caiu
 * nas três, sem SIGTERM): ninguém mais a reservaria, e as seguintes esperariam
 * para sempre. Vira 'failed' (lacuna na montagem).
 */
async function desistirDasEsgotadas(db: Banco, agora: number, escopo: Escopo) {
  // A parte cuja linha nasceu e cujo objeto nunca subiu (o bucket recusou e a
  // aba fechou): passada a espera, é lacuna, como a que nem chegou.
  await db.update(meetingAudioSlices).set({ status: "failed", lastError: "NAO_RECEBIDA", updatedAt: agora })
    .where(and(
      eq(meetingAudioSlices.status, "uploading"),
      lt(meetingAudioSlices.createdAt, agora - ESPERA_PELA_PARTE_QUE_FALTA_MS),
      daDona(meetingAudioSlices.ownerId, escopo),
    ));
  await db.update(meetingAudioSlices).set({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS", lockToken: null, lockedUntil: null, updatedAt: agora })
    .where(and(
      eq(meetingAudioSlices.status, "received"),
      sql`${meetingAudioSlices.attempts} >= ${TENTATIVAS_POR_PARTE}`,
      or(isNull(meetingAudioSlices.lockedUntil), lt(meetingAudioSlices.lockedUntil, agora)),
      daDona(meetingAudioSlices.ownerId, escopo),
    ));
}

/** O que a parte anterior passa adiante: onde a reunião está e quem já falou. */
async function contextoDaAnterior(db: Banco, meetingId: string, seq: number): Promise<{ inicioMs: number; anterior?: ContextoDaFatiaAnterior }> {
  if (seq === 0) return { inicioMs: 0 };
  const anteriores = await db.select({
    seq: meetingAudioSlices.seq, status: meetingAudioSlices.status, durationMs: meetingAudioSlices.durationMs,
    offsetMs: meetingAudioSlices.offsetMs, result: meetingAudioSlices.result,
  }).from(meetingAudioSlices).where(and(eq(meetingAudioSlices.meetingId, meetingId), lt(meetingAudioSlices.seq, seq)))
    .orderBy(asc(meetingAudioSlices.seq));
  // O início é a soma das partes anteriores; a que não chegou conta a duração
  // padrão, que é o que a gravação manda a cada parte.
  const porSeq = new Map(anteriores.map(a => [a.seq, a]));
  let inicioMs = 0;
  for (let s = 0; s < seq; s++) inicioMs += porSeq.get(s)?.durationMs ?? DURACAO_DA_FATIA_SEGUNDOS * 1000;
  const ultimaTranscrita = [...anteriores].reverse().find(a => a.status === "transcribed");
  const contexto = (ultimaTranscrita?.result as { contexto?: ContextoDaFatiaAnterior } | null)?.contexto;
  return { inicioMs, anterior: contexto };
}

async function transcreverUmaParte(db: Banco, parte: { id: string; meetingId: string; seq: number }, token: string) {
  const [linha] = await db.select({
    ownerId: meetingAudioSlices.ownerId, storageKey: meetingAudioSlices.storageKey, mimeType: meetingAudioSlices.mimeType,
    durationMs: meetingAudioSlices.durationMs, attempts: meetingAudioSlices.attempts, idioma: meetings.language,
  }).from(meetingAudioSlices)
    .innerJoin(meetings, and(eq(meetings.id, meetingAudioSlices.meetingId), eq(meetings.ownerId, meetingAudioSlices.ownerId)))
    .where(and(eq(meetingAudioSlices.id, parte.id), eq(meetingAudioSlices.lockToken, token))).limit(1);
  if (!linha) return;
  // A reserva já somou esta tentativa: na última, a G6 aceita a parte com os
  // tempos degradados (e devolve as contagens) em vez de pedir outra.
  const ultimaTentativa = linha.attempts >= TENTATIVAS_POR_PARTE;
  try {
    const { inicioMs, anterior } = await contextoDaAnterior(db, parte.meetingId, parte.seq);
    const audio = await storageGetBytes(linha.storageKey, TAMANHO_MAXIMO_DA_PARTE);
    const { segmentos, modelo, tempos } = await comVagaDeIA(() => transcreverFatia({
      audio, mimeType: linha.mimeType, idioma: linha.idioma, inicioSegundos: inicioMs / 1000, duracaoSegundos: linha.durationMs / 1000, anterior,
      ultimaTentativa,
    }));
    const contexto = contextoParaAProxima(segmentos, anterior);
    // Só grava quem ainda tem a reserva: outra instância que a retomou depois
    // de vencer, ou a exclusão da reunião, vencem esta escrita. A parte aceita
    // com os tempos degradados leva as contagens (`tempos`) no result, para
    // uma consulta achá-la.
    await db.update(meetingAudioSlices).set({
      status: "transcribed", result: { segmentos, contexto, ...(tempos ? { tempos } : {}) }, model: modelo.slice(0, 80), offsetMs: inicioMs,
      lastError: null, lockToken: null, lockedUntil: null, updatedAt: Date.now(),
    }).where(and(eq(meetingAudioSlices.id, parte.id), eq(meetingAudioSlices.lockToken, token)));
  } catch (erro) {
    const definitivo = ehDefinitivo(erro) || ultimaTentativa;
    console.error(`[Fila] a parte ${parte.seq} de uma reunião falhou (${definitivo ? "sem nova tentativa" : "volta à fila"}):`, descreverErroDeBanco(erro));
    // Na falha passageira a reserva vira uma espera curta e crescente antes da
    // próxima tentativa; na definitiva, a parte vira lacuna na montagem.
    await db.update(meetingAudioSlices).set({
      status: definitivo ? "failed" : "received", lastError: codigoDoErro(erro),
      lockToken: null, lockedUntil: definitivo ? null : Date.now() + linha.attempts * 60_000, updatedAt: Date.now(),
    }).where(and(eq(meetingAudioSlices.id, parte.id), eq(meetingAudioSlices.lockToken, token)));
  }
}

// ─── 2. Reuniões ─────────────────────────────────────────────────────────────

/**
 * Reunião abandonada no meio ('recording' sem parte nova nem fim por horas):
 * fecha com as partes que chegaram. Sem parte nenhuma, vira falha.
 */
async function encerrarAbandonadas(db: Banco, agora: number, escopo: Escopo) {
  const corte = agora - ABANDONO_DA_GRAVACAO_MS;
  const abandonadas = await db.select({ id: meetings.id, ownerId: meetings.ownerId }).from(meetings)
    .where(and(eq(meetings.audioPipeline, "slices"), eq(meetings.status, "recording"), lt(meetings.updatedAt, corte), daDona(meetings.ownerId, escopo)))
    .limit(20);
  for (const r of abandonadas) {
    const [partes] = await db.select({
      ultimaParte: sql<number | null>`max(${meetingAudioSlices.createdAt})`,
      maiorSeq: sql<number | null>`max(${meetingAudioSlices.seq})`,
    }).from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, r.id));
    if (partes?.ultimaParte !== null && partes?.ultimaParte !== undefined && Number(partes.ultimaParte) > corte) continue;
    if (partes?.maiorSeq === null || partes?.maiorSeq === undefined) {
      await db.update(meetings).set({ status: "failed", processingError: "A gravação foi interrompida antes de enviar o áudio.", updatedAt: agora })
        .where(and(eq(meetings.id, r.id), eq(meetings.status, "recording")));
      continue;
    }
    await db.update(meetings).set({ status: "uploading", expectedSlices: Number(partes.maiorSeq) + 1, updatedAt: agora })
      .where(and(eq(meetings.id, r.id), eq(meetings.status, "recording")));
  }
}

/**
 * Montagem que ficou presa em 'processing' (o processo caiu sem o SIGTERM, e a
 * reserva venceu): volta a 'uploading', e a próxima rodada a retoma.
 */
async function retomarMontagensPresas(db: Banco, agora: number, escopo: Escopo) {
  const presas = and(eq(meetings.audioPipeline, "slices"), eq(meetings.status, "processing"), lt(meetings.lockedUntil, agora), daDona(meetings.ownerId, escopo));
  // Esgotadas as tentativas (o processo caiu em todas), vira falha; senão, volta.
  await db.update(meetings).set({ status: "failed", processingError: MENSAGEM_DA_FALHA_DA_MONTAGEM, lockToken: null, lockedUntil: null, updatedAt: agora })
    .where(and(presas, sql`${meetings.attempts} >= ${TENTATIVAS_POR_REUNIAO}`));
  await db.update(meetings).set({ status: "uploading", lockToken: null, lockedUntil: null })
    .where(and(presas, lt(meetings.attempts, TENTATIVAS_POR_REUNIAO)));
}

const MENSAGEM_DA_FALHA_DA_MONTAGEM = "Não foi possível processar esta reunião. Tente de novo mais tarde.";

/**
 * Reuniões encerradas cujas partes estão todas resolvidas: transcritas ou com
 * falha definitiva, ou ausentes depois da espera.
 */
async function reunioesProntasParaMontar(db: Banco, agora: number, escopo: Escopo) {
  const encerradas = await db.select({ id: meetings.id, ownerId: meetings.ownerId, esperadas: meetings.expectedSlices })
    .from(meetings)
    .where(and(
      eq(meetings.audioPipeline, "slices"), eq(meetings.status, "uploading"),
      or(isNull(meetings.lockedUntil), lt(meetings.lockedUntil, agora)),
      lt(meetings.attempts, TENTATIVAS_POR_REUNIAO),
      daDona(meetings.ownerId, escopo),
    ))
    .limit(10);
  const prontas: typeof encerradas = [];
  for (const r of encerradas) {
    if (!r.esperadas) continue;
    const partes = await db.select({ seq: meetingAudioSlices.seq, status: meetingAudioSlices.status })
      .from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, r.id));
    const resolvidas = partes.filter(p => p.status === "transcribed" || p.status === "failed").length;
    const todasChegaram = partes.length >= r.esperadas;
    if (resolvidas === partes.length && (todasChegaram || agora - await ultimaChegada(db, r.id) > ESPERA_PELA_PARTE_QUE_FALTA_MS)) prontas.push(r);
  }
  return prontas;
}

async function montarUmaReuniao(db: Banco, reuniao: { id: string; ownerId: string; esperadas: number | null }) {
  // A ficha é o updated_at que a tomada grava: é o que gravarResultadoDaReuniao
  // confere antes de escrever, como no envio único.
  const ficha = Date.now();
  const token = novoToken();
  const tomada = await db.update(meetings).set({
    status: "processing", processingError: null, updatedAt: ficha, lockToken: token, lockedUntil: ficha + DURACAO_DA_RESERVA_MS,
    attempts: sql`${meetings.attempts} + 1`,
  }).where(and(
    eq(meetings.id, reuniao.id), eq(meetings.ownerId, reuniao.ownerId), eq(meetings.status, "uploading"),
    or(isNull(meetings.lockedUntil), lt(meetings.lockedUntil, ficha)),
  ));
  if (!linhas(tomada)) {
    tokensVivos.delete(token);
    return;
  }

  try {
    const partes = await db.select({
      seq: meetingAudioSlices.seq, status: meetingAudioSlices.status, offsetMs: meetingAudioSlices.offsetMs,
      durationMs: meetingAudioSlices.durationMs, result: meetingAudioSlices.result,
    }).from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, reuniao.id)).orderBy(asc(meetingAudioSlices.seq));
    const transcritas = partes.filter(p => p.status === "transcribed").map(p => ({
      seq: p.seq, inicioSegundos: Number(p.offsetMs ?? 0) / 1000, duracaoSegundos: p.durationMs / 1000,
      segmentos: ((p.result as { segmentos?: Segmento[] } | null)?.segmentos ?? []),
    }));
    const { segmentos, texto } = montarTranscricao(transcritas, Math.max(reuniao.esperadas ?? 0, ...partes.map(p => p.seq + 1)));
    if (!texto.trim()) throw new Error("Não foi possível transcrever o áudio desta reunião.");
    const [r] = await db.select({ idioma: meetings.language }).from(meetings).where(eq(meetings.id, reuniao.id)).limit(1);
    // A extração lê as falas com o rótulo da voz ("{F1}: fala"), a mesma
    // entrada do resumo: sem ele, a IA não via quem fala e chutava a presença
    // de quem fala sem dizer o próprio nome (revisão do pacote P2B). A
    // transcrição gravada e a conferência continuam no texto sem rótulos.
    const entrada = entradaDoResumo(texto, segmentos);
    const extraction = await comVagaDeIA(() => extrairDadosDaReuniao(entrada.texto, { rotulada: entrada.rotulada }));
    // Só o que foi transcrito conta minutos: a lacuna não é cobrada.
    const durationSeconds = Math.round(partes.filter(p => p.status === "transcribed").reduce((total, p) => total + p.durationMs, 0) / 1000);
    await gravarResultadoDaReuniao(db, {
      meetingId: reuniao.id, ownerId: reuniao.ownerId, ficha, limparAntes: true, durationSeconds,
      transcription: { text: texto, segments: segmentos, language: r?.idioma ?? "pt-BR" },
      extraction,
    });
    await db.update(meetings).set({ lockToken: null, lockedUntil: null }).where(and(eq(meetings.id, reuniao.id), eq(meetings.lockToken, token)));
    for (const gancho of ganchos) {
      try {
        await gancho({ meetingId: reuniao.id, ownerId: reuniao.ownerId });
      } catch (erro) {
        console.error("[Fila] um gancho de reunião pronta falhou:", descreverErroDeBanco(erro));
      }
    }
  } catch (erro) {
    if (erro instanceof ReuniaoExcluidaDuranteProcessamento || erro instanceof ReuniaoTomadaPorOutraExecucao) return;
    console.error("[Fila] a montagem de uma reunião falhou:", descreverErroDeBanco(erro));
    // Falha passageira (IA, banco) devolve a reunião a 'uploading' para outra
    // rodada; esgotadas as tentativas, ou sem texto nenhum, vira falha.
    const [atual] = await db.select({ attempts: meetings.attempts }).from(meetings).where(eq(meetings.id, reuniao.id)).limit(1);
    const passageira = erro instanceof GeminiIndisponivelError || ehErroDeBancoIndisponivel(erro) || (erro as Error)?.message?.startsWith("O serviço de IA");
    const desiste = !passageira || (atual?.attempts ?? TENTATIVAS_POR_REUNIAO) >= TENTATIVAS_POR_REUNIAO;
    await db.update(meetings).set(desiste
      ? { status: "failed", processingError: mensagemDaFalha(erro), lockToken: null, lockedUntil: null, updatedAt: Date.now() }
      : { status: "uploading", lockToken: null, lockedUntil: Date.now() + 60_000, updatedAt: Date.now() },
    ).where(and(eq(meetings.id, reuniao.id), eq(meetings.lockToken, token), eq(meetings.status, "processing")));
  } finally {
    tokensVivos.delete(token);
  }
}

// ─── A rodada ────────────────────────────────────────────────────────────────

/**
 * Uma rodada da fila: encerra as abandonadas, reserva e transcreve as partes
 * prontas e monta as reuniões prontas. Exportada para os testes; em produção é
 * o laço de iniciarFila que a chama.
 */
export async function rodarUmaVez(escopo: Escopo = {}): Promise<void> {
  if (parada) return;
  const db = await exigirDb();
  const agora = Date.now();
  await encerrarAbandonadas(db, agora, escopo);
  await retomarMontagensPresas(db, agora, escopo);
  await desistirDasEsgotadas(db, agora, escopo);
  const trabalhos: Promise<unknown>[] = [];
  // Só tantas partes quantas vagas de IA: a reserva começa a contar na hora, e
  // uma parte reservada esperando vaga no semáforo gastaria o prazo dela parada.
  for (const parte of await partesProntasParaTranscrever(db, agora, escopo, CHAMADAS_DE_IA_AO_MESMO_TEMPO)) {
    if (parada) break;
    const token = await reservarParte(db, parte.id, agora);
    if (token) trabalhos.push(transcreverUmaParte(db, parte, token).finally(() => tokensVivos.delete(token)));
  }
  for (const reuniao of await reunioesProntasParaMontar(db, agora, escopo)) {
    if (parada) break;
    trabalhos.push(montarUmaReuniao(db, reuniao));
  }
  // Cada trabalho já trata o próprio erro; o que ainda escapar (o banco caiu
  // dentro do catch) vira log aqui, e nunca uma rejeição solta, que derrubaria o
  // processo. A reserva desse trabalho vence sozinha e outra rodada o retoma.
  const seguros = trabalhos.map(t => {
    const seguro = t.then(() => undefined, erro => console.error("[Fila] um trabalho falhou sem registro:", descreverErroDeBanco(erro)));
    emCurso.add(seguro);
    void seguro.then(() => emCurso.delete(seguro));
    return seguro;
  });
  await Promise.all(seguros);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let rodando: Promise<void> | null = null;

/** Liga o laço da fila (no boot do servidor, com banco). */
export function iniciarFila(intervaloMs = INTERVALO_DA_RODADA_MS) {
  parada = false;
  const proxima = () => {
    if (parada) return;
    timer = setTimeout(() => {
      // Uma rodada por vez: a seguinte só agenda quando esta termina. A rodada
      // nunca rejeita solta (derrubaria o processo): todo erro vira log.
      rodando = rodarUmaVez()
        .catch(erro => console.error("[Fila] a rodada falhou:", descreverErroDeBanco(erro)))
        .finally(() => { rodando = null; proxima(); });
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/**
 * Desligamento (SIGTERM do Render, SIGINT no dev): para de reservar e DEVOLVE
 * as reservas desta instância — as partes voltam a 'received' sem reserva, e a
 * reunião em montagem volta a 'uploading' —, para o próximo processo retomar
 * na hora. O trabalho em curso é abandonado: as escritas dele conferem o token,
 * que já não vale.
 */
export async function pararFila(): Promise<{ partes: number; reunioes: number }> {
  parada = true;
  clearTimeout(timer);
  let db: Banco;
  try {
    db = await exigirDb();
  } catch (erro) {
    console.error("[Fila] sem banco no desligamento; as reservas vencem sozinhas:", descreverErroDeBanco(erro));
    return { partes: 0, reunioes: 0 };
  }
  // A tentativa devolvida não conta: a parte não falhou, o processo é que saiu.
  const tokens = Array.from(tokensVivos);
  if (!tokens.length) return { partes: 0, reunioes: 0 };
  const partes = await db.update(meetingAudioSlices).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingAudioSlices.attempts} - 1, 0)` })
    .where(and(inArray(meetingAudioSlices.lockToken, tokens), eq(meetingAudioSlices.status, "received")));
  const reunioes = await db.update(meetings).set({ status: "uploading", lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetings.attempts} - 1, 0)` })
    .where(and(inArray(meetings.lockToken, tokens), eq(meetings.status, "processing"), eq(meetings.audioPipeline, "slices")));
  tokensVivos.clear();
  return { partes: linhas(partes), reunioes: linhas(reunioes) };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}

export const _paraTestes = { tokensVivos, novoToken, rodando: () => rodando, emCurso };
