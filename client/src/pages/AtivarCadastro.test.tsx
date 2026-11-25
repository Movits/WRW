import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import AtivarCadastro from "./AtivarCadastro";

/**
 * A ativação do cadastro importado (N3), pública: a página mostra a entidade,
 * a empresa e os itens que ela mandou, todos marcados; o que a pessoa desmarca
 * não vai; a senha curta ou repetida errado não chega ao servidor; o sucesso
 * recarrega no cadastro; o e-mail já cadastrado mostra o código traduzido; o
 * link que não vale diz só isso; o banco fora do ar é erro, nunca "link
 * inválido". Em árabe, a tela traduz e o e-mail fica da esquerda para a direita.
 */
const duble = vi.hoisted(() => ({
  ver: vi.fn(), ativar: vi.fn(),
  opcoes: {} as { onSuccess?: () => void; onError?: (e: { message: string; data?: unknown }) => void },
}));
vi.mock("wouter", async importOriginal => ({ ...(await importOriginal<object>()), useParams: () => ({ token: "tok_ATIVACAOABCDEFGHIJKLMN" }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    ativacaoDeCadastro: {
      ver: { useQuery: (entrada: unknown) => duble.ver(entrada) },
      ativar: {
        useMutation: (opcoes: typeof duble.opcoes) => {
          duble.opcoes = opcoes;
          return { mutate: duble.ativar, isPending: false };
        },
      },
    },
  },
}));

const VISTA = {
  entidade: "Associação Teste", pais: "BR", empresa: "Empresa Um", uf: null,
  tenho: ["Café torrado", "Frete rodoviário"], preciso: ["Embalagens"], expiraEm: Date.UTC(2026, 11, 25, 12),
};
const consulta = (data: unknown, error: unknown = null) => ({ data, isLoading: false, error, refetch: vi.fn() });

let local: { href: string };
beforeEach(() => {
  local = { href: "/ativar/x" };
  Object.defineProperty(window, "location", { value: local, configurable: true, writable: true });
});
afterEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("pt-BR");
});

function preencher(senha = "senha-forte-123", repetida = senha) {
  fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Pessoa da Empresa" } });
  fireEvent.change(screen.getByLabelText("Seu e-mail"), { target: { value: "pessoa@exemplo.com" } });
  fireEvent.change(screen.getByLabelText("Crie uma senha"), { target: { value: senha } });
  fireEvent.change(screen.getByLabelText("Repita a senha"), { target: { value: repetida } });
}

describe("AtivarCadastro", () => {
  it("mostra a entidade, a empresa e os itens marcados; manda só o que ficou marcado", () => {
    duble.ver.mockReturnValue(consulta(VISTA));
    render(<AtivarCadastro />);
    expect(duble.ver).toHaveBeenCalledWith({ token: "tok_ATIVACAOABCDEFGHIJKLMN" });
    expect(screen.getByRole("heading")).toHaveTextContent("Ative o cadastro da Empresa Um");
    expect(screen.getByText("Cadastro enviado por Associação Teste")).toBeInTheDocument();
    expect(screen.getByLabelText("Café torrado")).toBeChecked();
    expect(screen.getByLabelText("Embalagens")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Frete rodoviário"));
    fireEvent.change(screen.getByLabelText("Nome da empresa"), { target: { value: "Empresa Um Ltda" } });
    preencher();
    fireEvent.click(screen.getByRole("button", { name: "Ativar o cadastro" }));
    expect(duble.ativar).toHaveBeenCalledWith({
      token: "tok_ATIVACAOABCDEFGHIJKLMN", nome: "Pessoa da Empresa", email: "pessoa@exemplo.com", senha: "senha-forte-123",
      empresa: "Empresa Um Ltda", tenho: ["Café torrado"], preciso: ["Embalagens"],
    });
  });

  it("senha curta ou repetida errado não vai ao servidor", () => {
    duble.ver.mockReturnValue(consulta(VISTA));
    render(<AtivarCadastro />);
    preencher("senha-forte-123", "outra-senha-456");
    fireEvent.submit(screen.getByRole("button", { name: "Ativar o cadastro" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("As senhas não são iguais.");
    preencher("curta", "curta");
    fireEvent.submit(screen.getByRole("button", { name: "Ativar o cadastro" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("pelo menos 8 caracteres");
    expect(duble.ativar).not.toHaveBeenCalled();
  });

  it("sucesso recarrega no cadastro; e-mail já cadastrado mostra o código traduzido", async () => {
    duble.ver.mockReturnValue(consulta(VISTA));
    render(<AtivarCadastro />);
    duble.opcoes.onSuccess!();
    expect(local.href).toBe("/onboarding");
    duble.opcoes.onError!({ message: "ATIVACAO_EMAIL_JA_CADASTRADO", data: { code: "CONFLICT" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Este e-mail já tem conta."));
  });

  it("link que não vale: só diz isso, sem formulário", () => {
    duble.ver.mockReturnValue(consulta(undefined, { data: { code: "NOT_FOUND" }, message: "ATIVACAO_NAO_ENCONTRADA" }));
    render(<AtivarCadastro />);
    expect(screen.getByRole("alert")).toHaveTextContent("não vale mais");
    expect(screen.queryByLabelText("Crie uma senha")).toBeNull();
  });

  it("banco fora do ar: erro de consulta, não link inválido", () => {
    duble.ver.mockReturnValue(consulta(undefined, { data: { code: "INTERNAL_SERVER_ERROR" }, message: "x" }));
    render(<AtivarCadastro />);
    expect(screen.queryByText(/não vale mais/)).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("em árabe, a tela traduz e o e-mail fica da esquerda para a direita", async () => {
    await i18n.changeLanguage("ar");
    duble.ver.mockReturnValue(consulta(VISTA));
    render(<AtivarCadastro />);
    expect(screen.getByRole("button", { name: "تفعيل التسجيل" })).toBeInTheDocument();
    expect(screen.getByLabelText("بريدك الإلكتروني")).toHaveAttribute("dir", "ltr");
  });
});
