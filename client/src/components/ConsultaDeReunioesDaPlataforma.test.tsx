import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECUSAS_DA_CONSULTA } from "@shared/consulta-da-administracao";
import { ConsultaDeReunioesDaPlataforma } from "./ConsultaDeReunioesDaPlataforma";

/**
 * Painel Ouro, aba "Reuniões" (R1a). O que se trava:
 * 1. A lista mostra o que `consultaDeReunioes.listar` devolve; a reunião
 *    anterior ao aviso não tem "Consultar".
 * 2. Abrir pede o motivo (categoria e texto de 10 caracteres ou mais) ANTES:
 *    sem ele, o botão fica desligado e nada vai ao servidor.
 * 3. A reunião aberta só se lê: nenhum controle da dona.
 * 4. A recusa do servidor vira frase; a lista que falhou é erro, não "nenhuma".
 */

const duble = vi.hoisted(() => ({
  lista: {} as Record<string, unknown>,
  entradas: [] as unknown[],
  mutate: vi.fn(),
  abrir: {} as Record<string, unknown>,
  aoAbrir: undefined as undefined | ((dado: unknown) => void),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    consultaDeReunioes: {
      listar: {
        useQuery: (entrada: unknown) => {
          duble.entradas.push(entrada);
          return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...duble.lista };
        },
      },
      abrir: {
        useMutation: (opcoes: { onSuccess: (dado: unknown) => void }) => {
          duble.aoAbrir = opcoes.onSuccess;
          return { mutate: duble.mutate, isPending: false, error: null, ...duble.abrir };
        },
      },
    },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const reuniao = (extra: Record<string, unknown> = {}) => ({
  id: ID, titulo: "Reunião de março", criadaEm: Date.UTC(2026, 10, 24, 12), status: "ready", origem: "gravacao",
  dona: "Ana Dona", linkLigado: false, podeConsultar: true, ...extra,
});
const ABERTA = {
  titulo: "Reunião de março", criadaEm: Date.UTC(2026, 10, 24, 12), idioma: "pt-BR", status: "ready", origem: "gravacao", dona: "Ana Dona",
  transcricao: { texto: "Oi", idioma: "pt-BR", editada: false, segmentos: [{ inicio: 0, fim: 2, falante: "F1", texto: "Bom dia a todas." }, { inicio: 2, fim: 4, falante: "F2", texto: "Vamos começar." }] },
  resumo: { estado: "pronto", emoji: null, idioma: "pt-BR", versaoAnterior: false, itens: [{ section: "decision", subject: null, text: "{F1} decidiu fechar o contrato.", assignee: null, due: null, excerpt: null, startSeconds: 0, status: "confirmed", escritoPelaDona: false, complemento: null }] },
  vozes: { F1: "Ana" },
  gravacao: { mimeType: "audio/mp4", durationSeconds: 4, expiresAt: 9e15, partes: [{ seq: 0, url: `/consulta-da-administracao/${ID}/audio`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 4 }] },
  gravacaoExpirada: false, gravacaoSaindo: false, passeDoAudioAte: Date.now() + 3_600_000,
};

beforeEach(() => {
  duble.lista = {};
  duble.entradas = [];
  duble.abrir = {};
  duble.mutate.mockReset();
});

describe("Reuniões — a lista", () => {
  it("mostra as reuniões; a gravada antes do aviso não tem Consultar", () => {
    duble.lista = { data: { reunioes: [reuniao(), reuniao({ id: "b", titulo: "Antiga", podeConsultar: false })], proxima: null } };
    render(<ConsultaDeReunioesDaPlataforma />);
    expect(screen.getByText("Reunião de março")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Consultar/ })).toHaveLength(1);
    expect(screen.getByText("Gravada antes do aviso")).toBeInTheDocument();
  });

  it("a busca e o filtro vão como entrada da consulta (o filtro é do servidor)", () => {
    duble.lista = { data: { reunioes: [], proxima: null } };
    render(<ConsultaDeReunioesDaPlataforma />);
    fireEvent.change(screen.getByLabelText("Buscar reuniões"), { target: { value: " ana " } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    fireEvent.click(screen.getByLabelText("Só com link aberto"));
    expect(duble.entradas.at(-1)).toEqual({ busca: "ana", comLinkAberto: true, antes: undefined });
  });

  it("a lista que falhou é erro, não 'nenhuma reunião'", () => {
    duble.lista = { isError: true, error: new Error("falhou") };
    render(<ConsultaDeReunioesDaPlataforma />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma reunião encontrada.")).not.toBeInTheDocument();
  });
});

describe("Reuniões — o motivo antes da leitura", () => {
  function abrirModal() {
    duble.lista = { data: { reunioes: [reuniao()], proxima: null } };
    render(<ConsultaDeReunioesDaPlataforma />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar/ }));
  }

  it("o modal avisa do registro; sem categoria ou com texto curto, o botão fica desligado e nada vai ao servidor", () => {
    abrirModal();
    expect(screen.getByText(/fica registrada com o seu nome, a data e o motivo/)).toBeInTheDocument();
    const registrar = screen.getByRole("button", { name: "Registrar e abrir" });
    expect(registrar).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Por que esta reunião/), { target: { value: "curto" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "seguranca" } });
    expect(registrar).toBeDisabled();
    fireEvent.click(registrar);
    expect(duble.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Por que esta reunião/), { target: { value: "Relato de ameaça feito pela usuária." } });
    expect(registrar).toBeDisabled();
  });

  it("com o motivo, manda a categoria e o texto aparado, e abre a reunião só para ler", () => {
    abrirModal();
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "ordem_judicial" } });
    fireEvent.change(screen.getByLabelText(/Por que esta reunião/), { target: { value: "  Ofício 123/2026 da 2ª Vara.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar e abrir" }));
    expect(duble.mutate).toHaveBeenCalledWith({ meetingId: ID, motivo: "ordem_judicial", complemento: "Ofício 123/2026 da 2ª Vara." });
  });

  it("a recusa da reunião anterior ao aviso vira frase", () => {
    duble.abrir = { error: { message: RECUSAS_DA_CONSULTA.anteriorAoAviso } };
    abrirModal();
    expect(screen.getByRole("alert")).toHaveTextContent("gravada antes do aviso");
  });
});

