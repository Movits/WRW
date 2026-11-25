import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";

/**
 * O Login com as chaves de acesso (A7). O jeito principal é a sugestão no
 * próprio campo: ao abrir, a tela pede as opções e fica esperando o navegador,
 * que oferece a chave deste aparelho quando a pessoa toca no e-mail ou na
 * senha. O link "Entrar com Face ID ou digital" é a reserva do navegador que não
 * sugere no campo. Depois da primeira senha certa, o convite ativa a chave neste
 * aparelho, e erro no convite nunca prende a pessoa.
 *
 * A conversa com o aparelho é dublada em @/lib/chaves-de-acesso; as funções que
 * leem erros (código, cancelamento, frase) são as de verdade.
 */

type QuemEntrou = { user: { name: string | null; onboardingCompleted: boolean } };
type OpcoesDoLogin = { onSuccess: (data: QuemEntrou) => void; onError: (erro: { message: string }) => void };

const duble = vi.hoisted(() => ({
  opcoesDoLogin: null as unknown as OpcoesDoLogin,
  estado: { disponivel: true, rpId: "wrwglobal.org" } as { disponivel: boolean; rpId?: string },
  opcoesDeEntrada: vi.fn(),
  entrar: vi.fn(),
  opcoesDeCadastro: vi.fn(),
  cadastrar: vi.fn(),
  podeUsar: vi.fn(() => true),
  sugereNoCampo: vi.fn(async () => true),
  autenticadorProprio: vi.fn(async () => true),
  pedirAoAparelho: vi.fn(),
  criarNoAparelho: vi.fn(),
  cancelar: vi.fn(),
  avisarDesconhecida: vi.fn(async () => undefined),
  conviteRespondido: vi.fn(() => false),
  marcarConvite: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      login: {
        useMutation: (opcoes: OpcoesDoLogin) => {
          duble.opcoesDoLogin = opcoes;
          return { mutate: vi.fn(), isPending: false };
        },
      },
    },
    chavesDeAcesso: {
      estado: { useQuery: () => ({ data: duble.estado }) },
      opcoesDeEntrada: { useMutation: () => ({ mutateAsync: duble.opcoesDeEntrada }) },
      entrar: { useMutation: () => ({ mutateAsync: duble.entrar }) },
      opcoesDeCadastro: { useMutation: () => ({ mutateAsync: duble.opcoesDeCadastro }) },
      cadastrar: { useMutation: () => ({ mutateAsync: duble.cadastrar }) },
    },
  },
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLocation: () => ["/login", vi.fn()],
}));
// "Continuar com Google" (A8) tem o teste dele (components/ContinuarComGoogle.test.tsx).
vi.mock("@/components/ContinuarComGoogle", () => ({ ContinuarComGoogle: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/lib/chaves-de-acesso", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/chaves-de-acesso")>();
  return {
    ...original,
    podeUsarChavesAqui: duble.podeUsar,
    sugestaoNoCampoDisponivel: duble.sugereNoCampo,
    podeAtivarNesteAparelho: duble.autenticadorProprio,
    entrarComAChave: duble.pedirAoAparelho,
    cadastrarAChave: duble.criarNoAparelho,
    cancelarPedidoDaChave: duble.cancelar,
    avisarChaveDesconhecida: duble.avisarDesconhecida,
    conviteRespondidoNoAparelho: duble.conviteRespondido,
    marcarConviteNoAparelho: duble.marcarConvite,
  };
});

import Login from "./Login";

const OPCOES_DE_ENTRADA = { challenge: "d-entrada", rpId: "wrwglobal.org" };
const RESPOSTA_DE_ENTRADA = { id: "credencial-1", rawId: "credencial-1", type: "public-key", response: {}, clientExtensionResults: {} };
const QUEM_ENTROU: QuemEntrou = { user: { name: "Ana Souza", onboardingCompleted: true } };
const erroDoServidor = (codigo: string) => ({ message: codigo, data: { code: "BAD_REQUEST" } });
const cancelado = () => Object.assign(new Error("fechou"), { name: "NotAllowedError" });
/** Uma espera que não termina sozinha, como a do navegador até a pessoa tocar no campo. */
const nuncaResponde = () => new Promise<never>(() => {});

let destino: { href: string; search: string };

