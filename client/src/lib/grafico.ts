/**
 * As contas do gráfico da resposta visual do Pergunte (H6d;
 * components/VisualDaResposta.tsx): o domínio com o zero, as marcas redondas
 * do eixo e o número no idioma da tela. Funções puras, testadas em
 * grafico.test.ts.
 */

/** As cores das séries: as quatro primeiras da paleta conferida para quem não distingue cores, no fundo escuro da tela. */
export const CORES_DAS_SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"] as const;

/** O domínio do eixo de valores, sempre com o zero (a barra cresce de uma linha de base só). */
export function dominioComZero(valores: readonly number[]): [number, number] {
  const finitos = valores.filter(Number.isFinite);
  const menor = Math.min(0, ...finitos);
  const maior = Math.max(0, ...finitos);
  return menor === maior ? [0, 1] : [menor, maior];
}

/** Um passo "redondo" (1, 2, 2,5 ou 5 vezes uma potência de 10) perto do tamanho pedido. */
function passoRedondo(bruto: number): number {
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const fracao = bruto / potencia;
  const passo = fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 2.5 ? 2.5 : fracao <= 5 ? 5 : 10;
  return passo * potencia;
}

/**
 * As marcas do eixo: números redondos que cobrem o domínio, com o zero entre
 * elas, cerca de `alvo` intervalos. Devolve também o domínio arredondado, que
 * é o que o gráfico desenha.
 */
export function marcasDoEixo(dominio: readonly [number, number], alvo = 4): { marcas: number[]; dominio: [number, number] } {
  const [menor, maior] = dominio;
  const passo = passoRedondo((maior - menor) / Math.max(1, alvo));
  const inicio = Math.floor(menor / passo) * passo;
  const fim = Math.ceil(maior / passo) * passo;
  const marcas: number[] = [];
  // Arredondado para o passo: somas de 0,1 não deixam 0,30000000000000004 no eixo.
  const casas = Math.max(0, -Math.floor(Math.log10(passo)) + 1);
  for (let valor = inicio; valor <= fim + passo / 2; valor += passo) marcas.push(Number(valor.toFixed(casas)));
  return { marcas, dominio: [inicio, fim] };
}

/** A posição (de 0 a 1) de um valor no domínio. */
export function posicaoNoDominio(valor: number, dominio: readonly [number, number]): number {
  const [menor, maior] = dominio;
  return maior === menor ? 0 : (valor - menor) / (maior - menor);
}

const SIMBOLO_DE_MOEDA = /[$€£¥₹₽]|R\$/;

/**
 * O número no idioma da tela, com a unidade: a moeda antes ("R$ 1.200"), o
 * "%" colado depois ("30%") e o resto depois, com espaço ("12 contêineres").
 * `compacto` encurta os grandes no eixo ("12 mil", "12K").
 */
export function numeroComUnidade(valor: number, idioma: string, unidade = "", compacto = false): string {
  let numero: string;
  try {
    numero = new Intl.NumberFormat(idioma, compacto && Math.abs(valor) >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(valor);
  } catch {
    numero = String(valor);
  }
  const limpa = unidade.trim();
  if (!limpa) return numero;
  if (limpa === "%") return `${numero}%`;
  if (SIMBOLO_DE_MOEDA.test(limpa) && Array.from(limpa).length <= 3) return `${limpa} ${numero}`;
  return `${numero} ${limpa}`;
}
