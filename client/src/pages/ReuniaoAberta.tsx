import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "wouter";
import { Clock3, FileText, Loader2, Network, ScanText } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { useNovaTentativa } from "@/hooks/useNovaTentativa";
import { useTraducaoDoResumo } from "@/hooks/useTraducaoDoResumo";
import type { ControleDoPlayer } from "@/components/PlayerDasPartes";
import { BarraDoPlayer, ESPACO_DA_BARRA_DO_PLAYER } from "@/components/BarraDoPlayer";
import { mmss, segmentosValidos, TranscricaoPorFalante } from "@/components/TranscricaoPorFalante";
import { AvisoDeTraducao } from "@/components/AvisoDeTraducao";
import { BrandLogo } from "@/components/BrandLogo";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ERRO_DE_CONSULTA } from "@shared/const";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { OpcaoDoIdiomaOriginal } from "@/components/SeletorDoIdiomaDaReuniao";
import { PergunteAReuniao } from "@/components/ReuniaoComIA";
import { ResumoGuardado } from "@/components/ResumoGuardado";
import { AnexosDoResumo } from "@/components/AnexosDoResumo";
import { MapaMentalDaReuniao } from "@/components/MapaMental";
import { SenhaDoLinkAberto } from "@/components/SenhaDoLinkAberto";
import { VideoDoYoutube } from "@/components/VideoDoYoutube";
import { linkDoYoutubeNoSegundo } from "@shared/youtube";

/**
 * A reunião aberta pelo link (pedido do Roberto em 12/11/2026, "por enquanto"):
 * quem recebeu o endereço /r/{token} ouve a gravação, lê e traduz a
 * transcrição, lê o resumo guardado e o mapa mental (e pede o que a reunião
 * ainda não tem) e faz perguntas à IA, sem conta na Marquesa Global Match. Só leitura:
 * excluir, reprocessar e o que é da rede particular da dona (contatos e
 * entidades) ficam no detalhe dela, em Meetings.tsx, e o servidor nem manda
 * esses dados para cá (server/link-aberto-da-reuniao.ts). Os nomes que a dona
 * deu às vozes chegam no `vozes` (H3b, decisão do Roberto de 16/11/2026), só
 * quando ela ligou o link com a confirmação que fala deles; sem nome, cada voz
 * é "Falante n". A reunião que nasceu de um documento (H12 e H12b) mostra o
 * texto lido no lugar da transcrição, sem player e sem o arquivo.
 *
 * O player e a tradução repetem os do detalhe da dona; o detalhe único da D1
 * (docs/arquitetura/gravador-de-reunioes.md) junta as duas telas.
 *
 * O link com senha (H23) responde UNAUTHORIZED até quem o recebeu acertar os 6
 * dígitos: a página mostra só a tela da senha (SenhaDoLinkAberto) e, com a
 * senha certa, relê a reunião. Se a entrada vencer com a página aberta (o
 * cookie dura 12 horas) ou a dona trocar a senha, a próxima chamada que recusar
 * traz a tela da senha de volta: o resumo, as duas traduções, o mapa mental, a
 * pergunta e o áudio (que, sem a entrada, não carrega). Com a senha de novo, o
 * que recusou pede outra vez. O link sem o áudio não traz a gravação: a página
 * diz isso no lugar do player (meetings.openLink.introWithoutAudio e
 * audioNotIncluded, que esperam a revisão da Cris com os outros textos da H23).
 */


type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;
// Link que não existe, desligado ou cortado: definitivo, sem tentar de novo.
const linkNaoAbre = (erro: unknown) => codigoDoErro(erro) === "NOT_FOUND" || codigoDoErro(erro) === "BAD_REQUEST";
// O link pede a senha (H23): também sem tentar de novo, até quem lê digitá-la.
const pedeSenha = (erro: unknown) => codigoDoErro(erro) === "UNAUTHORIZED";
const naoTentarDeNovo = (erro: unknown) => linkNaoAbre(erro) || pedeSenha(erro);

