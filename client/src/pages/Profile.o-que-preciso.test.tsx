import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";

/**
 * "O que preciso" no Perfil (Rosber, 14/09): a leitura mostra as demandas
 * detalhadas e a chave antiga ("consultoria"); a edição usa os mesmos cartões e
 * a mesma segunda camada do Onboarding; categoria marcada NESTA edição sem
 * demanda detalhada não salva; a categoria antiga sem detalhe não trava o
 * salvar da bio.
 */

const duble = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  salvos: [] as unknown[],
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    // N5: o bloco "Sugestões das suas reuniões" (sem nada esperando, não aparece).
    networkInteligente: { pendenciasDoPerfil: { useQuery: () => ({ data: [], isError: false, error: null, refetch: () => undefined }) } },
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
// A seção da Google Agenda (H16b) tem o teste dela (ConexaoGoogleAgenda.test.tsx).
vi.mock("@/components/ConexaoGoogleAgenda", () => ({ ConexaoGoogleAgenda: () => null }));
vi.mock("@/components/PerfilDeVoz", () => ({ PerfilDeVoz: () => null }));
vi.mock("@/components/ChavesDeAcesso", () => ({ ChavesDeAcesso: () => null }));
vi.mock("@/components/ContaGoogleNoPerfil", () => ({ ContaGoogleNoPerfil: () => null }));
vi.mock("@/components/QualificacaoDoPerfil", () => ({ QualificacaoDoPerfil: () => null }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

const cartao = (titulo: string) => screen.getAllByRole("button").find(b => b.hasAttribute("aria-expanded") && b.textContent?.includes(titulo))!;
const salvar = () => fireEvent.click(screen.getAllByRole("button", { name: /Salvar/ })[0]);

beforeEach(() => {
  duble.salvos.length = 0;
  vi.mocked(toast.error).mockClear();
  duble.perfil = {
    displayName: "Ana", country: "BR", whatIHave: [],
    whatINeed: ["consultoria", "fornecedores", "distribuidores"],
    whatINeedDetails: [{ id: "d1", category: "distribuidores", region: "África Oriental", description: "Busco parceiro para distribuir medicamentos na África Oriental" }],
  };
});

describe("Perfil — O que preciso", () => {
  it("a leitura mostra a demanda detalhada e a categoria antiga pelo rótulo", () => {
    render(<Profile />);
    expect(screen.getByText("Busco parceiro para distribuir medicamentos na África Oriental")).toBeInTheDocument();
    expect(screen.getByText("Distribuidores / Representantes")).toBeInTheDocument();
    expect(screen.getByText("Consultoria")).toBeInTheDocument();
    expect(screen.getByText("Fornecedores / Fabricantes")).toBeInTheDocument();
  });

  it("editar e salvar sem mexer: categorias antigas sem detalhe não travam, e as demandas vão junto", () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    expect(cartao("Fornecedores / Fabricantes")).toHaveAttribute("aria-pressed", "true");
    salvar();
    expect(toast.error).not.toHaveBeenCalled();
    expect(duble.salvos).toHaveLength(1);
    expect(duble.salvos[0]).toMatchObject({
      whatINeed: ["consultoria", "fornecedores", "distribuidores"],
      whatINeedDetails: [{ id: "d1", category: "distribuidores", region: "África Oriental", description: "Busco parceiro para distribuir medicamentos na África Oriental" }],
    });
  });

  it("categoria marcada nesta edição sem demanda detalhada não salva", () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    fireEvent.click(cartao("Talentos / Equipe"));
    salvar();
    expect(duble.salvos).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith("Para continuar, detalhe: Talentos / Equipe.");

    fireEvent.change(screen.getByLabelText(/^Descrição/), { target: { value: "Diretora comercial com experiência em exportação" } });
    salvar();
    expect(duble.salvos).toHaveLength(1);
    expect((duble.salvos[0] as { whatINeedDetails: unknown[] }).whatINeedDetails).toEqual([
      expect.objectContaining({ category: "distribuidores" }),
      expect.objectContaining({ category: "talentos_equipe", description: "Diretora comercial com experiência em exportação" }),
    ]);
  });
});
