import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import {
  ATRASO_MAXIMO_MS, ESPERA_PELA_PAUSA_MS, PAUSA_MAXIMA_MS, PREPARO_DO_DETECTOR_MS, useGravadorDeAudio, type AudioGravado, type OpcoesDoGravador,
} from "./useGravadorDeAudio";

/** O MediaRecorder do navegador, que grava só os formatos da lista. */
type GravadorFalso = {
  /** A ordem em que o gravador foi criado (o de `gravadores[indice]`). */
  indice: number;
  fluxo: unknown;
  opcoes: MediaRecorderOptions | undefined;
  mimeType: string;
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((evento: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  /** O que o microfone captou enquanto este gravador gravava (ver `falar`). */
  falas: string[];
  /** Com o fim atrasado: entrega os pedaços e o fim, como o navegador faz depois do stop(). */
  terminar: () => void;
};
let gravadores: GravadorFalso[] = [];
/** O começo e o fim de cada gravador, na ordem em que aconteceram: "começa 1", "para 0"... */
let linhaDoTempo: string[] = [];

function navegadorQueGrava(formatos: string[], { fimAtrasado = false, recusarAPartirDe = Infinity, umPorVez = false } = {}) {
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported = (tipo: string) => formatos.includes(tipo);
    indice: number;
    fluxo: unknown;
    opcoes: MediaRecorderOptions | undefined;
    mimeType: string;
    state: "inactive" | "recording" | "paused" = "inactive";
    ondataavailable: ((evento: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    falas: string[] = [];
    constructor(fluxo: unknown, opcoes?: MediaRecorderOptions) {
      // O navegador que recusa o gravador a partir do enésimo (a trilha do microfone que caiu, por exemplo).
      if (gravadores.length >= recusarAPartirDe) throw new DOMException("recusado", "NotSupportedError");
      this.fluxo = fluxo;
      this.opcoes = opcoes;
      // Sem mimeType nas opções, o navegador grava no padrão dele.
      this.mimeType = opcoes?.mimeType ?? "audio/webm;codecs=opus";
      this.indice = gravadores.length;
      gravadores.push(this);
    }
    start() {
      // O navegador que não grava o mesmo fluxo com dois gravadores ao mesmo tempo.
      if (umPorVez && gravadores.some(outro => outro !== this && outro.state !== "inactive")) throw new DOMException("ocupado", "InvalidStateError");
      this.state = "recording";
      linhaDoTempo.push(`começa ${this.indice}`);
    }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      linhaDoTempo.push(`para ${this.indice}`);
      if (!fimAtrasado) this.terminar();
    }
    terminar() {
      this.ondataavailable?.({ data: new Blob(this.falas.length ? this.falas : ["som"], { type: this.mimeType }) });
      this.onstop?.();
    }
  });
}

/** A fala que o microfone capta agora: vai para todo gravador que está gravando (o pausado e o parado não gravam). */
function falar(trecho: string) {
  for (const gravador of gravadores) if (gravador.state === "recording") gravador.falas.push(trecho);
}

// O som no ar, para o detector de pausa da troca de parte: a amplitude (de 0 a
// 1) a partir de cada instante do relógio (falso, nos testes que o usam).
let trechosDeSom: Array<{ desde: number; nivel: number }> = [];
const FALA = 0.3;
const SILENCIO = 0.001;
function somDesde(desde: number, nivel: number) {
  trechosDeSom = [...trechosDeSom.filter(trecho => trecho.desde < desde), { desde, nivel }];
}
function nivelEm(instante: number) {
  let nivel = 0;
  for (const trecho of trechosDeSom) if (trecho.desde <= instante) nivel = trecho.nivel;
  return nivel;
}

/** O AudioContext do navegador, com o AnalyserNode que lê o som no ar. */
type ContextoFalso = {
  state: string;
  fechado: boolean;
  resume: ReturnType<typeof vi.fn>;
  fonte: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
};
let contextos: ContextoFalso[] = [];

/**
 * O navegador com Web Audio. `estadoInicial` "suspended" é o iPhone, que só
 * deixa o contexto rodar a partir de um toque: o resume() nunca responde.
 */
function navegadorQueOuve({ estadoInicial = "running", recusar = false } = {}) {
  vi.stubGlobal("AudioContext", class {
    sampleRate = 48_000;
    state = estadoInicial;
    criadoEm = Date.now();
    fechado = false;
    resume = vi.fn(() => new Promise<void>(() => {}));
    fonte = { connect: vi.fn(), disconnect: vi.fn() };
    constructor() {
      if (recusar) throw new DOMException("recusado", "NotSupportedError");
      contextos.push(this);
    }
    get currentTime() { return this.state === "running" ? (Date.now() - this.criadoEm) / 1000 : 0; }
    close() {
      this.state = "closed";
      this.fechado = true;
      return Promise.resolve();
    }
    createMediaStreamSource() { return this.fonte; }
    createAnalyser() {
      const amostrasPorSegundo = this.sampleRate;
      return {
        fftSize: 2048,
        getFloatTimeDomainData(destino: Float32Array) {
          // A última amostra é a de agora; as de antes, 1/48000 s cada uma mais velha.
          const agora = Date.now();
          for (let i = 0; i < destino.length; i++) {
            destino[i] = nivelEm(agora - ((destino.length - 1 - i) * 1000) / amostrasPorSegundo) * Math.sin(i / 3);
          }
        },
      };
    }
  });
}

// A trilha do microfone: o stop dela é o microfone apagando.
let trilha: { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;
const microfone = () => ({ getTracks: () => [trilha] });
let microfoneOriginal: PropertyDescriptor | undefined;

beforeEach(() => {
  gravadores = [];
  linhaDoTempo = [];
  trechosDeSom = [];
  contextos = [];
  trilha = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => microfone());
  microfoneOriginal = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  navegadorQueGrava(["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
});

afterEach(() => {
  // Desmonta antes de devolver os originais: o desmonte ainda mexe no gravador.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (microfoneOriginal) Object.defineProperty(navigator, "mediaDevices", microfoneOriginal);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

function montar(opcoes: Partial<OpcoesDoGravador> = {}) {
  const aoTerminar = vi.fn<(audio: AudioGravado) => void>();
  const aoFalhar = vi.fn<(erro: unknown) => void>();
  const hook = renderHook(() => useGravadorDeAudio({ limiteSegundos: 120, bitsPorSegundo: 64_000, aoTerminar, aoFalhar, ...opcoes }));
  return { ...hook, aoTerminar, aoFalhar };
}

/** O navegador demora a responder ao pedido de microfone: a resposta sai quando o teste mandar. */
function microfoneQueDemora() {
  const pedidos: Array<(midia: unknown) => void> = [];
  getUserMedia.mockImplementation(() => new Promise(resolve => { pedidos.push(resolve); }));
  return pedidos;
}

describe("useGravadorDeAudio — o formato", () => {
  it("o navegador que só grava mp4 grava em mp4, e o servidor recebe audio/mp4", async () => {
    navegadorQueGrava(["audio/mp4"]);
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    expect(gravadores[0].opcoes).toEqual({ mimeType: "audio/mp4", audioBitsPerSecond: 64_000 });
    act(() => result.current.parar());
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    const audio = aoTerminar.mock.calls[0][0];
    expect(audio.mimeType).toBe("audio/mp4");
    expect(audio.blob.type).toBe("audio/mp4");
    expect(audio.blob.size).toBeGreaterThan(0);
  });

  it("com mp4 e webm à escolha (Chrome e Safari novos), pede o mp4 (AAC) primeiro", async () => {
    const { result, aoTerminar } = montar({ bitsPorSegundo: 48_000 });
    await act(async () => { await result.current.comecar(); });
    expect(gravadores[0].opcoes).toEqual({ mimeType: "audio/mp4;codecs=mp4a.40.2", audioBitsPerSecond: 48_000 });
    act(() => result.current.parar());
    expect(aoTerminar.mock.calls[0][0]).toMatchObject({ mimeType: "audio/mp4", blob: expect.objectContaining({ type: "audio/mp4;codecs=mp4a.40.2" }) });
  });

  it("o navegador que só grava webm continua em webm/Opus, como antes", async () => {
    navegadorQueGrava(["audio/webm;codecs=opus", "audio/webm"]);
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    expect(gravadores[0].opcoes).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64_000 });
    act(() => result.current.parar());
    expect(aoTerminar.mock.calls[0][0]).toMatchObject({ mimeType: "audio/webm", blob: expect.objectContaining({ type: "audio/webm;codecs=opus" }) });
  });

  it("nenhum formato da lista: grava no padrão do navegador, com o mesmo bitrate", async () => {
    navegadorQueGrava([]);
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    expect(gravadores[0].opcoes).toEqual({ audioBitsPerSecond: 64_000 });
    act(() => result.current.parar());
    expect(aoTerminar.mock.calls[0][0].mimeType).toBe("audio/webm");
  });
});

describe("useGravadorDeAudio — o microfone", () => {
  it("parar apaga o microfone uma vez só e entrega o áudio", async () => {
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    expect(result.current.estado).toBe("gravando");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(trilha.stop).not.toHaveBeenCalled();
    act(() => result.current.parar());
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(result.current.estado).toBe("parado");
  });

  it("desmontar gravando para o gravador, apaga o microfone que o hook abriu e não entrega nada", async () => {
    const { result, unmount, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    unmount();
    expect(gravadores[0].state).toBe("inactive");
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoTerminar).not.toHaveBeenCalled();
  });

  it("com entregarAoSair (a gravação em partes, G13b), desmontar gravando para e entrega a última parte, solta o microfone e avisa uma vez", async () => {
    const aoFecharParte = vi.fn();
    const aoEntregarAoSair = vi.fn();
    const { result, unmount, aoTerminar } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair });
    await act(async () => { await result.current.comecar(); });
    unmount();
    expect(gravadores[0].state).toBe("inactive");
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoFecharParte).toHaveBeenCalledTimes(1);
    expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: true });
    expect(aoFecharParte.mock.calls[0][0].blob.size).toBeGreaterThan(0);
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(aoEntregarAoSair).toHaveBeenCalledTimes(1);
  });

  it("com entregarAoSair, desmontar PAUSADA também entrega: a pausa não descarta o que foi gravado", async () => {
    const aoFecharParte = vi.fn();
    const aoEntregarAoSair = vi.fn();
    const { result, unmount } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.pausar());
    expect(result.current.estado).toBe("pausado");
    unmount();
    expect(aoFecharParte).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, ultima: true }));
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoEntregarAoSair).toHaveBeenCalledTimes(1);
  });

  it("com entregarAoSair e o fim que o navegador entrega depois do desmonte, a última parte sai assim mesmo, e só então o microfone é solto", async () => {
    navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
    const aoFecharParte = vi.fn();
    const { result, unmount } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair: vi.fn() });
    await act(async () => { await result.current.comecar(); });
    unmount();
    expect(aoFecharParte).not.toHaveBeenCalled();
    gravadores[0].terminar();
    expect(aoFecharParte).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, ultima: true }));
    expect(trilha.stop).toHaveBeenCalledTimes(1);
  });

  it("com entregarAoSair e o Parar já pedido (o Encerrar logo antes de sair), o desmonte não corta o fim que ainda vem", async () => {
    navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
    const aoFecharParte = vi.fn();
    const aoEntregarAoSair = vi.fn();
    const { result, unmount } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.parar());
    expect(result.current.estado).toBe("finalizando");
    unmount();
    gravadores[0].terminar();
    expect(aoFecharParte).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, ultima: true }));
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    // A dona já tinha pedido o fim: não é a saída que encerra.
    expect(aoEntregarAoSair).not.toHaveBeenCalled();
  });

  it("com entregarAoSair e o pedido do microfone ainda aberto, nada foi gravado: o microfone que chega é solto e nada é entregue nem avisado", async () => {
    const pedidos = microfoneQueDemora();
    const aoFecharParte = vi.fn();
    const aoEntregarAoSair = vi.fn();
    const { result, unmount, aoTerminar } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair });
    act(() => { void result.current.comecar(); });
    unmount();
    await act(async () => { pedidos[0](microfone()); });
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(gravadores).toHaveLength(0);
    expect(aoFecharParte).not.toHaveBeenCalled();
    expect(aoTerminar).not.toHaveBeenCalled();
    expect(aoEntregarAoSair).not.toHaveBeenCalled();
  });

  it("entregarAoSair como função é consultado na hora do desmonte, e só com a gravação em curso; respondendo false (o fim da sessão), descarta como antes", async () => {
    const decide = vi.fn(() => false);
    const aoFecharParte = vi.fn();
    const aoEntregarAoSair = vi.fn();
    const parada = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: decide, aoEntregarAoSair });
    parada.unmount();
    // Sem gravação em curso, nem pergunta.
    expect(decide).not.toHaveBeenCalled();
    const { result, unmount } = montar({ fatiaSegundos: 600, aoFecharParte, entregarAoSair: decide, aoEntregarAoSair });
    await act(async () => { await result.current.comecar(); });
    unmount();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoFecharParte).not.toHaveBeenCalled();
    expect(aoEntregarAoSair).not.toHaveBeenCalled();
  });

  it("com entregarAoSair e o gravador que o navegador já deu como inativo (o parar não tem o que parar), o desmonte ao menos solta o microfone", async () => {
    const aoEntregarAoSair = vi.fn();
    const { result, unmount } = montar({ fatiaSegundos: 600, aoFecharParte: vi.fn(), entregarAoSair: true, aoEntregarAoSair });
    await act(async () => { await result.current.comecar(); });
    gravadores[0].state = "inactive";
    unmount();
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoEntregarAoSair).not.toHaveBeenCalled();
  });

  it("o MediaStream de fora (a aba de uma reunião online) é gravado sem pedir o microfone, e o hook nunca o fecha", async () => {
    const trilhaDaAba = { stop: vi.fn() };
    const fluxoDaAba = { getTracks: () => [trilhaDaAba] } as unknown as MediaStream;
    // Só o MediaRecorder importa: nem precisa do getUserMedia.
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result, unmount, aoTerminar } = montar();
    await act(async () => { expect(await result.current.comecar(fluxoDaAba)).toBe(true); });
    expect(gravadores[0].fluxo).toBe(fluxoDaAba);
    act(() => result.current.parar());
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(trilhaDaAba.stop).not.toHaveBeenCalled();
    // Nem descartando, nem saindo da tela no meio de outra gravação.
    await act(async () => { await result.current.comecar(fluxoDaAba); });
    act(() => result.current.descartar());
    await act(async () => { await result.current.comecar(fluxoDaAba); });
    unmount();
    expect(gravadores.map(gravador => gravador.state)).toEqual(["inactive", "inactive", "inactive"]);
    expect(trilhaDaAba.stop).not.toHaveBeenCalled();
    expect(trilha.stop).not.toHaveBeenCalled();
  });

  it("duplo clique enquanto o navegador pede o microfone: um pedido e um gravador só", async () => {
    const pedidos = microfoneQueDemora();
    const { result } = montar();
    let primeiro!: Promise<boolean>;
    let segundo!: Promise<boolean>;
    act(() => {
      primeiro = result.current.comecar();
      segundo = result.current.comecar();
    });
    expect(result.current.estado).toBe("pedindoMicrofone");
    expect(pedidos).toHaveLength(1);
    await act(async () => { pedidos[0](microfone()); });
    expect(await primeiro).toBe(true);
    expect(await segundo).toBe(false);
    expect(gravadores).toHaveLength(1);
    // Gravando, outro clique em gravar também não abre outro.
    await act(async () => { expect(await result.current.comecar()).toBe(false); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("o microfone que chega depois de a tela sair é solto na hora, sem gravar nem avisar", async () => {
    const pedidos = microfoneQueDemora();
    const { result, unmount, aoFalhar, aoTerminar } = montar();
    act(() => { void result.current.comecar(); });
    unmount();
    await act(async () => { pedidos[0](microfone()); });
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(gravadores).toHaveLength(0);
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(aoTerminar).not.toHaveBeenCalled();
  });

  it("podeGravar falso quando o microfone chega: solta, volta a parado e não avisa", async () => {
    const pedidos = microfoneQueDemora();
    let pode = true;
    const { result, aoFalhar } = montar({ podeGravar: () => pode });
    act(() => { void result.current.comecar(); });
    pode = false;
    await act(async () => { pedidos[0](microfone()); });
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(gravadores).toHaveLength(0);
    expect(result.current.estado).toBe("parado");
    expect(aoFalhar).not.toHaveBeenCalled();
  });

  it("microfone negado: aoFalhar recebe o erro do navegador e o gravador volta a parado", async () => {
    const negado = new DOMException("negado", "NotAllowedError");
    getUserMedia.mockRejectedValue(negado);
    const { result, aoFalhar } = montar();
    await act(async () => { expect(await result.current.comecar()).toBe(false); });
    expect(aoFalhar).toHaveBeenCalledWith(negado);
    expect(result.current.estado).toBe("parado");
  });

  it("o gravador recusado depois de o microfone abrir solta o microfone e avisa", async () => {
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported = () => true;
      constructor() { throw new DOMException("recusado", "NotSupportedError"); }
    });
    const { result, aoFalhar } = montar();
    await act(async () => { expect(await result.current.comecar()).toBe(false); });
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(result.current.estado).toBe("parado");
  });

  it("o microfone negado depois de a tela sair não avisa ninguém", async () => {
    let negar!: (erro: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((_resolve, reject) => { negar = reject; }));
    const { result, unmount, aoFalhar } = montar();
    act(() => { void result.current.comecar(); });
    unmount();
    await act(async () => { negar(new DOMException("negado", "NotAllowedError")); });
    expect(aoFalhar).not.toHaveBeenCalled();
  });

  it("enquanto o navegador fecha o arquivo fica 'finalizando', e gravar de novo espera o fim", async () => {
    navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.parar());
    expect(result.current.estado).toBe("finalizando");
    expect(aoTerminar).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.comecar()).toBe(false); });
    expect(gravadores).toHaveLength(1);
    act(() => gravadores[0].terminar());
    expect(result.current.estado).toBe("parado");
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(trilha.stop).toHaveBeenCalledTimes(1);
  });

  it("descartar no meio da gravação para, apaga o microfone e não entrega nada", async () => {
    const { result, aoTerminar } = montar();
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.descartar());
    expect(gravadores[0].state).toBe("inactive");
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(aoTerminar).not.toHaveBeenCalled();
    expect(result.current.estado).toBe("parado");
  });

  it("sem MediaRecorder ou sem microfone, não começa", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result } = montar();
    await act(async () => { expect(await result.current.comecar()).toBe(false); });
    vi.stubGlobal("MediaRecorder", undefined);
    await act(async () => { expect(await result.current.comecar({ getTracks: () => [] } as unknown as MediaStream)).toBe(false); });
    expect(result.current.estado).toBe("parado");
  });
});

