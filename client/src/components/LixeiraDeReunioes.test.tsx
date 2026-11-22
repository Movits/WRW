import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { LixeiraDeReunioes } from "./LixeiraDeReunioes";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * A lixeira das reuniões na tela (H7d): a única que mostra a reunião da
 * lixeira, só para a dona, com os dias que faltam, o restaurar, o "Apagar de
 * vez" e o "Esvaziar a lixeira" (com confirmação). O React Query e os hooks do
 * tRPC são os de verdade; a rede é um link falso, que responde pela rota (ou
 * por uma função, para a resposta que muda a cada pedido). O que o servidor
 * confere (a dona, o prazo, a reunião de fora) está em
 * server/lixeira-de-reunioes.integracao.test.ts.
 */
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;
const ANTIGA = "b2b2b2b2-0000-4000-8000-000000000001";
const DOCUMENTO = "b2b2b2b2-0000-4000-8000-000000000002";
const NA_LIXEIRA = [
  { id: ANTIGA, title: "Reunião antiga", createdAt: AGORA - 40 * DIA, trashedAt: AGORA - 2 * DIA, status: "ready", origem: "gravacao", audioPipeline: "single" },
  { id: DOCUMENTO, title: "Contrato em PDF", createdAt: AGORA - 35 * DIA, trashedAt: AGORA - 29.5 * DIA, status: "ready", origem: "pdf", audioPipeline: null },
];

type Resposta = unknown | Error | ((entrada: unknown) => unknown);
const rede = { chamadas: [] as Array<{ path: string; input: unknown }>, respostas: {} as Record<string, Resposta> };
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    const combinada = rede.respostas[op.path];
    void Promise.resolve().then(() => {
      const resposta = typeof combinada === "function" ? (combinada as (entrada: unknown) => unknown)(op.input) : combinada;
      if (resposta === undefined) return observer.error(TRPCClientError.from(new Error(`rota não simulada: ${op.path}`)));
      if (resposta instanceof Error) return observer.error(resposta as never);
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    });
    return () => undefined;
  });
}
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 409 } } });

const aoVoltar = vi.fn();
function abrir() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <LixeiraDeReunioes aoVoltar={aoVoltar}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const chamadasDe = (rota: string) => rede.chamadas.filter(chamada => chamada.path === rota);

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "meetings.lixeira": NA_LIXEIRA };
  aoVoltar.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("LixeiraDeReunioes (H7d)", () => {
  it("mostra cada reunião com o título, a data e os dias que faltam para sair de vez; o documento leva a marca dele", async () => {
    abrir();
    expect(await screen.findByText("Reunião antiga")).toBeInTheDocument();
    const antiga = screen.getByText("Reunião antiga").closest("li")!;
    expect(within(antiga).getByText("Dias até ser apagada de vez: 28")).toBeInTheDocument();
    const documento = screen.getByText("Contrato em PDF").closest("li")!;
    expect(within(documento).getByText("Dias até ser apagada de vez: 1")).toBeInTheDocument();
    expect(within(documento).getByLabelText("Documento")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lixeira" })).toBeInTheDocument();
  });

  it("restaurar manda a reunião de volta, relê a lixeira e avisa", async () => {
    rede.respostas["meetings.restaurarDaLixeira"] = { restauradas: 1 };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar: Reunião antiga" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reunião restaurada."));
    expect(chamadasDe("meetings.restaurarDaLixeira").map(c => c.input)).toEqual([{ meetingIds: [ANTIGA] }]);
    expect(chamadasDe("meetings.lixeira").length).toBeGreaterThanOrEqual(2);
  });

  it("restaurar depois dos 30 dias: a recusa sai no idioma da tela", async () => {
    rede.respostas["meetings.restaurarDaLixeira"] = erroDoServidor("CONFLICT", "LIXEIRA_VENCIDA");
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar: Contrato em PDF" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Esta reunião passou dos 30 dias na lixeira e está sendo apagada de vez."));
  });

  it("apagar de vez pede confirmação, nomeia a reunião e só então chama o servidor; Cancelar não apaga", async () => {
    rede.respostas["meetings.apagarDeVez"] = { apagadas: 1 };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Apagar de vez: Reunião antiga" }));
    let confirmacao = screen.getByRole("dialog", { name: "Apagar esta reunião de vez?" });
    expect(within(confirmacao).getByText("Reunião antiga")).toBeInTheDocument();
    expect(within(confirmacao).getByText(/Não dá para desfazer/)).toBeInTheDocument();
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chamadasDe("meetings.apagarDeVez")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Apagar de vez: Reunião antiga" }));
    confirmacao = screen.getByRole("dialog", { name: "Apagar esta reunião de vez?" });
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Apagar de vez" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reunião apagada de vez."));
    expect(chamadasDe("meetings.apagarDeVez").map(c => c.input)).toEqual([{ meetingIds: [ANTIGA] }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("apagar de vez a reunião que já saiu (outra aba): 'não encontrada', no idioma da tela, e o modal fecha", async () => {
    rede.respostas["meetings.apagarDeVez"] = erroDoServidor("NOT_FOUND", "Reunião não encontrada.");
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Apagar de vez: Reunião antiga" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apagar de vez" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta."));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("esvaziar pede confirmação e pede de novo enquanto o servidor disser que resta alguma", async () => {
    const rodadas = [{ apagadas: 10, restam: true }, { apagadas: 2, restam: false }];
    rede.respostas["meetings.esvaziarLixeira"] = () => rodadas.shift();
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Esvaziar a lixeira" }));
    const confirmacao = screen.getByRole("dialog", { name: "Esvaziar a lixeira?" });
    expect(within(confirmacao).getByText(/Todas as reuniões da lixeira são apagadas para sempre/)).toBeInTheDocument();
    expect(chamadasDe("meetings.esvaziarLixeira")).toEqual([]);
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Esvaziar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lixeira esvaziada."));
    expect(chamadasDe("meetings.esvaziarLixeira")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("vazia, diz que está vazia e não oferece esvaziar", async () => {
    rede.respostas["meetings.lixeira"] = [];
    abrir();
    expect(await screen.findByText("A lixeira está vazia.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Esvaziar a lixeira" })).not.toBeInTheDocument();
  });

  it("a consulta em erro: o erro com 'tentar de novo', nunca 'lixeira vazia'", async () => {
    rede.respostas["meetings.lixeira"] = erroDoServidor("INTERNAL_SERVER_ERROR", "Banco de dados indisponível. Tente de novo em instantes.");
    abrir();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("A lixeira está vazia.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeInTheDocument();
  });

  it("o voltar leva às reuniões", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /Voltar às reuniões/ }));
    expect(aoVoltar).toHaveBeenCalledTimes(1);
  });

  it("em árabe (e a 375 px, em coluna), tudo no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    abrir();
    expect(screen.getByRole("heading", { name: "سلة المهملات" })).toBeInTheDocument();
    const antiga = (await screen.findByText("Reunião antiga")).closest("li")!;
    expect(within(antiga).getByRole("button", { name: "استعادة: Reunião antiga" })).toHaveTextContent("استعادة");
    expect(within(antiga).getByText("الأيام المتبقية حتى الحذف النهائي: 28")).toBeInTheDocument();
    // No celular, o título e os botões ficam um embaixo do outro.
    expect(antiga.className).toContain("flex-col");
  });
});
