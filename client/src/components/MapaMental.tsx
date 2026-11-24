import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { ChevronsDownUp, ChevronsUpDown, Download, Loader2, Maximize2, Minimize2, Minus, Network, Pencil, Plus, RotateCcw, Sparkles, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { AvisoDeConferir, mensagemDoErroDaIA } from "@/components/ReuniaoComIA";
import { mensagemDaFalhaDaTraducao, type TraducaoDoResumoNaTela } from "@/hooks/useTraducaoDoResumo";
import { escritoDaDireitaParaAEsquerda, idiomaFalado } from "@shared/idioma-da-reuniao";
import { rotuloDoIdioma } from "@/lib/idiomas-na-tela";
import { rotulosDoMapaMental, type MapaMental } from "@shared/mapa-mental";
import { ESTILOS_DO_MAPA, estiloDoMapa, mapaEmMarkdown, nomeDoArquivoDoMapa, type EstiloDoMapa } from "@shared/mapa-mental-edicao";
import { EditorDoMapa } from "@/components/EditorDoMapa";
import { canvasDoMapa, entregarArquivo, jpegDoCanvas, pdfComJpeg } from "@/lib/mapa-para-baixar";
import { ramoDasConexoes, useConexoesDaReuniao, type RamoDasConexoes } from "@/components/ConexoesDaReuniao";

/**
 * O mapa mental da reunião (H10 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), na aba "Mapa mental" do detalhe
 * da dona (pages/Meetings.tsx) e do link aberto (pages/ReuniaoAberta.tsx),
 * como no app de referência da cliente: a raiz é o título da reunião, os ramos
 * são os assuntos, as folhas os pontos de cada assunto e os filhos os detalhes.
 *
 * Feito só com CSS, sem biblioteca de diagrama:
 * - no computador (a partir de 768 px), árvore horizontal: cada coluna fica ao
 *   lado do nó de que sai, com as linhas de ligação desenhadas pelo próprio
 *   item (::before e ::after);
 * - no celular, contorno vertical, com os ramos recolhidos: a lista dos
 *   assuntos, e cada um abre ao toque;
 * - tudo por propriedades lógicas (start, border-s): no texto da direita para
 *   a esquerda (árabe), a árvore cresce para a esquerda. A direção é a do
 *   idioma do mapa (o da reunião), não a da tela.
 *
 * A consulta mora aqui. Ela pergunta de novo a cada 5 s enquanto o mapa está
 * na fila, e para em qualquer erro. O mapa não leva quem falou (o servidor
 * recusa rótulo de voz), então dona e link veem o mesmo.
 *
 * A tradução (H11) é a do resumo, que mora na página (useTraducaoDoResumo):
 * o mapa pronto avisa a página dos rótulos dele, ela os traduz junto com o
 * resumo, e a árvore os mostra no idioma escolhido, com a direção dele. Como
 * na aba Resumo, a aba do mapa diz que os rótulos foram traduzidos pela IA (e
 * de que idioma), que a tradução está em curso, e se ela falhou, com o
 * "Tentar de novo".
 *
 * No refazer do resumo que falhou (H4d), sem mapa pronto, a falha é a do
 * refazer: a dona lê isso e tenta de novo (o mapa vem com o resumo); pelo link,
 * que não reabre o refazer da dona, o aviso de que ela pediu uma nova versão,
 * sem botão.
 */

type MapaNaTela = inferRouterOutputs<AppRouter>["meetings"]["mapaMental"];
type ConsultaDoMapa = { data?: MapaNaTela; isError: boolean; error: unknown; refetch: () => unknown };
type PedidoDoMapa = { isPending: boolean; isError: boolean; error: unknown };
type TraducaoDoMapa = Pick<TraducaoDoResumoNaTela, "estado" | "idioma" | "idiomaOriginal" | "erro" | "tentarDeNovo" | "traduzirRotulo">;
type Extras = {
  /** O título da reunião: a raiz do mapa. */
  titulo: string;
  /** O emoji do resumo, que vai antes do título, como no cabeçalho da página. */
  emoji?: string | null;
  /** A tradução do resumo (H11): pronta, os rótulos saem no idioma dela. */
  traducao?: TraducaoDoMapa;
  /** Os rótulos do mapa pronto, para a página pedir a tradução deles (H11). */
  aoMudarRotulos?: (rotulos: string[]) => void;
  /**
   * Só pelo link: o link com senha recusou (UNAUTHORIZED), porque a entrada
   * venceu ou a dona trocou a senha. A página relê a reunião, que traz a tela
   * da senha de volta.
   */
  aoPedirSenha?: () => void;
  /** A reunião nasceu de um documento (H12): o aviso fala do texto do documento, e não da transcrição. */
  documento?: boolean;
};
type Props = ({ meetingId: string; token?: undefined } | { token: string; meetingId?: undefined }) & Extras;
type DoCorpo = Omit<Extras, "emoji" | "aoPedirSenha" | "documento"> & { emoji: string | null; documento: boolean };
/**
 * N5: o ramo "Conexões desta reunião", só no mapa da dona (o do link nunca o
 * recebe), e o erro da consulta dele, que aparece no lugar do ramo.
 */
type ComRamoExtra = { ramoExtra?: RamoDasConexoes | null; erroDoRamo?: { erro: unknown; tentarDeNovo: () => void } | null };

const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;
// A reunião que não existe mais e o link desligado (ou cortado) no meio da
// visita são definitivos: nem tentar de novo, nem perguntar a cada 5 s. O link
// que pede a senha (H23) também: repetir não passa sem a senha.
const pedeSenha = (erro: unknown) => codigoDoErro(erro) === "UNAUTHORIZED";
const erroDefinitivo = (erro: unknown) => codigoDoErro(erro) === "NOT_FOUND" || codigoDoErro(erro) === "BAD_REQUEST" || pedeSenha(erro);
// Para em qualquer erro, não só no definitivo: perguntar a cada 5 s não cura
// um 500. A releitura que dá certo limpa o erro e religa a repetição.
// O refazer em outro estilo (H10b) chega como "pronto", com o mapa de antes à
// vista e edicao.refazendo: a consulta segue perguntando até o mapa novo sair.
const esperaDaConsulta = (dados: { estado?: string; edicao?: { refazendo?: boolean } } | undefined, erro: unknown) =>
  (dados?.estado === "pendente" || dados?.estado === "gerando" || dados?.edicao?.refazendo === true) && !erro ? 5_000 : false;

export function MapaMentalDaReuniao(props: Props) {
  const extras: DoCorpo = { titulo: props.titulo, emoji: props.emoji ?? null, traducao: props.traducao, aoMudarRotulos: props.aoMudarRotulos, documento: !!props.documento };
  return props.token !== undefined
    ? <MapaDoLink token={props.token} aoPedirSenha={props.aoPedirSenha} {...extras}/>
    : <MapaDaDona meetingId={props.meetingId} {...extras}/>;
}

function MapaDaDona({ meetingId, ...extras }: { meetingId: string } & DoCorpo) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const consulta = trpc.meetings.mapaMental.useQuery({ meetingId }, {
    retry: (tentativas, erro) => !erroDefinitivo(erro) && tentativas < 3,
    refetchInterval: atual => esperaDaConsulta(atual.state.data, atual.state.error),
  });
  // N5: as pessoas da reunião, com o que têm e precisam e as conexões que
  // nasceram delas, num ramo à parte, montado aqui (sem IA nem tradução).
  const conexoes = useConexoesDaReuniao(meetingId);
  const ramoExtra = ramoDasConexoes(conexoes.data, t);
  // Erro de consulta é erro, nunca "reunião sem conexões" (revisão da N5): o ramo dá lugar ao aviso.
  const erroDoRamo = conexoes.isError ? { erro: conexoes.error, tentarDeNovo: () => { void conexoes.refetch(); } } : null;
  // Pedir o mapa pode criar ou reabrir o resumo (sem resumo pronto, o mapa vem
  // com ele): relê os dois, para a aba Resumo e o emoji do título não ficarem
  // velhos. Devolvida ao onSettled, a releitura segura o botão até o estado
  // novo chegar.
  const pedir = trpc.meetings.pedirMapa.useMutation({
    onSettled: () => Promise.all([utils.meetings.mapaMental.invalidate({ meetingId }), utils.meetings.resumoGuardado.invalidate({ meetingId })]),
  });
  // H10b: editar, voltar ao da IA e refazer em outro estilo. A resposta relê
  // o mapa (a revisão nova vem com ele).
  const reler = () => utils.meetings.mapaMental.invalidate({ meetingId });
  const editar = trpc.meetings.editarMapa.useMutation({ onSettled: reler });
  const refazer = trpc.meetings.refazerMapa.useMutation({ onSettled: reler });
  const revisao = consulta.data?.edicao?.revisao ?? 0;
  const acoes: AcoesDaDona = {
    salvar: (mapa, depois) => editar.mutate({ meetingId, revisao, operacao: { tipo: "salvar", mapa } }, { onSuccess: depois }),
    voltar: depois => editar.mutate({ meetingId, revisao, operacao: { tipo: "voltar" } }, { onSuccess: depois }),
    editando: { isPending: editar.isPending, error: editar.isError ? editar.error : null, limpar: () => editar.reset() },
    refazer: (estilo, depois) => refazer.mutate({ meetingId, revisao, estilo }, { onSuccess: depois }),
    refazendo: { isPending: refazer.isPending, error: refazer.isError ? refazer.error : null, limpar: () => refazer.reset() },
  };
  return <CorpoDoMapa consulta={consulta} pedido={pedir} aoPedir={() => pedir.mutate({ meetingId })} peloLink={false} ramoExtra={ramoExtra} erroDoRamo={erroDoRamo} acoes={acoes} {...extras}/>;
}

