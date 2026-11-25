import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import Dashboard from "./Dashboard";

/**
 * Rosber Severo, grupo, 16/09/2026 (véspera do lançamento), sobre "A rede hoje"
 * e "Membros por nível" no Dashboard: "isso aí fica suspenso, oculto, até a gente
 * ter números muito atraentes. O de baixo também".
 *
 * O primeiro teste lê a constante REAL (vi.importActual) e prende a decisão:
 * para religar as seções, troque-a para `true` e apague esse teste. Os outros
 * dois fixam a constante em `false` por vi.mock, então continuam valendo
 * depois de religar (é o comportamento de quando ela voltar a ser desligada):
 *  1. as duas seções fora da tela — títulos, rótulos e números;
 *  2. as duas consultas DESLIGADAS (`enabled: false`): esconder a seção e ainda
 *     buscar o número seria trabalho à toa a cada abertura do Dashboard;
 *  3. o resto do Dashboard de pé (anti-vacuidade: a tela renderizou, e as
 *     outras consultas continuam ligadas).
 *
 * Os testes da seção LIGADA continuam em Dashboard.indicadores-da-plataforma e
 * Dashboard.membros-por-nivel, com a constante trocada por vi.mock.
 */

type Resposta = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };

const duble = vi.hoisted(() => {
  const respostas: Record<string, Resposta> = {};
  /** O `enabled` com que cada consulta foi montada (o último render vence). */
  const ligada: Record<string, boolean> = {};
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";

  const procedimento = (caminho: string) => ({
    useQuery: (_input: unknown, opcoes?: { enabled?: boolean; select?: (dados: never) => unknown }) => {
      const habilitada = opcoes?.enabled !== false;
      ligada[caminho] = habilitada;
      // Como o React Query: consulta desligada não busca, então não há dado.
      const resposta = habilitada ? (respostas[caminho] ?? {}) : {};
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: vi.fn(), ...resposta };
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

  return { respostas, ligada, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null, GlobalMenu: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));
vi.mock("@/lib/numeros-da-rede", () => ({ MOSTRAR_NUMEROS_DA_REDE: false }));

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  for (const chave of Object.keys(duble.ligada)) delete duble.ligada[chave];
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Ana", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  duble.respostas["profile.get"] = { data: { profile: { displayName: "Ana", profileCompleteness: 80 } } };
  duble.respostas["matches.list"] = { data: [] };
  duble.respostas["connections.list"] = { data: [] };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  // Se as consultas estivessem ligadas, estes números iriam à tela.
  duble.respostas["stats.platform"] = { data: { users: 4040, opportunities: 3131, connections: 2727, countries: 1919 } };
  duble.respostas["stats.membrosPorNivel"] = { data: { bronze: 5151, silver: 6262, gold: 7373 } };
});

describe("Dashboard — números da rede escondidos até serem atraentes (Rosber, 16/09)", () => {
  it("a constante está desligada no código (para religar: true, e apagar este teste)", async () => {
    const real = await vi.importActual<typeof import("@/lib/numeros-da-rede")>("@/lib/numeros-da-rede");
    expect(real.MOSTRAR_NUMEROS_DA_REDE).toBe(false);
  });

  it("\"A rede hoje\" e \"Membros por nível\" não aparecem, nem os rótulos e números delas", async () => {
    render(<Dashboard />);
    // Anti-vacuidade: o Dashboard renderizou (o resumo das conexões da usuária está lá).
    expect(await screen.findByRole("region", { name: "Resumo das suas conexões" })).toBeInTheDocument();

    for (const texto of [
      "A rede hoje", "Pessoas cadastradas", "Oportunidades ativas", "Conexões realizadas", "Países representados",
      "Membros por nível", "Membros Bronze", "Membros Prata", "Membros Ouro",
    ]) {
      expect(screen.queryByText(texto), texto).not.toBeInTheDocument();
    }
    for (const numero of ["4040", "3131", "2727", "1919", "5151", "6262", "7373"]) {
      expect(screen.queryByText(numero), numero).not.toBeInTheDocument();
    }
  });

  it("as duas consultas ficam desligadas; as da usuária continuam ligadas", () => {
    render(<Dashboard />);

    expect(duble.ligada["stats.platform"]).toBe(false);
    expect(duble.ligada["stats.membrosPorNivel"]).toBe(false);
    expect(duble.ligada["matches.list"]).toBe(true);
    expect(duble.ligada["connections.list"]).toBe(true);
  });
});
