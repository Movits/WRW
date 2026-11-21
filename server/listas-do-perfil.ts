import crypto from "node:crypto";
import { LIMITE_DE_DEMANDAS, LIMITE_DE_DEMANDAS_POR_CATEGORIA } from "@shared/o-que-preciso";
import { LIMITE_DO_QUE_TENHO, slugDoItem } from "@shared/reuniao-no-match";

/**
 * O Perfil aberto e o que entrou nele depois (nota da validação da N5, PR #220).
 *
 * A edição do Meu Perfil carrega "O que tenho" e "O que preciso" e, ao salvar,
 * devolve as listas inteiras. Enquanto ela está aberta, a dona pode confirmar
 * com "Sou eu" um item de uma reunião, em outra aba ou na tela da reunião: o
 * item entra no FIM da lista gravada (server/reuniao-no-match.ts). Sem a
 * conferência abaixo, o salvar do Perfil regravava a lista velha e o item
 * sumia sem aviso.
 *
 * A tela leva a versão das três listas que carregou (`versaoDasListas`, de
 * `profile.get`) e a devolve no `profile.update`. O servidor trava a linha do
 * perfil (FOR UPDATE, como a confirmação da reunião) e compara:
 *
 * - nada mudou: grava o que chegou, como sempre;
 * - só ENTROU item no fim de uma lista (o caso da reunião): grava o que
 *   chegou e acrescenta, no fim, o que entrou depois, sem repetir o que a
 *   tela já mandou. A dona não viu esses itens, então não pode tê-los tirado;
 * - a lista mudou de outro jeito (outra aba do Perfil salvou, um item saiu ou
 *   foi trocado) ou a mescla passaria de um teto: nada é gravado, e a tela
 *   pede para recarregar (CONFLICT, MENSAGEM_PERFIL_MUDOU_NO_MEIO).
 *
 * A versão é a contagem e um resumo (sha-256) de cada lista como está gravada.
 * Não é o `updatedAt`: a coluna é TIMESTAMP de segundos, e a confirmação e o
 * salvar no mesmo segundo passariam pela conferência.
 */

export const LISTAS_DO_PERFIL = ["whatIHave", "whatINeed", "whatINeedDetails"] as const;
export type ListaDoPerfil = (typeof LISTAS_DO_PERFIL)[number];
export type ListasGravadas = Partial<Record<ListaDoPerfil, unknown>>;
export type OQueEntrouDepois = Record<ListaDoPerfil, unknown[]>;

/** O formato da versão: "v1" e, para cada lista, a contagem e 16 dígitos do resumo. */
export const FORMATO_DA_VERSAO_DAS_LISTAS = /^v1(?::\d{1,4}-[0-9a-f]{16}){3}$/;

/** A versão que a tela devolve não confere com as listas gravadas, ou a mescla passaria de um teto. */
export class PerfilMudouNoMeio extends Error {
  constructor() {
    super("O perfil mudou depois que a edição foi aberta.");
    this.name = "PerfilMudouNoMeio";
  }
}

/** Uma coluna JSON lida com desconfiança: lista, texto com uma lista, ou nada (o mesmo de reuniao-no-match.ts). */
function itensDe(valor: unknown): unknown[] {
  let bruto = valor;
  if (typeof bruto === "string") {
    try { bruto = JSON.parse(bruto); } catch { return []; }
  }
  return Array.isArray(bruto) ? bruto : [];
}

const resumoDe = (itens: unknown[]) => crypto.createHash("sha256").update(JSON.stringify(itens)).digest("hex").slice(0, 16);

/** A versão das três listas como estão gravadas (a tela não a lê: só a devolve). */
export function versaoDasListas(perfil: ListasGravadas | null | undefined): string {
  return "v1" + LISTAS_DO_PERFIL.map(lista => {
    const itens = itensDe(perfil?.[lista]);
    return `:${itens.length}-${resumoDe(itens)}`;
  }).join("");
}

/**
 * O que entrou no FIM de cada lista depois da versão que a tela carregou, ou
 * null quando alguma lista mudou de outro jeito (o começo dela já não é o que
 * a tela viu).
 */
