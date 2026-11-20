import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExcluirMinhaConta } from "./ExcluirMinhaConta";

/**
 * A exclusão da conta com a Google Agenda conectada (H16b). A exclusão revoga o
 * token na Google antes de apagar a conexão; quando a Google não confirma, a
 * conta sai assim mesmo, e a WRW segue em "Apps de terceiros" da conta Google
 * da dona, com permissão na agenda, até ela tirar. O servidor devolve
 * `googleNaoConfirmou` (server/routers/conta.ts), e a tela avisa como no
 * desconectar do Perfil.
 *
 * O tRPC é o dublê de ExcluirMinhaConta.sessao-ocupada.test.tsx, com o
 * desfecho da exclusão rodando como o do React Query (onSuccess).
 */

type ResultadoDaExclusao = {
  sucesso: true; linhasApagadas: number; arquivosApagados: number; arquivosComFalha: number; googleNaoConfirmou: boolean;
};
type OpcoesDaExclusao = { onSuccess: (resultado: ResultadoDaExclusao) => void; onError: (erro: Error) => void };

const duble = vi.hoisted(() => ({
  resultado: null as unknown as ResultadoDaExclusao,
  navegou: [] as string[],
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("wouter", () => ({ useLocation: () => ["/profile", (para: string) => duble.navegou.push(para)] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: () => {} } } }),
    conta: {
      requisitosDaExclusao: {
        useQuery: () => ({ data: { confirmacaoEsperada: "dona@exemplo.com", temSenha: true, ultimaAdministradora: false } }),
      },
      excluirMinhaConta: {
        useMutation: (opcoes: OpcoesDaExclusao) => ({ mutate: () => opcoes.onSuccess(duble.resultado), isPending: false }),
      },
    },
  },
}));

const RESULTADO: ResultadoDaExclusao = { sucesso: true, linhasApagadas: 31, arquivosApagados: 2, arquivosComFalha: 0, googleNaoConfirmou: false };

beforeEach(() => {
  duble.resultado = RESULTADO;
  duble.navegou.length = 0;
});

function excluirAConta() {
  render(<ExcluirMinhaConta />);
  fireEvent.click(screen.getByRole("button", { name: /Excluir minha conta/i }));
  fireEvent.change(screen.getByLabelText(/digite:/i), { target: { value: "dona@exemplo.com" } });
  fireEvent.change(screen.getByLabelText(/Sua senha/i), { target: { value: "minha-senha" } });
  fireEvent.click(screen.getByRole("button", { name: /Excluir definitivamente/i }));
}

describe("Excluir minha conta — a Google Agenda que a Google não confirmou", () => {
  it("a Google não confirmou a revogação: além do 'excluídos', um aviso longo diz como tirar o acesso pela conta Google", () => {
    duble.resultado = { ...RESULTADO, googleNaoConfirmou: true };
    excluirAConta();
    expect(toast.success).toHaveBeenCalledWith("Sua conta e seus dados foram excluídos.");
    expect(toast.warning).toHaveBeenCalledWith(
      "A conexão com a Google Agenda saiu junto com a conta, mas a Google não confirmou que tirou o acesso da WRW. Se quiser, tire esse acesso nas configurações da sua conta Google.",
      { duration: 15000 },
    );
    expect(duble.navegou).toEqual(["/"]);
  });

  it("revogada, sem conexão ou mantida para outra conta: nenhum aviso a mais", () => {
    excluirAConta();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
