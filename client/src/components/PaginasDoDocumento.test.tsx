import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PaginasDoDocumento, type DocumentoNaTela } from "./PaginasDoDocumento";

/**
 * As páginas do documento guardado (H12b), na aba "Páginas" do detalhe da dona:
 * o PDF enviado, ou as fotos do texto juntas num PDF, uma página por vez, com
 * anterior e próxima. Os bytes vêm da rota da dona (o link aberto não tem esta
 * aba), e o desenho é do pdf.js, que o jsdom não roda: o leitor
 * (lib/leitor-de-pdf.ts) é um dublê que conta as páginas e registra cada
 * desenho. O jsdom também não mede layout: a 375 px o que se prova são as
 * classes que fazem a página caber na largura da tela, sem rolagem lateral, e
 * em árabe as setas espelhadas e os textos e números no idioma da tela.
 */
const duble = vi.hoisted(() => ({
  buscar: vi.fn(),
  abrir: vi.fn(),
  desenhar: vi.fn(),
  fechar: vi.fn(),
}));
vi.mock("@/lib/envio-do-documento", async original => ({
  ...(await original<typeof import("@/lib/envio-do-documento")>()),
  buscarDocumentoGuardado: (...args: unknown[]) => duble.buscar(...args),
}));
vi.mock("@/lib/leitor-de-pdf", () => ({ abrirPdf: (...args: unknown[]) => duble.abrir(...args) }));

const { FalhaAoBuscarODocumento } = await import("@/lib/envio-do-documento");

const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";
const DOCUMENTO: DocumentoNaTela = { url: `/manus-storage/meetings/dona/${REUNIAO}/documento-abcd1234.pdf`, mimeType: "application/pdf", sizeBytes: 1234, expiresAt: Date.UTC(2026, 11, 20, 12) };
const BYTES = new TextEncoder().encode("%PDF-1.7 de teste").buffer;

function mostrar(props: Partial<Parameters<typeof PaginasDoDocumento>[0]> = {}) {
  // Sem espera entre as novas tentativas: o teste não espera o recuo do React Query.
  const cliente = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(<QueryClientProvider client={cliente}>
    <PaginasDoDocumento meetingId={REUNIAO} documento={DOCUMENTO} documentoExpirado={false} documentoSaindo={false} {...props}/>
  </QueryClientProvider>);
}

