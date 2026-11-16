import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { ResumoGuardado } from "./ResumoGuardado";

/**
 * O resumo guardado na tela (H4c): o formato da cliente, as decisões da dona
 * (caixa de feito, Confirmar, Ignorar, Desfazer, Confirmar todos), o "▶" que
 * leva o player ao trecho, os estados do resumo e o modo só de leitura do link
 * aberto. A consulta é da página (ela vem pronta, por props, como o React
 * Query a devolve); as mutações são dublês que registram o mutate e as opções.
 * O que o servidor faz está em server/resumo-guardado.ts e nos testes dele.
 */

type Opcoes = { onError?: (erro: unknown) => void; onSettled?: () => unknown; onSuccess?: (resultado: unknown, variaveis: unknown) => void };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: ReturnType<typeof vi.fn>; opcoes: Opcoes; isPending: boolean; isError: boolean; error: unknown }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), opcoes, isPending: false, isError: false, error: null });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: m.isPending, isError: m.isError, error: m.error };
    },
  });
  return {
    mutacoes,
    registrar,
    utils: {
      meetings: { resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      googleAgenda: { estado: { invalidate: vi.fn() } },
    },
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink") },
    // O "Tentar de novo" do evento que ficou na Google Agenda (H5c, useAvisosDaAgenda).
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
/** O fuso do aparelho e os rótulos da tela, em pt-BR (H5c). */
const PEDIDO = { fuso: expect.any(String), rotulos: { voz: "Falante {n}", responsavel: "Responsável: {nome}" } };
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

// Os itens como a dona os recebe (server/resumo-guardado.ts), fora da ordem do
// formato de propósito: a tela agrupa pelas seções na ordem da cliente.
const ITENS = [
  { id: "i-questao", section: "question", position: 7, subject: null, text: "Quem paga o seguro da carga?", assignee: null, due: null, excerpt: "ainda não sabemos quem paga o seguro da carga", startSeconds: 480, status: "pending", done: false },
  { id: "i-acao", section: "action", position: 0, subject: null, text: "{F2} envia a proposta revisada", assignee: "{F2}", due: "até sexta-feira", excerpt: "eu mando a proposta revisada até sexta-feira", startSeconds: 75, status: "pending", done: false },
  { id: "i-acao-feita", section: "action", position: 1, subject: null, text: "Reservar a sala de reunião", assignee: null, due: null, excerpt: "a sala já está reservada para quinta", startSeconds: 130, status: "confirmed", done: true },
  { id: "i-foco", section: "focus", position: 2, subject: null, text: "A reunião tratou da exportação de café para a Alemanha.", assignee: null, due: null, excerpt: "hoje vamos falar da exportação de café", startSeconds: 5, status: "confirmed", done: false },
  { id: "i-tarefa", section: "task", position: 3, subject: "Contrato com o importador", text: "{F1} fecha o contrato com o importador.", assignee: "{F1}", due: "sexta-feira", excerpt: "eu fecho o contrato com o importador na sexta-feira", startSeconds: 200, status: "pending", done: false },
  { id: "i-decisao", section: "decision", position: 4, subject: null, text: "Não renovar com a transportadora antiga.", assignee: null, due: null, excerpt: "decidimos não renovar com a transportadora", startSeconds: 320, status: "pending", done: false },
  { id: "i-bloqueio", section: "blocker", position: 5, subject: null, text: "A licença de exportação ainda não saiu.", assignee: null, due: null, excerpt: "a licença de exportação ainda não saiu", startSeconds: null, status: "confirmed", done: false },
  { id: "i-ignorado", section: "decision", position: 6, subject: null, text: "Abrir um escritório em Berlim.", assignee: null, due: null, excerpt: "talvez abrir um escritório em Berlim", startSeconds: 400, status: "ignored", done: false },
] as const;
// Pelo link: sem ids, sem a caixa de feito e sem os ignorados.
const ITENS_DO_LINK = ITENS.filter(item => item.status !== "ignored").map(({ id: _id, position: _p, done: _d, ...item }) => item);

const consulta = (data: unknown) => ({ data, isError: false, error: null as unknown, refetch: vi.fn() });
const pronto = (itens: readonly unknown[] = ITENS) => consulta({ estado: "pronto", emoji: "☕", idioma: "pt-BR", erro: null, itens });
const comEstado = (estado: string) => consulta({ estado, emoji: null, idioma: null, erro: null, itens: [] });
// A releitura que falhou: o React Query liga o isError e guarda o dado velho.
const comErro = (c: ReturnType<typeof consulta>, error: unknown) => ({ ...c, isError: true, error });
const ERRO_DO_BANCO = { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } };

type PropsDaDona = Partial<{ nomes: Record<string, string>; aoIrPara: (segundo: number) => void; itemDestacado: string | null }>;
const daDona = (c: ReturnType<typeof consulta>, props: PropsDaDona = {}) =>
  render(<ResumoGuardado meetingId={REUNIAO} consulta={c as never} {...props}/>);
const doLink = (c: ReturnType<typeof consulta>, aoIrPara?: (segundo: number) => void) =>
  render(<ResumoGuardado token={TOKEN} consulta={c as never} aoIrPara={aoIrPara}/>);
const itemDoTexto = (texto: string | RegExp) => screen.getByText(texto).closest("li") as HTMLElement;
const mutacao = (nome: string) => duble.mutacoes[nome];
// O estado de uma mutação antes de a tela desenhar (o registro nasce no primeiro uso).
const preparar = (nome: string, estado: Partial<{ isPending: boolean; isError: boolean; error: unknown }>) => {
  duble.mutacoes[nome] ??= { mutate: vi.fn(), opcoes: {}, isPending: false, isError: false, error: null };
  Object.assign(duble.mutacoes[nome], estado);
};

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) Object.assign(m, { isPending: false, isError: false, error: null });
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Resumo guardado — o formato da cliente, para a dona", () => {
  it("as seções saem na ordem do formato, e só as que têm itens", () => {
    daDona(pronto());
    expect(screen.getAllByRole("heading", { level: 3 }).map(titulo => titulo.textContent)).toEqual([
      "Ações", "Foco do trabalho", "Tarefas e arranjos de trabalho", "Decisões e mudanças de escopo",
      "Bloqueios, dependências e restrições", "Questões pendentes",
    ]);
    // A seção é a lista de baixo do título: a questão fica nas questões, não no topo.
    const secaoDasQuestoes = screen.getByRole("heading", { name: "Questões pendentes" }).closest("section")!;
    expect(within(secaoDasQuestoes).getByText("Quem paga o seguro da carga?")).toBeInTheDocument();
  });

  it("o rótulo da voz vira o nome que a dona deu, e a voz sem nome vira 'Falante n' (no texto e no responsável)", () => {
    daDona(pronto(), { nomes: { F2: "Carla" } });
    const acao = itemDoTexto("Carla envia a proposta revisada");
    expect(within(acao).getByText("Responsável: Carla")).toBeInTheDocument();
    expect(within(acao).getByText("Prazo: até sexta-feira")).toBeInTheDocument();
    const tarefa = itemDoTexto(/Falante 1 fecha o contrato com o importador\./);
    expect(tarefa).toHaveTextContent("Contrato com o importador: Falante 1 fecha o contrato com o importador.");
    expect(within(tarefa).getByText("Responsável: Falante 1")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
  });

  it("a caixa da ação marca e desmarca pelo marcarAcaoFeita, com o id do item", () => {
    daDona(pronto(), { nomes: { F2: "Carla" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Carla envia a proposta revisada" }));
    // Com o fuso e os rótulos da tela: reabrir a ação com prazo a manda de novo à Google Agenda (H5c).
    expect(mutacao("marcarAcaoFeita").mutate).toHaveBeenCalledWith({ itemId: "i-acao", feito: true, ...PEDIDO });
    const feita = screen.getByRole("checkbox", { name: "Reservar a sala de reunião" });
    expect(feita).toBeChecked();
    fireEvent.click(feita);
    expect(mutacao("marcarAcaoFeita").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao-feita", feito: false, ...PEDIDO });
    // Só as ações têm caixa.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("o item pendente tem o selo 'Para conferir' e os botões Confirmar e Ignorar, que decidem pelo id", () => {
    daDona(pronto());
    expect(screen.getAllByText("Para conferir")).toHaveLength(4);
    const decisao = itemDoTexto("Não renovar com a transportadora antiga.");
    fireEvent.click(within(decisao).getByRole("button", { name: "Confirmar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenCalledWith({ itemId: "i-decisao", status: "confirmed" });
    fireEvent.click(within(itemDoTexto("Quem paga o seguro da carga?")).getByRole("button", { name: "Ignorar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-questao", status: "ignored" });
    // O confirmado não tem selo nem botões de decidir.
    const foco = itemDoTexto("A reunião tratou da exportação de café para a Alemanha.");
    expect(within(foco).queryByText("Para conferir")).not.toBeInTheDocument();
    expect(within(foco).queryByRole("button", { name: /Confirmar|Ignorar/ })).not.toBeInTheDocument();
  });

  it("Confirmar, Ignorar e Desfazer se repetem em todo item: o texto do item descreve cada botão (leitor de tela)", () => {
    daDona(pronto(), { nomes: { F2: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar", description: "Não renovar com a transportadora antiga." }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-decisao", status: "confirmed" });
    fireEvent.click(screen.getByRole("button", { name: "Ignorar", description: "Quem paga o seguro da carga?" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-questao", status: "ignored" });
    // Na ação, o texto mora no rótulo da caixa, e é ele que descreve.
    fireEvent.click(screen.getByRole("button", { name: "Confirmar", description: "Carla envia a proposta revisada" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao", status: "confirmed" });
    fireEvent.click(screen.getByRole("button", { name: "Ignorados (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Desfazer", description: "Abrir um escritório em Berlim." }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-ignorado", status: "pending" });
  });

  it("'Confirmar todos (n)' conta os pendentes e confirma pela reunião", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Confirmar todos (4)" }));
    expect(mutacao("confirmarItensDoResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(screen.getByText(/Escrito pela IA a partir da transcrição/)).toBeInTheDocument();
  });

  it("sem pendentes, não há 'Confirmar todos' nem o aviso de conferir", () => {
    daDona(pronto(ITENS.filter(item => item.status !== "pending")));
    expect(screen.queryByRole("button", { name: /Confirmar todos/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Escrito pela IA/)).not.toBeInTheDocument();
  });

  it("os ignorados ficam recolhidos; abertos, o Desfazer volta o item a pendente", () => {
    daDona(pronto());
    expect(screen.queryByText("Abrir um escritório em Berlim.")).not.toBeInTheDocument();
    const recolhidos = screen.getByRole("button", { name: "Ignorados (1)" });
    expect(recolhidos).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(recolhidos);
    expect(recolhidos).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(itemDoTexto("Abrir um escritório em Berlim.")).getByRole("button", { name: "Desfazer" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenCalledWith({ itemId: "i-ignorado", status: "pending" });
  });

  it("desfazer a confirmação de uma ação pede confirmação antes (ela apaga a próxima ação), e então volta o item a pendente", () => {
    daDona(pronto());
    const acao = itemDoTexto("Reservar a sala de reunião");
    // A ação confirmada está em Próximas ações (H5a).
    expect(within(acao).getByRole("link", { name: "Em Próximas ações" })).toHaveAttribute("href", "/proximas-acoes");
    fireEvent.click(within(acao).getByRole("button", { name: "Desfazer a confirmação", description: "Reservar a sala de reunião" }));
    expect(within(acao).getByText(/também apaga a próxima ação criada a partir deste item/)).toBeInTheDocument();
    expect(mutacao("decidirItemDoResumo").mutate).not.toHaveBeenCalled();
    fireEvent.click(within(acao).getByRole("button", { name: "Cancelar" }));
    expect(within(acao).queryByText(/também apaga a próxima ação/)).not.toBeInTheDocument();
    fireEvent.click(within(acao).getByRole("button", { name: "Desfazer a confirmação" }));
    fireEvent.click(within(acao).getByRole("button", { name: "Sim, desfazer" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao-feita", status: "pending" });
  });

  it("o item confirmado que não vira ação (foco, bloqueio) desfaz direto, sem pergunta e sem link de Próximas ações", () => {
    daDona(pronto());
    const foco = itemDoTexto("A reunião tratou da exportação de café para a Alemanha.");
    expect(within(foco).queryByRole("link", { name: "Em Próximas ações" })).not.toBeInTheDocument();
    fireEvent.click(within(foco).getByRole("button", { name: "Desfazer a confirmação" }));
    expect(screen.queryByText(/também apaga a próxima ação/)).not.toBeInTheDocument();
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-foco", status: "pending" });
    // O pendente ainda não tem o que desfazer.
    expect(within(itemDoTexto("Não renovar com a transportadora antiga.")).queryByRole("button", { name: "Desfazer a confirmação" })).not.toBeInTheDocument();
  });

  it("o '▶ mm:ss' leva o player ao segundo do trecho; sem tempo não há botão", () => {
    const aoIrPara = vi.fn();
    daDona(pronto(), { aoIrPara });
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 01:15" }));
    expect(aoIrPara).toHaveBeenCalledWith(75);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 05:20" }));
    expect(aoIrPara).toHaveBeenLastCalledWith(320);
    expect(within(itemDoTexto("A licença de exportação ainda não saiu.")).queryByRole("button", { name: /Ouvir/ })).not.toBeInTheDocument();
  });

  it("sem player, o tempo é só texto: nem botão, nem rótulo de 'Ouvir'", () => {
    const { unmount } = daDona(pronto());
    const tempo = within(itemDoTexto("Não renovar com a transportadora antiga.")).getByText("05:20");
    expect(tempo.closest("button")).toBeNull();
    expect(screen.queryByLabelText(/Ouvir a partir de/)).not.toBeInTheDocument();
    unmount();
    // Pelo link sem gravação não sobra botão nenhum: nem de decidir, nem de ouvir.
    doLink(pronto(ITENS_DO_LINK));
    expect(screen.getByText("03:20")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("o trecho fica aberto nos pendentes e recolhível nos outros", () => {
    daDona(pronto());
    const trechoPendente = screen.getByText("decidimos não renovar com a transportadora");
    expect(trechoPendente.closest("details")).toBeNull();
    const trechoConfirmado = screen.getByText("hoje vamos falar da exportação de café");
    const recolhivel = trechoConfirmado.closest("details")!;
    expect(recolhivel).not.toBeNull();
    expect(recolhivel.open).toBe(false);
    expect(within(recolhivel).getByText("Trecho da transcrição")).toBeInTheDocument();
  });

  it("as mutações relêem o resumo da reunião, e o onSettled devolve a própria releitura", () => {
    // A promessa sentinela prova que o onSettled devolve a releitura, e não só
    // a dispara: é a espera por ela que segura o botão até o estado novo.
    const releitura = Promise.resolve();
    duble.utils.meetings.resumoGuardado.invalidate.mockReturnValue(releitura);
    daDona(pronto());
    for (const nome of ["pedirResumo", "decidirItemDoResumo", "confirmarItensDoResumo", "marcarAcaoFeita"]) expect(mutacao(nome).opcoes.onSettled?.()).toBe(releitura);
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledTimes(4);
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(duble.utils.reuniaoAberta.resumoGuardado.invalidate).not.toHaveBeenCalled();
  });

  it("a decisão recusada pelo servidor vira a frase traduzida, no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    daDona(pronto());
    const { onError } = mutacao("decidirItemDoResumo").opcoes;
    act(() => onError!({ message: MENSAGEM_RESUMO_SENDO_GERADO, data: { code: "CONFLICT" } }));
    expect(toast.error).toHaveBeenLastCalledWith("This meeting's summary is being regenerated. Wait for it to finish before deciding.");
    act(() => onError!({ message: MENSAGEM_ITEM_NAO_ENCONTRADO, data: { code: "NOT_FOUND" } }));
    expect(toast.error).toHaveBeenLastCalledWith("This summary item no longer exists. Refresh the page.");
    act(() => mutacao("marcarAcaoFeita").opcoes.onError!({ message: MENSAGEM_SO_ACAO_TEM_CAIXA, data: { code: "BAD_REQUEST" } }));
    expect(toast.error).toHaveBeenLastCalledWith("Only the summary's actions have a checkbox.");
    act(() => mutacao("confirmarItensDoResumo").opcoes.onError!({ message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } }));
    expect(toast.error).toHaveBeenLastCalledWith("Database unavailable; please try again in a moment");
    act(() => onError!(new Error("Failed to fetch")));
    expect(toast.error).toHaveBeenLastCalledWith("Could not save. Please try again.");
  });
});

describe("Resumo guardado — os estados", () => {
  it("sem resumo: 'Gerar resumo' pede o resumo da reunião", () => {
    daDona(comEstado("sem_resumo"));
    expect(screen.getByText("Esta reunião ainda não tem resumo.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));
    expect(mutacao("pedirResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(mutacao("pedirResumoPeloLink").mutate).not.toHaveBeenCalled();
  });

  it.each(["pendente", "gerando"])("%s: o aviso de que a IA está escrevendo, sem itens nem botões", estado => {
    daDona(comEstado(estado));
    expect(screen.getByRole("status")).toHaveTextContent("A IA está escrevendo o resumo desta reunião.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("falhou: o aviso e 'Tentar de novo', que pede o resumo outra vez", () => {
    daDona(comEstado("falhou"));
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível gerar o resumo desta reunião.");
    fireEvent.click(within(alerta).getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
  });

  it("pronto, mas sem nenhum item para mostrar: diz isso", () => {
    daDona(pronto([]));
    expect(screen.getByText("Nenhum item para mostrar neste resumo.")).toBeInTheDocument();
  });

  it("carregando: o aviso de carregar, nunca 'sem resumo'", () => {
    daDona(consulta(undefined));
    expect(screen.getByRole("status")).toHaveTextContent("Carregando o resumo…");
    expect(screen.queryByText("Esta reunião ainda não tem resumo.")).not.toBeInTheDocument();
  });

  it("erro de consulta é ErroDeConsulta, com tentar de novo, nunca 'sem resumo'", () => {
    const refetch = vi.fn();
    daDona({ data: undefined, isError: true, error: { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch } as never);
    expect(screen.getByRole("alert")).toHaveTextContent("Banco de dados indisponível; tente de novo em instantes");
    expect(screen.queryByText("Esta reunião ainda não tem resumo.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gerar resumo/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each(["pendente", "gerando"])("%s com a releitura falhando (banco fora do ar): o erro no lugar do aviso de que a IA escreve, com tentar de novo", estado => {
    const c = comErro(comEstado(estado), ERRO_DO_BANCO);
    daDona(c);
    expect(screen.getByRole("alert")).toHaveTextContent("Banco de dados indisponível; tente de novo em instantes");
    expect(screen.queryByText(/A IA está escrevendo/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(c.refetch).toHaveBeenCalledTimes(1);
  });

  it("pronto com a releitura falhando: os itens ficam, e o erro vai acima deles, com tentar de novo", () => {
    const c = comErro(pronto(), ERRO_DO_BANCO);
    daDona(c);
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Banco de dados indisponível; tente de novo em instantes");
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(6);
    expect(within(itemDoTexto("Não renovar com a transportadora antiga.")).getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(alerta.compareDocumentPosition(screen.getByRole("heading", { name: "Ações" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(alerta).getByRole("button", { name: "↻ Tentar novamente" }));
    expect(c.refetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sem_resumo", "Esta reunião ainda não tem resumo.", /Gerar resumo/],
    ["falhou", "Não foi possível gerar o resumo desta reunião.", /Tentar de novo/],
  ])("%s com a releitura falhando: o aviso e o botão de pedir ficam, com o erro junto", (estado, texto, botao) => {
    daDona(comErro(comEstado(estado), ERRO_DO_BANCO));
    expect(screen.getByText(texto)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: botao })).toBeInTheDocument();
    expect(screen.getByText("Banco de dados indisponível; tente de novo em instantes")).toBeInTheDocument();
  });

  it("o erro do pedido fica só onde está o botão de pedir: o resumo que anda por outro caminho o tira da tela", () => {
    preparar("pedirResumo", { isError: true, error: { message: "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.", data: { code: "TOO_MANY_REQUESTS" } } });
    const { rerender } = daDona(comEstado("falhou"));
    expect(screen.getByText("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.")).toBeInTheDocument();
    for (const c of [comEstado("pendente"), comEstado("gerando"), pronto()]) {
      rerender(<ResumoGuardado meetingId={REUNIAO} consulta={c as never}/>);
      expect(screen.queryByText(/Muitos pedidos em sequência/)).not.toBeInTheDocument();
    }
  });

  it("o pedido que o servidor recusa mostra o motivo traduzido (o teto de pedidos à IA)", () => {
    preparar("pedirResumo", { isError: true, error: { message: "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.", data: { code: "TOO_MANY_REQUESTS" } } });
    daDona(comEstado("sem_resumo"));
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
  });

  it("enquanto o pedido está no ar, o botão fica desligado (um pedido por vez)", () => {
    preparar("pedirResumo", { isPending: true });
    daDona(comEstado("sem_resumo"));
    expect(screen.getByRole("button", { name: /Gerar resumo/ })).toBeDisabled();
  });
});

describe("Resumo guardado — pelo link aberto, só leitura", () => {
  it("as vozes levam os nomes que o link recebeu, a voz sem nome é 'Falante n', e os pendentes levam o aviso de que a dona ainda não conferiu (H3b)", () => {
    render(<ResumoGuardado token={TOKEN} consulta={pronto(ITENS_DO_LINK) as never} nomes={{ F2: "Carla" }}/>);
    expect(screen.getByText("Carla envia a proposta revisada")).toBeInTheDocument();
    expect(screen.getByText("Responsável: Carla")).toBeInTheDocument();
    expect(itemDoTexto(/Falante 1 fecha o contrato com o importador\./)).toHaveTextContent("Responsável: Falante 1");
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Gerado pela IA; a dona da reunião ainda não conferiu.")).toHaveLength(4);
    expect(within(itemDoTexto("A reunião tratou da exportação de café para a Alemanha.")).queryByText(/a dona da reunião ainda não conferiu/)).not.toBeInTheDocument();
  });

  it("sem os nomes (o link ligado antes da confirmação que fala deles), toda voz é 'Falante n'", () => {
    doLink(pronto(ITENS_DO_LINK));
    expect(itemDoTexto(/Falante 1 fecha o contrato com o importador\./)).toHaveTextContent("Responsável: Falante 1");
    expect(screen.getByText("Falante 2 envia a proposta revisada")).toBeInTheDocument();
    expect(screen.getByText("Responsável: Falante 2")).toBeInTheDocument();
  });

  it("sem os botões de decidir: nem caixa, nem Confirmar, Ignorar, Confirmar todos ou os ignorados; só o '▶'", () => {
    const aoIrPara = vi.fn();
    doLink(pronto(ITENS_DO_LINK), aoIrPara);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Para conferir")).not.toBeInTheDocument();
    expect(screen.queryByText(/Escrito pela IA/)).not.toBeInTheDocument();
    const botoes = screen.getAllByRole("button");
    expect(botoes.length).toBeGreaterThan(0);
    for (const botao of botoes) expect(botao).toHaveAccessibleName(/^Ouvir a partir de /);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 03:20" }));
    expect(aoIrPara).toHaveBeenCalledWith(200);
  });

  it("sem resumo: 'Pedir resumo' pede pelo token, nunca pela rota da dona; e relê o resumo do link", () => {
    doLink(comEstado("sem_resumo"));
    fireEvent.click(screen.getByRole("button", { name: /Pedir resumo/ }));
    expect(mutacao("pedirResumoPeloLink").mutate).toHaveBeenCalledWith({ token: TOKEN });
    expect(mutacao("pedirResumo").mutate).not.toHaveBeenCalled();
    const releitura = Promise.resolve();
    duble.utils.reuniaoAberta.resumoGuardado.invalidate.mockReturnValue(releitura);
    expect(mutacao("pedirResumoPeloLink").opcoes.onSettled?.()).toBe(releitura);
    expect(duble.utils.reuniaoAberta.resumoGuardado.invalidate).toHaveBeenCalledWith({ token: TOKEN });
  });

  it("o link desligado no meio da visita diz isso, e não 'reunião não encontrada'", () => {
    doLink({ data: undefined, isError: true, error: { message: "Este link de reunião não existe ou foi desligado.", data: { code: "NOT_FOUND" } }, refetch: vi.fn() } as never);
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
  });

  it.each(["NOT_FOUND", "BAD_REQUEST"])("o link desligado ou cortado (%s), com ou sem o resumo velho no cache: o aviso do link, nunca o 'gerando' nem o tentar de novo", codigo => {
    const erro = { message: "Este link de reunião não existe ou foi desligado.", data: { code: codigo } };
    for (const c of [consulta(undefined), comEstado("gerando")]) {
      const { unmount } = doLink(comErro(c, erro));
      expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("Resumo guardado — o item pedido pelo link (?item)", () => {
  const rolados: Element[] = [];
  beforeEach(() => {
    rolados.length = 0;
    // O jsdom não rola: o dublê guarda quem pediu.
    Element.prototype.scrollIntoView = function (this: Element) { rolados.push(this); };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("destaca o item e rola até ele, uma vez", () => {
    const { rerender } = daDona(pronto(), { itemDestacado: "i-decisao" });
    const item = itemDoTexto("Não renovar com a transportadora antiga.");
    expect(item).toHaveAttribute("data-destacado", "true");
    expect(rolados).toEqual([item]);
    expect(item).toHaveFocus();
    expect(document.querySelectorAll("[data-destacado]")).toHaveLength(1);
    rerender(<ResumoGuardado meetingId={REUNIAO} consulta={pronto() as never} itemDestacado="i-decisao"/>);
    expect(rolados).toHaveLength(1);
  });

  it("o item ignorado: a lista recolhida abre para mostrá-lo", () => {
    daDona(pronto(), { itemDestacado: "i-ignorado" });
    expect(screen.getByRole("button", { name: "Ignorados (1)" })).toHaveAttribute("aria-expanded", "true");
    const item = itemDoTexto("Abrir um escritório em Berlim.");
    expect(item).toHaveAttribute("data-destacado", "true");
    expect(rolados).toEqual([item]);
  });

  it("o item que não está mais no resumo: um aviso, e nada destacado", () => {
    daDona(pronto(), { itemDestacado: "item-que-sumiu" });
    expect(screen.getByText("O item deste link não está mais no resumo.")).toBeInTheDocument();
    expect(document.querySelector("[data-destacado]")).toBeNull();
    expect(rolados).toEqual([]);
  });

  it("enquanto o resumo é gerado, não há aviso de item sumido: ele ainda vai chegar", () => {
    daDona(comEstado("gerando"), { itemDestacado: "i-decisao" });
    expect(screen.queryByText("O item deste link não está mais no resumo.")).not.toBeInTheDocument();
  });
});

describe("Resumo guardado — a próxima ação do item na Google Agenda (H5c)", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear();
    duble.utils.googleAgenda.estado.invalidate.mockClear();
    mutacao("tirarDaGoogle")?.mutate.mockClear();
  });

  it("desconfirmar o item cuja ação ficou na Google porque ela falhou: o aviso traz 'Tentar de novo', que tira o evento pela ação", () => {
    daDona(pronto());
    act(() => mutacao("decidirItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "falhou", motivo: "google" }, { itemId: "i-acao-feita", status: "pending" }));
    const [texto, opcoes] = vi.mocked(toast.warning).mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void } }];
    expect(texto).toBe("O evento desta ação continua na sua Google Agenda. A Google não respondeu. Tente de novo em instantes.");
    expect(opcoes.action.label).toBe("Tentar de novo");
    // A ação já saiu do banco (ou está feita): nenhuma lista oferece a retirada, só este aviso.
    act(() => opcoes.action.onClick());
    expect(mutacao("tirarDaGoogle").mutate).toHaveBeenCalledWith({ id: "acao-9" });
  });

  it("quando só reconectar resolve, o aviso manda apagar por lá e o estado da conexão é relido; reabrir que não chega à Google diz o porquê", () => {
    daDona(pronto());
    act(() => mutacao("marcarAcaoFeita").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "falhou", motivo: "revogada" }, { itemId: "i-acao", feito: true }));
    expect(toast.warning).toHaveBeenLastCalledWith("O evento desta ação continua na sua Google Agenda. Se quiser, apague o evento por lá.", { duration: 15_000 });
    expect(duble.utils.googleAgenda.estado.invalidate).toHaveBeenCalled();
    act(() => mutacao("marcarAcaoFeita").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "falhou", motivo: "google" }, { itemId: "i-acao-feita", feito: false }));
    expect(toast.warning).toHaveBeenLastCalledWith(
      "A ação está salva na WRW, mas não foi para a sua Google Agenda. A Google não respondeu. Tente de novo em instantes.", { duration: 10_000 });
  });

  it("deu certo, ou o item não tinha ação com evento: nenhum aviso", () => {
    daDona(pronto());
    act(() => mutacao("decidirItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "ok" }, { itemId: "i-acao-feita", status: "pending" }));
    act(() => mutacao("decidirItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: null, naGoogle: null }, { itemId: "i-decisao", status: "confirmed" }));
    act(() => mutacao("marcarAcaoFeita").opcoes.onSuccess!({ ok: true, acaoId: null, naGoogle: null }, { itemId: "i-acao", feito: false }));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
