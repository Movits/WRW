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
 *
 * O espaço segue a altura da barra (D1b). No celular, abaixo de sm, ela tem
 * duas linhas de 44 px (a linha do tempo e os botões) e, com o aviso em duas
 * linhas e a área segura do iPhone, chega a uns 170 px: max-sm:pb-44 (176 px).
 * De sm para cima é uma linha só, e o pb-36 (144 px) sobra. O md:pb-36 repete
 * o valor de propósito: as páginas usam md:p-8, que vem depois do pb-36 no CSS
 * e, sem ele, deixava só 32 px embaixo no computador.
 */
export const ESPACO_DA_BARRA_DO_PLAYER = "pb-36 max-sm:pb-44 md:pb-36";

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
        <PlayerDasPartes ref={ref} partes={partes} aoFalhar={aoFalhar} aoCarregar={aoCarregar}/>
        {/* Sempre montado: o leitor de tela anuncia o aviso quando ele aparece. */}
        <p role="status" className={aviso ? "text-xs text-amber-200/80 mt-1" : "sr-only"}>{aviso ?? ""}</p>
      </div>
    </div>
  );
});
