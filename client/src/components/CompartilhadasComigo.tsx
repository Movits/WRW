import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Check, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { rotaDaReuniaoCompartilhada } from "@shared/rotas";

/**
 * Na lista de Reuniões (R1b): os convites de conexão pendentes (aceitar ou
 * recusar) e as reuniões que outras donas compartilharam com esta conta. Some
 * quando não há nenhum dos dois. A consulta falhando não esconde a lista da
 * dona: a seção some, e a lista segue.
 */
export function CompartilhadasComigo() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const consulta = trpc.meetings.compartilhadasComigo.useQuery(undefined, { refetchOnWindowFocus: false });
  const responder = trpc.meetings.responderConviteDeConexao.useMutation({
    onSuccess: async ({ meetingId }, { aceitar }) => {
      await utils.meetings.compartilhadasComigo.invalidate();
      if (aceitar) navigate(rotaDaReuniaoCompartilhada(meetingId));
    },
    onError: erro => toast.error(mensagemDeErroParaTela(erro, t)),
  });
  const dados = consulta.data;
  if (!dados || (!dados.reunioes.length && !dados.convites.length)) return null;
  const data = (ms: number) => new Date(ms).toLocaleDateString(i18n.language);
  return <div className="mb-7 space-y-4">
    {dados.convites.length > 0 && <section aria-labelledby="convites-de-reuniao" className="rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4">
      <h2 id="convites-de-reuniao" className="inline-flex items-center gap-2 text-sm font-semibold text-amber-100"><Users size={15} aria-hidden="true"/>{t("meetings.participants.invitesHeading")}</h2>
      <p className="mt-1 text-xs text-amber-100/70">{t("meetings.participants.inviteNotice")}</p>
      <ul className="mt-3 space-y-2">{dados.convites.map(convite => <li key={convite.participanteId} className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/10 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p dir="auto" className="truncate font-medium">{convite.titulo}</p><p className="text-xs text-white/50">{t("meetings.participants.sharedBy", { nome: convite.nomeDaDona })} · {data(convite.criadaEm)}</p></div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ participanteId: convite.participanteId, aceitar: true })} className="inline-flex items-center gap-1 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-60"><Check size={14} aria-hidden="true"/>{t("meetings.participants.accept")}</button>
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ participanteId: convite.participanteId, aceitar: false })} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 disabled:opacity-60"><X size={14} aria-hidden="true"/>{t("meetings.participants.decline")}</button>
        </div>
      </li>)}</ul>
    </section>}
    {dados.reunioes.length > 0 && <section aria-labelledby="compartilhadas-comigo" className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <h2 id="compartilhadas-comigo" className="inline-flex items-center gap-2 text-sm font-semibold"><Users size={15} aria-hidden="true"/>{t("meetings.participants.sharedWithMeHeading")}</h2>
      <ul className="mt-3 space-y-2">{dados.reunioes.map(reuniao => <li key={reuniao.meetingId}>
        <button type="button" onClick={() => navigate(rotaDaReuniaoCompartilhada(reuniao.meetingId))} className="w-full rounded-xl border border-white/10 bg-black/10 p-3 text-start hover:bg-white/5">
          <p dir="auto" className="truncate font-medium">{reuniao.titulo}</p>
          <p className="text-xs text-white/50">{t("meetings.participants.sharedBy", { nome: reuniao.nomeDaDona })} · {data(reuniao.criadaEm)}</p>
        </button>
      </li>)}</ul>
    </section>}
  </div>;
}
