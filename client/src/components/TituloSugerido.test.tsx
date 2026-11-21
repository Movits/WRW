import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TituloSugerido } from "./TituloSugerido";

/**
 * O título que a IA sugeriu com o resumo, no detalhe da dona. O tRPC é dublê:
 * o mutate chama o onSuccess ou o onError que o componente passou, com o que o
 * teste combinou. O que o servidor faz (a transação, a dona no WHERE, o
 * CONFLICT) está em server/titulo-sugerido.integracao.test.ts.
 */
const duble = vi.hoisted(() => ({
  chamadas: [] as unknown[],
  resposta: { titulo: "Lançamento nas lojas" } as unknown,
  invalidadas: [] as string[],
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: {
        get: { invalidate: async () => { duble.invalidadas.push("get"); } },
        resumoGuardado: { invalidate: async () => { duble.invalidadas.push("resumoGuardado"); } },
        list: { invalidate: async () => { duble.invalidadas.push("list"); } },
      },
    }),
    meetings: {
      decidirTituloSugerido: {
        useMutation: (opcoes: { onSuccess?: (dados: unknown, pedido: { usar: boolean }) => unknown; onError?: (erro: unknown) => unknown }) => ({
          isPending: false,
          variables: undefined,
          mutate: (pedido: { meetingId: string; usar: boolean }) => {
            duble.chamadas.push(pedido);
            if (duble.resposta instanceof Error) opcoes.onError?.(duble.resposta);
            else void opcoes.onSuccess?.(duble.resposta, pedido);
          },
        }),
      },
    },
  },
}));

const ID = "0b6f2c1e-1111-4222-8333-944445555666";

beforeEach(() => {
  duble.chamadas = [];
  duble.invalidadas = [];
  duble.resposta = { titulo: "Lançamento nas lojas" };
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("TituloSugerido", () => {
  it("sem sugestão, nada aparece", () => {
    const { container } = render(<TituloSugerido meetingId={ID} emoji="📱" sugestao={null}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra a sugestão com o emoji do resumo e avisa que é só sugestão", () => {
    render(<TituloSugerido meetingId={ID} emoji="📱" sugestao="Lançamento nas lojas"/>);
    const caixa = screen.getByRole("region", { name: "Título sugerido pela IA" });
    expect(caixa).toHaveTextContent("📱Lançamento nas lojas");
    expect(caixa).toHaveTextContent("É só uma sugestão: o título muda apenas se você usar.");
  });

  it("\"Usar este título\" pede o uso, avisa e relê o detalhe, o resumo e a lista", async () => {
    render(<TituloSugerido meetingId={ID} emoji={null} sugestao="Lançamento nas lojas"/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Usar este título" })); });
    expect(duble.chamadas).toEqual([{ meetingId: ID, usar: true }]);
    expect(toast.success).toHaveBeenCalledWith("Título atualizado.");
    expect(duble.invalidadas.sort()).toEqual(["get", "list", "resumoGuardado"]);
  });

  it("\"Manter o atual\" só dispensa a sugestão, sem aviso de título novo", async () => {
    render(<TituloSugerido meetingId={ID} emoji={null} sugestao="Lançamento nas lojas"/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Manter o atual" })); });
    expect(duble.chamadas).toEqual([{ meetingId: ID, usar: false }]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a sugestão que já não espera a dona (CONFLICT) vira o aviso da tela, e a sugestão relê", async () => {
    duble.resposta = Object.assign(new Error("Esta sugestão de título não está mais disponível. Atualize a tela."), { data: { code: "CONFLICT" } });
    render(<TituloSugerido meetingId={ID} emoji={null} sugestao="Lançamento nas lojas"/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Usar este título" })); });
    expect(toast.error).toHaveBeenCalledWith("Esta sugestão não está mais disponível.");
    expect(duble.invalidadas).toEqual(["resumoGuardado"]);
  });

  it("em árabe, os botões e o aviso vêm em árabe", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<TituloSugerido meetingId={ID} emoji={null} sugestao="إطلاق التطبيق"/>);
    expect(screen.getByRole("button", { name: "استخدام هذا العنوان" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الإبقاء على الحالي" })).toBeInTheDocument();
  });
});