describe("useGravadorDeAudio — o relógio", () => {
  it("conta os segundos e para sozinho no limite, sem o relógio passar dele", async () => {
    navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
    const agora = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { result, aoTerminar } = montar({ limiteSegundos: 120 });
    await act(async () => { await result.current.comecar(); });
    agora.mockReturnValue(1_000_000 + 30_400);
    await waitFor(() => expect(result.current.segundos).toBe(30), { timeout: 3000 });
    expect(result.current.estado).toBe("gravando");
    expect(aoTerminar).not.toHaveBeenCalled();
    // O tique atrasado (aba em segundo plano) passa do limite: o relógio fica no limite e o gravador para.
    agora.mockReturnValue(1_000_000 + 121_300);
    await waitFor(() => expect(result.current.estado).toBe("finalizando"), { timeout: 3000 });
    expect(result.current.segundos).toBe(120);
    expect(gravadores[0].state).toBe("inactive");
    act(() => gravadores[0].terminar());
    expect(result.current.estado).toBe("parado");
    expect(result.current.segundos).toBe(0);
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(aoTerminar.mock.calls[0][0].duracaoMs).toBe(121_300);
    expect(trilha.stop).toHaveBeenCalledTimes(1);
  });

  it("o fim entrega ao aoTerminar da última renderização, não ao da hora do clique", async () => {
    const primeiro = vi.fn();
    const segundo = vi.fn();
    const { result, rerender } = renderHook(({ aoTerminar }) => useGravadorDeAudio({ limiteSegundos: 120, bitsPorSegundo: 64_000, aoTerminar }), {
      initialProps: { aoTerminar: primeiro },
    });
    await act(async () => { await result.current.comecar(); });
    rerender({ aoTerminar: segundo });
    act(() => result.current.parar());
    expect(primeiro).not.toHaveBeenCalled();
    expect(segundo).toHaveBeenCalledTimes(1);
  });
});

