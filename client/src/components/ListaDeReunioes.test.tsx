import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { MENSAGEM_BUSCAS_DEMAIS } from "@shared/busca-de-reunioes";
import { esperarTituloPequeno } from "@/test/titulo-da-janela";
import { ListaDeReunioes, type ReuniaoDaLista } from "./ListaDeReunioes";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * A lista das reuniões com a busca, os filtros e as buscas recentes (H7b), a
 * seleção de várias para juntar (H17), mover de pasta ou mandar para a lixeira
 * e as vistas por origem e as pastas (H7d). O React Query e os hooks do tRPC
 * são os de verdade; a rede é um link falso, que responde pela rota. O SQL da
 * busca está em server/busca-de-reunioes.integracao.test.ts; o das pastas e da
 * lixeira, em server/pastas-de-reunioes.integracao.test.ts e
 * server/lixeira-de-reunioes.integracao.test.ts.
 */
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;
const PASTA_CLIENTES = "f0f0f0f0-0000-4000-8000-000000000001";
const PASTA_VAZIA = "f0f0f0f0-0000-4000-8000-000000000002";
const REUNIOES: ReuniaoDaLista[] = [
  { id: "a1a1a1a1-0000-4000-8000-000000000001", title: "Reunião com a importadora", createdAt: AGORA - DIA, status: "ready", origem: "gravacao", etiquetas: ["Clientes"], ondeFoi: "Zoom", contactId: 7, contatoNome: "Carla Mendes", folderId: PASTA_CLIENTES },
  { id: "a1a1a1a1-0000-4000-8000-000000000002", title: "Mentoria de exportação", createdAt: AGORA - 2 * DIA, status: "ready", origem: "arquivo", etiquetas: ["Mentoria"], contextId: "c1c1c1c1-0000-4000-8000-000000000009", contextoNome: "Feira de Milão" },
  { id: "a1a1a1a1-0000-4000-8000-000000000003", title: "Contrato em PDF", createdAt: AGORA - 3 * DIA, status: "ready", origem: "pdf" },
  // A gravação em partes ainda no ar: não se junta e não vai para a lixeira.
  { id: "a1a1a1a1-0000-4000-8000-000000000004", title: "Gravando agora", createdAt: AGORA, status: "recording", origem: "gravacao", audioPipeline: "slices" },
  { id: "a1a1a1a1-0000-4000-8000-000000000005", title: "Palestra no YouTube", createdAt: AGORA - 4 * DIA, status: "ready", origem: "youtube" },
];
const PASTAS = [
  { id: PASTA_CLIENTES, nome: "Clientes", icone: "maleta", cor: "azul", reunioes: 1, createdAt: AGORA - 10 * DIA },
  { id: PASTA_VAZIA, nome: "Projetos novos", icone: "lampada", cor: "verde", reunioes: 0, createdAt: AGORA - 9 * DIA },
];

const rede = {
  chamadas: [] as Array<{ path: string; input: unknown }>,
  respostas: {} as Record<string, unknown | Error>,
};
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    // A resposta pode depender do pedido (uma função do input): o lote que o servidor recusa.
    const simulada = rede.respostas[op.path];
    const resposta = typeof simulada === "function" ? (simulada as (input: unknown) => unknown)(op.input) : simulada;
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
function abrir(conta: string | null = "dona-1", reunioes: ReuniaoDaLista[] = REUNIOES) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A conta da sessão vem do cache do auth.me, como na tela de verdade.
  if (conta) queryClient.setQueryData([["auth", "me"], { type: "query" }], { openId: conta });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <ListaDeReunioes reunioes={reunioes} rotuloDoStatus={r => `status:${r.status}`} classeDoStatus={() => ""} aoAbrir={aoAbrir}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const campo = () => screen.getByRole("searchbox", { name: "Buscar nas reuniões" });
