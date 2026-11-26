import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O leitor de PDF da aba das páginas (H12b), sem o pdf.js de verdade (o jsdom
 * não tem canvas, e a biblioteca roda no navegador): o módulo dele e o Worker
 * são dublês. O que se prova:
 *
 * - a abertura usa o worker da mesma origem, sem WebAssembly (a CSP não tem
 *   'wasm-unsafe-eval'), com os arquivos de /pdfjs/<versão>/ e uma cópia dos
 *   bytes, que o pdf.js transfere ao worker;
 * - o worker que não carrega (o arquivo da versão anterior, numa aba aberta
 *   antes do deploy) faz a abertura falhar, em vez de deixar a aba "abrindo"
 *   para sempre, e o próximo documento tenta um worker novo;
 * - a página é desenhada na largura da aba, na densidade da tela (até 3x), e o
 *   desenho anterior é cancelado ao trocar de página.
 *
 * Que o pdf.js de verdade desenha o PDF das fotos e o PDF com fonte padrão e
 * chinês sob a CSP de produção foi conferido no navegador (ver a PR).
 */
const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerPort: null as unknown },
  version: "9.9.9",
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjs);

class WorkerFalso extends EventTarget {
  static criados: WorkerFalso[] = [];
  terminate = vi.fn();
  constructor(readonly url: URL, readonly opcoes?: WorkerOptions) {
    super();
    WorkerFalso.criados.push(this);
  }
  /** O arquivo do worker não carregou (404, a página do app no lugar do script). */
  falhar() { this.dispatchEvent(new Event("error")); }
  /** O worker do pdf.js carregou e mandou a primeira mensagem. */
  carregar() { this.dispatchEvent(new MessageEvent("message", { data: { action: "ready" } })); }
}

type Tarefa = { promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> };
const tarefa = (promise: Promise<unknown>): Tarefa => ({ promise, destroy: vi.fn(async () => {}) });
const BYTES = new TextEncoder().encode("%PDF-1.7 de teste").buffer;

async function leitor() {
  vi.resetModules();
  return import("./leitor-de-pdf");
}

