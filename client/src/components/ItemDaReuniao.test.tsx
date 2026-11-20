import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { LinhaDoItemDaReuniao } from "./ItemDaReuniao";

/**
 * O item da reunião na tela (N5): ✓ confirma, ✎ corrige antes, ✕ ignora, com
 * o trecho embaixo. No perfil da dona, o "preciso" vira demanda: a categoria
 * ("Outra necessidade" por padrão), o serviço em "Especialistas / Serviços" e
 * a descrição de 10 caracteres ou mais, como no Perfil. O tRPC é dublê: o que
 * o servidor faz está em server/reuniao-no-match*.test.ts.
 */

type Opcoes = { onSuccess?: (dados: unknown) => void; onError?: (erro: unknown) => void };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: ReturnType<typeof vi.fn>; opcoes: Opcoes }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), opcoes });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return { mutacoes, registrar, utils: { auth: { me: { invalidate: vi.fn() } } } };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    networkInteligente: {
      confirmarPendencia: duble.registrar("confirmar"),
      ignorarPendencia: duble.registrar("ignorar"),
    },
  },
}));

const ITEM = { id: "p1", campo: "preciso", valor: "Distribuidor no Chile", trecho: "preciso de um distribuidor no Chile" };
const confirmar = () => screen.getByRole("button", { name: /Confirmar/ });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.utils.auth.me.invalidate.mockReset();
});

describe("o item da reunião", () => {
  it("do contato: confirma como veio, sem categoria; o trecho aparece embaixo", () => {
    render(<ul><LinhaDoItemDaReuniao item={ITEM} alvo="contato" aoDecidir={vi.fn()} /></ul>);
    expect(screen.getByText("Trecho: “preciso de um distribuidor no Chile”")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(confirmar());
    expect(duble.mutacoes.confirmar.mutate).toHaveBeenCalledWith({ id: "p1" });
  });

  it("✎ corrige o texto antes de confirmar; ✕ ignora", () => {
    const aoDecidir = vi.fn();
    render(<ul><LinhaDoItemDaReuniao item={ITEM} alvo="contato" aoDecidir={aoDecidir} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: /Corrigir/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do item" }), { target: { value: "Distribuidor de vinho no Chile" } });
    fireEvent.click(confirmar());
    expect(duble.mutacoes.confirmar.mutate).toHaveBeenCalledWith({ id: "p1", valor: "Distribuidor de vinho no Chile" });
    fireEvent.click(screen.getByRole("button", { name: /Ignorar/ }));
    expect(duble.mutacoes.ignorar.mutate).toHaveBeenCalledWith({ id: "p1" });
    act(() => { duble.mutacoes.ignorar.opcoes.onSuccess?.({}); });
    expect(aoDecidir).toHaveBeenCalledTimes(1);
  });

  it("no perfil, o 'preciso' leva a categoria; curto, o Confirmar trava com o aviso", () => {
    render(<ul><LinhaDoItemDaReuniao item={ITEM} alvo="perfil" aoDecidir={vi.fn()} /></ul>);
    const categoria = screen.getByRole("combobox", { name: "Categoria" });
    expect(categoria).toHaveValue("outra_necessidade");
    expect(screen.queryByRole("option", { name: /Compradores/ })).not.toBeInTheDocument();
    fireEvent.change(categoria, { target: { value: "distribuidores" } });
    fireEvent.click(confirmar());
    expect(duble.mutacoes.confirmar.mutate).toHaveBeenCalledWith({ id: "p1", categoria: "distribuidores" });

    fireEvent.click(screen.getByRole("button", { name: /Corrigir/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do item" }), { target: { value: "Chile" } });
    expect(screen.getByText("Descreva com pelo menos 10 caracteres.")).toBeInTheDocument();
    expect(confirmar()).toBeDisabled();
  });

  it("em Especialistas / Serviços, o serviço é obrigatório e vai junto", () => {
    render(<ul><LinhaDoItemDaReuniao item={{ ...ITEM, valor: "Contador para abrir filial" }} alvo="perfil" aoDecidir={vi.fn()} /></ul>);
    fireEvent.change(screen.getByRole("combobox", { name: "Categoria" }), { target: { value: "especialistas_servicos" } });
    expect(confirmar()).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Serviço" }), { target: { value: "contabil" } });
    fireEvent.click(confirmar());
    expect(duble.mutacoes.confirmar.mutate).toHaveBeenCalledWith({ id: "p1", categoria: "especialistas_servicos", servico: "contabil" });
  });

  it("a recusa do servidor (BAD_REQUEST) aparece como ele a escreveu; a Prata ganha o aviso e relê a conta", () => {
    render(<ul><LinhaDoItemDaReuniao item={ITEM} alvo="perfil" aoDecidir={vi.fn()} /></ul>);
    act(() => { duble.mutacoes.confirmar.opcoes.onError?.({ message: "O item não pode levar o nome de ninguém da reunião.", data: { code: "BAD_REQUEST" } }); });
    expect(toast.error).toHaveBeenCalledWith("O item não pode levar o nome de ninguém da reunião.");
    act(() => { duble.mutacoes.confirmar.opcoes.onSuccess?.({ promovidaAPrata: true }); });
    expect(toast.success).toHaveBeenCalledWith("Parabéns! Seu perfil qualificado agora é Membro Prata.");
    expect(duble.utils.auth.me.invalidate).toHaveBeenCalled();
  });
});
