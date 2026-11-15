import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { AvisoDeConferir, mensagemDoErroDaIA, Trecho } from "@/components/ReuniaoComIA";
import { mmss } from "@/components/TranscricaoPorFalante";
import { mensagemDeErroParaTela, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * O resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), no formato do app de referência
 * da cliente: no topo as ações com caixa de marcar; depois o foco do trabalho,
 * as tarefas por assunto (com responsável e prazo), as decisões, os bloqueios e
 * as questões pendentes. O emoji do resumo vai antes do título da reunião, na
 * página que usa este componente.
 *
 * Nada extraído por IA entra sozinho: cada item nasce "para conferir", com o
 * trecho da transcrição que o sustenta, e a dona confirma ou ignora. Os
 * ignorados ficam recolhidos, com Desfazer. O "▶ mm:ss" leva o player da barra
 * do rodapé ao ponto do trecho.
 *
 * Serve às duas telas: o detalhe da dona (pages/Meetings.tsx), que decide, e o
 * link aberto (pages/ReuniaoAberta.tsx), só de leitura: sem os botões de
 * decidir, com o aviso de que a dona ainda não conferiu nos pendentes e com as
 * vozes como "Falante n", porque o link não leva os nomes que a dona deu. A
 * consulta mora na página (que também lê o emoji e repete a consulta enquanto
 * o resumo é gerado); as mutações moram aqui e a relêem.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type Saidas = inferRouterOutputs<AppRouter>;
type ResumoDaDona = Saidas["meetings"]["resumoGuardado"];
type ResumoDoLink = Saidas["reuniaoAberta"]["resumoGuardado"];
// O link não recebe o id nem a caixa de feito (server/resumo-guardado.ts).
type ItemNaTela = ResumoDoLink["itens"][number] & { id?: string; done?: boolean };
type Secao = ItemNaTela["section"];
type ConsultaDoResumo<T> = { data?: T; isError: boolean; error: unknown; refetch: () => unknown };

type DaDona = {
  meetingId: string;
  token?: undefined;
  consulta: ConsultaDoResumo<ResumoDaDona>;
  /** Os nomes que a dona deu às vozes (nomesDosFalantes(meeting.speakerNames)). */
  nomes?: Readonly<Record<string, string>>;
  aoIrPara?: (segundo: number) => void;
  /** O item pedido pelo link (?item=<id>): a tela rola até ele e o destaca. */
  itemDestacado?: string | null;
  /**
   * O último item até o qual a tela já rolou, guardado pela página: voltar à
   * aba Resumo (que remonta este componente) não rola de novo até o mesmo item.
   */
  registroDoDestaque?: { current: string | null };
};
type DoLink = {
  token: string;
  meetingId?: undefined;
  consulta: ConsultaDoResumo<ResumoDoLink>;
  aoIrPara?: (segundo: number) => void;
};

// A ordem do formato da cliente.
const ORDEM_DAS_SECOES: readonly Secao[] = ["action", "focus", "task", "decision", "blocker", "question"];

// Cada ramo chama t() com a chave literal, para o teste das chaves usadas
// (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
function tituloDaSecao(t: TranslateFn, secao: Secao) {
  switch (secao) {
    case "action": return t("meetings.summary.actionsHeading");
    case "focus": return t("meetings.summary.focusHeading");
    case "task": return t("meetings.summary.tasksHeading");
    case "decision": return t("meetings.summary.decisionsHeading");
    case "blocker": return t("meetings.summary.blockersHeading");
    case "question": return t("meetings.summary.openQuestionsHeading");
  }
}

const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;
const MENSAGENS_DO_RESUMO = new Set([MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_SO_ACAO_TEM_CAIXA]);

// As três recusas do resumo vêm com frase própria do servidor, que a tabela
// de lib/mensagem-de-erro.ts traduz; as outras mensagens do servidor vêm em
// português, e a tela decide pelo código.
function mensagemDaDecisao(t: TranslateFn, erro: unknown) {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (typeof mensagem === "string" && MENSAGENS_DO_RESUMO.has(mensagem)) return traduzirMensagemDoServidor(mensagem, t);
  switch (codigoDoErro(erro)) {
    case "CONFLICT": return t("meetings.summary.errorRegenerating");
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR":
    case "TOO_MANY_REQUESTS": return mensagemDeErroParaTela(erro, t);
    default: return t("meetings.summary.decisionError");
  }
}

