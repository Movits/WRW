// Busca de cidade sobre as listas geradas em client/src/data/cidades/<CC>.json.
//
// A parte que decide o que casa (`buscarCidades`) é PURA: recebe o arquivo já
// carregado e devolve as sugestões, sem tocar em rede, em disco ou no React.
// É o que permite provar, em client/src/lib/busca-de-cidades.test.ts, que
// "sao paulo" acha "São Paulo" e "Munich" acha "München" sem montar tela.
//
// Como uma cidade é encontrada: o gerador guardou, dentro da própria linha da
// cidade, uma CHAVE com o nome canônico e os apelidos em outros idiomas já
// normalizados e separados por "|" (ver shared/cidade.ts). A consulta passa
// pela MESMA normalização (shared/normalizar-cidade.ts) e é comparada contra
// essa chave — por isso acento, caixa e idioma deixam de importar, sem nenhuma
// tabela de exceção escrita à mão.

import { normalizarCidade } from "@shared/normalizar-cidade";
import type { ArquivoDeCidades, SugestaoDeCidade } from "@shared/cidade";

/** Separador dos apelidos dentro da chave de busca; também marca o começo de cada apelido. */
const SEPARADOR = "|";

/** Teto de sugestões devolvidas. Mais que isso não cabe na tela nem ajuda a escolher. */
export const LIMITE_DE_SUGESTOES = 50;

/**
 * A faixa que conta como ESCRITA LATINA aqui: do começo do Unicode até o fim do
 * Latin Extended-B (U+024F). Escrita com \u0000, e não com o byte 0x00 literal
 * que este arquivo trazia: um byte nulo no meio do código faz o git e o grep
 * tratarem o arquivo como binário, e o diff deixa de ser legível.
 */
const FORA_DA_ESCRITA_LATINA = /[^\u0000-\u024F]/;

/**
 * Quantos caracteres a consulta precisa ter para valer uma busca. Em escrita
 * latina, uma letra só devolveria meio país; em chinês ou japonês um ideograma
 * já é uma consulta inteira, e exigir dois deixaria o campo mudo.
 */
export function minimoDeCaracteres(consulta: string): number {
  return FORA_DA_ESCRITA_LATINA.test(consulta) ? 1 : 2;
}

/**
 * Sugestões de cidade para a consulta, no máximo `limite`.
 *
 * Ordem do resultado, do melhor para o pior acerto:
 *   1. o NOME CANÔNICO começa com o que foi digitado ("são" → "São Paulo");
 *   2. algum APELIDO em outro idioma começa com o que foi digitado
 *      ("munich" → "München", "londres" → "London");
 *   3. a chave CONTÉM o que foi digitado em qualquer posição
 *      ("paulo" → "São Paulo").
 * Dentro de cada grupo vale a ordem do arquivo, que o gerador já deixou na
 * ordem certa: população decrescente onde a fonte informa população (a cidade
 * maior aparece primeiro), alfabética no Brasil, onde a lista do IBGE não tem
 * população.
 */
export function buscarCidades(
  arquivo: ArquivoDeCidades,
  consulta: string,
  limite: number = LIMITE_DE_SUGESTOES
): SugestaoDeCidade[] {
  const q = normalizarCidade(consulta);
  if (!q || q.length < minimoDeCaracteres(q)) return [];

  const comecaPeloNome: SugestaoDeCidade[] = [];
  const comecaPorApelido: SugestaoDeCidade[] = [];
  const contem: SugestaoDeCidade[] = [];

  for (const [nome, admin, chave] of arquivo.cidades) {
    let balde: SugestaoDeCidade[];
    if (chave.startsWith(q)) balde = comecaPeloNome;
    else if (chave.includes(SEPARADOR + q)) balde = comecaPorApelido;
    else if (chave.includes(q)) balde = contem;
    else continue;

    if (balde.length < limite)
      balde.push({ nome, rotulo: rotularCidade(arquivo, nome, admin) });
    // Com o primeiro grupo cheio, nada que venha depois entraria na resposta.
    if (comecaPeloNome.length >= limite) break;
  }

  return [...comecaPeloNome, ...comecaPorApelido, ...contem].slice(0, limite);
}

/**
 * O que a tela mostra na linha da sugestão: "São Paulo (SP)",
 * "Köln (Nordrhein-Westfalen)" ou, quando a fonte não traz divisão
 * administrativa, "Doha (QA)". O rótulo é só exibição — o que vai para o banco
 * é o nome canônico, sem o parêntese.
 */
export function rotularCidade(
  arquivo: ArquivoDeCidades,
  nome: string,
  admin: string
): string {
  // No Brasil a sigla da UF é como o lugar se lê ("Bom Jesus (PI)"); o nome por
  // extenso do mapa `admins` fica para o seletor de estado.
  const sufixo =
    arquivo.pais === "BR"
      ? admin || arquivo.pais
      : (admin && arquivo.admins[admin]) || admin || arquivo.pais;
  return sufixo ? `${nome} (${sufixo})` : nome;
}

// ── carregamento do arquivo do país ─────────────────────────────────────────

// O Vite resolve este glob em tempo de build e gera um pedaço com hash por
// país: o navegador baixa só o país escolhido, e saber quais países TÊM lista
// não depende de nenhum índice escrito à mão para ficar desatualizado. País
// sem arquivo simplesmente não aparece aqui, e o campo cai em texto livre.
const ARQUIVOS_POR_PAIS = import.meta.glob<{ default: ArquivoDeCidades }>(
  "../data/cidades/*.json"
);

function caminhoDoPais(pais: string): string {
  return `../data/cidades/${pais.toUpperCase()}.json`;
}

export function paisTemLista(pais: string): boolean {
  return Boolean(pais) && caminhoDoPais(pais) in ARQUIVOS_POR_PAIS;
}

const carregados = new Map<string, Promise<ArquivoDeCidades | null>>();

/**
 * Carrega (uma vez por sessão) a lista do país. Devolve null quando o país não
 * tem lista ou quando o carregamento falha: nos dois casos o campo continua
 * aceitando texto livre, porque perder o cadastro por causa de uma sugestão
 * seria trocar um problema pequeno por um grande.
 */
export function carregarCidadesDoPais(
  pais: string
): Promise<ArquivoDeCidades | null> {
  const codigo = (pais || "").toUpperCase();
  if (!paisTemLista(codigo)) return Promise.resolve(null);
  const jaPedido = carregados.get(codigo);
  if (jaPedido) return jaPedido;

  const promessa = ARQUIVOS_POR_PAIS[caminhoDoPais(codigo)]()
    .then(modulo => modulo.default)
    .catch(() => {
      // Falha de rede não fica em cache: a próxima tentativa pode dar certo.
      carregados.delete(codigo);
      return null;
    });
  carregados.set(codigo, promessa);
  return promessa;
}
