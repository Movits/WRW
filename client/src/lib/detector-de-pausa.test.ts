import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCO_MS, LIMIAR_DO_SILENCIO, TRECHO_CALMO_MS, abrirDetectorDePausa, tamanhoDaJanela, trechoCalmo } from "./detector-de-pausa";

const FLUXO = { getTracks: () => [] } as unknown as MediaStream;
// A 48 kHz: o trecho de 300 ms, os blocos de 20 ms e o buffer do analisador.
const TRECHO = (48_000 * TRECHO_CALMO_MS) / 1000;
const BLOCO = (48_000 * BLOCO_MS) / 1000;
const BUFFER = 16_384;
const FALA = 0.3;
const SILENCIO = 0.001;

/** Um sinal de `tamanho` amostras, com a amplitude de cada uma (a senoide tem RMS de ~0,7 da amplitude). */
function sinal(tamanho: number, amplitude: (indice: number) => number) {
  return Float32Array.from({ length: tamanho }, (_, i) => amplitude(i) * Math.sin(i / 3));
}

/** O AudioContext do navegador: o teste muda o estado, o relógio do áudio e o som que o analisador lê. */
type ContextoFalso = {
  state: string;
  currentTime: number;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createMediaStreamSource: ReturnType<typeof vi.fn>;
  fonte: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  analisador: { fftSize: number; getFloatTimeDomainData?: (destino: Float32Array) => void };
};
let criados: ContextoFalso[] = [];
let amplitude: (indice: number) => number = () => 0;

function navegadorComWebAudio({
  nome = "AudioContext", estado = "running", relogio = 10, falhaEm = "", semLeitura = false, resumeRecusado = false, closeRecusado = false,
} = {}) {
  vi.stubGlobal(nome, class {
    state = estado;
    sampleRate = 48_000;
    currentTime = relogio;
    resume = vi.fn(() => (resumeRecusado ? Promise.reject(new DOMException("sem o toque", "NotAllowedError")) : Promise.resolve()));
    close = vi.fn(() => {
      this.state = "closed";
      return closeRecusado ? Promise.reject(new DOMException("já fechado", "InvalidStateError")) : Promise.resolve();
    });
    fonte = { connect: vi.fn(), disconnect: vi.fn() };
    analisador = {
      fftSize: 2048,
      getFloatTimeDomainData: semLeitura ? undefined : (destino: Float32Array) => destino.set(sinal(destino.length, amplitude)),
    };
    createMediaStreamSource = vi.fn(() => {
      if (falhaEm === "fonte") throw new DOMException("sem trilha de áudio", "InvalidStateError");
      return this.fonte;
    });
    constructor() {
      if (falhaEm === "contexto") throw new DOMException("recusado", "NotSupportedError");
      criados.push(this);
    }
    createAnalyser() { return this.analisador; }
  });
}

/** Dá a vez às promessas recusadas: a que ficasse solta apareceria como erro da suíte. */
const esperarAsPromessas = () => new Promise(resolver => setTimeout(resolver, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  criados = [];
  amplitude = () => 0;
});

describe("tamanhoDaJanela", () => {
  it("a menor potência de 2 que cabe o trecho, entre 32 e 32768 (os limites do AnalyserNode)", () => {
    expect(tamanhoDaJanela(14_400)).toBe(16_384); // 300 ms a 48 kHz
    expect(tamanhoDaJanela(13_230)).toBe(16_384); // a 44,1 kHz
    expect(tamanhoDaJanela(4_800)).toBe(8_192); // a 16 kHz
    expect(tamanhoDaJanela(16_384)).toBe(16_384);
    expect(tamanhoDaJanela(28_800)).toBe(32_768); // a 96 kHz
    expect(tamanhoDaJanela(57_600)).toBe(32_768); // passa do teto: fica no teto
    expect(tamanhoDaJanela(0)).toBe(32);
  });
});

