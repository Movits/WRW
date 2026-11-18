import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  CAMPOS_DE_TEXTO_DA_DEMANDA,
  LIMITE_DA_DESCRICAO,
  LIMITE_DE_DEMANDAS,
  LIMITE_DE_DEMANDAS_POR_CATEGORIA,
  LIMITE_DE_PALAVRAS_CHAVE,
  LIMITE_DO_CAMPO,
  MINIMO_DA_DESCRICAO,
  demandasParaGravar,
  ehCategoriaOQuePreciso,
  problemaDaDemanda,
  rotuloDoQuePreciso,
  type CampoDeTextoDaDemanda,
  type DemandaDetalhada,
} from "@shared/o-que-preciso";

/**
 * O servidor de "O que preciso — Demandas e necessidades" (Rosber, 14/09): o
 * zod das demandas detalhadas e o preparo do que vai para `user_profiles`.
 * A tela valida o mesmo (shared/o-que-preciso.ts), mas a tela não é garantia:
 * o limite de tamanho e de quantidade é contra abuso, e a validação de cada
 * demanda é a mesma regra que decide o que chega aos motores.
 */

/** Chaves de `whatINeed`: as 17 categorias, "consultoria" e o texto livre antigo (importação, "falar sobre o negócio"). */
// Teto folgado (500 por item) de propósito: o Perfil devolve o que já está gravado, e um texto antigo
// maior que o limite novo não pode derrubar o salvar da bio.
export const esquemaDoWhatINeed = z.array(z.string().max(500)).max(LIMITE_DE_DEMANDAS);

const textoCurto = z.string().max(LIMITE_DO_CAMPO).optional();
const camposDeTexto = Object.fromEntries(CAMPOS_DE_TEXTO_DA_DEMANDA.map(campo => [campo, textoCurto])) as Record<CampoDeTextoDaDemanda, typeof textoCurto>;

export const esquemaDaDemanda = z.object({
  id: z.string().max(40).optional(),
  category: z.string().refine(ehCategoriaOQuePreciso, "Categoria desconhecida em \"O que preciso\"."),
  description: z.string().max(LIMITE_DA_DESCRICAO).optional(),
  exclusivity: z.enum(["sim", "nao"]).optional(),
  keywords: z.array(z.string().max(60)).max(LIMITE_DE_PALAVRAS_CHAVE).optional(),
  ...camposDeTexto,
});

export const esquemaDasDemandas = z.array(esquemaDaDemanda).max(LIMITE_DE_DEMANDAS);

const MENSAGENS: Record<NonNullable<ReturnType<typeof problemaDaDemanda>>, (categoria: string) => string> = {
  "categoria-desconhecida": () => "Categoria desconhecida em \"O que preciso\".",
  "descricao-curta": categoria => `Descreva a demanda de "${categoria}" com pelo menos ${MINIMO_DA_DESCRICAO} caracteres: a categoria sozinha não gera conexões.`,
  "descricao-longa": categoria => `A descrição da demanda de "${categoria}" passa de ${LIMITE_DA_DESCRICAO} caracteres.`,
  "servico-obrigatorio": categoria => `Escolha o serviço ou especialista em "${categoria}".`,
  "opcao-invalida": categoria => `Opção desconhecida numa demanda de "${categoria}".`,
  "campo-longo": categoria => `Um campo da demanda de "${categoria}" passa de ${LIMITE_DO_CAMPO} caracteres.`,
};

/**
 * A frase da recusa de uma demanda, com o rótulo da categoria em português.
 * Serve também ao "preciso" que a reunião leva ao perfil da dona (N5,
 * server/reuniao-no-match.ts): a mesma regra, a mesma frase.
 */
export function mensagemDoProblemaDaDemanda(problema: NonNullable<ReturnType<typeof problemaDaDemanda>>, categoria: string): string {
  return MENSAGENS[problema](rotuloDoQuePreciso(categoria));
}

/**
 * O par (whatINeed, whatINeedDetails) pronto para gravar.
 *
 * - Sem `whatINeedDetails` no pedido (Onboarding em cache no deploy, Perfil
 *   antigo): não mexe nas demandas e devolve `whatINeed` como veio — a regra de
 *   antes.
 * - Com as demandas: tira as em branco e, quando `whatINeed` veio junto, as de
 *   categoria desmarcada (desmarcar tira as demandas, como desmarcar "Outra
 *   necessidade" apaga o texto); recusa (BAD_REQUEST) a demanda começada e
 *   inválida e o excesso por categoria. Sem `whatINeed` no pedido, as
 *   categorias gravadas ficam como estão — e demanda de categoria não marcada
 *   não chega aos motores (`necessidadesDasDemandas`).
 *
 * Categoria marcada SEM demanda não é recusada aqui: o Perfil guarda as
 * categorias antigas sem detalhamento, e os motores já não leem as nove
 * categorias novas sem demanda (`chavesQueValemComoNecessidade`). Quem trava a
 * seleção sem detalhe é a tela, com a mesma função (`categoriasPendentes`).
 */
export function prepararOQuePreciso(
  whatINeed: string[] | undefined,
  whatINeedDetails: z.infer<typeof esquemaDasDemandas> | undefined,
): { whatINeed?: string[]; whatINeedDetails?: DemandaDetalhada[] } {
  if (whatINeedDetails === undefined) return whatINeed === undefined ? {} : { whatINeed };
  const categorias = whatINeed ?? whatINeedDetails.map(demanda => demanda.category);
  const demandas = demandasParaGravar(categorias, whatINeedDetails as DemandaDetalhada[]);
  for (const demanda of demandas) {
    const problema = problemaDaDemanda(demanda);
    if (problema) throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGENS[problema](rotuloDoQuePreciso(demanda.category)) });
  }
  const porCategoria: Record<string, number> = {};
  for (const demanda of demandas) porCategoria[demanda.category] = (porCategoria[demanda.category] ?? 0) + 1;
  const excedida = Object.keys(porCategoria).find(categoria => porCategoria[categoria] > LIMITE_DE_DEMANDAS_POR_CATEGORIA);
  if (excedida) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `No máximo ${LIMITE_DE_DEMANDAS_POR_CATEGORIA} demandas em "${rotuloDoQuePreciso(excedida)}".` });
  }
  // Ids repetidos (cliente velho, cópia colada) viram ids novos: a tela edita e remove por id.
  const vistos = new Set<string>();
  const comIdUnico = demandas.map((demanda, indice) => {
    const id = vistos.has(demanda.id) ? `${demanda.id}-${indice + 1}` : demanda.id;
    vistos.add(id);
    return id === demanda.id ? demanda : { ...demanda, id };
  });
  return whatINeed === undefined
    ? { whatINeedDetails: comIdUnico }
    : { whatINeed: whatINeed.filter((chave, indice) => whatINeed.indexOf(chave) === indice), whatINeedDetails: comIdUnico };
}
