import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, RotateCcw, ScanText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { emLotes } from "@/components/PastasDeReunioes";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import { diasRestantesNaLixeira, RECUSAS_DA_LIXEIRA, type CodigoDaRecusaDaLixeira } from "@shared/lixeira-de-reunioes";

/**
 * A lixeira das reuniões (H7d; HN-67 no app de referência da cliente:
 * "Excluídas recentemente"). A ÚNICA tela que mostra a reunião da lixeira, e
 * só para a dona: o título, a data e quantos dias faltam para ela sair de vez.
 * Restaurar a devolve à lista; "Apagar de vez" e "Esvaziar a lixeira" excluem
 * pelo caminho de sempre, com confirmação. O servidor confere a dona, a
 * reunião de fora e o prazo (server/lixeira-de-reunioes.ts).
 */

const AVISO_POR_RECUSA: Record<CodigoDaRecusaDaLixeira, (t: (chave: string) => string) => string> = {
  [RECUSAS_DA_LIXEIRA.gravando]: t => t("meetings.trash.errorRecording"),
  [RECUSAS_DA_LIXEIRA.vencida]: t => t("meetings.trash.errorExpired"),
};

/** O aviso de cada recusa da lixeira (o código do servidor), no idioma da tela. */
export function avisoDaRecusaDaLixeira(erro: unknown, t: (chave: string) => string, padrao: string): string {
  const { message, data } = (erro ?? {}) as { message?: unknown; data?: { code?: unknown } };
  if (typeof message === "string" && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA, message)) {
    return AVISO_POR_RECUSA[message as CodigoDaRecusaDaLixeira](t);
  }
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && data?.code) {
    const traduzida = traduzirMensagemDoServidor(message, t);
    if (traduzida !== message) return traduzida;
  }
  return padrao;
}

type Utilidades = ReturnType<typeof trpc.useUtils>;
type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;

/**
 * O "Desfazer" do aviso de ida para a lixeira (a lista e o detalhe): restaura
 * as mesmas reuniões, em lotes do tamanho que o servidor aceita, e relê a
 * lista, as pastas e a lixeira. A recusa do servidor vira o aviso traduzido:
 * quem chama é o botão do aviso, quando a tela que o abriu já pode ter saído.
 */
export async function restaurarComAviso(utils: Utilidades, ids: readonly string[], t: Traduzir): Promise<void> {
  try {
    for (const lote of emLotes(ids)) await utils.client.meetings.restaurarDaLixeira.mutate({ meetingIds: lote });
    toast.success(ids.length === 1 ? t("meetings.trash.restoredOne") : t("meetings.trash.restoredMany", { n: ids.length }));
  } catch (erro) {
    toast.error(avisoDaRecusaDaLixeira(erro, t, t("meetings.trash.restoreError")));
  }
  await Promise.all([utils.meetings.list.invalidate(), utils.meetings.pastas.invalidate(), utils.meetings.lixeira.invalidate()]);
}

type Confirmacao = { tipo: "apagar"; id: string; titulo: string } | { tipo: "esvaziar" } | null;

