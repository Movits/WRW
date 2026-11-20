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
/** O id fixo do aviso "parou sozinha": a gravação seguinte o fecha por ele (toast.dismiss). */
export const ID_DO_AVISO_PAROU_SOZINHA = "gravacao-parou-sem-confirmacao";

/** "Menos movimento" pedido ao sistema; sem matchMedia (o jsdom), não pediu. */
const movimentoReduzido = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function vibrar() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(VIBRACAO_DO_AVISO_MS);
  } catch {
    // Vibrar é enfeite, nunca pode derrubar a gravação: há navegador (e
    // iframe) que responde com SecurityError em vez de só não vibrar.
  }
}

/**
 * O aviso de hora da gravação em partes (G13a): a cada hora cheia de gravação,
 * um cartão pequeno pede o OK ("Continuar gravando"). Enquanto espera, o título
 * da aba pisca, para quem está em outra aba ver (com "menos movimento" no
 * sistema, só troca), e o celular vibra uma vez. Som, não: o microfone gravaria
 * o próprio aviso.
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
      // Fica até ser fechado (pelo X ou pela gravação seguinte): quem não
      // confirmou não estava olhando a tela.
      toast.info(t("meetings.hourCheckStopped", { minutos }), { id: ID_DO_AVISO_PAROU_SOZINHA, duration: Infinity, closeButton: true });
    },
  });
  const idDoPedido = useId();
  const idDasHoras = useId();
  const idDaDescricao = useId();
  const cartao = useRef<HTMLDivElement | null>(null);
  const botao = useRef<HTMLButtonElement | null>(null);
  // Quem tinha o foco quando o aviso abriu.
  const focoDeAntes = useRef<Element | null>(null);

  // O título da aba alterna com o pedido de confirmação e volta ao original
  // quando o aviso fecha (pelo OK, pelo prazo, pelo fim da gravação ou ao sair
  // da tela). Com "menos movimento" no sistema, troca uma vez e não pisca.
  useEffect(() => {
    if (!aviso.aberto) return;
    const original = document.title;
    const chamada = t("meetings.hourCheckTabTitle");
    let comChamada = true;
    document.title = chamada;
    const relogio = movimentoReduzido() ? undefined : window.setInterval(() => {
      comChamada = !comChamada;
      document.title = comChamada ? chamada : original;
    }, PISCADA_DO_TITULO_MS);
    return () => {
      window.clearInterval(relogio);
      document.title = original;
    };
  }, [aviso.aberto, aviso.horas]);

  // Ao abrir: uma vibração e o foco no OK, para o teclado e o leitor de tela
  // chegarem direto a ele. Ao fechar, o cartão sai da página e o foco, que
  // cairia no body, volta a quem o tinha antes.
  useEffect(() => {
    if (!aviso.aberto) return;
    // A hora seguinte com o cartão aberto (ou o StrictMode, que repete o
    // efeito) já acha o foco no OK: o de antes continua o guardado.
    if (!cartao.current?.contains(document.activeElement)) focoDeAntes.current = document.activeElement;
    vibrar();
    botao.current?.focus();
    return () => {
      const agora = document.activeElement;
      const anterior = focoDeAntes.current;
      // Só o foco que se perdeu com o cartão: quem o levou a outro lugar fica lá.
      const perdido = !agora || agora === document.body || !agora.isConnected;
      if (perdido && anterior instanceof HTMLElement && anterior.isConnected) anterior.focus({ preventScroll: true });
    };
  }, [aviso.aberto, aviso.horas]);

  if (!aviso.aberto) return null;
  // O nome é o pedido mais as horas: o leitor de tela anuncia que é preciso
  // confirmar, não só quanto já foi gravado.
  return (
    <div ref={cartao} role="alertdialog" aria-labelledby={`${idDoPedido} ${idDasHoras}`} aria-describedby={idDaDescricao} className="fixed inset-x-4 top-20 z-50 mx-auto max-w-sm rounded-2xl border border-amber-300/40 bg-[#211e1b] p-4 text-white shadow-2xl">
      <div className="flex items-start gap-3">
        <Clock3 aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-amber-300"/>
        <div className="min-w-0">
          {/* Tamanho próprio: o h2 global (index.css) é de título de página, e no cartão quebrava em duas linhas. */}
          <h2 id={idDoPedido} className="text-base font-semibold">{t("meetings.hourCheckTabTitle")}</h2>
          <p id={idDasHoras} className="text-sm font-semibold text-amber-300">{t("meetings.hoursOfRecording", { count: aviso.horas })}</p>
          <p id={idDaDescricao} className="mt-1 text-sm text-white/70">{t("meetings.hourCheckDescription", { minutos })}</p>
        </div>
      </div>
      <button ref={botao} type="button" onClick={aviso.continuar} className="mt-4 w-full rounded-xl bg-[#c98f70] py-3 font-bold text-[#1a120c] hover:bg-[#efcba8]">{t("meetings.resumeRecording")}</button>
    </div>
  );
}
