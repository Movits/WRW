import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConviteDaEntidade from "./ConviteDaEntidade";

/**
 * O convite da entidade (N1), público: o nome da entidade e o caminho ao
 * cadastro; o convite que não vale (NOT_FOUND) diz só isso; e o banco fora
 * do ar é erro, nunca "convite inválido".
 */
const duble = vi.hoisted(() => ({ ver: vi.fn() }));
vi.mock("wouter", async importOriginal => ({ ...(await importOriginal<object>()), useParams: () => ({ token: "tok_ABCDEFGHIJKLMNOPQRSTUVWX" }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { conviteDeEntidade: { ver: { useQuery: (entrada: unknown) => duble.ver(entrada) } } } }));

afterEach(() => vi.clearAllMocks());

describe("ConviteDaEntidade", () => {
  it("mostra a entidade e leva ao cadastro", () => {
    duble.ver.mockReturnValue({ data: { nome: "Associação Teste", pais: "BR" }, isLoading: false, error: null });
    render(<ConviteDaEntidade />);
    expect(duble.ver).toHaveBeenCalledWith({ token: "tok_ABCDEFGHIJKLMNOPQRSTUVWX" });
    expect(screen.getByRole("heading")).toHaveTextContent("Associação Teste convida você");
    expect(screen.getByRole("link", { name: "Criar minha conta" })).toHaveAttribute("href", "/register");
  });

  it("convite que não vale: só diz isso", () => {
    duble.ver.mockReturnValue({ data: undefined, isLoading: false, error: { data: { code: "NOT_FOUND" }, message: "CONVITE_NAO_ENCONTRADO" } });
    render(<ConviteDaEntidade />);
    expect(screen.getByRole("alert")).toHaveTextContent("não vale mais");
  });

  it("banco fora do ar: erro de consulta, não convite inválido", () => {
    duble.ver.mockReturnValue({ data: undefined, isLoading: false, error: { data: { code: "INTERNAL_SERVER_ERROR" }, message: "x" }, refetch: vi.fn() });
    render(<ConviteDaEntidade />);
    expect(screen.queryByText(/não vale mais/)).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
