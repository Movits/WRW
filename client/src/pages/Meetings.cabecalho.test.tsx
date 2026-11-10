import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O menu nos TRÊS ramos da tela de Reuniões (pedido do Rosber, 14/09: "o ideal é
 * que o menu fique sempre visível na página").
 *
 * A rota /meetings é isenta do cabeçalho global (App.tsx, `cabecalhoProprio`)
 * porque a página monta o seu — mas ela montava só no ramo da LISTA. Quem
 * clicava em "Nova reunião" ou abria uma reunião ficava sem menu nenhum, e o
 * único caminho de volta era o "voltar" de dentro do cartão.
 *
 * O invariante de rota (client/src/App.cabecalho-de-todas-as-telas.test.ts) lê o
 * arquivo; aqui a tela é renderizada de verdade e o cabeçalho é contado ramo a
 * ramo — uma vez, nunca zero, nunca dois.
 */

// vi.mock é içado para o topo do arquivo: o que a fábrica usa nasce em vi.hoisted.
const duble = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  pendencias: vi.fn(),
  mutacao: () => ({ useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }) }),
}));

// O AppHeader de verdade lê sessão e notificações pelo tRPC; aqui ele vira uma
// marca, e o que se prova é que a página o MONTA em cada ramo.
vi.mock("@/components/AppHeader", () => ({
  AppHeader: ({ title }: { title?: string }) => <nav data-testid="cabecalho">{title}</nav>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: { list: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
    }),
    meetings: {
      list: { useQuery: () => duble.list() },
      get: { useQuery: () => duble.get() },
      create: duble.mutacao(),
      submitRecording: duble.mutacao(),
      decideEntity: duble.mutacao(),
      decideContactSuggestion: duble.mutacao(),
      translateTranscript: duble.mutacao(),
      delete: duble.mutacao(),
      reprocess: duble.mutacao(),
      resumir: duble.mutacao(),
      perguntar: duble.mutacao(),
    },
    networkInteligente: { pendencias: { useQuery: () => duble.pendencias() } },
  },
}));

import Meetings from "./Meetings";

const REUNIAO = { id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", title: "Reunião com a vinícola", status: "ready", processingError: null, createdAt: Date.UTC(2026, 8, 4, 12), updatedAt: Date.UTC(2026, 8, 4, 12) };

const cabecalhos = () => screen.queryAllByTestId("cabecalho");

beforeEach(() => {
  duble.list.mockReturnValue({ data: [REUNIAO], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue({
    data: { meeting: REUNIAO, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  });
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  // A URL escolhe o ramo; o setup limpa só o state do histórico.
  window.history.replaceState(null, "", "/meetings");
});

describe("Reuniões — o menu fica visível nos três ramos", () => {
  it("na lista", () => {
    render(<Meetings />);
    expect(screen.getByText("Assistente de Reuniões")).toBeInTheDocument();
    expect(cabecalhos()).toHaveLength(1);
    expect(cabecalhos()[0]).toHaveTextContent("Reuniões");
  });

  it("em 'nova reunião' — o ramo que ficava sem menu", () => {
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));

    expect(screen.getByRole("heading", { name: "Registre uma conversa estratégica" })).toBeInTheDocument();
    expect(cabecalhos(), "gravando uma reunião, a pessoa ficava sem menu").toHaveLength(1);
  });

  it("no detalhe da reunião — o outro ramo que ficava sem menu", () => {
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));

    expect(screen.getByRole("heading", { name: "Reunião com a vinícola" })).toBeInTheDocument();
    expect(cabecalhos(), "no detalhe, a pessoa ficava sem menu").toHaveLength(1);
  });

  it("no detalhe que ainda carrega e no que falhou de consultar", () => {
    // Os ramos internos do detalhe (spinner e erro) ficam debaixo do cabeçalho
    // da página: ele é montado antes da escolha do ramo, não dentro dela.
    duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    const { unmount } = render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(cabecalhos()).toHaveLength(1);
    unmount();
    // O clique deixou a URL no detalhe: a segunda montagem volta a partir da lista.
    window.history.replaceState(null, "", "/meetings");

    duble.get.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: { message: "Banco de dados indisponível. Tente de novo em instantes.", data: { code: "INTERNAL_SERVER_ERROR" } },
      refetch: vi.fn(),
    });
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(cabecalhos()).toHaveLength(1);
  });

  it("a lista em erro também mantém o menu", () => {
    duble.list.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: { message: "Banco de dados indisponível. Tente de novo em instantes.", data: { code: "INTERNAL_SERVER_ERROR" } },
      refetch: vi.fn(),
    });
    render(<Meetings />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(cabecalhos()).toHaveLength(1);
  });

  it("ir e voltar entre os ramos não duplica nem perde o cabeçalho", () => {
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(cabecalhos()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Voltar/ }));
    expect(cabecalhos()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(cabecalhos()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Todas as reuniões/ }));
    expect(cabecalhos()).toHaveLength(1);
    expect(screen.getByText("Assistente de Reuniões")).toBeInTheDocument();
  });
});
