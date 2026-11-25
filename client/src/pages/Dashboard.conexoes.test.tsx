import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Dashboard, { normalizarCaixa, normalizarCidade } from "./Dashboard";

/**
 * Reteste v4 do Gabriel, itens 6.1, 6.2 e 13 — defeitos medidos em produção na
 * aba Conexões:
 *
 * 6.1 O cartão de resumo contava só `status === "accepted"` e a aba contava
 *     `connections.length` (com pendentes e recusadas dentro), da MESMA
 *     consulta: dois números diferentes para a mesma coisa na mesma tela.
 *     Decisão do Roberto: vale a regra do cartão (conexões efetivadas) nos
 *     dois lugares, com o rótulo dizendo o que é contado.
 * 6.2 Um "0" solto aparecia abaixo da linha de setor/cidade: `souDestinataria`
 *     é `sql<boolean>` e o driver do MySQL devolve 1/0, então
 *     `status === "pending" && conn.souDestinataria` valia `0` — e o React
 *     desenha o zero. Os dublês abaixo devolvem 1 e 0, a forma real do driver.
 * 13  Usabilidade da lista: setor e cidade normalizados ("Cidade, UF"),
 *     rótulos sem ambiguidade, data da solicitação e agrupamento por status.
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

const CRIADA_EM = new Date("2026-09-10T12:00:00Z");
const DATA_NA_TELA = CRIADA_EM.toLocaleDateString("pt-BR");

/** A linha exata que `getConnectionsForUser` devolve — `souDestinataria` em 1/0. */
function conexao(extra: Record<string, unknown> = {}) {
  return {
    id: 1, status: "pending", createdAt: CRIADA_EM, souDestinataria: 0,
    city: "Lisboa", primarySpecialty: "Tecnologia & Software",
    outraParteId: null, message: null, displayName: null, avatarUrl: null,
    userName: null, userCompany: null,
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
  duble.respostas["matches.list"] = { data: [] };
  duble.respostas["connections.list"] = { data: [] };
  duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
  duble.respostas["dealRoom.listRooms"] = { data: [] };
  duble.respostas["notifications.list"] = { data: [] };
});

