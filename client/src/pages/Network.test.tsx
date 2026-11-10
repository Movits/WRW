import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import Network from "./Network";

/**
 * Etapa 1 — defeitos da reverificação de 04/09 (e da revisão da PR-A) na
 * tela Minha Rede:
 *
 * A. Editar e salvar não fechava o modal: ele virava "Novo Contato" com os
 *    dados da edição, e um 2º Salvar criava uma duplicata (com a MESMA foto
 *    no bucket).
 * B. Excluir o único contato da última página deixava a consulta presa nela:
 *    "20 contato" sobre "Sua rede está vazia", sem paginação para voltar.
 * C. Consulta falhando (banco fora do ar, 429, 500) virava "Sua rede está
 *    vazia" com convite para cadastrar o primeiro contato.
 * D. No detalhe do contato, histórico de IA em erro virava "Nenhum
 *    enriquecimento via IA ainda." e contextos em erro sumiam a seção.
 *
 * O tRPC vira um dublê (molde: EnrichmentChat.test.tsx): a lista é uma função
 * do input, e cada useMutation registra as opções para o teste "responder
 * pelo servidor" quando quiser. useAuth é dublê como em ProtectedRoute.test.
 * O chat de enriquecimento (dentro do detalhe) tem os próprios testes e fica
 * de fora.
 */

type Vars = Record<string, unknown>;
type Opcoes = { onSuccess?: (data: unknown, vars: Vars) => void; onError?: (erro: unknown, vars: Vars) => void };

// vi.mock é içado; o que as fábricas usam nasce em vi.hoisted.
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return { mutacoes, registrar, list: vi.fn(), refetch: vi.fn(), getHistory: vi.fn(), listByContact: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/EnrichmentChat", () => ({ EnrichmentChat: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    // A seção "Possui / Procura" do detalhe (PR #68) consulta e invalida por
    // aqui; sem itens ela não aparece, e é o que estes testes querem.
    useUtils: () => ({
      network: { assetsNeeds: { invalidate: vi.fn() }, get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } },
      enrichment: { getHistory: { invalidate: vi.fn() } },
    }),
    network: {
      list: { useQuery: (...args: unknown[]) => duble.list(...args) },
      // O detalhe relê o contato por network.get (PR do chat); sem resposta,
      // vale o retrato da lista — é o que estes testes querem.
      get: { useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }) },
      assetsNeeds: { useQuery: () => ({ data: { possui: [], procura: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() }) },
      removeAsset: duble.registrar("removeAsset"),
      removeNeed: duble.registrar("removeNeed"),
      create: duble.registrar("create"),
      update: duble.registrar("update"),
      delete: duble.registrar("delete"),
      uploadPhoto: duble.registrar("uploadPhoto"),
      uploadCard: duble.registrar("uploadCard"),
    },
    enrichment: {
      startSession: duble.registrar("startSession"),
      confirmSuggestion: duble.registrar("confirmSuggestion"),
      ignoreSuggestion: duble.registrar("ignoreSuggestion"),
      undoSuggestion: duble.registrar("undoSuggestion"),
      getHistory: { useQuery: (...args: unknown[]) => duble.getHistory(...args) },
    },
    contexts: { listByContact: { useQuery: (...args: unknown[]) => duble.listByContact(...args) } },
  },
}));

const FOTO = "/manus-storage/contacts/dona-1/foto_ana.jpg";
function contato(id: number, fullName = `Contato ${id}`) {
  return { id, fullName, photoUrl: FOTO, jobTitle: null, company: null, country: null, createdAt: 0, updatedAt: 0 };
}
const ana = contato(1, "Ana Lima");
const bia = contato(2, "Bia Souza");

// Erro como o servidor devolve (envelope tRPC, com data.code): é a mensagem
// dele que a tela mostra. Sem o envelope, vale o genérico traduzido.
const MENSAGEM = "Banco de dados indisponível. Tente de novo em instantes.";
const erroDoServidor = { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } };
const consultaSa = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };

