import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnrichmentChat } from "./EnrichmentChat";

/**
 * O Chat de Enriquecimento quando a pergunta seguinte chega com cartões: o que a usuária já tinha dito para ela
 * ("Não sei o telefone. O que ela tem para oferecer: Exportação de café." — conferência de tela do pacote do match,
 * 20/11/2026). Ao confirmar ou ignorar o cartão da pergunta anterior, o servidor devolve a pergunta seguinte e os
 * cartões dela (`nextSuggestions`): a tela os mostra e espera a decisão, em vez de abrir o campo de digitar.
 *
 * O cartão do que a pessoa oferece tem o rótulo do idioma ("✨ Ativo"): o servidor grava o campo com o nome da
 * pergunta ("assets"), que antes saía cru no cartão.
 */
type Vars = Record<string, unknown>;
type Opcoes = { onSuccess?: (data: unknown, vars: Vars) => void; onError?: (erro: unknown, vars: Vars) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return {
    mutacoes,
    registrar,
    getActiveSession: vi.fn(),
    getMessages: vi.fn(),
    utils: {
      enrichment: {
        getActiveSession: { invalidate: vi.fn() },
        getMessages: { fetch: vi.fn(), invalidate: vi.fn() },
        getHistory: { invalidate: vi.fn() },
      },
      network: { get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() }, assetsNeeds: { invalidate: vi.fn() } },
      contexts: { listByContact: { invalidate: vi.fn() } },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    enrichment: {
      getActiveSession: { useQuery: (...args: unknown[]) => duble.getActiveSession(...args) },
      getMessages: { useQuery: (...args: unknown[]) => duble.getMessages(...args) },
      startSession: duble.registrar("startSession"),
      sendMessage: duble.registrar("sendMessage"),
      confirmSuggestion: duble.registrar("confirmSuggestion"),
      ignoreSuggestion: duble.registrar("ignoreSuggestion"),
      completeSession: duble.registrar("completeSession"),
      createSuggestedContext: duble.registrar("createSuggestedContext"),
    },
  },
}));

const perguntaDaEmpresa = { id: "m1", role: "assistant", content: "Em qual empresa trabalha?", suggestions: [] };
const cartaoDaEmpresa = { id: "sug-empresa", fieldType: "company", suggestedValue: "Café Brasil", confidence: 0.9, status: "pending" as const };
const pedidoDaEmpresa = { id: "m2", role: "assistant", content: "Confirma: Café Brasil?", suggestions: [cartaoDaEmpresa] };
const PERGUNTA_DOS_ATIVOS = "O que essa pessoa pode oferecer? (ex.: mina, fábrica, patente, acesso) Você já tinha contado isto antes: confirme o que vale ou ignore.";
const cartaoDoAtivo = { id: "sug-ativo", fieldType: "assets", suggestedValue: "Exportação de café", confidence: 0.9, status: "pending" as const };
const comCartoes = { success: true, nextQuestion: PERGUNTA_DOS_ATIVOS, nextMessageId: "m3", nextSuggestions: [cartaoDoAtivo], sessionComplete: false, pendentesRestantes: 0 };

function montar(mensagens: unknown[]) {
  duble.getActiveSession.mockReturnValue({ data: { id: "sessao-1", status: "active" }, isLoading: false });
  duble.getMessages.mockReturnValue({ data: mensagens, isFetchedAfterMount: true });
  return render(<EnrichmentChat contactId={42} contactName="K1" />);
}

const campoDeResposta = () => screen.queryByPlaceholderText("Responda aqui...");

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
});

describe("EnrichmentChat — a pergunta seguinte chega com o que a usuária já tinha dito", () => {
  it.each([
    ["confirmar", "confirmSuggestion", /^confirmar$/i, "applied"],
    ["ignorar", "ignoreSuggestion", /^ignorar$/i, "ignored"],
  ])("ao %s o cartão da empresa: o cartão do ativo aparece, com o rótulo do idioma, e a tela espera a decisão", (_acao, mutacao, botao, status) => {
    montar([perguntaDaEmpresa, pedidoDaEmpresa]);
    fireEvent.click(screen.getByRole("button", { name: botao }));
    act(() => duble.mutacoes[mutacao].opcoes.onSuccess?.({ ...comCartoes, status }, { suggestionId: "sug-empresa" }));

    expect(screen.getByText(PERGUNTA_DOS_ATIVOS)).toBeInTheDocument();
    expect(screen.getByText("Exportação de café")).toBeInTheDocument();
    expect(screen.getByText("✨ Ativo")).toBeInTheDocument();
    expect(screen.queryByText("assets")).not.toBeInTheDocument();
    // O campo de digitar só volta depois da decisão do cartão novo.
    expect(campoDeResposta()).not.toBeInTheDocument();
    expect(screen.getByText(/confirme ou ignore/i)).toBeInTheDocument();
  });

  it("sem cartões na pergunta seguinte, o campo de digitar volta, como antes", () => {
    montar([perguntaDaEmpresa, pedidoDaEmpresa]);
    fireEvent.click(screen.getByRole("button", { name: /^confirmar$/i }));
    act(() => duble.mutacoes.confirmSuggestion.opcoes.onSuccess?.(
      { ...comCartoes, status: "applied", nextQuestion: "O que essa pessoa pode oferecer?", nextSuggestions: [] }, { suggestionId: "sug-empresa" }));

    expect(screen.getByText("O que essa pessoa pode oferecer?")).toBeInTheDocument();
    expect(campoDeResposta()).toBeInTheDocument();
  });
});
