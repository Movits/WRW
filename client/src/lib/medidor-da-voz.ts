/**
 * O medidor da bolha do gravador de reuniões (components/BolhaDaVoz.tsx): o
 * nível da voz, de 0 a 1, para a bolha crescer e ondular quando a pessoa fala.
 *
 * Como o detector de pausa (lib/detector-de-pausa.ts), só ouve: um AnalyserNode
 * num AudioContext sobre o MESMO fluxo que o MediaRecorder grava, sem ligar nada
 * à saída de som e sem mexer no fluxo. A bolha é enfeite: sem Web Audio, ou com o
 * contexto que não roda, a tela mostra o círculo de antes e a gravação segue
 * igual.
 *
 * O iPhone só deixa um AudioContext rodar a partir de um toque da dona. Por isso
 * o "Iniciar gravação" chama prepararContextoNoToque() antes do primeiro await,
 * e o medidor usa esse contexto quando o microfone chega.
 */
import { construtorDoContexto, semFalha } from "./detector-de-pausa";

// A régua do nível. Desde a #245 o microfone da reunião grava sem ganho
// automático e sem supressão de ruído (restricoesDoMicrofone("reuniao")): a voz
// chega mais baixa (a uns 30 cm, perto de −35 a −25 dBFS) e o fundo da sala, mais
// alto (−60 a −50). Com a régua de antes (−55 a −12), a bolha mal se mexia com
// a fala comum e tremia com o barulho de fundo.
/** O nível 0: o fundo da sala sem a supressão de ruído fica abaixo disso. */
export const PISO_DB = -50;
/** O nível 1: fala firme perto do aparelho, sem o ganho automático. */
export const TETO_DB = -20;
/** Quanto o nível mostrado anda por segundo rumo ao medido: sobe rápido (a sílaba) e desce devagar. */
const SUBIDA_POR_SEGUNDO = 14;
const DESCIDA_POR_SEGUNDO = 5;
/** O contexto criado no toque e não usado (a gravação não começou) fecha sozinho depois disto. */
const VALIDADE_DO_CONTEXTO_DO_TOQUE_MS = 120_000;

/** O nível da voz nas amostras (de −1 a 1): o RMS em dBFS, levado de PISO_DB..TETO_DB para 0..1. */
export function nivelDaVoz(amostras: ArrayLike<number>): number {
  if (amostras.length === 0) return 0;
  let soma = 0;
  for (let i = 0; i < amostras.length; i++) soma += amostras[i] * amostras[i];
  const rms = Math.sqrt(soma / amostras.length);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - PISO_DB) / (TETO_DB - PISO_DB)));
}

/** O nível mostrado depois de `segundos`, aproximando-se do medido: sem tremer, sem atrasar a sílaba. */
export function suavizarNivel(atual: number, alvo: number, segundos: number): number {
  const taxa = alvo > atual ? SUBIDA_POR_SEGUNDO : DESCIDA_POR_SEGUNDO;
  return atual + (alvo - atual) * Math.min(1, taxa * Math.max(0, segundos));
}

let contextoDoToque: AudioContext | null = null;
let validadeDoToque: ReturnType<typeof setTimeout> | null = null;

function soltarContextoDoToque(fechar: boolean) {
  if (validadeDoToque) clearTimeout(validadeDoToque);
  validadeDoToque = null;
  const contexto = contextoDoToque;
  contextoDoToque = null;
  if (fechar && contexto) semFalha(() => contexto.close());
}

/**
 * Cria (ou retoma) o contexto do medidor DENTRO do toque em "Iniciar gravação",
 * antes de qualquer await. Nunca lança: sem ele, a bolha só não aparece.
 */
export function prepararContextoNoToque(): void {
  const Contexto = construtorDoContexto();
  if (!Contexto) return;
  try {
    if (!contextoDoToque || contextoDoToque.state === "closed") contextoDoToque = new Contexto();
    const contexto = contextoDoToque;
    if (contexto.state === "suspended") semFalha(() => contexto.resume());
    if (validadeDoToque) clearTimeout(validadeDoToque);
    validadeDoToque = setTimeout(() => soltarContextoDoToque(true), VALIDADE_DO_CONTEXTO_DO_TOQUE_MS);
  } catch {
    soltarContextoDoToque(true);
  }
}

export type MedidorDaVoz = {
  /** O contexto roda: o nível vale. Suspenso (o iPhone sem o toque), fechado ou quebrado, não. */
  ouvindo(): boolean;
  /** O nível da voz agora, de 0 a 1. Sem ouvir, 0. */
  nivel(): number;
  /** Solta o fluxo e fecha o contexto. Pode ser chamado mais de uma vez. */
  fechar(): void;
};

/** Abre o medidor sobre `fluxo`, com o contexto do toque se houver. Null sem Web Audio ou se o navegador recusar. */
export function abrirMedidorDaVoz(fluxo: MediaStream): MedidorDaVoz | null {
  const Contexto = construtorDoContexto();
  if (!Contexto) return null;
  let contexto: AudioContext | null = null;
  try {
    // O do toque é deste medidor: sai do lugar e não fecha mais sozinho.
    const doToque = contextoDoToque && contextoDoToque.state !== "closed" ? contextoDoToque : null;
    soltarContextoDoToque(false);
    const ctx = (contexto = doToque ?? new Contexto());
    const fonte = ctx.createMediaStreamSource(fluxo);
    const analisador = ctx.createAnalyser();
    if (typeof analisador.getFloatTimeDomainData !== "function") throw new Error("O navegador não mede o nível do som.");
    // ~20 ms de som a 48 kHz: o bastante para uma sílaba, leve para cada quadro.
    analisador.fftSize = 1024;
    fonte.connect(analisador);
    const amostras = new Float32Array(analisador.fftSize);
    if (ctx.state === "suspended") semFalha(() => ctx.resume());
    let fechado = false;
    let quebrado = false;
    return {
      ouvindo: () => !fechado && !quebrado && ctx.state === "running",
      nivel: () => {
        if (fechado || quebrado || ctx.state !== "running") return 0;
        try {
          analisador.getFloatTimeDomainData(amostras);
        } catch {
          // A leitura falhou: a bolha para de ouvir, e a tela volta ao círculo.
          quebrado = true;
          return 0;
        }
        return nivelDaVoz(amostras);
      },
      fechar: () => {
        if (fechado) return;
        fechado = true;
        semFalha(() => fonte.disconnect());
        semFalha(() => ctx.close());
      },
    };
  } catch {
    const aberto = contexto;
    if (aberto) semFalha(() => aberto.close());
    return null;
  }
}
