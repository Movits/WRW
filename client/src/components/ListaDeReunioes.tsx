import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, FolderInput, FolderPlus, History, ListChecks, Loader2, MapPin, Merge, Milestone, MonitorPlay, Pencil, ScanText, Search, SlidersHorizontal, Tag, Trash2,
  UserRound, X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { JuntarReunioes } from "@/components/JuntarReunioes";
import { avisoDaRecusaDaLixeira, restaurarComAviso } from "@/components/LixeiraDeReunioes";
import { CLASSES_DA_COR, EditorDePasta, emLotes, EscolherPasta, IconeDaPastaNaTela, type PastaNaTela } from "@/components/PastasDeReunioes";
import { guardarBuscaRecente, lerBuscasRecentes, limparBuscasRecentes } from "@/lib/buscas-recentes";
import { rotaDaLixeira, rotaDaReuniao } from "@shared/rotas";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import { etiquetasDaDona, etiquetasDaReuniao } from "@shared/detalhes-da-reuniao";
import {
  filtrarReunioesNaTela, MENSAGEM_BUSCAS_DEMAIS, ORIGENS_DO_FILTRO, PERIODOS_DO_FILTRO, temFiltro, TERMO_DA_BUSCA_MAX, termoProntoParaOServidor,
  type FiltrosDaBusca, type OrigemDoFiltro, type PeriodoDoFiltro,
} from "@shared/busca-de-reunioes";
import { podeJuntar } from "@shared/juntar-reunioes";
import { podeIrParaALixeira } from "@shared/lixeira-de-reunioes";
import { PASTAS_POR_DONA_MAX, reuniaoNaVista, VISTAS_DA_LISTA, type VistaDaLista } from "@shared/pastas-de-reunioes";
import { partesComVozes, type ParteDoTextoComVozes } from "@shared/vozes-no-texto";

/**
 * A lista das reuniões da dona com a busca, os filtros e as buscas recentes
 * (H7b), as pastas e os filtros por origem (H7d: "Todas", "Gravadas",
 * "Importadas", "YouTube" e "Pastas") e a seleção de várias reuniões para
 * mover de pasta, juntar (H17) ou mandar para a lixeira (H7d). A busca na tela
 * filtra a lista na hora (título, etiquetas, "Onde foi", contato e contexto);
 * a partir de 3 letras, o servidor busca também na transcrição e nos itens do
 * resumo, e cada resultado abre a reunião no trecho (?q) ou no item (?item). A
 * lixeira tem tela própria (LixeiraDeReunioes), pelo endereço ?lixeira=1.
 */
export type ReuniaoDaLista = {
  id: string;
  title: string;
  createdAt: number;
  status: string;
  origem?: string | null;
  etiquetas?: unknown;
  ondeFoi?: string | null;
  contactId?: number | null;
  contextId?: string | null;
  contatoNome?: string | null;
  contextoNome?: string | null;
  /** Como o áudio chegou (envio único ou partes): a confirmação da junção avisa a retranscrição só quando vale. */
  audioPipeline?: string | null;
  /** A pasta da reunião (H7d), ou nula. */
  folderId?: string | null;
  /** A dona editou a transcrição (H18): a confirmação da junção avisa que as correções não passam. */
  transcricaoEditada?: boolean;
};

const ESPERA_ATE_BUSCAR_MS = 400;

/** O termo depois que a dona para de digitar: o servidor não recebe uma busca por letra. */
function useTermoParado(termo: string) {
  const [parado, setParado] = useState(termo);
  useEffect(() => {
    const espera = setTimeout(() => setParado(termo), ESPERA_ATE_BUSCAR_MS);
    return () => clearTimeout(espera);
  }, [termo]);
  return parado;
}

/**
 * O trecho com o termo destacado (sem caixa); o resto, texto puro. Cada voz
 * (o nome dado ou o rótulo traduzido, de partesComVozes) vai num <bdi>: o
 * dir="auto" de quem mostra o trecho decide a direção pelo resto do texto. Sem
 * isso, o rótulo em árabe no começo de um item em inglês viraria o parágrafo da
 * direita para a esquerda, com o ponto final do lado errado.
 */
