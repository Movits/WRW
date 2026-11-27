import { useState } from "react";
import { Handshake, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";

/**
 * A11 / etapa 12 — encerrar a negociação registrando o negócio e a comissão.
 *
 * O dinheiro não passa pela plataforma nesta versão (decisão D2 da cliente), então
 * o que a tela faz é registrar o que foi combinado. É esse registro que sustenta a
 * cobrança depois: sem ele, "fechamos pela plataforma" fica sendo palavra contra palavra.
 *
 * A comissão é calculada na tela enquanto a pessoa digita, para ela ver o número
 * ANTES de confirmar — o servidor recalcula e grava o dele, que é o que vale.
 *
 * `ehParte`: só quem negociou encerra (o servidor recusa os outros). Ouro, que
 * entra na sala para acompanhar, vê o registro quando ele existe e nada antes.
 */
export function EncerrarNegociacao({ roomId, ehParte, onEncerrada }: { roomId: number; ehParte: boolean; onEncerrada: () => void }) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const [valor, setValor] = useState("");
  const [honorarios, setHonorarios] = useState("");
  const [percentual, setPercentual] = useState("");
  const [moeda, setMoeda] = useState<"BRL" | "USD" | "EUR">("BRL");
  const [observacoes, setObservacoes] = useState("");

  const utils = trpc.useUtils();
  const { data: registro } = trpc.dealRoom.getClosure.useQuery({ roomId });

  const encerrar = trpc.dealRoom.closeRoom.useMutation({
    onSuccess: () => {
      toast.success(t("dealRoom.encerrarSucesso"));
      utils.dealRoom.getClosure.invalidate({ roomId });
      setAberto(false);
      onEncerrada();
    },
    onError: erro => toast.error(erro.message || t("dealRoom.encerrarFalha")),
  });

  const numero = (texto: string) => {
    const n = Number(texto.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };
  const nValor = numero(valor);
  const nHonorarios = numero(honorarios);
  const nPercentual = numero(percentual);

  const comissao =
    Number.isFinite(nHonorarios) && Number.isFinite(nPercentual) && nHonorarios >= 0 && nPercentual >= 0
      ? Math.round(nHonorarios * nPercentual) / 100
      : null;

  const podeEnviar =
    Number.isFinite(nValor) && nValor > 0 &&
    Number.isFinite(nHonorarios) && nHonorarios >= 0 && nHonorarios <= nValor &&
    Number.isFinite(nPercentual) && nPercentual >= 0 && nPercentual <= 50;

  // Já registrado: a sala mostra o que foi combinado, para as duas partes conferirem.
  if (registro) {
    return (
      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-5">
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 className="text-emerald-300" size={18} />
          <h3 className="font-semibold text-white">{t("dealRoom.encerradaTitulo")}</h3>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-white/45">{t("dealRoom.campoValor")}</dt>
          <dd className="text-right font-medium text-white tabular-nums">{registro.currency} {registro.dealValue}</dd>
          <dt className="text-white/45">{t("dealRoom.campoHonorarios")}</dt>
          <dd className="text-right font-medium text-white tabular-nums">{registro.currency} {registro.intermediationFee}</dd>
          <dt className="text-white/45">{t("dealRoom.campoPercentual")}</dt>
          <dd className="text-right font-medium text-white tabular-nums">{registro.commissionPercent}%</dd>
          <dt className="font-semibold text-amber-300">{t("dealRoom.campoComissao")}</dt>
          <dd className="text-right font-bold text-amber-300 tabular-nums">{registro.currency} {registro.commissionAmount}</dd>
        </dl>
        {registro.notes && <p className="mt-3 border-t border-white/10 pt-3 text-sm text-white/55">{registro.notes}</p>}
        <p className="mt-3 text-xs text-white/40">{t("dealRoom.encerradaPagamentoFora")}</p>
      </div>
    );
  }

  if (!ehParte) return null;

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="inline-flex items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-300/5 px-4 py-2.5 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-300/10"
      >
        <Handshake size={16} /> {t("dealRoom.encerrarBotao")}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-300/30 bg-amber-300/5 p-5">
      <h3 className="mb-1 font-semibold text-white">{t("dealRoom.encerrarTitulo")}</h3>
      <p className="mb-4 text-sm text-white/50">{t("dealRoom.encerrarSubtitulo")}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/45">{t("dealRoom.campoMoeda")}</span>
          <select
            value={moeda}
            onChange={e => setMoeda(e.target.value as "BRL" | "USD" | "EUR")}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white"
          >
            <option value="BRL">BRL</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/45">{t("dealRoom.campoValor")}</span>
          <input
            inputMode="decimal" value={valor} onChange={e => setValor(e.target.value)} placeholder="0,00"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white tabular-nums placeholder:text-white/25"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/45">{t("dealRoom.campoHonorarios")}</span>
          <input
            inputMode="decimal" value={honorarios} onChange={e => setHonorarios(e.target.value)} placeholder="0,00"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white tabular-nums placeholder:text-white/25"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/45">{t("dealRoom.campoPercentual")}</span>
          <input
            inputMode="decimal" value={percentual} onChange={e => setPercentual(e.target.value)} placeholder="0"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white tabular-nums placeholder:text-white/25"
          />
        </label>
      </div>

      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wider text-white/45">{t("dealRoom.campoObservacoes")}</span>
        <textarea
          value={observacoes} onChange={e => setObservacoes(e.target.value)} rows={2} maxLength={1000}
          className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/25"
          placeholder={t("dealRoom.campoObservacoesPlaceholder")}
        />
      </label>

      {/* O aviso da comissão, que é o coração da A11: a pessoa vê o número antes
          de confirmar, não depois. */}
      <div className="mt-4 rounded-xl border border-amber-300/25 bg-black/20 px-4 py-3">
        <p className="text-xs text-white/50">{t("dealRoom.avisoComissaoTitulo")}</p>
        <p className="mt-1 text-lg font-bold text-amber-300 tabular-nums">
          {comissao === null ? "—" : `${moeda} ${comissao.toFixed(2)}`}
        </p>
        <p className="mt-1 text-xs text-white/45">{t("dealRoom.avisoComissaoDetalhe")}</p>
      </div>

      {Number.isFinite(nHonorarios) && Number.isFinite(nValor) && nHonorarios > nValor && (
        <p className="mt-2 text-xs text-red-300/80">{t("dealRoom.erroHonorariosMaior")}</p>
      )}
      {Number.isFinite(nPercentual) && nPercentual > 50 && (
        <p className="mt-2 text-xs text-red-300/80">{t("dealRoom.erroTetoComissao")}</p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={!podeEnviar || encerrar.isPending}
          onClick={() =>
            encerrar.mutate({
              roomId, currency: moeda,
              dealValue: nValor, intermediationFee: nHonorarios, commissionPercent: nPercentual,
              notes: observacoes.trim() || undefined,
            })
          }
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-[#060e1a] transition-colors hover:bg-amber-400 disabled:opacity-50"
        >
          {encerrar.isPending && <Loader2 className="animate-spin" size={14} />}
          {t("dealRoom.encerrarConfirmar")}
        </button>
        <button
          type="button" onClick={() => setAberto(false)}
          className="rounded-lg px-3 py-2 text-sm text-white/50 hover:text-white/80"
        >
          {t("dealRoom.encerrarCancelar")}
        </button>
      </div>
    </div>
  );
}
