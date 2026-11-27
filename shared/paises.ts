// Os países do seletor de país do cadastro e do perfil (PaisEstadoCidade).
//
// A LISTA é shared/paises-gerados.ts (250 códigos ISO 3166-1 alfa-2 vindos do
// countryInfo.txt do GeoNames; ver scripts/gerar-paises.mjs). O RÓTULO não está
// lá: quem traduz o nome de cada país é o próprio navegador, por
// `Intl.DisplayNames`, no idioma em que a tela está. É o que permite oferecer o
// mundo inteiro nos 10 idiomas do site sem 2.500 linhas de tradução para alguém
// manter à mão — e é a mesma tabela que o navegador usa nos seletores dele.
//
// Antes disto, cada uma das três telas tinha a SUA lista escrita à mão, com 17
// ou 18 países e recortes diferentes: quem morava em Angola, no Paraguai ou no
// Catar não achava o próprio país e escolhia "Outro" (ou desistia).
//
// O QUE VAI PARA O BANCO NÃO MUDA: continua o código de duas letras, em
// `user_profiles.country` e em `opportunities.country`. Perfil antigo com "BR"
// continua valendo, e "XX" — o "Outro" que só o cadastro oferecia — continua
// aceito e legível (ver CODIGO_OUTRO).

import {
  FONTE_DOS_PAISES,
  FONTE_DOS_PAISES_URL,
  PAISES_GERADOS,
} from "./paises-gerados";

export { FONTE_DOS_PAISES, FONTE_DOS_PAISES_URL };

/**
 * O "Outro" do cadastro antigo. NÃO é código ISO: é o que ficou gravado no
 * perfil de quem não achou o próprio país na lista de 17. Continua na lista, por
 * último, por dois motivos: perfil antigo precisa continuar exibível, e mesmo
 * com 250 países existe quem prefira não declarar onde mora.
 */
export const CODIGO_OUTRO = "XX";

/** Um país pronto para o seletor. */
export interface PaisComRotulo {
  /** Código ISO 3166-1 alfa-2 — o que vai para o banco. */
  codigo: string;
  /** Nome no idioma da tela — o que a usuária lê. */
  rotulo: string;
}

const NOMES_DE_RESERVA = new Map<string, string>(
  PAISES_GERADOS.map(([codigo, reserva]) => [codigo, reserva])
);

/**
 * Um tradutor por idioma, guardado porque construir `Intl.DisplayNames` custa
 * caro perto de uma consulta.
 *
 * `fallback: "none"` faz o navegador devolver `undefined` para código que ele
 * não conhece, em vez de devolver o próprio código: sem isso, um país novo
 * apareceria no seletor como "XK" e ninguém entenderia. Ambiente sem a tabela de
 * regiões (navegador antigo, Node compilado com ICU reduzido) faz o construtor
 * lançar — e aí a lista inteira cai no nome de reserva em inglês. Degradar para
 * inglês é melhor do que um cadastro sem países.
 */
const tradutores = new Map<string, Intl.DisplayNames | null>();

function tradutor(idioma: string): Intl.DisplayNames | null {
  const emCache = tradutores.get(idioma);
  if (emCache !== undefined) return emCache;
  let novo: Intl.DisplayNames | null = null;
  try {
    novo = new Intl.DisplayNames([idioma], { type: "region", fallback: "none" });
  } catch {
    novo = null;
  }
  tradutores.set(idioma, novo);
  return novo;
}

/**
 * Nome do país no idioma pedido.
 *
 * Cai no nome de reserva do arquivo gerado quando o navegador não conhece o
 * código, e no próprio código quando nem o arquivo o conhece. Nunca devolve
 * vazio para um código preenchido: campo de país em branco no perfil parece dado
 * perdido, e "XX" ao menos diz que algo foi escolhido.
 */
export function nomeDoPais(codigo: string, idioma: string): string {
  const cod = (codigo || "").trim().toUpperCase();
  if (!cod) return "";
  let traduzido: string | undefined;
  try {
    traduzido = tradutor(idioma)?.of(cod) ?? undefined;
  } catch {
    // `of` lança quando o texto não tem forma de região ("X", "BRA", "1").
    traduzido = undefined;
  }
  return traduzido || NOMES_DE_RESERVA.get(cod) || cod;
}

const listas = new Map<string, PaisComRotulo[]>();

/**
 * Os países em ordem alfabética DO IDIOMA da tela (é por isso que a ordenação
 * usa `localeCompare` com o idioma, como shared/option-sorting.ts: em português
 * "Á" fica junto de "A", em sueco fica no fim do alfabeto).
 *
 * `rotuloDeOutro` é o texto traduzido do "Outro" do cadastro. Quando vem, a
 * opção entra POR ÚLTIMO, fora da ordenação: "Outro" no meio da lista, entre
 * Omã e Paquistão, é uma armadilha para quem está correndo o olho.
 *
 * O resultado fica guardado por idioma (e por ter ou não o "Outro"): ordenar 250
 * nomes a cada tecla digitada no formulário seria trabalho repetido à toa.
 */
export function listarPaises(
  idioma: string,
  rotuloDeOutro?: string
): PaisComRotulo[] {
  const chave = `${idioma}\u0000${rotuloDeOutro ?? ""}`;
  const emCache = listas.get(chave);
  if (emCache) return emCache;

  const lista: PaisComRotulo[] = PAISES_GERADOS.map(([codigo]) => ({
    codigo,
    rotulo: nomeDoPais(codigo, idioma),
  })).sort((a, b) =>
    a.rotulo.localeCompare(b.rotulo, idioma, { sensitivity: "base" })
  );
  if (rotuloDeOutro) lista.push({ codigo: CODIGO_OUTRO, rotulo: rotuloDeOutro });

  listas.set(chave, lista);
  return lista;
}
