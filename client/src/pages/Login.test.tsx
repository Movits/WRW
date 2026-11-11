import { act, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";

/**
 * Saudação do login (reteste v4, item 8): quem acabava de se cadastrar e
 * entrava pela primeira vez lia "Boas-vindas de volta" — mensagem de quem
 * volta. Quem decide é o `onboardingCompleted` que a resposta do login traz:
 * cadastro por concluir = primeiro acesso (auth.welcomeFirst, e o destino é
 * /onboarding); cadastro concluído = auth.welcomeBack, com o gravador (/gravar)
 * ou a tela do ?voltar=.
 */

type Opcoes = {
  onSuccess: (data: { user: { name: string | null; onboardingCompleted: boolean } }) => void;
  onError: (erro: { message: string }) => void;
};

type Sessao = { user: { onboardingCompleted: boolean } | null; loading: boolean };

const duble = vi.hoisted(() => ({
  opcoes: null as unknown as Opcoes,
  mutate: vi.fn(),
  navigate: vi.fn(),
  sessao: { user: null, loading: false } as Sessao,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      login: {
        useMutation: (opcoes: Opcoes) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: false };
        },
      },
    },
  },
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLocation: () => ["/login", duble.navigate],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// O hook de verdade fala com o tRPC (auth.me); aqui ele devolve a sessão que cada caso pede.
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => duble.sessao }));

import Login from "./Login";

// A tela redireciona atribuindo window.location.href depois de 600 ms. No jsdom
// isso tentaria navegar de verdade, então location vira um simples, só para ler
// para onde ela mandou.
let destino: { href: string };