describe("Reuniões — a reunião aberta", () => {
  it("mostra o resumo e a transcrição com os nomes das vozes e o áudio pela rota da consulta, sem os controles da dona", async () => {
    duble.lista = { data: { reunioes: [reuniao()], proxima: null } };
    const { container } = render(<ConsultaDeReunioesDaPlataforma />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar/ }));
    const { act } = await import("react");
    act(() => duble.aoAbrir!(ABERTA));
    expect(screen.getByText("Ana decidiu fechar o contrato.")).toBeInTheDocument();
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(`/consulta-da-administracao/${ID}/audio`);
    fireEvent.click(screen.getByRole("tab", { name: "Transcrição" }));
    expect(screen.getByText("Ana:")).toBeInTheDocument();
    expect(screen.getByText("Falante 2:")).toBeInTheDocument();
    for (const controle of [/excluir/i, /reprocessar/i, /compartilhar/i, /confirmar/i, /ignorar/i, /nomear/i, /juntar/i, /lixeira/i]) {
      expect(screen.queryByRole("button", { name: controle })).not.toBeInTheDocument();
    }
    // Voltar à lista: abrir de novo pede o motivo de novo.
    fireEvent.click(screen.getByRole("button", { name: /Voltar à lista/ }));
    fireEvent.click(screen.getByRole("button", { name: /Consultar/ }));
    expect(screen.getByRole("button", { name: "Registrar e abrir" })).toBeDisabled();
  });
});
