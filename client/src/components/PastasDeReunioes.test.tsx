import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { esperarTituloPequeno } from "@/test/titulo-da-janela";
import { PASTAS_POR_DONA_MAX } from "@shared/pastas-de-reunioes";
import { EditorDePasta, emLotes, EscolherPasta, IconeDaPastaNaTela, type PastaNaTela } from "./PastasDeReunioes";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * As pastas das reuniões na tela (H7d): o editor (criar, renomear, trocar o
 * ícone e a cor, apagar) e a escolha da pasta para mover as reuniões marcadas.
 * O React Query e os hooks do tRPC são os de verdade; a rede é um link falso.
 * O que o servidor confere (a dona, o nome repetido, o teto, todo ou nada) está
 * em server/pastas-de-reunioes.integracao.test.ts.
 */
const CLIENTES: PastaNaTela = { id: "f0f0f0f0-0000-4000-8000-000000000001", nome: "Clientes", icone: "maleta", cor: "azul", reunioes: 3 };
const NOVA = "f0f0f0f0-0000-4000-8000-000000000009";

const rede = { chamadas: [] as Array<{ path: string; input: unknown }>, respostas: {} as Record<string, unknown | Error> };
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
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });
const chamadasDe = (rota: string) => rede.chamadas.filter(chamada => chamada.path === rota);

function montar(conteudo: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>{conteudo}</QueryClientProvider>
  </trpc.Provider>);
}

