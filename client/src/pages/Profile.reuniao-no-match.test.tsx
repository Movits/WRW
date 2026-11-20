import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

/**
 * O Perfil na N5: "O que tenho" passa a mostrar os itens escritos (o
 * "Outros" do cadastro e o que a dona confirmou das reuniões), cada um com o
 * X na edição, e o bloco "Sugestões das suas reuniões" lista o que espera a
 * confirmação dela, com a reunião de onde veio. Sem nada esperando, o bloco
 * não aparece; erro de consulta é erro, nunca "nada esperando".
 */

const duble = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  salvos: [] as unknown[],
  sugestoes: { data: [] as unknown[] | undefined, isError: false, error: null as unknown, refetch: () => undefined },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    networkInteligente: {
      pendenciasDoPerfil: { useQuery: () => duble.sugestoes },
      confirmarPendencia: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      ignorarPendencia: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    profile: {
      get: { useQuery: () => ({ data: { user: { name: "Ana" }, profile: duble.perfil }, isLoading: false }) },
      update: { useMutation: () => ({ mutate: (vars: unknown) => { duble.salvos.push(vars); }, isPending: false }) },
    },
    assistenteTexto: {
      revisar: { useMutation: () => ({ mutateAsync: async () => ({ revisado: "", mudou: false }), isPending: false }) },
      transcrever: { useMutation: () => ({ mutateAsync: async () => ({ texto: "" }), isPending: false }) },
    },
    useUtils: () => ({ profile: { get: { invalidate: vi.fn() } }, auth: { me: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { name: "Ana", email: "ana@exemplo.com", role: "silver" } }) }));
vi.mock("@/components/ExcluirMinhaConta", () => ({ ExcluirMinhaConta: () => null }));
vi.mock("@/components/ConexaoGoogleAgenda", () => ({ ConexaoGoogleAgenda: () => null }));
vi.mock("@/components/ChavesDeAcesso", () => ({ ChavesDeAcesso: () => null }));
vi.mock("@/components/QualificacaoDoPerfil", () => ({ QualificacaoDoPerfil: () => null }));
vi.mock("wouter", () => ({ Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

const salvar = () => fireEvent.click(screen.getAllByRole("button", { name: /Salvar/ })[0]);

beforeEach(() => {
  duble.salvos.length = 0;
  duble.sugestoes = { data: [], isError: false, error: null, refetch: () => undefined };
  duble.perfil = { displayName: "Ana", country: "BR", whatIHave: ["industria", "Exportação de café", "Torrefação especial"], whatINeed: [], whatINeedDetails: [] };
});

describe("Perfil — o que a reunião leva ao perfil (N5)", () => {
  it("a leitura mostra os itens escritos em 'O que tenho', ao lado das opções fixas", () => {
    render(<Profile />);
    expect(screen.getByText("Indústria")).toBeInTheDocument();
    expect(screen.getByText("Outros itens")).toBeInTheDocument();
    expect(screen.getByText("Exportação de café")).toBeInTheDocument();
    expect(screen.getByText("Torrefação especial")).toBeInTheDocument();
    // Na leitura não há X: tirar é na edição.
    expect(screen.queryByRole("button", { name: /Tirar/ })).not.toBeInTheDocument();
  });

  it("na edição, cada item escrito tem o X, que o tira da lista salva; as opções fixas ficam", () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tirar “Exportação de café”" }));
    expect(screen.queryByText("Exportação de café")).not.toBeInTheDocument();
    salvar();
    expect(duble.salvos).toHaveLength(1);
    expect((duble.salvos[0] as { whatIHave: string[] }).whatIHave).toEqual(["industria", "Torrefação especial"]);
  });

  it("'Sugestões das suas reuniões' lista o que espera a dona, com a reunião de onde veio; sem nada, o bloco não aparece", () => {
    const { unmount } = render(<Profile />);
    expect(screen.queryByRole("region", { name: /Sugestões das suas reuniões/ })).not.toBeInTheDocument();
    unmount();

    duble.sugestoes = {
      data: [{ id: "p1", campo: "preciso", valor: "Distribuidor no Chile", trecho: "preciso de um distribuidor no Chile", confianca: 0.9, criadaEm: 1, reuniao: { id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", titulo: "Rodada do café", em: Date.UTC(2026, 10, 11) } }],
      isError: false, error: null, refetch: () => undefined,
    };
    render(<Profile />);
    const bloco = screen.getByRole("region", { name: /Sugestões das suas reuniões/ });
    expect(within(bloco).getByText("Distribuidor no Chile")).toBeInTheDocument();
    expect(within(bloco).getByRole("link", { name: /Da reunião “Rodada do café”/ })).toHaveAttribute("href", "/meetings/8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(within(bloco).getByRole("combobox", { name: "Categoria" })).toHaveValue("outra_necessidade");
  });

  it("a consulta que falha é erro com tentar de novo, nunca 'nada esperando'", () => {
    duble.sugestoes = { data: undefined, isError: true, error: { message: "Banco de dados indisponível.", data: { code: "INTERNAL_SERVER_ERROR" } }, refetch: () => undefined };
    render(<Profile />);
    expect(screen.getByRole("button", { name: "↻ Tentar novamente" })).toBeInTheDocument();
  });
});
