import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { PERGUNTAS_ENTRE_REUNIOES_EM_24H, RECUSAS_ENTRE_REUNIOES } from "@shared/perguntar-a-varias-reunioes";
import { fusoDoAparelho } from "@shared/agenda";
import { PergunteAVariasReunioes } from "./PergunteAVariasReunioes";

/**
 * O Pergunte a várias reuniões (H6c) na tela: a escolha por etiqueta e uma a
 * uma, a pergunta, a resposta com o número de fontes, os trechos de cada
 * reunião (o "▶" abre a reunião no ponto), as vozes com o nome dado em cada
 * reunião, o que ficou de fora, o visual (H6d) e a avaliação. O React Query e
 * os hooks do tRPC são os de verdade; a rede é um link falso, que responde
 * pela rota. O servidor está em server/perguntar-a-varias-reunioes*.test.ts.
 */
const AGORA = Date.UTC(2026, 10, 20);
const IDS = ["b1b1b1b1-0000-4000-8000-000000000001", "b1b1b1b1-0000-4000-8000-000000000002", "b1b1b1b1-0000-4000-8000-000000000003"];
const LISTA = [
  { id: IDS[0], titulo: "Contrato do café", criadaEm: AGORA, etiquetas: ["Clientes"], origem: "gravacao", caracteres: 60_000 },
  { id: IDS[1], titulo: "Frete", criadaEm: AGORA - 86_400_000, etiquetas: ["clientes", "Logística"], origem: "gravacao", caracteres: 30_000 },
  { id: IDS[2], titulo: "Mentoria", criadaEm: AGORA - 2 * 86_400_000, etiquetas: [], origem: "arquivo", caracteres: 500_000 },
];
const RESPOSTA = {
  perguntaId: "c1c1c1c1-0000-4000-8000-000000000001", respondida: true,
  resposta: "{R1:F1} adiou o frete, e {R2:F1} fecha o contrato.",
  citacoes: [
    { reuniao: 1, meetingId: IDS[1], trecho: "O frete marítimo ficou para a semana que vem", inicioSegundos: 40 },
    { reuniao: 2, meetingId: IDS[0], trecho: "Eu fecho o contrato de exportação de café", inicioSegundos: null },
  ],
  visual: null,
  reunioes: [
    { numero: 1, meetingId: IDS[1], titulo: "Frete", criadaEm: AGORA - 86_400_000, nomes: {}, citada: true },
    { numero: 2, meetingId: IDS[0], titulo: "Contrato do café", criadaEm: AGORA, nomes: { F1: "Glória" }, citada: true },
  ],
  deFora: [{ meetingId: IDS[2], titulo: "Mentoria", motivo: "limite" }],
  escolhidas: 3, alemDoMaximo: 0, ordem: "relevancia",
};

const rede = {
  chamadas: [] as Array<{ path: string; input: unknown }>,
  respostas: {} as Record<string, unknown | Error>,
};
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    const resposta = rede.respostas[op.path];
    void Promise.resolve().then(() => {
      if (resposta === undefined) return observer.error(TRPCClientError.from(new Error(`rota não simulada: ${op.path}`)));
      if (resposta instanceof Error) return observer.error(resposta as never);
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    });
    return () => undefined;
  });
}
const erroDoServidor = (code: string, message: string, httpStatus = 429) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus } } });
const chamadas = (rota: string) => rede.chamadas.filter(c => c.path === `perguntasEntreReunioes.${rota}`).map(c => c.input);

