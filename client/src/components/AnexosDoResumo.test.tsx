import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { AnexosDoResumo } from "./AnexosDoResumo";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A redução é do canvas, que o jsdom não tem: o que se prova aqui é que a tela a pede com a régua dos anexos.
const reduzida = { dataBase64: "data:image/webp;base64,UklGRg==", mimeType: "image/webp", bytes: 4, reduzida: true };
const preparar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reduzir-imagem", () => ({ prepararImagemParaEnvio: (arquivo: File, lado: number) => preparar(arquivo, lado) }));

/**
 * As fotos e os desenhos do resumo na tela (H4g e H4h): no detalhe da dona,
 * anexar (foto reduzida no aparelho), ver, tirar e abrir a tela de desenho;
 * no link aberto, só ver, pela rota do link, e pedir a senha quando ela
 * venceu. A rede é um link falso, como em LixeiraDeReunioes.test.tsx; o que o
 * servidor confere está em server/anexos-do-resumo*.test.ts.
 */
const REUNIAO = "c3c3c3c3-0000-4000-8000-000000000001";
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;
const ANEXOS = [
  { id: "a1", tipo: "photo", url: "/manus-storage/meetings/d/r/anexo-a1.webp", mimeType: "image/webp", criadoEm: AGORA, expiraEm: AGORA + 30 * DIA },
  { id: "a2", tipo: "drawing", url: "/manus-storage/meetings/d/r/anexo-a2.png", mimeType: "image/png", criadoEm: AGORA, expiraEm: AGORA + 30 * DIA },
];

type Resposta = unknown | Error | ((entrada: unknown) => unknown);
const rede = { chamadas: [] as Array<{ path: string; input: unknown }>, respostas: {} as Record<string, Resposta> };
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    const combinada = rede.respostas[op.path];
    void Promise.resolve().then(() => {
      const resposta = typeof combinada === "function" ? (combinada as (entrada: unknown) => unknown)(op.input) : combinada;
      if (resposta === undefined) return observer.error(TRPCClientError.from(new Error(`rota não simulada: ${op.path}`)));
      if (resposta instanceof Error) return observer.error(resposta as never);
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    });
    return () => undefined;
  });
}
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

