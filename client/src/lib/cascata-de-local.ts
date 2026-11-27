// A regra da cascata país → estado → cidade, sem React: o que PaisEstadoCidade
// mostra em cada nível sai daqui, e os testes provam a regra sem montar tela.
//
// Decisão do Roberto (26/11): fazer como os apps fazem. Primeiro o país; depois,
// se o país tem estados ou províncias, o estado; depois a cidade daquele estado.
// Nunca a lista inteira de cidades do mundo, nem a de um país grande, de uma vez.
//
// O BANCO NÃO MUDOU: `user_profiles.country` continua o código de duas letras e
// `user_profiles.city` o nome da cidade em texto. O estado NÃO é gravado: ele é
// só o filtro que leva à cidade, e ao reabrir o perfil é deduzido da cidade
// gravada (`deduzirEstado`). Cidade que não está na lista (texto livre antigo,
// distrito, vila) continua aparecendo e continua valendo.

import { normalizarCidade } from "@shared/normalizar-cidade";
import type { ArquivoDeCidades, SugestaoDeCidade } from "@shared/cidade";
import {
  CODIGO_OUTRO,
  listarPaises,
  nomeDoPais,
  type PaisComRotulo,
} from "@shared/paises";
import { PAISES_GERADOS } from "@shared/paises-gerados";
import { buscarCidades, LIMITE_DE_SUGESTOES } from "./busca-de-cidades";

/** Uma linha de qualquer um dos três seletores. */
export interface OpcaoDeLocal {
  /** O que a escolha grava ou passa adiante: código do país, código do estado, nome da cidade. */
  valor: string;
  /** O que a tela mostra. */
  rotulo: string;
}

/**
 * Abaixo deste número de cidades o país vai direto à cidade, sem o nível do
 * estado. Mônaco, Malta ou Catar têm divisões administrativas no GeoNames, mas
 * pedir a "paróquia" ou o "distrito" antes de uma lista de 20 cidades é um passo
 * a mais que não ajuda ninguém a achar a própria cidade.
 */
export const MINIMO_DE_CIDADES_PARA_PEDIR_ESTADO = 40;

/**
 * Os estados (divisões de primeiro nível) que TÊM cidade na lista, em ordem
 * alfabética do idioma da tela. Divisão sem cidade não entra: escolhê-la levaria
 * a uma lista de cidades vazia.
 */
export function estadosDoPais(
  arquivo: ArquivoDeCidades,
  idioma: string
): OpcaoDeLocal[] {
  const usados = new Set<string>();
  for (const [, admin] of arquivo.cidades) if (admin) usados.add(admin);
  return Array.from(usados)
    .map(codigo => ({
      valor: codigo,
      rotulo: arquivo.admins[codigo] || codigo,
    }))
    .sort((a, b) =>
      a.rotulo.localeCompare(b.rotulo, idioma, { sensitivity: "base" })
    );
}

/** Se o país pede o estado antes da cidade (ver MINIMO_DE_CIDADES_PARA_PEDIR_ESTADO). */
export function paisPedeEstado(arquivo: ArquivoDeCidades | null): boolean {
  if (!arquivo || arquivo.cidades.length <= MINIMO_DE_CIDADES_PARA_PEDIR_ESTADO)
    return false;
  const usados = new Set<string>();
  for (const [, admin] of arquivo.cidades) {
    if (admin) usados.add(admin);
    if (usados.size >= 2) return true;
  }
  return false;
}

const recortes = new WeakMap<ArquivoDeCidades, Map<string, ArquivoDeCidades>>();

/**
 * O arquivo do país reduzido às cidades de um estado, no mesmo formato, para a
 * mesma busca valer nos dois casos. Fica guardado: recortar 7.500 cidades a
 * cada tecla seria trabalho repetido à toa.
 */
export function recortarEstado(
  arquivo: ArquivoDeCidades,
  estado: string
): ArquivoDeCidades {
  if (!estado) return arquivo;
  let doPais = recortes.get(arquivo);
  if (!doPais) {
    doPais = new Map();
    recortes.set(arquivo, doPais);
  }
  const emCache = doPais.get(estado);
  if (emCache) return emCache;
  const recorte = {
    ...arquivo,
    cidades: arquivo.cidades.filter(([, admin]) => admin === estado),
  };
  doPais.set(estado, recorte);
  return recorte;
}

