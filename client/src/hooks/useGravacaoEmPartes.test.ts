import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultadoDoDescarte } from "./useGravacaoEmPartes";

const d = vi.hoisted(() => ({
  iniciar: vi.fn(),
  encerrar: vi.fn(),
  getData: vi.fn(),
  fetch: vi.fn(),
  excluir: vi.fn(),
  enviarParte: vi.fn(),
  enviarPendentes: vi.fn(),
  guardarParte: vi.fn(),
  apagarParte: vi.fn(),
  apagarPartesDaReuniao: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  // O MESMO objeto a cada render, como o useUtils do tRPC.
  const utils = {
    auth: { me: { getData: d.getData, fetch: d.fetch } },
    client: { meetings: { iniciarGravacao: { mutate: d.iniciar }, encerrarGravacao: { mutate: d.encerrar }, delete: { mutate: d.excluir } } },
  };
  return { trpc: { useUtils: () => utils } };
});
vi.mock("@/lib/envio-das-partes", () => ({
  enviarParte: (...a: unknown[]) => d.enviarParte(...a),
  enviarPendentes: (...a: unknown[]) => d.enviarPendentes(...a),
  travaDoNavegador: async (_nome: string, trabalho: () => Promise<unknown>) => trabalho(),
}));
vi.mock("@/lib/partes-no-aparelho", () => ({
  guardarParte: (...a: unknown[]) => d.guardarParte(...a),
  apagarParte: (...a: unknown[]) => d.apagarParte(...a),
  apagarPartesDaReuniao: (...a: unknown[]) => d.apagarPartesDaReuniao(...a),
}));

const { useGravacaoEmPartes } = await import("./useGravacaoEmPartes");
const { sessaoOcupada, motivoDaOcupacao } = await import("@/lib/sessao-ocupada");

const parte = (seq: number, ultima: boolean) => ({ blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4" as const, duracaoMs: 600_000, seq, ultima });

beforeEach(() => {
  localStorage.clear();
  Object.values(d).forEach(f => f.mockReset());
  d.excluir.mockResolvedValue({ success: true });
  d.getData.mockReturnValue({ openId: "dona-1" });
  d.iniciar.mockResolvedValue({ id: "r-1" });
  d.encerrar.mockResolvedValue({ partes: 2 });
  d.guardarParte.mockResolvedValue(undefined);
  d.apagarParte.mockResolvedValue(undefined);
  d.apagarPartesDaReuniao.mockResolvedValue(undefined);
  d.enviarPendentes.mockResolvedValue({ restantes: 0, semSessao: false });
});

const INICIO = { title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" } as const;
const DESCARTES = "wrw:descartes-de-gravacao-pendentes";

/** A retomada da montagem já terminou (senão ela mesma faz o que o teste quer provar). */
async function retomadaDaMontagemFeita() {
  await waitFor(() => expect(d.enviarPendentes).toHaveBeenCalled());
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
}

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

  it("o fim que falhou fica guardado e a retomada o declara de novo", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    d.encerrar.mockRejectedValueOnce(new Error("rede"));
    const aoFalhar = vi.fn();
    const primeira = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    // A retomada da montagem termina antes (senão ela mesma declara o fim já na primeira volta).
    await waitFor(() => expect(d.enviarPendentes).toHaveBeenCalled());
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    await act(async () => { await primeira.result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => primeira.result.current.receberParte(parte(0, false)));
    act(() => primeira.result.current.receberParte(parte(1, true)));
    await waitFor(() => expect(aoFalhar).toHaveBeenCalled());
    // Com a conta que gravou (G13c): só ela o declara de novo.
    expect(JSON.parse(localStorage.getItem("wrw:fins-de-gravacao-pendentes")!)).toEqual({ "r-1": { partes: 2, dona: "dona-1" } });
    primeira.unmount();
    // A tela aberta de novo (ou a próxima volta da retomada) declara o fim.
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(localStorage.getItem("wrw:fins-de-gravacao-pendentes")).toBeNull());
    expect(d.encerrar).toHaveBeenLastCalledWith({ meetingId: "r-1", partes: 2 });
  });

  it("o fim que o servidor recusa de vez (a reunião já encerrada ou excluída) avisa, mas não fica guardado para voltar a cada 30 s (G13c)", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    d.encerrar.mockRejectedValueOnce({ message: "Esta gravação já foi encerrada.", data: { code: "CONFLICT" } });
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    await retomadaDaMontagemFeita();
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoFalhar).toHaveBeenCalled());
    expect(localStorage.getItem("wrw:fins-de-gravacao-pendentes")).toBeNull();
  });

  it("a última parte vazia (Parar logo depois de uma troca) não vai, e o fim conta só as partes com áudio", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, false)));
    act(() => result.current.receberParte({ ...parte(1, true), blob: new Blob([]) }));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalled());
    expect(d.enviarParte).toHaveBeenCalledTimes(1);
    expect(d.encerrar).toHaveBeenCalledWith({ meetingId: "r-1", partes: 1 });
  });

  it("nenhuma parte com áudio: a reunião vazia é excluída, não encerrada, e a tela não vai ao detalhe dela", async () => {
    const aoEncerrar = vi.fn();
    const aoEncerrarSemAudio = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoEncerrarSemAudio, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    // G17: o microfone caiu no primeiro segundo, e a última parte (a primeira) saiu vazia.
    act(() => result.current.receberParte({ ...parte(0, true), blob: new Blob([]) }));
    await waitFor(() => expect(aoEncerrarSemAudio).toHaveBeenCalledWith("r-1"));
    expect(aoEncerrar).not.toHaveBeenCalled();
    expect(d.encerrar).not.toHaveBeenCalled();
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
  });

  it("cancelar (o microfone não abriu) exclui a reunião que nasceu, pelo caminho de exclusão de sempre", async () => {
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await result.current.cancelar("r-1"); });
    expect(resultado).toBe("descartada");
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
    expect(d.apagarPartesDaReuniao).toHaveBeenCalledWith("r-1");
    expect(localStorage.getItem(DESCARTES)).toBeNull();
  });

  it("a conta fora do cache: busca no servidor antes de guardar a parte", async () => {
    d.getData.mockReturnValue(undefined);
    d.fetch.mockResolvedValue({ openId: "dona-2" });
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(d.guardarParte).toHaveBeenCalledWith(expect.objectContaining({ dona: "dona-2" })));
  });

  it("parte que não foi ao servidor ocupa a sessão até sair do aparelho", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "passageira" });
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(d.enviarPendentes).toHaveBeenCalled());
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    await act(async () => { await result.current.iniciar({ title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" }); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(motivoDaOcupacao()).toBe("audio-nao-enviado"));
  });

  it("ativo: retoma o que ficou no aparelho ao montar; inativo: não toca o servidor", async () => {
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(d.enviarPendentes).toHaveBeenCalledWith("dona-1", expect.objectContaining({ aoRecusar: expect.any(Function) })));
    d.enviarPendentes.mockClear();
    d.getData.mockClear();
    renderHook(() => useGravacaoEmPartes({ ativo: false, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await new Promise(r => setTimeout(r, 10));
    expect(d.enviarPendentes).not.toHaveBeenCalled();
    expect(d.getData).not.toHaveBeenCalled();
  });
});

/**
 * G13b: a gravação em partes vira o padrão para todas, e o que era silencioso
 * passa a avisar (a parte recusada, a cópia que faltou); o Descartar apaga a
 * gravação em curso; e o cancelar de uma tentativa só mexe na reunião dela
 * (o duplo clique no Iniciar apagava a reunião da gravação em curso).
 */
describe("useGravacaoEmPartes — G13b", () => {
  it("cancelar só mexe na reunião da tentativa dele: a gravação em curso segue com as partes", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    await act(async () => { await result.current.iniciar(INICIO); });
    // A outra tentativa (o segundo clique de um duplo clique) cancela a reunião DELA.
    await act(async () => { await result.current.cancelar("r-2"); });
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-2" });
    expect(d.excluir).not.toHaveBeenCalledWith({ meetingId: "r-1" });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    expect(d.enviarParte).toHaveBeenCalledWith("r-1", 0, expect.any(Blob), "audio/mp4");
    expect(aoFalhar).not.toHaveBeenCalled();
  });

  it("a última parte de uma gravação que ainda subia não tira da tela a gravação seguinte", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    d.iniciar.mockResolvedValueOnce({ id: "r-1" }).mockResolvedValueOnce({ id: "r-2" });
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    // A gravação seguinte começa enquanto a última parte da primeira ainda sobe.
    await act(async () => { await result.current.iniciar(INICIO); });
    await act(async () => { soltar({ tipo: "recebida" }); });
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(2));
    expect(d.enviarParte.mock.calls[1][0]).toBe("r-2");
    expect(aoFalhar).not.toHaveBeenCalled();
  });

  it("a parte recusada de vez avisa com o código, na gravação e na retomada, e sai do aparelho", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recusada", codigo: "LONGA_DEMAIS" });
    d.enviarPendentes.mockImplementation(async (_dona: string, opcoes?: { aoRecusar?: (parte: { meetingId: string; seq: number }, codigo?: string) => void }) => {
      opcoes?.aoRecusar?.({ meetingId: "r-antiga", seq: 3 }, "FORMATO");
      return { restantes: 0, semSessao: false };
    });
    const aoRecusarParte = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoRecusarParte }));
    await waitFor(() => expect(aoRecusarParte).toHaveBeenCalledWith("FORMATO"));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(aoRecusarParte).toHaveBeenCalledWith("LONGA_DEMAIS"));
    expect(d.apagarParte).toHaveBeenCalledWith("r-1", 0);
  });

  it("sem a cópia no aparelho, avisa uma vez por gravação e segue enviando da memória", async () => {
    d.guardarParte.mockRejectedValue(new Error("sem IndexedDB"));
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    d.iniciar.mockResolvedValueOnce({ id: "r-1" }).mockResolvedValueOnce({ id: "r-2" });
    const aoFicarSemCopia = vi.fn();
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn(), aoFicarSemCopia }));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, false)));
    act(() => result.current.receberParte(parte(1, true)));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    expect(d.enviarParte).toHaveBeenCalledTimes(2);
    expect(aoFicarSemCopia).toHaveBeenCalledTimes(1);
    // A gravação seguinte avisa de novo: o aviso é por gravação.
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-2"));
    expect(aoFicarSemCopia).toHaveBeenCalledTimes(2);
  });

  it("sem saber de quem é a conta, a cópia não é guardada: também avisa", async () => {
    d.getData.mockReturnValue(undefined);
    d.fetch.mockRejectedValue(new Error("rede"));
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoFicarSemCopia = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoFicarSemCopia }));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalled());
    expect(d.guardarParte).not.toHaveBeenCalled();
    expect(aoFicarSemCopia).toHaveBeenCalledTimes(1);
  });

  it("descartar: a parte que espera na fila não sobe, e a reunião e a cópia saem depois da parte que já subia", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, false)));
    act(() => result.current.receberParte(parte(1, false)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    let descarte: Promise<ResultadoDoDescarte> = Promise.resolve("nada");
    act(() => { descarte = result.current.descartar(); });
    // Guardado antes de tudo, com a conta que descartou, para a retomada repetir se a exclusão falhar.
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-1", dona: "dona-1" }]);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    // A exclusão espera a parte que já subia.
    expect(d.excluir).not.toHaveBeenCalled();
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { soltar({ tipo: "recebida" }); resultado = await descarte; });
    expect(resultado).toBe("descartada");
    // A parte 1 esperava a vez: não subiu nem ficou no aparelho.
    expect(d.enviarParte).toHaveBeenCalledTimes(1);
    expect(d.guardarParte).toHaveBeenCalledTimes(1);
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
    expect(d.apagarPartesDaReuniao).toHaveBeenCalledWith("r-1");
    // Nada vai para a transcrição: nenhum fim é declarado.
    expect(d.encerrar).not.toHaveBeenCalled();
    expect(aoEncerrar).not.toHaveBeenCalled();
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(localStorage.getItem(DESCARTES)).toBeNull();
  });

  it("descartar com a exclusão falhando: responde 'pendente', fica guardado e a retomada apaga depois", async () => {
    d.excluir.mockRejectedValueOnce(new Error("rede"));
    const primeira = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await retomadaDaMontagemFeita();
    await act(async () => { await primeira.result.current.iniciar(INICIO); });
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await primeira.result.current.descartar(); });
    expect(resultado).toBe("pendente");
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-1", dona: "dona-1" }]);
    primeira.unmount();
    // A tela aberta de novo (ou a próxima volta da retomada) apaga.
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(localStorage.getItem(DESCARTES)).toBeNull());
    expect(d.excluir).toHaveBeenCalledTimes(2);
    expect(d.excluir).toHaveBeenLastCalledWith({ meetingId: "r-1" });
  });

  it("a exclusão repetida que responde NOT_FOUND (a anterior chegou e só a resposta se perdeu) dá o descarte por feito", async () => {
    localStorage.setItem(DESCARTES, JSON.stringify([{ id: "r-velha", dona: "dona-1" }]));
    d.excluir.mockRejectedValue({ message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } });
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(localStorage.getItem(DESCARTES)).toBeNull());
    expect(d.apagarPartesDaReuniao).toHaveBeenCalledWith("r-velha");
  });

  it("a cópia de uma gravação descartada que ficou no aparelho volta recusada sem virar aviso; a de outra reunião avisa", async () => {
    localStorage.setItem(DESCARTES, JSON.stringify([{ id: "r-descartada", dona: "dona-1" }]));
    // A cópia não sai (outra aba bloqueia o IndexedDB): o descarte segue guardado,
    // marcado como já excluído no servidor.
    d.apagarPartesDaReuniao.mockRejectedValue(new Error("bloqueado por outra aba"));
    d.enviarPendentes.mockImplementation(async (_dona: string, opcoes?: { aoRecusar?: (parte: { meetingId: string; seq: number }, codigo?: string) => void }) => {
      opcoes?.aoRecusar?.({ meetingId: "r-descartada", seq: 0 }, "SEM_REUNIAO");
      opcoes?.aoRecusar?.({ meetingId: "r-outra", seq: 2 }, "SEM_REUNIAO");
      return { restantes: 0, semSessao: false };
    });
    const aoRecusarParte = vi.fn();
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoRecusarParte }));
    await waitFor(() => expect(aoRecusarParte).toHaveBeenCalled());
    expect(aoRecusarParte).toHaveBeenCalledTimes(1);
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-descartada" });
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-descartada", dona: "dona-1", soFaltaACopia: true }]);
  });
});

