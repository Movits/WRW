/**
 * O vídeo do YouTube que vira reunião (H13 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): a dona cola o link de um vídeo
 * público, a IA do Google (Gemini) o lê pelo próprio link e devolve a
 * transcrição por falante, e dali em diante é o caminho de sempre da reunião
 * (resumo guardado, mapa mental e Pergunte à reunião).
 *
 * Aqui ficam as regras puras que o servidor e a tela dividem: tirar o id do
 * vídeo de um link, a URL canônica que a reunião guarda (`source_url`), o link
 * do "▶" com o segundo e os códigos de erro que a tela traduz. Nada aqui busca
 * a URL: nem o servidor nem a tela abrem o endereço que a dona colou. Quem lê
 * o vídeo é o Gemini, e ele só recebe a URL canônica montada a partir do id.
 */

/** O id de um vídeo do YouTube: 11 caracteres do alfabeto base64url. */
export const FORMATO_DO_ID_DO_YOUTUBE = /^[A-Za-z0-9_-]{11}$/;

/** O maior link aceito, antes de qualquer leitura (a tela e o servidor conferem o mesmo). */
export const TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE = 2048;

/**
 * Só a primeira hora do vídeo vai à IA (o corte `end_offset` do pedido ao
 * Gemini): é o teto de custo de cada vídeo, e o que cabe numa resposta só.
 */
export const SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX = 60 * 60;

/** Quantos vídeos cada dona manda à IA a cada 24 horas, contando os "Tentar de novo". */
export const VIDEOS_DO_YOUTUBE_POR_DIA = 5;

// Os endereços do próprio YouTube. youtu.be é o link curto do botão
// "Compartilhar"; m. é o celular; music. abre o mesmo vídeo pelo YouTube Music;
// youtube-nocookie.com é o embed sem cookie que alguns sites usam.
const HOSTS_DO_YOUTUBE = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com",
]);
const HOSTS_DO_LINK_CURTO = new Set(["youtu.be", "www.youtu.be"]);
// Os caminhos que trazem o id logo depois: /shorts/ID, /embed/ID, /live/ID
// (a transmissão ao vivo e a gravação dela) e /v/ID (o embed antigo).
const CAMINHOS_COM_O_ID = new Set(["shorts", "embed", "live", "v"]);
const TEM_ESQUEMA = /^[a-z][a-z0-9+.-]*:/i;

/**
 * O id do vídeo num link do YouTube, ou null. Aceita, com e sem parâmetros
 * (`&t=42s`, `?si=...`, `&list=...`, `?feature=share`) e com ou sem
 * `https://`: youtube.com/watch?v=ID (também www., m. e music.), youtu.be/ID,
 * /shorts/ID, /embed/ID (também youtube-nocookie.com), /live/ID e /v/ID.
 *
 * Recusa tudo o que não for exatamente um vídeo: outro site (inclusive
 * youtube.com.exemplo.com e exemplo.com/youtube.com/...), link com usuário ou
 * senha antes do endereço, esquema que não é http(s), canal, playlist sem
 * vídeo, perfil (@nome), caminho com pedaços a mais e id fora do formato.
 */
