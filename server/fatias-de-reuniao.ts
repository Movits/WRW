import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { meetingAudioSlices, meetings } from "../drizzle/schema";
import { exigirDb } from "./db";
import { storageDelete, storagePut } from "./storage";
import { medirDuracaoDoAudio } from "./duracao-do-audio";
import { ALLOWED_MEETING_AUDIO_TYPES, MEETING_AUDIO_TTL_MS } from "./meeting-service";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";

/**
 * A reunião gravada em partes (G5 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): a reunião nasce no início da
 * gravação, e cada parte (~10 min, um arquivo de áudio válido) chega por um POST
 * binário autenticado (server/_core/rota-das-partes.ts). As partes são internas:
 * quem grava vê uma gravação contínua.
 *
 * Ordem de cada parte: a linha nasce 'uploading' e é COMMITADA antes do upload
 * (ela é o ponteiro para o objeto: um objeto no bucket sem linha seria um órfão
 * que a exclusão da conta não acharia); depois o upload; depois 'received'.
 * Reenviar a mesma parte (mesmo conteúdo) é aceito sem duplicar; conteúdo
 * diferente na mesma posição é recusado.
 */

export const TAMANHO_MAXIMO_DA_PARTE = 16 * 1024 * 1024;
// 10 min de parte, com 2 min de folga: a tela troca de parte pelo relógio dela,
// e a aba em segundo plano atrasa esse relógio (o navegador espaça os timers),
// então a parte de 10 min pode chegar com mais.
export const DURACAO_MAXIMA_DA_PARTE_SEGUNDOS = 12 * 60;
// 12 h em partes de 10 min são 72; 200 deixam folga para partes mais curtas sem
// deixar uma reunião acumular linhas e objetos no bucket sem fim.
export const PARTES_NO_MAXIMO = 200;
/**
 * A folga sobre as 12 h da gravação em partes, só aqui no servidor: a tela para
 * nas 12 h pelo relógio dela, e a soma é das durações MEDIDAS nos bytes, que não
 * batem ao segundo com aquele relógio (nem com o atraso da aba em segundo plano).
 */
export const FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS = 10 * 60;

export type CodigoDaRecusa = "SEM_REUNIAO" | "FORA_DO_ESTADO" | "CONTEUDO_DIFERENTE" | "GRANDE_DEMAIS" | "FORMATO" | "SEM_DURACAO" | "LONGA_DEMAIS" | "POSICAO";

/** Recusa definitiva da parte: reenviar a mesma coisa não muda a resposta. */
export class RecusaDaParte extends Error {
  constructor(readonly codigo: CodigoDaRecusa, mensagem: string) {
    super(mensagem);
  }
}

/** Falha passageira (bucket fora): a mesma parte pode ser reenviada depois. */
export class FalhaPassageiraDaParte extends Error {}

const EXTENSAO: Record<string, string> = { "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav" };

