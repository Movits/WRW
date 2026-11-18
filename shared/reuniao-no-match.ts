import { slugDoTermo, tokensDoTermo } from "./direcao-do-termo";
import { CATEGORIAS_CUJA_DESCRICAO_E_OFERTA, CHAVES_O_QUE_PRECISO, type ChaveOQuePreciso } from "./o-que-preciso";

/**
 * N5 — a reunião vira conexões e refina o perfil (reunião de 11/11, R-29,
 * R-52 e R-55; desenho de 16/11). O que cada pessoa disse que TEM e PRECISA
 * já sai da extração da reunião, com o trecho literal (server/network-extracao.ts);
 * aqui ficam as regras puras que a tela e o servidor dividem: para onde o
 * item confirmado vai e quando a tela pergunta "É você?".
 *
 * Nada entra sozinho (CLAUDE.md): todo item espera o clique da dona.
 */

/** Para onde o item vai quando a dona confirma (network_sugestoes.alvo). */
export const ALVOS_DO_ITEM = ["contato", "perfil"] as const;
export type AlvoDoItem = (typeof ALVOS_DO_ITEM)[number];

/**
 * "O que tenho" do perfil: no máximo 50 itens, a mesma régua do Perfil
 * (`esquemaDoWhatIHave` em server/routers/profile.ts) e da confirmação vinda
 * da reunião.
 */
export const LIMITE_DO_QUE_TENHO = 50;

/** A categoria que o "preciso" da reunião leva ao perfil quando a dona não escolhe outra. */
export const CATEGORIA_PADRAO_DO_PRECISO: ChaveOQuePreciso = "outra_necessidade";

/**
 * As categorias que a dona pode dar ao "preciso" que vai ao perfil: todas,
 * menos as que descrevem a OFERTA (Compradores: "O que você deseja vender?").
 * Lá a descrição não chega aos motores como necessidade, e o item confirmado
 * sumiria das conexões sem aviso.
 */
export const CATEGORIAS_DO_PRECISO_DA_REUNIAO: readonly ChaveOQuePreciso[] =
  CHAVES_O_QUE_PRECISO.filter(chave => !CATEGORIAS_CUJA_DESCRICAO_E_OFERTA.has(chave));

/** O slug de um item, o mesmo de contact_assets.tag_slug: "não repetir o slug" compara por ele. */
export function slugDoItem(texto: string): string {
  return slugDoTermo(texto);
}

const palavrasDoNome = (nome: string | null | undefined) => tokensDoTermo(nome ?? "").filter(palavra => palavra.length >= 2);

/**
 * Dois nomes que podem ser da mesma pessoa: todas as palavras do mais curto
 * aparecem no mais longo, com pelo menos uma de 3 letras ou mais. "Glenda" ×
 * "Glenda Souza" e "Ana Ribeiro" × "Ana Paula Ribeiro" sim; "Ana" × "Mariana"
 * e "Maria Silva" × "Maria Souza" não. Acento e caixa não contam.
 */
export function mesmoNome(a: string | null | undefined, b: string | null | undefined): boolean {
  const deA = palavrasDoNome(a);
  const deB = palavrasDoNome(b);
  if (!deA.length || !deB.length) return false;
  const [curto, longo] = deA.length <= deB.length ? [deA, deB] : [deB, deA];
  return curto.some(palavra => palavra.length >= 3) && curto.every(palavra => longo.includes(palavra));
}

/**
 * A pessoa da reunião parece ser a dona da conta? Só decide se a tela PERGUNTA
 * "É você?": quem responde é ela, e nada muda sem o clique. Basta o mesmo
 * e-mail (sem caixa) ou o mesmo nome (`mesmoNome`) que um dos nomes da conta.
 */
export function pareceSerADona(
  pessoa: { fullName: string; email?: string | null },
  conta: { nomes: ReadonlyArray<string | null | undefined>; email?: string | null },
): boolean {
  const email = (pessoa.email ?? "").trim().toLowerCase();
  if (email && email === (conta.email ?? "").trim().toLowerCase()) return true;
  return conta.nomes.some(nome => mesmoNome(pessoa.fullName, nome));
}