/**
 * Sugestões de cidade. Com o estado escolhido e o campo vazio, mostra as
 * primeiras cidades dele (as maiores, onde a fonte informa população): é o que
 * a usuária espera ver ao tocar no campo depois de escolher o estado.
 *
 * O rótulo é só o nome, menos num caso: país que pede estado, com o estado
 * ainda em branco (cidade antiga que não se achou na lista). Aí a busca vale
 * para o país inteiro e o rótulo traz a divisão entre parênteses, para
 * distinguir as homônimas ("Bom Jesus (PI)", "Bom Jesus (RS)").
 */
export function sugerirCidades(
  arquivo: ArquivoDeCidades,
  estado: string,
  consulta: string
): OpcaoDeLocal[] {
  const comDivisao = !estado && paisPedeEstado(arquivo);
  const base = recortarEstado(arquivo, estado);
  if (estado && !consulta.trim()) {
    return base.cidades
      .slice(0, LIMITE_DE_SUGESTOES)
      .map(([nome]) => ({ valor: nome, rotulo: nome }));
  }
  return buscarCidades(base, consulta, LIMITE_DE_SUGESTOES).map(
    (s: SugestaoDeCidade) => ({
      valor: s.nome,
      rotulo: comDivisao ? s.rotulo : s.nome,
    })
  );
}

/**
 * O estado da cidade já gravada, para o perfil reabrir com a cascata preenchida.
 * Só devolve quando a resposta é única: "Bom Jesus" existe em quatro UFs, e
 * chutar uma delas mostraria o estado errado. Sem resposta única, o estado fica
 * em branco e a cidade gravada continua no campo, como estava.
 */
export function deduzirEstado(
  arquivo: ArquivoDeCidades,
  cidade: string
): string {
  const alvo = normalizarCidade(cidade);
  if (!alvo) return "";
  const achados = new Set<string>();
  for (const [nome, admin] of arquivo.cidades) {
    if (normalizarCidade(nome) === alvo) achados.add(admin);
    if (achados.size > 1) return "";
  }
  const [unico] = Array.from(achados);
  return unico ?? "";
}

/** Filtro de uma lista curta (países, estados) pelo que foi digitado, sem acento nem caixa. */
export function filtrarOpcoes(
  opcoes: OpcaoDeLocal[],
  consulta: string,
  chaveExtra?: (opcao: OpcaoDeLocal) => string
): OpcaoDeLocal[] {
  const q = normalizarCidade(consulta);
  if (!q) return opcoes;
  const comeca: OpcaoDeLocal[] = [];
  const contem: OpcaoDeLocal[] = [];
  for (const opcao of opcoes) {
    const rotulo = normalizarCidade(opcao.rotulo);
    const extra = chaveExtra ? chaveExtra(opcao) : "";
    if (
      rotulo.startsWith(q) ||
      extra.split("|").some(parte => parte.startsWith(q))
    )
      comeca.push(opcao);
    else if (rotulo.includes(q)) contem.push(opcao);
  }
  return [...comeca, ...contem];
}

const RESERVA_EM_INGLES = new Map<string, string>(
  PAISES_GERADOS.map(([codigo, reserva]) => [codigo, normalizarCidade(reserva)])
);

/**
 * Os países no idioma da tela, filtrados. A busca também acha pelo nome em
 * inglês e pelo código ("germany" e "de" acham a Alemanha em qualquer idioma):
 * quem cresceu falando outra língua nem sempre pensa no nome do país na língua
 * em que a tela está.
 */
export function sugerirPaises(
  idioma: string,
  rotuloDeOutro: string,
  consulta: string
): OpcaoDeLocal[] {
  const opcoes = listarPaises(idioma, rotuloDeOutro).map(
    (p: PaisComRotulo) => ({
      valor: p.codigo,
      rotulo: p.rotulo,
    })
  );
  return filtrarOpcoes(
    opcoes,
    consulta,
    opcao =>
      `${RESERVA_EM_INGLES.get(opcao.valor) ?? ""}|${opcao.valor.toLowerCase()}`
  );
}

/** Nome do país para exibir, com o "Outro" do cadastro antigo traduzido. */
export function rotuloDoPais(
  codigo: string,
  idioma: string,
  rotuloDeOutro: string
): string {
  if (!codigo) return "";
  return codigo.toUpperCase() === CODIGO_OUTRO
    ? rotuloDeOutro
    : nomeDoPais(codigo, idioma);
}
