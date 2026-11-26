import { TITULO_DA_REUNIAO_MIN } from "./const";

/**
 * O título que a IA sugere para a reunião, escrito com o resumo guardado
 * (meeting_summaries.suggested_title), como no app de referência da cliente:
 * "📱 Preparação e validação do aplicativo", com a data da reunião ao lado. O
 * emoji é o do resumo e a data é a da reunião: os dois ficam fora do texto. É
 * só sugestão (nada extraído por IA entra sozinho): o título muda quando a
 * dona toca em "Usar este título".
 */

/** O tamanho do título sugerido: curto, como o título de uma nota. */
export const TITULO_SUGERIDO_MAX = 80;

/** A recusa de decidir uma sugestão que não está mais à espera (CONFLICT); a tela diz a dela, pelo código. */
export const MENSAGEM_TITULO_SUGERIDO_INDISPONIVEL = "Esta sugestão de título não está mais disponível. Atualize a tela.";

// Pelo construtor: o alvo do tsconfig não aceita a flag u num literal. Os
// emojis, os seletores de variação, as junções e os tons de pele do começo do
// texto (o emoji do título é o do resumo, à parte).
const EMOJI_NO_COMECO = new RegExp("^(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|\\p{Emoji_Modifier}|[\\u200D\\uFE0E\\uFE0F\\u20E3])+\\s*", "u");
const ROTULO_DE_VOZ = /\{\s*F\d+\s*\}/i;
// Os acentos que o NFD separa da letra.
const MARCAS = new RegExp("\\p{M}", "gu");
// As aspas em volta do título inteiro, que o modelo às vezes escreve.
const ASPAS = new Set(["\"", "'", "“", "”", "‘", "’", "«", "»", "「", "」", "『", "』"]);

/**
 * O título que a IA escreveu, pronto para guardar, ou null quando não serve:
 * sem texto, curto demais ou com um rótulo de voz ({F2}), que a tela do link e
 * a lista não trocam por nome. Sai o emoji do começo, as aspas em volta, o
 * ponto final e o espaço repetido; o texto longo é cortado no teto, sem cortar
 * um emoji ao meio.
 */
export function tituloSugeridoValido(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  let titulo = valor.replace(/\s+/g, " ").trim().replace(EMOJI_NO_COMECO, "").trim();
  while (titulo.length >= 2 && ASPAS.has(titulo[0]) && ASPAS.has(titulo[titulo.length - 1])) titulo = titulo.slice(1, -1).trim();
  titulo = titulo.replace(/[.。]+$/, "").trim();
  if (ROTULO_DE_VOZ.test(titulo)) return null;
  const letras = Array.from(titulo);
  if (letras.length > TITULO_SUGERIDO_MAX) titulo = letras.slice(0, TITULO_SUGERIDO_MAX).join("").trimEnd();
  return Array.from(titulo).length >= TITULO_DA_REUNIAO_MIN ? titulo : null;
}

/** O mesmo título, sem caixa, acento nem espaço repetido: a sugestão igual ao título de agora não aparece. */
export function mesmoTitulo(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalizar = (texto: string | null | undefined) => (texto ?? "").normalize("NFD").replace(MARCAS, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return !!a && !!b && normalizar(a) === normalizar(b);
}

/** A situação da sugestão: à espera da dona, usada ou mantido o título dela. */
export type SituacaoDoTituloSugerido = "pending" | "confirmed" | "ignored";

/**
 * A sugestão que o resumo novo grava. A que a dona já decidiu (usou ou
 * manteve o dela) não volta a pedir decisão quando o resumo refeito (H4d)
 * sugere o mesmo título; outro título volta a esperar por ela. Sem sugestão
 * nova, nenhuma.
 */
export function sugestaoDoResumoNovo(
  anterior: { suggestedTitle: string | null; suggestedTitleStatus: SituacaoDoTituloSugerido | null } | null | undefined,
  novo: string | null,
): { suggestedTitle: string | null; suggestedTitleStatus: SituacaoDoTituloSugerido | null } {
  if (!novo) return { suggestedTitle: null, suggestedTitleStatus: null };
  const jaDecidida = !!anterior && mesmoTitulo(anterior.suggestedTitle, novo) && (anterior.suggestedTitleStatus === "confirmed" || anterior.suggestedTitleStatus === "ignored");
  return { suggestedTitle: novo, suggestedTitleStatus: jaDecidida ? anterior.suggestedTitleStatus : "pending" };
}
