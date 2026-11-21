import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { RECUSAS_DOS_DETALHES } from "@shared/detalhes-da-reuniao";
import { DetalhesDaReuniao, type DetalhesNaTela } from "./DetalhesDaReuniao";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * Os detalhes da reunião (H7c) no detalhe: o que aparece, o "Editar detalhes"
 * (etiquetas, "Onde foi", contato e contexto) e a recusa traduzida. O servidor
 * normaliza e confere a posse (server/detalhes-da-reuniao*.test.ts).
 */
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const rede = { chamadas: [] as Array<{ path: string; input: unknown }>, respostas: {} as Record<string, unknown | Error> };
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    void Promise.resolve().then(() => {
      const resposta = rede.respostas[op.path];
      if (resposta === undefined) return observer.error(TRPCClientError.from(new Error(`rota não simulada: ${op.path}`)));
      if (resposta instanceof Error) return observer.error(resposta as never);
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    });
    return () => undefined;
  });
}
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 404 } } });

function abrir(detalhes: DetalhesNaTela, etiquetasSugeridas: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  const arvore = (atuais: DetalhesNaTela) => <trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <DetalhesDaReuniao meetingId={ID} detalhes={atuais} etiquetasSugeridas={etiquetasSugeridas}/>
    </QueryClientProvider>
  </trpc.Provider>;
  const tela = render(arvore(detalhes));
  // A página relida (meetings.get) com os detalhes de agora, sem remontar o painel.
  return { ...tela, reler: (atuais: DetalhesNaTela) => tela.rerender(arvore(atuais)) };
}

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "meetings.atualizarDetalhes": { titulo: "x", etiquetas: [], ondeFoi: null, contato: null, contexto: null } };
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("DetalhesDaReuniao", () => {
  it("mostra as etiquetas, o 'Onde foi', o contato e o contexto", () => {
    abrir({ titulo: "Reunião", etiquetas: ["Clientes", "Vendas"], ondeFoi: "Café da Paulista", contato: { id: 7, nome: "Carla Mendes" }, contexto: { id: "c1", nome: "Feira de Milão" } });
    expect(screen.getByRole("list", { name: "Etiquetas" })).toHaveTextContent("ClientesVendas");
    expect(screen.getByText("Café da Paulista")).toBeInTheDocument();
    expect(screen.getByText("Carla Mendes")).toBeInTheDocument();
    expect(screen.getByText("Feira de Milão")).toBeInTheDocument();
  });

  it("sem nada, convida a organizar (a linha antiga, sem as colunas, também)", () => {
    abrir({ titulo: "Reunião" });
    expect(screen.getByText(/Sem etiquetas, lugar, contato nem contexto/)).toBeInTheDocument();
  });

  it("editar: acrescenta etiqueta com Enter e pela sugestão, tira, muda o lugar e salva o que ficou", async () => {
    abrir({ titulo: "Reunião", etiquetas: ["Clientes"], contato: { id: 7, nome: "Carla Mendes" } }, ["Mentoria", "clientes"]);
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    const etiqueta = screen.getByRole("textbox", { name: "Etiquetas" });
    fireEvent.change(etiqueta, { target: { value: "  Exportação " } });
    fireEvent.keyDown(etiqueta, { key: "Enter" });
    // A sugestão que já está (sem caixa) não aparece de novo.
    expect(screen.queryByRole("button", { name: "+ clientes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Mentoria" }));
    fireEvent.click(screen.getByRole("button", { name: "Tirar a etiqueta Clientes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Onde foi" }), { target: { value: "Zoom" } });
    fireEvent.click(screen.getByRole("button", { name: "Tirar" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Detalhes salvos."));
    // Só o que a dona mudou: o título e o contexto ficaram como estavam e não vão.
    expect(rede.chamadas.find(c => c.path === "meetings.atualizarDetalhes")?.input).toEqual({
      meetingId: ID, etiquetas: ["Exportação", "Mentoria"], ondeFoi: "Zoom", contactId: null,
    });
  });

  it("o título que muda por fora com o editor aberto (\"Usar este título\") não volta ao antigo ao salvar outra coisa", async () => {
    const tela = abrir({ titulo: "Reunião de terça", etiquetas: [] });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Reunião de terça");
    // O título sugerido foi aceito logo acima: a página relida traz o título novo.
    tela.reler({ titulo: "🚀 Lançamento nas lojas", etiquetas: [] });
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("🚀 Lançamento nas lojas");
    const etiqueta = screen.getByRole("textbox", { name: "Etiquetas" });
    fireEvent.change(etiqueta, { target: { value: "Clientes" } });
    fireEvent.keyDown(etiqueta, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.atualizarDetalhes")).toBe(true));
    expect(rede.chamadas.find(c => c.path === "meetings.atualizarDetalhes")?.input).toEqual({ meetingId: ID, etiquetas: ["Clientes"] });
  });

  it("o título digitado pela dona vale, mesmo que o de fora mude depois", async () => {
    const tela = abrir({ titulo: "Reunião de terça" });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Conversa com a cooperativa" } });
    tela.reler({ titulo: "🚀 Lançamento nas lojas" });
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Conversa com a cooperativa");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.atualizarDetalhes")).toBe(true));
    expect(rede.chamadas.find(c => c.path === "meetings.atualizarDetalhes")?.input).toEqual({ meetingId: ID, titulo: "Conversa com a cooperativa" });
  });

  it("salvar sem mudar nada fecha o editor sem pedir nada ao servidor", () => {
    abrir({ titulo: "Reunião", etiquetas: ["Clientes"], ondeFoi: "Zoom", contato: { id: 7, nome: "Carla Mendes" }, contexto: { id: "c1", nome: "Feira" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(rede.chamadas.some(c => c.path === "meetings.atualizarDetalhes")).toBe(false);
    expect(screen.getByRole("button", { name: "Editar detalhes" })).toBeInTheDocument();
  });

  it("o Enter que confirma a composição do teclado (japonês, chinês) não cria etiqueta", () => {
    abrir({ titulo: "Reunião" });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    const etiqueta = screen.getByRole("textbox", { name: "Etiquetas" });
    fireEvent.change(etiqueta, { target: { value: "かいぎ" } });
    fireEvent.keyDown(etiqueta, { key: "Enter", isComposing: true });
    expect(screen.queryByRole("button", { name: "Tirar a etiqueta かいぎ" })).not.toBeInTheDocument();
    expect(etiqueta).toHaveValue("かいぎ");
    fireEvent.keyDown(etiqueta, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Tirar a etiqueta かいぎ" })).toBeInTheDocument();
  });

  it("escolhe o contato pela busca na rede da dona", async () => {
    rede.respostas["network.list"] = { data: [{ id: 42, fullName: "Bia Souza", company: "Café Brasil" }], total: 1 };
    abrir({ titulo: "Reunião" });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Escolher" })[0]);
    fireEvent.change(screen.getByPlaceholderText("Nome, empresa ou cargo"), { target: { value: "Bia" } });
    fireEvent.click(await screen.findByRole("button", { name: /Bia Souza/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(rede.chamadas.some(c => c.path === "meetings.atualizarDetalhes")).toBe(true));
    expect(rede.chamadas.find(c => c.path === "meetings.atualizarDetalhes")?.input).toMatchObject({ contactId: 42 });
  });

  it("a recusa do contato de outra conta sai traduzida, e o editor fica aberto", async () => {
    rede.respostas["meetings.atualizarDetalhes"] = erroDoServidor("NOT_FOUND", RECUSAS_DOS_DETALHES.contato);
    rede.respostas["network.list"] = { data: [{ id: 9, fullName: "Alguém", company: null }], total: 1 };
    abrir({ titulo: "Reunião" });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Escolher" })[0]);
    fireEvent.change(screen.getByPlaceholderText("Nome, empresa ou cargo"), { target: { value: "Alg" } });
    fireEvent.click(await screen.findByRole("button", { name: /Alguém/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Esse contato não está na sua rede."));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
  });

  it("em árabe, o painel sai traduzido", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir({ titulo: "Reunião", etiquetas: ["Clientes"] });
    expect(screen.getByRole("heading", { name: "التفاصيل" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تعديل التفاصيل" })).toBeInTheDocument();
  });
});