beforeEach(() => {
  vi.useFakeTimers();
  destino = { href: "" };
  vi.stubGlobal("location", destino);
  duble.sessao = { user: null, loading: false };
  duble.navigate.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

/** Renderiza o login e faz a entrada dar certo para a usuária descrita. */
function entrar(onboardingCompleted: boolean, name: string | null = "Ana Souza") {
  render(<Login />);
  act(() => duble.opcoes.onSuccess({ user: { name, onboardingCompleted } }));
}

/** O texto do toast de sucesso, sem a descrição. */
function saudacao() {
  return vi.mocked(toast.success).mock.calls.at(-1)?.[0];
}

describe("Login — saudação do primeiro acesso", () => {
  it("cadastro por concluir: saúda como primeiro acesso, não como quem volta", () => {
    entrar(false);
    expect(saudacao()).toBe("Boas-vindas, ANA!");
    expect(saudacao()).not.toMatch(/de volta/);
  });

  it("cadastro concluído: saúda quem volta", () => {
    entrar(true);
    expect(saudacao()).toBe("Boas-vindas de volta, ANA!");
  });

  it("a saudação do primeiro acesso acompanha o destino: cadastro por concluir vai ao /onboarding", () => {
    entrar(false);
    act(() => vi.advanceTimersByTime(600));
    expect(destino.href).toBe("/onboarding");
  });

  // O gravador é a primeira tela depois do login (pedido da cliente de
  // 20/10/2026); o fim do cadastro continua levando ao Dashboard (Onboarding.tsx).
  it("quem volta vai ao gravador, /gravar", () => {
    entrar(true);
    act(() => vi.advanceTimersByTime(600));
    expect(destino.href).toBe("/gravar");
  });

  it("com ?voltar= seguro, volta à tela que pediu", () => {
    destino = { href: "", search: "?voltar=%2Fnetwork" } as typeof destino;
    vi.stubGlobal("location", destino);
    entrar(true);
    act(() => vi.advanceTimersByTime(600));
    expect(destino.href).toBe("/network");
  });

  it.each(["?voltar=https%3A%2F%2Fexemplo.com", "?voltar=%2F%2Fexemplo.com", "?voltar=%2F%5Cexemplo.com", "?voltar=%2F..%2F%2Fexemplo.com"])(
    "com ?voltar= para fora do site (%s), ignora e vai ao gravador",
    (search) => {
      destino = { href: "", search } as typeof destino;
      vi.stubGlobal("location", destino);
      entrar(true);
      act(() => vi.advanceTimersByTime(600));
      expect(destino.href).toBe("/gravar");
    },
  );

  it("cadastro por concluir vai ao /onboarding mesmo com ?voltar=", () => {
    destino = { href: "", search: "?voltar=%2Fnetwork" } as typeof destino;
    vi.stubGlobal("location", destino);
    entrar(false);
    act(() => vi.advanceTimersByTime(600));
    expect(destino.href).toBe("/onboarding");
  });

  it.each(LANGUAGES.map(l => l.code))("em %s as duas saudações existem, são diferentes e trazem o nome", async (idioma) => {
    await i18n.changeLanguage(idioma);

    entrar(false);
    const primeira = String(saudacao());
    entrar(true);
    const devolta = String(saudacao());

    for (const texto of [primeira, devolta]) {
      expect(texto, idioma).not.toMatch(/auth\./);
      expect(texto, idioma).not.toContain("{{");
      expect(texto, idioma).toContain("ANA");
    }
    expect(primeira, idioma).not.toBe(devolta);
  });
});

/**
 * Pedido do Roberto em 10/11/2026: quem já entrou não digita e-mail e senha
 * de novo. Com a sessão viva (auth.me devolve a usuária), o /login segue
 * direto para o destino que o login daria, sem mostrar o formulário.
 */
describe("Login — quem já está logada não vê o formulário", () => {
  it("cadastro concluído: segue ao gravador, trocando a entrada do histórico", () => {
    duble.sessao = { user: { onboardingCompleted: true }, loading: false };
    const { container } = render(<Login />);
    expect(duble.navigate).toHaveBeenCalledWith("/gravar", { replace: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("com ?voltar= seguro, segue à tela que pediu", () => {
    vi.stubGlobal("location", { href: "", search: "?voltar=%2Fnetwork" });
    duble.sessao = { user: { onboardingCompleted: true }, loading: false };
    render(<Login />);
    expect(duble.navigate).toHaveBeenCalledWith("/network", { replace: true });
  });

  it("cadastro por concluir: segue ao /onboarding", () => {
    duble.sessao = { user: { onboardingCompleted: false }, loading: false };
    render(<Login />);
    expect(duble.navigate).toHaveBeenCalledWith("/onboarding", { replace: true });
  });

  it("enquanto confere a sessão, não pisca o formulário nem navega", () => {
    duble.sessao = { user: null, loading: true };
    const { container } = render(<Login />);
    expect(container).toBeEmptyDOMElement();
    expect(duble.navigate).not.toHaveBeenCalled();
  });

  it("sem sessão, mostra o formulário e fica no /login", () => {
    const { container } = render(<Login />);
    expect(container.querySelector("input[type=email]")).not.toBeNull();
    expect(duble.navigate).not.toHaveBeenCalled();
  });
});

/**
 * Revisão da PR #179: o cadastro e a redefinição de senha mandam ao login
 * ("agora faça login"). Num aparelho com OUTRA conta logada, seguir sozinho
 * levava quem acabou de criar a conta para dentro da conta alheia. Eles mandam
 * a `LOGIN_COM_FORMULARIO` (`/login?entrar=1`), e aí o formulário aparece.
 */
describe("Login — ?entrar mostra o formulário mesmo com sessão viva", () => {
  it("com outra conta logada e ?entrar=1: formulário, sem seguir adiante", () => {
    vi.stubGlobal("location", { href: "", search: "?entrar=1" });
    duble.sessao = { user: { onboardingCompleted: true }, loading: false };
    const { container } = render(<Login />);
    expect(container.querySelector("input[type=email]")).not.toBeNull();
    expect(duble.navigate).not.toHaveBeenCalled();
  });

  it("com ?entrar=1, o formulário não espera a sessão carregar", () => {
    vi.stubGlobal("location", { href: "", search: "?entrar=1" });
    duble.sessao = { user: null, loading: true };
    const { container } = render(<Login />);
    expect(container.querySelector("input[type=email]")).not.toBeNull();
  });

  it("o endereço que o cadastro e a redefinição usam é o /login com ?entrar", async () => {
    const { LOGIN_COM_FORMULARIO } = await import("@/lib/caminho-de-volta");
    const url = new URL(LOGIN_COM_FORMULARIO, "https://wrw.invalid");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.has("entrar")).toBe(true);
  });
});
