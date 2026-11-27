import { act, fireEvent, render, screen } from "@testing-library/react";
import { Route } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reunião compartilhada com a participante (R1b): a mesma leitura do link,
 * pela credencial "participante:<id>", com quem compartilhou, quem mais
 * participa e o "Sair desta reunião". A leitura do link (LeituraDaReuniao) é
 * um marcador que mostra o que recebeu; ela está em ReuniaoAberta.test.tsx.
 */
const duble = vi.hoisted(() => ({
  participantes: { data: undefined as unknown },
  sair: { mutate: vi.fn(), isPending: false },
  opcoesDoSair: null as null | { onSuccess?: () => Promise<void> | void },
  navegar: vi.fn(),
  leitura: null as null | { token: string; naoEncontrada?: unknown },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { compartilhadasComigo: { invalidate: vi.fn(async () => undefined) } } }),
    meetings: {
      participantes: { useQuery: () => duble.participantes },
      sairDaReuniao: { useMutation: (opcoes: { onSuccess?: () => Promise<void> }) => { duble.opcoesDoSair = opcoes; return duble.sair; } },
    },
  },
}));
vi.mock("./ReuniaoAberta", () => ({
  LeituraDaReuniao: (props: { token: string; cabecalhoDaParticipante?: unknown; naoEncontrada?: unknown }) => {
    duble.leitura = props;
    return <div><span data-testid="credencial">{props.token}</span>{props.cabecalhoDaParticipante as never}</div>;
  },
}));

const { default: ReuniaoCompartilhada } = await import("./ReuniaoCompartilhada");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function abrir() {
  window.history.replaceState(null, "", `/reunioes-compartilhadas/${ID}`);
  return render(<Route path="/reunioes-compartilhadas/:id" component={ReuniaoCompartilhada}/>);
}

beforeEach(() => {
  duble.sair.mutate.mockReset();
  duble.navegar.mockReset();
  duble.participantes.data = { papel: "participante", nomeDaDona: "Dona Clara", participantes: [{ nome: "Ana", souEu: true }, { nome: "Bia", souEu: false }] };
});

describe("a reunião compartilhada com a participante", () => {
  it("lê pela credencial da participante, com quem compartilhou e quem participa", () => {
    abrir();
    expect(screen.getByTestId("credencial")).toHaveTextContent(`participante:${ID}`);
    expect(screen.getByText("Compartilhada por Dona Clara")).toBeInTheDocument();
    expect(screen.getByText("Ana (você)")).toBeInTheDocument();
    expect(screen.getByText("Bia")).toBeInTheDocument();
    expect(duble.leitura?.naoEncontrada).toBeTruthy();
  });

  it("sair pede confirmação, sai pelo id da reunião e volta à lista", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Sair desta reunião" }));
    expect(duble.sair.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("o dono precisa convidar você de novo");
    fireEvent.click(screen.getByRole("button", { name: "Sair desta reunião" }));
    expect(duble.sair.mutate).toHaveBeenCalledWith({ meetingId: ID });
    await act(async () => { await duble.opcoesDoSair?.onSuccess?.(); });
    expect(duble.navegar).toHaveBeenCalledWith("/meetings");
  });
});
