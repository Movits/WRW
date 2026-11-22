import { IDIOMA_AUTOMATICO, idiomaFalado, type EscolhaDoIdioma, type IdiomaFalado } from "@shared/idioma-da-reuniao";

/**
 * As partes puras da legenda ao vivo do gravador (G15b; a regra está em
 * shared/legenda-ao-vivo.ts): qual reconhecimento de voz o navegador tem, se o
 * botão aparece, em que idioma a legenda ouve, como os resultados do
 * reconhecimento viram linhas, o que fazer com cada erro e o tamanho da letra
 * guardado no aparelho. Ligar, religar e desligar moram em
 * hooks/useLegendaAoVivo.ts; a tela, em components/LegendaAoVivo.tsx.
 */

/** Um resultado do reconhecimento (SpeechRecognitionResult): a primeira alternativa é a que vale. */
export type ResultadoDoReconhecimento = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [indice: number]: { readonly transcript: string } | undefined;
};

/** A lista de resultados da sessão (SpeechRecognitionResultList): a sessão inteira, desde o start. */
export type ListaDeResultados = {
  readonly length: number;
  readonly [indice: number]: ResultadoDoReconhecimento | undefined;
};

/**
 * O reconhecimento de voz do navegador (a Web Speech API), na forma que esta
 * tela usa. O TypeScript não traz o tipo (o Chrome e o Safari só o expõem com
 * o prefixo webkit), então ele mora aqui.
 */
export interface ReconhecimentoDeVoz {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((evento: { readonly resultIndex: number; readonly results: ListaDeResultados }) => void) | null;
  onerror: ((evento: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type ConstrutorDoReconhecimento = new () => ReconhecimentoDeVoz;

/** O reconhecimento do navegador: o sem prefixo, ou o webkitSpeechRecognition do Chrome, do Edge e do Safari. Null sem nenhum (o Firefox). */
export function construtorDoReconhecimento(): ConstrutorDoReconhecimento | null {
  const global = globalThis as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const construtor = typeof global.SpeechRecognition === "function" ? global.SpeechRecognition
    : typeof global.webkitSpeechRecognition === "function" ? global.webkitSpeechRecognition : null;
  return construtor as ConstrutorDoReconhecimento | null;
}

/**
 * A legenda no celular e no tablet (decisão vetável, G15b): DESLIGADA até o
 * teste num aparelho de verdade. No Android, o reconhecimento do navegador é
 * o do sistema, que pode tomar o microfone da gravação (ela seguiria gravando
 * silêncio) e apita a cada vez que religa; no iPhone e no iPad, ele pode cortar
 * a captura da gravação. Perder o áudio da reunião por causa da legenda é pior
 * do que não ter a legenda. Conferido no aparelho que as duas convivem, troque
 * para true.
 */
export const LEGENDA_NO_CELULAR = false;

type Navegador = { userAgent?: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } };

/** Celular ou tablet: Android, iPhone, iPod, iPad (que se diz Mac, mas tem toque) e o que o próprio navegador diz que é móvel. */
export function ehCelularOuTablet(navegador: Navegador | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!navegador) return false;
  if (navegador.userAgentData?.mobile === true) return true;
  const agente = navegador.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(agente)) return true;
  return /Macintosh/.test(agente) && (navegador.maxTouchPoints ?? 0) > 1;
}

/**
 * Se o botão da legenda aparece: só onde o navegador tem o reconhecimento de
 * voz e, até o teste no aparelho (LEGENDA_NO_CELULAR), fora do celular e do
 * tablet.
 */
export function legendaDisponivel(
  construtor: ConstrutorDoReconhecimento | null = construtorDoReconhecimento(),
  navegador?: Navegador,
  noCelular = LEGENDA_NO_CELULAR,
): boolean {
  if (!construtor) return false;
  return noCelular || !ehCelularOuTablet(navegador);
}

