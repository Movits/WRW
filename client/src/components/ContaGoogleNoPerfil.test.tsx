import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ContaGoogleNoPerfil } from "./ContaGoogleNoPerfil";

/**
 * A conta Google no Perfil (A8), com o tRPC dublado: sem a função e sem conta
 * ligada, nada; a falha da consulta é erro; ligar é um <a href> no endereço
 * certo; desligar pede confirmação e traduz a recusa pelo código; a volta
 * `entre-de-novo` pede a senha e recomeça a ida.
 */

type Opcoes = { onSuccess?: (data: unknown) => unknown; onError?: (erro: unknown) => void };
const duble = vi.hoisted(() => ({
  estado: vi.fn(),
  opcoes: {} as Opcoes,
  mutate: vi.fn(),
  login: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, email: "dona@exemplo.com" } }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ contaGoogle: { estado: { invalidate: duble.invalidate } } }),
    auth: { login: { useMutation: () => ({ mutateAsync: duble.login, isPending: false }) } },
    contaGoogle: {
      estado: { useQuery: (...args: unknown[]) => duble.estado(...args) },
      desligar: {
        useMutation: (opcoes: Opcoes = {}) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: false };
        },
      },
    },
  },
}));

const consulta = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...extra });
const naOrigem = () => window.location.origin;

beforeEach(() => {
  vi.clearAllMocks();
  duble.opcoes = {};
  window.history.replaceState(null, "", "/profile");
});
afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("quando a seção aparece", () => {
  it("sem a função e sem conta ligada, nada", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: false, origem: null, ligada: false }));
    const { container } = render(<ContaGoogleNoPerfil />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sem a função, mas com uma conta ligada, mostra o Desligar e não o Ligar", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: false, origem: null, ligada: true, email: "g@exemplo.com", desde: Date.UTC(2026, 10, 1), temSenha: true }));
    render(<ContaGoogleNoPerfil />);
    expect(screen.getByText("Ligada à conta Google g@exemplo.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Desligar/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ligar a conta Google/ })).not.toBeInTheDocument();
  });

  it("a falha da consulta é erro com Tentar de novo, nunca 'nenhuma conta ligada'", () => {
    duble.estado.mockReturnValue(consulta(undefined, {
      isError: true, error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } },
    }));
    render(<ContaGoogleNoPerfil />);
    expect(screen.queryByText("Nenhuma conta Google ligada.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tentar/i })).toBeInTheDocument();
  });
});

describe("ligar", () => {
  it("no endereço certo, é um link de página inteira com o modo ligar", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: false }));
    render(<ContaGoogleNoPerfil />);
    expect(screen.getByText("Nenhuma conta Google ligada.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ligar a conta Google/ })).toHaveAttribute("href", `${naOrigem()}/api/entrar-com-google/ir?modo=ligar`);
  });

  it("noutro endereço, manda abrir o Perfil no endereço certo, sem o Ligar", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: "https://wrwglobal.org", ligada: false }));
    render(<ContaGoogleNoPerfil />);
    expect(screen.queryByRole("link", { name: /Ligar a conta Google/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir wrwglobal.org/ })).toHaveAttribute("href", "https://wrwglobal.org/profile");
  });

  it("a volta ligada avisa, atualiza o estado e tira o parâmetro", async () => {
    window.history.replaceState(null, "", "/profile?conta-google=ligada");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: false }));
    render(<ContaGoogleNoPerfil />);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Conta Google ligada")));
    expect(duble.invalidate).toHaveBeenCalled();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("a volta entre-de-novo pede a senha, entra de novo e recomeça a ida", async () => {
    window.history.replaceState(null, "", "/profile?conta-google=entre-de-novo");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: false }));
    duble.login.mockResolvedValue({ user: {} });
    const local = window.location;
    const dubleDoLocal = { ...local, href: local.href, host: local.host, pathname: local.pathname, search: local.search };
    Object.defineProperty(window, "location", { value: dubleDoLocal, configurable: true, writable: true });
    try {
      render(<ContaGoogleNoPerfil />);
      const campo = await screen.findByLabelText("Sua senha");
      fireEvent.change(campo, { target: { value: "senha-de-teste" } });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar e continuar" }));
      await waitFor(() => expect(dubleDoLocal.href).toBe(`${naOrigem()}/api/entrar-com-google/ir?modo=ligar`));
      expect(duble.login).toHaveBeenCalledWith({ email: "dona@exemplo.com", password: "senha-de-teste" });
    } finally {
      Object.defineProperty(window, "location", { value: local, configurable: true, writable: true });
    }
  });

  it("a senha errada não sai da tela e diz que está incorreta", async () => {
    window.history.replaceState(null, "", "/profile?conta-google=entre-de-novo");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: false }));
    duble.login.mockRejectedValue({ message: "E-mail ou senha incorretos", data: { code: "UNAUTHORIZED" } });
    render(<ContaGoogleNoPerfil />);
    fireEvent.change(await screen.findByLabelText("Sua senha"), { target: { value: "errada" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e continuar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Senha incorreta."));
  });
});

describe("desligar", () => {
  it("pede confirmação antes de desligar", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: true, email: "g@exemplo.com", desde: Date.UTC(2026, 10, 1), temSenha: true }));
    render(<ContaGoogleNoPerfil />);
    fireEvent.click(screen.getByRole("button", { name: /Desligar/ }));
    expect(duble.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sim, desligar" }));
    expect(duble.mutate).toHaveBeenCalledTimes(1);
  });

  it("a conta sem senha recebe o caminho do Esqueci minha senha, pelo código", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: true, email: null, desde: Date.UTC(2026, 10, 1), temSenha: false }));
    render(<ContaGoogleNoPerfil />);
    duble.opcoes.onError?.({ message: "CONTA_GOOGLE_SEM_SENHA", data: { code: "PRECONDITION_FAILED" } });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Esqueci minha senha"), expect.anything());
  });

  it("em árabe, a seção sai no idioma", async () => {
    await i18n.changeLanguage("ar");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), ligada: false }));
    render(<ContaGoogleNoPerfil />);
    expect(screen.getByRole("heading", { name: "تسجيل الدخول بحساب Google" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ربط حساب Google/ })).toBeInTheDocument();
  });
});
