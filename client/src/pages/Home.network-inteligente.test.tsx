import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Home from "./Home";

/**
 * Home — a seção "Meu Network Inteligente" substitui a antiga "Segurança"
 * (pedido do Nicolas, 13/09/2026).
 *
 * O que se trava aqui:
 * - a seção antiga sumiu da tela, inclusive a promessa falsa de "criptografia
 *   ponta a ponta" (não existe no servidor);
 * - os textos novos aparecem como pedidos, com os 4 cards;
 * - o CTA leva quem não entrou ao cadastro de sempre (/register) e quem já
 *   entrou ao painel Meu Network Inteligente (/meu-network-inteligente);
 * - os dois itens de menu (desktop e celular) rolam até a seção nova.
 *
 * O globo 3D, as consultas de números e o FAQ viram dublês: o teste é da
 * seção, não do WebGL nem do banco.
 */

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/GloboDoMundo", () => ({ default: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    stats: {
      platform: { useQuery: () => ({ data: undefined }) },
      presencaPorPais: { useQuery: () => ({ data: undefined }) },
    },
    faq: { ask: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, data: undefined }) } },
  },
}));

class IntersectionObserverFalso {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const scrollIntoView = vi.fn();

function comSessao(isAuthenticated: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    user: isAuthenticated ? { id: 1, name: "Ana", role: "silver" } : null,
    loading: false, error: null, isAuthenticated, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

const secao = () => document.getElementById("network-inteligente") as HTMLElement;

beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverFalso);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  await i18n.changeLanguage("pt-BR");
  comSessao(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Home — Meu Network Inteligente no lugar de Segurança", () => {
  it("a seção antiga sumiu, inclusive a promessa de criptografia ponta a ponta", () => {
    render(<Home />);
    expect(document.getElementById("seguranca")).toBeNull();
    expect(screen.queryByText("Segurança e privacidade em primeiro lugar")).not.toBeInTheDocument();
    expect(screen.queryByText(/ponta a ponta/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Bloqueio de acessos suspeitos")).not.toBeInTheDocument();
    expect(screen.queryByText("Verificação de identidade")).not.toBeInTheDocument();
  });

  it("a seção nova traz rótulo, título, subtítulo, frase de impacto, os 4 cards e o fechamento, como pedidos", () => {
    render(<Home />);
    const s = within(secao());
    expect(s.getByText("Meu Network Inteligente")).toBeInTheDocument();
    expect(s.getByRole("heading", { level: 2, name: "Você se lembra de todas as oportunidades que existem na sua própria rede?" })).toBeInTheDocument();
    expect(s.getByText("Cada reunião pode esconder uma oportunidade futura. Nossa inteligência registra, organiza e conecta o valor das relações que você construiu.")).toBeInTheDocument();
    expect(s.getByText("Você conhece mais oportunidades do que consegue lembrar.")).toBeInTheDocument();

    const titulos = s.getAllByRole("heading", { level: 3 }).map(h => h.textContent);
    expect(titulos).toEqual([
      "GRAVE E NÃO ESQUEÇA",
      "A IA ORGANIZA PARA VOCÊ",
      "DESCUBRA NEGÓCIOS NA SUA PRÓPRIA REDE",
      "FAÇA SUA REDE GERAR VALOR",
    ]);
    // Desde a G13b a gravação vai até as 12 h da gravação em partes, sem o teto de 10 minutos.
    expect(s.getByText("Registre e transcreva gratuitamente reuniões de até 12 horas e transforme conversas em memória estratégica.")).toBeInTheDocument();

    expect(s.getByText("Quantos negócios estão escondidos hoje entre as pessoas que você já conhece?")).toBeInTheDocument();
    expect(s.getByText("Transforme reuniões em memória. Memória em inteligência. Inteligência em conexões. E conexões em negócios.")).toBeInTheDocument();
  });

  it("sem sessão, o CTA leva ao cadastro de sempre (/register)", () => {
    render(<Home />);
    const cta = within(secao()).getByRole("button", { name: /ATIVAR MEU NETWORK INTELIGENTE/ });
    expect(cta.closest("a")).toHaveAttribute("href", "/register");
  });

  it("com sessão, o CTA leva ao painel Meu Network Inteligente", () => {
    comSessao(true);
    render(<Home />);
    const cta = within(secao()).getByRole("button", { name: /ATIVAR MEU NETWORK INTELIGENTE/ });
    expect(cta.closest("a")).toHaveAttribute("href", "/meu-network-inteligente");
  });

  it("os itens de menu (desktop e celular) dizem Meu Network Inteligente e rolam até a seção nova", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<Home />);
    const itens = screen.getAllByRole("button", { name: "Meu Network Inteligente" });
    expect(itens).toHaveLength(2);
    for (const item of itens) {
      scrollIntoView.mockClear();
      fireEvent.click(item);
      act(() => { vi.advanceTimersByTime(60); });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(secao());
    }
  });
});
