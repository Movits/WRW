import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

/**
 * Conexões Inteligentes: a frase do motivo sai no idioma da tela.
 *
 * Na conferência de tela do pacote do match (20/11/2026), em árabe a 375 px, o cartão dizia "Contato K3 Exportar
 * possui Exportar café, que Contato K2 Importadora procura." — a reasonText, gravada em português pela rodada do
 * motor, desenhada crua. O servidor manda também quem possui o quê (`motivo`), e a frase sai da chave do idioma.
 *
 * O tRPC é um dublê genérico, como em erros-de-consulta.test.tsx: `trpc.a.b.useQuery` responde o que o teste
 * registrou em `respostas["a.b"]`.
 */
const duble = vi.hoisted(() => {
  const respostas: Record<string, unknown> = {};
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: () => ({ data: respostas[caminho], isLoading: false, isError: false, error: null, refetch: () => {} }),
    useMutation: () => ({ mutate: () => {}, isPending: false }),
  });
  const utils = new Proxy({}, {
    get: (_, router) => ignorar(router) ? undefined : new Proxy({}, {
      get: (_, proc) => ignorar(proc) ? undefined : new Proxy({}, { get: (_, metodo) => ignorar(metodo) ? undefined : async () => undefined }),
    }),
  });
  const trpc = new Proxy({}, {
    get: (_, router) => {
      if (ignorar(router)) return undefined;
      if (router === "useUtils") return () => utils;
      return new Proxy({}, { get: (_, proc) => ignorar(proc) ? undefined : procedimento(`${String(router)}.${String(proc)}`) });
    },
  });
  return { respostas, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// SmartMatchConsent puxa CSS do katex, que o runner não transforma; o termo está aceito aqui.
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

const { default: IntelligentMatches, frasesDoMotivo } = await import("./IntelligentMatches");

const FRASE_GRAVADA = "Contato K3 Exportar possui Exportar café, que Contato K2 Importadora procura.";
const doK3ParaOK2 = {
  id: "s-1", contactAId: 13, contactBId: 12, matchScore: 100, matchType: "exact", status: "pending", origem: null,
  matchedAssets: [{ slug: "exportar-cafe", label: "Exportar café", category: null }],
  matchedNeeds: [{ slug: "importar-cafe", label: "Importar café", category: null }],
  reasonText: FRASE_GRAVADA,
  contactA: { name: "Contato K3 Exportar", company: null, jobTitle: null },
  contactB: { name: "Contato K2 Importadora", company: null, jobTitle: null },
  motivo: [{ deId: 13, paraId: 12, possui: ["Exportar café"] }],
};

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  duble.respostas["consent.status"] = { accepted: true, pendingText: null, document: null };
  duble.respostas["consent.history"] = [];
  duble.respostas["intelligentMatches.contacts"] = [];
});

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Conexões Inteligentes — a frase do motivo no idioma da tela", () => {
  it("em árabe, o cartão diz a frase em árabe, e não a frase gravada em português", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    duble.respostas["intelligentMatches.list"] = [doK3ParaOK2];

    render(<IntelligentMatches />);

    expect(screen.queryByText(FRASE_GRAVADA)).not.toBeInTheDocument();
    expect(screen.getByText("لدى Contato K3 Exportar: Exportar café، وهو ما يبحث عنه Contato K2 Importadora.")).toBeInTheDocument();
  });

  it("em português, a mesma frase de antes", async () => {
    duble.respostas["intelligentMatches.list"] = [doK3ParaOK2];

    render(<IntelligentMatches />);

    expect(screen.getByText(FRASE_GRAVADA)).toBeInTheDocument();
  });

  it("mútuo, em inglês: uma frase por sentido, com a lista no jeito do idioma", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.respostas["intelligentMatches.list"] = [{
      ...doK3ParaOK2, id: "s-2", contactAId: 11, contactBId: 14, matchType: "mutual",
      contactA: { name: "Ana", company: null, jobTitle: null }, contactB: { name: "Bia", company: null, jobTitle: null },
      reasonText: "Ana possui Torrefação e Exportar café, que Bia procura; Bia possui Armazém em Santos, que Ana procura.",
      motivo: [{ deId: 11, paraId: 14, possui: ["Torrefação", "Exportar café"] }, { deId: 14, paraId: 11, possui: ["Armazém em Santos"] }],
    }];

    render(<IntelligentMatches />);

    expect(screen.getByText("Ana has Torrefação and Exportar café, which Bia is looking for.")).toBeInTheDocument();
    expect(screen.getByText("Bia has Armazém em Santos, which Ana is looking for.")).toBeInTheDocument();
    expect(screen.queryByText(/possui/)).not.toBeInTheDocument();
  });
});

describe("frasesDoMotivo", () => {
  const t = (chave: string, opcoes?: Record<string, unknown>) => i18n.t(chave, opcoes);

  it("sem direção (resposta de antes desta versão), fica a frase gravada", () => {
    expect(frasesDoMotivo({ ...doK3ParaOK2, motivo: undefined }, t, "pt-BR")).toEqual([FRASE_GRAVADA]);
    expect(frasesDoMotivo({ ...doK3ParaOK2, motivo: [{ deId: 13, paraId: 12, possui: [] }] }, t, "pt-BR")).toEqual([FRASE_GRAVADA]);
  });

  it("contato sem nome: o nome de reserva do idioma, como no título do cartão", () => {
    expect(frasesDoMotivo({ ...doK3ParaOK2, contactA: null, contactB: undefined }, t, "pt-BR"))
      .toEqual(["Contato A possui Exportar café, que Contato B procura."]);
  });

  it("três itens em português: 'X, Y e Z'", () => {
    expect(frasesDoMotivo({ ...doK3ParaOK2, motivo: [{ deId: 13, paraId: 12, possui: ["Vinho", "Azeite", "Queijo"] }] }, t, "pt-BR"))
      .toEqual(["Contato K3 Exportar possui Vinho, Azeite e Queijo, que Contato K2 Importadora procura."]);
  });
});
