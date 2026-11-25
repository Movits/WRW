import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import { CHAVE_DOS_DESCARTES } from "@/lib/descartes-pendentes";
import { CHAVE_DOS_FINS } from "@/lib/retomada-das-partes";
import { sessaoOcupada } from "@/lib/sessao-ocupada";
import { TelaAutenticada } from "./App";

/**
 * O invólucro das telas logadas, montado sozinho: com a sessão em pé, o miolo
 * da página aparece COM o menu global ao lado — é o pedido do Rosber de 14/09
 * ("o menu tem que ficar sempre visível, em qualquer lugar do site"). O teste
 * irmão (App.cabecalho-de-todas-as-telas.test.ts) confere que toda rota
 * autenticada passa por aqui; este confere que passar por aqui basta.
 */

// A conta no cache, a exclusão de reunião e o fim da gravação: o que as
// retomadas da gravação em partes (components/RetomadaDosDescartes.tsx e
// components/RetomadaDasPartes.tsx), que vêm com toda tela logada, usam.
const duble = vi.hoisted(() => ({ conta: vi.fn(), excluir: vi.fn(), encerrar: vi.fn() }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/trpc", () => {
  // O MESMO objeto a cada render, como o useUtils do tRPC.
  const utils = { auth: { me: { getData: duble.conta } }, client: { meetings: { delete: { mutate: duble.excluir }, encerrarGravacao: { mutate: duble.encerrar } } } };
  return {
    trpc: {
      useUtils: () => utils,
      auth: { logout: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    },
  };
});

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

// O AppHeader chega por lazy() (App.tsx). Com a máquina carregada, a primeira
// carga do módulo passava de 1 s, o prazo do findByRole, e a tela ficava no
// fallback vazio do Suspense. Carregado aqui, com prazo próprio, o lazy()
// resolve na hora.
beforeAll(async () => {
  await import("./components/AppHeader");
}, 30_000);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role: "silver", onboardingCompleted: true },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function montar(props: { cabecalhoProprio?: boolean } = {}) {
  return render(
    <Suspense fallback={null}>
      <TelaAutenticada {...props}>
        <p>miolo da página</p>
      </TelaAutenticada>
    </Suspense>,
  );
}

describe("TelaAutenticada — o menu vem junto com a página", () => {
  it("tela logada comum: o miolo e o menu global na mesma tela", async () => {
    montar();

    expect(await screen.findByRole("button", { name: /menu/i })).toBeInTheDocument();
    expect(screen.getByText("miolo da página")).toBeInTheDocument();
    // O avatar do perfil, que também é do cabeçalho: a barra inteira veio.
    expect(screen.getByTitle("Meu Perfil")).toBeInTheDocument();
  });

  it("tela que monta o próprio cabeçalho: a rota não monta um segundo", async () => {
    montar({ cabecalhoProprio: true });

    expect(await screen.findByText("miolo da página")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /menu/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Meu Perfil")).not.toBeInTheDocument();
  });

  it("sem sessão: nem página nem menu (a guarda manda para o login)", () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null, loading: false, error: null, isAuthenticated: false, refresh: vi.fn(), logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    montar();

    expect(screen.queryByText("miolo da página")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /menu/i })).not.toBeInTheDocument();
  });
});

/**
 * A retomada dos descartes de gravação que não terminaram (revisão da G13b) vem
 * com toda tela logada, e não só com a de Reuniões: a dona que descartou, perdeu
 * a rede e foi para outra tela tem o descarte repetido ali.
 */
describe("TelaAutenticada — a retomada dos descartes de gravação vem junto", () => {
  afterEach(() => { localStorage.removeItem(CHAVE_DOS_DESCARTES); });

  it.each([{ tela: "com o menu global", cabecalhoProprio: false }, { tela: "com o cabeçalho próprio", cabecalhoProprio: true }])(
    "tela logada $tela: o descarte guardado da conta é excluído, e a sessão fica livre",
    async ({ cabecalhoProprio }) => {
      duble.conta.mockReturnValue({ openId: "dona-1" });
      duble.excluir.mockResolvedValue({ success: true });
      localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
      montar({ cabecalhoProprio });
      expect(await screen.findByText("miolo da página")).toBeInTheDocument();
      await waitFor(() => expect(duble.excluir).toHaveBeenCalledWith({ meetingId: "r-1" }));
      await waitFor(() => expect(localStorage.getItem(CHAVE_DOS_DESCARTES)).toBeNull());
      expect(sessaoOcupada()).toBe(false);
    },
  );

  it("sem sessão, nada é retomado", async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null, loading: false, error: null, isAuthenticated: false, refresh: vi.fn(), logout: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    duble.conta.mockReturnValue({ openId: "dona-1" });
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-1", dona: "dona-1" }]));
    localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify({ "r-2": { partes: 2, dona: "dona-1" } }));
    montar();
    await new Promise(r => setTimeout(r, 20));
    expect(duble.excluir).not.toHaveBeenCalled();
    expect(duble.encerrar).not.toHaveBeenCalled();
  });
});

/**
 * A retomada das partes e dos fins da gravação (G13c) também vem com toda tela
 * logada: a dona que saiu de Reuniões gravando, com a última parte ou o fim
 * falhando por rede, tem o envio repetido na tela em que estiver.
 */
describe("TelaAutenticada — a retomada das partes e dos fins vem junto", () => {
  afterEach(() => { localStorage.removeItem(CHAVE_DOS_FINS); });

  it.each([{ tela: "com o menu global", cabecalhoProprio: false }, { tela: "com o cabeçalho próprio", cabecalhoProprio: true }])(
    "tela logada $tela: o fim guardado da conta é declarado, e sai da lista",
    async ({ cabecalhoProprio }) => {
      duble.conta.mockReturnValue({ openId: "dona-1" });
      duble.encerrar.mockResolvedValue({ partes: 2 });
      localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify({ "r-2": { partes: 2, dona: "dona-1" } }));
      montar({ cabecalhoProprio });
      expect(await screen.findByText("miolo da página")).toBeInTheDocument();
      await waitFor(() => expect(duble.encerrar).toHaveBeenCalledWith({ meetingId: "r-2", partes: 2 }));
      await waitFor(() => expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull());
      expect(duble.encerrar).toHaveBeenCalledTimes(1);
    },
  );
});