const aoFechar = vi.fn();
const aoAbrir = vi.fn();
function abrir() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <PergunteAVariasReunioes aoFechar={aoFechar} aoAbrir={aoAbrir} />
    </QueryClientProvider>
  </trpc.Provider>);
}
const perguntarAgora = (texto = "O que ficou combinado?") => {
  fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre as reuniões escolhidas" }), { target: { value: texto } });
  fireEvent.click(screen.getByRole("button", { name: /^Perguntar$/ }));
};

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "perguntasEntreReunioes.reunioes": LISTA };
  aoFechar.mockReset();
  aoAbrir.mockReset();
});
afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Perguntar a várias reuniões — a escolha", () => {
  it("por etiqueta: as etiquetas da dona, sem repetir pela caixa; escolher uma mostra quantas reuniões e as horas de fala", async () => {
    abrir();
    const etiquetas = await screen.findByRole("list", { name: "Etiquetas das suas reuniões" });
    expect(within(etiquetas).getAllByRole("button").map(b => b.textContent)).toEqual(["Clientes", "Logística"]);
    expect(screen.getByRole("button", { name: /^Perguntar$/ })).toBeDisabled();
    fireEvent.click(within(etiquetas).getByRole("button", { name: "Clientes" }));
    expect(screen.getByText("Reuniões prontas com as etiquetas escolhidas: 2")).toBeInTheDocument();
    expect(screen.getByText("Cerca de 1,5 h de fala.")).toBeInTheDocument();
  });

  it("pela etiqueta, a pergunta vai com a etiqueta e o idioma da tela", async () => {
    rede.respostas["perguntasEntreReunioes.perguntar"] = RESPOSTA;
    abrir();
    fireEvent.click(within(await screen.findByRole("list", { name: "Etiquetas das suas reuniões" })).getByRole("button", { name: "Clientes" }));
    perguntarAgora();
    await screen.findByText("Fontes: 2 de 2 reuniões lidas");
    expect(chamadas("perguntar")).toEqual([{ etiquetas: ["Clientes"], idioma: "pt-BR", pergunta: "O que ficou combinado?", fuso: fusoDoAparelho() }]);
  });

  it("várias etiquetas (T52): entram as reuniões com qualquer uma delas, sem repetir; tocar de novo tira a etiqueta; a pergunta vai com todas", async () => {
    rede.respostas["perguntasEntreReunioes.perguntar"] = RESPOSTA;
    abrir();
    const etiquetas = await screen.findByRole("list", { name: "Etiquetas das suas reuniões" });
    expect(screen.getByText(/Toque em uma ou mais etiquetas/)).toBeInTheDocument();
    fireEvent.click(within(etiquetas).getByRole("button", { name: "Logística" }));
    expect(screen.getByText("Reuniões prontas com as etiquetas escolhidas: 1")).toBeInTheDocument();
    // "Frete" tem as duas: conta uma vez só.
    fireEvent.click(within(etiquetas).getByRole("button", { name: "Clientes" }));
    expect(within(etiquetas).getByRole("button", { name: "Logística" })).toHaveAttribute("aria-pressed", "true");
    expect(within(etiquetas).getByRole("button", { name: "Clientes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Reuniões prontas com as etiquetas escolhidas: 2")).toBeInTheDocument();
    expect(screen.getByText("Cerca de 1,5 h de fala.")).toBeInTheDocument();
    perguntarAgora();
    await screen.findByText("Fontes: 2 de 2 reuniões lidas");
    expect(chamadas("perguntar")).toEqual([{ etiquetas: ["Logística", "Clientes"], idioma: "pt-BR", pergunta: "O que ficou combinado?", fuso: fusoDoAparelho() }]);
    // Tocar de novo tira a etiqueta.
    fireEvent.click(within(etiquetas).getByRole("button", { name: "Clientes" }));
    expect(within(etiquetas).getByRole("button", { name: "Clientes" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Reuniões prontas com as etiquetas escolhidas: 1")).toBeInTheDocument();
  });

  it("o pedido de tabela ou gráfico (passo 2 do T52) tem a ajuda na tela", async () => {
    abrir();
    await screen.findByRole("list", { name: "Etiquetas das suas reuniões" });
    expect(screen.getByText(/Para ver em tabela ou gráfico, peça na pergunta/)).toBeInTheDocument();
  });

  it("uma a uma: pede ao menos duas; a pergunta vai com os ids; acima de ~7 h, avisa que a IA lê primeiro as mais ligadas", async () => {
    rede.respostas["perguntasEntreReunioes.perguntar"] = RESPOSTA;
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Uma a uma" }));
    const lista = screen.getByRole("list", { name: "Uma a uma" });
    fireEvent.click(within(lista).getByRole("checkbox", { name: /Contrato do café/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre as reuniões escolhidas" }), { target: { value: "O que ficou combinado?" } });
    expect(screen.getByRole("button", { name: /^Perguntar$/ })).toBeDisabled();
    expect(screen.getByText("Escolha uma ou mais etiquetas, ou pelo menos duas reuniões.")).toBeInTheDocument();
    fireEvent.click(within(lista).getByRole("checkbox", { name: /Mentoria/ }));
    expect(screen.getByText("Escolhidas: 2 (até 30)")).toBeInTheDocument();
    expect(screen.getByText(/a IA lê primeiro as reuniões mais ligadas à pergunta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Perguntar$/ }));
    await screen.findByText("Fontes: 2 de 2 reuniões lidas");
    expect(chamadas("perguntar")).toEqual([{ meetingIds: [IDS[0], IDS[2]], idioma: "pt-BR", pergunta: "O que ficou combinado?", fuso: fusoDoAparelho() }]);
  });

  it("uma a uma: a linha da estimativa já ocupa o seu lugar antes da escolha; marcar a primeira não empurra o campo da pergunta", async () => {
    const { container } = abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Uma a uma" }));
    const linha = container.querySelector("[data-estimativa]");
    expect(linha).not.toBeNull();
    expect(linha).toHaveTextContent("");
    expect(linha!.classList.contains("min-h-4")).toBe(true);
    fireEvent.click(within(screen.getByRole("list", { name: "Uma a uma" })).getByRole("checkbox", { name: /Frete/ }));
    // O mesmo nó, agora com o texto: nada novo entra acima do campo.
    expect(container.querySelector("[data-estimativa]")).toBe(linha);
    expect(linha).toHaveTextContent("Cerca de 0,5 h de fala.");
  });

  it("o filtro pelo título reduz a lista", async () => {
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Uma a uma" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filtrar pelo título" }), { target: { value: "fre" } });
    expect(within(screen.getByRole("list", { name: "Uma a uma" })).getAllByRole("checkbox")).toHaveLength(1);
  });

  it("sem reunião pronta, diz isso; a consulta que falha é erro, nunca \"nenhuma reunião\"", async () => {
    rede.respostas["perguntasEntreReunioes.reunioes"] = [];
    abrir();
    expect(await screen.findByText(/Nenhuma reunião pronta para perguntar ainda/)).toBeInTheDocument();
    cleanup();
    rede.respostas["perguntasEntreReunioes.reunioes"] = erroDoServidor("INTERNAL_SERVER_ERROR", "Erro ao consultar o banco de dados", 500);
    abrir();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma reunião pronta para perguntar ainda/)).not.toBeInTheDocument();
  });

  it("o Esc e o \"Fechar\" fecham", async () => {
    abrir();
    await screen.findByRole("list", { name: "Etiquetas das suas reuniões" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(aoFechar).toHaveBeenCalledTimes(2);
  });
});

describe("Perguntar a várias reuniões — a resposta", () => {
  async function perguntarPelaEtiqueta(resposta: unknown = RESPOSTA) {
    rede.respostas["perguntasEntreReunioes.perguntar"] = resposta;
    abrir();
    fireEvent.click(within(await screen.findByRole("list", { name: "Etiquetas das suas reuniões" })).getByRole("button", { name: "Clientes" }));
    perguntarAgora();
  }

  it("as vozes viram o nome dado NAQUELA reunião, ou o rótulo com a reunião; as fontes, os trechos e o que ficou de fora", async () => {
    await perguntarPelaEtiqueta();
    const resposta = await screen.findByRole("region", { name: "Resposta sobre as reuniões escolhidas" });
    expect(within(resposta).getByText("Falante 1 (reunião 1) adiou o frete, e Glória fecha o contrato.")).toBeInTheDocument();
    expect(within(resposta).getByText("Fontes: 2 de 2 reuniões lidas")).toBeInTheDocument();
    expect(within(resposta).getByText("[1] Frete")).toBeInTheDocument();
    expect(within(resposta).getByText("O frete marítimo ficou para a semana que vem")).toBeInTheDocument();
    expect(within(resposta).getAllByText("citada")).toHaveLength(2);
    expect(within(resposta).getByText(/As escolhidas passavam do limite: a IA leu primeiro as mais ligadas à pergunta/)).toBeInTheDocument();
    expect(within(resposta).getByText("Ficaram de fora")).toBeInTheDocument();
    expect(within(resposta).getByText(/não coube no limite de cerca de 7 h de fala por pergunta/)).toBeInTheDocument();
    expect(within(resposta).getByText(/A pergunta e a resposta não ficam guardadas/)).toBeInTheDocument();
  });

  it("o ▶ do trecho abre a reunião naquele segundo; a fonte abre a reunião", async () => {
    await perguntarPelaEtiqueta();
    fireEvent.click(await screen.findByRole("button", { name: "Ouvir a partir de 00:40" }));
    expect(aoAbrir).toHaveBeenLastCalledWith(`/meetings/${IDS[1]}?t=40`);
    fireEvent.click(screen.getByRole("button", { name: "Abrir a reunião Contrato do café" }));
    expect(aoAbrir).toHaveBeenLastCalledWith(`/meetings/${IDS[0]}`);
  });

  it("a avaliação vai com o id da pergunta; avaliada, a tela confirma", async () => {
    rede.respostas["perguntasEntreReunioes.avaliar"] = { avaliacao: "boa" };
    await perguntarPelaEtiqueta();
    fireEvent.click(await screen.findByRole("button", { name: "Ajudou" }));
    await screen.findByText("Avaliação guardada.");
    expect(chamadas("avaliar")).toEqual([{ perguntaId: RESPOSTA.perguntaId, nota: "boa" }]);
    expect(screen.getByRole("button", { name: "Ajudou" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a avaliação que falha diz isso, sem marcar", async () => {
    rede.respostas["perguntasEntreReunioes.avaliar"] = erroDoServidor("NOT_FOUND", RECUSAS_ENTRE_REUNIOES.perguntaNaoEncontrada, 404);
    await perguntarPelaEtiqueta();
    fireEvent.click(await screen.findByRole("button", { name: "Não ajudou" }));
    await screen.findByText("Não foi possível guardar a avaliação.");
    expect(screen.getByRole("button", { name: "Não ajudou" })).toHaveAttribute("aria-pressed", "false");
  });

  it("a não respondida diz isso, com as reuniões que a IA leu", async () => {
    await perguntarPelaEtiqueta({ ...RESPOSTA, respondida: false, resposta: "", citacoes: [], reunioes: RESPOSTA.reunioes.map(r => ({ ...r, citada: false })), deFora: [], ordem: "todas" });
    expect(await screen.findByText("As transcrições das reuniões escolhidas não respondem a esta pergunta.")).toBeInTheDocument();
    expect(screen.queryByText("citada")).not.toBeInTheDocument();
    expect(screen.getByText("Reuniões lidas")).toBeInTheDocument();
  });

  it("o visual (H6d) vem com as vozes de cada reunião", async () => {
    await perguntarPelaEtiqueta({
      ...RESPOSTA,
      visual: { tipo: "tabela", titulo: "Quem fez o quê", colunas: ["Quem", "O quê"], linhas: [["{R2:F1}", "contrato"], ["{R1:F1}", "frete"]] },
    });
    const tabela = await screen.findByRole("table");
    expect(within(tabela).getByRole("rowheader", { name: "Glória" })).toBeInTheDocument();
    expect(within(tabela).getByRole("rowheader", { name: "Falante 1 (reunião 1)" })).toBeInTheDocument();
  });

  it.each([
    [RECUSAS_ENTRE_REUNIOES.tetoDiario, "TOO_MANY_REQUESTS", `Você chegou ao limite de ${PERGUNTAS_ENTRE_REUNIOES_EM_24H} perguntas a várias reuniões em 24 horas. Tente de novo mais tarde.`],
    [RECUSAS_ENTRE_REUNIOES.naoEncontrada, "NOT_FOUND", "Uma das reuniões escolhidas não foi encontrada. Feche, atualize a lista e escolha de novo."],
    [RECUSAS_ENTRE_REUNIOES.semReuniao, "PRECONDITION_FAILED", "Nenhuma reunião pronta tem as etiquetas escolhidas."],
    [RECUSAS_ENTRE_REUNIOES.longasDemais, "PAYLOAD_TOO_LARGE", "Cada reunião escolhida passa, sozinha, do limite de cerca de 7 h de fala por pergunta."],
    ["O serviço de IA não respondeu agora. Tente de novo em instantes.", "SERVICE_UNAVAILABLE", "O serviço de IA não respondeu agora. Tente de novo em instantes."],
  ])("a recusa %s sai traduzida", async (mensagem, codigo, texto) => {
    await perguntarPelaEtiqueta(erroDoServidor(codigo, mensagem));
    expect(await screen.findByText(texto)).toBeInTheDocument();
  });

  it("em árabe, os textos da escolha e da resposta saem traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    rede.respostas["perguntasEntreReunioes.perguntar"] = RESPOSTA;
    abrir();
    expect(await screen.findByRole("heading", { name: "اسألي عدة اجتماعات" })).toBeInTheDocument();
    fireEvent.click(within(await screen.findByRole("list", { name: "وسوم اجتماعاتك" })).getByRole("button", { name: "Clientes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "سؤالك عن الاجتماعات المختارة" }), { target: { value: "ما الذي تقرر؟" } });
    fireEvent.click(screen.getByRole("button", { name: /^اسأل$/ }));
    await waitFor(() => expect(chamadas("perguntar")).toEqual([{ etiquetas: ["Clientes"], idioma: "ar", pergunta: "ما الذي تقرر؟", fuso: fusoDoAparelho() }]));
    expect(await screen.findByText("المصادر: 2 من 2 من الاجتماعات المقروءة")).toBeInTheDocument();
  });
});
