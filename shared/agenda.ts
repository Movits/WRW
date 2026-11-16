/**
 * As regras da agenda de reuniões (H16a do plano do gravador) que a tela e o
 * servidor dividem: os limites de cada campo, os lembretes que a tela oferece e
 * o fuso. O servidor recusa o que passa daqui (server/routers/agenda.ts); a tela
 * usa os mesmos números para não mandar o que seria recusado.
 */

/** A reunião marcada dura de 5 minutos a 12 horas, o teto técnico da gravação. */
export const DURACAO_DA_AGENDADA_MIN = 5;
export const DURACAO_DA_AGENDADA_MAX = 12 * 60;

/** As durações da lista da tela, em minutos. O servidor aceita qualquer uma entre o mínimo e o máximo. */
export const DURACOES_DA_TELA = [15, 30, 45, 60, 90, 120, 180, 240] as const;
export const DURACAO_PADRAO = 60;

/**
 * Os lembretes, em minutos antes do início: na hora, 5, 10, 15 e 30 minutos,
 * 1 e 2 horas e 1 dia. Sem lembrete é nulo.
 */
export const LEMBRETES_DA_AGENDA = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
export type LembreteDaAgenda = (typeof LEMBRETES_DA_AGENDA)[number];
export const LEMBRETE_PADRAO: LembreteDaAgenda = 15;

export const LOCAL_DA_AGENDADA_MAX = 500;
export const PARTICIPANTES_DA_AGENDADA_MAX = 50;
export const NOME_DO_PARTICIPANTE_MAX = 120;
export const EMAIL_DO_PARTICIPANTE_MAX = 320;
export const FUSO_MAX = 64;

/** Quem vai à reunião: o nome e o e-mail, cada um opcional, nunca os dois vazios. */
export type ParticipanteDaAgenda = { nome: string | null; email: string | null };

/**
 * O fuso no nome canônico da IANA ("america/sao_paulo" vira "America/Sao_Paulo"),
 * ou null quando o Intl não o conhece. Serve à tela e ao servidor: os dois têm
 * o banco de fusos completo (Node 20 e os navegadores atuais).
 */
export function fusoCanonico(fuso: string): string | null {
  if (!fuso || fuso.length > FUSO_MAX) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: fuso }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** O fuso do aparelho de quem marca; sem um que o Intl conheça, UTC. */
export function fusoDoAparelho(): string {
  try {
    return fusoCanonico(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** Endereço web inteiro (o link da chamada), e não um endereço de rua com um link no meio. */
export function ehLinkDaChamada(local: string | null | undefined): boolean {
  return typeof local === "string" && /^https?:\/\/[^\s<>"]+$/i.test(local.trim());
}
