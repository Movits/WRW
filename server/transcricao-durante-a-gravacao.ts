import { and, asc, eq, inArray } from "drizzle-orm";
import { nomesDosFalantes } from "@shared/const";
import { meetingAudioSlices, meetings } from "../drizzle/schema";
import { exigirDb } from "./db";
import { reuniaoForaDeVista } from "./reuniao-visivel";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { DURACAO_DA_FATIA_SEGUNDOS, montarTranscricao, type Segmento } from "./transcricao-de-fatia";

/**
 * A transcrição durante a gravação (G15a; HN-19 e HN-20 do HiNoter). A fila do
 * servidor já transcreve cada parte de ~10 min enquanto a reunião ainda grava
 * (server/fila-de-transcricao.ts pega as partes de reunião em "recording"):
 * aqui a dona lê o texto das partes prontas, com o andamento e o atraso de
 * cada uma, e pergunta à IA sobre o que já foi dito (perguntarDuranteAGravacao,
 * em server/reuniao-com-ia.ts). Não custa IA a mais: o texto é o que a fila já
 * gravou em meeting_audio_slices.result.
 *
 * Só a dona: o ownerId vai no WHERE de todas as leituras, e a reunião de outra
 * dona é "não encontrada" (nula). O texto é a fala de quem participou, como a
 * transcrição de sempre, e nada daqui vai ao link aberto. Banco fora do ar
 * sobe como erro (o middleware do tRPC o traduz), nunca vira "sem partes".
 *
 * A tela pede de tempos em tempos e só recebe o texto das partes que ainda não
 * tem (`desde`, a quantidade de partes resolvidas que ela já guarda, na ordem):
 * a parte transcrita não muda mais, e uma reunião de horas não trafega o texto
 * inteiro a cada pedido. O resto (o andamento de cada parte) vem sempre.
 */

/** O andamento de uma parte, para a tela: subindo, na fila, sendo transcrita, transcrita ou sem texto (a falha definitiva). */
export type EstadoDaParteNaGravacao = "enviando" | "na_fila" | "transcrevendo" | "transcrita" | "falhou";

export type ParteDaGravacao = {
  seq: number;
  estado: EstadoDaParteNaGravacao;
  /** Onde a parte começa na reunião e quanto ela dura, em segundos. */
  inicioSegundos: number;
  duracaoSegundos: number;
  /** Quando a parte chegou ao servidor e, transcrita, quando o texto ficou pronto (ms, relógio do servidor). */
  chegouEm: number;
  prontaEm: number | null;
  /** O atraso da parte: da chegada ao texto pronto, em segundos. Nulo antes de ela ser transcrita. */
  atrasoSegundos: number | null;
};

export type TranscricaoDaGravacao = {
  /** O status da reunião: a tela para de perguntar quando ela deixa de estar em andamento. */
  status: string;
  /** Se a reunião é gravada em partes; no envio único, não há o que mostrar durante a gravação. */
  emPartes: boolean;
  /** A hora do servidor, para a tela contar "chegou há..." sem depender do relógio do aparelho. */
  agora: number;
  partes: ParteDaGravacao[];
  /** As falas das partes transcritas a partir de `desde` (no máximo PARTES_COM_TEXTO_POR_CONSULTA por pedido). */
  falas: Array<{ seq: number; segmentos: Segmento[] }>;
  /** Os nomes que a dona deu às vozes (H3), como no detalhe dela. */
  nomes: Record<string, string>;
};

/** Quantas partes com texto vão num pedido: o resto vem nos pedidos seguintes. */
export const PARTES_COM_TEXTO_POR_CONSULTA = 12;

/** Os status em que a reunião em partes ainda está "em andamento": gravando, recebendo as últimas partes ou montando a transcrição. */
const EM_ANDAMENTO = ["recording", "uploading", "processing"] as const;
export function reuniaoEmAndamento(status: string): boolean {
  return (EM_ANDAMENTO as readonly string[]).includes(status);
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** As partes de uma reunião da dona, sem o texto (o result é pesado), na ordem. */
async function partesDaReuniao(db: Banco, ownerId: string, meetingId: string) {
  return db.select({
    seq: meetingAudioSlices.seq, status: meetingAudioSlices.status, durationMs: meetingAudioSlices.durationMs,
    offsetMs: meetingAudioSlices.offsetMs, lockedUntil: meetingAudioSlices.lockedUntil,
    createdAt: meetingAudioSlices.createdAt, updatedAt: meetingAudioSlices.updatedAt,
  }).from(meetingAudioSlices)
    .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)))
    .orderBy(asc(meetingAudioSlices.seq));
}

/**
 * O andamento de cada parte. O início é o que a transcrição gravou (offset) ou,
 * antes dela, a soma das anteriores, com a duração padrão no lugar da parte
 * que ainda não chegou, como a fila conta (contextoDaAnterior).
 */
