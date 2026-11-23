import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { mensagemDaRecusaDoAudioDoResumo } from "@/lib/mensagem-de-erro";
import { nomeDoArquivoDoAudio } from "@shared/baixar-audio";

/**
 * "Baixar o áudio do resumo" (H19b, server/resumo-em-audio.ts): o MP3 com a voz
 * do Gemini, só sob demanda e só para a dona. O primeiro toque abre o aviso do
 * que vai à Google e do que fica guardado (texto para a Cris revisar); o
 * "Gerar e baixar" pede o arquivo. O servidor gera uma vez por texto e idioma
 * e serve de novo do bucket. O arquivo chega em base64 e sai como download.
 * "Ouvir o resumo" (a voz do aparelho, H19) segue ao lado, sem servidor.
 */
export function BaixarAudioDoResumo({ meetingId, idioma, titulo }: { meetingId: string; idioma: string; titulo?: string | null }) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const idDoAviso = useId();
  const baixar = trpc.meetings.audioDoResumo.useMutation({
    onSuccess: resposta => {
      const bytes = Uint8Array.from(atob(resposta.mp3Base64), letra => letra.charCodeAt(0));
      const endereco = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const link = document.createElement("a");
      link.href = endereco;
      link.download = nomeDoArquivoDoAudio(`${titulo || resposta.titulo} (${resposta.idioma})`, "mp3");
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(endereco), 60_000);
      setAberto(false);
    },
  });

  if (!aberto) {
    return <button type="button" onClick={() => setAberto(true)}
      className="inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-1.5 text-sm font-semibold text-amber-100 hover:bg-amber-300/10">
      <Download size={15} aria-hidden/> {t("meetings.summary.audioDownload.button")}
    </button>;
  }
  return <div role="group" aria-describedby={idDoAviso} className="w-full max-w-sm rounded-lg border border-amber-300/30 bg-black/20 p-3 text-xs text-amber-100/80 sm:w-auto">
    <p id={idDoAviso}>{t("meetings.summary.audioDownload.notice")}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={baixar.isPending} onClick={() => baixar.mutate({ meetingId, idioma })}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-[#1a120c] disabled:opacity-60">
        {baixar.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <Download size={14} aria-hidden/>}
        {baixar.isPending ? t("meetings.summary.audioDownload.generating") : t("meetings.summary.audioDownload.confirm")}
      </button>
      <button type="button" disabled={baixar.isPending} onClick={() => { baixar.reset(); setAberto(false); }}
        className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 disabled:opacity-60">{t("meetings.summary.audioDownload.cancel")}</button>
    </div>
    {baixar.isError && <p role="alert" className="mt-2 text-red-200">{mensagemDaRecusaDoAudioDoResumo(baixar.error, t)}</p>}
  </div>;
}
