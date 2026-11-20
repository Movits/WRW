import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { MENSAGEM_EXPORTACOES_DEMAIS, MENSAGEM_EXPORTAR_SO_PRONTA } from "@shared/exportar-reuniao";
import { CLASSE_DA_IMPRESSAO, type ReuniaoExportada } from "./ImpressaoDaReuniao";
import { ExportarReuniao, nomeDoArquivo } from "./ExportarReuniao";

/**
 * "Baixar PDF" no detalhe da reunião (H8). O React Query e os hooks do tRPC
 * são os de verdade; só a rede é um link falso, que responde com
 * `rede.resposta` (ou segura o pedido com `rede.segurar`). A impressão do
 * navegador é um dublê que registra o que estava na página no momento em que
 * ela abriria: o documento no portal, a classe do body e o título da aba (o
 * nome do arquivo). O que o servidor faz está em server/exportar-reuniao*.test.ts.
 */

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EXPORTADA: ReuniaoExportada = {
  titulo: "Reunião: importadora / Santos",
  emoji: "🤝",
  criadaEm: new Date(2026, 10, 16, 14, 30).getTime(),
  idioma: "pt-BR",
  duracaoSegundos: 95,
  nomes: { F1: "Ana" },
  itens: [{ secao: "action", assunto: null, texto: "{F1} manda a proposta", responsavel: "{F1}", prazo: "sexta", feita: false }],
  transcricao: { texto: null, falas: [{ inicio: 0, fim: 4, falante: "F1", texto: "Bom dia." }] },
  exportadaEm: new Date(2026, 10, 16, 15, 0).getTime(),
};

type Resposta = ReuniaoExportada | Error;
const rede = {
  resposta: EXPORTADA as Resposta,
  segurar: false,
  chamadas: [] as unknown[],
  pendentes: [] as Array<(resposta: Resposta) => void>,
};

function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    const responder = (resposta: Resposta) => {
      if (resposta instanceof Error) return observer.error(resposta instanceof TRPCClientError ? resposta : TRPCClientError.from(resposta));
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    };
    if (op.path !== "meetings.exportar") {
      responder(new Error(`rota não simulada: ${op.path}`));
      return () => undefined;
    }
    rede.chamadas.push(op.input);
    const resposta = rede.resposta;
    if (rede.segurar) rede.pendentes.push(responder);
    else void Promise.resolve().then(() => responder(resposta));
    return () => undefined;
  });
}

// Erro como o servidor devolve: o envelope tRPC traz data.code.
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

// O que a página tinha no instante em que a impressão abriria.
type Retrato = { documento: Element | null; idioma: string | null; classeNoBody: boolean; titulo: string; texto: string };
const impressoes: Retrato[] = [];
function retratar() {
  const portal = document.body.querySelector(":scope > .impressao-da-reuniao");
  impressoes.push({
    documento: portal,
    idioma: portal?.querySelector("article")?.getAttribute("lang") ?? null,
    classeNoBody: document.body.classList.contains(CLASSE_DA_IMPRESSAO),
    titulo: document.title,
    texto: portal?.textContent ?? "",
  });
}
// A implementação entra no beforeEach: o projeto client zera os dublês antes de cada teste (mockReset).
const imprimir = vi.fn();

