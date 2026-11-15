import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Clock3 } from "lucide-react";
import { toast } from "sonner";
import { PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import { useAvisoDeHora } from "@/hooks/useAvisoDeHora";
import type { EstadoDoGravador } from "@/hooks/useGravadorDeAudio";

/** De quanto em quanto tempo o título da aba troca enquanto o aviso espera o OK. */
export const PISCADA_DO_TITULO_MS = 1000;
/** Uma vibração curta, uma vez por aviso, no aparelho que vibra. */
export const VIBRACAO_DO_AVISO_MS = 400;

/**
 * O aviso de hora da gravação em partes (G13a): a cada hora cheia de gravação,
 * um cartão pequeno pede o OK ("Continuar gravando"). Enquanto espera, o título
 * da aba pisca, para quem está em outra aba ver, e o celular vibra uma vez.
 * Som, não: o microfone gravaria o próprio aviso.
 *
 * Sem o OK em 10 minutos, a gravação para pelo MESMO caminho do Encerrar
 * (`encerrar`), que entrega o que foi gravado, e um aviso que fica na tela até
 * ser fechado diz que ela parou sozinha. A contagem das horas e o prazo estão
 * em hooks/useAvisoDeHora.ts.
 */
export function AvisoDeHoraDeGravacao(props: {
  estado: EstadoDoGravador;
  /** Os segundos gravados (o relógio do gravador, sem as pausas). */
  segundos: number;
  /** Retoma a gravação pausada (o continuar do gravador). */
  retomar: () => void;
  /** O Encerrar do gravador em partes: para e entrega o que foi gravado. */
  encerrar: () => void;
}) {
  const { t } = useTranslation();
  const minutos = PRAZO_DO_AVISO_DE_HORA_MS / 60_000;
  const aviso = useAvisoDeHora({
    estado: props.estado,
    segundos: props.segundos,
    retomar: props.retomar,
    aoExpirar: () => {
      props.encerrar();
      // Fica até ser fechado: quem não confirmou não estava olhando a tela.
      toast.info(t("meetings.hourCheckStopped", { minutos }), { id: "gravacao-parou-sem-confirmacao", duration: Infinity });
    },
  });
  const idDoTitulo = useId();
  const idDaDescricao = useId();
  const botao = useRef<HTMLButtonElement | null>(null);

  // O título da aba alterna com o pedido de confirmação e volta ao original
  // quando o aviso fecha (pelo OK, pelo prazo ou pelo fim da gravação).
  useEffect(() => {
    if (!aviso.aberto) return;
    const original = document.title;
    const chamada = t("meetings.hourCheckTabTitle");
    let comChamada = true;
    document.title = chamada;
    const relogio = window.setInterval(() => {
      comChamada = !comChamada;
      document.title = comChamada ? chamada : original;
    }, PISCADA_DO_TITULO_MS);
    return () => {
      window.clearInterval(relogio);
      document.title = original;
    };
  }, [aviso.aberto, aviso.horas]);

  // Ao abrir: uma vibração (o navegador sem vibração não tem a função) e o foco
  // no OK, para o teclado e o leitor de tela chegarem direto a ele.
  useEffect(() => {
    if (!aviso.aberto) return;
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(VIBRACAO_DO_AVISO_MS);
    botao.current?.focus();
  }, [aviso.aberto, aviso.horas]);

  if (!aviso.aberto) return null;
  return (
    <div role="alertdialog" aria-labelledby={idDoTitulo} aria-describedby={idDaDescricao} className="fixed inset-x-4 top-20 z-50 mx-auto max-w-sm rounded-2xl border border-amber-300/40 bg-[#211e1b] p-4 text-white shadow-2xl">
      <div className="flex items-start gap-3">
        <Clock3 aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-amber-300"/>
        <div className="min-w-0">
          <h2 id={idDoTitulo} className="font-semibold">{t("meetings.hoursOfRecording", { count: aviso.horas })}</h2>
          <p id={idDaDescricao} className="mt-1 text-sm text-white/70">{t("meetings.hourCheckDescription", { minutos })}</p>
        </div>
      </div>
      <button ref={botao} type="button" onClick={aviso.continuar} className="mt-4 w-full rounded-xl bg-[#c98f70] py-3 font-bold text-[#1a120c] hover:bg-[#efcba8]">{t("meetings.resumeRecording")}</button>
    </div>
  );
}
