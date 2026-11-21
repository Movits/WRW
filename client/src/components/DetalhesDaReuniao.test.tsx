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
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <DetalhesDaReuniao meetingId={ID} detalhes={detalhes} etiquetasSugeridas={etiquetasSugeridas}/>
    </QueryClientProvider>
  </trpc.Provider>);
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
    expect(rede.chamadas.find(c => c.path === "meetings.atualizarDetalhes")?.input).toEqual({
      meetingId: ID, titulo: "Reunião", etiquetas: ["Exportação", "Mentoria"], ondeFoi: "Zoom", contactId: null, contextId: null,
    });
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
    abrir({ titulo: "Reunião", contato: { id: 9, nome: "Alguém" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar detalhes" }));
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
