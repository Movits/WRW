import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import { useGravadorDeAudio, type AudioGravado, type OpcoesDoGravador } from "./useGravadorDeAudio";

/** O MediaRecorder do navegador, que grava só os formatos da lista. */
type GravadorFalso = {
  fluxo: unknown;
  opcoes: MediaRecorderOptions | undefined;
  mimeType: string;
  state: "inactive" | "recording";
  ondataavailable: ((evento: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  /** Com o fim atrasado: entrega os pedaços e o fim, como o navegador faz depois do stop(). */
  terminar: () => void;
};
let gravadores: GravadorFalso[] = [];

function navegadorQueGrava(formatos: string[], { fimAtrasado = false } = {}) {
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported = (tipo: string) => formatos.includes(tipo);
    fluxo: unknown;
    opcoes: MediaRecorderOptions | undefined;
    mimeType: string;
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((evento: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(fluxo: unknown, opcoes?: MediaRecorderOptions) {
      this.fluxo = fluxo;
      this.opcoes = opcoes;
      // Sem mimeType nas opções, o navegador grava no padrão dele.
      this.mimeType = opcoes?.mimeType ?? "audio/webm;codecs=opus";
      gravadores.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      if (!fimAtrasado) this.terminar();
    }
    terminar() {
      this.ondataavailable?.({ data: new Blob(["som"], { type: this.mimeType }) });
      this.onstop?.();
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
