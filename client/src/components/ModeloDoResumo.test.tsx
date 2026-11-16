import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ResumoGuardado } from "./ResumoGuardado";

/**
 * Os modelos do resumo na tela (H4d): a escolha do modelo antes de gerar o
 * resumo que a reunião não tem, o "Refazer como…" do resumo pronto (ou do que
 * falhou), a versão anterior só para ler enquanto a nova é escrita ou se ela
 * falhou, e nada disso pelo link aberto. As mutações são dublês, como em
 * ResumoGuardado.test.tsx; o que o servidor faz está nos testes dele
 * (server/resumo-guardado.test.ts, server/resumo-refeito.integracao.test.ts).
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      pedirResumo: duble.registrar("pedirResumo"),
      refazerResumo: duble.registrar("refazerResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink") },
    // O "Tentar de novo" do evento da próxima ação que ficou na Google Agenda (H5c): o resumo guardado o monta.
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const ITENS = [
  { id: "i-acao", section: "action", position: 0, subject: null, text: "Enviar a proposta revisada", assignee: null, due: null, excerpt: "eu mando a proposta revisada até sexta-feira", startSeconds: 75, status: "pending", done: false },
  { id: "i-acao-feita", section: "action", position: 1, subject: null, text: "Reservar a sala de reunião", assignee: null, due: null, excerpt: "a sala já está reservada para quinta", startSeconds: 130, status: "confirmed", done: true },
  { id: "i-decisao", section: "decision", position: 2, subject: null, text: "Não renovar com a transportadora antiga.", assignee: null, due: null, excerpt: "decidimos não renovar com a transportadora", startSeconds: 320, status: "pending", done: false },
  { id: "i-ignorado", section: "decision", position: 3, subject: null, text: "Abrir um escritório em Berlim.", assignee: null, due: null, excerpt: "talvez abrir um escritório em Berlim", startSeconds: 400, status: "ignored", done: false },
] as const;

// Pelo link: sem ids, sem a caixa de feito e sem os ignorados.
const ITENS_DO_LINK = ITENS.filter(item => item.status !== "ignored").map(({ id: _i, position: _p, done: _d, ...item }) => item);

const consulta = (data: unknown) => ({ data, isError: false, error: null as unknown, refetch: vi.fn() });
// versaoAnterior: o resumo está sendo refeito, ou o refazer falhou, e os itens são os da versão anterior.
const daDonaCom = (estado: string, modelo: string | null, itens: readonly unknown[] = [], versaoAnterior = false) =>
  consulta({ estado, emoji: null, idioma: "pt-BR", modelo, erro: null, versaoAnterior, itens });
const doLinkCom = (estado: string, itens: readonly unknown[] = [], versaoAnterior = false) => consulta({ estado, emoji: null, versaoAnterior, itens });
const daDona = (c: ReturnType<typeof consulta>) => render(<ResumoGuardado meetingId={REUNIAO} consulta={c as never}/>);
const doLink = (c: ReturnType<typeof consulta>) => render(<ResumoGuardado token={TOKEN} consulta={c as never}/>);
const mutacao = (nome: string) => duble.mutacoes[nome];
const preparar = (nome: string, estado: Partial<{ isPending: boolean; isError: boolean; error: unknown }>) => {
  duble.mutacoes[nome] ??= { mutate: vi.fn(), opcoes: {}, isPending: false, isError: false, error: null };
  Object.assign(duble.mutacoes[nome], estado);
};
const abrirRefazer = () => fireEvent.click(screen.getByRole("button", { name: "Refazer como…" }));

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) Object.assign(m, { isPending: false, isError: false, error: null });
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Modelos do resumo — escolher antes de gerar", () => {
  it("sem resumo: o seletor traz os cinco modelos (o Geral marcado, com a descrição) e o 'Gerar resumo' pede no escolhido", () => {
    daDona(daDonaCom("sem_resumo", null));
    const seletor = screen.getByRole("combobox", { name: "Modelo do resumo" });
    expect(within(seletor).getAllByRole("option").map(opcao => opcao.textContent)).toEqual(["Geral", "Networking", "Mentoria", "Vendas", "1:1"]);
    expect(seletor).toHaveValue("general");
    expect(seletor).toHaveAccessibleDescription(/O formato padrão: ações, foco, tarefas por assunto/);
    fireEvent.change(seletor, { target: { value: "sales" } });
    expect(seletor).toHaveAccessibleDescription(/O que o cliente disse que precisa, a proposta/);
    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));
    expect(mutacao("pedirResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: "sales" });
    // Ainda não há resumo para refazer.
    expect(screen.queryByRole("button", { name: "Refazer como…" })).not.toBeInTheDocument();
  });

  it("enquanto o pedido está no ar, o seletor fica desligado junto do botão", () => {
    preparar("pedirResumo", { isPending: true });
    daDona(daDonaCom("sem_resumo", null));
    expect(screen.getByRole("combobox", { name: "Modelo do resumo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Gerar resumo/ })).toBeDisabled();
  });
});

describe("Modelos do resumo — 'Refazer como…'", () => {
  it("pronto: mostra o modelo e abre o painel com o atual marcado, o que fica e o que é trocado", () => {
    daDona(daDonaCom("pronto", "sales", ITENS));
    expect(screen.getByText("Modelo: Vendas")).toBeInTheDocument();
    const botao = screen.getByRole("button", { name: "Refazer como…" });
    expect(botao).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    abrirRefazer();
    expect(botao).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(botao.getAttribute("aria-controls")!)).toContainElement(screen.getByRole("radio", { name: "Vendas" }));
    expect(screen.getAllByRole("radio").map(radio => radio.getAttribute("value"))).toEqual(["general", "networking", "mentoring", "sales", "one_on_one"]);
    expect(screen.getByRole("radio", { name: "Vendas" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Networking" })).toHaveAccessibleDescription(/Quem é quem, o que cada pessoa oferece e procura/);
    // Fica também o que a dona escreveu ou editou (H4f), mesmo ignorado: é o que a fila guarda.
    expect(screen.getByText(/Ficam os itens que você confirmou, as ações marcadas como feitas e os itens que você escreveu ou editou, mesmo ignorados\. Os outros itens para conferir e os ignorados são trocados/)).toBeInTheDocument();
  });

  it("escolher outro modelo e 'Refazer o resumo' pede o refazer nele; Cancelar fecha sem pedir", () => {
    daDona(daDonaCom("pronto", "general", ITENS));
    abrirRefazer();
    fireEvent.click(screen.getByRole("radio", { name: "Networking" }));
    fireEvent.click(screen.getByRole("button", { name: /Refazer o resumo/ }));
    expect(mutacao("refazerResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: "networking" });

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refazer como…" })).toHaveAttribute("aria-expanded", "false");
    expect(mutacao("refazerResumo").mutate).toHaveBeenCalledTimes(1);
  });

  it("aceito o pedido, o painel fecha, e o resumo é relido (o onSettled devolve a releitura)", () => {
    const releitura = Promise.resolve();
    duble.utils.meetings.resumoGuardado.invalidate.mockReturnValue(releitura);
    daDona(daDonaCom("pronto", "general", ITENS));
    abrirRefazer();
    expect(mutacao("refazerResumo").opcoes.onSettled?.()).toBe(releitura);
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    act(() => { mutacao("refazerResumo").opcoes.onSuccess?.(); });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("o pedido recusado mostra o motivo traduzido: o teto de pedidos, e o resumo que já está sendo escrito", () => {
    preparar("refazerResumo", { isError: true, error: { message: "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.", data: { code: "TOO_MANY_REQUESTS" } } });
    const { unmount } = daDona(daDonaCom("pronto", "general", ITENS));
    abrirRefazer();
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
    unmount();
    preparar("refazerResumo", { isError: true, error: { message: "O resumo desta reunião está sendo refeito. Espere terminar para decidir.", data: { code: "CONFLICT" } } });
    daDona(daDonaCom("pronto", "general", ITENS));
    abrirRefazer();
    expect(screen.getByRole("alert")).toHaveTextContent("A IA está escrevendo o resumo desta reunião.");
  });

  it("enquanto o pedido está no ar, o botão e a escolha ficam desligados (um pedido por vez)", () => {
    preparar("refazerResumo", { isPending: true });
    daDona(daDonaCom("pronto", "general", ITENS));
    abrirRefazer();
    expect(screen.getByRole("button", { name: /Refazer o resumo/ })).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});

describe("Modelos do resumo — a versão anterior enquanto a nova é escrita", () => {
  it.each(["pendente", "gerando"])("%s com a versão anterior (refazendo): o aviso com o modelo e os itens só para ler", estado => {
    daDona(daDonaCom(estado, "sales", ITENS, true));
    expect(screen.getByRole("status")).toHaveTextContent("Refazendo o resumo como Vendas. Ficam os itens que você confirmou, escreveu ou editou; os outros serão trocados. Espere terminar para conferir.");
    // A versão anterior na tela, sem decidir nada.
    expect(screen.getByText("Enviar a proposta revisada")).toBeInTheDocument();
    expect(screen.getByText("Não renovar com a transportadora antiga.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirmar$|^Ignorar$|Confirmar todos/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Escrito pela IA a partir da transcrição/)).not.toBeInTheDocument();
    for (const caixa of screen.getAllByRole("checkbox")) expect(caixa).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Reservar a sala de reunião" })).toBeChecked();
    // Os ignorados abrem, sem o Desfazer.
    fireEvent.click(screen.getByRole("button", { name: "Ignorados (1)" }));
    expect(screen.getByText("Abrir um escritório em Berlim.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desfazer" })).not.toBeInTheDocument();
    // E nada de refazer de novo no meio.
    expect(screen.queryByRole("button", { name: "Refazer como…" })).not.toBeInTheDocument();
  });

  it("a versão nova falhou: o aviso com o modelo, 'Tentar de novo' no mesmo modelo, e a dona decide sobre a anterior; dá para refazer em outro", () => {
    daDona(daDonaCom("falhou", "networking", ITENS, true));
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível refazer o resumo como Networking. Abaixo está a versão anterior.");
    fireEvent.click(within(alerta).getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    // Nenhuma geração está em curso: a versão anterior vale, e a dona confere,
    // marca e desfaz como no resumo pronto (o próximo refazer guarda o que ela confirmar).
    const pendente = screen.getByText("Enviar a proposta revisada").closest("li") as HTMLElement;
    fireEvent.click(within(pendente).getByRole("button", { name: "Confirmar" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenCalledWith({ itemId: "i-acao", status: "confirmed" });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar todos (2)" }));
    expect(mutacao("confirmarItensDoResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    const feita = screen.getByRole("checkbox", { name: "Reservar a sala de reunião" });
    expect(feita).toBeEnabled();
    fireEvent.click(feita);
    // Com o fuso do aparelho e os rótulos da tela: a próxima ação reaberta volta à Google Agenda (H5c).
    expect(mutacao("marcarAcaoFeita").mutate).toHaveBeenCalledWith({ itemId: "i-acao-feita", feito: false, fuso: expect.any(String), rotulos: expect.any(Object) });
    fireEvent.click(screen.getByRole("button", { name: "Ignorados (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    expect(mutacao("decidirItemDoResumo").mutate).toHaveBeenCalledWith({ itemId: "i-ignorado", status: "pending" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    abrirRefazer();
    expect(screen.getByRole("radio", { name: "Networking" })).toBeChecked();
  });

  it("o primeiro resumo que falhou (sem itens): o aviso de sempre, e também dá para pedir em outro modelo", () => {
    daDona(daDonaCom("falhou", "general"));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível gerar o resumo desta reunião.");
    expect(screen.queryByText(/Abaixo está a versão anterior/)).not.toBeInTheDocument();
    abrirRefazer();
    fireEvent.click(screen.getByRole("radio", { name: "Mentoria" }));
    fireEvent.click(screen.getByRole("button", { name: /Refazer o resumo/ }));
    expect(mutacao("refazerResumo").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, modelo: "mentoring" });
  });
});

describe("Modelos do resumo — o link aberto não escolhe nem refaz", () => {
  it("sem resumo: só o 'Pedir resumo', sem seletor; pronto: sem o modelo e sem o 'Refazer como…'", () => {
    const { unmount } = doLink(consulta({ estado: "sem_resumo", emoji: null, itens: [] }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Pedir resumo/ }));
    expect(mutacao("pedirResumoPeloLink").mutate).toHaveBeenCalledWith({ token: TOKEN });
    unmount();
    doLink(consulta({ estado: "pronto", emoji: null, itens: ITENS.filter(item => item.status !== "ignored").map(({ id: _i, position: _p, done: _d, ...item }) => item) }));
    expect(screen.queryByRole("button", { name: "Refazer como…" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Modelo:/)).not.toBeInTheDocument();
  });

  it("pelo link, o primeiro resumo sendo gerado: o aviso de que a IA está escrevendo", () => {
    doLink(doLinkCom("pendente"));
    expect(screen.getByRole("status")).toHaveTextContent("A IA está escrevendo o resumo desta reunião.");
  });

  it.each(["pendente", "gerando"])("pelo link, durante o refazer da dona (%s): a versão anterior, com o aviso de que ela pediu uma nova, só para ler", estado => {
    doLink(doLinkCom(estado, ITENS_DO_LINK, true));
    expect(screen.getByRole("status")).toHaveTextContent("A dona da reunião pediu uma nova versão deste resumo, que ainda não está pronta. Abaixo está a versão anterior.");
    expect(screen.queryByText(/A IA está escrevendo/)).not.toBeInTheDocument();
    // O link não recebe o modelo: nada de "Refazendo o resumo como Geral".
    expect(screen.queryByText(/Refazendo o resumo como/)).not.toBeInTheDocument();
    expect(screen.getByText("Enviar a proposta revisada")).toBeInTheDocument();
    expect(screen.getByText("Reservar a sala de reunião")).toBeInTheDocument();
    expect(screen.getAllByText("Gerado pela IA; a dona da reunião ainda não conferiu.")).toHaveLength(2);
    // Nenhum botão de decidir: só o "Ouvir o resumo" (H19), que lê a versão que está na tela.
    expect(screen.getAllByRole("button").map(botao => botao.textContent?.trim())).toEqual(["Ouvir o resumo"]);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("pelo link, o refazer que falhou: a versão anterior, com o aviso, e sem 'Tentar de novo' (refazer é da dona)", () => {
    preparar("pedirResumoPeloLink", { isError: true, error: { message: "Muitos pedidos à IA por este link em sequência. Aguarde alguns minutos e tente de novo.", data: { code: "TOO_MANY_REQUESTS" } } });
    const { unmount } = doLink(doLinkCom("falhou", ITENS_DO_LINK, true));
    expect(screen.getByRole("status")).toHaveTextContent("A dona da reunião pediu uma nova versão deste resumo, que ainda não está pronta. Abaixo está a versão anterior.");
    expect(screen.getByText("Não renovar com a transportadora antiga.")).toBeInTheDocument();
    expect(screen.queryByText(/Não foi possível/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Só o "Ouvir o resumo" (H19): a versão anterior segue valendo e se ouve.
    expect(screen.getAllByRole("button").map(botao => botao.textContent?.trim())).toEqual(["Ouvir o resumo"]);
    unmount();
    // Também quando a versão anterior não tem item para mostrar.
    doLink(doLinkCom("falhou", [], true));
    expect(screen.getByText("Nenhum item para mostrar neste resumo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar de novo/ })).not.toBeInTheDocument();
  });

  it("pelo link, o primeiro resumo que falhou: 'Tentar de novo' pede pelo token", () => {
    doLink(doLinkCom("falhou"));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível gerar o resumo desta reunião.");
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirResumoPeloLink").mutate).toHaveBeenCalledWith({ token: TOKEN });
  });
});

describe("Modelos do resumo — no idioma da tela", () => {
  it("em inglês, os nomes, o botão e o aviso saem traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    daDona(daDonaCom("pronto", "one_on_one", ITENS));
    expect(screen.getByText("Template: 1:1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo as…" }));
    expect(screen.getAllByRole("radio").map(radio => radio.labels?.[0]?.textContent)).toEqual(["General", "Networking", "Mentoring", "Sales", "1:1"]);
    expect(screen.getByText(/Items you confirmed, actions marked as done and items you wrote or edited stay, even if ignored\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Redo summary/ })).toBeInTheDocument();
  });
});
