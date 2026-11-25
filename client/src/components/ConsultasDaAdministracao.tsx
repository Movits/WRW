import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";

/**
 * As datas em que a administração consultou a reunião (R1a; o aviso de
 * gravação 2026-11-23 promete que "a organizadora é informada da data de cada
 * consulta"). Só a data: o motivo e quem consultou ficam na auditoria. Sem
 * consulta, nada aparece; a falha da leitura aparece como erro, nunca como
 * "nenhuma consulta".
 */
export function ConsultasDaAdministracao({ meetingId }: { meetingId: string }) {
  const { t, i18n } = useTranslation();
  const consultas = trpc.meetings.consultasDaAdministracao.useQuery({ meetingId });
  if (consultas.isError) return <ErroDeConsulta erro={consultas.error} aoTentarDeNovo={() => consultas.refetch()} />;
  if (!consultas.data?.length) return null;
  // Uma data por dia: duas consultas no mesmo dia não repetem a data.
  const datas = Array.from(new Set(consultas.data.map(momento => new Date(momento).toLocaleDateString(i18n.language))));
  return <p className="text-sm text-amber-200/80 mt-3" data-testid="consultas-da-administracao">{t("meetings.adminReads.notice", { datas: datas.join(", ") })}</p>;
}
