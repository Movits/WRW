import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Network from "./Network";

/**
 * Minha Rede — o botão "Desfazer" do Histórico IA faz alguma coisa.
 *
 * A reverificação de 04/09: o botão tinha ícone, title e nenhum onClick — o
 * clique era um no-op, sem requisição, sem aviso. Agora ele chama
 * enrichment.undoSuggestion, fica desligado (com o porquê no title) para a
 * sugestão aplicada antes de existir o retrato do valor anterior, e no
 * sucesso refaz tudo que lê o contato.
 *
 * O tRPC vira um dublê (molde de Network.possui-procura.test.tsx).
 */

type Vars = Record<string, unknown>;
type Opcoes = { onSuccess?: (data: unknown, vars: Vars) => void; onError?: (erro: unknown, vars: Vars) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes?: Opcoes) => {
      const m = (mutacoes[nome] ??= { opcoes: opcoes ?? {}, mutate: vi.fn() });
      m.opcoes = opcoes ?? {};
      return { mutate: m.mutate, isPending: false };
    },
  });
  const consulta = (data: unknown = undefined) => ({ useQuery: () => ({ data, isLoading: false, isError: false, refetch: vi.fn() }) });
  return {
    mutacoes,
    registrar,
    consulta,
    contatos: [] as unknown[],
    historico: { data: [] as unknown[], total: 0 },
    utils: {
      network: { assetsNeeds: { invalidate: vi.fn() }, get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } },
      enrichment: { getHistory: { invalidate: vi.fn() } },
    },
  };
});

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, openId: "dona-1" }, isAuthenticated: true, loading: false }),
}));
vi.mock("@/components/EnrichmentChat", () => ({ EnrichmentChat: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    network: {
      list: { useQuery: () => ({ data: { data: duble.contatos, total: duble.contatos.length }, isLoading: false, refetch: vi.fn() }) },
      get: duble.consulta(),
      create: duble.registrar("create"),
      update: duble.registrar("update"),
      delete: duble.registrar("delete"),
      uploadPhoto: duble.registrar("uploadPhoto"),
      uploadCard: duble.registrar("uploadCard"),
      assetsNeeds: duble.consulta({ possui: [], procura: [] }),
      removeAsset: duble.registrar("removeAsset"),
      removeNeed: duble.registrar("removeNeed"),
      addItem: duble.registrar("addItem"),
      editItem: duble.registrar("editItem"),
    },
    enrichment: {
      startSession: duble.registrar("startSession"),
      getHistory: { useQuery: () => ({ data: duble.historico, isLoading: false }) },
      undoSuggestion: duble.registrar("undoSuggestion"),
    },
    contexts: { listByContact: duble.consulta([]) },
  },
}));

const contato = { id: 42, fullName: "Ana Lima", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
const aplicada = { id: "sug-nova", fieldType: "phone", suggestedValue: "11 99999-8888", appliedValue: "11 99999-8888", status: "applied", actionedAt: 1_700_000_000_000, podeDesfazer: true };
const antiga = { id: "sug-antiga", fieldType: "company", suggestedValue: "ACME", appliedValue: "ACME", status: "applied", actionedAt: 1_700_000_000_000, podeDesfazer: false };
const ignorada = { id: "sug-ignorada", fieldType: "email", suggestedValue: "a@b.c", appliedValue: null, status: "ignored", actionedAt: 1_700_000_000_000, podeDesfazer: false };

function abrirHistorico(itens: unknown[]) {
  duble.contatos = [contato];
  duble.historico = { data: itens, total: itens.length };
  render(<Network />);
  fireEvent.click(screen.getByText("Ana Lima"));
  fireEvent.click(screen.getByRole("button", { name: /histórico ia/i }));
}

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  for (const grupo of Object.values(duble.utils)) for (const q of Object.values(grupo)) q.invalidate.mockReset();
});