beforeEach(() => {
  WorkerFalso.criados = [];
  vi.stubGlobal("Worker", WorkerFalso);
  pdfjs.GlobalWorkerOptions.workerPort = null;
  pdfjs.getDocument.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("abrirPdf", () => {
  it("abre com o worker em módulo da mesma origem, sem WebAssembly, com os arquivos de /pdfjs/<versão>/ e uma cópia dos bytes", async () => {
    const { abrirPdf } = await leitor();
    pdfjs.getDocument.mockReturnValue(tarefa(Promise.resolve({ numPages: 3, getPage: vi.fn() })));
    const aberto = await abrirPdf(BYTES);
    expect(aberto.paginas).toBe(3);
    const [worker] = WorkerFalso.criados;
    // Da mesma origem da página (a CSP não aceita blob:); o Vite ainda acrescenta a busca dele.
    expect(new URL(String(worker.url)).origin).toBe(location.origin);
    expect(new URL(String(worker.url)).pathname).toMatch(/\/workers\/leitor-de-pdf\.worker\.ts$/);
    expect(worker.opcoes).toEqual({ type: "module" });
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBe(worker);
    const [parametros] = pdfjs.getDocument.mock.calls[0];
    expect(parametros).toMatchObject({
      useWasm: false, wasmUrl: "/pdfjs/9.9.9/", cMapUrl: "/pdfjs/9.9.9/cmaps/", standardFontDataUrl: "/pdfjs/9.9.9/standard_fonts/",
      cMapPacked: true, enableXfa: false,
    });
    expect(parametros.data).toBeInstanceOf(Uint8Array);
    expect(parametros.data.buffer).not.toBe(BYTES);
    expect(new TextDecoder().decode(parametros.data)).toBe("%PDF-1.7 de teste");
    // O segundo documento usa o mesmo worker.
    await abrirPdf(BYTES);
    expect(WorkerFalso.criados).toHaveLength(1);
  });

  it("o worker que não carrega (o arquivo de antes do deploy): a abertura falha, em vez de esperar para sempre, e a próxima tenta um worker novo", async () => {
    const { abrirPdf } = await leitor();
    const presa = tarefa(new Promise(() => {}));
    pdfjs.getDocument.mockReturnValueOnce(presa);
    const abertura = abrirPdf(BYTES);
    await vi.waitFor(() => expect(WorkerFalso.criados).toHaveLength(1));
    WorkerFalso.criados[0].falhar();
    await expect(abertura).rejects.toThrow("O worker do leitor de PDF não carregou.");
    expect(presa.destroy).toHaveBeenCalled();
    expect(WorkerFalso.criados[0].terminate).toHaveBeenCalled();
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBeNull();

    pdfjs.getDocument.mockReturnValueOnce(tarefa(Promise.resolve({ numPages: 1, getPage: vi.fn() })));
    await expect(abrirPdf(BYTES)).resolves.toMatchObject({ paginas: 1 });
    expect(WorkerFalso.criados).toHaveLength(2);
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBe(WorkerFalso.criados[1]);
  });

  it("erro depois de o worker carregar é do pdf.js: não derruba o worker nem a próxima abertura", async () => {
    const { abrirPdf } = await leitor();
    pdfjs.getDocument.mockReturnValue(tarefa(Promise.resolve({ numPages: 2, getPage: vi.fn() })));
    await abrirPdf(BYTES);
    const [worker] = WorkerFalso.criados;
    worker.carregar();
    worker.falhar();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBe(worker);
    await expect(abrirPdf(BYTES)).resolves.toMatchObject({ paginas: 2 });
    expect(WorkerFalso.criados).toHaveLength(1);
  });

  it("o PDF que o pdf.js não abre: a falha chega à tela", async () => {
    const { abrirPdf } = await leitor();
    pdfjs.getDocument.mockReturnValue(tarefa(Promise.reject(new Error("Invalid PDF structure."))));
    await expect(abrirPdf(BYTES)).rejects.toThrow("Invalid PDF structure.");
  });
});

describe("desenharPagina", () => {
  type Desenho = { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> };
  function paginaFalsa(desenhos: Desenho[]) {
    return {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
      render: vi.fn(() => desenhos.shift()!),
    };
  }
  const densidadeOriginal = window.devicePixelRatio;
  afterEach(() => { Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: densidadeOriginal }); });

  it("na largura da aba e na densidade da tela, até 3x; trocar de página cancela o desenho anterior; fechar solta o documento", async () => {
    const { abrirPdf } = await leitor();
    let terminarPrimeiro!: () => void;
    const desenhos: Desenho[] = [
      { promise: new Promise<void>(resolver => { terminarPrimeiro = resolver; }), cancel: vi.fn() },
      { promise: Promise.resolve(), cancel: vi.fn() },
      { promise: Promise.resolve(), cancel: vi.fn() },
    ];
    const pagina = paginaFalsa([...desenhos]);
    const aberta = tarefa(Promise.resolve({ numPages: 2, getPage: vi.fn(async () => pagina) }));
    pdfjs.getDocument.mockReturnValue(aberta);
    const documento = await abrirPdf(BYTES);
    const canvas = document.createElement("canvas");

    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const primeiro = documento.desenharPagina(1, canvas, 300);
    await vi.waitFor(() => expect(pagina.render).toHaveBeenCalledTimes(1));
    // 300 px de largura numa tela 2x: o canvas tem 600 px reais.
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(800);
    expect(pagina.render.mock.calls[0][0]).toMatchObject({ canvas, viewport: { scale: 1 } });

    // A página seguinte antes de a primeira terminar: a primeira é cancelada.
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 5 });
    await documento.desenharPagina(2, canvas, 300);
    expect(desenhos[0].cancel).toHaveBeenCalled();
    // Densidade 5 vira 3: 300 x 3 = 900 px.
    expect(canvas.width).toBe(900);
    terminarPrimeiro();
    await primeiro;

    documento.fechar();
    expect(aberta.destroy).toHaveBeenCalled();
  });
});
