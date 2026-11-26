import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Opportunities from "./Opportunities";
import Dashboard from "./Dashboard";
import Memory from "./Memory";
import IntelligentMatches from "./IntelligentMatches";

/**
 * Erro de consulta nas telas que passaram a usar ErroDeConsulta na PR-A e não
 * tinham teste de erro: Oportunidades (lista e vitrine), Dashboard (stats e
 * aba de matches), Memória (status) e Conexões Inteligentes (lista). A regra
 * é a do servidor — banco fora do ar é ERRO, nunca "sem dados" — e cada tela
 * a traduzia num estado vazio diferente.
 *
 * Também prova os rótulos que saíram do português fixo junto com o menu
 * global: "Meu Perfil" no Dashboard e o título de Memória IA (revisão: item 9).
 *
 * O tRPC é um dublê genérico: qualquer `trpc.a.b.useQuery` responde o que o
 * teste registrou em `respostas["a.b"]` (ou o padrão "sem dados, sem erro");
 * qualquer useMutation devolve um mutate inerte; useUtils aceita qualquer
 * `invalidate`. Serve para telas com dezenas de procedures sem enumerar cada
 * uma — as asserções discriminam pelo que aparece na tela.
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

  return { respostas, refetchDe, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
// O título chega ao header como prop: renderizá-lo é o suficiente para provar
// que passou por t(). O menu global, o sino e o consentimento não são o que
// se prova aqui.
vi.mock("@/components/AppHeader", () => ({
  AppHeader: ({ title }: { title?: string }) => <h1>{title}</h1>,
  GlobalMenu: () => null,
}));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

const MENSAGEM = "Banco de dados indisponível. Tente de novo em instantes.";
const erroDoServidor = { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } };
const emErro: Resposta = { data: undefined, isError: true, error: erroDoServidor };
const RETENTAR = "↻ Tentar novamente";

function usuaria(role: "silver" | "gold") {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  usuaria("silver");
});

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("Oportunidades — lista e vitrine em erro", () => {
  it("lista em erro: alerta com a mensagem do servidor, sem 'Nenhuma oportunidade encontrada'", () => {
    duble.respostas["opportunities.list"] = emErro;
    duble.respostas["opportunities.saved"] = { data: [] };
    duble.respostas["network.vitrine"] = { data: [] };
    render(<Opportunities />);

    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText("Nenhuma oportunidade encontrada")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: RETENTAR }));
    expect(duble.refetchDe("opportunities.list")).toHaveBeenCalledTimes(1);
    expect(duble.refetchDe("network.vitrine")).not.toHaveBeenCalled();
  });

  it("vitrine em erro com a lista sã: a seção não some em silêncio — há um alerta próprio, e o retentar é o da vitrine", () => {
    duble.respostas["opportunities.list"] = { data: [] };
    duble.respostas["opportunities.saved"] = { data: [] };
    duble.respostas["network.vitrine"] = { data: undefined, isError: true, error: { message: "Failed to fetch" } };
    render(<Opportunities />);

    // A lista vazia de verdade continua dizendo que está vazia.
    expect(screen.getByText("Nenhuma oportunidade encontrada")).toBeInTheDocument();
    const alertas = screen.getAllByRole("alert");
    expect(alertas).toHaveLength(1);
    // Erro fora do envelope tRPC: o genérico, não o texto técnico.
    expect(alertas[0]).toHaveTextContent("O servidor não respondeu. Tente de novo em instantes.");
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: RETENTAR }));
    expect(duble.refetchDe("network.vitrine")).toHaveBeenCalledTimes(1);
    expect(duble.refetchDe("opportunities.list")).not.toHaveBeenCalled();
  });
});

describe("Dashboard — matches em erro", () => {
  const perfil = { profile: { displayName: "Glenda", jobTitle: "CEO", city: "São Paulo", profileCompleteness: 80 } };

  it("o resumo diz que não carregou (não 'nenhuma') e a aba de matches traz o alerta, sem convite a gerar os primeiros matches", async () => {
    duble.respostas["profile.get"] = { data: perfil };
    duble.respostas["matches.list"] = emErro;
    duble.respostas["connections.list"] = { data: [] };
    duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
    render(<Dashboard />);

    // Desde 25/11 os números do Início são o resumo em frases (components/ResumoDasConexoes.tsx).
    await waitFor(() => expect(screen.getByText("Não deu para carregar suas sugestões agora")).toBeInTheDocument());
    expect(screen.queryByText("Nenhuma sugestão nova por enquanto")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText(i18n.t("dashboard.noMatches"))).not.toBeInTheDocument();
    expect(screen.queryByText("✨ Encontrar conexões para mim")).not.toBeInTheDocument();
    // Pela chave, não pelo texto: o convite de boas-vindas mudou de "matches"
    // para "conexões" (14/09) e uma negativa com o texto velho passaria à toa.
    expect(screen.queryByText(i18n.t("dashboard.greetingWelcome"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: RETENTAR }));
    expect(duble.refetchDe("matches.list")).toHaveBeenCalled();
  });

  it("em inglês, o título do avatar é 'My Profile' — não o 'Meu Perfil' fixo", async () => {
    await i18n.changeLanguage("en");
    duble.respostas["profile.get"] = { data: perfil };
    duble.respostas["matches.list"] = { data: [] };
    duble.respostas["connections.list"] = { data: [] };
    render(<Dashboard />);

    expect(screen.getByTitle("My Profile")).toBeInTheDocument();
    expect(screen.queryByTitle("Meu Perfil")).not.toBeInTheDocument();
  });
});

describe("Memória IA — status em erro", () => {
  it("alerta no lugar de '0 registro(s) guardado(s)', e o retentar recarrega o status", () => {
    duble.respostas["memory.status"] = emErro;
    render(<Memory />);

    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText(/registro\(s\) guardado\(s\)/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: RETENTAR }));
    expect(duble.refetchDe("memory.status")).toHaveBeenCalledTimes(1);
  });

  it("em inglês, o título do header é 'AI Memory' — não o 'Memória IA' fixo", async () => {
    await i18n.changeLanguage("en");
    duble.respostas["memory.status"] = { data: { documents: 3, lastIndexedAt: null } };
    render(<Memory />);

    expect(screen.getByRole("heading", { name: "AI Memory" })).toBeInTheDocument();
    expect(screen.queryByText("Memória IA")).not.toBeInTheDocument();
  });
});

describe("Conexões Inteligentes — lista em erro", () => {
  it("alerta com a mensagem do servidor, sem 'Nenhuma oportunidade ainda'", () => {
    duble.respostas["consent.status"] = { data: { accepted: true, document: { id: "termo-1" } } };
    duble.respostas["consent.history"] = { data: [] };
    duble.respostas["intelligentMatches.contacts"] = { data: [] };
    duble.respostas["intelligentMatches.list"] = emErro;
    render(<IntelligentMatches />);

    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText("Nenhuma oportunidade ainda")).not.toBeInTheDocument();
    expect(screen.queryByText("Carregando oportunidades…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: RETENTAR }));
    expect(duble.refetchDe("intelligentMatches.list")).toHaveBeenCalledTimes(1);
  });
});
