import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTelaAcesa } from "./useTelaAcesa";

function wakeLockFalso() {
  const sentinelas: Array<{ released: boolean; release: ReturnType<typeof vi.fn> }> = [];
  const request = vi.fn(async () => {
    const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
    sentinelas.push(s);
    return s;
  });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  return { request, sentinelas };
}

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
});

describe("useTelaAcesa (G10)", () => {
  it("pede a tela acesa enquanto ativo e a solta ao parar", async () => {
    const { request, sentinelas } = wakeLockFalso();
    const { rerender } = renderHook(({ ativo }) => useTelaAcesa(ativo), { initialProps: { ativo: true } });
    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    await waitFor(() => expect(sentinelas).toHaveLength(1));
    rerender({ ativo: false });
    expect(sentinelas[0].release).toHaveBeenCalled();
  });

  it("ao voltar para a aba, pede de novo só se o navegador soltou a anterior", async () => {
    const { request, sentinelas } = wakeLockFalso();
    renderHook(() => useTelaAcesa(true));
    await waitFor(() => expect(sentinelas).toHaveLength(1));
    // A anterior ainda vale: nenhum pedido novo (nada vaza).
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(r => setTimeout(r, 0));
    expect(request).toHaveBeenCalledTimes(1);
    // O navegador soltou ao esconder a aba: ao voltar, pede outra.
    sentinelas[0].released = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("o pedido que chega depois de sair da gravação é solto na hora", async () => {
    let entregar: (s: { released: boolean; release: ReturnType<typeof vi.fn> }) => void = () => {};
    const request = vi.fn(() => new Promise(r => { entregar = r; }));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    const { unmount } = renderHook(() => useTelaAcesa(true));
    unmount();
    const atrasada = { released: false, release: vi.fn(async () => undefined) };
    entregar(atrasada);
    await waitFor(() => expect(atrasada.release).toHaveBeenCalled());
  });

  it("inativo não pede nada; sem a API, devolve recusada", () => {
    const { request } = wakeLockFalso();
    renderHook(() => useTelaAcesa(false));
    expect(request).not.toHaveBeenCalled();
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    const { result } = renderHook(() => useTelaAcesa(true));
    expect(result.current.recusada).toBe(true);
  });

  it("recusa do navegador (bateria fraca) não quebra a gravação", async () => {
    const request = vi.fn(async () => { throw new Error("recusado"); });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    const { result } = renderHook(() => useTelaAcesa(true));
    await waitFor(() => expect(result.current.recusada).toBe(true));
  });
});
