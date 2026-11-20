import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO } from "@shared/aviso-do-documento";
import { DOCUMENTO_BYTES_MAX, FOTOS_POR_DOCUMENTO_MAX } from "@shared/documento-da-reuniao";
import { DocumentoParaResumir } from "./DocumentoParaResumir";

/**
 * O resumo de um documento no gravador (H12 e H12b): um PDF ou as fotos de um
 * texto (no celular, pela câmera; no computador, por arquivo), com o aviso e a
 * autorização do documento, cuja versão vai gravada na reunião (como a G4 faz
 * com o aviso de gravação). O tRPC, o envio binário e a montagem do PDF das
 * fotos são dublês: a montagem está em lib/pdf-de-fotos.test.ts, o envio em
 * lib/envio-do-documento.test.ts e a rota no servidor, pelo HTTP, em
 * server/rota-do-documento.test.ts.
 */
const duble = vi.hoisted(() => ({
  iniciar: vi.fn(),
  enviar: vi.fn(),
  fotosParaPdf: vi.fn(),
  excluir: vi.fn(),
  invalidarLista: vi.fn(),
  liberar: vi.fn(),
  ocupar: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { list: { invalidate: duble.invalidarLista } }, client: { meetings: { delete: { mutate: duble.excluir } } } }),
    meetings: { iniciarDocumento: { useMutation: () => ({ mutateAsync: duble.iniciar }) } },
  },
}));
vi.mock("@/lib/envio-do-documento", () => ({ enviarDocumento: (...args: unknown[]) => duble.enviar(...args) }));
vi.mock("@/lib/pdf-de-fotos", async original => ({
  ...(await original<typeof import("@/lib/pdf-de-fotos")>()),
  fotosParaPdf: (...args: unknown[]) => duble.fotosParaPdf(...args),
}));
vi.mock("@/lib/sessao-ocupada", () => ({ ocupar: (...args: unknown[]) => duble.ocupar(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { toast } = await import("sonner");
const { FotoIlegivel } = await import("@/lib/pdf-de-fotos");

const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";
const pdf = (nome = "proposta.pdf", conteudo = "%PDF-1.7\n% proposta\n%%EOF\n", tipo = "application/pdf") => new File([conteudo], nome, { type: tipo });
const foto = (nome: string) => new File([new Uint8Array([0xff, 0xd8, 0xff])], nome, { type: "image/jpeg" });

let urls = 0;
const props = {
  titulo: "Proposta da feira",
  idioma: "pt-BR" as const,
  validarTitulo: vi.fn((): string | null => null),
  aoMudarOcupado: vi.fn(),
  aoEnviar: vi.fn(),
  aoVoltar: vi.fn(),
};

beforeEach(() => {
  for (const funcao of Object.values(duble)) funcao.mockReset();
  for (const funcao of [props.validarTitulo, props.aoMudarOcupado, props.aoEnviar, props.aoVoltar]) funcao.mockClear();
  props.validarTitulo.mockReturnValue(null);
  duble.iniciar.mockResolvedValue({ id: REUNIAO });
  duble.enviar.mockResolvedValue({ tipo: "recebido", repetido: false });
  duble.excluir.mockResolvedValue({ success: true });
  duble.ocupar.mockReturnValue(duble.liberar);
  duble.fotosParaPdf.mockImplementation(async (fotos: File[]) => new Blob([`%PDF-1.4 ${fotos.length} fotos`], { type: "application/pdf" }));
  vi.mocked(toast.success).mockClear();
  // O jsdom não cria URLs de arquivo: as miniaturas recebem uma de mentira.
  urls = 0;
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:foto-${++urls}`), revokeObjectURL: vi.fn() });
});
afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

const escolherPdf = (arquivo: File) => fireEvent.change(screen.getByTestId("entrada-do-pdf"), { target: { files: [arquivo] } });
const autorizar = () => fireEvent.click(screen.getByRole("checkbox"));
const enviar = () => fireEvent.click(screen.getByRole("button", { name: "Enviar para resumir" }));

describe("DocumentoParaResumir: o PDF", () => {
  it("mostra o aviso do documento, e o envio só liga com o arquivo e a autorização", () => {
    render(<DocumentoParaResumir {...props}/>);
    expect(screen.getByRole("heading", { name: "Resumir um documento" })).toBeInTheDocument();
    expect(screen.getByText(/O arquivo é lido pela IA do Google \(Gemini\), que pode processá-lo fora do Brasil/)).toBeInTheDocument();
    expect(screen.getByText(/nunca o arquivo\.$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDF" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("PDF de até 15 MB, digital ou escaneado.")).toBeInTheDocument();
    const botao = screen.getByRole("button", { name: "Enviar para resumir" });
    expect(botao).toBeDisabled();
    escolherPdf(pdf());
    expect(botao).toBeDisabled();
    autorizar();
    expect(botao).toBeEnabled();
  });

  it("a reunião nasce com o consentimento e a versão do aviso do documento, o PDF vai cru, e a tela vai ao detalhe", async () => {
    render(<DocumentoParaResumir {...props}/>);
    const arquivo = pdf();
    escolherPdf(arquivo);
    expect(screen.getByText(/proposta\.pdf/)).toBeInTheDocument();
    autorizar();
    enviar();
    await waitFor(() => expect(props.aoEnviar).toHaveBeenCalledWith(REUNIAO));
    expect(duble.iniciar).toHaveBeenCalledWith({
      title: "Proposta da feira", language: "pt-BR", consentGranted: true,
      consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf",
    });
    expect(VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO).toMatch(/^documento-/);
    expect(duble.enviar).toHaveBeenCalledWith(REUNIAO, arquivo);
    expect(toast.success).toHaveBeenCalledWith("Documento enviado. A IA já está lendo o texto.");
    expect(duble.invalidarLista).toHaveBeenCalled();
    // A sessão fica ocupada do começo ao fim do envio, e o gravador trava o título.
    expect(duble.ocupar).toHaveBeenCalledWith("enviando");
    expect(duble.liberar).toHaveBeenCalledTimes(1);
    expect(props.aoMudarOcupado.mock.calls).toEqual([[true], [false]]);
    expect(duble.excluir).not.toHaveBeenCalled();
  });

  it("título fora da regra ou sem autorização: o aviso, e nada nasce", async () => {
    render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf());
    autorizar();
    props.validarTitulo.mockReturnValueOnce("Dê um título à reunião.");
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Dê um título à reunião.");
    expect(duble.iniciar).not.toHaveBeenCalled();
  });

  it("arquivo com nome de PDF que não começa por %PDF-: recusado no aparelho, sem criar a reunião", async () => {
    render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf("disfarcado.pdf", "PK\u0003\u0004 um zip"));
    autorizar();
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Este arquivo não é um PDF.");
    expect(duble.iniciar).not.toHaveBeenCalled();
    expect(duble.liberar).toHaveBeenCalledTimes(1);
  });

  it("PDF acima de 15 MB ou de outro tipo: recusado ao escolher", () => {
    render(<DocumentoParaResumir {...props}/>);
    const grande = pdf();
    Object.defineProperty(grande, "size", { value: DOCUMENTO_BYTES_MAX + 1 });
    escolherPdf(grande);
    expect(screen.getByRole("alert")).toHaveTextContent("O PDF passa de 15 MB. Envie um arquivo menor ou divida o documento em partes.");
    escolherPdf(new File(["oi"], "notas.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Este arquivo não é um PDF.");
    expect(screen.getByRole("button", { name: "Enviar para resumir" })).toBeDisabled();
  });

  it.each([
    ["GRANDE_DEMAIS", 413, "O PDF passa de 15 MB. Envie um arquivo menor ou divida o documento em partes."],
    ["MUITOS_PEDIDOS", 429, "Você já enviou 10 documentos na última hora. Espere um pouco para enviar outro."],
    ["FORMATO", 415, "Este arquivo não é um PDF."],
  ])("o servidor recusou (%s): a frase no idioma da tela, e a reunião que nasceu para o arquivo sai", async (codigo, status, frase) => {
    duble.enviar.mockResolvedValue({ tipo: "recusado", status, codigo });
    render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf());
    autorizar();
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent(frase);
    expect(duble.excluir).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(props.aoEnviar).not.toHaveBeenCalled();
    // O arquivo continua escolhido, para enviar de novo.
    expect(screen.getByText(/proposta\.pdf/)).toBeInTheDocument();
  });

  it("a rede caiu: tenta uma vez de novo (o servidor reconhece o mesmo arquivo) e, caindo de novo, não exclui a reunião", async () => {
    duble.enviar.mockResolvedValue({ tipo: "recusado", status: 0, codigo: "REDE" });
    render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf());
    autorizar();
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent("A conexão caiu durante o envio. Confira na lista de reuniões se o documento chegou antes de enviar de novo.");
    expect(duble.enviar).toHaveBeenCalledTimes(2);
    expect(duble.excluir).not.toHaveBeenCalled();
  });

  it("a rede caiu só na primeira vez: a segunda entrega", async () => {
    duble.enviar.mockResolvedValueOnce({ tipo: "recusado", status: 0, codigo: "REDE" }).mockResolvedValueOnce({ tipo: "recebido", repetido: true });
    render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf());
    autorizar();
    enviar();
    await waitFor(() => expect(props.aoEnviar).toHaveBeenCalledWith(REUNIAO));
  });
});

describe("DocumentoParaResumir: as fotos de um texto", () => {
  const abrirFotos = () => fireEvent.click(screen.getByRole("button", { name: "Fotos de um texto" }));

  it("no celular, a câmera; no computador, várias imagens de uma vez", () => {
    render(<DocumentoParaResumir {...props}/>);
    abrirFotos();
    const camera = screen.getByTestId("entrada-da-camera");
    expect(camera).toHaveAttribute("accept", "image/*");
    expect(camera).toHaveAttribute("capture", "environment");
    expect(camera).not.toHaveAttribute("multiple");
    const arquivos = screen.getByTestId("entrada-das-fotos");
    expect(arquivos).toHaveAttribute("accept", "image/*");
    expect(arquivos).toHaveAttribute("multiple");
    expect(arquivos).not.toHaveAttribute("capture");
    expect(screen.getByRole("button", { name: "Tirar foto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escolher fotos" })).toBeInTheDocument();
  });

  it("as fotos entram na ordem, cada uma vira uma página, e o PDF delas segue o caminho do PDF com a origem 'foto'", async () => {
    render(<DocumentoParaResumir {...props}/>);
    abrirFotos();
    fireEvent.change(screen.getByTestId("entrada-da-camera"), { target: { files: [foto("a.jpg")] } });
    fireEvent.change(screen.getByTestId("entrada-das-fotos"), { target: { files: [foto("b.jpg"), foto("c.jpg"), new File(["x"], "nota.txt", { type: "text/plain" })] } });
    const lista = screen.getByRole("list", { name: "Fotos do texto, na ordem das páginas" });
    expect(within(lista).getAllByRole("img").map(imagem => imagem.getAttribute("alt"))).toEqual(["Página 1", "Página 2", "Página 3"]);
    // Tirar a segunda: as outras sobem de número, e a URL dela sai da memória.
    fireEvent.click(screen.getByRole("button", { name: "Remover a foto 2" }));
    expect(within(lista).getAllByRole("img").map(imagem => imagem.getAttribute("src"))).toEqual(["blob:foto-1", "blob:foto-3"]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:foto-2");
    autorizar();
    enviar();
    await waitFor(() => expect(props.aoEnviar).toHaveBeenCalledWith(REUNIAO));
    const [fotos, opcoes] = duble.fotosParaPdf.mock.calls[0];
    expect(fotos.map((arquivo: File) => arquivo.name)).toEqual(["a.jpg", "c.jpg"]);
    expect(typeof opcoes.aoAvancar).toBe("function");
    expect(duble.iniciar).toHaveBeenCalledWith(expect.objectContaining({ origem: "foto", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO }));
    const [, enviado] = duble.enviar.mock.calls[0];
    expect(enviado).toBeInstanceOf(Blob);
    expect(enviado.type).toBe("application/pdf");
    // Enviadas, as miniaturas saem da tela e da memória.
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it(`no máximo ${FOTOS_POR_DOCUMENTO_MAX} fotos: as que passam ficam de fora, com o aviso, e os botões desligam`, () => {
    render(<DocumentoParaResumir {...props}/>);
    abrirFotos();
    const muitas = Array.from({ length: FOTOS_POR_DOCUMENTO_MAX + 1 }, (_, i) => foto(`${i}.jpg`));
    fireEvent.change(screen.getByTestId("entrada-das-fotos"), { target: { files: muitas } });
    expect(screen.getAllByRole("img")).toHaveLength(FOTOS_POR_DOCUMENTO_MAX);
    expect(screen.getByRole("alert")).toHaveTextContent("Um documento tem no máximo 20 fotos: as que passaram disso ficaram de fora.");
    expect(screen.getByRole("button", { name: "Tirar foto" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Escolher fotos" })).toBeDisabled();
  });

  it("a foto que o aparelho não abre: diz qual, e nada nasce", async () => {
    duble.fotosParaPdf.mockRejectedValue(new FotoIlegivel(1));
    render(<DocumentoParaResumir {...props}/>);
    abrirFotos();
    fireEvent.change(screen.getByTestId("entrada-das-fotos"), { target: { files: [foto("a.jpg"), foto("b.heic")] } });
    autorizar();
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível abrir a foto 2. Tire de novo ou escolha uma imagem em JPEG ou PNG.");
    expect(duble.iniciar).not.toHaveBeenCalled();
  });

  it("as fotos juntas passaram de 15 MB: pede menos fotos, sem criar a reunião", async () => {
    const grande = new Blob(["%PDF-"], { type: "application/pdf" });
    Object.defineProperty(grande, "size", { value: DOCUMENTO_BYTES_MAX + 1 });
    duble.fotosParaPdf.mockResolvedValue(grande);
    render(<DocumentoParaResumir {...props}/>);
    abrirFotos();
    fireEvent.change(screen.getByTestId("entrada-das-fotos"), { target: { files: [foto("a.jpg")] } });
    autorizar();
    enviar();
    expect(await screen.findByRole("alert")).toHaveTextContent("As fotos juntas passam de 15 MB. Envie menos fotos de cada vez.");
    expect(duble.iniciar).not.toHaveBeenCalled();
  });
});

describe("DocumentoParaResumir: a 375 px e em árabe", () => {
  it("a 375 px: as opções dividem a largura, os botões das fotos empilham e as miniaturas ficam em três colunas, sem lado físico", () => {
    const { container } = render(<DocumentoParaResumir {...props}/>);
    escolherPdf(pdf("um-nome-de-arquivo-muito-comprido-sem-espacos-que-nao-cabe-na-tela-do-celular.pdf"));
    expect(screen.getByText(/um-nome-de-arquivo-muito-comprido/)).toHaveClass("min-w-0", "break-words");
    expect(screen.getByRole("button", { name: "PDF" })).toHaveClass("flex-1");
    fireEvent.click(screen.getByRole("button", { name: "Fotos de um texto" }));
    expect(screen.getByRole("button", { name: "Tirar foto" }).parentElement).toHaveClass("grid-cols-1", "sm:grid-cols-2");
    fireEvent.change(screen.getByTestId("entrada-das-fotos"), { target: { files: [foto("a.jpg")] } });
    expect(screen.getByRole("list")).toHaveClass("grid-cols-3");
    expect(container.innerHTML).not.toMatch(/(^|\s|")([a-z]+:)*(ml|mr|pl|pr|left|right)-\d|w-\[\d+px\]/);
  });

  it("em árabe: o aviso, os botões e os erros no idioma da tela, e as setas espelhadas", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const { container } = render(<DocumentoParaResumir {...props}/>);
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("heading", { name: "تلخيص مستند" })).toBeInTheDocument();
    expect(screen.getByText(/لا ترسلي إلا المستندات التي يحق لك مشاركتها/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /العودة إلى التسجيل/ }).querySelector("svg")).toHaveClass("rtl:rotate-180");
    expect(container.querySelector("button svg.rtl\\:-scale-x-100")).not.toBeNull();
    escolherPdf(new File(["oi"], "notas.docx", { type: "application/msword" }));
    expect(screen.getByRole("alert")).toHaveTextContent("هذا الملف ليس ملف PDF.");
    expect(document.body.textContent).not.toMatch(/Resumir|Enviar|arquivo/);
  });
});
