/**
 * O áudio do resumo (H19b do plano do gravador; HN-46 no HiNoter, decisão do
 * Roberto de 22/11/2026). Dois caminhos, e a dona escolhe:
 *
 * - "Ouvir o resumo" (H19, client/src/components/OuvirOResumo.tsx): a voz do
 *   próprio aparelho, sem servidor e sem IA, assim que o resumo fica pronto;
 * - "Baixar o áudio do resumo": a voz do Gemini, só sob demanda. O servidor
 *   (server/resumo-em-audio.ts) monta o mesmo texto que a voz do aparelho lê
 *   (shared/falas-do-resumo.ts), pede a voz ao Gemini, converte o áudio cru
 *   em MP3 com o ffmpeg (o do Pacote 4b) e guarda no bucket. O áudio é gerado
 *   uma vez por texto do resumo e idioma, e o mesmo pedido de novo é servido
 *   do bucket, sem IA. Teto por dona em 24 h, contado no banco. O áudio sai
 *   com a reunião.
 *
 * Só a dona baixa: o link aberto não ganha o botão.
 */

/**
 * O modelo de voz do Gemini: id concreto, nunca alias (CLAUDE.md da raiz). A
 * variável LLM_TTS_MODEL troca sem deploy, pela guarda do modelo de áudio
 * (server/_core/modelos-de-ia.ts). Preço lido em 23/11/2026 na página oficial
 * (ai.google.dev/gemini-api/docs/pricing): US$ 0,50 por 1 milhão de tokens de
 * texto e US$ 6,00 por 1 milhão de tokens de áudio (25 tokens por segundo),
 * até 31/12/2026; o dobro a partir de 01/01/2027.
 */
export const MODELO_DA_VOZ_DO_RESUMO_PADRAO = "gemini-3.8-flash-lite-tts";

/** A voz pronta do Gemini (uma das vozes que servem a todos os idiomas). */
export const VOZ_DO_GEMINI_PADRAO = "Kore";

/** Quantos áudios novos a dona gera em 24 h (o servido do bucket não conta). */
export const AUDIOS_DO_RESUMO_POR_DIA = 10;

/** O texto que vai à voz do Gemini, no máximo; o resumo maior é recusado. */
export const TEXTO_DO_AUDIO_DO_RESUMO_MAX = 20_000;

/** As recusas, como código: a tela as traduz (client/src/lib/mensagem-de-erro.ts). */
export const RECUSAS_DO_AUDIO_DO_RESUMO = {
  /** O teto por dona (AUDIOS_DO_RESUMO_POR_DIA). */
  demais: "AUDIO_DO_RESUMO_DEMAIS",
  /** Não há resumo com item à vista para ler. */
  semResumo: "AUDIO_DO_RESUMO_SEM_RESUMO",
  /** O idioma pedido não é o do resumo e a tradução dele ainda não está pronta. */
  traduzaAntes: "AUDIO_DO_RESUMO_TRADUZA_ANTES",
  /** O texto passa de TEXTO_DO_AUDIO_DO_RESUMO_MAX. */
  longo: "AUDIO_DO_RESUMO_LONGO",
  /** A voz do Gemini não respondeu. */
  ia: "AUDIO_DO_RESUMO_IA_INDISPONIVEL",
  /** O conversor ou o bucket não estão disponíveis no servidor. */
  indisponivel: "AUDIO_DO_RESUMO_INDISPONIVEL",
} as const;
export type CodigoDaRecusaDoAudioDoResumo = (typeof RECUSAS_DO_AUDIO_DO_RESUMO)[keyof typeof RECUSAS_DO_AUDIO_DO_RESUMO];

/** A ação da auditoria de cada download (o arquivo sai da WRW). */
export const ACAO_AUDIO_DO_RESUMO_BAIXADO = "MEETING_SUMMARY_AUDIO_DOWNLOADED";
