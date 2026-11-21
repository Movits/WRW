import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { RECUSAS_DA_JUNCAO } from "@shared/juntar-reunioes";
import { JuntarReunioes } from "./JuntarReunioes";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * A confirmação de juntar reuniões (H17): a ordem (cronológica por padrão, que
 * a dona muda), o pedido com os ids na ordem escolhida e as recusas traduzidas.
 * O que o servidor faz está em server/juntar-reunioes*.test.ts.
 */
const A = { id: "a1a1a1a1-0000-4000-8000-000000000001", title: "Parte 2 da reunião", createdAt: 2_000 };
const B = { id: "a1a1a1a1-0000-4000-8000-000000000002", title: "Parte 1 da reunião", createdAt: 1_000 };
const C = { id: "a1a1a1a1-0000-4000-8000-000000000003", title: "Parte 3 da reunião", createdAt: 3_000 };

const rede = { chamadas: [] as Array<{ path: string; input: unknown }>, resposta: null as unknown | Error };
function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    rede.chamadas.push({ path: op.path, input: op.input });
    void Promise.resolve().then(() => {
      if (op.path !== "meetings.juntar") return observer.error(TRPCClientError.from(new Error(`rota não simulada: ${op.path}`)));
      if (rede.resposta instanceof Error) return observer.error(rede.resposta as never);
      observer.next({ result: { type: "data", data: rede.resposta } } as never);
      observer.complete();
    });
    return () => undefined;
  });
}
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 412 } } });

const aoJuntar = vi.fn();
const aoFechar = vi.fn();
function abrir() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <JuntarReunioes reunioes={[A, B, C]} aoFechar={aoFechar} aoJuntar={aoJuntar}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const ordemNaTela = () => within(screen.getByRole("dialog")).getAllByRole("listitem").filter(li => li.querySelector("button")).map(li => li.querySelector("span.block")?.textContent);

beforeEach(() => {
  rede.chamadas = [];
  rede.resposta = { meetingId: B.id, partes: 3, duracaoSegundos: 1800, retranscreve: false, linkAbertoDesligado: false };
  aoJuntar.mockReset();
  aoFechar.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("JuntarReunioes", () => {
  it("abre na ordem cronológica, com a primeira marcada como a que fica", () => {
    abrir();
    expect(ordemNaTela()).toEqual(["Parte 1 da reunião", "Parte 2 da reunião", "Parte 3 da reunião"]);
    expect(within(screen.getByRole("dialog")).getByText("Fica")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subir: Parte 1 da reunião" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Descer: Parte 3 da reunião" })).toBeDisabled();
  });

  it("a dona muda a ordem, e o pedido leva os ids nela; depois abre a reunião que ficou", async () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Descer: Parte 1 da reunião" }));
    expect(ordemNaTela()).toEqual(["Parte 2 da reunião", "Parte 1 da reunião", "Parte 3 da reunião"]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Juntar" }));
    await waitFor(() => expect(aoJuntar).toHaveBeenCalledWith(B.id));
    expect(rede.chamadas.find(c => c.path === "meetings.juntar")?.input).toEqual({ meetingIds: [A.id, B.id, C.id] });
    expect(toast.success).toHaveBeenCalledWith("Reuniões juntadas. A transcrição e o resumo estão sendo refeitos.");
  });

  it("cada recusa do servidor sai traduzida pelo código; a reunião de outra conta, como não encontrada", async () => {
    const casos: Array<[Error, string]> = [
      [erroDoServidor("CONFLICT", RECUSAS_DA_JUNCAO.foraDoEstado), "Alguma das reuniões não está pronta (ainda gravando, processando ou com falha)."],
      [erroDoServidor("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.semAudio), "O áudio de alguma das reuniões não está mais guardado (passou dos 30 dias)."],
      [erroDoServidor("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.longaDemais), "A reunião juntada passaria do limite de 12 horas."],
      [erroDoServidor("TOO_MANY_REQUESTS", RECUSAS_DA_JUNCAO.demais), "Muitas junções em sequência. Aguarde alguns minutos e tente de novo."],
      [erroDoServidor("NOT_FOUND", "REUNIAO_NAO_ENCONTRADA"), i18n.t("meetings.meetingNotFound")],
    ];
    for (const [erro, aviso] of casos) {
      rede.resposta = erro;
      abrir();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Juntar" }));
      await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith(aviso));
      cleanup();
    }
    expect(aoJuntar).not.toHaveBeenCalled();
  });

  it("Cancelar fecha sem pedir nada", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(aoFechar).toHaveBeenCalled();
    expect(rede.chamadas).toEqual([]);
  });
});
