/**
 * A CNAE como "o que tem" (N4; desenho em docs/arquitetura/entidades.md, seção 2).
 *
 * A CNAE é a atividade da empresa, e atividade é OFERTA: o código da planilha
 * da entidade vira item de "o que tem" do associado, com a origem "cnae". Ela
 * NUNCA vira necessidade ("a padaria precisa de farinha" é inferência, e a
 * regra da demanda expressa proíbe: server/CLAUDE.md). O match só nasce quando
 * alguém DECLARA, em "o que preciso", algo que esse item atende, pelas regras
 * de sempre dos motores (concorrentes zeram, palavra solta não cruza, serviço
 * só com necessidade declarada).
 *
 * A tabela é a da CNAE 2.3 do IBGE (server/cnae/cnae-2-3.json, gerada por
 * scripts/cnae/gerar-tabela-cnae.mjs, com a fonte e a data dentro). O rótulo
 * da oferta é o texto oficial, em frase comum, com dois cortes que evitam o
 * falso match:
 * - a cláusula "exceto ..." sai: "Transporte rodoviário de carga, exceto
 *   produtos perigosos e mudanças" casava com quem procura "transporte de
 *   mudança", justamente o que a subclasse exclui;
 * - a subclasse residual ("... não especificados anteriormente") não vira
 *   oferta: o texto não diz o que a empresa faz, e "outros produtos" cruzaria
 *   com qualquer coisa. O código fica guardado do mesmo jeito.
 * A categoria do item fica VAZIA: "mesma categoria" dá nota 60 no motor
 * privado, e uma categoria por seção casaria cada necessidade com milhares de
 * associados do mesmo ramo, o que é setor, não necessidade.
 */
import tabela from "./cnae/cnae-2-3.json";
import { ITEM_MAX } from "../shared/entidades";

type Tabela = {
  fonte: string; versao: string; consultadoEm: string;
  secoes: Record<string, string>; divisoes: Record<string, string>; subclasses: Record<string, string>;
};
const CNAE = tabela as Tabela;

export const FONTE_DA_CNAE = { fonte: CNAE.fonte, versao: CNAE.versao, consultadoEm: CNAE.consultadoEm };

/** Origem gravada em contact_assets.origem para o item que veio da CNAE. */
export const ORIGEM_CNAE = "cnae";

/** A seção da CNAE pela divisão (os dois primeiros dígitos), como a tabela oficial agrupa. */
const SECAO_POR_DIVISAO: Array<[number, number, string]> = [
  [1, 3, "A"], [5, 9, "B"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"], [45, 47, "G"],
  [49, 53, "H"], [55, 56, "I"], [58, 63, "J"], [64, 66, "K"], [68, 68, "L"], [69, 75, "M"], [77, 82, "N"],
  [84, 84, "O"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"], [94, 96, "S"], [97, 97, "T"], [99, 99, "U"],
];

/** A subclasse existe na CNAE 2.3. Recebe o código já normalizado (7 dígitos). */
export function cnaeExiste(codigo: string): boolean {
  return Object.prototype.hasOwnProperty.call(CNAE.subclasses, codigo);
}

/** O texto oficial da subclasse (em frase comum), ou null. */
export function descricaoDoCnae(codigo: string): string | null {
  return cnaeExiste(codigo) ? CNAE.subclasses[codigo] : null;
}

/** O segmento (seção e divisão) tirado do código, para contar e filtrar; nunca para cruzar. */
export function segmentoDoCnae(codigo: string): { secao: string; divisao: string } | null {
  if (!cnaeExiste(codigo)) return null;
  const divisao = codigo.slice(0, 2);
  const n = Number(divisao);
  const secao = SECAO_POR_DIVISAO.find(([de, ate]) => n >= de && n <= ate)?.[2];
  return secao ? { secao, divisao } : null;
}

const RESIDUAL = /\bn[ãa]o\s+especificad[oa]s?\b/i;
const EXCETO = /[\s,;(-]*\bexceto\b[\s\S]*$/i;

/**
 * O rótulo da oferta que a subclasse dá, ou null (código que não existe, ou
 * subclasse residual). É o texto que os motores comparam com o que alguém
 * declarou precisar.
 */
export function ofertaDoCnae(codigo: string): string | null {
  const oficial = descricaoDoCnae(codigo);
  if (!oficial || RESIDUAL.test(oficial)) return null;
  const rotulo = oficial.replace(EXCETO, "").replace(/[\s,;:(-]+$/, "").trim();
  return rotulo ? rotulo.slice(0, ITEM_MAX) : null;
}

/**
 * As ofertas da empresa pela CNAE: a principal primeiro, depois as secundárias,
 * sem repetir o que a entidade já escreveu em "o que tem" e sem passar do teto
 * de itens por lado (o que a entidade escreveu vem antes e não é cortado).
 */
export function ofertasDasCnaes(
  cnaes: { principal: string | null; secundarias: string[] },
  jaEscritas: string[],
  teto: number,
): string[] {
  const chave = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const vistas = new Set(jaEscritas.map(chave));
  const ofertas: string[] = [];
  for (const codigo of [cnaes.principal, ...cnaes.secundarias]) {
    if (!codigo || jaEscritas.length + ofertas.length >= teto) continue;
    const oferta = ofertaDoCnae(codigo);
    if (!oferta || vistas.has(chave(oferta))) continue;
    vistas.add(chave(oferta));
    ofertas.push(oferta);
  }
  return ofertas;
}
