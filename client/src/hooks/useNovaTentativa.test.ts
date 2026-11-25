import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNovaTentativa } from "./useNovaTentativa";

describe("useNovaTentativa — pedir de novo a tradução longa (G8)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("agendar liga o aviso e, passado o intervalo, soma uma tentativa; parar cancela", () => {
    const { result } = renderHook(() => useNovaTentativa("r1|en"));
    act(() => result.current.agendar());
    expect(result.current.aguardando).toBe(true);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current.tentativa).toBe(1);
    act(() => result.current.agendar());
    act(() => result.current.parar());
    expect(result.current.aguardando).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.tentativa).toBe(1);
  });

  it("mudar a chave (outro idioma) desliga o aviso e cancela o agendado do pedido anterior", () => {
    const { result, rerender } = renderHook(({ chave }) => useNovaTentativa(chave), { initialProps: { chave: "r1|en" } });
    act(() => result.current.agendar());
    rerender({ chave: "r1|es" });
    expect(result.current.aguardando).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("desmontar a tela cancela o agendado", () => {
    const { result, unmount } = renderHook(() => useNovaTentativa("r1|en"));
    act(() => result.current.agendar());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
