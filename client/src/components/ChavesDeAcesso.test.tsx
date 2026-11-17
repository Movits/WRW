import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CHAVES_POR_CONTA_MAX, ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";

/**
 * A seção das chaves de acesso no Perfil (A7): a dona vê as chaves dos
 * aparelhos dela, troca o nome, remove (com confirmação, e o aparelho é avisado)
 * e ativa a chave deste aparelho. Some sem a função, e a falha da lista é erro,
 * nunca "nenhuma chave". Com CHAVE_REAUTENTICAR, pede a senha ali mesmo.
 */

type Chave = {
  id: string;
  credencialId: string;
  identificadorDaConta: string;
  apelido: string | null;
  tipoDoAparelho: "singleDevice" | "multiDevice";
  sincronizada: boolean;
  transportes: string[];
  aaguid: string | null;
  criadaEm: number;
  ultimoUsoEm: number | null;
};
type OpcoesDaMutacao = { onSuccess?: (...args: unknown[]) => void; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => ({
  estado: { data: { disponivel: true, rpId: "wrwglobal.org" } } as { data?: { disponivel: boolean; rpId?: string } },
  lista: { data: [] as unknown[], isLoading: false, isError: false, error: null as unknown, refetch: vi.fn() },
  invalidar: vi.fn(),
  opcoesDeCadastro: vi.fn(),
  cadastrar: vi.fn(),
  entrarDeNovo: vi.fn(),
  renomear: vi.fn(),
  opcoesDoRenomear: {} as OpcoesDaMutacao,
  remover: vi.fn(),
  podeUsar: vi.fn(() => true),
  autenticadorProprio: vi.fn(async () => true),
  criarNoAparelho: vi.fn(),
  avisarQueValem: vi.fn(async () => undefined),
  marcarConvite: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { email: "ana@exemplo.com" }, loading: false }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ chavesDeAcesso: { listar: { invalidate: duble.invalidar } } }),
    auth: { login: { useMutation: () => ({ mutateAsync: duble.entrarDeNovo, isPending: false }) } },
    chavesDeAcesso: {
      estado: { useQuery: () => duble.estado },
      listar: { useQuery: () => duble.lista },
      opcoesDeCadastro: { useMutation: () => ({ mutateAsync: duble.opcoesDeCadastro }) },
      cadastrar: { useMutation: () => ({ mutateAsync: duble.cadastrar }) },
      renomear: {
        useMutation: (opcoes: OpcoesDaMutacao = {}) => {
          duble.opcoesDoRenomear = opcoes;
          return { mutate: duble.renomear, isPending: false };
        },
      },
      remover: { useMutation: () => ({ mutateAsync: duble.remover, isPending: false }) },
    },
  },
}));
vi.mock("@/lib/chaves-de-acesso", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/chaves-de-acesso")>();
  return {
    ...original,
    podeUsarChavesAqui: duble.podeUsar,
    podeAtivarNesteAparelho: duble.autenticadorProprio,
    cadastrarAChave: duble.criarNoAparelho,
    avisarChavesQueValem: duble.avisarQueValem,
    marcarConviteNoAparelho: duble.marcarConvite,
  };
});

import { ChavesDeAcesso } from "./ChavesDeAcesso";

const chave = (id: string, extra: Partial<Chave> = {}): Chave => ({
  id,
  credencialId: `cred-${id}`,
  identificadorDaConta: "conta-1",
  apelido: `Aparelho ${id}`,
  tipoDoAparelho: "multiDevice",
  sincronizada: false,
  transportes: ["internal"],
  aaguid: null,
  criadaEm: Date.UTC(2026, 10, 10),
  ultimoUsoEm: null,
  ...extra,
});
const erroDoServidor = (codigo: string) => ({ message: codigo, data: { code: "PRECONDITION_FAILED" } });

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR");
  duble.estado = { data: { disponivel: true, rpId: "wrwglobal.org" } };
  duble.lista = { data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() };
  duble.podeUsar.mockReturnValue(true);
  duble.autenticadorProprio.mockResolvedValue(true);
  duble.avisarQueValem.mockResolvedValue(undefined);
  duble.opcoesDeCadastro.mockResolvedValue({ challenge: "d-cadastro" });
  duble.criarNoAparelho.mockResolvedValue({ id: "cred-nova", clientExtensionResults: {} });
  duble.cadastrar.mockResolvedValue({ id: "nova" });
  duble.remover.mockResolvedValue({ success: true });
  duble.entrarDeNovo.mockResolvedValue({ success: true });
});

