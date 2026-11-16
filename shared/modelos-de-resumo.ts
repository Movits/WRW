/**
 * Os modelos do resumo guardado da reunião (H4d do plano do gravador): o mesmo
 * formato e as mesmas seções (ações, foco, tarefas por assunto, decisões,
 * bloqueios e questões), com outra instrução à IA. A dona escolhe o modelo ao
 * pedir o resumo e pode "Refazer como…" outro: os itens que ela confirmou e as
 * ações feitas ficam; os pendentes e os ignorados são trocados.
 *
 * O código fica gravado em meeting_summaries.template (varchar com o enum só
 * no TypeScript, em drizzle/schema.ts); server/modelos-de-resumo.ts confere,
 * em tempo de compilação, que esta lista e a do schema são a mesma. O nome de
 * cada modelo na tela mora nos 10 idiomas de client/src/i18n/locales/.
 */
export const MODELOS_DE_RESUMO = ["general", "networking", "mentoring", "sales", "one_on_one"] as const;

export type ModeloDeResumo = (typeof MODELOS_DE_RESUMO)[number];

/** O modelo do resumo que nasce sozinho quando a reunião fica pronta. */
export const MODELO_DE_RESUMO_PADRAO: ModeloDeResumo = "general";

/** O valor gravado, se é um modelo conhecido; null se não é. */
export function modeloDeResumo(valor: unknown): ModeloDeResumo | null {
  return typeof valor === "string" && (MODELOS_DE_RESUMO as readonly string[]).includes(valor) ? valor as ModeloDeResumo : null;
}
