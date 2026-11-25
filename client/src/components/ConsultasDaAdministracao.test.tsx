import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsultasDaAdministracao } from "./ConsultasDaAdministracao";

/**
 * As datas das consultas da administração no detalhe da dona (R1a): só a
 * data, uma vez por dia; nada sem consulta; a falha é erro, nunca "nenhuma".
 */
const duble = vi.hoisted(() => ({ resposta: {} as Record<string, unknown>, entradas: [] as unknown[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    meetings: {
      consultasDaAdministracao: {
        useQuery: (entrada: unknown) => {
          duble.entradas.push(entrada);
          return { data: undefined, isError: false, error: null, refetch: () => undefined, ...duble.resposta };
        },
      },
    },
  },
}));

beforeEach(() => {
  duble.resposta = {};
  duble.entradas = [];
});

describe("as consultas da administração, para a dona", () => {
  it("mostra a data de cada dia de consulta, sem repetir o dia, e pede pela reunião certa", () => {
    duble.resposta = { data: [Date.UTC(2026, 10, 25, 15), Date.UTC(2026, 10, 25, 14), Date.UTC(2026, 10, 24, 15)] };
    render(<ConsultasDaAdministracao meetingId="r-1" />);
    expect(screen.getByTestId("consultas-da-administracao")).toHaveTextContent(
      "A administração da Marquesa Global Match consultou esta reunião em: 25/11/2026, 24/11/2026.",
    );
    expect(duble.entradas[0]).toEqual({ meetingId: "r-1" });
  });

  it("sem consulta, nada aparece", () => {
    duble.resposta = { data: [] };
    const { container } = render(<ConsultasDaAdministracao meetingId="r-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a leitura que falhou é erro, não 'nenhuma consulta'", () => {
    duble.resposta = { isError: true, error: new Error("fora do ar") };
    render(<ConsultasDaAdministracao meetingId="r-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
