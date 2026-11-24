import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { instalarSinteseFalsa } from "@/test/sintese-falsa";
import { MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
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
      // H4e: os modelos da dona (vazio) e a pergunta do tamanho.
      modelosDeResumo: { useQuery: () => ({ data: undefined, isError: false, error: null }) },
      responderTamanhoDoResumo: { useMutation: () => ({ mutate: () => undefined, isPending: false, isError: false, error: null }) },
      pedirResumo: duble.registrar("pedirResumo"),
      refazerResumo: duble.registrar("refazerResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      // O grupo voz: baixar o áudio do resumo (H19b) e o complemento pela busca (H4i).
      audioDoResumo: duble.registrar("audioDoResumo"),
      pedirComplemento: duble.registrar("pedirComplemento"),
      decidirComplemento: duble.registrar("decidirComplemento"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      // As do formulário do item (H4f), que só monta quando a dona o abre.
      editarItemDoResumo: duble.registrar("editarItemDoResumo"),
      acrescentarItemDoResumo: duble.registrar("acrescentarItemDoResumo"),
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

type PropsDaDona = Partial<{ nomes: Record<string, string>; falantes: readonly string[]; aoIrPara: (segundo: number) => void; itemDestacado: string | null }>;
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
    // Pelo link sem gravação não sobra botão de decidir nem de ouvir a
    // gravação: só o "Ouvir o resumo" (H19), que lê com a voz do aparelho e não
    // depende dela.
    doLink(pronto(ITENS_DO_LINK));
    expect(screen.getByText("03:20")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" })]);
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

describe("Resumo guardado — a dona edita e acrescenta itens (H4f)", () => {
  // O item que a dona acrescentou (sem trecho e sem tempo) e o foco que ela editou.
  const DA_DONA = { id: "i-da-dona", section: "action", position: 8, subject: null, text: "Ligar para o importador", assignee: null, due: "amanhã", excerpt: "", startSeconds: null, status: "confirmed", done: false, origin: "owner", editedAt: null };
  const COM_ORIGEM = [...ITENS.map(item => ({ ...item, origin: "ai", editedAt: item.id === "i-foco" ? 1_800_000_000_000 : null })), DA_DONA];
  const opcoesDaLista = () => Array.from(document.getElementById(screen.getByLabelText("Responsável").getAttribute("list") ?? "")?.querySelectorAll("option") ?? [])
    .map(opcao => opcao.getAttribute("value"));

  it("todo item visível tem 'Editar', descrito pelo texto do item; o ignorado, não", () => {
    daDona(pronto(COM_ORIGEM), { nomes: { F2: "Carla" } });
    expect(screen.getAllByRole("button", { name: "Editar" })).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Editar", description: "Não renovar com a transportadora antiga." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar", description: "Ligar para o importador" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ignorados (1)" }));
    expect(within(itemDoTexto("Abrir um escritório em Berlim.")).queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
  });

  it("o item que a dona acrescentou leva 'Acrescentado por você' e não tem trecho; o editado leva 'Editado por você'", () => {
    daDona(pronto(COM_ORIGEM));
    const acrescentado = itemDoTexto("Ligar para o importador");
    expect(within(acrescentado).getByText("Acrescentado por você")).toBeInTheDocument();
    expect(within(acrescentado).getByText("Prazo: amanhã")).toBeInTheDocument();
    expect(acrescentado.querySelector("details, q")).toBeNull();
    expect(within(acrescentado).queryByText("Para conferir")).not.toBeInTheDocument();
    const editado = itemDoTexto("A reunião tratou da exportação de café para a Alemanha.");
    expect(within(editado).getByText("Editado por você")).toBeInTheDocument();
    // O trecho é o da versão da IA: pode não sustentar mais o que a dona escreveu.
    expect(within(editado).getByText("Trecho original da transcrição")).toBeInTheDocument();
    expect(screen.getAllByText(/ por você$/)).toHaveLength(2);
    // O item da IA que ela não editou segue com o rótulo de sempre.
    expect(within(itemDoTexto("A licença de exportação ainda não saiu.")).getByText("Trecho da transcrição")).toBeInTheDocument();
  });

  it("pelo link, o que a dona escreveu aparece como confirmado e com a marca de que quem gravou o escreveu: sem o aviso da IA, sem trecho vazio e sem botões", () => {
    // O que o servidor manda ao link: sem ids, sem a origem e sem a hora da edição, só a marca.
    const peloLink = COM_ORIGEM.filter(item => item.status !== "ignored")
      .map(({ id: _i, position: _p, done: _d, origin, editedAt, ...item }) => ({ ...item, escritoPelaDona: origin === "owner" || editedAt !== null }));
    doLink(pronto(peloLink));
    const acrescentado = itemDoTexto("Ligar para o importador");
    expect(within(acrescentado).queryByText(/ainda não conferiu/)).not.toBeInTheDocument();
    expect(within(acrescentado).getByText("Escrito ou editado por quem gravou a reunião")).toBeInTheDocument();
    expect(acrescentado.querySelector("details, q")).toBeNull();
    // O item da IA que a dona editou: a marca, e o trecho é o original.
    const editado = itemDoTexto("A reunião tratou da exportação de café para a Alemanha.");
    expect(within(editado).getByText("Escrito ou editado por quem gravou a reunião")).toBeInTheDocument();
    expect(within(editado).getByText("Trecho original da transcrição")).toBeInTheDocument();
    expect(screen.getAllByText("Escrito ou editado por quem gravou a reunião")).toHaveLength(2);
    expect(screen.queryByText(/ por você$/)).not.toBeInTheDocument();
    // Nenhum botão da dona: o único botão do link é o "Ouvir o resumo" (H19).
    expect(screen.getAllByRole("button").map(botao => botao.textContent?.trim())).toEqual(["Ouvir resumo · áudio gerado pela IA da Google"]);
  });

  it("com o link ligado, editar e acrescentar avisam que o que a dona salva aparece para quem tem o link; sem link, não", () => {
    const { unmount } = render(<ResumoGuardado meetingId={REUNIAO} consulta={pronto() as never} comLinkAberto/>);
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Não renovar com a transportadora antiga." }));
    const aviso = "O link desta reunião está ligado: o que você salvar aqui aparece também para quem tem o link.";
    expect(screen.getByRole("form", { name: "Editar" })).toHaveAccessibleDescription(aviso);
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    expect(screen.getByRole("form", { name: "Acrescentar item" })).toHaveAccessibleDescription(aviso);
    unmount();
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    expect(screen.queryByText(aviso)).not.toBeInTheDocument();
  });

  it("Editar abre o formulário no lugar do item, com o texto como a tela mostra; Cancelar fecha e devolve o foco ao Editar", () => {
    daDona(pronto(), { nomes: { F2: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Carla envia a proposta revisada" }));
    const formulario = screen.getByRole("form", { name: "Editar" });
    expect(within(formulario).getByLabelText("Texto")).toHaveValue("Carla envia a proposta revisada");
    expect(within(formulario).getByLabelText("Responsável")).toHaveValue("Carla");
    // O formulário mora no lugar do item: o ?item=<id> ainda o acha.
    expect(formulario.closest("li")).toHaveAttribute("id", "item-do-resumo-i-acao");
    expect(screen.queryByRole("checkbox", { name: "Carla envia a proposta revisada" })).not.toBeInTheDocument();
    fireEvent.click(within(formulario).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("form", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar", description: "Carla envia a proposta revisada" })).toHaveFocus();
  });

  it("salvar a edição manda o rótulo de volta pelo id; o Ignorar do formulário decide pelo id", () => {
    daDona(pronto(), { nomes: { F2: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Carla envia a proposta revisada" }));
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Carla envia a proposta final" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("editarItemDoResumo").mutate).toHaveBeenCalledWith({
      itemId: "i-acao", texto: "{F2} envia a proposta final", assunto: null, responsavel: "{F2}", prazo: "até sexta-feira", ...PEDIDO,
    });
    fireEvent.click(within(screen.getByRole("form", { name: "Editar" })).getByRole("button", { name: "Ignorar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao", status: "ignored" });
  });

  it("as vozes sugeridas no responsável: as que a dona nomeou e as que o resumo cita, na ordem do número", () => {
    daDona(pronto(), { nomes: { F2: "Carla", F5: "Bia" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Carla envia a proposta revisada" }));
    expect(opcoesDaLista()).toEqual(["Falante 1", "Carla", "Bia"]);
  });

  it("a voz que falou, sem nome e sem citação no resumo, também entra no responsável e volta como rótulo", () => {
    // O resumo cita F1 e F2; F3 só falou. A lacuna da transcrição vem sem falante.
    daDona(pronto(), { falantes: ["F1", "F3", "F2", "F3", ""] });
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    expect(opcoesDaLista()).toEqual(["Falante 1", "Falante 2", "Falante 3"]);
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Ligar para o importador" } });
    fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "Falante 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("acrescentarItemDoResumo").mutate).toHaveBeenLastCalledWith({
      meetingId: REUNIAO, secao: "action", texto: "Ligar para o importador", assunto: null, responsavel: "{F3}", prazo: null,
    });
  });

  it("'Acrescentar item' abre o formulário com a seção; Cancelar devolve o foco ao botão; o resumo vazio também tem o botão", () => {
    const { unmount } = daDona(pronto([]));
    expect(screen.getByText("Nenhum item para mostrar neste resumo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acrescentar item" })).toBeInTheDocument();
    unmount();
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    const formulario = screen.getByRole("form", { name: "Acrescentar item" });
    expect(within(formulario).getByLabelText("Seção")).toHaveValue("action");
    fireEvent.change(within(formulario).getByLabelText("Texto"), { target: { value: "Reservar o voo" } });
    fireEvent.click(within(formulario).getByRole("button", { name: "Salvar" }));
    expect(mutacao("acrescentarItemDoResumo").mutate).toHaveBeenCalledWith({
      meetingId: REUNIAO, secao: "action", texto: "Reservar o voo", assunto: null, responsavel: null, prazo: null,
    });
    fireEvent.click(within(formulario).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("form", { name: "Acrescentar item" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acrescentar item" })).toHaveFocus();
  });

  it("salvo o item novo, o resumo é relido e o formulário fecha; a recusa do teto vira a frase traduzida e o deixa aberto", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.utils.meetings.resumoGuardado.invalidate.mockReturnValue(Promise.resolve());
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    const { onError, onSettled } = mutacao("acrescentarItemDoResumo").opcoes as { onError: (erro: unknown) => void; onSettled: (dados: unknown, erro: unknown) => Promise<unknown> };
    const recusa = { message: MENSAGEM_RESUMO_CHEIO, data: { code: "PRECONDITION_FAILED" } };
    act(() => onError(recusa));
    expect(toast.error).toHaveBeenLastCalledWith("This summary has reached the maximum number of items.");
    await act(async () => { await onSettled(undefined, recusa); });
    expect(screen.getByRole("form", { name: "Add item" })).toBeInTheDocument();
    await act(async () => { await onSettled({ id: "item-novo" }, null); });
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(screen.queryByRole("form", { name: "Add item" })).not.toBeInTheDocument();
  });
});

describe("Resumo guardado — os estados", () => {
  it("sem resumo: 'Gerar resumo' pede o resumo da reunião, no modelo escolhido (o Geral, de início)", () => {
    daDona(comEstado("sem_resumo"));
    expect(screen.getByText("Esta reunião ainda não tem resumo.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));
    expect(mutacao("pedirResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: "general" });
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

  it("sem os botões de decidir: nem caixa, nem Confirmar, Ignorar, Confirmar todos ou os ignorados; só o '▶' e o 'Ouvir o resumo'", () => {
    const aoIrPara = vi.fn();
    doLink(pronto(ITENS_DO_LINK), aoIrPara);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Para conferir")).not.toBeInTheDocument();
    expect(screen.queryByText(/Escrito pela IA/)).not.toBeInTheDocument();
    const botoes = screen.getAllByRole("button");
    expect(botoes.length).toBeGreaterThan(1);
    for (const botao of botoes) expect(botao).toHaveAccessibleName(/^(Ouvir a partir de |Ouvir resumo · áudio gerado pela IA da Google$)/);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 03:20" }));
    expect(aoIrPara).toHaveBeenCalledWith(200);
  });

  it("o trecho que a dona tirou da transcrição (H18) vem vazio pelo link: o item fica, sem trecho, com o aviso de que quem gravou o corrigiu", () => {
    const aviso = "O trecho da transcrição deste item foi corrigido por quem gravou a reunião.";
    const itens = ITENS_DO_LINK.map(item => (item.text === "Não renovar com a transportadora antiga."
      ? { ...item, excerpt: "", trechoForaDaTranscricao: true }
      : { ...item, trechoForaDaTranscricao: false }));
    const aoIrPara = vi.fn();
    doLink(pronto(itens), aoIrPara);
    const corrigido = itemDoTexto("Não renovar com a transportadora antiga.");
    expect(within(corrigido).getByText(aviso)).toBeInTheDocument();
    expect(corrigido.querySelector("details, q, blockquote")).toBeNull();
    // O tempo do item continua: o "▶" leva ao ponto da gravação.
    fireEvent.click(within(corrigido).getByRole("button", { name: "Ouvir a partir de 05:20" }));
    expect(aoIrPara).toHaveBeenCalledWith(320);
    // Só nele: os outros seguem com o trecho, sem o aviso.
    expect(screen.getAllByText(aviso)).toHaveLength(1);
    expect(within(itemDoTexto("A licença de exportação ainda não saiu.")).getByText("Trecho da transcrição")).toBeInTheDocument();
  });

  it("para a dona, a marca do link não aparece (ela vê o trecho da versão da IA)", () => {
    daDona(pronto(ITENS.map(item => ({ ...item, trechoForaDaTranscricao: true }))));
    expect(screen.queryByText(/foi corrigido por quem gravou a reunião/)).not.toBeInTheDocument();
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
      "A ação está salva na MarquesaMatch, mas não foi para a sua Google Agenda. A Google não respondeu. Tente de novo em instantes.", { duration: 10_000 });
  });

  // A junção com a H4f: o item que a dona escreveu não volta a "para
  // conferir" (o servidor o deixa confirmado), e a tela não oferece isso.
  it("o item confirmado que a dona escreveu não tem 'Desfazer a confirmação', mas tem o caminho até Próximas ações", () => {
    const daDonaConfirmados = [
      { ...ITENS[1], id: "i-da-dona", status: "confirmed", origin: "owner", editedAt: null, text: "Ligar para o importador", excerpt: "" },
      { ...ITENS[1], id: "i-editado", status: "confirmed", origin: "ai", editedAt: 500, text: "Mandar o catálogo" },
      { ...ITENS[1], id: "i-da-ia", status: "confirmed", origin: "ai", editedAt: null, text: "Reservar o voo" },
    ];
    daDona(pronto(daDonaConfirmados));
    for (const texto of ["Ligar para o importador", "Mandar o catálogo"]) {
      const item = itemDoTexto(texto);
      expect(within(item).queryByRole("button", { name: "Desfazer a confirmação" })).not.toBeInTheDocument();
      expect(within(item).getByRole("link", { name: "Em Próximas ações" })).toHaveAttribute("href", "/proximas-acoes");
    }
    expect(within(itemDoTexto("Reservar o voo")).getByRole("button", { name: "Desfazer a confirmação" })).toBeInTheDocument();
  });

  it("enquanto o resumo é refeito (H4d), o confirmado não tem 'Desfazer a confirmação'; no refazer que falhou, tem", () => {
    const anterior = (estado: string) => consulta({ estado, emoji: "☕", idioma: "pt-BR", erro: null, modelo: "sales", versaoAnterior: true, itens: ITENS });
    const { unmount } = daDona(anterior("pendente"));
    expect(within(itemDoTexto("Reservar a sala de reunião")).queryByRole("button", { name: "Desfazer a confirmação" })).not.toBeInTheDocument();
    unmount();
    daDona(anterior("falhou"));
    expect(within(itemDoTexto("Reservar a sala de reunião")).getByRole("button", { name: "Desfazer a confirmação" })).toBeInTheDocument();
  });

  it("Ignorar no formulário a ação confirmada pergunta antes; o item pendente, não", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Reservar a sala de reunião" }));
    fireEvent.click(within(screen.getByRole("form", { name: "Editar" })).getByRole("button", { name: "Ignorar" }));
    expect(mutacao("decidirItemDoResumo").mutate).not.toHaveBeenCalledWith({ itemId: "i-acao-feita", status: "ignored" });
    fireEvent.click(screen.getByRole("button", { name: "Sim, ignorar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao-feita", status: "ignored" });
  });

  it("editar o item cuja ação não chegou à Google avisa como a lista; o evento que foi, não", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Reservar a sala de reunião" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    act(() => mutacao("editarItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "falhou", motivo: "google" }, {}));
    expect(toast.warning).toHaveBeenLastCalledWith(
      "A ação está salva na MarquesaMatch, mas não foi para a sua Google Agenda. A Google não respondeu. Tente de novo em instantes.", { duration: 10_000 });
    vi.mocked(toast.warning).mockClear();
    act(() => mutacao("editarItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "ok" }, {}));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("deu certo, ou o item não tinha ação com evento: nenhum aviso", () => {
    daDona(pronto());
    act(() => mutacao("decidirItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: "acao-9", naGoogle: "ok" }, { itemId: "i-acao-feita", status: "pending" }));
    act(() => mutacao("decidirItemDoResumo").opcoes.onSuccess!({ ok: true, acaoId: null, naGoogle: null }, { itemId: "i-decisao", status: "confirmed" }));
    act(() => mutacao("marcarAcaoFeita").opcoes.onSuccess!({ ok: true, acaoId: null, naGoogle: null }, { itemId: "i-acao", feito: false }));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

/**
 * A tradução do resumo (H11). A página guarda a tradução (useTraducaoDoResumo,
 * testado à parte) e a passa pronta; aqui se prova o que a tela faz com ela: a
 * escolha do idioma, o aviso, os textos traduzidos no lugar dos originais, o
 * trecho que fica no original e as decisões que seguem pelo id do item.
 */
describe("Resumo guardado — a tradução (H11)", () => {
  type Dados = { estado: string; itens: Array<Record<string, unknown> & { text: string; subject: string | null; due: string | null }> };
  const EM_INGLES: Record<string, string> = {
    "{F2} envia a proposta revisada": "{F2} sends the revised proposal",
    "até sexta-feira": "by Friday",
    "Contrato com o importador": "Contract with the importer",
    "{F1} fecha o contrato com o importador.": "{F1} closes the contract with the importer.",
  };
  const paraIngles = (texto: string | null) => (texto === null ? null : EM_INGLES[texto] ?? texto);
  const traducao = (extra: Record<string, unknown> = {}) => ({
    idioma: "en", idiomaOriginal: "pt-BR", estado: "pronta", erro: null,
    escolher: vi.fn(), tentarDeNovo: vi.fn(), traduzirRotulo: (rotulo: string) => rotulo,
    aplicar: (dados?: Dados) => dados && dados.estado === "pronto"
      ? { ...dados, itens: dados.itens.map(item => ({ ...item, text: paraIngles(item.text)!, subject: paraIngles(item.subject), due: paraIngles(item.due) })) }
      : dados,
    ...extra,
  });
  const comTraducao = (c: ReturnType<typeof consulta>, t: ReturnType<typeof traducao>, nomes?: Record<string, string>) =>
    render(<ResumoGuardado meetingId={REUNIAO} consulta={c as never} nomes={nomes} traducao={t as never}/>);

  it("pronta: os textos vêm traduzidos, a voz vira o nome, o trecho fica no original e a decisão segue pelo id", () => {
    comTraducao(pronto(), traducao(), { F2: "Carla" });
    const acao = itemDoTexto("Carla sends the revised proposal");
    expect(within(acao).getByText("Carla sends the revised proposal")).toHaveAttribute("lang", "en");
    expect(within(acao).getByText("Prazo: by Friday")).toBeInTheDocument();
    expect(within(acao).getByText("eu mando a proposta revisada até sexta-feira")).toBeInTheDocument();
    expect(itemDoTexto(/Falante 1 closes the contract with the importer\./)).toHaveTextContent("Contract with the importer: Falante 1 closes the contract with the importer.");
    // O trecho do item já conferido, recolhido, leva o idioma original.
    expect(screen.getByText("hoje vamos falar da exportação de café")).toHaveAttribute("lang", "pt-BR");
    expect(screen.getByText("Tradução automática pela IA. Original: Português. Os trechos citados ficam no idioma original.")).toBeInTheDocument();
    fireEvent.click(within(acao).getByRole("button", { name: "Confirmar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-acao", status: "confirmed" });
  });

  it("a escolha do idioma começa no da tradução, marca o original e passa o idioma escolhido", () => {
    const t = traducao();
    comTraducao(pronto(), t);
    const escolha = screen.getByRole("combobox", { name: "Idioma do resumo" });
    expect(escolha).toHaveValue("en");
    expect(within(escolha).getByRole("option", { name: "🇧🇷 Português (original)" })).toBeInTheDocument();
    expect(within(escolha).getAllByRole("option")).toHaveLength(10);
    fireEvent.change(escolha, { target: { value: "ja" } });
    expect(t.escolher).toHaveBeenCalledWith("ja");
  });

  it("traduzindo: o aviso é anunciado, e o resumo segue no original até a tradução chegar", () => {
    comTraducao(pronto(), traducao({ estado: "traduzindo", aplicar: (dados: unknown) => dados }));
    expect(screen.getByRole("status")).toHaveTextContent("Traduzindo o resumo…");
    expect(screen.getByText("Falante 2 envia a proposta revisada")).toBeInTheDocument();
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
  });

  it("erro: a frase sai pelo código, o resumo fica no original, e 'Tentar de novo' pede outra vez", () => {
    const t = traducao({ estado: "erro", erro: { message: "A tradução do resumo não respondeu agora.", data: { code: "SERVICE_UNAVAILABLE" } }, aplicar: (dados: unknown) => dados });
    const { unmount } = comTraducao(pronto(), t);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível traduzir o resumo agora. Ele aparece no idioma original.");
    expect(screen.getByText("Falante 2 envia a proposta revisada")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Tentar de novo" }));
    expect(t.tentarDeNovo).toHaveBeenCalledTimes(1);
    unmount();
    comTraducao(pronto(), traducao({ estado: "erro", erro: { message: "x", data: { code: "TOO_MANY_REQUESTS" } }, aplicar: (dados: unknown) => dados }));
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
  });

  it("sem resumo pronto com itens, não há escolha de idioma; com o original escolhido, nem aviso", () => {
    const { unmount } = comTraducao(comEstado("gerando"), traducao({ estado: "inativa", idiomaOriginal: null }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    unmount();
    comTraducao(pronto(), traducao({ estado: "original", idioma: "pt-BR", aplicar: (dados: unknown) => dados }));
    expect(screen.getByRole("combobox", { name: "Idioma do resumo" })).toHaveValue("pt-BR");
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pelo link: o resumo traduzido entra inteiro, com 'Falante n' e sem os botões da dona", () => {
    const t = traducao({ aplicar: (dados?: Dados) => dados && { ...dados, itens: [{ ...ITENS_DO_LINK[1], text: "{F2} sends the revised proposal", due: "by Friday" }] } });
    render(<ResumoGuardado token={TOKEN} consulta={pronto(ITENS_DO_LINK) as never} traducao={t as never}/>);
    expect(screen.getByText("Falante 2 sends the revised proposal")).toBeInTheDocument();
    expect(screen.getByText("Prazo: by Friday")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Idioma do resumo" })).toBeInTheDocument();
  });
});

describe("Resumo guardado — ouvir o resumo com a voz do aparelho (H19)", () => {
  // O tocar, pausar e continuar estão em OuvirOResumo.test.tsx; aqui, o que o
  // resumo manda ler, em que idioma e quando o botão aparece.
  const VOZES = [{ name: "Luciana", lang: "pt-BR", default: true }, { name: "Samantha", lang: "en-US" }];
  const ouvir = () => fireEvent.click(screen.getByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" }));
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a dona ouve o que está à vista, na ordem da tela e com os nomes das vozes; o ignorado não, e o pendente começa com 'Para conferir'", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    daDona(pronto(), { nomes: { F2: "Carla" } });
    ouvir();
    expect(voz.lerAteOFim()).toEqual([
      "Os itens que começam com “Para conferir” foram escritos pela IA e ainda não foram conferidos.",
      "Ações",
      "Para conferir", "Carla envia a proposta revisada", "Responsável: Carla", "Prazo: até sexta-feira",
      "Reservar a sala de reunião",
      "Foco do trabalho",
      "A reunião tratou da exportação de café para a Alemanha.",
      "Tarefas e arranjos de trabalho",
      "Para conferir", "Contrato com o importador: Falante 1 fecha o contrato com o importador.", "Responsável: Falante 1", "Prazo: sexta-feira",
      "Decisões e mudanças de escopo",
      "Para conferir", "Não renovar com a transportadora antiga.",
      "Bloqueios, dependências e restrições",
      "A licença de exportação ainda não saiu.",
      "Questões pendentes",
      "Para conferir", "Quem paga o seguro da carga?",
    ]);
    expect(voz.pedidas.every(fala => fala.voice?.name === "Luciana" && fala.lang === "pt-BR")).toBe(true);
  });

  it("todos pendentes: um aviso no começo basta, sem 'Para conferir' em cada item; nenhum pendente: nem aviso, nem selo", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const { unmount } = daDona(pronto(ITENS.filter(item => item.status === "pending")), { nomes: { F2: "Carla" } });
    ouvir();
    expect(voz.lerAteOFim()).toEqual([
      "Este resumo foi escrito pela IA, e nenhum item foi conferido ainda.",
      "Ações", "Carla envia a proposta revisada", "Responsável: Carla", "Prazo: até sexta-feira",
      "Tarefas e arranjos de trabalho", "Contrato com o importador: Falante 1 fecha o contrato com o importador.", "Responsável: Falante 1", "Prazo: sexta-feira",
      "Decisões e mudanças de escopo", "Não renovar com a transportadora antiga.",
      "Questões pendentes", "Quem paga o seguro da carga?",
    ]);
    unmount();
    daDona(pronto(ITENS.filter(item => item.status === "confirmed")));
    ouvir();
    expect(voz.lerAteOFim()).toEqual([
      "Ações", "Reservar a sala de reunião",
      "Foco do trabalho", "A reunião tratou da exportação de café para a Alemanha.",
      "Bloqueios, dependências e restrições", "A licença de exportação ainda não saiu.",
    ]);
  });

  it("resumo em inglês numa tela em português: a voz inglesa, e os títulos, os rótulos e o 'Falante n' também em inglês; a tela não muda", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const itens = [
      { id: "a", section: "action", position: 0, subject: null, text: "{F2} sends the revised proposal", assignee: "{F2}", due: "by Friday", excerpt: "I'll send the revised proposal by Friday", startSeconds: 75, status: "confirmed", done: false },
      { id: "q", section: "question", position: 1, subject: "Insurance", text: "Who pays for the cargo insurance?", assignee: null, due: null, excerpt: "who pays for the cargo insurance", startSeconds: 90, status: "confirmed", done: false },
    ];
    daDona(consulta({ estado: "pronto", emoji: null, idioma: "en", erro: null, itens }));
    ouvir();
    expect(voz.lerAteOFim()).toEqual([
      "Actions", "Speaker 2 sends the revised proposal", "Assigned to: Speaker 2", "Due: by Friday",
      "Open questions", "Insurance: Who pays for the cargo insurance?",
    ]);
    expect(voz.pedidas.every(fala => fala.voice?.name === "Samantha" && fala.lang === "en-US")).toBe(true);
    expect(screen.getByText("Falante 2 sends the revised proposal")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ações" })).toBeInTheDocument();
  });

  it("resumo sem idioma gravado (ou com o 'pt' das reuniões antigas) é lido em português do Brasil", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    for (const idioma of [null, "pt"]) {
      const { unmount } = daDona(consulta({ estado: "pronto", emoji: null, idioma, erro: null, itens: ITENS.filter(item => item.id === "i-foco") }));
      ouvir();
      expect(voz.lerAteOFim()).toEqual(["Foco do trabalho", "A reunião tratou da exportação de café para a Alemanha."]);
      expect(voz.pedidas.at(-1)?.voice?.name).toBe("Luciana");
      unmount();
    }
  });

  it("pelo link: os nomes que o link recebeu (H3b), 'Falante n' na voz sem nome e no link sem os nomes, e o idioma que o link manda", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    // A voz lê o que a tela mostra: o nome que o link recebeu (o `vozes` de
    // reuniaoAberta.ver) e "Falante n" na voz sem nome, nunca o rótulo cru.
    const { unmount } = render(<ResumoGuardado token={TOKEN} consulta={pronto(ITENS_DO_LINK) as never} nomes={{ F2: "Carla" }}/>);
    ouvir();
    expect(voz.lerAteOFim()).toEqual([
      "Os itens que começam com “Para conferir” foram escritos pela IA e ainda não foram conferidos.",
      "Ações",
      "Para conferir", "Carla envia a proposta revisada", "Responsável: Carla", "Prazo: até sexta-feira",
      "Reservar a sala de reunião",
      "Foco do trabalho",
      "A reunião tratou da exportação de café para a Alemanha.",
      "Tarefas e arranjos de trabalho",
      "Para conferir", "Contrato com o importador: Falante 1 fecha o contrato com o importador.", "Responsável: Falante 1", "Prazo: sexta-feira",
      "Decisões e mudanças de escopo",
      "Para conferir", "Não renovar com a transportadora antiga.",
      "Bloqueios, dependências e restrições",
      "A licença de exportação ainda não saiu.",
      "Questões pendentes",
      "Para conferir", "Quem paga o seguro da carga?",
    ]);
    unmount();
    // O link ligado antes da confirmação que fala dos nomes não os recebe:
    // toda voz é "Falante n", no idioma que o link manda.
    const acao = ITENS_DO_LINK.find(item => item.section === "action")!;
    doLink(consulta({ estado: "pronto", emoji: null, idioma: "en", itens: [{ ...acao, status: "confirmed" }] }));
    ouvir();
    expect(voz.lerAteOFim()).toEqual(["Actions", "Speaker 2 envia a proposta revisada", "Assigned to: Speaker 2", "Due: até sexta-feira"]);
    expect(voz.pedidas.at(-1)?.voice?.name).toBe("Samantha");
  });

  it("no refazer (H4d), a versão anterior que está na tela também se ouve: a do refazer que falhou e a do refazer em curso, para a dona e pelo link", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const anterior = (estado: string) => consulta({ estado, emoji: "☕", idioma: "pt-BR", erro: estado === "falhou" ? "RESPOSTA_CORTADA" : null, modelo: "sales", versaoAnterior: true, itens: ITENS });
    const { unmount } = daDona(anterior("falhou"), { nomes: { F2: "Carla" } });
    ouvir();
    expect(voz.lerAteOFim()).toContain("Carla envia a proposta revisada");
    unmount();
    const tela = daDona(anterior("pendente"));
    expect(screen.getByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" })).toBeInTheDocument();
    tela.unmount();
    doLink(consulta({ estado: "falhou", emoji: "☕", idioma: "pt-BR", versaoAnterior: true, itens: ITENS_DO_LINK }));
    ouvir();
    expect(voz.lerAteOFim()).toContain("Falante 2 envia a proposta revisada");
  });

  it("o botão só aparece com o resumo pronto e algo à vista", () => {
    instalarSinteseFalsa({ vozes: VOZES });
    const soIgnorados = ITENS.filter(item => item.status === "ignored");
    for (const c of [consulta(undefined), comEstado("sem_resumo"), comEstado("pendente"), comEstado("gerando"), comEstado("falhou"), pronto([]), pronto(soIgnorados)]) {
      const { unmount } = daDona(c);
      expect(screen.queryByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" })).not.toBeInTheDocument();
      unmount();
    }
    doLink(pronto(ITENS_DO_LINK));
    expect(screen.getByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" })).toBeInTheDocument();
  });

  it("o resumo que volta a ser gerado no meio da leitura cala a voz", () => {
    const voz = instalarSinteseFalsa({ vozes: VOZES });
    const { rerender } = daDona(pronto());
    ouvir();
    expect(voz.fila().length).toBeGreaterThan(0);
    rerender(<ResumoGuardado meetingId={REUNIAO} consulta={comEstado("gerando") as never}/>);
    expect(voz.fila()).toEqual([]);
    expect(screen.queryByRole("button", { name: /leitura/ })).not.toBeInTheDocument();
  });
});

/**
 * As funções do pacote P2 juntas no mesmo resumo: com a tradução pronta (H11),
 * "Ouvir o resumo" (H19) lê o texto que está à vista, no idioma dele, e o
 * formulário de edição (H4f) abre com o texto original do item, para salvar
 * não gravar a tradução no lugar dele.
 */
describe("Resumo guardado — a tradução com o ouvir e o editar (pacote P2)", () => {
  type Dados = { estado: string; itens: Array<Record<string, unknown> & { text: string; subject: string | null; due: string | null }> };
  const EM_INGLES: Record<string, string> = { "{F2} envia a proposta revisada": "{F2} sends the revised proposal", "até sexta-feira": "by Friday" };
  const paraIngles = (texto: string | null) => (texto === null ? null : EM_INGLES[texto] ?? texto);
  const traducaoPronta = () => ({
    idioma: "en", idiomaOriginal: "pt-BR", estado: "pronta", erro: null,
    escolher: vi.fn(), tentarDeNovo: vi.fn(), traduzirRotulo: (rotulo: string) => rotulo,
    aplicar: (dados?: Dados) => dados && dados.estado === "pronto"
      ? { ...dados, itens: dados.itens.map(item => ({ ...item, text: paraIngles(item.text)!, subject: paraIngles(item.subject), due: paraIngles(item.due) })) }
      : dados,
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ouvir o resumo traduzido: a voz, os títulos e os rótulos vão no idioma da tradução, que é o texto à vista", () => {
    const voz = instalarSinteseFalsa({ vozes: [{ name: "Luciana", lang: "pt-BR", default: true }, { name: "Samantha", lang: "en-US" }] });
    render(<ResumoGuardado meetingId={REUNIAO} consulta={pronto(ITENS.filter(item => item.id === "i-acao")) as never} nomes={{ F2: "Carla" }} traducao={traducaoPronta() as never}/>);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir resumo · áudio gerado pela IA da Google" }));
    expect(voz.lerAteOFim()).toEqual([
      // Como o aviso da tela: é uma tradução da IA, e o original é outro idioma.
      "This summary was translated by the AI.", "The original is in Portuguese.",
      "This summary was written by the AI, and no item has been reviewed yet.",
      "Actions", "Carla sends the revised proposal", "Assigned to: Carla", "Due: by Friday",
    ]);
    expect(voz.pedidas.every(fala => fala.voice?.name === "Samantha" && fala.lang === "en-US")).toBe(true);
  });

  it("editar com o resumo traduzido: o formulário abre com o texto original do item, e não com a tradução", () => {
    render(<ResumoGuardado meetingId={REUNIAO} consulta={pronto() as never} nomes={{ F2: "Carla" }} traducao={traducaoPronta() as never}/>);
    fireEvent.click(screen.getByRole("button", { name: "Editar", description: "Carla sends the revised proposal" }));
    const formulario = screen.getByRole("form", { name: "Editar" });
    expect(within(formulario).getByLabelText("Texto")).toHaveValue("Carla envia a proposta revisada");
    expect(within(formulario).getByLabelText("Prazo")).toHaveValue("até sexta-feira");
  });
});

describe("Resumo guardado — editar e acrescentar no resumo refeito (H4f com a H4d)", () => {
  const comVersaoAnterior = (estado: string, erro: string | null) =>
    consulta({ estado, emoji: "☕", idioma: "pt-BR", erro, modelo: "sales", versaoAnterior: true, itens: ITENS });

  it("enquanto o resumo é refeito, Editar e Acrescentar somem, como as decisões; no refazer que falhou, voltam", () => {
    const { unmount } = render(<ResumoGuardado meetingId={REUNIAO} consulta={comVersaoAnterior("pendente", null) as never}/>);
    expect(screen.getByText(/envia a proposta revisada/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acrescentar item" })).not.toBeInTheDocument();
    unmount();
    render(<ResumoGuardado meetingId={REUNIAO} consulta={comVersaoAnterior("falhou", "RESPOSTA_CORTADA") as never} nomes={{ F2: "Carla" }}/>);
    expect(screen.getAllByRole("button", { name: "Editar" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Acrescentar item" })).toBeInTheDocument();
  });
});
