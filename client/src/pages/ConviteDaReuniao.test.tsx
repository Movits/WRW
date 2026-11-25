import { act, fireEvent, render, screen } from "@testing-library/react";
import { Route } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A página do convite (R1b): o convite válido mostra o título, a dona e o
 * aviso, e entra; o inválido (não existe, venceu ou já foi usado) tem uma
 * frase só, sem título; a dona que abre o próprio convite vai ao detalhe dela.
 */
const duble = vi.hoisted(() => ({
  convite: { data: undefined as unknown, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  aceitar: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  opcoes: null as null | { onSuccess?: (dados: { meetingId: string }) => Promise<void> | void },
  navegar: vi.fn(),
}));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { compartilhadasComigo: { invalidate: vi.fn(async () => undefined) } } }),
    meetings: {
      verConvite: { useQuery: () => duble.convite },
      aceitarConvite: { useMutation: (opcoes: typeof duble.opcoes) => { duble.opcoes = opcoes; return duble.aceitar; } },
    },
  },
}));
const { default: ConviteDaReuniao } = await import("./ConviteDaReuniao");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function abrir() {
  window.history.replaceState(null, "", `/convite/${TOKEN}`);
  return render(<Route path="/convite/:token" component={ConviteDaReuniao}/>);
}
beforeEach(() => { duble.aceitar.mutate.mockReset(); duble.navegar.mockReset(); });

describe("a página do convite", () => {
  it("válido: o título, a dona e o aviso de quem vê o quê; entrar aceita pelo token e abre a reunião compartilhada", async () => {
    duble.convite.data = { valido: true, meetingId: ID, titulo: "Reunião de vendas", nomeDaDona: "Dona Clara", propria: false, jaParticipa: false, expiraEm: 1 };
    abrir();
    expect(screen.getByRole("heading", { name: "Reunião de vendas" })).toBeInTheDocument();
    expect(screen.getByText("Compartilhada por Dona Clara")).toBeInTheDocument();
    expect(screen.getByText(/o seu nome aparece também para quem tiver o link aberto/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entrar na reunião" }));
    expect(duble.aceitar.mutate).toHaveBeenCalledWith({ token: TOKEN });
    await act(async () => { await duble.opcoes?.onSuccess?.({ meetingId: ID }); });
    expect(duble.navegar).toHaveBeenCalledWith(`/reunioes-compartilhadas/${ID}`);
  });

  it("inválido: a frase única, sem título nem nome", () => {
    duble.convite.data = { valido: false };
    abrir();
    expect(screen.getByRole("alert")).toHaveTextContent("Este convite não vale mais");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Entrar na reunião" })).not.toBeInTheDocument();
  });

  it("a dona que abre o próprio convite vai ao detalhe dela, sem entrar", () => {
    duble.convite.data = { valido: true, meetingId: ID, titulo: "Minha", nomeDaDona: "Eu", propria: true, jaParticipa: false, expiraEm: 1 };
    abrir();
    expect(screen.queryByRole("button", { name: "Entrar na reunião" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir a reunião" }));
    expect(duble.navegar).toHaveBeenCalledWith(`/meetings/${ID}`);
  });
});
