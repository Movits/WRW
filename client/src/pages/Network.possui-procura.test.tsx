import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Network from "./Network";

/**
 * Minha Rede — a seção "Possui / Procura" no detalhe do contato.
 *
 * Possui/procura é dado da AGENDA: o chat de enriquecimento grava sem o termo
 * do Smart Match e a vitrine já expõe. Ver e remover precisa morar aqui, sem
 * termo. E a consulta que FALHA (banco fora) precisa dizer isso: a seção
 * sumindo em silêncio, ou "nada registrado", faria a dona refazer de cabeça
 * um dado que ainda existe.
 *
 * O tRPC vira um dublê (molde de EnrichmentChat.test.tsx): cada useMutation
 * registra as opções para o teste "responder pelo servidor" na hora que
 * quiser, e `invalidate` re-renderiza quem consulta, como o React Query faria.
 */

type Vars = Record<string, unknown>;
type Opcoes = { onSuccess?: (data: unknown, vars: Vars) => void; onError?: (erro: unknown, vars: Vars) => void };
type PossuiProcura = {
  possui: { id: number; label: string; category: string | null }[];
  procura: { id: number; label: string; category: string | null }[];
};

// vi.mock é içado para o topo do arquivo; o que as fábricas usam precisa
// nascer em vi.hoisted, senão é lido antes de existir.
const duble = vi.hoisted(() => {
  const ouvintes = new Set<() => void>();
  let versao = 0;
  const loja = {
    subscribe: (fn: () => void) => { ouvintes.add(fn); return () => { ouvintes.delete(fn); }; },
    getSnapshot: () => versao,
    notificar: () => { versao += 1; ouvintes.forEach(fn => fn()); },
  };
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes?: Opcoes) => {
      const m = (mutacoes[nome] ??= { opcoes: opcoes ?? {}, mutate: vi.fn() });
      m.opcoes = opcoes ?? {};
      return { mutate: m.mutate, isPending: false };
    },
  });
  const consulta = (data: unknown = undefined) => ({ useQuery: () => ({ data, isLoading: false, refetch: vi.fn() }) });
  return {
    loja,
    mutacoes,
    registrar,
    consulta,
    contatos: [] as unknown[],
    /** O que network.assetsNeeds responde no momento: dados, ou erro. */
    possuiProcura: { data: undefined as PossuiProcura | undefined, isError: false, refetch: vi.fn() },
    invalidate: vi.fn(),
  };
});

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, openId: "dona-1" }, isAuthenticated: true, loading: false }),
}));
vi.mock("@/components/EnrichmentChat", () => ({ EnrichmentChat: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/trpc", async () => {
  const React = await import("react");
  return {
    trpc: {
      useUtils: () => ({
        network: { assetsNeeds: { invalidate: duble.invalidate }, get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } },
        enrichment: { getHistory: { invalidate: vi.fn() } },
      }),
      network: {
        list: { useQuery: () => ({ data: { data: duble.contatos, total: duble.contatos.length }, isLoading: false, refetch: vi.fn() }) },
        // O detalhe relê o contato pelo servidor (network.get); sem resposta,
        // vale o contato da lista — é o caso deste teste.
        get: duble.consulta(),
        create: duble.registrar("create"),
        update: duble.registrar("update"),
        delete: duble.registrar("delete"),
        uploadPhoto: duble.registrar("uploadPhoto"),
        uploadCard: duble.registrar("uploadCard"),
        assetsNeeds: {
          useQuery: () => {
            React.useSyncExternalStore(duble.loja.subscribe, duble.loja.getSnapshot);
            return duble.possuiProcura;
          },
        },
        removeAsset: duble.registrar("removeAsset"),
        removeNeed: duble.registrar("removeNeed"),
        addItem: duble.registrar("addItem"),
        editItem: duble.registrar("editItem"),
      },
      enrichment: {
        startSession: duble.registrar("startSession"),
        getHistory: duble.consulta(),
        undoSuggestion: duble.registrar("undoSuggestion"),
      },
      contexts: { listByContact: duble.consulta() },
    },
  };
});