export function andamentoDasPartes(linhas: Awaited<ReturnType<typeof partesDaReuniao>>, agora: number): ParteDaGravacao[] {
  const porSeq = new Map(linhas.map(linha => [linha.seq, linha]));
  const saida: ParteDaGravacao[] = [];
  let inicioMs = 0;
  const maior = linhas.reduce((m, linha) => Math.max(m, linha.seq), -1);
  for (let seq = 0; seq <= maior; seq++) {
    const linha = porSeq.get(seq);
    if (!linha) {
      inicioMs += DURACAO_DA_FATIA_SEGUNDOS * 1000;
      continue;
    }
    const inicio = linha.offsetMs !== null && linha.offsetMs !== undefined ? Number(linha.offsetMs) : inicioMs;
    const estado: EstadoDaParteNaGravacao = linha.status === "uploading" ? "enviando"
      : linha.status === "transcribed" ? "transcrita"
      : linha.status === "failed" ? "falhou"
      : linha.lockedUntil !== null && Number(linha.lockedUntil) > agora ? "transcrevendo"
      : "na_fila";
    const transcrita = estado === "transcrita";
    saida.push({
      seq,
      estado,
      inicioSegundos: inicio / 1000,
      duracaoSegundos: linha.durationMs / 1000,
      chegouEm: Number(linha.createdAt),
      prontaEm: transcrita ? Number(linha.updatedAt) : null,
      atrasoSegundos: transcrita ? Math.max(0, Math.round((Number(linha.updatedAt) - Number(linha.createdAt)) / 1000)) : null,
    });
    inicioMs = inicio + linha.durationMs;
  }
  return saida;
}

/**
 * A transcrição da reunião da dona durante a gravação. Nula quando a reunião
 * não existe, é de outra dona ou foi excluída. Fora do andamento (pronta, com
 * falha) e no envio único, vem sem partes: o detalhe mostra a transcrição de
 * sempre.
 */
export async function transcricaoDuranteAGravacao(ownerId: string, meetingId: string, desde: number): Promise<TranscricaoDaGravacao | null> {
  const db = await exigirDb();
  const [reuniao] = await db.select({ status: meetings.status, audioPipeline: meetings.audioPipeline, speakerNames: meetings.speakerNames, trashedAt: meetings.trashedAt })
    .from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  // A da lixeira (H7d) é "não encontrada", como a excluída.
  if (!reuniao || reuniaoForaDeVista(reuniao)) return null;
  const agora = Date.now();
  const emPartes = reuniao.audioPipeline === "slices";
  const nomes = nomesDosFalantes(reuniao.speakerNames);
  if (!emPartes || !reuniaoEmAndamento(reuniao.status)) return { status: reuniao.status, emPartes, agora, partes: [], falas: [], nomes };
  const partes = andamentoDasPartes(await partesDaReuniao(db, ownerId, meetingId), agora);
  const comTexto = partes.filter(parte => parte.estado === "transcrita" && parte.seq >= desde).slice(0, PARTES_COM_TEXTO_POR_CONSULTA).map(parte => parte.seq);
  const resultados = comTexto.length
    ? await db.select({ seq: meetingAudioSlices.seq, result: meetingAudioSlices.result }).from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.seq, comTexto)))
    : [];
  const falas = resultados
    .map(linha => ({ seq: linha.seq, segmentos: segmentosDoContrato((linha.result as { segmentos?: unknown } | null)?.segmentos) as Segmento[] }))
    .sort((a, b) => a.seq - b.seq);
  return { status: reuniao.status, emPartes, agora, partes, falas, nomes };
}

/**
 * O texto das partes já transcritas, para a pergunta durante a gravação: as
 * falas na ordem, com a lacuna no lugar da parte do meio que falhou ou ainda
 * não chegou, e sem as partes depois da última transcrita (o que ainda não tem
 * texto não entra). `ateSegundos` é onde o texto termina na reunião.
 */
export async function transcricaoDasPartesProntas(db: Banco, ownerId: string, meetingId: string): Promise<{ texto: string; segmentos: Segmento[]; ateSegundos: number }> {
  const linhas = await db.select({
    seq: meetingAudioSlices.seq, status: meetingAudioSlices.status, offsetMs: meetingAudioSlices.offsetMs,
    durationMs: meetingAudioSlices.durationMs, result: meetingAudioSlices.result,
  }).from(meetingAudioSlices)
    .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId), eq(meetingAudioSlices.status, "transcribed")))
    .orderBy(asc(meetingAudioSlices.seq));
  if (!linhas.length) return { texto: "", segmentos: [], ateSegundos: 0 };
  const transcritas = linhas.map(linha => ({
    seq: linha.seq, inicioSegundos: Number(linha.offsetMs ?? 0) / 1000, duracaoSegundos: linha.durationMs / 1000,
    segmentos: segmentosDoContrato((linha.result as { segmentos?: unknown } | null)?.segmentos) as Segmento[],
  }));
  const ultima = transcritas[transcritas.length - 1];
  const { texto, segmentos } = montarTranscricao(transcritas, ultima.seq + 1);
  return { texto, segmentos, ateSegundos: ultima.inicioSegundos + ultima.duracaoSegundos };
}
