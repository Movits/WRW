/**
 * O complemento pela busca na web (H4i do plano do gravador; R-25 da reunião
 * de 11/11, decisão do Roberto de 22/11/2026): a dona pede, num item do resumo,
 * que a IA complete uma referência dita pela metade (o número de uma lei, o nome
 * de uma norma ou de uma empresa) com a busca da Google no Gemini.
 *
 * Foge da regra de que todo item está na transcrição, e por isso:
 * - só quando a dona pede, item a item (nunca sozinho);
 * - sempre marcado "fora da reunião, a conferir", com a fonte (o endereço que a
 *   busca devolveu) e as consultas que a busca fez;
 * - espera a dona confirmar antes de entrar no resumo: até lá, só ela o vê; o
 *   link aberto, a Memória e o áudio do resumo só levam o confirmado;
 * - teto por dona em 24 h, contado no banco.
 *
 * Preço lido em 23/11/2026 na página oficial (ai.google.dev/gemini-api/docs/pricing):
 * nos modelos Gemini 3, 5.000 buscas grátis por mês (somadas entre os modelos),
 * depois US$ 14 por 1.000 buscas, além dos tokens do modelo.
 */

/** Quantas buscas a dona faz em 24 h (a que falhou conta). */
export const BUSCAS_DO_COMPLEMENTO_POR_DIA = 10;

/** O tamanho máximo do complemento guardado. */
export const COMPLEMENTO_MAX = 400;

/** Quantas consultas da busca ficam guardadas, e o tamanho de cada uma. */
export const CONSULTAS_DO_COMPLEMENTO_MAX = 5;
export const CONSULTA_DO_COMPLEMENTO_MAX = 200;

/** As recusas, como código: a tela as traduz (client/src/lib/mensagem-de-erro.ts). */
export const RECUSAS_DO_COMPLEMENTO = {
  /** O teto por dona (BUSCAS_DO_COMPLEMENTO_POR_DIA). */
  demais: "COMPLEMENTO_DEMAIS",
  /** A busca não achou nada com fonte. */
  naoAchou: "COMPLEMENTO_NAO_ACHADO",
  /** A IA não respondeu. */
  ia: "COMPLEMENTO_IA_INDISPONIVEL",
  /** O item foi ignorado, ou o resumo está sendo refeito. */
  itemForaDoResumo: "COMPLEMENTO_ITEM_FORA_DO_RESUMO",
  /** Não há complemento esperando a decisão. */
  ausente: "COMPLEMENTO_AUSENTE",
} as const;
export type CodigoDaRecusaDoComplemento = (typeof RECUSAS_DO_COMPLEMENTO)[keyof typeof RECUSAS_DO_COMPLEMENTO];

/** A fonte que vai à tela: só endereço https, até 2048 caracteres. Fora disso, nula. */
export function fonteDoComplemento(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const lida = new URL(url);
    return lida.protocol === "https:" ? lida.toString() : null;
  } catch {
    return null;
  }
}

/** O endereço da pesquisa na Google de uma consulta que a busca fez (as "sugestões de pesquisa"). */
export function enderecoDaConsulta(consulta: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(consulta)}`;
}

/** As consultas guardadas, lidas do JSON da coluna: só textos, aparados, no máximo CONSULTAS_DO_COMPLEMENTO_MAX. */
export function consultasDoComplemento(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((consulta): consulta is string => typeof consulta === "string")
    .map(consulta => consulta.trim().slice(0, CONSULTA_DO_COMPLEMENTO_MAX))
    .filter(Boolean)
    .slice(0, CONSULTAS_DO_COMPLEMENTO_MAX);
}