beforeEach(() => {
  duble.buscar.mockReset();
  duble.buscar.mockResolvedValue(BYTES);
  duble.desenhar.mockReset();
  duble.desenhar.mockResolvedValue(undefined);
  duble.fechar.mockReset();
  duble.abrir.mockReset();
  duble.abrir.mockResolvedValue({ paginas: 3, desenharPagina: duble.desenhar, fechar: duble.fechar });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  // Desmonta antes: os hooks rodam em pilha, e a troca do idioma redesenharia a aba com os dublês já restaurados.
  cleanup();
  vi.restoreAllMocks();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("PaginasDoDocumento", () => {
  it("baixa o PDF da dona uma vez, abre no leitor e desenha a primeira página na largura da aba", async () => {
    mostrar();
    expect(await screen.findByText("Página 1 de 3")).toBeInTheDocument();
    expect(duble.buscar).toHaveBeenCalledTimes(1);
    expect(duble.buscar).toHaveBeenCalledWith(REUNIAO);
    expect(duble.abrir).toHaveBeenCalledWith(BYTES);
    await waitFor(() => expect(duble.desenhar).toHaveBeenCalled());
    const [pagina, canvas, largura] = duble.desenhar.mock.calls.at(-1)!;
    expect(pagina).toBe(1);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(largura).toBeGreaterThan(0);
    expect(screen.getByText("Arquivo guardado até você excluir a reunião.")).toBeInTheDocument();
  });

  it("anterior e próxima andam uma página e param nas pontas", async () => {
    mostrar();
    const anterior = await screen.findByRole("button", { name: "Página anterior" });
    const proxima = screen.getByRole("button", { name: "Próxima página" });
    expect(anterior).toBeDisabled();
    fireEvent.click(proxima);
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();
    await waitFor(() => expect(duble.desenhar.mock.calls.at(-1)![0]).toBe(2));
    fireEvent.click(proxima);
    expect(screen.getByText("Página 3 de 3")).toBeInTheDocument();
    expect(proxima).toBeDisabled();
    fireEvent.click(anterior);
    expect(screen.getByText("Página 2 de 3")).toBeInTheDocument();
  });

  it("a 375 px: a página ocupa a largura da aba e nunca passa dela; os botões cabem só com as setas", async () => {
    const { container } = mostrar();
    await screen.findByText("Página 1 de 3");
    const canvas = container.querySelector("canvas")!;
    expect(canvas).toHaveClass("block", "w-full", "h-auto");
    expect(canvas.parentElement).toHaveClass("w-full", "max-w-full", "overflow-hidden");
    // No celular, o rótulo some e fica a seta (o nome do botão continua no aria-label).
    expect(screen.getByRole("button", { name: "Próxima página" }).querySelector("span")).toHaveClass("hidden", "sm:inline");
    // Nenhum lado físico nem largura fixa nas classes da aba.
    expect(container.innerHTML).not.toMatch(/(^|\s|")([a-z]+:)*(ml|mr|pl|pr|left|right)-\d|w-\[\d+px\]/);
  });

  it("em árabe: os textos e os números no idioma da tela, e as setas espelhadas", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const { container } = mostrar();
    const um = (1).toLocaleString("ar");
    const tres = (3).toLocaleString("ar");
    expect(await screen.findByText(`الصفحة ${um} من ${tres}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الصفحة التالية" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /فتح ملف PDF/ })).toBeInTheDocument();
    // As duas setas giram na escrita da direita para a esquerda.
    expect(container.querySelectorAll("svg.rtl\\:rotate-180")).toHaveLength(2);
    // Mas a página do PDF não: o canvas herdaria a direção da tela, e o pdf.js
    // desenhava as letras do texto latino fora do lugar (visto no navegador).
    expect(container.querySelector("canvas")!.parentElement).toHaveAttribute("dir", "ltr");
    expect(document.body.textContent).not.toMatch(/Página|Próxima|Abrir/);
  });

  it("sair da aba fecha o documento no leitor", async () => {
    const { unmount } = mostrar();
    await screen.findByText("Página 1 de 3");
    unmount();
    expect(duble.fechar).toHaveBeenCalled();
  });

  it("trocar de página no meio do desenho cancela o anterior sem dizer que falhou", async () => {
    duble.desenhar.mockRejectedValueOnce(Object.assign(new Error("cancelado"), { name: "RenderingCancelledException" }));
    mostrar();
    await screen.findByText("Página 1 de 3");
    await waitFor(() => expect(duble.desenhar).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("o leitor não abriu o PDF: diz isso e oferece abrir o arquivo pelo navegador", async () => {
    duble.abrir.mockRejectedValue(new Error("PDF inválido"));
    mostrar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível mostrar as páginas neste navegador. Abra o PDF para ver o arquivo.");
    const link = screen.getByRole("link", { name: /Abrir o PDF/ });
    expect(link).toHaveAttribute("href", DOCUMENTO.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("o arquivo saiu do bucket (404): diz que está saindo, sem tentar de novo", async () => {
    duble.buscar.mockRejectedValue(new FalhaAoBuscarODocumento(404, "SEM_DOCUMENTO"));
    mostrar();
    expect(await screen.findByRole("alert")).toHaveTextContent("O arquivo já não pode ser aberto.");
    expect(screen.queryByRole("button", { name: /Tentar novamente/ })).not.toBeInTheDocument();
    expect(duble.buscar).toHaveBeenCalledTimes(1);
  });

  it("rede ou servidor fora: diz que não baixou e deixa tentar de novo", async () => {
    duble.buscar.mockRejectedValue(new FalhaAoBuscarODocumento(503, "TENTE_DE_NOVO"));
    mostrar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível baixar o arquivo agora.");
    duble.buscar.mockResolvedValue(BYTES);
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
    expect(await screen.findByText("Página 1 de 3")).toBeInTheDocument();
  });

  it.each([
    ["saiu pela regra dos 30 dias de antes de 26/11/2026", { documentoExpirado: true }, "O arquivo foi apagado pela regra de antes, que apagava o arquivo 30 dias depois do envio. O texto lido continua aqui."],
    ["está saindo", { documentoSaindo: true }, "O arquivo já não pode ser aberto. O app ainda está apagando o arquivo do armazenamento."],
    ["não há arquivo", {}, "Nenhum arquivo guardado para este documento."],
  ])("sem o arquivo (%s): diz isso e nem pede os bytes", (_caso, estado, frase) => {
    mostrar({ documento: null, ...estado });
    expect(screen.getByText(frase)).toBeInTheDocument();
    expect(duble.buscar).not.toHaveBeenCalled();
    expect(duble.abrir).not.toHaveBeenCalled();
  });
});
