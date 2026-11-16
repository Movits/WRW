import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { prepararImagemParaEnvio, type ImagemParaEnviar } from "@/lib/reduzir-imagem";
import Network from "./Network";

/**
 * Minha Rede — foto e cartão de visita no passo 4 do formulário (#149).
 *
 * 1. Cada campo prepara a SUA imagem. Com um estado só para os dois, escolher
 *    o cartão no meio da redução da foto destravava a foto, e a primeira a
 *    terminar destravava a outra ainda em preparo: um segundo arquivo ali
 *    disparava dois envios, e um deles ficava órfão no bucket.
 * 2. O erro do envio chega no idioma da tela: a mensagem de sessão vem do
 *    servidor em inglês ("Please login (10001)") e o toast a mostrava crua.
 *
 * A redução é dublada com promessas que o teste resolve na ordem que quiser;
 * o que ela faz está em client/src/lib/reduzir-imagem.test.ts. O tRPC vira um
 * dublê (molde de Network.completude.test.tsx).
 */

const duble = vi.hoisted(() => {
  const registrar = () => ({ useMutation: () => ({ mutate: () => {}, isPending: false }) });
  const consulta = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, isError: false, refetch: () => {} }) });
  return { registrar, consulta, enviarFoto: vi.fn(), enviarCartao: vi.fn() };
});

vi.mock("@/lib/reduzir-imagem", () => ({
  prepararImagemParaEnvio: vi.fn(),
  lerArquivoComoDataUrl: vi.fn(),
  LADO_MAXIMO_FOTO_DE_CONTATO: 512,
  LADO_MAXIMO_CARTAO_DE_VISITA: 1600,
  LADO_MAXIMO_MIDIA_DE_CONTEXTO: 1600,
}));
vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, openId: "dona-1" }, isAuthenticated: true, loading: false }),
}));
vi.mock("@/components/EnrichmentChat", () => ({ EnrichmentChat: () => <div data-testid="chat-do-contato" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      network: { assetsNeeds: { invalidate: () => {} }, get: { invalidate: () => {} }, list: { invalidate: () => {} } },
      enrichment: { getHistory: { invalidate: () => {} } },
    }),
    network: {
      list: { useQuery: () => ({ data: { data: [], total: 0 }, isLoading: false, isError: false, isSuccess: true, fetchStatus: "idle", refetch: () => {} }) },
      get: { useQuery: () => ({ data: undefined, isLoading: false, isError: false, refetch: () => {} }) },
      assetsNeeds: { useQuery: () => ({ data: { possui: [], procura: [] }, isLoading: false, isError: false, refetch: () => {} }) },
      create: duble.registrar(),
      update: duble.registrar(),
      delete: duble.registrar(),
      uploadPhoto: { useMutation: () => ({ mutate: duble.enviarFoto, isPending: false }) },
      uploadCard: { useMutation: () => ({ mutate: duble.enviarCartao, isPending: false }) },
      removeAsset: duble.registrar(),
      removeNeed: duble.registrar(),
    },
    enrichment: {
      startSession: duble.registrar(),
      getHistory: duble.consulta({ data: [], total: 0 }),
      undoSuggestion: duble.registrar(),
    },
    contexts: { listByContact: duble.consulta([]) },
  },
}));

type OpcoesDoEnvio = { onSuccess: (res: { url: string }) => void; onError: (erro: { message: string }) => void };

function adiada<T>() {
  let resolver!: (valor: T) => void;
  const promessa = new Promise<T>(r => { resolver = r; });
  return { promessa, resolver };
}

const reduzida = (corpo: string): ImagemParaEnviar => ({
  dataBase64: `data:image/webp;base64,${corpo}`, mimeType: "image/webp", bytes: 3, reduzida: true,
});
const arquivo = (nome: string, tipo: string) => new File(["x"], nome, { type: tipo });
const escolher = (campo: HTMLInputElement, escolhido: File) => fireEvent.change(campo, { target: { files: [escolhido] } });

