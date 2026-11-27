import { act, fireEvent, render, screen } from "@testing-library/react";
import { Route } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A página do convite da equipe (R2): o convite válido mostra a equipe, a
 * dona, o papel e o aviso, e entra; o inválido tem uma frase só, sem nome; a
 * dona que abre o próprio convite vai à equipe, sem o botão de entrar.
 */
const duble = vi.hoisted(() => ({
  convite: { data: undefined as unknown, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  aceitar: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  opcoes: null as null | { onSuccess?: (dados: { pastaId: string }) => Promise<void> | void },
  navegar: vi.fn(),
}));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ equipes: { minhas: { invalidate: vi.fn(async () => undefined) } } }),
    equipes: {
      verConvite: { useQuery: () => duble.convite },
      aceitarConvite: { useMutation: (opcoes: typeof duble.opcoes) => { duble.opcoes = opcoes; return duble.aceitar; } },
    },
  },
}));
const { default: ConviteDaEquipe } = await import("./ConviteDaEquipe");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PASTA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function abrir() {
  window.history.replaceState(null, "", `/convite-da-equipe/${TOKEN}`);
  return render(<Route path="/convite-da-equipe/:token" component={ConviteDaEquipe}/>);
}
beforeEach(() => { duble.aceitar.mutate.mockReset(); duble.navegar.mockReset(); });

describe("a página do convite da equipe", () => {
  it("válido: a equipe, a dona, o papel e o aviso; entrar aceita pelo token e abre a equipe", async () => {
    duble.convite.data = { valido: true, pastaId: PASTA, nome: "Vendas Sul", nomeDaDona: "Dona Clara", papel: "reader", propria: false, jaEsta: false, expiraEm: 1 };
    abrir();
    expect(screen.getByRole("heading", { name: "Vendas Sul" })).toBeInTheDocument();
    expect(screen.getByText("Equipe de Dona Clara")).toBeInTheDocument();
    expect(screen.getByText("Seu papel: Leitor")).toBeInTheDocument();
    expect(screen.getByText(/você aparece para o dono e para os membros desta equipe/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entrar na equipe" }));
    expect(duble.aceitar.mutate).toHaveBeenCalledWith({ token: TOKEN });
    await act(async () => { await duble.opcoes?.onSuccess?.({ pastaId: PASTA }); });
    expect(duble.navegar).toHaveBeenCalledWith(`/equipes/${PASTA}`);
  });

  it("inválido: a frase única, sem nome nenhum", () => {
    duble.convite.data = { valido: false };
    abrir();
    expect(screen.getByRole("alert")).toHaveTextContent("Este convite não vale mais");
    expect(screen.queryByRole("button", { name: "Entrar na equipe" })).toBeNull();
  });

  it("a dona que abre o próprio convite não entra: abre a equipe", () => {
    duble.convite.data = { valido: true, pastaId: PASTA, nome: "Vendas Sul", nomeDaDona: "Dona Clara", papel: "member", propria: true, jaEsta: false, expiraEm: 1 };
    abrir();
    expect(screen.queryByRole("button", { name: "Entrar na equipe" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir a equipe" }));
    expect(duble.navegar).toHaveBeenCalledWith(`/equipes/${PASTA}`);
  });
});
