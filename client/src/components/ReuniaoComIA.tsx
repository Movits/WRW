import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Loader2, MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

/**
 * O resumo da reunião e o "Pergunte à reunião", no detalhe de uma reunião
 * pronta com transcrição. A IA lê a transcrição no servidor e responde só para
 * a tela: nada é gravado, e cada item traz o trecho que o sustenta para a dona
 * conferir (nada extraído por IA entra sozinho).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type IdiomaDaTela = "pt-BR" | "en" | "es" | "fr" | "de" | "ar" | "zh" | "hi" | "ja" | "ru";

// O idioma RESOLVIDO, como na tradução da transcrição: "en-US" cai fora da lista.
function idiomaDaTela(i18n: { resolvedLanguage?: string; language: string }): IdiomaDaTela {
  const atual = i18n.resolvedLanguage ?? i18n.language;
  return (LANGUAGES.some(idioma => idioma.code === atual) ? atual : "pt-BR") as IdiomaDaTela;
}

// O código tRPC decide a frase: as mensagens do servidor vêm em português.
// Banco fora do ar chega como INTERNAL_SERVER_ERROR com a frase conhecida, que
// mensagemDeErroParaTela traduz.
function mensagemDoErroDaIA(t: TranslateFn, erro: unknown, padrao: string) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "SERVICE_UNAVAILABLE": return t("meetings.ai.unavailable");
    case "PRECONDITION_FAILED": return t("meetings.ai.needsTranscript");
    // Teto de pedidos à IA: a mesma frase do assistente de texto, já nos 10 idiomas.
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return padrao;
  }
}

/** O trecho literal da transcrição que sustenta o item: é por ele que a dona confere. */
function Trecho({ texto }: { texto: string }) {
  const { t } = useTranslation();
  return <div className="mt-2 border-l-2 border-amber-300/40 pl-3">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{t("meetings.ai.excerptLabel")}</p>
    <q className="text-xs italic text-white/55">{texto}</q>
  </div>;
}

function AvisoDeConferir() {
  const { t } = useTranslation();
  return <p className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100/80"><CircleAlert size={14} className="mr-1.5 inline"/>{t("meetings.ai.reviewNotice")}</p>;
}

function SecaoDoResumo({ titulo, vazia, children }: { titulo: string; vazia: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return <div>
    <h3 className="text-sm font-semibold text-amber-200">{titulo}</h3>
    {vazia ? <p className="mt-1 text-sm text-white/45">{t("meetings.ai.sectionEmpty")}</p> : <ul className="mt-2 space-y-3">{children}</ul>}
  </div>;
}

export function ResumoDaReuniaoPelaIA({ meetingId }: { meetingId: string }) {
  const { t, i18n } = useTranslation();
  const resumir = trpc.meetings.resumir.useMutation();
  const resumo = resumir.isPending ? undefined : resumir.data;
  return <section aria-labelledby="resumo-da-reuniao" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 id="resumo-da-reuniao" className="inline-flex items-center gap-2 font-semibold text-amber-100"><Sparkles size={16}/>{t("meetings.ai.summaryTitle")}</h2>
        <p className="mt-1 text-sm text-white/55">{t("meetings.ai.summaryIntro")}</p>
      </div>
      <button type="button" onClick={() => resumir.mutate({ meetingId, idioma: idiomaDaTela(i18n) })} disabled={resumir.isPending}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {resumir.isPending ? <Loader2 size={15} className="animate-spin"/> : <Sparkles size={15}/>} {resumo ? t("meetings.ai.regenerateSummary") : t("meetings.ai.generateSummary")}
      </button>
    </div>
    {resumir.isPending && <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.ai.generatingSummary")}</p>}
    {resumir.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, resumir.error, t("meetings.ai.summaryError"))}</p>}
    {resumo && <div className="mt-4 space-y-5">
      <AvisoDeConferir/>
      <SecaoDoResumo titulo={t("meetings.ai.topicsHeading")} vazia={!resumo.topicos.length}>
        {resumo.topicos.map((topico, i) => <li key={i}>
          <p className="font-medium text-white/90">{topico.titulo}</p>
          <p className="mt-0.5 text-sm text-white/70">{topico.resumo}</p>
          <Trecho texto={topico.trecho}/>
        </li>)}
      </SecaoDoResumo>
      <SecaoDoResumo titulo={t("meetings.ai.decisionsHeading")} vazia={!resumo.decisoes.length}>
        {resumo.decisoes.map((decisao, i) => <li key={i}>
          <p className="text-sm text-white/85">{decisao.texto}</p>
          <Trecho texto={decisao.trecho}/>
        </li>)}
      </SecaoDoResumo>
      <SecaoDoResumo titulo={t("meetings.ai.tasksHeading")} vazia={!resumo.tarefas.length}>
        {resumo.tarefas.map((tarefa, i) => <li key={i}>
          <p className="text-sm text-white/85">{tarefa.oQue}</p>
          {(tarefa.quem || tarefa.quando) && <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-100/70">
            {tarefa.quem && <span>{t("meetings.ai.taskWho", { who: tarefa.quem })}</span>}
            {tarefa.quando && <span>{t("meetings.ai.taskWhen", { when: tarefa.quando })}</span>}
          </p>}
          <Trecho texto={tarefa.trecho}/>
        </li>)}
      </SecaoDoResumo>
    </div>}
  </section>;
}