/**
 * A revisão da G13b. O descarte guardado tem dona (só a conta que descartou o
 * retoma, e o NOT_FOUND só vale para ela); descartar responde o que fez
 * ("descartada", "pendente" ou "nada"); a cópia que não sai não vira erro; e a
 * retomada avisa a tela quando conclui um descarte guardado.
 */
describe("useGravacaoEmPartes — o descarte com dona e o que ele responde (revisão da G13b)", () => {
  it("a retomada só repete os descartes da conta logada: o NOT_FOUND da reunião de outra conta não apaga o descarte dela", async () => {
    localStorage.setItem(DESCARTES, JSON.stringify([{ id: "r-minha", dona: "dona-1" }, { id: "r-da-outra", dona: "outra-conta" }]));
    // Para a conta logada, toda reunião que não é dela responde NOT_FOUND.
    d.excluir.mockRejectedValue({ message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } });
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-da-outra", dona: "outra-conta" }]));
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-minha" });
    expect(d.excluir).not.toHaveBeenCalledWith({ meetingId: "r-da-outra" });
    expect(d.apagarPartesDaReuniao).not.toHaveBeenCalledWith("r-da-outra");
  });

  it("descartar sem gravação em curso responde 'nada' e não exclui nada", async () => {
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await retomadaDaMontagemFeita();
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await result.current.descartar(); });
    expect(resultado).toBe("nada");
    expect(d.excluir).not.toHaveBeenCalled();
    expect(localStorage.getItem(DESCARTES)).toBeNull();
  });

  it("o Descartar depois de a última parte entrar na fila (o Encerrar no mesmo instante) responde 'nada': a gravação segue para a transcrição", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await result.current.descartar(); });
    expect(resultado).toBe("nada");
    await act(async () => { soltar({ tipo: "recebida" }); });
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    expect(d.encerrar).toHaveBeenCalledWith({ meetingId: "r-1", partes: 1 });
    expect(d.excluir).not.toHaveBeenCalled();
    expect(localStorage.getItem(DESCARTES)).toBeNull();
  });

  it("a exclusão dá certo e só a cópia no aparelho falha: 'descartada', e o descarte fica guardado até a cópia sair, sem excluir de novo no servidor", async () => {
    const primeira = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await retomadaDaMontagemFeita();
    await act(async () => { await primeira.result.current.iniciar(INICIO); });
    d.apagarPartesDaReuniao.mockRejectedValueOnce(new Error("bloqueado por outra aba"));
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await primeira.result.current.descartar(); });
    expect(resultado).toBe("descartada");
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-1", dona: "dona-1", soFaltaACopia: true }]);
    primeira.unmount();
    // A retomada seguinte tira a cópia, e o servidor não é chamado de novo.
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await waitFor(() => expect(localStorage.getItem(DESCARTES)).toBeNull());
    expect(d.apagarPartesDaReuniao).toHaveBeenCalledTimes(2);
    expect(d.excluir).toHaveBeenCalledTimes(1);
  });

  it("a parte que está subindo quando a gravação é descartada e que o servidor recusa não avisa, e sai do aparelho", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    const aoRecusarParte = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoRecusarParte }));
    await retomadaDaMontagemFeita();
    await act(async () => { await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, false)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    let descarte: Promise<ResultadoDoDescarte> = Promise.resolve("nada");
    act(() => { descarte = result.current.descartar(); });
    // O servidor já excluiu a reunião quando a parte chega: recusa de vez.
    await act(async () => { soltar({ tipo: "recusada", codigo: "SEM_REUNIAO" }); await descarte; });
    expect(d.apagarParte).toHaveBeenCalledWith("r-1", 0);
    expect(aoRecusarParte).not.toHaveBeenCalled();
  });

  it("a retomada (com o relógio falso) repete a exclusão que falhou duas vezes, guarda o descarte até a 3ª dar certo e só então avisa a tela", async () => {
    localStorage.setItem(DESCARTES, JSON.stringify([{ id: "r-velha", dona: "dona-1" }]));
    d.excluir.mockRejectedValueOnce(new Error("rede")).mockRejectedValueOnce(new Error("deploy")).mockResolvedValue({ success: true });
    const aoConcluirDescarte = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoConcluirDescarte }));
      // A primeira volta da retomada, na montagem.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(d.excluir).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-velha", dona: "dona-1" }]);
      // 30 s depois, a segunda.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(d.excluir).toHaveBeenCalledTimes(2);
      expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-velha", dona: "dona-1" }]);
      expect(aoConcluirDescarte).not.toHaveBeenCalled();
      // E a terceira, que dá certo.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(d.excluir).toHaveBeenCalledTimes(3);
      expect(localStorage.getItem(DESCARTES)).toBeNull();
      expect(aoConcluirDescarte).toHaveBeenCalledTimes(1);
      expect(aoConcluirDescarte).toHaveBeenCalledWith("r-velha");
    } finally {
      vi.useRealTimers();
    }
  });

  it("o descarte que dá certo na hora não é 'concluído pela retomada': a tela não recebe aoConcluirDescarte", async () => {
    const aoConcluirDescarte = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn(), aoConcluirDescarte }));
    await retomadaDaMontagemFeita();
    await act(async () => { await result.current.iniciar(INICIO); });
    await act(async () => { await result.current.descartar(); });
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
    expect(aoConcluirDescarte).not.toHaveBeenCalled();
  });
});