export async function receberParte(entrada: { ownerId: string; meetingId: string; seq: number; mimeType: string; bytes: Buffer }) {
  const { ownerId, meetingId, seq, bytes } = entrada;
  const mimeType = entrada.mimeType.split(";")[0].trim().toLowerCase();
  if (!Number.isInteger(seq) || seq < 0 || seq >= PARTES_NO_MAXIMO) throw new RecusaDaParte("POSICAO", "Parte fora de ordem.");
  if (!(ALLOWED_MEETING_AUDIO_TYPES as readonly string[]).includes(mimeType)) throw new RecusaDaParte("FORMATO", "Formato de áudio não suportado.");
  if (!bytes.length || bytes.length > TAMANHO_MAXIMO_DA_PARTE) throw new RecusaDaParte("GRANDE_DEMAIS", "Parte de áudio vazia ou grande demais.");
  const duracao = medirDuracaoDoAudio(bytes);
  if (duracao === null || duracao <= 0) throw new RecusaDaParte("SEM_DURACAO", "Não foi possível ler a duração desta parte do áudio.");
  if (duracao > DURACAO_MAXIMA_DA_PARTE_SEGUNDOS) throw new RecusaDaParte("LONGA_DEMAIS", "Parte de áudio longa demais.");

  const db = await exigirDb();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const agora = Date.now();

  // A decisão (a reunião aceita esta parte? cabe no teto? a posição é nova?) e o
  // INSERT correm numa transação com a linha da reunião TRAVADA (FOR UPDATE):
  // o encerrar trava a mesma linha, então uma parte além do total não entra
  // entre a conferência e o fim, e duas partes ao mesmo tempo não passam juntas
  // pelo teto de tempo.
  const decisao = await db.transaction(async tx => {
    const [reuniao] = await tx.select({
      status: meetings.status, pipeline: meetings.audioPipeline, consentimento: meetings.consentGranted, esperadas: meetings.expectedSlices,
    }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1).for("update");
    // Reunião de outra dona e reunião que não existe respondem igual.
    if (!reuniao) throw new RecusaDaParte("SEM_REUNIAO", "Reunião não encontrada.");
    if (reuniao.pipeline !== "slices" || !reuniao.consentimento || !["recording", "uploading"].includes(reuniao.status)) {
      throw new RecusaDaParte("FORA_DO_ESTADO", "Esta reunião não está recebendo áudio.");
    }
    // Depois do fim, só as partes que faltavam até o total declarado.
    if (reuniao.esperadas !== null && seq >= reuniao.esperadas) throw new RecusaDaParte("POSICAO", "Parte além do total da gravação.");

    const existente = await lerParte(tx, meetingId, seq);
    if (existente && existente.sha256 !== sha256) throw new RecusaDaParte("CONTEUDO_DIFERENTE", "Esta parte da gravação já chegou com outro conteúdo.");
    if (existente) return existente.status === "uploading" ? { linha: existente } : { repetida: true as const };

    // O teto da reunião em partes é técnico, contra gasto (G13a): 12 h, com a
    // folga do servidor. O envio único segue com os 10 min dele.
    const [soma] = await tx.select({ ms: sql<number>`coalesce(sum(${meetingAudioSlices.durationMs}), 0)` })
      .from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId));
    if (Number(soma?.ms ?? 0) / 1000 + duracao > GRAVACAO_EM_PARTES_SEGUNDOS_MAX + FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS) {
      throw new RecusaDaParte("LONGA_DEMAIS", "A gravação passou do limite de tempo por reunião.");
    }
    // A chave é EXATA (sem o sufixo aleatório do storagePut) e leva o id da
    // linha: a linha gravada antes do upload aponta para o objeto que vai
    // existir, e o reenvio da mesma parte sobrescreve o mesmo objeto.
    const id = crypto.randomUUID();
    const chave = `meetings/${ownerId}/${meetingId}/partes/${String(seq).padStart(4, "0")}-${id.slice(0, 8)}.${EXTENSAO[mimeType] ?? "bin"}`;
    const nova = {
      id, meetingId, ownerId, seq, status: "uploading" as const,
      storageKey: chave, storageUrl: `/manus-storage/${chave}`, mimeType, sizeBytes: bytes.length, sha256,
      durationMs: Math.round(duracao * 1000), expiresAt: agora + MEETING_AUDIO_TTL_MS, createdAt: agora, updatedAt: agora,
    };
    // Com a reunião travada, dois envios da mesma parte se enfileiram aqui: o
    // segundo já acha a linha acima. O UNIQUE (reunião, posição) segue de guarda.
    await tx.insert(meetingAudioSlices).values(nova);
    return { linha: nova };
  });
  if ("repetida" in decisao) return { seq, repetida: true };
  const linha = decisao.linha;

  try {
    await storagePut(linha.storageKey, bytes, mimeType, { chaveExata: true });
  } catch (erro) {
    console.error("[Reuniões] o bucket recusou uma parte do áudio:", erro instanceof Error ? erro.message : erro);
    throw new FalhaPassageiraDaParte("Não foi possível guardar esta parte do áudio agora.", { cause: erro });
  }
  const recebida = await db.update(meetingAudioSlices).set({ status: "received", updatedAt: Date.now() })
    .where(and(eq(meetingAudioSlices.id, linha.id), eq(meetingAudioSlices.status, "uploading")));
  if (!linhasAlcancadas(recebida)) {
    // A linha sumiu (a reunião foi excluída durante o upload) ou outro envio
    // simultâneo já a marcou. Sumiu: o objeto que acabou de subir sai também,
    // para nenhuma voz ficar no bucket sem ponteiro.
    const ainda = await lerParte(db, meetingId, seq);
    if (!ainda) {
      await storageDelete(linha.storageKey).catch(erro => console.warn("[Reuniões] a parte de uma reunião excluída ficou no bucket:", erro instanceof Error ? erro.message : erro));
      throw new RecusaDaParte("SEM_REUNIAO", "Reunião não encontrada.");
    }
    return { seq, repetida: true };
  }
  return { seq, repetida: false };
}