/** O que só a dona faz no mapa pronto (H10b). */
type EstadoDaMutacao = { isPending: boolean; error: unknown; limpar: () => void };
type AcoesDaDona = {
  salvar: (mapa: MapaMental, depois: () => void) => void;
  voltar: (depois: () => void) => void;
  editando: EstadoDaMutacao;
  refazer: (estilo: EstiloDoMapa, depois: () => void) => void;
  refazendo: EstadoDaMutacao;
};

function MapaDoLink({ token, aoPedirSenha, ...extras }: { token: string; aoPedirSenha?: () => void } & DoCorpo) {
  const utils = trpc.useUtils();
  // A página do link não pede conta: como o resumo dela, não relê na volta à aba.
  const consulta = trpc.reuniaoAberta.mapaMental.useQuery({ token }, {
    retry: (tentativas, erro) => !erroDefinitivo(erro) && tentativas < 3,
    refetchOnWindowFocus: false,
    refetchInterval: atual => esperaDaConsulta(atual.state.data, atual.state.error),
  });
  const pedir = trpc.reuniaoAberta.pedirMapa.useMutation({
    onSettled: () => Promise.all([utils.reuniaoAberta.mapaMental.invalidate({ token }), utils.reuniaoAberta.resumoGuardado.invalidate({ token })]),
  });
  // A entrada no link com senha venceu (ou a senha mudou): a página relê a
  // reunião, que traz a tela da senha. Vale para a leitura e para o pedido.
  const recusouPelaSenha = pedeSenha(consulta.error) || pedeSenha(pedir.error);
  useEffect(() => {
    if (recusouPelaSenha) aoPedirSenha?.();
  }, [recusouPelaSenha]);
  return <CorpoDoMapa consulta={consulta} pedido={pedir} aoPedir={() => pedir.mutate({ token })} peloLink {...extras}/>;
}