beforeEach(() => {
  destino = { href: "", search: "" };
  vi.stubGlobal("location", destino);
  duble.estado = { disponivel: true, rpId: "wrwglobal.org" };
  duble.podeUsar.mockReturnValue(true);
  duble.sugereNoCampo.mockResolvedValue(true);
  duble.autenticadorProprio.mockResolvedValue(true);
  duble.conviteRespondido.mockReturnValue(false);
  duble.avisarDesconhecida.mockResolvedValue(undefined);
  duble.opcoesDeEntrada.mockResolvedValue(OPCOES_DE_ENTRADA);
  duble.pedirAoAparelho.mockImplementation(nuncaResponde);
  duble.entrar.mockResolvedValue(QUEM_ENTROU);
  duble.opcoesDeCadastro.mockResolvedValue({ challenge: "d-cadastro" });
  duble.criarNoAparelho.mockResolvedValue({ id: "credencial-nova", clientExtensionResults: {} });
  duble.cadastrar.mockResolvedValue({ id: "chave-1" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

describe("a sugestão da chave no campo", () => {
  it("os campos de e-mail e de senha pedem ao navegador a sugestão da chave", () => {
    render(<Login />);
    expect(screen.getByLabelText("E-mail").getAttribute("autocomplete")).toContain("webauthn");
    expect(screen.getByLabelText("Senha").getAttribute("autocomplete")).toContain("webauthn");
  });

  it("com a função disponível, a tela pede as opções ao abrir e espera a escolha no campo", async () => {
    render(<Login />);
    await waitFor(() => expect(duble.pedirAoAparelho).toHaveBeenCalledWith(OPCOES_DE_ENTRADA, { autofill: true }));
    expect(duble.opcoesDeEntrada).toHaveBeenCalledTimes(1);
  });

  it("sem a função no servidor, fora do navegador com suporte ou sem a sugestão no campo, não pede nada", async () => {
    duble.estado = { disponivel: false };
    const { unmount } = render(<Login />);
    await act(async () => {});
    unmount();
    duble.estado = { disponivel: true, rpId: "wrwglobal.org" };
    duble.podeUsar.mockReturnValue(false);
    const segundo = render(<Login />);
    await act(async () => {});
    segundo.unmount();
    duble.podeUsar.mockReturnValue(true);
    duble.sugereNoCampo.mockResolvedValue(false);
    render(<Login />);
    await act(async () => {});
    expect(duble.opcoesDeEntrada).not.toHaveBeenCalled();
    expect(duble.pedirAoAparelho).not.toHaveBeenCalled();
  });

  it("escolher a chave na sugestão entra e segue para o gravador, sem convite", async () => {
    duble.pedirAoAparelho.mockResolvedValue(RESPOSTA_DE_ENTRADA);
    render(<Login />);
    await waitFor(() => expect(duble.entrar).toHaveBeenCalledWith({ resposta: RESPOSTA_DE_ENTRADA }));
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe("Boas-vindas de volta, ANA!");
  });

  it("a chave que não vale mais sai das sugestões do aparelho e o aviso manda entrar com a senha", async () => {
    duble.pedirAoAparelho.mockResolvedValueOnce(RESPOSTA_DE_ENTRADA).mockImplementation(nuncaResponde);
    duble.entrar.mockRejectedValue(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.desconhecida));
    render(<Login />);
    await waitFor(() => expect(duble.avisarDesconhecida).toHaveBeenCalledWith("wrwglobal.org", "credencial-1"));
    expect(toast.error).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.errors.unknownKey"));
    expect(destino.href).toBe("");
    // A espera no campo se refaz, para outra chave.
    await waitFor(() => expect(duble.pedirAoAparelho).toHaveBeenCalledTimes(2));
  });

  it("conta desativada não refaz a espera: o erro voltaria igual", async () => {
    duble.pedirAoAparelho.mockResolvedValueOnce(RESPOSTA_DE_ENTRADA).mockImplementation(nuncaResponde);
    duble.entrar.mockRejectedValue(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.contaDesativada));
    render(<Login />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.errors.accountDisabled")));
    await act(async () => {});
    expect(duble.pedirAoAparelho).toHaveBeenCalledTimes(1);
  });

  it("fechar o pedido do aparelho não mostra erro", async () => {
    duble.pedirAoAparelho.mockRejectedValue(cancelado());
    render(<Login />);
    await waitFor(() => expect(duble.pedirAoAparelho).toHaveBeenCalled());
    await act(async () => {});
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("sair da tela cancela a espera", async () => {
    const { unmount } = render(<Login />);
    await waitFor(() => expect(duble.pedirAoAparelho).toHaveBeenCalled());
    unmount();
    expect(duble.cancelar).toHaveBeenCalled();
  });
});

describe("o link de reserva", () => {
  it("só aparece no navegador que não sugere a chave no campo", async () => {
    const { unmount } = render(<Login />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Entrar com Face ID ou digital/ })).not.toBeInTheDocument();
    unmount();
    duble.sugereNoCampo.mockResolvedValue(false);
    render(<Login />);
    expect(await screen.findByRole("button", { name: /Entrar com Face ID ou digital/ })).toBeInTheDocument();
  });

  it("não aparece sem a função no servidor", async () => {
    duble.sugereNoCampo.mockResolvedValue(false);
    duble.estado = { disponivel: false };
    render(<Login />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Entrar com Face ID ou digital/ })).not.toBeInTheDocument();
  });

  it("pede a chave ao aparelho, entra e segue", async () => {
    duble.sugereNoCampo.mockResolvedValue(false);
    duble.pedirAoAparelho.mockResolvedValue(RESPOSTA_DE_ENTRADA);
    render(<Login />);
    fireEvent.click(await screen.findByRole("button", { name: /Entrar com Face ID ou digital/ }));
    await waitFor(() => expect(duble.pedirAoAparelho).toHaveBeenCalledWith(OPCOES_DE_ENTRADA));
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
  });

  it("o erro do servidor aparece traduzido, nunca como código", async () => {
    duble.sugereNoCampo.mockResolvedValue(false);
    duble.opcoesDeEntrada.mockRejectedValue(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.muitasTentativas));
    render(<Login />);
    fireEvent.click(await screen.findByRole("button", { name: /Entrar com Face ID ou digital/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.errors.tooManyAttempts")));
  });
});

describe("o convite depois da senha certa", () => {
  async function entrarComSenha() {
    render(<Login />);
    // Espera as checagens do aparelho (sugestão e autenticador próprio).
    await act(async () => {});
    act(() => duble.opcoesDoLogin.onSuccess(QUEM_ENTROU));
  }

  it("aparece no lugar do formulário e segura a ida ao destino", async () => {
    await entrarComSenha();
    expect(screen.getByRole("heading", { name: "Entrar mais rápido da próxima vez?" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Senha")).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(destino.href).toBe("");
  });

  it("Agora não marca o aparelho e segue", async () => {
    await entrarComSenha();
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(duble.marcarConvite).toHaveBeenCalledWith("recusado");
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
  });

  it("Ativar cadastra a chave deste aparelho com o apelido, marca e segue", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      configurable: true,
    });
    try {
      await entrarComSenha();
      fireEvent.click(screen.getByRole("button", { name: "Ativar neste aparelho" }));
      await waitFor(() => expect(duble.cadastrar).toHaveBeenCalledWith({
        resposta: { id: "credencial-nova", clientExtensionResults: {} },
        apelido: "iPhone",
      }));
    } finally {
      delete (window.navigator as unknown as { userAgent?: string }).userAgent;
    }
    expect(duble.criarNoAparelho).toHaveBeenCalledWith({ challenge: "d-cadastro" });
    expect(duble.marcarConvite).toHaveBeenCalledWith("ativada");
    expect(toast.success).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.toast.activated"));
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
  });

  it("erro ao ativar avisa e segue mesmo assim", async () => {
    duble.cadastrar.mockRejectedValue(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.erroInterno));
    await entrarComSenha();
    fireEvent.click(screen.getByRole("button", { name: "Ativar neste aparelho" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.errors.generic")));
    expect(duble.marcarConvite).not.toHaveBeenCalled();
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
  });

  it("a chave que já estava no aparelho conta como ativada", async () => {
    duble.cadastrar.mockRejectedValue(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.jaCadastrada));
    await entrarComSenha();
    fireEvent.click(screen.getByRole("button", { name: "Ativar neste aparelho" }));
    await waitFor(() => expect(duble.marcarConvite).toHaveBeenCalledWith("ativada"));
  });

  it("fechar o pedido do aparelho mantém o convite, sem erro", async () => {
    duble.criarNoAparelho.mockRejectedValue(cancelado());
    await entrarComSenha();
    fireEvent.click(screen.getByRole("button", { name: "Ativar neste aparelho" }));
    await waitFor(() => expect(duble.criarNoAparelho).toHaveBeenCalled());
    await act(async () => {});
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ativar neste aparelho" })).toBeEnabled();
    expect(destino.href).toBe("");
  });

  it.each([
    ["o aparelho já respondeu ao convite", () => duble.conviteRespondido.mockReturnValue(true)],
    ["o aparelho não tem autenticador próprio", () => duble.autenticadorProprio.mockResolvedValue(false)],
    ["a função não está disponível", () => { duble.estado = { disponivel: false }; }],
  ])("sem convite quando %s: segue direto", async (_caso, preparar) => {
    preparar();
    await entrarComSenha();
    expect(screen.queryByRole("heading", { name: "Entrar mais rápido da próxima vez?" })).not.toBeInTheDocument();
    await waitFor(() => expect(destino.href).toBe("/gravar"), { timeout: 2000 });
  });
});
