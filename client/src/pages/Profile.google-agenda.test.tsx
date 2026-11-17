import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * A seção da Google Agenda (H16b) entra no Perfil fora da edição, antes da
 * zona de risco, como a exclusão da conta: na edição, não compete com o botão
 * de salvar. O que a seção faz por dentro está em
 * components/ConexaoGoogleAgenda.test.tsx.
 */

vi.mock("@/lib/trpc", () => ({
  trpc: {
    profile: {
      get: { useQuery: () => ({ data: { user: { name: "Ana" }, profile: { displayName: "Ana Souza", country: "BR" } }, isLoading: false }) },
      update: { useMutation: () => ({ mutate: () => {}, isPending: false }) },
    },
    assistenteTexto: {
      revisar: { useMutation: () => ({ mutateAsync: async () => ({ revisado: "", mudou: false }), isPending: false }) },
      transcrever: { useMutation: () => ({ mutateAsync: async () => ({ texto: "" }), isPending: false }) },
    },
    useUtils: () => ({ profile: { get: { invalidate: vi.fn() } }, auth: { me: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { name: "Ana", email: "ana@exemplo.com", role: "silver" } }) }));
vi.mock("@/components/ExcluirMinhaConta", () => ({ ExcluirMinhaConta: () => <div data-testid="zona-de-risco" /> }));
vi.mock("@/components/ConexaoGoogleAgenda", () => ({ ConexaoGoogleAgenda: () => <div data-testid="google-agenda" /> }));
vi.mock("@/components/ChavesDeAcesso", () => ({ ChavesDeAcesso: () => <div data-testid="chaves-de-acesso" /> }));
vi.mock("@/components/QualificacaoDoPerfil", () => ({ QualificacaoDoPerfil: () => null }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

describe("Perfil — a seção da Google Agenda", () => {
  it("aparece na leitura, antes da zona de risco", () => {
    render(<Profile />);
    const secao = screen.getByTestId("google-agenda");
    const zona = screen.getByTestId("zona-de-risco");
    expect(secao.compareDocumentPosition(zona) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("some durante a edição, como a zona de risco", () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    expect(screen.queryByTestId("google-agenda")).not.toBeInTheDocument();
    expect(screen.queryByTestId("zona-de-risco")).not.toBeInTheDocument();
  });
});
