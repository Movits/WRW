import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Na lista de Reuniões (R1b): os convites de conexão (aceitar ou recusar) e
 * as reuniões compartilhadas com a conta. Sem nenhum dos dois, nada aparece.
 */
const duble = vi.hoisted(() => ({
  consulta: { data: undefined as unknown },
  responder: { mutate: vi.fn(), isPending: false },
  opcoes: null as null | { onSuccess?: (dados: { meetingId: string }, pedido: { aceitar: boolean }) => Promise<void> | void },
  navegar: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { compartilhadasComigo: { invalidate: vi.fn(async () => undefined) } } }),
    meetings: {
      compartilhadasComigo: { useQuery: () => duble.consulta },
      responderConviteDeConexao: { useMutation: (opcoes: typeof duble.opcoes) => { duble.opcoes = opcoes; return duble.responder; } },
    },
  },
}));
const { CompartilhadasComigo } = await import("./CompartilhadasComigo");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PART = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

beforeEach(() => { duble.responder.mutate.mockReset(); duble.navegar.mockReset(); });

describe("compartilhadas comigo", () => {
  it("sem convites nem reuniões, nada aparece", () => {
    duble.consulta.data = { reunioes: [], convites: [] };
    const { container } = render(<CompartilhadasComigo/>);
    expect(container).toBeEmptyDOMElement();
  });

  it("o convite aceita ou recusa pelo id da participação; aceito, abre a reunião; a compartilhada abre a leitura", async () => {
    duble.consulta.data = {
      convites: [{ participanteId: PART, meetingId: ID, titulo: "Convite A", nomeDaDona: "Dona Clara", criadaEm: 1, expiraEm: 2 }],
      reunioes: [{ meetingId: ID, titulo: "Reunião B", nomeDaDona: "Dona Clara", criadaEm: 1 }],
    };
    render(<CompartilhadasComigo/>);
    fireEvent.click(screen.getByRole("button", { name: "Recusar" }));
    fireEvent.click(screen.getByRole("button", { name: "Aceitar" }));
    expect(duble.responder.mutate.mock.calls.map(([pedido]) => pedido)).toEqual([{ participanteId: PART, aceitar: false }, { participanteId: PART, aceitar: true }]);
    await act(async () => { await duble.opcoes?.onSuccess?.({ meetingId: ID }, { aceitar: true }); });
    expect(duble.navegar).toHaveBeenCalledWith(`/reunioes-compartilhadas/${ID}`);
    fireEvent.click(screen.getByRole("button", { name: /Reunião B/ }));
    expect(duble.navegar).toHaveBeenCalledTimes(2);
  });
});
