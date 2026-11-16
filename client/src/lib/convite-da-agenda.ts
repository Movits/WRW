import type { ParticipanteDaAgenda } from "@shared/agenda";
import { linkDoEmailDoConvite, linkDoWhatsAppDoConvite, mensagemDoConvite, type EventoDoConvite } from "@shared/agenda-links";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** O que o convite lê de uma reunião da agenda: agenda.listar e agenda.obter devolvem isto. */
export type ReuniaoDoConvite = {
  titulo: string;
  inicioEm: number;
  duracaoMinutos: number;
  fuso: string;
  local: string | null;
  participantes: ParticipanteDaAgenda[];
};

/**
 * O convite de uma reunião da agenda (H16a), o mesmo no cartão da agenda e no
 * gravador: a mensagem pronta no idioma da tela, que abre no WhatsApp ou no
 * e-mail da própria dona, com os convidados em cópia oculta. Os e-mails nunca
 * vão na mensagem (shared/agenda-links.ts).
 */
export function conviteDaReuniao(reuniao: ReuniaoDoConvite, t: TranslateFn, idioma: string) {
  const evento: EventoDoConvite = {
    titulo: reuniao.titulo, inicioMs: reuniao.inicioEm, duracaoMinutos: reuniao.duracaoMinutos, fuso: reuniao.fuso, local: reuniao.local,
  };
  const emails = reuniao.participantes.map(p => p.email).filter((email): email is string => Boolean(email));
  const mensagem = mensagemDoConvite(evento, {
    cabecalho: t("agenda.invite.heading", { title: reuniao.titulo }),
    quando: t("agenda.invite.when"),
    onde: t("agenda.invite.where"),
    adicionarNaGoogle: t("agenda.invite.addToGoogle"),
  }, idioma);
  return {
    evento,
    emails,
    whatsapp: linkDoWhatsAppDoConvite(mensagem),
    email: linkDoEmailDoConvite(emails, t("agenda.invite.emailSubject", { title: reuniao.titulo }), mensagem),
  };
}
