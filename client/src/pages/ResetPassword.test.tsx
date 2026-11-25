import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";

/**
 * Redefinir a senha: os dois campos pedem "new-password", para o gerenciador de
 * senhas sugerir uma senha forte e guardá-la; e o erro do servidor aparece
 * no idioma da tela, sem o texto técnico do zod ou da rede.
 */

type Erro = { message: string; data?: { code?: string; path?: string; httpStatus?: number } };
const duble = vi.hoisted(() => ({ opcoes: null as unknown as { onError: (erro: Erro) => void }, mutate: vi.fn(), pendente: false }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      resetPassword: {
        useMutation: (opcoes: { onError: (erro: Erro) => void }) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: duble.pendente };
        },
      },
    },
  },
}));

import ResetPassword from "./ResetPassword";

const campo = (id: string) => document.querySelector<HTMLInputElement>(`input#${id}`)!;

beforeEach(() => {
  duble.mutate.mockReset();
  duble.pendente = false;
  window.history.replaceState(null, "", "/reset-password?token=abcdefghijk");
});

afterEach(async () => {
  // Desmonta antes: no Vitest 2 os afterEach rodam em pilha, e este viria antes do
  // cleanup do setup. Com a tela montada, trocar a URL e o idioma a redesenharia.
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  await i18n.changeLanguage("pt-BR");
});

describe("Redefinir a senha — o link e a volta ao login", () => {
  it("o link com token abre direto no formulário, sem pintar o aviso de link inválido no primeiro render", () => {
    // Sem efeitos: é o que o navegador pinta no primeiro quadro.
    const html = renderToStaticMarkup(<ResetPassword />);
    expect(html).not.toContain(i18n.t("auth.invalidTokenTitle"));
    expect(html).toContain('name="new-password"');
  });

  it("sem token na URL, o aviso de link inválido continua", () => {
    window.history.replaceState(null, "", "/reset-password");
    render(<ResetPassword />);
    expect(screen.getByText(i18n.t("auth.invalidTokenTitle"))).toBeInTheDocument();
  });

  it("depois da troca da senha, a tela vai ao login em 3 segundos", () => {
    vi.useFakeTimers();
    render(<ResetPassword />);
    act(() => (duble.opcoes as unknown as { onSuccess: () => void }).onSuccess());
    // A confirmação fica na tela até a ida ao login, e não antes dos 3 segundos.
    expect(screen.getByText(i18n.t("auth.resetPasswordSuccessTitle"))).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2999));
    expect(window.location.pathname).toBe("/reset-password");
    act(() => vi.advanceTimersByTime(1));
    expect(window.location.pathname).toBe("/login");
    // Com ?entrar: num aparelho com outra conta logada, o /login simples
    // seguiria para dentro dela em vez de mostrar o formulário (PR #179).
    expect(new URLSearchParams(window.location.search).has("entrar")).toBe(true);
  });

  it("o botão 'Ir para o login' da confirmação também pede o formulário (?entrar)", () => {
    render(<ResetPassword />);
    act(() => (duble.opcoes as unknown as { onSuccess: () => void }).onSuccess());
    const link = screen.getByText(i18n.t("auth.goToLogin")).closest("a");
    expect(link).toHaveAttribute("href", "/login?entrar=1");
  });

  it("sair da tela antes dos 3 segundos cancela a ida ao login", () => {
    vi.useFakeTimers();
    const { unmount } = render(<ResetPassword />);
    act(() => (duble.opcoes as unknown as { onSuccess: () => void }).onSuccess());
    // A ida ainda não aconteceu quando a pessoa sai.
    expect(window.location.pathname).toBe("/reset-password");
    unmount();
    window.history.replaceState(null, "", "/register");
    act(() => vi.advanceTimersByTime(3500));
    expect(window.location.pathname).toBe("/register");
  });

  it("sem a troca da senha, a tela não vai sozinha ao login, nem depois de um erro", () => {
    vi.useFakeTimers();
    render(<ResetPassword />);
    act(() => vi.advanceTimersByTime(3500));
    expect(window.location.pathname).toBe("/reset-password");
    expect(campo("newPassword")).toBeInTheDocument();
    act(() => duble.opcoes.onError({ message: "Token inválido ou expirado.", data: { code: "BAD_REQUEST", httpStatus: 400, path: "auth.resetPassword" } }));
    expect(screen.getByText(i18n.t("auth.invalidTokenDesc"))).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3500));
    expect(window.location.pathname).toBe("/reset-password");
  });

  it("no aviso de link inválido, a tela também não vai sozinha ao login", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/reset-password");
    render(<ResetPassword />);
    act(() => vi.advanceTimersByTime(3500));
    expect(window.location.pathname).toBe("/reset-password");
    expect(screen.getByText(i18n.t("auth.invalidTokenTitle"))).toBeInTheDocument();
  });
});