const titulo = () => screen.queryByRole("heading", { name: "Face ID e digital" });

describe("quando a seção aparece", () => {
  it("some sem a função neste endereço", () => {
    duble.estado = { data: { disponivel: false } };
    render(<ChavesDeAcesso />);
    expect(titulo()).not.toBeInTheDocument();
  });

  it("some na casca das lojas, até a M1", () => {
    duble.podeUsar.mockReturnValue(false);
    render(<ChavesDeAcesso />);
    expect(titulo()).not.toBeInTheDocument();
  });

  it("a falha da lista é erro na tela, nunca \"nenhuma chave\"", () => {
    duble.lista = { data: undefined as unknown as unknown[], isLoading: false, isError: true, error: new Error("x"), refetch: vi.fn() };
    render(<ChavesDeAcesso />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum aparelho entra com Face ID ou digital ainda.")).not.toBeInTheDocument();
  });

  it("sem chave, diz que nenhum aparelho entra assim ainda", () => {
    render(<ChavesDeAcesso />);
    expect(titulo()).toBeInTheDocument();
    expect(screen.getByText("Nenhum aparelho entra com Face ID ou digital ainda.")).toBeInTheDocument();
    expect(screen.getByText(/não recebe a sua biometria/)).toBeInTheDocument();
  });
});

describe("a lista", () => {
  it("mostra o apelido, a chave sem nome, a sincronizada e o uso", () => {
    duble.lista.data = [
      chave("a", { apelido: "iPhone", sincronizada: true, ultimoUsoEm: Date.UTC(2026, 10, 15) }),
      chave("b", { apelido: null }),
    ];
    render(<ChavesDeAcesso />);
    const itens = screen.getAllByRole("listitem");
    expect(within(itens[0]).getByText("iPhone")).toBeInTheDocument();
    expect(within(itens[0]).getByText("Sincronizada")).toBeInTheDocument();
    expect(within(itens[0]).getByText(/último uso em/)).toBeInTheDocument();
    expect(within(itens[1]).getByText("Chave sem nome")).toBeInTheDocument();
    expect(within(itens[1]).getByText(/ainda não usada/)).toBeInTheDocument();
  });

  it("renomeia com o nome aparado", () => {
    duble.lista.data = [chave("a")];
    render(<ChavesDeAcesso />);
    fireEvent.click(screen.getByRole("button", { name: /Renomear/ }));
    const campo = screen.getByLabelText("Nome da chave");
    fireEvent.change(campo, { target: { value: "  Notebook  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.renomear).toHaveBeenCalledWith({ id: "a", apelido: "Notebook" });
    act(() => duble.opcoesDoRenomear.onSuccess?.());
    expect(toast.success).toHaveBeenCalledWith("Nome salvo.");
    expect(duble.invalidar).toHaveBeenCalled();
  });

  it("remover pede confirmação, com o foco em Manter", () => {
    duble.lista.data = [chave("a")];
    render(<ChavesDeAcesso />);
    fireEvent.click(screen.getByRole("button", { name: /Remover/ }));
    expect(screen.getByText(/Remover esta chave\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manter" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(duble.remover).not.toHaveBeenCalled();
    expect(screen.queryByText(/Remover esta chave\?/)).not.toBeInTheDocument();
  });

  it("remove, avisa e diz ao aparelho quais chaves ainda valem", async () => {
    duble.lista.data = [chave("a"), chave("b")];
    render(<ChavesDeAcesso />);
    fireEvent.click(screen.getAllByRole("button", { name: /Remover/ })[0]);
    const confirmacao = screen.getByText(/Remover esta chave\?/).parentElement as HTMLElement;
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(duble.remover).toHaveBeenCalledWith({ id: "a" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Chave removida."));
    expect(duble.avisarQueValem).toHaveBeenCalledWith("wrwglobal.org", "conta-1", ["cred-b"]);
    expect(duble.invalidar).toHaveBeenCalled();
  });
});

describe("ativar neste aparelho", () => {
  it("o botão só aparece com autenticador próprio", async () => {
    duble.autenticadorProprio.mockResolvedValue(false);
    render(<ChavesDeAcesso />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Ativar neste aparelho/ })).not.toBeInTheDocument();
  });

  it("cadastra a chave, marca o aparelho e atualiza a lista", async () => {
    render(<ChavesDeAcesso />);
    fireEvent.click(await screen.findByRole("button", { name: /Ativar neste aparelho/ }));
    await waitFor(() => expect(duble.cadastrar).toHaveBeenCalledWith(expect.objectContaining({ resposta: { id: "cred-nova", clientExtensionResults: {} } })));
    expect(duble.marcarConvite).toHaveBeenCalledWith("ativada");
    expect(toast.success).toHaveBeenCalledWith(i18n.t("chavesDeAcesso.toast.activated"));
    expect(duble.invalidar).toHaveBeenCalled();
  });

  it("com CHAVE_REAUTENTICAR, pede a senha, entra de novo e repete o cadastro", async () => {
    duble.opcoesDeCadastro
      .mockRejectedValueOnce(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.reautenticar))
      .mockResolvedValue({ challenge: "d-cadastro-2" });
    render(<ChavesDeAcesso />);
    fireEvent.click(await screen.findByRole("button", { name: /Ativar neste aparelho/ }));
    const senha = await screen.findByLabelText("Senha");
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.change(senha, { target: { value: "segredo123" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e ativar" }));
    await waitFor(() => expect(duble.entrarDeNovo).toHaveBeenCalledWith({ email: "ana@exemplo.com", password: "segredo123" }));
    await waitFor(() => expect(duble.criarNoAparelho).toHaveBeenCalledWith({ challenge: "d-cadastro-2" }));
    await waitFor(() => expect(duble.cadastrar).toHaveBeenCalled());
    expect(screen.queryByLabelText("Senha")).not.toBeInTheDocument();
  });

  it("senha errada avisa e não tenta cadastrar", async () => {
    duble.opcoesDeCadastro.mockRejectedValueOnce(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.reautenticar));
    duble.entrarDeNovo.mockRejectedValue({ message: "E-mail ou senha incorretos", data: { code: "UNAUTHORIZED" } });
    render(<ChavesDeAcesso />);
    fireEvent.click(await screen.findByRole("button", { name: /Ativar neste aparelho/ }));
    fireEvent.change(await screen.findByLabelText("Senha"), { target: { value: "errada" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e ativar" }));
    // A frase do servidor (em português) não vai para a tela.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível confirmar a senha."));
    expect(duble.opcoesDeCadastro).toHaveBeenCalledTimes(1);
  });

  it("fechar o pedido do aparelho não mostra erro", async () => {
    duble.criarNoAparelho.mockRejectedValue(Object.assign(new Error("fechou"), { name: "NotAllowedError" }));
    render(<ChavesDeAcesso />);
    fireEvent.click(await screen.findByRole("button", { name: /Ativar neste aparelho/ }));
    await waitFor(() => expect(duble.criarNoAparelho).toHaveBeenCalled());
    await act(async () => {});
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("no limite de chaves, o botão fica desligado e explica", async () => {
    duble.lista.data = Array.from({ length: CHAVES_POR_CONTA_MAX }, (_, i) => chave(String(i)));
    render(<ChavesDeAcesso />);
    expect(await screen.findByRole("button", { name: /Ativar neste aparelho/ })).toBeDisabled();
    expect(screen.getByText(`Esta conta chegou ao limite de ${CHAVES_POR_CONTA_MAX} chaves. Remova uma para ativar outro aparelho.`)).toBeInTheDocument();
  });
});
