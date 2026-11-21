import { chaveDaEtiqueta, etiquetasDaReuniao } from "./detalhes-da-reuniao";

/**
 * A busca entre as reuniões (H7b do plano do gravador; HN-29 no app de
 * referência da cliente: buscar em todas as notas, com filtros e buscas
 * recentes). Duas camadas, com a mesma régua de filtros:
 * - na tela, na hora, sobre a lista que já veio (título, etiquetas, "Onde
 *   foi", contato e contexto): filtrarReunioesNaTela, abaixo;
 * - no servidor, a partir de 3 letras (2 nas escritas sem espaço, como o
 *   chinês e o japonês), na transcrição e nos itens do resumo que não foram
 *   ignorados (server/busca-de-reunioes.ts). O resultado abre a reunião no
 *   trecho (`?q`) ou no item (`?item`).
 */

/** O menor termo que o servidor aceita (o servidor só é chamado a partir de TERMO_PARA_O_SERVIDOR). */
export const TERMO_DA_BUSCA_MIN = 2;
export const TERMO_DA_BUSCA_MAX = 100;
/** A partir de quantas letras a tela pergunta ao servidor. */
export const TERMO_PARA_O_SERVIDOR = 3;
/** Quantos resultados o servidor devolve, no máximo. */
export const RESULTADOS_DA_BUSCA_MAX = 30;
/** O teto de buscas no servidor por dona: 120 a cada 10 minutos (cada busca lê as transcrições dela). */
export const BUSCAS_POR_JANELA = 120;
export const JANELA_DA_BUSCA_MS = 10 * 60_000;
/** A recusa do teto, como CÓDIGO (a tela traduz). */
export const MENSAGEM_BUSCAS_DEMAIS = "BUSCAS_DEMAIS";
/** As letras do trecho que o servidor devolve em volta do termo. */
export const TRECHO_ANTES = 60;
export const TRECHO_TAMANHO = 180;
/** Quantas buscas recentes a tela guarda, neste aparelho. */
export const BUSCAS_RECENTES_MAX = 8;

/** De onde a reunião veio, para o filtro: o áudio (gravado, importado ou da aba), o documento (PDF e fotos) e o vídeo do YouTube. */
export const ORIGENS_DO_FILTRO = ["audio", "documento", "youtube"] as const;
export type OrigemDoFiltro = (typeof ORIGENS_DO_FILTRO)[number];
/** O período do filtro, contado de agora para trás. */
export const PERIODOS_DO_FILTRO = ["7d", "30d", "90d", "365d"] as const;
export type PeriodoDoFiltro = (typeof PERIODOS_DO_FILTRO)[number];
const DIAS_DO_PERIODO: Record<PeriodoDoFiltro, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

export type FiltrosDaBusca = {
  etiqueta?: string | null;
  origem?: OrigemDoFiltro | null;
  periodo?: PeriodoDoFiltro | null;
  contactId?: number | null;
  contextId?: string | null;
};

/** O começo do período (em ms), ou null sem período. */
export function inicioDoPeriodo(periodo: PeriodoDoFiltro | null | undefined, agora: number): number | null {
  return periodo ? agora - DIAS_DO_PERIODO[periodo] * 24 * 60 * 60_000 : null;
}

/** A origem gravada da reunião no grupo do filtro; nula (o envio único) é áudio. */
export function grupoDaOrigem(origem: string | null | undefined): OrigemDoFiltro {
  if (origem === "pdf" || origem === "foto") return "documento";
  if (origem === "youtube") return "youtube";
  return "audio";
}

// O chinês, o japonês e o tailandês escrevem sem espaço: duas letras já são uma
// palavra ("会议", "契約"). A mesma faixa de ESCRITA_SEM_ESPACO (meeting-service.ts).
const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}]", "u");

/** O termo já vale uma ida ao servidor? 3 letras, ou 2 nas escritas sem espaço. */
export function termoProntoParaOServidor(termo: string): boolean {
  const limpo = termo.trim();
  const letras = Array.from(limpo).length;
  return letras >= TERMO_PARA_O_SERVIDOR || (letras >= TERMO_DA_BUSCA_MIN && ESCRITA_SEM_ESPACO.test(limpo));
}

