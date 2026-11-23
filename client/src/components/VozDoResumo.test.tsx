import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { BaixarAudioDoResumo } from "./BaixarAudioDoResumo";
import { ComplementoDoItem, type ComplementoNaTela } from "./ComplementoDoItem";

/**
 * O grupo voz na tela: "Baixar o áudio do resumo" (H19b) e o complemento pela
 * busca na web (H4i). As mutações são dublês que registram o mutate e as
 * opções; o servidor está em server/resumo-em-audio.ts e
 * server/complemento-pela-busca.ts, com os testes deles.
 */
type Opcoes = { onSuccess?: (resultado: unknown) => void; onSettled?: () => unknown };
type Estado = { mutate: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; opcoes: Opcoes; isPending: boolean; isError: boolean; error: unknown };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, Estado> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), reset: vi.fn(), opcoes, isPending: false, isError: false, error: null });
      m.opcoes = opcoes;
      return { mutate: m.mutate, reset: m.reset, isPending: m.isPending, isError: m.isError, error: m.error };
    },
  });
  return { mutacoes, registrar };
});
vi.mock("@/lib/trpc", () => ({
  trpc: {
    meetings: {
      audioDoResumo: duble.registrar("audioDoResumo"),
      pedirComplemento: duble.registrar("pedirComplemento"),
      decidirComplemento: duble.registrar("decidirComplemento"),
    },
  },
}));

const REUNIAO = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const PENDENTE: ComplementoNaTela = { texto: "Lei nº 14.133/2021", fonte: "https://fonte.example/lei", titulo: "Planalto", consultas: ["lei 14.133"], situacao: "pending" };

beforeEach(async () => {
  for (const nome of Object.keys(duble.mutacoes)) delete duble.mutacoes[nome];
  await i18n.changeLanguage("pt-BR");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("BaixarAudioDoResumo (H19b)", () => {
  it("o primeiro toque só abre o aviso do que vai à Google; o Gerar pede o áudio no idioma do resumo", () => {
    render(<BaixarAudioDoResumo meetingId={REUNIAO} idioma="pt-BR"/>);
    fireEvent.click(screen.getByRole("button", { name: /Baixar o áudio do resumo/ }));
    expect(duble.mutacoes.audioDoResumo.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/vai ao Gemini, da Google/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Gerar e baixar/ }));
    expect(duble.mutacoes.audioDoResumo.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, idioma: "pt-BR" });
  });

  it("a resposta vira o download de um MP3 com o título e o idioma", () => {
    const criar = vi.fn(() => "blob:mp3");
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() });
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<BaixarAudioDoResumo meetingId={REUNIAO} idioma="pt-BR"/>);
    fireEvent.click(screen.getByRole("button", { name: /Baixar o áudio do resumo/ }));
    duble.mutacoes.audioDoResumo.opcoes.onSuccess?.({ mp3Base64: btoa("ID3"), idioma: "pt-BR", titulo: "Reunião da voz", reaproveitado: false });
    expect(criar).toHaveBeenCalledTimes(1);
    expect(clique).toHaveBeenCalledTimes(1);
    const link = clique.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toMatch(/Reunião da voz.*pt-BR.*\.mp3$/);
  });

  it("a recusa do teto vira o aviso traduzido", () => {
    render(<BaixarAudioDoResumo meetingId={REUNIAO} idioma="pt-BR"/>);
    fireEvent.click(screen.getByRole("button", { name: /Baixar o áudio do resumo/ }));
    Object.assign(duble.mutacoes.audioDoResumo, { isError: true, error: { message: "AUDIO_DO_RESUMO_DEMAIS", data: { code: "TOO_MANY_REQUESTS" } } });
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Baixar o áudio do resumo/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/limite de áudios do resumo por hoje/);
  });
});

describe("ComplementoDoItem (H4i)", () => {
  it("sem complemento, a dona pede: primeiro o aviso do que vai à busca, depois o Buscar com o item", () => {
    const reler = vi.fn();
    render(<ComplementoDoItem itemId={ITEM} complemento={null} peloLink={false} podeMexer reler={reler}/>);
    fireEvent.click(screen.getByRole("button", { name: /Completar pela web/ }));
    expect(screen.getByText(/vai à busca da Google no Gemini/)).toBeTruthy();
    expect(duble.mutacoes.pedirComplemento.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
    expect(duble.mutacoes.pedirComplemento.mutate).toHaveBeenCalledWith({ itemId: ITEM });
    duble.mutacoes.pedirComplemento.opcoes.onSettled?.();
    expect(reler).toHaveBeenCalled();
  });

  it("o achado aparece marcado 'fora da reunião, a conferir', com a fonte e as consultas, e espera Usar ou Descartar", () => {
    render(<ComplementoDoItem itemId={ITEM} complemento={PENDENTE} peloLink={false} podeMexer reler={vi.fn()}/>);
    expect(screen.getByText(/Fora da reunião, a conferir/)).toBeTruthy();
    const fonte = screen.getByRole("link", { name: /Fonte: Planalto/ });
    expect(fonte.getAttribute("href")).toBe("https://fonte.example/lei");
    expect(fonte.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "lei 14.133" }).getAttribute("href")).toBe("https://www.google.com/search?q=lei%2014.133");
    fireEvent.click(screen.getByRole("button", { name: /Usar o complemento/ }));
    expect(duble.mutacoes.decidirComplemento.mutate).toHaveBeenCalledWith({ itemId: ITEM, decisao: "confirmar" });
    fireEvent.click(screen.getByRole("button", { name: /Descartar/ }));
    expect(duble.mutacoes.decidirComplemento.mutate).toHaveBeenLastCalledWith({ itemId: ITEM, decisao: "descartar" });
  });

  it("o confirmado não oferece Usar de novo, só Descartar", () => {
    render(<ComplementoDoItem itemId={ITEM} complemento={{ ...PENDENTE, situacao: "confirmed" }} peloLink={false} podeMexer reler={vi.fn()}/>);
    expect(screen.queryByRole("button", { name: /Usar o complemento/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Descartar/ })).toBeTruthy();
  });

  it("pelo link: só leitura, sem botões nem consultas; sem complemento, nada", () => {
    const { container, rerender } = render(<ComplementoDoItem complemento={{ ...PENDENTE, situacao: "confirmed", consultas: [] }} peloLink podeMexer={false} reler={vi.fn()}/>);
    expect(screen.getByText(/Fora da reunião, a conferir/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(duble.mutacoes.pedirComplemento).toBeUndefined();
    rerender(<ComplementoDoItem complemento={null} peloLink podeMexer={false} reler={vi.fn()}/>);
    expect(container.textContent).toBe("");
  });

  it("a recusa 'não achei' vira o aviso traduzido", () => {
    render(<ComplementoDoItem itemId={ITEM} complemento={null} peloLink={false} podeMexer reler={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: /Completar pela web/ }));
    Object.assign(duble.mutacoes.pedirComplemento, { isError: true, error: { message: "COMPLEMENTO_NAO_ACHADO", data: { code: "PRECONDITION_FAILED" } } });
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Completar pela web/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/não achou essa referência/);
  });
});
