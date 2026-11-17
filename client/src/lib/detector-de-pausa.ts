/**
 * O ouvido da troca de parte da gravação em partes: um AnalyserNode num
 * AudioContext sobre o MESMO fluxo que o MediaRecorder grava, que diz se os
 * últimos ~300 ms foram silêncio. A troca de parte (hooks/useGravadorDeAudio.ts)
 * espera um trecho assim para a palavra não sair cortada entre dois arquivos:
 * cada parte é transcrita sozinha, e meia palavra em cada uma se perde nas duas.
 *
 * Só ouve: não liga nada à saída de som, não grava e não mexe no fluxo. Sem
 * AudioContext (o navegador sem Web Audio), ou se ele recusar, abrir devolve
 * null; com o contexto suspenso, `ouvindo` diz false. O suspenso pode ser só o
 * começo (o Firefox cria o contexto suspenso e só o roda numa tarefa seguinte,
 * como pede a especificação) ou para sempre (o iPhone, que só deixa o áudio
 * rodar a partir de um toque da dona). Sem detector, quem chama troca no tempo,
 * como antes; com o contexto que não roda, também, depois de dar a ele o prazo
 * para começar (PREPARO_DO_DETECTOR_MS, em hooks/useGravadorDeAudio.ts).
 */

/** O trecho calmo que a troca espera: uns 300 ms sem fala. */
export const TRECHO_CALMO_MS = 300;
/**
 * O nível (RMS, de 0 a 1) abaixo do qual um bloco é silêncio: 0,01 é cerca de
 * −40 dBFS. A fala perto do microfone fica entre −30 e −10 dBFS; o silêncio,
 * com a supressão de ruído que o gravador pede ao microfone, abaixo de −50.
 * Num lugar barulhento a pausa pode não chegar abaixo disso, e a troca sai no
 * prazo máximo da espera.
 */
export const LIMIAR_DO_SILENCIO = 0.01;
/** O trecho é medido em blocos de 20 ms: um só bloco alto (uma sílaba) basta para não ser calmo. */
export const BLOCO_MS = 20;
/**
 * O analisador nasce com o buffer zerado, que pareceria silêncio: o trecho só
 * vale depois de o contexto rodar o bastante para enchê-lo de som de verdade
 * (o trecho e mais uma folga para o som do microfone começar a chegar).
 */
const FOLGA_DO_INICIO_MS = 200;
/** Os limites do fftSize do AnalyserNode. */
const JANELA_MINIMA = 32;
const JANELA_MAXIMA = 32_768;

export type DetectorDePausa = {
  /** O contexto roda e a análise funciona: o que ele ouve vale. Suspenso, fechado ou quebrado, não. */
  ouvindo(): boolean;
  /** Os últimos TRECHO_CALMO_MS foram silêncio. Sem ouvir, false. */
  calmo(): boolean;
  /** Solta o fluxo e fecha o contexto. Pode ser chamado mais de uma vez. */
  fechar(): void;
};

type ConstrutorDoContexto = new () => AudioContext;

function construtorDoContexto(): ConstrutorDoContexto | undefined {
  // O webkitAudioContext é o do Safari antigo.
  const global = globalThis as unknown as { AudioContext?: ConstrutorDoContexto; webkitAudioContext?: ConstrutorDoContexto };
  return global.AudioContext ?? global.webkitAudioContext;
}

/** A menor potência de 2 com pelo menos `amostras`, nos limites do fftSize do AnalyserNode (32 a 32768). */
export function tamanhoDaJanela(amostras: number) {
  let tamanho = JANELA_MINIMA;
  while (tamanho < amostras && tamanho < JANELA_MAXIMA) tamanho *= 2;
  return tamanho;
}

/**
 * As últimas `quantas` amostras são silêncio: cada bloco de `bloco` amostras,
 * contado do fim, tem o RMS de no máximo `limiar`. Sem amostras, não é calmo.
 */
export function trechoCalmo(amostras: ArrayLike<number>, quantas: number, bloco: number, limiar = LIMIAR_DO_SILENCIO): boolean {
  const total = Math.min(quantas, amostras.length);
  if (total <= 0 || bloco <= 0) return false;
  const comeco = amostras.length - total;
  for (let fim = amostras.length; fim > comeco; fim -= bloco) {
    const de = Math.max(comeco, fim - bloco);
    let soma = 0;
    for (let i = de; i < fim; i++) soma += amostras[i] * amostras[i];
    if (Math.sqrt(soma / (fim - de)) > limiar) return false;
  }
  return true;
}

/**
 * Chama `acao` sem deixar escapar o erro dela, nem a promessa recusada que ela
 * devolva (o resume e o close do AudioContext). O detector é um extra da
 * troca: se ele falha, a troca sai no tempo, como antes, e não há o que avisar.
 */
function semFalha(acao: () => unknown) {
  try {
    const resultado = acao() as { catch?: (aoFalhar: () => undefined) => unknown } | null | undefined;
    if (typeof resultado?.catch === "function") resultado.catch(() => undefined);
  } catch {
    // Ver acima: sem o detector, a troca sai no tempo.
  }
}

/** Abre o detector sobre `fluxo`. Null sem AudioContext, ou se o navegador recusar o contexto ou o analisador. */
export function abrirDetectorDePausa(fluxo: MediaStream): DetectorDePausa | null {
  const Contexto = construtorDoContexto();
  if (!Contexto) return null;
  let contexto: AudioContext | null = null;
  try {
    const ctx = (contexto = new Contexto());
    const fonte = ctx.createMediaStreamSource(fluxo);
    const analisador = ctx.createAnalyser();
    if (typeof analisador.getFloatTimeDomainData !== "function") throw new Error("O navegador não mede o nível do som.");
    const quantas = Math.round((ctx.sampleRate * TRECHO_CALMO_MS) / 1000);
    const bloco = Math.max(1, Math.round((ctx.sampleRate * BLOCO_MS) / 1000));
    analisador.fftSize = tamanhoDaJanela(quantas);
    fonte.connect(analisador);
    const amostras = new Float32Array(analisador.fftSize);
    // Criado fora do toque da dona, o contexto pode nascer suspenso: pede para
    // rodar. O Chrome já o cria rodando; o Firefox o roda numa tarefa seguinte;
    // o iPhone, sem o toque, segue suspenso.
    if (ctx.state === "suspended") semFalha(() => ctx.resume());
    let fechado = false;
    let quebrado = false;
    return {
      ouvindo: () => !fechado && !quebrado && ctx.state === "running",
      calmo: () => {
        if (fechado || quebrado || ctx.state !== "running") return false;
        if (ctx.currentTime * 1000 < TRECHO_CALMO_MS + FOLGA_DO_INICIO_MS) return false;
        try {
          analisador.getFloatTimeDomainData(amostras);
        } catch {
          // A leitura falhou: o detector deixa de ouvir, e a troca sai no tempo.
          quebrado = true;
          return false;
        }
        return trechoCalmo(amostras, quantas, bloco);
      },
      fechar: () => {
        if (fechado) return;
        fechado = true;
        semFalha(() => fonte.disconnect());
        semFalha(() => ctx.close());
      },
    };
  } catch {
    // Sem o detector, a troca sai no tempo; o contexto que chegou a abrir fecha.
    const aberto = contexto;
    if (aberto) semFalha(() => aberto.close());
    return null;
  }
}