function abrirConexoes() {
  const aba = screen.getAllByRole("button").find(b => /^Conexões( \(|$)/.test(b.textContent ?? ""));
  if (!aba) throw new Error("aba Conexões não encontrada");
  aba.click();
}

// Desde 25/11 o "cartão" do item 6.1 é a linha de conexões feitas do resumo em
// frases (components/ResumoDasConexoes.tsx): a regra continua a mesma da aba.
describe("item 6.1 — o resumo e a aba contam a mesma coisa", () => {
  it("as duas contagens são as conexões efetivadas, e a aba diz isso a quem passa o mouse", async () => {
    duble.respostas["connections.list"] = { data: [
      conexao({ id: 1, status: "accepted", displayName: "Bia", souDestinataria: 1 }),
      conexao({ id: 2, status: "pending", souDestinataria: 0 }),
      conexao({ id: 3, status: "in_review", souDestinataria: 0 }),
      conexao({ id: 4, status: "declined", souDestinataria: 1 }),
    ] };
    render(<Dashboard />);

    // A aba conta o mesmo que o resumo: 1 efetivada entre as 4 linhas.
    const aba = screen.getAllByRole("button").find(b => b.textContent === `${i18n.t("dashboard.connections")} (1)`);
    expect(aba).toHaveAttribute("title", i18n.t("dashboard.connectionsEstablished"));
    expect(screen.getAllByRole("button").some(b => (b.textContent ?? "").includes("(4)"))).toBe(false);

    await waitFor(() => expect(screen.getByText("1 conexão feita")).toBeInTheDocument(), { timeout: 4000 });
    // O pendente enviado por mim (souDestinataria 0) não é pedido para eu responder.
    expect(screen.queryByText(/quer(em)? se conectar com você/)).not.toBeInTheDocument();
  });
});

describe("resumo em frases — o pedido que espera a minha resposta", () => {
  it("vem primeiro, e 'Responder' abre a aba Conexões", async () => {
    duble.respostas["connections.list"] = { data: [
      conexao({ id: 1, status: "pending", souDestinataria: 1 }),
      conexao({ id: 2, status: "pending", souDestinataria: 1 }),
    ] };
    render(<Dashboard />);

    const resumo = await screen.findByRole("region", { name: "Resumo das suas conexões" });
    expect(resumo.querySelector("li")?.textContent).toContain("2 pessoas querem se conectar com você");
    screen.getByRole("button", { name: "Responder: 2 pessoas querem se conectar com você" }).click();
    expect(await screen.findAllByRole("button", { name: i18n.t("dashboard.acceptReveal") }, { timeout: 2000 })).toHaveLength(2);
  });

  it("sem conexão feita e com sugestões, a linha é o próximo passo; sem sugestões, ela some", async () => {
    duble.respostas["matches.list"] = { data: [{ matchId: 9, overallScore: 70, userSeen: true }] };
    const { unmount } = render(<Dashboard />);
    expect(await screen.findByText("Aceite uma sugestão para fazer sua primeira conexão")).toBeInTheDocument();
    unmount();

    duble.respostas["matches.list"] = { data: [] };
    render(<Dashboard />);
    expect(await screen.findByText("Nenhuma sugestão nova por enquanto")).toBeInTheDocument();
    expect(screen.queryByText("Aceite uma sugestão para fazer sua primeira conexão")).not.toBeInTheDocument();
  });
});

describe("item 6.2 — souDestinataria chega do driver como 1/0", () => {
  it("pendente com souDestinataria 0 não desenha um '0' solto no cartão", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "pending", souDestinataria: 0 })] };
    render(<Dashboard />);
    abrirConexoes();

    const coluna = (await screen.findByText(i18n.t("dashboard.anonTitle"))).parentElement!;
    const zeroSolto = Array.from(coluna.childNodes)
      .some(no => no.nodeType === Node.TEXT_NODE && (no.textContent ?? "").trim() === "0");
    expect(zeroSolto).toBe(false);
    expect(screen.queryByText(i18n.t("dashboard.acceptRevealHint"))).toBeNull();
  });

  it("pendente com souDestinataria 1 continua oferecendo aceitar e recusar", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "pending", souDestinataria: 1 })] };
    render(<Dashboard />);
    abrirConexoes();

    expect(await screen.findByRole("button", { name: i18n.t("dashboard.acceptReveal") })).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dashboard.acceptRevealHint"))).toBeInTheDocument();
  });
});

describe("item 13.1 — setor e cidade normalizados", () => {
  it("capitaliza o que veio todo em caixa baixa ou alta e preserva caixa mista", () => {
    expect(normalizarCaixa("tecnologia")).toBe("Tecnologia");
    expect(normalizarCaixa("SÃO PAULO")).toBe("São Paulo");
    expect(normalizarCaixa("rio de janeiro")).toBe("Rio de Janeiro");
    // Caixa mista já veio certa do onboarding: não pode virar "Ti E Telecom".
    expect(normalizarCaixa("TI e Telecom")).toBe("TI e Telecom");
    expect(normalizarCaixa("Tecnologia & Software")).toBe("Tecnologia & Software");
    expect(normalizarCaixa(null)).toBe("");
  });

  it("monta 'Cidade, UF' quando a sigla vem depois de vírgula, hífen ou barra", () => {
    expect(normalizarCidade("SÃO PAULO - sp")).toBe("São Paulo, SP");
    expect(normalizarCidade("belo horizonte/mg")).toBe("Belo Horizonte, MG");
    expect(normalizarCidade("Curitiba, pr")).toBe("Curitiba, PR");
    expect(normalizarCidade("Rio de Janeiro")).toBe("Rio de Janeiro");
    expect(normalizarCidade("")).toBe("");
  });

  // Regressão de idioma apontada na revisão: caixa alta e caixa baixa são
  // conceito da escrita LATINA. "可持续发展与ESG" é igual a si mesmo em
  // toLocaleUpperCase (o chinês não tem caixa), a normalização o tomava por
  // "veio todo em maiúsculas" e achatava a sigla latina de dentro: "…esg".
  // Texto com qualquer letra fora do alfabeto latino volta como está.
  it("não mexe em texto de escrita não latina, nem nas siglas latinas dentro dele", () => {
    expect(normalizarCaixa("可持续发展与ESG")).toBe("可持续发展与ESG");
    expect(normalizarCaixa("サステナビリティとESG")).toBe("サステナビリティとESG");
    expect(normalizarCaixa("テクノロジー・IT")).toBe("テクノロジー・IT");
    expect(normalizarCaixa("ТЕХНОЛОГИИ И IT")).toBe("ТЕХНОЛОГИИ И IT");
    // A cidade segue a mesma regra, e a sigla depois da vírgula continua valendo.
    expect(normalizarCidade("東京, jp")).toBe("東京, JP");
    expect(normalizarCidade("上海")).toBe("上海");
  });

  it("a lista mostra a versão normalizada, não o texto cru do banco", async () => {
    duble.respostas["connections.list"] = { data: [
      conexao({ status: "accepted", displayName: "Bia", primarySpecialty: "tecnologia", city: "SÃO PAULO - sp" }),
    ] };
    render(<Dashboard />);
    abrirConexoes();

    expect(await screen.findByText("Tecnologia · São Paulo, SP")).toBeInTheDocument();
  });
});