function abrirPassoDasImagens() {
  render(<Network />);
  fireEvent.click(screen.getByRole("button", { name: "Novo" }));
  fireEvent.change(screen.getByPlaceholderText("Nome completo do contato"), { target: { value: "Ana Lima" } });
  for (let passo = 1; passo < 4; passo++) fireEvent.click(screen.getByRole("button", { name: "Próximo →" }));
  return {
    foto: screen.getByLabelText("Enviar foto") as HTMLInputElement,
    cartao: screen.getByLabelText("Enviar cartão") as HTMLInputElement,
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/network");
});

describe("Minha Rede — foto e cartão preparam cada um no seu campo", () => {
  it("escolher o cartão no meio da foto não destrava a foto, e o cartão pronto não destrava a foto ainda em preparo", async () => {
    const { foto, cartao } = abrirPassoDasImagens();
    const preparoDaFoto = adiada<ImagemParaEnviar>();
    const preparoDoCartao = adiada<ImagemParaEnviar>();
    vi.mocked(prepararImagemParaEnvio)
      .mockReturnValueOnce(preparoDaFoto.promessa)
      .mockReturnValueOnce(preparoDoCartao.promessa);

    escolher(foto, arquivo("foto.jpg", "image/jpeg"));
    expect(foto).toBeDisabled();
    expect(cartao).not.toBeDisabled();

    escolher(cartao, arquivo("cartao.png", "image/png"));
    expect(cartao).toBeDisabled();
    expect(foto).toBeDisabled();

    await act(async () => { preparoDoCartao.resolver(reduzida("CCCC")); });
    expect(cartao).not.toBeDisabled();
    expect(foto).toBeDisabled();
    expect(duble.enviarCartao).toHaveBeenCalledWith(
      { fileName: "cartao.png", mimeType: "image/webp", dataBase64: "data:image/webp;base64,CCCC" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(duble.enviarFoto).not.toHaveBeenCalled();

    await act(async () => { preparoDaFoto.resolver(reduzida("FFFF")); });
    expect(foto).not.toBeDisabled();
    expect(duble.enviarFoto).toHaveBeenCalledWith(
      { fileName: "foto.jpg", mimeType: "image/webp", dataBase64: "data:image/webp;base64,FFFF" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    // A foto reduz para o avatar; o cartão, para o texto continuar legível.
    expect(vi.mocked(prepararImagemParaEnvio).mock.calls.map(([, lado]) => lado)).toEqual([512, 1600]);
  });

  it("falha de leitura: avisa, não envia e destrava só aquele campo", async () => {
    const { foto } = abrirPassoDasImagens();
    vi.mocked(prepararImagemParaEnvio).mockRejectedValueOnce(new Error("Não foi possível ler o arquivo."));

    await act(async () => { escolher(foto, arquivo("foto.jpg", "image/jpeg")); });

    expect(toast.error).toHaveBeenCalledWith("Não foi possível ler o arquivo. Tente de novo.");
    expect(foto).not.toBeDisabled();
    expect(duble.enviarFoto).not.toHaveBeenCalled();
  });
});

describe("Minha Rede — erro do envio no idioma da tela", () => {
  it("a mensagem de sessão do servidor (em inglês) vira o texto traduzido; sem mensagem, o texto da tela", async () => {
    const { foto, cartao } = abrirPassoDasImagens();
    vi.mocked(prepararImagemParaEnvio).mockResolvedValue(reduzida("FFFF"));
    duble.enviarFoto.mockImplementation((_dados: unknown, opcoes: OpcoesDoEnvio) => opcoes.onError({ message: UNAUTHED_ERR_MSG }));
    duble.enviarCartao.mockImplementation((_dados: unknown, opcoes: OpcoesDoEnvio) => opcoes.onError({ message: "" }));

    await act(async () => { escolher(foto, arquivo("foto.jpg", "image/jpeg")); });
    await act(async () => { escolher(cartao, arquivo("cartao.png", "image/png")); });

    expect(vi.mocked(toast.error).mock.calls.map(([texto]) => texto)).toEqual([
      "Faça login para continuar.",
      "Não foi possível enviar a imagem.",
    ]);
  });
});
