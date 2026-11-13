import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import { motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import Meetings from "./Meetings";

/**
 * A sessão ocupada no gravador de reuniões (PR S). Até o envio, o áudio gravado
 * só existe na memória da aba: gravando, enviando ou com o áudio gravado ainda
 * na tela, a sessão fica ocupada (lib/sessao-ocupada.ts), e o Sair e o fechar
 * da aba perguntam antes. O envio ocupa à parte, sem depender da página: ele
 * segue no ar mesmo que a dona saia da tela, e só libera quando termina. A
 * validação que recusa o envio (título, autorização, formato, tamanho) não
 * ocupa nada.
 *
 * O tRPC é o dublê de Meetings.rotas.test.tsx, com o auth.logout do menu; o
 * cabeçalho é o de verdade, para os dois últimos blocos clicarem no Sair dele.
 */

type Opcoes = {
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (erro: unknown, vars: unknown) => void;
  onSettled?: (data: unknown, erro: unknown, vars: unknown) => void;
};

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn>; mutateAsync: ReturnType<typeof vi.fn> }> = {};
  // A entrada nasce no primeiro uso, pela página ou pelo teste: o teste que
  // prepara o envio antes de desenhar a página não depende de outro ter desenhado.
  const mutacao = (nome: string) => (mutacoes[nome] ??= { opcoes: {}, mutate: vi.fn(), mutateAsync: vi.fn() });
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = mutacao(nome);
      m.opcoes = opcoes;
      return { mutate: m.mutate, mutateAsync: m.mutateAsync, isPending: false };
    },
  });
  return {
    mutacoes,
    mutacao,
    registrar,
    list: vi.fn(),
    get: vi.fn(),
    pendencias: vi.fn(),
    duracao: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, get: { invalidate: vi.fn(), setData: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/duracao-no-navegador", () => ({ lerDuracaoNoNavegador: (arquivo: Blob) => duble.duracao(arquivo) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    auth: { logout: duble.registrar("logout") },
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

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

let originais: { criar: unknown; revogar: unknown; microfone: PropertyDescriptor | undefined };
// Os envios que um teste deixou no ar: terminam no afterEach, para um teste que
// falhe no meio não deixar a sessão ocupada para o seguinte.
const pendentes: Array<() => void> = [];

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  originais = { criar: URL.createObjectURL, revogar: URL.revokeObjectURL, microfone: Object.getOwnPropertyDescriptor(navigator, "mediaDevices") };
  vi.stubGlobal("MediaRecorder", GravadorFalso);
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:gravacao") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  // Todo teste começa com a sessão livre: nenhum envio do anterior ficou no ar.
  expect(sessaoOcupada()).toBe(false);
});

afterEach(async () => {
  // Desmonta antes: no Vitest 2 este afterEach roda antes do cleanup do setup.
  cleanup();
  await act(async () => { for (const terminar of pendentes.splice(0)) terminar(); });
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originais.criar });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originais.revogar });
  if (originais.microfone) Object.defineProperty(navigator, "mediaDevices", originais.microfone);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

function abrirOGravador() {
  window.history.replaceState(null, "", "/gravar");
  return render(<Meetings />);
}

async function gravarEEncerrar() {
  fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
  expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  expect(motivoDaOcupacao()).toBe("gravando");
  fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
  expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
}

/**
 * O envio no ar: o create e o envio do áudio só terminam quando o teste manda
 * (criar e terminar). As duas promessas nascem já aqui, para o afterEach
 * terminar o que um teste deixou no ar mesmo antes do submitRecording.
 */
function envioNoAr() {
  let criar: () => void = () => {};
  const criado = new Promise<{ id: string }>(resolver => { criar = () => resolver({ id: VINICOLA }); });
  let terminar: () => void = () => {};
  const enviado = new Promise<void>(resolver => { terminar = () => resolver(); });
  duble.mutacao("create").mutateAsync.mockImplementation(() => criado);
  duble.mutacao("submitRecording").mutateAsync.mockImplementation(() => enviado);
  pendentes.push(() => { criar(); terminar(); });
  return { criar: () => criar(), terminar: () => terminar() };
}

