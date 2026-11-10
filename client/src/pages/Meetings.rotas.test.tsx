import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense, type ComponentType } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Switch } from "wouter";
import i18n from "@/i18n";
import { PageTransition } from "@/components/PageTransition";
import { CODIGO_ERRO_INTERROMPIDO, MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ERRO_DE_CONSULTA } from "@shared/const";
import Meetings from "./Meetings";

/**
 * As rotas de Reuniões (30/10/2026): a URL escolhe o ramo da tela. /gravar abre
 * o gravador (o link exclusivo e a primeira tela depois do login), /meetings/:id
 * o detalhe e /meetings a lista. Era estado interno: o voltar do celular saía
 * da tela, recarregar perdia o detalhe e não havia link para gravar nem para
 * abrir uma reunião.
 *
 * O tRPC vira o mesmo dublê de Meetings.test.tsx.
 */

type Opcoes = {
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (erro: unknown, vars: unknown) => void;
  onSettled?: (data: unknown, erro: unknown, vars: unknown) => void;
};

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn>; mutateAsync: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn(), mutateAsync: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, mutateAsync: m.mutateAsync, isPending: false };
    },
  });
  return {
    mutacoes,
    registrar,
    list: vi.fn(),
    get: vi.fn(),
    pendencias: vi.fn(),
    // A leitura da duração do arquivo pelo navegador (o jsdom não toca áudio).
    duracao: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, get: { invalidate: vi.fn(), setData: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/lib/duracao-no-navegador", () => ({ lerDuracaoNoNavegador: (arquivo: Blob) => duble.duracao(arquivo) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      list: { useQuery: (...args: unknown[]) => duble.list(...args) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      create: duble.registrar("create"),
      submitRecording: duble.registrar("submitRecording"),
      decideEntity: duble.registrar("decideEntity"),
      decideContactSuggestion: duble.registrar("decideContactSuggestion"),
      translateTranscript: duble.registrar("translateTranscript"),
      delete: duble.registrar("delete"),
      reprocess: duble.registrar("reprocess"),
      resumir: duble.registrar("resumir"),
      perguntar: duble.registrar("perguntar"),
    },
    networkInteligente: {
      pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) },
    },
  },
}));

const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const BIA = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const TITULOS: Record<string, string> = { [VINICOLA]: "Reunião com a vinícola", [BIA]: "Reunião com a Bia" };
const reuniao = (id: string) => ({ id, title: TITULOS[id], status: "ready", processingError: null, createdAt: Date.UTC(2026, 8, 4, 12), updatedAt: Date.UTC(2026, 8, 4, 12) });

function abrirEm(caminho: string) {
  window.history.replaceState(null, "", caminho);
  return render(<Meetings />);
}

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [reuniao(VINICOLA), reuniao(BIA)], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockImplementation(({ meetingId }: { meetingId: string }) => ({
    data: { meeting: reuniao(meetingId), transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }));
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
});

afterEach(async () => {
  // Desmonta antes: no Vitest 2 os afterEach rodam em pilha, e este viria antes do
  // cleanup do setup. Com a página montada, restaurar os dublês e trocar o idioma
  // a redesenharia sem dados, e o vitest sairia com erro mesmo com tudo verde.
  cleanup();
  vi.restoreAllMocks();
  // Um teste que troca o idioma e falha no meio não deixa os seguintes em outra língua.
  await i18n.changeLanguage("pt-BR");
});

describe("Reuniões — a URL escolhe a tela", () => {
  it("/gravar abre o gravador direto, sem passar pela lista", () => {
    abrirEm("/gravar");
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nova reunião/ })).not.toBeInTheDocument();
    // O aviso de privacidade (retenção do áudio) aparece antes de gravar, sem passar pela lista.
    expect(screen.getByText(/expirar após 30 dias/)).toBeInTheDocument();
  });

  it("/meetings/<id> abre o detalhe daquela reunião", () => {
    abrirEm(`/meetings/${VINICOLA}`);
    expect(duble.get).toHaveBeenCalledWith({ meetingId: VINICOLA }, expect.anything());
    expect(screen.getByRole("button", { name: /Todas as reuniões/ })).toBeInTheDocument();
    expect(screen.getByText("Reunião com a vinícola")).toBeInTheDocument();
  });

  it("clicar numa reunião leva ao link dela, e 'Todas as reuniões' volta a /meetings", () => {
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /Todas as reuniões/ }));
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.getByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
  });

  it("'Nova reunião' leva a /gravar, e 'Voltar' devolve à lista", () => {
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(window.location.pathname).toBe("/gravar");
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Voltar/ }));
    expect(window.location.pathname).toBe("/meetings");
  });

  it("o voltar do navegador sai do detalhe para a lista", async () => {
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/meetings"));
    expect(await screen.findByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
  });

  it("ir de uma reunião direto a outra remonta o detalhe: nada da anterior fica aberto", () => {
    abrirEm(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    expect(screen.getByText("Excluir esta reunião?")).toBeInTheDocument();
    act(() => window.history.pushState(null, "", `/meetings/${BIA}`));
    expect(screen.getByText("Reunião com a Bia")).toBeInTheDocument();
    expect(screen.queryByText("Excluir esta reunião?")).not.toBeInTheDocument();
  });
});

