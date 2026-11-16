import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motivoDaOcupacao, ocupar, sessaoOcupada } from "@/lib/sessao-ocupada";
import { ExcluirMinhaConta } from "./ExcluirMinhaConta";

/**
 * Excluir a conta encerra a sessão nesta aba sem passar pelo logout do useAuth
 * (PR S do gravador, lib/sessao-ocupada.ts). O envio da gravação ocupa à parte
 * e segue no ar depois que a dona sai do gravador (para o perfil, por exemplo):
 * sem soltar as ocupações aqui, a aba já deslogada ficava ocupada até o pedido
 * terminar, e fechar a aba ou o próximo login nela (o Login troca de página ao
 * entrar) caíam na pergunta do navegador, por um áudio de uma conta que não
 * existe mais. A exclusão recusada não solta nada: a conta segue logada.
 *
 * O tRPC é o dublê de ExcluirMinhaConta.test.tsx, com o desfecho da exclusão
 * rodando como o do React Query (onSuccess ou onError).
 */

type ResultadoDaExclusao = { sucesso: true; linhasApagadas: number; arquivosApagados: number; arquivosComFalha: number };
type OpcoesDaExclusao = { onSuccess: (resultado: ResultadoDaExclusao) => void; onError: (erro: Error) => void };

const duble = vi.hoisted(() => ({
  desfecho: "sucesso" as "sucesso" | "falha",
  navegou: [] as string[],
  setData: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("wouter", () => ({ useLocation: () => ["/profile", (para: string) => duble.navegou.push(para)] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: duble.setData } } }),
    conta: {
      requisitosDaExclusao: {
        useQuery: () => ({ data: { confirmacaoEsperada: "dona@exemplo.com", temSenha: true, ultimaAdministradora: false } }),
      },
      excluirMinhaConta: {
        // O resultado tem a forma do que o servidor devolve (server/routers/conta.ts).
        useMutation: (opcoes: OpcoesDaExclusao) => ({
          mutate: () => duble.desfecho === "falha"
            ? opcoes.onError(new Error("Senha incorreta."))
            : opcoes.onSuccess({ sucesso: true, linhasApagadas: 31, arquivosApagados: 2, arquivosComFalha: 0 }),
          isPending: false,
        }),
      },
    },
  },
}));

/** O navegador avisa antes de fechar a aba: devolve se a página pediu a confirmação. */
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

// O registro da sessão ocupada é um só no app: cada teste libera o que abriu.
const abertas: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  duble.desfecho = "sucesso";
  duble.navegou.length = 0;
  expect(sessaoOcupada()).toBe(false);
});

afterEach(() => {
  for (const liberar of abertas.splice(0)) liberar();
});

function excluirAConta() {
  fireEvent.click(screen.getByRole("button", { name: /Excluir minha conta/i }));
  fireEvent.change(screen.getByLabelText(/digite:/i), { target: { value: "dona@exemplo.com" } });
  fireEvent.change(screen.getByLabelText(/Sua senha/i), { target: { value: "minha-senha" } });
  fireEvent.click(screen.getByRole("button", { name: /Excluir definitivamente/i }));
}

describe("Excluir minha conta — a sessão ocupada sai com a conta", () => {
  it("com o envio no ar, excluir a conta solta a sessão, e o navegador deixa de perguntar ao fechar a aba", () => {
    const liberarEnvio = ocupar("enviando");
    abertas.push(liberarEnvio);
    expect(fecharAba()).toBe(true);

    render(<ExcluirMinhaConta />);
    excluirAConta();

    expect(duble.setData).toHaveBeenCalledWith(undefined, null);
    expect(duble.navegou).toEqual(["/"]);
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    // O fim do envio, que chega depois, não reabre nada.
    liberarEnvio();
    expect(sessaoOcupada()).toBe(false);
  });

  it("a exclusão recusada não solta nada: a conta segue logada, e o envio no ar segue ocupando", () => {
    duble.desfecho = "falha";
    abertas.push(ocupar("enviando"));

    render(<ExcluirMinhaConta />);
    excluirAConta();

    expect(toast.error).toHaveBeenCalledWith("Senha incorreta.");
    expect(duble.setData).not.toHaveBeenCalled();
    expect(duble.navegou).toEqual([]);
    expect(motivoDaOcupacao()).toBe("enviando");
    expect(fecharAba()).toBe(true);
  });
});