type Resposta = { data?: { data: ReturnType<typeof contato>[]; total: number }; isLoading?: boolean; isError?: boolean; error?: { message: string; data?: { code: string } } | null };
function servidorResponde(porPagina: (page: number) => Resposta) {
  duble.list.mockImplementation((input: { page: number }) => {
    const resposta = { ...consultaSa, refetch: duble.refetch, ...porPagina(input.page) };
    // Este dublê é SÍNCRONO: `data` é função pura de `page`, então a resposta
    // é sempre a que o servidor acabou de dar — nunca há pedido em voo, sobra
    // do cache nem busca suspensa por falta de rede. É o que
    // `isSuccess`/`fetchStatus` precisam dizer para a tela; sem eles o dublê
    // afirmaria, calado, que a consulta nunca assentou. Cache, resposta velha
    // e modo offline ficam em Network.paginacao-cache.test.tsx, com o React
    // Query de verdade — esta suíte é cega para eles de propósito.
    return { ...resposta, fetchStatus: resposta.isLoading ? "fetching" : "idle", isSuccess: !resposta.isLoading && !resposta.isError };
  });
}

beforeEach(() => {
  // mockReset zera os dublês antes de cada teste: cada um declara o que espera.
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Dona", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  duble.getHistory.mockReturnValue({ ...consultaSa });
  duble.listByContact.mockReturnValue({ ...consultaSa, data: [] });
});

const botaoDoFormulario = () => screen.queryByRole("button", { name: /salvar|próximo/i });
const proximo = () => screen.queryByRole("button", { name: /próximo/i });
const campoNome = () => screen.getByPlaceholderText("Nome completo do contato");

/** Abre o menu "···" do cartão daquele contato e clica em Editar. */
function abrirEdicaoDe(nome: string) {
  const cartao = screen.getByText(nome).closest("div.group") as HTMLElement;
  fireEvent.click(within(cartao).getByRole("button", { name: "···" }));
  fireEvent.click(within(cartao).getByRole("button", { name: "Editar" }));
}

/** Anda as 4 etapas do formulário e clica em ✓ Salvar (só existe na última). */
function salvarFormulario() {
  for (let i = 0; i < 5 && proximo(); i++) fireEvent.click(proximo()!);
  fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
}

/**
 * Fecha o formulário pelo fundo escuro — que, de propósito, continua ativo
 * enquanto o envio está no ar: travar o modal até o servidor responder
 * prenderia a usuária num pedido que nunca volta. É justamente por isso que o
 * `onSuccess` precisa conferir de quem era o salvamento.
 */
function fecharFormulario() {
  const titulo = screen.getByText(/^(Editar|Novo) Contato$/);
  fireEvent.click(titulo.closest("div.fixed") as HTMLElement);
}

/** As variáveis que a tela mandou no último `update.mutate` (inclui o id). */
const varsDoUpdate = () => duble.mutacoes.update.mutate.mock.calls.at(-1)?.[0] as Vars;

describe("Minha Rede — editar e salvar fecha o modal", () => {
  it("após o servidor confirmar a edição, nem 'Editar Contato' nem 'Novo Contato' ficam na tela, e não há 2º Salvar", () => {
    servidorResponde(() => ({ data: { data: [ana], total: 1 } }));
    render(<Network />);

    abrirEdicaoDe("Ana Lima");
    expect(screen.getByText("Editar Contato")).toBeInTheDocument();
    expect(botaoDoFormulario()).toBeInTheDocument();
    salvarFormulario();
    expect(varsDoUpdate().id).toBe(ana.id);

    // O servidor confirma o update — com as MESMAS variáveis que a tela
    // enviou, como o React Query devolve em onSuccess(dados, vars).
    act(() => { duble.mutacoes.update.opcoes.onSuccess?.({ success: true }, varsDoUpdate()); });

    expect(screen.queryByText("Editar Contato")).not.toBeInTheDocument();
    expect(screen.queryByText("Novo Contato")).not.toBeInTheDocument();
    expect(botaoDoFormulario()).not.toBeInTheDocument();
    expect(duble.mutacoes.create.mutate).not.toHaveBeenCalled();
    expect(duble.refetch).toHaveBeenCalled();
  });
});