function TrechoDestacado({ partes, termo }: { partes: ParteDoTextoComVozes[]; termo: string }) {
  const inteiro = partes.map(parte => parte.texto).join("");
  const procurado = termo.trim();
  const inicioDoTermo = procurado ? inteiro.toLocaleLowerCase().indexOf(procurado.toLocaleLowerCase()) : -1;
  const fimDoTermo = inicioDoTermo < 0 ? -1 : inicioDoTermo + procurado.length;
  let deslocamento = 0;
  return <>{partes.map((parte, indice) => {
    const inicio = deslocamento;
    deslocamento += parte.texto.length;
    // O pedaço do termo que cai nesta parte (o termo pode começar numa voz e seguir no texto).
    const de = Math.max(inicioDoTermo, inicio) - inicio;
    const ate = Math.min(fimDoTermo, deslocamento) - inicio;
    const conteudo = ate > de && de >= 0
      ? <>{parte.texto.slice(0, de)}<mark className="rounded bg-amber-300/25 px-0.5 text-amber-100">{parte.texto.slice(de, ate)}</mark>{parte.texto.slice(ate)}</>
      : parte.texto;
    return parte.voz ? <bdi key={indice}>{conteudo}</bdi> : <Fragment key={indice}>{conteudo}</Fragment>;
  })}</>;
}

/** O trecho do resultado em pedaços: o item do resumo com as vozes à parte; a transcrição, inteira. */
function partesDoTrecho(texto: string, vozes: Readonly<Record<string, string>> | null, rotuloDaVoz: (numero: number) => string): ParteDoTextoComVozes[] {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return vozes ? partesComVozes(limpo, vozes, rotuloDaVoz) : [{ texto: limpo, voz: false }];
}

function ResultadosDoServidor({ termo, filtros, aoAbrir }: { termo: string; filtros: FiltrosDaBusca; aoAbrir: (destino: string) => void }) {
  const { t, i18n } = useTranslation();
  const busca = trpc.meetings.buscar.useQuery({
    termo, etiqueta: filtros.etiqueta ?? undefined, origem: filtros.origem ?? undefined, periodo: filtros.periodo ?? undefined,
    contactId: filtros.contactId ?? undefined, contextId: filtros.contextId ?? undefined,
  }, {
    refetchOnWindowFocus: false,
    // O teto de buscas não melhora repetindo na hora.
    retry: (tentativas, erro) => (erro as { data?: { code?: string } })?.data?.code !== "TOO_MANY_REQUESTS" && tentativas < 2,
  });
  if (busca.isError) {
    const codigo = (busca.error as { data?: { code?: string } })?.data?.code;
    if (codigo === "TOO_MANY_REQUESTS" && busca.error.message === MENSAGEM_BUSCAS_DEMAIS) {
      return <p role="alert" className="text-sm text-amber-200">{t("meetings.search.tooMany")}</p>;
    }
    return <ErroDeConsulta erro={busca.error} aoTentarDeNovo={() => void busca.refetch()} />;
  }
  if (!busca.data) return <p role="status" className="text-sm text-white/50"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.search.searching")}</p>;
  if (!busca.data.resultados.length) return <p className="text-sm text-white/45">{t("meetings.search.noContentResults")}</p>;
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {busca.data.resultados.map(resultado => {
          const destino = resultado.tipo === "item" ? rotaDaReuniao(resultado.meetingId, { item: resultado.itemId }) : rotaDaReuniao(resultado.meetingId, { q: termo });
          const trecho = partesDoTrecho(resultado.trecho, resultado.tipo === "item" ? resultado.nomes : null, numero => t("meetings.speakerLabel", { n: numero }));
          return (
            <li key={resultado.tipo === "item" ? `item-${resultado.itemId}` : `transcricao-${resultado.meetingId}`}>
              <button type="button" onClick={() => aoAbrir(destino)}
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] p-3 text-start hover:bg-white/[0.07]">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span dir="auto" className="min-w-0 break-words text-sm font-semibold text-white">{resultado.titulo}</span>
                  <span className="text-xs text-white/40">{new Date(resultado.criadaEm).toLocaleDateString(i18n.language)}</span>
                </span>
                <span className="mt-1 block text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">
                  {resultado.tipo === "item" ? t("meetings.search.summaryHit") : t("meetings.search.transcriptHit")}
                </span>
                <span dir="auto" className="mt-1 block break-words text-sm text-white/70"><TrechoDestacado partes={trecho} termo={termo} /></span>
              </button>
            </li>
          );
        })}
      </ul>
      {busca.data.maisResultados && <p className="text-xs text-white/45">{t("meetings.search.moreResults")}</p>}
    </div>
  );
}