describe("trechoCalmo", () => {
  it("silêncio no trecho todo é calmo; fala, não", () => {
    expect(trechoCalmo(sinal(BUFFER, () => SILENCIO), TRECHO, BLOCO)).toBe(true);
    expect(trechoCalmo(new Float32Array(BUFFER), TRECHO, BLOCO)).toBe(true);
    expect(trechoCalmo(sinal(BUFFER, () => FALA), TRECHO, BLOCO)).toBe(false);
  });

  it("um bloco alto só (uma sílaba), no fim ou no começo do trecho, basta para não ser calmo", () => {
    expect(trechoCalmo(sinal(BUFFER, i => (i >= BUFFER - BLOCO ? FALA : SILENCIO)), TRECHO, BLOCO)).toBe(false);
    const comecoDoTrecho = BUFFER - TRECHO;
    expect(trechoCalmo(sinal(BUFFER, i => (i >= comecoDoTrecho && i < comecoDoTrecho + BLOCO ? FALA : SILENCIO)), TRECHO, BLOCO)).toBe(false);
  });

  it("só o trecho conta: a fala de antes dele não impede a calma", () => {
    expect(trechoCalmo(sinal(BUFFER, i => (i < BUFFER - TRECHO ? FALA : SILENCIO)), TRECHO, BLOCO)).toBe(true);
  });

  it("o limiar separa a fala baixa do silêncio: perto de −40 dBFS", () => {
    // RMS de ~0,0085 (abaixo do limiar) e de ~0,014 (acima).
    expect(trechoCalmo(sinal(BUFFER, () => 0.012), TRECHO, BLOCO)).toBe(true);
    expect(trechoCalmo(sinal(BUFFER, () => 0.02), TRECHO, BLOCO)).toBe(false);
    expect(trechoCalmo(sinal(BUFFER, () => 0.02), TRECHO, BLOCO, LIMIAR_DO_SILENCIO * 2)).toBe(true);
  });

  it("sem amostras, nunca é calmo; o trecho maior que o buffer mede o buffer inteiro", () => {
    expect(trechoCalmo(new Float32Array(0), TRECHO, BLOCO)).toBe(false);
    expect(trechoCalmo(sinal(BUFFER, () => SILENCIO), 0, BLOCO)).toBe(false);
    expect(trechoCalmo(sinal(BUFFER, () => SILENCIO), TRECHO, 0)).toBe(false);
    expect(trechoCalmo(sinal(1_000, () => SILENCIO), TRECHO, BLOCO)).toBe(true);
    expect(trechoCalmo(sinal(1_000, i => (i < 10 ? FALA : SILENCIO)), TRECHO, BLOCO)).toBe(false);
  });
});

