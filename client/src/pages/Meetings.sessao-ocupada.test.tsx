import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
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
    resumoGuardado: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      // A gravação em partes (G9, /gravar?emPartes=1) chama o servidor por aqui.
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: { meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() } } },
    },
    enviarParte: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/envio-das-partes", () => ({
  enviarParte: (...a: unknown[]) => duble.enviarParte(...a),
  enviarPendentes: async () => ({ restantes: 0, semSessao: false }),
  travaDoNavegador: async (_nome: string, trabalho: () => Promise<unknown>) => trabalho(),
}));
vi.mock("@/lib/partes-no-aparelho", () => ({
  guardarParte: async () => undefined,
  apagarParte: async () => undefined,
  apagarTodasAsPartes: async () => undefined,
}));
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
      resumoGuardado: { useQuery: (...args: unknown[]) => duble.resumoGuardado(...args) },
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      perguntar: duble.registrar("perguntar"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink"), perguntar: duble.registrar("perguntarPeloLink") },
    networkInteligente: {
      pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) },
    },
  },
}));

const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

class GravadorFalso {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((evento: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
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
  // O resumo guardado da reunião (H4c): sem resumo, salvo o teste que diz outro.
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
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
    // A gravação ao vivo leva o idioma escolhido (o da tela, por padrão) e a
    // versão do aviso de gravação, como o envio de arquivo (G1b e G4).
    expect(duble.mutacao("create").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO }));
    expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ language: "pt-BR" }));
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

describe("Reuniões — gravação em partes (G9, /gravar?emPartes=1)", () => {
  const { iniciarGravacao, encerrarGravacao, delete: excluir } = duble.utils.client.meetings;

  beforeEach(() => {
    iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
    encerrarGravacao.mutate.mockReset().mockResolvedValue({ partes: 1 });
    excluir.mutate.mockReset().mockResolvedValue({ success: true });
    duble.enviarParte.mockReset().mockResolvedValue({ tipo: "recebida" });
  });

  function abrirEmPartes() {
    window.history.replaceState(null, "", "/gravar?emPartes=1");
    return render(<Meetings />);
  }

  function preencher() {
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
  }

  it("a reunião nasce no Iniciar, a parte vai ao servidor no Encerrar, e a tela abre a reunião sem o Transcrever", async () => {
    abrirEmPartes();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({
      title: "Conversa com a Bia", consentGranted: true, origem: "gravacao", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO,
    }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    await waitFor(() => expect(window.location.pathname).toContain(VINICOLA));
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("o microfone negado depois de a reunião nascer: a reunião vazia é excluída", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("negado", "NotAllowedError"); } },
    });
    abrirEmPartes();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(excluir.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
  });

  it("sem ?emPartes=1, o gravador de sempre: nada de reunião no Iniciar", async () => {
    abrirOGravador();
    await gravarEEncerrar();
    expect(iniciarGravacao.mutate).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
  });
});

describe("Reuniões — gravação longa no celular (G10)", () => {
  it("Pausar e Continuar gravando; pausada, a sessão segue ocupada e o Encerrar continua lá", async () => {
    abrirOGravador();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    expect(screen.getByRole("status")).toHaveTextContent("Gravação pausada");
    expect(motivoDaOcupacao()).toBe("gravando");
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
  });

  async function iniciar() {
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
  }
  // Com a tela acesa garantida (Wake Lock aceito): só o aparelho decide o aviso.
  function comTelaAcesa() {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ released: false, release: async () => {} }) } });
  }
  afterEach(() => { delete (navigator as { wakeLock?: unknown }).wakeLock; });

  it("no computador com a tela acesa garantida, nenhum aviso", async () => {
    comTelaAcesa();
    abrirOGravador();
    await iniciar();
    await screen.findByRole("button", { name: "Pausar" });
    await act(async () => {});
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("sem a tela acesa (navegador sem Wake Lock ou que recusou), avisa", async () => {
    abrirOGravador();
    await iniciar();
    expect(await screen.findByRole("note")).toHaveTextContent(/Mantenha esta tela aberta/);
  });

  it("navegador sem pause(): o Pausar não aparece", async () => {
    const pausar = GravadorFalso.prototype.pause;
    (GravadorFalso.prototype as { pause?: unknown }).pause = undefined;
    try {
      abrirOGravador();
      await iniciar();
      expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
    } finally {
      GravadorFalso.prototype.pause = pausar;
    }
  });

  it("no iPhone, avisa para manter a tela aberta mesmo com a tela acesa garantida", async () => {
    comTelaAcesa();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    abrirOGravador();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("note")).toHaveTextContent(/Mantenha esta tela aberta/);
  });
});

