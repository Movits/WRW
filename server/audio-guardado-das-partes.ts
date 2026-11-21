import type { ParteDoAudio } from "./conversao-do-audio";

/**
 * Que partes da reunião gravada em partes ainda têm o áudio no bucket, e em que
 * ponto da reunião cada uma começa. Serve ao reprocesso (reprocessarEmPartes,
 * em meeting-service.ts), que relê do bucket as partes que falharam, e ao
 * "Baixar o áudio" (H8c, baixar-audio-da-reuniao.ts), que as emenda num arquivo
 * só: as duas leem a mesma regra daqui, para nunca divergirem.
 *
 * A parte recebida ou transcrita tem o áudio guardado. A que FALHOU também,
 * quando a falha foi da IA, do banco ou das tentativas (IA_INDISPONIVEL,
 * IA_RECUSOU, IA_CORTOU, TEMPOS_FORA_DA_PARTE, TENTATIVAS_ESGOTADAS...): a fila
 * guarda o áudio antes de transcrever, e é justamente no trecho sem transcrição
 * que a dona pode querer ouvi-lo. Só não têm áudio a parte cujo objeto sumiu do
 * bucket (AUDIO_AUSENTE) e a que nunca subiu (NAO_RECEBIDA), além da que ainda
 * está subindo. A parte que fica só como ponteiro (reunião ou conta excluída)
 * vence na hora e sai pelo prazo.
 */

/** As causas de falha em que a parte não tem o áudio no bucket. */
export const CAUSAS_DA_PARTE_SEM_AUDIO = ["AUDIO_AUSENTE", "NAO_RECEBIDA"] as const;

/** A parte tem o áudio guardado no bucket (sem olhar o prazo)? */
export function parteTemAudioGuardado(linha: { status: string; lastError: string | null | undefined }): boolean {
  if (linha.status === "received" || linha.status === "transcribed") return true;
  if (linha.status !== "failed") return false;
  return !(CAUSAS_DA_PARTE_SEM_AUDIO as readonly string[]).includes(linha.lastError ?? "");
}

/** O que se lê de cada parte para baixá-la. */
export type LinhaDaParte = {
  seq: number; status: string; lastError: string | null; storageKey: string; mimeType: string;
  durationMs: number; offsetMs: number | null; expiresAt: number;
};

/**
 * As partes que saem no arquivo baixado, no tempo do player (gravacaoParaOuvir,
 * em meeting-service.ts): o início é o gravado pela fila (offset) ou, antes de
 * ela transcrever, a soma das anteriores, contada sobre TODAS as linhas; saem as
 * que têm o áudio guardado (parteTemAudioGuardado), no prazo.
 */
export function partesParaBaixar(linhas: LinhaDaParte[], agora: number): ParteDoAudio[] {
  const partes: ParteDoAudio[] = [];
  let acumulado = 0;
  for (const linha of [...linhas].sort((a, b) => a.seq - b.seq)) {
    const inicio = linha.offsetMs !== null && linha.offsetMs !== undefined ? Number(linha.offsetMs) : acumulado;
    acumulado = inicio + Number(linha.durationMs);
    if (!parteTemAudioGuardado(linha) || Number(linha.expiresAt) <= agora) continue;
    partes.push({ seq: linha.seq, storageKey: linha.storageKey, mimeType: linha.mimeType, inicioMs: inicio, duracaoMs: Number(linha.durationMs) });
  }
  return partes;
}
