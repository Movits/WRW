import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ocupar, sessaoOcupada } from "@/lib/sessao-ocupada";
import { GlobalMenu } from "./AppHeader";

/**
 * O Sair do menu global (o do cabeçalho de toda tela logada) solta a sessão
 * ocupada (PR S do gravador, lib/sessao-ocupada.ts). Quem solta é o logout do
 * useAuth, e o menu só chega a ele pelo onSuccess da mutation auth.logout dele.
 * Os testes do diálogo (SairDaConta.test.tsx, Dashboard.sair.test.tsx) trocam o
 * useAuth por um dublê e param no "auth.logout chamado": não veriam essa
 * ligação cair. Sem ela, "Sair mesmo assim" com o envio no ar deixava a aba
 * deslogada ocupada até o pedido terminar, e o próximo login nela (o Login
 * troca de página ao entrar) caía na pergunta do navegador.
 *
 * O useAuth é o de verdade; o tRPC, o mínimo que ele e o menu usam, com o
 * auth.logout rodando o onSuccess como o React Query. O teste não conta as
 * chamadas ao servidor: hoje o menu chama o auth.logout e o useAuth chama de
 * novo, e enxugar isso não pode quebrar este teste.
 */

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: () => {}, invalidate: () => Promise.resolve() } } }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: 7, name: "Fulana", role: "silver" }, isLoading: false, error: null, refetch: () => Promise.resolve() }),
      },
      logout: {
        useMutation: (opcoes?: { onSuccess?: () => unknown }) => ({
          mutate: () => { void Promise.resolve().then(() => opcoes?.onSuccess?.()); },
          mutateAsync: async () => { await opcoes?.onSuccess?.(); },
          isPending: false,
          error: null,
        }),
      },
    },
  },
}));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

/** O navegador avisa antes de fechar a aba (ou de trocar de página): devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  // O returnValue do Event comum do jsdom ignora o true que a página grava; o do
  // navegador o guarda, e o Chrome e o Edge antes da 119 só perguntam com ele.
  Object.defineProperty(evento, "returnValue", { value: "", writable: true });
  window.dispatchEvent(evento);
  // A página pede pelas duas formas, ou por nenhuma.
  expect(Boolean(evento.returnValue)).toBe(evento.defaultPrevented);
  return evento.defaultPrevented;
}

// O registro da sessão ocupada é um só no app: o teste libera o que abriu.
const abertas: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  window.history.replaceState(null, "", "/gravar");
  expect(sessaoOcupada()).toBe(false);
});

afterEach(() => {
  for (const liberar of abertas.splice(0)) liberar();
  vi.unstubAllGlobals();
});

describe("o Sair do menu global solta a sessão ocupada", () => {
  it("com o envio no ar, 'Sair mesmo assim' termina com a sessão livre e o navegador sem perguntar", async () => {
    abertas.push(ocupar("enviando"));
    expect(fecharAba()).toBe(true);

    render(<GlobalMenu />);
    fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
    fireEvent.click(screen.getByRole("button", { name: "Sair mesmo assim" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(fecharAba()).toBe(false);
  });
});
