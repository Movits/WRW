import { useTranslation } from "react-i18next";
import { CircleAlert, Loader2, X } from "lucide-react";
import type { AndamentoDaImportacao } from "@/hooks/useImportacaoEmPartes";

/** A parte que está subindo (a seguinte às já enviadas) e o total, para "parte N de M". */
const parteDaVez = ({ enviadas, total }: { enviadas: number; total: number }) => ({ atual: Math.min(enviadas + 1, total), total });

/**
 * O andamento do MP3 importado em partes (H9a), no lugar dos botões do
 * gravador: a leitura do arquivo (em porcentagem dos bytes), depois as partes
 * enviadas, e o Cancelar, que exclui a reunião que o envio criou. Não pede
 * confirmação: o arquivo continua no aparelho da dona, e enviar de novo é só
 * escolhê-lo outra vez.
 *
 * A parte que não subiu (rede, servidor ocupado) vai de novo: o texto diz que
 * o envio está tentando de novo, e o Cancelar segue valendo. Sem a tela acesa
 * garantida (`telaPodeApagar`: o iPhone, ou o navegador sem Wake Lock), o
 * aviso de manter o app aberto vira o de manter a tela acesa, porque o
 * aparelho bloqueado suspende a página e o envio para.
 */
export function ImportacaoEmAndamento({ andamento, aoCancelar, telaPodeApagar = false }: { andamento: Exclude<AndamentoDaImportacao, { fase: "parada" }>; aoCancelar: () => void; telaPodeApagar?: boolean }) {
  const { t } = useTranslation();
  const cancelando = andamento.fase === "cancelando";
  const porcento = andamento.fase === "lendo"
    ? (andamento.total > 0 ? Math.floor((andamento.lidos / andamento.total) * 100) : 0)
    : andamento.fase === "enviando" ? Math.floor((andamento.enviadas / Math.max(1, andamento.total)) * 100) : null;
  const texto = andamento.fase === "lendo"
    ? t("meetings.importReading", { porcento })
    : andamento.fase === "enviando"
      ? andamento.tentandoDeNovo ? t("meetings.importRetrying", parteDaVez(andamento)) : t("meetings.importSending", parteDaVez(andamento))
      : t("meetings.importCanceling");
  return (
    <div className="space-y-3 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4">
      {/* me-2, e não mr-2: em árabe (RTL) o ícone fica à direita do texto, e a margem tem de acompanhá-lo. */}
      <p role="status" className="text-sm text-amber-100"><Loader2 className="inline animate-spin me-2" size={16}/>{texto}</p>
      {/* Sem o valor (cancelando), a barra fica indeterminada, como pede o ARIA. */}
      <div role="progressbar" aria-label={t("meetings.importProgressLabel")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={porcento ?? undefined} aria-valuetext={texto} className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full bg-amber-300 transition-all ${porcento === null ? "w-full animate-pulse" : ""}`} style={porcento === null ? undefined : { width: `${porcento}%` }}/>
      </div>
      {telaPodeApagar
        ? <p role="note" className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100"><CircleAlert size={14} className="inline me-2"/>{t("meetings.importKeepScreenOpenNotice")}</p>
        : <p className="text-xs text-white/45">{t("meetings.importKeepOpen")}</p>}
      <button type="button" onClick={aoCancelar} disabled={cancelando} className="w-full rounded-xl border border-white/20 py-3 text-sm text-white/75 hover:bg-white/5 inline-flex justify-center gap-2 disabled:opacity-40"><X size={16}/> {t("meetings.importCancel")}</button>
    </div>
  );
}
