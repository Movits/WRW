import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { PergunteAReuniao, ResumoDaReuniaoPelaIA } from "./ReuniaoComIA";

/**
 * O resumo da reunião e o "Pergunte à reunião" na tela. O tRPC vira um dublê
 * com estado de verdade: o mutate guarda a resposta combinada no teste e o
 * componente a lê em `data` ou `error`, como faz com o React Query. O que o
 * servidor faz com a IA está em server/reuniao-com-ia.test.ts.
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
  return { trpc: { meetings: { resumir: mutacao("resumir"), perguntar: mutacao("perguntar") } } };
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

describe("Resumo da reunião", () => {
  it("o botão gera o resumo e mostra as seções, com os trechos e o aviso de conferir", () => {
    duble.respostas.resumir = {
      topicos: [{ titulo: "Exportação de café", resumo: "Envio para a Alemanha em março.", trecho: "vamos falar da exportação de café para a Alemanha" }],
      decisoes: [{ texto: "Não renovar com a transportadora antiga.", trecho: "Decidimos não renovar o contrato" }],
      tarefas: [{ oQue: "Fechar o contrato com o importador", quem: "Carla", quando: "sexta-feira", trecho: "a Carla fecha o contrato com o importador até sexta-feira" }],
    };
    render(<ResumoDaReuniaoPelaIA meetingId={ID} />);
    expect(screen.queryByText("Tópicos")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));

    expect(duble.chamadas.resumir).toEqual([{ meetingId: ID, idioma: "pt-BR" }]);
    expect(screen.getByText("Tópicos")).toBeInTheDocument();
    expect(screen.getByText("Exportação de café")).toBeInTheDocument();
    expect(screen.getByText("Envio para a Alemanha em março.")).toBeInTheDocument();
    expect(screen.getByText("Decisões")).toBeInTheDocument();
    expect(screen.getByText("Não renovar com a transportadora antiga.")).toBeInTheDocument();
    expect(screen.getByText("Tarefas e providências")).toBeInTheDocument();
    expect(screen.getByText("Fechar o contrato com o importador")).toBeInTheDocument();
    expect(screen.getByText("Quem: Carla")).toBeInTheDocument();
    expect(screen.getByText("Quando: sexta-feira")).toBeInTheDocument();
    expect(screen.getByText("a Carla fecha o contrato com o importador até sexta-feira")).toBeInTheDocument();
    expect(screen.getAllByText("Trecho da transcrição")).toHaveLength(3);
    expect(screen.getByText(/Sugestões da IA para você conferir/)).toBeInTheDocument();
    // Depois de gerado, o botão oferece gerar de novo.
    expect(screen.getByRole("button", { name: /Gerar de novo/ })).toBeInTheDocument();
  });

  it("seção sem itens diz que nada foi encontrado, em vez de sumir", () => {
    duble.respostas.resumir = { topicos: [{ titulo: "Abertura", resumo: "Boas-vindas.", trecho: "Bom dia a todos, vamos começar" }], decisoes: [], tarefas: [] };
    render(<ResumoDaReuniaoPelaIA meetingId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));
    expect(screen.getAllByText("Nada encontrado na transcrição.")).toHaveLength(2);
  });

  it("pede no idioma da tela e, com a IA fora do ar, mostra o aviso traduzido, não uma tela vazia", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.respostas.resumir = erroDoServidor("SERVICE_UNAVAILABLE", "O serviço de IA não respondeu agora. Tente de novo em instantes.");
    render(<ResumoDaReuniaoPelaIA meetingId={ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Generate summary/ }));

    expect(duble.chamadas.resumir).toEqual([{ meetingId: ID, idioma: "en" }]);
    expect(screen.getByRole("alert")).toHaveTextContent("The AI service did not respond just now. Please try again in a moment.");
  });

  it("banco fora do ar é erro na tela, com a frase conhecida do servidor traduzida", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.respostas.resumir = erroDoServidor("INTERNAL_SERVER_ERROR", MENSAGEM_BANCO_INDISPONIVEL);
    render(<ResumoDaReuniaoPelaIA meetingId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Generate summary/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable; please try again in a moment");
    expect(screen.queryByText("Topics")).not.toBeInTheDocument();
  });
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
