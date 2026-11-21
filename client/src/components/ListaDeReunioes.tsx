import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, MapPin, Merge, MonitorPlay, ScanText, Search, SlidersHorizontal, Tag, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { JuntarReunioes } from "@/components/JuntarReunioes";
import { guardarBuscaRecente, lerBuscasRecentes, limparBuscasRecentes } from "@/lib/buscas-recentes";
import { rotaDaReuniao } from "@shared/rotas";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import { etiquetasDaDona, etiquetasDaReuniao } from "@shared/detalhes-da-reuniao";
import {
  filtrarReunioesNaTela, MENSAGEM_BUSCAS_DEMAIS, ORIGENS_DO_FILTRO, PERIODOS_DO_FILTRO, temFiltro, TERMO_DA_BUSCA_MAX, termoProntoParaOServidor,
  type FiltrosDaBusca, type OrigemDoFiltro, type PeriodoDoFiltro,
} from "@shared/busca-de-reunioes";
import { podeJuntar } from "@shared/juntar-reunioes";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * A lista das reuniões da dona com a busca, os filtros e as buscas recentes
 * (H7b) e a escolha das reuniões para juntar (H17). A busca na tela filtra a
 * lista na hora (título, etiquetas, "Onde foi", contato e contexto); a partir
 * de 3 letras, o servidor busca também na transcrição e nos itens do resumo, e
 * cada resultado abre a reunião no trecho (?q) ou no item (?item).
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