export function LixeiraDeReunioes({ aoVoltar }: { aoVoltar: () => void }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const lixeira = trpc.meetings.lixeira.useQuery(undefined, { refetchOnWindowFocus: false });
  const [confirmacao, setConfirmacao] = useState<Confirmacao>(null);
  const [esvaziando, setEsvaziando] = useState(false);
  // A hora da leitura, para os dias que faltam não mudarem a cada render.
  const agora = lixeira.dataUpdatedAt || Date.now();
  const atualizar = () => Promise.all([utils.meetings.lixeira.invalidate(), utils.meetings.list.invalidate(), utils.meetings.pastas.invalidate()]);
  const restaurar = trpc.meetings.restaurarDaLixeira.useMutation({
    onSuccess: async () => { await atualizar(); toast.success(t("meetings.trash.restoredOne")); },
    onError: erro => toast.error(avisoDaRecusaDaLixeira(erro, t, t("meetings.trash.restoreError"))),
  });
  const apagar = trpc.meetings.apagarDeVez.useMutation({
    onSuccess: async () => { setConfirmacao(null); await atualizar(); toast.success(t("meetings.trash.deletedForever")); },
    onError: erro => { setConfirmacao(null); toast.error(avisoDaRecusaDaLixeira(erro, t, t("meetings.trash.deleteError"))); },
  });
  // Uma rodada por pedido (o servidor exclui até 10 de cada vez), enquanto restar alguma.
  const esvaziar = async () => {
    setEsvaziando(true);
    try {
      let rodada = await utils.client.meetings.esvaziarLixeira.mutate();
      for (let voltas = 0; rodada.restam && voltas < 100; voltas += 1) rodada = await utils.client.meetings.esvaziarLixeira.mutate();
      toast.success(t("meetings.trash.emptied"));
    } catch (erro) {
      toast.error(avisoDaRecusaDaLixeira(erro, t, t("meetings.trash.deleteError")));
    } finally {
      setEsvaziando(false);
      setConfirmacao(null);
      await atualizar();
    }
  };
  const ocupado = restaurar.isPending || apagar.isPending || esvaziando;
  const reunioes = lixeira.data ?? [];

  return (
    <section aria-labelledby="lixeira-titulo" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <button type="button" onClick={aoVoltar} className="mb-3 inline-flex items-center gap-2 text-sm text-white/60 hover:text-white">
            <ArrowLeft size={16} aria-hidden="true" className="rtl:rotate-180" />{t("meetings.trash.back")}
          </button>
          <h2 id="lixeira-titulo" className="flex items-center gap-2 text-2xl font-bold"><Trash2 size={22} aria-hidden="true" className="text-white/60" />{t("meetings.trash.title")}</h2>
          <p className="mt-2 max-w-2xl text-sm text-white/55">{t("meetings.trash.subtitle")}</p>
        </div>
        {reunioes.length > 0 && (
          <button type="button" onClick={() => setConfirmacao({ tipo: "esvaziar" })} disabled={ocupado}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-red-400/30 px-4 py-2.5 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-50">
            {esvaziando ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
            {esvaziando ? t("meetings.trash.emptying") : t("meetings.trash.emptyButton")}
          </button>
        )}
      </div>

      {lixeira.isLoading ? (
        <p role="status" className="py-14 text-center text-white/45"><Loader2 className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.loadingList")}</p>
      ) : lixeira.isError ? (
        <ErroDeConsulta erro={lixeira.error} aoTentarDeNovo={() => void lixeira.refetch()} />
      ) : !reunioes.length ? (
        <p className="rounded-3xl border border-dashed border-white/15 px-6 py-16 text-center text-white/45">{t("meetings.trash.empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {reunioes.map(reuniao => (
            <li key={reuniao.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p dir="auto" className="break-words font-semibold">
                  {ehReuniaoDeDocumento(reuniao.origem) && <ScanText size={15} aria-label={t("meetings.document.listBadge")} className="me-2 inline text-amber-300" />}{reuniao.title}
                </p>
                <p className="mt-1 text-xs text-white/45">{new Date(reuniao.createdAt).toLocaleString(i18n.language)}</p>
                <p className="mt-1 text-xs text-amber-200/80">{t("meetings.trash.daysLeft", { n: diasRestantesNaLixeira(reuniao.trashedAt, agora) })}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => restaurar.mutate({ meetingIds: [reuniao.id] })} disabled={ocupado}
                  aria-label={t("meetings.trash.restoreNamed", { titulo: reuniao.title })}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50">
                  <RotateCcw size={15} aria-hidden="true" />{t("meetings.trash.restore")}
                </button>
                <button type="button" onClick={() => setConfirmacao({ tipo: "apagar", id: reuniao.id, titulo: reuniao.title })} disabled={ocupado}
                  aria-label={t("meetings.trash.deleteForeverNamed", { titulo: reuniao.title })}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-400/25 px-3 py-2 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-50">
                  <Trash2 size={15} aria-hidden="true" />{t("meetings.trash.deleteForever")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmacao && (
        <div role="dialog" aria-modal="true" aria-labelledby="confirmar-lixeira-titulo" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#211e1b] p-6 shadow-2xl">
            <h3 id="confirmar-lixeira-titulo" className="mb-2 font-bold text-white">
              {confirmacao.tipo === "esvaziar" ? t("meetings.trash.emptyConfirmTitle") : t("meetings.trash.deleteForeverConfirmTitle")}
            </h3>
            {confirmacao.tipo === "apagar" && <p dir="auto" className="mb-2 break-words text-sm font-semibold text-white/80">{confirmacao.titulo}</p>}
            <p className="mb-6 text-sm text-white/55">
              {confirmacao.tipo === "esvaziar" ? t("meetings.trash.emptyConfirmText") : t("meetings.trash.deleteForeverConfirmText")}
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmacao(null)} disabled={ocupado} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.trash.cancel")}</button>
              <button type="button" disabled={ocupado}
                onClick={() => (confirmacao.tipo === "esvaziar" ? void esvaziar() : apagar.mutate({ meetingIds: [confirmacao.id] }))}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
                {(apagar.isPending || esvaziando) && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                {confirmacao.tipo === "esvaziar" ? t("meetings.trash.emptyConfirm") : t("meetings.trash.deleteForeverConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
