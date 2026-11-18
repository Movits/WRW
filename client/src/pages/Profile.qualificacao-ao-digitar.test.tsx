import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * A régua da qualificação lê a apresentação que está SENDO digitada.
 *
 * O cartão de governança fica ao lado da caixa "Sobre você" e diz quantas
 * palavras de conteúdo faltam. Ele recebia o perfil SALVO, então enquanto a
 * pessoa reescrevia o texto — justamente para sair da recusa — o número ficava
 * parado, contando o texto antigo. É a nota menor do item 8 da validação de
 * 16/09 na #135: o número errado colado na caixa piora o defeito que o item
 * condena ("recusa sem explicar").
 */

const duble = vi.hoisted(() => ({ perfil: null as Record<string, unknown> | null }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    // N5: o bloco "Sugestões das suas reuniões" (sem nada esperando, não aparece).
    networkInteligente: { pendenciasDoPerfil: { useQuery: () => ({ data: [], isError: false, error: null, refetch: () => undefined }) } },
    profile: {
      get: { useQuery: () => ({ data: { user: { name: "Ana" }, profile: duble.perfil }, isLoading: false }) },
      update: { useMutation: () => ({ mutate: () => {}, isPending: false }) },
    },
    assistenteTexto: {
      revisar: { useMutation: () => ({ mutateAsync: async () => ({ revisado: "", mudou: false }), isPending: false }) },
      transcrever: { useMutation: () => ({ mutateAsync: async () => ({ texto: "" }), isPending: false }) },
    },
    useUtils: () => ({ profile: { get: { invalidate: vi.fn() } }, auth: { me: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { name: "Ana", email: "ana@exemplo.com", role: "bronze" } }) }));
vi.mock("@/components/ExcluirMinhaConta", () => ({ ExcluirMinhaConta: () => null }));
// A seção da Google Agenda (H16b) tem o teste dela (ConexaoGoogleAgenda.test.tsx).
vi.mock("@/components/ConexaoGoogleAgenda", () => ({ ConexaoGoogleAgenda: () => null }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

const editar = () => fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
const caixaDaApresentacao = () => screen.getByPlaceholderText(/Conte um pouco da sua história/);
const linhaDaApresentacao = () => screen.queryByText(/Apresentação:/);

beforeEach(() => {
  duble.perfil = {
    displayName: "Ana Souza",
    city: "Porto Alegre",
    country: "BR",
    activityArea: "Comércio exterior",
    whatIHave: ["industria"],
    whatINeed: ["distribuidores"],
    // Recusada: duas palavras de conteúdo, e o texto se repete.
    bio: "Aulas de inglês. Aulas de inglês. Aulas de inglês.",
  };
});

describe("Perfil — a régua acompanha o que está sendo digitado", () => {
  it("o número muda conforme a pessoa reescreve a apresentação", () => {
    render(<Profile />);
    expect(linhaDaApresentacao()).toHaveTextContent("2 de 6");

    editar();
    fireEvent.change(caixaDaApresentacao(), {
      target: { value: "Consultora de exportação em vinhos portugueses finos tintos" },
    });

    // Seis palavras de conteúdo diferentes: a pendência sai da lista.
    expect(linhaDaApresentacao()).toBeNull();
  });

  it("texto ainda insuficiente atualiza a contagem em vez de repetir a antiga", () => {
    render(<Profile />);
    editar();

    fireEvent.change(caixaDaApresentacao(), { target: { value: "Consultora de comércio exterior" } });

    expect(linhaDaApresentacao()).toHaveTextContent("3 de 6");
  });

  it("a régua mede os OUTROS campos em edição também, não só a apresentação", () => {
    // Medir só a bio deixava cinco linhas paradas ao lado dos campos que a
    // pessoa estava preenchendo — e podia prometer Prata para um estado que o
    // Salvar não grava, porque o objeto avaliado não era nem o salvo nem o que
    // vai ser enviado.
    duble.perfil = { displayName: "Ana Souza", country: "BR", bio: "", city: "", activityArea: "", whatIHave: [], whatINeed: [] };
    render(<Profile />);
    editar();

    const antes = screen.getAllByRole("listitem").length;
    fireEvent.change(screen.getByPlaceholderText("Sua cidade"), { target: { value: "Porto Alegre" } });

    expect(screen.getAllByRole("listitem").length).toBeLessThan(antes);
  });

  it("fora da edição, a régua continua lendo o perfil salvo", () => {
    render(<Profile />);

    expect(linhaDaApresentacao()).toHaveTextContent("2 de 6");
  });
});
