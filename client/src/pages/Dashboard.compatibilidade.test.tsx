import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Dashboard, {
  CORES_DAS_FAIXAS, corDaFaixaDeCompatibilidade, faixaDeCompatibilidade, rotuloDaFaixaDeCompatibilidade,
} from "./Dashboard";

/**
 * Reteste v4 do Gabriel, itens 6.3 e 12 — medidos em produção:
 *
 * 6.3 "Compatibilidade Média" mostrava o número sem "%": o StatCard não
 *     repassava sufixo nenhum, embora o AnimatedNumber já aceite `suffix`.
 * 12  Os indicadores de compatibilidade dos cartões (anel do match e anel da
 *     oportunidade recomendada) pintavam em TRÊS cores (80+ verde, 60+ marrom,
 *     resto azul) e o gráfico de distribuição da MESMA tela em CINCO: 65%
 *     saía marrom no anel e azul na barra da faixa 60–80. Uma função só de cor
 *     por faixa para os dois, e o rótulo da faixa junto do número — cor não
 *     pode ser o único indicador.
 */

const duble = vi.hoisted(() => {
  const respostas: Record<string, { data?: unknown; isError?: boolean; error?: unknown }> = {};
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: (_input: unknown, opcoes?: { select?: (dados: never) => unknown }) => {
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: vi.fn(), ...(respostas[caminho] ?? {}) };
      if (opcoes?.select && resultado.data !== undefined) resultado.data = opcoes.select(resultado.data as never);
      return resultado;
    },
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false, isError: false, error: null, data: undefined }),
  });
  const utils = new Proxy({}, {
    get: (_, r) => ignorar(r) ? undefined : new Proxy({}, {
      get: (_, p) => ignorar(p) ? undefined : new Proxy({}, { get: (_, m) => ignorar(m) ? undefined : vi.fn(async () => undefined) }),
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

function cartao(extra: Record<string, unknown> = {}) {
  return {
    matchId: 1, overallScore: 65, userSeen: true,
    specialtyScore: 90, objectivesScore: 80, incomeScore: 70, locationScore: 60, valuesScore: 50,
    aiInsight: null, city: "Lisboa", country: "PT", primarySpecialty: "tech",
    seekingTypes: [], businessInterests: [], values: [], sector: null,
    displayName: null, connectionId: null, connectionStatus: null, souDestinataria: null,
    ...extra,
  };
}

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Ana", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  duble.respostas["profile.get"] = { data: { profile: { displayName: "Ana", city: "Lisboa", profileCompleteness: 80 } } };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  duble.respostas["matches.list"] = { data: [cartao()] };
  duble.respostas["connections.list"] = { data: [] };
  duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
  duble.respostas["dealRoom.listRooms"] = { data: [] };
  duble.respostas["notifications.list"] = { data: [] };
});

// Desde 25/11 o item 6.3 vale para o resumo em frases (components/ResumoDasConexoes.tsx):
// a afinidade média é a única porcentagem, e sai com "%" na frase.
describe("item 6.3 — o '%' da afinidade média, no resumo em frases", () => {
  it("a frase diz quantas pessoas combinam, e a afinidade média sai com '%'", async () => {
    duble.respostas["matches.list"] = { data: [cartao({ matchId: 1, overallScore: 70 }), cartao({ matchId: 2, overallScore: 60 })] };
    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("2 pessoas combinam com você")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText("65% de afinidade em média")).toBeInTheDocument();
  });

  it("com alguém de 80% ou mais, o detalhe diz quantas combinam muito", async () => {
    duble.respostas["matches.list"] = { data: [cartao({ matchId: 1, overallScore: 85 }), cartao({ matchId: 2, overallScore: 60 })] };
    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("1 delas combina muito")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/de afinidade em média/)).not.toBeInTheDocument();
  });

  it("consulta que falhou diz que não carregou: nem zero, nem '%' pendurado", async () => {
    duble.respostas["matches.list"] = { isError: true, error: new Error("banco fora"), data: undefined };
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Não deu para carregar suas sugestões agora")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/de afinidade em média/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhuma sugestão nova por enquanto")).not.toBeInTheDocument();
  });
});

describe("item 12 — uma paleta só por faixa de compatibilidade", () => {
  it("a faixa é a mesma de 20 em 20 do gráfico de distribuição", () => {
    expect([10, 30, 45, 65, 85].map(faixaDeCompatibilidade)).toEqual([0, 1, 2, 3, 4]);
    expect(faixaDeCompatibilidade(100)).toBe(4);
    expect(faixaDeCompatibilidade(0)).toBe(0);
  });

  it("a cor de cada nota é a cor da barra da faixa dela", () => {
    // As quatro primeiras discriminam: o anel antigo pintava 10, 30 e 45 de
    // azul (#3b82f6) e 65 de marrom (#c98f70).
    expect(corDaFaixaDeCompatibilidade(10)).toBe(CORES_DAS_FAIXAS[0]);
    expect(corDaFaixaDeCompatibilidade(30)).toBe(CORES_DAS_FAIXAS[1]);
    expect(corDaFaixaDeCompatibilidade(45)).toBe(CORES_DAS_FAIXAS[2]);
    expect(corDaFaixaDeCompatibilidade(65)).toBe(CORES_DAS_FAIXAS[3]);
    expect(corDaFaixaDeCompatibilidade(85)).toBe(CORES_DAS_FAIXAS[4]);
    expect([...CORES_DAS_FAIXAS]).toEqual(["#ef4444", "#f97316", "#c98f70", "#3b82f6", "#10b981"]);
  });

  it("cada faixa tem rótulo traduzido e diferente das outras", () => {
    const rotulos = [10, 30, 45, 65, 85].map(n => rotuloDaFaixaDeCompatibilidade(i18n.t, n));
    expect(new Set(rotulos).size).toBe(5);
    for (const rotulo of rotulos) expect(rotulo).not.toMatch(/^dashboard\./);
  });

  it("o anel do cartão de match usa a cor da faixa e diz a faixa por escrito", async () => {
    render(<Dashboard />);
    const anel = document.querySelector('svg[width="64"]')!;
    // O anel anima o número; a cor final é a da faixa de 65 (60–80), não a
    // marrom de "60 ou mais" que o anel usava.
    await waitFor(() => {
      const arco = anel.querySelectorAll("circle")[1];
      expect(arco.getAttribute("stroke")).toBe(CORES_DAS_FAIXAS[3]);
    }, { timeout: 4000 });
    expect(screen.getAllByText(rotuloDaFaixaDeCompatibilidade(i18n.t, 65)).length).toBeGreaterThan(0);
  });

  it("o anel da oportunidade recomendada usa a mesma função", async () => {
    duble.respostas["matching.getRecommendedOpportunities"] = { data: [{
      id: 7, title: "Distribuição na Península", sector: "technology", type: "offer",
      complianceLevel: "green", compatibilityScore: 45, compatibilityReason: "motivo",
    }] };
    render(<Dashboard />);

    const arco = (await screen.findByText("Distribuição na Península"))
      .closest("div.p-5")!.querySelector('svg[width="56"]')!.querySelectorAll("circle")[1];
    // 45 caía em azul no getScoreColor antigo; na paleta do gráfico é 40–60.
    expect(arco.getAttribute("stroke")).toBe(CORES_DAS_FAIXAS[2]);
    expect(screen.getAllByText(rotuloDaFaixaDeCompatibilidade(i18n.t, 45)).length).toBeGreaterThan(0);
  });
});
