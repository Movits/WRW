import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import type { inferRouterOutputs } from "@trpc/server";
import { AlertTriangle, CalendarCheck, CalendarDays, CalendarPlus, Download, FileText, Loader2, Mail, MessageCircle, Mic, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  DURACAO_PADRAO,
  DURACOES_DA_TELA,
  ehLinkDaChamada,
  emailDoParticipanteValido,
  fusoDoAparelho,
  LEMBRETE_PADRAO,
  LEMBRETES_DA_AGENDA,
  LOCAL_DA_AGENDADA_MAX,
  NOME_DO_PARTICIPANTE_MAX,
  EMAIL_DO_PARTICIPANTE_MAX,
  PARTICIPANTES_DA_AGENDADA_MAX,
} from "@shared/agenda";
import { montarIcs, nomeDoArquivoIcs, revisaoDoIcs } from "@shared/agenda-ics";
import { linkDaGoogleAgenda, quandoDaReuniao } from "@shared/agenda-links";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import { ROTA_DO_PERFIL } from "@shared/google-agenda";
import type { MotivoSemGoogle, ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { ROTA_DAS_REUNIOES, rotaDaReuniao, rotaGravarDaAgenda } from "@shared/rotas";
import { conviteDaReuniao } from "@/lib/convite-da-agenda";
import { baixarIcsOuAvisar } from "@/components/AcaoNaAgenda";

/**
 * A agenda de reuniões (H16a do plano do gravador): a dona marca a reunião,
 * convida as pessoas pelo WhatsApp ou pelo e-mail (abertos no app dela, com a
 * mensagem pronta), põe na Google Agenda ou baixa o .ics, feito aqui no
 * navegador, e, na hora, toca em "Gravar agora": o gravador abre com o título
 * preenchido, e a gravação fica ligada à reunião marcada.
 *
 * A data e a hora do formulário são as do aparelho, e o fuso dele vai junto.
 * Os cartões mostram a hora no fuso em que a reunião foi marcada, com o nome do
 * fuso. Falha na leitura da agenda é erro na tela (ErroDeConsulta), nunca
 * "nenhuma reunião".
 *
 * Com a Google Agenda conectada no Perfil (H16c), marcar, mudar e excluir
 * também criam, mudam e tiram o evento lá, e o cartão diz se a reunião está na
 * Google Agenda da dona, com "Tentar de novo" quando não está. No lugar do link
 * "Google Agenda" da H16a, que criaria o evento em dobro, fica esse estado. O
 * formulário ganha "A Google manda o convite pela sua conta", desmarcado.
 */

type ReuniaoDaAgenda = inferRouterOutputs<AppRouter>["agenda"]["listar"]["proximas"][number];
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** O código tRPC decide a frase: as mensagens do servidor vêm em português. */
export function mensagemDoErroDaAgenda(t: TranslateFn, erro: unknown): string {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "NOT_FOUND": return t("agenda.errors.notFound");
    case "BAD_REQUEST": return t("agenda.errors.invalid");
    case "PRECONDITION_FAILED": return t("agenda.errors.full");
    case "CONFLICT": return t("agenda.errors.conflict");
    default: return mensagemDeErroParaTela(erro, t);
  }
}

// Cada ramo chama t() com a chave literal, para o teste de chaves usadas conferir que todas existem.
/** Por que a reunião não foi para a Google Agenda (ou não saiu dela), no idioma da tela. */
export function motivoSemGoogleNaTela(t: TranslateFn, motivo: MotivoSemGoogle): string {
  switch (motivo) {
    case "nao-conectada": return t("agenda.google.reason.notConnected");
    case "revogada": return t("agenda.google.reason.revoked");
    case "google": return t("agenda.google.reason.google");
  }
}

/** O erro do "Tentar de novo" de tirar da Google: a reunião que ainda está na agenda tem frase própria. */
export function mensagemDoErroDeTirarDaGoogle(t: TranslateFn, erro: unknown): string {
  if ((erro as { data?: { code?: string } } | null)?.data?.code === "CONFLICT") return t("agenda.google.errors.stillInAgenda");
  return mensagemDoErroDaAgenda(t, erro);
}

/** "15 min", "1 h", "1 h 30 min", no idioma de quem lê. */
export function rotuloDaDuracao(minutos: number, idioma: string): string {
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  const formatar = (valor: number, unidade: "hour" | "minute") => {
    try {
      return new Intl.NumberFormat(idioma, { style: "unit", unit: unidade, unitDisplay: "short" }).format(valor);
    } catch {
      return `${valor} ${unidade === "hour" ? "h" : "min"}`;
    }
  };
  if (!horas) return formatar(resto, "minute");
  if (!resto) return formatar(horas, "hour");
  return `${formatar(horas, "hour")} ${formatar(resto, "minute")}`;
}

