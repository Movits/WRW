import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO } from "@shared/const";
import Dashboard from "./Dashboard";

/**
 * U3, "matches possíveis" (promessa à Dra. Glenda na reunião de 11/11/2026):
 * no Painel, a Bronze vê QUANTAS conexões são possíveis para ela e o que falta
 * no perfil para a lista se liberar; a Prata vê a lista, como antes.
 *
 * A trava de verdade é do servidor (matches.list sai vazio para a Bronze:
 * server/conexoes-possiveis.test.ts). Este arquivo guarda a tela: mesmo que a
 * lista chegasse, a Bronze não a vê — por isso a fixtura da lista vem cheia
 * também nos casos da Bronze, e o dublê ignora o `enabled` das consultas.
 */

type Resposta = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };

const duble = vi.hoisted(() => {
  const respostas: Record<string, Resposta> = {};
  const mutacoes: Record<string, (...args: unknown[]) => unknown> = {};
  /** As consultas relidas por `refetch()`, que no React Query passa por cima do `enabled: false`. */
  const relidas: string[] = [];
  /** O `enabled` com que a tela montou cada consulta (o dublê devolve a resposta de qualquer jeito). */
  const ligadas: Record<string, boolean> = {};
  /** As chamadas a `trpc.useUtils()`, como "auth.me.invalidate". */
  const utilidades: string[] = [];
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: (_input: unknown, opcoes?: { select?: (dados: never) => unknown; enabled?: boolean }) => {
      ligadas[caminho] = opcoes?.enabled !== false;
      const parcial = respostas[caminho] ?? {};
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: () => { relidas.push(caminho); }, ...parcial };
      if (opcoes?.select && resultado.data !== undefined) resultado.data = opcoes.select(resultado.data as never);
      return resultado;
    },
    // Mutação com resposta registrada pelo teste chama o `onSuccess` da tela, como
    // o React Query; a que lança chama o `onError`.
    useMutation: (opcoes?: { onSuccess?: (dados: unknown, variaveis: unknown) => void; onError?: (erro: unknown, variaveis: unknown) => void }) => ({
      mutate: (variaveis: unknown) => {
        if (!(caminho in mutacoes)) return;
        let dados: unknown;
        try {
          dados = mutacoes[caminho](variaveis);
        } catch (erro) {
          opcoes?.onError?.(erro, variaveis);
          return;
        }
        opcoes?.onSuccess?.(dados, variaveis);
      },
      mutateAsync: async () => undefined, isPending: false, isError: false, error: null, data: undefined,
    }),
  });
  const utils = new Proxy({}, {
    get: (_, r) => ignorar(r) ? undefined : new Proxy({}, {
      get: (_, p) => ignorar(p) ? undefined : new Proxy({}, {
        get: (_, m) => ignorar(m) ? undefined : async () => { utilidades.push(`${String(r)}.${String(p)}.${String(m)}`); },
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
  return { respostas, mutacoes, relidas, ligadas, utilidades, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null, GlobalMenu: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

/** Um cartão da lista da Prata, com uma cidade que só existe aqui. */
const CARTAO = {
  matchId: 1, overallScore: 64, userSeen: true,
  specialtyScore: 60, objectivesScore: 0, incomeScore: 60, locationScore: 75, valuesScore: 50,
  aiInsight: null, city: "Cidade-sentinela", country: "PT", primarySpecialty: "tech",
  seekingTypes: [], businessInterests: [], values: [], sector: null,
  displayName: null, connectionId: null, connectionStatus: null, souDestinataria: false,
};

/** Perfil Bronze: falta a apresentação e O que preciso. */
const PERFIL_BRONZE = { displayName: "Ana", city: "Lisboa", primarySpecialty: "Vinhos", whatIHave: ["Vinho do Porto"], whatINeed: [], profileCompleteness: 40 };

function logada(role: string) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Ana", role },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  for (const chave of Object.keys(duble.mutacoes)) delete duble.mutacoes[chave];
  for (const chave of Object.keys(duble.ligadas)) delete duble.ligadas[chave];
  duble.relidas.length = 0;
  duble.utilidades.length = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  logada("bronze");
  duble.respostas["profile.get"] = { data: { profile: PERFIL_BRONZE } };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  duble.respostas["connections.list"] = { data: [] };
  duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
  duble.respostas["dealRoom.listRooms"] = { data: [] };
  duble.respostas["notifications.list"] = { data: [] };
  duble.respostas["matches.list"] = { data: [CARTAO] };
  duble.respostas["matches.conexoesPossiveis"] = { data: { total: 3, listaLiberada: false } };
  window.history.replaceState(null, "", "/dashboard");
});

afterEach(async () => {
  // Desmonta ANTES de trocar o idioma: no Vitest 2 este afterEach roda antes do
  // cleanup() do setup, e a troca com a tela montada gera erro não tratado.
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

const ESPERA = { timeout: 3000 };

/** O resumo das conexões do Início, em frases (components/ResumoDasConexoes.tsx). */
const resumo = () => screen.getByRole("region", { name: "Resumo das suas conexões" });

describe("U3 — a Bronze vê quantas conexões são possíveis, e não quem", () => {
  it("mostra o número, o que falta para a Prata, e nenhum cartão da lista", () => {
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Há 3 conexões possíveis para você" })).toBeInTheDocument();
    expect(screen.getByText(/a lista se libera quando ele chega a Membro Prata/)).toBeInTheDocument();
    // O que falta, pela régua da Prata (o mesmo cartão do Perfil).
    expect(screen.getByRole("heading", { name: "Membro Bronze: seu perfil está em qualificação" })).toBeInTheDocument();
    expect(screen.getByText("Pelo menos um item em O que preciso")).toBeInTheDocument();
    expect(screen.getByText(/Uma apresentação com pelo menos 6 palavras/)).toBeInTheDocument();
    // Nada da lista, nem com o dublê devolvendo um cartão.
    expect(document.body.innerHTML).not.toContain("Cidade-sentinela");
    expect(screen.queryByRole("button", { name: "Demonstrar Interesse" })).not.toBeInTheDocument();
    expect(screen.queryByText("Distribuição de Compatibilidade")).not.toBeInTheDocument();
  });

  it("o resumo: quantas pessoas combinam e o convite a completar o perfil, sem nada das notas da lista", async () => {
    render(<Dashboard />);

    await waitFor(() => expect(within(resumo()).getByText("3 pessoas combinam com você")).toBeInTheDocument(), ESPERA);
    expect(within(resumo()).getByText("Complete seu perfil para ver quem são")).toBeInTheDocument();
    expect(within(resumo()).getByRole("link", { name: "Completar: 3 pessoas combinam com você" })).toHaveAttribute("href", "/profile");
    // A afinidade e o "combinam muito" são da lista, que a Bronze não vê.
    expect(within(resumo()).queryByText(/afinidade|combina muito|combinam muito/)).not.toBeInTheDocument();
    expect(screen.getByText("3 oportunidades compatíveis encontradas para você")).toBeInTheDocument();
    // A aba não conta a lista que ela não vê (nem a que ficou no cache).
    expect(screen.queryByText("Conexões sugeridas (1)")).not.toBeInTheDocument();
  });

  it("'Completar perfil' leva ao Perfil, e 'Buscar' roda o motor de novo", () => {
    const regenerar = vi.fn(() => ({ count: 12 }));
    duble.mutacoes["matches.regenerate"] = regenerar;
    render(<Dashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Buscar novas conexões sugeridas" }));
    expect(regenerar).toHaveBeenCalledTimes(1);
    // Para a Bronze, o que vale é o número do cartão, relido; as linhas que a
    // rodada gravou (`count`) não viram "12 novas conexões", e a lista não é lida.
    expect(duble.relidas).toContain("matches.conexoesPossiveis");
    expect(duble.relidas).not.toContain("matches.list");
    expect(toast.success).toHaveBeenCalledWith("Análise concluída. O número de conexões possíveis está atualizado.");

    fireEvent.click(screen.getByRole("button", { name: "Completar perfil" }));
    expect(window.location.pathname).toBe("/profile");
  });

  it("'Buscar' que falha diz que falhou: o número não fica igual em silêncio, como se não houvesse nada novo", () => {
    duble.mutacoes["matches.regenerate"] = () => {
      throw Object.assign(new Error(MENSAGEM_BANCO_INDISPONIVEL), { data: { code: "INTERNAL_SERVER_ERROR" } });
    };
    render(<Dashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Buscar novas conexões sugeridas" }));
    expect(toast.error).toHaveBeenCalledWith(MENSAGEM_BANCO_INDISPONIVEL);
    expect(toast.success).not.toHaveBeenCalled();
    expect(duble.relidas).not.toContain("matches.conexoesPossiveis");
  });

  // Etapa 13 (revisão do pacote do match, 20/11): as contas novas nascem Bronze, e
  // a primeira a aceitar o termo tem as conexões esperando o outro lado aceitar.
  it("zero possíveis porque o outro lado ainda não aceitou o termo: 'Suas conexões estão a caminho', e não o convite a completar o perfil", () => {
    duble.respostas["matches.conexoesPossiveis"] = { data: { total: 0, listaLiberada: false } };
    duble.respostas["matches.redeAguardando"] = { data: { ocultas: 3 } };
    render(<Dashboard />);

    expect(duble.ligadas["matches.redeAguardando"]).toBe(true);
    expect(screen.getByRole("heading", { name: "Suas conexões estão a caminho" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ainda não há conexões possíveis para você" })).not.toBeInTheDocument();
    expect(screen.queryByText(/quanto mais completo ele estiver/)).not.toBeInTheDocument();
  });

  it("promovida em outra aba (o número já diz que a lista está liberada): a tela relê o nível, em vez de ficar presa na visão da Bronze", () => {
    duble.respostas["matches.conexoesPossiveis"] = { data: { total: 3, listaLiberada: true } };
    render(<Dashboard />);
    expect(duble.utilidades).toContain("auth.me.invalidate");
  });

  it("Bronze com a lista trancada no servidor também: o nível não é relido à toa", () => {
    render(<Dashboard />);
    expect(duble.utilidades).not.toContain("auth.me.invalidate");
  });

  it("uma só possível: o singular", () => {
    duble.respostas["matches.conexoesPossiveis"] = { data: { total: 1, listaLiberada: false } };
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "Há 1 conexão possível para você" })).toBeInTheDocument();
  });

  it("nenhuma possível: diz isso e convida a completar o perfil", () => {
    duble.respostas["matches.conexoesPossiveis"] = { data: { total: 0, listaLiberada: false } };
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Ainda não há conexões possíveis para você" })).toBeInTheDocument();
    expect(screen.getByText(/quanto mais completo ele estiver/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completar perfil" })).toBeInTheDocument();
  });

  it("consulta que falhou não vira 'nenhuma possível': erro com tentar de novo, e o resumo diz que não carregou", async () => {
    duble.respostas["matches.conexoesPossiveis"] = { isError: true, error: new Error("queda") };
    render(<Dashboard />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /conexões possíveis/ })).not.toBeInTheDocument();
    await waitFor(() => expect(within(resumo()).getByText("Não deu para carregar suas sugestões agora")).toBeInTheDocument(), ESPERA);
    expect(within(resumo()).queryByText("Complete seu perfil para ver quem combina com você")).not.toBeInTheDocument();
  });

  it("nenhuma possível: o resumo convida a completar o perfil", async () => {
    duble.respostas["matches.conexoesPossiveis"] = { data: { total: 0, listaLiberada: false } };
    render(<Dashboard />);
    await waitFor(() => expect(within(resumo()).getByText("Complete seu perfil para ver quem combina com você")).toBeInTheDocument(), ESPERA);
  });

  it("em árabe: o plural do árabe, da direita para a esquerda", async () => {
    await i18n.changeLanguage("ar");
    render(<Dashboard />);

    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("heading", { name: "توجد 3 اتصالات ممكنة لك" })).toBeInTheDocument();
    expect(screen.getByText(/تُفتح القائمة عندما يصل ملفك إلى مستوى العضو الفضي/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("Cidade-sentinela");
  });
});

describe("U3 — a Prata, a Ouro, a presidente e a admin veem a lista", () => {
  it.each(["silver", "gold", "president", "admin"])("%s vê os cartões, sem o bloco das conexões possíveis", async (role) => {
    logada(role);
    render(<Dashboard />);

    expect(screen.getByRole("button", { name: "Demonstrar Interesse" })).toBeInTheDocument();
    expect(screen.getByText("Conexões sugeridas (1)")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /conexões possíveis/ })).not.toBeInTheDocument();
    await waitFor(() => expect(within(resumo()).getByText("1 pessoa combina com você")).toBeInTheDocument(), ESPERA);
    expect(within(resumo()).queryByText("Complete seu perfil para ver quem são")).not.toBeInTheDocument();
    expect(within(resumo()).getByRole("button", { name: "Ver: 1 pessoa combina com você" })).toBeInTheDocument();
  });

  // A conta caiu para Bronze (Ouro revogado, nível mudado pela admin) com o cartão
  // ainda na tela: o servidor recusa com a frase dele, em português, e a tela a
  // diz no idioma de quem lê (revisão do pacote do match, 20/11).
  it("o interesse recusado pela U3 (FORBIDDEN) sai no idioma da tela", async () => {
    logada("gold");
    duble.mutacoes["connections.send"] = () => {
      throw Object.assign(new Error(MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO), { data: { code: "FORBIDDEN" } });
    };
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Express Interest" }));
    expect(toast.error).toHaveBeenCalledWith("Complete your profile to see the suggested connections and express interest in them.");
  });
});

describe("U3 — a lista da Prata a 375 px", () => {
  it("a distribuição não vaza do cartão: o título tem tamanho próprio e o botão desce de linha", () => {
    // Visto na bancada a 375 px (19/11): o título no tamanho global de h2
    // espremia o "Buscar novas conexões sugeridas", que saía do cartão e abria
    // rolagem lateral. O jsdom não mede layout; o teste guarda as duas classes.
    logada("silver");
    render(<Dashboard />);
    const titulo = screen.getByRole("heading", { name: "Distribuição de Compatibilidade" });
    expect(titulo).toHaveClass("text-base");
    expect(titulo.parentElement!.parentElement).toHaveClass("flex-wrap");
  });
});

describe("U3 — a tela da Bronze não relê a lista que ela não vê", () => {
  const aviso = (id: number) => ({ id, type: "interest_received", title: "Nova conexão!", body: "", isRead: false, createdAt: new Date() });
  /** Um pedido encaminhado PARA ela, anônimo como `connections.list` o devolve antes do aceite. */
  const PEDIDO_RECEBIDO = {
    id: 7, status: "pending", createdAt: new Date("2026-11-18T12:00:00Z"), souDestinataria: true,
    city: "Porto", primarySpecialty: "tech", outraParteId: null, message: null,
    displayName: null, avatarUrl: null, userName: null, userCompany: null,
  };

  it.each([["bronze", false], ["silver", true]] as const)(
    "aviso de interesse novo (%s): relê as conexões, e a lista só quando ela a vê",
    (role, releALista) => {
      logada(role);
      duble.respostas["notifications.list"] = { data: [aviso(1)] };
      const { rerender } = render(<Dashboard />);
      duble.relidas.length = 0;

      duble.respostas["notifications.list"] = { data: [aviso(2), aviso(1)] };
      rerender(<Dashboard />);

      expect(duble.relidas).toContain("connections.list");
      expect(duble.relidas.includes("matches.list")).toBe(releALista);
    },
  );

  it.each([["bronze", false], ["silver", true]] as const)(
    "responder ao pedido recebido (%s): relê as conexões, e a lista só quando ela a vê",
    async (role, releALista) => {
      logada(role);
      duble.respostas["connections.list"] = { data: [PEDIDO_RECEBIDO] };
      duble.mutacoes["connections.respond"] = () => ({ success: true });
      render(<Dashboard />);

      fireEvent.click(screen.getByRole("button", { name: "Conexões" }));
      fireEvent.click(await screen.findByRole("button", { name: "Aceitar e revelar" }, ESPERA));

      expect(duble.relidas).toContain("connections.list");
      expect(duble.relidas.includes("matches.list")).toBe(releALista);
    },
  );
});
