import { fireEvent, render, screen } from "@testing-library/react";
import { Route } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O espaço de equipe (R2) por papel: a dona convida (com a confirmação na
 * primeira vez e o papel escolhido) e vê o convite por link sem nome; a
 * membro escreve tarefas; a leitora só lê, e a membra vê a dona e as ativas,
 * e sai. A tela só esconde: quem recusa é o servidor (integração).
 */
const PASTA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const REUNIAO = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const consulta = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const mutacao = () => ({ mutate: vi.fn(), isPending: false });
const duble = vi.hoisted(() => ({
  equipe: null as unknown,
  tarefas: null as unknown,
  mutacoes: {} as Record<string, { mutate: ReturnType<typeof vi.fn>; isPending: boolean }>,
  navegar: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/", duble.navegar] }));
vi.mock("@/lib/trpc", () => {
  const mut = (nome: string) => ({ useMutation: () => duble.mutacoes[nome] });
  return {
    trpc: {
      useUtils: () => new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: vi.fn(async () => undefined) }) }) }),
      equipes: {
        ver: { useQuery: () => duble.equipe },
        reunioes: { useQuery: () => ({ data: [{ id: REUNIAO, titulo: "Reunião de abertura", criadaEm: 1 }], isLoading: false, isError: false }) },
        tarefas: { useQuery: () => duble.tarefas },
        agenda: { useQuery: () => ({ data: [], isLoading: false, isError: false }) },
        criarConvite: mut("criarConvite"), convidarConexao: mut("convidarConexao"), removerMembra: mut("removerMembra"),
        cancelarConvite: mut("cancelarConvite"), mudarPapel: mut("mudarPapel"), sair: mut("sair"),
        criarTarefa: mut("criarTarefa"), marcarTarefa: mut("marcarTarefa"), apagarTarefa: mut("apagarTarefa"), porNaAgenda: mut("porNaAgenda"),
      },
      connections: { list: { useQuery: () => ({ data: [], isLoading: false }) } },
      agenda: { listar: { useQuery: () => ({ data: { proximas: [], anteriores: [] } }) } },
    },
  };
});
const { default: EquipeDaPasta } = await import("./EquipeDaPasta");

function abrir() {
  window.history.replaceState(null, "", `/equipes/${PASTA}`);
  return render(<Route path="/equipes/:pastaId" component={EquipeDaPasta}/>);
}
const daPasta = { pastaId: PASTA, nome: "Vendas Sul", icone: "pasta", cor: "ambar" };

beforeEach(() => {
  for (const nome of ["criarConvite", "convidarConexao", "removerMembra", "cancelarConvite", "mudarPapel", "sair", "criarTarefa", "marcarTarefa", "apagarTarefa", "porNaAgenda"]) duble.mutacoes[nome] = mutacao();
  duble.navegar.mockReset();
  duble.tarefas = consulta({ podeEscrever: true, tarefas: [{ id: "t1", texto: "Mandar a proposta", responsavel: "Ana", prazo: null, feita: false, feitaEm: null, criadaEm: 1 }] });
});

describe("o espaço de equipe", () => {
  it("dona: o convite pede a confirmação na primeira vez e vai com o papel escolhido; o convite por link não tem nome", () => {
    duble.equipe = consulta({ ...daPasta, papel: "owner", autorizado: false, membras: [
      { id: "m1", status: "invited", origem: "link", papel: "member", nome: null, expiraEm: 1 },
      { id: "m2", status: "active", origem: "connection", papel: "reader", nome: "Bia", expiraEm: null },
    ] });
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Membros" }));
    const convidar = screen.getByRole("button", { name: "Convidar por link" });
    expect(convidar).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("combobox", { name: "Papel de quem entrar" }), { target: { value: "reader" } });
    fireEvent.click(convidar);
    expect(duble.mutacoes.criarConvite.mutate).toHaveBeenCalledWith({ pastaId: PASTA, papel: "reader", autorizacao: expect.objectContaining({ textoExibido: expect.stringContaining("autorizaram") }) });
    expect(screen.getByText("Convite por link (ainda não aceito)")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Papel de Bia" }), { target: { value: "member" } });
    expect(duble.mutacoes.mudarPapel.mutate).toHaveBeenCalledWith({ membraId: "m2", papel: "member" });
  });

  it("dona: a reunião abre o detalhe dela", () => {
    duble.equipe = consulta({ ...daPasta, papel: "owner", autorizado: true, membras: [] });
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /Reunião de abertura/ }));
    expect(duble.navegar).toHaveBeenCalledWith(`/meetings/${REUNIAO}`);
  });

  it("membro: escreve tarefa; a reunião abre a leitura da equipe", () => {
    duble.equipe = consulta({ ...daPasta, papel: "member", nomeDaDona: "Dona Clara", membras: [{ nome: "Ana", papel: "member", souEu: true }] });
    abrir();
    expect(screen.getByText(/Equipe de Dona Clara/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reunião de abertura/ }));
    expect(duble.navegar).toHaveBeenCalledWith(`/equipes/${PASTA}/reunioes/${REUNIAO}`);
    fireEvent.click(screen.getByRole("button", { name: "Tarefas" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nova tarefa" }), { target: { value: "Ligar para o cliente" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    expect(duble.mutacoes.criarTarefa.mutate).toHaveBeenCalledWith({ pastaId: PASTA, texto: "Ligar para o cliente", responsavel: "", prazo: null });
  });

  it("leitora: vê as tarefas sem o formulário nem apagar; vê a dona e as ativas, e sai com confirmação", () => {
    duble.equipe = consulta({ ...daPasta, papel: "reader", nomeDaDona: "Dona Clara", membras: [{ nome: "Ana", papel: "member", souEu: false }, { nome: "Bia", papel: "reader", souEu: true }] });
    duble.tarefas = consulta({ podeEscrever: false, tarefas: [{ id: "t1", texto: "Mandar a proposta", responsavel: null, prazo: null, feita: false, feitaEm: null, criadaEm: 1 }] });
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Tarefas" }));
    expect(screen.queryByRole("textbox", { name: "Nova tarefa" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apagar tarefa" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Feita" })).toBeDisabled();
    expect(screen.getByText("Como leitor, você vê as tarefas sem mudar nada.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Membros" }));
    expect(screen.getByText("Dona Clara")).toBeInTheDocument();
    expect(screen.getByText("Bia (você)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convidar por link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sair da equipe" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Sair da equipe" })[0]);
    expect(duble.mutacoes.sair.mutate).toHaveBeenCalledWith({ pastaId: PASTA });
  });

  it("a equipe que não abre tem uma frase só", () => {
    duble.equipe = { data: undefined, isLoading: false, isError: true, error: { message: "EQUIPE_NAO_ENCONTRADA" }, refetch: vi.fn() };
    abrir();
    expect(screen.getByRole("alert")).toHaveTextContent("Esta equipe não existe ou você não faz parte dela.");
  });
});