// A região de cada idioma da tela quando o navegador não diz qual prefere: o
// reconhecimento reconhece melhor com a região, e o chinês simplificado é o do
// mandarim da China continental.
const REGIAO_PADRAO: ReadonlyMap<string, string> = new Map([
  ["pt-BR", "pt-BR"], ["en", "en-US"], ["es", "es-ES"], ["fr", "fr-FR"], ["de", "de-DE"],
  ["ar", "ar-SA"], ["zh", "zh-CN"], ["hi", "hi-IN"], ["ja", "ja-JP"], ["ru", "ru-RU"],
]);

/**
 * O idioma em que a legenda ouve: o da reunião; no "Detectar sozinho" (G16),
 * que o reconhecimento do navegador não faz, o da tela (`automatico` diz isso
 * à tela). A etiqueta (BCP 47) é a que o navegador prefere para esse idioma
 * ("es-MX" para quem tem o navegador em espanhol do México), senão a região
 * padrão, senão o próprio código.
 */
export function idiomaDaLegenda(escolha: EscolhaDoIdioma, idiomaDaTela: string, preferidos: readonly string[] = []): { idioma: IdiomaFalado; etiqueta: string; automatico: boolean } {
  const automatico = escolha === IDIOMA_AUTOMATICO;
  const idioma = (automatico ? idiomaFalado(idiomaDaTela) : idiomaFalado(escolha)) ?? "pt-BR";
  const preferida = preferidos.find(etiqueta => typeof etiqueta === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(etiqueta) && idiomaFalado(etiqueta) === idioma);
  return { idioma, etiqueta: preferida ?? REGIAO_PADRAO.get(idioma) ?? idioma, automatico };
}

/** O chinês e o japonês não separam as palavras com espaço: os trechos provisórios se juntam sem ele. */
export function separadorDoIdioma(idioma: IdiomaFalado): string {
  return idioma === "zh" || idioma === "ja" ? "" : " ";
}

/**
 * Os resultados da sessão em linhas: cada resultado final é uma linha, e os
 * provisórios (o que ainda está sendo dito, que o navegador reescreve) viram o
 * texto provisório. Lê a lista INTEIRA a cada evento, e não só a partir do
 * resultIndex: assim um resultado reescrito pelo navegador nunca entra duas
 * vezes. A sessão do navegador é curta (ele a encerra sozinho no silêncio), e
 * a lista, pequena.
 */
export function lerResultados(resultados: ListaDeResultados, separador = " "): { finais: string[]; provisorio: string } {
  const finais: string[] = [];
  const provisorios: string[] = [];
  for (let i = 0; i < resultados.length; i++) {
    const resultado = resultados[i];
    const texto = (resultado?.[0]?.transcript ?? "").trim();
    if (!resultado || !texto) continue;
    (resultado.isFinal ? finais : provisorios).push(texto);
  }
  return { finais, provisorio: provisorios.join(separador) };
}

/**
 * Quantas linhas a legenda guarda na memória da aba: numa gravação de horas,
 * só as mais novas ficam (a legenda não é a transcrição, e nada dela fica
 * guardado).
 */
export const LINHAS_DA_LEGENDA_MAX = 200;

/** As linhas de antes com as novas, no máximo `maximo`, ficando as mais novas. */
export function juntarLinhas(anteriores: readonly string[], novas: readonly string[], maximo = LINHAS_DA_LEGENDA_MAX): string[] {
  const todas = [...anteriores, ...novas];
  return todas.length > maximo ? todas.slice(todas.length - maximo) : todas;
}

/** Por que a legenda desligou sozinha: a tela diz a frase de cada uma. */
export type FalhaDaLegenda =
  | "semPermissao"
  | "servicoRecusado"
  | "semMicrofone"
  | "idiomaSemSuporte"
  | "naoResponde"
  | "microfoneDaGravacao";