function CorpoDoMapa({ consulta, pedido, aoPedir, peloLink, titulo, emoji, traducao, aoMudarRotulos, documento, ramoExtra, erroDoRamo, acoes }: {
  consulta: ConsultaDoMapa;
  pedido: PedidoDoMapa;
  aoPedir: () => void;
  peloLink: boolean;
  acoes?: AcoesDaDona;
} & DoCorpo & ComRamoExtra) {
  const { t } = useTranslation();
  const idDoTitulo = useId();
  const dados = consulta.data;
  // O mapa pronto avisa a página dos rótulos dele (H11): o mapa que fica
  // pronto depois do resumo, ou que só agora foi lido, pede a tradução deles.
  const mapaPronto = dados?.estado === "pronto" ? dados.mapa : null;
  useEffect(() => {
    if (mapaPronto) aoMudarRotulos?.(rotulosDoMapaMental(mapaPronto));
  }, [mapaPronto]);

  // Erro de consulta é erro, nunca "sem mapa" nem "gerando".
  const erroDaConsulta = !consulta.isError ? null
    // A senha do link (H23): a frase traduzida, sem o "tentar de novo", que não passaria.
    : pedeSenha(consulta.error)
      ? <p role="alert" className="mt-4 text-sm text-white/70">{mensagemDeErroParaTela(consulta.error, t)}</p>
    : erroDefinitivo(consulta.error)
      ? <p role="alert" className="mt-4 text-sm text-white/70">{peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound")}</p>
      : <div className="mt-4"><ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()}/></div>;
  // Sem dado, ou com o mapa ainda na fila, o erro toma o lugar do aviso, que
  // senão giraria para sempre; com o mapa pronto, falho ou ausente, ele vai
  // acima do conteúdo (a releitura que falha deixa o dado velho no cache).
  const esperando = !dados || dados.estado === "pendente" || dados.estado === "gerando";
  // O refazer da dona que falhou antes do mapa (H4d): pelo link, pedir não
  // reabre o refazer, e o botão não faria nada.
  const refazerQueFalhou = dados?.estado === "falhou" && dados.versaoAnterior;
  // O refazer em outro estilo que falhou (H10b) também tem o botão de pedir, no aviso dele.
  const comBotaoDePedir = dados?.estado === "sem_mapa" || (dados?.estado === "falhou" && !(peloLink && refazerQueFalhou)) || (!peloLink && !!dados?.edicao?.erroDoRefazer);

  let corpo: ReactNode;
  if (esperando && erroDaConsulta) {
    corpo = erroDaConsulta;
  } else if (!dados) {
    corpo = <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="me-2 inline animate-spin"/>{t("meetings.mindMap.loading")}</p>;
  } else if (dados.estado === "sem_mapa") {
    corpo = <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-white/60">{t("meetings.mindMap.none")}</p>
      <BotaoDePedir aoClicar={aoPedir} pedindo={pedido.isPending}>{peloLink ? t("meetings.mindMap.requestLink") : t("meetings.mindMap.generate")}</BotaoDePedir>
    </div>;
  } else if (dados.estado === "pendente" || dados.estado === "gerando") {
    corpo = <p role="status" className="mt-4 text-sm text-white/60"><Loader2 size={15} className="me-2 inline animate-spin"/>{t("meetings.mindMap.generating")}</p>;
  } else if (refazerQueFalhou && peloLink) {
    corpo = <p role="status" className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">{t("meetings.mindMap.linkPreviousVersion")}</p>;
  } else if (dados.estado === "falhou" || !dados.mapa) {
    corpo = <div role="alert" className="mt-4 flex flex-col gap-3 rounded-xl border border-red-400/20 bg-red-400/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-red-200">{refazerQueFalhou ? t("meetings.mindMap.redoFailed") : dados.erro === "MAPA_INVALIDO" ? t("meetings.mindMap.notEnough") : t("meetings.mindMap.failed")}</p>
      <BotaoDePedir aoClicar={aoPedir} pedindo={pedido.isPending}>{t("meetings.mindMap.retry")}</BotaoDePedir>
    </div>;
  } else {
    corpo = <div className="mt-4 space-y-4">
      {/* No documento (H12) não há transcrição: o aviso fala do texto dele (conferência de tela de 20/11/2026). */}
      <AvisoDeConferir>{documento ? t("meetings.document.mindMapNotice") : t("meetings.mindMap.notice")}</AvisoDeConferir>
      {traducao && <EstadoDaTraducao traducao={traducao} peloLink={peloLink}/>}
      {/* Com a tradução pronta (H11), os rótulos e a direção são os do idioma dela. */}
      <MapaPronto raiz={titulo} emoji={emoji} mapa={dados.mapa} idiomaDoMapa={dados.idioma} estilo={estiloDoMapa(dados.estilo)} edicao={peloLink ? undefined : dados.edicao}
        idioma={traducao?.estado === "pronta" ? traducao.idioma : dados.idioma}
        traduzir={traducao?.estado === "pronta" ? traducao.traduzirRotulo : undefined} ramoExtra={peloLink ? null : ramoExtra ?? null}
        acoes={peloLink ? undefined : acoes} aoPedirDeNovo={aoPedir} pedindoDeNovo={pedido.isPending}/>
      {!peloLink && ramoExtra && <p className="text-xs text-white/45">{t("reuniaoNoMatch.mapaAviso")}</p>}
      {!peloLink && erroDoRamo && <ErroDeConsulta erro={erroDoRamo.erro} aoTentarDeNovo={erroDoRamo.tentarDeNovo}/>}
    </div>;
  }

  return <section aria-labelledby={idDoTitulo} className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <h2 id={idDoTitulo} className="inline-flex items-center gap-2 text-base font-semibold text-amber-100"><Network size={16} aria-hidden="true"/>{t("meetings.mindMap.title")}</h2>
    {!esperando && erroDaConsulta}
    {corpo}
    {/* O erro do pedido é do botão de pedir: quando o mapa anda por outro
        caminho (a fila, outro pedido), ele sai da tela com o botão. */}
    {comBotaoDePedir && pedido.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, pedido.error, t("meetings.mindMap.requestError"), peloLink)}</p>}
  </section>;
}