describe("Network — Desfazer no Histórico IA", () => {
  it("clicar em Desfazer chama undoSuggestion com o id da sugestão", () => {
    abrirHistorico([aplicada]);

    const botao = screen.getByTitle("Desfazer");
    expect(botao).toBeEnabled();
    fireEvent.click(botao);

    // Mutante "botão sem onClick": nada seria chamado.
    expect(duble.mutacoes.undoSuggestion.mutate).toHaveBeenCalledWith({ suggestionId: "sug-nova" });
  });

  it("aplicada antes do recurso existir: botão desligado, com o motivo no title; ignorada não tem botão", () => {
    abrirHistorico([antiga, ignorada]);

    const botao = screen.getByTitle("Aplicado antes do recurso existir; não há como reverter");
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(duble.mutacoes.undoSuggestion.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Desfazer")).not.toBeInTheDocument();
  });

  it("no sucesso: aviso, e o histórico, o perfil, a lista e possui/procura são refeitos", () => {
    abrirHistorico([aplicada]);
    fireEvent.click(screen.getByTitle("Desfazer"));

    act(() => duble.mutacoes.undoSuggestion.opcoes.onSuccess?.({ success: true, status: "undone", reverted: true, motivo: null }, { suggestionId: "sug-nova" }));

    expect(toast.success).toHaveBeenCalledWith("Alteração desfeita.");
    expect(duble.utils.enrichment.getHistory.invalidate).toHaveBeenCalledWith({ contactId: 42 });
    expect(duble.utils.network.get.invalidate).toHaveBeenCalledWith({ id: 42 });
    expect(duble.utils.network.list.invalidate).toHaveBeenCalled();
    expect(duble.utils.network.assetsNeeds.invalidate).toHaveBeenCalledWith({ contactId: 42 });
  });

  it("campo alterado depois pela dona: o aviso explica que ficou como está; erro do servidor vira aviso de erro", () => {
    abrirHistorico([aplicada]);
    fireEvent.click(screen.getByTitle("Desfazer"));

    act(() => duble.mutacoes.undoSuggestion.opcoes.onSuccess?.({ success: true, status: "undone", reverted: false, motivo: "valor_alterado_depois" }, { suggestionId: "sug-nova" }));
    expect(toast.success).toHaveBeenCalledWith("Marcado como desfeito. O campo foi alterado depois e ficou como está.");

    act(() => duble.mutacoes.undoSuggestion.opcoes.onError?.({ message: "UNDO_UNAVAILABLE", data: { code: "BAD_REQUEST" } }, { suggestionId: "sug-nova" }));
    expect(toast.error).toHaveBeenCalledWith("Erro ao desfazer.");
  });

  it("já desfeita (por outra aba, ou antes): diz isso, refaz o histórico e não chama de erro", () => {
    abrirHistorico([aplicada]);
    fireEvent.click(screen.getByTitle("Desfazer"));

    act(() => duble.mutacoes.undoSuggestion.opcoes.onError?.({ message: "SUGGESTION_ALREADY_UNDONE", data: { code: "NOT_FOUND" } }, { suggestionId: "sug-nova" }));

    expect(toast.info).toHaveBeenCalledWith("Essa sugestão já tinha sido desfeita.");
    // Mutante "onError só com toast": o botão continuaria ligado numa lista velha.
    expect(duble.utils.enrichment.getHistory.invalidate).toHaveBeenCalledWith({ contactId: 42 });
    expect(toast.error).not.toHaveBeenCalled();

    // O erro comum continua erro comum, sem refazer nada.
    act(() => duble.mutacoes.undoSuggestion.opcoes.onError?.({ message: "Banco de dados indisponível", data: { code: "INTERNAL_SERVER_ERROR" } }, { suggestionId: "sug-nova" }));
    expect(toast.error).toHaveBeenCalledWith("Erro ao desfazer.");
    expect(duble.utils.enrichment.getHistory.invalidate).toHaveBeenCalledTimes(1);
  });
});