/**
 * Regressão da PR #69 (major 1 da reverificação de 04/09): o `onSuccess` do
 * update fechava o formulário SEM conferir de quem era o salvamento. Quem
 * salvava a Ana, fechava e abria outro formulário perdia o que já tinha
 * digitado assim que a resposta atrasada da Ana chegava — com o toast
 * "Contato atualizado!" por cima, como se estivesse tudo certo.
 */
describe("Minha Rede — sucesso atrasado só fecha o formulário de quem foi salvo", () => {
  it("salvou a Ana, fechou e abriu '+ Novo': o que está sendo digitado não some", () => {
    servidorResponde(() => ({ data: { data: [ana], total: 1 } }));
    render(<Network />);

    abrirEdicaoDe("Ana Lima");
    salvarFormulario();
    const varsDaAna = varsDoUpdate();
    expect(varsDaAna.id).toBe(ana.id);

    fecharFormulario();
    fireEvent.click(screen.getByRole("button", { name: "Novo" }));
    expect(screen.getByText("Novo Contato")).toBeInTheDocument();
    fireEvent.change(campoNome(), { target: { value: "Carla Nova" } });

    // Só AGORA o servidor responde o salvamento da Ana.
    act(() => { duble.mutacoes.update.opcoes.onSuccess?.({ success: true }, varsDaAna); });

    expect(screen.getByText("Novo Contato")).toBeInTheDocument();
    expect(campoNome()).toHaveValue("Carla Nova");
    expect(duble.mutacoes.create.mutate).not.toHaveBeenCalled();
    // O aviso e a atualização da lista continuam acontecendo sempre.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Contato atualizado!");
    expect(duble.refetch).toHaveBeenCalled();
  });

  it("salvou a Ana e abriu a edição da Bia: o formulário continua sendo o da Bia", () => {
    servidorResponde(() => ({ data: { data: [ana, bia], total: 2 } }));
    render(<Network />);

    abrirEdicaoDe("Ana Lima");
    salvarFormulario();
    const varsDaAna = varsDoUpdate();
    expect(varsDaAna.id).toBe(ana.id);

    fecharFormulario();
    abrirEdicaoDe("Bia Souza");
    expect(screen.getByText("Editar Contato")).toBeInTheDocument();
    expect(campoNome()).toHaveValue("Bia Souza");
    fireEvent.change(campoNome(), { target: { value: "Bia Souza Nova" } });

    act(() => { duble.mutacoes.update.opcoes.onSuccess?.({ success: true }, varsDaAna); });

    expect(screen.getByText("Editar Contato")).toBeInTheDocument();
    expect(campoNome()).toHaveValue("Bia Souza Nova");
    expect(screen.queryByText("Novo Contato")).not.toBeInTheDocument();
  });
});

