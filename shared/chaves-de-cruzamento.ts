import { slugDoTermo, substanciasDoTermo } from "./direcao-do-termo";
import { chavesDeServico } from "./tipo-da-oferta";

/**
 * As CHAVES de cruzamento de um item de "o que tem" ou "o que precisa" (N4b,
 * docs/arquitetura/entidades.md, seção 8). O índice invertido
 * (`chaves_de_cruzamento`) guarda estas chaves por item, e o cruzamento só
 * compara os pares que têm ao menos uma chave em comum.
 *
 * A chave NÃO decide match: ela só acha candidatos. Quem decide continua sendo
 * `scoreMatch` (server/match-service.ts), com todas as regras de sempre:
 * concorrentes zeram, serviço só casa com necessidade declarada, nada de
 * palavra solta. Por isso as chaves são um SUPERCONJUNTO do que o motor aceita:
 * cada critério DETERMINÍSTICO de `scoreMatch` que dá 50 ou mais tem a sua chave,
 * e o par que ele aceitaria tem sempre uma chave em comum
 * (`server/chaves-de-cruzamento.test.ts` confere sobre o vocabulário dos testes
 * dos motores e a tabela da CNAE). A exceção é o critério semântico estreito do
 * N7 (55, `NOTA_SEMANTICA_ESTREITA`, desligado por padrão): ele não tem chave, e
 * o par só por semântica fica fora do índice e do motor privado em massa.
 *
 *   - `s:` o slug do termo (tag exata), o gravado e o calculado;
 *   - `t:` as substâncias (objeto sem o verbo, núcleo sem a cabeça
 *     transparente e os dois sem o lugar do fim): mesmo objeto, mesmo núcleo
 *     e "a menos do lugar";
 *   - `f:` e `a:` a família do serviço e o assunto curado
 *     (`chavesDeServico`, shared/tipo-da-oferta.ts): o mesmo serviço escrito de
 *     outro jeito, a família, o apoio que nomeia a profissão e o assunto;
 *   - `c:` a categoria: mesma categoria (e o idioma que a regra não lê).
 *
 * Palavra solta nunca é chave: "exportar" sozinho não junta ninguém.
 */
export type LadoDoItem = "tem" | "precisa";

/**
 * A versão do cálculo das chaves. O índice guarda, em cada linha, a versão de
 * quem a gravou, e a varredura trata versão diferente como item sem chave
 * (reindexa em lotes). SUBA este número sempre que `chavesDoItem` mudar de
 * resultado (vocabulário, famílias, lemas, direção): sem isso, o lado de quem
 * procura sai com a chave nova, calculada na hora, e o lado de lá continua com a
 * antiga, gravada no banco, e o par novo some calado da busca e do motor em
 * massa. O instantâneo de `server/chaves-de-cruzamento.test.ts` fica vermelho
 * quando as chaves mudam sem a versão subir.
 */
export const VERSAO_DAS_CHAVES = 1;

export type ItemParaChaves = { label: string; category?: string | null; slug?: string | null };

/**
 * As chaves são função pura do rótulo, da categoria, do slug e do lado, e a
 * base das associações repete muito o mesmo rótulo (as 1227 ofertas da CNAE):
 * guardadas, a análise do termo roda uma vez por rótulo, não por item.
 */
const MAXIMO_NO_CACHE = 50_000;
const cache = new Map<string, string[]>();

export function chavesDoItem(item: ItemParaChaves, lado: LadoDoItem): string[] {
  const chaveDoCache = JSON.stringify([lado, item.category ?? "", item.slug ?? "", item.label]);
  const guardadas = cache.get(chaveDoCache);
  if (guardadas) return guardadas;
  const calculadas = calcularChaves(item, lado);
  if (cache.size >= MAXIMO_NO_CACHE) cache.clear();
  cache.set(chaveDoCache, calculadas);
  return calculadas;
}

function calcularChaves(item: ItemParaChaves, lado: LadoDoItem): string[] {
  const chaves = new Set<string>();
  const slug = slugDoTermo(item.label);
  if (slug) chaves.add(`s:${slug}`);
  if (item.slug) chaves.add(`s:${item.slug}`);
  for (const substancia of substanciasDoTermo(item.label)) chaves.add(`t:${substancia}`);
  const categoria = slugDoTermo(item.category ?? "");
  if (categoria) chaves.add(`c:${categoria}`);
  for (const chave of chavesDeServico(item.label, item.category, lado)) chaves.add(chave);
  return Array.from(chaves);
}

/** Os dois lados de um contato (ou perfil), já em chaves. */
export function chavesDoContato(contato: { tenho: ItemParaChaves[]; preciso: ItemParaChaves[] }) {
  return {
    tem: new Set(contato.tenho.flatMap(item => chavesDoItem(item, "tem"))),
    precisa: new Set(contato.preciso.flatMap(item => chavesDoItem(item, "precisa"))),
  };
}

/** Os dois lados podem casar? Alguma chave do "tem" de um está no "precisa" do outro. */
export function podemCasar(
  a: { tem: ReadonlySet<string>; precisa: ReadonlySet<string> },
  b: { tem: ReadonlySet<string>; precisa: ReadonlySet<string> },
): boolean {
  const cruza = (x: ReadonlySet<string>, y: ReadonlySet<string>) => {
    const [menor, maior] = x.size <= y.size ? [x, y] : [y, x];
    for (const chave of Array.from(menor)) if (maior.has(chave)) return true;
    return false;
  };
  return cruza(a.tem, b.precisa) || cruza(b.tem, a.precisa);
}
