import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "wouter";
import { Clock3, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { BrandLogo } from "@/components/BrandLogo";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ERRO_DE_CONSULTA } from "@shared/const";
import { PergunteAReuniao, ResumoDaReuniaoPelaIA } from "@/components/ReuniaoComIA";

/**
 * A reunião aberta pelo link (pedido do Roberto em 12/11/2026, "por enquanto"):
 * quem recebeu o endereço /r/{token} ouve a gravação, lê e traduz a
 * transcrição e pede à IA o resumo e respostas, sem conta na WRW. Só leitura:
 * excluir, reprocessar e o que é da rede particular da dona (contatos e
 * entidades) ficam no detalhe dela, em Meetings.tsx, e o servidor nem manda
 * esses dados para cá (server/link-aberto-da-reuniao.ts).
 *
 * O player e a tradução repetem os do detalhe da dona; o detalhe único da D1
 * (docs/arquitetura/gravador-de-reunioes.md) junta as duas telas.
 */

type IdiomaDaTraducao = "en" | "es" | "fr" | "de" | "ar" | "zh" | "hi" | "ja" | "ru";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;
// Link que não existe, desligado ou cortado: definitivo, sem tentar de novo.
const linkNaoAbre = (erro: unknown) => codigoDoErro(erro) === "NOT_FOUND" || codigoDoErro(erro) === "BAD_REQUEST";

// A frase pelo código: o teto, o link desligado e o banco fora do ar pedem
// coisas diferentes de quem lê. Mensagem de servidor que a tela não conhece
// não aparece crua: vira a frase geral da tradução.
function mensagemDaTraducao(t: TranslateFn, erro: unknown) {
  switch (codigoDoErro(erro)) {
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    case "NOT_FOUND": return t("meetings.openLink.notFound");
    case "INTERNAL_SERVER_ERROR": {
      // Só as duas frases do banco que a tela conhece (em pt-BR a tradução é
      // o próprio texto, por isso a comparação é com a constante).
      const mensagem = (erro as { message?: unknown } | null)?.message;
      return mensagem === MENSAGEM_BANCO_INDISPONIVEL || mensagem === MENSAGEM_ERRO_DE_CONSULTA
        ? mensagemDeErroParaTela(erro, t)
        : t("meetings.translateError");
    }
    default: return t("meetings.translateError");
  }
}

function duracao(segundos: number) {
  return `${String(Math.floor(segundos / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`;
}

