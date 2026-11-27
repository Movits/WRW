import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ConexaoRegistrada, type ConexaoNaTela } from "./ConexoesRegistradas";

/**
 * O cartão da conexão cujo outro lado é associado de uma entidade (N2), com o
 * tRPC dublado: "membro de uma entidade parceira" (ou o nome, quando o convênio
 * autoriza), o pedido que só sai com a ciência do nome, o estado do pedido e o
 * contato que só aparece no aceito, a pedido.
 */
const duble = vi.hoisted(() => ({
  avancar: vi.fn(), pedir: vi.fn(), revelar: vi.fn(), revelado: undefined as unknown,
  utils: { networkInteligente: { conexoes: { invalidate: vi.fn() }, contato: { invalidate: vi.fn() } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("wouter", () => ({ Link: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    networkInteligente: {
      avancarConexao: { useMutation: () => ({ mutate: duble.avancar, isPending: false }) },
      pedirContatoPelaEntidade: { useMutation: () => ({ mutate: duble.pedir, isPending: false }) },
      contatoPeloPedido: { useMutation: () => ({ mutate: duble.revelar, isPending: false, data: duble.revelado }) },
    },
  },
}));

const base = (extra: Partial<ConexaoNaTela> = {}): ConexaoNaTela => ({
  id: "11111111-2222-4333-8444-555555555555",
  origem: "NETWORK_PLATFORM_MATCH",
  itens: [{ tem: "Café torrado", precisa: "Café para revenda", deCodigo: "NW-AB12CD", paraCodigo: null }],
  status: "identificada", statusComissao: "sem_negocio", criadaEm: Date.UTC(2026, 10, 20),
  lados: [
    { lado: "a", tipo: "contato", contactId: null, codigoAnonimo: "NW-AB12CD", meu: false, originador: false, statusComissaoOriginador: null, entidade: { nome: null } },
    { lado: "b", tipo: "membro", contactId: null, codigoAnonimo: null, meu: true, originador: false, statusComissaoOriginador: null },
  ],
  pedidoPelaEntidade: null, podePedirPelaEntidade: true,
  ...extra,
});

beforeEach(() => { duble.revelado = undefined; });
afterEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("pt-BR"); });

describe("PedidoPelaEntidade", () => {
  it("sem autorização do convênio, o outro lado é só 'membro de uma entidade parceira'", () => {
    render(<ConexaoRegistrada conexao={base()} />);
    expect(screen.getByText(/membro de uma entidade parceira/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pedir contato pela entidade" })).toBeInTheDocument();
  });

  it("com a autorização, aparece o nome da entidade", () => {
    const conexao = base();
    conexao.lados[0].entidade = { nome: "Associação X" };
    render(<ConexaoRegistrada conexao={conexao} />);
    expect(screen.getByText(/membro da entidade Associação X/)).toBeInTheDocument();
  });

  it("o pedido só sai com a ciência do nome, e leva a mensagem", () => {
    render(<ConexaoRegistrada conexao={base()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pedir contato pela entidade" }));
    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText(/vai à entidade com o seu nome/)).toBeInTheDocument();
    const enviar = within(dialogo).getByRole("button", { name: "Enviar o pedido" });
    expect(enviar).toBeDisabled();
    fireEvent.change(within(dialogo).getByRole("textbox"), { target: { value: "Quero comprar café" } });
    fireEvent.click(within(dialogo).getByRole("checkbox"));
    fireEvent.click(enviar);
    expect(duble.pedir).toHaveBeenCalledWith({ conexaoId: base().id, mensagem: "Quero comprar café", cienteDoNome: true });
  });

  it("com o pedido aberto, mostra o estado e não oferece pedir de novo", () => {
    render(<ConexaoRegistrada conexao={base({
      podePedirPelaEntidade: false,
      pedidoPelaEntidade: { id: "p1", estado: "na_entidade", criadoEm: 1, expiraEm: Date.UTC(2026, 11, 20), decididoEm: null, canal: null },
    })} />);
    expect(screen.getByText("Pedido com a entidade")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pedir/ })).toBeNull();
  });

  it("no aceito, o contato só aparece quando ela pede para ver", () => {
    const pedido = { id: "p1", estado: "aceito" as const, criadoEm: 1, expiraEm: 2, decididoEm: 3, canal: "email" as const };
    const { rerender } = render(<ConexaoRegistrada conexao={base({ podePedirPelaEntidade: false, pedidoPelaEntidade: pedido })} />);
    expect(screen.queryByTestId("contato-pelo-pedido")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ver o contato" }));
    expect(duble.revelar).toHaveBeenCalledWith({ pedidoId: "p1" });
    duble.revelado = { empresa: "Empresa Um", telefone: null, email: "um@exemplo.com" };
    rerender(<ConexaoRegistrada conexao={base({ podePedirPelaEntidade: false, pedidoPelaEntidade: pedido })} />);
    expect(screen.getByTestId("contato-pelo-pedido")).toHaveTextContent("Empresa Um");
    expect(screen.getByTestId("contato-pelo-pedido")).toHaveTextContent("E-mail: um@exemplo.com");
  });

  it("em árabe, a tela traduz o lado e o botão", async () => {
    await i18n.changeLanguage("ar");
    render(<ConexaoRegistrada conexao={base()} />);
    expect(screen.getByText(/عضو في جهة شريكة/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "اطلب التواصل عبر الجهة" })).toBeInTheDocument();
  });
});
