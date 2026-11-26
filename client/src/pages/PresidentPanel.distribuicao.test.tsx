import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PresidentPanel from "./PresidentPanel";

/**
 * Painel Ouro — aba "Distribuição" (distribuidor do Smart Match).
 *
 * O poder de distribuição (`users.isDistributor`) acumula com qualquer nível.
 * Ouro/presidente/admin veem "Quem distribui" (conceder e revogar); quem tem o
 * poder vê a "Fila de análise" e as últimas decisões. Quem só distribui, sem
 * Ouro, entra no painel só com essa aba e a tela NÃO consulta
 * `distribuicao.listar`, que é da presidência e devolveria 403; a presidente sem
 * o poder não consulta a fila, pelo motivo simétrico. Sem Ouro e sem o poder:
 * "Acesso Restrito".
 *
 * O tRPC é um dublê explícito (molde de PresidentPanel.test.tsx): registra as
 * consultas feitas e o que as mutações receberam.
 */

const duble = vi.hoisted(() => ({
  usuaria: { id: 1, role: "president", name: "Presidente", isDistributor: false } as Record<string, unknown>,
  consultas: [] as string[],
  distribuidores: [] as unknown[],
  membros: { users: [] as unknown[], total: 0 },
  fila: [] as unknown[],
  historico: [] as unknown[],
  conceder: vi.fn(),
  revogar: vi.fn(),
  decidir: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: duble.usuaria, loading: false, isAuthenticated: true }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/president", vi.fn()] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/trpc", () => {
  const consulta = (nome: string, dados: () => unknown) => ({
    useQuery: () => { duble.consultas.push(nome); return { data: dados(), isLoading: false, refetch: vi.fn() }; },
  });
  const mutacao = (fn: () => (entrada: unknown) => void) => ({
    useMutation: () => ({ mutate: (entrada: unknown) => fn()(entrada), isPending: false }),
  });
  return {
    trpc: {
      useUtils: () => ({}),
      president: {
        getGovernanceStats: consulta("president.getGovernanceStats", () => undefined),
        getGoldGrants: consulta("president.getGoldGrants", () => []),
        listLeaders: consulta("president.listLeaders", () => []),
        getLeaderOpportunities: consulta("president.getLeaderOpportunities", () => undefined),
        listAllUsers: consulta("president.listAllUsers", () => duble.membros),
        grantGold: mutacao(() => vi.fn()),
        revokeGold: mutacao(() => vi.fn()),
        nominateLeader: mutacao(() => vi.fn()),
        revokeLeader: mutacao(() => vi.fn()),
      },
      distribuicao: {
        listar: consulta("distribuicao.listar", () => duble.distribuidores),
        fila: consulta("distribuicao.fila", () => duble.fila),
        historico: consulta("distribuicao.historico", () => duble.historico),
        conceder: mutacao(() => duble.conceder),
        revogar: mutacao(() => duble.revogar),
        decidir: mutacao(() => duble.decidir),
      },
    },
  };
});

const dina = { id: 8, name: "Dina Já-Distribui", email: "dina@exemplo.com", role: "silver", isActive: true };
const dora = { id: 7, name: "Dora Candidata", email: "dora@exemplo.com", role: "gold", country: null };

// Nomes impossíveis de colidir: a trava anti-vacuidade da fila é vê-los na tela.
const perfil = (name: string, extra: Record<string, unknown> = {}) => ({
  name, displayName: null, role: "silver", isActive: true, isVerified: true, onboardingCompleted: true,
  company: "Vinícola Quindim", jobTitle: "Diretora", city: "Lisboa", country: "PT", sector: "agro", primarySpecialty: "export",
  bio: "Exporto vinho.", whatIHave: ["vinho"], whatINeed: ["capital"], seekingTypes: ["investor"], profileCompleteness: 90,
  ...extra,
});
const pedido = (extra: Record<string, unknown> = {}) => ({
  connectionId: 7, createdAt: new Date("2026-09-13T10:00:00Z"), reciprocado: false,
  solicitante: perfil("Zoroastra Solicitante"), destinataria: perfil("Quintiliana Destinatária"),
  compatibilidade: { overallScore: 82, specialtyScore: 90, objectivesScore: 80, incomeScore: 70, locationScore: 60, valuesScore: 50, aiInsight: "Vinho e capital." },
  bloqueadoPeloPortao: false, termoOk: { solicitante: true, destinataria: true }, ativas: { solicitante: true, destinataria: true },
  ...extra,
});

const abas = () => screen.getAllByRole("button").map(b => b.textContent?.trim()).filter(t =>
  ["Visão Geral", "Gestão Ouro", "Líderes", "Validações", "Compliance", "Distribuição"].includes(t ?? ""));

function abrir() {
  render(<PresidentPanel />);
  fireEvent.click(screen.getByRole("button", { name: /distribuição/i }));
}

beforeEach(() => {
  duble.consultas = [];
  duble.distribuidores = [];
  duble.membros = { users: [], total: 0 };
  duble.fila = [];
  duble.historico = [];
  duble.conceder.mockReset();
  duble.revogar.mockReset();
  duble.decidir.mockReset();
  duble.usuaria = { id: 1, role: "president", name: "Presidente", isDistributor: false };
});

describe("quem entra no painel", () => {
  it("Prata sem o poder: Acesso Restrito, e nenhuma consulta sai", () => {
    duble.usuaria = { id: 2, role: "silver", name: "Prata", isDistributor: false };
    render(<PresidentPanel />);
    expect(screen.getByText("Acesso Restrito")).toBeInTheDocument();
    expect(duble.consultas).toEqual([]);
  });

  it("Prata COM o poder entra, vê só a aba Distribuição com a fila, e NÃO consulta distribuicao.listar (seria 403)", () => {
    duble.usuaria = { id: 2, role: "silver", name: "Prata", isDistributor: true };
    render(<PresidentPanel />);
    expect(screen.queryByText("Acesso Restrito")).not.toBeInTheDocument();
    expect(abas()).toEqual(["Distribuição"]);
    expect(screen.getByText("Fila de análise")).toBeInTheDocument();
    expect(screen.getByText("Distribuidor")).toBeInTheDocument();
    expect(screen.queryByText("Quem distribui hoje")).not.toBeInTheDocument();
    expect(duble.consultas).toContain("distribuicao.fila");
    expect(duble.consultas).not.toContain("distribuicao.listar");
    expect(duble.consultas).not.toContain("president.listAllUsers");
  });

  it("a aba Reuniões (consulta da administração, R1a) é só de admin e presidente: Ouro sem cargo não a vê", () => {
    for (const role of ["president", "admin"]) {
      duble.usuaria = { id: 1, role, name: "Staff", isDistributor: false };
      const { unmount } = render(<PresidentPanel />);
      expect(screen.getByRole("button", { name: "Reuniões" })).toBeInTheDocument();
      unmount();
    }
    duble.usuaria = { id: 3, role: "gold", name: "Ouro", isDistributor: false };
    render(<PresidentPanel />);
    expect(screen.queryByRole("button", { name: "Reuniões" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conexões registradas" })).not.toBeInTheDocument();
  });

  it("presidente vê as cinco abas de sempre mais Distribuição, e a badge Ouro", () => {
    render(<PresidentPanel />);
    expect(abas()).toEqual(["Visão Geral", "Gestão Ouro", "Líderes", "Validações", "Compliance", "Distribuição"]);
    expect(screen.getByText("Ouro")).toBeInTheDocument();
    expect(screen.queryByText("Distribuidor")).not.toBeInTheDocument();
  });

  it("presidente SEM o poder abre a aba: vê Quem distribui e NÃO consulta a fila (seria 403)", () => {
    abrir();
    expect(screen.getByText("Quem distribui hoje")).toBeInTheDocument();
    expect(screen.queryByText("Fila de análise")).not.toBeInTheDocument();
    expect(duble.consultas).toContain("distribuicao.listar");
    expect(duble.consultas).not.toContain("distribuicao.fila");
  });

  it("presidente que também distribui vê as duas badges e as duas seções", () => {
    duble.usuaria = { id: 1, role: "president", name: "Presidente", isDistributor: true };
    abrir();
    expect(screen.getByText("Ouro")).toBeInTheDocument();
    expect(screen.getByText("Distribuidor")).toBeInTheDocument();
    expect(screen.getByText("Fila de análise")).toBeInTheDocument();
    expect(screen.getByText("Quem distribui hoje")).toBeInTheDocument();
  });
});

describe("aba Distribuição para Ouro/presidente/admin — Quem distribui", () => {
  it("lista quem distribui hoje (nome, e-mail, nível) vindo de distribuicao.listar", () => {
    duble.distribuidores = [dina];
    abrir();
    expect(screen.getByText("Dina Já-Distribui")).toBeInTheDocument();
    expect(screen.getByText(/dina@exemplo.com · Prata/)).toBeInTheDocument();
  });

  it("sem ninguém: diz que ninguém tem o poder", () => {
    abrir();
    expect(screen.getByText("Ninguém tem o poder de distribuição no momento.")).toBeInTheDocument();
  });

  it("candidatas vêm de president.listAllUsers e quem já distribui sai da lista", () => {
    duble.distribuidores = [dina];
    duble.membros = { users: [dora, { ...dina, country: null }], total: 2 };
    abrir();
    expect(screen.getByText("Dora Candidata")).toBeInTheDocument();
    // Dina aparece uma vez só: em "Quem distribui hoje", não entre as candidatas.
    expect(screen.getAllByText("Dina Já-Distribui")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /conceder poder/i })).toHaveLength(1);
  });

  it("Conceder poder → confirmar chama conceder({ userId }) com o motivo opcional", () => {
    duble.membros = { users: [dora], total: 1 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /conceder poder/i }));
    expect(screen.getByText("Conceder poder de distribuição")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Motivo \(opcional/), { target: { value: "  Primeira distribuidora  " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar concessão" }));
    expect(duble.conceder).toHaveBeenCalledWith({ userId: 7, reason: "Primeira distribuidora" });
  });

  it("sem motivo, conceder manda reason undefined (o servidor aceita)", () => {
    duble.membros = { users: [dora], total: 1 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /conceder poder/i }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar concessão" }));
    expect(duble.conceder).toHaveBeenCalledWith({ userId: 7, reason: undefined });
  });

  it("Revogar exige motivo com 10 caracteres; depois chama revogar({ userId, reason })", () => {
    duble.distribuidores = [dina];
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Revogar" }));
    const confirmar = screen.getByRole("button", { name: "Confirmar revogação" });
    expect(confirmar).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Motivo da revogação/), { target: { value: "curto" } });
    expect(confirmar).toBeDisabled();
    fireEvent.click(confirmar);
    expect(duble.revogar).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Motivo da revogação/), { target: { value: "Saiu da equipe de distribuição" } });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    expect(duble.revogar).toHaveBeenCalledWith({ userId: 8, reason: "Saiu da equipe de distribuição" });
  });
});