describe("Minha Rede — página que deixou de existir volta para a ÚLTIMA que existe", () => {
  const faixa = (de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => contato(de + i));

  it("na página 2 vazia (total 20), a consulta seguinte pede a página 1 e 'Sua rede está vazia' não aparece", () => {
    servidorResponde(page => page === 1
      ? { data: { data: faixa(1, 20), total: 21 } }   // 21 contatos: há página 2
      : { data: { data: [], total: 20 } });           // o único da página 2 foi excluído

    render(<Network />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));

    const ultimaConsulta = duble.list.mock.calls.at(-1)?.[0] as { page: number };
    expect(ultimaConsulta.page).toBe(1);
    expect(screen.queryByText("Sua rede está vazia")).not.toBeInTheDocument();
    expect(screen.getByText("Contato 1")).toBeInTheDocument();
  });

  it("41 contatos, o único da página 3 é excluído: a consulta seguinte pede a página 2 (não a 1) e 'Contato 21' aparece", () => {
    // Um clamp que voltasse sempre para a página 1 passaria no caso acima
    // (última página = 1). Aqui a última que existe é a 2.
    let excluido = false;
    servidorResponde(page => {
      if (page === 3) { excluido = true; return { data: { data: [], total: 40 } }; }
      const total = excluido ? 40 : 41;
      return page === 1 ? { data: { data: faixa(1, 20), total } } : { data: { data: faixa(21, 40), total } };
    });

    render(<Network />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));
    fireEvent.click(screen.getByRole("button", { name: "Próxima →" }));

    const ultimaConsulta = duble.list.mock.calls.at(-1)?.[0] as { page: number };
    expect(ultimaConsulta.page).toBe(2);
    expect(screen.getByText("Contato 21")).toBeInTheDocument();
    expect(screen.queryByText("Contato 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Sua rede está vazia")).not.toBeInTheDocument();
    expect(screen.getByText("Página 2 de 2")).toBeInTheDocument();
  });
});

describe("Minha Rede — erro de consulta não é rede vazia", () => {
  it("com a consulta em erro, mostra a mensagem do servidor e o botão de tentar de novo; sem 'rede vazia' e sem contador", () => {
    servidorResponde(() => ({ isError: true, error: erroDoServidor }));
    render(<Network />);

    expect(screen.getByRole("alert")).toHaveTextContent("Algo inesperado aconteceu");
    expect(screen.getByText(MENSAGEM)).toBeInTheDocument();
    expect(screen.queryByText("Sua rede está vazia")).not.toBeInTheDocument();
    expect(screen.queryByText("Adicione seu primeiro contato estratégico.")).not.toBeInTheDocument();
    // O contador ("Nenhum contato encontrado" / "N contato") some: não há número a afirmar.
    expect(screen.queryByText("Nenhum contato encontrado")).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ contato/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(duble.refetch).toHaveBeenCalledTimes(1);
  });

  it("erro fora do envelope tRPC (rede fora, 502 em HTML): o genérico traduzido, nunca 'Failed to fetch'", () => {
    servidorResponde(() => ({ isError: true, error: { message: "Failed to fetch" } }));
    render(<Network />);

    expect(screen.getByRole("alert")).toHaveTextContent("O servidor não respondeu. Tente de novo em instantes.");
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(screen.queryByText("Sua rede está vazia")).not.toBeInTheDocument();
  });
});

describe("Minha Rede — detalhe do contato: consulta em erro não é 'nada ainda'", () => {
  const abrirDetalhe = () => {
    servidorResponde(() => ({ data: { data: [ana], total: 1 } }));
    render(<Network />);
    fireEvent.click(screen.getByText("Ana Lima"));
  };

  it("histórico de IA em erro: a aba mostra o alerta, não 'Nenhum enriquecimento via IA ainda.'", () => {
    const recarregar = vi.fn();
    duble.getHistory.mockReturnValue({ ...consultaSa, isError: true, error: erroDoServidor, refetch: recarregar });
    abrirDetalhe();

    fireEvent.click(screen.getByRole("button", { name: /Histórico IA/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText("Nenhum enriquecimento via IA ainda.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it("contextos em erro: a seção 'Linha do Tempo' aparece com o alerta em vez de sumir", () => {
    const recarregar = vi.fn();
    duble.listByContact.mockReturnValue({ ...consultaSa, isError: true, error: erroDoServidor, refetch: recarregar });
    abrirDetalhe();

    expect(screen.getByText("Linha do Tempo")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it("sem erro e sem contextos, a seção não aparece — e o histórico vazio continua dizendo que está vazio", () => {
    abrirDetalhe();
    expect(screen.queryByText("Linha do Tempo")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Histórico IA/ }));
    expect(screen.getByText("Nenhum enriquecimento via IA ainda.")).toBeInTheDocument();
  });
});
