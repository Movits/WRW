import { afterEach, describe, expect, it, vi } from "vitest";
import { cortarMp3, ehCorteCancelado, type PedidoDeCorte, type RespostaDoCorte } from "./corte-do-mp3";
import { cortarMp3NoWorker } from "./corte-do-mp3-no-worker";
import { id3v2, juntar, leitorDe, MPEG1_128K, quadroDeEtiqueta, quadros } from "@/test/mp3-sintetico";

/**
 * O corte no Worker (H9a): o Worker é um módulo do próprio site, nunca um
 * blob: (a CSP de produção não deixa); sem ele, o corte roda na página. O
 * jsdom não tem Worker: os casos com Worker usam um dublê que responde como o
 * de verdade (atenderPedidoDeCorte, em workers/corte-do-mp3.worker.ts).
 */

const AUDIO = juntar(id3v2(300), quadroDeEtiqueta(MPEG1_128K, "Xing"), quadros(MPEG1_128K, 60));
const arquivo = () => new File([AUDIO], "reuniao.mp3", { type: "audio/mpeg" });

type Roteiro = (worker: WorkerFalso, pedido: PedidoDeCorte) => void;

class WorkerFalso {
  static criados: WorkerFalso[] = [];
  static roteiro: Roteiro = () => {};
  onmessage: ((evento: MessageEvent<RespostaDoCorte>) => void) | null = null;
  onerror: ((evento: { preventDefault: () => void }) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((pedido: PedidoDeCorte) => WorkerFalso.roteiro(this, pedido));
  constructor(readonly url: URL, readonly opcoes: WorkerOptions) {
    WorkerFalso.criados.push(this);
  }
  responder(resposta: RespostaDoCorte) {
    this.onmessage?.({ data: resposta } as MessageEvent<RespostaDoCorte>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  WorkerFalso.criados = [];
  WorkerFalso.roteiro = () => {};
});

describe("cortarMp3NoWorker", () => {
  it("sem Worker (o jsdom, um navegador antigo), corta na página, com o mesmo resultado", async () => {
    expect(typeof Worker).toBe("undefined");
    const aoLer = vi.fn();
    const corte = await cortarMp3NoWorker(arquivo(), { aoLer });
    expect(corte).toEqual(await cortarMp3(leitorDe(AUDIO), AUDIO.length));
    expect(corte.ok).toBe(true);
    expect(aoLer).toHaveBeenCalledWith(AUDIO.length, AUDIO.length);
  });

  it("com Worker: um módulo do próprio site (sem blob:), que recebe o File, avisa o andamento e devolve o corte", async () => {
    vi.stubGlobal("Worker", WorkerFalso);
    const corteDoWorker = await cortarMp3(leitorDe(AUDIO), AUDIO.length);
    WorkerFalso.roteiro = (worker, pedido) => {
      expect(pedido.arquivo).toBeInstanceOf(File);
      worker.responder({ tipo: "lendo", lidos: 10, total: 20 });
      worker.responder({ tipo: "pronto", corte: corteDoWorker });
    };
    const aoLer = vi.fn();
    expect(await cortarMp3NoWorker(arquivo(), { aoLer })).toBe(corteDoWorker);
    const [worker] = WorkerFalso.criados;
    expect(worker.url.protocol).not.toBe("blob:");
    expect(worker.url.pathname).toMatch(/\/workers\/corte-do-mp3\.worker\.ts$/);
    expect(worker.opcoes).toEqual({ type: "module" });
    expect(aoLer).toHaveBeenCalledWith(10, 20);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("o Worker que não carrega (erro antes de responder) cai no corte na página", async () => {
    vi.stubGlobal("Worker", WorkerFalso);
    WorkerFalso.roteiro = worker => worker.onerror?.({ preventDefault: () => {} });
    const corte = await cortarMp3NoWorker(arquivo());
    expect(corte).toEqual(await cortarMp3(leitorDe(AUDIO), AUDIO.length));
    expect(WorkerFalso.criados[0].terminate).toHaveBeenCalled();
  });

  it("o erro do Worker depois de ele responder, ou a resposta de erro, rejeitam: é falha de leitura", async () => {
    vi.stubGlobal("Worker", WorkerFalso);
    WorkerFalso.roteiro = worker => {
      worker.responder({ tipo: "lendo", lidos: 1, total: 2 });
      worker.onerror?.({ preventDefault: () => {} });
    };
    await expect(cortarMp3NoWorker(arquivo())).rejects.toThrow();
    WorkerFalso.roteiro = worker => worker.responder({ tipo: "erro" });
    await expect(cortarMp3NoWorker(arquivo())).rejects.toThrow();
  });

  it("cancelar encerra o Worker e rejeita com AbortError", async () => {
    vi.stubGlobal("Worker", WorkerFalso);
    WorkerFalso.roteiro = worker => worker.responder({ tipo: "lendo", lidos: 1, total: 2 });
    const controle = new AbortController();
    const corte = cortarMp3NoWorker(arquivo(), { sinal: controle.signal });
    controle.abort();
    expect(ehCorteCancelado(await corte.catch(e => e))).toBe(true);
    expect(WorkerFalso.criados[0].terminate).toHaveBeenCalled();
    // Já cancelado antes de começar: nem cria o Worker.
    expect(ehCorteCancelado(await cortarMp3NoWorker(arquivo(), { sinal: controle.signal }).catch(e => e))).toBe(true);
    expect(WorkerFalso.criados).toHaveLength(1);
  });
});
