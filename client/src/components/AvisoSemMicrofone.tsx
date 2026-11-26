import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MicOff, RefreshCw } from "lucide-react";

/** Duas vibrações curtas, uma vez por queda, no aparelho que vibra: diferente do aviso de hora, que vibra uma. */
export const VIBRACAO_SEM_MICROFONE_MS = [250, 120, 250];

function vibrar() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(VIBRACAO_SEM_MICROFONE_MS);
  } catch {
    // Vibrar é enfeite, nunca pode derrubar a gravação: há navegador (e
    // iframe) que responde com SecurityError em vez de só não vibrar.
  }
}

/**
 * O aviso do microfone que caiu no meio da gravação em partes (G17; HN-81 do
 * HiNoter), no lugar dos botões de pausa: a gravação espera um microfone e
 * segue sozinha quando ele voltar (hooks/useGravadorDeAudio.ts). Ao aparecer,
 * o leitor de tela o anuncia (role="alert") e o celular vibra, para quem está
 * com o aparelho no bolso. Som, não: o microfone que voltar gravaria o aviso.
 *
 * Com o microfone recusado pelo navegador (a permissão que caiu junto), o hook
 * não pede mais sozinho, e o texto diz como liberar; o "Tentar de novo" pede
 * dentro do toque, nos dois casos.
 *
 * O título da aba não pisca aqui, de propósito: o aviso de hora
 * (AvisoDeHoraDeGravacao) pode estar piscando ao mesmo tempo, e os dois
 * brigariam pelo título, que podia ficar preso no texto de um deles.
 */
export function AvisoSemMicrofone({ bloqueado, aoTentarDeNovo }: { bloqueado: boolean; aoTentarDeNovo: () => void }) {
  const { t } = useTranslation();
  useEffect(() => { vibrar(); }, []);
  return (
    <div role="alert" className="mb-4 rounded-xl border border-red-300/30 bg-red-400/10 p-4 text-sm text-red-50">
      <p className="inline-flex items-center gap-2 font-semibold"><MicOff size={16} aria-hidden className="shrink-0 text-red-200"/>{t("meetings.micLost.title")}</p>
      <p className="mt-1 text-red-50/80">{bloqueado ? t("meetings.micLost.blocked") : t("meetings.micLost.body")}</p>
      <button type="button" onClick={aoTentarDeNovo}
        className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-red-200/30 px-4 py-2 text-sm font-semibold text-red-50 hover:bg-red-300/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-300">
        <RefreshCw size={15} aria-hidden/>{t("meetings.micLost.retry")}
      </button>
    </div>
  );
}
