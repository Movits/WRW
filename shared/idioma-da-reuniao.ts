/**
 * O idioma falado numa reunião, num ditado ou na voz sobre um contato.
 *
 * Contrato do desenho do gravador (docs/arquitetura/gravador-de-reunioes.md,
 * "Contratos entre as PRs"): uma função só decide o código, em que 'pt' vira
 * 'pt-BR'. O CÓDIGO fica gravado (meetings.language e
 * meeting_transcripts.language, varchar 12); o NOME só vai no prompt da IA.
 *
 * São os mesmos 10 idiomas da tela (client/src/i18n). Reuniões gravadas antes
 * desta função guardam 'pt'; quem lê o idioma gravado passa por
 * `idiomaDaReuniao` em vez de comparar a string crua.
 */
export const IDIOMAS_DA_REUNIAO = ["pt-BR", "en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"] as const;

export type IdiomaDaReuniao = (typeof IDIOMAS_DA_REUNIAO)[number];

export const IDIOMA_DA_REUNIAO_PADRAO: IdiomaDaReuniao = "pt-BR";

const NOMES: Record<IdiomaDaReuniao, string> = {
  "pt-BR": "português do Brasil",
  en: "inglês",
  es: "espanhol",
  fr: "francês",
  de: "alemão",
  ar: "árabe",
  zh: "chinês simplificado",
  hi: "hindi",
  ja: "japonês",
  ru: "russo",
};

/**
 * O código da lista para o que veio da tela, do navegador ou do banco, ou
 * null quando não é um dos 10. Aceita o código regional que o navegador
 * informa ("en-US", "zh-CN") e todo português ("pt", "pt-PT", "pt-br") como
 * 'pt-BR', o único português da lista.
 */
export function idiomaDaReuniao(codigo: string | null | undefined): IdiomaDaReuniao | null {
  if (typeof codigo !== "string") return null;
  const base = codigo.trim().toLowerCase().split(/[-_]/)[0];
  if (base === "pt") return "pt-BR";
  return (IDIOMAS_DA_REUNIAO as readonly string[]).includes(base) ? (base as IdiomaDaReuniao) : null;
}

/** O nome do idioma, em português, para o prompt da IA. */
export function nomeDoIdioma(codigo: IdiomaDaReuniao): string {
  return NOMES[codigo];
}
