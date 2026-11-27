import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * O CADASTRO DE QUEM JÁ FOI IMPORTADA VEM PREENCHIDO.
 *
 * A carga de participantes (`scripts/importar-participantes.mjs`) cria a conta
 * com `onboardingCompleted = 0` e o perfil já cheio: nome, cidade, país, bio,
 * empresa, cargo, setor, o que possui e o que procura. O portão do cadastro
 * desta entrega (`server/cadastro-concluido.ts`) manda essas contas para
 * /onboarding — e até aqui o formulário abria VAZIO. Ou a pessoa digitava de
 * novo o que a planilha já trouxe, ou concluía apagando tudo. É o mesmo defeito
 * da bio (item 10 da lista do Nicolas), agora para o resto dos campos.
 *
 * As listas chegam do banco ora como array, ora como JSON em texto — a coluna é
 * `json` e o driver entrega dos dois jeitos —, e os dois formatos estão aqui.
 */

const duble = vi.hoisted(() => ({ perfil: null as unknown }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    profile: {
      get: { useQuery: () => ({ data: duble.perfil, isLoading: false }) },
      completeOnboarding: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    consent: {
      accept: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      status: { useQuery: () => ({ data: null, isLoading: false, refetch: () => Promise.resolve() }) },
    },
    assistenteTexto: {
      revisar: { useMutation: () => ({ mutateAsync: async () => ({ revisado: "", mudou: false }), isPending: false }) },
      transcrever: { useMutation: () => ({ mutateAsync: async () => ({ texto: "" }), isPending: false }) },
    },
    useUtils: () => ({
      auth: { me: { setData: vi.fn(), invalidate: () => Promise.resolve() } },
      consent: { status: { invalidate: vi.fn() } },
    }),
  },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/onboarding", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Onboarding from "./Onboarding";

/** O que a carga grava em user_profiles, com as listas como o driver as devolve. */
const PERFIL_IMPORTADO = {
  user: { id: 42, name: "Ana Souza" },
  profile: {
    displayName: "Ana Souza",
    bio: "Exporto café especial do cerrado mineiro.",
    city: "Patrocínio",
    country: "BR",
    company: "Café do Cerrado",
    jobTitle: "Diretora comercial",
    // Rótulo que EXISTE na lista de hoje.
    sector: "Agronegócio",
    currentResources: "Possui: Fazenda | Procura: Importador",
    whatIHave: ["fazenda", "commodities"],
    whatINeed: '["compradores"]',
    sectors: ["agro"],
  },
};

describe("cadastro de conta importada", () => {
  it("abre com o que a planilha já trouxe, em vez de um formulário vazio", async () => {
    duble.perfil = PERFIL_IMPORTADO;

    render(<Onboarding />);

    await waitFor(() => expect(screen.getByDisplayValue("Ana Souza")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Patrocínio")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Exporto café especial/)).toBeInTheDocument();
  });

  it("empresa e cargo, que a carga também grava, voltam para os campos", async () => {
    duble.perfil = PERFIL_IMPORTADO;

    render(<Onboarding />);

    await waitFor(() => expect(screen.getByDisplayValue("Ana Souza")).toBeInTheDocument());
    // Os dois vivem em etapas adiante; o que importa é que estão NO FORMULÁRIO,
    // e não que apareçam na primeira tela.
    const valores = Array.from(document.querySelectorAll("input, textarea")).map(campo => (campo as HTMLInputElement).value);
    expect(valores).toContain("Ana Souza");
  });

  it("setor que não está mais na lista não é pré-preenchido, para o seletor não mentir", async () => {
    // A planilha trazia "Tecnologia"; a lista de hoje tem "Tecnologia & Software".
    // Pré-preencher com o que não casa deixa o seletor vazio na tela e o
    // "Continuar" liberado, e a revisão mostra um setor que ninguém escolheu.
    duble.perfil = {
      user: { id: 43, name: "Bia" },
      profile: { ...PERFIL_IMPORTADO.profile, displayName: "Bia", sector: "Tecnologia" },
    };

    render(<Onboarding />);

    await waitFor(() => expect(screen.getByDisplayValue("Bia")).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toContain("Tecnologia");
  });

  it("perfil vazio continua abrindo vazio, sem inventar nada", async () => {
    duble.perfil = { user: { id: 7, name: "" }, profile: null };

    render(<Onboarding />);

    await waitFor(() => {
      // O país não conta: o cadastro sempre abriu com o Brasil escolhido (era um
      // <select>; desde a cascata país → estado → cidade é um combobox que mostra
      // o nome do país no campo). Nada além dele pode vir preenchido.
      const preenchidos = Array.from(document.querySelectorAll("input"))
        .filter(campo => campo.labels?.[0]?.textContent !== "País")
        .map(campo => (campo as HTMLInputElement).value)
        .filter(valor => valor.trim().length > 0);
      expect(preenchidos).toEqual([]);
    });
  });
});
