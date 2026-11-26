/**
 * A resposta em forma visual do Pergunte (H6d do plano do gravador; HN-45 no
 * app de referência da cliente): quando a pergunta pede, a IA devolve, junto
 * da resposta, uma tabela ou os dados de um gráfico, num formato FIXO (o
 * esquema de server/resposta-visual.ts). O servidor confere tudo antes de
 * mandar à tela (visualConferido, no mesmo arquivo), e a tela desenha o
 * gráfico com os números (client/src/components/VisualDaResposta.tsx).
 *
 * Nunca vem HTML, SVG, Markdown ou código da IA: cada célula é texto, e o
 * React a escapa. As vozes chegam como rótulo ({F2} numa reunião, {R2:F1}
 * entre reuniões) e viram nome na tela, como na resposta.
 *
 * Os limites cabem numa tela de celular e na paleta conferida para quem não
 * distingue cores (4 séries; o validador do gráfico na PR).
 */

export const TIPOS_DE_VISUAL = ["tabela", "barras", "linhas"] as const;
export type TipoDeVisual = (typeof TIPOS_DE_VISUAL)[number];

/** Colunas da tabela; no gráfico, a primeira é o nome de cada item e as outras são as séries. */
export const COLUNAS_DO_VISUAL_MAX = 5;
/** Séries de um gráfico: as quatro primeiras cores da paleta conferida. */
export const SERIES_DO_GRAFICO_MAX = COLUNAS_DO_VISUAL_MAX - 1;
export const LINHAS_DO_VISUAL_MAX = 12;
export const TITULO_DO_VISUAL_MAX = 100;
export const CABECALHO_DO_VISUAL_MAX = 40;
export const CELULA_DO_VISUAL_MAX = 80;
export const UNIDADE_DO_VISUAL_MAX = 20;
/** O maior número que um gráfico mostra (em módulo): acima disso, o valor não é de conversa. */
export const VALOR_DO_GRAFICO_MAX = 1e15;

export type TabelaDaResposta = {
  tipo: "tabela";
  titulo: string;
  colunas: string[];
  linhas: string[][];
};

export type SerieDoGrafico = { nome: string; valores: number[] };

export type GraficoDaResposta = {
  tipo: "barras" | "linhas";
  titulo: string;
  /** O nome da primeira coluna: o que cada item (ou momento) é. */
  eixo: string;
  /** "R$", "%", "contêineres"; vazia quando não há. */
  unidade: string;
  /** O nome de cada item, na ordem em que aparece. */
  rotulos: string[];
  series: SerieDoGrafico[];
};

export type VisualDaResposta = TabelaDaResposta | GraficoDaResposta;

export function ehGrafico(visual: VisualDaResposta): visual is GraficoDaResposta {
  return visual.tipo === "barras" || visual.tipo === "linhas";
}

/**
 * O número de uma célula de série, como a IA foi instruída a escrever: só os
 * algarismos, com o sinal e o ponto decimal ("1200", "-3.5"). A vírgula
 * decimal sozinha ("3,5") também vale. Qualquer outra coisa ("1.200,50",
 * "R$ 10", "dez", "10%") é null: o gráfico não adivinha o que a IA quis dizer.
 */
export function numeroDaCelula(celula: string): number | null {
  const limpo = celula.trim().replace(/\s+/g, "");
  let texto: string;
  if (/^-?\d+(\.\d+)?$/.test(limpo)) texto = limpo;
  else if (/^-?\d+,\d+$/.test(limpo)) texto = limpo.replace(",", ".");
  else return null;
  const valor = Number(texto);
  return Number.isFinite(valor) && Math.abs(valor) <= VALOR_DO_GRAFICO_MAX ? valor : null;
}
