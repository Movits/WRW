import { lerParametrosDaReuniaoPronta, lerParametrosDoLembrete } from "@shared/lembretes";
import { prazoNaTela } from "@shared/proximas-acoes";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * O texto de um aviso do sino no idioma de quem lê (H15 do plano do gravador).
 *
 * Os avisos antigos guardam a frase pronta em title e body. Os do gravador
 * ('lembrete' e 'reuniao_pronta') guardam só os parâmetros (shared/lembretes.ts),
 * e a frase sai daqui, pelo tipo, com a data e a hora no formato do idioma:
 * - o lembrete da próxima ação diz o prazo, e o texto dela vai abaixo, com a
 *   voz sem nome como "Falante n";
 * - o da reunião da agenda diz o dia e a hora no fuso em que ela foi marcada,
 *   com o nome do fuso (como os cartões da agenda), e o título vai abaixo;
 * - o de reunião pronta diz se o resumo saiu, e o título vai abaixo.
 * Parâmetros fora da forma (uma versão futura, uma linha estragada): fica o
 * título guardado, que é o da origem.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type AvisoDoSino = { type: string; title: string; body: string | null; parametros?: unknown };
export type TextoDoAviso = { titulo: string; corpo: string | null };

const OPCOES_DA_HORA: Intl.DateTimeFormatOptions = {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
};

/** O dia e a hora da reunião marcada no idioma de quem lê, no fuso dela; fuso que o aparelho não conhece cai no dele. */
export function horaDaReuniaoNoSino(inicioEm: number, fuso: string, idioma: string): string {
  const inicio = new Date(inicioEm);
  try {
    return new Intl.DateTimeFormat(idioma, { ...OPCOES_DA_HORA, timeZone: fuso }).format(inicio);
  } catch {
    return new Intl.DateTimeFormat(idioma, OPCOES_DA_HORA).format(inicio);
  }
}

export function textoDoAviso(aviso: AvisoDoSino, t: TranslateFn, idioma: string, agora: Date = new Date()): TextoDoAviso {
  if (aviso.type === "lembrete") {
    const lembrete = lerParametrosDoLembrete(aviso.parametros);
    if (lembrete?.origem === "acao") {
      return {
        titulo: t("notifications.reminder.actionTitle", { data: prazoNaTela(lembrete.prazo, idioma, agora) }),
        corpo: vozesNoTexto(lembrete.texto, {}, numero => t("meetings.speakerLabel", { n: numero })),
      };
    }
    if (lembrete?.origem === "agenda") {
      return {
        titulo: t("notifications.reminder.meetingTitle", { quando: horaDaReuniaoNoSino(lembrete.inicioEm, lembrete.fuso, idioma) }),
        corpo: lembrete.titulo,
      };
    }
  }
  if (aviso.type === "reuniao_pronta") {
    const pronta = lerParametrosDaReuniaoPronta(aviso.parametros);
    if (pronta) {
      return {
        titulo: t(pronta.resumo === "pronto" ? "notifications.meetingReady.title" : "notifications.meetingReady.titleNoSummary"),
        corpo: pronta.titulo,
      };
    }
  }
  return { titulo: aviso.title, corpo: aviso.body };
}
