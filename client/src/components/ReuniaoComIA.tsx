import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Loader2, MessageCircleQuestion, Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

/**
 * O "Pergunte à reunião", no detalhe de uma reunião pronta com transcrição. A
 * IA lê a transcrição no servidor e responde só para a tela: nada é gravado, e
 * a resposta traz o trecho que a sustenta para a dona conferir (nada extraído
 * por IA entra sozinho).
 *
 * Serve também à página do link aberto (pages/ReuniaoAberta.tsx): a dona pede
 * pelo id da reunião, e quem abriu o link, pelo token dele. O trecho, o aviso
 * de conferir e as frases de erro da IA servem também ao resumo guardado
 * (components/ResumoGuardado.tsx).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type IdiomaDaTela = "pt-BR" | "en" | "es" | "fr" | "de" | "ar" | "zh" | "hi" | "ja" | "ru";
type FonteDaReuniao = { meetingId: string; token?: undefined } | { token: string; meetingId?: undefined };

// O idioma RESOLVIDO, como na tradução da transcrição: "en-US" cai fora da lista.
function idiomaDaTela(i18n: { resolvedLanguage?: string; language: string }): IdiomaDaTela {
  const atual = i18n.resolvedLanguage ?? i18n.language;
  return (LANGUAGES.some(idioma => idioma.code === atual) ? atual : "pt-BR") as IdiomaDaTela;
}

// O código tRPC decide a frase: as mensagens do servidor vêm em português.
// Banco fora do ar chega como INTERNAL_SERVER_ERROR com a frase conhecida, que
// mensagemDeErroParaTela traduz.
export function mensagemDoErroDaIA(t: TranslateFn, erro: unknown, padrao: string, peloLink: boolean) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "SERVICE_UNAVAILABLE": return t("meetings.ai.unavailable");
    case "PRECONDITION_FAILED": return t("meetings.ai.needsTranscript");
    // Teto de pedidos à IA: a mesma frase do assistente de texto, já nos 10 idiomas.
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    // Pelo link, NOT_FOUND é o link desligado no meio da visita.
    case "NOT_FOUND": return peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return padrao;
  }
}

/** O trecho literal da transcrição que sustenta o item: é por ele que a dona confere. */
export function Trecho({ texto }: { texto: string }) {
  const { t } = useTranslation();
  return <div className="mt-2 border-l-2 border-amber-300/40 pl-3">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{t("meetings.ai.excerptLabel")}</p>
    <q dir="auto" className="text-xs italic text-white/55">{texto}</q>
  </div>;
}

/** A caixa do aviso de conferir o que a IA escreveu; quem chama escolhe a frase, que muda com quem lê. */
export function AvisoDeConferir({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100/80"><CircleAlert size={14} className="mr-1.5 inline"/>{children}</p>;
}

export function PergunteAReuniao(fonte: FonteDaReuniao) {
  const { t, i18n } = useTranslation();
  const [pergunta, setPergunta] = useState("");
  // A pergunta que gerou a resposta na tela: o campo pode já ter outra.
  const [perguntaFeita, setPerguntaFeita] = useState("");
  const perguntarDaDona = trpc.meetings.perguntar.useMutation();
  const perguntarPeloLink = trpc.reuniaoAberta.perguntar.useMutation();
  const peloLink = fonte.token !== undefined;
  const perguntar = peloLink ? perguntarPeloLink : perguntarDaDona;
  const resposta = perguntar.isPending ? undefined : perguntar.data;
  const podePerguntar = pergunta.trim().length >= 2 && !perguntar.isPending;

  function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (!podePerguntar) return;
    const texto = pergunta.trim();
    setPerguntaFeita(texto);
    const idioma = idiomaDaTela(i18n);
    if (fonte.token !== undefined) perguntarPeloLink.mutate({ token: fonte.token, idioma, pergunta: texto });
    else perguntarDaDona.mutate({ meetingId: fonte.meetingId, idioma, pergunta: texto });
  }

  return <section aria-labelledby="pergunte-a-reuniao" className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
    <h2 id="pergunte-a-reuniao" className="inline-flex items-center gap-2 text-base font-semibold"><MessageCircleQuestion size={16} className="text-amber-300"/>{t("meetings.ai.askTitle")}</h2>
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
    {perguntar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, perguntar.error, t("meetings.ai.askError"), peloLink)}</p>}
    {resposta && <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/10 p-4">
      {perguntaFeita && <p dir="auto" className="text-xs text-white/45">{perguntaFeita}</p>}
      {resposta.respondida ? <>
        <p dir="auto" className="text-sm leading-6 text-white/85">{resposta.resposta}</p>
        <Trecho texto={resposta.trecho}/>
        {/* Pelo link aberto, quem lê não tem conta nem rede na WRW: o aviso da dona ("não entra na sua rede") não vale. */}
        <AvisoDeConferir>{peloLink ? t("meetings.openLink.reviewNotice") : t("meetings.ai.reviewNotice")}</AvisoDeConferir>
      </> : <p className="text-sm text-white/60">{t("meetings.ai.notAnswered")}</p>}
    </div>}
  </section>;
}
