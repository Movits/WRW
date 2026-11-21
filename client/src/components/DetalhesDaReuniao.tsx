import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MapPin, Pencil, Search, Tag, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import {
  chaveDaEtiqueta, ehRecusaDosDetalhes, ETIQUETA_MAX, ETIQUETAS_POR_REUNIAO_MAX, etiquetasDaReuniao, normalizarEtiquetas, ONDE_FOI_MAX,
  RECUSAS_DOS_DETALHES,
} from "@shared/detalhes-da-reuniao";

/**
 * Os detalhes da reunião (H7c): as etiquetas, o "Onde foi", o contato e o
 * contexto, à vista no detalhe, e o "Editar detalhes", que muda também o
 * título. Só a dona: o link aberto não leva nada disto. O servidor normaliza e
 * confere a posse do contato e do contexto (meetings.atualizarDetalhes); a
 * recusa sai pelo código, no idioma da tela.
 */
export type DetalhesNaTela = {
  titulo: string;
  etiquetas?: unknown;
  ondeFoi?: string | null;
  contato?: { id: number; nome: string } | null;
  contexto?: { id: string; nome: string } | null;
};

function avisoDoErro(erro: unknown, t: (chave: string) => string) {
  const { message, data } = (erro ?? {}) as { message?: unknown; data?: { code?: unknown } };
  if (ehRecusaDosDetalhes(message)) return message === RECUSAS_DOS_DETALHES.contato ? t("meetings.details.contactNotFound") : t("meetings.details.contextNotFound");
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && data?.code) {
    const traduzida = traduzirMensagemDoServidor(message, t);
    if (traduzida !== message) return traduzida;
  }
  return t("meetings.details.error");
}

