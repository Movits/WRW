import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { MENSAGEM_FALHA_DA_MONTAGEM, MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO, MENSAGEM_PARTES_SEM_TRANSCRICAO } from "@shared/const";
import { idiomaDaTranscricao } from "@shared/idioma-da-reuniao";
import { contasDasVozes, nomesDosFalantes } from "@shared/const";
import { ROTULO_DA_VOZ_DA_DONA } from "@shared/perfil-de-voz";
import { meetingAudioSlices, meetings } from "../drizzle/schema";
import { amostraDaVozDaDona } from "./perfil-de-voz";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { foraDaLixeira } from "./reuniao-visivel";
import { GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError } from "./gemini";
import { extrairDadosDaReuniao, gravarResultadoDaReuniao, mensagemDaFalha, ReuniaoExcluidaDuranteProcessamento, ReuniaoTomadaPorOutraExecucao } from "./meeting-service";
import { ObjetoAusenteNoStorageError, storageGetBytes } from "./storage";
import { entradaDoResumo } from "./resumo-da-reuniao";
import { TAMANHO_MAXIMO_DA_PARTE } from "./fatias-de-reuniao";
import {
  contasComAVozDaDona, contextoParaAProxima, deslocarRotulosDasFalas, DURACAO_DA_FATIA_SEGUNDOS, ehInicioDeOutraReuniao, MARCA_DA_VOZ_DA_DONA, MARCA_DE_OUTRA_REUNIAO,
  montarTranscricao, numeroDoRotulo, parteUsouAVozDaDona, TemposForaDaParteError, transcreverFatia, type ContextoDaFatiaAnterior, type Segmento,
} from "./transcricao-de-fatia";

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
      // A reunião na lixeira (H7d) fica fora da fila: as partes dela esperam,
      // e a fila as transcreve se a dona a restaurar.
      foraDaLixeira(),
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
 *
 * As varreduras desta fila travam só pela chave: as linhas saem de uma leitura
 * sem trava, e cada uma muda num UPDATE pelo id que repete as condições (a que
 * mudou no meio não casa mais e fica). O UPDATE pela condição travava o
 * intervalo inteiro do índice que ele percorre, com o vão até a linha
 * seguinte, que é de outra reunião ou de outra dona; quem inseria ou movia uma
 * linha ali se travava com ele (deadlock no laço dos testes de integração, que
 * rodam em paralelo no mesmo banco).
 */