/**
 * A revisão da G13c. O fim e o descarte guardados sem a conta (a sessão que
 * some no meio da gravação: o Sair com ela no ar, o cache limpo) valiam para a
 * primeira conta que entrasse no aparelho, e o NOT_FOUND dela apagava o fim da
 * dona. Agora levam a conta que começou a gravação.
 */
describe("useGravacaoEmPartes — a dona desde o Iniciar (revisão da G13c)", () => {
  const FINS = "wrw:fins-de-gravacao-pendentes";

  it("a sessão que some no meio da gravação: o fim que falha fica guardado com a conta que a começou, e a cópia da parte não", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "sem-sessao" });
    d.encerrar.mockRejectedValue({ message: "Sessão encerrada.", data: { code: "UNAUTHORIZED" } });
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    await retomadaDaMontagemFeita();
    await act(async () => { await result.current.iniciar(INICIO); });
    // O Sair com a gravação no ar: o cache fica sem a conta, e o servidor não a reconhece mais.
    d.getData.mockReturnValue(null);
    d.fetch.mockResolvedValue(null);
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(aoFalhar).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(FINS)!)).toEqual({ "r-1": { partes: 1, dona: "dona-1" } });
    // Depois do Sair nenhuma voz fica no aparelho.
    expect(d.guardarParte).not.toHaveBeenCalled();
  });

  it("descartar sem a conta no cache nem do servidor: o descarte fica guardado com a conta que começou a gravação", async () => {
    d.excluir.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await retomadaDaMontagemFeita();
    await act(async () => { await result.current.iniciar(INICIO); });
    d.getData.mockReturnValue(undefined);
    d.fetch.mockRejectedValue(new Error("rede"));
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { resultado = await result.current.descartar(); });
    expect(resultado).toBe("pendente");
    // Na lista, a retomada de toda tela logada também a vê, e não sobe parte dela.
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: "r-1", dona: "dona-1" }]);
  });
});