// PR S: até o envio, o áudio só existe nesta aba. Do pedido do microfone ao fim
// do arquivo o gravador ocupa a sessão (lib/sessao-ocupada.ts), e o Sair e o
// fechar da aba perguntam antes. Vale para os três gravadores, que usam este hook.
describe("useGravadorDeAudio — a sessão ocupada", () => {
  it("ocupa 'gravando' do pedido do microfone ao fim do arquivo, e só o fim libera", async () => {
    navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
    const pedidos = microfoneQueDemora();
    const { result } = montar();
    expect(sessaoOcupada()).toBe(false);
    act(() => { void result.current.comecar(); });
    // O navegador ainda pergunta pelo microfone: o pedido já ocupa.
    expect(result.current.estado).toBe("pedindoMicrofone");
    expect(motivoDaOcupacao()).toBe("gravando");
    await act(async () => { pedidos[0](microfone()); });
    expect(result.current.estado).toBe("gravando");
    expect(motivoDaOcupacao()).toBe("gravando");
    act(() => result.current.parar());
    // Parou, mas o navegador ainda fecha o arquivo: segue ocupada.
    expect(result.current.estado).toBe("finalizando");
    expect(motivoDaOcupacao()).toBe("gravando");
    act(() => gravadores[0].terminar());
    expect(result.current.estado).toBe("parado");
    expect(sessaoOcupada()).toBe(false);
  });

  it("descartar no meio da gravação libera", async () => {
    const { result } = montar();
    await act(async () => { await result.current.comecar(); });
    expect(motivoDaOcupacao()).toBe("gravando");
    act(() => result.current.descartar());
    expect(sessaoOcupada()).toBe(false);
  });

  it("o microfone negado libera", async () => {
    let negar!: (erro: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((_resolve, reject) => { negar = reject; }));
    const { result, aoFalhar } = montar();
    act(() => { void result.current.comecar(); });
    expect(motivoDaOcupacao()).toBe("gravando");
    await act(async () => { negar(new DOMException("negado", "NotAllowedError")); });
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(sessaoOcupada()).toBe(false);
  });

  it("sair da tela gravando, ou com o pedido do microfone aberto, libera, e o microfone que chega depois não volta a ocupar", async () => {
    const gravando = montar();
    await act(async () => { await gravando.result.current.comecar(); });
    expect(motivoDaOcupacao()).toBe("gravando");
    gravando.unmount();
    expect(sessaoOcupada()).toBe(false);

    const pedidos = microfoneQueDemora();
    const pedindo = montar();
    act(() => { void pedindo.result.current.comecar(); });
    expect(motivoDaOcupacao()).toBe("gravando");
    pedindo.unmount();
    expect(sessaoOcupada()).toBe(false);
    await act(async () => { pedidos[0](microfone()); });
    expect(sessaoOcupada()).toBe(false);
  });

  it("parado o gravador não ocupa, e dois gravando (a reunião e o ditado) liberam cada um o seu", async () => {
    const reuniao = montar();
    const ditado = montar();
    expect(sessaoOcupada()).toBe(false);
    await act(async () => { await reuniao.result.current.comecar(); });
    await act(async () => { await ditado.result.current.comecar(); });
    act(() => reuniao.result.current.parar());
    expect(reuniao.result.current.estado).toBe("parado");
    expect(motivoDaOcupacao()).toBe("gravando");
    act(() => ditado.result.current.parar());
    expect(sessaoOcupada()).toBe(false);
  });
});