describe("Reuniões — depois do envio", () => {
  it("o envio que dá certo leva ao detalhe e tira o gravador do histórico", async () => {
    const trocar = vi.spyOn(window.history, "replaceState");
    abrirEm("/gravar");
    trocar.mockClear();
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
    expect(trocar.mock.calls.some(chamada => chamada[2] === `/meetings/${VINICOLA}`)).toBe(true);
  });

  it("quem saiu do gravador enquanto o áudio processava não é arrastada ao detalhe", async () => {
    abrirEm("/gravar");
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/meetings");
  });

  it("o envio de um gravador que já saiu da tela não tira a usuária do gravador novo", async () => {
    const { unmount } = abrirEm("/gravar");
    const onSuccessDoPrimeiro = duble.mutacoes.submitRecording.opcoes.onSuccess;
    unmount();
    abrirEm("/gravar");
    await act(async () => { await onSuccessDoPrimeiro?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/gravar");
  });

  it("em /gravar/ (barra final, como a rota aceita) o envio que dá certo também leva ao detalhe", async () => {
    abrirEm("/gravar/");
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
  });

  it("o fim do envio, com sucesso ou com falha, relê o detalhe daquela reunião (que pode já estar aberto)", () => {
    abrirEm("/gravar");
    const { onSettled } = duble.mutacoes.submitRecording.opcoes;
    act(() => onSettled?.({}, null, { meetingId: VINICOLA }));
    expect(duble.utils.meetings.get.invalidate).toHaveBeenLastCalledWith({ meetingId: VINICOLA });
    // As pendências lidas no meio do envio saem da tela e se releem.
    expect(duble.utils.networkInteligente.pendencias.reset).toHaveBeenLastCalledWith({ meetingId: VINICOLA });
    duble.utils.meetings.get.invalidate.mockClear();
    act(() => onSettled?.(undefined, new Error("falhou"), { meetingId: BIA }));
    expect(duble.utils.meetings.get.invalidate).toHaveBeenLastCalledWith({ meetingId: BIA });
    expect(duble.utils.networkInteligente.pendencias.reset).toHaveBeenLastCalledWith({ meetingId: BIA });
  });

  it("com o detalhe aberto durante o envio, o fim do envio e o detalhe avisam com o mesmo id: um aviso só", async () => {
    const detalheCom = (status: string) => ({
      data: { meeting: { ...reuniao(VINICOLA), status }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    duble.get.mockReturnValue(detalheCom("processing"));
    const { rerender } = abrirEm(`/meetings/${VINICOLA}`);
    duble.get.mockReturnValue(detalheCom("ready"));
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    rerender(<Meetings />);
    const avisos = vi.mocked(toast.success).mock.calls.filter(([texto]) => texto === i18n.t("meetings.processedSuccess"));
    expect(avisos).toHaveLength(2);
    for (const [, opcoes] of avisos) expect(opcoes).toEqual({ id: `reuniao-processada-${VINICOLA}` });
  });

  it("com o detalhe aberto, a falha do envio e a do detalhe também avisam com o mesmo id", async () => {
    const detalheCom = (status: string) => ({
      data: { meeting: { ...reuniao(VINICOLA), status }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    duble.get.mockReturnValue(detalheCom("processing"));
    const { rerender } = abrirEm(`/meetings/${VINICOLA}`);
    duble.get.mockReturnValue(detalheCom("failed"));
    act(() => duble.mutacoes.submitRecording.opcoes.onError?.(new Error("A IA não respondeu."), { meetingId: VINICOLA }));
    rerender(<Meetings />);
    const avisos = vi.mocked(toast.error).mock.calls;
    expect(avisos).toHaveLength(2);
    for (const [, opcoes] of avisos) expect(opcoes).toEqual({ id: `reuniao-falhou-${VINICOLA}` });
  });

  it("a falha do envio com o banco fora do ar avisa no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    abrirEm("/gravar");
    act(() => duble.mutacoes.submitRecording.opcoes.onError?.(new Error(MENSAGEM_BANCO_INDISPONIVEL), { meetingId: VINICOLA }));
    expect(toast.error).toHaveBeenCalledWith(i18n.t("errors.databaseUnavailable"), { id: `reuniao-falhou-${VINICOLA}` });
  });

  it("com o detalhe aberto, o aviso da falha que o detalhe vê traz a causa gravada pelo servidor, e não a frase genérica", async () => {
    const CAUSA = "O limite de uso gratuito do serviço de IA foi atingido.";
    const detalheCom = (status: string, processingError: string | null) => ({
      data: { meeting: { ...reuniao(VINICOLA), status, processingError }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    duble.get.mockReturnValue(detalheCom("processing", null));
    const { rerender } = abrirEm(`/meetings/${VINICOLA}`);
    act(() => duble.mutacoes.submitRecording.opcoes.onError?.(new Error(CAUSA), { meetingId: VINICOLA }));
    duble.get.mockReturnValue(detalheCom("failed", CAUSA));
    rerender(<Meetings />);
    const avisos = vi.mocked(toast.error).mock.calls;
    expect(avisos.at(-1)).toEqual([CAUSA, { id: `reuniao-falhou-${VINICOLA}` }]);
    expect(avisos.some(([texto]) => texto === i18n.t("meetings.processError"))).toBe(false);
  });

  it("com a tela em inglês, o erro de consulta gravado como causa sai traduzido no aviso do detalhe e no quadro", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    const detalheCom = (status: string, processingError: string | null) => ({
      data: { meeting: { ...reuniao(VINICOLA), status, processingError }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    duble.get.mockReturnValue(detalheCom("processing", null));
    const { rerender } = abrirEm(`/meetings/${VINICOLA}`);
    act(() => duble.mutacoes.submitRecording.opcoes.onError?.(new Error(MENSAGEM_ERRO_DE_CONSULTA), { meetingId: VINICOLA }));
    duble.get.mockReturnValue(detalheCom("failed", MENSAGEM_ERRO_DE_CONSULTA));
    rerender(<Meetings />);
    // O aviso do detalhe (o último, com o mesmo id do envio) e o quadro vermelho, os dois traduzidos.
    expect(vi.mocked(toast.error).mock.calls.at(-1)).toEqual([i18n.t("errors.queryFailed"), { id: `reuniao-falhou-${VINICOLA}` }]);
    expect(screen.getByText(i18n.t("errors.queryFailed"))).toBeInTheDocument();
    expect(screen.queryByText(MENSAGEM_ERRO_DE_CONSULTA)).not.toBeInTheDocument();
    expect(i18n.t("errors.queryFailed")).not.toBe(MENSAGEM_ERRO_DE_CONSULTA);
  });

  it("a falha marcada pela varredura chega ao aviso do detalhe já traduzida", () => {
    const detalheCom = (status: string, processingError: string | null) => ({
      data: { meeting: { ...reuniao(VINICOLA), status, processingError }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    duble.get.mockReturnValue(detalheCom("processing", null));
    const { rerender } = abrirEm(`/meetings/${VINICOLA}`);
    duble.get.mockReturnValue(detalheCom("failed", CODIGO_ERRO_INTERROMPIDO));
    rerender(<Meetings />);
    expect(toast.error).toHaveBeenLastCalledWith(i18n.t("meetings.processingInterrupted"), { id: `reuniao-falhou-${VINICOLA}` });
  });

  it("depois do envio o gravador recomeça vazio, sem o título nem o consentimento da reunião enviada", async () => {
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    act(() => window.history.pushState(null, "", "/gravar"));
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

describe("Reuniões — gravação em curso", () => {
  class GravadorFalso {
    static isTypeSupported = () => true;
    mimeType = "audio/webm";
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((evento: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["som"], { type: "audio/webm" }) });
      this.onstop?.();
    }
  }

  // O jsdom não tem createObjectURL nem mediaDevices: o gravador usa o primeiro
  // para ouvir o áudio antes de transcrever. Os originais voltam depois de cada teste.
  let originais: { criar: unknown; revogar: unknown; microfone: PropertyDescriptor | undefined };
  // A trilha do microfone que o navegador entrega: o stop dela é o microfone fechando.
  const trilha = { stop: vi.fn() };

  beforeEach(() => {
    originais = { criar: URL.createObjectURL, revogar: URL.revokeObjectURL, microfone: Object.getOwnPropertyDescriptor(navigator, "mediaDevices") };
    vi.stubGlobal("MediaRecorder", GravadorFalso);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [trilha] }) },
    });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:gravacao") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originais.criar });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originais.revogar });
    if (originais.microfone) Object.defineProperty(navigator, "mediaDevices", originais.microfone);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  /** Monta como o App: a página dentro do PageTransition, que escurece a tela a cada troca de URL. */
  function abrirComTransicao(caminho: string) {
    window.history.replaceState(null, "", caminho);
    return render(<PageTransition><Meetings /></PageTransition>);
  }

  const veu = () => document.querySelector<HTMLDivElement>("div[aria-hidden='true']")!;

  async function comecarAGravar() {
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  }

  it("sair de /gravar gravando pelo menu devolve a URL ao gravador, avisa e não deixa o véu preto preso", async () => {
    abrirComTransicao("/gravar");
    await comecarAGravar();
    // Nada avisou antes da saída: o aviso conferido abaixo é o da volta.
    expect(toast.info).not.toHaveBeenCalled();
    const trocar = vi.spyOn(window.history, "replaceState");
    const pararGravador = vi.spyOn(GravadorFalso.prototype, "stop");
    const releiturasAntes = duble.utils.meetings.list.invalidate.mock.calls.length;
    act(() => window.history.pushState(null, "", "/meetings"));
    await waitFor(() => expect(window.location.pathname).toBe("/gravar"));
    // A tela ficou no gravador o tempo todo: a lista nem montou (montar relê a lista).
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBe(releiturasAntes);
    // A volta troca a entrada do histórico, e o voltar do navegador não cai na lista.
    expect(trocar.mock.calls.some(chamada => chamada[2] === "/gravar")).toBe(true);
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nova reunião/ })).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" });
    // A ida e volta da URL no mesmo instante não pode deixar o véu cobrindo a tela.
    // Sem escurecer: a espera curta não deixa passar um ciclo inteiro de 630 ms.
    await waitFor(() => expect(veu().style.pointerEvents).toBe("none"), { timeout: 200 });
    expect(veu().style.opacity).toBe("0");
    // A gravação continuou: nem o microfone fechou nem o gravador parou.
    expect(trilha.stop).not.toHaveBeenCalled();
    expect(pararGravador).not.toHaveBeenCalled();
    // O Encerrar fecha os dois: os espiões enxergam o caminho de verdade.
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(pararGravador).toHaveBeenCalled();
    expect(trilha.stop).toHaveBeenCalled();
  });

  it("ir a uma reunião (/meetings/:id) gravando também devolve a URL ao gravador, com o microfone aberto", async () => {
    abrirEm("/gravar");
    await comecarAGravar();
    act(() => window.history.pushState(null, "", `/meetings/${VINICOLA}`));
    await waitFor(() => expect(window.location.pathname).toBe("/gravar"));
    // A tela ficou no gravador o tempo todo: o detalhe nem montou, nem consultou.
    expect(duble.get).not.toHaveBeenCalled();
    expect(duble.pendencias).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Todas as reuniões/ })).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" });
    expect(trilha.stop).not.toHaveBeenCalled();
  });

  it("sair de Reuniões gravando, para outra tela, desmonta a página e fecha o microfone", async () => {
    const { unmount } = abrirEm("/gravar");
    await comecarAGravar();
    expect(trilha.stop).not.toHaveBeenCalled();
    unmount();
    expect(trilha.stop).toHaveBeenCalled();
  });

  it("o voltar do navegador durante a gravação também volta ao gravador, sem véu preso", async () => {
    abrirComTransicao("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument());
    // A troca de /meetings para /gravar termina antes do voltar, como no uso real.
    await waitFor(() => expect(veu().style.pointerEvents).toBe("none"), { timeout: 3000 });
    await comecarAGravar();
    const releiturasAntes = duble.utils.meetings.list.invalidate.mock.calls.length;
    act(() => window.history.back());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" }));
    await waitFor(() => expect(window.location.pathname).toBe("/gravar"));
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBe(releiturasAntes);
    // Sem escurecer: a espera curta não deixa passar um ciclo inteiro de 630 ms.
    await waitFor(() => expect(veu().style.pointerEvents).toBe("none"), { timeout: 200 });
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  });

  it("com a autorização marcada, 'Transcrever áudio' cria a reunião e envia o áudio gravado com o id dela", async () => {
    duble.mutacoes.create?.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    expect(duble.mutacoes.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia", consentGranted: true }));
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: "reuniao-gravada", mimeType: "audio/webm", audioBase64: expect.stringMatching(/^data:audio\/webm/),
    })));
  });

  it("o microfone que chega depois de a página sair é solto na hora, sem gravar", async () => {
    let entregar: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolver => { entregar = resolver; }) },
    });
    const criar = vi.spyOn(GravadorFalso.prototype, "start");
    const { unmount } = abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    unmount();
    await act(async () => { entregar({ getTracks: () => [trilha] }); });
    expect(trilha.stop).toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
  });

  it("o microfone que chega depois de a dona ir do gravador à lista (a mesma página) é solto, sem gravar nem puxá-la de volta", async () => {
    let entregar: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolver => { entregar = resolver; }) },
    });
    const iniciar = vi.spyOn(GravadorFalso.prototype, "start");
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { entregar({ getTracks: () => [trilha] }); });
    expect(trilha.stop).toHaveBeenCalled();
    expect(iniciar).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.getByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
    expect(toast.info).not.toHaveBeenCalled();
    // De volta ao gravador, ele está livre para gravar.
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
  });

  it("o servidor recusa o envio da gravação: o aviso leva o id da reunião e o formulário destrava", async () => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    duble.mutacoes.submitRecording.mutateAsync.mockRejectedValue(new Error("A IA não respondeu."));
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    // O mesmo id do onError do envio: o sonner troca aquele aviso em vez de empilhar outro igual.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A IA não respondeu.", { id: "reuniao-falhou-reuniao-gravada" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
    // O áudio gravado continua na tela: dá para tentar de novo.
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
  });

  it("o envio da gravação recusado com um erro sem mensagem avisa com a frase genérica, e não com um aviso em branco", async () => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    // O TRPCError sem mensagem chega com a string vazia. O onError já avisou com
    // a frase genérica, e o catch vem depois, com o mesmo id: troca aquele aviso.
    duble.mutacoes.submitRecording.mutateAsync.mockRejectedValue(new Error(""));
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("meetings.processError"), { id: "reuniao-falhou-reuniao-gravada" }));
    expect(toast.error).not.toHaveBeenCalledWith("", expect.anything());
  });

  it("a reunião não chega a ser criada (banco fora do ar): o aviso sai sem id, nada é enviado e o áudio continua para tentar de novo", async () => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error("Banco de dados indisponível. Tente de novo em instantes."));
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    // Só a mensagem: sem reunião criada não há aviso do onError para trocar.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Banco de dados indisponível. Tente de novo em instantes."));
    expect(duble.mutacoes.submitRecording.mutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
  });

  it("a reunião não chega a ser criada e o erro vem sem mensagem: o aviso da gravação sai com a frase genérica do envio, sem id", async () => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error(""));
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    // Um argumento só: sem reunião criada, o aviso não leva o id da reunião.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("meetings.sendRecordingError")));
    expect(toast.error).not.toHaveBeenCalledWith("");
    expect(toast.error).not.toHaveBeenCalledWith(i18n.t("meetings.processError"));
    expect(duble.mutacoes.submitRecording.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    { caminho: "o menu (Reuniões)", irALista: () => act(() => window.history.pushState(null, "", "/meetings")) },
    { caminho: "o Voltar do gravador", irALista: () => fireEvent.click(screen.getByRole("button", { name: /Voltar/ })) },
  ])("o áudio gravado e ainda não enviado sobrevive à ida à lista por $caminho e à volta ao gravador", async ({ irALista }) => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    irALista();
    expect(window.location.pathname).toBe("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(window.location.pathname).toBe("/gravar");
    // A mesma instância: o áudio, o título e a autorização continuam, e nada foi descartado.
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toHaveValue("Conversa com a Bia");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    expect(duble.mutacoes.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia", consentGranted: true }));
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: "reuniao-gravada", audioBase64: expect.stringMatching(/^data:audio\/webm/),
    })));
  });

  it("quem volta ao gravador durante o envio encontra a trava, e o fim do envio a leva ao detalhe", async () => {
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: VINICOLA });
    let entregarEnvio: () => void = () => {};
    duble.mutacoes.submitRecording.mutateAsync.mockImplementation(() => new Promise<void>(resolver => { entregarEnvio = () => resolver(); }));
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalled());
    const releiturasAntes = duble.utils.meetings.list.invalidate.mock.calls.length;
    act(() => window.history.pushState(null, "", "/meetings"));
    // Com o envio no ar, a lista se relê: a reunião recém-criada aparece nela.
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBeGreaterThan(releiturasAntes);
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(window.location.pathname).toBe("/gravar");
    // O envio ainda está no ar: o gravador continua travado, sem gravar nem enviar outra.
    expect(screen.getByText(/Transcrevendo e analisando/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Iniciar gravação/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar arquivo de áudio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    const trocar = vi.spyOn(window.history, "replaceState");
    await act(async () => {
      await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA });
      entregarEnvio();
    });
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
    expect(trocar.mock.calls.some(chamada => chamada[2] === `/meetings/${VINICOLA}`)).toBe(true);
  });

  it("o fim automático que chega depois do teto (aba em segundo plano) declara no máximo os 600 s que o servidor aceita", async () => {
    const agora = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    await comecarAGravar();
    // O relógio pula para 601,05 s: o próximo tique do cronômetro encerra a gravação sozinho.
    agora.mockReturnValue(1_000_000 + 601_050);
    // A espera fica fora do act: dentro dele, a tela só se redesenha no fim.
    const transcrever = await screen.findByRole("button", { name: /Transcrever áudio/ }, { timeout: 3000 });
    await act(async () => { fireEvent.click(transcrever); });
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 600 })));
  });

  it("a gravação comum declara o tempo que durou, e não o teto", async () => {
    const agora = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-gravada" });
    await comecarAGravar();
    agora.mockReturnValue(1_000_000 + 95_400);
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByText("Duração: 01:35")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 95 })));
  });

  it("vários toques no menu durante a gravação dão um aviso só, com o mesmo id", async () => {
    abrirEm("/gravar");
    await comecarAGravar();
    for (let i = 0; i < 3; i++) act(() => window.history.pushState(null, "", "/meetings"));
    expect(window.location.pathname).toBe("/gravar");
    const avisos = vi.mocked(toast.info).mock.calls;
    expect(avisos).toHaveLength(3);
    for (const chamada of avisos) expect(chamada).toEqual(["Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" }]);
  });

  it("o microfone negado depois de a dona ir à lista não avisa fora do gravador nem fica guardado para a volta", async () => {
    let negar: (erro: unknown) => void = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise((_resolver, rejeitar) => { negar = rejeitar; }) },
    });
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { negar(new DOMException("negado", "NotAllowedError")); });
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(screen.queryByText(/Permissão de microfone:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
  });

  it("o microfone negado no gravador avisa e mostra o problema (controle do teste anterior)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("negado", "NotAllowedError")) },
    });
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByText(/Permissão de microfone:/)).toBeInTheDocument();
  });

  it("com o banco fora do ar, o aviso do envio da gravação sai no idioma da tela, e não na frase do servidor em português", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error(MENSAGEM_BANCO_INDISPONIVEL));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("meetings.titlePlaceholder")), { target: { value: "Talk with Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("meetings.startRecording")) })); });
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(i18n.t("meetings.stopRecording")) }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: new RegExp(i18n.t("meetings.transcribeButton")) })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("errors.databaseUnavailable")));
    expect(i18n.t("errors.databaseUnavailable")).not.toBe(MENSAGEM_BANCO_INDISPONIVEL);
  });

  it("desmarcar o consentimento depois de gravar impede o envio", async () => {
    abrirEm("/gravar");
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    const transcrever = await screen.findByRole("button", { name: /Transcrever áudio/ });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(transcrever); });
    expect(toast.error).toHaveBeenCalledWith("Marque a caixa de autorização antes de enviar o áudio.");
    expect(duble.mutacoes.create.mutateAsync).not.toHaveBeenCalled();
  });

  it("o envio que termina com a dona fora do gravador também o zera: voltar a ele não reabre o áudio enviado", async () => {
    abrirEm("/gravar");
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/meetings");
    expect(toast.success).toHaveBeenCalledWith(i18n.t("meetings.processedSuccess"), { id: `reuniao-processada-${VINICOLA}` });
    act(() => window.history.pushState(null, "", "/gravar"));
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:gravacao");
  });

  it("depois do envio, 'Nova reunião' não reabre o áudio já enviado (era o que duplicava a reunião)", async () => {
    abrirEm("/gravar");
    await comecarAGravar();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
    act(() => window.history.pushState(null, "", "/gravar"));
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:gravacao");
  });
});

