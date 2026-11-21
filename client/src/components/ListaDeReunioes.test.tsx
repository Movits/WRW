import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { MENSAGEM_BUSCAS_DEMAIS } from "@shared/busca-de-reunioes";
import { ListaDeReunioes, type ReuniaoDaLista } from "./ListaDeReunioes";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * A lista das reuniões com a busca, os filtros e as buscas recentes (H7b) e a
 * escolha para juntar (H17). O React Query e os hooks do tRPC são os de
 * verdade; a rede é um link falso, que responde pela rota. O SQL da busca está
 * em server/busca-de-reunioes.integracao.test.ts.
 */
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;
const REUNIOES: ReuniaoDaLista[] = [
  { id: "a1a1a1a1-0000-4000-8000-000000000001", title: "Reunião com a importadora", createdAt: AGORA - DIA, status: "ready", origem: "gravacao", etiquetas: ["Clientes"], ondeFoi: "Zoom", contactId: 7, contatoNome: "Carla Mendes" },
  { id: "a1a1a1a1-0000-4000-8000-000000000002", title: "Mentoria de exportação", createdAt: AGORA - 2 * DIA, status: "ready", origem: "arquivo", etiquetas: ["Mentoria"], contextId: "c1c1c1c1-0000-4000-8000-000000000009", contextoNome: "Feira de Milão" },
  { id: "a1a1a1a1-0000-4000-8000-000000000003", title: "Contrato em PDF", createdAt: AGORA - 3 * DIA, status: "ready", origem: "pdf" },
  { id: "a1a1a1a1-0000-4000-8000-000000000004", title: "Gravando agora", createdAt: AGORA, status: "recording", origem: "gravacao" },
];

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
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 429 } } });

