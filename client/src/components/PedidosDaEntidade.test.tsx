import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PedidosDaEntidade } from "./PedidosDaEntidade";

/**
 * A fila de pedidos de contato da entidade (N2), com o tRPC dublado: quem pede,
 * o associado e a mensagem; as ações de cada estado; o aceite com o canal; o
 * convênio inativo sem botões; e a tela em árabe.
 */
const duble = vi.hoisted(() => ({
  pedidos: vi.fn(), decidir: vi.fn(),
  utils: { entidades: { pedidos: { invalidate: vi.fn() } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    entidades: {
      pedidos: { useQuery: (entrada: unknown) => duble.pedidos(entrada) },
      decidirPedido: { useMutation: () => ({ mutate: duble.decidir, isPending: false }) },
    },
  },
}));

const consulta = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });
const pedido = (id: string, estado: string, extra: Record<string, unknown> = {}) => ({
  id, estado, canal: null, mensagem: null, criadoEm: Date.UTC(2026, 10, 20), expiraEm: Date.UTC(2026, 11, 20),
  encaminhadoEm: null, decididoEm: null,
  associado: { membroId: 1, codigo: "NW-AB12CD", nome: "Empresa Um" },
  solicitante: { nome: "Marta Membra", empresa: "Torrefação da Marta", ehEntidade: false },
  itens: [{ tem: "Café torrado", precisa: "Café para revenda" }],
  ...extra,
});

beforeEach(() => {
  duble.pedidos.mockReturnValue(consulta({
    total: 2, abertos: 2, pagina: 0, porPagina: 30,
    pedidos: [pedido("p1", "na_entidade", { mensagem: "Quero comprar café" }), pedido("p2", "encaminhado")],
  }));
});
afterEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("pt-BR"); });

describe("PedidosDaEntidade", () => {
  it("mostra quem pede, a empresa dela, o associado, os itens e a mensagem", () => {
    render(<PedidosDaEntidade habilitado />);
    expect(screen.getAllByText("De Marta Membra · Torrefação da Marta")).toHaveLength(2);
    expect(screen.getAllByText("Associado: NW-AB12CD · Empresa Um")).toHaveLength(2);
    expect(screen.getByText("Mensagem: Quero comprar café")).toBeInTheDocument();
    expect(screen.getByText("2 em aberto")).toBeInTheDocument();
    expect(duble.pedidos).toHaveBeenCalledWith({ abertos: true, pagina: 0 });
  });

  it("no novo, encaminha ou não encaminha; no encaminhado, recusa ou aceita com o canal", () => {
    render(<PedidosDaEntidade habilitado />);
    const [novo, comEmpresa] = screen.getAllByRole("listitem");
    fireEvent.click(within(novo).getByRole("button", { name: "Levei à empresa" }));
    expect(duble.decidir).toHaveBeenLastCalledWith({ pedidoId: "p1", acao: "encaminhar", canal: undefined });
    fireEvent.click(within(novo).getByRole("button", { name: "Não encaminhar" }));
    expect(duble.decidir).toHaveBeenLastCalledWith({ pedidoId: "p1", acao: "nao_encaminhar", canal: undefined });
    fireEvent.click(within(comEmpresa).getByRole("button", { name: "A empresa recusou" }));
    expect(duble.decidir).toHaveBeenLastCalledWith({ pedidoId: "p2", acao: "recusar", canal: undefined });
    fireEvent.click(within(comEmpresa).getByRole("button", { name: "A empresa aceitou" }));
    fireEvent.click(within(comEmpresa).getByRole("radio", { name: "E-mail" }));
    fireEvent.click(within(comEmpresa).getByRole("button", { name: "Confirmar o aceite" }));
    expect(duble.decidir).toHaveBeenLastCalledWith({ pedidoId: "p2", acao: "aceitar", canal: "email" });
  });

  it("o filtro 'Todos' pede a lista inteira", () => {
    render(<PedidosDaEntidade habilitado />);
    fireEvent.click(screen.getByRole("button", { name: "Todos" }));
    expect(duble.pedidos).toHaveBeenLastCalledWith({ abertos: false, pagina: 0 });
  });

  it("com o convênio inativo, a lista fica, sem as ações", () => {
    render(<PedidosDaEntidade habilitado={false} />);
    expect(screen.getAllByText("Associado: NW-AB12CD · Empresa Um")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Levei à empresa" })).toBeNull();
    expect(screen.queryByRole("button", { name: "A empresa aceitou" })).toBeNull();
  });

  it("em árabe, a tela traduz o título e as ações", async () => {
    await i18n.changeLanguage("ar");
    render(<PedidosDaEntidade habilitado />);
    expect(screen.getByRole("heading", { name: "طلبات التواصل" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "نقلته إلى الشركة" })).toBeInTheDocument();
  });
});
