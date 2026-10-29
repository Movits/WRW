import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConexoesRegistradasDaPlataforma } from "./ConexoesRegistradasDaPlataforma";

/**
 * Painel Ouro, aba "Conexões registradas" (Meu Network Inteligente, itens 17 e
 * 18). O que se trava:
 * 1. A aba lista o que `networkInteligente.admin.conexoes` devolve — origem,
 *    etapa, status da comissão, ID anônimo do contato — e os filtros vão como
 *    entrada da consulta (o filtro é do servidor, não da tela).
 * 2. O botão de comissão só existe para conexão FECHADA, e registrar pede
 *    confirmação antes de chamar `definirComissao`.
 * 3. Consulta que falhou é erro, não "nenhuma conexão".
 */

type Resposta = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };

const duble = vi.hoisted(() => ({
  resposta: {} as { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown },
  entradas: [] as unknown[],
  mutate: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    networkInteligente: {
      admin: {
        conexoes: {
          useQuery: (entrada: unknown) => {
            duble.entradas.push(entrada);
            return { data: undefined, isLoading: false, isError: false, error: null, refetch: duble.refetch, ...duble.resposta };
          },
        },
        definirComissao: { useMutation: () => ({ mutate: duble.mutate, isPending: false }) },
      },
    },
  },
}));

const lado = (extra: Record<string, unknown>) => ({
  id: 1, lado: "a", tipo: "contato", codigoAnonimo: null, originador: false, statusComissaoOriginador: null, conta: { id: 10, nome: "Conta Dez" }, ...extra,
});

const conexao = (extra: Record<string, unknown>) => ({
  id: "c-1", origem: "PRIVATE_NETWORK_MATCH", chaveDoPar: "k", motivo: "NW-AAAAAA tem Vinho, que NW-BBBBBB procura.",
  itens: [{ tem: "Vinho", precisa: "Vinho", deCodigo: "NW-AAAAAA", paraCodigo: "NW-BBBBBB" }], pontuacao: 100,
  status: "identificada", apresentacaoEm: null, negociacaoEm: null, fechamentoEm: null, descartadaEm: null,
  statusComissao: "sem_negocio", createdAt: Date.UTC(2026, 8, 14), updatedAt: 1,
  lados: [lado({ id: 1, lado: "a", codigoAnonimo: "NW-AAAAAA" }), lado({ id: 2, lado: "b", codigoAnonimo: "NW-BBBBBB" })],
  ...extra,
});

const identificada = conexao({ id: "c-identificada" });
const fechada = conexao({
  id: "c-fechada", origem: "NETWORK_NETWORK_MATCH", status: "fechada", statusComissao: "a_apurar",
  apresentacaoEm: 1, negociacaoEm: 2, fechamentoEm: Date.UTC(2026, 8, 14),
  lados: [
    lado({ id: 7, lado: "a", codigoAnonimo: "NW-CCCCCC", originador: true, statusComissaoOriginador: "a_apurar" }),
    lado({ id: 8, lado: "b", codigoAnonimo: "NW-DDDDDD", originador: true, statusComissaoOriginador: "a_apurar", conta: { id: 11, nome: "Conta Onze" } }),
  ],
});
const entreMembras = conexao({
  id: "c-membras", origem: "PLATFORM_MATCH", itens: [], motivo: "Conexão sugerida pelo motor de perfis entre dois membros da plataforma.",
  lados: [lado({ id: 3, lado: "a", tipo: "membro", conta: { id: 1, nome: "Membra Um" } }), lado({ id: 4, lado: "b", tipo: "membro", conta: { id: 3, nome: "Membra Três" } })],
});

const responder = (resposta: Resposta) => { duble.resposta = resposta; };
const cartoes = () => screen.getAllByTestId("conexao-registrada");

beforeEach(() => {
  duble.resposta = {};
  duble.entradas = [];
  duble.mutate.mockClear();
  duble.refetch.mockClear();
});

