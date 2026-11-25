import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "wouter";
import { CalendarDays, ClipboardList, Copy, FileText, Link2, Loader2, LogOut, Mail, MessageCircle, Trash2, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { IconeDaPastaNaTela } from "@/components/PastasDeReunioes";
import { idiomaDaTela, linkDoEmail, linkDoWhatsApp } from "@/components/CompartilharReuniao";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { PAPEIS_DA_EQUIPE, RECUSAS_DA_EQUIPE, RESPONSAVEL_DA_TAREFA_MAX, TEXTO_DA_TAREFA_MAX, type PapelNaEquipe, type PapelDaEquipe } from "@shared/espacos-de-equipe";
import { ROTA_DAS_REUNIOES, rotaDaReuniao, rotaDaReuniaoDaEquipe, rotaDoConviteDaEquipe } from "@shared/rotas";

/**
 * O espaço de equipe (R2): a pasta da dona com membras, em quatro abas.
 * - Reuniões: as da pasta, prontas. A dona abre o detalhe dela; a membra, a
 *   leitura da participante (rotaDaReuniaoDaEquipe).
 * - Tarefas: a dona e as de papel "membro" escrevem; as leitoras só leem (o
 *   servidor confere o papel; a tela só esconde o que não vale).
 * - Agenda: as reuniões marcadas que a dona pôs na equipe, sem quem foi
 *   convidado. A dona escolhe da agenda dela.
 * - Membras: a dona convida (link de uso único ou conexão, com o papel), muda
 *   o papel, remove e cancela; a membra vê a dona e as membras ativas e sai.
 * Os textos que dizem quem vê o quê (intro, authorization, inviteNotice,
 * agendaHint) esperam a revisão da Cris, nos 10 idiomas.
 */

type Aba = "reunioes" | "tarefas" | "agenda" | "membras";

export function rotuloDoPapel(t: (chave: string) => string, papel: PapelNaEquipe) {
  return papel === "owner" ? t("teams.roleOwner") : papel === "member" ? t("teams.roleMember") : t("teams.roleReader");
}

/** A equipe que não abre (não existe, ou a conta não é dela) tem uma frase só. */
function naoAbre(erro: unknown) {
  return (erro as { message?: string } | null)?.message === RECUSAS_DA_EQUIPE.equipeNaoEncontrada;
}

export default function EquipeDaPasta() {
  const { pastaId = "" } = useParams<{ pastaId: string }>();
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const [aba, setAba] = useState<Aba>("reunioes");
  const equipe = trpc.equipes.ver.useQuery({ pastaId }, { retry: false, refetchOnWindowFocus: false });
  const moldura = (conteudo: React.ReactNode) => <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-4xl mx-auto">{conteudo}</div></main>;
  const voltar = <button type="button" onClick={() => navigate(ROTA_DAS_REUNIOES)} className="mt-4 text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.allMeetings")}</button>;

  if (equipe.isLoading) return moldura(<p role="status" className="py-20 text-center text-white/50"><Loader2 className="me-2 inline animate-spin"/>{t("teams.loading")}</p>);
  if (equipe.isError && naoAbre(equipe.error)) return moldura(<div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6"><p className="text-sm text-white/75">{t("teams.notFound")}</p>{voltar}</div>);
  if (equipe.isError || !equipe.data) return moldura(<ErroDeConsulta erro={equipe.error} aoTentarDeNovo={() => equipe.refetch()}/>);
  const dados = equipe.data;
  const abas: Array<[Aba, string, typeof FileText]> = [
    ["reunioes", t("teams.tabMeetings"), FileText], ["tarefas", t("teams.tabTasks"), ClipboardList],
    ["agenda", t("teams.tabAgenda"), CalendarDays], ["membras", t("teams.tabMembers"), Users],
  ];
  return moldura(<>
    <button type="button" onClick={() => navigate(ROTA_DAS_REUNIOES)} className="text-sm text-white/55 hover:text-white">{t("meetings.allMeetings")}</button>
    <p className="mt-4 text-xs font-semibold text-amber-300">{t("teams.eyebrow")}</p>
    <h1 className="mt-1 flex min-w-0 items-center gap-2 text-2xl font-bold">
      <IconeDaPastaNaTela icone={dados.icone} cor={dados.cor} tamanho={22}/>
      <span dir="auto" className="min-w-0 break-words">{dados.nome}</span>
    </h1>
    <p className="mt-2 text-sm text-white/55">
      {dados.papel === "owner" ? rotuloDoPapel(t, "owner") : <>{t("teams.ownerOf", { nome: dados.nomeDaDona })} · {rotuloDoPapel(t, dados.papel)}</>}
    </p>
    <div className="mt-6 flex gap-1 overflow-x-auto border-b border-white/10">{abas.map(([id, rotulo, Icone]) =>
      <button key={id} type="button" aria-pressed={aba === id} onClick={() => setAba(id)}
        className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm ${aba === id ? "border-amber-300 text-amber-300" : "border-transparent text-white/50"}`}><Icone size={16} aria-hidden="true"/>{rotulo}</button>)}</div>
    <div className="mt-5">
      {aba === "reunioes" && <ReunioesDaEquipe pastaId={pastaId} daDona={dados.papel === "owner"}/>}
      {aba === "tarefas" && <TarefasDaEquipe pastaId={pastaId}/>}
      {aba === "agenda" && <AgendaDaEquipe pastaId={pastaId} daDona={dados.papel === "owner"}/>}
      {aba === "membras" && (dados.papel === "owner"
        ? <MembrasParaADona pastaId={pastaId} nome={dados.nome} autorizado={dados.autorizado} membras={dados.membras}/>
        : <MembrasParaAMembra pastaId={pastaId} nomeDaDona={dados.nomeDaDona} membras={dados.membras}/>)}
    </div>
  </>);
}

function ReunioesDaEquipe({ pastaId, daDona }: { pastaId: string; daDona: boolean }) {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const reunioes = trpc.equipes.reunioes.useQuery({ pastaId }, { refetchOnWindowFocus: false });
  if (reunioes.isLoading) return <Loader2 className="animate-spin text-white/50"/>;
  if (reunioes.isError) return <ErroDeConsulta erro={reunioes.error} aoTentarDeNovo={() => reunioes.refetch()}/>;
  if (!reunioes.data?.length) return <p className="text-sm text-white/50">{t("teams.noMeetings")}</p>;
  return <ul className="space-y-2">{reunioes.data.map(reuniao => <li key={reuniao.id}>
    <button type="button" onClick={() => navigate(daDona ? rotaDaReuniao(reuniao.id) : rotaDaReuniaoDaEquipe(pastaId, reuniao.id))}
      className="w-full rounded-xl border border-white/10 bg-white/[0.035] p-3 text-start hover:bg-white/5">
      <p dir="auto" className="break-words font-medium">{reuniao.titulo}</p>
      <p className="text-xs text-white/50">{new Date(reuniao.criadaEm).toLocaleDateString(i18n.language)}</p>
    </button>
  </li>)}</ul>;
}

function TarefasDaEquipe({ pastaId }: { pastaId: string }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const tarefas = trpc.equipes.tarefas.useQuery({ pastaId }, { refetchOnWindowFocus: false });
  const [texto, setTexto] = useState("");
  const [responsavel, setResponsavel] = useState("");
  const [prazo, setPrazo] = useState("");
  const depois = () => utils.equipes.tarefas.invalidate({ pastaId });
  const avisar = (erro: unknown) => toast.error(mensagemDeErroParaTela(erro, t));
  const criar = trpc.equipes.criarTarefa.useMutation({ onSuccess: async () => { setTexto(""); setResponsavel(""); setPrazo(""); await depois(); }, onError: avisar });
  const marcar = trpc.equipes.marcarTarefa.useMutation({ onSuccess: depois, onError: avisar });
  const apagar = trpc.equipes.apagarTarefa.useMutation({ onSuccess: depois, onError: avisar });
  if (tarefas.isLoading) return <Loader2 className="animate-spin text-white/50"/>;
  if (tarefas.isError || !tarefas.data) return <ErroDeConsulta erro={tarefas.error} aoTentarDeNovo={() => tarefas.refetch()}/>;
  const { podeEscrever, tarefas: lista } = tarefas.data;
  const dataDoPrazo = (valor: string) => new Date(`${valor}T12:00:00`).toLocaleDateString(i18n.language);
  const campo = "min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white";
  return <div className="space-y-4">
    {podeEscrever
      ? <form className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.035] p-3 sm:grid-cols-[1fr_10rem_9rem_auto]"
        onSubmit={evento => { evento.preventDefault(); if (texto.trim()) criar.mutate({ pastaId, texto, responsavel, prazo: prazo || null }); }}>
        <input value={texto} maxLength={TEXTO_DA_TAREFA_MAX} onChange={evento => setTexto(evento.target.value)} placeholder={t("teams.taskText")} aria-label={t("teams.taskText")} className={campo}/>
        <input value={responsavel} maxLength={RESPONSAVEL_DA_TAREFA_MAX} onChange={evento => setResponsavel(evento.target.value)} placeholder={t("teams.taskResponsible")} aria-label={t("teams.taskResponsible")} className={campo}/>
        <input type="date" value={prazo} onChange={evento => setPrazo(evento.target.value)} aria-label={t("teams.taskDue")} className={campo}/>
        <button type="submit" disabled={criar.isPending || !texto.trim()} className="rounded-lg bg-[#c98f70] px-3 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-50">{t("teams.addTask")}</button>
      </form>
      : <p className="text-xs text-white/50">{t("teams.readOnlyTasks")}</p>}
    {!lista.length ? <p className="text-sm text-white/50">{t("teams.tasksEmpty")}</p>
      : <ul className="space-y-2">{lista.map(tarefa => <li key={tarefa.id} className="flex items-start gap-3 rounded-xl border border-white/10 px-3 py-2">
        <input type="checkbox" checked={tarefa.feita} disabled={!podeEscrever || marcar.isPending} aria-label={t("teams.taskDone")}
          onChange={evento => marcar.mutate({ pastaId, tarefaId: tarefa.id, feita: evento.target.checked })} className="mt-1"/>
        <div className="min-w-0 flex-1">
          <p dir="auto" className={`break-words text-sm ${tarefa.feita ? "text-white/40 line-through" : ""}`}>{tarefa.texto}</p>
          {(tarefa.responsavel || tarefa.prazo) && <p className="text-xs text-white/50">
            {tarefa.responsavel && <span dir="auto">{tarefa.responsavel}</span>}{tarefa.responsavel && tarefa.prazo && " · "}{tarefa.prazo && t("teams.dueOn", { data: dataDoPrazo(tarefa.prazo) })}
          </p>}
        </div>
        {podeEscrever && <button type="button" disabled={apagar.isPending} onClick={() => apagar.mutate({ pastaId, tarefaId: tarefa.id })} aria-label={t("teams.taskDelete")}
          className="rounded-lg border border-white/15 p-1.5 text-white/60 hover:bg-white/5 disabled:opacity-50"><Trash2 size={14} aria-hidden="true"/></button>}
      </li>)}</ul>}
  </div>;
}

function AgendaDaEquipe({ pastaId, daDona }: { pastaId: string; daDona: boolean }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const agenda = trpc.equipes.agenda.useQuery({ pastaId }, { refetchOnWindowFocus: false });
  const daAgendaDaDona = trpc.agenda.listar.useQuery(undefined, { enabled: daDona, refetchOnWindowFocus: false });
  const por = trpc.equipes.porNaAgenda.useMutation({
    onSuccess: async () => { await Promise.all([utils.equipes.agenda.invalidate({ pastaId }), utils.agenda.listar.invalidate()]); },
    onError: erro => toast.error(mensagemDeErroParaTela(erro, t)),
  });
  if (agenda.isLoading) return <Loader2 className="animate-spin text-white/50"/>;
  if (agenda.isError || !agenda.data) return <ErroDeConsulta erro={agenda.error} aoTentarDeNovo={() => agenda.refetch()}/>;
  const candidatas = (daAgendaDaDona.data?.proximas ?? []).filter(marcada => marcada.folderId !== pastaId);
  const quando = (inicio: number, fuso: string) => {
    try { return new Date(inicio).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: fuso }); }
    catch { return new Date(inicio).toLocaleString(i18n.language); }
  };
  return <div className="space-y-4">
    {daDona && <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
      <p className="text-xs text-white/55">{t("teams.agendaHint")}</p>
      <select aria-label={t("teams.agendaAdd")} disabled={por.isPending || !candidatas.length} value="" onChange={evento => { if (evento.target.value) por.mutate({ agendaId: evento.target.value, pastaId }); }}
        className="mt-2 w-full max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-2 text-sm text-white">
        <option value="">{candidatas.length ? t("teams.agendaAdd") : t("teams.agendaNothingToAdd")}</option>
        {candidatas.map(marcada => <option key={marcada.id} value={marcada.id}>{marcada.titulo} · {quando(marcada.inicioEm, marcada.fuso)}</option>)}
      </select>
    </div>}
    {!agenda.data.length ? <p className="text-sm text-white/50">{t("teams.agendaEmpty")}</p>
      : <ul className="space-y-2">{agenda.data.map(marcada => <li key={marcada.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-white/10 px-3 py-2">
        <div className="min-w-0">
          <p dir="auto" className="break-words text-sm font-medium">{marcada.titulo}</p>
          <p className="text-xs text-white/50">{quando(marcada.inicioEm, marcada.fuso)} · {t("teams.minutes", { n: marcada.duracaoMinutos })}</p>
          {marcada.local && <p dir="auto" className="break-all text-xs text-white/50">{marcada.local}</p>}
        </div>
        {daDona && <button type="button" disabled={por.isPending} onClick={() => por.mutate({ agendaId: marcada.id, pastaId: null })}
          className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70 disabled:opacity-50">{t("teams.agendaRemove")}</button>}
      </li>)}</ul>}
  </div>;
}

type MembraDaDona = { id: string; status: "invited" | "active"; origem: "link" | "connection"; papel: PapelDaEquipe; nome: string | null; expiraEm: number | null };

function MembrasParaADona({ pastaId, nome, autorizado, membras }: { pastaId: string; nome: string; autorizado: boolean; membras: MembraDaDona[] }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const [autorizou, setAutorizou] = useState(false);
  const [papel, setPapel] = useState<PapelDaEquipe>("member");
  const [linkNovo, setLinkNovo] = useState<string | null>(null);
  const [escolhendoConexao, setEscolhendoConexao] = useState(false);
  const campoDoLink = useRef<HTMLInputElement>(null);
  const conexoes = trpc.connections.list.useQuery(undefined, { enabled: escolhendoConexao, refetchOnWindowFocus: false });
  const depois = () => utils.equipes.ver.invalidate({ pastaId });
  const avisar = (erro: unknown) => toast.error(mensagemDeErroParaTela(erro, t));
  const autorizacao = () => (autorizado ? undefined : { idioma: idiomaDaTela(i18n), textoExibido: t("teams.authorization") });
  const criarConvite = trpc.equipes.criarConvite.useMutation({
    onSuccess: async ({ token }) => { setLinkNovo(`${window.location.origin}${rotaDoConviteDaEquipe(token)}`); await depois(); },
    onError: avisar,
  });
  const convidarConexao = trpc.equipes.convidarConexao.useMutation({
    onSuccess: async () => { setEscolhendoConexao(false); toast.success(t("teams.connectionInvited")); await depois(); },
    onError: avisar,
  });
  const remover = trpc.equipes.removerMembra.useMutation({ onSuccess: depois, onError: avisar });
  const cancelar = trpc.equipes.cancelarConvite.useMutation({ onSuccess: depois, onError: avisar });
  const mudar = trpc.equipes.mudarPapel.useMutation({ onSuccess: depois, onError: avisar });
  const precisaAutorizar = !autorizado;
  const conexoesAceitas = (conexoes.data ?? []).filter(c => c.status === "accepted" && c.outraParteId);
  const mensagem = t("teams.inviteMessage", { nome, link: linkNovo ?? "" });
  const seletor = "max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1.5 text-sm text-white";

  return <div className="space-y-5">
    <p className="text-sm text-white/60">{t("teams.intro")}</p>
    {precisaAutorizar && <label className="flex items-start gap-3 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100/85">
      <input type="checkbox" checked={autorizou} onChange={evento => setAutorizou(evento.target.checked)} className="mt-1"/>
      <span>{t("teams.authorization")}</span>
    </label>}
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-white/70">{t("teams.inviteRole")}
        <select value={papel} onChange={evento => setPapel(evento.target.value as PapelDaEquipe)} className={seletor}>
          {PAPEIS_DA_EQUIPE.map(opcao => <option key={opcao} value={opcao}>{rotuloDoPapel(t, opcao)}</option>)}
        </select>
      </label>
      <button type="button" disabled={(precisaAutorizar && !autorizou) || criarConvite.isPending} onClick={() => criarConvite.mutate({ pastaId, papel, autorizacao: autorizacao() })}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-3 py-2 text-sm font-bold text-[#1a120c] disabled:opacity-50"><Link2 size={15} aria-hidden="true"/>{t("teams.inviteByLink")}</button>
      <button type="button" disabled={precisaAutorizar && !autorizou} onClick={() => setEscolhendoConexao(aberto => !aberto)}
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 disabled:opacity-50"><UserPlus size={15} aria-hidden="true"/>{t("teams.inviteConnection")}</button>
    </div>
    <p className="text-xs text-white/45">{papel === "member" ? t("teams.roleMemberHint") : t("teams.roleReaderHint")}</p>
    {linkNovo && <div className="rounded-xl border border-white/10 bg-black/10 p-3">
      <p className="text-xs text-white/60">{t("teams.linkOnce")}</p>
      <input ref={campoDoLink} readOnly value={linkNovo} aria-label={t("teams.inviteByLink")} className="mt-2 w-full rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-xs text-white"/>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(linkNovo); toast.success(t("teams.copied")); } catch { campoDoLink.current?.select(); } }} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><Copy size={13} aria-hidden="true"/>{t("teams.copy")}</button>
        <a href={linkDoWhatsApp(mensagem)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><MessageCircle size={13} aria-hidden="true"/>WhatsApp</a>
        <a href={linkDoEmail(nome, mensagem)} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs"><Mail size={13} aria-hidden="true"/>{t("teams.email")}</a>
      </div>
    </div>}
    {escolhendoConexao && <div className="rounded-xl border border-white/10 bg-black/10 p-3">
      {conexoes.isLoading ? <Loader2 size={15} className="animate-spin"/> : conexoesAceitas.length === 0
        ? <p className="text-sm text-white/55">{t("teams.noConnections")}</p>
        : <ul className="space-y-1">{conexoesAceitas.map(conexao => <li key={conexao.id}>
          <button type="button" disabled={convidarConexao.isPending} onClick={() => convidarConexao.mutate({ pastaId, conexaoId: conexao.id, papel, autorizacao: autorizacao() })}
            className="w-full rounded-lg px-2 py-1.5 text-start text-sm hover:bg-white/5 disabled:opacity-50"><span dir="auto">{conexao.displayName || conexao.userName}</span></button>
        </li>)}</ul>}
    </div>}
    <ul className="space-y-2">{membras.length === 0
      ? <li className="text-sm text-white/45">{t("teams.noMembers")}</li>
      : membras.map(membra => <li key={membra.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 px-3 py-2">
        <div className="min-w-0">
          <p dir="auto" className="break-words text-sm">{membra.nome ?? t("teams.pendingLink")}</p>
          <p className="text-xs text-white/45">{membra.status === "active" ? t("teams.statusActive") : t("teams.statusInvited", { data: new Date(membra.expiraEm ?? 0).toLocaleDateString(i18n.language) })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t("teams.changeRole", { nome: membra.nome ?? t("teams.pendingLink") })} value={membra.papel} disabled={mudar.isPending}
            onChange={evento => mudar.mutate({ membraId: membra.id, papel: evento.target.value as PapelDaEquipe })} className={seletor}>
            {PAPEIS_DA_EQUIPE.map(opcao => <option key={opcao} value={opcao}>{rotuloDoPapel(t, opcao)}</option>)}
          </select>
          <button type="button" disabled={remover.isPending || cancelar.isPending}
            onClick={() => (membra.status === "active" ? remover : cancelar).mutate({ membraId: membra.id })}
            className="inline-flex items-center gap-1 rounded-lg border border-red-400/25 px-2 py-1 text-xs text-red-200 disabled:opacity-50">
            <X size={13} aria-hidden="true"/>{membra.status === "active" ? t("teams.remove") : t("teams.cancelInvite")}
          </button>
        </div>
      </li>)}</ul>
  </div>;
}

function MembrasParaAMembra({ pastaId, nomeDaDona, membras }: { pastaId: string; nomeDaDona: string; membras: Array<{ nome: string; papel: PapelDaEquipe; souEu: boolean }> }) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [confirmando, setConfirmando] = useState(false);
  const sair = trpc.equipes.sair.useMutation({
    onSuccess: async () => { toast.success(t("teams.leftToast")); await utils.equipes.minhas.invalidate(); navigate(ROTA_DAS_REUNIOES); },
    onError: erro => toast.error(mensagemDeErroParaTela(erro, t)),
  });
  return <div className="space-y-4">
    <ul className="space-y-2">
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 px-3 py-2"><span dir="auto" className="break-words text-sm">{nomeDaDona}</span><span className="text-xs text-white/50">{rotuloDoPapel(t, "owner")}</span></li>
      {membras.map((membra, indice) => <li key={indice} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 px-3 py-2">
        <span dir="auto" className="break-words text-sm">{membra.souEu ? t("teams.you", { nome: membra.nome }) : membra.nome}</span>
        <span className="text-xs text-white/50">{rotuloDoPapel(t, membra.papel)}</span>
      </li>)}
    </ul>
    {confirmando
      ? <div role="alertdialog" aria-labelledby="sair-da-equipe" className="rounded-xl border border-red-400/25 bg-red-400/5 p-4">
        <p id="sair-da-equipe" className="text-sm text-red-100/85">{t("teams.leaveConfirm")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={sair.isPending} onClick={() => sair.mutate({ pastaId })} className="rounded-lg bg-red-400/80 px-3 py-2 text-sm font-semibold text-[#1a120c] disabled:opacity-60">{t("teams.leave")}</button>
          <button type="button" onClick={() => setConfirmando(false)} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/70">{t("teams.cancel")}</button>
        </div>
      </div>
      : <button type="button" onClick={() => setConfirmando(true)} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 hover:bg-white/5"><LogOut size={14} aria-hidden="true"/>{t("teams.leave")}</button>}
  </div>;
}

