import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { useAuth } from "@/_core/hooks/useAuth";
import Contexts from "./Contexts";

/**
 * Minha Linha do Tempo — o erro ao anexar ou remover um arquivo chega no
 * idioma da tela (#149). A mensagem de sessão vem do servidor em inglês
 * ("Please login (10001)") e o toast a mostrava crua; agora passa por
 * traduzirMensagemDoServidor, como os toasts de Reuniões.
 *
 * O dublê do tRPC (molde: Contexts.test.tsx) guarda as opções de cada
 * useMutation pelo nome, e o teste chama o onError como o React Query chamaria.
 */

type Opcoes = { onError?: (erro: { message: string }) => unknown };

const duble = vi.hoisted(() => {
  const opcoes: Record<string, Opcoes | undefined> = {};
  const registrar = (nome: string) => ({
    useMutation: (o?: Opcoes) => {
      opcoes[nome] = o;
      return { mutate: () => {}, isPending: false };
    },
  });
  return { opcoes, registrar, list: vi.fn(), get: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    contexts: {
      listTypes: { useQuery: () => ({ data: [] }) },
      list: { useQuery: (...args: unknown[]) => duble.list(...args) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      create: duble.registrar("create"),
      update: duble.registrar("update"),
      delete: duble.registrar("delete"),
      linkContact: duble.registrar("linkContact"),
      unlinkContact: duble.registrar("unlinkContact"),
      addParticipant: duble.registrar("addParticipant"),
      uploadMedia: duble.registrar("uploadMedia"),
      deleteMedia: duble.registrar("deleteMedia"),
    },
    network: { list: { useQuery: () => ({ data: { data: [], total: 0 } }) } },
  },
}));

const CONTEXTO = { id: "ctx-1", name: "CPHI 2024", isCustom: true, contactCount: 0, eventDate: null, city: null, country: null, notes: null };

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Dona", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  duble.list.mockReturnValue({
    data: { data: [CONTEXTO], total: 1 }, isLoading: false, isError: false, error: null,
    refetch: vi.fn(), fetchStatus: "idle", isSuccess: true,
  });
  duble.get.mockReturnValue({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() });
});

describe("Minha Linha do Tempo — erro de anexo no idioma da tela", () => {
  it("anexar e remover: a mensagem de sessão do servidor vira o texto traduzido; sem mensagem, o texto da tela", () => {
    render(<Contexts />);
    fireEvent.click(screen.getByText("CPHI 2024"));

    act(() => { duble.opcoes.uploadMedia?.onError?.({ message: UNAUTHED_ERR_MSG }); });
    act(() => { duble.opcoes.deleteMedia?.onError?.({ message: UNAUTHED_ERR_MSG }); });
    act(() => { duble.opcoes.uploadMedia?.onError?.({ message: "" }); });
    act(() => { duble.opcoes.deleteMedia?.onError?.({ message: "" }); });

    expect(vi.mocked(toast.error).mock.calls.map(([texto]) => texto)).toEqual([
      "Faça login para continuar.",
      "Faça login para continuar.",
      "Não foi possível anexar o arquivo.",
      "Não foi possível remover o arquivo.",
    ]);
  });
});
