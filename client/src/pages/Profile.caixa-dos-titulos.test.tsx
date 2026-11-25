import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * Caixa dos títulos no PERFIL — a outra metade do que já valia no cadastro
 * (client/src/pages/Onboarding.caixa-dos-titulos.test.tsx).
 *
 * REGRA (revisão de 15/09): CAIXA ALTA só nos títulos das categorias das duas
 * listas de seleção — "O que tenho" e "O que preciso" —, e nas duas telas em que
 * essas listas aparecem, cadastro e Perfil. No Perfil a regra tinha ficado pela
 * metade: "O que preciso" vinha em caixa alta porque a lista mora num componente
 * compartilhado (components/OQuePreciso.tsx), e "O que tenho", que tem cartões
 * próprios aqui, continuava em caixa normal — as duas listas, uma embaixo da
 * outra, com tratamentos diferentes. Vale na edição E na leitura: é a mesma
 * lista, com os mesmos títulos.
 *
 * O que NÃO muda: o resto do Perfil. Os "Setores de interesse" são outra lista
 * (a de shared/setores.ts, que no cadastro é um menu suspenso), e o título das
 * seções é título de seção, não de categoria.
 *
 * Como no cadastro, a padronização é de EXIBIÇÃO — a classe `uppercase` — e
 * nunca texto reescrito nos 10 JSONs: em árabe, chinês e japonês não existe
 * caixa, `text-transform` não os toca e "subir a caixa" no dado só estragaria os
 * idiomas latinos. Por isso se exige a classe no elemento e o texto igual ao
 * rótulo, caractere por caractere.
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
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { name: "Ana", email: "ana@exemplo.com", role: "silver" } }) }));
vi.mock("@/components/ExcluirMinhaConta", () => ({ ExcluirMinhaConta: () => null }));
// A seção da Google Agenda (H16b) tem o teste dela (ConexaoGoogleAgenda.test.tsx).
vi.mock("@/components/ConexaoGoogleAgenda", () => ({ ConexaoGoogleAgenda: () => null }));
vi.mock("@/components/ChavesDeAcesso", () => ({ ChavesDeAcesso: () => null }));
vi.mock("@/components/ContaGoogleNoPerfil", () => ({ ContaGoogleNoPerfil: () => null }));
vi.mock("@/components/QualificacaoDoPerfil", () => ({ QualificacaoDoPerfil: () => null }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

/** O elemento que mostra exatamente aquele rótulo. */
const rotulo = (texto: string) => screen.getByText(texto);
const editar = () => fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));

// "Indústria" (O que tenho) e "Indústria & Manufatura" (setor) são rótulos
// diferentes: o getByText é exato, então um não pega o outro.
const TENHO = "Indústria";
const TENHO_2 = "Rede de Investidores";
const PRECISO = "Distribuidores / Representantes";
const SETOR = "Tecnologia & Software";

beforeEach(() => {
  duble.perfil = {
    displayName: "Ana", country: "BR",
    whatIHave: ["industria", "investidores"],
    whatINeed: ["distribuidores"],
    whatINeedDetails: [{ id: "d1", category: "distribuidores", region: "África Oriental", description: "Busco parceiro para distribuir na África Oriental" }],
    interestSectors: [SETOR],
  };
});

describe("Perfil — as duas listas de seleção saem em caixa alta", () => {
  it("na edição, os cartões de 'O que tenho' (era a metade que faltava)", () => {
    render(<Profile />);
    editar();
    expect(rotulo(TENHO).className, TENHO).toMatch(/\buppercase\b/);
    expect(rotulo(TENHO_2).className, TENHO_2).toMatch(/\buppercase\b/);
  });

  it("na edição, os cartões de 'O que preciso' continuam como já estavam", () => {
    render(<Profile />);
    editar();
    expect(rotulo(PRECISO).className, PRECISO).toMatch(/\buppercase\b/);
  });

  it("na leitura, as duas listas têm o mesmo tratamento — é a mesma lista", () => {
    render(<Profile />);
    expect(rotulo(TENHO).className, TENHO).toMatch(/\buppercase\b/);
    expect(rotulo(TENHO_2).className, TENHO_2).toMatch(/\buppercase\b/);
    expect(rotulo(PRECISO).className, PRECISO).toMatch(/\buppercase\b/);
  });

  it("a caixa é CSS: o texto na tela é o do rótulo, caractere por caractere", () => {
    // Um rótulo gravado em maiúsculas não faria nada por árabe, chinês e
    // japonês, e estragaria os idiomas latinos; por isso o dado fica intacto.
    render(<Profile />);
    editar();
    for (const texto of [TENHO, TENHO_2, PRECISO]) {
      expect(rotulo(texto).textContent, texto).toBe(texto);
    }
  });
});

describe("Perfil — o que não é lista de categoria fica em caixa normal", () => {
  it("os setores de interesse, na edição e na leitura", () => {
    const { unmount } = render(<Profile />);
    expect(rotulo(SETOR).className, "leitura").not.toMatch(/\buppercase\b/);
    unmount();

    render(<Profile />);
    editar();
    expect(rotulo(SETOR).className, "edição").not.toMatch(/\buppercase\b/);
    expect(rotulo("Agronegócio").className, "outro setor da lista").not.toMatch(/\buppercase\b/);
  });

  it("os títulos das seções", () => {
    render(<Profile />);
    for (const titulo of ["Quem sou", "O que tenho", "O que preciso"]) {
      expect(rotulo(titulo).className, titulo).not.toMatch(/\buppercase\b/);
    }
  });
});
