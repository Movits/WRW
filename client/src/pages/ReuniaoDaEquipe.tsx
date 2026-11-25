import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "wouter";
import { Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { credencialDaParticipante } from "@shared/participantes-da-reuniao";
import { rotaDaEquipe } from "@shared/rotas";
import { LeituraDaReuniao } from "./ReuniaoAberta";

/**
 * A reunião da equipe, lida pela membra (R2): a mesma leitura da participante
 * (R1b), pela credencial "participante:<id>", que o servidor confere com a
 * sessão a cada leitura (a membra ativa da pasta em que a reunião está). Nada
 * aqui muda a reunião. O cabeçalho diz de que equipe ela é e volta à equipe.
 */
export default function ReuniaoDaEquipe() {
  const { pastaId = "", id = "" } = useParams<{ pastaId: string; id: string }>();
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const equipe = trpc.equipes.ver.useQuery({ pastaId }, { retry: false, refetchOnWindowFocus: false });
  const voltar = <button type="button" onClick={() => navigate(rotaDaEquipe(pastaId))} className="mt-4 inline-block text-sm font-semibold text-amber-300 hover:text-amber-200">{t("teams.backToTeam")}</button>;
  const cabecalho = <div className="mt-4 space-y-2">
    <p className="inline-flex items-center gap-2 text-sm text-white/60"><Users size={14} aria-hidden="true"/>
      <span dir="auto">{equipe.data ? t("teams.meetingOf", { nome: equipe.data.nome }) : t("teams.eyebrow")}</span>
    </p>
    <div>{voltar}</div>
  </div>;
  return <LeituraDaReuniao token={credencialDaParticipante(id)} cabecalhoDaParticipante={cabecalho}
    naoEncontrada={<div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
      <p className="text-sm text-white/75">{t("teams.meetingNotFound")}</p>
      {voltar}
    </div>}/>;
}
