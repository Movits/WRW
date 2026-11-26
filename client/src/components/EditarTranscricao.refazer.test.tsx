import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Refazer o resumo" depois de editar a transcrição (H18), com o defeito do
 * teste manual T51 (24/11): o toque não mostrava nada, nem carregando, nem
 * erro. O pedido aceito agora avisa na hora; a recusa fica escrita no próprio
 * aviso; e o refazer pede o mesmo resumo de agora (o modelo da escolha, o
 * estilo e as instruções), e não só o código do modelo pronto. O servidor está
 * nos testes dele (server/editar-transcricao.integracao.test.ts).
 */

type Opcoes = { onSuccess?: () => unknown; onError?: (erro: unknown) => void; onSettled?: () => unknown };
const duble = vi.hoisted(() => {
  const estado = { mutate: vi.fn(), opcoes: {} as Opcoes, isPending: false, isError: false, error: null as unknown };
  return {
    estado,
    utils: { meetings: { resumoGuardado: { invalidate: vi.fn() }, mapaMental: { invalidate: vi.fn() } } },
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      refazerResumo: {
        useMutation: (opcoes: Opcoes = {}) => {
          duble.estado.opcoes = opcoes;
          return { mutate: duble.estado.mutate, isPending: duble.estado.isPending, isError: duble.estado.isError, error: duble.estado.error };
        },
      },
    },
  },
}));

import { toast } from "sonner";
import { AvisoDeResumoDeOutraVersao, AvisoDoResumoSendoRefeito, pedidoDoRefazerDepoisDaEdicao } from "./EditarTranscricao";

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  duble.estado.mutate.mockReset();
  duble.estado.isPending = false;
  duble.estado.isError = false;
  duble.estado.error = null;
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("pedidoDoRefazerDepoisDaEdicao: o mesmo resumo de agora, lido da transcrição editada", () => {
  it("o resumo num modelo da dona refaz no modelo dela, com o estilo e as instruções (e não no Geral)", () => {
    expect(pedidoDoRefazerDepoisDaEdicao({ escolha: "proprio:abc", modelo: "general", estilo: "detailed", instrucoes: "Destaque os prazos." }))
      .toEqual({ modelo: "proprio:abc", estilo: "detailed", instrucoes: "Destaque os prazos." });
  });

  it("o resumo num modelo pronto, no estilo padrão e sem instruções: só o modelo", () => {
    expect(pedidoDoRefazerDepoisDaEdicao({ escolha: "sales", modelo: "sales", estilo: "balanced", instrucoes: null })).toEqual({ modelo: "sales" });
  });

  it("sem a escolha (a resposta de antes da H4e), o modelo; sem nada, o Geral", () => {
    expect(pedidoDoRefazerDepoisDaEdicao({ modelo: "sales" })).toEqual({ modelo: "sales" });
    expect(pedidoDoRefazerDepoisDaEdicao(undefined)).toEqual({ modelo: "general" });
  });
});

describe("AvisoDeResumoDeOutraVersao", () => {
  it("o toque pede o refazer com o pedido de agora", () => {
    render(<AvisoDeResumoDeOutraVersao meetingId={REUNIAO} resumo={{ escolha: "proprio:abc", modelo: "general", estilo: "detailed", instrucoes: "" }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Refazer o resumo" }));
    expect(duble.estado.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: "proprio:abc", estilo: "detailed" });
  });

  it("o pedido aceito avisa na hora que o resumo está sendo refeito e onde a versão nova aparece (T51: antes, nada aparecia)", async () => {
    render(<AvisoDeResumoDeOutraVersao meetingId={REUNIAO} resumo={{ escolha: "general" }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Refazer o resumo" }));
    await act(async () => { await duble.estado.opcoes.onSuccess?.(); });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("o resumo está sendo refeito com a transcrição editada"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("aba Resumo"));
  });

  it("a recusa (o teto de refazeres) sai traduzida no aviso flutuante e fica escrita no próprio aviso", async () => {
    const erro = { message: "REFAZERES_DO_RESUMO_DEMAIS", data: { code: "TOO_MANY_REQUESTS" } };
    render(<AvisoDeResumoDeOutraVersao meetingId={REUNIAO} resumo={{ escolha: "general" }}/>);
    await act(async () => { duble.estado.opcoes.onError?.(erro); });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const texto = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(texto).not.toMatch(/REFAZERES_DO_RESUMO_DEMAIS|TOO_MANY/);
    duble.estado.isError = true;
    duble.estado.error = erro;
    render(<AvisoDeResumoDeOutraVersao meetingId={REUNIAO} resumo={{ escolha: "general" }}/>);
    expect(screen.getByRole("alert")).toHaveTextContent(texto);
  });

  it("enquanto o pedido vai ao servidor, o botão fica desligado", () => {
    duble.estado.isPending = true;
    render(<AvisoDeResumoDeOutraVersao meetingId={REUNIAO} resumo={{ escolha: "general" }}/>);
    expect(screen.getByRole("button", { name: "Refazer o resumo" })).toBeDisabled();
  });
});

describe("AvisoDoResumoSendoRefeito", () => {
  it("diz que o resumo está sendo refeito e onde a versão nova aparece", () => {
    render(<AvisoDoResumoSendoRefeito/>);
    expect(screen.getByRole("status")).toHaveTextContent("Refazendo o resumo com a transcrição de agora. A versão nova aparece na aba Resumo quando terminar.");
  });
});
