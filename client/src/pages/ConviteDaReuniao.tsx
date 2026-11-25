import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "wouter";
import { Loader2, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { ROTA_DAS_REUNIOES, rotaDaReuniao, rotaDaReuniaoCompartilhada } from "@shared/rotas";

/**
 * O convite para participar de uma reunião (R1b): /convite/{token}, só
 * logada (a rota manda ao login, que volta para cá). Mostra o título, o nome
 * da dona e o aviso do que a participante aparece para as outras, e "Entrar na
 * reunião". O link vale uma vez: a conta que o usa vira a participante. O
 * convite que não existe, venceu ou já foi usado tem uma frase só, sem título
 * nem nome. O aviso (meetings.participants.inviteNotice) espera a revisão da
 * Cris, nos 10 idiomas.
 */
export default function ConviteDaReuniao() {
  const { token = "" } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const convite = trpc.meetings.verConvite.useQuery({ token }, { retry: false, refetchOnWindowFocus: false });
  const aceitar = trpc.meetings.aceitarConvite.useMutation({
    onSuccess: async ({ meetingId }) => {
      await utils.meetings.compartilhadasComigo.invalidate();
      navigate(rotaDaReuniaoCompartilhada(meetingId));
    },
  });
  const caixa = (conteudo: React.ReactNode) => <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-xl mx-auto mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-6">{conteudo}</div></main>;

  if (convite.isLoading) return <main className="min-h-screen grid place-items-center text-white"><Loader2 className="animate-spin"/></main>;
  if (convite.isError || !convite.data) return caixa(<ErroDeConsulta erro={convite.error} aoTentarDeNovo={() => convite.refetch()}/>);
  const dados = convite.data;
  if (!dados.valido) return caixa(<>
    <p role="alert" className="text-sm text-white/75">{t("meetings.participants.inviteInvalid")}</p>
    <button type="button" onClick={() => navigate(ROTA_DAS_REUNIOES)} className="mt-4 text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.allMeetings")}</button>
  </>);
  return caixa(<>
    <p className="inline-flex items-center gap-2 text-amber-300 text-xs font-semibold"><Users size={14} aria-hidden="true"/>{t("meetings.participants.inviteEyebrow")}</p>
    <h1 dir="auto" className="mt-2 text-2xl font-bold">{dados.titulo}</h1>
    <p className="mt-2 text-sm text-white/60">{t("meetings.participants.sharedBy", { nome: dados.nomeDaDona })}</p>
    {dados.propria
      ? <>
        <p className="mt-5 text-sm text-white/70">{t("meetings.participants.inviteOwn")}</p>
        <button type="button" onClick={() => navigate(rotaDaReuniao(dados.meetingId))} className="mt-4 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c]">{t("meetings.participants.openMeeting")}</button>
      </>
      : dados.jaParticipa
      ? <button type="button" onClick={() => navigate(rotaDaReuniaoCompartilhada(dados.meetingId))} className="mt-5 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c]">{t("meetings.participants.openMeeting")}</button>
      : <>
        <p className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100/85">{t("meetings.participants.inviteNotice")}</p>
        {aceitar.isError && <p role="alert" className="mt-3 text-sm text-red-200">{mensagemDeErroParaTela(aceitar.error, t)}</p>}
        <button type="button" disabled={aceitar.isPending} onClick={() => aceitar.mutate({ token })} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-60">
          {aceitar.isPending && <Loader2 size={15} className="animate-spin"/>}{t("meetings.participants.joinButton")}
        </button>
      </>}
  </>);
}
