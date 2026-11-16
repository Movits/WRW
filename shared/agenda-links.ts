import { dataIcsUtc } from "./agenda-ics";

/**
 * Os links e a mensagem do convite de uma reunião da agenda (H16a do plano do
 * gravador). Tudo abre no app da própria dona (WhatsApp, e-mail, Google Agenda),
 * e é ela quem escolhe para quem mandar: a WRW não envia nada em nome dela. Das
 * integrações de fora, só a Google Agenda entra (decisão do Roberto de 16/11),
 * aqui pelo link de criar evento, sem conta ligada.
 */

export type EventoDoConvite = {
  titulo: string;
  inicioMs: number;
  duracaoMinutos: number;
  /** O fuso IANA em que a reunião foi marcada. */
  fuso?: string | null;
  local?: string | null;
};

const OPCOES_DO_QUANDO: Intl.DateTimeFormatOptions = {
  weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
};

/**
 * O começo e o fim da reunião no idioma de quem lê, na hora do fuso em que ela
 * foi marcada, com o nome do fuso ("sexta-feira, 20 de novembro de 2026
 * 14:00 – 15:30 BRT"): quem recebe o convite em outro fuso sabe de que hora se
 * trata. Fuso que o aparelho não conhece cai na hora local, também com o nome.
 */
export function quandoDaReuniao(evento: Pick<EventoDoConvite, "inicioMs" | "duracaoMinutos" | "fuso">, idioma: string): string {
  const inicio = new Date(evento.inicioMs);
  const fim = new Date(evento.inicioMs + evento.duracaoMinutos * 60_000);
  let formato: Intl.DateTimeFormat;
  try {
    formato = new Intl.DateTimeFormat(idioma, { ...OPCOES_DO_QUANDO, timeZone: evento.fuso || undefined });
  } catch {
    formato = new Intl.DateTimeFormat(idioma, OPCOES_DO_QUANDO);
  }
  return typeof formato.formatRange === "function" ? formato.formatRange(inicio, fim) : formato.format(inicio);
}

export const ENDERECO_DA_GOOGLE_AGENDA = "https://calendar.google.com/calendar/render";

/**
 * O link que abre a Google Agenda com o evento preenchido (título, início e
 * fim em UTC, local e fuso). Com `convidados`, os e-mails entram como
 * convidados: a Google pergunta, ao salvar, se manda o convite pela conta da
 * dona. Só o botão da própria dona passa convidados; o link que vai no convite,
 * não (ver mensagemDoConvite).
 */
export function linkDaGoogleAgenda(evento: EventoDoConvite & { convidados?: readonly string[]; detalhes?: string | null }): string {
  const fimMs = evento.inicioMs + evento.duracaoMinutos * 60_000;
  const parametros = new URLSearchParams({
    action: "TEMPLATE",
    text: evento.titulo,
    dates: `${dataIcsUtc(evento.inicioMs)}/${dataIcsUtc(fimMs)}`,
  });
  // A descrição do evento (a próxima ação da H5c leva o detalhe, o responsável e o endereço dela).
  const detalhes = evento.detalhes?.trim();
  if (detalhes) parametros.set("details", detalhes);
  const local = evento.local?.trim();
  if (local) parametros.set("location", local);
  if (evento.fuso) parametros.set("ctz", evento.fuso);
  const convidados = (evento.convidados ?? []).map(email => email.trim()).filter(Boolean);
  if (convidados.length) parametros.set("add", convidados.join(","));
  return `${ENDERECO_DA_GOOGLE_AGENDA}?${parametros.toString()}`;
}

/** Os rótulos do convite, já traduzidos pela tela; o cabeçalho já leva o título. */
export type RotulosDoConvite = {
  cabecalho: string;
  quando: string;
  onde: string;
  adicionarNaGoogle: string;
};

/**
 * A mensagem do convite, a mesma no WhatsApp e no e-mail: o título, quando,
 * onde (se a dona escreveu) e o link para a pessoa pôr na própria Google
 * Agenda. Os e-mails dos outros convidados nunca vão: o link é montado só com o
 * evento, mesmo que o objeto recebido traga os participantes.
 */
export function mensagemDoConvite(evento: EventoDoConvite, rotulos: RotulosDoConvite, idioma: string): string {
  const soOEvento: EventoDoConvite = {
    titulo: evento.titulo, inicioMs: evento.inicioMs, duracaoMinutos: evento.duracaoMinutos, fuso: evento.fuso, local: evento.local,
  };
  const linhas = [rotulos.cabecalho, `${rotulos.quando}: ${quandoDaReuniao(soOEvento, idioma)}`];
  const local = soOEvento.local?.trim();
  if (local) linhas.push(`${rotulos.onde}: ${local}`);
  linhas.push(`${rotulos.adicionarNaGoogle}: ${linkDaGoogleAgenda(soOEvento)}`);
  return linhas.join("\n");
}

/** O WhatsApp com a mensagem pronta: o app escolhe o contato ou o grupo. */
export function linkDoWhatsAppDoConvite(mensagem: string): string {
  return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}

/**
 * O e-mail do convite no app da dona. Os convidados vão em cópia oculta, para
 * um não ver o e-mail do outro; sem nenhum e-mail, ela escolhe a quem mandar.
 * A arroba fica como está e a vírgula separa os endereços (RFC 6068).
 */
export function linkDoEmailDoConvite(convidados: readonly string[], assunto: string, corpo: string): string {
  const enderecos = convidados.map(email => email.trim()).filter(Boolean);
  const partes: string[] = [];
  if (enderecos.length) partes.push(`bcc=${enderecos.map(email => encodeURIComponent(email).replace(/%40/g, "@")).join(",")}`);
  partes.push(`subject=${encodeURIComponent(assunto)}`, `body=${encodeURIComponent(corpo)}`);
  return `mailto:?${partes.join("&")}`;
}