/**
 * O termo como padrão de LIKE, com `!` de escape: `%`, `_` e o próprio `!`
 * digitados pela dona valem como letra, e não como curinga. O SQL leva
 * `ESCAPE '!'` (e não a barra, que muda de sentido com o modo do servidor).
 */
export function padraoDoLike(termo: string): string {
  return `%${termo.replace(/[!%_]/g, letra => `!${letra}`)}%`;
}

// Em RegExp, e não em literal com a bandeira u: o alvo do tsconfig não aceita a bandeira no literal.
const DIACRITICOS = new RegExp("\\p{Diacritic}", "gu");

/** Sem acento e em minúsculas, para a busca na tela achar "reuniao" em "Reunião". */
export function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(DIACRITICOS, "").toLocaleLowerCase("pt-BR");
}

/** O que a tela sabe de cada reunião da lista para buscar e filtrar. */
export type ReuniaoParaFiltrar = {
  title: string;
  createdAt: number;
  origem?: string | null;
  etiquetas?: unknown;
  ondeFoi?: string | null;
  contactId?: number | null;
  contextId?: string | null;
  contatoNome?: string | null;
  contextoNome?: string | null;
};

/** A reunião passa pelos filtros (sem o termo)? */
export function passaNosFiltros(reuniao: ReuniaoParaFiltrar, filtros: FiltrosDaBusca, agora: number): boolean {
  if (filtros.etiqueta) {
    const chave = chaveDaEtiqueta(filtros.etiqueta);
    if (!etiquetasDaReuniao(reuniao.etiquetas).some(etiqueta => chaveDaEtiqueta(etiqueta) === chave)) return false;
  }
  if (filtros.origem && grupoDaOrigem(reuniao.origem) !== filtros.origem) return false;
  const inicio = inicioDoPeriodo(filtros.periodo, agora);
  if (inicio !== null && reuniao.createdAt < inicio) return false;
  if (filtros.contactId && Number(reuniao.contactId) !== filtros.contactId) return false;
  if (filtros.contextId && reuniao.contextId !== filtros.contextId) return false;
  return true;
}

/**
 * A busca na tela, na hora: o termo (sem acento e sem caixa) no título, nas
 * etiquetas, no "Onde foi", no nome do contato e no do contexto, e os filtros.
 * Sem termo, só os filtros. A ordem da lista não muda.
 */
export function filtrarReunioesNaTela<T extends ReuniaoParaFiltrar>(lista: readonly T[], termo: string, filtros: FiltrosDaBusca, agora: number): T[] {
  const procurado = semAcento(termo.trim());
  return lista.filter(reuniao => {
    if (!passaNosFiltros(reuniao, filtros, agora)) return false;
    if (!procurado) return true;
    const campos = [reuniao.title, reuniao.ondeFoi, reuniao.contatoNome, reuniao.contextoNome, ...etiquetasDaReuniao(reuniao.etiquetas)];
    return campos.some(campo => typeof campo === "string" && semAcento(campo).includes(procurado));
  });
}

/** Há algum filtro ligado? */
export function temFiltro(filtros: FiltrosDaBusca): boolean {
  return Boolean(filtros.etiqueta || filtros.origem || filtros.periodo || filtros.contactId || filtros.contextId);
}

/**
 * A lista das buscas recentes com o termo novo na frente: sem repetida (sem
 * caixa e sem acento), sem vazia e no máximo BUSCAS_RECENTES_MAX.
 */
export function comBuscaRecente(recentes: readonly string[], termo: string): string[] {
  const limpo = termo.trim().slice(0, TERMO_DA_BUSCA_MAX);
  if (!limpo) return recentes.slice(0, BUSCAS_RECENTES_MAX);
  const chave = semAcento(limpo);
  return [limpo, ...recentes.filter(anterior => semAcento(anterior) !== chave)].slice(0, BUSCAS_RECENTES_MAX);
}
