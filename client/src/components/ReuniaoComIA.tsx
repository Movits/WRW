import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Loader2, MessageCircleQuestion, Play, Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { mmss } from "@/components/TranscricaoPorFalante";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * O "Pergunte à reunião" (H6 do desenho do gravador), no detalhe de uma reunião
 * pronta com transcrição. A IA lê a transcrição no servidor e responde só para
 * a tela: nada é gravado, nem no servidor nem no navegador. A resposta traz de
 * 1 a 3 trechos que a sustentam, para conferir (nada extraído por IA entra
 * sozinho), cada um com o "▶ mm:ss" que leva o player único do rodapé ao ponto
 * em que foi dito.
 *
 * Serve também à página do link aberto (pages/ReuniaoAberta.tsx): a dona pede
 * pelo id da reunião, e quem abriu o link, pelo token dele. As vozes chegam
 * como rótulo ({F2}) e viram o nome que a dona deu (ou "Falante 2"), também no
 * link, que recebe os nomes só quando foi ligado com a confirmação que fala
 * deles (H3b). Os nomes só trocam o rótulo na tela: nunca vão à IA. O trecho,
 * o tempo, o aviso de conferir e as frases de erro da IA servem também ao
 * resumo guardado (components/ResumoGuardado.tsx).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type IdiomaDaTela = "pt-BR" | "en" | "es" | "fr" | "de" | "ar" | "zh" | "hi" | "ja" | "ru";
type FonteDaReuniao =
  | {
      meetingId: string;
      token?: undefined;
      /** Os nomes que a dona deu às vozes (nomesDosFalantes(meeting.speakerNames)). */
      nomes?: Readonly<Record<string, string>>;
      aoIrPara?: (segundo: number) => void;
      /** A reunião do YouTube (H13): o "▶" abre o vídeo no segundo (TempoDoTrecho). */
      linkDoTempo?: (segundo: number) => string;
      /** A reunião nasceu de um documento (H12): os textos falam do documento, e não do que foi dito. */
      documento?: boolean;
    }
  | {
      token: string;
      meetingId?: undefined;
      /** Os nomes das vozes que o link recebeu (o `vozes` de reuniaoAberta.ver, H3b). */
      nomes?: Readonly<Record<string, string>>;
      aoIrPara?: (segundo: number) => void;
      linkDoTempo?: (segundo: number) => string;
      documento?: boolean;
    };

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
    // Só a pergunta recusa assim: a reunião passa do que a IA lê de uma vez.
    case "PAYLOAD_TOO_LARGE": return t("meetings.ai.tooLong");
    // Teto de pedidos à IA: a mesma frase do assistente de texto, já nos 10 idiomas.
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    // Pelo link, NOT_FOUND é o link desligado no meio da visita.
    case "NOT_FOUND": return peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return padrao;
  }
}

/**
 * O trecho literal da transcrição que sustenta o item: é por ele que a dona
 * confere. Na reunião de documento (H12), o trecho é do texto do documento.
 */
export function Trecho({ texto, documento = false }: { texto: string; documento?: boolean }) {
  const { t } = useTranslation();
  return <div className="mt-2 border-l-2 border-amber-300/40 pl-3">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{documento ? t("meetings.document.excerptLabel") : t("meetings.ai.excerptLabel")}</p>
    <q dir="auto" className="text-xs italic text-white/55">{texto}</q>
  </div>;
}

/**
 * O "▶ mm:ss" de um trecho, que leva o player único do rodapé ao segundo em
 * que ele começa. Sem player (a gravação venceu ou não existe), o tempo é só
 * informação: nada de botão desligado anunciando "Ouvir". Na reunião que veio
 * de um vídeo do YouTube (H13) não há player: `linkDoTempo` dá o endereço do
 * vídeo naquele segundo, e o "▶" é um link que o abre numa aba nova.
 */
export function TempoDoTrecho({ segundos, aoIrPara, linkDoTempo }: { segundos: number; aoIrPara?: (segundo: number) => void; linkDoTempo?: (segundo: number) => string }) {
  const { t } = useTranslation();
  if (linkDoTempo) {
    return <a href={linkDoTempo(segundos)} target="_blank" rel="noopener noreferrer"
      aria-label={t("meetings.youtube.watchFrom", { tempo: mmss(segundos) })}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10">
      <Play size={11} aria-hidden/>{mmss(segundos)}
    </a>;
  }
  return aoIrPara
    ? <button type="button" onClick={() => aoIrPara(segundos)}
        aria-label={t("meetings.playFrom", { tempo: mmss(segundos) })}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs text-amber-300 hover:bg-amber-300/10">
        <Play size={11} aria-hidden/>{mmss(segundos)}
      </button>
    : <span className="px-1.5 py-0.5 font-mono text-xs text-white/40">{mmss(segundos)}</span>;
}