/**
 * O que fazer com cada erro do reconhecimento (SpeechRecognitionErrorEvent.error):
 * seguir (o fim da sessão, que vem logo depois, religa, contando as falhas
 * seguidas) ou desligar com a falha. O silêncio ("no-speech"), a interrupção
 * ("aborted") e a rede ("network", que às vezes volta) seguem; o que não volta
 * sozinho (permissão, serviço recusado, microfone ocupado, idioma sem suporte)
 * desliga. Erro desconhecido segue, e a conta das falhas o para se repetir.
 */
export function destinoDoErro(erro: string): { tipo: "seguir" } | { tipo: "desligar"; falha: FalhaDaLegenda } {
  switch (erro) {
    case "not-allowed": return { tipo: "desligar", falha: "semPermissao" };
    case "service-not-allowed": return { tipo: "desligar", falha: "servicoRecusado" };
    case "audio-capture": return { tipo: "desligar", falha: "semMicrofone" };
    case "language-not-supported": return { tipo: "desligar", falha: "idiomaSemSuporte" };
    default: return { tipo: "seguir" };
  }
}

/**
 * O navegador encerra a sessão sozinho (no silêncio, depois de um tempo, numa
 * queda de rede), e a legenda religa. A sessão que acaba antes de SESSAO_CURTA_MS
 * sem nenhum resultado é uma falha; depois de REINICIOS_RAPIDOS_MAX seguidas
 * (o navegador que expõe o reconhecimento mas não o atende, como o Brave), a
 * legenda desliga com o aviso, em vez de religar em laço.
 */
export const SESSAO_CURTA_MS = 2_000;
export const REINICIOS_RAPIDOS_MAX = 5;

/** A espera antes de religar: cresce com as falhas seguidas (250 ms, 500 ms, 1 s, 2 s, 4 s), até 8 s. */
export function esperaParaReligar(falhasSeguidas: number): number {
  return Math.min(250 * 2 ** Math.max(0, falhasSeguidas), 8_000);
}

/** Os tamanhos da letra da legenda, em px. A dona escolhe com A− e A+; o aparelho lembra. */
export const TAMANHOS_DA_LETRA = [16, 20, 24, 30, 36, 44] as const;
export const TAMANHO_DA_LETRA_PADRAO = 1;
/** A marca no aparelho (o prefixo mmm: é o das outras marcas do app no navegador). */
export const CHAVE_DO_TAMANHO_DA_LETRA = "mmm:tamanho-da-legenda";

type Armazenamento = Pick<Storage, "getItem" | "setItem">;

const armazenamentoDoAparelho = (): Armazenamento | null => (typeof localStorage === "undefined" ? null : localStorage);

/** O tamanho guardado no aparelho (a posição em TAMANHOS_DA_LETRA), ou o padrão: sem armazenamento, com valor estranho ou com o acesso recusado (janela anônima). */
export function lerTamanhoDaLetra(armazenamento: Armazenamento | null = armazenamentoDoAparelho()): number {
  try {
    const bruto = armazenamento?.getItem(CHAVE_DO_TAMANHO_DA_LETRA);
    // Só dígitos: o Number("") e o Number(" ") dariam 0, a primeira posição.
    if (typeof bruto !== "string" || !/^\d+$/.test(bruto)) return TAMANHO_DA_LETRA_PADRAO;
    const posicao = Number(bruto);
    return posicao < TAMANHOS_DA_LETRA.length ? posicao : TAMANHO_DA_LETRA_PADRAO;
  } catch {
    return TAMANHO_DA_LETRA_PADRAO;
  }
}

/** Guarda o tamanho no aparelho; sem armazenamento (ou recusado), só não lembra. */
export function guardarTamanhoDaLetra(posicao: number, armazenamento: Armazenamento | null = armazenamentoDoAparelho()): void {
  try {
    armazenamento?.setItem(CHAVE_DO_TAMANHO_DA_LETRA, String(posicao));
  } catch {
    // Sem lembrar: a letra fica como está nesta tela.
  }
}
