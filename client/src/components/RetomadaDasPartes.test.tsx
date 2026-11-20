import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useGravacaoEmPartes } from "@/hooks/useGravacaoEmPartes";
import { CHAVE_DOS_DESCARTES, guardarDescarte } from "@/lib/descartes-pendentes";
import { rotaDaParte } from "@/lib/envio-das-partes";
import { apagarParte, guardarParte, parteNoAparelho, partesGuardadas, type ParteNoAparelho } from "@/lib/partes-no-aparelho";
import { CHAVE_DOS_FINS, guardarFim } from "@/lib/retomada-das-partes";
import { liberarTodas, motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import { indexedDBEmMemoria } from "@/test/indexeddb-em-memoria";
import { ID_DO_AVISO_DA_PARTE_RECUSADA, NOVA_TENTATIVA_DAS_PARTES_MS, RetomadaDasPartes } from "./RetomadaDasPartes";

/**
 * A retomada das partes e dos fins em toda tela logada (G13c). Antes ela só
 * rodava com a tela de Reuniões montada: a dona saía da tela gravando, o envio
 * da última parte falhava por rede, e nada tentava de novo até ela voltar a
 * Reuniões; a ocupação do áudio por enviar saía no desmonte, e fechar a aba
 * não perguntava. Aqui o aparelho é o módulo de verdade sobre um IndexedDB em
 * memória, o envio é o de verdade sobre um fetch de mentira, e o servidor tRPC,
 * dublês.
 */

const d = vi.hoisted(() => ({
  getData: vi.fn(),
  fetchConta: vi.fn(),
  iniciar: vi.fn(),
  encerrar: vi.fn(),
  excluir: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  // O MESMO objeto a cada render, como o useUtils do tRPC.
  const utils = {
    auth: { me: { getData: d.getData, fetch: d.fetchConta } },
    client: { meetings: { iniciarGravacao: { mutate: d.iniciar }, encerrarGravacao: { mutate: d.encerrar }, delete: { mutate: d.excluir } } },
  };
  return { trpc: { useUtils: () => utils } };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

const INICIO = { title: "R", language: "pt-BR", consentNoticeVersion: "2026-11-14" } as const;
const noAparelho = (meetingId: string, seq: number, dona = "dona-1"): ParteNoAparelho => ({
  meetingId, seq, dona, blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4", duracaoMs: 600_000, guardadaEm: 1,
});
const parteDoGravador = (seq: number, ultima: boolean) => ({ blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4" as const, duracaoMs: 600_000, seq, ultima });

// A rede: no ar ou fora. Fora, o fetch falha como no navegador (TypeError).
const recebida = () => new Response(JSON.stringify({ codigo: "RECEBIDA" }), { status: 201, headers: { "Content-Type": "application/json" } });
const rede = { noAr: true, resposta: recebida };
const buscar = vi.fn();
const enviadas = () => buscar.mock.calls.map(([url]) => url);
const fins = () => JSON.parse(localStorage.getItem(CHAVE_DOS_FINS) ?? "null");

/** O navegador avisa antes de fechar a aba: devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(evento);
  return evento.defaultPrevented;
}

/**
 * O relógio falso anda `ms`, e as promessas e o IndexedDB em memória terminam.
 * O IndexedDB responde num setTimeout de 0, e o relógio falso empurra para 1 ms
 * depois o que é marcado no meio de um avanço: a cadeia anda um passo por
 * milissegundo, e os 100 ms do fim a esgotam.
 */
async function andar(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(100);
  });
}

/** Uma operação direta no aparelho, fora da retomada: o relógio falso anda até ela terminar. */
async function noAparelhoJa<T>(operacao: Promise<T>): Promise<T> {
  await andar();
  return operacao;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("indexedDB", indexedDBEmMemoria());
  vi.stubGlobal("fetch", buscar);
  rede.noAr = true;
  rede.resposta = recebida;
  // O mockReset do projeto client zera a implementação antes de cada teste.
  buscar.mockImplementation(async (_url: string, _init?: RequestInit) => {
    if (!rede.noAr) throw new TypeError("Failed to fetch");
    return rede.resposta();
  });
  d.getData.mockReturnValue({ openId: "dona-1" });
  d.iniciar.mockResolvedValue({ id: "r-1" });
  d.encerrar.mockResolvedValue({ partes: 2 });
  d.excluir.mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("RetomadaDasPartes — sair da tela gravando com a última parte falhando (G13c)", () => {
  it("a retomada de toda tela logada envia a parte depois, declara o fim depois dela, e a sessão pergunta até lá", async () => {
    render(<RetomadaDasPartes />);
    await andar();
    const aoFalhar = vi.fn();
    const reunioes = renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar }));
    await andar();
    await act(async () => { await reunioes.result.current.iniciar(INICIO); });
    act(() => reunioes.result.current.receberParte(parteDoGravador(0, false)));
    await andar();
    expect(enviadas()).toEqual([rotaDaParte("r-1", 0)]);
    // A dona sai de Reuniões gravando: a tela desmonta, e o gravador entrega a
    // última parte depois do desmonte (G13b). A rede caiu: a parte e o fim falham.
    const { receberParte } = reunioes.result.current;
    reunioes.unmount();
    rede.noAr = false;
    d.encerrar.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    act(() => receberParte(parteDoGravador(1, true)));
    await andar();
    expect(aoFalhar).toHaveBeenCalledTimes(1);
    expect(enviadas()).toEqual([rotaDaParte("r-1", 0), rotaDaParte("r-1", 1)]);
    expect(await noAparelhoJa(parteNoAparelho("r-1", 1))).toBe(true);
    expect(fins()).toEqual({ "r-1": { partes: 2, dona: "dona-1" } });
    // Com a tela de Reuniões fechada, a sessão segue ocupada: o Sair e o fechar da aba perguntam.
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    expect(fecharAba()).toBe(true);

    // A rede volta. Em 30 s, a retomada envia a parte e só então declara o fim.
    rede.noAr = true;
    await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(enviadas()).toEqual([rotaDaParte("r-1", 0), rotaDaParte("r-1", 1), rotaDaParte("r-1", 1)]);
    expect(d.encerrar).toHaveBeenLastCalledWith({ meetingId: "r-1", partes: 2 });
    expect(buscar.mock.invocationCallOrder[2]).toBeLessThan(d.encerrar.mock.invocationCallOrder.at(-1)!);
    expect(await noAparelhoJa(parteNoAparelho("r-1", 1))).toBe(false);
    expect(fins()).toBeNull();
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    // Nada mais por enviar: a retomada não volta.
    const chamadas = buscar.mock.calls.length;
    await andar(5 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).toHaveBeenCalledTimes(chamadas);
    expect(d.encerrar).toHaveBeenCalledTimes(2);
  });
});

describe("RetomadaDasPartes — a sessão ocupada enquanto houver parte da conta no aparelho (G13c)", () => {
  it("ocupa ao montar com parte por enviar; o Sair apaga as partes do aparelho e solta a sessão, e nada sobe depois", async () => {
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    rede.noAr = false;
    render(<RetomadaDasPartes />);
    await andar();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    expect(fecharAba()).toBe(true);
    // Fora do ar, tenta de novo a cada 30 s, e a sessão segue ocupada.
    await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).toHaveBeenCalledTimes(2);
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    // O Sair da conta (liberarTodas): a voz sai do aparelho, como antes.
    act(() => liberarTodas());
    await andar();
    expect(await noAparelhoJa(partesGuardadas("dona-1"))).toEqual([]);
    expect(sessaoOcupada()).toBe(false);
    rede.noAr = true;
    await andar(2 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("a parte que a tela de Reuniões deixa no aparelho ocupa a sessão na hora, sem esperar a próxima volta", async () => {
    render(<RetomadaDasPartes />);
    await andar();
    expect(sessaoOcupada()).toBe(false);
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    await andar();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
  });
});

describe("RetomadaDasPartes — o que não sobe (G13c)", () => {
  it("as partes e os fins de outra conta não sobem, não são declarados nem ocupam a sessão", async () => {
    await noAparelhoJa(guardarParte(noAparelho("r-9", 0, "outra-conta")));
    guardarFim("r-9", 1, "outra-conta");
    render(<RetomadaDasPartes />);
    await andar(2 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).not.toHaveBeenCalled();
    expect(d.encerrar).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
    expect(await noAparelhoJa(partesGuardadas("outra-conta"))).toHaveLength(1);
    expect(fins()).toEqual({ "r-9": { partes: 1, dona: "outra-conta" } });
  });

  it("a gravação descartada cuja cópia ficou no aparelho não sobe nem ocupa a sessão", async () => {
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-2", dona: "dona-1", soFaltaACopia: true }]));
    await noAparelhoJa(guardarParte(noAparelho("r-2", 0)));
    render(<RetomadaDasPartes />);
    await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
  });

  it("sem a conta no cache, não faz nada", async () => {
    d.getData.mockReturnValue(undefined);
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    guardarFim("r-1", 1, "dona-1");
    render(<RetomadaDasPartes />);
    await andar(2 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(buscar).not.toHaveBeenCalled();
    expect(d.encerrar).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
  });
});

describe("RetomadaDasPartes — junto com a retomada de Reuniões e com outra aba (G13c)", () => {
  it("o fim guardado é declarado uma vez só, com as duas retomadas montadas ao mesmo tempo", async () => {
    guardarFim("r-1", 2, "dona-1");
    let responder: (valor: unknown) => void = () => {};
    d.encerrar.mockImplementationOnce(() => new Promise(resolver => { responder = resolver; }));
    render(<RetomadaDasPartes />);
    renderHook(() => useGravacaoEmPartes({ ativo: true, aoEncerrar: vi.fn(), aoFalhar: vi.fn() }));
    await andar();
    await andar();
    expect(d.encerrar).toHaveBeenCalledTimes(1);
    await act(async () => { responder({ partes: 2 }); });
    await andar(2 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(d.encerrar).toHaveBeenCalledTimes(1);
    expect(fins()).toBeNull();
  });

  it("com a trava da reunião na outra aba, esta não envia; a sessão segue ocupada até a outra aba terminar", async () => {
    const presas = new Set<string>(["wrw-envio-r-1"]);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (nome: string, _opcoes: unknown, trabalho: (trava: unknown) => Promise<unknown>) => {
          if (presas.has(nome)) return trabalho(null);
          presas.add(nome);
          try { return await trabalho({ name: nome }); } finally { presas.delete(nome); }
        },
      },
    });
    try {
      await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
      render(<RetomadaDasPartes />);
      await andar();
      expect(buscar).not.toHaveBeenCalled();
      expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
      // A outra aba enviou a parte, a apagou do aparelho e soltou a trava.
      await noAparelhoJa(apagarParte("r-1", 0));
      presas.delete("wrw-envio-r-1");
      await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
      expect(buscar).not.toHaveBeenCalled();
      expect(sessaoOcupada()).toBe(false);
    } finally {
      delete (navigator as Navigator & { locks?: unknown }).locks;
    }
  });

  it("a parte recusada de vez avisa com o código, em qualquer tela, e sai do aparelho", async () => {
    rede.resposta = () => new Response(JSON.stringify({ codigo: "FORA_DO_ESTADO" }), { status: 409, headers: { "Content-Type": "application/json" } });
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    render(<RetomadaDasPartes />);
    await andar();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(i18n.t("meetings.partRejectedMeetingGone"), { id: ID_DO_AVISO_DA_PARTE_RECUSADA, duration: Infinity, closeButton: true });
    expect(await noAparelhoJa(parteNoAparelho("r-1", 0))).toBe(false);
    expect(sessaoOcupada()).toBe(false);
  });
});

/**
 * A revisão da G13c: a conta do áudio por enviar relia todas as partes (com o
 * áudio) a cada parte enviada; a conta fora do cache ou o aparelho ilegível na
 * montagem paravam a retomada sem aviso; e faltavam testes do evento storage,
 * do descarte novo e da conferência sob a trava entre abas.
 */
describe("RetomadaDasPartes — revisão da G13c", () => {
  it("uma volta com 6 partes: a contagem lê as chaves (e uma parte por reunião) e espera a volta, em vez de reler o aparelho a cada parte enviada", async () => {
    let lidasComOAudio = 0;
    let leiturasDeChaves = 0;
    vi.stubGlobal("indexedDB", indexedDBEmMemoria({ aoLerComOAudio: partes => { lidasComOAudio += partes; }, aoLerAsChaves: () => { leiturasDeChaves++; } }));
    for (let seq = 0; seq < 6; seq++) await noAparelhoJa(guardarParte(noAparelho("r-1", seq)));
    render(<RetomadaDasPartes />);
    await andar(1_000);
    expect(enviadas()).toHaveLength(6);
    expect(sessaoOcupada()).toBe(false);
    // A volta leu as 6 partes uma vez, para enviá-las; cada contagem, as chaves e uma parte.
    expect(lidasComOAudio).toBeLessThanOrEqual(7);
    expect(leiturasDeChaves).toBeLessThanOrEqual(3);
  });

  it("a conta que chega ao cache depois da montagem: a tentativa seguinte retoma e ocupa a sessão, sem esperar outro evento", async () => {
    d.getData.mockReturnValue(undefined);
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    rede.noAr = false;
    render(<RetomadaDasPartes />);
    await andar();
    expect(buscar).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
    d.getData.mockReturnValue({ openId: "dona-1" });
    await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(enviadas()).toEqual([rotaDaParte("r-1", 0)]);
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
  });

  it("o aparelho ilegível na montagem (outra aba bloqueando o IndexedDB): tenta de novo em 30 s, e então envia e ocupa a sessão", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const aparelho = indexedDBEmMemoria();
      let bloqueado = false;
      vi.stubGlobal("indexedDB", {
        open: () => {
          if (!bloqueado) return aparelho.open();
          const pedido: { onblocked?: () => void } = {};
          setTimeout(() => pedido.onblocked?.(), 0);
          return pedido;
        },
      });
      await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
      bloqueado = true;
      rede.noAr = false;
      render(<RetomadaDasPartes />);
      await andar();
      expect(buscar).not.toHaveBeenCalled();
      expect(sessaoOcupada()).toBe(false);
      bloqueado = false;
      await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
      expect(enviadas()).toEqual([rotaDaParte("r-1", 0)]);
      expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    } finally {
      aviso.mockRestore();
    }
  });

  it("um descarte novo nesta aba solta a sessão na hora, sem esperar a próxima tentativa", async () => {
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    rede.noAr = false;
    render(<RetomadaDasPartes />);
    await andar();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    act(() => guardarDescarte("r-1", "dona-1"));
    await andar();
    expect(sessaoOcupada()).toBe(false);
  });

  it("um descarte gravado por outra aba (o evento storage) solta a sessão na hora", async () => {
    await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
    rede.noAr = false;
    render(<RetomadaDasPartes />);
    await andar();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    // A outra aba grava a lista; nesta, o navegador só dispara o evento storage.
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: CHAVE_DOS_DESCARTES })); });
    await andar();
    expect(sessaoOcupada()).toBe(false);
  });

  it.each([
    ["a chave dos fins", CHAVE_DOS_FINS],
    ["key null (a outra aba limpou o armazenamento)", null],
  ])("um fim guardado por outra aba marca a retomada (evento storage com %s)", async (_nome, chave) => {
    render(<RetomadaDasPartes />);
    await andar(2 * NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(d.encerrar).not.toHaveBeenCalled();
    localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify({ "r-5": { partes: 1, dona: "dona-1" } }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: chave })); });
    await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
    expect(d.encerrar).toHaveBeenCalledWith({ meetingId: "r-5", partes: 1 });
    expect(fins()).toBeNull();
  });

  it("a outra aba envia e apaga a parte enquanto segura a trava: esta, ao pegar a trava, confere de novo e não a envia", async () => {
    // A outra aba segurava a trava da reunião quando esta leu a lista: ela
    // envia a parte, a apaga do aparelho e solta a trava, e só então esta a pega.
    let outraAbaSegurava = true;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (nome: string, _opcoes: unknown, trabalho: (trava: unknown) => Promise<unknown>) => {
          if (outraAbaSegurava && nome === "wrw-envio-r-1") {
            outraAbaSegurava = false;
            await apagarParte("r-1", 0);
          }
          return trabalho({ name: nome });
        },
      },
    });
    try {
      await noAparelhoJa(guardarParte(noAparelho("r-1", 0)));
      render(<RetomadaDasPartes />);
      await andar(NOVA_TENTATIVA_DAS_PARTES_MS);
      expect(outraAbaSegurava).toBe(false);
      expect(buscar).not.toHaveBeenCalled();
      expect(await noAparelhoJa(parteNoAparelho("r-1", 0))).toBe(false);
      expect(sessaoOcupada()).toBe(false);
    } finally {
      delete (navigator as Navigator & { locks?: unknown }).locks;
    }
  });
});
