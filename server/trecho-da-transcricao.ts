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
// Em volta do trecho, os turnos (falas seguidas da mesma voz contam como um
// turno, como a IA as lê) ou, no envio único sem falas, as letras em que
// responsável e prazo de um item precisam aparecer para ficar nele.
const TURNOS_EM_VOLTA = 3;
const LETRAS_EM_VOLTA = 400;
// Uma frase comum ("vou mandar a proposta") pode se repetir na reunião: cada
// vez é uma ocorrência, até este teto.
const OCORRENCIAS_NO_MAXIMO = 20;
// A regra do prompt (REGRA_DO_TRECHO, em reuniao-com-ia.ts): o trecho é cópia
// de 5 a 30 palavras SEGUIDAS da transcrição. Com reticências, os pedaços
// precisam caber nessas 30 palavras: um "[...]" que emenda falas distantes
// alargaria a vizinhança em que o resumo procura responsável e prazo. O mínimo
// vale para o trecho que o app encurta (trechoDentroDaRegra); o que a IA manda
// segue o mínimo de letras de sempre.
const PALAVRAS_SEGUIDAS_NO_MAXIMO = 30;
const PALAVRAS_SEGUIDAS_NO_MINIMO = 5;
// Só limita até onde se procuram os pedaços seguintes, para a busca não varrer
// a reunião inteira a cada vez que o primeiro aparece; a regra é contada em
// palavras. 30 palavras nunca chegam perto disso.
const LETRAS_DA_JANELA = 2_000;

