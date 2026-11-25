import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, Link2, Loader2, Mail, MessageCircle, Play, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { CONTA_DA_DONA } from "@shared/const";
import { rotaDoConvite } from "@shared/rotas";
import { idiomaDaTela, linkDoEmail, linkDoWhatsApp } from "./CompartilharReuniao";

/**
 * O painel "Participantes" da dona (R1b e H3c, desenho de 16/11/2026):
 * - convidar por um link de uso único (vale 7 dias, para uma pessoa) ou uma
 *   das conexões aceitas dela; a primeira vez na reunião pede a confirmação de
 *   que as pessoas que falaram autorizaram (a prova vai para a auditoria);
 * - a lista: quem participa, os convites pendentes, remover e cancelar;
 * - "Quem é cada voz": para cada voz {Fn}, a conta de quem falou (ela mesma ou
 *   uma participante; o nome da conta vira o nome da voz), um nome livre ou
 *   "Falante n", e "Juntar com..." (F3 é a mesma pessoa que F1), com o ▶ que
 *   toca a primeira fala de cada voz.
 * Os textos que dizem quem vê o quê (intro, authorization, voiceHint,
 * inviteNotice) esperam a revisão da Cris, nos 10 idiomas.
 */

type Fala = { falante: string; inicio: number };

/** As vozes na ordem em que falam pela primeira vez, com o segundo da primeira fala. */
export function vozesDaReuniao(falas: readonly Fala[]): Array<{ voz: string; inicio: number }> {
  const vistas = new Map<string, number>();
  for (const fala of falas) if (!vistas.has(fala.falante)) vistas.set(fala.falante, fala.inicio);
  return Array.from(vistas, ([voz, inicio]) => ({ voz, inicio }));
}

const numero = (voz: string) => Number(voz.replace(/^F/, "")) || 0;

type Props = {
  meetingId: string;
  titulo: string;
  falas: readonly Fala[];
  /** Os nomes das vozes como a dona os vê (com as contas ligadas), sem as juntadas. */
  nomes: Readonly<Record<string, string>>;
  /** Os nomes livres (H3), os que a dona digitou. */
  nomesLivres: Readonly<Record<string, string>>;
  /** A conta ligada a cada voz: "owner" ou o id da participação. */
  contas: Readonly<Record<string, string>>;
  juntadas: Readonly<Record<string, string>>;
  /** O ▶ de cada voz: toca a partir da primeira fala dela. Sem player, não aparece. */
  aoOuvir?: (segundo: number) => void;
};

export function ParticipantesDaReuniao(props: Props) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  // O painel fechado não consulta nada: as participantes, as conexões e as
  // mutações só existem com ele aberto.
  return <section className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
    <button type="button" aria-expanded={aberto} onClick={() => setAberto(a => !a)} className="flex w-full items-center justify-between gap-3 text-start">
      <span className="inline-flex items-center gap-2 font-semibold"><Users size={17} aria-hidden="true"/>{t("meetings.participants.heading")}</span>
      <ChevronDown size={17} aria-hidden="true" className={aberto ? "rotate-180" : ""}/>
    </button>
    {aberto && <PainelAberto {...props}/>}
  </section>;
}

