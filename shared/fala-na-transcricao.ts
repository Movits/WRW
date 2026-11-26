/**
 * O que é fala numa transcrição. A marca curta entre colchetes ([música],
 * [ruído], [inaudível], na língua da fala em volta: a regra 5 dos prompts de
 * server/transcricao-de-fatia.ts e de server/youtube.ts) não é fala, mesmo
 * quando o modelo dá a ela um falante.
 *
 * Mora em shared/ porque os dois lados contam fala do mesmo jeito: o servidor,
 * para dizer que o vídeo não tem fala nenhuma (temFala, em server/youtube.ts);
 * a tela, para o tempo de fala de cada voz e o rótulo da voz em cada trecho
 * (components/TranscricaoPorFalante.tsx). A vinheta de música de um vídeo do
 * YouTube vinha como "Falante 2", e uma voz que não existe entrava no tempo de
 * fala (conferência de tela de 20/11/2026).
 */

// Letra ou número de qualquer escrita. Pelo construtor, com "u", como
// ESCRITA_SEM_ESPACO em server/meeting-service.ts: o alvo do tsc não aceita o
// literal /.../u.
const LETRA_OU_NUMERO = new RegExp("[\\p{L}\\p{N}]", "u");

/** Se o texto tem fala: alguma letra ou número fora das marcas entre colchetes. */
export function textoTemFala(texto: string): boolean {
  return LETRA_OU_NUMERO.test(texto.replace(/\[[^\]]*\]/g, ""));
}
