import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "wouter";
import { Loader2, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { ROTA_DAS_REUNIOES, rotaDaEquipe } from "@shared/rotas";
import { rotuloDoPapel } from "./EquipeDaPasta";

/**
 * O convite para uma equipe (R2): /convite-da-equipe/{token}, só logada (a
 * rota manda ao login, que volta para cá). Mostra o nome da equipe, o nome da
 * dona, o papel e o aviso do que a membra aparece para as outras, e "Entrar
 * na equipe". O link vale uma vez. O convite que não existe, venceu ou já foi
 * usado tem uma frase só, sem nome nenhum. O aviso (teams.inviteNotice) espera
 * a revisão da Cris, nos 10 idiomas.
 */
export default function ConviteDaEquipe() {
  const { token = "" } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const convite = trpc.equipes.verConvite.useQuery({ token }, { retry: false, refetchOnWindowFocus: false });
  const aceitar = trpc.equipes.aceitarConvite.useMutation({
    onSuccess: async ({ pastaId }) => {
      await utils.equipes.minhas.invalidate();
      navigate(rotaDaEquipe(pastaId));
    },
  });
  const caixa = (conteudo: React.ReactNode) => <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-xl mx-auto mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-6">{conteudo}</div></main>;

  if (convite.isLoading) return <main className="min-h-screen grid place-items-center text-white"><Loader2 className="animate-spin"/></main>;
  if (convite.isError || !convite.data) return caixa(<ErroDeConsulta erro={convite.error} aoTentarDeNovo={() => convite.refetch()}/>);
  const dados = convite.data;
  if (!dados.valido) return caixa(<>
    <p role="alert" className="text-sm text-white/75">{t("teams.inviteInvalid")}</p>
    <button type="button" onClick={() => navigate(ROTA_DAS_REUNIOES)} className="mt-4 text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.allMeetings")}</button>
  </>);
  const abrir = <button type="button" onClick={() => navigate(rotaDaEquipe(dados.pastaId))} className="mt-5 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c]">{t("teams.openTeam")}</button>;
  return caixa(<>
    <p className="inline-flex items-center gap-2 text-amber-300 text-xs font-semibold"><Users size={14} aria-hidden="true"/>{t("teams.inviteEyebrow")}</p>
    <h1 dir="auto" className="mt-2 break-words text-2xl font-bold">{dados.nome}</h1>
    <p className="mt-2 text-sm text-white/60">{t("teams.ownerOf", { nome: dados.nomeDaDona })}</p>
    <p className="mt-1 text-sm text-white/60">{t("teams.inviteRoleIs", { papel: rotuloDoPapel(t, dados.papel) })}</p>
    {dados.propria
      ? <><p className="mt-5 text-sm text-white/70">{t("teams.inviteOwn")}</p>{abrir}</>
      : dados.jaEsta
      ? abrir
      : <>
        <p className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100/85">{t("teams.inviteNotice")}</p>
        {aceitar.isError && <p role="alert" className="mt-3 text-sm text-red-200">{mensagemDeErroParaTela(aceitar.error, t)}</p>}
        <button type="button" disabled={aceitar.isPending} onClick={() => aceitar.mutate({ token })} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-60">
          {aceitar.isPending && <Loader2 size={15} className="animate-spin"/>}{t("teams.joinButton")}
        </button>
      </>}
  </>);
}
