import { afterEach, describe, expect, it, vi } from "vitest";
import { abrirMedidorDaVoz, nivelDaVoz, PISO_DB, prepararContextoNoToque, suavizarNivel, TETO_DB } from "./medidor-da-voz";

/** Um sinal constante com o RMS em `db` dBFS. */
function sinal(db: number, quantas = 1024) {
  return new Float32Array(quantas).fill(10 ** (db / 20));
}

describe("nivelDaVoz", () => {
  it("silêncio e o piso são 0; o teto e acima são 1", () => {
    expect(nivelDaVoz(new Float32Array(1024))).toBe(0);
    expect(nivelDaVoz([])).toBe(0);
    expect(nivelDaVoz(sinal(PISO_DB))).toBeCloseTo(0, 5);
    expect(nivelDaVoz(sinal(-70))).toBe(0);
    expect(nivelDaVoz(sinal(TETO_DB))).toBeCloseTo(1, 5);
    expect(nivelDaVoz(sinal(0))).toBe(1);
  });

  it("sem o ganho automático (#245): a fala comum já mexe a bolha, e o fundo da sala não", () => {
    expect(nivelDaVoz(sinal(-30))).toBeGreaterThanOrEqual(0.6);
    expect(nivelDaVoz(sinal(-55))).toBe(0);
  });

  it("a fala comum fica no meio, e mais alto é mais nível", () => {
    const baixa = nivelDaVoz(sinal(-40));
    const comum = nivelDaVoz(sinal(-25));
    expect(baixa).toBeGreaterThan(0);
    expect(comum).toBeGreaterThan(baixa);
    expect(comum).toBeLessThan(1);
  });
});

describe("suavizarNivel", () => {
  it("sobe mais rápido do que desce, e não passa do alvo", () => {
    const subida = suavizarNivel(0, 1, 0.05);
    const descida = 1 - suavizarNivel(1, 0, 0.05);
    expect(subida).toBeGreaterThan(descida);
    expect(suavizarNivel(0, 1, 10)).toBe(1);
    expect(suavizarNivel(1, 0, 10)).toBe(0);
    expect(suavizarNivel(0.4, 0.8, 0)).toBe(0.4);
  });
});

class AnalisadorFalso {
  fftSize = 2048;
  db = -25;
  getFloatTimeDomainData(destino: Float32Array) { destino.fill(10 ** (this.db / 20)); }
}

const criados: ContextoFalso[] = [];
class ContextoFalso {
  state: AudioContextState = "suspended";
  analisador = new AnalisadorFalso();
  fechado = false;
  fonteDesligada = false;
  constructor() { criados.push(this); }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { this.fechado = true; this.state = "closed"; return Promise.resolve(); }
  createAnalyser() { return this.analisador; }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => { this.fonteDesligada = true; } };
  }
}

afterEach(() => {
  criados.splice(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("abrirMedidorDaVoz", () => {
  it("sem Web Audio, não há medidor", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(abrirMedidorDaVoz({} as MediaStream)).toBeNull();
  });

  it("ouve o fluxo, mede o nível e fecha o contexto", () => {
    vi.stubGlobal("AudioContext", ContextoFalso);
    const medidor = abrirMedidorDaVoz({} as MediaStream)!;
    expect(medidor.ouvindo()).toBe(true);
    expect(medidor.nivel()).toBeCloseTo(nivelDaVoz(sinal(-25)), 5);
    medidor.fechar();
    medidor.fechar();
    expect(medidor.ouvindo()).toBe(false);
    expect(medidor.nivel()).toBe(0);
    expect(criados[0].fechado).toBe(true);
    expect(criados[0].fonteDesligada).toBe(true);
  });

  it("usa o contexto criado no toque em vez de abrir outro", () => {
    vi.stubGlobal("AudioContext", ContextoFalso);
    prepararContextoNoToque();
    expect(criados).toHaveLength(1);
    expect(criados[0].state).toBe("running");
    const medidor = abrirMedidorDaVoz({} as MediaStream)!;
    expect(criados).toHaveLength(1);
    medidor.fechar();
    // O contexto do toque foi usado: o próximo medidor abre outro.
    abrirMedidorDaVoz({} as MediaStream)!.fechar();
    expect(criados).toHaveLength(2);
  });

  it("o contexto do toque que ninguém usou fecha sozinho", () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", ContextoFalso);
    prepararContextoNoToque();
    vi.advanceTimersByTime(121_000);
    expect(criados[0].fechado).toBe(true);
  });

  it("com o contexto suspenso para sempre (o iPhone sem o toque), não ouve e o nível é 0", () => {
    class ContextoQueNaoRoda extends ContextoFalso { resume() { return Promise.resolve(); } }
    vi.stubGlobal("AudioContext", ContextoQueNaoRoda);
    const medidor = abrirMedidorDaVoz({} as MediaStream)!;
    expect(medidor.ouvindo()).toBe(false);
    expect(medidor.nivel()).toBe(0);
    medidor.fechar();
  });
});