/** O rótulo de cada vista da lista. O Record é pelo tipo: vista nova lá não compila aqui sem o texto. */
const ROTULO_DA_VISTA: Record<VistaDaLista, (t: (chave: string) => string) => string> = {
  todas: t => t("meetings.views.all"),
  gravadas: t => t("meetings.views.recorded"),
  importadas: t => t("meetings.views.imported"),
  youtube: t => t("meetings.views.youtube"),
  pastas: t => t("meetings.views.folders"),
};

export function ListaDeReunioes({ reunioes, rotuloDoStatus, classeDoStatus, aoAbrir }: {
  reunioes: ReuniaoDaLista[];
  rotuloDoStatus: (reuniao: ReuniaoDaLista) => string;
  classeDoStatus: (status: string) => string;
  aoAbrir: (destino: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  // A conta lida do cache da sessão (o Sair grava null nele), para as buscas
  // recentes serem desta conta. Sem a leitura (o cache ainda vazio), a busca
  // funciona sem as recentes.
  const conta = (() => {
    try {
      return utils.auth.me.getData()?.openId ?? null;
    } catch {
      return null;
    }
  })();
  // As pastas da dona (H7d). Sem a leitura (carregando, ou a consulta em erro),
  // a lista segue com as reuniões, e a vista "Pastas" mostra o erro.
  const consultaDasPastas = trpc.meetings.pastas.useQuery(undefined, { refetchOnWindowFocus: false });
  const pastas: PastaNaTela[] = consultaDasPastas.data ?? [];
  const pastaPorId = useMemo(() => new Map(pastas.map(pasta => [pasta.id, pasta])), [pastas]);
  const [termo, setTermo] = useState("");
  const [filtros, setFiltros] = useState<FiltrosDaBusca>({});
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [recentes, setRecentes] = useState<string[]>([]);
  const [mostraRecentes, setMostraRecentes] = useState(false);
  const [vista, setVista] = useState<VistaDaLista>("todas");
  const [pastaId, setPastaId] = useState<string | null>(null);
  const [editor, setEditor] = useState<"nova" | PastaNaTela | null>(null);
  const [escolhendo, setEscolhendo] = useState(false);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [confirmando, setConfirmando] = useState<"juntar" | "mover" | "lixeira" | null>(null);
  const [mandando, setMandando] = useState(false);
  const campo = useRef<HTMLInputElement | null>(null);
  const termoParado = useTermoParado(termo.trim());
  const agora = useMemo(() => Date.now(), [filtros.periodo]);

  useEffect(() => { setRecentes(lerBuscasRecentes(conta)); }, [conta]);
  // A pasta aberta que deixou de existir (apagada em outra aba) volta às pastas.
  useEffect(() => {
    if (pastaId && consultaDasPastas.isSuccess && !pastaPorId.has(pastaId)) setPastaId(null);
  }, [pastaId, consultaDasPastas.isSuccess, pastaPorId]);

  const buscando = termo.trim().length > 0 || temFiltro(filtros);
  // Na vista "Pastas" sem pasta aberta, a tela mostra as pastas; a busca e os
  // filtros ali procuram nas reuniões que estão em alguma pasta.
  const mostraAsPastas = vista === "pastas" && !pastaId && !buscando;
  const filtradas = useMemo(
    () => filtrarReunioesNaTela(reunioes, termo, filtros, agora).filter(reuniao => reuniaoNaVista(reuniao, vista, pastaId)),
    [reunioes, termo, filtros, agora, vista, pastaId],
  );
  const etiquetas = useMemo(() => etiquetasDaDona(reunioes, i18n.language), [reunioes, i18n.language]);
  const contatos = useMemo(() => {
    const porId = new Map<number, string>();
    for (const reuniao of reunioes) if (reuniao.contactId && reuniao.contatoNome) porId.set(Number(reuniao.contactId), reuniao.contatoNome);
    return Array.from(porId.entries()).sort((a, b) => a[1].localeCompare(b[1], i18n.language));
  }, [reunioes, i18n.language]);
  const contextos = useMemo(() => {
    const porId = new Map<string, string>();
    for (const reuniao of reunioes) if (reuniao.contextId && reuniao.contextoNome) porId.set(reuniao.contextId, reuniao.contextoNome);
    return Array.from(porId.entries()).sort((a, b) => a[1].localeCompare(b[1], i18n.language));
  }, [reunioes, i18n.language]);
  const noServidor = termoProntoParaOServidor(termoParado) && termoParado === termo.trim();
  const pastaAberta = pastaId ? pastaPorId.get(pastaId) ?? null : null;
  // As ações da seleção (mover, juntar, mandar para a lixeira) valem só para as
  // escolhidas que estão na tela agora: a vista, a pasta aberta, a busca e os
  // filtros. A escolhida que a busca escondeu não vai junto sem a dona ver, e
  // a contagem diz só as que vão. Com as pastas na tela (e não as reuniões),
  // nenhuma.
  const naTela = mostraAsPastas ? [] : filtradas;
  const reunioesEscolhidas = naTela.filter(reuniao => escolhidas.includes(reuniao.id));
  const idsEscolhidos = reunioesEscolhidas.map(reuniao => reuniao.id);
  const juntaveis = reunioesEscolhidas.length >= 2 && reunioesEscolhidas.every(podeJuntar);
  const vaoParaALixeira = reunioesEscolhidas.length >= 1 && reunioesEscolhidas.every(podeIrParaALixeira);

  const lembrar = (valor: string) => setRecentes(guardarBuscaRecente(conta, valor));
  const abrir = (destino: string) => {
    if (termo.trim()) lembrar(termo);
    aoAbrir(destino);
  };
  const alternarEscolha = (id: string) => setEscolhidas(atuais => atuais.includes(id) ? atuais.filter(atual => atual !== id) : [...atuais, id]);
  const sairDaEscolha = () => { setEscolhendo(false); setEscolhidas([]); setConfirmando(null); };
  const todasEscolhidas = naTela.length > 0 && naTela.every(reuniao => escolhidas.includes(reuniao.id));
  const escolherTodas = () => setEscolhidas(todasEscolhidas ? [] : naTela.map(reuniao => reuniao.id));
  // Trocar de vista ou de pasta começa a seleção do zero: a dona que marcou
  // reuniões em "Todas" e abriu uma pasta mandaria para a lixeira (ou moveria)
  // também as que não vê.
  const abrirPasta = (id: string | null) => { setPastaId(id); setEscolhidas([]); };
  const mudarDeVista = (nova: VistaDaLista) => { setVista(nova); abrirPasta(null); };

  /**
   * Manda as escolhidas para a lixeira, em lotes do tamanho que o servidor
   * aceita, com o "Desfazer" no aviso (restaura as mesmas). O servidor manda
   * todas ou nenhuma de cada lote: a gravação em partes ainda no ar recusa o
   * lote dela, com o aviso traduzido.
   */
  const mandarParaALixeira = async () => {
    const ids = [...idsEscolhidos];
    setMandando(true);
    const enviadas: string[] = [];
    try {
      for (const lote of emLotes(ids)) {
        await utils.client.meetings.mandarParaALixeira.mutate({ meetingIds: lote });
        enviadas.push(...lote);
      }
      sairDaEscolha();
      toast.success(t("meetings.trash.movedMany", { n: enviadas.length }), {
        duration: 10_000,
        action: { label: t("meetings.trash.undo"), onClick: () => void restaurarComAviso(utils, enviadas, t) },
      });
    } catch (erro) {
      setConfirmando(null);
      // O lote recusado não foi; os anteriores, sim: o aviso diz a recusa, e a
      // lista relida mostra o que saiu. As que já foram saem da seleção e ficam
      // com o "Desfazer".
      setEscolhidas(atuais => atuais.filter(id => !enviadas.includes(id)));
      toast.error(avisoDaRecusaDaLixeira(erro, t, t("meetings.trash.error")), enviadas.length ? {
        duration: 10_000,
        action: { label: t("meetings.trash.undo"), onClick: () => void restaurarComAviso(utils, enviadas, t) },
      } : undefined);
    } finally {
      setMandando(false);
      await Promise.all([utils.meetings.list.invalidate(), utils.meetings.pastas.invalidate(), utils.meetings.lixeira.invalidate()]);
    }
  };

  const selecao = (rotulo: string, valor: string, opcoes: Array<[string, string]>, todas: string, aoMudar: (valor: string) => void) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-white/55">
      {rotulo}
      <select value={valor} onChange={evento => aoMudar(evento.target.value)}
        className="min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-2 py-2 text-sm text-white">
        <option className="bg-white text-[#322C26]" value="">{todas}</option>
        {opcoes.map(([id, nome]) => <option className="bg-white text-[#322C26]" key={id} value={id}>{nome}</option>)}
      </select>
    </label>
  );

  const rotuloDaOrigem: Record<OrigemDoFiltro, string> = {
    audio: t("meetings.search.originAudio"), documento: t("meetings.search.originDocument"), youtube: t("meetings.search.originYoutube"),
  };
  const rotuloDoPeriodo: Record<PeriodoDoFiltro, string> = {
    "7d": t("meetings.search.period7d"), "30d": t("meetings.search.period30d"), "90d": t("meetings.search.period90d"), "365d": t("meetings.search.period365d"),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="relative min-w-0 flex-1">
          {/* O "x" de limpar é o do app, fora do <label> (dentro, o nome dele entrava no nome do
              campo); o "x" nativo do input type=search fica escondido, para não aparecerem dois. */}
          <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 focus-within:border-amber-300/50">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <Search size={16} aria-hidden="true" className="shrink-0 text-white/40" />
              <span className="sr-only">{t("meetings.search.label")}</span>
              <input ref={campo} type="search" value={termo} maxLength={TERMO_DA_BUSCA_MAX} placeholder={t("meetings.search.placeholder")}
                onChange={evento => setTermo(evento.target.value)}
                onFocus={() => setMostraRecentes(true)}
                onBlur={() => setTimeout(() => setMostraRecentes(false), 150)}
                onKeyDown={evento => {
                  // O Enter que confirma a composição do teclado (japonês, chinês) não é uma busca.
                  if (evento.nativeEvent.isComposing) return;
                  if (evento.key === "Enter" && termo.trim()) { lembrar(termo); setMostraRecentes(false); }
                }}
                className="w-full min-w-0 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-white/35 [&::-webkit-search-cancel-button]:hidden" />
            </label>
            {termo && <button type="button" aria-label={t("meetings.search.clear")} onClick={() => { setTermo(""); campo.current?.focus(); }}
              className="shrink-0 rounded-md p-1 text-white/50 hover:text-white"><X size={15} aria-hidden="true" /></button>}
          </div>
          {mostraRecentes && !termo.trim() && recentes.length > 0 && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-white/15 bg-[#211e1b] p-3 shadow-xl">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-white/50">
                <span className="inline-flex items-center gap-1.5"><History size={13} aria-hidden="true" />{t("meetings.search.recent")}</span>
                <button type="button" onMouseDown={evento => evento.preventDefault()} onClick={() => { limparBuscasRecentes(conta); setRecentes([]); }}
                  className="rounded px-1.5 py-0.5 text-amber-200 hover:bg-white/5">{t("meetings.search.clearRecent")}</button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {recentes.map(recente => (
                  <li key={recente}>
                    <button type="button" dir="auto" onMouseDown={evento => evento.preventDefault()} onClick={() => { setTermo(recente); setMostraRecentes(false); }}
                      className="max-w-full break-words rounded-full border border-white/15 px-3 py-1 text-xs text-white/75 hover:bg-white/5">{recente}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-expanded={filtrosAbertos} onClick={() => setFiltrosAbertos(aberto => !aberto)}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${temFiltro(filtros) ? "border-amber-300/50 text-amber-200" : "border-white/15 text-white/70"} hover:bg-white/5`}>
            <SlidersHorizontal size={15} aria-hidden="true" />{t("meetings.search.filters")}
          </button>
          {!escolhendo && (
            <button type="button" onClick={() => setEscolhendo(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2.5 text-sm text-white/70 hover:bg-white/5">
              <ListChecks size={15} aria-hidden="true" />{t("meetings.select.button")}
            </button>
          )}
          <button type="button" onClick={() => aoAbrir(rotaDaLixeira())}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2.5 text-sm text-white/70 hover:bg-white/5">
            <Trash2 size={15} aria-hidden="true" />{t("meetings.trash.open")}
          </button>
        </div>
      </div>

      {/* Os filtros por origem e as pastas (H7d), como no app de referência. Quebram em
          mais de uma linha no celular: rolando de lado, a 375 px "Pastas" (a entrada das
          pastas) ficava fora da tela, sem barra de rolagem no iPhone, e com ela ativa
          nenhuma vista visível aparecia marcada. */}
      <div role="group" aria-label={t("meetings.views.label")} className="flex flex-wrap gap-2">
        {VISTAS_DA_LISTA.map(opcao => (
          <button key={opcao} type="button" aria-pressed={vista === opcao} onClick={() => mudarDeVista(opcao)}
            className={`shrink-0 rounded-full border px-4 py-1.5 text-sm ${vista === opcao ? "border-amber-300/60 bg-amber-300/15 text-amber-100" : "border-white/15 text-white/65 hover:bg-white/5"}`}>
            {ROTULO_DA_VISTA[opcao](t)}
          </button>
        ))}
      </div>

      {filtrosAbertos && (
        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:grid-cols-2 lg:grid-cols-5">
          {selecao(t("meetings.search.tagFilter"), filtros.etiqueta ?? "", etiquetas.map(e => [e, e]), t("meetings.search.anyTag"), valor => setFiltros(f => ({ ...f, etiqueta: valor || null })))}
          {selecao(t("meetings.search.originFilter"), filtros.origem ?? "", ORIGENS_DO_FILTRO.map(o => [o, rotuloDaOrigem[o]]), t("meetings.search.anyOrigin"), valor => setFiltros(f => ({ ...f, origem: (valor || null) as OrigemDoFiltro | null })))}
          {selecao(t("meetings.search.periodFilter"), filtros.periodo ?? "", PERIODOS_DO_FILTRO.map(p => [p, rotuloDoPeriodo[p]]), t("meetings.search.anyPeriod"), valor => setFiltros(f => ({ ...f, periodo: (valor || null) as PeriodoDoFiltro | null })))}
          {selecao(t("meetings.search.contactFilter"), filtros.contactId ? String(filtros.contactId) : "", contatos.map(([id, nome]) => [String(id), nome]), t("meetings.search.anyContact"), valor => setFiltros(f => ({ ...f, contactId: valor ? Number(valor) : null })))}
          {selecao(t("meetings.search.contextFilter"), filtros.contextId ?? "", contextos, t("meetings.search.anyContext"), valor => setFiltros(f => ({ ...f, contextId: valor || null })))}
          {temFiltro(filtros) && <button type="button" onClick={() => setFiltros({})} className="justify-self-start rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 hover:bg-white/5 sm:col-span-2 lg:col-span-5">{t("meetings.search.clearFilters")}</button>}
        </div>
      )}

      {escolhendo && (
        <div role="region" aria-label={t("meetings.select.button")} className="sticky top-2 z-10 flex flex-col gap-3 rounded-2xl border border-amber-300/30 bg-[#2a221c] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/80">
            <div>
              <p>{t("meetings.select.hint")}</p>
              <p className="mt-1 text-xs text-white/50">{t("meetings.select.selected", { n: reunioesEscolhidas.length })}</p>
            </div>
            <button type="button" onClick={escolherTodas} disabled={!naTela.length}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-40">
              {todasEscolhidas ? t("meetings.select.none") : t("meetings.select.all")}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!reunioesEscolhidas.length} onClick={() => setConfirmando("mover")}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-40">
              <FolderInput size={15} aria-hidden="true" />{t("meetings.select.move")}
            </button>
            <button type="button" disabled={!juntaveis} onClick={() => setConfirmando("juntar")}
              aria-describedby={reunioesEscolhidas.length && !reunioesEscolhidas.every(podeJuntar) ? "nao-junta" : undefined}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-40">
              <Merge size={15} aria-hidden="true" />{t("meetings.select.join")}
            </button>
            <button type="button" disabled={!vaoParaALixeira} onClick={() => setConfirmando("lixeira")}
              aria-describedby={reunioesEscolhidas.length && !vaoParaALixeira ? "nao-vai-para-a-lixeira" : undefined}
              className="inline-flex items-center gap-2 rounded-xl border border-red-400/30 px-3 py-2 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-40">
              <Trash2 size={15} aria-hidden="true" />{t("meetings.select.trash")}
            </button>
            <button type="button" onClick={sairDaEscolha} className="ms-auto rounded-xl border border-white/15 px-3 py-2 text-sm text-white/70 hover:bg-white/5">{t("meetings.select.cancel")}</button>
          </div>
          {reunioesEscolhidas.length > 0 && !reunioesEscolhidas.every(podeJuntar) && <p id="nao-junta" className="text-xs text-white/50">{t("meetings.join.notEligible")}</p>}
          {reunioesEscolhidas.length > 0 && !vaoParaALixeira && <p id="nao-vai-para-a-lixeira" className="text-xs text-amber-200/80">{t("meetings.trash.errorRecording")}</p>}
        </div>
      )}

      {vista === "pastas" && pastaAberta && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => abrirPasta(null)} className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white">
            <ArrowLeft size={16} aria-hidden="true" className="rtl:rotate-180" />{t("meetings.folders.back")}
          </button>
          <p className={`inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1 ${CLASSES_DA_COR[pastaAberta.cor].borda} ${CLASSES_DA_COR[pastaAberta.cor].fundo}`}>
            <IconeDaPastaNaTela icone={pastaAberta.icone} cor={pastaAberta.cor} />
            <span dir="auto" className="min-w-0 break-words text-sm font-semibold text-white">{pastaAberta.nome}</span>
          </p>
          <button type="button" onClick={() => setEditor(pastaAberta)} aria-label={t("meetings.folders.edit", { nome: pastaAberta.nome })}
            className="rounded-lg border border-white/15 p-2 text-white/60 hover:bg-white/5 hover:text-white"><Pencil size={14} aria-hidden="true" /></button>
        </div>
      )}

      {mostraAsPastas ? (
        consultaDasPastas.isError ? <ErroDeConsulta erro={consultaDasPastas.error} aoTentarDeNovo={() => void consultaDasPastas.refetch()} />
        : consultaDasPastas.isLoading ? <p role="status" className="text-sm text-white/50"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.loadingList")}</p>
        : (
          <div className="space-y-3">
            {!pastas.length && <p className="text-sm text-white/50">{t("meetings.folders.empty")}</p>}
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pastas.map(pasta => (
                <li key={pasta.id}>
                  <button type="button" onClick={() => abrirPasta(pasta.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-start transition-colors hover:bg-white/[0.07] ${CLASSES_DA_COR[pasta.cor].borda} ${CLASSES_DA_COR[pasta.cor].fundo}`}>
                    <IconeDaPastaNaTela icone={pasta.icone} cor={pasta.cor} tamanho={22} />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" className="block break-words font-semibold text-white">{pasta.nome}</span>
                      <span className="text-xs text-white/50">{t("meetings.folders.meetingsCount", { n: pasta.reunioes })}</span>
                    </span>
                  </button>
                </li>
              ))}
              <li>
                <button type="button" onClick={() => setEditor("nova")} disabled={pastas.length >= PASTAS_POR_DONA_MAX}
                  className="flex h-full w-full items-center gap-3 rounded-2xl border border-dashed border-white/20 p-4 text-start text-amber-200 hover:bg-white/[0.05] disabled:opacity-40">
                  <FolderPlus size={22} aria-hidden="true" className="shrink-0" />
                  <span className="font-semibold">{t("meetings.folders.new")}</span>
                </button>
              </li>
            </ul>
          </div>
        )
      ) : (
        <>
          {buscando && (
            <p className="text-xs font-semibold text-white/55">{t("meetings.search.inMeetings", { n: filtradas.length })}</p>
          )}
          {filtradas.length === 0 && buscando ? (
            <p className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-sm text-white/45">{t("meetings.search.noLocalResults")}</p>
          ) : filtradas.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-sm text-white/45">
              {vista === "pastas" ? t("meetings.folders.emptyFolder") : t("meetings.views.empty")}
            </p>
          ) : (
            <ul className="grid gap-3">
              {filtradas.map(reuniao => {
                const etiquetasDaLinha = etiquetasDaReuniao(reuniao.etiquetas);
                const escolhida = escolhidas.includes(reuniao.id);
                // A pasta da reunião, menos dentro da própria pasta (ali ela já se sabe).
                const pastaDaLinha = reuniao.folderId && reuniao.folderId !== pastaId ? pastaPorId.get(reuniao.folderId) : undefined;
                const conteudo = (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h2 dir="auto" className="break-words text-base font-semibold">
                        {ehReuniaoDeDocumento(reuniao.origem) && <ScanText size={15} aria-label={t("meetings.document.listBadge")} className="me-2 inline text-amber-300" />}{reuniao.title}
                      </h2>
                      <p className="mt-1 text-xs text-white/45">
                        {new Date(reuniao.createdAt).toLocaleString(i18n.language)}
                        {reuniao.origem === "youtube" && <span className="ms-2 inline-flex items-center gap-1 text-[#efcba8]/80"><MonitorPlay size={12} aria-hidden="true" />{t("meetings.youtube.listBadge")}</span>}
                        {reuniao.ondeFoi && <span dir="auto" className="ms-2 inline-flex items-center gap-1 text-white/55"><MapPin size={12} aria-label={t("meetings.details.placeLabel")} />{reuniao.ondeFoi}</span>}
                        {/* O contato e o contexto (H7c): a reunião achada por eles na busca diz por que apareceu. */}
                        {reuniao.contatoNome && <span dir="auto" className="ms-2 inline-flex max-w-full items-center gap-1 break-words text-white/55"><UserRound size={12} aria-label={t("meetings.details.contactLabel")} className="shrink-0" />{reuniao.contatoNome}</span>}
                        {reuniao.contextoNome && <span dir="auto" className="ms-2 inline-flex max-w-full items-center gap-1 break-words text-white/55"><Milestone size={12} aria-label={t("meetings.details.contextLabel")} className="shrink-0" />{reuniao.contextoNome}</span>}
                        {pastaDaLinha && (
                          <span className={`ms-2 inline-flex max-w-full items-center gap-1 break-words ${CLASSES_DA_COR[pastaDaLinha.cor].texto}`} aria-label={t("meetings.folders.badge", { nome: pastaDaLinha.nome })}>
                            <IconeDaPastaNaTela icone={pastaDaLinha.icone} cor={pastaDaLinha.cor} tamanho={12} /><span dir="auto" aria-hidden="true">{pastaDaLinha.nome}</span>
                          </span>
                        )}
                      </p>
                      {etiquetasDaLinha.length > 0 && (
                        <ul aria-label={t("meetings.details.tagsLabel")} className="mt-2 flex flex-wrap gap-1.5">
                          {etiquetasDaLinha.map(etiqueta => <li key={etiqueta} dir="auto" className="inline-flex max-w-full items-center gap-1 break-words rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-100/85"><Tag size={10} aria-hidden="true" />{etiqueta}</li>)}
                        </ul>
                      )}
                    </div>
                    <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${classeDoStatus(reuniao.status)}`}>{rotuloDoStatus(reuniao)}</span>
                  </div>
                );
                return (
                  <li key={reuniao.id}>
                    {escolhendo ? (
                      <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-5 transition-colors hover:bg-white/[0.07] ${escolhida ? "border-amber-300/50 bg-amber-300/[0.07]" : "border-white/10 bg-white/[0.035]"}`}>
                        <input type="checkbox" checked={escolhida} onChange={() => alternarEscolha(reuniao.id)} className="mt-1 h-4 w-4 shrink-0 accent-amber-300" />
                        <span className="min-w-0 flex-1">{conteudo}</span>
                      </label>
                    ) : (
                      <button type="button" onClick={() => aoAbrir(rotaDaReuniao(reuniao.id))} className="w-full rounded-2xl border border-white/10 bg-white/[0.035] p-5 text-start transition-colors hover:bg-white/[0.07]">
                        {conteudo}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {buscando && termo.trim() && (
        <section aria-labelledby="busca-no-conteudo" className="space-y-2 pt-2">
          <h2 id="busca-no-conteudo" className="text-xs font-semibold text-white/55">{t("meetings.search.inContent")}</h2>
          {noServidor
            ? <ResultadosDoServidor termo={termoParado} filtros={filtros} aoAbrir={abrir} />
            : termoProntoParaOServidor(termo) ? <p role="status" className="text-sm text-white/50"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.search.searching")}</p>
            : <p className="text-sm text-white/45">{t("meetings.search.typeMore")}</p>}
        </section>
      )}

      {confirmando === "juntar" && (
        <JuntarReunioes reunioes={reunioesEscolhidas}
          aoFechar={() => setConfirmando(null)}
          aoJuntar={meetingId => { sairDaEscolha(); aoAbrir(rotaDaReuniao(meetingId)); }} />
      )}
      {confirmando === "mover" && (
        <EscolherPasta reunioes={idsEscolhidos} pastas={consultaDasPastas.isSuccess ? pastas : null}
          erro={consultaDasPastas.isError ? consultaDasPastas.error : null} aoTentarDeNovo={() => void consultaDasPastas.refetch()}
          aoFechar={() => setConfirmando(null)} aoMover={sairDaEscolha} />
      )}
      {confirmando === "lixeira" && (
        <div role="dialog" aria-modal="true" aria-labelledby="mandar-para-a-lixeira-titulo" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#211e1b] p-6 shadow-2xl">
            <h3 id="mandar-para-a-lixeira-titulo" className="mb-2 text-base font-bold text-white">{t("meetings.trash.moveConfirmTitle")}</h3>
            <p className="mb-2 text-xs text-white/50">{t("meetings.select.selected", { n: reunioesEscolhidas.length })}</p>
            <p className="mb-6 text-sm text-white/55">{t("meetings.trash.moveConfirmTextMany")}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmando(null)} disabled={mandando} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.trash.cancel")}</button>
              <button type="button" onClick={() => void mandarParaALixeira()} disabled={mandando}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
                {mandando && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t("meetings.trash.moveConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {editor && (
        <EditorDePasta pasta={editor === "nova" ? undefined : editor} aoFechar={() => setEditor(null)}
          aoCriar={id => { setVista("pastas"); abrirPasta(id); }}
          aoApagar={() => abrirPasta(null)} />
      )}
    </div>
  );
}
