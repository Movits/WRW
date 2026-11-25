import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import { FormularioDoItemDoResumo, type ItemEditavel } from "./FormularioDoItemDoResumo";

/**
 * O formulário do item do resumo (H4f): a dona edita o que a tela mostra (o
 * nome da voz no lugar do rótulo) e o que ela salva volta com o rótulo; cada
 * seção mostra só os campos dela; salvar relê antes de fechar, e a falha deixa
 * aberto o que ela escreveu. As mutações são dublês que registram o mutate e
 * as opções; o que o servidor faz está em server/resumo-guardado-edicao.test.ts.
 */

type Opcoes = { onSuccess?: (dados: unknown) => void; onError?: (erro: unknown) => void; onSettled?: (dados: unknown, erro: unknown) => unknown };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: ReturnType<typeof vi.fn>; opcoes: Opcoes; isPending: boolean }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), opcoes, isPending: false });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: m.isPending };
    },
  });
  return { mutacoes, registrar };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    meetings: {
      editarItemDoResumo: duble.registrar("editarItemDoResumo"),
      acrescentarItemDoResumo: duble.registrar("acrescentarItemDoResumo"),
    },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const nomes = { F2: "Carla" };
const exibir = (falante: string) => vozesNoTexto(`{${falante}}`, nomes, n => `Falante ${n}`);
const TITULOS: Record<string, string> = {
  action: "Ações", focus: "Foco do trabalho", task: "Tarefas e arranjos de trabalho",
  decision: "Decisões e mudanças de escopo", blocker: "Bloqueios, dependências e restrições", question: "Questões pendentes",
};
const ACAO: ItemEditavel = { id: "i-acao", section: "action", subject: null, text: "{F2} envia a proposta para {F3}", assignee: "{F2}", due: "até sexta-feira" };

function abrir(props: Partial<Parameters<typeof FormularioDoItemDoResumo>[0]> = {}) {
  const chamadas = { reler: vi.fn(() => Promise.resolve()), aoFalhar: vi.fn(), aoFechar: vi.fn(), aoIgnorar: props.aoIgnorar };
  render(<FormularioDoItemDoResumo meetingId={REUNIAO} vozes={["F2", "F3"]} exibir={exibir} tituloDaSecao={secao => TITULOS[secao]}
    reler={chamadas.reler} aoFalhar={chamadas.aoFalhar} aoFechar={chamadas.aoFechar} {...props}/>);
  return chamadas;
}
const mutacao = (nome: string) => duble.mutacoes[nome];
/** O fuso do aparelho e os rótulos da tela, em pt-BR: o evento da próxima ação do item na Google Agenda (H5c). */
const PEDIDO = { fuso: expect.any(String), rotulos: { voz: "Falante {n}", responsavel: "Responsável: {nome}" } };
const preparar = (nome: string, isPending: boolean) => {
  duble.mutacoes[nome] ??= { mutate: vi.fn(), opcoes: {}, isPending: false };
  duble.mutacoes[nome].isPending = isPending;
};

