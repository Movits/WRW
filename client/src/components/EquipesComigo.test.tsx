import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Na lista de Reuniões (R2): os convites de conexão para equipes (aceitar ou
 * recusar) e as equipes de que a conta é membra. Sem nenhum dos dois, nada.
 */
const duble = vi.hoisted(() => ({
  consulta: { data: undefined as unknown },
  responder: { mutate: vi.fn(), isPending: false },
  opcoes: null as null | { onSuccess?: (dados: { pastaId: string }, pedido: { aceitar: boolean }) => Promise<void> | void },
  navegar: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ equipes: { minhas: { invalidate: vi.fn(async () => undefined) } } }),
    equipes: {
      minhas: { useQuery: () => duble.consulta },
      responderConvite: { useMutation: (opcoes: typeof duble.opcoes) => { duble.opcoes = opcoes; return duble.responder; } },
    },
  },
}));
const { EquipesComigo } = await import("./EquipesComigo");
const PASTA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const MEMBRA = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

beforeEach(() => { duble.responder.mutate.mockReset(); duble.navegar.mockReset(); });

describe("equipes comigo", () => {
  it("sem convites nem equipes, nada aparece", () => {
    duble.consulta.data = { equipes: [], convites: [] };
    const { container } = render(<EquipesComigo/>);
    expect(container).toBeEmptyDOMElement();
  });

  it("o convite aceita ou recusa pelo id da membra; aceito, abre a equipe; a equipe abre a página dela", async () => {
    duble.consulta.data = {
      convites: [{ membraId: MEMBRA, pastaId: PASTA, nome: "Vendas", icone: "pasta", cor: "ambar", papel: "member", nomeDaDona: "Dona Clara", expiraEm: 2 }],
      equipes: [{ pastaId: PASTA, nome: "Jurídico", icone: "livro", cor: "azul", papel: "reader", nomeDaDona: "Dona Clara" }],
    };
    render(<EquipesComigo/>);
    expect(screen.getByText("Equipe de Dona Clara · Membro")).toBeInTheDocument();
    expect(screen.getByText("Equipe de Dona Clara · Leitor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recusar" }));
    fireEvent.click(screen.getByRole("button", { name: "Aceitar" }));
    expect(duble.responder.mutate.mock.calls.map(([pedido]) => pedido)).toEqual([{ membraId: MEMBRA, aceitar: false }, { membraId: MEMBRA, aceitar: true }]);
    await act(async () => { await duble.opcoes?.onSuccess?.({ pastaId: PASTA }, { aceitar: true }); });
    expect(duble.navegar).toHaveBeenCalledWith(`/equipes/${PASTA}`);
    fireEvent.click(screen.getByRole("button", { name: /Jurídico/ }));
    expect(duble.navegar).toHaveBeenCalledTimes(2);
  });
});