const titulos = () => screen.queryAllByRole("heading", { level: 2 }).map(h => h.textContent).filter(t => t !== "No que foi dito e nos resumos");

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "meetings.pastas": PASTAS };
  aoAbrir.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
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

  it("em árabe, os rótulos saem traduzidos (a busca, a seleção, a lixeira e as vistas)", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir();
    expect(screen.getByRole("searchbox", { name: "البحث في الاجتماعات" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تحديد" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "سلة المهملات" })).toBeInTheDocument();
    const vistas = screen.getByRole("group", { name: "تصفية الاجتماعات حسب المصدر" });
    expect(within(vistas).getAllByRole("button").map(botao => botao.textContent)).toEqual(["الكل", "المسجَّلة", "المستورَدة", "YouTube", "المجلدات"]);
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

/** A caixa da reunião na seleção, pelo título. */
const caixaDe = (titulo: string) => within(screen.getByText(titulo).closest("label")!).getByRole("checkbox");
const barraDaSelecao = () => screen.getByRole("region", { name: "Selecionar" });

describe("ListaDeReunioes — a seleção de várias: juntar (H17), mover e mandar para a lixeira (H7d)", () => {
  it("toda reunião se marca; o Juntar pede duas ou mais prontas de áudio, e diz por que não junta", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    const caixas = screen.getAllByRole("checkbox");
    expect(caixas).toHaveLength(REUNIOES.length);
    expect(caixas.every(caixa => !(caixa as HTMLInputElement).disabled)).toBe(true);
    const juntar = within(barraDaSelecao()).getByRole("button", { name: "Juntar" });
    expect(juntar).toBeDisabled();
    fireEvent.click(caixaDe("Reunião com a importadora"));
    fireEvent.click(caixaDe("Mentoria de exportação"));
    expect(screen.getByText("Selecionadas: 2")).toBeInTheDocument();
    expect(juntar).toBeEnabled();
    // O PDF não se junta: o botão para, e a tela diz o motivo.
    fireEvent.click(caixaDe("Contrato em PDF"));
    expect(juntar).toBeDisabled();
    expect(screen.getByText("Só reuniões prontas, gravadas ou de áudio importado, podem ser juntadas.")).toBeInTheDocument();
    fireEvent.click(caixaDe("Contrato em PDF"));
    fireEvent.click(juntar);
    expect(screen.getByRole("dialog", { name: "Juntar 2 reuniões" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("a marca da transcrição editada (H18) chega à junção pela seleção: só com ela a confirmação avisa que as correções não passam", () => {
    const aviso = /As correções feitas à mão na transcrição não passam para a reunião juntada/;
    const juntarAsDuas = () => {
      fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
      fireEvent.click(caixaDe("Reunião com a importadora"));
      fireEvent.click(caixaDe("Mentoria de exportação"));
      fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Juntar" }));
      return screen.getByRole("dialog", { name: "Juntar 2 reuniões" });
    };
    // Nenhuma das duas editada: sem o aviso.
    abrir();
    expect(within(juntarAsDuas()).queryByText(aviso)).not.toBeInTheDocument();
    cleanup();
    // A segunda com a transcrição editada pela dona (a marca que a lista do servidor manda).
    abrir("dona-1", REUNIOES.map(reuniao => reuniao.title === "Mentoria de exportação" ? { ...reuniao, transcricaoEditada: true } : reuniao));
    expect(within(juntarAsDuas()).getByText(aviso)).toBeInTheDocument();
  });

  it("'Marcar todas' marca as da vista, e vira 'Desmarcar todas'", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Importadas" }));
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Marcar todas" }));
    expect(screen.getByText("Selecionadas: 2")).toBeInTheDocument();
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Desmarcar todas" }));
    expect(screen.getByText("Selecionadas: 0")).toBeInTheDocument();
  });

  it("mover: escolhe a pasta, o servidor recebe as reuniões marcadas, e a seleção fecha", async () => {
    rede.respostas["meetings.moverParaPasta"] = { movidas: 2 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Mentoria de exportação"));
    fireEvent.click(caixaDe("Contrato em PDF"));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mover para pasta" }));
    const janela = await screen.findByRole("dialog", { name: "Mover para qual pasta?" });
    esperarTituloPequeno(janela);
    fireEvent.click(await within(janela).findByRole("button", { name: /Clientes/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reuniões movidas para a pasta."));
    expect(rede.chamadas.filter(c => c.path === "meetings.moverParaPasta")).toEqual([
      { path: "meetings.moverParaPasta", input: { meetingIds: [REUNIOES[1].id, REUNIOES[2].id], pastaId: PASTA_CLIENTES } },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("mover para 'Sem pasta' tira da pasta (pastaId nulo); a recusa sai no idioma da tela, e a seleção fica", async () => {
    rede.respostas["meetings.moverParaPasta"] = erroDoServidor("NOT_FOUND", "PASTA_NAO_ENCONTRADA");
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Reunião com a importadora"));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mover para pasta" }));
    // A janela espera a lista das pastas antes de oferecer "Sem pasta".
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Sem pasta" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Essa pasta não existe mais. Ela pode ter sido apagada em outra aba."));
    expect(rede.chamadas.find(c => c.path === "meetings.moverParaPasta")?.input).toEqual({ meetingIds: [REUNIOES[0].id], pastaId: null });
    expect(within(barraDaSelecao()).getByText("Selecionadas: 1")).toBeInTheDocument();
  });

  it("lixeira: confirma, manda as marcadas, e o aviso traz o Desfazer, que restaura as mesmas", async () => {
    rede.respostas["meetings.mandarParaALixeira"] = { naLixeira: 2, linksDesligados: 1 };
    rede.respostas["meetings.restaurarDaLixeira"] = { restauradas: 2 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Reunião com a importadora"));
    fireEvent.click(caixaDe("Palestra no YouTube"));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mandar para a lixeira" }));
    const confirmacao = screen.getByRole("dialog", { name: "Mandar para a lixeira?" });
    esperarTituloPequeno(confirmacao);
    expect(within(confirmacao).getByText(/ficam na lixeira por 30 dias/)).toBeInTheDocument();
    expect(rede.chamadas.some(c => c.path === "meetings.mandarParaALixeira")).toBe(false);
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Mandar para a lixeira" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reuniões na lixeira: 2. Dá para restaurar por 30 dias.", expect.anything()));
    expect(rede.chamadas.find(c => c.path === "meetings.mandarParaALixeira")?.input).toEqual({ meetingIds: [REUNIOES[0].id, REUNIOES[4].id] });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const [, opcoes] = vi.mocked(toast.success).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(opcoes.action.label).toBe("Desfazer");
    await act(async () => { opcoes.action.onClick(); });
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith("Reuniões restauradas: 2."));
    expect(rede.chamadas.find(c => c.path === "meetings.restaurarDaLixeira")?.input).toEqual({ meetingIds: [REUNIOES[0].id, REUNIOES[4].id] });
  });

  it("a gravação em partes ainda no ar não vai para a lixeira: o botão para e a tela diz por quê; a recusa do servidor sai traduzida", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Gravando agora"));
    expect(within(barraDaSelecao()).getByRole("button", { name: "Mandar para a lixeira" })).toBeDisabled();
    expect(within(barraDaSelecao()).getByText("Uma gravação ainda está em andamento: encerre a gravação antes de mandá-la para a lixeira.")).toBeInTheDocument();
    // Desmarcada, as outras vão; o servidor confere de novo e recusa com o código (a gravação que começou noutra aba).
    fireEvent.click(caixaDe("Gravando agora"));
    fireEvent.click(caixaDe("Contrato em PDF"));
    rede.respostas["meetings.mandarParaALixeira"] = erroDoServidor("CONFLICT", "LIXEIRA_GRAVANDO");
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mandar para a lixeira" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mandar para a lixeira" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Uma gravação ainda está em andamento: encerre a gravação antes de mandá-la para a lixeira.", undefined));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(barraDaSelecao()).getByText("Selecionadas: 1")).toBeInTheDocument();
  });

  it("lixeira em lotes, com o segundo recusado: as que já foram saem da seleção, e o aviso de erro traz o Desfazer delas", async () => {
    const muitas: ReuniaoDaLista[] = Array.from({ length: 51 }, (_v, i) => ({
      id: `b2b2b2b2-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Reunião ${i + 1}`, createdAt: AGORA - i * 60_000, status: "ready", origem: "gravacao",
    }));
    // O primeiro lote (50) vai; o segundo (a 51ª) o servidor recusa: uma gravação começou noutra aba.
    rede.respostas["meetings.mandarParaALixeira"] = (input: unknown) => (input as { meetingIds: string[] }).meetingIds.length === 50
      ? { naLixeira: 50, linksDesligados: 0 }
      : erroDoServidor("CONFLICT", "LIXEIRA_GRAVANDO");
    rede.respostas["meetings.restaurarDaLixeira"] = { restauradas: 50 };
    abrir("dona-1", muitas);
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Marcar todas" }));
    expect(within(barraDaSelecao()).getByText("Selecionadas: 51")).toBeInTheDocument();
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mandar para a lixeira" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mandar para a lixeira" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const lotes = rede.chamadas.filter(c => c.path === "meetings.mandarParaALixeira").map(c => (c.input as { meetingIds: string[] }).meetingIds);
    expect(lotes.map(lote => lote.length)).toEqual([50, 1]);
    const [mensagem, opcoes] = vi.mocked(toast.error).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(mensagem).toBe("Uma gravação ainda está em andamento: encerre a gravação antes de mandá-la para a lixeira.");
    expect(opcoes.action.label).toBe("Desfazer");
    // Só a recusada continua marcada.
    expect(within(barraDaSelecao()).getByText("Selecionadas: 1")).toBeInTheDocument();
    expect(caixaDe("Reunião 51")).toBeChecked();
    expect(caixaDe("Reunião 1")).not.toBeChecked();
    // O Desfazer restaura as 50 que foram, e só elas.
    await act(async () => { opcoes.action.onClick(); });
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.restaurarDaLixeira")).toBe(true));
    expect(rede.chamadas.find(c => c.path === "meetings.restaurarDaLixeira")?.input).toEqual({ meetingIds: lotes[0] });
  });

  it("trocar de vista ou de pasta começa a seleção do zero: a lixeira leva só a que a dona marcou na pasta aberta", async () => {
    rede.respostas["meetings.mandarParaALixeira"] = { naLixeira: 1, linksDesligados: 0 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Mentoria de exportação"));
    fireEvent.click(caixaDe("Contrato em PDF"));
    expect(within(barraDaSelecao()).getByText("Selecionadas: 2")).toBeInTheDocument();
    // Ir a outra vista e voltar não traz a seleção de antes.
    fireEvent.click(screen.getByRole("button", { name: "Importadas" }));
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(within(barraDaSelecao()).getByText("Selecionadas: 0")).toBeInTheDocument();
    expect(caixaDe("Mentoria de exportação")).not.toBeChecked();
    fireEvent.click(caixaDe("Mentoria de exportação"));
    fireEvent.click(screen.getByRole("button", { name: "Pastas" }));
    fireEvent.click(await screen.findByRole("button", { name: /Clientes/ }));
    expect(within(barraDaSelecao()).getByText("Selecionadas: 0")).toBeInTheDocument();
    fireEvent.click(caixaDe("Reunião com a importadora"));
    expect(within(barraDaSelecao()).getByText("Selecionadas: 1")).toBeInTheDocument();
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mandar para a lixeira" }));
    const confirmacao = screen.getByRole("dialog", { name: "Mandar para a lixeira?" });
    expect(within(confirmacao).getByText("Selecionadas: 1")).toBeInTheDocument();
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Mandar para a lixeira" }));
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.mandarParaALixeira")).toBe(true));
    expect(rede.chamadas.find(c => c.path === "meetings.mandarParaALixeira")?.input).toEqual({ meetingIds: [REUNIOES[0].id] });
  });

  it("a escolhida que a busca escondeu não vai junto: as ações valem só para as marcadas que estão na tela", async () => {
    rede.respostas["meetings.moverParaPasta"] = { movidas: 1 };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Mentoria de exportação"));
    fireEvent.click(caixaDe("Contrato em PDF"));
    fireEvent.change(campo(), { target: { value: "contrato" } });
    expect(within(barraDaSelecao()).getByText("Selecionadas: 1")).toBeInTheDocument();
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mover para pasta" }));
    const janela = await screen.findByRole("dialog", { name: "Mover para qual pasta?" });
    fireEvent.click(await within(janela).findByRole("button", { name: /Clientes/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reuniões movidas para a pasta."));
    expect(rede.chamadas.find(c => c.path === "meetings.moverParaPasta")?.input).toEqual({ meetingIds: [REUNIOES[2].id], pastaId: PASTA_CLIENTES });
  });

  it("mover com a consulta das pastas em erro: a janela mostra o erro com 'tentar de novo', e não oferece 'Sem pasta'", async () => {
    rede.respostas["meetings.pastas"] = erroDoServidor("INTERNAL_SERVER_ERROR", "Banco de dados indisponível. Tente de novo em instantes.");
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Selecionar" }));
    fireEvent.click(caixaDe("Reunião com a importadora"));
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.pastas")).toBe(true));
    fireEvent.click(within(barraDaSelecao()).getByRole("button", { name: "Mover para pasta" }));
    const janela = await screen.findByRole("dialog", { name: "Mover para qual pasta?" });
    expect(await within(janela).findByRole("alert")).toBeInTheDocument();
    expect(within(janela).queryByRole("button", { name: "Sem pasta" })).not.toBeInTheDocument();
    expect(within(janela).queryByRole("button", { name: "Nova pasta" })).not.toBeInTheDocument();
    // Tentar de novo com as pastas de volta: a janela passa a oferecê-las.
    rede.respostas["meetings.pastas"] = PASTAS;
    fireEvent.click(within(janela).getByRole("button", { name: /Tentar novamente/ }));
    expect(await within(janela).findByRole("button", { name: "Sem pasta" })).toBeInTheDocument();
    expect(rede.chamadas.some(c => c.path === "meetings.moverParaPasta")).toBe(false);
  });

  it("o botão da lixeira abre a lixeira, pelo endereço dela", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Lixeira" }));
    expect(aoAbrir).toHaveBeenCalledWith("/meetings?lixeira=1");
  });
});

describe("ListaDeReunioes — as vistas por origem e as pastas (H7d)", () => {
  it("Todas, Gravadas, Importadas e YouTube filtram pela origem", () => {
    abrir();
    expect(titulos()).toHaveLength(REUNIOES.length);
    fireEvent.click(screen.getByRole("button", { name: "Gravadas" }));
    expect(screen.getByRole("button", { name: "Gravadas" })).toHaveAttribute("aria-pressed", "true");
    expect(titulos()).toEqual(["Reunião com a importadora", "Gravando agora"]);
    fireEvent.click(screen.getByRole("button", { name: "Importadas" }));
    expect(titulos()).toEqual(["Mentoria de exportação", "Contrato em PDF"]);
    fireEvent.click(screen.getByRole("button", { name: "YouTube" }));
    expect(titulos()).toEqual(["Palestra no YouTube"]);
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(titulos()).toHaveLength(REUNIOES.length);
  });

  it("a reunião numa pasta mostra a pasta no cartão; a sem pasta, não", async () => {
    abrir();
    const naPasta = screen.getByRole("button", { name: /Reunião com a importadora/ });
    expect(await within(naPasta).findByLabelText("Pasta: Clientes")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Mentoria de exportação/ })).queryByLabelText(/^Pasta:/)).not.toBeInTheDocument();
  });

  it("Pastas mostra as pastas com quantas reuniões têm; abrir uma mostra as reuniões dela, e voltar mostra as pastas", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Pastas" }));
    const clientes = await screen.findByRole("button", { name: /Clientes/ });
    expect(clientes).toHaveTextContent("Reuniões: 1");
    expect(screen.getByRole("button", { name: /Projetos novos/ })).toHaveTextContent("Reuniões: 0");
    expect(titulos()).toEqual([]);
    fireEvent.click(clientes);
    expect(titulos()).toEqual(["Reunião com a importadora"]);
    // Dentro da pasta, o cartão não repete a pasta.
    expect(screen.queryByLabelText("Pasta: Clientes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Todas as pastas" }));
    fireEvent.click(await screen.findByRole("button", { name: /Projetos novos/ }));
    expect(screen.getByText(/Nenhuma reunião nesta pasta/)).toBeInTheDocument();
  });

  it("sem pastas, a vista convida a criar uma; a pasta nova abre na hora", async () => {
    rede.respostas["meetings.pastas"] = [];
    rede.respostas["meetings.criarPasta"] = { id: "f0f0f0f0-0000-4000-8000-000000000003" };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Pastas" }));
    expect(await screen.findByText(/Você ainda não tem pastas/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nova pasta" }));
    const janela = screen.getByRole("dialog", { name: "Nova pasta" });
    fireEvent.change(within(janela).getByRole("textbox", { name: "Nome" }), { target: { value: "  Mentoria  " } });
    fireEvent.click(within(janela).getByRole("button", { name: "Estrela" }));
    fireEvent.click(within(janela).getByRole("button", { name: "Roxo" }));
    // O servidor passa a ter a pasta nova: a releitura das pastas a traz.
    rede.respostas["meetings.pastas"] = [{ id: "f0f0f0f0-0000-4000-8000-000000000003", nome: "Mentoria", icone: "estrela", cor: "roxo", reunioes: 0, createdAt: AGORA }];
    fireEvent.click(within(janela).getByRole("button", { name: "Criar pasta" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pasta criada."));
    expect(rede.chamadas.find(c => c.path === "meetings.criarPasta")?.input).toEqual({ nome: "  Mentoria  ", icone: "estrela", cor: "roxo" });
    expect(await screen.findByText("Mentoria")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas as pastas" })).toBeInTheDocument();
  });

  it("a consulta das pastas em erro: a vista Pastas mostra o erro com 'tentar de novo', e a lista segue nas outras vistas", async () => {
    rede.respostas["meetings.pastas"] = erroDoServidor("INTERNAL_SERVER_ERROR", "Banco de dados indisponível. Tente de novo em instantes.");
    abrir();
    expect(titulos()).toHaveLength(REUNIOES.length);
    fireEvent.click(screen.getByRole("button", { name: "Pastas" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeInTheDocument();
  });

  it("a 375 px, as vistas quebram em linhas, e não rolam de lado: 'Pastas' e a vista marcada ficam sempre na tela", () => {
    abrir();
    const vistas = screen.getByRole("group", { name: "Filtrar as reuniões por origem" });
    // As cinco medem 464 px numa largura de 345 px: rolando de lado, "Pastas"
    // ficava fora da tela (sem barra de rolagem no iPhone), e com ela ativa
    // nenhuma vista visível aparecia marcada. Quebrando, nenhuma fica de fora.
    expect(vistas.className.split(/\s+/)).toContain("flex-wrap");
    expect(vistas.className).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(within(vistas).getAllByRole("button").map(botao => botao.textContent)).toEqual(["Todas", "Gravadas", "Importadas", "YouTube", "Pastas"]);
    // O chip não encolhe nem quebra o próprio rótulo.
    for (const botao of within(vistas).getAllByRole("button")) expect(botao.className).toContain("shrink-0");
  });
});

describe("ListaDeReunioes — perguntar a várias reuniões (H6c)", () => {
  it("o botão abre o diálogo, que pede as reuniões que a dona pode perguntar; abrir uma fonte fecha o diálogo e abre a reunião", async () => {
    rede.respostas["perguntasEntreReunioes.reunioes"] = [
      { id: REUNIOES[0].id, titulo: REUNIOES[0].title, criadaEm: REUNIOES[0].createdAt, etiquetas: ["Clientes"], origem: "gravacao", caracteres: 1000 },
      { id: REUNIOES[1].id, titulo: REUNIOES[1].title, criadaEm: REUNIOES[1].createdAt, etiquetas: ["Mentoria"], origem: "arquivo", caracteres: 1000 },
    ];
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Perguntar a várias" }));
    const dialogo = screen.getByRole("dialog", { name: "Perguntar a várias reuniões" });
    expect(await within(dialogo).findByRole("list", { name: "Etiquetas das suas reuniões" })).toBeInTheDocument();
    expect(rede.chamadas.filter(c => c.path === "perguntasEntreReunioes.reunioes")).toHaveLength(1);
    fireEvent.click(within(dialogo).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("com menos de duas reuniões prontas, o botão não aparece", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = trpc.createClient({ links: [linkFalso() as never] });
    render(<trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ListaDeReunioes reunioes={[REUNIOES[0], REUNIOES[3]]} rotuloDoStatus={r => `status:${r.status}`} classeDoStatus={() => ""} aoAbrir={aoAbrir}/>
      </QueryClientProvider>
    </trpc.Provider>);
    expect(screen.queryByRole("button", { name: "Perguntar a várias" })).not.toBeInTheDocument();
  });
});