describe("useGravadorDeAudio — gravação em partes (G9)", () => {
  it("a cada fatiaSegundos fecha a parte e abre a seguinte no MESMO microfone, sem parar a gravação", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"]);
      const aoFecharParte = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_500); });
      expect(gravadores).toHaveLength(2);
      expect(gravadores[1].fluxo).toBe(gravadores[0].fluxo);
      // O gravador da parte seguinte começa ANTES de o da atual parar: nada cai entre as duas.
      expect(linhaDoTempo).toEqual(["começa 0", "começa 1", "para 0"]);
      expect(aoFecharParte).toHaveBeenCalledTimes(1);
      expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: false, mimeType: "audio/mp4", duracaoMs: 600_000 });
      expect(result.current.estado).toBe("gravando");
      expect(trilha.stop).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(100_000); });
      act(() => result.current.parar());
      expect(aoFecharParte).toHaveBeenCalledTimes(2);
      expect(aoFecharParte.mock.calls[1][0]).toMatchObject({ seq: 1, ultima: true });
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(trilha.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["da anterior", [0, 1]],
    ["da seguinte", [1, 0]],
  ])("o Parar logo depois de uma troca, com a parte anterior ainda fechando o arquivo: as duas saem na ordem (com o fim %s primeiro), e só então o microfone é solto", async (_primeiro, fins) => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      // A troca: a parte 1 já grava, e a 0 parou, mas o navegador ainda não entregou o fim dela.
      expect(gravadores.map(gravador => gravador.state)).toEqual(["inactive", "recording"]);
      act(() => { vi.advanceTimersByTime(3_000); });
      act(() => result.current.parar());
      expect(result.current.estado).toBe("finalizando");
      act(() => gravadores[fins[0]].terminar());
      // O fim da seguinte que chega primeiro espera o da anterior: a última parte sai por último.
      expect(aoFecharParte.mock.calls.map(([parte]) => parte.seq)).toEqual(fins[0] === 0 ? [0] : []);
      expect(result.current.estado).toBe("finalizando");
      expect(trilha.stop).not.toHaveBeenCalled();
      expect(aoTerminar).not.toHaveBeenCalled();
      act(() => gravadores[fins[1]].terminar());
      expect(aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima, parte.duracaoMs])).toEqual([[0, false, 600_000], [1, true, 3_000]]);
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(aoTerminar.mock.calls[0][0]).toMatchObject({ duracaoMs: 3_000 });
      expect(result.current.estado).toBe("parado");
      expect(trilha.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Pausar logo depois de uma troca, com a parte anterior ainda fechando o arquivo: cada parte sai com a sua duração, e a pausa conta só na seguinte", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const { result } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      act(() => result.current.pausar());
      expect(result.current.estado).toBe("pausado");
      expect(gravadores.map(gravador => gravador.state)).toEqual(["inactive", "paused"]);
      act(() => { vi.advanceTimersByTime(30_000); });
      // O fim da parte 0 chega com a gravação pausada: ela sai inteira, sem a pausa da seguinte.
      act(() => gravadores[0].terminar());
      expect(aoFecharParte).toHaveBeenCalledTimes(1);
      expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: false, duracaoMs: 600_000 });
      expect(result.current.estado).toBe("pausado");
      act(() => result.current.continuar());
      act(() => { vi.advanceTimersByTime(10_000); });
      act(() => result.current.parar());
      act(() => gravadores[1].terminar());
      expect(aoFecharParte.mock.calls[1][0]).toMatchObject({ seq: 1, ultima: true, duracaoMs: 10_000 });
      expect(gravadores).toHaveLength(2);
      expect(trilha.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Descartar logo depois de uma troca: nem a parte anterior, que ainda fechava o arquivo, nem a atual saem, e o microfone é solto", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      act(() => result.current.descartar());
      expect(gravadores.map(gravador => gravador.state)).toEqual(["inactive", "inactive"]);
      expect(trilha.stop).toHaveBeenCalledTimes(1);
      expect(result.current.estado).toBe("parado");
      // Os fins que o navegador ainda entregaria não chegam a ninguém.
      act(() => { for (const gravador of gravadores) gravador.terminar(); });
      expect(aoFecharParte).not.toHaveBeenCalled();
      expect(aoTerminar).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("com entregarAoSair, desmontar logo depois de uma troca entrega as duas partes na ordem e avisa uma vez", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const aoEntregarAoSair = vi.fn();
      const { result, unmount, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte, entregarAoSair: true, aoEntregarAoSair });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      unmount();
      expect(aoEntregarAoSair).toHaveBeenCalledTimes(1);
      gravadores[1].terminar();
      gravadores[0].terminar();
      expect(aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima])).toEqual([[0, false], [1, true]]);
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(trilha.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o navegador que não grava o mesmo fluxo com dois gravadores: troca como antes da emenda (a seguinte abre quando a atual fecha o arquivo), e a gravação continua", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { umPorVez: true });
      const aoFecharParte = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      // O gravador 1 foi recusado; o 2 abriu depois de o 0 fechar o arquivo.
      expect(linhaDoTempo).toEqual(["começa 0", "para 0", "começa 2"]);
      expect(result.current.estado).toBe("gravando");
      expect(aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima, parte.duracaoMs])).toEqual([[0, false, 600_000]]);
      act(() => { vi.advanceTimersByTime(100_000); });
      act(() => result.current.parar());
      expect(aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima])).toEqual([[0, false], [1, true]]);
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(trilha.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nessa troca como antes, o Parar que chega antes do fim do arquivo vale como o fim, e a parte seguinte não abre; pausar no meio dela não pausa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { umPorVez: true, fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      expect(gravadores[0].state).toBe("inactive");
      act(() => result.current.pausar());
      expect(result.current.estado).toBe("gravando");
      act(() => result.current.parar());
      expect(result.current.estado).toBe("finalizando");
      act(() => gravadores[0].terminar());
      expect(linhaDoTempo).toEqual(["começa 0", "para 0"]);
      expect(aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima])).toEqual([[0, true]]);
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(result.current.estado).toBe("parado");
      expect(trilha.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o gravador da parte seguinte recusado na troca e de novo no fim do arquivo (a trilha do microfone que caiu): a gravação encerra e entrega o que gravou como a última parte", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { recusarAPartirDe: 1 });
      const aoFecharParte = vi.fn();
      const { result, aoTerminar, aoFalhar } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_000); });
      expect(gravadores).toHaveLength(1);
      expect(aoFecharParte).toHaveBeenCalledTimes(1);
      expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: true, duracaoMs: 600_000 });
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(result.current.estado).toBe("parado");
      expect(trilha.stop).toHaveBeenCalledTimes(1);
      // Nada a avisar: o que foi gravado foi entregue.
      expect(aoFalhar).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("descartar no meio da troca não deixa a próxima gravação presa sem trocar de parte", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const aoFecharParte = vi.fn();
      const { result } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_500); });
      act(() => result.current.descartar());
      navegadorQueGrava(["audio/mp4"]);
      gravadores = [];
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(600_500); });
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 0, ultima: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("no limite, avisa uma vez por aoChegarAoLimite e para entregando o que gravou (as 12 h da G13a)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const aoChegarAoLimite = vi.fn();
      const { result, aoTerminar } = montar({ limiteSegundos: 120, aoChegarAoLimite });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(119_500); });
      expect(aoChegarAoLimite).not.toHaveBeenCalled();
      expect(result.current.estado).toBe("gravando");
      act(() => { vi.advanceTimersByTime(500); });
      expect(aoChegarAoLimite).toHaveBeenCalledTimes(1);
      expect(result.current.estado).toBe("parado");
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(aoChegarAoLimite).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no limite com o gravador que o navegador já deu como inativo (o parar sai cedo), avisa uma vez só, e não a cada volta do relógio (G13b)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const aoChegarAoLimite = vi.fn();
      const { result } = montar({ limiteSegundos: 120, aoChegarAoLimite });
      await act(async () => { await result.current.comecar(); });
      // O navegador encerrou o MediaRecorder por conta própria, sem o fim chegar:
      // o parar() não tem o que parar e sai sem trocar o estado.
      gravadores[0].state = "inactive";
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(aoChegarAoLimite).toHaveBeenCalledTimes(1);
      expect(result.current.estado).toBe("gravando");
      // O relógio segue batendo no limite a cada 500 ms, e o aviso não se repete.
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(aoChegarAoLimite).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no limite, para primeiro e avisa depois; e a gravação seguinte que chega ao limite avisa de novo (um aviso por gravação)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      // Quantas gravações já tinham sido entregues quando cada aviso chegou.
      const entreguesNoAviso: number[] = [];
      let entregues = () => 0;
      const aoChegarAoLimite = vi.fn(() => { entreguesNoAviso.push(entregues()); });
      const { result, aoTerminar } = montar({ limiteSegundos: 120, aoChegarAoLimite });
      entregues = () => aoTerminar.mock.calls.length;
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(result.current.estado).toBe("parado");
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(aoChegarAoLimite).toHaveBeenCalledTimes(2);
      expect(aoTerminar).toHaveBeenCalledTimes(2);
      // O gravador falso entrega já no stop(): cada aviso chega depois da entrega da própria gravação.
      expect(entreguesNoAviso).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o Parar de quem grava não é o limite: aoChegarAoLimite não é chamado", async () => {
    const aoChegarAoLimite = vi.fn();
    const { result, aoTerminar } = montar({ aoChegarAoLimite });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.parar());
    expect(aoTerminar).toHaveBeenCalledTimes(1);
    expect(aoChegarAoLimite).not.toHaveBeenCalled();
  });

  it("sem fatiaSegundos, é a gravação de sempre: uma parte só, com a duração inteira", async () => {
    navegadorQueGrava(["audio/mp4"]);
    const aoFecharParte = vi.fn();
    const { result, aoTerminar } = montar({ aoFecharParte });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.parar());
    expect(gravadores).toHaveLength(1);
    expect(aoFecharParte).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, ultima: true }));
    expect(aoTerminar).toHaveBeenCalledTimes(1);
  });
});

