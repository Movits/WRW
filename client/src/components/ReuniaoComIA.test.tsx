import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { PergunteAReuniao } from "./ReuniaoComIA";

/**
 * O "Pergunte à reunião" na tela. O tRPC vira um dublê com estado de verdade:
 * o mutate guarda a resposta combinada no teste e o componente a lê em `data`
 * ou `error`, como faz com o React Query. O que o servidor faz com a IA está em
 * server/reuniao-com-ia.test.ts. O resumo é o guardado, com o teste dele em
 * components/ResumoGuardado.test.tsx.
 */

const duble = vi.hoisted(() => ({
  respostas: {} as Record<string, unknown>,
  chamadas: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/trpc", async () => {
  const { useState } = await import("react");
  const mutacao = (nome: string) => ({
    useMutation: () => {
      const [estado, setEstado] = useState<{ data?: unknown; error?: unknown }>({});
      return {
        data: estado.data,
        error: estado.error ?? null,
        isError: !!estado.error,
        isPending: false,
        mutate: (variaveis: unknown) => {
          (duble.chamadas[nome] ??= []).push(variaveis);
          const resposta = duble.respostas[nome];
          setEstado(resposta instanceof Error ? { error: resposta } : { data: resposta });
        },
      };
    },
  });
  return {
    trpc: {
      meetings: { perguntar: mutacao("perguntar") },
      // A página do link aberto pede pelo token, num router público à parte.
      reuniaoAberta: { perguntar: mutacao("perguntarPeloLink") },
    },
  };
});

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
// Erro como o servidor devolve: o envelope tRPC traz data.code.
const erroDoServidor = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

beforeEach(() => {
  duble.respostas = {};
  duble.chamadas = {};
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Pergunte à reunião", () => {
  it("a pergunta mostra a resposta com o trecho citado", () => {
    duble.respostas.perguntar = { respondida: true, resposta: "O contêiner sai de Santos em 12 de março.", trecho: "O contêiner sai do porto de Santos no dia 12 de março." };
    render(<PergunteAReuniao meetingId={ID} />);
    const enviar = screen.getByRole("button", { name: /Perguntar/ });
    expect(enviar).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "  Quando sai o contêiner?  " } });
    fireEvent.click(enviar);

    expect(duble.chamadas.perguntar).toEqual([{ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai o contêiner?" }]);
    expect(screen.getByText("O contêiner sai de Santos em 12 de março.")).toBeInTheDocument();
    expect(screen.getByText("O contêiner sai do porto de Santos no dia 12 de março.")).toBeInTheDocument();
    expect(screen.getByText("Trecho da transcrição")).toBeInTheDocument();
    expect(screen.getByText("Quando sai o contêiner?")).toBeInTheDocument();
  });

  it("a transcrição não responde: a tela diz isso", () => {
    duble.respostas.perguntar = { respondida: false };
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Qual é o CNPJ?" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }).closest("form")!);
    expect(screen.getByText("A transcrição desta reunião não responde a esta pergunta.")).toBeInTheDocument();
    expect(screen.queryByText("Trecho da transcrição")).not.toBeInTheDocument();
  });

  it("reunião sem transcrição pronta: aviso traduzido no lugar da resposta", () => {
    duble.respostas.perguntar = erroDoServidor("PRECONDITION_FAILED", "Esta reunião ainda não tem transcrição pronta para a IA ler.");
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Quem participou?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(within(screen.getByRole("alert")).getByText("Esta reunião ainda não tem transcrição pronta para a IA ler.")).toBeInTheDocument();
  });

  it("muitos pedidos seguidos: a tela pede para aguardar, no idioma de quem lê", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.respostas.perguntar = erroDoServidor("TOO_MANY_REQUESTS", "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.");
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your question about the meeting" }), { target: { value: "Who attended?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests in a row. Wait a few minutes and try again.");
  });
});

describe("Pelo link aberto (pages/ReuniaoAberta.tsx)", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("a pergunta vai pelo token, aparada, e a resposta aparece com o trecho", () => {
    duble.respostas.perguntarPeloLink = { respondida: true, resposta: "Na sexta.", trecho: "a entrega fica para sexta" };
    render(<PergunteAReuniao token={TOKEN} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "  Quando é a entrega?  " } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(duble.chamadas.perguntarPeloLink).toEqual([{ token: TOKEN, idioma: "pt-BR", pergunta: "Quando é a entrega?" }]);
    expect(duble.chamadas.perguntar).toBeUndefined();
    expect(screen.getByText("Na sexta.")).toBeInTheDocument();
  });

  it("link desligado no meio da visita: a tela diz isso, e não 'reunião não encontrada'", () => {
    duble.respostas.perguntarPeloLink = erroDoServidor("NOT_FOUND", "Este link de reunião não existe ou foi desligado.");
    render(<PergunteAReuniao token={TOKEN} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Quem falou?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
  });

  it("pela dona, NOT_FOUND continua 'reunião não encontrada'", () => {
    duble.respostas.perguntar = erroDoServidor("NOT_FOUND", "Reunião não encontrada.");
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Quem falou?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta.");
  });
});

describe("O aviso de conferir fala com quem lê", () => {
  const perguntarAgora = () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Qual o prazo?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
  };

  it("pelo link: sem 'sua rede', que o visitante não tem", () => {
    duble.respostas.perguntarPeloLink = { respondida: true, resposta: "Sexta.", trecho: "a entrega fica para sexta" };
    render(<PergunteAReuniao token="AbCdEfGhIjKlMnOpQrStUvWxYz012345" />);
    perguntarAgora();
    expect(screen.getByText("Sugestões da IA para conferir com o trecho da transcrição. Nada disto foi gravado.")).toBeInTheDocument();
    expect(screen.queryByText(/sua rede/)).not.toBeInTheDocument();
  });

  it("pela dona: o aviso dela continua", () => {
    duble.respostas.perguntar = { respondida: true, resposta: "Sexta.", trecho: "a entrega fica para sexta" };
    render(<PergunteAReuniao meetingId={ID} />);
    perguntarAgora();
    expect(screen.getByText(/entra na sua rede sozinho/)).toBeInTheDocument();
  });

  it("a resposta da IA, a pergunta e o trecho seguem a direção deles mesmos", () => {
    duble.respostas.perguntar = { respondida: true, resposta: "Resposta", trecho: "trecho citado" };
    render(<PergunteAReuniao meetingId={ID} />);
    perguntarAgora();
    for (const texto of ["Resposta", "Qual o prazo?", "trecho citado"]) expect(screen.getByText(texto)).toHaveAttribute("dir", "auto");
  });
});