describe("Formulário do item do resumo — editar", () => {
  it("abre com o que a tela mostra (o nome da voz e o 'Falante n'), e salvar manda os rótulos de volta", () => {
    abrir({ item: ACAO });
    const texto = screen.getByLabelText("Texto");
    expect(texto).toHaveValue("Carla envia a proposta para Falante 3");
    expect(texto).toHaveFocus();
    expect(screen.getByLabelText("Responsável")).toHaveValue("Carla");
    expect(screen.getByLabelText("Prazo")).toHaveValue("até sexta-feira");
    // A ação não tem assunto, e a edição não troca a seção.
    expect(screen.queryByLabelText("Assunto")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Seção")).not.toBeInTheDocument();

    fireEvent.change(texto, { target: { value: "Carla envia a proposta revisada para Falante 3" } });
    fireEvent.change(screen.getByLabelText("Prazo"), { target: { value: "  até segunda  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("editarItemDoResumo").mutate).toHaveBeenCalledWith({
      itemId: "i-acao", texto: "{F2} envia a proposta revisada para {F3}", assunto: null, responsavel: "{F2}", prazo: "até segunda", ...PEDIDO,
    });
  });

  it("a tarefa edita também o assunto", () => {
    abrir({ item: { id: "i-tarefa", section: "task", subject: "Contrato com {F2}", text: "{F2} fecha o contrato.", assignee: null, due: null } });
    expect(screen.getByLabelText("Assunto")).toHaveValue("Contrato com Carla");
    fireEvent.change(screen.getByLabelText("Assunto"), { target: { value: "Contrato com Carla e o importador" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("editarItemDoResumo").mutate).toHaveBeenLastCalledWith({
      itemId: "i-tarefa", texto: "{F2} fecha o contrato.", assunto: "Contrato com {F2} e o importador", responsavel: null, prazo: null, ...PEDIDO,
    });
  });

  it("a decisão não tem responsável nem prazo", () => {
    abrir({ item: { id: "i-decisao", section: "decision", subject: null, text: "Não renovar.", assignee: null, due: null } });
    expect(screen.queryByLabelText("Responsável")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Prazo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("editarItemDoResumo").mutate).toHaveBeenLastCalledWith({ itemId: "i-decisao", texto: "Não renovar.", assunto: null, responsavel: null, prazo: null, ...PEDIDO });
  });

  it("Ignorar só existe na edição, e espera a decisão que está no ar", () => {
    const aoIgnorar = vi.fn();
    const { unmount } = render(<FormularioDoItemDoResumo meetingId={REUNIAO} item={ACAO} vozes={[]} exibir={exibir} tituloDaSecao={s => TITULOS[s]}
      reler={vi.fn()} aoFalhar={vi.fn()} aoFechar={vi.fn()} aoIgnorar={aoIgnorar} decidindo/>);
    expect(screen.getByRole("button", { name: "Ignorar" })).toBeDisabled();
    unmount();
    abrir({ item: ACAO, aoIgnorar });
    fireEvent.click(screen.getByRole("button", { name: "Ignorar" }));
    expect(aoIgnorar).toHaveBeenCalledTimes(1);
  });

  // A ação ou tarefa confirmada virou próxima ação (H5a): ignorá-la apaga a
  // ação, com o prazo, o contato e o evento. Como o "Desfazer a confirmação",
  // o formulário pergunta antes.
  it("Ignorar a ação confirmada pergunta antes, porque apaga a próxima ação; Cancelar não ignora", () => {
    const aoIgnorar = vi.fn();
    abrir({ item: ACAO, aoIgnorar, ignorarApagaAcao: true });
    fireEvent.click(screen.getByRole("button", { name: "Ignorar" }));
    expect(aoIgnorar).not.toHaveBeenCalled();
    expect(screen.getByText("Ignorar este item também apaga a próxima ação criada a partir dele. Ignorar mesmo?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/Ignorar mesmo\?/)).not.toBeInTheDocument();
    expect(aoIgnorar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ignorar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sim, ignorar" }));
    expect(aoIgnorar).toHaveBeenCalledTimes(1);
  });

  it("salvar a edição devolve a quem chama o que a Google Agenda fez com o evento da ação (H5c)", () => {
    const aoSalvarEdicao = vi.fn();
    abrir({ item: ACAO, aoSalvarEdicao });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    const resultado = { ok: true, acaoId: "acao-9", naGoogle: "falhou", motivo: "google" };
    act(() => mutacao("editarItemDoResumo").opcoes.onSuccess!(resultado));
    expect(aoSalvarEdicao).toHaveBeenCalledWith(resultado);
  });
});

describe("Formulário do item do resumo — acrescentar", () => {
  it("começa nas ações; a seção escolhida mostra só os campos dela", () => {
    abrir();
    const secao = screen.getByLabelText("Seção");
    expect(secao).toHaveValue("action");
    expect(Array.from((secao as HTMLSelectElement).options).map(opcao => opcao.textContent)).toEqual(Object.values(TITULOS));
    expect(screen.getByLabelText("Responsável")).toBeInTheDocument();
    expect(screen.queryByLabelText("Assunto")).not.toBeInTheDocument();
    fireEvent.change(secao, { target: { value: "task" } });
    expect(screen.getByLabelText("Assunto")).toBeInTheDocument();
    fireEvent.change(secao, { target: { value: "question" } });
    expect(screen.queryByLabelText("Assunto")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Responsável")).not.toBeInTheDocument();
    // O que foi digitado nos campos que a seção não tem não vai.
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "  Quem paga o frete?  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("acrescentarItemDoResumo").mutate).toHaveBeenLastCalledWith({
      meetingId: REUNIAO, secao: "question", texto: "Quem paga o frete?", assunto: null, responsavel: null, prazo: null,
    });
  });

  it("o responsável escolhido na lista das vozes vira o rótulo; o nome digitado fica como texto", () => {
    abrir();
    const lista = document.getElementById(screen.getByLabelText("Responsável").getAttribute("list") ?? "");
    expect(Array.from(lista?.querySelectorAll("option") ?? []).map(opcao => opcao.getAttribute("value"))).toEqual(["Carla", "Falante 3"]);
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Carla manda o contrato" } });
    fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "Falante 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    // No texto do item novo, o nome fica como a dona escreveu: pode ser outra Carla.
    expect(mutacao("acrescentarItemDoResumo").mutate).toHaveBeenLastCalledWith({
      meetingId: REUNIAO, secao: "action", texto: "Carla manda o contrato", assunto: null, responsavel: "{F3}", prazo: null,
    });
    fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "Maria do jurídico" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("acrescentarItemDoResumo").mutate).toHaveBeenLastCalledWith(expect.objectContaining({ responsavel: "Maria do jurídico" }));
  });

  it("sem texto, Salvar fica desligado; Cancelar e Esc fecham sem salvar", () => {
    const { aoFechar } = abrir();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Acrescentar item" }));
    expect(mutacao("acrescentarItemDoResumo").mutate).not.toHaveBeenCalledWith(expect.objectContaining({ texto: "" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(aoFechar).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("Texto"), { key: "Escape" });
    expect(aoFechar).toHaveBeenCalledTimes(2);
  });
});

describe("Formulário do item do resumo — salvar", () => {
  it("salvou: relê e só então fecha; a falha avisa e deixa aberto o que a dona escreveu", async () => {
    let terminarReleitura = () => {};
    const releitura = new Promise<void>(resolver => { terminarReleitura = resolver; });
    const { aoFalhar, aoFechar } = abrir({ item: ACAO, reler: () => releitura });
    const { onSettled, onError } = mutacao("editarItemDoResumo").opcoes;

    const fim = onSettled!({ ok: true }, null);
    await Promise.resolve();
    expect(aoFechar).not.toHaveBeenCalled();
    terminarReleitura();
    await act(async () => { await fim; });
    expect(aoFechar).toHaveBeenCalledTimes(1);

    const erro = { message: "Este item do resumo não existe mais. Atualize a tela.", data: { code: "NOT_FOUND" } };
    onError!(erro);
    expect(aoFalhar).toHaveBeenCalledWith(erro);
    await act(async () => { await onSettled!(undefined, erro); });
    expect(aoFechar).toHaveBeenCalledTimes(1);
  });

  it("enquanto salva, Salvar e Cancelar ficam desligados, e o Esc não fecha", () => {
    preparar("acrescentarItemDoResumo", true);
    try {
      const { aoFechar } = abrir();
      fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Novo" } });
      expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText("Texto"), { key: "Escape" });
      expect(aoFechar).not.toHaveBeenCalled();
    } finally {
      preparar("acrescentarItemDoResumo", false);
    }
  });
});
