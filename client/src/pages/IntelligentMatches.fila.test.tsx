import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";

/**
 * Conexões Inteligentes na conta grande (N4b): com mais de 2000 contatos, o
 * recálculo vai para a fila do servidor e a resposta vem `{ total: 0, emFila: true }`.
 * A tela dizia "0 oportunidade(s) analisada(s)" como sucesso; agora diz que as
 * sugestões são recalculadas em segundo plano, no recalcular, no acrescentar e no
 * remover.
 *
 * O tRPC é um dublê genérico (como em IntelligentMatches.motivo.test.tsx), que
 * guarda as opções de cada useMutation para o teste chamar o onSuccess.
 */
const duble = vi.hoisted(() => {
  const respostas: Record<string, unknown> = {};
  const opcoes: Record<string, { onSuccess?: (r: unknown) => void }> = {};
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: () => ({ data: respostas[caminho], isLoading: false, isError: false, error: null, refetch: () => {} }),
    useMutation: (o: { onSuccess?: (r: unknown) => void } = {}) => { opcoes[caminho] = o; return { mutate: () => {}, isPending: false }; },
  });
  const utils = new Proxy({}, {
    get: (_, router) => ignorar(router) ? undefined : new Proxy({}, {
      get: (_, proc) => ignorar(proc) ? undefined : new Proxy({}, { get: (_, metodo) => ignorar(metodo) ? undefined : async () => undefined }),
    }),
  });
  const trpc = new Proxy({}, {
    get: (_, router) => {
      if (ignorar(router)) return undefined;
      if (router === "useUtils") return () => utils;
      return new Proxy({}, { get: (_, proc) => ignorar(proc) ? undefined : procedimento(`${String(router)}.${String(proc)}`) });
    },
  });
  return { respostas, opcoes, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

const { default: IntelligentMatches } = await import("./IntelligentMatches");

const NA_FILA = { created: 0, updated: 0, removed: 0, total: 0, emFila: true };
const NA_HORA = { created: 1, updated: 0, removed: 0, total: 3 };

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.info).mockClear();
  duble.respostas["consent.status"] = { accepted: true, pendingText: null, document: null };
  duble.respostas["consent.history"] = [];
  duble.respostas["intelligentMatches.contacts"] = [];
  duble.respostas["intelligentMatches.list"] = [];
  render(<IntelligentMatches />);
});

describe("Conexões Inteligentes — o recálculo que foi para a fila", () => {
  it("recalcular na conta grande avisa que roda em segundo plano, sem anunciar 0 analisadas", () => {
    duble.opcoes["intelligentMatches.recalculate"].onSuccess!(NA_FILA);
    expect(toast.info).toHaveBeenCalledWith(i18n.t("intelligentMatches.recalculoNaFila"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("acrescentar e remover na conta grande também dizem que as sugestões vêm depois", () => {
    duble.opcoes["intelligentMatches.addAsset"].onSuccess!(NA_FILA);
    duble.opcoes["intelligentMatches.removeNeed"].onSuccess!(NA_FILA);
    expect(toast.info).toHaveBeenCalledTimes(2);
    expect(toast.info).toHaveBeenCalledWith(i18n.t("intelligentMatches.alteracaoNaFila"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("na conta comum, o de sempre", () => {
    duble.opcoes["intelligentMatches.recalculate"].onSuccess!(NA_HORA);
    expect(toast.success).toHaveBeenCalledWith(i18n.t("intelligentMatches.toastRecalculado", { total: 3 }));
    expect(toast.info).not.toHaveBeenCalled();
  });
});
