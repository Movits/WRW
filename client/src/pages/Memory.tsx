import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BrainCircuit, Database, ExternalLink, FileText, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { AppHeader } from "@/components/AppHeader";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { destinoDaFonte } from "@/lib/destino-da-fonte";

// As sugestões são as perguntas-exemplo do próprio requisito da etapa 9: é
// exatamente o que a validação vai digitar, então a tela ensina pelo exemplo.
const SUGGESTION_IDS = ["suggestion1", "suggestion2", "suggestion3", "suggestion4", "suggestion5", "suggestion6"] as const;

const TYPE_KEYS: Record<string, string> = { contact: "memory.typeContact", context: "memory.typeContext", meeting: "memory.typeMeeting" };

export default function Memory() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const { data: status, isLoading: loadingStatus, isError: statusFalhou, error: erroDoStatus, refetch: recarregarStatus } = trpc.memory.status.useQuery();
  const reindex = trpc.memory.reindex.useMutation({
    onSuccess: async (result) => {
      await utils.memory.status.invalidate();
      const partes = [t("memory.updatedIndexed", { count: result.indexed })];
      if (result.removed) partes.push(t("memory.updatedRemoved", { count: result.removed }));
      toast.success(t("memory.updatedToast", { partes: partes.join(t("memory.updatedJoin")) }));
      if (result.pending) toast.info(t("memory.pendingToast", { count: result.pending }));
      if (result.truncated) toast.warning(t("memory.truncatedToast", { count: result.truncated }));
    },
    onError: error => toast.error(error.message || t("memory.errorReindex")),
  });
  const search = trpc.memory.search.useMutation({
    onError: error => toast.error(error.message || t("memory.errorSearch")),
  });

  function submit(value = query) {
    const clean = value.trim();
    if (clean.length < 2) return toast.error(t("memory.errorShortQuery"));
    setQuery(clean);
    search.mutate({ query: clean });
  }

  return <><AppHeader title={t("appHeader.menu.memory")} backTo="/dashboard"/>
  <main className="min-h-screen px-4 py-8 md:px-8 text-white bg-transparent">
    <div className="max-w-5xl mx-auto">
      <section className="rounded-3xl border border-amber-400/20 bg-[radial-gradient(circle_at_top_right,rgba(201,143,112,.15),transparent_38%),rgba(8,18,31,.82)] p-6 md:p-9 overflow-hidden relative">
        <div className="absolute -right-14 -top-14 h-52 w-52 rounded-full border border-amber-300/10" />
        <div className="relative"><p className="text-amber-300 text-xs font-bold tracking-[.18em]">{t("memory.eyebrow")}</p><h1 className="text-3xl md:text-4xl font-bold mt-2">{t("memory.title")}</h1><p className="max-w-2xl mt-3 text-white/60">{t("memory.subtitle")}</p>
          <div className="mt-7 flex flex-col md:flex-row gap-3"><div className="relative flex-1"><Search size={19} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40"/><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") submit(); }} placeholder={t("memory.searchPlaceholder")} className="w-full rounded-xl border border-white/15 bg-[#151312]/80 py-4 pl-12 pr-4 outline-none focus:border-amber-300"/></div><button onClick={() => submit()} disabled={search.isPending} className="rounded-xl bg-[#c98f70] px-6 py-4 font-bold text-[#1a120c] disabled:opacity-60 inline-flex justify-center items-center gap-2">{search.isPending ? <Loader2 className="animate-spin" size={19}/> : <Sparkles size={19}/>}{t("memory.searchButton")}</button></div>
          <div className="mt-4 flex flex-wrap gap-2">{SUGGESTION_IDS.map(id => { const pergunta = t(`memory.${id}`); return <button key={id} onClick={() => submit(pergunta)} className="rounded-full border border-white/15 bg-white/[.04] px-3 py-1.5 text-xs text-white/65 hover:border-amber-300/50 hover:text-amber-100">{pergunta}</button>; })}</div>
        </div>
      </section>

      {/* Consulta falhou não é "0 registro(s) guardado(s)": a memória existe,
          o servidor é que não respondeu. */}
      {statusFalhou ? <div className="mt-5"><ErroDeConsulta erro={erroDoStatus} aoTentarDeNovo={() => recarregarStatus()} /></div> : <section className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[.035] p-4"><div className="flex items-center gap-3"><div className="grid place-items-center h-10 w-10 rounded-xl bg-amber-400/10 text-amber-300"><Database size={19}/></div><div><p className="text-sm font-semibold">{t("memory.privateMemory")}</p><p className="text-xs text-white/45">{loadingStatus ? t("memory.checkingStatus") : t("memory.documentsStored", { count: status?.documents ?? 0 })}{status?.lastIndexedAt ? t("memory.updatedAt", { data: new Date(status.lastIndexedAt).toLocaleDateString(i18n.language) }) : ""}</p></div></div><button onClick={() => reindex.mutate()} disabled={reindex.isPending} className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-sm text-amber-200 hover:bg-amber-300/10 disabled:opacity-50">{reindex.isPending ? <Loader2 size={16} className="animate-spin"/> : <RefreshCw size={16}/>}{t("memory.reindexButton")}</button></section>}

      {search.isPending && <section className="mt-6 rounded-2xl border border-white/10 bg-white/[.035] p-10 text-center"><BrainCircuit className="mx-auto animate-pulse text-amber-300" size={34}/><h2 className="mt-4 font-semibold">{t("memory.searchingTitle")}</h2><p className="mt-2 text-sm text-white/45">{t("memory.searchingSubtitle")}</p></section>}
      {search.data && <section className="mt-6 space-y-5">{(search.data.pending ?? 0) > 0 && <div className="rounded-xl border border-sky-300/30 bg-sky-300/10 px-4 py-3 text-sm text-sky-100/85">{t("memory.pendingBanner", { count: search.data.pending })}</div>}{(search.data.truncated ?? 0) > 0 && <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100/85">{t("memory.truncatedBanner", { count: search.data.truncated })}</div>}<div className="rounded-2xl border border-amber-400/20 bg-amber-400/[.06] p-5"><div className="flex items-center gap-2 text-amber-300"><Sparkles size={18}/><h2 className="font-semibold">{t("memory.answerTitle")}</h2></div><p className="mt-3 whitespace-pre-wrap leading-7 text-white/85">{search.data.answer}</p></div><div><h2 className="text-lg font-semibold mb-3">{t("memory.sourcesTitle")}</h2>{search.data.hits.length ? <div className="grid md:grid-cols-2 gap-3">{search.data.hits.map((hit, index) => <article key={hit.id} className="rounded-2xl border border-white/10 bg-white/[.035] p-5"><div className="flex items-start justify-between gap-3"><div><span className="text-xs text-amber-300">[{index + 1}] {TYPE_KEYS[hit.sourceType] ? t(TYPE_KEYS[hit.sourceType]) : hit.sourceType}</span><h3 className="font-semibold mt-1">{hit.title}</h3></div><span className="text-xs text-white/40">{t("memory.relevance", { percent: Math.round(hit.score * 100) })}</span></div><p className="mt-3 text-sm leading-6 text-white/55 line-clamp-4">{hit.content}</p>{destinoDaFonte(hit) && <button onClick={() => navigate(destinoDaFonte(hit) as string)} className="mt-4 inline-flex items-center gap-1 text-sm text-amber-300 hover:text-amber-200">{t("memory.openSource")} <ExternalLink size={14}/></button>}</article>)}</div> : <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-white/45"><FileText className="mx-auto mb-3" size={25}/>{t("memory.noSources")}</div>}</div></section>}
    </div>
  </main></>;
}
