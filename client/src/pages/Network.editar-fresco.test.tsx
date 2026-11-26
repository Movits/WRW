import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Network from "./Network";

/**
 * Minha Rede — o detalhe do contato lê o contato FRESCO, e "Editar" abre com ele.
 *
 * A lista é um retrato de quando foi carregada. O chat de enriquecimento grava
 * o telefone no servidor e invalida network.get; o detalhe passou a ler por
 * ele (PR-C). A revisão achou a segunda metade: "Editar" ainda abria o
 * formulário com o retrato da lista (`viewContact`), então o Telefone vinha
 * vazio e Salvar mandava `phone: null` — apagando o dado que o chat acabara
 * de confirmar. Aqui a lista traz phone null e network.get traz o telefone.
 *
 * O tRPC vira um dublê (molde de Network.desfazer.test.tsx), com network.get
 * como vi.fn para ler com o que foi chamado.
 */

type Vars = Record<string, unknown>;
type Opcoes = { onSuccess?: (data: unknown, vars: Vars) => void; onError?: (erro: unknown, vars: Vars) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes?: Opcoes) => {
      const m = (mutacoes[nome] ??= { opcoes: opcoes ?? {}, mutate: vi.fn() });
      m.opcoes = opcoes ?? {};
      return { mutate: m.mutate, isPending: false };
    },
  });
  const consulta = (data: unknown = undefined) => ({ useQuery: () => ({ data, isLoading: false, isError: false, refetch: vi.fn() }) });
  return {
    mutacoes,
    registrar,
    consulta,
    contatos: [] as unknown[],
    /** network.get: o que o servidor responde para o contato aberto. */
    get: vi.fn(),
  };
});

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, openId: "dona-1" }, isAuthenticated: true, loading: false }),
}));
vi.mock("@/components/EnrichmentChat", () => ({ EnrichmentChat: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      network: { assetsNeeds: { invalidate: vi.fn() }, get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } },
      enrichment: { getHistory: { invalidate: vi.fn() } },
    }),
    network: {
      list: { useQuery: () => ({ data: { data: duble.contatos, total: duble.contatos.length }, isLoading: false, refetch: vi.fn() }) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      create: duble.registrar("create"),
      update: duble.registrar("update"),
      delete: duble.registrar("delete"),
      uploadPhoto: duble.registrar("uploadPhoto"),
      uploadCard: duble.registrar("uploadCard"),
      assetsNeeds: duble.consulta({ possui: [], procura: [] }),
      removeAsset: duble.registrar("removeAsset"),
      removeNeed: duble.registrar("removeNeed"),
      addItem: duble.registrar("addItem"),
      editItem: duble.registrar("editItem"),
    },
    enrichment: {
      startSession: duble.registrar("startSession"),
      getHistory: duble.consulta({ data: [], total: 0 }),
      undoSuggestion: duble.registrar("undoSuggestion"),
    },
    contexts: { listByContact: duble.consulta([]) },
  },
}));

// Na lista, o telefone ainda é null (retrato de antes do chat confirmar).
const daLista = { id: 42, fullName: "Ana Lima", phone: null, whatsapp: null, email: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
const TELEFONE_CONFIRMADO = "11 97777-6666";
const fresco = { ...daLista, phone: TELEFONE_CONFIRMADO, updatedAt: 1_700_000_100_000 };

const campoTelefone = () => screen.getAllByPlaceholderText("+55 11 9 9999-9999")[0] as HTMLInputElement;
const proximo = () => screen.queryByRole("button", { name: /próximo/i });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.contatos = [daLista];
  duble.get.mockReturnValue({ data: fresco, isLoading: false, isError: false, refetch: vi.fn() });
});

describe("Network — o detalhe lê o contato fresco e Editar abre com ele", () => {
  it("o perfil aberto mostra o telefone que só existe no network.get, consultado pelo id do contato", () => {
    render(<Network />);
    fireEvent.click(screen.getByText("Ana Lima"));

    // Mutantes "sem o useQuery, usando o da lista" e "consulta feita mas
    // `data` ignorado": o Telefone não apareceria.
    expect(duble.get).toHaveBeenCalledWith({ id: 42 }, expect.anything());
    expect(screen.getByText("Telefone")).toBeInTheDocument();
    expect(screen.getByText(TELEFONE_CONFIRMADO)).toBeInTheDocument();
  });

  it("Editar abre o formulário com o telefone fresco, e Salvar o manda de volta (não phone: null)", () => {
    render(<Network />);
    fireEvent.click(screen.getByText("Ana Lima"));
    fireEvent.click(screen.getByRole("button", { name: /editar/i }));

    // Passo 2 do formulário: contato.
    fireEvent.click(proximo()!);
    // Mutante "onEdit com viewContact" (o retrato da lista): o campo viria vazio.
    expect(campoTelefone().value).toBe(TELEFONE_CONFIRMADO);

    for (let i = 0; i < 5 && proximo(); i++) fireEvent.click(proximo()!);
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    expect(duble.mutacoes.update.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutacoes.update.mutate).toHaveBeenCalledWith(expect.objectContaining({ id: 42, phone: TELEFONE_CONFIRMADO }));
  });

  it("enquanto o network.get não respondeu, vale o retrato da lista (a tela não fica vazia)", () => {
    duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(<Network />);
    fireEvent.click(screen.getByText("Ana Lima"));

    expect(screen.getAllByText("Ana Lima").length).toBeGreaterThan(1); // lista + detalhe
    expect(screen.queryByText("Telefone")).not.toBeInTheDocument();
  });
});
