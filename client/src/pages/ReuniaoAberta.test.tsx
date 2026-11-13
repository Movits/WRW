import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import i18n from "@/i18n";
import ReuniaoAberta from "./ReuniaoAberta";

/**
 * A página do link aberto, /r/{token} (pedido do Roberto em 12/11/2026): quem
 * recebeu o link vê a reunião sem conta. O tRPC é um dublê: `ver` devolve o que
 * o teste combina, e `traduzir` registra o mutate e as opções. O resumo e o
 * "Pergunte à reunião" viram marcadores que mostram o token que receberam (o
 * comportamento deles está em components/ReuniaoComIA.test.tsx).
 */

type OpcoesDaConsulta = {
  retry: (tentativas: number, erro: unknown) => boolean;
  refetchOnReconnect: (consulta: { state: { error: unknown } }) => boolean;
};

const duble = vi.hoisted(() => ({
  ver: vi.fn(),
  opcoesDaConsulta: null as OpcoesDaConsulta | null,
  traduzir: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    reuniaoAberta: {
      ver: {
        useQuery: (entrada: unknown, opcoes: OpcoesDaConsulta) => {
          duble.opcoesDaConsulta = opcoes;
          return duble.ver(entrada);
        },
      },
      traduzir: { useMutation: () => duble.traduzir },
    },
  },
}));
vi.mock("@/components/ReuniaoComIA", () => ({
  ResumoDaReuniaoPelaIA: ({ token }: { token: string }) => <div data-testid="resumo">{token}</div>,
  PergunteAReuniao: ({ token }: { token: string }) => <div data-testid="pergunte">{token}</div>,
}));

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const VISTA = {
  titulo: "Reunião com a Ana",
  criadaEm: 1_700_000_000_000,
  transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR" },
  gravacao: { url: `/reuniao-aberta/${TOKEN}/audio`, mimeType: "audio/mp4", durationSeconds: 95, expiresAt: 1_800_000_000_000 },
  gravacaoExpirada: false,
};
const pronta = (data: unknown = VISTA) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const emErro = (code: string, refetch = vi.fn()) => ({
  data: undefined, isLoading: false, isError: true, error: { message: "frase do servidor", data: { code } }, refetch,
});

function abrir() {
  window.history.replaceState(null, "", `/r/${TOKEN}`);
  return render(<Route path="/r/:token" component={ReuniaoAberta}/>);
}

beforeEach(() => {
  duble.ver.mockReset();
  duble.opcoesDaConsulta = null;
  duble.traduzir = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false };
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Reunião aberta pelo link", () => {
  it("pede a reunião pelo token da URL e mostra título, gravação pela rota do link, transcrição e a IA", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    expect(duble.ver).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.getByText("REUNIÃO COMPARTILHADA")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Reunião com a Ana" })).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/audio`);
    expect(screen.getByText(/01:35/)).toBeInTheDocument();
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    expect(screen.getByTestId("resumo")).toHaveTextContent(TOKEN);
    expect(screen.getByTestId("pergunte")).toHaveTextContent(TOKEN);
    // Nada do que é só da dona.
    expect(screen.queryByRole("button", { name: /Excluir/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Contatos/)).not.toBeInTheDocument();
  });

  it("link que não existe ou foi desligado: aviso traduzido, sem tentar de novo", () => {
    duble.ver.mockReturnValue(emErro("NOT_FOUND"));
    abrir();
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou foi desligado por quem compartilhou a reunião.");
    expect(screen.getByRole("link", { name: "Conhecer a WRW" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /Tentar/ })).not.toBeInTheDocument();
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(duble.opcoesDaConsulta!.refetchOnReconnect({ state: { error: { data: { code: "NOT_FOUND" } } } })).toBe(false);
  });

  it("servidor fora do ar não é 'link desligado': erro com tentar de novo", () => {
    const refetch = vi.fn();
    duble.ver.mockReturnValue(emErro("INTERNAL_SERVER_ERROR", refetch));
    abrir();
    expect(screen.queryByText(/foi desligado/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tentar/ }));
    expect(refetch).toHaveBeenCalled();
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(duble.opcoesDaConsulta!.retry(3, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });

  it("gravação vencida: diz que expirou e que a transcrição continua", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: true }));
    const { container } = abrir();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByText(/passou dos 30 dias/)).toBeInTheDocument();
  });

  it("sem transcrição: a IA não aparece e a tela diz que a transcrição não está disponível", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: null }));
    abrir();
    expect(screen.queryByTestId("resumo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pergunte")).not.toBeInTheDocument();
    expect(screen.getByText("A transcrição ainda não está disponível.")).toBeInTheDocument();
  });

  it("áudio que não carrega: aviso sem mandar entrar na conta, que quem abriu o link não tem", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByText("Não foi possível carregar o áudio agora. Recarregue a página e tente de novo.")).toBeInTheDocument();
    expect(screen.queryByText(/entre de novo/)).not.toBeInTheDocument();
  });

  it("em pt-BR mostra o original sem pedir tradução; trocar o idioma traduz pelo token", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.traduzir.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "es" } });
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "es" }, expect.anything());
    const { onSuccess } = duble.traduzir.mutate.mock.calls[0][1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Acordamos la entrega el viernes." }));
    expect(screen.getByText("Acordamos la entrega el viernes.")).toBeInTheDocument();
    // De volta ao original: o texto da transcrição, e o erro de antes sai.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pt-BR" } });
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    expect(duble.traduzir.reset).toHaveBeenCalled();
  });

  it("com a tela em inglês, já abre pedindo a tradução para o inglês", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "en" }, expect.anything());
  });

  it("tradução que falhou: avisa e mostra o original", () => {
    duble.traduzir = { ...duble.traduzir, isError: true };
    duble.ver.mockReturnValue(pronta());
    abrir();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fr" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível traduzir a transcrição.");
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
  });
});