// Cada ramo chama t() com a chave literal, para o teste de chaves usadas conferir que todas existem.
export function rotuloDoLembrete(t: TranslateFn, minutos: number | null): string {
  switch (minutos) {
    case null: return t("agenda.reminder.none");
    case 0: return t("agenda.reminder.atStart");
    case 5: return t("agenda.reminder.m5");
    case 10: return t("agenda.reminder.m10");
    case 15: return t("agenda.reminder.m15");
    case 30: return t("agenda.reminder.m30");
    case 60: return t("agenda.reminder.h1");
    case 120: return t("agenda.reminder.h2");
    case 1440: return t("agenda.reminder.d1");
    default: return `${minutos} min`;
  }
}

function rotuloDaGravacao(t: TranslateFn, status: string): string {
  switch (status) {
    case "ready": return t("meetings.statusReady");
    case "processing": return t("meetings.statusProcessing");
    case "failed": return t("meetings.statusFailed");
    case "uploading": return t("meetings.statusUploading");
    case "recording": return t("meetings.statusRecording");
    default: return t("meetings.statusDraft");
  }
}

const doisDigitos = (n: number) => String(n).padStart(2, "0");

type Formulario = {
  titulo: string;
  /** AAAA-MM-DD e HH:MM, na hora do aparelho (os campos nativos de data e hora). */
  data: string;
  hora: string;
  duracaoMinutos: number;
  local: string;
  participantes: Array<{ nome: string; email: string }>;
  /** "" é sem lembrete. */
  lembrete: string;
  /** "A Google manda o convite pela sua conta" (H16c): desmarcado por padrão. */
  googleConvites: boolean;
};

/** A próxima hora cheia, hoje (ou amanhã, perto da meia-noite). */
function formularioNovo(agora = new Date()): Formulario {
  const inicio = new Date(agora);
  inicio.setMinutes(0, 0, 0);
  inicio.setHours(inicio.getHours() + 1);
  return {
    titulo: "",
    data: `${inicio.getFullYear()}-${doisDigitos(inicio.getMonth() + 1)}-${doisDigitos(inicio.getDate())}`,
    hora: `${doisDigitos(inicio.getHours())}:${doisDigitos(inicio.getMinutes())}`,
    duracaoMinutos: DURACAO_PADRAO,
    local: "",
    participantes: [],
    lembrete: String(LEMBRETE_PADRAO),
    googleConvites: false,
  };
}

function formularioDe(reuniao: ReuniaoDaAgenda): Formulario {
  const inicio = new Date(reuniao.inicioEm);
  return {
    titulo: reuniao.titulo,
    data: `${inicio.getFullYear()}-${doisDigitos(inicio.getMonth() + 1)}-${doisDigitos(inicio.getDate())}`,
    hora: `${doisDigitos(inicio.getHours())}:${doisDigitos(inicio.getMinutes())}`,
    duracaoMinutos: reuniao.duracaoMinutos,
    local: reuniao.local ?? "",
    participantes: reuniao.participantes.map(p => ({ nome: p.nome ?? "", email: p.email ?? "" })),
    lembrete: reuniao.lembreteMinutos === null ? "" : String(reuniao.lembreteMinutos),
    googleConvites: reuniao.googleConvites === true,
  };
}

/**
 * O formulário vira a entrada do servidor, ou a frase do que falta. A data e a
 * hora são lidas na hora do aparelho; o fuso dele vai junto. As linhas de
 * participante vazias saem. O e-mail passa pela regra do servidor
 * (emailDoParticipanteValido): o que ele recusaria aparece aqui, com o número
 * do participante.
 */
export function entradaDoFormulario(formulario: Formulario, t: TranslateFn, fuso: string = fusoDoAparelho()) {
  const titulo = formulario.titulo.trim();
  if (!titulo) return { erro: t("agenda.form.titleRequired") } as const;
  if (titulo.length < TITULO_DA_REUNIAO_MIN || titulo.length > TITULO_DA_REUNIAO_MAX) {
    return { erro: t("agenda.form.titleLength", { min: TITULO_DA_REUNIAO_MIN, max: TITULO_DA_REUNIAO_MAX }) } as const;
  }
  const [ano, mes, dia] = formulario.data.split("-").map(Number);
  const [horas, minutos] = formulario.hora.split(":").map(Number);
  const inicio = new Date(ano, (mes ?? 1) - 1, dia, horas, minutos).getTime();
  if (!formulario.data || !formulario.hora || !Number.isFinite(inicio)) return { erro: t("agenda.form.whenRequired") } as const;
  const participantes = formulario.participantes
    .map(p => ({ nome: p.nome.trim(), email: p.email.trim() }))
    .filter(p => p.nome || p.email);
  if (participantes.length > PARTICIPANTES_DA_AGENDADA_MAX) {
    return { erro: t("agenda.form.tooManyParticipants", { max: PARTICIPANTES_DA_AGENDADA_MAX }) } as const;
  }
  const comEmailRuim = participantes.findIndex(p => p.email && !emailDoParticipanteValido(p.email));
  if (comEmailRuim >= 0) return { erro: t("agenda.form.emailInvalid", { position: comEmailRuim + 1 }) } as const;
  return {
    entrada: {
      titulo,
      inicioEm: inicio,
      duracaoMinutos: formulario.duracaoMinutos,
      fuso,
      local: formulario.local.trim() || null,
      participantes: participantes.map(p => ({ nome: p.nome || null, email: p.email || null })),
      lembreteMinutos: formulario.lembrete === "" ? null : Number(formulario.lembrete),
      googleConvites: formulario.googleConvites === true,
    },
  } as const;
}

