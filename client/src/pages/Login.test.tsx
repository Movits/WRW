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

const duble = vi.hoisted(() => ({ opcoes: null as unknown as Opcoes, mutate: vi.fn() }));

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
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Login from "./Login";

// A tela redireciona atribuindo window.location.href depois de 600 ms. No jsdom
// isso tentaria navegar de verdade, então location vira um simples, só para ler
// para onde ela mandou.
let destino: { href: string };

beforeEach(() => {
  vi.useFakeTimers();
  destino = { href: "" };
  vi.stubGlobal("location", destino);
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