describe("Reuniões — excluir, voltar à lista e link inválido", () => {
  it("excluir volta à lista trocando o histórico: o voltar não reabre a reunião excluída", async () => {
    const trocar = vi.spyOn(window.history, "replaceState");
    abrirEm(`/meetings/${VINICOLA}`);
    trocar.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Excluir reunião" }));
    expect(duble.mutacoes.delete.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA });
    await act(async () => { await duble.mutacoes.delete.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/meetings");
    expect(trocar.mock.calls.some(chamada => chamada[2] === "/meetings")).toBe(true);
  });

  it("a exclusão que termina depois de a pessoa sair do detalhe não a puxa de volta", async () => {
    abrirEm(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Excluir reunião" }));
    const onSuccessDaExclusao = duble.mutacoes.delete.opcoes.onSuccess;
    act(() => window.history.pushState(null, "", "/gravar"));
    await act(async () => { await onSuccessDaExclusao?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/gravar");
  });

  it("chegar à lista vinda do detalhe relê a lista", () => {
    // Começa na lista, como quem entra pelo menu: a prova não vem do valor inicial do ref.
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    const antes = duble.utils.meetings.list.invalidate.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /Todas as reuniões/ }));
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBeGreaterThan(antes);
  });

  it("com a lista aberta durante o envio, o fim do envio com sucesso a relê (ela foi lida com a reunião ainda pendente)", async () => {
    abrirEm("/meetings");
    const releiturasAntes = duble.utils.meetings.list.invalidate.mock.calls.length;
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBe(releiturasAntes + 1);
    expect(window.location.pathname).toBe("/meetings");
  });

  it("chegar à lista vinda do gravador (menu ou voltar) relê a lista", () => {
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    const antes = duble.utils.meetings.list.invalidate.mock.calls.length;
    act(() => window.history.pushState(null, "", "/meetings"));
    expect(duble.utils.meetings.list.invalidate.mock.calls.length).toBeGreaterThan(antes);
  });

  it("reunião excluída ou de outra conta (NOT_FOUND) diz isso no idioma da tela, e não na frase do servidor", async () => {
    await i18n.changeLanguage("en");
    duble.get.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: { message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } }, refetch: vi.fn(),
    });
    abrirEm(`/meetings/${VINICOLA}`);
    expect(screen.getByRole("alert")).toHaveTextContent("Meeting not found.");
    expect(screen.queryByText(/Reunião não encontrada/)).not.toBeInTheDocument();
    // Tentar de novo não traz de volta o que foi excluído.
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
    // A saída é a lista.
    fireEvent.click(screen.getByRole("button", { name: /All meetings/ }));
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.getByRole("button", { name: /New meeting/ })).toBeInTheDocument();
    await i18n.changeLanguage("pt-BR");
  });

  it("link com id inválido diz que o link está incompleto, sem o JSON do servidor e sem novas tentativas", () => {
    duble.get.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: { message: '[{"code":"invalid_format","format":"uuid"}]', data: { code: "BAD_REQUEST" } }, refetch: vi.fn(),
    });
    abrirEm("/meetings/8b1f6a2e-3c4d");
    expect(screen.getByRole("alert")).toHaveTextContent("Este link de reunião está incompleto ou foi alterado.");
    expect(screen.queryByText(/invalid_format/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar novamente/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Todas as reuniões/ }));
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.getByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
    const opcoes = duble.get.mock.calls[0][1] as { retry: (tentativas: number, erro: unknown) => boolean };
    expect(opcoes.retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(opcoes.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    // As pendências da reunião também consultam com o id da URL: uma vez só.
    expect(duble.pendencias).toHaveBeenCalledWith({ meetingId: "8b1f6a2e-3c4d" }, expect.anything());
    const opcoesDasPendencias = duble.pendencias.mock.calls[0][1] as { retry: (tentativas: number, erro: unknown) => boolean };
    expect(opcoesDasPendencias.retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(opcoesDasPendencias.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(opcoesDasPendencias.retry(3, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });

  it("o erro definitivo (reunião que não existe, link cortado) não se relê na volta à aba nem na reconexão; os outros erros, sim", () => {
    abrirEm(`/meetings/${VINICOLA}`);
    // O estado da consulta, como o React Query o passa às opções em forma de função.
    const consultaCom = (code?: string) => ({ state: { data: undefined, error: code ? { data: { code } } : null } });
    const opcoes = duble.get.mock.calls[0][1] as { refetchOnWindowFocus?: (consulta: unknown) => unknown; refetchOnReconnect?: (consulta: unknown) => unknown };
    for (const code of ["NOT_FOUND", "BAD_REQUEST"]) {
      expect(opcoes.refetchOnWindowFocus?.(consultaCom(code)), `volta à aba com ${code}`).toBe(false);
      expect(opcoes.refetchOnReconnect?.(consultaCom(code)), `reconexão com ${code}`).toBe(false);
    }
    for (const code of [undefined, "INTERNAL_SERVER_ERROR"]) {
      expect(opcoes.refetchOnWindowFocus?.(consultaCom(code)), `volta à aba com ${code ?? "consulta sem erro"}`).toBe(true);
      expect(opcoes.refetchOnReconnect?.(consultaCom(code)), `reconexão com ${code ?? "consulta sem erro"}`).toBe(true);
    }
    // As pendências não se releem na volta à aba; na reconexão, só sem o link cortado.
    const opcoesDasPendencias = duble.pendencias.mock.calls[0][1] as { refetchOnWindowFocus?: boolean; refetchOnReconnect?: (consulta: unknown) => unknown };
    expect(opcoesDasPendencias.refetchOnWindowFocus).toBe(false);
    expect(opcoesDasPendencias.refetchOnReconnect?.(consultaCom("BAD_REQUEST"))).toBe(false);
    expect(opcoesDasPendencias.refetchOnReconnect?.(consultaCom())).toBe(true);
  });
});

describe("Reuniões — escondida pelo Suspense, sem desmontar", () => {
  /**
   * Monta como o App: um Suspense só, acima do Switch, as três rotas de
   * Reuniões com a mesma instância da página e uma tela lazy (/memory) cujo
   * código só chega quando o teste chama entregarTela. Na primeira ida a ela, o
   * React esconde a página (display: none) sem desmontá-la até o código chegar,
   * e nesse meio só os efeitos de layout se limpam.
   */
  function abrirNoApp(caminho: string) {
    let entregar: (modulo: { default: ComponentType }) => void = () => {};
    // O lazy nasce em cada teste: depois de resolvido, ele fica em cache.
    const TelaLenta = lazy(() => new Promise<{ default: ComponentType }>(resolver => { entregar = resolver; }));
    window.history.replaceState(null, "", caminho);
    render(
      <Suspense fallback={<p>Carregando a tela…</p>}>
        <Switch>
          <Route path="/gravar"><Meetings /></Route>
          <Route path="/meetings/:id"><Meetings /></Route>
          <Route path="/meetings"><Meetings /></Route>
          <Route path="/memory"><TelaLenta /></Route>
        </Switch>
      </Suspense>,
    );
    return { entregarTela: () => act(async () => { entregar({ default: () => <h1>Memória</h1> }); }) };
  }

  it("o fim do envio com a dona numa tela que ainda carrega não troca essa tela pelo detalhe", async () => {
    const { entregarTela } = abrirNoApp("/gravar");
    act(() => window.history.pushState(null, "", "/memory"));
    expect(screen.getByText("Carregando a tela…")).toBeInTheDocument();
    // O gravador segue montado, só escondido: é o caso em que o efeito comum não se limpa.
    expect(screen.getByText(/Iniciar gravação/)).not.toBeVisible();
    await act(async () => { await duble.mutacoes.submitRecording.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/memory");
    await entregarTela();
    expect(await screen.findByRole("heading", { name: "Memória" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/memory");
  });

  it("a exclusão que termina com o detalhe escondido (a dona foi a uma tela que ainda carrega) não a leva à lista", async () => {
    abrirNoApp(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Excluir reunião" }));
    act(() => window.history.pushState(null, "", "/memory"));
    expect(screen.getByText("Carregando a tela…")).toBeInTheDocument();
    expect(screen.getByText("Reunião com a vinícola")).not.toBeVisible();
    await act(async () => { await duble.mutacoes.delete.opcoes.onSuccess?.({}, { meetingId: VINICOLA }); });
    expect(window.location.pathname).toBe("/memory");
  });

  it("o microfone que o navegador entrega com a página escondida é solto na hora, sem gravar", async () => {
    let entregarMicrofone: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    const iniciar = vi.fn();
    const microfoneOriginal = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() { return true; }
      state = "inactive";
      ondataavailable = null;
      onstop = null;
      start() { iniciar(); }
      stop() {}
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolver => { entregarMicrofone = resolver; }) },
    });
    try {
      const { entregarTela } = abrirNoApp("/gravar");
      fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
      // O pedido do microfone ainda aberto quando a dona vai a uma tela que ainda carrega.
      act(() => window.history.pushState(null, "", "/memory"));
      expect(screen.getByText("Carregando a tela…")).toBeInTheDocument();
      await act(async () => { entregarMicrofone({ getTracks: () => [trilha] }); });
      expect(trilha.stop).toHaveBeenCalled();
      expect(iniciar).not.toHaveBeenCalled();
      await entregarTela();
      expect(await screen.findByRole("heading", { name: "Memória" })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/memory");
    } finally {
      vi.unstubAllGlobals();
      if (microfoneOriginal) Object.defineProperty(navigator, "mediaDevices", microfoneOriginal);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });
});

describe("Reuniões — envio de arquivo", () => {
  it("o formulário trava do começo ao fim do envio: a autorização não se desmarca no meio", async () => {
    let entregarDuracao: (segundos: number | null) => void = () => {};
    duble.duracao.mockImplementation(() => new Promise(resolver => { entregarDuracao = resolver; }));
    abrirEm("/gravar");
    let entregarCriacao: (reuniao: { id: string }) => void = () => {};
    duble.mutacoes.create.mutateAsync.mockImplementation(() => new Promise(resolver => { entregarCriacao = resolver; }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const arquivo = new File(["som"], "reuniao.mp3", { type: "audio/mpeg" });
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivo] } });
    // Enquanto o navegador lê o arquivo, nada do formulário muda.
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toBeDisabled();
    await act(async () => { entregarDuracao(30); });
    // Com a reunião sendo criada, também não: a autorização não se desmarca no meio.
    await waitFor(() => expect(duble.mutacoes.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia", consentGranted: true })));
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toBeDisabled();
    expect(duble.mutacoes.submitRecording.mutateAsync).not.toHaveBeenCalled();
    await act(async () => { entregarCriacao({ id: "reuniao-do-arquivo" }); });
    await waitFor(() => expect(duble.mutacoes.submitRecording.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: "reuniao-do-arquivo", mimeType: "audio/mpeg", durationSeconds: 30,
    })));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
  });

  it("o servidor recusa o envio: o aviso aparece e o formulário destrava", async () => {
    duble.duracao.mockResolvedValue(30);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-do-arquivo" });
    duble.mutacoes.submitRecording.mutateAsync.mockRejectedValue(new Error("Não foi possível processar o áudio."));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível processar o áudio.", { id: "reuniao-falhou-reuniao-do-arquivo" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
  });

  it("o envio de arquivo recusado com um erro sem mensagem avisa com a frase genérica, e não com um aviso em branco", async () => {
    duble.duracao.mockResolvedValue(30);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: "reuniao-do-arquivo" });
    // Como na gravação: o catch troca o aviso do onError, que já usou a frase genérica.
    duble.mutacoes.submitRecording.mutateAsync.mockRejectedValue(new Error(""));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("meetings.processError"), { id: "reuniao-falhou-reuniao-do-arquivo" }));
    expect(toast.error).not.toHaveBeenCalledWith("", expect.anything());
  });

  it("com o banco fora do ar, o aviso do envio de arquivo sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.duracao.mockResolvedValue(30);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error(MENSAGEM_BANCO_INDISPONIVEL));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("meetings.titlePlaceholder")), { target: { value: "Talk with Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("errors.databaseUnavailable")));
  });

  /** Sem leitura do arquivo nem reunião criada, e o formulário livre (a trava só começa depois das recusas). */
  function nadaSubiuEOFormularioSegueLivre() {
    expect(duble.duracao).not.toHaveBeenCalled();
    expect(duble.mutacoes.create.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
  }

  it("sem a autorização marcada, o arquivo não sobe: o create, que grava consentGranted, nem é chamado", async () => {
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Marque a caixa de autorização antes de enviar o áudio."));
    nadaSubiuEOFormularioSegueLivre();
  });

  it.each([
    { caso: "sem título", titulo: "", arquivo: () => new File(["som"], "reuniao.mp3", { type: "audio/mpeg" }), aviso: "Dê um título para a reunião." },
    { caso: "em formato que a tela não aceita", titulo: "Conversa com a Bia", arquivo: () => new File(["x"], "notas.txt", { type: "text/plain" }), aviso: "Envie um arquivo WebM, MP3, M4A, MP4, OGG ou WAV." },
    { caso: "acima de 10 MB", titulo: "Conversa com a Bia", arquivo: () => new File([new Uint8Array(11 * 1024 * 1024)], "longa.mp3", { type: "audio/mpeg" }), aviso: "O arquivo de áudio deve ter no máximo 10 MB." },
  ])("o arquivo $caso é recusado antes de travar o formulário", async ({ titulo, arquivo, aviso }) => {
    abrirEm("/gravar");
    if (titulo) fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: titulo } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivo()] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(aviso));
    nadaSubiuEOFormularioSegueLivre();
  });

  it("a reunião não chega a ser criada no envio de arquivo: o aviso sai sem id, nada é enviado e o formulário destrava", async () => {
    duble.duracao.mockResolvedValue(30);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error("Banco de dados indisponível. Tente de novo em instantes."));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Banco de dados indisponível. Tente de novo em instantes."));
    expect(duble.mutacoes.submitRecording.mutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
  });

  it("a reunião não chega a ser criada e o erro vem sem mensagem: o aviso do arquivo sai com a frase genérica do envio, sem id", async () => {
    duble.duracao.mockResolvedValue(30);
    abrirEm("/gravar");
    duble.mutacoes.create.mutateAsync.mockRejectedValue(new Error(""));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("meetings.uploadError")));
    expect(toast.error).not.toHaveBeenCalledWith("");
    expect(toast.error).not.toHaveBeenCalledWith(i18n.t("meetings.processError"));
    expect(duble.mutacoes.submitRecording.mutateAsync).not.toHaveBeenCalled();
  });
});