function abrir(elemento: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>{elemento}</QueryClientProvider>
  </trpc.Provider>);
}
const chamadasDe = (rota: string) => rede.chamadas.filter(chamada => chamada.path === rota);
const arquivo = (nome: string, tipo: string) => new File([new Uint8Array([1, 2, 3])], nome, { type: tipo });

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "meetings.anexos": ANEXOS, "meetings.anexarAoResumo": { ...ANEXOS[0], id: "a3" }, "meetings.apagarAnexo": { saiuDoBucket: true } };
  preparar.mockReset();
  preparar.mockImplementation(async () => reduzida);
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("no detalhe da dona", () => {
  it("mostra as imagens com o texto alternativo, a conta, o prazo dos 30 dias e o aviso do link aberto", async () => {
    abrir(<AnexosDoResumo meetingId={REUNIAO} comLinkAberto/>);
    expect(await screen.findByAltText("Foto 1")).toHaveAttribute("src", ANEXOS[0].url);
    expect(screen.getByAltText("Desenho 2")).toBeInTheDocument();
    expect(screen.getByText("2/20")).toBeInTheDocument();
    expect(screen.getByText(/ficam guardados por 30 dias desde o envio; o primeiro sai em/)).toBeInTheDocument();
    expect(screen.getByText(/quem tem o link vê estas imagens/)).toBeInTheDocument();
  });

  it("sem link aberto, sem o aviso do link; sem imagens, o convite a anexar", async () => {
    rede.respostas["meetings.anexos"] = [];
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    expect(await screen.findByText(/Nenhuma foto ou desenho ainda/)).toBeInTheDocument();
    expect(screen.queryByText(/quem tem o link vê estas imagens/)).not.toBeInTheDocument();
  });

  it("escolher fotos: cada uma é reduzida a 1600 px e sobe como 'photo', uma de cada vez, e a lista se relê", async () => {
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    await screen.findByAltText("Foto 1");
    const lidasAntes = chamadasDe("meetings.anexos").length;
    fireEvent.change(screen.getByTestId("anexo-escolher"), { target: { files: [arquivo("a.jpg", "image/jpeg"), arquivo("b.png", "image/png")] } });
    await waitFor(() => expect(chamadasDe("meetings.anexarAoResumo")).toHaveLength(2));
    expect(preparar.mock.calls.map(chamada => chamada[1])).toEqual([1600, 1600]);
    expect(chamadasDe("meetings.anexarAoResumo")[0].input).toEqual({ meetingId: REUNIAO, tipo: "photo", dataBase64: "data:image/webp;base64,UklGRg==" });
    await waitFor(() => expect(chamadasDe("meetings.anexos").length).toBeGreaterThan(lidasAntes));
    expect(toast.success).toHaveBeenCalledWith("Imagens anexadas: 2");
  });

  it("o que não é imagem nem sobe; a recusa do servidor sai traduzida pelo código", async () => {
    rede.respostas["meetings.anexarAoResumo"] = erroDoServidor("PRECONDITION_FAILED", "ANEXOS_DEMAIS");
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    await screen.findByAltText("Foto 1");
    fireEvent.change(screen.getByTestId("anexo-escolher"), { target: { files: [arquivo("nota.pdf", "application/pdf")] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Envie uma imagem JPG, PNG ou WebP."));
    expect(chamadasDe("meetings.anexarAoResumo")).toHaveLength(0);
    fireEvent.change(screen.getByTestId("anexo-escolher"), { target: { files: [arquivo("a.jpg", "image/jpeg")] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Esta reunião já tem 20 imagens. Tire uma para anexar outra."));
  });

  it("a reunião cheia não deixa escolher mais", async () => {
    rede.respostas["meetings.anexos"] = Array.from({ length: 20 }, (_, i) => ({ ...ANEXOS[0], id: `x${i}` }));
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    await screen.findByText("20/20");
    expect(screen.getByRole("button", { name: /Escolher fotos/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Desenhar/ })).toBeDisabled();
  });

  it("tirar uma imagem pede confirmação; confirmado, chama o servidor com a reunião e o anexo", async () => {
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    await screen.findByAltText("Foto 1");
    const confirmar = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Tirar Foto 1" }));
    expect(chamadasDe("meetings.apagarAnexo")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Tirar Foto 1" }));
    await waitFor(() => expect(chamadasDe("meetings.apagarAnexo")[0]?.input).toEqual({ meetingId: REUNIAO, anexoId: "a1" }));
    expect(confirmar).toHaveBeenCalledTimes(2);
  });

  it("Desenhar abre a tela de desenho, com Guardar desligado enquanto a folha está vazia", async () => {
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    await screen.findByAltText("Foto 1");
    fireEvent.click(screen.getByRole("button", { name: /Desenhar/ }));
    expect(await screen.findByText("Desenhar ou escrever à mão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar no resumo" })).toBeDisabled();
  });

  it("em árabe, os textos saem traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir(<AnexosDoResumo meetingId={REUNIAO}/>);
    expect(await screen.findByAltText("صورة 1")).toBeInTheDocument();
    expect(screen.getByText("الصور والرسومات")).toBeInTheDocument();
  });
});

describe("no link aberto", () => {
  const TOKEN = "T".repeat(32);
  const DO_LINK = [{ id: "a1", tipo: "photo", url: `/reuniao-aberta/${TOKEN}/anexo/a1` }];

  it("mostra as imagens pela rota do link, sem botão de tirar nem de anexar", async () => {
    rede.respostas = { "reuniaoAberta.anexos": DO_LINK };
    abrir(<AnexosDoResumo token={TOKEN}/>);
    expect(await screen.findByAltText("Foto 1")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/anexo/a1`);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(chamadasDe("meetings.anexos")).toHaveLength(0);
  });

  it("sem imagens, a seção não aparece (o link de antes fica igual)", async () => {
    rede.respostas = { "reuniaoAberta.anexos": [] };
    const { container } = abrir(<AnexosDoResumo token={TOKEN}/>);
    await waitFor(() => expect(chamadasDe("reuniaoAberta.anexos")).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("a entrada do link com senha venceu (UNAUTHORIZED): a página é avisada para pedir a senha", async () => {
    rede.respostas = { "reuniaoAberta.anexos": erroDoServidor("UNAUTHORIZED", "senha") };
    const aoPedirSenha = vi.fn();
    abrir(<AnexosDoResumo token={TOKEN} aoPedirSenha={aoPedirSenha}/>);
    await waitFor(() => expect(aoPedirSenha).toHaveBeenCalledTimes(1));
  });
});
