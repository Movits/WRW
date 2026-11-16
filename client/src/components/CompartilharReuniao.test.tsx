import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompartilharReuniao, enderecoDoLinkAberto, linkDoEmail, linkDoWhatsApp } from "./CompartilharReuniao";

/**
 * O painel "Compartilhar por link" no detalhe da reunião (pedido do Roberto em
 * 12/11/2026): ligar pede a confirmação de que as pessoas autorizaram; ligado,
 * o link sai por cópia, WhatsApp e e-mail; desligar pede confirmação. O tRPC é
 * um dublê que registra o mutate e as opções, no molde de Meetings.test.tsx; o
 * que o servidor faz está em server/reuniao-aberta-rota.test.ts.
 */

type Opcoes = { onSuccess?: (data: unknown) => void; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return { mutacoes, registrar, setData: vi.fn(), invalidate: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { get: { setData: duble.setData, invalidate: duble.invalidate } } }),
    meetings: {
      ligarLinkAberto: duble.registrar("ligar"),
      desligarLinkAberto: duble.registrar("desligar"),
    },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const erroDoServidor = (code: string, message = "frase do servidor") => Object.assign(new Error(message), { data: { code } });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.setData.mockReset();
  duble.invalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.message).mockReset();
});
// O jsdom não tem área de transferência: cada teste põe a sua e tira no fim.
const porAreaDeTransferencia = (writeText: (texto: string) => Promise<void>) =>
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
afterEach(() => { Reflect.deleteProperty(window.navigator, "clipboard"); });

describe("os endereços que o painel monta", () => {
  it("o link é o domínio em que a dona está mais /r/{token}", () => {
    expect(enderecoDoLinkAberto(TOKEN, "https://wrwglobal.org")).toBe(`https://wrwglobal.org/r/${TOKEN}`);
    expect(enderecoDoLinkAberto(TOKEN)).toBe(`${window.location.origin}/r/${TOKEN}`);
  });

  it("WhatsApp e e-mail levam a mensagem inteira codificada: & ? # e quebra de linha não cortam o texto", () => {
    const mensagem = "Reunião “Vinho & café? #1”\nhttps://wrwglobal.org/r/x";
    const whatsapp = new URL(linkDoWhatsApp(mensagem));
    expect(whatsapp.origin).toBe("https://wa.me");
    expect(whatsapp.searchParams.get("text")).toBe(mensagem);
    const email = linkDoEmail("Assunto & tal?", mensagem);
    expect(email.startsWith("mailto:?subject=")).toBe(true);
    // Sem destinatário: quem escolhe é a dona, no app de e-mail dela.
    const parametros = new URLSearchParams(email.slice("mailto:?".length));
    expect(parametros.get("subject")).toBe("Assunto & tal?");
    expect(parametros.get("body")).toBe(mensagem);
  });
});

describe("sem link: ligar pede a confirmação de que as pessoas autorizaram", () => {
  it("o botão Criar link só aparece depois de Compartilhar e só funciona com a caixa marcada", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={null}/>);
    expect(screen.getByRole("heading", { name: "Compartilhar por link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Criar link/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    const criar = screen.getByRole("button", { name: /Criar link/ });
    expect(criar).toBeDisabled();
    fireEvent.click(criar);
    expect(duble.mutacoes.ligar.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /autorizaram compartilhar/ }));
    expect(criar).toBeEnabled();
    fireEvent.click(criar);
    // A prova leva a frase que a dona viu e o idioma da tela dela.
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith({
      meetingId: ID,
      autorizacaoDasPessoas: true,
      idioma: "pt-BR",
      textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram compartilhar a gravação e a transcrição com quem receber o link.",
    });
  });

  it("Cancelar volta ao começo e desmarca a caixa", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("ligado no servidor, o token entra na tela na hora e a reunião é relida", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onSuccess?.({ token: TOKEN }));
    expect(duble.setData).toHaveBeenCalledWith({ meetingId: ID }, expect.any(Function));
    const atualizar = duble.setData.mock.calls[0][1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, shareToken: null }, transcript: null })).toEqual({ meeting: { id: ID, shareToken: TOKEN }, transcript: null });
    expect(atualizar(undefined)).toBeUndefined();
    expect(duble.invalidate).toHaveBeenCalledWith({ meetingId: ID });
  });

  it("recusa do servidor vira frase traduzida, não a do servidor", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onError?.(erroDoServidor("PRECONDITION_FAILED")));
    expect(toast.error).toHaveBeenCalledWith("Só dá para compartilhar uma reunião pronta.");
    act(() => duble.mutacoes.ligar.opcoes.onError?.(erroDoServidor("BAD_REQUEST")));
    expect(toast.error).toHaveBeenLastCalledWith("Não foi possível mudar o compartilhamento. Tente de novo.");
  });
});

