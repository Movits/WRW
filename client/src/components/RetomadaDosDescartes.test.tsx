import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAVE_DOS_DESCARTES, guardarDescarte, retomarDescartes } from "@/lib/descartes-pendentes";
import { liberarTodas, motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import { ID_DO_AVISO_DO_DESCARTE_PENDENTE, NOVA_TENTATIVA_DOS_DESCARTES_MS, RetomadaDosDescartes } from "./RetomadaDosDescartes";

/**
 * A retomada dos descartes de gravação em toda tela logada (revisão da G13b).
 * Antes, a exclusão que falhava só era repetida com a tela de Reuniões aberta e
 * não ocupava a sessão: a dona descartava, a rede caía, ela saía, e em 6 h a
 * varredura de abandono transcrevia o que fora descartado. Agora a retomada
 * roda em toda tela logada (App.tsx, TelaAutenticada), ao montar e a cada 30 s
 * enquanto houver descarte da conta, e a sessão fica ocupada enquanto o
 * servidor não excluiu.
 */

const d = vi.hoisted(() => ({
  getData: vi.fn(),
  excluir: vi.fn(),
  apagarPartesDaReuniao: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  // O MESMO objeto a cada render, como o useUtils do tRPC.
  const utils = { auth: { me: { getData: d.getData } }, client: { meetings: { delete: { mutate: d.excluir } } } };
  return { trpc: { useUtils: () => utils } };
});
vi.mock("@/lib/partes-no-aparelho", () => ({
  apagarPartesDaReuniao: (...a: unknown[]) => d.apagarPartesDaReuniao(...a),
  apagarTodasAsPartes: async () => undefined,
}));
vi.mock("sonner", () => ({ toast: { dismiss: (...a: unknown[]) => d.dismiss(...a) } }));

const NAO_ENCONTRADA = { message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } };
const guardados = () => JSON.parse(localStorage.getItem(CHAVE_DOS_DESCARTES) ?? "[]");

/** O navegador avisa antes de fechar a aba: devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(evento);
  return evento.defaultPrevented;
}

/** As promessas da retomada andam, e o relógio falso, se houver, avança `ms`. */
async function andar(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  localStorage.clear();
  d.getData.mockReturnValue({ openId: "dona-1" });
  d.excluir.mockResolvedValue({ success: true });
  d.apagarPartesDaReuniao.mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("RetomadaDosDescartes — os descartes que não terminaram, em toda tela logada", () => {
  it("ao montar, repete os descartes da conta logada; os de outra conta ficam guardados e não ocupam a sessão", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }, { id: "r-2", dona: "outra-conta" }]));
    render(<RetomadaDosDescartes />);
    await andar();
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-1" });
    expect(d.excluir).not.toHaveBeenCalledWith({ meetingId: "r-2" });
    expect(d.apagarPartesDaReuniao).toHaveBeenCalledWith("r-1");
    expect(guardados()).toEqual([{ id: "r-2", dona: "outra-conta" }]);
    expect(sessaoOcupada()).toBe(false);
    // Nada desta conta sobrou: a retomada não volta.
    await andar(5 * NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).toHaveBeenCalledTimes(1);
  });

  it("enquanto o servidor não exclui, a sessão fica ocupada e a retomada tenta a cada 30 s; quando dá certo, libera, fecha o aviso e para", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    d.excluir.mockRejectedValueOnce(new Error("rede")).mockRejectedValueOnce(new Error("deploy")).mockResolvedValue({ success: true });
    render(<RetomadaDosDescartes />);
    await andar();
    expect(d.excluir).toHaveBeenCalledTimes(1);
    expect(motivoDaOcupacao()).toBe("descarte-pendente");
    // Fechar a aba pergunta: com ela fechada, nada tenta de novo.
    expect(fecharAba()).toBe(true);
    await andar(NOVA_TENTATIVA_DOS_DESCARTES_MS - 1);
    expect(d.excluir).toHaveBeenCalledTimes(1);
    await andar(1);
    expect(d.excluir).toHaveBeenCalledTimes(2);
    expect(guardados()).toEqual([{ id: "r-1", dona: "dona-1" }]);
    expect(d.dismiss).not.toHaveBeenCalled();
    await andar(NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).toHaveBeenCalledTimes(3);
    expect(guardados()).toEqual([]);
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    // O aviso de que o descarte não tinha terminado sai, com a dona em qualquer tela.
    expect(d.dismiss).toHaveBeenCalledWith(ID_DO_AVISO_DO_DESCARTE_PENDENTE);
    await andar(5 * NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).toHaveBeenCalledTimes(3);
  });

  it("o descarte guardado agora (o Descartar que falhou em Reuniões) ocupa a sessão na hora e entra nas tentativas", async () => {
    render(<RetomadaDosDescartes />);
    await andar();
    expect(sessaoOcupada()).toBe(false);
    act(() => guardarDescarte("r-9", "dona-1"));
    expect(motivoDaOcupacao()).toBe("descarte-pendente");
    await andar(NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-9" });
    expect(guardados()).toEqual([]);
    expect(sessaoOcupada()).toBe(false);
  });

  it("o descarte guardado em outra aba (o evento storage) também ocupa a sessão e entra nas tentativas", async () => {
    render(<RetomadaDosDescartes />);
    await andar();
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-7", dona: "dona-1" }]));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: CHAVE_DOS_DESCARTES })); });
    expect(motivoDaOcupacao()).toBe("descarte-pendente");
    await andar(NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).toHaveBeenCalledWith({ meetingId: "r-7" });
    expect(sessaoOcupada()).toBe(false);
  });

  it("com só a cópia no aparelho faltando, o servidor já excluiu: não ocupa a sessão nem exclui de novo, e a cópia sai", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1", soFaltaACopia: true }]));
    d.apagarPartesDaReuniao.mockRejectedValueOnce(new Error("bloqueado por outra aba")).mockResolvedValue(undefined);
    render(<RetomadaDosDescartes />);
    await andar();
    expect(sessaoOcupada()).toBe(false);
    expect(guardados()).toEqual([{ id: "r-1", dona: "dona-1", soFaltaACopia: true }]);
    await andar(NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(guardados()).toEqual([]);
    expect(d.excluir).not.toHaveBeenCalled();
  });

  it("o Sair (liberarTodas) solta a ocupação, mas o descarte fica guardado para o próximo login da mesma conta", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    d.excluir.mockRejectedValue(new Error("rede"));
    render(<RetomadaDosDescartes />);
    await andar();
    expect(motivoDaOcupacao()).toBe("descarte-pendente");
    act(() => liberarTodas());
    expect(sessaoOcupada()).toBe(false);
    expect(guardados()).toEqual([{ id: "r-1", dona: "dona-1" }]);
  });

  it("junto com a retomada da tela de Reuniões: a exclusão repetida dá NOT_FOUND, que é feito, e a que falha depois não traz o descarte de volta", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    let perderAResposta: () => void = () => {};
    // A exclusão desta retomada chega ao servidor, mas a resposta se perde; a da
    // tela de Reuniões, que corre junto, encontra a reunião já excluída.
    d.excluir.mockImplementationOnce(() => new Promise((_resolver, rejeitar) => { perderAResposta = () => rejeitar(new Error("rede")); })).mockRejectedValue(NAO_ENCONTRADA);
    render(<RetomadaDosDescartes />);
    await andar();
    expect(d.excluir).toHaveBeenCalledTimes(1);
    await act(async () => { await retomarDescartes("dona-1", id => d.excluir({ meetingId: id })); });
    expect(d.excluir).toHaveBeenCalledTimes(2);
    expect(guardados()).toEqual([]);
    await act(async () => { perderAResposta(); });
    await andar();
    expect(guardados()).toEqual([]);
    expect(sessaoOcupada()).toBe(false);
  });

  it("sem a conta no cache, não faz nada", async () => {
    d.getData.mockReturnValue(undefined);
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    render(<RetomadaDosDescartes />);
    await andar(2 * NOVA_TENTATIVA_DOS_DESCARTES_MS);
    expect(d.excluir).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
  });
});
