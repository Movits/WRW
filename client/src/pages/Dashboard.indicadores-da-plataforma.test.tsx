import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Dashboard from "./Dashboard";

/**
 * Os quatro indicadores da plataforma saíram da Home pública e passaram a
 * morar aqui, na área logada.
 *
 * O que este teste guarda, e que não se vê lendo o JSX:
 *
 *  1. Os números vêm da consulta `stats.platform` — a MESMA que alimentava a
 *     Hero. O segundo caso troca a resposta e exige que a tela mude junto: é
 *     o que separa "dado dinâmico" de "número cravado no código", que é
 *     exatamente o que o pedido proíbe.
 *  2. A grade de cima (matches, compatibilidade, top, conexões) é da USUÁRIA;
 *     esta é da PLATAFORMA. As duas têm um cartão de conexões, e sem o título
 *     de seção os dois números pareceriam o mesmo dado se contradizendo.
 *  3. Consulta que falhou não vira zero. Zero é um fato ("nenhuma
 *     oportunidade ativa"); o traço diz que o número não veio.
 *
 * O dublê do tRPC é o mesmo de Dashboard.i18n.test.tsx.
 */

type Resposta = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };

const duble = vi.hoisted(() => {
  const respostas: Record<string, Resposta | ((input: unknown) => Resposta)> = {};
  const refetches: Record<string, ReturnType<typeof vi.fn>> = {};
  const refetchDe = (caminho: string) => (refetches[caminho] ??= vi.fn());

  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";

  const procedimento = (caminho: string) => ({
    useQuery: (input: unknown, opcoes?: { select?: (dados: never) => unknown }) => {
      const registrada = respostas[caminho];
      const parcial = (typeof registrada === "function" ? registrada(input) : registrada) ?? {};
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: refetchDe(caminho), ...parcial };
      if (opcoes?.select && resultado.data !== undefined) resultado.data = opcoes.select(resultado.data as never);
      return resultado;
    },
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false, isError: false, error: null, data: undefined }),
  });

  const utils = new Proxy({}, {
    get: (_, router) => ignorar(router) ? undefined : new Proxy({}, {
      get: (_, proc) => ignorar(proc) ? undefined : new Proxy({}, {
        get: (_, metodo) => ignorar(metodo) ? undefined : vi.fn(async () => undefined),
      }),
    }),
  });

  const trpc = new Proxy({}, {
    get: (_, router) => {
      if (ignorar(router)) return undefined;
      if (router === "useUtils") return () => utils;
      return new Proxy({}, { get: (_, proc) => ignorar(proc) ? undefined : procedimento(`${String(router)}.${String(proc)}`) });
    },
  });

  return { respostas, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null, GlobalMenu: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));
// A seção está escondida em produção desde 16/09 (MOSTRAR_NUMEROS_DA_REDE, pedido do
// Rosber). Este arquivo guarda o comportamento dela LIGADA, para quando voltar;
// o estado desligado está em Dashboard.numeros-da-rede-escondidos.test.tsx.
vi.mock("@/lib/numeros-da-rede", () => ({ MOSTRAR_NUMEROS_DA_REDE: true }));

/** Os cartões entram escalonados e o número sobe animado; 3 s cobre CI carregado. */
const ESPERA = { timeout: 3000 };

/**
 * Números escolhidos para não colidirem entre si nem com os da grade da
 * usuária: um `getByText("3")` que casasse com dois cartões passaria por
 * acidente e não provaria nada.
 */
const PLATAFORMA = { users: 26, opportunities: 11, connections: 42, countries: 7, bronze: 0, silver: 0, gold: 0 };

function cenarioPadrao() {
  duble.respostas["profile.get"] = { data: { profile: { displayName: "Ana", profileCompleteness: 80 } } };
  // Um match só: a grade da usuária mostra 1, 85, 0 e 1 — nenhum bate com os da plataforma.
  duble.respostas["matches.list"] = { data: [{
    matchId: 1, overallScore: 85, userSeen: true,
    specialtyScore: 90, objectivesScore: 80, incomeScore: 70, locationScore: 60, valuesScore: 50,
    aiInsight: null, city: "Lisboa", country: "PT", primarySpecialty: "tech",
    seekingTypes: [], businessInterests: [], values: [], sector: null,
    connectionId: null, connectionStatus: null, souDestinataria: null, displayName: null,
  }] };
  duble.respostas["connections.list"] = { data: [{ id: 7, status: "accepted", souDestinataria: true, outraParteId: null, displayName: "Bia", primarySpecialty: "finance", city: "Porto", message: null }] };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
  duble.respostas["dealRoom.listRooms"] = { data: [] };
  duble.respostas["notifications.list"] = { data: [] };
  duble.respostas["stats.platform"] = { data: PLATAFORMA };
}

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Ana", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  cenarioPadrao();
});

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("indicadores da plataforma no Dashboard", () => {
  it("mostra os quatro, com os números que vieram de stats.platform", async () => {
    render(<Dashboard />);

    expect(await screen.findByRole("heading", { name: "A rede hoje" }, ESPERA)).toBeInTheDocument();

    for (const rotulo of ["Pessoas cadastradas", "Oportunidades ativas", "Conexões realizadas", "Países representados"]) {
      expect(screen.getByText(rotulo), rotulo).toBeInTheDocument();
    }

    await waitFor(() => {
      for (const numero of ["26", "11", "42", "7"]) {
        expect(screen.getByText(numero), numero).toBeInTheDocument();
      }
    }, ESPERA);
  });

  it("outra resposta, outros números: o dado é dinâmico, não está cravado", async () => {
    duble.respostas["stats.platform"] = { data: { ...PLATAFORMA, users: 137, countries: 19 } };
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("137")).toBeInTheDocument();
      expect(screen.getByText("19")).toBeInTheDocument();
    }, ESPERA);
    expect(screen.queryByText("26")).not.toBeInTheDocument();
  });

  it("consulta que falhou vira traço, não zero", async () => {
    duble.respostas["stats.platform"] = { isError: true, error: new Error("queda") };
    render(<Dashboard />);

    await waitFor(() => expect(screen.getAllByText("—")).toHaveLength(4), ESPERA);
  });

  it("as conexões da plataforma não se confundem com as da usuária", async () => {
    render(<Dashboard />);

    // Duas contagens de conexão na tela, ditas de jeitos diferentes: a da
    // usuária, no resumo em frases ("1 conexão feita", a regra do item 6.1 do
    // reteste v4), e a da rede inteira ("Conexões realizadas", 42).
    expect(await screen.findByText("Conexões realizadas", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("1 conexão feita")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument(), ESPERA);
  });

  it("os rótulos acompanham o idioma da usuária", async () => {
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    expect(await screen.findByRole("heading", { name: "The network today" }, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Countries represented")).toBeInTheDocument();
    expect(screen.queryByText("Países representados")).not.toBeInTheDocument();
  });
});
