/**
 * O formato das gravações feitas no navegador, o mesmo nos três gravadores: a
 * reunião, o ditado e a voz do contato (ver hooks/useGravadorDeAudio.ts). Cada
 * um tinha a sua lista, e só o ditado pedia mp4 primeiro.
 */

/**
 * mp4 (AAC) primeiro: em 16/09 o webm/Opus, que o Safari novo do iPhone e o
 * Chrome gravam por padrão, dava erro na transcrição do Gemini, e o mp4
 * transcreve bem (#158). Quem não grava mp4 cai no webm e no ogg, como antes.
 */
export const MIMES_DE_GRAVACAO = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

/** O primeiro formato da lista que o navegador grava; sem nenhum, undefined (o gravador usa o padrão dele). */
export function escolherMimeDeGravacao(suporta: (tipo: string) => boolean): string | undefined {
  return MIMES_DE_GRAVACAO.find(tipo => suporta(tipo));
}

/** Os tipos de gravação que o servidor aceita (ALLOWED_MEETING_AUDIO_TYPES, em server/meeting-service.ts). */
export type TipoDeAudioGravado = "audio/webm" | "audio/ogg" | "audio/wav" | "audio/mp4";

/**
 * O tipo que vai ao servidor. O navegador dá ao áudio o tipo com parâmetros
 * ("audio/mp4;codecs=mp4a.40.2") e às vezes como vídeo ("video/webm;codecs=vp8,opus"),
 * e o servidor só aceita o tipo puro.
 */
export function tipoParaOServidor(tipoDoNavegador: string): TipoDeAudioGravado {
  if (tipoDoNavegador.includes("ogg")) return "audio/ogg";
  if (tipoDoNavegador.includes("wav")) return "audio/wav";
  if (tipoDoNavegador.includes("mp4") || tipoDoNavegador.includes("m4a")) return "audio/mp4";
  return "audio/webm";
}
