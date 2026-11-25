import { ehLinkDaChamada } from "./agenda";

/**
 * O arquivo .ics de uma reunião da agenda (H16a do plano do gravador), feito no
 * navegador da dona: ela o abre no calendário do celular ou o anexa a um
 * convite. Nada vai ao servidor.
 *
 * Segue a RFC 5545 no que os calendários do iPhone, do Android, da Google e do
 * Outlook cobram:
 * - toda linha termina em CRLF, inclusive a última;
 * - no texto, a barra invertida, o ponto e vírgula, a vírgula e a quebra de
 *   linha vão escapados, e os caracteres de controle saem;
 * - linha com mais de 75 octetos é dobrada (CRLF e um espaço), contando os
 *   octetos do UTF-8 e sem partir um caractere no meio;
 * - as datas vão em UTC (com o Z): cada calendário mostra na hora local de quem
 *   abre, sem precisar descrever o fuso (VTIMEZONE);
 * - o UID é o mesmo a cada download, e o SEQUENCE cresce a cada mudança da
 *   reunião: o calendário que já tem o evento fica com a versão nova.
 */

export type EventoDoIcs = {
  /** Estável por reunião: com o SEQUENCE maior, baixar de novo atualiza o evento, em vez de duplicar. */
  uid: string;
  titulo: string;
  inicioMs: number;
  duracaoMinutos: number;
  local?: string | null;
  descricao?: string | null;
  /** Minutos antes do início; nulo ou ausente é sem lembrete. */
  lembreteMinutos?: number | null;
  /**
   * A revisão do evento (SEQUENCE, RFC 5545, 3.8.7.4), que cresce a cada mudança:
   * ver revisaoDoIcs. O calendário que já tem o UID escolhe a versão pelo
   * SEQUENCE (RFC 5546, 2.1.5); com o mesmo número, o arquivo da reunião
   * mudada podia ser ignorado ou recusado como repetido, e a dona chegava na
   * hora velha. Ausente é 0, a da reunião recém-criada.
   */
  revisao?: number;
  /** A última mudança da reunião (LAST-MODIFIED), em ms. */
  modificadoEmMs?: number | null;
  /**
   * O evento não ocupa a agenda (TRANSP:TRANSPARENT, RFC 5545, 3.8.2.7): quem
   * consulta a disponibilidade da dona vê o horário livre. É o da próxima ação
   * (H5c). Ausente, vale o padrão da RFC, ocupado, o certo para a reunião.
   */
  livre?: boolean;
};

const OCTETOS_POR_LINHA = 75;

// Por new RegExp(..., "u"), como em direcao-do-termo.ts: o tsconfig não fixa
// target, e o literal /.../u não passa no `pnpm check`. As marcas (\p{M})
// ficam: sem elas, o hindi perde as vogais.
const FORA_DO_NOME = new RegExp("[^\\p{L}\\p{M}\\p{N} _-]+", "gu");
// A marca que sobrou sem letra antes dela (o seletor de variação de um emoji que
// saiu) também sai.
const MARCA_SOLTA = new RegExp("(^|[^\\p{L}\\p{M}\\p{N}])\\p{M}+", "gu");

/** Texto de propriedade (RFC 5545, 3.3.11). */
export function escaparTextoIcs(texto: string): string {
  return texto
    .replace(/\r\n?/g, "\n")
    // O TAB e a quebra de linha ficam (a quebra vira \n abaixo); o resto do controle sai.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function octetosDe(caractere: string): number {
  const ponto = caractere.codePointAt(0) ?? 0;
  return ponto < 0x80 ? 1 : ponto < 0x800 ? 2 : ponto < 0x10000 ? 3 : 4;
}

/**
 * Dobra a linha em pedaços de até 75 octetos. A continuação começa com um
 * espaço, que conta no tamanho dela. O Array.from anda de caractere em
 * caractere (de ponto de código em ponto de código), então nenhum se parte ao
 * meio.
 */
export function dobrarLinhaIcs(linha: string): string {
  const pedacos: string[] = [];
  let atual = "";
  let octetos = 0;
  for (const caractere of Array.from(linha)) {
    const tamanho = octetosDe(caractere);
    if (octetos + tamanho > OCTETOS_POR_LINHA) {
      pedacos.push(atual);
      atual = " ";
      octetos = 1;
    }
    atual += caractere;
    octetos += tamanho;
  }
  pedacos.push(atual);
  return pedacos.join("\r\n");
}

