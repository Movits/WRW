import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ocupar, sessaoOcupada } from "@/lib/sessao-ocupada";
import { useAuth } from "./useAuth";

/**
 * Sair da conta solta as ocupações da sessão que sobraram (PR S do gravador,
 * lib/sessao-ocupada.ts). O envio da gravação ocupa à parte e segue no ar depois
 * que a página desmonta: sem isto, ele deixava ocupada a aba já deslogada, e o
 * login seguinte nela (o Login troca de página ao entrar) e o fechar da aba
 * caíam na pergunta do navegador, por um áudio que a dona já aceitou perder no
 * diálogo do Sair.
 *
 * O useAuth é o de verdade; o tRPC, o mínimo que ele usa, como em
 * pages/Onboarding.rascunho.test.tsx.
 */

const duble = vi.hoisted(() => ({ sairNoServidor: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: () => {}, invalidate: () => Promise.resolve() } } }),
    auth: {
      me: { useQuery: () => ({ data: { id: 7, name: "Fulana" }, isLoading: false, error: null, refetch: () => Promise.resolve() }) },
      logout: { useMutation: () => ({ mutateAsync: duble.sairNoServidor, isPending: false, error: null }) },
    },
  },
}));

/** O navegador avisa antes de fechar a aba (ou de trocar de página): devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(evento);
  return evento.defaultPrevented;
}

// O registro da sessão ocupada é um só no app: o teste libera o que abriu.
const abertas: Array<() => void> = [];
afterEach(() => {
  for (const liberar of abertas.splice(0)) liberar();
});

describe("useAuth — sair da conta solta a sessão ocupada", () => {
  it("com o envio no ar, o logout libera a sessão e o navegador deixa de perguntar", async () => {
    const liberarEnvio = ocupar("enviando");
    abertas.push(liberarEnvio);
    expect(fecharAba()).toBe(true);

    const { result } = renderHook(() => useAuth());
    await act(async () => { await result.current.logout(); });

    expect(duble.sairNoServidor).toHaveBeenCalledTimes(1);
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    // O fim do envio, que chega depois, não reabre nada.
    liberarEnvio();
    expect(sessaoOcupada()).toBe(false);
  });

  it("também quando o servidor não responde: como o cache, a sessão do navegador acaba assim mesmo", async () => {
    duble.sairNoServidor.mockRejectedValueOnce(new Error("Failed to fetch"));
    abertas.push(ocupar("enviando"));

    const { result } = renderHook(() => useAuth());
    await act(async () => { await expect(result.current.logout()).rejects.toThrow("Failed to fetch"); });

    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
  });
});