/** O navegador avisa antes de fechar a aba: devolve se a página pediu a confirmação. */
function fecharAba() {
  const evento = new Event("beforeunload", { cancelable: true });
  // O returnValue do Event comum do jsdom ignora o true que a página grava; o do
  // navegador o guarda, e o Chrome e o Edge antes da 119 só perguntam com ele.
  Object.defineProperty(evento, "returnValue", { value: "", writable: true });
  window.dispatchEvent(evento);
  // A página pede pelas duas formas, ou por nenhuma.
  expect(Boolean(evento.returnValue)).toBe(evento.defaultPrevented);
  return evento.defaultPrevented;
}

describe("Reuniões — o que ocupa a sessão", () => {
  it("gravando ocupa; encerrada, o áudio na tela segue ocupando, e fechar a aba pergunta", async () => {
    abrirOGravador();
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    await gravarEEncerrar();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    expect(fecharAba()).toBe(true);
  });

  it("descartar o áudio gravado libera a sessão, e fechar a aba deixa de perguntar", async () => {
    abrirOGravador();
    await gravarEEncerrar();
    fireEvent.click(screen.getByRole("button", { name: "Descartar e gravar novamente" }));
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
  });

  it("o envio que dá certo: 'enviando' do clique ao fim, e depois a sessão fica livre", async () => {
    abrirOGravador();
    const envio = envioNoAr();
    await gravarEEncerrar();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    // Já no clique, com o create e a leitura do áudio ainda no ar, o envio ocupa.
    expect(duble.mutacao("create").mutateAsync).toHaveBeenCalled();
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => { envio.criar(); });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    // O envio vem antes do áudio por enviar, que continua na memória até o fim.
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => {
      await duble.mutacao("submitRecording").opcoes.onSuccess?.({}, { meetingId: VINICOLA });
      envio.terminar();
    });
    expect(sessaoOcupada()).toBe(false);
  });

  it("o envio que falha: o áudio continua na tela e a sessão, ocupada por ele", async () => {
    abrirOGravador();
    duble.mutacoes.create.mutateAsync.mockResolvedValue({ id: VINICOLA });
    duble.mutacoes.submitRecording.mutateAsync.mockRejectedValue(new Error("A IA não respondeu."));
    await gravarEEncerrar();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
  });

  it("sair da página com o áudio na tela libera: a página desmontada não guarda mais nada", async () => {
    const { unmount } = abrirOGravador();
    await gravarEEncerrar();
    unmount();
    expect(sessaoOcupada()).toBe(false);
  });

  it("sair da página no meio do envio, com o create ainda no ar: o pedido segue e a sessão, ocupada, até ele terminar", async () => {
    const { unmount } = abrirOGravador();
    const envio = envioNoAr();
    await gravarEEncerrar();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
    // A página desmontada solta o áudio por enviar; o envio, avulso, segura a sessão.
    unmount();
    expect(motivoDaOcupacao()).toBe("enviando");
    expect(fecharAba()).toBe(true);
    await act(async () => { envio.criar(); });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => { envio.terminar(); });
    expect(sessaoOcupada()).toBe(false);
  });

  it("o envio de arquivo ocupa do clique ao fim, inclusive quando termina recusado", async () => {
    let entregarDuracao: (segundos: number | null) => void = () => {};
    duble.duracao.mockImplementation(() => new Promise(resolver => { entregarDuracao = resolver; }));
    pendentes.push(() => entregarDuracao(null));
    abrirOGravador();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    expect(motivoDaOcupacao()).toBe("enviando");
    // Sem duração legível, o envio para antes do servidor: a ocupação sai junto.
    await act(async () => { entregarDuracao(null); });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(sessaoOcupada()).toBe(false);
  });

  it("o envio de arquivo que dá certo também libera no fim", async () => {
    duble.duracao.mockResolvedValue(30);
    // Preparado antes de desenhar a página, de propósito: o dublê não depende de
    // um teste anterior (rodado sozinho, este caía num TypeError).
    const envio = envioNoAr();
    envio.criar();
    abrirOGravador();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => { envio.terminar(); });
    expect(sessaoOcupada()).toBe(false);
  });
});

