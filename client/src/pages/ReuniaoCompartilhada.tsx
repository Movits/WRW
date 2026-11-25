import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "wouter";
import { LogOut, Users } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { credencialDaParticipante } from "@shared/participantes-da-reuniao";
import { ROTA_DAS_REUNIOES } from "@shared/rotas";
import { LeituraDaReuniao } from "./ReuniaoAberta";

/**
 * A reunião compartilhada com a participante (R1b): a mesma leitura do link
 * aberto (resumo, transcrição, gravação, mapa mental e o Pergunte), pela
 * credencial dela ("participante:<id>"), que o servidor confere com a sessão a
 * cada leitura. Nada aqui muda a reunião: excluir, reprocessar, decidir itens,
 * nomear e juntar vozes e convidar ficam com a dona. A participante vê quem
 * compartilhou e quem mais participa (só as que aceitaram), e pode sair.
 *
 * As perguntas ao Pergunte não ficam guardadas (o histórico da H6b não está
 * na main): cada participante vê só as que fez nesta tela.
 */
export default function ReuniaoCompartilhada() {
  const { id = "" } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const participantes = trpc.meetings.participantes.useQuery({ meetingId: id }, { retry: false, refetchOnWindowFocus: false });
  const [confirmandoSaida, setConfirmandoSaida] = useState(false);
  const sair = trpc.meetings.sairDaReuniao.useMutation({
    onSuccess: async () => {
      toast.success(t("meetings.participants.leftToast"));
      await utils.meetings.compartilhadasComigo.invalidate();
      navigate(ROTA_DAS_REUNIOES);
    },
    onError: erro => toast.error(mensagemDeErroParaTela(erro, t)),
  });
  const dados = participantes.data?.papel === "participante" ? participantes.data : null;
  const voltar = <button type="button" onClick={() => navigate(ROTA_DAS_REUNIOES)} className="mt-4 inline-block text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.allMeetings")}</button>;

  const cabecalho = <div className="mt-4 space-y-3">
    <p className="max-w-3xl text-sm text-white/60">{dados ? t("meetings.participants.sharedBy", { nome: dados.nomeDaDona }) : t("meetings.participants.sharedIntro")}</p>
    {dados && dados.participantes.length > 0 && <p className="flex flex-wrap items-center gap-2 text-xs text-white/50">
      <Users size={14} aria-hidden="true"/>
      <span>{t("meetings.participants.whoParticipates")}</span>
      {dados.participantes.map((p, i) => <span key={i} dir="auto" className="rounded-full border border-white/10 px-2 py-0.5 text-white/70">{p.souEu ? t("meetings.participants.you", { nome: p.nome }) : p.nome}</span>)}
    </p>}
    {confirmandoSaida
      ? <div role="alertdialog" aria-labelledby="sair-da-reuniao" className="rounded-xl border border-red-400/25 bg-red-400/5 p-4">
        <p id="sair-da-reuniao" className="text-sm text-red-100/85">{t("meetings.participants.leaveConfirm")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={sair.isPending} onClick={() => sair.mutate({ meetingId: id })} className="rounded-lg bg-red-400/80 px-3 py-2 text-sm font-semibold text-[#1a120c] disabled:opacity-60">{t("meetings.participants.leaveButton")}</button>
          <button type="button" onClick={() => setConfirmandoSaida(false)} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/70">{t("meetings.participants.cancel")}</button>
        </div>
      </div>
      : <button type="button" onClick={() => setConfirmandoSaida(true)} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 hover:bg-white/5"><LogOut size={14} aria-hidden="true"/>{t("meetings.participants.leaveButton")}</button>}
  </div>;

  return <LeituraDaReuniao token={credencialDaParticipante(id)} cabecalhoDaParticipante={cabecalho}
    naoEncontrada={<div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
      <p className="text-sm text-white/75">{t("meetings.participants.sharedNotFound")}</p>
      {voltar}
    </div>}/>;
}
