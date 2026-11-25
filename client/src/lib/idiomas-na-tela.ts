import { LANGUAGES } from "@/i18n";
import { IDIOMAS_DA_REUNIAO, IDIOMAS_FALADOS, nomeDoIdiomaEm, type IdiomaFalado } from "@shared/idioma-da-reuniao";

/**
 * Os nomes dos idiomas falados (G16) na tela. Os 10 da tela têm o rótulo de
 * sempre, no próprio idioma ("English", "Français"), como no seletor do site;
 * os outros 99, o nome no idioma de quem lê, pelo Intl.DisplayNames
 * (nomeDoIdiomaEm, em shared/idioma-da-reuniao.ts): "Italiano" com a tela em
 * português, "Italian" em inglês, "イタリア語" em japonês. Nada disto passa
 * pelos JSONs de idioma: são 99 nomes em 10 idiomas, e o CLDR do navegador já
 * os traz.
 */

const DA_TELA: ReadonlySet<string> = new Set(IDIOMAS_DA_REUNIAO);

/** A primeira letra maiúscula, na regra do idioma de quem lê ("italiano" vira "Italiano"; o árabe e o chinês não mudam). */
function comMaiuscula(nome: string, tela: string): string {
  try {
    return nome.charAt(0).toLocaleUpperCase(tela) + nome.slice(1);
  } catch {
    return nome.charAt(0).toUpperCase() + nome.slice(1);
  }
}

/** O nome do idioma no idioma de quem lê, para frases e listas ("Inglês", "Italiano"). */
export function nomeDoIdiomaNaTela(codigo: string, tela: string): string {
  return comMaiuscula(nomeDoIdiomaEm(codigo, tela), tela);
}

/** O rótulo de um idioma nas listas: o dos 10 da tela, como no seletor do site; dos outros, o nome no idioma de quem lê. */
export function rotuloDoIdioma(codigo: string | null | undefined, tela: string): string {
  if (!codigo) return "";
  return LANGUAGES.find(idioma => idioma.code === codigo)?.label ?? nomeDoIdiomaNaTela(codigo, tela);
}

/** Se o idioma é um dos 10 da tela (o seletor do site, a tradução e os rótulos do PDF). */
export function ehIdiomaDaTela(codigo: string | null | undefined): boolean {
  return !!codigo && DA_TELA.has(codigo);
}

/** Os idiomas falados que não são da tela, com o nome no idioma de quem lê, em ordem alfabética nele. */
export function outrosIdiomasFalados(tela: string): Array<{ codigo: IdiomaFalado; nome: string }> {
  const ordem = (() => {
    try {
      return new Intl.Collator(tela).compare;
    } catch {
      return (a: string, b: string) => a.localeCompare(b);
    }
  })();
  return IDIOMAS_FALADOS.filter(codigo => !DA_TELA.has(codigo))
    .map(codigo => ({ codigo, nome: nomeDoIdiomaNaTela(codigo, tela) }))
    .sort((a, b) => ordem(a.nome, b.nome));
}
