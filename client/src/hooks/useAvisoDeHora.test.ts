import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVISO_DE_HORA_SEGUNDOS, PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import type { EstadoDoGravador } from "./useGravadorDeAudio";
import { CONFERENCIA_DO_PRAZO_MS, useAvisoDeHora } from "./useAvisoDeHora";

/**
 * O aviso de hora da gravação em partes (G13a). O gravador é só o par estado +
 * segundos gravados, que o teste troca à mão (o relógio do gravador, sem as
 * pausas, é provado em useGravadorDeAudio.test.ts). O relógio de parede e o
 * setInterval são falsos: o prazo de 10 min anda sem esperar 10 min.
 */

type Gravador = { estado: EstadoDoGravador; segundos: number };
const HORA = AVISO_DE_HORA_SEGUNDOS;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function montar(inicial: Gravador = { estado: "gravando", segundos: 0 }) {
  const retomar = vi.fn();
  const aoExpirar = vi.fn();
  const hook = renderHook((gravador: Gravador) => useAvisoDeHora({ ...gravador, retomar, aoExpirar }), { initialProps: inicial });
  return { ...hook, retomar, aoExpirar };
}

const andar = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("useAvisoDeHora — quando abre (G13a)", () => {
  it("abre aos 3600 s gravados, e não aos 3599", () => {
    const { result, rerender } = montar();
    rerender({ estado: "gravando", segundos: HORA - 1 });
    expect(result.current.aberto).toBe(false);
    rerender({ estado: "gravando", segundos: HORA });
    expect(result.current).toMatchObject({ aberto: true, horas: 1 });
  });

  it("parada não abre, nem fechando o arquivo", () => {
    const { result, rerender } = montar({ estado: "parado", segundos: HORA });
    expect(result.current.aberto).toBe(false);
    rerender({ estado: "finalizando", segundos: 2 * HORA });
    expect(result.current.aberto).toBe(false);
  });

  it("pausada antes da hora não abre, por mais que o relógio de parede ande: as horas são de gravação", () => {
    const { result, rerender } = montar();
    rerender({ estado: "gravando", segundos: HORA - 1 });
    rerender({ estado: "pausado", segundos: HORA - 1 });
    andar(2 * 3_600_000);
    expect(result.current.aberto).toBe(false);
  });
});

describe("useAvisoDeHora — o prazo de 10 min, no relógio de parede", () => {
  it("expira aos 600 000 ms, uma vez só, e fecha o aviso", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    andar(PRAZO_DO_AVISO_DE_HORA_MS - 1);
    expect(result.current.aberto).toBe(true);
    expect(aoExpirar).not.toHaveBeenCalled();
    andar(1);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    expect(result.current.aberto).toBe(false);
    andar(3 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
  });

  it("um tique atrasado (aba em segundo plano) também expira", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    // O navegador segurou os timers da aba oculta: o relógio de parede passou
    // do prazo sem nenhum tique no meio.
    vi.setSystemTime(Date.now() + 30 * 60_000);
    expect(aoExpirar).not.toHaveBeenCalled();
    andar(CONFERENCIA_DO_PRAZO_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    expect(result.current.aberto).toBe(false);
  });

  it("o prazo corre também com a gravação pausada: é de relógio, não de gravação", () => {
    const { rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    rerender({ estado: "pausado", segundos: HORA });
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
  });

  it("depois de expirar, a mesma hora não reabre; a segunda hora abre o aviso de novo", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    // O dublê não para a gravação: ela segue na mesma hora sem reabrir.
    rerender({ estado: "gravando", segundos: HORA + 900 });
    expect(result.current.aberto).toBe(false);
    rerender({ estado: "gravando", segundos: 2 * HORA });
    expect(result.current).toMatchObject({ aberto: true, horas: 2 });
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(2);
  });
});

describe("useAvisoDeHora — Continuar gravando", () => {
  it("fecha o aviso e retoma a gravação pausada; fechado, o prazo não vence mais", () => {
    const { result, rerender, retomar, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    rerender({ estado: "pausado", segundos: HORA });
    act(() => result.current.continuar());
    expect(result.current.aberto).toBe(false);
    expect(retomar).toHaveBeenCalledTimes(1);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).not.toHaveBeenCalled();
  });

  it("gravando, só fecha o aviso; a hora seguinte abre de novo", () => {
    const { result, rerender, retomar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    act(() => result.current.continuar());
    expect(result.current.aberto).toBe(false);
    expect(retomar).not.toHaveBeenCalled();
    rerender({ estado: "gravando", segundos: 2 * HORA - 1 });
    expect(result.current.aberto).toBe(false);
    rerender({ estado: "gravando", segundos: 2 * HORA });
    expect(result.current).toMatchObject({ aberto: true, horas: 2 });
  });

  it("retomar pelo botão do próprio gravador vale como o OK: o aviso fecha e não vence", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    rerender({ estado: "pausado", segundos: HORA });
    expect(result.current.aberto).toBe(true);
    rerender({ estado: "gravando", segundos: HORA });
    expect(result.current.aberto).toBe(false);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).not.toHaveBeenCalled();
  });

  it("a gravação que para fecha o aviso, e a seguinte conta as horas do zero", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    rerender({ estado: "parado", segundos: 0 });
    expect(result.current.aberto).toBe(false);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).not.toHaveBeenCalled();
    rerender({ estado: "gravando", segundos: HORA });
    expect(result.current).toMatchObject({ aberto: true, horas: 1 });
  });
});