function abrir(props: { confirmados?: number | null } = {}) {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <ExportarReuniao meetingId={ID} confirmados={props.confirmados === undefined ? 3 : props.confirmados}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const botaoDaPagina = () => screen.getByRole("button", { name: "Baixar PDF" });
const dialogo = () => screen.getByRole("dialog", { name: "Baixar a reunião em PDF" });
const confirmar = () => fireEvent.click(within(dialogo()).getByRole("button", { name: "Baixar PDF" }));

beforeEach(() => {
  rede.resposta = EXPORTADA;
  rede.segurar = false;
  rede.chamadas = [];
  rede.pendentes = [];
  impressoes.length = 0;
  imprimir.mockImplementation(retratar);
  window.print = imprimir;
  document.title = "WRW";
});
afterEach(async () => {
  // A página sai antes de o idioma voltar (o afterEach do arquivo roda antes do cleanup do setup).
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Baixar PDF — o aviso vem antes", () => {
  it("o botão abre o aviso, que diz o que vai no PDF e quantos itens confirmados; nada é pedido ainda", () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    expect(dialogo()).toHaveAccessibleDescription(/O PDF leva a transcrição desta reunião, com os nomes que você deu às vozes, e só os itens do resumo que você confirmou/);
    expect(dialogo()).toHaveTextContent("Itens do resumo confirmados que vão no PDF: 3.");
    expect(rede.chamadas).toEqual([]);
    expect(imprimir).not.toHaveBeenCalled();
  });

  it("sem item confirmado, o aviso diz que o PDF leva só a transcrição", () => {
    abrir({ confirmados: 0 });
    fireEvent.click(botaoDaPagina());
    expect(dialogo()).toHaveTextContent("Nenhum item do resumo foi confirmado ainda: o PDF leva só a transcrição.");
  });

  it("sem a contagem (o resumo ainda não chegou, ou a consulta falhou), o aviso não afirma contagem nenhuma: fica o texto que diz que vão os confirmados", () => {
    abrir({ confirmados: null });
    fireEvent.click(botaoDaPagina());
    expect(dialogo()).toHaveAccessibleDescription(/e só os itens do resumo que você confirmou/);
    expect(dialogo()).not.toHaveTextContent("só a transcrição");
    expect(dialogo()).not.toHaveTextContent("Itens do resumo confirmados que vão no PDF");
  });

  it("Cancelar (ou Esc) fecha sem pedir nada ao servidor, e o foco volta ao botão", () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(botaoDaPagina()).toHaveFocus();
    fireEvent.click(botaoDaPagina());
    fireEvent.keyDown(dialogo(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rede.chamadas).toEqual([]);
    expect(imprimir).not.toHaveBeenCalled();
  });
});

describe("Baixar PDF — a impressão", () => {
  it("confirmado, pede o PDF desta reunião e abre a impressão com o documento já na página e o título do arquivo", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    expect(rede.chamadas).toEqual([{ meetingId: ID, formato: "pdf" }]);
    const [retrato] = impressoes;
    expect(retrato.documento).not.toBeNull();
    expect(retrato.idioma).toBe("pt-BR");
    expect(retrato.classeNoBody).toBe(true);
    expect(retrato.texto).toContain("Ana manda a proposta");
    expect(retrato.titulo).toBe("Reunião importadora Santos - 2026-11-16");
    expect(dialogo()).toHaveTextContent("Na tela de impressão, escolha “Salvar como PDF”.");
  });

  it("quando a impressão fecha, o título da aba volta; 'Abrir a impressão de novo' reabre sem pedir de novo ao servidor", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(document.title).toBe("WRW");
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Abrir a impressão de novo" }));
    expect(imprimir).toHaveBeenCalledTimes(2);
    expect(impressoes[1].titulo).toBe("Reunião importadora Santos - 2026-11-16");
    expect(rede.chamadas).toHaveLength(1);
  });

  it("Fechar tira o documento da página e a classe do body, e devolve o título; o PDF seguinte é pedido de novo", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Fechar" }));
    expect(document.body.querySelector(".impressao-da-reuniao")).toBeNull();
    expect(document.body).not.toHaveClass(CLASSE_DA_IMPRESSAO);
    expect(document.title).toBe("WRW");
    expect(botaoDaPagina()).toHaveFocus();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(2));
    expect(rede.chamadas).toHaveLength(2);
  });

  it("enquanto o servidor prepara, o aviso diz 'Preparando' e os botões esperam; Esc não fecha", async () => {
    rede.segurar = true;
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    expect(await within(dialogo()).findByText("Preparando o PDF…")).toBeInTheDocument();
    expect(within(dialogo()).getByRole("button", { name: "Baixar PDF" })).toBeDisabled();
    expect(within(dialogo()).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    fireEvent.keyDown(dialogo(), { key: "Escape" });
    expect(dialogo()).toBeInTheDocument();
    await act(async () => { rede.pendentes[0](EXPORTADA); });
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
  });

  it("reunião em árabe com a tela em pt-BR: o documento sai em árabe e o aviso segue em português", async () => {
    rede.resposta = { ...EXPORTADA, idioma: "ar", nomes: {} };
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    expect(impressoes[0].idioma).toBe("ar");
    expect(impressoes[0].texto).toContain("ملخص الاجتماع");
    expect(impressoes[0].texto).toContain("المتحدث 1");
    expect(impressoes[0].texto).not.toContain("Resumo da reunião");
    expect(dialogo()).toHaveTextContent("Na tela de impressão");
  });
});