// G16: o idioma fora dos 10 da tela vai pelo nome no idioma de quem lê.
const nomeNaTela = (codigo: string | null, tela: string) => rotuloDoIdioma(codigo, tela);

/**
 * O estado da tradução dos rótulos (H11), como a aba Resumo o mostra: em curso,
 * pronta (os rótulos são tradução da IA, e de que idioma) ou com a falha, que
 * deixa o mapa no original e oferece "Tentar de novo".
 */
function EstadoDaTraducao({ traducao, peloLink }: { traducao: TraducaoDoMapa; peloLink: boolean }) {
  const { t, i18n } = useTranslation();
  if (traducao.estado === "traduzindo") {
    return <p role="status" className="text-xs text-amber-100/70"><Loader2 size={13} className="me-1.5 inline animate-spin"/>{t("meetings.mindMap.translating")}</p>;
  }
  if (traducao.estado === "pronta") {
    return <p className="text-xs text-white/45">{t("meetings.mindMap.translationNotice", { idioma: nomeNaTela(traducao.idiomaOriginal, i18n.resolvedLanguage ?? i18n.language) })}</p>;
  }
  if (traducao.estado !== "erro") return null;
  return <div role="alert" className="flex flex-wrap items-center gap-3 text-xs text-amber-200/80">
    <span>{mensagemDaFalhaDaTraducao(t, traducao.erro, peloLink, t("meetings.mindMap.translationError"))}</span>
    <button type="button" onClick={traducao.tentarDeNovo} className="rounded-lg border border-amber-300/30 px-3 py-1 font-semibold text-amber-200 hover:bg-amber-300/10">{t("meetings.mindMap.retry")}</button>
  </div>;
}

function BotaoDePedir({ aoClicar, pedindo, children }: { aoClicar: () => void; pedindo: boolean; children: ReactNode }) {
  return <button type="button" onClick={aoClicar} disabled={pedindo}
    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
    {pedindo ? <Loader2 size={15} className="animate-spin"/> : <Sparkles size={15}/>} {children}
  </button>;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const ZOOM_PADRAO = 2;
const BOTAO_DA_BARRA = "inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/5 disabled:opacity-40";
const AVISO = "rounded-xl border px-3 py-2 text-sm";

/** O nome do estilo na tela (H10b). Uma chamada por chave, para o teste das chaves usadas as achar. */
function nomeDoEstilo(t: (chave: string) => string, estilo: EstiloDoMapa): string {
  switch (estilo) {
    case "hierarchical": return t("meetings.mindMap.styles.hierarchical");
    case "timeline": return t("meetings.mindMap.styles.timeline");
    case "concept": return t("meetings.mindMap.styles.concept");
    default: return t("meetings.mindMap.styles.overview");
  }
}
function ajudaDoEstilo(t: (chave: string) => string, estilo: EstiloDoMapa): string {
  switch (estilo) {
    case "hierarchical": return t("meetings.mindMap.styles.hierarchicalHelp");
    case "timeline": return t("meetings.mindMap.styles.timelineHelp");
    case "concept": return t("meetings.mindMap.styles.conceptHelp");
    default: return t("meetings.mindMap.styles.overviewHelp");
  }
}

/**
 * A recusa do refazer (H10b): os códigos do mapa (MAPA_*) pela tabela das
 * mensagens; o resto (o teto comum de pedidos à IA, a IA fora do ar) como os
 * outros pedidos à IA da reunião.
 */
function fraseDoErroDoMapa(t: (chave: string) => string, erro: unknown): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (typeof mensagem === "string" && mensagem.startsWith("MAPA_")) return mensagemDeErroParaTela(erro, t);
  return mensagemDoErroDaIA(t, erro, t("meetings.mindMap.requestError"), false);
}

type EdicaoNaTela = { revisao: number; editado: boolean; editadoEm: number | null; refazendo: boolean; erroDoRefazer: string | null; estiloPedido?: EstiloDoMapa };

/**
 * O mapa pronto (H10b): a barra (zoom, tela cheia e, para a dona, baixar,
 * editar e refazer em outro estilo), os avisos da edição e do refazer, e a
 * árvore no estilo dele ou o editor. O link aberto recebe só o zoom e a tela
 * cheia: baixar, editar e refazer são da dona.
 *
 * A tela cheia é uma camada fixa sobre a página (Esc ou o botão fecham), e não
 * a API de tela cheia do navegador: o Safari do iPhone só a dá ao vídeo.
 * O zoom é a propriedade CSS `zoom`, que mexe no tamanho de verdade (a
 * rolagem acompanha), e não um transform.
 */