export function oQueEntrouDepois(versao: string, gravadas: ListasGravadas | null | undefined): OQueEntrouDepois | null {
  if (!FORMATO_DA_VERSAO_DAS_LISTAS.test(versao)) return null;
  const partes = versao.split(":").slice(1);
  const entrou = {} as OQueEntrouDepois;
  for (let indice = 0; indice < LISTAS_DO_PERFIL.length; indice += 1) {
    const lista: ListaDoPerfil = LISTAS_DO_PERFIL[indice];
    const [contagem, resumo] = partes[indice].split("-");
    const quantos = Number(contagem);
    const itens = itensDe(gravadas?.[lista]);
    if (itens.length < quantos || resumoDe(itens.slice(0, quantos)) !== resumo) return null;
    entrou[lista] = itens.slice(quantos);
  }
  return entrou;
}

const texto = (valor: unknown) => (typeof valor === "string" ? valor : "");
const daDemanda = (demanda: unknown, campo: "id" | "category" | "description") =>
  demanda && typeof demanda === "object" ? texto((demanda as Record<string, unknown>)[campo]) : "";

export type ListasRecebidas = { whatIHave?: unknown[]; whatINeed?: unknown[]; whatINeedDetails?: unknown[] };

/**
 * As listas que o Perfil grava, com o que entrou depois acrescentado no fim.
 * Só mexe nas listas que o pedido traz: a que não veio não é regravada, e o
 * que entrou nela fica onde está. Não repete item: "O que tenho" pelo slug
 * (como a confirmação da reunião), a demanda pelo id ou pela descrição, a
 * categoria pelo valor. A demanda que entrou depois leva a categoria dela a
 * "O que preciso": é a categoria marcada que faz a descrição valer nos
 * motores, e a dona não a desmarcou (não viu essa demanda).
 *
 * Devolve null quando a mescla passaria de um teto (50 em "O que tenho", 50
 * demandas e 10 por categoria): aí quem decide é a dona, com a tela recarregada.
 */
export function mesclarOQueEntrouDepois(recebidas: ListasRecebidas, entrou: OQueEntrouDepois): ListasRecebidas | null {
  const mescladas: ListasRecebidas = {};

  if (recebidas.whatIHave !== undefined) {
    const lista = [...recebidas.whatIHave];
    const slugs = new Set(lista.map(item => slugDoItem(texto(item))).filter(Boolean));
    for (const item of entrou.whatIHave) {
      const slug = slugDoItem(texto(item));
      if (slug ? slugs.has(slug) : lista.some(existente => JSON.stringify(existente) === JSON.stringify(item))) continue;
      if (slug) slugs.add(slug);
      lista.push(item);
    }
    if (lista.length > LIMITE_DO_QUE_TENHO) return null;
    mescladas.whatIHave = lista;
  }

  if (recebidas.whatINeedDetails !== undefined) {
    const lista = [...recebidas.whatINeedDetails];
    for (const demanda of entrou.whatINeedDetails) {
      const id = daDemanda(demanda, "id");
      const slug = slugDoItem(daDemanda(demanda, "description"));
      const repetida = lista.some(existente =>
        (id && daDemanda(existente, "id") === id) || (slug && slugDoItem(daDemanda(existente, "description")) === slug));
      if (!repetida) lista.push(demanda);
    }
    if (lista.length > LIMITE_DE_DEMANDAS) return null;
    const porCategoria = new Map<string, number>();
    for (const demanda of lista) {
      const categoria = daDemanda(demanda, "category");
      porCategoria.set(categoria, (porCategoria.get(categoria) ?? 0) + 1);
    }
    if (Array.from(porCategoria.values()).some(quantas => quantas > LIMITE_DE_DEMANDAS_POR_CATEGORIA)) return null;
    mescladas.whatINeedDetails = lista;
  }

  if (recebidas.whatINeed !== undefined) {
    const lista = [...recebidas.whatINeed];
    const categoriasQueEntraram = [...entrou.whatINeed, ...entrou.whatINeedDetails.map(demanda => daDemanda(demanda, "category")).filter(Boolean)];
    for (const categoria of categoriasQueEntraram) {
      if (!lista.some(existente => JSON.stringify(existente) === JSON.stringify(categoria))) lista.push(categoria);
    }
    if (lista.length > LIMITE_DE_DEMANDAS) return null;
    mescladas.whatINeed = lista;
  }

  return mescladas;
}