const idDoItem = (id: string) => `item-do-resumo-${id}`;
const movimentoReduzido = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function ResumoGuardado(props: DaDona | DoLink) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const peloLink = props.token !== undefined;
  const meetingId = props.meetingId ?? "";
  const token = props.token ?? "";
  // O link nunca mostra nomes: as vozes são sempre "Falante n".
  const nomes = props.token === undefined ? props.nomes ?? {} : {};
  const itemDestacado = props.token === undefined ? props.itemDestacado ?? null : null;
  const dados = props.consulta.data as ResumoDaDona | ResumoDoLink | undefined;

  // Toda mutação relê o resumo; devolvida ao onSettled, a releitura segura o
  // botão até o estado novo chegar.
  const reler = () => peloLink
    ? utils.reuniaoAberta.resumoGuardado.invalidate({ token })
    : utils.meetings.resumoGuardado.invalidate({ meetingId });
  const aoFalharDecisao = (erro: unknown) => toast.error(mensagemDaDecisao(t, erro));
  const pedirDaDona = trpc.meetings.pedirResumo.useMutation({ onSettled: reler });
  const pedirPeloLink = trpc.reuniaoAberta.pedirResumo.useMutation({ onSettled: reler });
  const decidir = trpc.meetings.decidirItemDoResumo.useMutation({ onError: aoFalharDecisao, onSettled: reler });
  const confirmarTodos = trpc.meetings.confirmarItensDoResumo.useMutation({ onError: aoFalharDecisao, onSettled: reler });
  const marcar = trpc.meetings.marcarAcaoFeita.useMutation({ onError: aoFalharDecisao, onSettled: reler });
  const pedir = peloLink ? pedirPeloLink : pedirDaDona;
  const pedirResumo = () => {
    if (peloLink) pedirPeloLink.mutate({ token });
    else pedirDaDona.mutate({ meetingId });
  };
  // Uma decisão por vez: a próxima espera a releitura da anterior.
  const decidindo = decidir.isPending || confirmarTodos.isPending || marcar.isPending;

  const itens: ItemNaTela[] = dados?.estado === "pronto" ? dados.itens : [];
  const visiveis = itens.filter(item => item.status !== "ignored");
  const ignorados = itens.filter(item => item.status === "ignored");
  const pendentes = visiveis.filter(item => item.status === "pending");
  const [verIgnorados, setVerIgnorados] = useState(false);
  // O Desfazer se repete em todo ignorado: o texto do item o descreve.
  const prefixoDosIgnorados = useId();

  // ?item=<id>: rola até o item e o destaca. Cada link diferente rola uma vez;
  // o item ignorado mora na lista recolhida, que abre antes.
  const alvo = itemDestacado ? itens.find(item => item.id === itemDestacado) : undefined;
  const alvoIgnorado = alvo?.status === "ignored";
  const itemNaoAchado = !!itemDestacado && dados?.estado === "pronto" && !alvo;
  const jaRolouAqui = useRef<string | null>(null);
  const jaRolou = (props.token === undefined ? props.registroDoDestaque : undefined) ?? jaRolouAqui;
  useEffect(() => {
    if (!itemDestacado || !alvo || jaRolou.current === itemDestacado) return;
    if (alvoIgnorado && !verIgnorados) {
      setVerIgnorados(true);
      return;
    }
    const elemento = document.getElementById(idDoItem(itemDestacado));
    if (!elemento) return;
    jaRolou.current = itemDestacado;
    elemento.scrollIntoView?.({ block: "center", behavior: movimentoReduzido() ? "auto" : "smooth" });
    elemento.focus({ preventScroll: true });
  }, [itemDestacado, !!alvo, alvoIgnorado, verIgnorados]);

  const comVozes = (texto: string) => vozesNoTexto(texto, nomes, numero => t("meetings.speakerLabel", { n: numero }));

  // Erro de consulta é erro, nunca "sem resumo" nem "gerando". Pelo link,
  // NOT_FOUND ou BAD_REQUEST é o link desligado (ou cortado) no meio da visita:
  // definitivo, como em pages/ReuniaoAberta.tsx, sem tentar de novo.
  const codigoDaConsulta = codigoDoErro(props.consulta.error);
  const naoAchou = codigoDaConsulta === "NOT_FOUND" || (peloLink && codigoDaConsulta === "BAD_REQUEST");
  const erroDaConsulta = !props.consulta.isError ? null
    : naoAchou
      ? <p role="alert" className="mt-4 text-sm text-white/70">{peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound")}</p>
      : <div className="mt-4"><ErroDeConsulta erro={props.consulta.error} aoTentarDeNovo={() => void props.consulta.refetch()}/></div>;
  // A releitura que falha deixa o dado velho no cache. Sem dado, ou com o
  // resumo ainda na fila, o erro toma o lugar do aviso, que senão giraria para
  // sempre; com o resumo pronto, falho ou ausente, ele vai acima do conteúdo.
  const esperando = !dados || dados.estado === "pendente" || dados.estado === "gerando";
  // O erro do pedido é do botão de pedir: quando o resumo anda por outro
  // caminho (a fila, outro pedido pelo link), ele sai da tela com o botão.
  const comBotaoDePedir = dados?.estado === "sem_resumo" || dados?.estado === "falhou";

  let corpo: ReactNode;
  if (esperando && erroDaConsulta) {
    corpo = erroDaConsulta;
  } else if (!dados) {
    corpo = <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.loading")}</p>;
  } else if (dados.estado === "sem_resumo") {
    corpo = <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-white/60">{t("meetings.summary.noSummary")}</p>
      <BotaoDePedir aoClicar={pedirResumo} pedindo={pedir.isPending}>{peloLink ? t("meetings.summary.requestLink") : t("meetings.summary.generate")}</BotaoDePedir>
    </div>;
  } else if (dados.estado === "pendente" || dados.estado === "gerando") {
    corpo = <p role="status" className="mt-4 text-sm text-white/60"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.generating")}</p>;
  } else if (dados.estado === "falhou") {
    corpo = <div role="alert" className="mt-4 flex flex-col gap-3 rounded-xl border border-red-400/20 bg-red-400/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-red-200">{t("meetings.summary.failed")}</p>
      <BotaoDePedir aoClicar={pedirResumo} pedindo={pedir.isPending}>{t("meetings.summary.retry")}</BotaoDePedir>
    </div>;
  } else {
    corpo = <div className="mt-4 space-y-5">
      {!peloLink && pendentes.length > 0 && <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <AvisoDeConferir>{t("meetings.summary.reviewNotice")}</AvisoDeConferir>
        <button type="button" disabled={decidindo} onClick={() => confirmarTodos.mutate({ meetingId })}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-300/10 disabled:opacity-50">
          <Check size={15}/> {t("meetings.summary.confirmAll", { n: pendentes.length })}
        </button>
      </div>}
      {itemNaoAchado && <p role="status" className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/60">{t("meetings.summary.itemNotFound")}</p>}
      {!visiveis.length && <p className="text-sm text-white/55">{t("meetings.summary.empty")}</p>}
      {ORDEM_DAS_SECOES.map(secao => {
        const daSecao = visiveis.filter(item => item.section === secao);
        if (!daSecao.length) return null;
        return <section key={secao} aria-labelledby={`secao-do-resumo-${secao}`}>
          <h3 id={`secao-do-resumo-${secao}`} className="text-sm font-semibold text-amber-200">{tituloDaSecao(t, secao)}</h3>
          <ul className="mt-2 space-y-3">
            {daSecao.map((item, i) => <ItemDoResumo key={item.id ?? `${secao}-${i}`} item={item} peloLink={peloLink} comVozes={comVozes}
              aoIrPara={props.aoIrPara} destacado={!!item.id && item.id === itemDestacado} decidindo={decidindo}
              aoDecidir={status => { if (item.id) decidir.mutate({ itemId: item.id, status }); }}
              aoMarcar={feito => { if (item.id) marcar.mutate({ itemId: item.id, feito }); }}/>)}
          </ul>
        </section>;
      })}
      {!peloLink && ignorados.length > 0 && <div className="border-t border-white/10 pt-4">
        <button type="button" aria-expanded={verIgnorados} onClick={() => setVerIgnorados(aberta => !aberta)}
          className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white">
          <ChevronDown size={15} className={verIgnorados ? "rotate-180" : ""}/> {t("meetings.summary.showIgnored", { n: ignorados.length })}
        </button>
        {verIgnorados && <ul className="mt-3 space-y-2">
          {ignorados.map((item, i) => <li key={item.id ?? i} id={item.id ? idDoItem(item.id) : undefined} tabIndex={item.id === itemDestacado ? -1 : undefined}
            data-destacado={item.id === itemDestacado ? "true" : undefined}
            className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm text-white/45 ${item.id === itemDestacado ? "ring-2 ring-amber-300/70" : ""}`}>
            <span id={`${prefixoDosIgnorados}-${i}`} dir="auto" className="line-through">{item.subject ? `${comVozes(item.subject)}: ` : ""}{comVozes(item.text)}</span>
            <button type="button" aria-describedby={`${prefixoDosIgnorados}-${i}`} disabled={decidindo} onClick={() => { if (item.id) decidir.mutate({ itemId: item.id, status: "pending" }); }}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-200 hover:text-amber-100 disabled:opacity-50">
              <RotateCcw size={13}/> {t("meetings.summary.undo")}
            </button>
          </li>)}
        </ul>}
      </div>}
    </div>;
  }

  return <section aria-labelledby="resumo-guardado" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <h2 id="resumo-guardado" className="inline-flex items-center gap-2 text-base font-semibold text-amber-100"><Sparkles size={16}/>{t("meetings.summary.title")}</h2>
    {!esperando && erroDaConsulta}
    {corpo}
    {comBotaoDePedir && pedir.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, pedir.error, t("meetings.summary.requestError"), peloLink)}</p>}
  </section>;
}

function BotaoDePedir({ aoClicar, pedindo, children }: { aoClicar: () => void; pedindo: boolean; children: ReactNode }) {
  return <button type="button" onClick={aoClicar} disabled={pedindo}
    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
    {pedindo ? <Loader2 size={15} className="animate-spin"/> : <Sparkles size={15}/>} {children}
  </button>;
}

function ItemDoResumo({ item, peloLink, comVozes, aoIrPara, destacado, decidindo, aoDecidir, aoMarcar }: {
  item: ItemNaTela;
  peloLink: boolean;
  comVozes: (texto: string) => string;
  aoIrPara?: (segundo: number) => void;
  destacado: boolean;
  decidindo: boolean;
  aoDecidir: (status: "confirmed" | "ignored") => void;
  aoMarcar: (feito: boolean) => void;
}) {
  const { t } = useTranslation();
  const pendente = item.status === "pending";
  // A caixa é só da dona: o link não recebe o feito, e não decide nada.
  const comCaixa = item.section === "action" && !peloLink;
  // Confirmar e Ignorar se repetem em todo item: o texto do item os descreve.
  const idDoTexto = useId();
  const texto = <>{item.subject && <strong className="font-semibold text-white/90">{comVozes(item.subject)}: </strong>}{comVozes(item.text)}</>;
  return <li id={item.id ? idDoItem(item.id) : undefined} tabIndex={destacado ? -1 : undefined} data-destacado={destacado ? "true" : undefined}
    className={`rounded-xl border p-3 outline-none ${destacado ? "border-amber-300/70 ring-2 ring-amber-300/60" : pendente ? "border-amber-300/20 bg-black/10" : "border-white/10 bg-black/5"}`}>
    {comCaixa
      ? <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={!!item.done} disabled={decidindo} onChange={evento => aoMarcar(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span id={idDoTexto} dir="auto" className={`text-sm text-white/85 ${item.done ? "line-through text-white/50" : ""}`}>{texto}</span>
        </label>
      : <p id={idDoTexto} dir="auto" className="text-sm leading-6 text-white/85">{texto}</p>}
    {(item.assignee || item.due) && <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-100/70">
      {item.assignee && <span dir="auto">{t("meetings.summary.assignee", { nome: comVozes(item.assignee) })}</span>}
      {item.due && <span dir="auto">{t("meetings.summary.due", { prazo: item.due })}</span>}
    </p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {/* Sem player (a gravação venceu ou não existe), o tempo é só
          informação: nada de botão desligado anunciando "Ouvir". */}
      {item.startSeconds !== null && (aoIrPara
        ? <button type="button" onClick={() => aoIrPara(item.startSeconds as number)}
            aria-label={t("meetings.playFrom", { tempo: mmss(item.startSeconds) })}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10">
            <Play size={11} aria-hidden/>{mmss(item.startSeconds)}
          </button>
        : <span className="px-1.5 py-0.5 font-mono text-xs text-white/40">{mmss(item.startSeconds)}</span>)}
      {pendente && !peloLink && <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">{t("meetings.summary.toReview")}</span>}
    </div>
    {/* O trecho fica aberto enquanto o item espera a conferência; depois, recolhido. */}
    {pendente
      ? <Trecho texto={item.excerpt}/>
      : <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-white/35">{t("meetings.ai.excerptLabel")}</summary>
          <q dir="auto" className="mt-1 block border-l-2 border-amber-300/40 pl-3 text-xs italic text-white/55">{item.excerpt}</q>
        </details>}
    {pendente && peloLink && <p className="mt-2 text-xs text-amber-100/70">{t("meetings.summary.linkNotice")}</p>}
    {pendente && !peloLink && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" aria-describedby={idDoTexto} disabled={decidindo} onClick={() => aoDecidir("confirmed")}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-50"><Check size={14}/> {t("meetings.summary.confirm")}</button>
      <button type="button" aria-describedby={idDoTexto} disabled={decidindo} onClick={() => aoDecidir("ignored")}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 disabled:opacity-50"><X size={14}/> {t("meetings.summary.ignore")}</button>
    </div>}
  </li>;
}
