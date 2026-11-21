import { ehCodigoDeErroDoYoutube, VIDEOS_DO_YOUTUBE_POR_DIA, type CodigoDeErroDoYoutube } from "@shared/youtube";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

type TranslateFn = (chave: string, opcoes?: Record<string, unknown>) => string;

/**
 * Os erros do vídeo do YouTube (H13) no idioma da tela. O servidor não sabe o
 * idioma de quem lê: grava o CÓDIGO em processing_error, ou o manda como
 * mensagem do erro do tRPC (shared/youtube.ts), e a tradução é aqui.
 *
 * O Record é pelo tipo do servidor: código novo lá não compila aqui sem a
 * frase dele. Cada valor chama t() com a chave literal, para o teste das
 * chaves usadas (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
 */
const FRASE_POR_CODIGO: Record<CodigoDeErroDoYoutube, (t: TranslateFn) => string> = {
  YOUTUBE_LINK_INVALIDO: t => t("meetings.youtube.errors.linkInvalid"),
  YOUTUBE_VIDEO_PRIVADO: t => t("meetings.youtube.errors.privateVideo"),
  YOUTUBE_LONGO_DEMAIS: t => t("meetings.youtube.errors.tooLong"),
  YOUTUBE_SEM_FALA: t => t("meetings.youtube.errors.noSpeech"),
  YOUTUBE_IA_INDISPONIVEL: t => t("meetings.youtube.errors.aiUnavailable"),
  YOUTUBE_IA_RECUSOU: t => t("meetings.youtube.errors.aiRefused"),
  YOUTUBE_FALHOU: t => t("meetings.youtube.errors.failed"),
  YOUTUBE_TETO_DIARIO: t => t("meetings.youtube.errors.dailyLimit", { n: VIDEOS_DO_YOUTUBE_POR_DIA }),
};

/** A frase de um código do vídeo do YouTube, ou null se não é um deles. */
export function fraseDoErroDoYoutube(codigo: unknown, t: TranslateFn): string | null {
  return ehCodigoDeErroDoYoutube(codigo) ? FRASE_POR_CODIGO[codigo](t) : null;
}

/**
 * A frase da recusa de um pedido de vídeo (o resumir e o "Tentar de novo"):
 * o código do vídeo quando ele vem na mensagem; senão, pelo código tRPC (as
 * frases do servidor vêm em português); senão, a frase geral da tela.
 */
export function fraseDoPedidoDoYoutube(erro: unknown, t: TranslateFn): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  const doVideo = fraseDoErroDoYoutube(mensagem, t);
  if (doVideo) return doVideo;
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "CONFLICT": return t("meetings.reprocessConflict");
    case "PRECONDITION_FAILED": return t("meetings.reprocessUnavailable");
    default: return mensagemDeErroParaTela(erro, t);
  }
}
