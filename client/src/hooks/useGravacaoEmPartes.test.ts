import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const d = vi.hoisted(() => ({
  iniciar: vi.fn(),
  encerrar: vi.fn(),
  getData: vi.fn(),
  enviarParte: vi.fn(),
  enviarPendentes: vi.fn(),
  guardarParte: vi.fn(),
  apagarParte: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      auth: { me: { getData: d.getData } },
      client: { meetings: { iniciarGravacao: { mutate: d.iniciar }, encerrarGravacao: { mutate: d.encerrar } } },
    }),
  },
}));
vi.mock("@/lib/envio-das-partes", () => ({
  enviarParte: (...a: unknown[]) => d.enviarParte(...a),
  enviarPendentes: (...a: unknown[]) => d.enviarPendentes(...a),
  travaDoNavegador: async (_nome: string, trabalho: () => Promise<unknown>) => trabalho(),
}));
vi.mock("@/lib/partes-no-aparelho", () => ({
  guardarParte: (...a: unknown[]) => d.guardarParte(...a),
  apagarParte: (...a: unknown[]) => d.apagarParte(...a),
}));

const { useGravacaoEmPartes } = await import("./useGravacaoEmPartes");
const { sessaoOcupada } = await import("@/lib/sessao-ocupada");

const parte = (seq: number, ultima: boolean) => ({ blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4" as const, duracaoMs: 600_000, seq, ultima });

beforeEach(() => {
  Object.values(d).forEach(f => f.mockReset());
  d.getData.mockReturnValue({ openId: "dona-1" });
  d.iniciar.mockResolvedValue({ id: "r-1" });
  d.encerrar.mockResolvedValue({ partes: 2 });
  d.guardarParte.mockResolvedValue(undefined);
  d.apagarParte.mockResolvedValue(undefined);
  d.enviarPendentes.mockResolvedValue({ restantes: 0, semSessao: false });
});

describe("useGravacaoEmPartes (G9)", () => {
  it("cria a reunião no início, guarda cada parte no aparelho, envia em ordem, apaga a confirmada e encerra na última", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "Reunião", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    expect(d.iniciar).toHaveBeenCalledWith(expect.objectContaining({ title: "Reunião", consentGranted: true, origem: "gravacao" }));

    act(() => result.current.receberParte(parte(0, false)));
    act(() => result.current.receberParte(parte(1, true)));
    expect(sessaoOcupada()).toBe(true);
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    expect(d.guardarParte.mock.calls.map(c => c[0].seq)).toEqual([0, 1]);
    expect(d.guardarParte.mock.calls[0][0]).toMatchObject({ meetingId: "r-1", dona: "dona-1" });
    expect(d.enviarParte.mock.calls.map(c => c[1])).toEqual([0, 1]);
    expect(d.apagarParte.mock.calls).toEqual([["r-1", 0], ["r-1", 1]]);
    expect(d.encerrar).toHaveBeenCalledWith({ meetingId: "r-1", partes: 2 });
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("envio passageiro: a parte FICA no aparelho (a retomada manda depois), e o fim ainda é declarado", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "passageira" });
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalled());
    expect(d.apagarParte).not.toHaveBeenCalled();
  });

  it("sem IndexedDB, envia da memória mesmo assim", async () => {
    d.guardarParte.mockRejectedValue(new Error("sem IndexedDB"));
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalled());
  });

  it("encerrar que falha avisa a tela", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    d.encerrar.mockRejectedValue(new Error("rede"));
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoFalhar).toHaveBeenCalled());
  });

  it("ativo: retoma o que ficou no aparelho ao montar; inativo: não toca o servidor", async () => {
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(d.enviarPendentes).toHaveBeenCalledWith("dona-1"));
    d.enviarPendentes.mockClear();
    d.getData.mockClear();
    renderHook(() => useGravacaoEmPartes({ ativo: false, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await new Promise(r => setTimeout(r, 10));
    expect(d.enviarPendentes).not.toHaveBeenCalled();
    expect(d.getData).not.toHaveBeenCalled();
  });
});
