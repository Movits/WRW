import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { PlayerDasPartes, type ControleDoPlayer, type ParteDoPlayer } from "./PlayerDasPartes";

/**
 * O player da reunião fixo no rodapé da tela (H4b do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), como no app de referência da
 * cliente: um só para todas as abas, sempre à vista, e o áudio segue tocando ao
 * trocar de aba. O "▶ mm:ss" da transcrição, do resumo e das respostas leva a
 * ele (o ref repassa o `irPara` do PlayerDasPartes). A página que o usa reserva
 * espaço embaixo (ESPACO_DA_BARRA_DO_PLAYER) para o conteúdo não ficar coberto.
 */
export const ESPACO_DA_BARRA_DO_PLAYER = "pb-36";

export const BarraDoPlayer = forwardRef<ControleDoPlayer, {
  partes: ParteDoPlayer[];
  /** Aviso curto embaixo do player (o áudio que não carregou). */
  aviso?: string | null;
  aoFalhar?: () => void;
  aoCarregar?: () => void;
}>(function BarraDoPlayer({ partes, aviso, aoFalhar, aoCarregar }, ref) {
  const { t } = useTranslation();
  if (!partes.length) return null;
  return (
    <div
      role="region"
      aria-label={t("meetings.recordingHeading")}
      data-barra-do-player
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#16130f]/95 backdrop-blur px-4 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
    >
      <div className="max-w-5xl mx-auto">
        <PlayerDasPartes ref={ref} partes={partes} aoFalhar={aoFalhar} aoCarregar={aoCarregar} className="w-full"/>
        {aviso && <p role="status" className="text-xs text-amber-200/80 mt-1">{aviso}</p>}
      </div>
    </div>
  );
});
