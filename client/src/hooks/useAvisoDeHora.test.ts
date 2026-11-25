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

describe("useAvisoDeHora — os saltos do relógio e o mesmo tique", () => {
  it("os segundos que saltam de uma vez para além das 2 h abrem um aviso só, o das 2 h", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA - 1 });
    // A aba em segundo plano: o relógio do gravador pula a hora 1 inteira num tique.
    rerender({ estado: "gravando", segundos: 2 * HORA + 30 });
    expect(result.current).toMatchObject({ aberto: true, horas: 2 });
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    // A hora 1 que ficou para trás não abre depois, nem a 2 de novo.
    rerender({ estado: "gravando", segundos: 2 * HORA + 31 });
    expect(result.current.aberto).toBe(false);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
  });

  it("o aviso que venceu com a aba congelada não ganha mais 10 min quando a hora seguinte chega antes do tique atrasado", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    // O notebook dormiu: 1 h de relógio sem nenhum tique, e a volta traz
    // primeiro os segundos do gravador, já na hora 2.
    vi.setSystemTime(Date.now() + HORA * 1000);
    rerender({ estado: "gravando", segundos: 2 * HORA + 5 });
    expect(result.current).toMatchObject({ aberto: true, horas: 2 });
    andar(CONFERENCIA_DO_PRAZO_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    expect(result.current.aberto).toBe(false);
  });

  it("a gravação que passa a fechar o arquivo no mesmo tique em que o prazo vence: o aviso fecha e expira uma vez só", () => {
    const { result, rerender, aoExpirar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    andar(PRAZO_DO_AVISO_DE_HORA_MS - CONFERENCIA_DO_PRAZO_MS);
    // Um act só, como a tarefa do navegador antes de o React renderizar: o
    // prazo vence, o gravador passa a "finalizando" e mais tiques chegam.
    act(() => {
      vi.advanceTimersByTime(CONFERENCIA_DO_PRAZO_MS);
      rerender({ estado: "finalizando", segundos: HORA });
      vi.advanceTimersByTime(3 * CONFERENCIA_DO_PRAZO_MS);
    });
    expect(result.current.aberto).toBe(false);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
  });
});

describe("useAvisoDeHora — sem microfone (G17)", () => {
  it("a espera por um microfone não zera as horas: na volta dele, o aviso da hora já confirmada não abre de novo", () => {
    const { result, rerender } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    expect(result.current.aberto).toBe(true);
    act(() => result.current.continuar());
    rerender({ estado: "gravando", segundos: HORA + 100 });
    // O fone caiu: a gravação espera outro microfone, com o relógio parado.
    rerender({ estado: "semMicrofone", segundos: HORA + 100 });
    rerender({ estado: "gravando", segundos: HORA + 101 });
    expect(result.current.aberto).toBe(false);
    // A hora seguinte abre, como sempre.
    rerender({ estado: "gravando", segundos: 2 * HORA });
    expect(result.current).toMatchObject({ aberto: true, horas: 2 });
  });

  it("o aviso aberto quando o microfone cai segue aberto, e o prazo dele vale", () => {
    const { result, rerender, aoExpirar, retomar } = montar();
    rerender({ estado: "gravando", segundos: HORA });
    rerender({ estado: "semMicrofone", segundos: HORA });
    expect(result.current.aberto).toBe(true);
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    // O OK sem microfone não tenta retomar nada: não há pausa a desfazer.
    expect(retomar).not.toHaveBeenCalled();
  });
});