export function PergunteAReuniao({ meetingId }: { meetingId: string }) {
  const { t, i18n } = useTranslation();
  const [pergunta, setPergunta] = useState("");
  // A pergunta que gerou a resposta na tela: o campo pode já ter outra.
  const [perguntaFeita, setPerguntaFeita] = useState("");
  const perguntar = trpc.meetings.perguntar.useMutation();
  const resposta = perguntar.isPending ? undefined : perguntar.data;
  const podePerguntar = pergunta.trim().length >= 2 && !perguntar.isPending;

  function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (!podePerguntar) return;
    const texto = pergunta.trim();
    setPerguntaFeita(texto);
    perguntar.mutate({ meetingId, idioma: idiomaDaTela(i18n), pergunta: texto });
  }

  return <section aria-labelledby="pergunte-a-reuniao" className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
    <h2 id="pergunte-a-reuniao" className="inline-flex items-center gap-2 font-semibold"><MessageCircleQuestion size={16} className="text-amber-300"/>{t("meetings.ai.askTitle")}</h2>
    <p className="mt-1 text-sm text-white/55">{t("meetings.ai.askIntro")}</p>
    <form onSubmit={enviar} className="mt-4 flex flex-col gap-2 sm:flex-row">
      <input aria-label={t("meetings.ai.askLabel")} value={pergunta} onChange={evento => setPergunta(evento.target.value)} maxLength={500}
        placeholder={t("meetings.ai.askPlaceholder")}
        className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-amber-300"/>
      <button type="submit" disabled={!podePerguntar}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {perguntar.isPending ? <Loader2 size={15} className="animate-spin"/> : <Send size={15}/>} {t("meetings.ai.askButton")}
      </button>
    </form>
    {perguntar.isPending && <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.ai.asking")}</p>}
    {perguntar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, perguntar.error, t("meetings.ai.askError"))}</p>}
    {resposta && <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/10 p-4">
      {perguntaFeita && <p className="text-xs text-white/45">{perguntaFeita}</p>}
      {resposta.respondida ? <>
        <p className="text-sm leading-6 text-white/85">{resposta.resposta}</p>
        <Trecho texto={resposta.trecho}/>
        <AvisoDeConferir/>
      </> : <p className="text-sm text-white/60">{t("meetings.ai.notAnswered")}</p>}
    </div>}
  </section>;
}