describe("item 13.2 — rótulos sem ambiguidade", () => {
  it("pedido enviado por mim diz que a espera é do outro membro", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "pending", souDestinataria: 0 })] };
    render(<Dashboard />);
    abrirConexoes();

    // O rótulo aparece no cabeçalho do grupo e no selo do cartão.
    expect((await screen.findAllByText(i18n.t("dashboard.awaitingOtherReply"))).length).toBeGreaterThan(0);
    expect(screen.queryByText(i18n.t("dashboard.pending"))).toBeNull();
  });

  it("pedido que espera por mim diz que a resposta é minha", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "pending", souDestinataria: 1 })] };
    render(<Dashboard />);
    abrirConexoes();

    expect((await screen.findAllByText(i18n.t("dashboard.awaitingYourReply"))).length).toBeGreaterThan(0);
  });

  it("'Em análise' fica só para o que ainda está com a distribuidora", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "in_review", souDestinataria: 0 })] };
    render(<Dashboard />);
    abrirConexoes();

    expect((await screen.findAllByText(i18n.t("dashboard.inReview"))).length).toBeGreaterThan(0);
    expect(screen.queryByText(i18n.t("dashboard.awaitingOtherReply"))).toBeNull();
    expect(screen.queryByText(i18n.t("dashboard.awaitingYourReply"))).toBeNull();
  });
});

describe("item 13.3 — data da solicitação", () => {
  it("cada cartão mostra quando o pedido foi feito", async () => {
    duble.respostas["connections.list"] = { data: [conexao({ status: "accepted", displayName: "Bia", souDestinataria: 1 })] };
    render(<Dashboard />);
    abrirConexoes();

    expect(await screen.findByText(i18n.t("dashboard.requestedOn", { data: DATA_NA_TELA }))).toBeInTheDocument();
  });
});

describe("item 13.4 — lista agrupada por status", () => {
  it("cada grupo tem cabeçalho, com a contagem, e na ordem de quem espera por mim primeiro", async () => {
    duble.respostas["connections.list"] = { data: [
      conexao({ id: 1, status: "accepted", displayName: "Bia", souDestinataria: 1 }),
      conexao({ id: 2, status: "declined", souDestinataria: 0 }),
      conexao({ id: 3, status: "pending", souDestinataria: 1 }),
      conexao({ id: 4, status: "in_review", souDestinataria: 0 }),
      conexao({ id: 5, status: "pending", souDestinataria: 0 }),
    ] };
    render(<Dashboard />);
    abrirConexoes();

    await screen.findAllByText(i18n.t("dashboard.awaitingYourReply"));
    const cabecalhos = Array.from(document.querySelectorAll("h3"))
      .map(h => h.textContent ?? "")
      .filter(texto => /\(\d+\)$/.test(texto));
    expect(cabecalhos).toEqual([
      `${i18n.t("dashboard.awaitingYourReply")} (1)`,
      `${i18n.t("dashboard.inReview")} (1)`,
      `${i18n.t("dashboard.awaitingOtherReply")} (1)`,
      `${i18n.t("dashboard.connectionsEstablished")} (1)`,
      `${i18n.t("dashboard.groupClosed")} (1)`,
    ]);
  });
});