/** Escolher o contato: procura na rede da dona (network.list), como o "Vincular a um contato". */
function EscolherContato({ aoEscolher }: { aoEscolher: (contato: { id: number; nome: string }) => void }) {
  const { t } = useTranslation();
  const [busca, setBusca] = useState("");
  const termo = busca.trim();
  const procura = trpc.network.list.useQuery({ q: termo, limit: 8, page: 1 }, { enabled: termo.length >= 2, refetchOnWindowFocus: false });
  return (
    <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <label className="block text-xs text-white/55">
        {t("reuniaoNoMatch.vincularProcurar")}
        <span className="mt-1 flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2">
          <Search size={14} aria-hidden="true" className="shrink-0 text-white/40" />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t("reuniaoNoMatch.vincularProcurarPlaceholder")} maxLength={100}
            className="w-full bg-transparent py-1.5 text-sm text-white outline-none placeholder:text-white/30" />
        </span>
      </label>
      {termo.length >= 2 && (procura.isError ? (
        <div className="mt-2"><ErroDeConsulta erro={procura.error} aoTentarDeNovo={() => void procura.refetch()} /></div>
      ) : !procura.data ? (
        <p role="status" className="mt-2 text-xs text-white/45"><Loader2 size={13} className="me-1.5 inline animate-spin" aria-hidden="true" />{t("networkPanel.loading")}</p>
      ) : procura.data.data.length === 0 ? (
        <p className="mt-2 text-xs text-white/45">{t("reuniaoNoMatch.vincularNenhum")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {procura.data.data.map(contato => (
            <li key={contato.id}>
              <button type="button" onClick={() => aoEscolher({ id: Number(contato.id), nome: contato.fullName })}
                className="w-full rounded-lg border border-white/10 px-3 py-2 text-start text-sm text-white/85 hover:bg-white/5">
                <span dir="auto" className="font-semibold">{contato.fullName}</span>{contato.company && <span className="text-white/45"> · {contato.company}</span>}
              </button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/** Escolher o contexto: os da dona e os do catálogo (contexts.list), pelo nome. */
function EscolherContexto({ aoEscolher }: { aoEscolher: (contexto: { id: string; nome: string }) => void }) {
  const { t } = useTranslation();
  const [busca, setBusca] = useState("");
  const lista = trpc.contexts.list.useQuery({ q: busca.trim() || undefined, limit: 20, page: 1 }, { refetchOnWindowFocus: false });
  return (
    <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <label className="block text-xs text-white/55">
        {t("meetings.details.chooseContext")}
        <span className="mt-1 flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2">
          <Search size={14} aria-hidden="true" className="shrink-0 text-white/40" />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} maxLength={100}
            className="w-full bg-transparent py-1.5 text-sm text-white outline-none" />
        </span>
      </label>
      {lista.isError ? (
        <div className="mt-2"><ErroDeConsulta erro={lista.error} aoTentarDeNovo={() => void lista.refetch()} /></div>
      ) : !lista.data ? (
        <p role="status" className="mt-2 text-xs text-white/45"><Loader2 size={13} className="me-1.5 inline animate-spin" aria-hidden="true" />{t("networkPanel.loading")}</p>
      ) : lista.data.data.length === 0 ? (
        <p className="mt-2 text-xs text-white/45">{t("meetings.details.noContextFound")}</p>
      ) : (
        <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
          {lista.data.data.map(contexto => (
            <li key={contexto.id}>
              <button type="button" onClick={() => aoEscolher({ id: contexto.id, nome: contexto.name })}
                className="w-full rounded-lg border border-white/10 px-3 py-2 text-start text-sm text-white/85 hover:bg-white/5">
                <span dir="auto" className="font-semibold">{contexto.name}</span>{contexto.typeName && <span className="text-white/45"> · {contexto.typeName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({ meetingId, detalhes, etiquetasSugeridas, aoFechar }: {
  meetingId: string; detalhes: DetalhesNaTela; etiquetasSugeridas: string[]; aoFechar: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [titulo, setTitulo] = useState(detalhes.titulo);
  const [etiquetas, setEtiquetas] = useState<string[]>(() => etiquetasDaReuniao(detalhes.etiquetas));
  const [novaEtiqueta, setNovaEtiqueta] = useState("");
  const [ondeFoi, setOndeFoi] = useState(detalhes.ondeFoi ?? "");
  const [contato, setContato] = useState(detalhes.contato ?? null);
  const [contexto, setContexto] = useState(detalhes.contexto ?? null);
  const [escolhendo, setEscolhendo] = useState<"contato" | "contexto" | null>(null);
  const salvar = trpc.meetings.atualizarDetalhes.useMutation({
    onSuccess: async () => {
      toast.success(t("meetings.details.saved"));
      await Promise.all([utils.meetings.get.invalidate({ meetingId }), utils.meetings.list.invalidate()]);
      aoFechar();
    },
    onError: erro => toast.error(avisoDoErro(erro, t)),
  });
  const acrescentar = (bruta: string) => {
    const juntas = normalizarEtiquetas([...etiquetas, bruta]) ?? [];
    setEtiquetas(juntas);
    setNovaEtiqueta("");
  };
  const tituloValido = titulo.trim().length >= TITULO_DA_REUNIAO_MIN;
  const cheia = etiquetas.length >= ETIQUETAS_POR_REUNIAO_MAX;
  const sugeridas = etiquetasSugeridas.filter(sugerida => !etiquetas.some(atual => chaveDaEtiqueta(atual) === chaveDaEtiqueta(sugerida))).slice(0, 12);
  const campoDeTexto = "mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-amber-300/50";

  return (
    <form className="mt-4 space-y-4" onSubmit={evento => {
      evento.preventDefault();
      if (!tituloValido || salvar.isPending) return;
      // A etiqueta escrita e ainda não acrescentada vai junto.
      const finais = novaEtiqueta.trim() ? normalizarEtiquetas([...etiquetas, novaEtiqueta]) ?? [] : etiquetas;
      salvar.mutate({ meetingId, titulo: titulo.trim(), etiquetas: finais, ondeFoi: ondeFoi.trim() || null, contactId: contato?.id ?? null, contextId: contexto?.id ?? null });
    }}>
      <label className="block text-xs text-white/55">
        {t("meetings.details.titleLabel")}
        <input dir="auto" value={titulo} onChange={evento => setTitulo(evento.target.value)} maxLength={TITULO_DA_REUNIAO_MAX} required minLength={TITULO_DA_REUNIAO_MIN} className={campoDeTexto} />
      </label>
      <div>
        <label className="block text-xs text-white/55">
          {t("meetings.details.tagsLabel")}
          <input dir="auto" value={novaEtiqueta} disabled={cheia} maxLength={ETIQUETA_MAX} placeholder={t("meetings.details.tagsPlaceholder")}
            onChange={evento => setNovaEtiqueta(evento.target.value)}
            onKeyDown={evento => {
              // O Enter que confirma a composição do teclado (japonês, chinês) é do teclado, não da etiqueta.
              if (evento.nativeEvent.isComposing) return;
              if ((evento.key === "Enter" || evento.key === ",") && novaEtiqueta.trim()) { evento.preventDefault(); acrescentar(novaEtiqueta); }
            }}
            className={campoDeTexto} />
        </label>
        <p className="mt-1 text-[11px] text-white/40">{t("meetings.details.tagsHelp", { max: ETIQUETAS_POR_REUNIAO_MAX, letras: ETIQUETA_MAX })}</p>
        {etiquetas.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {etiquetas.map(etiqueta => (
              <li key={etiqueta} className="inline-flex max-w-full items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/10 py-0.5 ps-2.5 pe-1 text-xs text-amber-100">
                <span dir="auto" className="break-words">{etiqueta}</span>
                <button type="button" aria-label={t("meetings.details.removeTag", { etiqueta })} onClick={() => setEtiquetas(atuais => atuais.filter(atual => atual !== etiqueta))}
                  className="rounded-full p-0.5 hover:bg-white/10"><X size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        {sugeridas.length > 0 && !cheia && (
          <div className="mt-2">
            <p className="text-[11px] text-white/40">{t("meetings.details.tagSuggestions")}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {sugeridas.map(sugerida => (
                <li key={sugerida}>
                  <button type="button" dir="auto" onClick={() => acrescentar(sugerida)} className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-white/65 hover:bg-white/5">+ {sugerida}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <label className="block text-xs text-white/55">
        {t("meetings.details.placeLabel")}
        <input dir="auto" value={ondeFoi} onChange={evento => setOndeFoi(evento.target.value)} maxLength={ONDE_FOI_MAX} placeholder={t("meetings.details.placePlaceholder")} className={campoDeTexto} />
      </label>
      <div>
        <p className="text-xs text-white/55">{t("meetings.details.contactLabel")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span dir="auto" className="text-sm text-white/85">{contato?.nome ?? t("meetings.details.none")}</span>
          <button type="button" onClick={() => setEscolhendo(atual => atual === "contato" ? null : "contato")} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/70 hover:bg-white/5">{contato ? t("meetings.details.change") : t("meetings.details.choose")}</button>
          {contato && <button type="button" onClick={() => setContato(null)} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/60 hover:bg-white/5">{t("meetings.details.remove")}</button>}
        </div>
        {escolhendo === "contato" && <EscolherContato aoEscolher={escolhido => { setContato(escolhido); setEscolhendo(null); }} />}
      </div>
      <div>
        <p className="text-xs text-white/55">{t("meetings.details.contextLabel")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span dir="auto" className="text-sm text-white/85">{contexto?.nome ?? t("meetings.details.none")}</span>
          <button type="button" onClick={() => setEscolhendo(atual => atual === "contexto" ? null : "contexto")} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/70 hover:bg-white/5">{contexto ? t("meetings.details.change") : t("meetings.details.choose")}</button>
          {contexto && <button type="button" onClick={() => setContexto(null)} className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/60 hover:bg-white/5">{t("meetings.details.remove")}</button>}
        </div>
        {escolhendo === "contexto" && <EscolherContexto aoEscolher={escolhido => { setContexto(escolhido); setEscolhendo(null); }} />}
      </div>
      <div className="flex gap-3">
        <button type="button" onClick={aoFechar} disabled={salvar.isPending} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.details.cancel")}</button>
        <button type="submit" disabled={!tituloValido || salvar.isPending}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#c98f70] py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
          {salvar.isPending && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t("meetings.details.save")}
        </button>
      </div>
    </form>
  );
}

export function DetalhesDaReuniao({ meetingId, detalhes, etiquetasSugeridas }: {
  meetingId: string;
  detalhes: DetalhesNaTela;
  /** As etiquetas que a dona já usou nas outras reuniões, para sugerir. */
  etiquetasSugeridas?: string[];
}) {
  const { t } = useTranslation();
  const [editando, setEditando] = useState(false);
  const etiquetas = etiquetasDaReuniao(detalhes.etiquetas);
  const vazio = !etiquetas.length && !detalhes.ondeFoi && !detalhes.contato && !detalhes.contexto;
  return (
    <section aria-labelledby="detalhes-da-reuniao" className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="detalhes-da-reuniao" className="text-sm font-semibold text-white/80">{t("meetings.details.heading")}</h2>
        {!editando && (
          <button type="button" onClick={() => setEditando(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5">
            <Pencil size={13} aria-hidden="true" />{t("meetings.details.edit")}
          </button>
        )}
      </div>
      {!editando && (vazio ? (
        <p className="mt-2 text-sm text-white/45">{t("meetings.details.empty")}</p>
      ) : (
        <div className="mt-3 space-y-2 text-sm text-white/75">
          {etiquetas.length > 0 && (
            <ul aria-label={t("meetings.details.tagsLabel")} className="flex flex-wrap gap-1.5">
              {etiquetas.map(etiqueta => <li key={etiqueta} dir="auto" className="inline-flex max-w-full items-center gap-1 break-words rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-0.5 text-xs text-amber-100"><Tag size={11} aria-hidden="true" />{etiqueta}</li>)}
            </ul>
          )}
          {detalhes.ondeFoi && <p className="flex items-center gap-2"><MapPin size={14} aria-hidden="true" className="shrink-0 text-white/45" /><span className="text-white/50">{t("meetings.details.placeLabel")}:</span> <span dir="auto" className="break-words">{detalhes.ondeFoi}</span></p>}
          {detalhes.contato && <p className="flex items-center gap-2"><UserRound size={14} aria-hidden="true" className="shrink-0 text-white/45" /><span className="text-white/50">{t("meetings.details.contactLabel")}:</span> <span dir="auto" className="break-words">{detalhes.contato.nome}</span></p>}
          {detalhes.contexto && <p className="flex items-center gap-2"><MapPin size={14} aria-hidden="true" className="shrink-0 text-white/45" /><span className="text-white/50">{t("meetings.details.contextLabel")}:</span> <span dir="auto" className="break-words">{detalhes.contexto.nome}</span></p>}
        </div>
      ))}
      {editando && <Editor meetingId={meetingId} detalhes={detalhes} etiquetasSugeridas={etiquetasSugeridas ?? []} aoFechar={() => setEditando(false)} />}
    </section>
  );
}
