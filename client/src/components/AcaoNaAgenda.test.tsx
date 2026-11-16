import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { AcaoNaAgenda, icsDaAcao, linkDaAcaoNaGoogle, mensagemDoErroDeTirarDaAgenda, useAvisosDaAgenda, type AcaoParaAAgenda } from "./AcaoNaAgenda";

/**
 * A próxima ação na agenda, na tela (H5c): a linha com o estado na Google
 * Agenda conectada, o link de criar evento sem ela e o .ics; os avisos do que
 * houve na Google. As mutações são dublês que registram o que a tela pede; o
 * que o servidor faz está em server/acoes-na-google.ts e nos testes dele.
 */

type Opcoes = { onSuccess?: (resultado: unknown, variaveis: { id: string }) => void; onError?: (erro: unknown) => void; onSettled?: () => unknown };
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { chamadas: unknown[][]; opcoes: Opcoes }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { chamadas: [], opcoes });
      m.opcoes = opcoes;
      return { mutate: (...args: unknown[]) => { m.chamadas.push(args); }, isPending: false };
    },
  });
  const invalidados: string[] = [];
  return {
    mutacoes, registrar, invalidados,
    utils: { googleAgenda: { estado: { invalidate: () => { invalidados.push("googleAgenda"); return Promise.resolve(); } } } },
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    proximasAcoes: { mandarParaGoogle: duble.registrar("mandarParaGoogle"), tirarDaGoogle: duble.registrar("tirarDaGoogle") },
  },
}));

const doisDigitos = (n: number) => String(n).padStart(2, "0");
/** "AAAA-MM-DD" daqui a n dias, no relógio de quem roda o teste. */
const dia = (n: number) => {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
};

const acao = (extra: Partial<AcaoParaAAgenda> = {}): AcaoParaAAgenda => ({
  id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", texto: "{F2} envia a proposta", detalhe: "Com o desconto", responsavel: "{F3}",
  prazo: dia(3), feita: false, google: null, vozes: { F2: "Carla" }, createdAt: 1_000, updatedAt: 61_000, ...extra,
});
const PEDIDO = { fuso: expect.any(String), rotulos: { voz: "Falante {n}", responsavel: "Responsável: {nome}" } };
const t = (chave: string, opcoes?: Record<string, unknown>) => i18n.t(chave, opcoes);
const chamadas = (nome: string) => duble.mutacoes[nome]?.chamadas ?? [];
const linha = (props: Partial<Parameters<typeof AcaoNaAgenda>[0]> = {}) => render(<AcaoNaAgenda acao={acao()} googleLigada={false} googleDesligada={false}
  aoTerminar={() => undefined} aoFalhar={() => undefined} {...props}/>);

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.chamadas.length = 0;
  duble.invalidados.length = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("a linha da agenda", () => {
  it("sem a Google Agenda conectada: o link de criar evento, já preenchido, e o .ics para o celular", () => {
    linha({ googleDesligada: true });
    const link = screen.getByRole("link", { name: "Google Agenda" });
    const url = new URL(link.getAttribute("href")!);
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Carla envia a proposta");
    expect(url.searchParams.get("details")).toContain("Responsável: Falante 3");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Agenda do celular (.ics)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pôr na Google Agenda" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Na agenda" })).toBeInTheDocument();
  });

  it("carregando a resposta da Google (nem ligada nem desligada): nada de link, que criaria o evento em dobro", () => {
    linha();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agenda do celular (.ics)" })).toBeInTheDocument();
  });

  it("com a Google Agenda: o estado da ação lá, no lugar do link", () => {
    linha({ googleLigada: true, acao: acao({ google: "ok" }) });
    expect(screen.getByText("Na sua Google Agenda")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("a que não chegou à Google: 'Tentar de novo' manda a versão do banco, com o fuso e os rótulos da tela", () => {
    linha({ googleLigada: true, acao: acao({ google: "falhou" }) });
    expect(screen.getByText("Ainda não está na sua Google Agenda")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(chamadas("mandarParaGoogle")).toEqual([[{ id: acao().id, ...PEDIDO }]]);
  });

  it("a que tinha prazo antes de conectar: 'Pôr na Google Agenda'", () => {
    linha({ googleLigada: true });
    fireEvent.click(screen.getByRole("button", { name: "Pôr na Google Agenda" }));
    expect(chamadas("mandarParaGoogle")).toHaveLength(1);
  });

  it("o dia do prazo já passou: nada a pôr na agenda; só o estado da que já estava lá", () => {
    const { container } = linha({ googleLigada: true, acao: acao({ prazo: dia(-3) }) });
    expect(container).toBeEmptyDOMElement();
    linha({ googleLigada: true, acao: acao({ prazo: dia(-3), google: "ok" }) });
    expect(screen.getByText("Na sua Google Agenda")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agenda do celular (.ics)" })).not.toBeInTheDocument();
  });

  it("o que a Google respondeu ao 'Pôr na Google Agenda' vira o aviso certo; e a tela relê", () => {
    const aoTerminar = vi.fn();
    linha({ googleLigada: true, aoTerminar });
    const { onSuccess, onSettled } = duble.mutacoes.mandarParaGoogle.opcoes;
    act(() => onSuccess!({ naGoogle: "ok" }, { id: "x" }));
    expect(toast.success).toHaveBeenCalledWith("A ação está na sua Google Agenda.");
    act(() => onSuccess!({ naGoogle: null }, { id: "x" }));
    expect(toast.info).toHaveBeenCalledWith("O prazo desta ação já passou: ela fica só na WRW.");
    act(() => onSuccess!({ naGoogle: "falhou", motivo: "revogada" }, { id: "x" }));
    expect(toast.warning).toHaveBeenCalledWith(
      "A ação está salva na WRW, mas não foi para a sua Google Agenda. Reconecte a Google Agenda no Perfil.", { duration: 10_000 });
    // A conexão quebrada: o estado dela é relido.
    expect(duble.invalidados).toEqual(["googleAgenda"]);
    onSettled!();
    expect(aoTerminar).toHaveBeenCalled();
  });

  it("baixar o .ics faz o arquivo aqui, sem ir ao servidor", () => {
    const criar = vi.fn(() => "blob:ics");
    const soltar = vi.fn();
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: soltar });
    const clicar = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    linha();
    fireEvent.click(screen.getByRole("button", { name: "Agenda do celular (.ics)" }));
    expect(criar).toHaveBeenCalledTimes(1);
    expect(clicar).toHaveBeenCalledTimes(1);
    expect(chamadas("mandarParaGoogle")).toEqual([]);
    clicar.mockRestore();
  });

  it("no árabe, os rótulos e o grupo saem traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    linha({ googleLigada: true });
    expect(screen.getByRole("group", { name: "في التقويم" })).toBeInTheDocument();
  });
});

