import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BolhaDaVoz } from "./BolhaDaVoz";

/**
 * A bolha da voz é enfeite do gravador: sem ouvir, a tela fica com o círculo de
 * sempre; ouvindo, a bolha toma o lugar dele; e ao sair, o contexto de áudio
 * fecha (um AudioContext esquecido segura o microfone e gasta bateria).
 */

const contextos: ContextoFalso[] = [];
class ContextoFalso {
  state: AudioContextState = "running";
  fechado = false;
  constructor() { contextos.push(this); }
  resume() { return Promise.resolve(); }
  close() { this.fechado = true; this.state = "closed"; return Promise.resolve(); }
  createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (destino: Float32Array) => destino.fill(0.05) }; }
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
}

const CIRCULO = <div data-testid="circulo-de-sempre" />;
const FLUXO = {} as MediaStream;

beforeEach(() => {
  // O jsdom não desenha: o contexto 2D falso só aceita as chamadas.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => new Proxy({}, { get: () => () => {}, set: () => true }) as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("matchMedia", (consulta: string) => ({ matches: false, media: consulta, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  contextos.splice(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BolhaDaVoz", () => {
  it("sem Web Audio, fica o círculo de sempre", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    render(<BolhaDaVoz fluxo={FLUXO} pausada={false} circulo={CIRCULO} />);
    expect(screen.getByTestId("circulo-de-sempre")).toBeInTheDocument();
    await new Promise(resolver => setTimeout(resolver, 50));
    expect(screen.queryByTestId("bolha-da-voz")).not.toBeInTheDocument();
  });

  it("ouvindo, a bolha toma o lugar do círculo; ao sair, o contexto fecha", async () => {
    vi.stubGlobal("AudioContext", ContextoFalso);
    const { unmount } = render(<BolhaDaVoz fluxo={FLUXO} pausada={false} circulo={CIRCULO} />);
    await waitFor(() => expect(screen.getByTestId("bolha-da-voz")).toBeInTheDocument());
    expect(screen.queryByTestId("circulo-de-sempre")).not.toBeInTheDocument();
    expect(screen.getByTestId("bolha-da-voz").querySelector("canvas")).toHaveAttribute("aria-hidden", "true");
    unmount();
    expect(contextos[0].fechado).toBe(true);
  });

  it("com o 'reduzir movimento' do aparelho, fica o círculo e nem abre o áudio", async () => {
    vi.stubGlobal("AudioContext", ContextoFalso);
    vi.stubGlobal("matchMedia", (consulta: string) => ({ matches: true, media: consulta, addEventListener() {}, removeEventListener() {} }));
    render(<BolhaDaVoz fluxo={FLUXO} pausada={false} circulo={CIRCULO} />);
    await new Promise(resolver => setTimeout(resolver, 50));
    expect(screen.getByTestId("circulo-de-sempre")).toBeInTheDocument();
    expect(contextos).toHaveLength(0);
  });

  it("o fluxo que troca (o microfone que voltou) fecha o medidor velho e abre outro", async () => {
    vi.stubGlobal("AudioContext", ContextoFalso);
    const { rerender } = render(<BolhaDaVoz fluxo={FLUXO} pausada={false} circulo={CIRCULO} />);
    await waitFor(() => expect(screen.getByTestId("bolha-da-voz")).toBeInTheDocument());
    rerender(<BolhaDaVoz fluxo={{} as MediaStream} pausada={false} circulo={CIRCULO} />);
    await waitFor(() => expect(contextos).toHaveLength(2));
    expect(contextos[0].fechado).toBe(true);
    await waitFor(() => expect(screen.getByTestId("bolha-da-voz")).toBeInTheDocument());
  });
});