beforeEach(() => {
  rede.chamadas = [];
  rede.respostas = { "meetings.pastas": [CLIENTES], "meetings.list": [] };
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("EditorDePasta — criar (H7d)", () => {
  it("o nome vazio (ou só espaços) não cria; com nome, o ícone e a cor escolhidos vão ao servidor, e a pasta nova volta a quem abriu", async () => {
    rede.respostas["meetings.criarPasta"] = { id: NOVA };
    const aoCriar = vi.fn();
    const aoFechar = vi.fn();
    montar(<EditorDePasta aoFechar={aoFechar} aoCriar={aoCriar}/>);
    const janela = screen.getByRole("dialog", { name: "Nova pasta" });
    esperarTituloPequeno(janela);
    const criar = within(janela).getByRole("button", { name: "Criar pasta" });
    expect(criar).toBeDisabled();
    fireEvent.change(within(janela).getByRole("textbox", { name: "Nome" }), { target: { value: "    " } });
    expect(criar).toBeDisabled();
    fireEvent.change(within(janela).getByRole("textbox", { name: "Nome" }), { target: { value: "Feira de março" } });
    expect(criar).toBeEnabled();
    // O padrão é a pasta âmbar; a escolha marca o botão.
    expect(within(janela).getByRole("button", { name: "Pasta" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(janela).getByRole("button", { name: "Bandeira" }));
    fireEvent.click(within(janela).getByRole("button", { name: "Laranja" }));
    expect(within(janela).getByRole("button", { name: "Bandeira" })).toHaveAttribute("aria-pressed", "true");
    expect(within(janela).getByRole("button", { name: "Laranja" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(criar);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pasta criada."));
    expect(chamadasDe("meetings.criarPasta").map(c => c.input)).toEqual([{ nome: "Feira de março", icone: "bandeira", cor: "laranja" }]);
    expect(aoCriar).toHaveBeenCalledWith(NOVA);
    expect(aoFechar).toHaveBeenCalled();
  });

  it.each([
    ["PRECONDITION_FAILED", "PASTAS_DEMAIS", `Você chegou ao limite de ${PASTAS_POR_DONA_MAX} pastas. Apague uma para criar outra.`],
    ["CONFLICT", "NOME_DA_PASTA_REPETIDO", "Você já tem uma pasta com esse nome."],
    ["BAD_REQUEST", "NOME_DA_PASTA_INVALIDO", "Dê um nome à pasta."],
    ["INTERNAL_SERVER_ERROR", "falha qualquer", "Não foi possível salvar a pasta. Tente de novo."],
  ])("a recusa %s (%s) sai no idioma da tela, e o editor fica aberto", async (code, message, aviso) => {
    rede.respostas["meetings.criarPasta"] = erroDoServidor(code, message);
    const aoFechar = vi.fn();
    montar(<EditorDePasta aoFechar={aoFechar}/>);
    fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value: "Clientes" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar pasta" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(aviso));
    expect(aoFechar).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Nova pasta" })).toBeInTheDocument();
  });
});

describe("EditorDePasta — editar e apagar (H7d)", () => {
  it("abre com o nome, o ícone e a cor da pasta, e salva o que mudou", async () => {
    rede.respostas["meetings.editarPasta"] = { success: true };
    const aoFechar = vi.fn();
    montar(<EditorDePasta pasta={CLIENTES} aoFechar={aoFechar}/>);
    const janela = screen.getByRole("dialog", { name: "Editar a pasta" });
    esperarTituloPequeno(janela);
    expect(within(janela).getByRole("textbox", { name: "Nome" })).toHaveValue("Clientes");
    expect(within(janela).getByRole("button", { name: "Maleta" })).toHaveAttribute("aria-pressed", "true");
    expect(within(janela).getByRole("button", { name: "Azul" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(janela).getByRole("button", { name: "Verde" }));
    fireEvent.click(within(janela).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pasta salva."));
    expect(chamadasDe("meetings.editarPasta").map(c => c.input)).toEqual([{ pastaId: CLIENTES.id, nome: "Clientes", icone: "maleta", cor: "verde" }]);
    expect(aoFechar).toHaveBeenCalled();
  });

  it("apagar pede confirmação, diz que as reuniões ficam, e só então chama o servidor", async () => {
    rede.respostas["meetings.apagarPasta"] = { soltas: 3 };
    const aoApagar = vi.fn();
    montar(<EditorDePasta pasta={CLIENTES} aoFechar={vi.fn()} aoApagar={aoApagar}/>);
    fireEvent.click(screen.getByRole("button", { name: "Apagar a pasta" }));
    const confirmacao = screen.getByRole("dialog", { name: "Apagar a pasta “Clientes”?" });
    esperarTituloPequeno(confirmacao);
    expect(within(confirmacao).getByText(/As reuniões desta pasta não são apagadas/)).toBeInTheDocument();
    expect(chamadasDe("meetings.apagarPasta")).toEqual([]);
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Apagar a pasta" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pasta apagada. As reuniões dela ficaram sem pasta."));
    expect(chamadasDe("meetings.apagarPasta").map(c => c.input)).toEqual([{ pastaId: CLIENTES.id }]);
    expect(aoApagar).toHaveBeenCalled();
  });

  it("em árabe, o editor fala o idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    montar(<EditorDePasta aoFechar={vi.fn()}/>);
    const janela = screen.getByRole("dialog", { name: "مجلد جديد" });
    expect(within(janela).getByRole("textbox", { name: "الاسم" })).toBeInTheDocument();
    expect(within(janela).getByRole("button", { name: "إنشاء المجلد" })).toBeInTheDocument();
    expect(within(janela).getByRole("group", { name: "الأيقونة" })).toBeInTheDocument();
  });
});

describe("EscolherPasta — mover as reuniões marcadas (H7d)", () => {
  const MARCADAS = ["a1a1a1a1-0000-4000-8000-000000000001", "a1a1a1a1-0000-4000-8000-000000000002"];

  it("a pasta nova, criada ali mesmo, recebe as reuniões marcadas", async () => {
    rede.respostas["meetings.criarPasta"] = { id: NOVA };
    rede.respostas["meetings.moverParaPasta"] = { movidas: 2 };
    const aoMover = vi.fn();
    montar(<EscolherPasta reunioes={MARCADAS} pastas={[CLIENTES]} aoFechar={vi.fn()} aoMover={aoMover}/>);
    expect(screen.getByRole("button", { name: /Clientes/ })).toHaveTextContent("Reuniões: 3");
    fireEvent.click(screen.getByRole("button", { name: "Nova pasta" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value: "Exportação" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar pasta" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reuniões movidas para a pasta."));
    expect(chamadasDe("meetings.moverParaPasta").map(c => c.input)).toEqual([{ meetingIds: MARCADAS, pastaId: NOVA }]);
    expect(aoMover).toHaveBeenCalled();
  });

  it("muitas marcadas vão em lotes do tamanho que o servidor aceita", async () => {
    rede.respostas["meetings.moverParaPasta"] = { movidas: 50 };
    const muitas = Array.from({ length: 120 }, (_, i) => `a1a1a1a1-0000-4000-8000-${String(i).padStart(12, "0")}`);
    montar(<EscolherPasta reunioes={muitas} pastas={[CLIENTES]} aoFechar={vi.fn()} aoMover={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: /Clientes/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const lotes = chamadasDe("meetings.moverParaPasta").map(c => (c.input as { meetingIds: string[] }).meetingIds);
    expect(lotes.map(lote => lote.length)).toEqual([50, 50, 20]);
    expect(lotes.flat()).toEqual(muitas);
  });

  it("no teto de pastas, a pasta nova não se oferece", () => {
    const cheias = Array.from({ length: PASTAS_POR_DONA_MAX }, (_, i) => ({ ...CLIENTES, id: `f0f0f0f0-0000-4000-8000-${String(i).padStart(12, "0")}`, nome: `Pasta ${i}` }));
    montar(<EscolherPasta reunioes={MARCADAS} pastas={cheias} aoFechar={vi.fn()} aoMover={vi.fn()}/>);
    expect(screen.getByRole("button", { name: "Nova pasta" })).toBeDisabled();
  });
});

describe("as peças das pastas", () => {
  it("emLotes corta pelo teto do pedido, sem perder nem repetir", () => {
    expect(emLotes([])).toEqual([]);
    expect(emLotes([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(emLotes(Array.from({ length: 50 }, (_, i) => i))).toHaveLength(1);
  });

  it("o ícone e a cor que não estão na lista (de uma versão futura) caem no desenho e na cor padrão, sem quebrar", () => {
    const { container } = render(<IconeDaPastaNaTela icone={"foguete" as never} cor={"dourado" as never}/>);
    const desenho = container.querySelector("svg")!;
    expect(desenho).not.toBeNull();
    expect(desenho.getAttribute("class")).toContain("text-amber-300");
  });
});