describe("aba Distribuição para quem tem o poder — Fila de análise", () => {
  beforeEach(() => {
    duble.usuaria = { id: 2, role: "silver", name: "Distribuidora", isDistributor: true };
  });

  it("fila vazia diz que não há pedido; histórico vazio idem", () => {
    render(<PresidentPanel />);
    expect(screen.getByText("Nenhum pedido de interesse esperando análise.")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma decisão registrada ainda.")).toBeInTheDocument();
  });

  it("um pedido mostra as DUAS partes com nome (trava anti-vacuidade), empresa, travas verdes e a nota do Smart Match", () => {
    duble.fila = [pedido()];
    render(<PresidentPanel />);
    expect(screen.getByText("Zoroastra Solicitante")).toBeInTheDocument();
    expect(screen.getByText("Quintiliana Destinatária")).toBeInTheDocument();
    expect(screen.getByText("Quem pediu")).toBeInTheDocument();
    expect(screen.getByText("Quem recebe")).toBeInTheDocument();
    expect(screen.getAllByText(/Vinícola Quindim/)).toHaveLength(2);
    expect(screen.getByText("Compatibilidade 82%")).toBeInTheDocument();
    expect(screen.getByText("Vinho e capital.")).toBeInTheDocument();
    expect(screen.getAllByText("termo do Smart Match")).toHaveLength(2);
    expect(screen.queryByText("Interesse recíproco")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^encaminhar$/i })).toBeEnabled();
  });

  it("Encaminhar chama decidir({ connectionId, aprovar: true })", () => {
    duble.fila = [pedido()];
    render(<PresidentPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^encaminhar$/i }));
    expect(duble.decidir).toHaveBeenCalledWith({ connectionId: 7, aprovar: true });
  });

  it("Não encaminhar exige a nota; depois chama decidir({ connectionId, aprovar: false, nota })", () => {
    duble.fila = [pedido()];
    render(<PresidentPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Não encaminhar" }));
    const confirmar = screen.getByRole("button", { name: "Confirmar: não encaminhar" });
    expect(confirmar).toBeDisabled();
    fireEvent.click(confirmar);
    expect(duble.decidir).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Por que não encaminhar/), { target: { value: "  Setores sem relação  " } });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    expect(duble.decidir).toHaveBeenCalledWith({ connectionId: 7, aprovar: false, nota: "Setores sem relação" });
  });

  it("trava vermelha (portão, termo ou conta inativa) desabilita Encaminhar e explica; Não encaminhar continua possível", () => {
    duble.fila = [pedido({ bloqueadoPeloPortao: true, termoOk: { solicitante: true, destinataria: false } })];
    render(<PresidentPanel />);
    expect(screen.getByText("Portão da demanda expressa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^encaminhar$/i })).toBeDisabled();
    expect(screen.getByText(/Uma trava está vermelha/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Não encaminhar" })).toBeEnabled();
  });

  it("pedido recíproco leva a badge; sem nota do Smart Match a badge diz isso", () => {
    duble.fila = [pedido({ reciprocado: true, compatibilidade: null })];
    render(<PresidentPanel />);
    expect(screen.getByText("Interesse recíproco")).toBeInTheDocument();
    expect(screen.getByText("Sem nota do Smart Match")).toBeInTheDocument();
  });

  it("histórico lista as decisões com quem decidiu, o resultado e a nota", () => {
    duble.historico = [{
      connectionId: 3, decididoEm: new Date("2026-09-12T09:00:00Z"), decididoPor: { id: 2, name: "Distribuidora" },
      resultado: "not_forwarded", nota: "Setores sem relação", reciprocado: false,
      solicitanteNome: "Ana Histórica", destinatariaNome: "Bia Histórica",
    }];
    render(<PresidentPanel />);
    expect(screen.getByText(/Ana Histórica → Bia Histórica/)).toBeInTheDocument();
    expect(screen.getByText("Não encaminhado")).toBeInTheDocument();
    expect(screen.getByText(/por Distribuidora/)).toBeInTheDocument();
    expect(screen.getByText(/nota: Setores sem relação/)).toBeInTheDocument();
  });
});
