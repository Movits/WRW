import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MeusModelosDeResumo } from "./MeusModelosDeResumo";
import { EscolhaDoModelo, PainelDeRefazer, PedidoAntesDeGravar, PerguntaDoTamanho, pedidoParaEnviar, PEDIDO_PADRAO, mensagemDoRefazer } from "./ModeloDoResumo";

/**
 * A tela da H4e: os modelos da dona (criar, editar, apagar e o padrão), o
 * seletor com os modelos dela e "A IA escolhe", o estilo e as instruções no
 * pedido e no refazer, o pedido antes de gravar e "O resumo teve o tamanho
 * certo?". As mutações são dublês; o que o servidor faz está em
 * server/modelos-proprios.integracao.test.ts.
 */
type Opcoes = { onSuccess?: () => unknown; onError?: (erro: unknown) => void; onSettled?: () => unknown };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: ReturnType<typeof vi.fn>; opcoes: Opcoes; isPending: boolean; isError: boolean; error: unknown }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), opcoes, isPending: false, isError: false, error: null });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: m.isPending, isError: m.isError, error: m.error };
    },
  });
  const estado = { modelos: undefined as unknown };
  return {
    mutacoes, registrar, estado,
    utils: { meetings: { resumoGuardado: { invalidate: vi.fn() }, modelosDeResumo: { invalidate: vi.fn() } } },
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      modelosDeResumo: { useQuery: () => ({ data: duble.estado.modelos, isError: false, error: null }) },
      criarModeloDeResumo: duble.registrar("criar"),
      editarModeloDeResumo: duble.registrar("editar"),
      apagarModeloDeResumo: duble.registrar("apagar"),
      definirPreferenciasDoResumo: duble.registrar("preferencias"),
      refazerResumo: duble.registrar("refazer"),
      responderTamanhoDoResumo: duble.registrar("tamanho"),
    },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PROPRIO = { id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", nome: "Entrevista", icone: "🎤", instrucoes: "Destaque as perguntas e as respostas." };
const mutacao = (nome: string) => duble.mutacoes[nome];

beforeEach(() => {
  duble.estado.modelos = { proprios: [PROPRIO], padrao: "general", estilo: "balanced", ajusteDoTamanho: 0, refazeresQueRestam: 7 };
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockClear(); Object.assign(m, { isPending: false, isError: false, error: null }); }
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("o pedido do resumo (H4e)", () => {
  it("o seletor traz os prontos, os modelos da dona e 'A IA escolhe o modelo'; o estilo e as instruções mudam o pedido", () => {
    const aoMudar = vi.fn();
    render(<EscolhaDoModelo valor={PEDIDO_PADRAO} aoMudar={aoMudar} proprios={[PROPRIO]}/>);
    const seletor = screen.getByRole("combobox", { name: "Modelo do resumo" });
    expect(within(seletor).getAllByRole("option").map(opcao => opcao.textContent)).toEqual(["Geral", "Networking", "Mentoria", "Vendas", "1:1", "🎤 Entrevista", "A IA escolhe o modelo"]);
    fireEvent.change(seletor, { target: { value: `proprio:${PROPRIO.id}` } });
    expect(aoMudar).toHaveBeenLastCalledWith({ ...PEDIDO_PADRAO, modelo: `proprio:${PROPRIO.id}` });
    fireEvent.click(screen.getByRole("radio", { name: "Detalhado" }));
    expect(aoMudar).toHaveBeenLastCalledWith({ ...PEDIDO_PADRAO, estilo: "detailed" });
    fireEvent.change(screen.getByLabelText("Instruções para a IA (opcional)"), { target: { value: "Cite os prazos." } });
    expect(aoMudar).toHaveBeenLastCalledWith({ ...PEDIDO_PADRAO, instrucoes: "Cite os prazos." });
  });

  it("o que vai à mutação: o estilo só fora do equilibrado e as instruções só com texto", () => {
    expect(pedidoParaEnviar(PEDIDO_PADRAO)).toEqual({ modelo: "general" });
    expect(pedidoParaEnviar({ modelo: "ia", estilo: "concise", instrucoes: "  x  " })).toEqual({ modelo: "ia", estilo: "concise", instrucoes: "x" });
  });

  it("o refazer começa no pedido atual, leva o modelo da dona, o estilo e as instruções, e diz quantos refazeres restam", () => {
    render(<PainelDeRefazer id="painel" meetingId={REUNIAO} atual={{ modelo: "sales", estilo: "concise", instrucoes: "Preço." }} aoFechar={() => undefined}/>);
    expect(screen.getByRole("radio", { name: "Vendas" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Conciso" })).toBeChecked();
    expect(screen.getByText("Você ainda pode refazer 7 resumos nas próximas 24 horas.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "🎤 Entrevista" }));
    fireEvent.click(screen.getByRole("button", { name: /Refazer o resumo/ }));
    expect(mutacao("refazer").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: `proprio:${PROPRIO.id}`, estilo: "concise", instrucoes: "Preço." });
  });

  it("o teto do refazer e o modelo que sumiu têm frase própria", () => {
    const t = i18n.t.bind(i18n) as never;
    expect(mensagemDoRefazer(t, { message: "REFAZERES_DO_RESUMO_DEMAIS", data: { code: "TOO_MANY_REQUESTS" } })).toBe("Você chegou ao limite de resumos refeitos em 24 horas. Tente de novo mais tarde.");
    expect(mensagemDoRefazer(t, { message: "MODELO_DE_RESUMO_NAO_ENCONTRADO", data: { code: "NOT_FOUND" } })).toBe("Este modelo não existe mais. Atualize a tela.");
  });

  it("antes de gravar: recolhido, diz o padrão da dona; aberto, muda o pedido", () => {
    duble.estado.modelos = { proprios: [PROPRIO], padrao: `proprio:${PROPRIO.id}`, estilo: "balanced", ajusteDoTamanho: 0, refazeresQueRestam: 20 };
    const aoMudar = vi.fn();
    render(<PedidoAntesDeGravar valor={null} aoMudar={aoMudar}/>);
    expect(screen.getByText("Resumo desta reunião", { exact: false }).closest("summary")).toHaveTextContent("Resumo desta reunião: 🎤 Entrevista");
    fireEvent.change(screen.getByRole("combobox", { name: "Modelo do resumo" }), { target: { value: "ia" } });
    expect(aoMudar).toHaveBeenCalledWith({ modelo: "ia", estilo: "balanced", instrucoes: "" });
  });
});

describe("'O resumo teve o tamanho certo?' (H4e)", () => {
  it("responde pela reunião; a resposta marcada fica pressionada e, tocada de novo, desfaz", () => {
    const { rerender } = render(<PerguntaDoTamanho meetingId={REUNIAO} resposta={null}/>);
    expect(screen.getByText("O resumo teve o tamanho certo?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Longo demais" }));
    expect(mutacao("tamanho").mutate).toHaveBeenLastCalledWith({ meetingId: REUNIAO, resposta: "long" });
    rerender(<PerguntaDoTamanho meetingId={REUNIAO} resposta="long"/>);
    expect(screen.getByRole("button", { name: "Longo demais" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Obrigada! Os próximos resumos vão levar isso em conta.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Longo demais" }));
    expect(mutacao("tamanho").mutate).toHaveBeenLastCalledWith({ meetingId: REUNIAO, resposta: null });
  });

  it("em inglês, a pergunta do HiNoter", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    render(<PerguntaDoTamanho meetingId={REUNIAO} resposta={null}/>);
    expect(screen.getByText("Was this summary the right length?")).toBeInTheDocument();
  });
});

describe("Meus modelos de resumo (H4e)", () => {
  it("lista os modelos da dona; Novo modelo abre o formulário e cria com nome, ícone e instruções", () => {
    render(<MeusModelosDeResumo/>);
    expect(screen.getByText("Entrevista")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Novo modelo/ }));
    const salvar = screen.getByRole("button", { name: "Salvar" });
    expect(salvar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: " Podcast " } });
    fireEvent.click(screen.getByRole("radio", { name: "📚" }));
    fireEvent.change(screen.getByLabelText("Instruções para a IA"), { target: { value: "Destaque os temas e as citações." } });
    expect(screen.getByText(/vão à IA \(Google Gemini\)/)).toBeInTheDocument();
    fireEvent.click(salvar);
    expect(mutacao("criar").mutate).toHaveBeenCalledWith({ nome: "Podcast", icone: "📚", instrucoes: "Destaque os temas e as citações." });
  });

  it("editar manda o id; apagar pede confirmação", () => {
    render(<MeusModelosDeResumo/>);
    fireEvent.click(screen.getByRole("button", { name: "Editar Entrevista" }));
    expect(screen.getByLabelText("Nome")).toHaveValue("Entrevista");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Entrevistas" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutacao("editar").mutate).toHaveBeenCalledWith({ id: PROPRIO.id, nome: "Entrevistas", icone: "🎤", instrucoes: PROPRIO.instrucoes });
    const confirmar = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Apagar Entrevista" }));
    expect(mutacao("apagar")?.mutate ?? vi.fn()).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apagar Entrevista" }));
    expect(mutacao("apagar").mutate).toHaveBeenCalledWith({ id: PROPRIO.id });
    confirmar.mockRestore();
  });

  it("o padrão: o modelo (também o da dona ou 'A IA escolhe') e o estilo, salvos juntos", () => {
    render(<MeusModelosDeResumo/>);
    const salvar = screen.getByRole("button", { name: "Salvar o padrão" });
    expect(salvar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Modelo padrão dos próximos resumos"), { target: { value: "ia" } });
    fireEvent.change(screen.getByLabelText("Estilo padrão"), { target: { value: "concise" } });
    fireEvent.click(salvar);
    expect(mutacao("preferencias").mutate).toHaveBeenCalledWith({ padrao: "ia", estilo: "concise" });
  });

  it("as recusas do servidor saem traduzidas (nome repetido, teto)", () => {
    render(<MeusModelosDeResumo/>);
    fireEvent.click(screen.getByRole("button", { name: /Novo modelo/ }));
    Object.assign(mutacao("criar"), { isError: true, error: { message: "MODELO_DE_RESUMO_NOME_REPETIDO", data: { code: "CONFLICT" } } });
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "X" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Você já tem um modelo com esse nome.");
  });
});
