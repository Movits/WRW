/**
 * O leitor de PDF da tela (H12b do desenho do gravador): desenha uma página do
 * PDF guardado num canvas, para a dona navegar pelo documento página a página,
 * no computador e no celular (o celular não mostra PDF dentro da página, e a
 * CSP não aceita iframe nem object). É o pdf.js (Mozilla, Apache-2.0), carregado
 * só quando a aba das páginas abre: o resto do app não paga o peso dele.
 *
 * - A versão "legacy" do pdf.js, que traz o que falta nos Safari mais antigos.
 * - O worker é um Worker em módulo da mesma origem (workers/leitor-de-pdf.worker.ts).
 * - Sem WebAssembly (`useWasm: false`): compilar WebAssembly pede
 *   'wasm-unsafe-eval' na CSP. Os decodificadores do preto e branco do escâner
 *   (JBIG2, CCITT) e do JPEG 2000 vêm em JavaScript, e os mapas de caracteres
 *   (chinês, japonês, coreano) e as fontes padrão (Helvetica, Times, Courier
 *   não embutidas) também: todos servidos pelo próprio servidor em
 *   /pdfjs/<versão>/ (server/_core/arquivos-do-leitor-de-pdf.ts).
 * - Sem `eval`: o pdf.js 6 não o usa mais (a opção isEvalSupported saiu), e a
 *   CSP de produção não o aceitaria.
 * - Fica de fora o que o PDF pode trazer além das páginas: formulários XFA e o
 *   JavaScript embutido (o pdf.js só o roda no visualizador completo, que não
 *   é este).
 */

export type DocumentoAberto = {
  paginas: number;
  /** Desenha a página `numero` (a partir de 1) no canvas, na largura dada em pixels CSS. */
  desenharPagina(numero: number, canvas: HTMLCanvasElement, larguraCss: number): Promise<void>;
  fechar(): void;
};

let worker: Worker | null = null;
/**
 * Rejeita quando o worker não carrega. O caso de sempre é o deploy: a aba aberta
 * antes dele pede o worker da versão anterior, que não existe mais, e o pdf.js,
 * que recebe o worker pronto, ficaria esperando a resposta dele para sempre (a
 * aba diria "abrindo as páginas" sem fim). Com isto, a tela mostra a falha e o
 * "Abrir o PDF", e o próximo documento tenta um worker novo.
 */
let falhaDoWorker: Promise<never> = new Promise<never>(() => {});

/** Onde o servidor serve os arquivos do pdf.js desta versão (a versão muda o endereço, e o cache longo vale). */
export function enderecosDoLeitor(versao: string) {
  const base = `/pdfjs/${versao}/`;
  return { wasmUrl: base, cMapUrl: `${base}cmaps/`, standardFontDataUrl: `${base}standard_fonts/` };
}

function ligarOWorker(opcoes: { workerPort: unknown }) {
  if (worker) return;
  const novo = new Worker(new URL("../workers/leitor-de-pdf.worker.ts", import.meta.url), { type: "module" });
  // O worker do pdf.js manda uma mensagem ao carregar; erro antes dela é o
  // arquivo que não carregou. Erro depois é do pdf.js, que o trata sozinho.
  let carregou = false;
  novo.addEventListener("message", () => { carregou = true; }, { once: true });
  falhaDoWorker = new Promise<never>((_resolver, rejeitar) => {
    novo.addEventListener("error", () => {
      if (carregou) return;
      if (worker === novo) {
        worker = null;
        opcoes.workerPort = null;
      }
      novo.terminate();
      rejeitar(new Error("O worker do leitor de PDF não carregou."));
    });
  });
  // Sem ninguém esperando (o documento já abriu), a rejeição não fica solta.
  falhaDoWorker.catch(() => {});
  worker = novo;
  opcoes.workerPort = novo;
}

export async function abrirPdf(bytes: ArrayBuffer): Promise<DocumentoAberto> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  ligarOWorker(pdfjs.GlobalWorkerOptions);
  // Uma cópia: o pdf.js transfere o buffer ao worker, e o original continua no
  // cache da tela para a próxima abertura.
  const tarefa = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    useWasm: false,
    ...enderecosDoLeitor(pdfjs.version),
    cMapPacked: true,
    enableXfa: false,
  });
  let documento: Awaited<typeof tarefa.promise>;
  try {
    documento = await Promise.race([tarefa.promise, falhaDoWorker]);
  } catch (erro) {
    void tarefa.destroy();
    throw erro;
  }
  let desenhoEmCurso: { cancel(): void } | null = null;
  return {
    paginas: documento.numPages,
    async desenharPagina(numero, canvas, larguraCss) {
      desenhoEmCurso?.cancel();
      const pagina = await documento.getPage(numero);
      const base = pagina.getViewport({ scale: 1 });
      // A nitidez da tela: o canvas tem os pixels físicos, e o CSS o encolhe à largura.
      const densidade = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      const viewport = pagina.getViewport({ scale: (Math.max(larguraCss, 1) / base.width) * densidade });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const desenho = pagina.render({ canvas, viewport });
      desenhoEmCurso = desenho;
      try {
        await desenho.promise;
      } finally {
        if (desenhoEmCurso === desenho) desenhoEmCurso = null;
      }
    },
    fechar() {
      desenhoEmCurso?.cancel();
      void tarefa.destroy();
    },
  };
}
