import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, CircleAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { quandoDaReuniao } from "@shared/agenda-links";

/**
 * A reunião da agenda no gravador (H16a do plano do gravador). Com
 * `/gravar?agendada=<id>` (o "Gravar agora" da agenda), o gravador lê a reunião
 * marcada, preenche o título, se a dona ainda não escreveu outro, e mostra de
 * qual reunião se trata. `aoCarregar` diz ao gravador qual reunião ligar à
 * gravação que nascer (Meetings.tsx); ao sair da tela, ou sem a reunião, nenhuma.
 *
 * Se a reunião não está mais na agenda, ou a leitura falha, a gravação segue
 * sem a ligação, e a dona é avisada aqui: a agenda nunca trava a gravação.
 */

function codigoDoErro(erro: unknown) {
  return (erro as { data?: { code?: string } } | null)?.data?.code;
}

export function ReuniaoDaAgendaNoGravador({ id, tituloAtual, aoPreencherTitulo, aoCarregar }: {
  id: string;
  /** O título que está no campo agora: escrito pela dona, não é trocado. */
  tituloAtual: string;
  aoPreencherTitulo: (titulo: string) => void;
  aoCarregar: (agendaId: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  // NOT_FOUND é definitivo (excluída ou de outra conta): não tenta de novo.
  const consulta = trpc.agenda.obter.useQuery({ id }, {
    retry: (tentativas, erro) => codigoDoErro(erro) !== "NOT_FOUND" && tentativas < 2,
    refetchOnWindowFocus: false,
  });
  // O título do campo e os avisos ao gravador, sempre os da última renderização,
  // sem refazer os efeitos a cada tecla.
  const atuais = useRef({ tituloAtual, aoPreencherTitulo, aoCarregar });
  atuais.current = { tituloAtual, aoPreencherTitulo, aoCarregar };
  const preenchida = useRef(false);

  const reuniao = consulta.data;
  useEffect(() => {
    if (!reuniao) return;
    atuais.current.aoCarregar(reuniao.id);
    // Uma vez só: o que a dona escrever depois fica, mesmo que a consulta volte.
    if (!preenchida.current) {
      preenchida.current = true;
      if (!atuais.current.tituloAtual.trim()) atuais.current.aoPreencherTitulo(reuniao.titulo);
    }
  }, [reuniao]);
  // Saiu da tela: a próxima gravação não leva esta reunião.
  useEffect(() => () => atuais.current.aoCarregar(null), []);

  if (reuniao) {
    return <p role="note" className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100/85">
      <CalendarDays size={14} className="mt-0.5 shrink-0"/>
      <span>{t("agenda.recorder.fromAgenda", { when: quandoDaReuniao({ inicioMs: reuniao.inicioEm, duracaoMinutos: reuniao.duracaoMinutos, fuso: reuniao.fuso }, i18n.resolvedLanguage ?? i18n.language) })}</span>
    </p>;
  }
  if (consulta.isError) {
    const naoExiste = codigoDoErro(consulta.error) === "NOT_FOUND";
    return <p role="note" className="mt-2 flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60">
      <CircleAlert size={14} className="mt-0.5 shrink-0"/>
      <span>{naoExiste ? t("agenda.recorder.notFound") : t("agenda.recorder.loadError")}</span>
    </p>;
  }
  return null;
}
