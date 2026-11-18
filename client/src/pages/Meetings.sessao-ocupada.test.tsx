import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import { RetomadaDosDescartes } from "@/components/RetomadaDosDescartes";
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
      // A gravação em partes (G9; o padrão do /gravar desde a G13b) chama o servidor por aqui.
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: { meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() } } },
    },
    enviarParte: vi.fn(),
    // A cópia no aparelho (G9): o teste da cópia que falta (G13b) a faz falhar,
    // e o do Descartar confere que a da gravação descartada sai.
    guardarParte: vi.fn(),
    apagarPartesDaReuniao: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/envio-das-partes", () => ({
  enviarParte: (...a: unknown[]) => duble.enviarParte(...a),
  enviarPendentes: async () => ({ restantes: 0, semSessao: false }),
  travaDoNavegador: async (_nome: string, trabalho: () => Promise<unknown>) => trabalho(),
}));
vi.mock("@/lib/partes-no-aparelho", () => ({
  guardarParte: (...a: unknown[]) => duble.guardarParte(...a),
  apagarParte: async () => undefined,
  apagarPartesDaReuniao: (...a: unknown[]) => duble.apagarPartesDaReuniao(...a),
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
      // N5: a linha "Conexões geradas por esta reunião" (sem conexões, não aparece).
      conexoes: { useQuery: () => ({ data: undefined }) },
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      traduzirResumo: duble.registrar("traduzirResumo"),
      perguntar: duble.registrar("perguntar"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink"), perguntar: duble.registrar("perguntarPeloLink"), traduzirResumo: duble.registrar("traduzirResumoPeloLink") },
    // O "Tentar de novo" do evento da próxima ação que ficou na Google Agenda (H5c): o resumo guardado o monta.
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
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
  // A cópia no aparelho dá certo, salvo no teste que diz outro.
  duble.guardarParte.mockResolvedValue(undefined);
  duble.apagarPartesDaReuniao.mockResolvedValue(undefined);
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

/**
 * O gravador no envio único de antes (o áudio inteiro num pedido só, com a
 * revisão antes de enviar), que desde a G13b só abre por ?envioUnico=1, a
 * saída de suporte até a G14. Os blocos que gravam, revisam e enviam são dele;
 * a gravação em partes, o padrão, tem os blocos dela no fim deste arquivo.
 */
function abrirOGravador() {
  window.history.replaceState(null, "", "/gravar?envioUnico=1");
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

describe("Reuniões — gravação em partes (G9; o /gravar de sempre desde a G13b)", () => {
  const { iniciarGravacao, encerrarGravacao, delete: excluir } = duble.utils.client.meetings;

  beforeEach(() => {
    iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
    encerrarGravacao.mutate.mockReset().mockResolvedValue({ partes: 1 });
    excluir.mutate.mockReset().mockResolvedValue({ success: true });
    duble.enviarParte.mockReset().mockResolvedValue({ tipo: "recebida" });
  });

  function abrirEmPartes() {
    window.history.replaceState(null, "", "/gravar");
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

  it("com ?envioUnico=1, o envio único de antes: nada de reunião no Iniciar", async () => {
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
  // Os ids dos dois avisos que ficam até ser fechados: a gravação seguinte os
  // fecha por eles, e os testes conferem os mesmos na criação e no dismiss.
  const AVISO_DO_LIMITE = "gravacao-chegou-ao-limite";
  const AVISO_PAROU_SOZINHA = "gravacao-parou-sem-confirmacao";

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

  /** As partes que foram ao servidor, em ordem: [reunião, seq] de cada envio. */
  function partesEnviadas() {
    return duble.enviarParte.mock.calls.map(([meetingId, seq]) => [meetingId, seq]);
  }

  it("na hora cheia o aviso aparece, sem o toast antigo e com o relógio em 1:00:00; Continuar retoma a pausada, e a 2ª hora reabre", async () => {
    await iniciar("/gravar");
    // Sem o teto de 10 min: o texto sob o relógio fala do aviso e das 12 h.
    expect(screen.getByText("A cada hora de gravação, confirme que ela continua. Limite: 12 horas.")).toBeInTheDocument();
    await passar(UMA_HORA_MS);
    // O nome do aviso traz o pedido de confirmação e as horas; aqui, as horas.
    const aviso = screen.getByRole("alertdialog", { name: /1 h de gravação/ });
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
    expect(screen.getByRole("alertdialog", { name: /2 h de gravação/ })).toBeInTheDocument();
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

  it("com o aviso aberto, o Encerrar da dona fecha o aviso e entrega uma vez só; o prazo que vence depois não para nem avisa", async () => {
    await iniciar("/gravar");
    await passar(UMA_HORA_MS);
    expect(screen.getByRole("alertdialog", { name: /1 h de gravação/ })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Os dublês do envio respondem na hora: a entrega termina sem o relógio andar.
    await act(async () => { await new Promise(resolver => setTimeout(resolver, 0)); });
    expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 2 });
    // Vence o prazo do aviso que estava aberto: nada para de novo, nada avisa.
    vi.setSystemTime(Date.now() + PRAZO_DO_AVISO_DE_HORA_MS);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    vi.useRealTimers();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(partesEnviadas()).toEqual([[VINICOLA, 0], [VINICOLA, 1]]);
    expect(encerrarGravacao.mutate).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toContain(VINICOLA);
  });

  it("sem o OK em 10 min (o tique atrasado da aba oculta), para sozinha, entrega pelo caminho do Encerrar uma vez só e avisa até ser fechado", async () => {
    await iniciar("/gravar");
    await passar(UMA_HORA_MS);
    expect(screen.getByRole("alertdialog", { name: /1 h de gravação/ })).toBeInTheDocument();
    vi.setSystemTime(Date.now() + PRAZO_DO_AVISO_DE_HORA_MS);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    // objectContaining: o botão de fechar desse aviso é conferido no teste dele.
    expect(toast.info).toHaveBeenCalledWith(PAROU_SOZINHA, expect.objectContaining({ id: AVISO_PAROU_SOZINHA, duration: Infinity }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    // A hora pulada de uma vez fecha a parte 0 no primeiro tique, e o tique dos
    // 10 min seguintes fecha a 1; a 2 é a que o fim automático entrega.
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(partesEnviadas()).toEqual([[VINICOLA, 0], [VINICOLA, 1], [VINICOLA, 2]]);
    await waitFor(() => expect(window.location.pathname).toContain(VINICOLA));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(encerrarGravacao.mutate).toHaveBeenCalledTimes(1);
  });

  it("pausada com o aviso na tela, o prazo vence do mesmo jeito e a gravação é entregue: pausar não vale como o OK", async () => {
    await iniciar("/gravar");
    await passar(UMA_HORA_MS);
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(screen.getByRole("status")).toHaveTextContent("Gravação pausada");
    expect(screen.getByRole("alertdialog", { name: /1 h de gravação/ })).toBeInTheDocument();
    vi.setSystemTime(Date.now() + PRAZO_DO_AVISO_DE_HORA_MS);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(toast.info).toHaveBeenCalledWith(PAROU_SOZINHA, expect.objectContaining({ id: AVISO_PAROU_SOZINHA, duration: Infinity }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    // A parte 0 fechou na hora cheia; a 1, pausada, é a que o fim automático entrega.
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 2 }));
    expect(partesEnviadas()).toEqual([[VINICOLA, 0], [VINICOLA, 1]]);
    await waitFor(() => expect(window.location.pathname).toContain(VINICOLA));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(encerrarGravacao.mutate).toHaveBeenCalledTimes(1);
  });

  it("nas 12 h, a gravação em partes para e entrega uma vez só, com um aviso que fica até ser fechado pelo botão", async () => {
    await iniciar("/gravar");
    await passar(12 * UMA_HORA_MS);
    expect(toast.info).toHaveBeenCalledWith("A gravação chegou ao limite de 12 horas e foi encerrada. O que foi gravado segue para a transcrição.", { id: AVISO_DO_LIMITE, duration: Infinity, closeButton: true });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    // As 12 h puladas de uma vez ficam na parte 0: o teto é conferido antes da troca de parte.
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(partesEnviadas()).toEqual([[VINICOLA, 0]]);
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(encerrarGravacao.mutate).toHaveBeenCalledTimes(1);
  });

  it("a gravação nova tira da tela os avisos que ficam até ser fechados (os das 12 h, da hora sem OK, do descarte que não terminou e da gravação encerrada ao sair); o Iniciar recusado, não", async () => {
    window.history.replaceState(null, "", "/gravar");
    render(<Meetings />);
    // Sem título nada começa: os avisos da gravação anterior seguem na tela.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(toast.error).toHaveBeenCalledWith("Dê um título para a reunião.");
    expect(toast.dismiss).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(toast.dismiss).toHaveBeenCalledWith(AVISO_DO_LIMITE);
    expect(toast.dismiss).toHaveBeenCalledWith(AVISO_PAROU_SOZINHA);
    // Revisão da G13b: o do descarte que não terminou e o da gravação encerrada ao sair também.
    expect(toast.dismiss).toHaveBeenCalledWith("gravacao-descarte-pendente");
    expect(toast.dismiss).toHaveBeenCalledWith("gravacao-encerrada-ao-sair");
  });

  it("no envio único nada muda: para nos 10 min, com a revisão do áudio, sem aviso de hora", async () => {
    await iniciar("/gravar?envioUnico=1");
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

/**
 * G13b: a gravação em partes vira o padrão para todas. O /gravar grava em
 * partes, o ?emPartes=1 da G9 continua aceito e ?envioUnico=1 é a saída de
 * suporte até a G14. Os avisos que eram silenciosos passam a aparecer (a parte
 * recusada, a cópia no aparelho que faltou), o Descartar apaga a gravação em
 * curso depois da confirmação na página, e o duplo clique no Iniciar cria uma
 * reunião só.
 */
describe("Reuniões — a gravação em partes é o padrão para todas (G13b)", () => {
  const { iniciarGravacao, encerrarGravacao, delete: excluir } = duble.utils.client.meetings;
  const DESCARTES = "wrw:descartes-de-gravacao-pendentes";
  const FINS = "wrw:fins-de-gravacao-pendentes";
  const DESCARTADA = "Gravação descartada. Nada dela vai para a transcrição.";
  const DESCARTE_PENDENTE = "Não foi possível apagar a gravação agora. O app tenta de novo sozinho enquanto estiver aberto; se a reunião aparecer na lista, exclua-a por lá.";
  const AVISO_DO_DESCARTE_PENDENTE = "gravacao-descarte-pendente";

  beforeEach(() => {
    iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
    encerrarGravacao.mutate.mockReset().mockResolvedValue({ partes: 1 });
    excluir.mutate.mockReset().mockResolvedValue({ success: true });
    duble.enviarParte.mockReset().mockResolvedValue({ tipo: "recebida" });
    localStorage.removeItem(DESCARTES);
    localStorage.removeItem(FINS);
  });
  afterEach(() => {
    localStorage.removeItem(DESCARTES);
    localStorage.removeItem(FINS);
  });

  function preencher() {
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
  }

  async function iniciarEm(caminho: string) {
    window.history.replaceState(null, "", caminho);
    render(<Meetings />);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  }

  async function descartarPelaConfirmacao() {
    fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Descartar gravação" })); });
  }

  it.each(["/gravar", "/gravar?emPartes=1"])("%s grava em partes: sob o relógio, o aviso de hora e as 12 h, e o arquivo com os 10 min dele; a reunião nasce no Iniciar", async caminho => {
    window.history.replaceState(null, "", caminho);
    render(<Meetings />);
    expect(screen.getByText("A cada hora de gravação, confirme que ela continua. Limite: 12 horas.")).toBeInTheDocument();
    expect(screen.queryByText("Limite por gravação: 10 minutos ou 10 MB")).not.toBeInTheDocument();
    // O arquivo enviado segue no envio único até a H9a: a dica diz o teto dele.
    expect(screen.getByText("Arquivo de áudio: até 10 minutos ou 10 MB")).toBeInTheDocument();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("o padrão grava em partes, e ?envioUnico=1 volta ao envio único de antes, sem reunião no Iniciar nem Descartar no meio", async () => {
    window.history.replaceState(null, "", "/gravar");
    const padrao = render(<Meetings />);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Descartar gravação" })).toBeInTheDocument();
    // Sair da tela gravando em partes entrega o que foi gravado (revisão da G13b).
    padrao.unmount();
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    iniciarGravacao.mutate.mockClear();
    duble.enviarParte.mockClear();

    window.history.replaceState(null, "", "/gravar?envioUnico=1");
    render(<Meetings />);
    expect(screen.getByText("Limite por gravação: 10 minutos ou 10 MB")).toBeInTheDocument();
    expect(screen.queryByText("Arquivo de áudio: até 10 minutos ou 10 MB")).not.toBeInTheDocument();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Descartar gravação" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    expect(await screen.findByRole("button", { name: /Transcrever áudio/ })).toBeInTheDocument();
    expect(iniciarGravacao.mutate).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Descartar e gravar novamente/ }));
  });

  it("duplo clique no Iniciar: uma reunião só, o botão travado enquanto o servidor cria, e a gravação mantém as partes", async () => {
    let criar: (reuniao: { id: string }) => void = () => {};
    iniciarGravacao.mutate.mockImplementation(() => new Promise(resolver => { criar = resolver; }));
    window.history.replaceState(null, "", "/gravar");
    render(<Meetings />);
    preencher();
    const iniciar = screen.getByRole("button", { name: /Iniciar gravação/ });
    fireEvent.click(iniciar);
    fireEvent.click(iniciar);
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    // Enquanto o servidor cria a reunião, o botão e o formulário ficam travados.
    await waitFor(() => expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeDisabled());
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    await act(async () => { criar({ id: VINICOLA }); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    // Nenhuma reunião apagada, nenhuma parte perdida "sem reunião".
    expect(excluir.mutate).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("a parte recusada pelo servidor avisa no idioma da tela, até ser fechada, e nunca com o código cru", async () => {
    duble.enviarParte.mockResolvedValue({ tipo: "recusada", codigo: "LONGA_DEMAIS" });
    await iniciarEm("/gravar");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Um trecho da gravação passou do tamanho ou do tempo que o servidor aceita e ficou de fora da transcrição.",
      { id: "gravacao-parte-recusada", duration: Infinity, closeButton: true },
    ));
    expect(vi.mocked(toast.error).mock.calls.some(([texto]) => String(texto).includes("LONGA_DEMAIS"))).toBe(false);
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("sem a cópia no aparelho, avisa uma vez só na gravação, até ser fechado, e as partes seguem subindo", async () => {
    duble.guardarParte.mockRejectedValue(new Error("Sem IndexedDB neste navegador."));
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await iniciarEm("/gravar");
      // Duas trocas de parte (10 min cada) e o Encerrar: três partes sem cópia.
      for (let i = 0; i < 2; i++) {
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await act(async () => { vi.advanceTimersByTime(500); });
      }
    } finally {
      vi.useRealTimers();
    }
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(duble.enviarParte).toHaveBeenCalledTimes(3);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Não foi possível guardar uma cópia da gravação neste aparelho. Ela continua sendo enviada, mas, se a internet cair, um trecho pode se perder.",
      { id: "gravacao-sem-copia-no-aparelho", duration: Infinity, closeButton: true },
    );
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("Descartar pede a confirmação na própria página; 'Voltar à gravação' segue gravando, e confirmar apaga a reunião e a cópia, sem nada para a transcrição", async () => {
    const confirmarDoNavegador = vi.spyOn(window, "confirm");
    try {
      await iniciarEm("/gravar");
      fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
      const confirmacao = screen.getByRole("alertdialog", { name: "Descartar esta gravação?" });
      expect(confirmacao).toHaveAccessibleDescription("Tudo o que foi gravado até agora será apagado, inclusive o que já foi enviado, e nada vai para a transcrição. Não dá para desfazer.");
      // O foco começa no botão que não perde o áudio.
      await waitFor(() => expect(within(confirmacao).getByRole("button", { name: "Voltar à gravação" })).toHaveFocus());
      fireEvent.click(within(confirmacao).getByRole("button", { name: "Voltar à gravação" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      // O foco volta ao Descartar, que continua na tela com a gravação.
      await waitFor(() => expect(screen.getByRole("button", { name: "Descartar gravação" })).toHaveFocus());
      expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
      expect(motivoDaOcupacao()).toBe("gravando");
      // O Esc também fecha sem descartar.
      fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
      fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
      expect(excluir.mutate).not.toHaveBeenCalled();

      vi.mocked(toast.dismiss).mockClear();
      await descartarPelaConfirmacao();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(DESCARTADA));
      // Um aviso de descarte que não terminou, ainda na tela, contradiria este: sai.
      expect(toast.dismiss).toHaveBeenCalledWith(AVISO_DO_DESCARTE_PENDENTE);
      // O caminho de exclusão de sempre (a reunião, as partes que subiram e os
      // objetos delas) e a cópia no aparelho.
      expect(excluir.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA });
      expect(duble.apagarPartesDaReuniao).toHaveBeenCalledWith(VINICOLA);
      // Nada vai para a transcrição: a última parte não saiu do gravador e nenhum fim foi declarado.
      expect(duble.enviarParte).not.toHaveBeenCalled();
      expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
      expect(confirmarDoNavegador).not.toHaveBeenCalled();
      expect(localStorage.getItem(DESCARTES)).toBeNull();
      // O gravador volta ao começo: o título fica, para gravar de novo, e a
      // autorização volta desmarcada, como no Encerrar (revisão da G13b).
      expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toHaveValue("Conversa com a Bia");
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      await waitFor(() => expect(sessaoOcupada()).toBe(false));
    } finally {
      confirmarDoNavegador.mockRestore();
    }
  });

  it("a confirmação do Descartar prende o foco, deixa o fundo inerte e fecha com o Esc mesmo com o foco fora dela (revisão da G13b)", async () => {
    await iniciarEm("/gravar");
    fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
    const confirmacao = screen.getByRole("alertdialog", { name: "Descartar esta gravação?" });
    const voltar = within(confirmacao).getByRole("button", { name: "Voltar à gravação" });
    const descartar = within(confirmacao).getByRole("button", { name: "Descartar gravação" });
    await waitFor(() => expect(voltar).toHaveFocus());
    // O fundo fica inerte: fora da árvore de acessibilidade e sem clique.
    expect(screen.queryByRole("button", { name: /Encerrar gravação/ })).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe("none");
    // O Tab no último botão volta ao primeiro, e o Shift+Tab no primeiro vai ao
    // último: o foco não sai da confirmação.
    act(() => descartar.focus());
    fireEvent.keyDown(descartar, { key: "Tab" });
    expect(voltar).toHaveFocus();
    fireEvent.keyDown(voltar, { key: "Tab", shiftKey: true });
    expect(descartar).toHaveFocus();
    // O Esc fecha de qualquer lugar da página, sem descartar.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(excluir.mutate).not.toHaveBeenCalled();
  });

  it("o descarte que não conseguiu apagar agora avisa até ser fechado e fica guardado, com a conta, para a retomada", async () => {
    excluir.mutate.mockRejectedValue(new Error("rede"));
    await iniciarEm("/gravar");
    await descartarPelaConfirmacao();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(DESCARTE_PENDENTE, { id: AVISO_DO_DESCARTE_PENDENTE, duration: Infinity, closeButton: true }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(DESCARTES)!)).toEqual([{ id: VINICOLA, dona: "dona-1" }]);
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    // A autorização volta desmarcada também aqui: a gravação acabou.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("o descarte que não terminou ocupa a sessão em toda tela logada: o fechar da aba e o Sair perguntam (revisão da G13b)", async () => {
    excluir.mutate.mockRejectedValue(new Error("rede"));
    window.history.replaceState(null, "", "/gravar");
    // Como no App: a retomada de toda a sessão ao lado da página.
    render(<><RetomadaDosDescartes /><Meetings /></>);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    await descartarPelaConfirmacao();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(DESCARTE_PENDENTE, expect.anything()));
    expect(motivoDaOcupacao()).toBe("descarte-pendente");
    expect(fecharAba()).toBe(true);
    // O Sair do cabeçalho pergunta, com o texto do descarte que não terminou.
    fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
    expect(duble.mutacoes.logout?.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Sair agora?" })).toHaveAccessibleDescription(
      "A gravação descartada ainda não foi apagada. Se sair agora, ela pode seguir para a transcrição.",
    );
  });

  it("o aviso do descarte que não terminou fecha quando a retomada termina a exclusão (revisão da G13b)", async () => {
    excluir.mutate.mockRejectedValueOnce(new Error("rede")).mockResolvedValue({ success: true });
    window.history.replaceState(null, "", "/gravar");
    const primeira = render(<Meetings />);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    await descartarPelaConfirmacao();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(DESCARTE_PENDENTE, expect.anything()));
    vi.mocked(toast.dismiss).mockClear();
    primeira.unmount();
    // A dona volta à tela: a retomada dela repete a exclusão, que dá certo.
    window.history.replaceState(null, "", "/meetings");
    render(<Meetings />);
    await waitFor(() => expect(localStorage.getItem(DESCARTES)).toBeNull());
    expect(excluir.mutate).toHaveBeenLastCalledWith({ meetingId: VINICOLA });
    expect(toast.dismiss).toHaveBeenCalledWith(AVISO_DO_DESCARTE_PENDENTE);
  });

  it("a confirmação aberta quando a gravação termina (o limite, o aviso de hora sem OK) não volta na gravação seguinte, nem deixa o fundo travado", async () => {
    // O fim que falha deixa a dona no gravador, para gravar de novo.
    encerrarGravacao.mutate.mockRejectedValue(new Error("rede"));
    iniciarGravacao.mutate.mockResolvedValueOnce({ id: VINICOLA }).mockResolvedValueOnce({ id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" });
    await iniciarEm("/gravar");
    fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
    expect(screen.getByRole("alertdialog", { name: "Descartar esta gravação?" })).toBeInTheDocument();
    // A gravação termina com a confirmação aberta. O Encerrar, sob o fundo inerte
    // (hidden), faz as vezes do fim que vem sozinho: o limite, o aviso de hora.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/, hidden: true })); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível enviar a gravação."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(excluir.mutate).not.toHaveBeenCalled();
    // A segunda gravação também termina aqui, e não no desmonte do fim do teste.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });
});
