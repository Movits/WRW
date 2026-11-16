import { vozesNoTexto } from "./vozes-no-texto";

/**
 * O rascunho de e-mail de retorno (H20): a IA escreve, a partir dos itens que a
 * dona confirmou no resumo guardado, um e-mail que ela revisa e manda pelo app
 * de e-mail dela ou copia. A WRW não envia nada e não guarda o rascunho.
 *
 * O nome de quem recebe não sai do navegador: a IA escreve a marca
 * {DESTINATARIO} no lugar dele, e a tela troca a marca pelo nome digitado. As
 * pessoas da reunião seguem a regra das vozes do resumo: a IA escreve o rótulo
 * ({F2}), e a tela o troca pelo nome que a dona deu (shared/vozes-no-texto.ts).
 * Os nomes nunca vão ao prompt.
 */

/** Para quem a dona escreve: muda o que o e-mail destaca. */
export const RELACOES_DO_EMAIL = ["team", "external", "leadership", "network"] as const;
export type RelacaoDoEmail = (typeof RELACOES_DO_EMAIL)[number];

export const TONS_DO_EMAIL = ["professional", "friendly", "direct", "urgent"] as const;
export type TomDoEmail = (typeof TONS_DO_EMAIL)[number];

/** Onde vai o nome de quem recebe. Em maiúsculas e sem acento, como a IA deve copiar. */
export const MARCA_DO_DESTINATARIO = "{DESTINATARIO}";
/** O nome de quem recebe, digitado na tela: o mesmo teto do nome de uma voz. */
export const NOME_DO_DESTINATARIO_MAX = 60;

/**
 * As recusas do rascunho, nas palavras que chegam ao navegador. Como as do
 * resumo guardado (shared/const.ts): o servidor (server/email-de-retorno.ts)
 * escreve sem saber o idioma da dona, e a tela as traduz reconhecendo o texto
 * exato (client/src/lib/mensagem-de-erro.ts, chaves meetings.followUp.*).
 */
export const MENSAGEM_EMAIL_SEM_RESUMO_PRONTO = "O resumo desta reunião não está pronto. Espere terminar para escrever o e-mail.";
export const MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO = "Confirme ao menos um item do resumo para escrever o e-mail.";

const ROTULO_DE_VOZ = /\{(F[1-9][0-9]?)\}/g;

const comparavel = (nome: string) => nome.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * A voz da reunião que tem o nome digitado (sem diferença de caixa nem de
 * espaços), quando só uma tem: a IA então fala com quem recebe na segunda
 * pessoa sobre o que é dela. Nome que não é de nenhuma voz, ou de mais de uma,
 * não identifica ninguém.
 */
export function vozDoDestinatario(nome: string, nomes: Readonly<Record<string, string>>): string | undefined {
  const alvo = comparavel(nome);
  if (!alvo) return undefined;
  const vozes = Object.entries(nomes).filter(([, dado]) => comparavel(dado) === alvo).map(([voz]) => voz);
  return vozes.length === 1 ? vozes[0] : undefined;
}

/**
 * O texto da IA como a dona o vê: a marca vira o nome digitado, e cada rótulo
 * de voz, o nome que ela deu (ou o rótulo traduzido, "Falante 2"). Uma passada
 * só: um nome que contenha "{F1}" ou a marca não é trocado de novo.
 */
export function preencherRascunho(
  texto: string,
  destinatario: string,
  nomes: Readonly<Record<string, string>>,
  rotuloDaVoz: (numero: number) => string,
): string {
  return texto.split(MARCA_DO_DESTINATARIO).map(parte => vozesNoTexto(parte, nomes, rotuloDaVoz)).join(destinatario.trim());
}

/** Os números das vozes que o texto cita e que não têm nome: a tela avisa que saem como "Falante n". */
export function vozesSemNome(texto: string, nomes: Readonly<Record<string, string>>): number[] {
  const numeros = new Set<number>();
  for (const [, voz] of Array.from(texto.matchAll(ROTULO_DE_VOZ))) {
    if (!nomes[voz]?.trim()) numeros.add(Number(voz.slice(1)));
  }
  return Array.from(numeros).sort((a, b) => a - b);
}