function PainelAberto({ meetingId, titulo, falas, nomes, nomesLivres, contas, juntadas, aoOuvir }: Props) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const [autorizou, setAutorizou] = useState(false);
  const [linkNovo, setLinkNovo] = useState<string | null>(null);
  const [escolhendoConexao, setEscolhendoConexao] = useState(false);
  const [nomeLivre, setNomeLivre] = useState<{ voz: string; nome: string } | null>(null);
  const campoDoLink = useRef<HTMLInputElement>(null);
  const painel = trpc.meetings.participantes.useQuery({ meetingId }, { refetchOnWindowFocus: false });
  const conexoes = trpc.connections.list.useQuery(undefined, { enabled: escolhendoConexao, refetchOnWindowFocus: false });
  const dados = painel.data?.papel === "dona" ? painel.data : null;
  const autorizacao = () => (dados?.autorizado ? undefined : { idioma: idiomaDaTela(i18n), textoExibido: t("meetings.participants.authorization") });
  const depois = async () => { await Promise.all([utils.meetings.participantes.invalidate({ meetingId }), utils.meetings.get.invalidate({ meetingId })]); };
  const avisarErro = (erro: unknown) => toast.error(mensagemDeErroParaTela(erro, t));
  const criarConvite = trpc.meetings.criarConvite.useMutation({
    onSuccess: async ({ token }) => { setLinkNovo(`${window.location.origin}${rotaDoConvite(token)}`); await depois(); },
    onError: avisarErro,
  });
  const convidarConexao = trpc.meetings.convidarConexao.useMutation({
    onSuccess: async () => { setEscolhendoConexao(false); toast.success(t("meetings.participants.connectionInvited")); await depois(); },
    onError: avisarErro,
  });
  const remover = trpc.meetings.removerParticipante.useMutation({ onSuccess: depois, onError: avisarErro });
  const ligar = trpc.meetings.ligarVozAConta.useMutation({ onSuccess: depois, onError: avisarErro });
  const nomear = trpc.meetings.nomearFalante.useMutation({ onSuccess: async () => { setNomeLivre(null); await depois(); }, onError: avisarErro });
  const juntar = trpc.meetings.juntarVozes.useMutation({ onSuccess: depois, onError: avisarErro });
  const separar = trpc.meetings.separarVoz.useMutation({ onSuccess: depois, onError: avisarErro });
  const ocupado = ligar.isPending || nomear.isPending || juntar.isPending || separar.isPending;

  const ativas = (dados?.participantes ?? []).filter(p => p.status === "active" && p.nome);
  const vozes = useMemo(() => vozesDaReuniao(falas), [falas]);
  const rotulo = (voz: string) => nomes[voz] || t("meetings.speakerLabel", { n: numero(voz) });
  const precisaAutorizar = !!dados && !dados.autorizado;
  const conexoesAceitas = (conexoes.data ?? []).filter(c => c.status === "accepted" && c.outraParteId);
  const mensagem = t("meetings.participants.inviteMessage", { titulo, link: linkNovo ?? "" });

  // O valor do seletor da voz: a conta ligada, o nome livre ou "Falante n".
  const valorDaVoz = (voz: string) => contas[voz] ?? (nomesLivres[voz] ? "livre" : "");
  const escolher = (voz: string, valor: string) => {
    if (valor === "livre") { setNomeLivre({ voz, nome: nomesLivres[voz] ?? "" }); return; }
    setNomeLivre(null);
    if (valor === "") {
      if (contas[voz]) ligar.mutate({ meetingId, falante: voz, conta: null });
      if (nomesLivres[voz]) nomear.mutate({ meetingId, falante: voz, nome: "" });
      return;
    }
    ligar.mutate({ meetingId, falante: voz, conta: valor });
  };

  return <div className="mt-4 space-y-5">
      <p className="text-sm text-white/60">{t("meetings.participants.intro")}</p>
      {painel.isLoading && <p role="status" className="text-sm text-white/50"><Loader2 size={15} className="inline animate-spin me-2"/>{t("meetings.participants.loading")}</p>}
      {painel.isError && <p role="alert" className="text-sm text-red-200">{mensagemDeErroParaTela(painel.error, t)}</p>}
      {dados && <>
        {precisaAutorizar && <label className="flex items-start gap-3 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100/85">
          <input type="checkbox" checked={autorizou} onChange={evento => setAutorizou(evento.target.checked)} className="mt-1"/>
          <span>{t("meetings.participants.authorization")}</span>
        </label>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={(precisaAutorizar && !autorizou) || criarConvite.isPending} onClick={() => criarConvite.mutate({ meetingId, autorizacao: autorizacao() })}
            className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-3 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-50"><Link2 size={15} aria-hidden="true"/>{t("meetings.participants.inviteByLink")}</button>
          <button type="button" disabled={precisaAutorizar && !autorizou} onClick={() => setEscolhendoConexao(e => !e)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 disabled:opacity-50"><UserPlus size={15} aria-hidden="true"/>{t("meetings.participants.inviteConnection")}</button>
        </div>
        {linkNovo && <div className="rounded-xl border border-white/10 bg-black/10 p-3">
          <p className="text-xs text-white/60">{t("meetings.participants.linkOnce")}</p>
          <input ref={campoDoLink} readOnly value={linkNovo} aria-label={t("meetings.participants.inviteByLink")} className="mt-2 w-full rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-xs text-white"/>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(linkNovo); toast.success(t("meetings.participants.copied")); } catch { campoDoLink.current?.select(); } }} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><Copy size={13} aria-hidden="true"/>{t("meetings.participants.copy")}</button>
            <a href={linkDoWhatsApp(mensagem)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><MessageCircle size={13} aria-hidden="true"/>WhatsApp</a>
            <a href={linkDoEmail(titulo, mensagem)} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><Mail size={13} aria-hidden="true"/>{t("meetings.participants.email")}</a>
          </div>
        </div>}
        {escolhendoConexao && <div className="rounded-xl border border-white/10 bg-black/10 p-3">
          {conexoes.isLoading ? <Loader2 size={15} className="animate-spin"/> : conexoesAceitas.length === 0
            ? <p className="text-sm text-white/55">{t("meetings.participants.noConnections")}</p>
            : <ul className="space-y-1">{conexoesAceitas.map(conexao => <li key={conexao.id}>
              <button type="button" disabled={convidarConexao.isPending} onClick={() => convidarConexao.mutate({ meetingId, conexaoId: conexao.id, autorizacao: autorizacao() })}
                className="w-full rounded-lg px-2 py-1.5 text-start text-sm hover:bg-white/5 disabled:opacity-50"><span dir="auto">{conexao.displayName || conexao.userName}</span></button>
            </li>)}</ul>}
        </div>}
        <ul className="space-y-2">{dados.participantes.length === 0
          ? <li className="text-sm text-white/45">{t("meetings.participants.none")}</li>
          : dados.participantes.map(p => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 px-3 py-2">
            <div className="min-w-0">
              <p dir="auto" className="truncate text-sm">{p.nome ?? t("meetings.participants.pendingLink")}</p>
              <p className="text-xs text-white/45">{p.status === "active" ? t("meetings.participants.statusActive") : t("meetings.participants.statusInvited", { data: new Date(p.expiraEm ?? 0).toLocaleDateString(i18n.language) })}</p>
            </div>
            <button type="button" disabled={remover.isPending} onClick={() => remover.mutate({ participanteId: p.id })} className="inline-flex items-center gap-1 rounded-lg border border-red-400/25 px-2 py-1 text-xs text-red-200 disabled:opacity-50">
              <X size={13} aria-hidden="true"/>{p.status === "active" ? t("meetings.participants.remove") : t("meetings.participants.cancelInvite")}
            </button>
          </li>)}</ul>

        {vozes.length > 0 && <div>
          <h3 className="text-sm font-semibold">{t("meetings.participants.voicesHeading")}</h3>
          <p className="mt-1 text-xs text-white/50">{t("meetings.participants.voiceHint")}</p>
          <ul className="mt-3 space-y-3">{vozes.map(({ voz, inicio }) => {
            const principal = juntadas[voz];
            return <li key={voz} className="rounded-xl border border-white/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {aoOuvir && <button type="button" onClick={() => aoOuvir(inicio)} aria-label={t("meetings.participants.playVoice", { voz: t("meetings.speakerLabel", { n: numero(voz) }) })} className="rounded-full border border-white/15 p-1.5"><Play size={12} aria-hidden="true"/></button>}
                <span className="text-sm font-medium">{t("meetings.speakerLabel", { n: numero(voz) })}</span>
                {principal
                  ? <>
                    <span dir="auto" className="text-xs text-white/60">{t("meetings.participants.mergedWith", { nome: rotulo(principal) })}</span>
                    <button type="button" disabled={ocupado} onClick={() => separar.mutate({ meetingId, voz })} className="rounded-lg border border-white/15 px-2 py-1 text-xs disabled:opacity-50">{t("meetings.participants.split")}</button>
                  </>
                  : <>
                    <select aria-label={t("meetings.participants.whoIsVoice", { voz: t("meetings.speakerLabel", { n: numero(voz) }) })} disabled={ocupado} value={nomeLivre?.voz === voz ? "livre" : valorDaVoz(voz)} onChange={evento => escolher(voz, evento.target.value)}
                      className="max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1 text-xs text-white">
                      <option value="">{t("meetings.speakerLabel", { n: numero(voz) })}</option>
                      <option value={CONTA_DA_DONA}>{t("meetings.participants.voiceMe")}</option>
                      {ativas.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
                      <option value="livre">{t("meetings.participants.voiceOther")}</option>
                    </select>
                    <select aria-label={t("meetings.participants.mergeWith")} disabled={ocupado} value="" onChange={evento => { if (evento.target.value) juntar.mutate({ meetingId, voz, principal: evento.target.value }); }}
                      className="max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1 text-xs text-white">
                      <option value="">{t("meetings.participants.mergeWith")}</option>
                      {vozes.filter(outra => outra.voz !== voz && !juntadas[outra.voz]).map(outra => <option key={outra.voz} value={outra.voz}>{rotulo(outra.voz)}</option>)}
                    </select>
                  </>}
              </div>
              {nomeLivre?.voz === voz && <form className="mt-2 flex flex-wrap gap-2" onSubmit={evento => { evento.preventDefault(); if (nomeLivre.nome.trim()) nomear.mutate({ meetingId, falante: voz, nome: nomeLivre.nome }); }}>
                <input autoFocus maxLength={60} value={nomeLivre.nome} onChange={evento => setNomeLivre({ voz, nome: evento.target.value })} aria-label={t("meetings.participants.voiceOther")}
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1 text-sm text-white"/>
                <button type="submit" disabled={nomear.isPending || !nomeLivre.nome.trim()} className="rounded-lg bg-[#c98f70] px-3 py-1 text-xs font-bold text-[#1a120c] disabled:opacity-50">{t("meetings.participants.save")}</button>
              </form>}
            </li>;
          })}</ul>
        </div>}
      </>}
    </div>;
}