// A emenda entre as partes (pedido do Roberto em 16/11: "a fala não pode se
// perder"). Antes, a troca parava o gravador da parte e só abria o da seguinte
// quando o navegador entregava o fim do arquivo: o áudio desse intervalo caía
// entre as duas, e a palavra dita bem na troca saía cortada.
describe("useGravadorDeAudio — a emenda das partes, sem corte", () => {
  const HORA_DA_TROCA = 600_000;
  const RELOGIO_FALSO: Parameters<typeof vi.useFakeTimers>[0] = { shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] };

  async function gravarEmPartes(opcoes: Partial<OpcoesDoGravador> = {}) {
    const aoFecharParte = vi.fn<(parte: AudioGravado & { seq: number; ultima: boolean }) => void>();
    const montado = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte, ...opcoes });
    await act(async () => { await montado.result.current.comecar(); });
    return { ...montado, aoFecharParte, comecouEm: Date.now() };
  }

  /** Anda o relógio falso até `ms` depois do começo da gravação (sem pausas no meio). */
  function andarAte(comecouEm: number, ms: number) {
    act(() => { vi.advanceTimersByTime(comecouEm + ms - Date.now()); });
  }

  it("nenhum pedaço de áudio cai entre as partes: a fala de antes, durante e depois da troca está numa parte, na ordem, mesmo com o fim do arquivo chegando depois", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"], { fimAtrasado: true });
      const { result, aoFecharParte, comecouEm } = await gravarEmPartes();
      const faladas: string[] = [];
      const falarPor = (ms: number) => {
        for (let passados = 0; passados < ms; passados += 100) {
          const trecho = `[fala ${faladas.length}]`;
          faladas.push(trecho);
          falar(trecho);
          act(() => { vi.advanceTimersByTime(100); });
        }
      };
      andarAte(comecouEm, HORA_DA_TROCA - 1_000);
      // Fala sem pausa (sem detector, a troca sai no tempo) até 2 s depois da troca.
      falarPor(3_000);
      expect(gravadores).toHaveLength(2);
      // O navegador só agora entrega o fim da parte 0, e a fala continua.
      act(() => gravadores[0].terminar());
      falarPor(1_000);
      act(() => result.current.parar());
      act(() => gravadores[1].terminar());
      const partes = aoFecharParte.mock.calls.map(([parte]) => parte);
      expect(partes.map(parte => [parte.seq, parte.ultima])).toEqual([[0, false], [1, true]]);
      const ouvidas = (await Promise.all(partes.map(parte => parte.blob.text()))).flatMap(texto => texto.match(/\[fala \d+\]/g) ?? []);
      expect(ouvidas).toEqual(faladas);
      expect(linhaDoTempo).toEqual(["começa 0", "começa 1", "para 0", "para 1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a troca espera a pausa da fala: o detector abre 2 s antes da hora, a calma antes dela não troca, e a troca sai no primeiro trecho calmo de 300 ms depois dela", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      // Uma pausa logo antes da hora, com o detector já aberto: a parte ainda não chegou aos 600 s.
      somDesde(comecouEm + HORA_DA_TROCA - 1_500, SILENCIO);
      somDesde(comecouEm + HORA_DA_TROCA - 200, FALA);
      // A pausa da fala depois da hora, aos 607 s.
      somDesde(comecouEm + HORA_DA_TROCA + 7_000, SILENCIO);
      andarAte(comecouEm, HORA_DA_TROCA - PREPARO_DO_DETECTOR_MS - 100);
      expect(contextos).toHaveLength(0);
      andarAte(comecouEm, HORA_DA_TROCA - PREPARO_DO_DETECTOR_MS);
      expect(contextos).toHaveLength(1);
      expect(contextos[0].fonte.connect).toHaveBeenCalledTimes(1);
      // A hora chega com fala: não troca.
      andarAte(comecouEm, HORA_DA_TROCA + 7_200);
      expect(gravadores).toHaveLength(1);
      expect(aoFecharParte).not.toHaveBeenCalled();
      // 300 ms calmos: troca.
      andarAte(comecouEm, HORA_DA_TROCA + 7_300);
      expect(gravadores).toHaveLength(2);
      expect(linhaDoTempo).toEqual(["começa 0", "começa 1", "para 0"]);
      expect(aoFecharParte).toHaveBeenCalledTimes(1);
      expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: false, duracaoMs: HORA_DA_TROCA + 7_300 });
      // A troca solta o fluxo e fecha o contexto; a parte seguinte abre o seu na hora dela.
      expect(contextos[0].fechado).toBe(true);
      expect(contextos[0].fonte.disconnect).toHaveBeenCalled();
      // O primeiro tique do relógio (a cada 500 ms) depois dos 598 s da parte 1.
      andarAte(comecouEm, HORA_DA_TROCA + 7_300 + HORA_DA_TROCA - PREPARO_DO_DETECTOR_MS + 500);
      expect(contextos).toHaveLength(2);
      expect(gravadores).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("em silêncio, troca logo na hora, e não antes", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, SILENCIO);
      andarAte(comecouEm, HORA_DA_TROCA - 100);
      expect(gravadores).toHaveLength(1);
      andarAte(comecouEm, HORA_DA_TROCA);
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(HORA_DA_TROCA);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem pausa na fala, troca aos 620 s, abaixo dos 720 s que o servidor aceita", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      andarAte(comecouEm, HORA_DA_TROCA + ESPERA_PELA_PAUSA_MS - 100);
      expect(gravadores).toHaveLength(1);
      andarAte(comecouEm, HORA_DA_TROCA + ESPERA_PELA_PAUSA_MS);
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(620_000);
      expect(contextos[0].fechado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem AudioContext, troca no tempo, na hora, como antes", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      andarAte(comecouEm, HORA_DA_TROCA - 500);
      expect(gravadores).toHaveLength(1);
      andarAte(comecouEm, HORA_DA_TROCA);
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(HORA_DA_TROCA);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o AudioContext que o navegador recusa: troca no tempo, na hora", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve({ recusar: true });
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      andarAte(comecouEm, HORA_DA_TROCA - 500);
      expect(gravadores).toHaveLength(1);
      andarAte(comecouEm, HORA_DA_TROCA);
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(HORA_DA_TROCA);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o contexto suspenso (o iPhone sem o toque da dona): pede para rodar, troca no tempo, na hora, e fecha o contexto", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve({ estadoInicial: "suspended" });
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      andarAte(comecouEm, HORA_DA_TROCA - 100);
      expect(contextos).toHaveLength(1);
      expect(contextos[0].resume).toHaveBeenCalledTimes(1);
      expect(gravadores).toHaveLength(1);
      andarAte(comecouEm, HORA_DA_TROCA);
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(HORA_DA_TROCA);
      expect(contextos[0].fechado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o tique atrasado (a aba em segundo plano, com os timers espaçados) troca na hora, sem esperar a pausa", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const { aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      andarAte(comecouEm, HORA_DA_TROCA - 10_000);
      // O navegador segura os timers: o relógio de parede anda 12 s sem tique.
      vi.setSystemTime(Date.now() + ATRASO_MAXIMO_MS + 7_000);
      act(() => { vi.advanceTimersByTime(500); });
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBe(HORA_DA_TROCA + 2_500);
      // Nem chegou a abrir o detector.
      expect(contextos).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pausar perto da troca fecha o detector; na volta ele abre de novo, e a troca sai na pausa da fala, sem contar a pausa da gravação", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const { result, aoFecharParte, comecouEm } = await gravarEmPartes();
      somDesde(comecouEm, FALA);
      andarAte(comecouEm, HORA_DA_TROCA + 5_000);
      expect(contextos).toHaveLength(1);
      act(() => result.current.pausar());
      expect(contextos[0].fechado).toBe(true);
      act(() => { vi.advanceTimersByTime(30_000); });
      // Pausada, não troca, e nenhum detector abre.
      expect(gravadores).toHaveLength(1);
      expect(contextos).toHaveLength(1);
      act(() => result.current.continuar());
      const voltouEm = Date.now();
      somDesde(voltouEm + 2_000, SILENCIO);
      act(() => { vi.advanceTimersByTime(2_200); });
      expect(contextos).toHaveLength(2);
      expect(gravadores).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(100); });
      expect(gravadores).toHaveLength(2);
      expect(aoFecharParte.mock.calls[0][0]).toMatchObject({ seq: 0, ultima: false, duracaoMs: HORA_DA_TROCA + 5_000 + 2_300 });
      expect(contextos[1].fechado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("encerrar com o detector aberto fecha o contexto; a gravação de uma parte só (o ditado, a voz) nem o abre", async () => {
    vi.useFakeTimers(RELOGIO_FALSO);
    try {
      navegadorQueGrava(["audio/mp4"]);
      navegadorQueOuve();
      const emPartes = await gravarEmPartes();
      somDesde(emPartes.comecouEm, FALA);
      andarAte(emPartes.comecouEm, HORA_DA_TROCA + 1_000);
      expect(contextos).toHaveLength(1);
      act(() => emPartes.result.current.parar());
      expect(contextos[0].fechado).toBe(true);
      expect(emPartes.aoFecharParte.mock.calls.map(([parte]) => [parte.seq, parte.ultima])).toEqual([[0, true]]);
      emPartes.unmount();

      const ditado = montar({ limiteSegundos: 3600 });
      await act(async () => { await ditado.result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(HORA_DA_TROCA + ESPERA_PELA_PAUSA_MS); });
      expect(contextos).toHaveLength(1);
      act(() => ditado.result.current.parar());
      expect(ditado.aoTerminar).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useGravadorDeAudio — pausa (G10)", () => {
  it("pausar congela o relógio; continuar retoma; a duração entregue desconta a pausa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { result, aoTerminar } = montar({ limiteSegundos: 3600 });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(10_000); });
      act(() => result.current.pausar());
      expect(result.current.estado).toBe("pausado");
      expect(gravadores[0].state).toBe("paused");
      const congelado = result.current.segundos;
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(result.current.segundos).toBe(congelado);
      act(() => result.current.continuar());
      expect(result.current.estado).toBe("gravando");
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(result.current.segundos).toBe(15);
      act(() => result.current.parar());
      expect(aoTerminar.mock.calls[0][0].duracaoMs).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parar com a gravação pausada entrega o áudio sem o tempo pausado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { result, aoTerminar } = montar({ limiteSegundos: 3600 });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(8_000); });
      act(() => result.current.pausar());
      act(() => { vi.advanceTimersByTime(30_000); });
      act(() => result.current.parar());
      expect(result.current.estado).toBe("parado");
      expect(aoTerminar.mock.calls[0][0].duracaoMs).toBe(8_000);
      expect(trilha.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("em partes, a pausa não conta para a troca de parte", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      navegadorQueGrava(["audio/mp4"]);
      const aoFecharParte = vi.fn();
      const { result } = montar({ limiteSegundos: 3600, fatiaSegundos: 600, aoFecharParte });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(500_000); });
      act(() => result.current.pausar());
      act(() => { vi.advanceTimersByTime(300_000); });
      act(() => result.current.continuar());
      act(() => { vi.advanceTimersByTime(50_000); });
      expect(aoFecharParte).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(51_000); });
      expect(aoFecharParte).toHaveBeenCalledTimes(1);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBeGreaterThanOrEqual(600_000);
      expect(aoFecharParte.mock.calls[0][0].duracaoMs).toBeLessThanOrEqual(601_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pausa além do teto (1 h): encerra e entrega o que gravou, sem a pausa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { result, aoTerminar } = montar({ limiteSegundos: 7200 });
      await act(async () => { await result.current.comecar(); });
      act(() => { vi.advanceTimersByTime(20_000); });
      act(() => result.current.pausar());
      act(() => { vi.advanceTimersByTime(PAUSA_MAXIMA_MS + 1_000); });
      expect(result.current.estado).toBe("parado");
      expect(aoTerminar).toHaveBeenCalledTimes(1);
      expect(aoTerminar.mock.calls[0][0].duracaoMs).toBe(20_000);
      expect(trilha.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continuar com a trilha do microfone encerrada (iPhone bloqueado na pausa): encerra e entrega", async () => {
    const { result, aoTerminar } = montar({ limiteSegundos: 3600 });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.pausar());
    (gravadores[0] as unknown as { stream: unknown }).stream = { getAudioTracks: () => [{ readyState: "ended" }] };
    act(() => result.current.continuar());
    expect(result.current.estado).toBe("parado");
    expect(aoTerminar).toHaveBeenCalledTimes(1);
  });

  it("pausar e continuar duplos, e continuar sem pausa, não fazem nada", async () => {
    const { result } = montar({ limiteSegundos: 3600 });
    await act(async () => { await result.current.comecar(); });
    act(() => result.current.continuar());
    expect(result.current.estado).toBe("gravando");
    act(() => result.current.pausar());
    act(() => result.current.pausar());
    expect(result.current.estado).toBe("pausado");
    act(() => result.current.continuar());
    act(() => result.current.continuar());
    expect(result.current.estado).toBe("gravando");
  });
});
