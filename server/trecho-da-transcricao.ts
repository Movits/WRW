import type { Segmento } from "./transcricao-de-fatia";

/**
 * O trecho literal da transcrição que sustenta o que a IA disse sobre uma
 * reunião: onde ele está, em que segundo começa e o que foi dito em volta.
 * Servem ao "Pergunte à reunião" e ao resumo guardado (H4 do desenho do
 * gravador, docs/arquitetura/gravador-de-reunioes.md).
 */

// Menos que isso ("sim", "ok", um nome) aparece em qualquer transcrição e não prova nada.
const TAMANHO_MINIMO_DO_TRECHO = 8;
// Cada pedaço entre reticências: sem esse mínimo, "a ... e ... i" juntaria
// letras soltas de qualquer ponto da transcrição.
const TAMANHO_MINIMO_DO_PEDACO = 4;
// Em volta do trecho, as falas (ou letras, no envio único sem falas) em que
// responsável e prazo precisam aparecer para ficar no item.
const FALAS_EM_VOLTA = 3;
const LETRAS_EM_VOLTA = 400;

// Pelo construtor, como ESCRITA_SEM_ESPACO em meeting-service.ts: o alvo do
// tsconfig não aceita a flag u num literal.
const FORA_DE_LETRAS_E_NUMEROS = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");
// O rótulo que a IA às vezes copia junto da fala: "[12:34]", "[1:02:03]",
// "{F2}:" ou "F2:".
const ROTULO_DE_TEMPO = /\[\d{1,2}(?::\d{2}){1,2}\]/g;
const ROTULO_DE_VOZ = /\{?\bF[1-9]\d?\b\}?\s*:/g;

/**
 * Só letras, marcas e números, em minúsculas, separados por um espaço: o modelo
 * troca uma vírgula, acrescenta aspas ou junta espaços, e isso não faz o
 * trecho deixar de estar na transcrição.
 */
export function normalizarParaComparar(texto: string): string {
  return texto.normalize("NFC").toLowerCase().replace(FORA_DE_LETRAS_E_NUMEROS, " ").trim();
}

/** Tira do trecho os rótulos de tempo e de voz que a IA copiou junto da fala. */
export function limparRotulos(trecho: string): string {
  return trecho.replace(ROTULO_DE_TEMPO, " ").replace(ROTULO_DE_VOZ, " ").replace(/\s+/g, " ").trim();
}

/** Os pedaços do trecho (separados por reticências), já normalizados, ou null se não provam nada. */
function pedacosDoTrecho(trecho: unknown): string[] | null {
  if (typeof trecho !== "string") return null;
  const pedacos = trecho.split(/\.{3}|…/).map(normalizarParaComparar).filter(Boolean);
  const letras = (pedaco: string) => pedaco.replace(/ /g, "").length;
  const tamanho = pedacos.reduce((soma, pedaco) => soma + letras(pedaco), 0);
  if (!pedacos.length || tamanho < TAMANHO_MINIMO_DO_TRECHO) return null;
  if (pedacos.some(pedaco => letras(pedaco) < TAMANHO_MINIMO_DO_PEDACO)) return null;
  return pedacos;
}

/** Onde os pedaços aparecem em `fonte` (já normalizada), na ordem: [início, fim) ou null. */
function ondeNaFonte(pedacos: string[], fonte: string): [number, number] | null {
  // Cada pedaço é procurado depois do fim do anterior: fora de ordem não vale.
  let desde = 0;
  let comeco = -1;
  for (const pedaco of pedacos) {
    const onde = fonte.indexOf(pedaco, desde);
    if (onde < 0) return null;
    if (comeco < 0) comeco = onde;
    desde = onde + pedaco.length;
  }
  return [comeco, desde];
}

/**
 * O trecho citado está na transcrição? Com reticências ("vamos fechar ... até
 * sexta"), cada pedaço precisa estar, com pelo menos 4 letras ou números e na
 * mesma ordem da transcrição. Não usa o trechoEstaNaFonte do Network
 * Inteligente de propósito: ele recusa trecho com negação, e "decidimos não
 * renovar" é uma decisão legítima de resumo.
 */
