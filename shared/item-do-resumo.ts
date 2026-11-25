import type { meetingSummaryItems } from "./types";

/**
 * O item do resumo guardado que a dona escreve (H4f do pacote do gravador):
 * ela edita o texto, o assunto (das tarefas), o responsável e o prazo de um
 * item, e acrescenta item à mão. As regras moram aqui porque o servidor
 * (server/resumo-guardado.ts e a entrada de server/routers/meetings.ts) e a
 * tela (components/FormularioDoItemDoResumo.tsx) leem as mesmas.
 */

export type SecaoDoItem = (typeof meetingSummaryItems.$inferSelect)["section"];

/** As seções do resumo, na ordem do formato da cliente (a mesma do schema). */
export const SECOES_DO_RESUMO = ["action", "focus", "task", "decision", "blocker", "question"] as const satisfies readonly SecaoDoItem[];

/** O texto que a dona escreve: o foco da IA vai até 900 caracteres. */
export const TEXTO_DO_ITEM_DO_RESUMO_MAX = 1000;
/** O assunto, o responsável e o prazo: o tamanho das colunas. */
export const CAMPO_DO_ITEM_DO_RESUMO_MAX = 120;
/**
 * Quantos itens um resumo guarda, somados os da IA (até 44) e os da dona,
 * ignorados inclusive: acrescentar não custa IA, e o teto segura o banco.
 */
export const ITENS_DO_RESUMO_MAX = 200;

/** Só as ações e as tarefas têm responsável e prazo, como no formato da cliente. */
export function secaoTemResponsavel(secao: SecaoDoItem): boolean {
  return secao === "action" || secao === "task";
}

/** Só as tarefas têm assunto ("Contrato com o importador: ..."). */
export function secaoTemAssunto(secao: SecaoDoItem): boolean {
  return secao === "task";
}