type Citacao = { trecho: string; inicioSegundos: number | null };

/**
 * As citações da resposta. O servidor de antes da H6 manda só o `trecho` (o
 * deploy no meio do caminho, por exemplo): ele vira uma citação sem tempo, em
 * vez de a tela quebrar com a lista que não veio.
 */
function citacoesDaResposta(resposta: { citacoes?: readonly Citacao[] | null; trecho?: string | null }): readonly Citacao[] {
  if (Array.isArray(resposta.citacoes)) return resposta.citacoes;
  return resposta.trecho ? [{ trecho: resposta.trecho, inicioSegundos: null }] : [];
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
  // O documento (H12) não tem transcrição nem "o que foi dito": os textos falam
  // dele (conferência de tela de 20/11/2026).
  const documento = !!fonte.documento;
  const perguntar = peloLink ? perguntarPeloLink : perguntarDaDona;
  const resposta = perguntar.isPending ? undefined : perguntar.data;
  const citacoes = resposta?.respondida ? citacoesDaResposta(resposta) : [];
  const podePerguntar = pergunta.trim().length >= 2 && !perguntar.isPending;
  // Para a dona, os nomes que ela deu; pelo link, os que o servidor mandou.
  const nomes = fonte.nomes ?? {};
  const comVozes = (texto: string) => vozesNoTexto(texto, nomes, numero => t("meetings.speakerLabel", { n: numero }));
  const idDasCitacoes = useId();

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
    <h2 id="pergunte-a-reuniao" className="inline-flex items-center gap-2 text-base font-semibold"><MessageCircleQuestion size={16} className="text-amber-300"/>{documento ? t("meetings.document.askTitle") : t("meetings.ai.askTitle")}</h2>
    <p className="mt-1 text-sm text-white/55">{documento ? t("meetings.document.askIntro") : t("meetings.ai.askIntro")}</p>
    <form onSubmit={enviar} className="mt-4 flex flex-col gap-2 sm:flex-row">
      <input aria-label={documento ? t("meetings.document.askLabel") : t("meetings.ai.askLabel")} value={pergunta} onChange={evento => setPergunta(evento.target.value)} maxLength={500}
        placeholder={t("meetings.ai.askPlaceholder")}
        className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-amber-300"/>
      <button type="submit" disabled={!podePerguntar}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {perguntar.isPending ? <Loader2 size={15} className="animate-spin"/> : <Send size={15}/>} {t("meetings.ai.askButton")}
      </button>
    </form>
    {perguntar.isPending && <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{documento ? t("meetings.document.asking") : t("meetings.ai.asking")}</p>}
    {perguntar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, perguntar.error, t("meetings.ai.askError"), peloLink)}</p>}
    {resposta && <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/10 p-4">
      {perguntaFeita && <p dir="auto" className="text-xs text-white/45">{perguntaFeita}</p>}
      {resposta.respondida ? <>
        <p dir="auto" className="text-sm leading-6 text-white/85">{comVozes(resposta.resposta)}</p>
        {/* Os trechos ficam como a transcrição os tem: é por eles que se confere. */}
        {citacoes.length > 0 && <div className="border-l-2 border-amber-300/40 pl-3">
          <p id={idDasCitacoes} className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{documento ? t("meetings.document.sourcesLabel") : t("meetings.ai.sourcesLabel")}</p>
          <ul aria-labelledby={idDasCitacoes} className="mt-1 space-y-1.5">
            {citacoes.map((citacao, i) => <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {citacao.inicioSegundos !== null && <TempoDoTrecho segundos={citacao.inicioSegundos} aoIrPara={fonte.aoIrPara} linkDoTempo={fonte.linkDoTempo}/>}
              <q dir="auto" className="text-xs italic text-white/55">{citacao.trecho}</q>
            </li>)}
          </ul>
        </div>}
        {/* Pelo link aberto, quem lê não tem conta nem rede na WRW: o aviso da dona ("não entra na sua rede") não vale. */}
        <AvisoDeConferir>{peloLink
          ? (documento ? t("meetings.document.openLinkReviewNotice") : t("meetings.openLink.reviewNotice"))
          : (documento ? t("meetings.document.aiReviewNotice") : t("meetings.ai.reviewNotice"))}</AvisoDeConferir>
      </> : <p className="text-sm text-white/60">{documento ? t("meetings.document.notAnswered") : t("meetings.ai.notAnswered")}</p>}
    </div>}
  </section>;
}