/** O trecho com o termo destacado (sem caixa); o resto, texto puro. */
function TrechoDestacado({ texto, termo }: { texto: string; termo: string }) {
  const limpo = texto.replace(/\s+/g, " ").trim();
  const procurado = termo.trim();
  const posicao = procurado ? limpo.toLocaleLowerCase().indexOf(procurado.toLocaleLowerCase()) : -1;
  if (posicao < 0) return <>{limpo}</>;
  return <>{limpo.slice(0, posicao)}<mark className="rounded bg-amber-300/25 px-0.5 text-amber-100">{limpo.slice(posicao, posicao + procurado.length)}</mark>{limpo.slice(posicao + procurado.length)}</>;
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
          const trecho = resultado.tipo === "item" ? vozesNoTexto(resultado.trecho, resultado.nomes, numero => t("meetings.speakerLabel", { n: numero })) : resultado.trecho;
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
                <span dir="auto" className="mt-1 block break-words text-sm text-white/70"><TrechoDestacado texto={trecho} termo={termo} /></span>
              </button>
            </li>
          );
        })}
      </ul>
      {busca.data.maisResultados && <p className="text-xs text-white/45">{t("meetings.search.moreResults")}</p>}
    </div>
  );
}

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
  const [termo, setTermo] = useState("");
  const [filtros, setFiltros] = useState<FiltrosDaBusca>({});
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [recentes, setRecentes] = useState<string[]>([]);
  const [mostraRecentes, setMostraRecentes] = useState(false);
  const [escolhendo, setEscolhendo] = useState(false);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [confirmando, setConfirmando] = useState(false);
  const campo = useRef<HTMLInputElement | null>(null);
  const termoParado = useTermoParado(termo.trim());
  const agora = useMemo(() => Date.now(), [filtros.periodo]);

  useEffect(() => { setRecentes(lerBuscasRecentes(conta)); }, [conta]);

  const filtradas = useMemo(() => filtrarReunioesNaTela(reunioes, termo, filtros, agora), [reunioes, termo, filtros, agora]);
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
  const buscando = termo.trim().length > 0 || temFiltro(filtros);
  const noServidor = termoProntoParaOServidor(termoParado) && termoParado === termo.trim();

  const lembrar = (valor: string) => setRecentes(guardarBuscaRecente(conta, valor));
  const abrir = (destino: string) => {
    if (termo.trim()) lembrar(termo);
    aoAbrir(destino);
  };
  const alternarEscolha = (id: string) => setEscolhidas(atuais => atuais.includes(id) ? atuais.filter(atual => atual !== id) : [...atuais, id]);
  const sairDaEscolha = () => { setEscolhendo(false); setEscolhidas([]); setConfirmando(false); };
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
          <label className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 focus-within:border-amber-300/50">
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
              className="w-full min-w-0 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-white/35" />
            {termo && <button type="button" aria-label={t("meetings.search.clear")} onClick={() => { setTermo(""); campo.current?.focus(); }}
              className="shrink-0 rounded-md p-1 text-white/50 hover:text-white"><X size={15} /></button>}
          </label>
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
        <div className="flex gap-2">
          <button type="button" aria-expanded={filtrosAbertos} onClick={() => setFiltrosAbertos(aberto => !aberto)}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${temFiltro(filtros) ? "border-amber-300/50 text-amber-200" : "border-white/15 text-white/70"} hover:bg-white/5`}>
            <SlidersHorizontal size={15} aria-hidden="true" />{t("meetings.search.filters")}
          </button>
          {!escolhendo && reunioes.some(podeJuntar) && (
            <button type="button" onClick={() => setEscolhendo(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2.5 text-sm text-white/70 hover:bg-white/5">
              <Merge size={15} aria-hidden="true" />{t("meetings.join.button")}
            </button>
          )}
        </div>
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
        <div role="region" aria-label={t("meetings.join.button")} className="sticky top-2 z-10 flex flex-col gap-3 rounded-2xl border border-amber-300/30 bg-[#2a221c] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-white/80">
            <p>{t("meetings.join.selectHint")}</p>
            <p className="mt-1 text-xs text-white/50">{t("meetings.join.selected", { n: escolhidas.length })}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={sairDaEscolha} className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5">{t("meetings.join.cancel")}</button>
            <button type="button" disabled={escolhidas.length < 2} onClick={() => setConfirmando(true)}
              className="rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">{t("meetings.join.continue")}</button>
          </div>
        </div>
      )}

      {buscando && (
        <p className="text-xs font-semibold text-white/55">{t("meetings.search.inMeetings", { n: filtradas.length })}</p>
      )}
      {filtradas.length === 0 && buscando ? (
        <p className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-sm text-white/45">{t("meetings.search.noLocalResults")}</p>
      ) : (
        <ul className="grid gap-3">
          {filtradas.map(reuniao => {
            const etiquetasDaLinha = etiquetasDaReuniao(reuniao.etiquetas);
            const escolhivel = podeJuntar(reuniao);
            const escolhida = escolhidas.includes(reuniao.id);
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
                  <label className={`flex items-start gap-3 rounded-2xl border p-5 transition-colors ${escolhida ? "border-amber-300/50 bg-amber-300/[0.07]" : "border-white/10 bg-white/[0.035]"} ${escolhivel ? "cursor-pointer hover:bg-white/[0.07]" : "opacity-50"}`}>
                    <input type="checkbox" checked={escolhida} disabled={!escolhivel} onChange={() => alternarEscolha(reuniao.id)}
                      aria-describedby={escolhivel ? undefined : `nao-junta-${reuniao.id}`} className="mt-1 h-4 w-4 shrink-0 accent-amber-300" />
                    <span className="min-w-0 flex-1">
                      {conteudo}
                      {!escolhivel && <span id={`nao-junta-${reuniao.id}`} className="mt-2 block text-xs text-white/50">{t("meetings.join.notEligible")}</span>}
                    </span>
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

      {buscando && termo.trim() && (
        <section aria-labelledby="busca-no-conteudo" className="space-y-2 pt-2">
          <h2 id="busca-no-conteudo" className="text-xs font-semibold text-white/55">{t("meetings.search.inContent")}</h2>
          {noServidor
            ? <ResultadosDoServidor termo={termoParado} filtros={filtros} aoAbrir={abrir} />
            : termoProntoParaOServidor(termo) ? <p role="status" className="text-sm text-white/50"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.search.searching")}</p>
            : <p className="text-sm text-white/45">{t("meetings.search.typeMore")}</p>}
        </section>
      )}

      {confirmando && (
        <JuntarReunioes reunioes={reunioes.filter(reuniao => escolhidas.includes(reuniao.id))}
          aoFechar={() => setConfirmando(false)}
          aoJuntar={meetingId => { sairDaEscolha(); aoAbrir(rotaDaReuniao(meetingId)); }} />
      )}
    </div>
  );
}
