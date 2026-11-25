/**
 * Os detalhes da reunião (H7c do plano do gravador): as etiquetas e o "Onde
 * foi", que a dona dá à reunião para achá-la depois (a busca e os filtros da
 * H7b), e o contato e o contexto, que já existiam. A mesma regra vale na tela
 * e no servidor: o servidor normaliza o que chega, e a tela mostra o que ele
 * guardou.
 *
 * O vocabulário da tela é "etiqueta" (decisão do plano de 15/11), e não "tag"
 * nem "pasta": as pastas do app de referência são outra função (H7d).
 */

/** Quantas etiquetas uma reunião leva. */
export const ETIQUETAS_POR_REUNIAO_MAX = 10;
/** As letras de uma etiqueta. */
export const ETIQUETA_MAX = 30;
/** As letras do "Onde foi" (o lugar ou o canal: "Escritório da Ana", "Zoom"); a coluna é varchar(120). */
export const ONDE_FOI_MAX = 120;

/**
 * As recusas dos detalhes, como CÓDIGO (a tela traduz): o contato ou o
 * contexto que não é da dona, ou que não existe, respondem igual, para o id de
 * outra conta não ser sondado.
 */
export const RECUSAS_DOS_DETALHES = {
  contato: "CONTATO_NAO_ENCONTRADO",
  contexto: "CONTEXTO_NAO_ENCONTRADO",
} as const;
export type CodigoDaRecusaDosDetalhes = (typeof RECUSAS_DOS_DETALHES)[keyof typeof RECUSAS_DOS_DETALHES];

export function ehRecusaDosDetalhes(mensagem: unknown): mensagem is CodigoDaRecusaDosDetalhes {
  return mensagem === RECUSAS_DOS_DETALHES.contato || mensagem === RECUSAS_DOS_DETALHES.contexto;
}

/** Espaços repetidos (inclusive quebra de linha e tab) viram um só, e as pontas saem. */
function semEspacosSobrando(texto: string) {
  return texto.replace(/\s+/g, " ").trim();
}

/** Corta sem partir um caractere fora do plano básico (emoji) ao meio. */
function cortarPorCaracteres(texto: string, maximo: number) {
  const caracteres = Array.from(texto);
  return caracteres.length > maximo ? caracteres.slice(0, maximo).join("").trim() : texto;
}

/** Chave de comparação das etiquetas: "Clientes", "clientes" e " CLIENTES " são a mesma. */
export function chaveDaEtiqueta(etiqueta: string) {
  return semEspacosSobrando(etiqueta).toLocaleLowerCase("pt-BR");
}

/**
 * As etiquetas como ficam guardadas: sem espaços sobrando, sem vazias, cortadas
 * em ETIQUETA_MAX letras, sem repetidas (a primeira grafia fica: "Clientes" e
 * "clientes" são uma só) e no máximo ETIQUETAS_POR_REUNIAO_MAX, na ordem em que
 * vieram. Lista vazia vira null: a coluna nula é "sem etiqueta".
 */
export function normalizarEtiquetas(entrada: readonly unknown[] | null | undefined): string[] | null {
  if (!entrada) return null;
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const bruta of entrada) {
    if (typeof bruta !== "string") continue;
    const etiqueta = cortarPorCaracteres(semEspacosSobrando(bruta), ETIQUETA_MAX);
    if (!etiqueta) continue;
    const chave = chaveDaEtiqueta(etiqueta);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(etiqueta);
    if (saida.length >= ETIQUETAS_POR_REUNIAO_MAX) break;
  }
  return saida.length ? saida : null;
}

/**
 * As etiquetas lidas do banco: a coluna é JSON, e o que não for lista de
 * textos (linha antiga, valor corrompido) vira lista vazia, nunca erro na tela.
 */
export function etiquetasDaReuniao(bruto: unknown): string[] {
  return Array.isArray(bruto) ? normalizarEtiquetas(bruto) ?? [] : [];
}

/** O "Onde foi" como fica guardado: sem espaços sobrando e cortado; vazio vira null. */
export function normalizarOndeFoi(entrada: string | null | undefined): string | null {
  if (typeof entrada !== "string") return null;
  return cortarPorCaracteres(semEspacosSobrando(entrada), ONDE_FOI_MAX) || null;
}

/**
 * Todas as etiquetas que a dona já usou, sem repetidas e em ordem alfabética
 * do idioma da tela: a sugestão ao escrever uma etiqueta e a lista do filtro.
 */
export function etiquetasDaDona(reunioes: ReadonlyArray<{ etiquetas?: unknown }>, idioma = "pt-BR"): string[] {
  const porChave = new Map<string, string>();
  for (const reuniao of reunioes) {
    for (const etiqueta of etiquetasDaReuniao(reuniao.etiquetas)) {
      const chave = chaveDaEtiqueta(etiqueta);
      if (!porChave.has(chave)) porChave.set(chave, etiqueta);
    }
  }
  return Array.from(porChave.values()).sort((a, b) => a.localeCompare(b, idioma, { sensitivity: "base" }));
}
