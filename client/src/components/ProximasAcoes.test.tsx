import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { hojeNoRelogio, MENSAGEM_ACAO_NAO_ENCONTRADA, MENSAGEM_CONTATO_FORA_DA_REDE } from "@shared/proximas-acoes";
import { CartaoDeProximasAcoes, mensagemDoErroDaAcao, ProximasAcoes, type ProximaAcao } from "./ProximasAcoes";

/**
 * As próximas ações na tela (H5a): o cartão do Dashboard e a lista da página.
 * As consultas e as mutações são dublês que registram o que a tela pede; o que
 * o servidor faz está em server/proximas-acoes.ts e nos testes dele.
 */

type Opcoes = { onError?: (erro: unknown) => void; onSettled?: () => unknown; onSuccess?: () => void };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: (...args: unknown[]) => void; chamadas: unknown[][]; opcoes: Opcoes }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { chamadas: [], opcoes, mutate: (...args: unknown[]) => { m.chamadas.push(args); } });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  const consultas: Record<string, { data?: unknown; isError?: boolean; error?: unknown }> = {};
  const entradas: Record<string, unknown[]> = {};
  const consultar = (nome: string) => ({
    useQuery: (entrada?: unknown) => {
      (entradas[nome] ??= []).push(entrada);
      return { data: undefined, isError: false, error: null, refetch: () => undefined, ...(consultas[nome] ?? {}) };
    },
  });
  const invalidados: string[] = [];
  return {
    mutacoes, registrar, consultas, entradas, consultar, invalidados,
    utils: {
      proximasAcoes: { invalidate: () => { invalidados.push("proximasAcoes"); return Promise.resolve(); } },
      meetings: { resumoGuardado: { invalidate: () => { invalidados.push("resumoGuardado"); return Promise.resolve(); } } },
      networkInteligente: { contato: { invalidate: () => { invalidados.push("perfilDoContato"); return Promise.resolve(); } } },
      googleAgenda: { estado: { invalidate: () => { invalidados.push("googleAgenda"); return Promise.resolve(); } } },
    },
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    proximasAcoes: {
      doPainel: duble.consultar("doPainel"),
      listar: duble.consultar("listar"),
      marcarFeita: duble.registrar("marcarFeita"),
      ligarContato: duble.registrar("ligarContato"),
      editar: duble.registrar("editar"),
      apagar: duble.registrar("apagar"),
      criar: duble.registrar("criar"),
      mandarParaGoogle: duble.registrar("mandarParaGoogle"),
      tirarDaGoogle: duble.registrar("tirarDaGoogle"),
    },
    network: { list: duble.consultar("network.list") },
    googleAgenda: { estado: duble.consultar("googleAgenda.estado") },
  },
}));

const ontem = hojeNoRelogio(new Date(Date.now() - 24 * 60 * 60 * 1000));
const hoje = hojeNoRelogio();

const acao = (extra: Partial<ProximaAcao & { contatoSugerido: { id: number; nome: string } | null }> = {}) => ({
  id: "acao-1", texto: "{F2} envia a proposta revisada", detalhe: null, responsavel: "{F2}", prazo: null, prazoDito: "até sexta-feira",
  origem: "reuniao", feita: false, feitaEm: null, trecho: "eu mando a proposta até sexta", createdAt: 1,
  reuniao: { id: "reuniao-1", titulo: "Reunião com a Carla", itemId: "item-1", itemDaDona: false }, vozes: { F2: "Carla" }, contato: null,
  contatoSugerido: null, ...extra,
}) as ProximaAcao;

const chamadas = (nome: string) => duble.mutacoes[nome]?.chamadas ?? [];
/** O que toda mutação que pode levar a ação à Google manda (H5c): o fuso do aparelho e os rótulos da tela, em pt-BR. */
const PEDIDO = { fuso: expect.any(String), rotulos: { voz: "Falante {n}", responsavel: "Responsável: {nome}" } };
const itemDoTexto = (texto: string | RegExp) => screen.getByText(texto).closest("li") as HTMLElement;

