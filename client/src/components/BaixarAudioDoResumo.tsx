import { useEffect, useId, useRef, useState } from "react";
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
 * O resumo longo leva minutos: o servidor responde "gerando" antes do corte do
 * proxy, e a tela pede de novo a cada ESPERA_ENTRE_PEDIDOS_MS até o MP3 chegar.
 * Como o download então começa longe do toque (o Safari do iPhone pode
 * ignorá-lo), o link "Salvar o áudio" fica à vista para a dona tocar.
 * "Ouvir o resumo" (a voz do aparelho, H19) segue ao lado, sem servidor.
 */
/** Quanto a tela espera para pedir de novo o áudio que o servidor ainda gera. */
export const ESPERA_ENTRE_PEDIDOS_MS = 5_000;

export function BaixarAudioDoResumo({ meetingId, idioma, titulo }: { meetingId: string; idioma: string; titulo?: string | null }) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const idDoAviso = useId();
  const [salvar, setSalvar] = useState<{ endereco: string; nome: string } | null>(null);
  const [esperando, setEsperando] = useState(false);
  const relogio = useRef<number | undefined>(undefined);
  const enderecoAtual = useRef<string | null>(null);
  // Cancelado ou fora da tela: a resposta que ainda chegar não pede de novo nem baixa.
  const ativo = useRef(true);
  useEffect(() => {
    ativo.current = true;
    return () => {
      ativo.current = false;
      window.clearTimeout(relogio.current);
      if (enderecoAtual.current) URL.revokeObjectURL(enderecoAtual.current);
    };
  }, []);
  const baixar = trpc.meetings.audioDoResumo.useMutation({
    onSuccess: resposta => {
      if (!ativo.current) return;
      if (resposta.estado === "gerando") {
        setEsperando(true);
        relogio.current = window.setTimeout(() => baixar.mutate({ meetingId, idioma }), ESPERA_ENTRE_PEDIDOS_MS);
        return;
      }
      setEsperando(false);
      const bytes = Uint8Array.from(atob(resposta.mp3Base64), letra => letra.charCodeAt(0));
      const endereco = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const nome = nomeDoArquivoDoAudio(`${titulo || resposta.titulo} (${resposta.idioma})`, "mp3");
      const link = document.createElement("a");
      link.href = endereco;
      link.download = nome;
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (enderecoAtual.current) URL.revokeObjectURL(enderecoAtual.current);
      enderecoAtual.current = endereco;
      setSalvar({ endereco, nome });
    },
    onError: () => setEsperando(false),
  });
  const ocupado = baixar.isPending || esperando;
  const pedir = () => {
    ativo.current = true;
    baixar.mutate({ meetingId, idioma });
  };
  const fechar = () => {
    ativo.current = false;
    window.clearTimeout(relogio.current);
    if (enderecoAtual.current) URL.revokeObjectURL(enderecoAtual.current);
    enderecoAtual.current = null;
    setSalvar(null);
    setEsperando(false);
    baixar.reset();
    setAberto(false);
  };
  // Trocar o idioma do resumo fecha o painel: o "Salvar o áudio" do idioma de
  // antes e uma espera em curso não valem para o idioma novo (conferência de tela).
  const idiomaDoPainel = useRef(idioma);
  useEffect(() => {
    if (idiomaDoPainel.current === idioma) return;
    idiomaDoPainel.current = idioma;
    if (aberto) fechar();
  }, [idioma]);

  if (!aberto) {
    return <button type="button" onClick={() => setAberto(true)}
      className="inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-1.5 text-sm font-semibold text-amber-100 hover:bg-amber-300/10">
      <Download size={15} aria-hidden/> {t("meetings.summary.audioDownload.button")}
    </button>;
  }
  return <div role="group" aria-describedby={idDoAviso} className="w-full max-w-sm rounded-lg border border-amber-300/30 bg-black/20 p-3 text-xs text-amber-100/80 sm:w-auto">
    <p id={idDoAviso}>{t("meetings.summary.audioDownload.notice")}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      {salvar
        ? <a href={salvar.endereco} download={salvar.nome}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-[#1a120c]">
          <Download size={14} aria-hidden/> {t("meetings.summary.audioDownload.save")}
        </a>
        : <button type="button" disabled={ocupado} onClick={pedir}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-[#1a120c] disabled:opacity-60">
          {ocupado ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <Download size={14} aria-hidden/>}
          {ocupado ? t("meetings.summary.audioDownload.generating") : t("meetings.summary.audioDownload.confirm")}
        </button>}
      <button type="button" onClick={fechar}
        className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70">{t(salvar ? "meetings.summary.audioDownload.close" : "meetings.summary.audioDownload.cancel")}</button>
    </div>
    {baixar.isError && <p role="alert" className="mt-2 text-red-200">{mensagemDaRecusaDoAudioDoResumo(baixar.error, t)}</p>}
  </div>;
}
