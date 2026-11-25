/**
 * Baixar o áudio da reunião (H8c do desenho do gravador; HN-60 no HiNoter): a
 * dona baixa a gravação inteira num arquivo só, em MP3 ou em M4A. As partes da
 * reunião gravada em partes (WebM/Opus no Chrome e no Android, MP4/AAC no
 * Safari e no iPhone, MP3 da importação) e o arquivo do envio único saem
 * emendados, na ordem, num formato que toca em qualquer aparelho.
 *
 * O servidor junta e converte com o ffmpeg, em streaming, sem guardar o
 * resultado (server/conversao-do-audio.ts). Em dois passos:
 *
 * 1. `meetings.baixarAudio` (tRPC) confere a dona, o prazo dos 30 dias e o
 *    teto, lê as partes e grava a auditoria na MESMA transação (o padrão do
 *    MEETING_EXPORTED da H8), e devolve um endereço de uso único, que vale
 *    poucos minutos e só para a sessão da dona;
 * 2. a dona toca no link, e a rota GET (server/_core/rota-do-audio-baixado.ts)
 *    lê as partes do bucket pelo servidor e transmite o arquivo enquanto o
 *    converte. A chave e a URL do bucket nunca chegam ao navegador.
 *
 * Regras que o servidor e a tela leem daqui: só a dona baixa (o link aberto não
 * ganha o botão nem rota); depois dos 30 dias o botão some, e o servidor recusa
 * com um código que a tela traduz.
 */

/** Os formatos do arquivo. O MP3 toca em qualquer aparelho; o M4A (AAC) soa melhor no mesmo tamanho. */
export const FORMATOS_DO_AUDIO = ["mp3", "m4a"] as const;
export type FormatoDoAudio = (typeof FORMATOS_DO_AUDIO)[number];

/** O tipo do arquivo na resposta da rota. */
export const TIPO_DO_AUDIO: Record<FormatoDoAudio, string> = { mp3: "audio/mpeg", m4a: "audio/mp4" };

/** A ação gravada em audit_logs a cada áudio preparado para baixar. */
export const ACAO_AUDIO_BAIXADO = "MEETING_AUDIO_DOWNLOADED";

/**
 * O teto por dona: 10 áudios a cada hora, só os que foram preparados (a recusa
 * e a falha devolvem a vaga). Converter custa CPU na instância de 1 CPU: uma
 * hora de reunião leva de meio minuto a um minuto de CPU (medido em 20/11 num
 * computador comum: 10 min de Opus viram MP3 em ~5 s e M4A em ~8 s).
 */
export const AUDIOS_POR_JANELA = 10;
export const JANELA_DO_AUDIO_MS = 60 * 60_000;

/**
 * Quantos áudios a instância converte ao mesmo tempo, somando os que já foram
 * preparados e esperam o toque da dona. Acima disso, a preparação recusa com
 * AUDIO_OCUPADO, antes de ler qualquer coisa ou gravar auditoria.
 */
export const CONVERSOES_DE_AUDIO_SIMULTANEAS = 2;

/** Quanto tempo o endereço preparado vale. Passado o prazo, a tela pede para preparar de novo. */
export const VALIDADE_DO_ENDERECO_DO_AUDIO_MS = 2 * 60_000;

/** A rota do download: `${ROTA_DO_AUDIO_BAIXADO}/{ficha}`. */
export const ROTA_DO_AUDIO_BAIXADO = "/api/reunioes/baixar-audio";

/**
 * A taxa do arquivo: 64 kbps, mono, 24 kHz. Fala soa bem, e uma hora fica em
 * ~29 MB (12 h, o teto da gravação em partes, em ~346 MB).
 */
export const BITS_POR_SEGUNDO_DO_AUDIO = 64_000;

/** O tamanho aproximado do arquivo, para a tela dizer quanto vai baixar. */
export function tamanhoEstimadoDoAudio(duracaoSegundos: number): number {
  if (!Number.isFinite(duracaoSegundos) || duracaoSegundos <= 0) return 0;
  return Math.ceil((duracaoSegundos * BITS_POR_SEGUNDO_DO_AUDIO) / 8);
}

/**
 * As recusas, como CÓDIGO (e não frase): a tela traduz cada um nos 10 idiomas
 * (meetings.audioDownload.*; client/src/lib/mensagem-de-erro.ts). A reunião de
 * outra conta, excluída ou que não existe sai como NOT_FOUND, igual à H8.
 */
export const RECUSAS_DO_AUDIO = {
  /** O áudio passou dos 30 dias e saiu (ou está saindo) do bucket. */
  vencido: "AUDIO_VENCIDO",
  /** Não há áudio guardado: nunca houve, ou as partes não chegaram ao bucket. */
  ausente: "AUDIO_AUSENTE",
  /** A gravação ainda está gravando ou recebendo partes. */
  aindaGravando: "AUDIO_AINDA_GRAVANDO",
  /** O teto por dona (AUDIOS_POR_JANELA). */
  demais: "AUDIOS_DEMAIS",
  /** A instância já converte o máximo de áudios ao mesmo tempo. */
  ocupado: "AUDIO_OCUPADO",
  /** O conversor não está disponível no servidor (o ffmpeg não subiu com a imagem). */
  indisponivel: "AUDIO_INDISPONIVEL",
} as const;
export type CodigoDaRecusaDoAudio = (typeof RECUSAS_DO_AUDIO)[keyof typeof RECUSAS_DO_AUDIO];

/** O tamanho máximo do nome do arquivo, sem a extensão. */
export const NOME_DO_ARQUIVO_DO_AUDIO_MAX = 120;

/**
 * O nome do arquivo que o navegador grava: o que a tela sugere (o título e a
 * data, como no PDF da H8), sem o que o sistema de arquivos recusa, sem os
 * controles de direção do texto (que fariam "abc\u202e3pm.exe" parecer outra
 * extensão) e com a extensão do formato. Sem nome, "audio".
 */
export function nomeDoArquivoDoAudio(sugerido: string | null | undefined, formato: FormatoDoAudio): string {
  const limpo = Array.from(
    (sugerido ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, NOME_DO_ARQUIVO_DO_AUDIO_MAX)
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return `${limpo || "audio"}.${formato}`;
}
