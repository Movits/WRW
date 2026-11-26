import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Check, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { IconeDaPastaNaTela } from "@/components/PastasDeReunioes";
import { rotaDaEquipe } from "@shared/rotas";
import { rotuloDoPapel } from "@/pages/EquipeDaPasta";

/**
 * Na lista de Reuniões (R2): os convites de conexão para equipes (aceitar ou
 * recusar) e as equipes de outras donas de que esta conta é membra. Some
 * quando não há nenhum dos dois; a consulta falhando não esconde a lista da
 * dona.
 */
export function EquipesComigo() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const consulta = trpc.equipes.minhas.useQuery(undefined, { refetchOnWindowFocus: false });
  const responder = trpc.equipes.responderConvite.useMutation({
    onSuccess: async ({ pastaId }, { aceitar }) => {
      await utils.equipes.minhas.invalidate();
      if (aceitar) navigate(rotaDaEquipe(pastaId));
    },
    onError: erro => toast.error(mensagemDeErroParaTela(erro, t)),
  });
  const dados = consulta.data;
  if (!dados || (!dados.equipes.length && !dados.convites.length)) return null;
  return <div className="mb-7 space-y-4">
    {dados.convites.length > 0 && <section aria-labelledby="convites-de-equipe" className="rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4">
      <h2 id="convites-de-equipe" className="inline-flex items-center gap-2 text-sm font-semibold text-amber-100"><Users size={15} aria-hidden="true"/>{t("teams.invitesHeading")}</h2>
      <p className="mt-1 text-xs text-amber-100/70">{t("teams.inviteNotice")}</p>
      <ul className="mt-3 space-y-2">{dados.convites.map(convite => <li key={convite.membraId} className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/10 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p dir="auto" className="break-words font-medium">{convite.nome}</p><p className="text-xs text-white/50">{t("teams.ownerOf", { nome: convite.nomeDaDona })} · {rotuloDoPapel(t, convite.papel)}</p></div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ membraId: convite.membraId, aceitar: true })} className="inline-flex items-center gap-1 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-60"><Check size={14} aria-hidden="true"/>{t("teams.accept")}</button>
          <button type="button" disabled={responder.isPending} onClick={() => responder.mutate({ membraId: convite.membraId, aceitar: false })} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 disabled:opacity-60"><X size={14} aria-hidden="true"/>{t("teams.decline")}</button>
        </div>
      </li>)}</ul>
    </section>}
    {dados.equipes.length > 0 && <section aria-labelledby="minhas-equipes" className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <h2 id="minhas-equipes" className="inline-flex items-center gap-2 text-sm font-semibold"><Users size={15} aria-hidden="true"/>{t("teams.myTeamsHeading")}</h2>
      <ul className="mt-3 space-y-2">{dados.equipes.map(equipe => <li key={equipe.pastaId}>
        <button type="button" onClick={() => navigate(rotaDaEquipe(equipe.pastaId))} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/10 p-3 text-start hover:bg-white/5">
          <IconeDaPastaNaTela icone={equipe.icone} cor={equipe.cor}/>
          <span className="min-w-0">
            <span dir="auto" className="block break-words font-medium">{equipe.nome}</span>
            <span className="block text-xs text-white/50">{t("teams.ownerOf", { nome: equipe.nomeDaDona })} · {rotuloDoPapel(t, equipe.papel)}</span>
          </span>
        </button>
      </li>)}</ul>
    </section>}
  </div>;
}