describe("useGravacaoEmPartes — o MP3 importado em partes (H9a)", () => {
  it("a origem vai ao servidor: 'arquivo' na importação, 'gravacao' por padrão", async () => {
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    expect(d.iniciar).toHaveBeenLastCalledWith({ ...INICIO, consentGranted: true, origem: "arquivo" });
    await act(async () => { await result.current.iniciar(INICIO); });
    expect(d.iniciar).toHaveBeenLastCalledWith({ ...INICIO, consentGranted: true, origem: "gravacao" });
  });

  it("a parte audio/mpeg vai ao aparelho e ao servidor com o tipo dela", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    await act(async () => { await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    const blob = new Blob(["quadros"], { type: "audio/mpeg" });
    act(() => result.current.receberParte({ blob, mimeType: "audio/mpeg", duracaoMs: 599_976, seq: 0, ultima: true }));
    await waitFor(() => expect(aoEncerrar).toHaveBeenCalledWith("r-1"));
    expect(d.guardarParte.mock.calls[0][0]).toMatchObject({ meetingId: "r-1", seq: 0, mimeType: "audio/mpeg", duracaoMs: 599_976 });
    expect(d.enviarParte).toHaveBeenCalledWith("r-1", 0, blob, "audio/mpeg");
  });

  const parteDoArquivo = (seq: number) => ({ blob: new Blob(["quadros"], { type: "audio/mpeg" }), mimeType: "audio/mpeg" as const, duracaoMs: 599_976, seq });

  it("a parte do arquivo responde o que houve com ela: recebida sai do aparelho; passageira fica nele, sem contar como áudio por enviar; a trava com outra aba é 'ocupada'", async () => {
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await retomadaDaMontagemFeita();
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    d.enviarParte.mockResolvedValueOnce({ tipo: "recebida" });
    await act(async () => { expect(await result.current.subirParteDoArquivo(id, parteDoArquivo(0))).toEqual({ tipo: "recebida" }); });
    expect(d.guardarParte.mock.calls[0][0]).toMatchObject({ meetingId: "r-1", seq: 0, mimeType: "audio/mpeg", dona: "dona-1" });
    expect(d.apagarParte).toHaveBeenLastCalledWith("r-1", 0);
    d.apagarParte.mockClear();
    d.enviarParte.mockResolvedValueOnce({ tipo: "passageira", codigo: "MUITOS_PEDIDOS" });
    await act(async () => { expect(await result.current.subirParteDoArquivo(id, parteDoArquivo(1))).toEqual({ tipo: "passageira", codigo: "MUITOS_PEDIDOS" }); });
    // Fica no aparelho (a página que recarrega a sobe pela retomada), mas a importação ainda a está mandando.
    expect(d.apagarParte).not.toHaveBeenCalled();
    expect(motivoDaOcupacao()).not.toBe("audio-nao-enviado");
    d.enviarParte.mockResolvedValueOnce(null);
    await act(async () => { expect(await result.current.subirParteDoArquivo(id, parteDoArquivo(1))).toEqual({ tipo: "ocupada" }); });
  });

  it("a parte do arquivo cancelado que esperava a vez não sobe nem vai ao aparelho: 'descartada'", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    let primeira: Promise<unknown> = Promise.resolve();
    let segunda: Promise<unknown> = Promise.resolve();
    act(() => {
      primeira = result.current.subirParteDoArquivo(id, parteDoArquivo(0));
      segunda = result.current.subirParteDoArquivo(id, parteDoArquivo(1));
    });
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    let cancelamento: Promise<unknown> = Promise.resolve();
    act(() => { cancelamento = result.current.cancelar(id); });
    await act(async () => { soltar({ tipo: "recebida" }); });
    expect(await primeira).toEqual({ tipo: "recebida" });
    expect(await segunda).toEqual({ tipo: "descartada" });
    expect(await cancelamento).toBe("descartada");
    expect(d.enviarParte).toHaveBeenCalledTimes(1);
    expect(d.guardarParte).toHaveBeenCalledTimes(1);
  });

  it("o fim do arquivo: declara com o total e vai ao detalhe ('declarado')", async () => {
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    let fim: unknown;
    await act(async () => { fim = await result.current.encerrarArquivo(id, 4); });
    expect(fim).toBe("declarado");
    expect(d.encerrar).toHaveBeenCalledWith({ meetingId: "r-1", partes: 4 });
    expect(aoEncerrar).toHaveBeenCalledWith("r-1");
    // Encerrado, o Descartar não tem mais o que descartar.
    let descarte: ResultadoDoDescarte | undefined;
    await act(async () => { descarte = await result.current.descartar(); });
    expect(descarte).toBe("nada");
  });

  it("o fim do arquivo que falha por rede: 'pendente', guardado para a retomada, sem o aviso de envio que falhou", async () => {
    d.encerrar.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    await retomadaDaMontagemFeita();
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    let fim: unknown;
    await act(async () => { fim = await result.current.encerrarArquivo(id, 3); });
    expect(fim).toBe("pendente");
    expect(JSON.parse(localStorage.getItem("wrw:fins-de-gravacao-pendentes")!)).toEqual({ "r-1": { partes: 3, dona: "dona-1" } });
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(aoEncerrar).not.toHaveBeenCalled();
  });

  it("o fim do arquivo que o servidor recusa de vez (a reunião excluída em outro aparelho): 'recusado', com o aviso, e nada guardado", async () => {
    d.encerrar.mockRejectedValueOnce({ message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } });
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    let fim: unknown;
    await act(async () => { fim = await result.current.encerrarArquivo(id, 3); });
    expect(fim).toBe("recusado");
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("wrw:fins-de-gravacao-pendentes")).toBeNull();
  });

  it("cancelado enquanto o fim do arquivo estava no ar: a tela não vai ao detalhe ('descartada'), e a exclusão vem logo atrás", async () => {
    let confirmarOFim: (resposta: unknown) => void = () => {};
    d.encerrar.mockImplementationOnce(() => new Promise(resolver => { confirmarOFim = resolver; }));
    const aoEncerrar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar: vi.fn() }));
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    let fim: Promise<unknown> = Promise.resolve();
    act(() => { fim = result.current.encerrarArquivo(id, 3); });
    await waitFor(() => expect(d.encerrar).toHaveBeenCalledTimes(1));
    let cancelamento: Promise<unknown> = Promise.resolve();
    act(() => { cancelamento = result.current.cancelar(id); });
    // A exclusão espera o fim que já estava no ar.
    expect(d.excluir).not.toHaveBeenCalled();
    await act(async () => { confirmarOFim({ partes: 3 }); });
    expect(await fim).toBe("descartada");
    expect(await cancelamento).toBe("descartada");
    expect(aoEncerrar).not.toHaveBeenCalled();
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
  });

  it("a última parte da gravação, cancelada enquanto o fim estava no ar: também não vai ao detalhe", async () => {
    d.enviarParte.mockResolvedValue({ tipo: "recebida" });
    let confirmarOFim: (resposta: unknown) => void = () => {};
    d.encerrar.mockImplementationOnce(() => new Promise(resolver => { confirmarOFim = resolver; }));
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    let id = "";
    await act(async () => { id = await result.current.iniciar(INICIO); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(d.encerrar).toHaveBeenCalledTimes(1));
    let cancelamento: Promise<unknown> = Promise.resolve();
    act(() => { cancelamento = result.current.cancelar(id); });
    await act(async () => { confirmarOFim({ partes: 1 }); await cancelamento; });
    expect(aoEncerrar).not.toHaveBeenCalled();
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
  });

  it("cancelada enquanto a ÚLTIMA parte subia: o fim não é declarado, a tela não vai ao detalhe, e a reunião sai", async () => {
    let soltar: (resultado: unknown) => void = () => {};
    d.enviarParte.mockImplementationOnce(() => new Promise(resolver => { soltar = resolver; }));
    const aoEncerrar = vi.fn();
    const aoFalhar = vi.fn();
    const { result } = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar, aoFalhar }));
    let id = "";
    await act(async () => { id = await result.current.iniciar({ ...INICIO, origem: "arquivo" }); });
    act(() => result.current.receberParte(parte(0, true)));
    await waitFor(() => expect(d.enviarParte).toHaveBeenCalledTimes(1));
    let cancelamento: Promise<ResultadoDoDescarte> = Promise.resolve("nada");
    act(() => { cancelamento = result.current.cancelar(id); });
    let resultado: ResultadoDoDescarte | undefined;
    await act(async () => { soltar({ tipo: "recebida" }); resultado = await cancelamento; });
    expect(resultado).toBe("descartada");
    expect(d.encerrar).not.toHaveBeenCalled();
    expect(aoEncerrar).not.toHaveBeenCalled();
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
  });
});