async function desistirDasEsgotadas(db: Banco, agora: number, escopo: Escopo) {
  // A parte cuja linha nasceu e cujo objeto nunca subiu (o bucket recusou e a
  // aba fechou): passada a espera, é lacuna, como a que nem chegou.
  const naoRecebida = (id?: string) => and(
    id ? eq(meetingAudioSlices.id, id) : undefined,
    eq(meetingAudioSlices.status, "uploading"),
    lt(meetingAudioSlices.createdAt, agora - ESPERA_PELA_PARTE_QUE_FALTA_MS),
    daDona(meetingAudioSlices.ownerId, escopo),
  );
  for (const { id } of await db.select({ id: meetingAudioSlices.id }).from(meetingAudioSlices).where(naoRecebida())) {
    await db.update(meetingAudioSlices).set({ status: "failed", lastError: "NAO_RECEBIDA", updatedAt: agora }).where(naoRecebida(id));
  }
  const esgotada = (id?: string) => and(
    id ? eq(meetingAudioSlices.id, id) : undefined,
    eq(meetingAudioSlices.status, "received"),
    sql`${meetingAudioSlices.attempts} >= ${TENTATIVAS_POR_PARTE}`,
    or(isNull(meetingAudioSlices.lockedUntil), lt(meetingAudioSlices.lockedUntil, agora)),
    daDona(meetingAudioSlices.ownerId, escopo),
  );
  for (const { id } of await db.select({ id: meetingAudioSlices.id }).from(meetingAudioSlices).where(esgotada())) {
    await db.update(meetingAudioSlices).set({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS", lockToken: null, lockedUntil: null, updatedAt: agora })
      .where(esgotada(id));
  }
}

/**
 * O que a parte anterior passa adiante: onde a reunião está e quem já falou.
 *
 * Na reunião juntada que retranscreve (H17), a primeira parte de cada reunião
 * juntada traz a marca de outra conversa (MARCA_DE_OUTRA_REUNIAO, em
 * server/transcricao-de-fatia.ts); a parte que vem depois de uma dessas sem
 * nenhuma transcrita da mesma conversa no meio (a marcada falhou de vez)
 * também começa outra conversa. Aí não vai `anterior`: vem `rotulosUsados`,
 * os rótulos que as partes de antes já usam, para a fila pôr os desta parte
 * depois deles.
 *
 * `vozDaDonaContinua` (H3d): esta parte pode levar a amostra da voz da dona
 * sem trocar quem é o rótulo fixo dela. Na mesma conversa, só se a parte
 * anterior transcrita também levou (ou não há nenhuma); na outra conversa, só
 * se todas as transcritas antes levaram. Uma reunião que começou sem a amostra
 * (o perfil gravado no meio dela) segue sem ela até o fim.
 */
async function contextoDaAnterior(db: Banco, meetingId: string, seq: number, propria: unknown): Promise<{ inicioMs: number; anterior?: ContextoDaFatiaAnterior; rotulosUsados?: string[]; vozDaDonaContinua: boolean }> {
  if (seq === 0) return { inicioMs: 0, vozDaDonaContinua: true };
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
  // De trás para a frente: a primeira transcrita é da mesma conversa, a não ser
  // que antes dela apareça o começo de outra que não foi transcrita.
  let outraConversa = ehInicioDeOutraReuniao(propria);
  let ultimaTranscrita: (typeof anteriores)[number] | undefined;
  if (!outraConversa) {
    for (const parte of [...anteriores].reverse()) {
      if (parte.status === "transcribed") { ultimaTranscrita = parte; break; }
      if (ehInicioDeOutraReuniao(parte.result)) { outraConversa = true; break; }
    }
  }
  if (outraConversa) {
    const rotulos = new Set<string>();
    for (const parte of anteriores) {
      if (parte.status !== "transcribed") continue;
      const r = parte.result as { segmentos?: Array<{ falante?: unknown }>; contexto?: { falantes?: unknown } } | null;
      for (const segmento of Array.isArray(r?.segmentos) ? r.segmentos : []) if (numeroDoRotulo(segmento?.falante)) rotulos.add(String(segmento.falante));
      for (const falante of Array.isArray(r?.contexto?.falantes) ? r.contexto.falantes : []) if (numeroDoRotulo(falante)) rotulos.add(String(falante));
    }
    const vozDaDonaContinua = anteriores.filter(parte => parte.status === "transcribed").every(parte => parteUsouAVozDaDona(parte.result));
    return { inicioMs, rotulosUsados: Array.from(rotulos).sort((a, b) => numeroDoRotulo(a) - numeroDoRotulo(b)), vozDaDonaContinua };
  }
  const contexto = (ultimaTranscrita?.result as { contexto?: ContextoDaFatiaAnterior } | null)?.contexto;
  return { inicioMs, anterior: contexto, vozDaDonaContinua: !ultimaTranscrita || parteUsouAVozDaDona(ultimaTranscrita.result) };
}

async function transcreverUmaParte(db: Banco, parte: { id: string; meetingId: string; seq: number }, token: string) {
  const [linha] = await db.select({
    ownerId: meetingAudioSlices.ownerId, storageKey: meetingAudioSlices.storageKey, mimeType: meetingAudioSlices.mimeType,
    durationMs: meetingAudioSlices.durationMs, attempts: meetingAudioSlices.attempts, idioma: meetings.language, result: meetingAudioSlices.result,
  }).from(meetingAudioSlices)
    .innerJoin(meetings, and(eq(meetings.id, meetingAudioSlices.meetingId), eq(meetings.ownerId, meetingAudioSlices.ownerId)))
    .where(and(eq(meetingAudioSlices.id, parte.id), eq(meetingAudioSlices.lockToken, token))).limit(1);
  if (!linha) return;
  // A reserva já somou esta tentativa: na última, a G6 aceita a parte com os
  // tempos degradados (e devolve as contagens) em vez de pedir outra.
  const ultimaTentativa = linha.attempts >= TENTATIVAS_POR_PARTE;
  try {
    const { inicioMs, anterior, rotulosUsados, vozDaDonaContinua } = await contextoDaAnterior(db, parte.meetingId, parte.seq, linha.result);
    const audio = await storageGetBytes(linha.storageKey, TAMANHO_MAXIMO_DA_PARTE);
    // O perfil de voz da dona (H3d, server/perfil-de-voz.ts): a amostra vai
    // junto, e a voz dela sai com o rótulo fixo. Sem perfil, como antes.
    let amostra = vozDaDonaContinua ? await amostraDaVozDaDona(db, linha.ownerId) : null;
    const transcrever = (amostraDaVoz: typeof amostra) => comVagaDeIA(() => transcreverFatia({
      audio, mimeType: linha.mimeType, idioma: linha.idioma, inicioSegundos: inicioMs / 1000, duracaoSegundos: linha.durationMs / 1000, anterior,
      ultimaTentativa, ...(amostraDaVoz ? { amostraDaVoz } : {}),
    }));
    let transcrita: Awaited<ReturnType<typeof transcrever>>;
    try {
      transcrita = await transcrever(amostra);
    } catch (erro) {
      // A IA recusou o pedido com a amostra (uma amostra corrompida dá 400) ou
      // cortou a resposta: a parte não paga pela amostra. Vai de novo, na mesma
      // tentativa, sem ela, e fica sem a marca da voz da dona (as partes
      // seguintes também seguem sem a amostra, e a montagem não liga o F1).
      if (!amostra || !(erro instanceof GeminiRecusouChamadaError || erro instanceof GeminiRespostaCortadaError)) throw erro;
      console.warn(`[Fila] a IA não aceitou a parte ${parte.seq} com a amostra da voz da dona (${codigoDoErro(erro)}); vai sem ela`);
      amostra = null;
      transcrita = await transcrever(null);
    }
    const { modelo, tempos } = transcrita;
    // Outra conversa (a junção, H17): a IA rotulou as vozes do zero (F1, F2...),
    // e os rótulos vão para depois dos que as partes de antes já usam. Com a
    // amostra, a dona fica no rótulo fixo (é a mesma pessoa nas reuniões
    // juntadas, todas dela) e as outras, que a IA começou em F2, vão para
    // depois dos usados.
    const outraConversa = rotulosUsados !== undefined;
    const maiorUsado = outraConversa ? Math.max(0, ...rotulosUsados.map(numeroDoRotulo)) : 0;
    const segmentos = !outraConversa
      ? transcrita.segmentos
      : amostra
        ? deslocarRotulosDasFalas(transcrita.segmentos, Math.max(0, maiorUsado - 1), [ROTULO_DA_VOZ_DA_DONA])
        : deslocarRotulosDasFalas(transcrita.segmentos, maiorUsado);
    const contexto = contextoParaAProxima(segmentos, outraConversa ? { falantes: rotulosUsados, ultimasFalas: [] } : anterior);
    // A marca da outra conversa fica no result depois de transcrita: se a parte
    // seguinte falhar de vez, a de depois dela não herda a conversa de antes.
    const marca = ehInicioDeOutraReuniao(linha.result) ? { [MARCA_DE_OUTRA_REUNIAO]: true } : {};
    // Só grava quem ainda tem a reserva: outra instância que a retomou depois
    // de vencer, ou a exclusão da reunião, vencem esta escrita. A parte aceita
    // com os tempos degradados leva as contagens (`tempos`) no result, para
    // uma consulta achá-la.
    await db.update(meetingAudioSlices).set({
      status: "transcribed", result: { segmentos, contexto, ...(tempos ? { tempos } : {}), ...marca, ...(amostra ? { [MARCA_DA_VOZ_DA_DONA]: true } : {}) },
      model: modelo.slice(0, 80), offsetMs: inicioMs,
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
      await db.update(meetings).set({ status: "failed", processingError: MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO, updatedAt: agora })
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
  // Pela chave, como as varreduras das partes (desistirDasEsgotadas): a leitura
  // não trava, e cada UPDATE pelo id repete as condições.
  const presa = (id?: string) => and(
    id ? eq(meetings.id, id) : undefined,
    eq(meetings.audioPipeline, "slices"), eq(meetings.status, "processing"), lt(meetings.lockedUntil, agora), daDona(meetings.ownerId, escopo),
  );
  for (const { id, attempts } of await db.select({ id: meetings.id, attempts: meetings.attempts }).from(meetings).where(presa())) {
    // Esgotadas as tentativas (o processo caiu em todas), vira falha; senão, volta.
    if (attempts >= TENTATIVAS_POR_REUNIAO) {
      await db.update(meetings).set({ status: "failed", processingError: MENSAGEM_FALHA_DA_MONTAGEM, lockToken: null, lockedUntil: null, updatedAt: agora })
        .where(and(presa(id), sql`${meetings.attempts} >= ${TENTATIVAS_POR_REUNIAO}`));
    } else {
      await db.update(meetings).set({ status: "uploading", lockToken: null, lockedUntil: null })
        .where(and(presa(id), lt(meetings.attempts, TENTATIVAS_POR_REUNIAO)));
    }
  }
}

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
      foraDaLixeira(),
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
    or(isNull(meetings.lockedUntil), lt(meetings.lockedUntil, ficha)), foraDaLixeira(),
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
    // A frase é compartilhada (shared/const.ts): a tela a mostra no idioma da dona.
    if (!texto.trim()) throw new Error(MENSAGEM_PARTES_SEM_TRANSCRICAO);
    const [r] = await db.select({ idioma: meetings.language, speakerAccounts: meetings.speakerAccounts, speakerNames: meetings.speakerNames }).from(meetings)
      .where(and(eq(meetings.id, reuniao.id), eq(meetings.ownerId, reuniao.ownerId))).limit(1);
    // A voz da dona reconhecida pela amostra (H3d) já sai ligada à conta dela,
    // menos se a dona deu nome livre ao rótulo (ela soltou a conta).
    const contasDasVozesNovas = contasComAVozDaDona(partes, segmentos, contasDasVozes(r?.speakerAccounts), nomesDosFalantes(r?.speakerNames));
    // A extração lê as falas com o rótulo da voz ("{F1}: fala"), a mesma
    // entrada do resumo: sem ele, a IA não via quem fala e chutava a presença
    // de quem fala sem dizer o próprio nome (revisão do pacote P2B). A
    // transcrição gravada e a conferência continuam no texto sem rótulos.
    const entrada = entradaDoResumo(texto, segmentos);
    const extraction = await comVagaDeIA(() => extrairDadosDaReuniao(entrada.texto, { rotulada: entrada.rotulada }));
    // Só o que foi transcrito conta minutos: a lacuna não é cobrada.
    const durationSeconds = Math.round(partes.filter(p => p.status === "transcribed").reduce((total, p) => total + p.durationMs, 0) / 1000);
    // Os nomes das vozes ficam (zerarNomes: false): a montagem relê as falas
    // que as partes guardam, com os mesmos rótulos. O reprocesso, que
    // transcreve de novo, os zera antes (em meeting-service.ts). A junção
    // (server/juntar-reunioes.ts) traz os nomes das reuniões juntadas já nos
    // rótulos novos; quando ela retranscreve, ficam só os de antes da primeira
    // parte retranscrita, e cada reunião retranscrita começa depois dos
    // rótulos já usados (contextoDaAnterior), sem herdar as vozes nem os nomes.
    await gravarResultadoDaReuniao(db, {
      meetingId: reuniao.id, ownerId: reuniao.ownerId, ficha, limparAntes: true, zerarNomes: false, durationSeconds,
      ...(contasDasVozesNovas ? { contasDasVozes: contasDasVozesNovas } : {}),
      // Com "Detectar sozinho" (G16), o idioma da transcrição (e do resumo) é o
      // que mais aparece nas falas de todas as partes; senão, o escolhido.
      transcription: { text: texto, segments: segmentos, language: idiomaDaTranscricao(r?.idioma, segmentos) },
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
  // Cada reserva volta pela chave da linha, com o token no WHERE. O UPDATE por
  // `lock_token IN (...)` não tem índice para a coluna: varria as partes em
  // 'received' e as reuniões em montagem de todas as donas, travando cada uma,
  // e se travava com quem as movia no índice. As linhas saem de uma leitura
  // sem trava pelo índice do estado.
  const parteNaFila = (token: string, id?: string) => and(id ? eq(meetingAudioSlices.id, id) : undefined, eq(meetingAudioSlices.status, "received"), eq(meetingAudioSlices.lockToken, token));
  const emMontagem = (token: string, id?: string) => and(id ? eq(meetings.id, id) : undefined, eq(meetings.audioPipeline, "slices"), eq(meetings.status, "processing"), eq(meetings.lockToken, token));
  let partes = 0;
  const reservasDePartes = await db.select({ id: meetingAudioSlices.id, token: meetingAudioSlices.lockToken }).from(meetingAudioSlices)
    .where(and(eq(meetingAudioSlices.status, "received"), inArray(meetingAudioSlices.lockToken, tokens)));
  for (const { id, token } of reservasDePartes) {
    if (!token) continue;
    partes += linhas(await db.update(meetingAudioSlices).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingAudioSlices.attempts} - 1, 0)` })
      .where(parteNaFila(token, id)));
  }
  let reunioes = 0;
  const reservasDeReunioes = await db.select({ id: meetings.id, token: meetings.lockToken }).from(meetings)
    .where(and(eq(meetings.audioPipeline, "slices"), eq(meetings.status, "processing"), inArray(meetings.lockToken, tokens)));
  for (const { id, token } of reservasDeReunioes) {
    if (!token) continue;
    reunioes += linhas(await db.update(meetings).set({ status: "uploading", lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetings.attempts} - 1, 0)` })
      .where(emMontagem(token, id)));
  }
  tokensVivos.clear();
  return { partes, reunioes };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}

// montarUmaReuniao entra para o teste da tomada: a reunião que vai para a
// lixeira entre a seleção (reunioesProntasParaMontar) e a tomada não é tomada.
export const _paraTestes = { tokensVivos, novoToken, rodando: () => rodando, emCurso, montarUmaReuniao };
