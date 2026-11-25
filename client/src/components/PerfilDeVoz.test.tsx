import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerfilDeVoz } from "./PerfilDeVoz";
import { VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ } from "@shared/perfil-de-voz";

/**
 * O perfil de voz no Perfil (H3d), com o tRPC e o gravador dublados. Prova o
 * que a Cris pediu na tela: a caixa do consentimento nasce DESMARCADA, sem ela
 * o botão de gravar não liga, e a primeira gravação leva o texto que a dona
 * viu, com a versão e o idioma; regravar não pede a caixa de novo; desligar
 * pede confirmação; a falha da consulta é erro, nunca "sem perfil".
 */

type Opcoes = { onSuccess?: (data: unknown) => unknown; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => ({
  estado: vi.fn(),
  gravar: vi.fn(),
  ouvir: vi.fn(),
  desligar: vi.fn(),
  comecar: vi.fn(async () => true),
  aoTerminar: null as null | ((audio: { blob: Blob; mimeType: string; duracaoMs: number }) => void),
  opcoes: {} as Record<string, Opcoes>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => {
  const mutacao = (nome: "gravar" | "ouvir" | "desligar") => ({
    useMutation: (opcoes: Opcoes = {}) => {
      duble.opcoes[nome] = opcoes;
      return { mutate: duble[nome], isPending: false };
    },
  });
  return {
    trpc: {
      useUtils: () => ({ perfilDeVoz: { estado: { invalidate: vi.fn() } } }),
      perfilDeVoz: {
        estado: { useQuery: (...args: unknown[]) => duble.estado(...args) },
        gravar: mutacao("gravar"),
        ouvir: mutacao("ouvir"),
        desligar: mutacao("desligar"),
      },
    },
  };
});
vi.mock("@/hooks/useGravadorDeAudio", () => ({
  gravacaoDeAudioSuportada: () => true,
  useGravadorDeAudio: (opcoes: { aoTerminar: typeof duble.aoTerminar }) => {
    duble.aoTerminar = opcoes.aoTerminar;
    return { estado: "parado", segundos: 0, comecar: duble.comecar, parar: vi.fn() };
  },
}));

const consulta = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, isLoading: false, error: null, refetch: vi.fn(), ...extra });
const botaoDeGravar = () => screen.getByRole("button", { name: /Gravar a minha voz/ });

beforeEach(() => {
  vi.clearAllMocks();
  duble.opcoes = {};
  duble.aoTerminar = null;
});

describe("sem perfil", () => {
  it("a caixa da Cris nasce desmarcada, com o texto de apoio, e o gravar só liga com ela marcada", () => {
    duble.estado.mockReturnValue(consulta({ ativo: false }));
    render(<PerfilDeVoz />);
    const caixa = screen.getByRole("checkbox");
    expect(caixa).not.toBeChecked();
    expect(screen.getByText("Autorizo a Marquesa Global Match a criar um perfil da minha voz para me identificar nas transcrições e resumos das reuniões.")).toBeInTheDocument();
    expect(screen.getByText(/O perfil de voz é um dado biométrico\. É usado apenas para esse fim, não é obrigatório/)).toBeInTheDocument();
    expect(botaoDeGravar()).toBeDisabled();
    fireEvent.click(caixa);
    expect(botaoDeGravar()).toBeEnabled();
    fireEvent.click(botaoDeGravar());
    expect(duble.comecar).toHaveBeenCalledTimes(1);
  });

  it("a primeira gravação leva o consentimento: a versão vigente, o idioma e o texto que a dona viu", async () => {
    duble.estado.mockReturnValue(consulta({ ativo: false }));
    render(<PerfilDeVoz />);
    fireEvent.click(screen.getByRole("checkbox"));
    duble.aoTerminar!({ blob: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", duracaoMs: 31_000 });
    await vi.waitFor(() => expect(duble.gravar).toHaveBeenCalledTimes(1));
    const pedido = duble.gravar.mock.calls[0][0];
    expect(pedido).toMatchObject({ mimeType: "audio/webm", duracaoMs: 31_000, consentimento: { versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ, idioma: "pt-BR" } });
    expect(pedido.consentimento.textoExibido).toContain("Autorizo a Marquesa Global Match");
    expect(pedido.consentimento.textoExibido).toContain("Ao desligar, o perfil é excluído.");
    expect(pedido.audioBase64).toMatch(/^data:audio\/webm;base64,/);
  });

  it("a gravação curta demais não vai ao servidor", async () => {
    duble.estado.mockReturnValue(consulta({ ativo: false }));
    render(<PerfilDeVoz />);
    fireEvent.click(screen.getByRole("checkbox"));
    duble.aoTerminar!({ blob: new Blob(["a"], { type: "audio/webm" }), mimeType: "audio/webm", duracaoMs: 4_000 });
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(duble.gravar).not.toHaveBeenCalled();
  });

  it("a falha da consulta é erro com Tentar de novo, nunca a caixa de 'sem perfil'", () => {
    duble.estado.mockReturnValue(consulta(undefined, { error: { message: "Banco de dados indisponível", data: { code: "INTERNAL_SERVER_ERROR" } } }));
    render(<PerfilDeVoz />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar/ })).toBeInTheDocument();
  });
});

describe("com perfil", () => {
  it("ouvir, regravar (sem a caixa e sem consentimento no pedido) e desligar com confirmação", async () => {
    duble.estado.mockReturnValue(consulta({ ativo: true, duracaoMs: 30_000, criadoEm: Date.now(), atualizadoEm: Date.now() }));
    render(<PerfilDeVoz />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir" }));
    expect(duble.ouvir).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Desligar e excluir/ }));
    expect(duble.desligar).not.toHaveBeenCalled();
    expect(screen.getByText(/exclui a gravação da sua voz de vez/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sim, desligar e excluir/ }));
    expect(duble.desligar).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Regravar" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(botaoDeGravar()).toBeEnabled();
    duble.aoTerminar!({ blob: new Blob(["audio"], { type: "audio/mp4" }), mimeType: "audio/mp4", duracaoMs: 25_000 });
    await vi.waitFor(() => expect(duble.gravar).toHaveBeenCalledTimes(1));
    expect(duble.gravar.mock.calls[0][0].consentimento).toBeUndefined();
  });
});