// Pelo construtor, como ESCRITA_SEM_ESPACO em meeting-service.ts: o alvo do
// tsconfig não aceita a flag u num literal.
const FORA_DE_LETRAS_E_NUMEROS = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");
// Escritas que não separam as palavras por espaço (chinês, japonês e
// tailandês): nelas cada caractere conta como uma palavra, o lado estrito da
// conta. A mesma lista de ESCRITA_SEM_ESPACO (meeting-service.ts), copiada para
// este módulo não carregar o serviço da reunião inteiro.
const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}]", "u");
const RETICENCIAS = /\.{3}|…/;
const CADA_RETICENCIAS = /\.{3}|…/g;
// O que sobra nas pontas de uma parte tirada de entre reticências: os
// colchetes de "[...]", os parênteses de "(...)", a vírgula e o espaço.
const SOBRA_NO_COMECO = /^[\s)\]},;:.–—-]+/;
const SOBRA_NO_FIM = /[\s([{,;:–—-]+$/;
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

/** Quantas palavras tem um texto já normalizado; nas escritas sem espaço, cada caractere conta como uma. */
function contarPalavras(normalizado: string): number {
  let total = 0;
  for (const palavra of normalizado.split(" ")) {
    if (palavra) total += ESCRITA_SEM_ESPACO.test(palavra) ? Array.from(palavra).length : 1;
  }
  return total;
}

/** Os pedaços do trecho (separados por reticências), já normalizados, ou null se não provam nada. */
function pedacosDoTrecho(trecho: unknown): string[] | null {
  if (typeof trecho !== "string") return null;
  const pedacos = trecho.split(RETICENCIAS).map(normalizarParaComparar).filter(Boolean);
  const letras = (pedaco: string) => pedaco.replace(/ /g, "").length;
  const tamanho = pedacos.reduce((soma, pedaco) => soma + letras(pedaco), 0);
  if (!pedacos.length || tamanho < TAMANHO_MINIMO_DO_TRECHO) return null;
  if (pedacos.some(pedaco => letras(pedaco) < TAMANHO_MINIMO_DO_PEDACO)) return null;
  return pedacos;
}

/**
 * Onde os pedaços aparecem em `fonte` (já normalizada), na ordem, na primeira
 * vez: [início, fim) ou null.
 */
function ondeNaFonte(pedacos: string[], fonte: string): [number, number] | null {
  // Cada pedaço é procurado depois do fim do anterior: fora de ordem não vale.
  let cursor = 0;
  let comeco = -1;
  for (const pedaco of pedacos) {
    const onde = fonte.indexOf(pedaco, cursor);
    if (onde < 0) return null;
    if (comeco < 0) comeco = onde;
    cursor = onde + pedaco.length;
  }
  return [comeco, cursor];
}

/**
 * Todas as vezes em que o trecho aparece, até o teto. Com reticências, só
 * conta a vez em que os pedaços cabem em 30 palavras seguidas (a regra do
 * prompt): pedaços que só aparecem longe uns dos outros não são uma
 * ocorrência, e a vizinhança nunca se estica até uma fala distante.
 */
function todasAsOcorrencias(pedacos: string[], fonte: string): Array<[number, number]> {
  const achadas: Array<[number, number]> = [];
  for (let comeco = fonte.indexOf(pedacos[0]); comeco >= 0 && achadas.length < OCORRENCIAS_NO_MAXIMO; comeco = fonte.indexOf(pedacos[0], comeco + 1)) {
    if (pedacos.length === 1) {
      achadas.push([comeco, comeco + pedacos[0].length]);
      continue;
    }
    const janela = fonte.slice(comeco, comeco + LETRAS_DA_JANELA);
    const onde = ondeNaFonte(pedacos, janela);
    if (onde && contarPalavras(janela.slice(onde[0], onde[1])) <= PALAVRAS_SEGUIDAS_NO_MAXIMO) achadas.push([comeco + onde[0], comeco + onde[1]]);
  }
  return achadas;
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

/**
 * As falas com o que comparar: sem as lacunas (o trecho que não chegou) e sem
 * as que só têm pontuação ("...", "?"), que não têm letra para casar e
 * deixariam um espaço a mais entre as vizinhas.
 */
function falasComTexto(segmentos: readonly Segmento[]): Segmento[] {
  return segmentos.filter(segmento => !segmento.lacuna && typeof segmento.texto === "string" && normalizarParaComparar(segmento.texto));
}

/**
 * As falas emendadas num texto só, normalizado, com a posição em que cada
 * fala começa (um trecho que cruza duas falas também é achado) e o turno de
 * cada uma (falas seguidas da mesma voz são um turno).
 */
function falasEmendadas(segmentos: readonly Segmento[]) {
  const falas = falasComTexto(segmentos);
  const inicios: number[] = [];
  const turnos: number[] = [];
  let fonte = "";
  let turno = -1;
  falas.forEach((fala, i) => {
    if (fonte) fonte += " ";
    inicios.push(fonte.length);
    fonte += normalizarParaComparar(fala.texto);
    if (i === 0 || fala.falante !== falas[i - 1].falante) turno++;
    turnos.push(turno);
  });
  return { falas, inicios, turnos, fonte };
}

/** O índice da fala que contém a posição `pos` do texto emendado. */
function falaNaPosicao(inicios: number[], pos: number): number {
  let i = 0;
  while (i + 1 < inicios.length && inicios[i + 1] <= pos) i++;
  return i;
}

export type OcorrenciaDoTrecho = {
  /** O segundo da reunião em que o trecho começa; null sem falas (envio único). */
  inicio: number | null;
  /** O que foi dito em volta do trecho, com ele. */
  texto: string;
  /** Quem falou em volta (rótulos F1, F2...); vazio no envio único. */
  falantes: Set<string>;
};

/**
 * Cada vez em que o trecho aparece na reunião, com o segundo em que começa e o
 * que foi dito em volta: as falas dele e as de até 3 turnos de cada lado (no
 * envio único, sem falas, 400 letras de cada lado no texto corrido). Vazio
 * quando o trecho não está na transcrição — ou, com reticências, quando os
 * pedaços só aparecem longe uns dos outros (ver trechoDentroDaRegra).
 */
export function ocorrenciasDoTrecho(trecho: unknown, transcricao: string, segmentos: readonly Segmento[]): OcorrenciaDoTrecho[] {
  const pedacos = pedacosDoTrecho(trecho);
  if (!pedacos) return [];
  const emendadas = falasEmendadas(segmentos);
  if (emendadas.falas.length) {
    const { falas, inicios, turnos, fonte } = emendadas;
    return todasAsOcorrencias(pedacos, fonte).map(([comeco, fim]) => {
      const primeira = falaNaPosicao(inicios, comeco);
      const ultima = falaNaPosicao(inicios, Math.max(comeco, fim - 1));
      const emVolta = falas.filter((_, i) => turnos[i] >= turnos[primeira] - TURNOS_EM_VOLTA && turnos[i] <= turnos[ultima] + TURNOS_EM_VOLTA);
      const inicio = falas[primeira].inicio;
      return {
        inicio: Number.isFinite(inicio) && inicio >= 0 ? Math.floor(inicio) : null,
        texto: emVolta.map(fala => fala.texto).join("\n"),
        falantes: new Set(emVolta.map(fala => fala.falante)),
      };
    });
  }
  const fonte = normalizarParaComparar(transcricao);
  return todasAsOcorrencias(pedacos, fonte).map(([comeco, fim]) => ({
    inicio: null,
    texto: fonte.slice(Math.max(0, comeco - LETRAS_EM_VOLTA), fim + LETRAS_EM_VOLTA),
    falantes: new Set<string>(),
  }));
}

/**
 * O trecho como a regra do prompt pede: palavras seguidas da transcrição. Com
 * reticências, os pedaços precisam caber em 30 palavras seguidas. Quando só
 * aparecem longe uns dos outros (um "[...]" que emenda falas distantes), fica
 * uma parte do trecho que cabe e tem as 5 palavras da regra: o começo dele, o
 * mais longo que der (é para onde o "▶" já apontava); se o começo não chega a
 * 5 palavras ("Eu sei. [...]"), a maior das outras partes. Sem nenhuma, null,
 * e o item sai. Trecho sem reticências, e trecho que nem aparece na
 * transcrição, voltam como vieram: quem chama confere a presença
 * (trechoApareceNaTranscricao).
 */
export function trechoDentroDaRegra(trecho: string, transcricao: string, segmentos: readonly Segmento[]): string | null {
  const pedacos = pedacosDoTrecho(trecho);
  if (!pedacos || pedacos.length === 1) return trecho;
  const emendadas = falasEmendadas(segmentos);
  const fonte = emendadas.falas.length ? emendadas.fonte : normalizarParaComparar(transcricao);
  if (!ondeNaFonte(pedacos, fonte) || todasAsOcorrencias(pedacos, fonte).length) return trecho;

  // Os pedaços com a posição no trecho como veio, para devolver o texto dele.
  const crus: Array<{ inicio: number; fim: number; normalizado: string }> = [];
  let inicio = 0;
  for (const reticencias of [...Array.from(trecho.matchAll(CADA_RETICENCIAS)), null]) {
    const fim = reticencias ? reticencias.index ?? 0 : trecho.length;
    const normalizado = normalizarParaComparar(trecho.slice(inicio, fim));
    if (normalizado) crus.push({ inicio, fim, normalizado });
    if (reticencias) inicio = fim + reticencias[0].length;
  }
  // Cada parte seguida de pedaços (menos o trecho inteiro, que não cabe): as
  // que começam no começo do trecho primeiro, e entre elas a mais longa.
  const partes: Array<{ primeiro: number; ultimo: number; palavras: number }> = [];
  for (let primeiro = 0; primeiro < crus.length; primeiro++) {
    for (let ultimo = primeiro; ultimo < crus.length; ultimo++) {
      if (primeiro === 0 && ultimo === crus.length - 1) continue;
      const palavras = contarPalavras(crus.slice(primeiro, ultimo + 1).map(cru => cru.normalizado).join(" "));
      if (palavras >= PALAVRAS_SEGUIDAS_NO_MINIMO) partes.push({ primeiro, ultimo, palavras });
    }
  }
  partes.sort((a, b) => Number(a.primeiro > 0) - Number(b.primeiro > 0) || b.palavras - a.palavras || a.primeiro - b.primeiro);
  for (const { primeiro, ultimo } of partes) {
    const parte = trecho.slice(crus[primeiro].inicio, crus[ultimo].fim).replace(SOBRA_NO_COMECO, "").replace(SOBRA_NO_FIM, "");
    const pedacosDaParte = pedacosDoTrecho(parte);
    if (pedacosDaParte && todasAsOcorrencias(pedacosDaParte, fonte).length) return parte;
  }
  return null;
}

/**
 * O segundo da reunião em que o trecho começa (o início da fala em que ele
 * começa, na primeira vez em que aparece), para o "▶ mm:ss" da tela. Null
 * quando a transcrição não tem falas (envio único) ou o trecho não está nelas.
 */
export function localizarTrecho(trecho: unknown, segmentos: readonly Segmento[]): number | null {
  if (!falasComTexto(segmentos).length) return null;
  return ocorrenciasDoTrecho(trecho, "", segmentos)[0]?.inicio ?? null;
}

/** O que foi dito em volta da primeira vez em que o trecho aparece; null se ele não está na transcrição. */
export function vizinhanca(trecho: unknown, transcricao: string, segmentos: readonly Segmento[]): { texto: string; falantes: Set<string> } | null {
  const [primeira] = ocorrenciasDoTrecho(trecho, transcricao, segmentos);
  return primeira ? { texto: primeira.texto, falantes: primeira.falantes } : null;
}
