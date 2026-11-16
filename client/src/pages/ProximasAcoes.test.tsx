import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import PaginaDasProximasAcoes from "./ProximasAcoes";

/**
 * A página /proximas-acoes (H5a): o filtro Abertas/Todas, os estados da
 * consulta (erro é erro, nunca lista vazia) e o "Nova ação". A lista em si é o
 * componente ProximasAcoes, testado ao lado dele.
 */

type Opcoes = { onError?: (erro: unknown) => void; onSettled?: () => unknown; onSuccess?: () => void };
const duble = vi.hoisted(() => {
  const chamadas: Record<string, unknown[][]> = {};
  const registrar = (nome: string) => ({
    useMutation: (_opcoes: Opcoes = {}) => ({ mutate: (...args: unknown[]) => { (chamadas[nome] ??= []).push(args); }, isPending: false }),
  });
  const respostas: { listar?: { data?: unknown; isError?: boolean; error?: unknown } } = {};
  const entradas: unknown[] = [];
  return {
    chamadas, registrar, respostas, entradas,
    trpc: {
      useUtils: () => ({
        proximasAcoes: { invalidate: () => Promise.resolve() }, meetings: { resumoGuardado: { invalidate: () => Promise.resolve() } },
        networkInteligente: { contato: { invalidate: () => Promise.resolve() } },
      }),
      proximasAcoes: {
        listar: { useQuery: (entrada: unknown) => { entradas.push(entrada); return { data: undefined, isError: false, error: null, refetch: () => undefined, ...(respostas.listar ?? {}) }; } },
        criar: registrar("criar"),
        marcarFeita: registrar("marcarFeita"),
        ligarContato: registrar("ligarContato"),
        editar: registrar("editar"),
        apagar: registrar("apagar"),
      },
      network: { list: { useQuery: () => ({ data: undefined, isError: false, error: null, refetch: () => undefined }) } },
    },
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));

const ACAO = {
  id: "acao-1", texto: "Mandar o contrato", detalhe: null, responsavel: null, prazo: null, prazoDito: null, origem: "manual",
  feita: false, feitaEm: null, trecho: null, createdAt: 1, reuniao: null, vozes: {}, contato: null, contatoSugerido: null,
};

beforeEach(() => {
  delete duble.respostas.listar;
  duble.entradas.length = 0;
  for (const chave of Object.keys(duble.chamadas)) delete duble.chamadas[chave];
});

describe("a página das próximas ações", () => {
  it("abre nas abertas, e 'Todas' troca o filtro da consulta", () => {
    duble.respostas.listar = { data: { acoes: [ACAO], abertas: 3, limite: 300 } };
    render(<PaginaDasProximasAcoes/>);
    expect(screen.getByRole("heading", { level: 1, name: "Próximas ações" })).toBeInTheDocument();
    expect(duble.entradas.at(-1)).toEqual({ filtro: "abertas" });
    expect(screen.getByRole("button", { name: "Abertas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Abertas: 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(duble.entradas.at(-1)).toEqual({ filtro: "todas" });
    expect(screen.getByRole("button", { name: "Todas" })).toHaveAttribute("aria-pressed", "true");
  });

  it("erro de consulta é erro, nunca 'nenhuma ação'", () => {
    duble.respostas.listar = { isError: true, error: { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } } };
    render(<PaginaDasProximasAcoes/>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma ação aberta|Nenhuma próxima ação/)).not.toBeInTheDocument();
  });

  it("carregando; vazio nas abertas explica de onde as ações vêm; vazio em todas diz só que não há", () => {
    const { rerender } = render(<PaginaDasProximasAcoes/>);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando as próximas ações…");
    duble.respostas.listar = { data: { acoes: [], abertas: 0, limite: 300 } };
    rerender(<PaginaDasProximasAcoes/>);
    expect(screen.getByText(/Quando você confirmar uma ação ou tarefa no resumo de uma reunião/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(screen.getByText("Nenhuma próxima ação ainda.")).toBeInTheDocument();
  });

  it("'Nova ação' anota à mão: o texto é obrigatório e o resto vai como a dona deixou", () => {
    duble.respostas.listar = { data: { acoes: [], abertas: 0, limite: 300 } };
    render(<PaginaDasProximasAcoes/>);
    fireEvent.click(screen.getByRole("button", { name: "Nova ação" }));
    const salvar = screen.getByRole("button", { name: "Salvar" });
    expect(salvar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("O que fazer"), { target: { value: "Ligar para a Bia" } });
    fireEvent.change(screen.getByLabelText("Prazo (opcional)"), { target: { value: "2026-12-01" } });
    fireEvent.click(salvar);
    expect(duble.chamadas.criar?.[0]?.[0]).toEqual({ texto: "Ligar para a Bia", detalhe: "", responsavel: "", prazo: "2026-12-01" });
  });

  it("no teto da lista, avisa que mostra só as primeiras", () => {
    duble.respostas.listar = { data: { acoes: [ACAO, { ...ACAO, id: "acao-2", texto: "Outra" }], abertas: 2, limite: 2 } };
    render(<PaginaDasProximasAcoes/>);
    expect(screen.getByText("Mostrando as primeiras 2.")).toBeInTheDocument();
  });
});
