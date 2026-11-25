import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Continuar com Google" (A8) no login e no cadastro: o login passa o modo
 * `entrar` e só o `?voltar=` seguro (o que o login daria depois da senha); o
 * cadastro passa o modo `cadastrar`. O botão em si está em
 * components/ContinuarComGoogle.test.tsx.
 */

const duble = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock("@/components/ContinuarComGoogle", () => ({
  ContinuarComGoogle: (props: Record<string, unknown>) => {
    duble.props.push(props);
    return <div data-testid="continuar-com-google" />;
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      login: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      register: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    chavesDeAcesso: {
      estado: { useQuery: () => ({ data: { disponivel: false } }) },
      opcoesDeEntrada: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      entrar: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      opcoesDeCadastro: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cadastrar: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLocation: () => ["/login", vi.fn()],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false }) }));

import Login from "./Login";
import Register from "./Register";

beforeEach(() => {
  duble.props = [];
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("o botão do Google nas telas de entrada", () => {
  it("no login, com o modo entrar e o voltar seguro, antes do formulário", () => {
    window.history.replaceState(null, "", "/login?voltar=%2Freunioes%2F7");
    render(<Login />);
    const botao = screen.getByTestId("continuar-com-google");
    expect(botao.compareDocumentPosition(screen.getByLabelText("E-mail")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(duble.props.at(-1)).toMatchObject({ modo: "entrar", voltar: "/reunioes/7", desligado: false });
  });

  it("no login, o voltar para fora do site não vai ao botão", () => {
    window.history.replaceState(null, "", "/login?voltar=%2F%2Fexemplo.com");
    render(<Login />);
    expect(duble.props.at(-1)).toMatchObject({ modo: "entrar", voltar: null });
  });

  it("no cadastro, com o modo cadastrar", () => {
    window.history.replaceState(null, "", "/register");
    render(<Register />);
    expect(screen.getByTestId("continuar-com-google")).toBeInTheDocument();
    expect(duble.props.at(-1)).toMatchObject({ modo: "cadastrar", desligado: false });
  });
});
