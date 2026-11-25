import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalMenu } from "./AppHeader";

/**
 * Dentro do app das lojas, a barra de abas de baixo já leva a Início, Minha
 * Rede, Reuniões, Oportunidades e Agenda (mobile/abas.ts), e o Menu do site
 * deixa de repetir essas telas: com as 9, ele tomava a tela do celular e
 * escondia o Sair. No navegador, o menu continua inteiro.
 */

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ auth: { me: { setData: () => {}, invalidate: () => Promise.resolve() } } }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: 7, name: "Fulana", role: "silver" }, isLoading: false, error: null, refetch: () => Promise.resolve() }),
      },
      logout: {
        useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false, error: null }),
      },
    },
  },
}));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

type JanelaDoApp = Window & { __wrwRotasDaBarraDoApp?: unknown };

const NA_BARRA = ["Reuniões", "Agenda", "Minha Rede", "Oportunidades"];
const SO_NO_MENU = ["Meu Network Inteligente", "Verificação", "Linha do Tempo", "Memória IA", "Conexões Inteligentes"];

async function abrirMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Sair" });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
});

afterEach(() => {
  delete (window as JanelaDoApp).__wrwRotasDaBarraDoApp;
  vi.unstubAllGlobals();
});

describe("o Menu do site dentro do app das lojas", () => {
  it("no navegador, mostra as 9 telas e o Sair", async () => {
    render(<GlobalMenu />);
    await abrirMenu();
    for (const nome of [...NA_BARRA, ...SO_NO_MENU]) expect(screen.getByText(nome)).toBeInTheDocument();
  });

  it("dentro do app, tira as telas da barra e mantém as outras e o Sair", async () => {
    (window as JanelaDoApp).__wrwRotasDaBarraDoApp = ["/dashboard", "/network", "/meetings", "/opportunities", "/agenda"];
    render(<GlobalMenu />);
    await abrirMenu();
    for (const nome of NA_BARRA) expect(screen.queryByText(nome)).not.toBeInTheDocument();
    for (const nome of SO_NO_MENU) expect(screen.getByText(nome)).toBeInTheDocument();
  });

  it("lê a lista ao abrir: vale mesmo se o app a gravar depois de o cabeçalho montar", async () => {
    render(<GlobalMenu />);
    (window as JanelaDoApp).__wrwRotasDaBarraDoApp = ["/meetings"];
    await abrirMenu();
    expect(screen.queryByText("Reuniões")).not.toBeInTheDocument();
    expect(screen.getByText("Agenda")).toBeInTheDocument();
  });
});
