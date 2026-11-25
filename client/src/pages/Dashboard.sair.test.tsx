import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import { ocupar, sessaoOcupada } from "@/lib/sessao-ocupada";
import Dashboard from "./Dashboard";

/**
 * O Sair do Dashboard (PR S do gravador). O Dashboard monta a própria barra,
 * com o menu global (GlobalMenu) dentro: o Sair dele é o mesmo das outras telas
 * e, com a sessão ocupada (lib/sessao-ocupada.ts), pede confirmação antes do
 * auth.logout. O Dashboard tinha também um logout próprio, que nenhum botão
 * chamava; saiu, para não sobrar um caminho sem o diálogo.
 *
 * O tRPC é o dublê em Proxy de Dashboard.gravar-reuniao.test.tsx, com o
 * auth.logout num espião só; aqui o menu global é o de verdade.
 */

const duble = vi.hoisted(() => {
  const sairNoServidor = vi.fn();
  const respostas: Record<string, { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown }> = {};
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: (_input: unknown, opcoes?: { select?: (dados: never) => unknown }) => {
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: vi.fn(), ...(respostas[caminho] ?? {}) };
      if (opcoes?.select && resultado.data !== undefined) resultado.data = opcoes.select(resultado.data as never);
      return resultado;
    },
    useMutation: () => ({ mutate: caminho === "auth.logout" ? sairNoServidor : vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false, isError: false, error: null, data: undefined }),
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
  return { sairNoServidor, respostas, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

const abertas: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Ana", role: "bronze" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  duble.respostas["profile.get"] = { data: { profile: { displayName: "Ana", city: "Lisboa", profileCompleteness: 80, bio: "Exporto vinho." } } };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  duble.respostas["connections.list"] = { data: [] };
  duble.respostas["matches.list"] = { data: [] };
  duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
  duble.respostas["dealRoom.listRooms"] = { data: [] };
  duble.respostas["notifications.list"] = { data: [] };
  expect(sessaoOcupada()).toBe(false);
});

afterEach(() => {
  for (const liberar of abertas.splice(0)) liberar();
  vi.unstubAllGlobals();
});

async function clicarEmSair() {
  fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
}

describe("Dashboard — o Sair da barra pede confirmação com a sessão ocupada", () => {
  it("livre: o Sair do menu chama o auth.logout na hora", async () => {
    render(<Dashboard />);
    await clicarEmSair();
    expect(duble.sairNoServidor).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("com áudio por enviar: o diálogo abre, 'Continuar aqui' fica, e só 'Sair mesmo assim' sai", async () => {
    abertas.push(ocupar("audio-nao-enviado"));
    render(<Dashboard />);
    await clicarEmSair();
    expect(duble.sairNoServidor).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Sair agora?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continuar aqui" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Continuar aqui" }));
    expect(duble.sairNoServidor).not.toHaveBeenCalled();

    await clicarEmSair();
    fireEvent.click(screen.getByRole("button", { name: "Sair mesmo assim" }));
    expect(duble.sairNoServidor).toHaveBeenCalledTimes(1);
  });
});