describe("Baixar PDF — as recusas, no idioma da tela, sem abrir a impressão", () => {
  it.each([
    ["o teto de exportações", "TOO_MANY_REQUESTS", MENSAGEM_EXPORTACOES_DEMAIS, "Muitos PDFs baixados em sequência. Aguarde alguns minutos e tente de novo."],
    ["a reunião que não está pronta", "PRECONDITION_FAILED", MENSAGEM_EXPORTAR_SO_PRONTA, "Só dá para baixar o PDF de uma reunião pronta."],
    ["a reunião de outra conta (ou excluída)", "NOT_FOUND", "Reunião não encontrada.", "Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta."],
    ["a falha que a tela não conhece", "BAD_REQUEST", "qualquer coisa", "Não foi possível preparar o PDF. Tente de novo."],
  ])("%s", async (_caso, codigo, mensagem, naTela) => {
    rede.resposta = erroDoServidor(codigo, mensagem);
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    expect(await within(dialogo()).findByRole("alert")).toHaveTextContent(naTela);
    expect(imprimir).not.toHaveBeenCalled();
    expect(document.body.querySelector(".impressao-da-reuniao")).toBeNull();
  });

  it("com a tela em inglês, o teto sai em inglês", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    rede.resposta = erroDoServidor("TOO_MANY_REQUESTS", MENSAGEM_EXPORTACOES_DEMAIS);
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download PDF" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Too many PDFs downloaded in a row. Wait a few minutes and try again.");
  });
});

describe("Baixar PDF — no app instalado", () => {
  it("a dica de abrir no navegador aparece só no app instalado", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((consulta: string) => ({ matches: consulta === "(display-mode: standalone)", media: consulta, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    try {
      abrir();
      fireEvent.click(botaoDaPagina());
      confirmar();
      await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
      expect(dialogo()).toHaveTextContent("No app instalado, se a tela de impressão não abrir, abra esta reunião no navegador e baixe o PDF por lá.");
    } finally {
      cleanup();
      window.matchMedia = original;
    }
  });

  it("no navegador, a dica não aparece", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    confirmar();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1));
    expect(dialogo()).not.toHaveTextContent("No app instalado");
  });
});

describe("nomeDoArquivo", () => {
  it("o título e a data, sem os caracteres que o sistema de arquivos recusa", () => {
    const criadaEm = new Date(2026, 0, 5, 9, 0).getTime();
    expect(nomeDoArquivo({ titulo: "Reunião: importadora / Santos", criadaEm })).toBe("Reunião importadora Santos - 2026-01-05");
    expect(nomeDoArquivo({ titulo: "اجتماع مع المستورد", criadaEm })).toBe("اجتماع مع المستورد - 2026-01-05");
    expect(nomeDoArquivo({ titulo: '<>:"|?*', criadaEm })).toBe("2026-01-05");
  });
});
