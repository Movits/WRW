import { useTranslation } from "react-i18next";
import { ExternalLink, MonitorPlay } from "lucide-react";
import { SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX, urlCanonicaDoYoutube } from "@shared/youtube";

/**
 * O vídeo do YouTube de onde a reunião veio (H13), no lugar da gravação: o
 * link para o vídeo, que abre numa aba nova, e o aviso de que só a primeira
 * hora foi transcrita. Não há player embutido: a CSP da WRW não deixa a página
 * carregar frames de outros sites (frame-src 'none'), e o "▶" de cada fala
 * abre o vídeo no segundo dela. Serve ao detalhe da dona e ao link aberto
 * (`peloLink`), que não leva o aviso de privacidade da conta dela.
 */
export function VideoDoYoutube({ id, peloLink = false }: { id: string; peloLink?: boolean }) {
  const { t } = useTranslation();
  return <>
    <h2 className="inline-flex items-center gap-2 text-base font-semibold"><MonitorPlay size={16} className="text-amber-300" aria-hidden/>{t("meetings.youtube.videoHeading")}</h2>
    <div className="mt-3">
      <a href={urlCanonicaDoYoutube(id)} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-[#c98f70]/40 px-3 py-2 text-sm font-semibold text-[#efcba8] hover:bg-[#c98f70]/10">
        <ExternalLink size={15} aria-hidden/>{t("meetings.youtube.openOnYoutube")} <span className="sr-only">({t("meetings.youtube.newTab")})</span>
      </a>
    </div>
    <p className="mt-3 text-sm text-white/50">{t("meetings.youtube.firstHourNote", { minutos: SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX / 60 })}</p>
    {!peloLink && <p className="mt-3 text-sm text-white/50">{t("meetings.youtube.privacyNotice")}</p>}
  </>;
}
