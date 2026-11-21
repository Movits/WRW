import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import i18n from "@/i18n";
import { MENSAGEM_PERFIL_MUDOU_NO_MEIO } from "@shared/const";

import ar from "@/i18n/locales/ar.json";
import de from "@/i18n/locales/de.json";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import fr from "@/i18n/locales/fr.json";
import hi from "@/i18n/locales/hi.json";
import ja from "@/i18n/locales/ja.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import ru from "@/i18n/locales/ru.json";
import zh from "@/i18n/locales/zh.json";

/**
 * O Meu Perfil aberto e o que muda no meio (nota da validação da N5, PR #220;
 * o servidor está em server/listas-do-perfil.ts):
 *
 * - o salvar leva a versão das listas que ESTA edição carregou, e não a do
 *   perfil relido depois (a reunião confirmou um item em outra aba e a tela
 *   releu o perfil ao voltar o foco);
 * - o CONFLICT do perfil mudado em outra tela sai no idioma da tela, nos 10
 *   idiomas, e a edição fica aberta (nada foi salvo).
 */

const IDIOMAS: Record<string, { profile: { changedElsewhere: string } }> = { ar, de, en, es, fr, hi, ja, "pt-BR": ptBR, ru, zh };

type OpcoesDaMutation = { onError: (erro: unknown) => void; onSuccess: (resultado: unknown) => void };
const duble = vi.hoisted(() => ({
  dados: null as Record<string, unknown> | null,
  salvos: [] as Array<Record<string, unknown>>,
  opcoes: null as OpcoesDaMutation | null,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    networkInteligente: { pendenciasDoPerfil: { useQuery: () => ({ data: [], isError: false, error: null, refetch: () => undefined }) } },
    profile: {
      get: { useQuery: () => ({ data: duble.dados, isLoading: false }) },
      update: {
        useMutation: (opcoes: OpcoesDaMutation) => {
          duble.opcoes = opcoes;
          return { mutate: (vars: Record<string, unknown>) => { duble.salvos.push(vars); }, isPending: false };
        },
      },
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
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import Profile from "./Profile";

const VERSAO_AO_ABRIR = `v1:2-${"a".repeat(16)}:1-${"b".repeat(16)}:0-${"c".repeat(16)}`;
const VERSAO_RELIDA = `v1:3-${"d".repeat(16)}:1-${"b".repeat(16)}:0-${"c".repeat(16)}`;
const perfil = (whatIHave: string[]) => ({ displayName: "Ana", country: "BR", whatIHave, whatINeed: [], whatINeedDetails: [] });
const salvar = () => fireEvent.click(screen.getAllByRole("button", { name: /Salvar/ })[0]);
const conflito = { message: MENSAGEM_PERFIL_MUDOU_NO_MEIO, data: { code: "CONFLICT", httpStatus: 409, path: "profile.update" } };

beforeEach(() => {
  duble.salvos.length = 0;
  duble.opcoes = null;
  duble.dados = { user: { name: "Ana" }, profile: perfil(["industria", "Exportar vinho"]), versaoDasListas: VERSAO_AO_ABRIR };
  vi.mocked(toast.error).mockClear();
});

afterEach(async () => {
  // O DOM sai antes de o idioma voltar (a ordem dos afterEach é em pilha; ver client/src/test/setup.ts).
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("Perfil — a versão das listas que a edição carregou", () => {
  it("o salvar leva a versão de quando a edição abriu, mesmo com o perfil relido no meio", () => {
    const { rerender } = render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    // A dona confirmou um item da reunião em outra aba; ao voltar, a tela relê o perfil.
    duble.dados = { user: { name: "Ana" }, profile: perfil(["industria", "Exportar vinho", "Exportar café"]), versaoDasListas: VERSAO_RELIDA };
    rerender(<Profile />);
    salvar();
    expect(duble.salvos).toHaveLength(1);
    // As listas são as que a edição carregou, e a versão também: é com ela que o servidor
    // sabe que "Exportar café" entrou depois, e o acrescenta em vez de apagar.
    expect(duble.salvos[0]).toMatchObject({ whatIHave: ["industria", "Exportar vinho"], versaoDasListas: VERSAO_AO_ABRIR });
  });

  it("uma edição aberta de novo leva a versão nova", () => {
    const { rerender } = render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /Cancelar/ })[0]);
    duble.dados = { user: { name: "Ana" }, profile: perfil(["industria", "Exportar vinho", "Exportar café"]), versaoDasListas: VERSAO_RELIDA };
    rerender(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    salvar();
    expect(duble.salvos[0]).toMatchObject({ whatIHave: ["industria", "Exportar vinho", "Exportar café"], versaoDasListas: VERSAO_RELIDA });
  });
});

describe("Perfil — o perfil mudou em outra tela (CONFLICT)", () => {
  it("em português é a frase do servidor, caractere a caractere, e a edição fica aberta", () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    salvar();
    act(() => duble.opcoes!.onError(conflito));
    expect(ptBR.profile.changedElsewhere).toBe(MENSAGEM_PERFIL_MUDOU_NO_MEIO);
    expect(toast.error).toHaveBeenCalledWith(MENSAGEM_PERFIL_MUDOU_NO_MEIO);
    // Nada foi salvo: a edição segue aberta, com o que a dona escreveu.
    expect(screen.getAllByRole("button", { name: /Salvar/ }).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(IDIOMAS))("%s: a mensagem sai no idioma da tela", async idioma => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /Editar perfil/ }));
    salvar();
    await act(async () => { await i18n.changeLanguage(idioma); });
    act(() => duble.opcoes!.onError(conflito));
    const esperada = IDIOMAS[idioma].profile.changedElsewhere;
    expect(esperada).toBeTruthy();
    expect(toast.error).toHaveBeenLastCalledWith(esperada);
    if (idioma !== "pt-BR") expect(esperada).not.toBe(MENSAGEM_PERFIL_MUDOU_NO_MEIO);
  });
});