// A frase pelo código: o teto, o link desligado e o banco fora do ar pedem
// coisas diferentes de quem lê. Mensagem de servidor que a tela não conhece
// não aparece crua: vira a frase geral da tradução.
function mensagemDaTraducao(t: TranslateFn, erro: unknown) {
  switch (codigoDoErro(erro)) {
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    case "NOT_FOUND": return t("meetings.openLink.notFound");
    // A entrada no link com senha venceu: a página relê a reunião e traz a tela da senha.
    case "UNAUTHORIZED": return t("meetings.openLink.password.required");
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

function Moldura({ children, comPlayer = false }: { children: React.ReactNode; comPlayer?: boolean }) {
  // Com o player fixo no rodapé, o fim da página fica livre embaixo dele.
  return <main className={`min-h-screen p-4 md:p-8 text-white bg-transparent ${comPlayer ? ESPACO_DA_BARRA_DO_PLAYER : ""}`}><div className="max-w-5xl mx-auto">
    <a href="/" aria-label="Marquesa Global Match" className="inline-block mb-8"><BrandLogo variante="lockup" className="w-36"/></a>
    {children}
  </div></main>;
}

export default function ReuniaoAberta() {
  const { token = "" } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError, error, refetch } = trpc.reuniaoAberta.ver.useQuery({ token }, {
    retry: (tentativas, erro) => !naoTentarDeNovo(erro) && tentativas < 3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: consulta => !naoTentarDeNovo(consulta.state.error),
  });
  // O resumo guardado (H4), só leitura: sem ids, sem os ignorados e com as
  // vozes como rótulo ({F2}), que o componente troca pelo nome do `vozes` ou
  // por "Falante n". Pergunta de novo a cada 5 s enquanto ele está na
  // fila ou sendo gerado, e para em qualquer erro, não só no link desligado: a
  // página não pede conta, e um 500 que persiste deixaria cada visitante
  // perguntando ao servidor para sempre. O erro só chega ao estado depois das
  // novas tentativas do retry; a releitura que dá certo (o tentar de novo, a
  // reconexão) o limpa e religa a repetição.
  const temTextoParaResumir = !!data?.transcricao?.texto?.trim();
  const resumoGuardado = trpc.reuniaoAberta.resumoGuardado.useQuery({ token }, {
    enabled: temTextoParaResumir,
    retry: (tentativas, erro) => !naoTentarDeNovo(erro) && tentativas < 3,
    refetchOnWindowFocus: false,
    refetchInterval: consulta => {
      const estado = consulta.state.data?.estado;
      return (estado === "pendente" || estado === "gerando") && !consulta.state.error ? 5_000 : false;
    },
  });
  // A tradução do resumo (H11) para o idioma de quem lê, como no detalhe da
  // dona: sem ids e sem os ignorados, e só gasta vaga do teto quando a IA
  // traduz de fato.
  // Os rótulos do mapa mental pronto (H10), que a aba do mapa informa: a
  // tradução os traduz junto com o resumo.
  const [rotulosDoMapa, setRotulosDoMapa] = useState<string[]>();
  const traducaoDoResumo = useTraducaoDoResumo({ token }, temTextoParaResumir ? resumoGuardado.data : undefined, rotulosDoMapa);
  const [falhaNoAudio, setFalhaNoAudio] = useState(false);
  const player = useRef<ControleDoPlayer | null>(null);
  // D2: a voz que o player toca sozinha (nula: todas), como no detalhe da dona.
  // Só troca o que toca e o que a lista mostra: os dados são os que o link já recebe.
  const [soAVoz, setSoAVoz] = useState<string | null>(null);
  // As abas, como no app de referência da cliente (H4c): o resumo abre
  // primeiro, e a transcrição e o mapa mental (H10) ficam nas outras. O player
  // é um só, na barra do rodapé, fora das abas: trocar de aba não corta o
  // áudio. A tradução mora aqui em cima e também sobrevive à troca.
  const [aba, setAba] = useState<"summary" | "transcript" | "mindmap">("summary");
  // Como no detalhe da dona: a tradução começa no idioma da tela, e o idioma
  // em que a reunião foi transcrita é o texto original.
  const idiomaAtual = i18n.resolvedLanguage ?? i18n.language;
  const [idiomaDaTraducao, setIdiomaDaTraducao] = useState(LANGUAGES.some(idioma => idioma.code === idiomaAtual) ? idiomaAtual : "pt-BR");
  // O "Ver original" some com o aviso de tradução e deixa o foco aqui (T25).
  const seletorDaTraducao = useRef<HTMLSelectElement>(null);
  const [textoTraduzido, setTextoTraduzido] = useState<string | null>(null);
  const traduzir = trpc.reuniaoAberta.traduzir.useMutation();
  // Reunião longa: a tradução segue em segundo plano no servidor, que responde
  // "em andamento"; a página pergunta de novo a cada 5 s, sem gastar vaga do teto.
  const traducaoLonga = useNovaTentativa(`${token}|${idiomaDaTraducao}`);
  const temTranscricao = !!data?.transcricao;
  // Reunião antiga guarda 'pt'. G16: o original pode ser um idioma fora dos 10
  // da tela, que a lista de tradução ganha como opção à parte.
  const idiomaDoOriginal = idiomaFalado(data?.transcricao?.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  // O callback do próprio mutate só dispara para o ÚLTIMO pedido: a tradução
  // de um idioma trocado no meio do caminho não sobrescreve a do atual.
  const pedirTraducao = () => traduzir.mutate(
    { token, language: idiomaDaTraducao as IdiomaDaReuniao },
    {
      onSuccess: resultado => {
        if (resultado.emAndamento) return traducaoLonga.agendar();
        traducaoLonga.parar();
        setTextoTraduzido(resultado.text);
      },
      onError: () => traducaoLonga.parar(),
    },
  );
  // A entrada no link com senha venceu com a página aberta (ou a dona trocou a
  // senha): o resumo (que se relê sozinho enquanto é gerado) ou uma das
  // traduções recusam com UNAUTHORIZED, e a releitura da reunião traz a tela da
  // senha. O mapa mental e a pergunta avisam pelo aoPedirSenha; o áudio que
  // não carrega relê também.
  const entradaVencida = pedeSenha(resumoGuardado.error) || pedeSenha(traduzir.error) || pedeSenha(traducaoDoResumo.erro);
  useEffect(() => {
    if (entradaVencida) void refetch();
  }, [entradaVencida]);
  const pedirASenhaDeNovo = () => { void refetch(); };
  useEffect(() => {
    setTextoTraduzido(null);
    // De volta ao original, o erro da tradução anterior sai junto.
    if (!temTranscricao || idiomaDaTraducao === idiomaDoOriginal) { traducaoLonga.parar(); traduzir.reset(); return; }
    pedirTraducao();
  }, [temTranscricao, token, idiomaDaTraducao, idiomaDoOriginal, traducaoLonga.tentativa]);

  // Com a senha certa, a reunião se relê, e o que recusou com a entrada
  // vencida pede de novo. A tradução da transcrição é pedida aqui: o efeito que
  // a pede não roda sozinho, porque nada nas dependências dele mudou.
  const utils = trpc.useUtils();
  const depoisDaSenha = () => {
    void refetch();
    // As fotos e os desenhos do resumo (H4g e H4h) pedem a entrada também.
    void utils.reuniaoAberta.anexos.invalidate({ token });
    if (pedeSenha(resumoGuardado.error)) void resumoGuardado.refetch();
    if (pedeSenha(traduzir.error)) {
      if (temTranscricao && idiomaDaTraducao !== idiomaDoOriginal) pedirTraducao();
      else traduzir.reset();
    }
    if (pedeSenha(traducaoDoResumo.erro)) traducaoDoResumo.tentarDeNovo();
  };

  if (isError && linkNaoAbre(error)) return <Moldura>
    <div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
      <p className="text-sm text-white/75">{t("meetings.openLink.notFound")}</p>
      <a href="/" className="mt-4 inline-block text-sm font-semibold text-amber-300 hover:text-amber-200">{t("meetings.openLink.goHome")}</a>
    </div>
  </Moldura>;
  if (isError && pedeSenha(error)) return <Moldura>
    <SenhaDoLinkAberto token={token} aoEntrar={depoisDaSenha}/>
  </Moldura>;
  if (isError && !data) return <Moldura><ErroDeConsulta erro={error} aoTentarDeNovo={() => refetch()}/></Moldura>;
  if (isLoading || !data) return <main className="min-h-screen grid place-items-center text-white"><Loader2 className="animate-spin"/></main>;

  const { titulo, criadaEm, transcricao, gravacao, gravacaoExpirada, gravacaoSaindo } = data;
  // A dona tirou o áudio deste link (H23). A resposta de um servidor de antes
  // da H23 não traz o campo: o link levava o áudio.
  const semAudio = data.audioIncluido === false;
  // A reunião que nasceu de um documento (H12 e H12b): o link mostra o texto
  // lido e o resumo, como a transcrição de sempre, sem falar de áudio. O
  // arquivo é só da dona e nem vem do servidor. A resposta de um servidor de
  // antes da H12 não traz o campo: é reunião de áudio.
  const ehDocumento = data.documento === true;
  const rotuloDoTexto = ehDocumento ? t("meetings.document.textTab") : t("meetings.transcriptTab");
  const IconeDoTexto = ehDocumento ? ScanText : Clock3;
  // Os nomes das vozes, os mesmos no resumo, na pergunta e na transcrição. A
  // resposta de um servidor de antes da H3b não traz o campo: todas "Falante n".
  const nomes = data.vozes ?? {};
  const partes = gravacao?.partes ?? (gravacao ? [{ seq: 0, url: gravacao.url, mimeType: gravacao.mimeType, inicioSegundos: 0, duracaoSegundos: gravacao.durationSeconds }] : []);
  // A reunião que veio de um vídeo do YouTube (H13): sem player, o "▶" de cada
  // fala abre o vídeo no segundo dela. O servidor de antes da H13 não traz o campo.
  const idDoVideo = data.videoDoYoutube ?? null;
  const linkDoTempo = idDoVideo ? (segundo: number) => linkDoYoutubeNoSegundo(idDoVideo, segundo) : undefined;
  const falas = segmentosValidos(transcricao?.segmentos);
  // O nome da voz que toca sozinha (D2): o do `vozes` (H3b) ou "Falante n".
  const rotuloDaVoz = (falante: string) => nomes[falante] ?? t("meetings.speakerLabel", { n: Number(falante.replace(/^F/, "")) || 0 });
  const mostraFalas = falas.length > 0 && idiomaDaTraducao === idiomaDoOriginal;
  const textoNaTela = idiomaDaTraducao === idiomaDoOriginal ? transcricao?.texto : textoTraduzido;
  // O idioma do texto que está na tela, para o leitor de tela e a hifenização;
  // a direção vem do próprio texto (dir="auto"), não da tela: português numa
  // tela em árabe continua da esquerda para a direita.
  const idiomaNaTela = textoTraduzido && idiomaDaTraducao !== idiomaDoOriginal ? idiomaDaTraducao : idiomaDoOriginal;
  // Como no detalhe da dona (T25): a tradução na tela, ou a espera pela da
  // reunião longa, ganha o aviso com o caminho para o original.
  const traducaoNaTela = !!transcricao && idiomaDaTraducao !== idiomaDoOriginal && (!!textoTraduzido || traducaoLonga.aguardando);
  return <Moldura comPlayer={!!gravacao && partes.length > 0}>
    <p className="text-amber-300 text-xs font-semibold">{t("meetings.openLink.eyebrow")}</p>
    {/* O emoji do resumo antes do título, como no detalhe da dona. */}
    <h1 dir="auto" className="text-3xl font-bold mt-1">{temTextoParaResumir && resumoGuardado.data?.emoji && <span aria-hidden="true" className="mr-2">{resumoGuardado.data.emoji}</span>}{titulo}</h1>
    <p className="text-sm text-white/45 mt-2">{new Date(criadaEm).toLocaleString(i18n.language)}</p>
    {/* O documento e o vídeo não têm gravação: a frase deles vale com ou sem o áudio no link (H23). */}
    <p className="mt-4 max-w-3xl text-sm text-white/60">{ehDocumento ? t("meetings.document.openLinkIntro") : idDoVideo ? t("meetings.youtube.linkIntro") : semAudio ? t("meetings.openLink.introWithoutAudio") : t("meetings.openLink.intro")}</p>

    <div className="mt-6 flex gap-2 overflow-x-auto border-b border-white/10">{([["summary", t("meetings.summaryTab"), FileText], ["transcript", rotuloDoTexto, IconeDoTexto], ["mindmap", t("meetings.mindMapTab"), Network]] as const).map(([id, rotulo, Icone]) =>
      <button key={id} type="button" aria-pressed={aba === id} onClick={() => setAba(id)} className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-3 text-sm border-b-2 ${aba === id ? "border-amber-300 text-amber-300" : "border-transparent text-white/50"}`}><Icone size={16}/>{rotulo}</button>)}</div>

    {aba === "summary" && <>
      {temTextoParaResumir && <div className="mt-6 space-y-4">
        <ResumoGuardado token={token} consulta={resumoGuardado} nomes={nomes} aoIrPara={partes.length ? segundo => player.current?.irPara(segundo) : undefined} linkDoTempo={linkDoTempo} traducao={traducaoDoResumo} documento={ehDocumento}/>
        {/* As fotos e os desenhos que a dona anexou ao resumo (H4g e H4h), pela rota do link. */}
        <AnexosDoResumo token={token} aoPedirSenha={pedirASenhaDeNovo}/>
        {/* Os nomes só trocam o rótulo na tela: a pergunta vai à IA sem eles. */}
        <PergunteAReuniao token={token} nomes={nomes} aoIrPara={partes.length ? segundo => player.current?.irPara(segundo) : undefined} linkDoTempo={linkDoTempo} documento={ehDocumento} aoPedirSenha={pedirASenhaDeNovo}/>
      </div>}

      {/* A de documento não tem gravação, e o arquivo dela não sai pelo link. */}
      {!ehDocumento && <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
        {/* O vídeo do YouTube (H13) no lugar da gravação: o link para ele, sem player. */}
        {idDoVideo ? <VideoDoYoutube id={idDoVideo} peloLink/> : <>
        <h2 className="text-base font-semibold">{t("meetings.recordingHeading")}</h2>
        {gravacao ? <>
          {/* O player fica no rodapé (BarraDoPlayer), como no detalhe da dona. */}
          <p className="text-xs text-white/45 mt-2">{t("meetings.durationLabel")} {mmss(gravacao.durationSeconds)} {t("meetings.availableUntil")} {new Date(gravacao.expiresAt).toLocaleDateString(i18n.language)}</p>
        </> : <p className="text-sm text-white/50 mt-3">{semAudio ? t("meetings.openLink.audioNotIncluded") : gravacaoExpirada
          ? (transcricao ? t("meetings.recordingExpiredNotice") : t("meetings.recordingExpiredNoTranscript"))
          : gravacaoSaindo ? t("meetings.recordingDeletionPending") : t("meetings.noRecordingStored")}</p>}
        </>}
      </section>}
    </>}

    {aba === "transcript" && <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <h2 className="inline-flex items-center gap-2 text-base font-semibold mb-4"><IconeDoTexto size={16}/>{rotuloDoTexto}</h2>
      {/* H18: a dona corrigiu a transcrição; o link mostra a versão dela, e diz isso. */}
      {transcricao?.editada && <p className="-mt-2 mb-4 text-xs text-white/50">{t("meetings.editTranscript.linkPageNotice")}</p>}
      {transcricao ? <>
        <div className="mb-5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4">
          <p className="font-semibold text-amber-100">{ehDocumento ? t("meetings.document.translateHeading") : t("meetings.translateHeading")}</p>
          <p className="mt-1 text-sm text-amber-100/70">{ehDocumento ? t("meetings.document.openLinkTranslateSubtext") : t("meetings.openLink.translateSubtext")}</p>
          <label className="mt-3 flex flex-col gap-2 text-sm text-white/75 sm:flex-row sm:items-center">{t("meetings.targetLanguageLabel")}
            <select ref={seletorDaTraducao} value={idiomaDaTraducao} onChange={evento => setIdiomaDaTraducao(evento.target.value)} className="rounded-lg bg-[#211e1b] border border-white/15 px-3 py-2 text-white">
              <OpcaoDoIdiomaOriginal idioma={idiomaDoOriginal}/>
              {LANGUAGES.map(idioma => <option className="bg-white text-[#322C26]" key={idioma.code} value={idioma.code}>{idioma.flag} {idioma.label}{idioma.code === idiomaDoOriginal ? ` ${t("meetings.originalLanguageSuffix")}` : ""}</option>)}
            </select>
          </label>
        </div>
        {traducaoNaTela && <AvisoDeTraducao idioma={idiomaDaTraducao} aoVerOriginal={() => setIdiomaDaTraducao(idiomaDoOriginal)} focoDepois={seletorDaTraducao}/>}
        {traducaoLonga.aguardando
          ? <div role="status" className="text-white/55"><Loader2 className="inline animate-spin me-2" size={16}/>{t("meetings.translatingLongStatus")}</div>
          : traduzir.isPending
          ? <div role="status" className="text-white/55"><Loader2 className="inline animate-spin me-2" size={16}/>{ehDocumento ? t("meetings.document.translatingStatus") : t("meetings.translatingStatus")}</div>
          : <>
            {traduzir.isError && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 text-sm text-amber-200/80">
              <span>{mensagemDaTraducao(t, traduzir.error)}</span>
              <button type="button" onClick={pedirTraducao} className="rounded-lg border border-amber-300/30 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-300/10">
                {t("errorBoundary.retryButton")}
              </button>
            </div>}
            {mostraFalas
              ? <div lang={idiomaNaTela}><TranscricaoPorFalante segmentos={falas} nomes={nomes} aoIrPara={partes.length ? segundo => player.current?.irPara(segundo) : undefined} linkDoTempo={linkDoTempo}
                soAVoz={soAVoz} aoOuvirSoAVoz={gravacao && partes.length ? voz => player.current?.ouvirSoAVoz(voz) : undefined}/></div>
              : <p dir="auto" lang={idiomaNaTela} className="whitespace-pre-wrap leading-7 text-white/75">{textoNaTela || transcricao.texto}</p>}
          </>}
      </> : <p className="text-white/45">{ehDocumento ? t("meetings.document.textUnavailable") : t("meetings.transcriptUnavailable")}</p>}
    </section>}

    {/* O mapa mental (H10), como no detalhe da dona: a raiz é o título, com o emoji do resumo. */}
    {aba === "mindmap" && <div className="mt-6">
      {temTextoParaResumir
        ? <MapaMentalDaReuniao token={token} titulo={titulo} emoji={resumoGuardado.data?.emoji ?? null} traducao={traducaoDoResumo} aoMudarRotulos={setRotulosDoMapa} documento={ehDocumento} aoPedirSenha={pedirASenhaDeNovo}/>
        : <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><p className="text-sm text-white/50">{ehDocumento ? t("meetings.document.mindMapWait") : t("meetings.mindMap.waitTranscript")}</p></section>}
    </div>}
    {gravacao && <BarraDoPlayer ref={player} partes={partes}
      aviso={falhaNoAudio ? t("meetings.openLink.audioLoadError") : null}
      falas={falas} soAVoz={soAVoz} rotuloDaVoz={soAVoz ? rotuloDaVoz(soAVoz) : undefined} aoMudarSoAVoz={setSoAVoz}
      // O áudio que não carrega pode ser a entrada vencida (a rota responde 404
      // sem ela): a releitura da reunião traz a tela da senha, se for isso.
      aoFalhar={() => { setFalhaNoAudio(true); pedirASenhaDeNovo(); }} aoCarregar={() => setFalhaNoAudio(false)}/>}
  </Moldura>;
}