type LeitorDoBanco = Pick<Awaited<ReturnType<typeof exigirDb>>, "select">;

async function lerParte(db: LeitorDoBanco, meetingId: string, seq: number) {
  const [linha] = await db.select({
    id: meetingAudioSlices.id, sha256: meetingAudioSlices.sha256, status: meetingAudioSlices.status, storageKey: meetingAudioSlices.storageKey,
  }).from(meetingAudioSlices).where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.seq, seq))).limit(1);
  return linha ?? null;
}

/**
 * A reunião em partes nasce no INÍCIO da gravação (com o consentimento e a
 * versão do aviso, como no envio único), para cada parte ter onde chegar.
 */
export async function iniciarReuniaoEmPartes(ownerId: string, entrada: {
  title: string; language: string; consentNoticeVersion: string | null; origem: "gravacao" | "arquivo" | "aba";
  contactId?: number | null; contextId?: string | null;
}) {
  const db = await exigirDb();
  const agora = Date.now();
  const id = crypto.randomUUID();
  await db.insert(meetings).values({
    id, ownerId, title: entrada.title, contactId: entrada.contactId ?? null, contextId: entrada.contextId ?? null,
    status: "recording", consentGranted: true, consentAt: agora, consentNoticeVersion: entrada.consentNoticeVersion,
    language: entrada.language, audioPipeline: "slices", origem: entrada.origem, createdAt: agora, updatedAt: agora,
  });
  return { id };
}

/**
 * Fim da gravação: a tela diz quantas partes ela teve. A reunião passa a
 * 'uploading' (gravação encerrada, partes ainda podem estar chegando) e guarda
 * o total, que a fila (G7) usa para saber quando a última chegou. Repetir o
 * mesmo fim é aceito; outro total depois do fim, não.
 */
export async function encerrarGravacaoEmPartes(ownerId: string, meetingId: string, partes: number) {
  if (!Number.isInteger(partes) || partes < 1 || partes > PARTES_NO_MAXIMO) throw new RecusaDaParte("POSICAO", "Número de partes inválido.");
  const db = await exigirDb();
  // Trava a linha da reunião, como receberParte: nenhuma parte entra entre a
  // conferência da maior posição e o fim.
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({ status: meetings.status, pipeline: meetings.audioPipeline, esperadas: meetings.expectedSlices })
      .from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1).for("update");
    if (!reuniao) throw new RecusaDaParte("SEM_REUNIAO", "Reunião não encontrada.");
    if (reuniao.pipeline !== "slices") throw new RecusaDaParte("FORA_DO_ESTADO", "Esta reunião não está recebendo áudio.");
    if (reuniao.status === "uploading" && reuniao.esperadas === partes) return { partes };
    if (reuniao.status !== "recording") throw new RecusaDaParte("FORA_DO_ESTADO", "Esta gravação já foi encerrada.");
    // Uma parte que já chegou além do total declarado seria descartada pela
    // montagem: o total não pode ser menor que a maior posição recebida.
    const [maior] = await tx.select({ seq: sql<number | null>`max(${meetingAudioSlices.seq})` })
      .from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId));
    if (maior?.seq !== null && maior?.seq !== undefined && Number(maior.seq) >= partes) {
      throw new RecusaDaParte("POSICAO", "Chegaram mais partes do que a gravação diz ter.");
    }
    await tx.update(meetings).set({ status: "uploading", expectedSlices: partes, updatedAt: Date.now() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
    return { partes };
  });
}

function linhasAlcancadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}
