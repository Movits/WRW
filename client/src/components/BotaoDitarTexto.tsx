import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { gravacaoDeAudioSuportada, useGravadorDeAudio, type AudioGravado } from "@/hooks/useGravadorDeAudio";

/**
 * "Gravar áudio" como alternativa a digitar (Rosber, 14/09 19:10).
 *
 * Grava no navegador (useGravadorDeAudio), manda ao servidor, que transcreve com o
 * Gemini (assistenteTexto.transcrever), e entrega o TEXTO a quem usa o botão,
 * que o põe no campo. A pessoa revisa e edita ali; nada é salvo até ela
 * confirmar o formulário. O áudio não fica guardado em lugar nenhum.
 *
 * Os limites espelham server/assistente-de-texto.ts: 2 minutos (a gravação para
 * sozinha) e 3 MB.
 */
export const LIMITE_GRAVACAO_SEGUNDOS = 120;
const LIMITE_AUDIO_BYTES = 3 * 1024 * 1024;

type Estado = "parado" | "pedindoMicrofone" | "gravando" | "transcrevendo";

/** Texto ditado entra DEPOIS do que já estava escrito, nunca por cima. */
export function juntarTextoDitado(atual: string, ditado: string): string {
  const novo = ditado.trim();
  if (!novo) return atual;
  const antes = atual.trimEnd();
  return antes ? `${antes} ${novo}` : novo;
}

function lerComoDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(leitor.error);
    leitor.onload = () => resolve(String(leitor.result));
    leitor.readAsDataURL(blob);
  });
}

const minutos = (segundos: number) => `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}`;

export function BotaoDitarTexto({ onTexto, desabilitado = false }: {
  onTexto: (texto: string) => void;
  desabilitado?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [transcrevendo, setTranscrevendo] = useState(false);

  const transcrever = trpc.assistenteTexto.transcrever.useMutation();
  // A gravação termina alguns segundos depois de começar: o texto tem de ir para
  // o valor ATUAL do campo, não para o da hora em que ela clicou em gravar.
  const onTextoAtual = useRef(onTexto);
  onTextoAtual.current = onTexto;

  // Saiu da tela GRAVANDO: o hook para o microfone e não manda nada. O que já foi
  // enviado segue e é entregue ao campo (ver `enviar`): quem avança de etapa
  // durante o "Transcrevendo…" não perde o ditado.
  const gravador = useGravadorDeAudio({
    limiteSegundos: LIMITE_GRAVACAO_SEGUNDOS,
    bitsPorSegundo: 64_000,
    aoTerminar: audio => void enviar(audio),
    aoFalhar: () => toast.error(t("assistenteTexto.microfoneNegado")),
  });
  // Enquanto o navegador fecha o arquivo, o botão continua o de parar.
  const estado: Estado = transcrevendo ? "transcrevendo"
    : gravador.estado === "pedindoMicrofone" ? "pedindoMicrofone"
    : gravador.estado === "parado" ? "parado"
    : "gravando";

  async function enviar({ blob, mimeType }: AudioGravado) {
    if (!blob.size) {
      toast.error(t("assistenteTexto.audioVazio"));
      return;
    }
    if (blob.size > LIMITE_AUDIO_BYTES) {
      toast.error(t("assistenteTexto.audioGrande"));
      return;
    }
    setTranscrevendo(true);
    try {
      const audioBase64 = await lerComoDataUrl(blob);
      const { texto } = await transcrever.mutateAsync({ audioBase64, mimeType, idioma: i18n.language });
      // Entrega mesmo se o campo saiu da tela durante a transcrição (ex.: Continuar
      // no cadastro): a pessoa já parou a gravação e espera o texto no campo, e o
      // pedido já contou no limite. `onTextoAtual` é o da última renderização.
      onTextoAtual.current(texto);
      toast.success(t("assistenteTexto.transcricaoPronta"));
    } catch (erro) {
      const codigo = (erro as { data?: { code?: string } } | null)?.data?.code;
      toast.error(t(codigo === "TOO_MANY_REQUESTS" ? "assistenteTexto.muitosPedidos"
        // O servidor recusa o áudio grande e também a fala de mais de 2 minutos.
        : codigo === "PAYLOAD_TOO_LARGE" ? "assistenteTexto.audioGrande"
        : "assistenteTexto.erroTranscrever"));
    } finally {
      // Com o campo já fora da tela, o React ignora a troca de estado.
      setTranscrevendo(false);
    }
  }

  function comecar() {
    if (!gravacaoDeAudioSuportada()) {
      toast.error(t("assistenteTexto.semSuporte"));
      return;
    }
    void gravador.comecar();
  }

  function parar() {
    gravador.parar();
  }

  const segundos = gravador.segundos;
  const base = "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  if (estado === "gravando") {
    return (
      <button type="button" onClick={parar} aria-live="polite"
        className={`${base} border-red-400/50 bg-red-500/10 text-red-200 hover:bg-red-500/20`}>
        <Square size={12} className="fill-current" aria-hidden />
        <span>{t("assistenteTexto.parar")}</span>
        <span className="tabular-nums text-red-200/70">
          {t("assistenteTexto.gravando", { tempo: minutos(segundos), limite: minutos(LIMITE_GRAVACAO_SEGUNDOS) })}
        </span>
      </button>
    );
  }

  return (
    <button type="button" onClick={comecar} disabled={desabilitado || estado !== "parado"}
      title={t("assistenteTexto.gravarDica")} aria-live="polite" aria-busy={estado !== "parado" || undefined}
      className={`${base} border-white/15 bg-white/5 text-white/70 hover:border-[#c98f70]/50 hover:text-white`}>
      {estado === "transcrevendo"
        ? <><Loader2 size={13} className="animate-spin" aria-hidden /> {t("assistenteTexto.transcrevendo")}</>
        : estado === "pedindoMicrofone"
          ? <><Loader2 size={13} className="animate-spin" aria-hidden /> {t("assistenteTexto.gravar")}</>
          : <><Mic size={13} aria-hidden /> {t("assistenteTexto.gravar")}</>}
    </button>
  );
}