describe("o .ics e o link", () => {
  it("o .ics: às 9h do prazo no fuso, 30 minutos, aviso na hora, o texto da lista e a revisão que cresce", () => {
    const ics = icsDaAcao(acao({ prazo: "2026-11-20" }), t, "America/Sao_Paulo", Date.UTC(2026, 10, 16))!;
    const desdobrado = ics.conteudo.replace(/\r\n /g, "");
    expect(desdobrado).toContain(`UID:acao-${acao().id}@wrwglobal.org`);
    expect(desdobrado).toContain("DTSTART:20261120T120000Z");
    expect(desdobrado).toContain("DTEND:20261120T123000Z");
    expect(desdobrado).toContain("SUMMARY:Carla envia a proposta");
    expect(desdobrado).toContain("TRIGGER:PT0S");
    expect(desdobrado).toContain("SEQUENCE:60");
    expect(desdobrado).toContain("Responsável: Falante 3");
    expect(ics.nome).toBe("Carla-envia-a-proposta.ics");
  });

  it("sem prazo, nem .ics nem link", () => {
    expect(icsDaAcao(acao({ prazo: null }), t)).toBeNull();
    expect(linkDaAcaoNaGoogle(acao({ prazo: null }), t)).toBeNull();
  });
});

describe("os avisos do que houve na Google", () => {
  it("o evento que ficou na Google porque ela falhou: o aviso traz 'Tentar de novo', que tira pela ação", () => {
    const { result } = renderHook(() => useAvisosDaAgenda());
    act(() => result.current.depoisDeTirar("acao-1", { naGoogle: "falhou", motivo: "google" }));
    const [texto, opcoes] = vi.mocked(toast.warning).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(texto).toBe("O evento desta ação continua na sua Google Agenda. A Google não respondeu. Tente de novo em instantes.");
    expect(opcoes.action.label).toBe("Tentar de novo");
    act(() => opcoes.action.onClick());
    expect(chamadas("tirarDaGoogle")).toEqual([[{ id: "acao-1" }]]);
  });

  it("quando só reconectar resolve, o aviso diz para apagar por lá, sem 'Tentar de novo'", () => {
    const { result } = renderHook(() => useAvisosDaAgenda());
    act(() => result.current.depoisDeTirar("acao-1", { naGoogle: "falhou", motivo: "nao-conectada" }));
    const [texto, opcoes] = vi.mocked(toast.warning).mock.calls[0] as [string, Record<string, unknown>];
    expect(texto).toBe("O evento desta ação continua na sua Google Agenda. Se quiser, apague o evento por lá.");
    expect(opcoes).not.toHaveProperty("action");
    expect(duble.invalidados).toEqual(["googleAgenda"]);
  });

  it("deu certo, ou a ação nunca esteve lá: nenhum aviso", () => {
    const { result } = renderHook(() => useAvisosDaAgenda());
    act(() => result.current.depoisDeTirar("acao-1", { naGoogle: "ok" }));
    act(() => result.current.depoisDeMandar({ naGoogle: null }));
    act(() => result.current.depoisDeMandar(undefined));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("o 'Tentar de novo' da retirada: o resultado vira aviso, e a ação que continua aberta tem frase própria", () => {
    renderHook(() => useAvisosDaAgenda());
    const { onSuccess, onError } = duble.mutacoes.tirarDaGoogle.opcoes;
    act(() => onSuccess!({ naGoogle: "ok" }, { id: "acao-1" }));
    expect(toast.success).toHaveBeenCalledWith("O evento da ação saiu da sua Google Agenda.");
    act(() => onError!({ data: { code: "CONFLICT" } }));
    expect(toast.error).toHaveBeenCalledWith("Esta ação continua aberta e com prazo, e o evento dela fica na sua Google Agenda. Atualize a tela.");
    expect(mensagemDoErroDeTirarDaAgenda(t, { data: { code: "CONFLICT" } })).toBe(t("proximasAcoes.agenda.errors.stillOpen"));
  });
});
