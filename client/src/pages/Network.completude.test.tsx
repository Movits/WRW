import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import Network from "./Network";

/**
 * Minha Rede — o que o Meu Network Inteligente acrescenta ao detalhe do
 * contato (pedido do Nicolas, 13/09/2026, item 10):
 *
 * - o alerta "Faltam informações importantes…" com Quem Sou / O Que Tenho /
 *   O Que Preciso, pela mesma régua do painel; some com o contato completo e
 *   não afirma nada enquanto possui/procura não foi lido;
 * - "Completar por texto" rola até o assistente do contato;
 * - o atalho do painel, /network?contato=<id>, abre o detalhe lido do servidor
 *   (que confere a posse), avisa quando o contato não é da dona e limpa o
 *   endereço.
 *
 * O tRPC vira um dublê (molde de Network.editar-fresco.test.tsx).
 */

const duble = vi.hoisted(() => {
  const registrar = () => ({ useMutation: () => ({ mutate: () => {}, isPending: false }) });
  const consulta = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, isError: false, refetch: () => {} }) });
  return { registrar, consulta, contatos: [] as unknown[], get: vi.fn(), assetsNeeds: vi.fn() };
});

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
      list: { useQuery: () => ({ data: { data: duble.contatos, total: duble.contatos.length }, isLoading: false, isError: false, isSuccess: true, fetchStatus: "idle", refetch: () => {} }) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      assetsNeeds: { useQuery: (...args: unknown[]) => duble.assetsNeeds(...args) },
      create: duble.registrar(),
      update: duble.registrar(),
      delete: duble.registrar(),
      uploadPhoto: duble.registrar(),
      uploadCard: duble.registrar(),
      removeAsset: duble.registrar(),
      removeNeed: duble.registrar(),
      addItem: duble.registrar(),
      editItem: duble.registrar(),
    },
    enrichment: {
      startSession: duble.registrar(),
      getHistory: duble.consulta({ data: [], total: 0 }),
      undoSuggestion: duble.registrar(),
    },
    contexts: { listByContact: duble.consulta([]) },
  },
}));

const ana = { id: 42, fullName: "Ana Lima", phone: null, whatsapp: null, email: "ana@exemplo.com", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
const POSSUI = { id: 1, label: "Distribuição farmacêutica", category: null };
const PROCURA = { id: 2, label: "Fornecedores internacionais", category: null };
const ALERTA = "Faltam informações importantes para tornar este contato mais útil para o seu Network Inteligente.";

const respondeu = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: () => {} });
const alerta = () => screen.queryByRole("note", { name: "Informações faltando" });

function abrirDetalhe(contato: typeof ana, possuiProcura: unknown = respondeu({ possui: [POSSUI], procura: [] })) {
  duble.contatos = [contato];
  duble.get.mockReturnValue(respondeu(contato));
  duble.assetsNeeds.mockReturnValue(possuiProcura);
  render(<Network />);
  fireEvent.click(screen.getByText(contato.fullName));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/network");
  duble.contatos = [];
  duble.get.mockReturnValue(respondeu(undefined));
  duble.assetsNeeds.mockReturnValue(respondeu({ possui: [], procura: [] }));
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("Minha Rede — alerta de informações faltando no detalhe do contato", () => {
  it("texto do pedido e o que falta em Quem Sou, O Que Tenho e O Que Preciso", () => {
    abrirDetalhe(ana);
    const nota = alerta()!;
    expect(nota).toBeInTheDocument();
    expect(within(nota).getByText(ALERTA)).toBeInTheDocument();
    expect(within(nota).getByText("Quem Sou")).toBeInTheDocument();
    for (const linha of ["Nome ou razão social ✓", "Telefone — FALTANDO", "E-mail ✓", "O Que Tenho ✓", "O Que Preciso — FALTANDO"]) {
      expect(within(nota).getByText(linha)).toBeInTheDocument();
    }
  });

  it("contato completo: nenhum alerta", () => {
    abrirDetalhe({ ...ana, phone: "+55 11 90000-0001" } as typeof ana, respondeu({ possui: [POSSUI], procura: [PROCURA] }));
    expect(screen.getByText("Fornecedores internacionais")).toBeInTheDocument();
    expect(alerta()).not.toBeInTheDocument();
    expect(screen.queryByText(ALERTA)).not.toBeInTheDocument();
  });

  it("WhatsApp conta como telefone", () => {
    abrirDetalhe({ ...ana, whatsapp: "+55 21 90000-0003" } as typeof ana);
    expect(within(alerta()!).getByText("Telefone ✓")).toBeInTheDocument();
  });

  it("possui/procura em erro: o alerta não afirma que falta O Que Tenho", () => {
    abrirDetalhe(ana, { data: undefined, isLoading: false, isError: true, refetch: () => {} });
    expect(alerta()).not.toBeInTheDocument();
  });

  it("possui/procura carregando: também sem alerta", () => {
    abrirDetalhe(ana, { data: undefined, isLoading: true, isError: false, refetch: () => {} });
    expect(alerta()).not.toBeInTheDocument();
  });

  it("Completar por texto rola até o assistente do contato", () => {
    const rolar = vi.fn();
    Element.prototype.scrollIntoView = rolar;
    abrirDetalhe(ana);
    fireEvent.click(within(alerta()!).getByRole("button", { name: "Completar por texto" }));
    expect(rolar).toHaveBeenCalledTimes(1);
    expect(rolar.mock.contexts[0]).toBe(screen.getByTestId("chat-do-contato").parentElement);
  });
});

describe("Minha Rede — atalho do painel: /network?contato=<id>", () => {
  it("abre o detalhe do contato lido do servidor, mesmo fora da página da lista, e limpa o endereço", () => {
    window.history.replaceState(null, "", "/network?contato=42");
    duble.get.mockReturnValue(respondeu(ana));
    render(<Network />);
    expect(duble.get).toHaveBeenCalledWith({ id: 42 }, expect.objectContaining({ enabled: true, retry: false }));
    expect(screen.getByText("Ana Lima")).toBeInTheDocument();
    expect(alerta()).toBeInTheDocument();
    expect(window.location.pathname).toBe("/network");
    expect(window.location.search).toBe("");
  });

  it("contato de outra dona ou inexistente: aviso, nada abre, endereço limpo", () => {
    window.history.replaceState(null, "", "/network?contato=999");
    duble.get.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "NOT_FOUND" }, refetch: () => {} });
    render(<Network />);
    expect(toast.error).toHaveBeenCalledWith("Esse contato não foi encontrado na sua rede.");
    expect(alerta()).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-do-contato")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("id inválido: o servidor nem é consultado", () => {
    window.history.replaceState(null, "", "/network?contato=abc");
    render(<Network />);
    expect(duble.get).toHaveBeenCalledWith({ id: 0 }, expect.objectContaining({ enabled: false }));
    expect(duble.get).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ enabled: true }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
