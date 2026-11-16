import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import Meetings from "./Meetings";

/**
 * O "Gravar agora" da agenda (H16a) no gravador: /gravar?agendada=<id> lê a
 * reunião marcada, preenche o título (sem trocar o que a dona escreveu) e liga
 * à reunião marcada a gravação que nascer, nos três caminhos: o arquivo
 * enviado, a gravação de envio único (no Transcrever) e a gravação em partes
 * (no Iniciar). A agenda nunca trava a gravação: sem a reunião, ou com a
 * ligação recusada, a gravação segue e a dona é avisada.
 *
 * O tRPC é o dublê de Meetings.sessao-ocupada.test.tsx, com a agenda.
 */

type Opcoes = {
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (erro: unknown, vars: unknown) => void;
  onSettled?: (data: unknown, erro: unknown, vars: unknown) => void;
};

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn>; mutateAsync: ReturnType<typeof vi.fn> }> = {};
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
    obterDaAgenda: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      agenda: { listar: { invalidate: vi.fn(async () => undefined) } },
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: {
        meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() } },
        agenda: { ligarGravacao: { mutate: vi.fn() } },
      },
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
    networkInteligente: { pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) } },
    agenda: { obter: { useQuery: (...args: unknown[]) => duble.obterDaAgenda(...args) } },
  },
}));

const AGENDADA = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const DA_AGENDA = {
  id: AGENDADA, titulo: "Conversa com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17, 0), duracaoMinutos: 60, fuso: "America/Sao_Paulo",
  local: null, participantes: [], lembreteMinutos: 15, createdAt: 1, updatedAt: 2, gravacao: null,
};
const PLACEHOLDER_DO_TITULO = "Ex.: Conversa com investidor";
const AVISO_DA_LIGACAO = "A gravação segue, mas não ficou ligada à reunião da agenda.";

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
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

let originais: { criar: unknown; revogar: unknown; microfone: PropertyDescriptor | undefined };
const ligar = () => duble.utils.client.agenda.ligarGravacao.mutate;

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.obterDaAgenda.mockReturnValue({ data: DA_AGENDA, isLoading: false, isError: false, error: null });
  duble.duracao.mockResolvedValue(30);
  duble.mutacao("create").mutateAsync.mockResolvedValue({ id: VINICOLA });
  duble.mutacao("submitRecording").mutateAsync.mockResolvedValue({ success: true });
  ligar().mockReset().mockResolvedValue({ ok: true });
  duble.utils.client.meetings.iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
  duble.utils.client.meetings.encerrarGravacao.mutate.mockReset().mockResolvedValue({ partes: 1 });
  duble.utils.client.meetings.delete.mutate.mockReset().mockResolvedValue({ success: true });
  duble.enviarParte.mockReset().mockResolvedValue({ tipo: "recebida" });
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originais.criar });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originais.revogar });
  if (originais.microfone) Object.defineProperty(navigator, "mediaDevices", originais.microfone);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

function abrir(caminho: string) {
  window.history.replaceState(null, "", caminho);
  return render(<Meetings />);
}

function enviarArquivo() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.mp3", { type: "audio/mpeg" })] } });
}

describe("Gravar agora: o gravador com a reunião da agenda", () => {
  it("o título vem da reunião marcada, e o gravador diz de qual se trata", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    expect(duble.obterDaAgenda).toHaveBeenCalledWith({ id: AGENDADA }, expect.any(Object));
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    expect(screen.getByRole("note")).toHaveTextContent("Da sua agenda:");
  });

  it("o título que a dona já escreveu não é trocado quando a reunião chega", async () => {
    duble.obterDaAgenda.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    const { rerender } = abrir(`/gravar?agendada=${AGENDADA}`);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Minha reunião" } });
    duble.obterDaAgenda.mockReturnValue({ data: DA_AGENDA, isLoading: false, isError: false, error: null });
    rerender(<Meetings />);
    await waitFor(() => expect(screen.getByRole("note")).toHaveTextContent("Da sua agenda:"));
    expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Minha reunião");
  });

  it("arquivo enviado: a reunião criada é ligada à reunião marcada, e a agenda se relê", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    enviarArquivo();
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    await waitFor(() => expect(duble.utils.agenda.listar.invalidate).toHaveBeenCalled());
    expect(duble.mutacao("create").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia" }));
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
  });

  it("gravação de envio único: liga no Transcrever, quando a reunião nasce", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ }));
    expect(ligar()).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Transcrever áudio/ })); });
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
  });

  it("gravação em partes: liga no Iniciar, com a reunião que nasce ali", async () => {
    abrir(`/gravar?emPartes=1&agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    expect(duble.utils.client.meetings.iniciarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia" }));
  });

  it("gravação em partes com o microfone negado: a reunião vazia sai e nada é ligado", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("negado", "NotAllowedError"); } },
    });
    abrir(`/gravar?emPartes=1&agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(duble.utils.client.meetings.delete.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    expect(ligar()).not.toHaveBeenCalled();
  });

  it("a ligação recusada não trava a gravação: o envio segue e a dona é avisada", async () => {
    ligar().mockRejectedValue(Object.assign(new Error("Gravação não encontrada."), { data: { code: "NOT_FOUND" } }));
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    enviarArquivo();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AVISO_DA_LIGACAO));
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
  });
});

describe("sem a reunião da agenda, o gravador de sempre", () => {
  it("sem ?agendada: nada de agenda, nem leitura nem ligação", async () => {
    abrir("/gravar");
    expect(duble.obterDaAgenda).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Conversa avulsa" } });
    enviarArquivo();
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(ligar()).not.toHaveBeenCalled();
  });

  it("?agendada fora do formato é ignorado, sem consulta", () => {
    abrir("/gravar?agendada=nao-e-uuid");
    expect(duble.obterDaAgenda).not.toHaveBeenCalled();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("reunião que não está mais na agenda: o aviso, o título vazio, e a gravação sem ligação", async () => {
    duble.obterDaAgenda.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "Reunião agendada não encontrada.", data: { code: "NOT_FOUND" } } });
    abrir(`/gravar?agendada=${AGENDADA}`);
    expect(screen.getByRole("note")).toHaveTextContent("Esta reunião não está mais na sua agenda. A gravação segue sem ligação.");
    expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("");
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Conversa avulsa" } });
    enviarArquivo();
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(ligar()).not.toHaveBeenCalled();
  });

  it("a leitura que falha por outro motivo também avisa, sem travar", () => {
    duble.obterDaAgenda.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } } });
    abrir(`/gravar?agendada=${AGENDADA}`);
    expect(screen.getByRole("note")).toHaveTextContent("Não deu para ler a reunião da agenda. A gravação segue sem ligação.");
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeEnabled();
  });
});
