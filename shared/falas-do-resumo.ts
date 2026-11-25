import { vozesNoTexto } from "./vozes-no-texto";

/**
 * O que a voz lê do resumo guardado, fala por fala: a voz do aparelho ("Ouvir
 * o resumo", H19, client/src/components/OuvirOResumo.tsx) e a voz do Gemini
 * ("Baixar o áudio do resumo", H19b, server/resumo-em-audio.ts) leem o MESMO
 * texto. Mora aqui para as duas nunca divergirem; o `t` vem de quem chama, no
 * idioma do resumo (a tela usa o i18n; o servidor, os mesmos arquivos de
 * tradução).
 *
 * Cada seção com o título e os itens, o responsável e o prazo. O item ainda
 * não conferido não pode soar como conferido: com todos pendentes, um aviso
 * no começo basta; com alguns, o aviso explica e cada pendente começa com
 * "Para conferir", o selo que a dona vê na tela. O resumo traduzido (H11)
 * começa dizendo que a IA o traduziu e de que idioma. O complemento pela busca
 * na web (H4i) entra só confirmado, sempre anunciado como de fora da reunião.
 */

export type TraduzirFala = (key: string, options?: Record<string, unknown>) => string;

export const SECOES_NA_ORDEM = ["action", "focus", "task", "decision", "blocker", "question"] as const;
export type SecaoDaFala = (typeof SECOES_NA_ORDEM)[number];

export type ItemDaFala = {
  section: SecaoDaFala;
  status: string;
  subject: string | null;
  text: string;
  assignee: string | null;
  due: string | null;
  /** O complemento pela busca, só quando a dona o confirmou (H4i). */
  complemento?: { texto: string } | null;
};

// Cada ramo chama t() com a chave literal.
export function tituloDaSecaoNaFala(t: TraduzirFala, secao: SecaoDaFala) {
  switch (secao) {
    case "action": return t("meetings.summary.actionsHeading");
    case "focus": return t("meetings.summary.focusHeading");
    case "task": return t("meetings.summary.tasksHeading");
    case "decision": return t("meetings.summary.decisionsHeading");
    case "blocker": return t("meetings.summary.blockersHeading");
    case "question": return t("meetings.summary.openQuestionsHeading");
  }
}

export function falasDoResumo(t: TraduzirFala, itens: readonly ItemDaFala[], nomes: Readonly<Record<string, string>>, traduzidoDe: string | null = null): string[] {
  const comVozes = (texto: string) => vozesNoTexto(texto, nomes, numero => t("meetings.speakerLabel", { n: numero }));
  const pendentes = itens.filter(item => item.status === "pending").length;
  const todosPendentes = pendentes === itens.length;
  const falas: string[] = [];
  if (traduzidoDe) falas.push(t("meetings.summary.listenTranslated", { idioma: traduzidoDe }));
  if (pendentes) falas.push(todosPendentes ? t("meetings.summary.listenNoneReviewed") : t("meetings.summary.listenSomeToReview"));
  for (const secao of SECOES_NA_ORDEM) {
    const daSecao = itens.filter(item => item.section === secao);
    if (!daSecao.length) continue;
    falas.push(tituloDaSecaoNaFala(t, secao));
    for (const item of daSecao) {
      if (item.status === "pending" && !todosPendentes) falas.push(t("meetings.summary.toReview"));
      falas.push(item.subject ? `${comVozes(item.subject)}: ${comVozes(item.text)}` : comVozes(item.text));
      if (item.assignee) falas.push(t("meetings.summary.assignee", { nome: comVozes(item.assignee) }));
      if (item.due) falas.push(t("meetings.summary.due", { prazo: item.due }));
      if (item.complemento?.texto) falas.push(t("meetings.summary.complement.listen", { texto: item.complemento.texto }));
    }
  }
  return falas;
}