const contato = { id: 42, fullName: "Ana Lima", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
const registrado: PossuiProcura = {
  possui: [{ id: 1, label: "Vinho do Porto", category: "Bebidas" }],
  procura: [{ id: 2, label: "Distribuidora na Ásia", category: null }],
};

// Abre a página com um contato e clica nele: o detalhe (com a seção) aparece.
function abrirDetalhe(resposta: Partial<typeof duble.possuiProcura>) {
  duble.contatos = [contato];
  duble.possuiProcura = { data: undefined, isError: false, refetch: vi.fn(), ...resposta };
  render(<Network />);
  fireEvent.click(screen.getByText("Ana Lima"));
}

const titulo = () => screen.queryByText("Possui / Procura");
const textoDeVazio = () => screen.queryByText(/Nada registrado ainda/);
const botaoRemover = (label: string) => screen.queryByRole("button", { name: `Remover ${label}` });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  // O invalidate do React Query refaz a consulta; aqui, re-renderiza quem
  // consulta com o que `duble.possuiProcura` tiver na hora.
  duble.invalidate.mockImplementation(() => duble.loja.notificar());
});

describe("Network — seção Possui / Procura no detalhe do contato", () => {
  it("lista o que o chat registrou, com os rótulos e a categoria", () => {
    abrirDetalhe({ data: registrado });

    expect(titulo()).toBeInTheDocument();
    expect(screen.getByText("Possui")).toBeInTheDocument();
    expect(screen.getByText("Procura")).toBeInTheDocument();
    expect(screen.getByText("Vinho do Porto")).toBeInTheDocument();
    expect(screen.getByText("· Bebidas")).toBeInTheDocument();
    expect(screen.getByText("Distribuidora na Ásia")).toBeInTheDocument();
    expect(botaoRemover("Vinho do Porto")).toBeInTheDocument();
    expect(botaoRemover("Distribuidora na Ásia")).toBeInTheDocument();
    expect(textoDeVazio()).not.toBeInTheDocument();
  });

  it("sem itens, diz que nada foi registrado (e não mostra erro)", () => {
    abrirDetalhe({ data: { possui: [], procura: [] } });
    expect(titulo()).toBeInTheDocument();
    expect(textoDeVazio()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("enquanto a consulta ainda não respondeu (sem dado e sem erro), a seção não aparece", () => {
    abrirDetalhe({ data: undefined });
    expect(titulo()).not.toBeInTheDocument();
  });

  it("o X chama removeAsset com o id; o chip só some quando o servidor confirma e a consulta é invalidada", () => {
    abrirDetalhe({ data: registrado });
    const remover = duble.mutacoes.removeAsset;

    fireEvent.click(botaoRemover("Vinho do Porto")!);
    expect(remover.mutate).toHaveBeenCalledWith({ id: 1 });
    // Mutante "esconder antes da resposta": o chip já teria sumido aqui.
    expect(botaoRemover("Vinho do Porto")).toBeInTheDocument();

    // O servidor confirma; a consulta refeita já vem sem o item.
    act(() => {
      duble.possuiProcura = { ...duble.possuiProcura, data: { possui: [], procura: registrado.procura } };
      remover.opcoes.onSuccess?.({ success: true }, { id: 1 });
    });
    expect(duble.invalidate).toHaveBeenCalledWith({ contactId: 42 });
    expect(toast.success).toHaveBeenCalledWith("Item removido.");
    // Mutante "sem invalidate": o chip continuaria na tela.
    expect(botaoRemover("Vinho do Porto")).not.toBeInTheDocument();
    expect(botaoRemover("Distribuidora na Ásia")).toBeInTheDocument();
  });

  it("o X de um 'procura' chama removeNeed, e o erro do servidor vira aviso sem tirar o chip", () => {
    abrirDetalhe({ data: registrado });
    const remover = duble.mutacoes.removeNeed;

    fireEvent.click(botaoRemover("Distribuidora na Ásia")!);
    expect(remover.mutate).toHaveBeenCalledWith({ id: 2 });

    act(() => { remover.opcoes.onError?.({ message: "Banco de dados indisponível" }, { id: 2 }); });
    expect(toast.error).toHaveBeenCalledWith("Não foi possível remover o item.");
    expect(duble.invalidate).not.toHaveBeenCalled();
    expect(botaoRemover("Distribuidora na Ásia")).toBeInTheDocument();
  });

  it("consulta com erro: mostra o bloco de erro com 'tentar de novo' — não 'nada registrado', nem some", () => {
    abrirDetalhe({ data: undefined, isError: true });

    // Mutante "só `possuiProcura &&`": a seção inteira sumiria em silêncio.
    expect(titulo()).toBeInTheDocument();
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Algo inesperado aconteceu");
    expect(textoDeVazio()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    expect(duble.possuiProcura.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Network — acrescentar e corrigir o possui e o procura na ficha (T45, 24/11)", () => {
  type OpcoesComFim = Opcoes & { onSettled?: () => void };
  const opcoesDe = (nome: string) => duble.mutacoes[nome].opcoes as OpcoesComFim;

  it("acrescentar no possui manda o texto da dona, limpa o campo quando o servidor aceita e relê a lista", () => {
    abrirDetalhe({ data: registrado });
    const campo = screen.getByRole("textbox", { name: "Novo item do que possui" });
    fireEvent.change(campo, { target: { value: "  Exportação de café  " } });
    fireEvent.click(screen.getAllByRole("button", { name: /Acrescentar/ })[0]);
    expect(duble.mutacoes.addItem.mutate).toHaveBeenCalledWith({ contactId: 42, tipo: "possui", rotulo: "Exportação de café" });

    act(() => { opcoesDe("addItem").onSuccess?.({ id: 7 }, {}); opcoesDe("addItem").onSettled?.(); });
    expect(toast.success).toHaveBeenCalledWith("Item acrescentado.");
    expect(duble.invalidate).toHaveBeenCalledWith({ contactId: 42 });
    expect(screen.getByRole("textbox", { name: "Novo item do que possui" })).toHaveValue("");
  });

  it("o campo vazio não manda nada (o botão fica desligado)", () => {
    abrirDetalhe({ data: registrado });
    const botao = screen.getAllByRole("button", { name: /Acrescentar/ })[1];
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(duble.mutacoes.addItem.mutate).not.toHaveBeenCalled();
  });

  it("corrigir um item do procura abre o campo com o texto de agora e manda o texto novo com o id e o tipo", () => {
    abrirDetalhe({ data: registrado });
    fireEvent.click(screen.getByRole("button", { name: "Corrigir Distribuidora na Ásia" }));
    const campo = screen.getByRole("textbox", { name: "Texto do item" });
    expect(campo).toHaveValue("Distribuidora na Ásia");
    fireEvent.change(campo, { target: { value: "Distribuidora no Japão" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    expect(duble.mutacoes.editItem.mutate).toHaveBeenCalledWith({ id: 2, tipo: "procura", rotulo: "Distribuidora no Japão" });

    act(() => { opcoesDe("editItem").onSuccess?.({ id: 2 }, {}); });
    expect(toast.success).toHaveBeenCalledWith("Item corrigido.");
    expect(screen.queryByRole("textbox", { name: "Texto do item" })).not.toBeInTheDocument();
  });

  it("a recusa do servidor sai traduzida, nunca como o código", () => {
    abrirDetalhe({ data: registrado });
    act(() => { opcoesDe("addItem").onError?.({ message: "ITEM_DA_FICHA_REPETIDO" }, {}); });
    expect(toast.error).toHaveBeenLastCalledWith("Este contato já tem esse item.");
    act(() => { opcoesDe("addItem").onError?.({ message: "ITEM_DA_FICHA_SEM_TEXTO" }, {}); });
    expect(toast.error).toHaveBeenLastCalledWith("Escreva o item com letras ou números.");
    act(() => { opcoesDe("editItem").onError?.({ message: "Banco de dados indisponível" }, {}); });
    expect(toast.error).toHaveBeenLastCalledWith("Não foi possível salvar o item. Tente de novo.");
  });

  it("a ficha sem nada mostra os campos para acrescentar e a nota de que o texto não passa pela IA", () => {
    abrirDetalhe({ data: { possui: [], procura: [] } });
    expect(screen.getByRole("textbox", { name: "Novo item do que possui" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Novo item do que procura" })).toBeInTheDocument();
    expect(screen.getByText(/sem passar pela IA/)).toBeInTheDocument();
  });
});
