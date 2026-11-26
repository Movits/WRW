import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mic } from "lucide-react";
import { abrirMedidorDaVoz, suavizarNivel } from "@/lib/medidor-da-voz";
import { pontosDaBolha, raioMaximoDaBolha } from "@/lib/forma-da-bolha";

/**
 * A bolha da voz do gravador de reuniões (pedido do Nicolas, 24/11): no lugar do
 * círculo que só pisca, uma bolha cobre em volta do microfone que cresce e ondula
 * conforme a voz (lib/forma-da-bolha.ts), medida no mesmo fluxo que está sendo
 * gravado (lib/medidor-da-voz.ts).
 *
 * É enfeite e nunca atrapalha a gravação. Enquanto o medidor não ouve (sem Web
 * Audio, o contexto suspenso do iPhone, a leitura que falhou) e com o "reduzir
 * movimento" do aparelho, a tela mostra o `circulo` de sempre. Pausada, a bolha
 * se acalma e para redonda. O desenho vai direto no canvas a cada quadro, sem
 * passar pelo React.
 */

/** O lado do círculo de hoje (h-28): a bolha ocupa o mesmo lugar na tela. */
const LADO_DO_CIRCULO = 112;
/** O canvas passa um pouco do círculo para a bolha ter onde crescer, sem chegar ao relógio. */
const LADO_DO_DESENHO = 152;
/** O raio de repouso: em silêncio, a bolha tem quase o tamanho do círculo de hoje. */
const RAIO_EM_SILENCIO = 50;
/** Quanto tempo o medidor tem para começar a ouvir antes de a tela ficar com o círculo. */
const ESPERA_PELO_MEDIDOR_MS = 2_000;

const COBRE = "#c98f70";
const FUNDO_DA_BOLHA = "#2c221d";
const VERMELHO_DE_GRAVANDO = "#e24b4a";

function prefereMenosMovimento() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function tracarContorno(ctx: CanvasRenderingContext2D, pontos: Array<[number, number]>) {
  ctx.beginPath();
  for (let i = 0; i <= pontos.length; i++) {
    const [x, y] = pontos[i % pontos.length];
    const [px, py] = pontos[(i + 1) % pontos.length];
    const meioX = (x + px) / 2;
    const meioY = (y + py) / 2;
    if (i === 0) ctx.moveTo(meioX, meioY);
    else ctx.quadraticCurveTo(x, y, meioX, meioY);
  }
  ctx.closePath();
}

/** Desenha um quadro: duas camadas de cobre transparente, a bolha escura com contorno e o ponto de "gravando". */
function desenharQuadro(canvas: HTMLCanvasElement, nivel: number, tempo: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const escala = canvas.width / LADO_DO_DESENHO;
  const meio = canvas.width / 2;
  // A camada de fora é a maior: ela decide quanto a bolha pode crescer sem sair do desenho.
  const cabe = (canvas.width / 2 - 2 * escala) / raioMaximoDaBolha(RAIO_EM_SILENCIO * 1.16 * escala, nivel * 1.15);
  const base = RAIO_EM_SILENCIO * escala * Math.min(1, cabe);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COBRE;
  ctx.globalAlpha = 0.16 + nivel * 0.14;
  tracarContorno(ctx, pontosDaBolha(meio, meio, base * 1.16, nivel * 1.15, tempo * 0.85 + 0.6));
  ctx.fill();
  ctx.globalAlpha = 0.28 + nivel * 0.2;
  tracarContorno(ctx, pontosDaBolha(meio, meio, base * 1.06, nivel, tempo + 0.3));
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = FUNDO_DA_BOLHA;
  tracarContorno(ctx, pontosDaBolha(meio, meio, base, nivel * 0.85, tempo));
  ctx.fill();
  ctx.strokeStyle = COBRE;
  ctx.lineWidth = 1.5 * escala;
  ctx.stroke();
  ctx.fillStyle = VERMELHO_DE_GRAVANDO;
  ctx.beginPath();
  ctx.arc(meio + base * 0.78, meio - base * 0.78, 4 * escala, 0, Math.PI * 2);
  ctx.fill();
}

export function BolhaDaVoz({ fluxo, pausada, circulo }: { fluxo: MediaStream | null; pausada: boolean; circulo: ReactNode }) {
  const [ouvindo, setOuvindo] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pausadaAgora = useRef(pausada);
  useEffect(() => { pausadaAgora.current = pausada; }, [pausada]);

  useEffect(() => {
    setOuvindo(false);
    if (!fluxo || prefereMenosMovimento()) return;
    const medidor = abrirMedidorDaVoz(fluxo);
    if (!medidor) return;
    let vivo = true;
    let quadro = 0;
    let mostrando = false;
    let nivel = 0;
    let tempo = 0;
    const abertoEm = performance.now();
    let anterior = abertoEm;
    const passo = (agora: number) => {
      if (!vivo) return;
      const segundos = Math.min(0.05, Math.max(0, (agora - anterior) / 1000));
      anterior = agora;
      if (!medidor.ouvindo()) {
        if (mostrando) {
          // Parou de ouvir no meio (o iPhone suspende o áudio numa ligação): volta ao círculo e espera.
          mostrando = false;
          setOuvindo(false);
        } else if (agora - abertoEm > ESPERA_PELO_MEDIDOR_MS) {
          // Nunca chegou a ouvir: fica o círculo, e o medidor solta o fluxo.
          medidor.fechar();
          return;
        }
        quadro = requestAnimationFrame(passo);
        return;
      }
      if (!mostrando) {
        mostrando = true;
        setOuvindo(true);
      }
      if (pausadaAgora.current) {
        nivel = suavizarNivel(nivel, 0, segundos);
      } else {
        tempo += segundos;
        nivel = suavizarNivel(nivel, medidor.nivel(), segundos);
      }
      if (canvas.current) desenharQuadro(canvas.current, nivel, tempo);
      quadro = requestAnimationFrame(passo);
    };
    quadro = requestAnimationFrame(passo);
    return () => {
      vivo = false;
      cancelAnimationFrame(quadro);
      medidor.fechar();
    };
  }, [fluxo]);

  if (!ouvindo) return <>{circulo}</>;
  const densidade = typeof window !== "undefined" ? Math.min(3, Math.max(1, window.devicePixelRatio || 1)) : 1;
  const sobra = (LADO_DO_DESENHO - LADO_DO_CIRCULO) / 2;
  return (
    <div data-testid="bolha-da-voz" className="relative isolate mx-auto mb-4 flex items-center justify-center" style={{ width: LADO_DO_CIRCULO, height: LADO_DO_CIRCULO }}>
      <canvas
        ref={canvas}
        aria-hidden="true"
        width={Math.round(LADO_DO_DESENHO * densidade)}
        height={Math.round(LADO_DO_DESENHO * densidade)}
        style={{ position: "absolute", left: -sobra, top: -sobra, width: LADO_DO_DESENHO, height: LADO_DO_DESENHO, pointerEvents: "none" }}
      />
      <Mic className="relative text-[#c98f70]" size={36} aria-hidden="true" />
    </div>
  );
}
