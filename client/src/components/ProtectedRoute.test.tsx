import { useAuth } from "@/_core/hooks/useAuth";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProtectedRoute from "./ProtectedRoute";

// O hook de verdade fala com o tRPC; aqui ele vira um dublê que devolve o
// papel que cada caso pede.
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));

// Os cinco papéis do enum users.role em drizzle/schema.ts.
type Papel = "bronze" | "silver" | "gold" | "president" | "admin";
const TODOS_OS_PAPEIS: Papel[] = [
  "bronze",
  "silver",
  "gold",
  "president",
  "admin",
];

function simularAuth(estado: { papel?: string; carregando?: boolean; cadastroConcluido?: boolean }) {
  const user = estado.papel
    ? {
        id: 1,
        role: estado.papel,
        ...(estado.cadastroConcluido === undefined ? {} : { onboardingCompleted: estado.cadastroConcluido }),
      }
    : null;
  vi.mocked(useAuth).mockReturnValue({
    user,
    loading: estado.carregando ?? false,
    error: null,
    isAuthenticated: user !== null,
    refresh: vi.fn(),
    logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

// A guarda redireciona atribuindo window.location.href. No jsdom isso tentaria
// navegar de verdade (e o jsdom só avisa que não implementa navegação), então
// o objeto location inteiro vira um simples, só para ler para onde a guarda
// mandou. No Vitest, window === globalThis, por isso stubGlobal alcança.
let destino: { href: string };

beforeEach(() => {
  destino = { href: "" };
  vi.stubGlobal("location", destino);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILHO = "conteúdo protegido";

function renderizar(
  props: Omit<ComponentProps<typeof ProtectedRoute>, "children"> = {}
) {
  return render(
    <ProtectedRoute {...props}>
      <p>{FILHO}</p>
    </ProtectedRoute>
  );
}

function esperaEntrar() {
  expect(screen.getByText(FILHO)).toBeInTheDocument();
  expect(destino.href).toBe("");
}

function esperaBarrar(paraOnde: string) {
  expect(screen.queryByText(FILHO)).not.toBeInTheDocument();
  expect(destino.href).toBe(paraOnde);
}

describe("ProtectedRoute", () => {
  it("enquanto carrega, mostra o aviso e não renderiza os filhos nem redireciona", () => {
    // Sem usuária e com requireAdmin: se a guarda ignorasse o loading, ela
    // mandaria para o login antes de saber quem é.
    simularAuth({ carregando: true });
    renderizar({ requireAdmin: true });

    expect(screen.getByText("Verificando acesso...")).toBeInTheDocument();
    expect(screen.queryByText(FILHO)).not.toBeInTheDocument();
    expect(destino.href).toBe("");
  });

  describe("sem autenticação", () => {
    it("manda para o login e não renderiza os filhos", () => {
      simularAuth({});
      renderizar();
      esperaBarrar("/login");
    });

    it("respeita redirectTo no lugar do login", () => {
      simularAuth({});
      renderizar({ redirectTo: "/entrar" });
      esperaBarrar("/entrar");
    });

    // Quem abre /gravar ou o link de uma reunião deslogada volta a ela depois
    // de entrar (Login.tsx lê o ?voltar=). Os casos acima seguem em /login
    // porque o dublê de location não tem pathname.
    it.each([
      ["/gravar", "", "/login?voltar=%2Fgravar"],
      ["/meetings/abc", "?t=90", "/login?voltar=%2Fmeetings%2Fabc%3Ft%3D90"],
      ["/login", "", "/login"],
      ["/", "", "/login"],
    ])("em %s%s leva o caminho de volta ao login: %s", (pathname, search, esperado) => {
      destino = { href: "", pathname, search } as typeof destino;
      vi.stubGlobal("location", destino);
      simularAuth({});
      renderizar();
      esperaBarrar(esperado);
    });

    it.each([
      ["requireAdmin", { requireAdmin: true }],
      ["requireGold", { requireGold: true }],
      ["requireOpportunities", { requireOpportunities: true }],
    ] as const)(
      "com %s, o login vem antes da checagem de nível",
      (_nome, props) => {
        simularAuth({});
        renderizar(props);
        esperaBarrar("/login");
      }
    );
  });

  describe("só autenticação", () => {
    it.each(TODOS_OS_PAPEIS)("%s entra", papel => {
      simularAuth({ papel });
      renderizar();
      esperaEntrar();
    });
  });

  describe("requireAdmin", () => {
    it("admin entra", () => {
      simularAuth({ papel: "admin" });
      renderizar({ requireAdmin: true });
      esperaEntrar();
    });

    // Aqui admin é estrito: nem president passa (diferente da regra
    // "Ouro = Presidente" do requireGold).
    it.each(["bronze", "silver", "gold", "president"] as Papel[])(
      "%s vai para /404 sem ver os filhos",
      papel => {
        simularAuth({ papel });
        renderizar({ requireAdmin: true });
        esperaBarrar("/404");
      }
    );
  });

  describe("requireGold", () => {
    it.each(["gold", "president", "admin"] as Papel[])("%s entra", papel => {
      simularAuth({ papel });
      renderizar({ requireGold: true });
      esperaEntrar();
    });

    it.each(["bronze", "silver"] as Papel[])(
      "%s vai para /dashboard sem ver os filhos",
      papel => {
        simularAuth({ papel });
        renderizar({ requireGold: true });
        esperaBarrar("/dashboard");
      }
    );
  });

  describe("requireOpportunities", () => {
    it.each(TODOS_OS_PAPEIS)("%s entra", papel => {
      simularAuth({ papel });
      renderizar({ requireOpportunities: true });
      esperaEntrar();
    });

    it("papel fora do enum vai para /dashboard sem ver os filhos", () => {
      simularAuth({ papel: "visitante" });
      renderizar({ requireOpportunities: true });
      esperaBarrar("/dashboard");
    });
  });

  it("as guardas se acumulam: requireAdmin barra o Ouro mesmo com requireGold junto", () => {
    simularAuth({ papel: "gold" });
    renderizar({ requireAdmin: true, requireGold: true });
    esperaBarrar("/404");
  });

  // O Termo Geral de Uso é aceito na última etapa do cadastro; quem não o
  // concluiu digitava /dashboard e usava a plataforma sem o termo.
  describe("cadastro não concluído", () => {
    it.each(TODOS_OS_PAPEIS)("%s vai para /onboarding sem ver os filhos", papel => {
      simularAuth({ papel, cadastroConcluido: false });
      renderizar();
      esperaBarrar("/onboarding");
    });

    it("vem antes da checagem de nível: admin incompleto no /admin vai para /onboarding, não entra", () => {
      simularAuth({ papel: "admin", cadastroConcluido: false });
      renderizar({ requireAdmin: true });
      esperaBarrar("/onboarding");
    });

    it("sem sessão, o login vem antes", () => {
      simularAuth({});
      renderizar();
      esperaBarrar("/login");
    });

    it("a rota do próprio cadastro (permitirCadastroIncompleto) deixa entrar", () => {
      simularAuth({ papel: "bronze", cadastroConcluido: false });
      renderizar({ permitirCadastroIncompleto: true });
      esperaEntrar();
    });

    it("cadastro concluído entra normalmente", () => {
      simularAuth({ papel: "silver", cadastroConcluido: true });
      renderizar();
      esperaEntrar();
    });

    it("sem o campo não há veredito (=== false, como no servidor): entra", () => {
      simularAuth({ papel: "silver" });
      renderizar();
      esperaEntrar();
    });
  });
});