/**
 * O .ics, feito aqui: nada vai ao servidor. A reunião mudada sai com o mesmo
 * UID e o SEQUENCE maior: o calendário que já a tem troca pela versão nova.
 * Dentro do app das lojas não baixa: um aviso manda ao navegador
 * (baixarIcsOuAvisar, em components/AcaoNaAgenda.tsx).
 */
function baixarIcs(reuniao: ReuniaoDaAgenda, t: (chave: string) => string) {
  const conteudo = montarIcs({
    uid: `${reuniao.id}@wrwglobal.org`,
    titulo: reuniao.titulo,
    inicioMs: reuniao.inicioEm,
    duracaoMinutos: reuniao.duracaoMinutos,
    local: reuniao.local,
    lembreteMinutos: reuniao.lembreteMinutos,
    revisao: revisaoDoIcs(reuniao.createdAt, reuniao.updatedAt),
    modificadoEmMs: reuniao.updatedAt,
  });
  baixarIcsOuAvisar(conteudo, nomeDoArquivoIcs(reuniao.titulo), t);
}

export default function Agenda() {
  const { t, i18n } = useTranslation();
  const idioma = i18n.resolvedLanguage ?? i18n.language;
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const consulta = trpc.agenda.listar.useQuery();
  // A mesma consulta da seção do Perfil (H16b): a agenda só fala da Google
  // quando a dona a conectou. As mesmas opções, para as duas telas dividirem o cache.
  const estadoGoogle = trpc.googleAgenda.estado.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const google = estadoGoogle.data;
  const googleLigada = google?.disponivel === true && google.conectada === true;
  const googleQuebrada = google?.disponivel === true && google.conectada === true && Boolean(google.falha);
  // Só com a resposta "não conectada" o link de criar evento da H16a aparece:
  // carregando ou com a consulta em erro, ele criaria o evento em dobro na
  // agenda de quem está conectada.
  const googleDesligada = Boolean(google) && !googleLigada;
  // null: formulário fechado; com id: editando aquela reunião.
  const [formulario, setFormulario] = useState<{ id: string | null; valores: Formulario } | null>(null);
  const topo = useRef<HTMLDivElement>(null);
  // O "agora" dos cartões ("acontecendo agora"), a cada minuto.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const relogio = window.setInterval(() => setAgora(Date.now()), 60_000);
    return () => window.clearInterval(relogio);
  }, []);

  // A conexão que a Google recusou (revogada) ou que saiu em outra aba (não
  // conectada): o estado guardado da consulta ficou velho, e o aviso do topo,
  // com "Abrir o Perfil", e o formulário dependem dele. A consulta não relê
  // sozinha ao voltar à aba (refetchOnWindowFocus falso), então relê aqui.
  const releAConexaoSeMudou = (resultado: ResultadoNaGoogle | undefined) => {
    if (resultado?.naGoogle === "falhou" && (resultado.motivo === "revogada" || resultado.motivo === "nao-conectada")) {
      void utils.googleAgenda.estado.invalidate();
    }
  };
  // O que a dona salvou está salvo; a falha da Google vem num aviso à parte,
  // com o porquê, e o cartão mostra "Tentar de novo".
  const avisarSeNaoFoi = (resultado: ResultadoNaGoogle | undefined) => {
    if (resultado?.naGoogle === "falhou") toast.warning(`${t("agenda.google.toast.notSent")} ${motivoSemGoogleNaTela(t, resultado.motivo)}`, { duration: 10_000 });
    releAConexaoSeMudou(resultado);
  };
  const aoSalvar = (mensagem: string, resultado?: ResultadoNaGoogle) => {
    toast.success(mensagem);
    avisarSeNaoFoi(resultado);
    setFormulario(null);
    void utils.agenda.listar.invalidate();
  };
  const criar = trpc.agenda.criar.useMutation({
    onSuccess: resultado => aoSalvar(t("agenda.toast.created"), resultado),
    onError: erro => toast.error(mensagemDoErroDaAgenda(t, erro)),
  });
  const atualizar = trpc.agenda.atualizar.useMutation({
    onSuccess: resultado => aoSalvar(t("agenda.toast.updated"), resultado),
    onError: erro => toast.error(mensagemDoErroDaAgenda(t, erro)),
  });
  const tirarDaGoogle = trpc.agenda.tirarDaGoogle.useMutation({
    onSuccess: resultado => {
      if (resultado.naGoogle === "falhou") avisarQueFicouNaGoogle(resultado.motivo);
      else toast.success(t("agenda.google.toast.removed"));
      releAConexaoSeMudou(resultado);
    },
    onError: erro => toast.error(mensagemDoErroDeTirarDaGoogle(t, erro)),
  });
  // A reunião saiu da WRW, e o evento ficou na Google: o "Tentar de novo" vai
  // no próprio aviso, porque o cartão já sumiu. Quando só reconectar resolve,
  // o aviso diz para apagar por lá.
  function avisarQueFicouNaGoogle(motivo: MotivoSemGoogle, novaTentativa?: () => void) {
    const texto = `${t("agenda.google.toast.notRemoved")} ${motivo === "google" ? motivoSemGoogleNaTela(t, motivo) : t("agenda.google.toast.removeThere")}`;
    if (motivo === "google" && novaTentativa) toast.warning(texto, { duration: 15_000, action: { label: t("agenda.google.retry"), onClick: novaTentativa } });
    else toast.warning(texto, { duration: 15_000 });
  }
  const excluir = trpc.agenda.excluir.useMutation({
    onSuccess: (resultado, variaveis) => {
      toast.success(t("agenda.toast.deleted"));
      if (resultado.naGoogle === "falhou") {
        const { avisarConvidados } = resultado;
        avisarQueFicouNaGoogle(resultado.motivo, () => tirarDaGoogle.mutate({ id: variaveis.id, avisarConvidados }));
      }
      releAConexaoSeMudou(resultado);
      void utils.agenda.listar.invalidate();
    },
    onError: erro => {
      toast.error(mensagemDoErroDaAgenda(t, erro));
      void utils.agenda.listar.invalidate();
    },
  });
  // "Tentar de novo" e "Pôr na Google Agenda" no cartão. A reunião que já
  // acabou e não está na Google fica só na WRW: o servidor não a cria lá, e a
  // resposta é nula.
  const mandarParaGoogle = trpc.agenda.mandarParaGoogle.useMutation({
    onSuccess: resultado => {
      if (resultado.naGoogle === "falhou") toast.warning(`${t("agenda.google.toast.notSent")} ${motivoSemGoogleNaTela(t, resultado.motivo)}`, { duration: 10_000 });
      else if (resultado.naGoogle === null) toast.info(t("agenda.google.toast.pastNotSent"));
      else toast.success(t("agenda.google.toast.sent"));
      releAConexaoSeMudou(resultado);
      void utils.agenda.listar.invalidate();
    },
    onError: erro => {
      toast.error(mensagemDoErroDaAgenda(t, erro));
      void utils.agenda.listar.invalidate();
    },
  });

  function abrir(valores: Formulario, id: string | null) {
    setFormulario({ id, valores });
    // O formulário abre no topo: no celular, o cartão editado pode estar longe dele.
    window.setTimeout(() => topo.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  }

  function salvar(valores: Formulario, id: string | null) {
    const resultado = entradaDoFormulario(valores, t);
    if ("erro" in resultado) return toast.error(resultado.erro);
    if (id) atualizar.mutate({ ...resultado.entrada, id });
    else criar.mutate(resultado.entrada);
  }

  // A lista de Reuniões entra no histórico antes do gravador, como quando a dona
  // abre o gravador pela lista. Com a agenda logo atrás, o voltar do navegador
  // (o gesto do celular) no meio da gravação caía em /agenda, que desmonta o
  // gravador e descarta o áudio sem aviso; caindo em /meetings, a mesma página
  // devolve a dona ao gravador e avisa (Meetings.tsx). As duas trocas vão no
  // mesmo toque, e a tela só desenha a última.
  function gravar(id: string) {
    navigate(ROTA_DAS_REUNIOES);
    navigate(rotaGravarDaAgenda(id));
  }

  const dados = consulta.data;
  const salvando = criar.isPending || atualizar.isPending;
  const cartao = (reuniao: ReuniaoDaAgenda) => <CartaoDaAgendada key={reuniao.id} reuniao={reuniao} agora={agora} idioma={idioma}
    googleLigada={googleLigada}
    googleDesligada={googleDesligada}
    aoGravar={() => gravar(reuniao.id)}
    aoAbrirGravacao={id => navigate(rotaDaReuniao(id))}
    aoEditar={() => abrir(formularioDe(reuniao), reuniao.id)}
    aoExcluir={() => excluir.mutate({ id: reuniao.id })}
    aoMandarParaGoogle={() => mandarParaGoogle.mutate({ id: reuniao.id })}
    mandandoParaGoogle={mandarParaGoogle.isPending && mandarParaGoogle.variables?.id === reuniao.id}
    excluindo={excluir.isPending && excluir.variables?.id === reuniao.id}/>;

  return <main className="min-h-screen text-white px-4 py-8 md:px-8 bg-transparent">
    <div ref={topo} className="max-w-4xl mx-auto scroll-mt-20">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <p className="text-amber-300 text-sm font-semibold tracking-wide">{t("agenda.eyebrow")}</p>
          <h1 className="text-3xl md:text-4xl font-bold mt-1">{t("agenda.title")}</h1>
          <p className="text-white/55 mt-2 max-w-2xl">{t("agenda.subtitle")}</p>
        </div>
        {!formulario && <button type="button" onClick={() => abrir(formularioNovo(), null)}
          className="inline-flex justify-center items-center gap-2 rounded-xl bg-[#c98f70] text-[#1a120c] font-bold px-5 py-3 hover:bg-[#efcba8]">
          <Plus size={18}/> {t("agenda.newButton")}
        </button>}
      </div>

      {googleQuebrada && <div role="status" className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex gap-2 text-sm text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true"/> {t("agenda.google.broken")}
        </p>
        <button type="button" onClick={() => navigate(ROTA_DO_PERFIL)} className={`shrink-0 ${CLASSE_DO_BOTAO}`}>{t("agenda.google.openProfile")}</button>
      </div>}

      {/* A consulta da Google com erro é erro, nunca "não conectada"; a lista
          com erro já mostra o dela, e um basta. */}
      {estadoGoogle.isError && !consulta.isError && <div role="alert" className="mb-6 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-white/70">{t("agenda.google.statusError")} <span className="text-white/45">{mensagemDeErroParaTela(estadoGoogle.error, t)}</span></p>
        <button type="button" onClick={() => void estadoGoogle.refetch()} className={`shrink-0 ${CLASSE_DO_BOTAO}`}>{t("errorBoundary.retryButton")}</button>
      </div>}

      {formulario && <FormularioDaAgendada
        key={formulario.id ?? "nova"}
        inicial={formulario.valores}
        editando={formulario.id !== null}
        salvando={salvando}
        googleLigada={googleLigada}
        aoSalvar={valores => salvar(valores, formulario.id)}
        aoCancelar={() => setFormulario(null)}
      />}

      {consulta.isLoading ? <div className="py-20 text-center text-white/45"><Loader2 className="animate-spin inline mr-2"/>{t("agenda.loading")}</div>
        : consulta.isError && !dados ? <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()}/>
        : !dados?.proximas.length && !dados?.anteriores.length ? <div className="rounded-3xl border border-dashed border-white/15 px-6 py-16 text-center">
          <CalendarDays className="mx-auto text-amber-300 mb-4" size={34}/>
          <h2 className="font-semibold text-xl">{t("agenda.emptyTitle")}</h2>
          <p className="text-white/45 mt-2">{t("agenda.emptySubtitle")}</p>
        </div>
        : <div className="space-y-10">
          <section aria-labelledby="agenda-proximas">
            <h2 id="agenda-proximas" className="text-sm font-semibold uppercase tracking-widest text-white/45 mb-3">{t("agenda.upcomingHeading")}</h2>
            {dados.proximas.length
              ? <div className="grid gap-3">{dados.proximas.map(cartao)}</div>
              : <p className="rounded-2xl border border-dashed border-white/10 px-5 py-6 text-sm text-white/45">{t("agenda.noUpcoming")}</p>}
          </section>
          {dados.anteriores.length > 0 && <section aria-labelledby="agenda-anteriores">
            <h2 id="agenda-anteriores" className="text-sm font-semibold uppercase tracking-widest text-white/45 mb-3">{t("agenda.pastHeading")}</h2>
            <div className="grid gap-3">{dados.anteriores.map(cartao)}</div>
          </section>}
        </div>}
    </div>
  </main>;
}