describe("com link: copiar, WhatsApp, e-mail e desligar", () => {
  const endereco = `${window.location.origin}/r/${TOKEN}`;

  it("mostra o endereço, e WhatsApp e e-mail levam o título e o link", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN}/>);
    expect(screen.getByRole("heading", { name: "Compartilhada por link" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveValue(endereco);
    const mensagem = `Reunião “Reunião com a Ana” na WRW: ${endereco}`;
    const whatsapp = screen.getByRole("link", { name: /WhatsApp/ });
    expect(new URL(whatsapp.getAttribute("href")!).searchParams.get("text")).toBe(mensagem);
    expect(whatsapp).toHaveAttribute("target", "_blank");
    expect(whatsapp).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const email = screen.getByRole("link", { name: /E-mail/ }).getAttribute("href")!;
    const parametros = new URLSearchParams(email.slice("mailto:?".length));
    expect(parametros.get("subject")).toBe("Reunião “Reunião com a Ana” na WRW");
    expect(parametros.get("body")).toBe(mensagem);
  });

  it("copiar põe o endereço na área de transferência e avisa", async () => {
    const writeText = vi.fn(async () => {});
    porAreaDeTransferencia(writeText);
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar link/ })); });
    expect(writeText).toHaveBeenCalledWith(endereco);
    expect(toast.success).toHaveBeenCalledWith("Link copiado.");
  });

  it("sem área de transferência, o endereço fica selecionado no campo e a tela diz para copiar dali", async () => {
    porAreaDeTransferencia(vi.fn(async () => { throw new Error("sem permissão"); }));
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    const campo = screen.getByRole("textbox", { name: "Link da reunião" }) as HTMLInputElement;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar link/ })); });
    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining("copie por ali"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(campo.selectionStart).toBe(0);
    expect(campo.selectionEnd).toBe(endereco.length);
  });

  it("desligar pede confirmação; Manter não chama o servidor", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    expect(screen.getByText(/deixa de abrir a reunião na hora/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(duble.mutacoes.desligar.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText(/deixa de abrir a reunião na hora/)).not.toBeInTheDocument();
  });

  it("confirmado, desliga a reunião certa, tira o token da tela e avisa", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    expect(duble.mutacoes.desligar.mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => duble.mutacoes.desligar.opcoes.onSuccess?.(undefined));
    const atualizar = duble.setData.mock.calls[0][1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, shareToken: TOKEN } })).toEqual({ meeting: { id: ID, shareToken: null } });
    expect(toast.success).toHaveBeenCalledWith("Link desligado.");
  });
});

describe("o painel anuncia o que mudou e não perde o foco", () => {
  it("Compartilhar: o foco vai para a caixa de autorização", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox")).toHaveFocus();
  });

  it("ligado: avisa \"Link criado\" e o foco vai para o campo do link", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onSuccess?.({ token: TOKEN }));
    expect(toast.success).toHaveBeenCalledWith("Link criado.");
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveFocus();
  });

  it("abrir a reunião que já tem link não rouba o foco", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).not.toHaveFocus();
  });

  it("desligar: a pergunta abre com o foco em Manter; desligado, o foco volta para Compartilhar", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    const manter = screen.getByRole("button", { name: "Manter" });
    expect(manter).toHaveFocus();
    expect(manter).toHaveAccessibleDescription(/deixa de abrir a reunião na hora/);
    act(() => duble.mutacoes.desligar.opcoes.onSuccess?.(undefined));
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    expect(screen.getByRole("button", { name: /Compartilhar/ })).toHaveFocus();
  });

  it("o endereço fica da esquerda para a direita, também numa tela em árabe", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveAttribute("dir", "ltr");
  });
});
