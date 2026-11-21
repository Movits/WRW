import { textoTemFala } from "@shared/fala-na-transcricao";

/**
 * Os trechos que o player toca quando quem ouve escolhe ouvir só uma voz ou
 * pular os silêncios (D2 do desenho do gravador; HN-26 e HN-79 do HiNoter). O
 * player (components/PlayerDasPartes.tsx) toca a reunião inteira; com uma
 * lista daqui, ele salta de um trecho ao seguinte e para depois do último.
 *
 * - Só uma voz: as falas dessa voz. A marca sem fala ([música], [ruído]) não é
 *   voz de ninguém (textoTemFala), como no tempo de fala.
 * - Pular os silêncios: todas as falas, inclusive as marcas, que são som; sai
 *   só o intervalo em que ninguém fala.
 *
 * Os tempos da transcrição vêm em segundos inteiros (o modelo escreve
 * "MM:SS", server/transcricao-de-fatia.ts): a fala que termina em 12,9 s pode
 * vir com o fim em 12. Por isso cada fala ganha uma margem antes e depois, e
 * duas falas com menos de 1 s de intervalo entre as margens tocam juntas, sem
 * picotar a conversa.
 */

/** Um trecho da reunião que o player toca, em segundos absolutos. */
export type TrechoParaTocar = { inicio: number; fim: number };

/** O segmento da transcrição como a tela o recebe (o contrato de components/TranscricaoPorFalante.tsx). */
type Segmento = { inicio: number; fim: number; falante: string; texto: string; lacuna?: boolean };

export const MARGEM_ANTES_DA_FALA_SEGUNDOS = 0.25;
export const MARGEM_DEPOIS_DA_FALA_SEGUNDOS = 0.75;
/** O intervalo entre duas falas (já com as margens) abaixo do qual elas tocam juntas. */
export const INTERVALO_QUE_JUNTA_SEGUNDOS = 1;
/**
 * A folga da posição no começo de um trecho: o navegador que pula para o
 * segundo 12,25 pode parar em 12,2. Sem a folga, esse ponto contaria como fora
 * do trecho, e o player pularia de novo para o mesmo lugar, sem fim.
 */
export const FOLGA_DO_PULO_SEGUNDOS = 0.25;

/**
 * Os trechos a tocar, em ordem e sem sobreposição. Nulo quando não há o que
 * restringir: nem voz escolhida nem pular os silêncios, ou nenhuma fala com
 * tempo (a transcrição antiga, sem as falas), caso em que o player toca tudo.
 */
export function trechosParaTocar(segmentos: readonly Segmento[], opcoes: { voz?: string | null; pularSilencios?: boolean }): TrechoParaTocar[] | null {
  const voz = opcoes.voz || null;
  if (!voz && !opcoes.pularSilencios) return null;
  const falas = segmentos.filter(s => !s.lacuna && Number.isFinite(s.inicio) && Number.isFinite(s.fim) && s.fim >= s.inicio
    && (voz ? s.falante === voz && textoTemFala(s.texto) : s.texto.trim() !== ""));
  if (!falas.length) return null;
  const ordenadas = [...falas].sort((a, b) => a.inicio - b.inicio);
  const trechos: TrechoParaTocar[] = [];
  for (const fala of ordenadas) {
    const inicio = Math.max(0, fala.inicio - MARGEM_ANTES_DA_FALA_SEGUNDOS);
    const fim = fala.fim + MARGEM_DEPOIS_DA_FALA_SEGUNDOS;
    const anterior = trechos[trechos.length - 1];
    if (anterior && inicio - anterior.fim < INTERVALO_QUE_JUNTA_SEGUNDOS) anterior.fim = Math.max(anterior.fim, fim);
    else trechos.push({ inicio, fim });
  }
  return trechos;
}

/**
 * Onde tocar a partir de `segundo`: o próprio segundo, se ele cai num trecho;
 * senão, o começo do trecho seguinte. Nulo depois do último trecho.
 */
export function pontoParaTocar(trechos: readonly TrechoParaTocar[], segundo: number): number | null {
  for (const trecho of trechos) {
    if (segundo >= trecho.fim) continue;
    return segundo >= trecho.inicio - FOLGA_DO_PULO_SEGUNDOS ? segundo : trecho.inicio;
  }
  return null;
}

/** Se o segundo cai dentro de um dos trechos (com a folga do pulo no começo). */
export function dentroDosTrechos(trechos: readonly TrechoParaTocar[], segundo: number): boolean {
  return trechos.some(trecho => segundo >= trecho.inicio - FOLGA_DO_PULO_SEGUNDOS && segundo < trecho.fim);
}

/**
 * Onde cai um pulo de `delta` segundos (os 15 s dos botões) contando só o que
 * toca: os intervalos de fora não contam, como o buraco entre as partes em
 * destinoDoPulo (components/PlayerDasPartes.tsx). Sem isto, voltar 15 s
 * ouvindo só uma voz caía na fala de outra pessoa, e o player voltava ao
 * começo da mesma fala: o botão não saía do lugar.
 */
export function destinoDoPuloNosTrechos(trechos: readonly TrechoParaTocar[], segundo: number, delta: number): number {
  if (!trechos.length) return segundo;
  const total = trechos.reduce((soma, trecho) => soma + (trecho.fim - trecho.inicio), 0);
  let posicao = total;
  let antes = 0;
  for (const trecho of trechos) {
    if (segundo < trecho.fim) {
      posicao = antes + Math.max(0, segundo - trecho.inicio);
      break;
    }
    antes += trecho.fim - trecho.inicio;
  }
  let resto = Math.min(total, Math.max(0, posicao + delta));
  for (const trecho of trechos) {
    const duracao = trecho.fim - trecho.inicio;
    if (resto < duracao) return trecho.inicio + resto;
    resto -= duracao;
  }
  return trechos[trechos.length - 1].fim;
}