const aoAbrir = vi.fn();
function abrir(conta: string | null = "dona-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A conta da sessão vem do cache do auth.me, como na tela de verdade.
  if (conta) queryClient.setQueryData([["auth", "me"], { type: "query" }], { openId: conta });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <ListaDeReunioes reunioes={REUNIOES} rotuloDoStatus={r => `status:${r.status}`} classeDoStatus={() => ""} aoAbrir={aoAbrir}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const campo = () => screen.getByRole("searchbox", { name: "Buscar nas reuniões" });
const titulos = () => screen.queryAllByRole("heading", { level: 2 }).map(h => h.textContent).filter(t => t !== "No que foi dito e nos resumos");

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = {};
  aoAbrir.mockReset();
  window.localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("ListaDeReunioes — busca e filtros (H7b)", () => {
  it("mostra as etiquetas e o 'Onde foi' de cada reunião, e abre a reunião", () => {
    abrir();
    expect(screen.getAllByRole("list", { name: "Etiquetas" })[0]).toHaveTextContent("Clientes");
    expect(screen.getByText("Zoom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a importadora/ }));
    expect(aoAbrir).toHaveBeenCalledWith(`/meetings/${REUNIOES[0].id}`);
  });

  it("filtra na hora pelo título, pela etiqueta, pelo contato e pelo contexto, sem acento", () => {
    abrir();
    fireEvent.change(campo(), { target: { value: "reuniao" } });
    expect(titulos()).toEqual(["Reunião com a importadora"]);
    fireEvent.change(campo(), { target: { value: "carla" } });
    expect(titulos()).toEqual(["Reunião com a importadora"]);
    fireEvent.change(campo(), { target: { value: "milao" } });
    expect(titulos()).toEqual(["Mentoria de exportação"]);
    expect(screen.getByText("Reuniões encontradas: 1")).toBeInTheDocument();
  });

  it("os filtros: a etiqueta e a origem vêm das reuniões da dona", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "Mentoria" } });
    expect(titulos()).toEqual(["Mentoria de exportação"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Origem" }), { target: { value: "documento" } });
    expect(titulos()).toEqual(["Contrato em PDF"]);
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(titulos()).toHaveLength(REUNIOES.length);
  });

  it("com 3 letras, busca no servidor depois de parar de digitar; o resultado abre no trecho ou no item e vira busca recente", async () => {
    rede.respostas["meetings.buscar"] = {
      resultados: [
        { tipo: "transcricao", meetingId: REUNIOES[1].id, titulo: "Mentoria de exportação", criadaEm: AGORA, trecho: "falamos da proposta de frete", nomes: {} },
        { tipo: "item", meetingId: REUNIOES[0].id, titulo: "Reunião com a importadora", criadaEm: AGORA, trecho: "{F1} manda a proposta", nomes: { F1: "Ana" }, itemId: "i1i1i1i1-0000-4000-8000-000000000001", secao: "action", assunto: null, inicioSegundos: 12 },
      ],
      maisResultados: false,
    };
    abrir();
    fireEvent.change(campo(), { target: { value: "pr" } });
    expect(screen.getByText("Escreva um pouco mais para buscar também no que foi dito.")).toBeInTheDocument();
    fireEvent.change(campo(), { target: { value: "proposta" } });
    const noConteudo = await screen.findByRole("region", { name: "No que foi dito e nos resumos" }).catch(() => screen.getByLabelText("No que foi dito e nos resumos"));
    await waitFor(() => expect(within(noConteudo).getByText("Na transcrição")).toBeInTheDocument());
    expect(rede.chamadas.filter(c => c.path === "meetings.buscar")).toEqual([{ path: "meetings.buscar", input: expect.objectContaining({ termo: "proposta" }) }]);
    // O token da voz vira o nome que a dona deu.
    const itemDoResumo = within(noConteudo).getByRole("button", { name: /Ana manda a proposta/ });
    expect(within(itemDoResumo).getByText("Ana")).toBeInTheDocument();
    fireEvent.click(itemDoResumo);
    expect(aoAbrir).toHaveBeenCalledWith(`/meetings/${REUNIOES[0].id}?item=i1i1i1i1-0000-4000-8000-000000000001`);
    fireEvent.click(within(noConteudo).getByText("Na transcrição").closest("button")!);
    expect(aoAbrir).toHaveBeenLastCalledWith(`/meetings/${REUNIOES[1].id}?q=proposta`);
    expect(JSON.parse(window.localStorage.getItem("mmm.buscasDeReunioes.dona-1")!)).toEqual(["proposta"]);
  });

  it("o teto de buscas aparece no idioma da tela, sem repetir o pedido", async () => {
    rede.respostas["meetings.buscar"] = erroDoServidor("TOO_MANY_REQUESTS", MENSAGEM_BUSCAS_DEMAIS);
    abrir();
    fireEvent.change(campo(), { target: { value: "proposta" } });
    expect(await screen.findByText("Muitas buscas em sequência. Aguarde alguns minutos e tente de novo.")).toBeInTheDocument();
    expect(rede.chamadas.filter(c => c.path === "meetings.buscar")).toHaveLength(1);
  });

  it("as buscas recentes aparecem ao focar o campo, preenchem a busca e se limpam", () => {
    window.localStorage.setItem("mmm.buscasDeReunioes.dona-1", JSON.stringify(["frete", "mentoria"]));
    abrir();
    fireEvent.focus(campo());
    expect(screen.getByText("Buscas recentes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "mentoria" }));
    expect(campo()).toHaveValue("mentoria");
    fireEvent.change(campo(), { target: { value: "" } });
    fireEvent.focus(campo());
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
    expect(window.localStorage.getItem("mmm.buscasDeReunioes.dona-1")).toBeNull();
    expect(screen.queryByText("Buscas recentes")).not.toBeInTheDocument();
  });

  it("o Enter que confirma a composição do teclado (japonês, chinês) não vira busca recente pela metade", () => {
    abrir();
    fireEvent.change(campo(), { target: { value: "かいぎ" } });
    fireEvent.keyDown(campo(), { key: "Enter", isComposing: true });
    expect(window.localStorage.getItem("mmm.buscasDeReunioes.dona-1")).toBeNull();
    // O Enter de depois, fora da composição, guarda o termo inteiro.
    fireEvent.keyDown(campo(), { key: "Enter" });
    expect(JSON.parse(window.localStorage.getItem("mmm.buscasDeReunioes.dona-1") ?? "[]")).toEqual(["かいぎ"]);
  });

  it("as recentes são da conta: as de outra conta não aparecem, e sem a conta não há recentes", () => {
    window.localStorage.setItem("mmm.buscasDeReunioes.outra", JSON.stringify(["segredo da outra"]));
    abrir("dona-1");
    fireEvent.focus(campo());
    expect(screen.queryByText("segredo da outra")).not.toBeInTheDocument();
  });

  it("em árabe, os rótulos saem traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir();
    expect(screen.getByRole("searchbox", { name: "البحث في الاجتماعات" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "دمج الاجتماعات" })).toBeInTheDocument();
  });

  it("o campo tem um 'x' só, o do app, fora do rótulo: o nome do campo continua só 'Buscar nas reuniões', e limpar devolve o foco ao campo", () => {
    abrir();
    fireEvent.change(campo(), { target: { value: "carla" } });
    const limpar = screen.getByRole("button", { name: "Limpar a busca" });
    expect(screen.getByRole("searchbox")).toHaveAccessibleName("Buscar nas reuniões");
    expect(limpar.closest("label")).toBeNull();
    // O 'x' nativo do Chrome no input type=search fica escondido; o do app é o único.
    expect(screen.getByRole("searchbox").className).toContain("[&::-webkit-search-cancel-button]:hidden");
    fireEvent.click(limpar);
    expect(campo()).toHaveValue("");
    expect(campo()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Limpar a busca" })).not.toBeInTheDocument();
  });

  it("o cartão mostra o contato e o contexto da reunião: a achada por eles diz por que apareceu", () => {
    abrir();
    fireEvent.change(campo(), { target: { value: "carla" } });
    const comContato = screen.getByRole("button", { name: /Reunião com a importadora/ });
    expect(within(comContato).getByText("Carla Mendes")).toBeInTheDocument();
    expect(within(comContato).getByLabelText("Contato")).toBeInTheDocument();
    fireEvent.change(campo(), { target: { value: "milao" } });
    const comContexto = screen.getByRole("button", { name: /Mentoria de exportação/ });
    expect(within(comContexto).getByText("Feira de Milão")).toBeInTheDocument();
    expect(within(comContexto).getByLabelText("Contexto")).toBeInTheDocument();
    // A reunião sem contato nem contexto não ganha rótulo vazio.
    fireEvent.change(campo(), { target: { value: "" } });
    const semNada = screen.getByRole("button", { name: /Contrato em PDF/ });
    expect(within(semNada).queryByLabelText("Contato")).not.toBeInTheDocument();
    expect(within(semNada).queryByLabelText("Contexto")).not.toBeInTheDocument();
  });

  it("em árabe, a voz no trecho do resumo fica isolada (<bdi>): o item em inglês não vira da direita para a esquerda, e o termo continua destacado", async () => {
    rede.respostas["meetings.buscar"] = {
      resultados: [
        { tipo: "item", meetingId: REUNIOES[1].id, titulo: "Spring Networking Fair Planning", criadaEm: AGORA, trecho: "{F2} evaluated two locations for the fair.", nomes: {}, itemId: "i1i1i1i1-0000-4000-8000-000000000002", secao: "decision", assunto: null, inicioSegundos: null },
      ],
      maisResultados: false,
    };
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir();
    fireEvent.change(screen.getByRole("searchbox", { name: "البحث في الاجتماعات" }), { target: { value: "locations" } });
    const voz = await screen.findByText("المتحدث 2");
    expect(voz.tagName).toBe("BDI");
    // O trecho decide a direção pelo resto do texto: o dir="auto" pula o que está no <bdi>.
    const trecho = voz.parentElement!;
    expect(trecho).toHaveAttribute("dir", "auto");
    expect(trecho).toHaveTextContent("المتحدث 2 evaluated two locations for the fair.");
    expect(within(trecho).getByText("locations").tagName).toBe("MARK");
  });
});

describe("ListaDeReunioes — escolher para juntar (H17)", () => {
  it("só as reuniões prontas de áudio se escolhem, e o Juntar pede pelo menos duas", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Juntar reuniões" }));
    const caixas = screen.getAllByRole("checkbox");
    expect(caixas).toHaveLength(REUNIOES.length);
    // O PDF e a gravação em curso não se juntam.
    expect(caixas.map(caixa => (caixa as HTMLInputElement).disabled)).toEqual([false, false, true, true]);
    const juntar = screen.getByRole("button", { name: "Juntar" });
    expect(juntar).toBeDisabled();
    fireEvent.click(caixas[0]);
    fireEvent.click(caixas[1]);
    expect(screen.getByText("Selecionadas: 2")).toBeInTheDocument();
    expect(juntar).toBeEnabled();
    fireEvent.click(juntar);
    expect(screen.getByRole("dialog", { name: "Juntar 2 reuniões" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancelar" })[0]);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