describe("abrirDetectorDePausa", () => {
  it("sem Web Audio, não abre: quem chama troca no tempo", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(abrirDetectorDePausa(FLUXO)).toBeNull();
  });

  it("ouve o mesmo fluxo num analisador que cabe os 300 ms, sem ligar nada à saída de som, e diz se o trecho foi calmo", () => {
    navegadorComWebAudio();
    const detector = abrirDetectorDePausa(FLUXO);
    expect(detector).not.toBeNull();
    const [contexto] = criados;
    expect(contexto.createMediaStreamSource).toHaveBeenCalledWith(FLUXO);
    expect(contexto.fonte.connect).toHaveBeenCalledTimes(1);
    expect(contexto.fonte.connect).toHaveBeenCalledWith(contexto.analisador);
    expect(contexto.analisador.fftSize).toBe(BUFFER);
    expect(contexto.resume).not.toHaveBeenCalled();
    expect(detector?.ouvindo()).toBe(true);
    amplitude = () => SILENCIO;
    expect(detector?.calmo()).toBe(true);
    amplitude = () => FALA;
    expect(detector?.calmo()).toBe(false);
    // A fala de mais de 300 ms atrás, ainda no buffer, não conta.
    amplitude = i => (i < BUFFER - TRECHO ? FALA : SILENCIO);
    expect(detector?.calmo()).toBe(true);
  });

  it("o webkitAudioContext do Safari antigo também serve", () => {
    vi.stubGlobal("AudioContext", undefined);
    navegadorComWebAudio({ nome: "webkitAudioContext" });
    expect(abrirDetectorDePausa(FLUXO)?.ouvindo()).toBe(true);
    expect(criados).toHaveLength(1);
  });

  it("o contexto recusado não abre", () => {
    navegadorComWebAudio({ falhaEm: "contexto" });
    expect(abrirDetectorDePausa(FLUXO)).toBeNull();
  });

  it("o fluxo que o analisador recusa (sem trilha de áudio) não abre, e o contexto que chegou a abrir fecha", () => {
    navegadorComWebAudio({ falhaEm: "fonte" });
    expect(abrirDetectorDePausa(FLUXO)).toBeNull();
    expect(criados[0].close).toHaveBeenCalledTimes(1);
  });

  it("o navegador que não mede o nível do som (sem getFloatTimeDomainData) não abre, e o contexto fecha", () => {
    navegadorComWebAudio({ semLeitura: true });
    expect(abrirDetectorDePausa(FLUXO)).toBeNull();
    expect(criados[0].close).toHaveBeenCalledTimes(1);
  });

  it("o contexto suspenso (o iPhone sem o toque da dona): pede para rodar e não ouve enquanto não roda", () => {
    navegadorComWebAudio({ estado: "suspended" });
    const detector = abrirDetectorDePausa(FLUXO);
    const [contexto] = criados;
    expect(contexto.resume).toHaveBeenCalledTimes(1);
    amplitude = () => 0;
    expect(detector?.ouvindo()).toBe(false);
    expect(detector?.calmo()).toBe(false);
    contexto.state = "running";
    expect(detector?.ouvindo()).toBe(true);
    expect(detector?.calmo()).toBe(true);
  });

  it("o pedido para rodar recusado não vira erro solto", async () => {
    navegadorComWebAudio({ estado: "suspended", resumeRecusado: true });
    const detector = abrirDetectorDePausa(FLUXO);
    await esperarAsPromessas();
    expect(criados[0].resume).toHaveBeenCalledTimes(1);
    expect(detector?.ouvindo()).toBe(false);
  });

  it("logo depois de o contexto começar a rodar, o buffer ainda zerado não vale como silêncio", () => {
    navegadorComWebAudio({ relogio: 0.2 });
    const detector = abrirDetectorDePausa(FLUXO);
    amplitude = () => 0;
    expect(detector?.ouvindo()).toBe(true);
    expect(detector?.calmo()).toBe(false);
    criados[0].currentTime = 0.6;
    expect(detector?.calmo()).toBe(true);
  });

  it("a leitura que falha: o detector deixa de ouvir, e quem chama troca no tempo", () => {
    navegadorComWebAudio();
    const detector = abrirDetectorDePausa(FLUXO);
    criados[0].analisador.getFloatTimeDomainData = () => { throw new Error("quebrou"); };
    expect(detector?.calmo()).toBe(false);
    expect(detector?.ouvindo()).toBe(false);
  });

  it("fechar solta o fluxo e fecha o contexto uma vez só; fechado, não ouve, e o close recusado não vira erro solto", async () => {
    navegadorComWebAudio({ closeRecusado: true });
    const detector = abrirDetectorDePausa(FLUXO);
    amplitude = () => SILENCIO;
    detector?.fechar();
    detector?.fechar();
    await esperarAsPromessas();
    const [contexto] = criados;
    expect(contexto.fonte.disconnect).toHaveBeenCalledTimes(1);
    expect(contexto.close).toHaveBeenCalledTimes(1);
    expect(detector?.ouvindo()).toBe(false);
    expect(detector?.calmo()).toBe(false);
  });
});