describe("Reuniões — o aviso de hora e o teto de 12 h da gravação em partes (G13a)", () => {
  const { iniciarGravacao, encerrarGravacao, delete: excluir } = duble.utils.client.meetings;
  const UMA_HORA_MS = 3_600_000;
  const PAROU_SOZINHA = "A gravação parou sozinha: ninguém confirmou o aviso de hora em 10 minutos. O que foi gravado segue para a transcrição.";

  beforeEach(() => {
    iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
    encerrarGravacao.mutate.mockReset().mockResolvedValue({ partes: 1 });
    excluir.mutate.mockReset().mockResolvedValue({ success: true });
    duble.enviarParte.mockReset().mockResolvedValue({ tipo: "recebida" });
    // O relógio do gravador (a cada 500 ms) e o do prazo do aviso são falsos:
    // as horas passam sem esperar. O setTimeout fica real, para o waitFor.
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function iniciar(caminho: string) {
    window.history.replaceState(null, "", caminho);
    render(<Meetings />);
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  }

  /** O relógio de parede anda `ms` de uma vez, e o gravador dá o tique seguinte (500 ms). */
  async function passar(ms: number) {
    vi.setSystemTime(Date.now() + ms);
    await act(async () => { vi.advanceTimersByTime(500); });
  }

  it("na hora cheia o aviso aparece, sem o toast antigo e com o relógio em 1:00:00; Continuar retoma a pausada, e a 2ª hora reabre", async () => {
    await iniciar("/gravar?emPartes=1");
    // Sem o teto de 10 min: o texto sob o relógio fala do aviso e das 12 h.
    expect(screen.getByText("A cada hora de gravação, confirme que ela continua. Limite: 12 horas.")).toBeInTheDocument();
    await passar(UMA_HORA_MS);
    const aviso = screen.getByRole("alertdialog", { name: "1 h de gravação" });
    expect(screen.getByText("1:00:00")).toBeInTheDocument();
    expect(toast.info).not.toHaveBeenCalled();
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    // Pausada com o aviso na tela: o Continuar do aviso fecha e retoma.
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(screen.getByRole("status")).toHaveTextContent("Gravação pausada");
    fireEvent.click(within(aviso).getByRole("button", { name: "Continuar gravando" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
    await passar(UMA_HORA_MS);
    expect(screen.getByRole("alertdialog", { name: "2 h de gravação" })).toBeInTheDocument();
    // Os dois tiques de 500 ms somam um segundo além das 2 h.
    expect(screen.getByText("2:00:01")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Continuar gravando" }));
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    // A dona encerra: as partes vão e a sessão fica livre.
    vi.useRealTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(toast.info).not.toHaveBeenCalled();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("sem o OK em 10 min (o tique atrasado da aba oculta), para sozinha, entrega pelo caminho do Encerrar e avisa até ser fechado", async () => {
    await iniciar("/gravar?emPartes=1");
    await passar(UMA_HORA_MS);
    expect(screen.getByRole("alertdialog", { name: "1 h de gravação" })).toBeInTheDocument();
    vi.setSystemTime(Date.now() + PRAZO_DO_AVISO_DE_HORA_MS);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(toast.info).toHaveBeenCalledWith(PAROU_SOZINHA, { id: "gravacao-parou-sem-confirmacao", duration: Infinity });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({ meetingId: VINICOLA })));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    await waitFor(() => expect(window.location.pathname).toContain(VINICOLA));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("nas 12 h, a gravação em partes para e entrega, com um aviso que fica até ser fechado", async () => {
    await iniciar("/gravar?emPartes=1");
    await passar(12 * UMA_HORA_MS);
    expect(toast.info).toHaveBeenCalledWith("A gravação chegou ao limite de 12 horas e foi encerrada. O que foi gravado segue para a transcrição.", { id: "gravacao-chegou-ao-limite", duration: Infinity });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("no envio único nada muda: para nos 10 min, com a revisão do áudio, sem aviso de hora", async () => {
    await iniciar("/gravar");
    expect(screen.getByText("Limite por gravação: 10 minutos ou 10 MB")).toBeInTheDocument();
    await passar(10 * 60_000);
    expect(screen.getByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    expect(screen.getByText("Duração: 10:00")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(iniciarGravacao.mutate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Descartar e gravar novamente/ }));
    expect(sessaoOcupada()).toBe(false);
  });
});
