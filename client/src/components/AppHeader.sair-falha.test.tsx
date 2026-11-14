import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { TRPCClientError } from "@trpc/client";
import { GlobalMenu } from "./AppHeader";

/**
 * O Sair do menu global quando a revogação da sessão falha no servidor (banco
 * fora do ar, servidor sem resposta). Pendência da revisão da #179: o erro era
 * engolido (a mutation do menu não tinha onError), e a dona achava que tinha
 * saído com a sessão de 90 dias ainda valendo no servidor. Agora o aviso
 * traduzido aparece (menos no "não autenticada", em que não havia o que
 * revogar), e a aba sai assim mesmo (o useAuth limpa a sessão do
 * navegador de propósito, pensando no computador compartilhado).
 *
 * O useAuth é o de verdade; o tRPC, o mínimo que ele e o menu usam, com o
 * auth.logout falhando como o React Query falha: o mutate chama o onError, e o
 * mutateAsync rejeita.
 */

const duble = vi.hoisted(() => ({
  falhar: true,
  /** O erro com que o auth.logout falha; por padrão, o do banco fora do ar. */
  erro: null as Error | null,
  limparCache: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: duble.limparCache, invalidate: () => Promise.resolve() } } }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: 7, name: "Fulana", role: "silver" }, isLoading: false, error: null, refetch: () => Promise.resolve() }),
      },
      logout: {
        useMutation: (opcoes?: { onSuccess?: () => unknown; onError?: (erro: Error) => unknown }) => ({
          mutate: () => {
            void Promise.resolve().then(() =>
              duble.falhar ? opcoes?.onError?.(duble.erro ?? new Error("Banco de dados indisponível")) : opcoes?.onSuccess?.(),
            );
          },
          mutateAsync: async () => {
            if (duble.falhar) throw new Error("Banco de dados indisponível");
            await opcoes?.onSuccess?.();
          },
          isPending: false,
          error: null,
        }),
      },
    },
  },
}));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

const AVISO = "O servidor não confirmou o fim da sessão. Se a sua conta ainda aparecer aberta, saia de novo quando a conexão voltar.";

async function clicarEmSair() {
  fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  window.history.replaceState(null, "", "/dashboard");
  vi.mocked(toast.error).mockClear();
  duble.erro = null;
  duble.limparCache.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("o Sair do menu global com a revogação falhando", () => {
  it("mostra o aviso traduzido uma vez, limpa a sessão desta aba e volta ao início", async () => {
    duble.falhar = true;
    render(<GlobalMenu />);
    await clicarEmSair();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    await waitFor(() => expect(duble.limparCache).toHaveBeenCalledWith(undefined, null));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(AVISO);
  });

  it("'não autenticada' não é falha (não havia sessão para revogar): sai sem aviso", async () => {
    duble.falhar = true;
    duble.erro = Object.assign(Object.create(TRPCClientError.prototype) as Error, { message: "Please login", data: { code: "UNAUTHORIZED" } });
    render(<GlobalMenu />);
    await clicarEmSair();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    await waitFor(() => expect(duble.limparCache).toHaveBeenCalledWith(undefined, null));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("com a revogação dando certo, nenhum aviso de erro", async () => {
    duble.falhar = false;
    render(<GlobalMenu />);
    await clicarEmSair();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    await waitFor(() => expect(duble.limparCache).toHaveBeenCalledWith(undefined, null));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