function MapaPronto({ raiz, emoji, mapa, idioma, idiomaDoMapa, estilo, edicao, traduzir, ramoExtra, acoes, aoPedirDeNovo, pedindoDeNovo }: {
  raiz: string; emoji: string | null; mapa: MapaMental; idioma: string | null; idiomaDoMapa: string | null; estilo: EstiloDoMapa;
  edicao?: EdicaoNaTela; traduzir?: (rotulo: string) => string; ramoExtra: RamoDasConexoes | null;
  acoes?: AcoesDaDona; aoPedirDeNovo: () => void; pedindoDeNovo: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [zoom, setZoom] = useState(ZOOM_PADRAO);
  const [telaCheia, setTelaCheia] = useState(false);
  const [editando, setEditando] = useState(false);
  const [escolhendo, setEscolhendo] = useState(false);
  const [estiloNovo, setEstiloNovo] = useState<EstiloDoMapa>(estilo === "overview" ? "hierarchical" : "overview");
  const [confirmarVolta, setConfirmarVolta] = useState(false);
  const [falhaDoArquivo, setFalhaDoArquivo] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const refazendo = !!edicao?.refazendo;

  // Esc sai da tela cheia.
  useEffect(() => {
    if (!telaCheia) return;
    const aoTeclar = (e: KeyboardEvent) => { if (e.key === "Escape") setTelaCheia(false); };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [telaCheia]);

  const rtl = direcaoDoMapa(idioma) === "rtl";
  const baixar = async (formato: "pdf" | "jpg" | "md") => {
    setFalhaDoArquivo(false);
    setBaixando(true);
    try {
      const titulo = `${emoji ? `${emoji} ` : ""}${raiz}`;
      if (formato === "md") {
        entregarArquivo(new Blob([mapaEmMarkdown(titulo, mapa, traduzir)], { type: "text/markdown;charset=utf-8" }), nomeDoArquivoDoMapa(raiz, "md"));
        return;
      }
      const canvas = canvasDoMapa(titulo, mapa, rtl, traduzir);
      const jpeg = await jpegDoCanvas(canvas);
      if (formato === "jpg") { entregarArquivo(jpeg, nomeDoArquivoDoMapa(raiz, "jpg")); return; }
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      entregarArquivo(new Blob([pdfComJpeg(bytes, canvas.width, canvas.height)], { type: "application/pdf" }), nomeDoArquivoDoMapa(raiz, "pdf"));
    } catch {
      // O aparelho sem canvas (ou sem memória para um mapa enorme): o aviso, e o Markdown continua valendo.
      setFalhaDoArquivo(true);
    } finally {
      setBaixando(false);
    }
  };

  if (editando && acoes) {
    return <EditorDoMapa mapa={mapa} dir={direcaoDoMapa(idiomaDoMapa)} lang={idiomaFalado(idiomaDoMapa) ?? undefined}
      salvando={acoes.editando.isPending} erro={acoes.editando.error}
      aoSalvar={novo => acoes.salvar(novo, () => setEditando(false))}
      aoCancelar={() => { acoes.editando.limpar(); setEditando(false); }}/>;
  }

  const barra = <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("meetings.mindMap.toolbar")}>
    <button type="button" className={BOTAO_DA_BARRA} disabled={zoom === 0} onClick={() => setZoom(z => Math.max(0, z - 1))} aria-label={t("meetings.mindMap.zoomOut")}><ZoomOut size={14}/></button>
    <button type="button" className={BOTAO_DA_BARRA} onClick={() => setZoom(ZOOM_PADRAO)} aria-label={t("meetings.mindMap.zoomReset")}>{Math.round(ZOOMS[zoom] * 100)}%</button>
    <button type="button" className={BOTAO_DA_BARRA} disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(z => Math.min(ZOOMS.length - 1, z + 1))} aria-label={t("meetings.mindMap.zoomIn")}><ZoomIn size={14}/></button>
    <button type="button" className={BOTAO_DA_BARRA} onClick={() => setTelaCheia(v => !v)} aria-pressed={telaCheia}>
      {telaCheia ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}{telaCheia ? t("meetings.mindMap.exitFullscreen") : t("meetings.mindMap.fullscreen")}
    </button>
    {acoes && <>
      <span className="inline-flex items-center gap-1 text-xs text-white/55"><Download size={14} aria-hidden="true"/>{t("meetings.mindMap.download")}</span>
      <button type="button" className={BOTAO_DA_BARRA} disabled={baixando} onClick={() => void baixar("pdf")}>{t("meetings.mindMap.downloadPdf")}</button>
      <button type="button" className={BOTAO_DA_BARRA} disabled={baixando} onClick={() => void baixar("jpg")}>{t("meetings.mindMap.downloadJpeg")}</button>
      <button type="button" className={BOTAO_DA_BARRA} disabled={baixando} onClick={() => void baixar("md")}>{t("meetings.mindMap.downloadMarkdown")}</button>
      <button type="button" className={BOTAO_DA_BARRA} disabled={refazendo} onClick={() => { setTelaCheia(false); setEditando(true); }}><Pencil size={14}/>{t("meetings.mindMap.edit.start")}</button>
      <button type="button" className={BOTAO_DA_BARRA} disabled={refazendo} onClick={() => setEscolhendo(v => !v)} aria-expanded={escolhendo}><Wand2 size={14}/>{t("meetings.mindMap.redo.start")}</button>
    </>}
  </div>;

  // O zoom vale só para a árvore: os botões de abrir e recolher os ramos ficam no tamanho da barra.
  const arvore = <ArvoreDoMapa raiz={raiz} emoji={emoji} mapa={mapa} idioma={idioma} traduzir={traduzir} ramoExtra={ramoExtra} estilo={estilo} zoom={ZOOMS[zoom]}/>;

  return <div className="space-y-3">
    {estilo !== "overview" && <p className="text-xs text-white/50">{t("meetings.mindMap.currentStyle", { estilo: nomeDoEstilo(t, estilo) })}</p>}
    {edicao?.editado && <div className="flex flex-wrap items-center gap-3 text-xs text-white/55">
      <span>{edicao.editadoEm ? t("meetings.mindMap.editedOn", { data: new Date(edicao.editadoEm).toLocaleString(i18n.resolvedLanguage ?? i18n.language, { dateStyle: "short", timeStyle: "short" }) }) : t("meetings.mindMap.edited")}</span>
      {acoes && !refazendo && !confirmarVolta && <button type="button" onClick={() => setConfirmarVolta(true)} className="inline-flex items-center gap-1 font-semibold text-amber-200 hover:underline"><RotateCcw size={13}/>{t("meetings.mindMap.restoreAi")}</button>}
    </div>}
    {acoes && confirmarVolta && <div role="alertdialog" aria-label={t("meetings.mindMap.restoreAi")} className={`${AVISO} border-amber-300/25 bg-amber-300/10 text-amber-100`}>
      <p>{t("meetings.mindMap.restoreAiQuestion")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={acoes.editando.isPending} onClick={() => acoes.voltar(() => setConfirmarVolta(false))} className="rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-60">{t("meetings.mindMap.restoreAiYes")}</button>
        <button type="button" onClick={() => { acoes.editando.limpar(); setConfirmarVolta(false); }} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/75">{t("meetings.mindMap.edit.cancel")}</button>
      </div>
      {acoes.editando.error ? <p role="alert" className="mt-2 text-red-200">{mensagemDeErroParaTela(acoes.editando.error, t)}</p> : null}
    </div>}
    {refazendo && <p role="status" className={`${AVISO} border-amber-300/25 bg-amber-300/10 text-amber-100`}><Loader2 size={14} className="me-2 inline animate-spin"/>{t("meetings.mindMap.redo.running", { estilo: nomeDoEstilo(t, edicao?.estiloPedido ?? estilo) })}</p>}
    {edicao?.erroDoRefazer && <div role="alert" className={`${AVISO} flex flex-wrap items-center justify-between gap-3 border-red-400/20 bg-red-400/10 text-red-200`}>
      <span>{t("meetings.mindMap.redo.failed")}</span>
      {acoes && <BotaoDePedir aoClicar={aoPedirDeNovo} pedindo={pedindoDeNovo}>{t("meetings.mindMap.retry")}</BotaoDePedir>}
    </div>}
    {acoes && escolhendo && !refazendo && <fieldset className={`${AVISO} space-y-2 border-white/15 bg-black/20 text-white/80`}>
      <legend className="px-1 text-sm font-semibold text-amber-100">{t("meetings.mindMap.redo.title")}</legend>
      {ESTILOS_DO_MAPA.map(opcao => <label key={opcao} className="flex cursor-pointer items-start gap-2">
        <input type="radio" name="estilo-do-mapa" value={opcao} checked={estiloNovo === opcao} onChange={() => setEstiloNovo(opcao)} className="mt-1"/>
        <span><span className="font-semibold">{nomeDoEstilo(t, opcao)}</span>{opcao === estilo && <span className="text-white/45"> · {t("meetings.mindMap.redo.current")}</span>}
          <span className="block text-xs text-white/55">{ajudaDoEstilo(t, opcao)}</span></span>
      </label>)}
      {/* Texto para a Cris revisar: diz que a transcrição vai de novo à IA. */}
      <p className="text-xs text-white/55">{t("meetings.mindMap.redo.notice")}</p>
      {edicao?.editado && <p className="text-xs text-amber-200/85">{t("meetings.mindMap.redo.replacesEdits")}</p>}
      {acoes.refazendo.error ? <p role="alert" className="text-sm text-red-200">{fraseDoErroDoMapa(t, acoes.refazendo.error)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={acoes.refazendo.isPending} onClick={() => acoes.refazer(estiloNovo, () => setEscolhendo(false))}
          className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-60">
          {acoes.refazendo.isPending && <Loader2 size={13} className="animate-spin"/>}{t("meetings.mindMap.redo.confirm")}
        </button>
        <button type="button" onClick={() => { acoes.refazendo.limpar(); setEscolhendo(false); }} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/75">{t("meetings.mindMap.edit.cancel")}</button>
      </div>
    </fieldset>}
    {falhaDoArquivo && <p role="alert" className="text-sm text-red-200">{t("meetings.mindMap.downloadError")}</p>}
    {/* A tela cheia vai para o body: dentro da página, um ancestral com
        contexto de empilhamento deixava o menu do app (sticky, z-40) por cima
        da barra, e no celular, sem Esc, não havia como sair. */}
    {telaCheia
      ? createPortal(<div role="dialog" aria-modal="true" aria-label={t("meetings.mindMap.title")} className="fixed inset-0 z-[60] overflow-auto bg-[#120d0a] p-4">
          <div className="mb-3">{barra}</div>
          {arvore}
        </div>, document.body)
      : <>{barra}{arvore}</>}
  </div>;
}

// A partir daqui, a árvore. No computador, cada coluna (os ramos, as folhas de
// um ramo, os filhos de uma folha) fica ao lado do nó de que sai, afastada
// dele, e o traço que sai do nó até a linha vertical é o ::before da coluna.
const COLUNA = "md:relative md:ms-8 md:before:absolute md:before:top-1/2 md:before:-start-8 md:before:w-4 md:before:border-t md:before:border-amber-300/40";
// Cada item da coluna desenha a sua ligação: o traço até o nó (::before) e o
// pedaço da linha vertical que junta os irmãos (::after), que vai do centro do
// primeiro ao centro do último. Os itens se tocam (padding, não margem), para
// os pedaços da linha vertical se emendarem.
const ITEM = "md:relative md:flex md:items-center md:py-1.5 md:before:absolute md:before:top-1/2 md:before:-start-4 md:before:w-4 md:before:border-t md:before:border-amber-300/40 md:after:absolute md:after:inset-y-0 md:after:-start-4 md:after:border-s md:after:border-amber-300/40 md:first:after:top-1/2 md:last:after:bottom-1/2";
const NO_DO_RAMO = "flex w-full items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-start text-sm font-semibold text-amber-100 md:w-auto md:max-w-[15rem] md:shrink-0";
const NO_DA_FOLHA = "block rounded-lg px-2 py-1 text-sm text-white/85 md:max-w-[15rem] md:shrink-0 md:border md:border-white/15 md:bg-white/[0.04] md:px-3 md:py-1.5";
const NO_DO_FILHO = "block px-2 py-0.5 text-xs text-white/60 md:max-w-[13rem] md:shrink-0 md:rounded-lg md:border md:border-white/10 md:px-2.5 md:py-1";
const BOTAO_PEQUENO = "inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5";

// Abertos no computador, onde a árvore inteira cabe à vista; recolhidos no
// celular, onde o contorno começa como a lista dos assuntos.
const TELA_DA_ARVORE = "(min-width: 768px)";
function telaLarga() {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(TELA_DA_ARVORE).matches;
}

/**
 * A direção do mapa: a do idioma em que ele foi escrito; sem idioma, a da
 * página. G16: qualquer idioma que a IA transcreve (o hebraico e o persa
 * também vão da direita para a esquerda).
 */
function direcaoDoMapa(idioma: string | null): "ltr" | "rtl" | undefined {
  if (!idiomaFalado(idioma)) return undefined;
  return escritoDaDireitaParaAEsquerda(idioma) ? "rtl" : "ltr";
}

export function ArvoreDoMapa({ raiz, emoji, mapa, idioma, traduzir, ramoExtra, estilo = "overview", zoom = 1 }: {
  raiz: string; emoji?: string | null; mapa: MapaMental; idioma: string | null;
  /** O rótulo no idioma da tradução do resumo (H11); sem ela, o próprio rótulo. */
  traduzir?: (rotulo: string) => string;
  /**
   * N5: "Conexões desta reunião", depois dos ramos da IA. Os rótulos já vêm no
   * idioma da tela e os nomes e itens como foram ditos: nada aqui é traduzido.
   */
  ramoExtra?: RamoDasConexoes | null;
  /** O estilo (H10b): a visão geral é a árvore abaixo; os outros, ArvoreEmOutroEstilo. */
  estilo?: EstiloDoMapa;
  /** O zoom da barra (H10b): só a árvore cresce, não os botões de abrir e recolher. */
  zoom?: number;
}) {
  const { t } = useTranslation();
  // O ramo extra entra no fim, marcado: o rótulo dele não passa pela tradução do resumo.
  const ramos = [...mapa.ramos.map(ramo => ({ ...ramo, extra: false })), ...(ramoExtra ? [{ ...ramoExtra, extra: true }] : [])];
  const rotulo = (texto: string, extra = false) => traduzir && !extra ? traduzir(texto) : texto;
  const prefixo = useId();
  const [padrao] = useState(telaLarga);
  // Só o que a pessoa mudou; o resto segue o padrão da tela.
  const [mudados, setMudados] = useState<Record<number, boolean>>({});
  const aberto = (i: number) => mudados[i] ?? padrao;
  const alternar = (i: number) => setMudados(atual => ({ ...atual, [i]: !(atual[i] ?? padrao) }));
  const todos = (valor: boolean) => setMudados(Object.fromEntries(ramos.map((_, i) => [i, valor] as const)));
  const temFolhas = ramos.some(ramo => ramo.folhas.length > 0);
  const codigo = idiomaFalado(idioma);
  if (estilo !== "overview") {
    return <div style={{ zoom }} data-testid="zoom-do-mapa"><ArvoreEmOutroEstilo raiz={raiz} emoji={emoji} ramos={ramos.map(ramo => ({ ...ramo, rotulo: rotulo(ramo.rotulo, ramo.extra), folhas: ramo.folhas.map(folha => ({ rotulo: rotulo(folha.rotulo, ramo.extra), filhos: folha.filhos.map(filho => rotulo(filho, ramo.extra)) })) }))}
      estilo={estilo} dir={direcaoDoMapa(idioma)} lang={codigo ?? undefined}/></div>;
  }

  return <div>
    {temFolhas && <div className="mb-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => todos(true)} className={BOTAO_PEQUENO}><ChevronsUpDown size={14} aria-hidden="true"/>{t("meetings.mindMap.expandAll")}</button>
      <button type="button" onClick={() => todos(false)} className={BOTAO_PEQUENO}><ChevronsDownUp size={14} aria-hidden="true"/>{t("meetings.mindMap.collapseAll")}</button>
    </div>}
    <div style={{ zoom }} data-testid="zoom-do-mapa">
    <div dir={direcaoDoMapa(idioma)} lang={codigo ?? undefined} data-testid="arvore-do-mapa" className="overflow-x-auto pb-2">
      <div className="md:flex md:w-max md:items-center">
        <p className="inline-flex max-w-full items-center gap-2 rounded-2xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] md:max-w-[13rem] md:shrink-0">
          {emoji && <span aria-hidden="true">{emoji}</span>}<span dir="auto">{raiz}</span>
        </p>
        <ul className={`mt-3 space-y-2 md:mt-0 md:space-y-0 ${COLUNA}`}>
          {ramos.map((ramo, i) => {
            const idDasFolhas = `${prefixo}-ramo-${i}`;
            const estaAberto = aberto(i);
            return <li key={i} className={ITEM} data-ramo-extra={ramo.extra || undefined}>
              {ramo.folhas.length > 0
                ? <button type="button" aria-expanded={estaAberto} aria-controls={idDasFolhas} onClick={() => alternar(i)}
                    className={`${NO_DO_RAMO} hover:bg-amber-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60`}>
                    {estaAberto ? <Minus size={14} aria-hidden="true" className="mt-0.5 shrink-0"/> : <Plus size={14} aria-hidden="true" className="mt-0.5 shrink-0"/>}
                    <span dir="auto" className="min-w-0">{rotulo(ramo.rotulo, ramo.extra)}</span>
                    {!estaAberto && <span aria-hidden="true" className="ms-auto shrink-0 rounded-full bg-amber-300/20 px-1.5 text-[11px] font-semibold text-amber-200">+{ramo.folhas.length}</span>}
                  </button>
                : <span className={NO_DO_RAMO}><span dir="auto" className="min-w-0">{rotulo(ramo.rotulo, ramo.extra)}</span></span>}
              {ramo.folhas.length > 0 && <ul id={idDasFolhas} hidden={!estaAberto}
                className={`mt-1.5 ms-3 space-y-1 border-s border-amber-300/25 ps-3 md:mt-0 md:space-y-0 md:border-s-0 md:ps-0 ${COLUNA}`}>
                {ramo.folhas.map((folha, j) => <li key={j} className={ITEM}>
                  <span dir="auto" className={NO_DA_FOLHA}>{rotulo(folha.rotulo, ramo.extra)}</span>
                  {folha.filhos.length > 0 && <ul className={`mt-1 ms-3 space-y-0.5 border-s border-white/10 ps-3 md:mt-0 md:space-y-0 md:border-s-0 md:ps-0 ${COLUNA}`}>
                    {folha.filhos.map((filho, k) => <li key={k} className={ITEM}><span dir="auto" className={NO_DO_FILHO}>{rotulo(filho, ramo.extra)}</span></li>)}
                  </ul>}
                </li>)}
              </ul>}
            </li>;
          })}
        </ul>
      </div>
    </div>
    </div>
  </div>;
}

type RamoNaTela = { rotulo: string; folhas: Array<{ rotulo: string; filhos: string[] }>; extra: boolean };

/**
 * Os outros estilos do mapa (H10b), como o app de referência os desenha, só
 * com CSS e com propriedades lógicas (no árabe, tudo da direita para a
 * esquerda):
 * - hierárquico: do geral ao específico, de cima para baixo, em todo tamanho
 *   de tela, cada nível recuado sob o de cima;
 * - linha do tempo: os ramos numerados numa linha (de lado no computador, de
 *   cima para baixo no celular), cada um com os pontos embaixo;
 * - conceito: a raiz no centro e cada ideia num cartão em volta, com os pontos
 *   e os detalhes dela.
 * Tudo aberto: recolher é da visão geral.
 */
function ArvoreEmOutroEstilo({ raiz, emoji, ramos, estilo, dir, lang }: {
  raiz: string; emoji?: string | null; ramos: RamoNaTela[]; estilo: Exclude<EstiloDoMapa, "overview">; dir?: "ltr" | "rtl"; lang?: string;
}) {
  const cabeca = <p className="inline-flex max-w-full items-center gap-2 rounded-2xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c]">
    {emoji && <span aria-hidden="true">{emoji}</span>}<span dir="auto">{raiz}</span>
  </p>;
  const folhas = (ramo: RamoNaTela) => ramo.folhas.length > 0 && <ul className="mt-2 space-y-1.5">
    {ramo.folhas.map((folha, j) => <li key={j} className="text-sm text-white/85">
      <span dir="auto">{folha.rotulo}</span>
      {folha.filhos.length > 0 && <ul className="mt-1 space-y-0.5 border-s border-white/10 ps-3">
        {folha.filhos.map((filho, k) => <li key={k} className="text-xs text-white/60"><span dir="auto">{filho}</span></li>)}
      </ul>}
    </li>)}
  </ul>;

  if (estilo === "hierarchical") {
    return <div dir={dir} lang={lang} data-testid="arvore-do-mapa" data-estilo={estilo}>
      {cabeca}
      <ul className="mt-3 space-y-3 border-s-2 border-amber-300/30 ps-4">
        {ramos.map((ramo, i) => <li key={i} data-ramo-extra={ramo.extra || undefined}>
          <p className="text-sm font-semibold text-amber-100" dir="auto">{ramo.rotulo}</p>
          {ramo.folhas.length > 0 && <div className="border-s border-white/15 ps-4">{folhas(ramo)}</div>}
        </li>)}
      </ul>
    </div>;
  }
  if (estilo === "timeline") {
    return <div dir={dir} lang={lang} data-testid="arvore-do-mapa" data-estilo={estilo} className="overflow-x-auto pb-2">
      {cabeca}
      <ol className="relative mt-4 space-y-4 border-s-2 border-amber-300/40 ps-5 md:flex md:w-max md:space-y-0 md:gap-4 md:border-s-0 md:border-t-2 md:ps-0 md:pt-5">
        {ramos.map((ramo, i) => <li key={i} data-ramo-extra={ramo.extra || undefined} className="relative md:w-56 md:shrink-0">
          <span aria-hidden="true" className="absolute -start-[1.85rem] top-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#c98f70] text-xs font-bold text-[#1a120c] md:-top-[2.15rem] md:start-0">{i + 1}</span>
          <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3">
            <p className="text-sm font-semibold text-amber-100" dir="auto">{ramo.rotulo}</p>
            {folhas(ramo)}
          </div>
        </li>)}
      </ol>
    </div>;
  }
  return <div dir={dir} lang={lang} data-testid="arvore-do-mapa" data-estilo={estilo}>
    <div className="flex justify-center">{cabeca}</div>
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ramos.map((ramo, i) => <li key={i} data-ramo-extra={ramo.extra || undefined} className="rounded-2xl border border-amber-300/30 bg-white/[0.04] p-3">
        <p className="inline-block rounded-full bg-amber-300/15 px-3 py-1 text-sm font-semibold text-amber-100" dir="auto">{ramo.rotulo}</p>
        {folhas(ramo)}
      </li>)}
    </ul>
  </div>;
}