export function idDoVideoDoYoutube(entrada: unknown): string | null {
  if (typeof entrada !== "string") return null;
  const texto = entrada.trim();
  if (!texto || texto.length > TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE || /\s/.test(texto)) return null;
  // O link colado sem o esquema ("youtu.be/ID", "www.youtube.com/watch?v=ID").
  const comEsquema = texto.startsWith("//") ? `https:${texto}` : TEM_ESQUEMA.test(texto) ? texto : `https://${texto}`;
  let url: URL;
  try {
    url = new URL(comEsquema);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  // Os pedaços do caminho, sem a barra do fim ("/shorts/ID/" vale como "/shorts/ID").
  const pedacos = url.pathname.split("/").filter((pedaco, i, todos) => i > 0 && !(pedaco === "" && i === todos.length - 1));
  let id: string | null = null;
  if (HOSTS_DO_LINK_CURTO.has(host)) {
    id = pedacos.length === 1 ? pedacos[0] : null;
  } else if (HOSTS_DO_YOUTUBE.has(host)) {
    if (pedacos.length === 1 && pedacos[0] === "watch") id = url.searchParams.get("v");
    else if (pedacos.length === 2 && CAMINHOS_COM_O_ID.has(pedacos[0])) id = pedacos[1];
  }
  return id && FORMATO_DO_ID_DO_YOUTUBE.test(id) ? id : null;
}

/**
 * O id do vídeo de uma reunião, para a tela e o link aberto montarem o "▶":
 * só da reunião que veio do YouTube, e só se a URL guardada for de um vídeo.
 */
export function idDoVideoDaReuniao(reuniao: { origem?: string | null; sourceUrl?: string | null }): string | null {
  return reuniao.origem === "youtube" ? idDoVideoDoYoutube(reuniao.sourceUrl) : null;
}

/**
 * O endereço que a reunião guarda e que vai ao Gemini: sempre o mesmo para o
 * mesmo vídeo, sem os parâmetros do link colado (o `si` de rastreio, a
 * playlist, o tempo).
 */
export function urlCanonicaDoYoutube(id: string): string {
  if (!FORMATO_DO_ID_DO_YOUTUBE.test(id)) throw new Error("Id de vídeo do YouTube fora do formato.");
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * O destino do "▶ mm:ss" numa reunião que veio do YouTube: o vídeo, no
 * segundo em que a fala começa, numa aba nova. A tela não embute o player do
 * YouTube: a CSP da WRW proíbe frames de outros sites (frame-src 'none').
 */
export function linkDoYoutubeNoSegundo(id: string, segundos: number): string {
  const inteiro = Number.isFinite(segundos) ? Math.max(0, Math.floor(segundos)) : 0;
  return `${urlCanonicaDoYoutube(id)}&t=${inteiro}s`;
}

/**
 * Os códigos de erro do vídeo do YouTube. O servidor não sabe o idioma de quem
 * lê: grava o código em `meetings.processing_error` (ou o devolve como
 * mensagem do erro do tRPC), e a tela o traduz (meetings.youtube.errors.*).
 */
export const CODIGOS_DE_ERRO_DO_YOUTUBE = [
  // O link não é de um vídeo do YouTube (idDoVideoDoYoutube devolveu null).
  "YOUTUBE_LINK_INVALIDO",
  // O Gemini não abriu o vídeo: privado, não listado, removido ou bloqueado.
  "YOUTUBE_VIDEO_PRIVADO",
  // Fala demais para uma resposta só, ou o vídeo passou do que a IA lê de uma vez.
  "YOUTUBE_LONGO_DEMAIS",
  // A IA não achou fala nenhuma (música, silêncio, vídeo sem voz).
  "YOUTUBE_SEM_FALA",
  // A IA está lotada, sem cota ou não respondeu a tempo: passageiro.
  "YOUTUBE_IA_INDISPONIVEL",
  // A IA recusou o pedido (conteúdo bloqueado por ela, ou configuração do servidor).
  "YOUTUBE_IA_RECUSOU",
  // Qualquer outra falha depois de o pedido sair (resposta ilegível, extração, banco).
  "YOUTUBE_FALHOU",
  // A dona já mandou VIDEOS_DO_YOUTUBE_POR_DIA vídeos nas últimas 24 horas.
  "YOUTUBE_TETO_DIARIO",
] as const;

export type CodigoDeErroDoYoutube = (typeof CODIGOS_DE_ERRO_DO_YOUTUBE)[number];

export function ehCodigoDeErroDoYoutube(valor: unknown): valor is CodigoDeErroDoYoutube {
  return typeof valor === "string" && (CODIGOS_DE_ERRO_DO_YOUTUBE as readonly string[]).includes(valor);
}

/**
 * As falhas que se repetem com o mesmo vídeo: a mesma hora vai ao mesmo
 * modelo, com temperatura 0 e o mesmo teto de saída, e a IA para de novo em
 * MAX_TOKENS (fala demais) ou não acha fala outra vez. Cada "Tentar de novo"
 * pagaria outra leitura e gastaria uma vaga do dia para falhar igual: a tela
 * não mostra o botão, e o servidor recusa. A frase da causa já diz o que fazer.
 */
export const ERROS_DO_YOUTUBE_QUE_SE_REPETEM: readonly CodigoDeErroDoYoutube[] = ["YOUTUBE_LONGO_DEMAIS", "YOUTUBE_SEM_FALA"];

export function erroDoYoutubeSeRepete(codigo: string | null | undefined): codigo is CodigoDeErroDoYoutube {
  return ehCodigoDeErroDoYoutube(codigo) && ERROS_DO_YOUTUBE_QUE_SE_REPETEM.includes(codigo);
}

/**
 * A versão do aviso do YouTube (meetings.youtube.notice e consentLabel, nos 10
 * idiomas) que a dona aceitou. Vai em `meetings.consent_notice_version`, como
 * a do aviso de gravação (shared/aviso-de-gravacao.ts), e na auditoria do
 * pedido. Mudou o que o aviso diz sobre o vídeo (quem lê, onde, o que fica
 * guardado)? Versão NOVA no fim da lista, e a VIGENTE troca; as anteriores
 * continuam aceitas. O rascunho de cada versão, para a revisão jurídica, fica
 * em docs/termos/aviso-de-gravacao-rascunho.md.
 */
export const VERSOES_DO_AVISO_DO_YOUTUBE = ["youtube-2026-11-20", "youtube-2026-11-24"] as const;

export type VersaoDoAvisoDoYoutube = (typeof VERSOES_DO_AVISO_DO_YOUTUBE)[number];

export const VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE: VersaoDoAvisoDoYoutube = "youtube-2026-11-24";
