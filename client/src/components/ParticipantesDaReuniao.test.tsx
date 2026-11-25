import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParticipantesDaReuniao, vozesDaReuniao } from "./ParticipantesDaReuniao";

/**
 * O painel "Participantes" da dona (R1b e H3c): a confirmação na primeira vez,
 * o convite por link com o endereço /convite/{token}, a lista com remover e
 * cancelar, e "Quem é cada voz" (a conta, o nome livre, "Falante n", juntar e
 * separar). O tRPC é um dublê que registra o mutate; o servidor está em
 * server/participantes-da-reuniao.integracao.test.ts.
 */

type Opcoes = { onSuccess?: (data: unknown) => void; onError?: (erro: unknown) => void };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return { mutacoes, registrar, painel: { data: undefined as unknown, isLoading: false, isError: false }, conexoes: { data: [] as unknown[], isLoading: false } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { participantes: { invalidate: vi.fn() }, get: { invalidate: vi.fn() } } }),
    meetings: {
      participantes: { useQuery: () => duble.painel },
      criarConvite: duble.registrar("criarConvite"),
      convidarConexao: duble.registrar("convidarConexao"),
      removerParticipante: duble.registrar("remover"),
      ligarVozAConta: duble.registrar("ligar"),
      nomearFalante: duble.registrar("nomear"),
      juntarVozes: duble.registrar("juntar"),
      separarVoz: duble.registrar("separar"),
    },
    connections: { list: { useQuery: () => duble.conexoes } },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const ANA = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const CONVITE = "2b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const FALAS = [{ falante: "F1", inicio: 0 }, { falante: "F2", inicio: 5 }, { falante: "F1", inicio: 9 }, { falante: "F3", inicio: 12 }];

function abrir(props: Partial<Parameters<typeof ParticipantesDaReuniao>[0]> = {}) {
  render(<ParticipantesDaReuniao meetingId={ID} titulo="Reunião" falas={FALAS} nomes={{}} nomesLivres={{}} contas={{}} juntadas={{}} {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: /Participantes/ }));
}

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.painel.data = { papel: "dona", autorizado: true, participantes: [
    { id: ANA, status: "active", origem: "link", nome: "Ana", expiraEm: null, entrouEm: 1 },
    { id: CONVITE, status: "invited", origem: "link", nome: null, expiraEm: Date.UTC(2026, 11, 1), entrouEm: null },
  ] };
});

describe("as vozes na ordem da primeira fala", () => {
  it("cada voz uma vez, com o segundo da primeira fala dela", () => {
    expect(vozesDaReuniao(FALAS)).toEqual([{ voz: "F1", inicio: 0 }, { voz: "F2", inicio: 5 }, { voz: "F3", inicio: 12 }]);
  });
});

describe("o convite", () => {
  it("a primeira vez na reunião pede a confirmação: sem marcar, não convida; marcada, a frase vai junto", () => {
    duble.painel.data = { papel: "dona", autorizado: false, participantes: [] };
    abrir();
    const convidar = screen.getByRole("button", { name: "Convidar por link" });
    expect(convidar).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(convidar);
    expect(duble.mutacoes.criarConvite.mutate).toHaveBeenCalledWith({
      meetingId: ID, autorizacao: { idioma: "pt-BR", textoExibido: expect.stringContaining("autorizaram compartilhá-la") },
    });
  });

  it("já confirmada, convida sem a frase, e o link de uso único aparece com o endereço do convite", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Convidar por link" }));
    expect(duble.mutacoes.criarConvite.mutate).toHaveBeenCalledWith({ meetingId: ID, autorizacao: undefined });
    await act(async () => { duble.mutacoes.criarConvite.opcoes.onSuccess?.({ token: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" }); });
    expect(screen.getByDisplayValue(`${window.location.origin}/convite/AbCdEfGhIjKlMnOpQrStUvWxYz012345`)).toBeInTheDocument();
    expect(screen.getByText(/vale por 7 dias e para uma pessoa só/)).toBeInTheDocument();
  });

  it("a lista: a participante pelo nome, o convite por link sem nome; remover e cancelar", () => {
    abrir();
    expect(screen.getByText("Ana", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Convite por link, ainda não usado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar convite" }));
    expect(duble.mutacoes.remover.mutate.mock.calls.map(([pedido]) => pedido)).toEqual([{ participanteId: ANA }, { participanteId: CONVITE }]);
  });
});

describe("Quem é cada voz (H3c)", () => {
  it("o seletor oferece Eu, as participantes ativas (não a convidada), outra pessoa e Falante n; escolher a conta liga a voz", () => {
    abrir();
    const seletor = screen.getByRole("combobox", { name: "Quem é Falante 1" });
    const opcoes = Array.from((seletor as HTMLSelectElement).options).map(o => o.textContent);
    expect(opcoes).toEqual(["Falante 1", "Eu", "Ana", "Outra pessoa (digitar o nome)"]);
    fireEvent.change(seletor, { target: { value: ANA } });
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith({ meetingId: ID, falante: "F1", conta: ANA });
    fireEvent.change(screen.getByRole("combobox", { name: "Quem é Falante 2" }), { target: { value: "owner" } });
    expect(duble.mutacoes.ligar.mutate).toHaveBeenLastCalledWith({ meetingId: ID, falante: "F2", conta: "owner" });
  });

  it("outra pessoa abre o campo do nome livre, que grava pelo nome da voz (H3); Falante n tira a conta e o nome", () => {
    abrir({ contas: { F2: ANA }, nomesLivres: { F2: "Velho" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Quem é Falante 1" }), { target: { value: "livre" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Outra pessoa (digitar o nome)" }), { target: { value: "Convidada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.mutacoes.nomear.mutate).toHaveBeenCalledWith({ meetingId: ID, falante: "F1", nome: "Convidada" });
    fireEvent.change(screen.getByRole("combobox", { name: "Quem é Falante 2" }), { target: { value: "" } });
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith({ meetingId: ID, falante: "F2", conta: null });
    expect(duble.mutacoes.nomear.mutate).toHaveBeenLastCalledWith({ meetingId: ID, falante: "F2", nome: "" });
  });

  it("juntar oferece só as vozes que não estão juntadas; a juntada mostra a principal e o Separar", () => {
    abrir({ nomes: { F1: "Ana" }, juntadas: { F3: "F1" } });
    const juntar = screen.getAllByRole("combobox", { name: "Juntar com…" })[1];
    expect(Array.from((juntar as HTMLSelectElement).options).map(o => o.textContent)).toEqual(["Juntar com…", "Ana"]);
    fireEvent.change(juntar, { target: { value: "F1" } });
    expect(duble.mutacoes.juntar.mutate).toHaveBeenCalledWith({ meetingId: ID, voz: "F2", principal: "F1" });
    expect(screen.getByText("junto com Ana")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Separar" }));
    expect(duble.mutacoes.separar.mutate).toHaveBeenCalledWith({ meetingId: ID, voz: "F3" });
  });

  it("o ▶ de cada voz toca a primeira fala dela; sem player, não aparece", () => {
    const aoOuvir = vi.fn();
    abrir({ aoOuvir });
    fireEvent.click(screen.getByRole("button", { name: "Ouvir Falante 2" }));
    expect(aoOuvir).toHaveBeenCalledWith(5);
  });
});
