import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import { AppHeader, getMenuItems } from "./AppHeader";

/**
 * Menu global (reverificação de 04/09): o header único das telas traduzidas
 * tinha o menu, o botão "Menu", "Navegação", "Painel Ouro" e o título do
 * avatar em português fixo — só "Sair" trocava de idioma. Aqui se prova que
 * os rótulos passam por t() e acompanham o idioma escolhido.
 */

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: { auth: { logout: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } } },
}));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

const PORTUGUES = [
  "Oportunidades", "Verificação", "Minha Rede", "Linha do Tempo", "Reuniões", "Memória IA", "Conexões Inteligentes",
  "Propostas e negócios", "Identidade e selo", "Sua base particular", "Onde e como conheceu", "Gravações e transcrições",
  "Pergunte ao seu", "Sugestões entre os seus", "Meu Network Inteligente", "oportunidades da sua rede",
];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role: "gold" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

describe("AppHeader — o menu global fala o idioma da usuária", () => {
  it("getMenuItems em inglês: 8 itens, nenhum rótulo ou descrição em português", () => {
    const itens = getMenuItems(i18n.getFixedT("en"));
    // Reuniões em primeiro: o gravador é a primeira tela do app (30/10/2026).
    expect(itens.map(i => i.href)).toEqual([
      "/meetings", "/meu-network-inteligente", "/opportunities", "/verification", "/network", "/contexts", "/memory", "/intelligent-matches",
    ]);
    expect(itens.map(i => i.label)).toEqual([
      "Meetings", "My Smart Network", "Opportunities", "Verification", "My Network", "Timeline", "AI Memory", "Smart Connections",
    ]);
    for (const item of itens) {
      for (const pt of PORTUGUES) {
        expect(item.label).not.toContain(pt);
        expect(item.desc).not.toContain(pt);
      }
      expect(item.desc.length).toBeGreaterThan(0);
    }
  });

  it("em inglês: botão do menu, título do avatar e, aberto, a navegação inteira saem traduzidos", async () => {
    await i18n.changeLanguage("en");
    render(<AppHeader title="Meetings" />);

    const botao = screen.getByRole("button", { name: /menu/i });
    expect(botao).toHaveTextContent(i18n.getFixedT("en")("appHeader.menuButton"));
    expect(screen.getByTitle("My Profile")).toBeInTheDocument();
    expect(screen.queryByTitle("Meu Perfil")).not.toBeInTheDocument();

    fireEvent.keyDown(botao, { key: "Enter" });
    expect(await screen.findByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("My Network")).toBeInTheDocument();
    expect(screen.getByText("Gold Panel")).toBeInTheDocument();
    expect(screen.getByText("Governance and validations")).toBeInTheDocument();
    for (const pt of ["Navegação", "Minha Rede", "Painel Ouro", "Governança e validações"]) {
      expect(screen.queryByText(pt)).not.toBeInTheDocument();
    }
  });

  it("em chinês o próprio botão 'Menu' troca de texto — não era rótulo fixo", async () => {
    await i18n.changeLanguage("zh");
    render(<AppHeader />);
    expect(screen.getByText("菜单")).toBeInTheDocument();
    expect(screen.queryByText("Menu")).not.toBeInTheDocument();
    expect(screen.getByTitle("我的资料")).toBeInTheDocument();
  });
});
