import { useEffect, useId, useState, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { ChevronsDownUp, ChevronsUpDown, Loader2, Minus, Network, Plus, Sparkles } from "lucide-react";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { AvisoDeConferir, mensagemDoErroDaIA } from "@/components/ReuniaoComIA";
import { mensagemDaFalhaDaTraducao, type TraducaoDoResumoNaTela } from "@/hooks/useTraducaoDoResumo";
import { idiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { rotulosDoMapaMental, type MapaMental } from "@shared/mapa-mental";
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
};
type Props = ({ meetingId: string; token?: undefined } | { token: string; meetingId?: undefined }) & Extras;
type DoCorpo = Omit<Extras, "emoji" | "aoPedirSenha"> & { emoji: string | null };
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
const esperaDaConsulta = (estado: string | undefined, erro: unknown) => (estado === "pendente" || estado === "gerando") && !erro ? 5_000 : false;

export function MapaMentalDaReuniao(props: Props) {
  const extras: DoCorpo = { titulo: props.titulo, emoji: props.emoji ?? null, traducao: props.traducao, aoMudarRotulos: props.aoMudarRotulos };
  return props.token !== undefined
    ? <MapaDoLink token={props.token} aoPedirSenha={props.aoPedirSenha} {...extras}/>
    : <MapaDaDona meetingId={props.meetingId} {...extras}/>;
}

function MapaDaDona({ meetingId, ...extras }: { meetingId: string } & DoCorpo) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const consulta = trpc.meetings.mapaMental.useQuery({ meetingId }, {
    retry: (tentativas, erro) => !erroDefinitivo(erro) && tentativas < 3,
    refetchInterval: atual => esperaDaConsulta(atual.state.data?.estado, atual.state.error),
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
  return <CorpoDoMapa consulta={consulta} pedido={pedir} aoPedir={() => pedir.mutate({ meetingId })} peloLink={false} ramoExtra={ramoExtra} erroDoRamo={erroDoRamo} {...extras}/>;
}

function MapaDoLink({ token, aoPedirSenha, ...extras }: { token: string; aoPedirSenha?: () => void } & DoCorpo) {
  const utils = trpc.useUtils();
  // A página do link não pede conta: como o resumo dela, não relê na volta à aba.
  const consulta = trpc.reuniaoAberta.mapaMental.useQuery({ token }, {
    retry: (tentativas, erro) => !erroDefinitivo(erro) && tentativas < 3,
    refetchOnWindowFocus: false,
    refetchInterval: atual => esperaDaConsulta(atual.state.data?.estado, atual.state.error),
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

function CorpoDoMapa({ consulta, pedido, aoPedir, peloLink, titulo, emoji, traducao, aoMudarRotulos, ramoExtra, erroDoRamo }: {
  consulta: ConsultaDoMapa;
  pedido: PedidoDoMapa;
  aoPedir: () => void;
  peloLink: boolean;
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
  const comBotaoDePedir = dados?.estado === "sem_mapa" || (dados?.estado === "falhou" && !(peloLink && refazerQueFalhou));

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
      <AvisoDeConferir>{t("meetings.mindMap.notice")}</AvisoDeConferir>
      {traducao && <EstadoDaTraducao traducao={traducao} peloLink={peloLink}/>}
      {/* Com a tradução pronta (H11), os rótulos e a direção são os do idioma dela. */}
      <ArvoreDoMapa raiz={titulo} emoji={emoji} mapa={dados.mapa} idioma={traducao?.estado === "pronta" ? traducao.idioma : dados.idioma}
        traduzir={traducao?.estado === "pronta" ? traducao.traduzirRotulo : undefined} ramoExtra={peloLink ? null : ramoExtra}/>
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

const nomeNaTela = (codigo: string | null) => LANGUAGES.find(idioma => idioma.code === codigo)?.label ?? codigo ?? "";

/**
 * O estado da tradução dos rótulos (H11), como a aba Resumo o mostra: em curso,
 * pronta (os rótulos são tradução da IA, e de que idioma) ou com a falha, que
 * deixa o mapa no original e oferece "Tentar de novo".
 */
function EstadoDaTraducao({ traducao, peloLink }: { traducao: TraducaoDoMapa; peloLink: boolean }) {
  const { t } = useTranslation();
  if (traducao.estado === "traduzindo") {
    return <p role="status" className="text-xs text-amber-100/70"><Loader2 size={13} className="me-1.5 inline animate-spin"/>{t("meetings.mindMap.translating")}</p>;
  }
  if (traducao.estado === "pronta") {
    return <p className="text-xs text-white/45">{t("meetings.mindMap.translationNotice", { idioma: nomeNaTela(traducao.idiomaOriginal) })}</p>;
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

/** A direção do mapa: a do idioma em que ele foi escrito; sem idioma, a da página. */
function direcaoDoMapa(idioma: string | null): "ltr" | "rtl" | undefined {
  const codigo = idiomaDaReuniao(idioma);
  if (!codigo) return undefined;
  return LANGUAGES.find(lingua => lingua.code === codigo)?.dir === "rtl" ? "rtl" : "ltr";
}

export function ArvoreDoMapa({ raiz, emoji, mapa, idioma, traduzir, ramoExtra }: {
  raiz: string; emoji?: string | null; mapa: MapaMental; idioma: string | null;
  /** O rótulo no idioma da tradução do resumo (H11); sem ela, o próprio rótulo. */
  traduzir?: (rotulo: string) => string;
  /**
   * N5: "Conexões desta reunião", depois dos ramos da IA. Os rótulos já vêm no
   * idioma da tela e os nomes e itens como foram ditos: nada aqui é traduzido.
   */
  ramoExtra?: RamoDasConexoes | null;
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
  const codigo = idiomaDaReuniao(idioma);

  return <div>
    {temFolhas && <div className="mb-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => todos(true)} className={BOTAO_PEQUENO}><ChevronsUpDown size={14} aria-hidden="true"/>{t("meetings.mindMap.expandAll")}</button>
      <button type="button" onClick={() => todos(false)} className={BOTAO_PEQUENO}><ChevronsDownUp size={14} aria-hidden="true"/>{t("meetings.mindMap.collapseAll")}</button>
    </div>}
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
  </div>;
}