const CLASSE_DO_CAMPO = "mt-2 w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white outline-none focus:border-amber-300";
const CLASSE_DO_BOTAO = "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:bg-white/5";

function FormularioDaAgendada({ inicial, editando, salvando, googleLigada, aoSalvar, aoCancelar }: {
  inicial: Formulario;
  editando: boolean;
  salvando: boolean;
  /** A Google Agenda conectada (H16c): a reunião vai para lá, e o convite pela Google aparece. */
  googleLigada: boolean;
  aoSalvar: (valores: Formulario) => void;
  aoCancelar: () => void;
}) {
  const { t, i18n } = useTranslation();
  const idioma = i18n.resolvedLanguage ?? i18n.language;
  const [valores, setValores] = useState(inicial);
  const id = useId();
  const mudar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => setValores(atual => ({ ...atual, [campo]: valor }));
  const mudarParticipante = (posicao: number, campo: "nome" | "email", valor: string) =>
    setValores(atual => ({ ...atual, participantes: atual.participantes.map((p, i) => i === posicao ? { ...p, [campo]: valor } : p) }));
  // A duração de uma reunião antiga fora da lista também aparece, para não mudar sem querer.
  const duracoes = DURACOES_DA_TELA.includes(valores.duracaoMinutos as (typeof DURACOES_DA_TELA)[number])
    ? [...DURACOES_DA_TELA]
    : [...DURACOES_DA_TELA, valores.duracaoMinutos].sort((a, b) => a - b);
  const fuso = fusoDoAparelho();

  // noValidate: a conferência é a nossa (entradaDoFormulario), no idioma da tela;
  // a do navegador barraria o e-mail ruim com um balão no idioma do aparelho.
  return <form noValidate aria-labelledby={`${id}-titulo`} onSubmit={evento => { evento.preventDefault(); aoSalvar(valores); }}
    className="mb-10 rounded-3xl border border-white/10 bg-[#211e1b]/90 p-5 md:p-7 shadow-2xl">
    <h2 id={`${id}-titulo`} className="text-xl font-bold">{editando ? t("agenda.form.editTitle") : t("agenda.form.newTitle")}</h2>
    <div className="mt-5 space-y-5">
      <div>
        <label htmlFor={`${id}-nome`} className="text-sm text-white/70">{t("agenda.form.titleLabel")}</label>
        <input id={`${id}-nome`} autoFocus value={valores.titulo} maxLength={TITULO_DA_REUNIAO_MAX} onChange={e => mudar("titulo", e.target.value)}
          placeholder={t("agenda.form.titlePlaceholder")} className={CLASSE_DO_CAMPO}/>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-data`} className="text-sm text-white/70">{t("agenda.form.dateLabel")}</label>
          <input id={`${id}-data`} type="date" value={valores.data} onChange={e => mudar("data", e.target.value)} className={`${CLASSE_DO_CAMPO} [color-scheme:dark]`}/>
        </div>
        <div>
          <label htmlFor={`${id}-hora`} className="text-sm text-white/70">{t("agenda.form.timeLabel")}</label>
          <input id={`${id}-hora`} type="time" value={valores.hora} onChange={e => mudar("hora", e.target.value)} className={`${CLASSE_DO_CAMPO} [color-scheme:dark]`}/>
        </div>
      </div>
      <p className="-mt-3 text-xs text-white/40">{t("agenda.timeZoneNote", { zone: fuso.replace(/_/g, " ") })}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-duracao`} className="text-sm text-white/70">{t("agenda.form.durationLabel")}</label>
          <select id={`${id}-duracao`} value={valores.duracaoMinutos} onChange={e => mudar("duracaoMinutos", Number(e.target.value))} className={CLASSE_DO_CAMPO}>
            {duracoes.map(minutos => <option className="bg-white text-[#322C26]" key={minutos} value={minutos}>{rotuloDaDuracao(minutos, idioma)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-lembrete`} className="text-sm text-white/70">{t("agenda.form.reminderLabel")}</label>
          <select id={`${id}-lembrete`} value={valores.lembrete} onChange={e => mudar("lembrete", e.target.value)} className={CLASSE_DO_CAMPO}>
            <option className="bg-white text-[#322C26]" value="">{rotuloDoLembrete(t, null)}</option>
            {LEMBRETES_DA_AGENDA.map(minutos => <option className="bg-white text-[#322C26]" key={minutos} value={String(minutos)}>{rotuloDoLembrete(t, minutos)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-local`} className="text-sm text-white/70">{t("agenda.form.placeLabel")}</label>
        <input id={`${id}-local`} value={valores.local} maxLength={LOCAL_DA_AGENDADA_MAX} onChange={e => mudar("local", e.target.value)}
          placeholder={t("agenda.form.placePlaceholder")} className={CLASSE_DO_CAMPO}/>
      </div>
      <fieldset>
        <legend className="text-sm text-white/70">{t("agenda.form.participantsLabel")}</legend>
        <p className="mt-1 text-xs text-white/40">{t("agenda.form.participantsHint")}</p>
        <div className="mt-2 space-y-2">
          {valores.participantes.map((participante, posicao) => <div key={posicao} className="flex items-start gap-2">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              <input aria-label={`${t("agenda.form.participantName")} ${posicao + 1}`} value={participante.nome} maxLength={NOME_DO_PARTICIPANTE_MAX}
                onChange={e => mudarParticipante(posicao, "nome", e.target.value)} placeholder={t("agenda.form.participantName")}
                className="w-full rounded-xl bg-white/5 border border-white/15 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-300"/>
              <input aria-label={`${t("agenda.form.participantEmail")} ${posicao + 1}`} type="email" inputMode="email" dir="ltr" value={participante.email} maxLength={EMAIL_DO_PARTICIPANTE_MAX}
                onChange={e => mudarParticipante(posicao, "email", e.target.value)} placeholder={t("agenda.form.participantEmail")}
                className="w-full rounded-xl bg-white/5 border border-white/15 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-300"/>
            </div>
            <button type="button" aria-label={`${t("agenda.form.removeParticipant")} ${posicao + 1}`}
              onClick={() => setValores(atual => ({ ...atual, participantes: atual.participantes.filter((_, i) => i !== posicao) }))}
              className="mt-1 rounded-lg border border-white/10 p-2 text-white/55 hover:bg-white/5"><X size={15}/></button>
          </div>)}
        </div>
        {valores.participantes.length < PARTICIPANTES_DA_AGENDADA_MAX && <button type="button"
          onClick={() => setValores(atual => ({ ...atual, participantes: [...atual.participantes, { nome: "", email: "" }] }))}
          className={`mt-2 ${CLASSE_DO_BOTAO}`}><Plus size={15}/> {t("agenda.form.addParticipant")}</button>}
      </fieldset>
      {googleLigada && <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="flex gap-2 text-xs text-white/55">
          <CalendarCheck size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true"/> {t("agenda.google.formNote")}
        </p>
        <div className="mt-3 flex items-start gap-3">
          <input id={`${id}-convites`} type="checkbox" checked={valores.googleConvites} onChange={e => mudar("googleConvites", e.target.checked)}
            aria-describedby={`${id}-convites-dica`} className="mt-0.5 h-4 w-4 shrink-0 accent-[#c98f70]"/>
          <div>
            <label htmlFor={`${id}-convites`} className="text-sm text-white/85">{t("agenda.google.invitesLabel")}</label>
            <p id={`${id}-convites-dica`} className="mt-1 text-xs text-white/40">{t("agenda.google.invitesHint")}</p>
          </div>
        </div>
      </div>}
    </div>
    <div className="mt-7 flex flex-wrap gap-2">
      <button type="submit" disabled={salvando}
        className="inline-flex items-center gap-2 rounded-xl bg-[#c98f70] px-5 py-3 font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {salvando && <Loader2 size={16} className="animate-spin"/>} {t("agenda.form.save")}
      </button>
      <button type="button" onClick={aoCancelar} disabled={salvando}
        className="rounded-xl border border-white/15 px-5 py-3 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50">
        {t("agenda.form.cancel")}
      </button>
    </div>
  </form>;
}

function CartaoDaAgendada({ reuniao, agora, idioma, googleLigada, googleDesligada, aoGravar, aoAbrirGravacao, aoEditar, aoExcluir, aoMandarParaGoogle, mandandoParaGoogle, excluindo }: {
  reuniao: ReuniaoDaAgenda;
  agora: number;
  idioma: string;
  /** A dona tem a Google Agenda conectada: o cartão mostra o estado da reunião lá. */
  googleLigada: boolean;
  /** A resposta foi "não conectada": o link de criar evento da H16a aparece. */
  googleDesligada: boolean;
  aoGravar: () => void;
  aoAbrirGravacao: (meetingId: string) => void;
  aoEditar: () => void;
  aoExcluir: () => void;
  aoMandarParaGoogle: () => void;
  mandandoParaGoogle: boolean;
  excluindo: boolean;
}) {
  const { t } = useTranslation();
  const [confirmando, setConfirmando] = useState(false);
  const fim = reuniao.inicioEm + reuniao.duracaoMinutos * 60_000;
  const acontecendo = reuniao.inicioEm <= agora && agora < fim;
  const pessoas = reuniao.participantes.map(p => p.nome ?? p.email).filter(Boolean).join(", ");
  const { evento, emails, whatsapp, email } = conviteDaReuniao(reuniao, t, idioma);
  const idDoTitulo = `agendada-${reuniao.id}`;

  return <article aria-labelledby={idDoTitulo} className={`rounded-2xl border p-5 ${acontecendo ? "border-amber-300/40 bg-amber-300/[0.06]" : "border-white/10 bg-white/[0.035]"}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id={idDoTitulo} dir="auto" className="text-base font-semibold break-words">{reuniao.titulo}</h3>
        <p className="mt-1 text-sm text-white/65">{quandoDaReuniao(evento, idioma)}</p>
        {reuniao.local && (ehLinkDaChamada(reuniao.local)
          ? <a href={reuniao.local.trim()} target="_blank" rel="noopener noreferrer" dir="ltr" className="mt-1 block break-all text-sm text-amber-200 underline-offset-2 hover:underline">{reuniao.local}</a>
          : <p dir="auto" className="mt-1 text-sm text-white/60 break-words">{reuniao.local}</p>)}
        {pessoas && <p className="mt-2 text-xs text-white/45 break-words">{t("agenda.card.participants")}: <span dir="auto">{pessoas}</span></p>}
        {reuniao.lembreteMinutos !== null && <p className="mt-1 text-xs text-white/45">{t("agenda.card.reminder")}: {rotuloDoLembrete(t, reuniao.lembreteMinutos)}</p>}
        {reuniao.gravacao && <p className="mt-1 text-xs text-white/45">{t("agenda.card.recording")}: {rotuloDaGravacao(t, reuniao.gravacao.status)}</p>}
      </div>
      {acontecendo && <span className="shrink-0 rounded-full border border-amber-300/40 bg-amber-300/15 px-3 py-1 text-xs font-semibold text-amber-200">{t("agenda.card.now")}</span>}
    </div>

    <div className="mt-4 flex flex-wrap gap-2">
      {/* Com a gravação ligada, o "Gravar de novo" segue à mão: a gravação que
          falhou no envio deixa ligada uma reunião sem áudio, e gravar de novo
          troca a ligação pela gravação nova (a antiga fica em Reuniões). */}
      {reuniao.gravacao
        ? <>
          <button type="button" onClick={() => aoAbrirGravacao(reuniao.gravacao!.id)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
            <FileText size={15}/> {t("agenda.card.openRecording")}
          </button>
          <button type="button" onClick={aoGravar} className={CLASSE_DO_BOTAO}><Mic size={15}/> {t("agenda.card.recordAgain")}</button>
        </>
        : <button type="button" onClick={aoGravar}
          className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
          <Mic size={15}/> {t("agenda.card.recordNow")}
        </button>}
      <button type="button" onClick={aoEditar} className={CLASSE_DO_BOTAO}><Pencil size={15}/> {t("agenda.card.edit")}</button>
      <button type="button" onClick={() => setConfirmando(true)} disabled={excluindo} className={`${CLASSE_DO_BOTAO} text-red-200/85 disabled:opacity-50`}><Trash2 size={15}/> {t("agenda.card.delete")}</button>
    </div>

    <div role="group" aria-label={t("agenda.card.inviteGroup")} className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
      <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={CLASSE_DO_BOTAO}>
        <MessageCircle size={15}/> {t("agenda.card.inviteWhatsapp")}
      </a>
      <a href={email} className={CLASSE_DO_BOTAO}>
        <Mail size={15}/> {t("agenda.card.inviteEmail")}
      </a>
      {googleDesligada && <a href={linkDaGoogleAgenda({ ...evento, convidados: emails })} target="_blank" rel="noopener noreferrer" className={CLASSE_DO_BOTAO}>
        <CalendarPlus size={15}/> {t("agenda.card.googleCalendar")}
      </a>}
      {googleLigada && <NaGoogleAgenda estado={reuniao.google} futura={agora < fim} mandando={mandandoParaGoogle} aoMandar={aoMandarParaGoogle}/>}
      <button type="button" onClick={() => baixarIcs(reuniao, t)} className={CLASSE_DO_BOTAO}>
        <Download size={15}/> {t("agenda.card.downloadIcs")}
      </button>
    </div>

    {confirmando && <div className="mt-4 space-y-2 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3">
      <p id={`${idDoTitulo}-excluir`} className="text-sm text-red-100/90">{t("agenda.card.deleteConfirm", { title: reuniao.titulo })}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={excluindo} onClick={() => { aoExcluir(); setConfirmando(false); }}
          className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
          {t("agenda.card.deleteYes")}
        </button>
        {/* Manter, a saída segura, recebe o foco, e a pergunta vai junto no anúncio. */}
        <button type="button" autoFocus aria-describedby={`${idDoTitulo}-excluir`} onClick={() => setConfirmando(false)}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5">
          {t("agenda.card.deleteNo")}
        </button>
      </div>
    </div>}
  </article>;
}

/**
 * O estado da reunião na Google Agenda da dona (H16c), no lugar do link de
 * criar evento: "Na sua Google Agenda" quando a Google tem esta versão;
 * "Ainda não está" com "Tentar de novo" quando o envio falhou ou não terminou;
 * e, na reunião que nunca foi para lá (marcada antes de conectar, ou antes de
 * desconectar ou de trocar de conta Google, que zeram o estado), "Pôr na
 * Google Agenda", só nas que ainda vão acontecer.
 */
function NaGoogleAgenda({ estado, futura, mandando, aoMandar }: {
  estado: ReuniaoDaAgenda["google"];
  futura: boolean;
  mandando: boolean;
  aoMandar: () => void;
}) {
  const { t } = useTranslation();
  if (estado === "ok") {
    return <p className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-sm text-emerald-200/90">
      <CalendarCheck size={15} aria-hidden="true"/> {t("agenda.google.onCalendar")}
    </p>;
  }
  if (estado === "pendente" || estado === "falhou") {
    return <div className="flex flex-wrap items-center gap-2">
      <p className="inline-flex items-center gap-2 text-sm text-amber-200/90"><AlertTriangle size={15} aria-hidden="true"/> {t("agenda.google.notOnCalendar")}</p>
      <button type="button" onClick={aoMandar} disabled={mandando} className={`${CLASSE_DO_BOTAO} disabled:opacity-50`}>
        {mandando ? <Loader2 size={15} className="animate-spin" aria-hidden="true"/> : <RefreshCw size={15} aria-hidden="true"/>}
        {mandando ? t("agenda.google.sending") : t("agenda.google.retry")}
      </button>
    </div>;
  }
  if (!futura) return null;
  return <button type="button" onClick={aoMandar} disabled={mandando} className={`${CLASSE_DO_BOTAO} disabled:opacity-50`}>
    {mandando ? <Loader2 size={15} className="animate-spin" aria-hidden="true"/> : <CalendarPlus size={15} aria-hidden="true"/>}
    {mandando ? t("agenda.google.sending") : t("agenda.google.send")}
  </button>;
}
