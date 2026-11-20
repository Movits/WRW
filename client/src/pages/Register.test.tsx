import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

/**
 * Cadastro e login persistente (PR #179). Com a sessão de 90 dias, o /login
 * de quem já está logada segue direto para o app. Depois de criar a conta
 * ("agora faça login") e no link "Entrar" desta tela, num aparelho com OUTRA
 * conta logada, o /login simples levaria a pessoa para dentro da conta alheia.
 * Por isso os dois vão a `/login?entrar=1`, que mostra o formulário sempre.
 */

const duble = vi.hoisted(() => ({ opcoes: null as unknown as { onSuccess: () => void }, mutate: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      register: {
        useMutation: (opcoes: { onSuccess: () => void }) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: false };
        },
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Register from "./Register";

beforeEach(() => {
  window.history.replaceState(null, "", "/register");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Cadastro — a volta ao login pede o formulário", () => {
  it("conta criada: vai a /login com ?entrar", () => {
    render(<Register />);
    act(() => duble.opcoes.onSuccess());
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).has("entrar")).toBe(true);
  });

  it("o link 'Entrar' de quem já tem conta também leva o ?entrar", () => {
    render(<Register />);
    const link = screen.getByText(new RegExp(i18n.t("auth.loginLink"))).closest("a");
    expect(link).toHaveAttribute("href", "/login?entrar=1");
  });
});