describe("Conexões registradas — a lista", () => {
  it("mostra origem, etapa, comissão e o ID anônimo de cada conexão devolvida pela rota", () => {
    responder({ data: [identificada, fechada, entreMembras] });
    render(<ConexoesRegistradasDaPlataforma />);

    expect(cartoes()).toHaveLength(3);
    const [primeira, segunda, terceira] = cartoes();
    expect(within(primeira).getByText("Dentro de um mesmo network")).toBeInTheDocument();
    expect(within(primeira).getByText("Identificada")).toBeInTheDocument();
    expect(within(primeira).getByText("NW-AAAAAA")).toBeInTheDocument();
    expect(within(segunda).getByText("Negócio fechado")).toBeInTheDocument();
    expect(within(segunda).getByText("Comissão da plataforma: a apurar")).toBeInTheDocument();
    expect(within(terceira).getByText("Entre membros da plataforma")).toBeInTheDocument();
    expect(within(terceira).getAllByText(/Membro da plataforma · conta/)).toHaveLength(2);
    expect(within(terceira).getByText(/entre dois membros da plataforma/)).toBeInTheDocument();
  });

  it("os filtros de origem e etapa vão na consulta", () => {
    responder({ data: [] });
    render(<ConexoesRegistradasDaPlataforma />);
    expect(duble.entradas.at(-1)).toEqual({ origem: undefined, status: undefined });

    fireEvent.change(screen.getByLabelText("Origem"), { target: { value: "PLATFORM_MATCH" } });
    fireEvent.change(screen.getByLabelText("Etapa"), { target: { value: "fechada" } });

    expect(duble.entradas.at(-1)).toEqual({ origem: "PLATFORM_MATCH", status: "fechada" });
    expect(screen.getByText("Nenhuma conexão registrada com estes filtros.")).toBeInTheDocument();
  });

  it("sem conexão nenhuma: o vazio diz isso", () => {
    responder({ data: [] });
    render(<ConexoesRegistradasDaPlataforma />);
    expect(screen.getByText("Nenhuma conexão registrada ainda.")).toBeInTheDocument();
  });

  it("consulta que falhou é erro com 'tentar de novo', nunca 'nenhuma conexão'", () => {
    responder({ isError: true, error: new Error("Banco de dados indisponível") });
    render(<ConexoesRegistradasDaPlataforma />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conexão registrada/)).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button"));
    expect(duble.refetch).toHaveBeenCalled();
  });

  it("carregando não é vazio", () => {
    responder({ isLoading: true });
    render(<ConexoesRegistradasDaPlataforma />);
    expect(screen.getByLabelText("Carregando conexões")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conexão registrada/)).not.toBeInTheDocument();
  });
});

describe("Conexões registradas — a apuração da comissão", () => {
  it("conexão que não fechou não tem botão de comissão", () => {
    responder({ data: [identificada, entreMembras] });
    render(<ConexoesRegistradasDaPlataforma />);

    expect(screen.queryByRole("button", { name: /Comissão devida|Comissão não devida|Voltar para a apurar/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("A comissão só é apurada depois do fechamento do negócio.")).toHaveLength(2);
  });

  it("conexão fechada: a plataforma registra devida/não devida, depois de confirmar", () => {
    responder({ data: [identificada, fechada] });
    render(<ConexoesRegistradasDaPlataforma />);

    const [primeira, segunda] = cartoes();
    expect(within(primeira).queryByRole("button", { name: "Comissão devida" })).not.toBeInTheDocument();
    // Plataforma + as duas originadoras.
    const devidas = within(segunda).getAllByRole("button", { name: "Comissão devida" });
    expect(devidas).toHaveLength(3);
    // Ainda "a apurar": não há o que desfazer.
    expect(within(segunda).queryByRole("button", { name: "Voltar para a apurar" })).not.toBeInTheDocument();

    fireEvent.click(devidas[devidas.length - 1]); // a da plataforma é a última do cartão
    expect(duble.mutate).not.toHaveBeenCalled();
    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText("da plataforma")).toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole("button", { name: "Confirmar" }));

    expect(duble.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutate).toHaveBeenCalledWith({ conexaoId: "c-fechada", status: "devida" });
  });

  it("a comissão da originadora vai com o participante; cancelar não registra nada", () => {
    responder({ data: [fechada] });
    render(<ConexoesRegistradasDaPlataforma />);

    fireEvent.click(screen.getAllByRole("button", { name: "Comissão não devida" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(duble.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Comissão não devida" })[0]);
    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText("da originadora NW-CCCCCC")).toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole("button", { name: "Confirmar" }));
    expect(duble.mutate).toHaveBeenCalledWith({ conexaoId: "c-fechada", status: "nao_devida", participanteId: 7 });
  });
});