beforeEach(() => {
  for (const chave of Object.keys(duble.consultas)) delete duble.consultas[chave];
  for (const chave of Object.keys(duble.entradas)) delete duble.entradas[chave];
  for (const m of Object.values(duble.mutacoes)) m.chamadas.length = 0;
  duble.invalidados.length = 0;
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("o cartão do Dashboard", () => {
  it("erro de consulta é erro, nunca 'nenhuma ação'", () => {
    duble.consultas.doPainel = { isError: true, error: { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } } };
    render(<CartaoDeProximasAcoes/>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma ação aberta/)).not.toBeInTheDocument();
  });

  it("carregando, e depois vazio com o convite a confirmar no resumo; 'Ver todas' leva à página", () => {
    const { rerender } = render(<CartaoDeProximasAcoes/>);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando as próximas ações…");
    duble.consultas.doPainel = { data: { acoes: [], abertas: 0 } };
    rerender(<CartaoDeProximasAcoes/>);
    expect(screen.getByText(/Nenhuma ação aberta\. Confirme as ações e tarefas no resumo de uma reunião/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todas" })).toHaveAttribute("href", "/proximas-acoes");
  });

  it("as abertas: o nome da voz no lugar do rótulo, o selo de atrasada, quantas há; a caixa marca pela ação", () => {
    duble.consultas.doPainel = { data: { acoes: [acao({ prazo: ontem }), acao({ id: "acao-2", texto: "Ligar para {F3}", responsavel: null, prazo: hoje })], abertas: 7 } };
    render(<CartaoDeProximasAcoes/>);
    expect(screen.getByRole("heading", { name: "Próximas ações" })).toBeInTheDocument();
    expect(screen.getByText("Abertas: 7")).toBeInTheDocument();
    const primeira = itemDoTexto("Carla envia a proposta revisada");
    expect(within(primeira).getByText("Atrasada")).toBeInTheDocument();
    expect(within(primeira).getByText("Responsável: Carla")).toBeInTheDocument();
    // A voz sem nome é "Falante n", nunca o rótulo cru.
    expect(within(itemDoTexto("Ligar para Falante 3")).getByText("Vence hoje")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Carla envia a proposta revisada" }));
    // O fuso e os rótulos da tela vão junto: com a Google Agenda conectada, o evento anda com a ação (H5c).
    expect(chamadas("marcarFeita")).toEqual([[{ id: "acao-1", feita: true, ...PEDIDO }]]);
    // Compacto: nada de editar, apagar ou ligar contato no cartão.
    expect(screen.queryByRole("button", { name: /Editar|Apagar|Vincular/ })).not.toBeInTheDocument();
  });

  it("marcar relê as ações, o resumo (o item muda junto) e o perfil do contato (a seção e a linha do tempo da H5b)", async () => {
    duble.consultas.doPainel = { data: { acoes: [acao()], abertas: 1 } };
    render(<CartaoDeProximasAcoes/>);
    await duble.mutacoes.marcarFeita.opcoes.onSettled?.();
    expect(duble.invalidados.sort()).toEqual(["perfilDoContato", "proximasAcoes", "resumoGuardado"]);
  });
});

describe("a lista da página", () => {
  it("de onde veio: o link do item na reunião, a reunião excluída e a anotada à mão", () => {
    render(<ProximasAcoes acoes={[
      acao(),
      acao({ id: "solta", texto: "Mandar o orçamento", reuniao: null, vozes: {}, trecho: null }),
      acao({ id: "manual", texto: "Revisar o contrato", origem: "manual", reuniao: null, vozes: {}, trecho: null, responsavel: null }),
    ]}/>);
    expect(screen.getByRole("link", { name: "Da reunião: Reunião com a Carla" })).toHaveAttribute("href", "/meetings/reuniao-1?item=item-1");
    expect(within(itemDoTexto("Mandar o orçamento")).getByText("A reunião desta ação foi excluída.")).toBeInTheDocument();
    expect(within(itemDoTexto("Revisar o contrato")).getByText("Anotada por você")).toBeInTheDocument();
    expect(within(itemDoTexto("Carla envia a proposta revisada")).getByText("Prazo dito na reunião: até sexta-feira")).toBeInTheDocument();
  });

  it("a sugestão de contato pergunta, e 'Vincular' liga o contato sugerido", () => {
    render(<ProximasAcoes acoes={[acao({ contatoSugerido: { id: 7, nome: "Carla Souza" } })]}/>);
    expect(screen.getByText("É Carla Souza, da sua rede?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    expect(chamadas("ligarContato")).toEqual([[{ id: "acao-1", contactId: 7 }]]);
  });

  it("o contato ligado leva ao perfil dele, e 'Tirar o vínculo' manda null", () => {
    render(<ProximasAcoes acoes={[acao({ contato: { id: 5, nome: "Bia Lima" } })]}/>);
    expect(screen.getByRole("link", { name: "Contato: Bia Lima" })).toHaveAttribute("href", "/meu-network-inteligente/contatos/5");
    fireEvent.click(screen.getByRole("button", { name: "Tirar o vínculo" }));
    expect(chamadas("ligarContato")).toEqual([[{ id: "acao-1", contactId: null }]]);
  });

  it("no perfil do próprio contato (H5b), o link para ele mesmo some; o de outro contato e o 'Tirar o vínculo' ficam", () => {
    render(<ProximasAcoes contatoDaPagina={5} acoes={[
      acao({ contato: { id: 5, nome: "Bia Lima" } }),
      acao({ id: "acao-2", texto: "Ligar para a Ana", contato: { id: 6, nome: "Ana Prado" } }),
    ]}/>);
    expect(screen.queryByRole("link", { name: "Contato: Bia Lima" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contato: Ana Prado" })).toHaveAttribute("href", "/meu-network-inteligente/contatos/6");
    fireEvent.click(within(itemDoTexto("Carla envia a proposta revisada")).getByRole("button", { name: "Tirar o vínculo" }));
    expect(chamadas("ligarContato")).toEqual([[{ id: "acao-1", contactId: null }]]);
  });

  it("'Vincular a um contato' busca na rede pelo nome do responsável e liga o escolhido", () => {
    duble.consultas["network.list"] = { data: { data: [{ id: 9, fullName: "Carla Mendes", company: "Café SA" }], total: 1 } };
    render(<ProximasAcoes acoes={[acao()]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Vincular a um contato" }));
    expect(screen.getByLabelText("Buscar contato pelo nome")).toHaveValue("Carla");
    expect(duble.entradas["network.list"]?.at(-1)).toEqual({ q: "Carla", limit: 8 });
    fireEvent.click(screen.getByRole("button", { name: /Carla Mendes/ }));
    expect(chamadas("ligarContato")[0][0]).toEqual({ id: "acao-1", contactId: 9 });
  });

  it("apagar a ação presa ao item avisa que ele volta a 'para conferir', e só apaga no 'Sim'", () => {
    render(<ProximasAcoes acoes={[acao()]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    expect(screen.getByText("Apagar esta ação? O item volta a ficar para conferir no resumo da reunião.")).toBeInTheDocument();
    expect(chamadas("apagar")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Sim, apagar" }));
    expect(chamadas("apagar")).toEqual([[{ id: "acao-1" }]]);
  });

  // O item que a dona escreveu, acrescentado ou editado (H4f), não volta a
  // "para conferir": vai para os ignorados (server/proximas-acoes.ts).
  it("apagar a ação do item que a dona escreveu avisa que ele vai para os ignorados", () => {
    render(<ProximasAcoes acoes={[acao({ reuniao: { id: "reuniao-1", titulo: "Reunião com a Carla", itemId: "item-1", itemDaDona: true } })]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    expect(screen.getByText("Apagar esta ação? O item que você escreveu vai para os ignorados no resumo da reunião, e o Desfazer de lá o traz de volta.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sim, apagar" }));
    expect(chamadas("apagar")).toEqual([[{ id: "acao-1" }]]);
  });

  it("apagar a manual pergunta sem falar de resumo; Cancelar não apaga", () => {
    render(<ProximasAcoes acoes={[acao({ origem: "manual", reuniao: null, vozes: {} })]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    expect(screen.getByText("Apagar esta ação?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Apagar esta ação?")).not.toBeInTheDocument();
    expect(chamadas("apagar")).toEqual([]);
  });

  it("editar abre com o texto como a dona o lê e manda só o que mudou", () => {
    render(<ProximasAcoes acoes={[acao({ prazo: "2026-11-20" })]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByLabelText("O que fazer")).toHaveValue("Carla envia a proposta revisada");
    expect(screen.getByLabelText("Responsável (opcional)")).toHaveValue("Carla");
    expect(screen.getByLabelText("Prazo (opcional)")).toHaveValue("2026-11-20");
    fireEvent.change(screen.getByLabelText("Prazo (opcional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    // O prazo mudou: vai com o fuso do aparelho, para o lembrete no sino (H15), e os rótulos da tela, para o evento (H5c).
    expect(chamadas("editar")[0][0]).toEqual({ id: "acao-1", prazo: "", ...PEDIDO });
  });

  it("editar só o texto não manda o prazo (o lembrete fica como está); o fuso e os rótulos vão, para o evento na Google (H5c)", () => {
    render(<ProximasAcoes acoes={[acao({ prazo: "2026-11-20" })]}/>);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("O que fazer"), { target: { value: "Carla envia o contrato" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(chamadas("editar")[0][0]).toEqual({ id: "acao-1", texto: "Carla envia o contrato", ...PEDIDO });
  });

  it("a ação do lembrete no sino (?acao=, H15) fica destacada e a lista rola até ela uma vez", () => {
    const rolar = vi.fn();
    Element.prototype.scrollIntoView = rolar;
    try {
      const lista = [acao(), acao({ id: "acao-2", texto: "Ligar para a Bia", responsavel: null })];
      const { rerender } = render(<ProximasAcoes acoes={lista} destacada="acao-2"/>);
      const destacada = document.getElementById("proxima-acao-acao-2");
      expect(destacada).toHaveAttribute("data-destacada", "true");
      expect(document.getElementById("proxima-acao-acao-1")).not.toHaveAttribute("data-destacada");
      expect(rolar).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(destacada);
      // A mesma ação de novo (a lista relida depois de marcar): não rola outra vez.
      rerender(<ProximasAcoes acoes={[...lista]} destacada="acao-2"/>);
      expect(rolar).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("o recuo segue a direção do idioma (o início da linha, não a esquerda): no árabe, fica do lado da caixa", () => {
    render(<ProximasAcoes acoes={[acao({ detalhe: "Com o desconto combinado" })]}/>);
    const item = itemDoTexto("Carla envia a proposta revisada");
    // A linha do prazo e do responsável, o bloco do detalhe e a citação do trecho.
    expect(within(item).getByText("Responsável: Carla").parentElement).toHaveClass("ps-7");
    expect(within(item).getByText("Com o desconto combinado").parentElement).toHaveClass("ps-7");
    expect(item.querySelector("q")).toHaveClass("border-s-2", "ps-3");
  });

  it("um e-mail no texto, no detalhe ou no responsável quebra a linha em vez de passar da largura do celular", () => {
    const email = "joana.representante@farmabras.com.br";
    render(<ProximasAcoes acoes={[acao({ texto: `Mandar a proposta para ${email}`, detalhe: `Cópia para ${email}`, responsavel: email, vozes: {} })]}/>);
    // O jsdom não calcula layout: o que se trava é a regra de CSS de cada lugar.
    const texto = screen.getByText(`Mandar a proposta para ${email}`);
    // O item inteiro quebra a palavra em qualquer ponto (o texto, o detalhe e o responsável herdam a regra)...
    expect(texto.closest("li")).toHaveClass("wrap-anywhere");
    // ...e o texto, item de flex ao lado da caixa, pode encolher abaixo da palavra mais longa.
    expect(texto).toHaveClass("min-w-0");
    expect(texto.closest("li")).toContainElement(screen.getByText(`Responsável: ${email}`));
    expect(texto.closest("li")).toContainElement(screen.getByText(`Cópia para ${email}`));
  });

  it("a consulta da Google Agenda que falha é erro, nunca 'não conectada': o aviso da Agenda, com Tentar de novo (H5c)", () => {
    const refetch = vi.fn();
    duble.consultas["googleAgenda.estado"] = { isError: true, error: { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch } as never;
    const { unmount } = render(<ProximasAcoes acoes={[acao({ prazo: "2099-11-20" })]}/>);
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não deu para saber se a sua Google Agenda está conectada.");
    expect(alerta).toHaveTextContent(/Banco de dados indisponível/);
    fireEvent.click(within(alerta).getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount();
    // Sem ação aberta com prazo, o estado da Google não muda nada na lista: nenhum aviso.
    render(<ProximasAcoes acoes={[acao(), acao({ id: "acao-2", texto: "Ligar para a Bia", prazo: "2099-11-20", feita: true, feitaEm: 5 })]}/>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("feita fica riscada e a caixa marcada; desmarcar manda feita: false", () => {
    render(<ProximasAcoes acoes={[acao({ feita: true, feitaEm: 5, prazo: ontem })]}/>);
    const caixa = screen.getByRole("checkbox", { name: "Carla envia a proposta revisada" });
    expect(caixa).toBeChecked();
    // Feita não está atrasada.
    expect(screen.queryByText("Atrasada")).not.toBeInTheDocument();
    fireEvent.click(caixa);
    expect(chamadas("marcarFeita")).toEqual([[{ id: "acao-1", feita: false, ...PEDIDO }]]);
  });
});

describe("as recusas do servidor, no idioma da tela", () => {
  it("as frases conhecidas viram a chave traduzida; o resto, o aviso genérico de salvar", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    const t = i18n.t.bind(i18n) as (chave: string) => string;
    expect(mensagemDoErroDaAcao(t, { message: MENSAGEM_ACAO_NAO_ENCONTRADA, data: { code: "NOT_FOUND" } })).toBe("This next action no longer exists. Refresh the page.");
    expect(mensagemDoErroDaAcao(t, { message: MENSAGEM_CONTATO_FORA_DA_REDE, data: { code: "NOT_FOUND" } })).toBe("This contact isn't in your network.");
    expect(mensagemDoErroDaAcao(t, { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } })).toBe("Database unavailable; please try again in a moment");
    expect(mensagemDoErroDaAcao(t, { message: "Prazo inválido.", data: { code: "BAD_REQUEST" } })).toBe("Couldn't save. Please try again.");
  });
});