export function trechoApareceNaTranscricao(trecho: unknown, transcricao: string): boolean {
  const pedacos = pedacosDoTrecho(trecho);
  return !!pedacos && ondeNaFonte(pedacos, normalizarParaComparar(transcricao)) !== null;
}

/** As falas válidas, sem as lacunas (o trecho que não chegou não tem texto). */
function falasComTexto(segmentos: readonly Segmento[]): Segmento[] {
  return segmentos.filter(segmento => !segmento.lacuna && typeof segmento.texto === "string" && segmento.texto.trim());
}

/**
 * As falas emendadas num texto só, normalizado, com a posição em que cada
 * fala começa: um trecho que cruza duas falas também é achado.
 */
function falasEmendadas(segmentos: readonly Segmento[]) {
  const falas = falasComTexto(segmentos);
  const inicios: number[] = [];
  let fonte = "";
  for (const fala of falas) {
    if (fonte) fonte += " ";
    inicios.push(fonte.length);
    fonte += normalizarParaComparar(fala.texto);
  }
  return { falas, inicios, fonte };
}

/** O índice da fala que contém a posição `pos` do texto emendado. */
function falaNaPosicao(inicios: number[], pos: number): number {
  let i = 0;
  while (i + 1 < inicios.length && inicios[i + 1] <= pos) i++;
  return i;
}

/** As falas cobertas pelo trecho: [primeira, última] ou null. */
function falasDoTrecho(trecho: unknown, segmentos: readonly Segmento[]) {
  const pedacos = pedacosDoTrecho(trecho);
  if (!pedacos) return null;
  const emendadas = falasEmendadas(segmentos);
  const onde = ondeNaFonte(pedacos, emendadas.fonte);
  if (!onde) return null;
  return { ...emendadas, primeira: falaNaPosicao(emendadas.inicios, onde[0]), ultima: falaNaPosicao(emendadas.inicios, Math.max(onde[0], onde[1] - 1)) };
}

/**
 * O segundo da reunião em que o trecho começa (o início da fala em que ele
 * começa), para o "▶ mm:ss" da tela. Null quando a transcrição não tem falas
 * (envio único) ou o trecho não está nelas.
 */
export function localizarTrecho(trecho: unknown, segmentos: readonly Segmento[]): number | null {
  const achado = falasDoTrecho(trecho, segmentos);
  if (!achado) return null;
  const inicio = achado.falas[achado.primeira].inicio;
  return Number.isFinite(inicio) && inicio >= 0 ? Math.floor(inicio) : null;
}

/**
 * O que foi dito em volta do trecho: as falas dele e até 3 de cada lado, com
 * os rótulos de quem falou nelas; sem falas (envio único), 400 letras de cada
 * lado no texto corrido. Null se o trecho não está na transcrição. É onde o
 * responsável e o prazo de um item precisam aparecer para ficar nele.
 */
export function vizinhanca(trecho: unknown, transcricao: string, segmentos: readonly Segmento[]): { texto: string; falantes: Set<string> } | null {
  if (falasComTexto(segmentos).length) {
    const achado = falasDoTrecho(trecho, segmentos);
    if (!achado) return null;
    const em = achado.falas.slice(Math.max(0, achado.primeira - FALAS_EM_VOLTA), achado.ultima + FALAS_EM_VOLTA + 1);
    return { texto: em.map(fala => fala.texto).join("\n"), falantes: new Set(em.map(fala => fala.falante)) };
  }
  const pedacos = pedacosDoTrecho(trecho);
  if (!pedacos) return null;
  const fonte = normalizarParaComparar(transcricao);
  const onde = ondeNaFonte(pedacos, fonte);
  if (!onde) return null;
  return { texto: fonte.slice(Math.max(0, onde[0] - LETRAS_EM_VOLTA), onde[1] + LETRAS_EM_VOLTA), falantes: new Set() };
}