describe("Redefinir a senha — campos durante o envio", () => {
  it("durante o envio os dois campos ficam só de leitura, para a senha gravada ser a que está na tela", () => {
    duble.pendente = true;
    render(<ResetPassword />);
    expect(campo("newPassword")).toHaveAttribute("readonly");
    expect(campo("confirmPassword")).toHaveAttribute("readonly");
  });

  it("fora do envio os dois campos seguem editáveis", () => {
    render(<ResetPassword />);
    expect(campo("newPassword")).not.toHaveAttribute("readonly");
    expect(campo("confirmPassword")).not.toHaveAttribute("readonly");
  });
});

describe("Redefinir a senha — campos para o gerenciador de senhas", () => {
  it("a nova senha e a confirmação pedem new-password", () => {
    render(<ResetPassword />);
    expect(campo("newPassword")).toHaveAttribute("autocomplete", "new-password");
    expect(campo("newPassword")).toHaveAttribute("name", "new-password");
    expect(campo("confirmPassword")).toHaveAttribute("autocomplete", "new-password");
    expect(campo("confirmPassword")).toHaveAttribute("name", "confirm-password");
  });

  it("senha curta posta por script (o minLength não barra) é recusada antes de gastar o link", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    // 7 caracteres, um a menos que o mínimo do servidor: com o caso de 8 abaixo, prende a borda.
    fireEvent.change(campo("newPassword"), { target: { value: "senha12" } });
    fireEvent.change(campo("confirmPassword"), { target: { value: "senha12" } });
    fireEvent.submit(campo("newPassword").closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(i18n.t("auth.passwordTooShort"));
    expect(duble.mutate).not.toHaveBeenCalled();
  });

  it("senhas de tamanho certo mas diferentes nos dois campos dizem isso, e não 'senha curta'", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    fireEvent.change(campo("newPassword"), { target: { value: "senha123" } });
    fireEvent.change(campo("confirmPassword"), { target: { value: "senha124" } });
    fireEvent.submit(campo("newPassword").closest("form")!);
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("auth.passwordMismatch"));
    expect(aviso).not.toHaveTextContent(i18n.t("auth.passwordTooShort"));
    expect(duble.mutate).not.toHaveBeenCalled();
  });

  it("senha de 8 caracteres, igual nos dois campos, vai ao servidor com o token do link", () => {
    render(<ResetPassword />);
    fireEvent.change(campo("newPassword"), { target: { value: "senha123" } });
    fireEvent.change(campo("confirmPassword"), { target: { value: "senha123" } });
    fireEvent.submit(campo("newPassword").closest("form")!);
    expect(duble.mutate).toHaveBeenCalledWith({ token: "abcdefghijk", newPassword: "senha123" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Redefinir a senha — erros do servidor", () => {
  it("link vencido ou inválido (BAD_REQUEST) sai no idioma da tela, e não na frase do servidor", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    act(() => duble.opcoes.onError({ message: "Token inválido ou expirado. Solicite um novo link de recuperação.", data: { code: "BAD_REQUEST", httpStatus: 400, path: "auth.resetPassword" } }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("auth.invalidTokenDesc"));
    expect(aviso).not.toHaveTextContent("Token inválido ou expirado");
  });

  it("fila do bcrypt cheia (TOO_MANY_REQUESTS da rota) sai traduzida, e não como link vencido", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    act(() => duble.opcoes.onError({
      message: "Muitas entradas e cadastros ao mesmo tempo. Aguarde alguns segundos e tente de novo.",
      data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path: "auth.resetPassword" },
    }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("auth.tooManyRequests"));
    expect(aviso).not.toHaveTextContent(i18n.t("auth.invalidTokenDesc"));
    expect(aviso).not.toHaveTextContent("Muitas entradas");
  });

  it("o limite geral da API (429 sem path, de antes do tRPC) mostra a frase dele, traduzida, e não a fila de entradas", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    // O envelope de responderLimite (server/_core/limite-de-requisicoes.ts).
    const doLimiteGeral = "Muitas requisições em pouco tempo. Aguarde alguns segundos e tente de novo.";
    act(() => duble.opcoes.onError({ message: doLimiteGeral, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("errors.tooManyRequests"));
    expect(aviso).not.toHaveTextContent(doLimiteGeral);
    expect(aviso).not.toHaveTextContent(i18n.t("auth.tooManyRequests"));
    expect(aviso).not.toHaveTextContent(i18n.t("auth.invalidTokenDesc"));
  });

  it("banco fora do ar sai pelo tradutor comum, e não como link vencido", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    // Como chega de verdade: com o path da rota, como todo erro lançado nela.
    act(() => duble.opcoes.onError({ message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "auth.resetPassword" } }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("errors.databaseUnavailable"));
    expect(aviso).not.toHaveTextContent(i18n.t("auth.invalidTokenDesc"));
    expect(aviso).not.toHaveTextContent(i18n.t("auth.tooManyRequests"));
  });

  it("falha sem resposta do servidor mostra o texto genérico traduzido, não o técnico", async () => {
    await i18n.changeLanguage("en");
    render(<ResetPassword />);
    act(() => duble.opcoes.onError({ message: "Failed to fetch" }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("errorBoundary.serverUnavailable"));
    expect(aviso).not.toHaveTextContent("Failed to fetch");
    expect(aviso).not.toHaveTextContent(String(i18n.getResource("pt-BR", "translation", "errorBoundary.serverUnavailable")));
  });
});
