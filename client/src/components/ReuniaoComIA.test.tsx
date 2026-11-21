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
// A resposta como o servidor a manda (server/reuniao-com-ia.ts): as citações e,
// por uma versão, o campo antigo com o trecho da primeira.
const respondida = (resposta: string, ...citacoes: Array<{ trecho: string; inicioSegundos: number | null }>) =>
  ({ respondida: true, resposta, citacoes, trecho: citacoes[0].trecho });
const semTempo = (trecho: string) => ({ trecho, inicioSegundos: null });

beforeEach(() => {
  duble.respostas = {};
  duble.chamadas = {};
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

const perguntarAgora = (texto = "Qual o prazo?") => {
  fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: texto } });
  fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
};

describe("Pergunte à reunião", () => {
  it("a pergunta mostra a resposta com o trecho citado", () => {
    duble.respostas.perguntar = respondida("O contêiner sai de Santos em 12 de março.", semTempo("O contêiner sai do porto de Santos no dia 12 de março."));
    render(<PergunteAReuniao meetingId={ID} />);
    const enviar = screen.getByRole("button", { name: /Perguntar/ });
    expect(enviar).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "  Quando sai o contêiner?  " } });
    fireEvent.click(enviar);

    expect(duble.chamadas.perguntar).toEqual([{ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai o contêiner?" }]);
    expect(screen.getByText("O contêiner sai de Santos em 12 de março.")).toBeInTheDocument();
    expect(screen.getByText("O contêiner sai do porto de Santos no dia 12 de março.")).toBeInTheDocument();
    expect(screen.getByText("Onde isso foi dito")).toBeInTheDocument();
    expect(screen.getByText("Quando sai o contêiner?")).toBeInTheDocument();
  });

  it("a transcrição não responde: a tela diz isso", () => {
    duble.respostas.perguntar = { respondida: false };
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Qual é o CNPJ?" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }).closest("form")!);
    expect(screen.getByText("A transcrição desta reunião não responde a esta pergunta.")).toBeInTheDocument();
    expect(screen.queryByText("Onde isso foi dito")).not.toBeInTheDocument();
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

  it("reunião longa demais para perguntar: a tela diz isso no idioma de quem lê, nunca a frase do servidor", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.respostas.perguntar = erroDoServidor("PAYLOAD_TOO_LARGE", "Esta reunião é longa demais para perguntas à IA: o limite é de cerca de 7 horas de fala.");
    render(<PergunteAReuniao meetingId={ID} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your question about the meeting" }), { target: { value: "Who attended?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("This meeting is too long for questions to the AI: the limit is about 7 hours of speech.");
    expect(screen.queryByText(/longa demais/)).not.toBeInTheDocument();
  });
});

describe("As citações com o '▶' e as vozes (H6)", () => {
  const RESPOSTA = respondida(
    "{F1} disse que o contêiner sai dia 12, e {F2} confirmou.",
    { trecho: "o contêiner sai do porto de Santos no dia 12", inicioSegundos: 75 },
    { trecho: "confirmo a saída no dia 12 de março", inicioSegundos: 3725 },
    semTempo("a carga já está no porto desde segunda"),
  );

  it("dona: o rótulo vira o nome que ela deu à voz, e a voz sem nome vira 'Falante n'", () => {
    duble.respostas.perguntar = RESPOSTA;
    render(<PergunteAReuniao meetingId={ID} nomes={{ F1: "Ana" }} />);
    perguntarAgora();
    expect(screen.getByText("Ana disse que o contêiner sai dia 12, e Falante 2 confirmou.")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
  });

  it("cada citação tem o '▶ mm:ss' que leva o player ao ponto; a citação sem tempo fica sem ele", () => {
    duble.respostas.perguntar = RESPOSTA;
    const aoIrPara = vi.fn();
    render(<PergunteAReuniao meetingId={ID} aoIrPara={aoIrPara} />);
    perguntarAgora();
    const citacoes = within(screen.getByRole("list", { name: "Onde isso foi dito" })).getAllByRole("listitem");
    expect(citacoes).toHaveLength(3);
    fireEvent.click(within(citacoes[0]).getByRole("button", { name: "Ouvir a partir de 01:15" }));
    expect(aoIrPara).toHaveBeenCalledWith(75);
    fireEvent.click(within(citacoes[1]).getByRole("button", { name: "Ouvir a partir de 1:02:05" }));
    expect(aoIrPara).toHaveBeenLastCalledWith(3725);
    expect(within(citacoes[2]).queryByRole("button")).not.toBeInTheDocument();
    expect(citacoes[2]).toHaveTextContent("a carga já está no porto desde segunda");
  });

  it("sem player (gravação vencida ou ausente), o tempo é só texto, sem botão de ouvir", () => {
    duble.respostas.perguntar = RESPOSTA;
    render(<PergunteAReuniao meetingId={ID} />);
    perguntarAgora();
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
    expect(screen.getByText("01:15")).toBeInTheDocument();
    expect(screen.getByText("1:02:05")).toBeInTheDocument();
  });

  it("o servidor de antes da H6 manda só o trecho, sem as citações: a tela o mostra sem tempo, em vez de quebrar", () => {
    duble.respostas.perguntar = { respondida: true, resposta: "Na sexta.", trecho: "a entrega fica para sexta" };
    render(<PergunteAReuniao meetingId={ID} aoIrPara={vi.fn()} />);
    perguntarAgora();
    expect(screen.getByText("Na sexta.")).toBeInTheDocument();
    const citacoes = within(screen.getByRole("list", { name: "Onde isso foi dito" })).getAllByRole("listitem");
    expect(citacoes).toHaveLength(1);
    expect(citacoes[0]).toHaveTextContent("a entrega fica para sexta");
    expect(within(citacoes[0]).queryByRole("button")).not.toBeInTheDocument();
  });

  it("link: as vozes levam os nomes que o link recebeu, e a voz sem nome é 'Falante n'; os nomes não vão na pergunta; o '▶' leva o player ao ponto (H3b)", () => {
    duble.respostas.perguntarPeloLink = RESPOSTA;
    const aoIrPara = vi.fn();
    render(<PergunteAReuniao token="AbCdEfGhIjKlMnOpQrStUvWxYz012345" aoIrPara={aoIrPara} nomes={{ F1: "Ana" }} />);
    perguntarAgora();
    expect(screen.getByText("Ana disse que o contêiner sai dia 12, e Falante 2 confirmou.")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
    // O nome só troca o rótulo na tela: o pedido leva o token, o idioma e a pergunta, e mais nada.
    expect(duble.chamadas.perguntarPeloLink).toEqual([{ token: "AbCdEfGhIjKlMnOpQrStUvWxYz012345", idioma: "pt-BR", pergunta: "Qual o prazo?" }]);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 01:15" }));
    expect(aoIrPara).toHaveBeenCalledWith(75);
  });

  it("link sem os nomes (ligado antes da confirmação que fala deles): toda voz é 'Falante n'", () => {
    duble.respostas.perguntarPeloLink = RESPOSTA;
    render(<PergunteAReuniao token="AbCdEfGhIjKlMnOpQrStUvWxYz012345" />);
    perguntarAgora();
    expect(screen.getByText("Falante 1 disse que o contêiner sai dia 12, e Falante 2 confirmou.")).toBeInTheDocument();
  });
});

describe("Pelo link aberto (pages/ReuniaoAberta.tsx)", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("a pergunta vai pelo token, aparada, e a resposta aparece com o trecho", () => {
    duble.respostas.perguntarPeloLink = respondida("Na sexta.", semTempo("a entrega fica para sexta"));
    render(<PergunteAReuniao token={TOKEN} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "  Quando é a entrega?  " } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(duble.chamadas.perguntarPeloLink).toEqual([{ token: TOKEN, idioma: "pt-BR", pergunta: "Quando é a entrega?" }]);
    expect(duble.chamadas.perguntar).toBeUndefined();
    expect(screen.getByText("Na sexta.")).toBeInTheDocument();
    expect(screen.getByText("a entrega fica para sexta")).toBeInTheDocument();
  });

  it("link desligado no meio da visita: a tela diz isso, e não 'reunião não encontrada'", () => {
    duble.respostas.perguntarPeloLink = erroDoServidor("NOT_FOUND", "Este link de reunião não existe ou foi desligado.");
    render(<PergunteAReuniao token={TOKEN} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre a reunião" }), { target: { value: "Quem falou?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
  });

  it("a pergunta recusada pela senha do link (a entrada venceu, H23): a frase traduzida, e a página é avisada para trazer a tela da senha", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    const aoPedirSenha = vi.fn();
    duble.respostas.perguntarPeloLink = erroDoServidor("UNAUTHORIZED", "Este link pede a senha de 6 dígitos.");
    render(<PergunteAReuniao token={TOKEN} aoPedirSenha={aoPedirSenha} />);
    expect(aoPedirSenha).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Your question about the meeting" }), { target: { value: "Who spoke?" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("This link asks for the 6-digit password.");
    expect(aoPedirSenha).toHaveBeenCalledTimes(1);
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
  it("pelo link: sem 'sua rede', que o visitante não tem", () => {
    duble.respostas.perguntarPeloLink = respondida("Sexta.", semTempo("a entrega fica para sexta"));
    render(<PergunteAReuniao token="AbCdEfGhIjKlMnOpQrStUvWxYz012345" />);
    perguntarAgora();
    expect(screen.getByText("Sugestões da IA para conferir com os trechos da transcrição. Nada disto foi gravado.")).toBeInTheDocument();
    expect(screen.queryByText(/sua rede/)).not.toBeInTheDocument();
  });

  it("o convite e o aviso da dona falam dos trechos, no plural: a resposta traz até 3", () => {
    duble.respostas.perguntar = respondida("Sexta.", semTempo("a entrega fica para sexta"));
    render(<PergunteAReuniao meetingId={ID} />);
    expect(screen.getByText("A resposta vem só do que foi dito na reunião, com os trechos da transcrição que a sustentam.")).toBeInTheDocument();
    perguntarAgora();
    expect(screen.getByText(/^Sugestões da IA para você conferir com os trechos da transcrição\./)).toBeInTheDocument();
  });

  it("pela dona: o aviso dela continua", () => {
    duble.respostas.perguntar = respondida("Sexta.", semTempo("a entrega fica para sexta"));
    render(<PergunteAReuniao meetingId={ID} />);
    perguntarAgora();
    expect(screen.getByText(/entra na sua rede sozinho/)).toBeInTheDocument();
  });

  it("a resposta da IA, a pergunta e o trecho seguem a direção deles mesmos", () => {
    duble.respostas.perguntar = respondida("Resposta", semTempo("trecho citado"));
    render(<PergunteAReuniao meetingId={ID} />);
    perguntarAgora();
    for (const texto of ["Resposta", "Qual o prazo?", "trecho citado"]) expect(screen.getByText(texto)).toHaveAttribute("dir", "auto");
  });
});