/** A data em UTC no formato do iCalendar: 20261120T170000Z. */
export function dataIcsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A revisão do .ics de uma reunião da agenda: os segundos entre a criação e a
 * última mudança (o updatedAt que o servidor grava a cada mudança). Cresce a
 * cada mudança sem guardar contador, e cabe no INTEGER do iCalendar por 68 anos.
 */
export function revisaoDoIcs(criadoEmMs: number, modificadoEmMs: number): number {
  const segundos = Math.floor((modificadoEmMs - criadoEmMs) / 1000);
  return Number.isFinite(segundos) && segundos > 0 ? segundos : 0;
}

/** O aviso antes do início: em dias, horas ou minutos, o que for exato. Zero é na hora. */
function antecedenciaDoAviso(minutos: number): string {
  const inteiro = Math.max(0, Math.round(minutos));
  if (inteiro === 0) return "PT0S";
  if (inteiro % 1440 === 0) return `-P${inteiro / 1440}D`;
  if (inteiro % 60 === 0) return `-PT${inteiro / 60}H`;
  return `-PT${inteiro}M`;
}

/** O .ics de um evento, pronto para o Blob: as linhas dobradas e terminadas em CRLF. */
export function montarIcs(evento: EventoDoIcs, agoraMs: number = Date.now()): string {
  if (!Number.isFinite(evento.inicioMs) || !(evento.duracaoMinutos > 0)) {
    throw new RangeError("Evento sem início ou duração válidos.");
  }
  const fimMs = evento.inicioMs + evento.duracaoMinutos * 60_000;
  const revisao = typeof evento.revisao === "number" && Number.isInteger(evento.revisao) && evento.revisao > 0 ? evento.revisao : 0;
  const linhas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WRW//Agenda de reunioes//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escaparTextoIcs(evento.uid)}`,
    `DTSTAMP:${dataIcsUtc(agoraMs)}`,
    `SEQUENCE:${revisao}`,
  ];
  if (typeof evento.modificadoEmMs === "number" && Number.isFinite(evento.modificadoEmMs)) {
    linhas.push(`LAST-MODIFIED:${dataIcsUtc(evento.modificadoEmMs)}`);
  }
  linhas.push(
    `DTSTART:${dataIcsUtc(evento.inicioMs)}`,
    `DTEND:${dataIcsUtc(fimMs)}`,
    `SUMMARY:${escaparTextoIcs(evento.titulo)}`,
  );
  if (evento.livre) linhas.push("TRANSP:TRANSPARENT");
  const local = evento.local?.trim();
  if (local) {
    linhas.push(`LOCATION:${escaparTextoIcs(local)}`);
    // O link da chamada vai também como URL, que o celular abre com um toque.
    // Valor do tipo URI: sem o escape do texto.
    if (ehLinkDaChamada(local)) linhas.push(`URL:${local}`);
  }
  const descricao = evento.descricao?.trim();
  if (descricao) linhas.push(`DESCRIPTION:${escaparTextoIcs(descricao)}`);
  if (typeof evento.lembreteMinutos === "number" && Number.isFinite(evento.lembreteMinutos)) {
    linhas.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escaparTextoIcs(evento.titulo)}`,
      `TRIGGER:${antecedenciaDoAviso(evento.lembreteMinutos)}`,
      "END:VALARM",
    );
  }
  linhas.push("END:VEVENT", "END:VCALENDAR");
  return linhas.map(dobrarLinhaIcs).join("\r\n") + "\r\n";
}

/**
 * O nome do arquivo: o título com letras e números de qualquer escrita (o
 * chinês e o árabe ficam), espaço vira hífen, até 60 caracteres. Sem nada
 * aproveitável, "reuniao".
 */
export function nomeDoArquivoIcs(titulo: string): string {
  const limpo = titulo.normalize("NFC").replace(FORA_DO_NOME, " ").replace(MARCA_SOLTA, "$1").trim().replace(/\s+/g, "-");
  const curto = Array.from(limpo).slice(0, 60).join("").replace(/-+$/, "");
  return `${curto || "reuniao"}.ics`;
}