function Moldura({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-5xl mx-auto">
    <a href="/" aria-label="WRW" className="inline-block mb-8"><BrandLogo variante="lockup" className="w-36"/></a>
    {children}
  </div></main>;
}

export default function ReuniaoAberta() {
  const { token = "" } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError, error, refetch } = trpc.reuniaoAberta.ver.useQuery({ token }, {
    retry: (tentativas, erro) => !linkNaoAbre(erro) && tentativas < 3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: consulta => !linkNaoAbre(consulta.state.error),
  });
  const [falhaNoAudio, setFalhaNoAudio] = useState(false);
  // Como no detalhe da dona: a tradução começa no idioma da tela, e pt-BR é o
  // texto original.
  const idiomaAtual = i18n.resolvedLanguage ?? i18n.language;
  const [idiomaDaTraducao, setIdiomaDaTraducao] = useState(LANGUAGES.some(idioma => idioma.code === idiomaAtual) ? idiomaAtual : "pt-BR");
  const [textoTraduzido, setTextoTraduzido] = useState<string | null>(null);
  const traduzir = trpc.reuniaoAberta.traduzir.useMutation();
  const temTranscricao = !!data?.transcricao;
  // O callback do próprio mutate só dispara para o ÚLTIMO pedido: a tradução
  // de um idioma trocado no meio do caminho não sobrescreve a do atual.
  const pedirTraducao = () => traduzir.mutate(
    { token, language: idiomaDaTraducao as IdiomaDaTraducao },
    { onSuccess: resultado => setTextoTraduzido(resultado.text) },
  );
  useEffect(() => {
    setTextoTraduzido(null);
    // De volta ao original, o erro da tradução anterior sai junto.
    if (!temTranscricao || idiomaDaTraducao === "pt-BR") { traduzir.reset(); return; }
    pedirTraducao();
  }, [temTranscricao, token, idiomaDaTraducao]);

  if (isError && linkNaoAbre(error)) return <Moldura>
    <div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
      <p className="text-sm text-white/75">{t("meetings.openLink.notFound")}</p>
      <a href="/" className="mt-4 inline-block text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.openLink.goHome")}</a>
    </div>
  </Moldura>;
  if (isError && !data) return <Moldura><ErroDeConsulta erro={error} aoTentarDeNovo={() => refetch()}/></Moldura>;
  if (isLoading || !data) return <main className="min-h-screen grid place-items-center text-white"><Loader2 className="animate-spin"/></main>;

  const { titulo, criadaEm, transcricao, gravacao, gravacaoExpirada } = data;
  const textoNaTela = idiomaDaTraducao === "pt-BR" ? transcricao?.texto : textoTraduzido;
  // O idioma do texto que está na tela, para o leitor de tela e a hifenização;
  // a direção vem do próprio texto (dir="auto"), não da tela: português numa
  // tela em árabe continua da esquerda para a direita.
  const idiomaDoOriginal = transcricao?.idioma === "pt" ? "pt-BR" : transcricao?.idioma ?? undefined;
  const idiomaNaTela = textoTraduzido && idiomaDaTraducao !== "pt-BR" ? idiomaDaTraducao : idiomaDoOriginal;
  return <Moldura>
    <p className="text-amber-300 text-xs font-semibold">{t("meetings.openLink.eyebrow")}</p>
    <h1 dir="auto" className="text-3xl font-bold mt-1">{titulo}</h1>
    <p className="text-sm text-white/45 mt-2">{new Date(criadaEm).toLocaleString(i18n.language)}</p>
    <p className="mt-4 max-w-3xl text-sm text-white/60">{t("meetings.openLink.intro")}</p>

    {transcricao?.texto?.trim() && <div className="mt-6 space-y-4"><ResumoDaReuniaoPelaIA token={token}/><PergunteAReuniao token={token}/></div>}

    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <h2 className="text-base font-semibold">{t("meetings.recordingHeading")}</h2>
      {gravacao ? <>
        <audio controls preload="metadata" src={gravacao.url} className="w-full mt-4"
          onError={() => setFalhaNoAudio(true)} onLoadedData={() => setFalhaNoAudio(false)}>
          {t("meetings.audioNotSupported")}
        </audio>
        {falhaNoAudio
          ? <p className="text-xs text-amber-200/80 mt-2">{t("meetings.openLink.audioLoadError")}</p>
          : <p className="text-xs text-white/45 mt-2">{t("meetings.durationLabel")} {duracao(gravacao.durationSeconds)} {t("meetings.availableUntil")} {new Date(gravacao.expiresAt).toLocaleDateString(i18n.language)}</p>}
      </> : <p className="text-sm text-white/50 mt-3">{gravacaoExpirada
        ? (transcricao ? t("meetings.recordingExpiredNotice") : t("meetings.recordingExpiredNoTranscript"))
        : t("meetings.noRecordingStored")}</p>}
    </section>

    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <h2 className="inline-flex items-center gap-2 text-base font-semibold mb-4"><Clock3 size={16}/>{t("meetings.transcriptTab")}</h2>
      {transcricao ? <>
        <div className="mb-5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4">
          <p className="font-semibold text-amber-100">{t("meetings.translateHeading")}</p>
          <p className="mt-1 text-sm text-amber-100/70">{t("meetings.openLink.translateSubtext")}</p>
          <label className="mt-3 flex flex-col gap-2 text-sm text-white/75 sm:flex-row sm:items-center">{t("meetings.targetLanguageLabel")}
            <select value={idiomaDaTraducao} onChange={evento => setIdiomaDaTraducao(evento.target.value)} className="rounded-lg bg-[#211e1b] border border-white/15 px-3 py-2 text-white">
              {LANGUAGES.map(idioma => <option className="bg-white text-[#322C26]" key={idioma.code} value={idioma.code}>{idioma.flag} {idioma.label}</option>)}
            </select>
          </label>
        </div>
        {traduzir.isPending
          ? <div role="status" className="text-white/55"><Loader2 className="inline animate-spin mr-2" size={16}/>{t("meetings.translatingStatus")}</div>
          : <>
            {traduzir.isError && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 text-sm text-amber-200/80">
              <span>{mensagemDaTraducao(t, traduzir.error)}</span>
              <button type="button" onClick={pedirTraducao} className="rounded-lg border border-amber-300/30 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-300/10">
                {t("errorBoundary.retryButton")}
              </button>
            </div>}
            <p dir="auto" lang={idiomaNaTela} className="whitespace-pre-wrap leading-7 text-white/75">{textoNaTela || transcricao.texto}</p>
          </>}
      </> : <p className="text-white/45">{t("meetings.transcriptUnavailable")}</p>}
    </section>
  </Moldura>;
}
