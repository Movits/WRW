// Formato dos arquivos de cidade de client/src/data/cidades/<CC>.json, que
// scripts/gerar-cidades.mjs escreve e a busca do navegador lê.
//
// Um arquivo POR PAÍS, e não um arquivo do mundo, porque a tela só precisa do
// país que a usuária escolheu: o Vite gera um pedaço com hash por país e o
// navegador baixa só esse (o mesmo mecanismo que a lista do IBGE já usava,
// agora valendo para qualquer país).
//
// Cada cidade é uma TUPLA, não um objeto: repetir os nomes das propriedades
// 7.500 vezes num país grande custa mais bytes que os próprios dados.
//   [0] nome    — nome canônico, exatamente como vai para o banco quando a
//                 usuária escolhe da lista ("Köln", "São Paulo");
//   [1] admin   — código da divisão administrativa (UF no Brasil, admin1 do
//                 GeoNames fora), que vira rótulo pelo mapa `admins`; "" quando
//                 a fonte não informa;
//   [2] chave   — texto de busca JÁ normalizado por normalizarCidade(), com os
//                 apelidos em outros idiomas separados por "|". O primeiro
//                 trecho é sempre o nome canônico normalizado.
//
// A chave é o que faz "sao paulo", "Munich", "München" e "ケルン" acharem a
// mesma cidade: todos esses nomes moram dentro dela.

export type CidadeDaLista = [nome: string, admin: string, chave: string];

/** Como a lista está ordenada — a busca preserva esta ordem dentro de cada grau de acerto. */
export type OrdemDoArquivo = "populacao-desc" | "alfabetica";

export interface ArquivoDeCidades {
  /** Código ISO 3166-1 alpha-2 do país, em maiúsculas. */
  pais: string;
  /**
   * Fonte dos dados e licença, para o crédito obrigatório em tela: os dados do
   * GeoNames são CC BY 4.0 e exigem atribuição visível. É o que `PaisEstadoCidade`
   * mostra embaixo do campo — "GeoNames cities5000 (CC BY 4.0)".
   */
  fonte: string;
  /**
   * Endereço da fonte, para o crédito virar link ("" quando não houver). O
   * cabeçalho guarda a ORIGEM do dado, e nunca a data de geração: com a data,
   * rodar o gerador duas vezes sobre a mesma fonte dava arquivos diferentes e a
   * regeração deixava de ser conferível.
   */
  fonteUrl: string;
  /** Idiomas cujos apelidos entraram na chave de busca. */
  idiomas: string[];
  /** Critério de ordenação de `cidades`. */
  ordem: OrdemDoArquivo;
  /** Código da divisão administrativa → rótulo legível ("05" → "Nordrhein-Westfalen", "SP" → "SP"). */
  admins: Record<string, string>;
  cidades: CidadeDaLista[];
}

/** Uma linha da lista de sugestões, pronta para a tela. */
export interface SugestaoDeCidade {
  /** O que vai para o banco quando a usuária escolhe esta linha. */
  nome: string;
  /** O que a tela mostra: "São Paulo (SP)", "Köln (Nordrhein-Westfalen)", "Doha (QA)". */
  rotulo: string;
}

/** Os 10 idiomas do site, na forma de código ISO 639-1 usada pelo GeoNames. */
export const IDIOMAS_DO_SITE = [
  "pt",
  "en",
  "es",
  "fr",
  "de",
  "ru",
  "ar",
  "hi",
  "zh",
  "ja",
] as const;
