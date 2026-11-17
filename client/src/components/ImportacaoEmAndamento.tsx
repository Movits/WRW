import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import type { AndamentoDaImportacao } from "@/hooks/useImportacaoEmPartes";

/**
 * O andamento do MP3 importado em partes (H9a), no lugar dos botões do
 * gravador: a leitura do arquivo (em porcentagem dos bytes), depois as partes
 * enviadas, e o Cancelar, que exclui a reunião que o envio criou. Não pede
 * confirmação: o arquivo continua no aparelho da dona, e enviar de novo é só
 * escolhê-lo outra vez.
 */
export function ImportacaoEmAndamento({ andamento, aoCancelar }: { andamento: Exclude<AndamentoDaImportacao, { fase: "parada" }>; aoCancelar: () => void }) {
  const { t } = useTranslation();
  const cancelando = andamento.fase === "cancelando";
  const porcento = andamento.fase === "lendo"
    ? (andamento.total > 0 ? Math.floor((andamento.lidos / andamento.total) * 100) : 0)
    : andamento.fase === "enviando" ? Math.floor((andamento.enviadas / Math.max(1, andamento.total)) * 100) : null;
  const texto = andamento.fase === "lendo"
    ? t("meetings.importReading", { porcento })
    : andamento.fase === "enviando"
      ? t("meetings.importSending", { atual: Math.min(andamento.enviadas + 1, andamento.total), total: andamento.total })
      : t("meetings.importCanceling");
  return (
    <div className="space-y-3 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4">
      <p role="status" className="text-sm text-amber-100"><Loader2 className="inline animate-spin mr-2" size={16}/>{texto}</p>
      {/* Sem o valor (cancelando), a barra fica indeterminada, como pede o ARIA. */}
      <div role="progressbar" aria-label={t("meetings.importProgressLabel")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={porcento ?? undefined} aria-valuetext={texto} className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full bg-amber-300 transition-all ${porcento === null ? "w-full animate-pulse" : ""}`} style={porcento === null ? undefined : { width: `${porcento}%` }}/>
      </div>
      <p className="text-xs text-white/45">{t("meetings.importKeepOpen")}</p>
      <button type="button" onClick={aoCancelar} disabled={cancelando} className="w-full rounded-xl border border-white/20 py-3 text-sm text-white/75 hover:bg-white/5 inline-flex justify-center gap-2 disabled:opacity-40"><X size={16}/> {t("meetings.importCancel")}</button>
    </div>
  );
}