describe("Reuniões — a validação que recusa o envio não ocupa a sessão", () => {
  it("autorização desmarcada depois de gravar: Transcrever recusa, fica só o áudio por enviar, e descartar libera", async () => {
    abrirOGravador();
    await gravarEEncerrar();
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Transcrever áudio/ })); });
    expect(toast.error).toHaveBeenCalledWith("Marque a caixa de autorização antes de enviar o áudio.");
    expect(duble.mutacao("create").mutateAsync).not.toHaveBeenCalled();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    fireEvent.click(screen.getByRole("button", { name: "Descartar e gravar novamente" }));
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
  });

  const audio = () => new File(["som"], "reuniao.mp3", { type: "audio/mpeg" });
  it.each([
    { caso: "sem título", titulo: "", marcar: true, arquivo: audio },
    { caso: "sem a autorização", titulo: "Conversa com a Bia", marcar: false, arquivo: audio },
    { caso: "em formato não aceito", titulo: "Conversa com a Bia", marcar: true, arquivo: () => new File(["x"], "notas.txt", { type: "text/plain" }) },
    { caso: "acima de 10 MB", titulo: "Conversa com a Bia", marcar: true, arquivo: () => new File([new Uint8Array(11 * 1024 * 1024)], "longa.mp3", { type: "audio/mpeg" }) },
  ])("o arquivo $caso é recusado sem ocupar a sessão", async ({ titulo, marcar, arquivo }) => {
    abrirOGravador();
    if (titulo) fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: titulo } });
    if (marcar) fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivo()] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(duble.duracao).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
  });
});

describe("Reuniões — o Sair do cabeçalho com a gravação em andamento", () => {
  async function clicarEmSair() {
    fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
  }

  it("gravando: o Sair pergunta, e 'Continuar aqui' mantém a gravação no ar", async () => {
    abrirOGravador();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();

    await clicarEmSair();
    expect(duble.mutacoes.logout.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Sair agora?" })).toHaveAccessibleDescription(
      "Há uma gravação em andamento nesta aba. Se sair agora, esse áudio se perde.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar aqui" }));
    expect(duble.mutacoes.logout.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(motivoDaOcupacao()).toBe("gravando");

    await clicarEmSair();
    fireEvent.click(screen.getByRole("button", { name: "Sair mesmo assim" }));
    expect(duble.mutacoes.logout.mutate).toHaveBeenCalledTimes(1);
  });

  it("com a sessão livre (nada gravado), o Sair sai direto", async () => {
    abrirOGravador();
    await clicarEmSair();
    expect(duble.mutacoes.logout.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

/**
 * As três rotas de Reuniões são a MESMA instância da página (App.tsx), e o
 * áudio gravado é estado dela: parada a gravação, a dona vai à lista (o
 * "Voltar" do gravador, o item Reuniões do menu) ou a um detalhe com o áudio
 * ainda na memória, e ele reaparece quando ela volta ao gravador. A ocupação
 * vale fora do /gravar também: presa à rota, ou ao componente do gravador, ela
 * sairia na lista, e o Sair e o fechar da aba perderiam o áudio sem perguntar.
 */
describe("Reuniões — fora do gravador, o áudio por enviar segue ocupando a sessão", () => {
  function abrirOMenu() {
    fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
  }

  it("'Voltar' leva à lista com o áudio na memória: a sessão segue ocupada, o Sair pergunta e o áudio volta no gravador", async () => {
    abrirOGravador();
    await gravarEEncerrar();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Voltar" }));
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    expect(fecharAba()).toBe(true);

    abrirOMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
    expect(duble.mutacoes.logout.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Sair agora?" })).toHaveAccessibleDescription(
      "Há um áudio gravado nesta aba que ainda não foi enviado. Se sair agora, esse áudio se perde.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar aqui" }));
    expect(duble.mutacoes.logout.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(window.location.pathname).toBe("/gravar");
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
  });

  it("pelo item Reuniões do menu e no detalhe de uma reunião, a sessão também segue ocupada", async () => {
    duble.list.mockReturnValue({
      data: [{ id: VINICOLA, title: "Vinícola", status: "ready", createdAt: new Date("2026-11-01T10:00:00Z").toISOString() }],
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    abrirOGravador();
    await gravarEEncerrar();
    abrirOMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Reuniões/ }));
    expect(window.location.pathname).toBe("/meetings");
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");

    fireEvent.click(screen.getByRole("button", { name: /Vinícola/ }));
    expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`);
    expect(motivoDaOcupacao()).toBe("audio-nao-enviado");
    expect(fecharAba()).toBe(true);
  });
});
