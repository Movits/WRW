import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Switch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { _reiniciarParaTestes } from "@/hooks/useImportacaoEmPartes";
import Agenda from "./Agenda";
import Meetings from "./Meetings";

/**
 * O "Gravar agora" da agenda (H16a) no gravador: /gravar?agendada=<id> lê a
 * reunião marcada, preenche o título (sem trocar o que a dona escreveu) e liga
 * à reunião marcada a gravação que nascer: a gravação em partes, no Iniciar, e
 * o arquivo. O arquivo em partes está em Meetings.importacao.test.tsx; aqui fica
 * o do recuo do corte, o único que ainda vai pelo envio único depois da G14 (o
 * arquivo curto de um formato que o corte reconhece mas não lê). A gravação do
 * envio único (no Transcrever) saiu com o ?envioUnico=1, na G14. A agenda nunca
 * trava a gravação: sem a reunião, ou com a ligação recusada, a gravação segue
 * e a dona é avisada. E, com a agenda e o gravador montados como no App, o
 * voltar do navegador no meio da gravação não descarta o áudio.
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
    listarDaAgenda: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      agenda: { listar: { invalidate: vi.fn(async () => undefined) } },
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: {
        meetings: { iniciarGravacao: { mutate: vi.fn() }, definirPedidoDoResumo: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() }, // G15a: a transcrição durante a gravação, sem nenhuma parte pronta (função comum: o mockReset do projeto client zeraria um vi.fn).
        transcricaoDaGravacao: { query: async () => ({ status: "recording", emPartes: true, agora: Date.now(), partes: [], falas: [], nomes: {} }) } },
        agenda: { ligarGravacao: { mutate: vi.fn() } },
      },
    },
    enviarParte: vi.fn(),
  };
});

// warning e dismiss: a gravação em partes, o padrão desde a G13b, fecha no Iniciar os avisos da gravação anterior.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
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
  apagarPartesDaReuniao: async () => undefined,
  apagarTodasAsPartes: async () => undefined,
}));
vi.mock("@/lib/duracao-no-navegador", () => ({ lerDuracaoNoNavegador: (arquivo: Blob) => duble.duracao(arquivo) }));
// O corte do arquivo (H9b): reconhece o M4A e não lê o ALAC do Gravador do
// iPhone, e o arquivo curto vai pelo recuo do corte, o envio único que a G14
// manteve. Função comum: o mockReset do projeto client zeraria um vi.fn.
vi.mock("@/lib/corte-do-arquivo-no-worker", () => ({ cortarArquivoNoWorker: async () => ({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    auth: { logout: duble.registrar("logout") },
    meetings: {
      // H4e: os modelos da dona (vazio) e a pergunta do tamanho.
      modelosDeResumo: { useQuery: () => ({ data: undefined, isError: false, error: null }) },
      responderTamanhoDoResumo: { useMutation: () => ({ mutate: () => undefined, isPending: false, isError: false, error: null }) },
      list: { useQuery: (...args: unknown[]) => duble.list(...args) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      create: duble.registrar("create"),
      submitRecording: duble.registrar("submitRecording"),
      decideEntity: duble.registrar("decideEntity"),
      decideContactSuggestion: duble.registrar("decideContactSuggestion"),
      translateTranscript: duble.registrar("translateTranscript"),
      delete: duble.registrar("delete"),
      // As pastas e a lixeira (H7d): a lista lê as pastas, e o "Excluir" do detalhe manda para a lixeira.
      pastas: { useQuery: () => ({ data: [], isLoading: false, isSuccess: true, isError: false, error: null, refetch: () => undefined }) },
      mandarParaALixeira: duble.registrar("mandarParaALixeira"),
      reprocess: duble.registrar("reprocess"),
      // O vídeo do YouTube (H13): o botão da lista e o "Tentar de novo" do detalhe.
      resumirVideoDoYoutube: duble.registrar("resumirVideoDoYoutube"),
      refazerVideoDoYoutube: duble.registrar("refazerVideoDoYoutube"),
      resumoGuardado: { useQuery: (...args: unknown[]) => duble.resumoGuardado(...args) },
      // N5: a linha "Conexões geradas por esta reunião" (sem conexões, não aparece).
      conexoes: { useQuery: () => ({ data: undefined }) },
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      // O grupo voz: baixar o áudio do resumo (H19b) e o complemento pela busca (H4i).
      audioDoResumo: duble.registrar("audioDoResumo"),
      pedirComplemento: duble.registrar("pedirComplemento"),
      decidirComplemento: duble.registrar("decidirComplemento"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      // A tradução do resumo (H11) e o e-mail de retorno (H20), do pacote do
      // resumo: o detalhe da reunião, aberto depois do Encerrar, os monta.
      traduzirResumo: duble.registrar("traduzirResumo"),
      perguntar: duble.registrar("perguntar"),
      perguntarDuranteAGravacao: duble.registrar("perguntarDuranteAGravacao"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink"), perguntar: duble.registrar("perguntarPeloLink"), traduzirResumo: duble.registrar("traduzirResumoPeloLink") },
    // O "Tentar de novo" do evento da próxima ação que ficou na Google Agenda (H5c): o resumo guardado o monta.
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogleAAcao") },
    networkInteligente: { pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) } },
    agenda: {
      obter: { useQuery: (...args: unknown[]) => duble.obterDaAgenda(...args) },
      // A página da agenda, para o "Gravar agora" montado como no App.
      listar: { useQuery: (...args: unknown[]) => duble.listarDaAgenda(...args) },
      criar: duble.registrar("criarNaAgenda"),
      atualizar: duble.registrar("atualizarNaAgenda"),
      excluir: duble.registrar("excluirDaAgenda"),
      // A Google Agenda na página da agenda (H16c): aqui, sem a Google Agenda conectada.
      mandarParaGoogle: duble.registrar("mandarParaGoogle"),
      tirarDaGoogle: duble.registrar("tirarDaGoogle"),
    },
    googleAgenda: {
      estado: { useQuery: () => ({ data: { disponivel: false }, isLoading: false, isError: false, error: null, refetch: vi.fn() }) },
    },
  },
}));

const AGENDADA = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const DA_AGENDA = {
  id: AGENDADA, titulo: "Conversa com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17, 0), duracaoMinutos: 60, fuso: "America/Sao_Paulo",
  local: null, participantes: [], lembreteMinutos: 15, google: null, googleConvites: false, createdAt: 1, updatedAt: 2, gravacao: null,
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
  // A importação em curso mora fora da tela (decisão 5 da H9a): a de um teste anterior não vale aqui.
  _reiniciarParaTestes();
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.obterDaAgenda.mockReturnValue({ data: DA_AGENDA, isLoading: false, isError: false, error: null });
  duble.listarDaAgenda.mockReturnValue({ data: { proximas: [DA_AGENDA], anteriores: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.duracao.mockResolvedValue(30);
  duble.mutacao("create").mutateAsync.mockResolvedValue({ id: VINICOLA });
  duble.mutacao("submitRecording").mutateAsync.mockResolvedValue({ success: true });
  ligar().mockReset().mockResolvedValue({ ok: true });
  duble.utils.client.meetings.iniciarGravacao.mutate.mockReset().mockResolvedValue({ id: VINICOLA });
  duble.utils.client.meetings.definirPedidoDoResumo.mutate.mockReset().mockResolvedValue({ pedido: null });
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

/**
 * O arquivo pelo recuo do corte (o M4A em ALAC, que o corte reconhece e não
 * lê): o único que ainda vai pelo envio único depois da G14. O que vai em
 * partes, e a ligação dele à agenda, estão em Meetings.importacao.test.tsx.
 */
function enviarArquivo() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [new File(["som"], "reuniao.m4a", { type: "audio/m4a" })] } });
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

  it("o arquivo pelo recuo do corte: a reunião criada é ligada à reunião marcada, e a agenda se relê", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    enviarArquivo();
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    await waitFor(() => expect(duble.utils.agenda.listar.invalidate).toHaveBeenCalled());
    expect(duble.mutacao("create").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia" }));
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recuoDoCorte: true })));
    expect(duble.utils.client.meetings.iniciarGravacao.mutate).not.toHaveBeenCalled();
  });

  it("ir a Reuniões pelo menu no meio da gravação: a URL volta ao gravador com a reunião da agenda, e a faixa com o convite continua", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    act(() => window.history.pushState(null, "", "/meetings"));
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe(`/gravar?agendada=${AGENDADA}`));
    expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" });
    expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mandar o convite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  });

  it("gravação em partes: liga no Iniciar, com a reunião que nasce ali", async () => {
    abrir(`/gravar?emPartes=1&agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    expect(duble.utils.client.meetings.iniciarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa com a Bia" }));
  });

  it("o pedido do resumo antes de gravar (H4e): sem mexer, nada vai; escolhido, vai com a reunião que nasce no Iniciar", async () => {
    abrir(`/gravar?emPartes=1&agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByText("Resumo desta reunião", { exact: false }));
    fireEvent.change(screen.getByRole("combobox", { name: "Modelo do resumo" }), { target: { value: "sales" } });
    fireEvent.click(screen.getByRole("radio", { name: "Conciso" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(duble.utils.client.meetings.definirPedidoDoResumo.mutate).toHaveBeenCalledWith({
      meetingId: VINICOLA, pedido: { modelo: "sales", estilo: "concise", instrucoes: null },
    }));
  });

  it("sem mexer no pedido do resumo, o Iniciar não o manda: valem os padrões da dona", async () => {
    abrir(`/gravar?emPartes=1&agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(ligar()).toHaveBeenCalled());
    expect(duble.utils.client.meetings.definirPedidoDoResumo.mutate).not.toHaveBeenCalled();
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

  it("a ligação recusada não trava a gravação: ela segue, a dona é avisada e o Encerrar entrega", async () => {
    ligar().mockRejectedValue(Object.assign(new Error("Gravação não encontrada."), { data: { code: "NOT_FOUND" } }));
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AVISO_DA_LIGACAO));
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
  });

  it("a ligação recusada também não trava o arquivo pelo recuo do corte: o envio segue e a dona é avisada", async () => {
    ligar().mockRejectedValue(Object.assign(new Error("Gravação não encontrada."), { data: { code: "NOT_FOUND" } }));
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    enviarArquivo();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AVISO_DA_LIGACAO));
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
  });
});

// O lembrete da agenda no sino (H15) leva a /gravar?agendada=<id>, que é esta
// mesma página: o sino fica no cabeçalho do gravador, e tocar o aviso não
// desmonta a gravação em curso. A reunião da agenda só ganha a gravação que
// começou com ela (a decisão 2 da H16a); o lembrete de outra reunião, tocado no
// meio da gravação, não troca essa reunião.
describe("o lembrete de outra reunião da agenda, tocado no sino com uma gravação na tela", () => {
  const OUTRA = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const caminho = () => `${window.location.pathname}${window.location.search}`;

  async function gravar(titulo?: string) {
    if (titulo) fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: titulo } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
  }

  async function encerrar() {
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
  }

  // Em partes (desde a G14, a única gravação), a reunião nasce no Iniciar, e a
  // ligação à agenda, se houver, já foi feita ali, antes de qualquer lembrete.
  // Antes, no envio único do ?envioUnico=1, a reunião só nascia no Transcrever.
  it("no meio da gravação sem agenda: a URL volta ao gravador de antes, sem a faixa, e a gravação não é ligada à reunião do lembrete", async () => {
    abrir("/gravar");
    await gravar("Reunião A");
    act(() => window.history.pushState(null, "", `/gravar?agendada=${AGENDADA}`));
    await waitFor(() => expect(caminho()).toBe("/gravar"));
    expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" });
    expect(screen.queryByText(/Da sua agenda:/)).not.toBeInTheDocument();
    await encerrar();
    expect(duble.utils.client.meetings.iniciarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({ title: "Reunião A" }));
    expect(ligar()).not.toHaveBeenCalled();
  });

  it("no meio da gravação de uma reunião da agenda: a URL volta à dela, com a faixa, e a gravação fica com ela", async () => {
    duble.obterDaAgenda.mockImplementation(({ id }: { id: string }) => ({
      data: { ...DA_AGENDA, id, titulo: id === OUTRA ? "Conversa com o Rui" : DA_AGENDA.titulo }, isLoading: false, isError: false, error: null,
    }));
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    await gravar();
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    act(() => window.history.pushState(null, "", `/gravar?agendada=${OUTRA}`));
    await waitFor(() => expect(caminho()).toBe(`/gravar?agendada=${AGENDADA}`));
    expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument();
    await encerrar();
    expect(ligar()).toHaveBeenCalledTimes(1);
  });

});

describe("Gravar agora pela agenda, montado como no App", () => {
  /** A agenda numa rota e as três de Reuniões com a mesma página, como em App.tsx. */
  function abrirAAgenda() {
    window.history.replaceState(null, "", "/agenda");
    return render(<Switch>
      <Route path="/agenda"><Agenda /></Route>
      <Route path="/gravar"><Meetings /></Route>
      <Route path="/meetings/:id"><Meetings /></Route>
      <Route path="/meetings"><Meetings /></Route>
    </Switch>);
  }

  // O cenário do achado: no celular, a dona grava pela agenda e faz o gesto de
  // voltar no meio da reunião. Com a agenda logo atrás no histórico, a página do
  // gravador desmontava e o áudio era descartado sem aviso.
  it("o voltar do navegador no meio da gravação não descarta o áudio: volta ao gravador, com a reunião da agenda, e a gravação fica ligada", async () => {
    abrirAAgenda();
    fireEvent.click(screen.getByRole("button", { name: /Gravar agora/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    const pararGravador = vi.spyOn(GravadorFalso.prototype, "stop");
    try {
      act(() => window.history.back());
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" }));
      await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe(`/gravar?agendada=${AGENDADA}`));
      // O gravador não parou nem saiu da tela, e a faixa da agenda voltou com ele.
      expect(pararGravador).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Gravar agora/ })).not.toBeInTheDocument();
      expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument();
      // O "Gravar agora" grava em partes (o padrão desde a G13b): a reunião nasceu
      // no Iniciar e já ficou ligada à da agenda.
      await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
      fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
      // O Encerrar entrega a gravação inteira: a última parte e o fim.
      await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    } finally {
      pararGravador.mockRestore();
    }
  });
});

describe("sem a reunião da agenda, o gravador de sempre", () => {
  it("sem ?agendada: nada de agenda, nem leitura nem ligação", async () => {
    abrir("/gravar");
    expect(duble.obterDaAgenda).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Conversa avulsa" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
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
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(ligar()).not.toHaveBeenCalled();
  });

  it("a leitura que falha por outro motivo também avisa, sem travar", () => {
    duble.obterDaAgenda.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } } });
    abrir(`/gravar?agendada=${AGENDADA}`);
    expect(screen.getByRole("note")).toHaveTextContent("Não deu para ler a reunião da agenda. A gravação segue sem ligação.");
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeEnabled();
  });
});

/**
 * A reunião da agenda que termina de carregar depois do toque da dona (a rede
 * lenta, ou a primeira leitura que falhou e foi repetida): a gravação liga do
 * mesmo jeito, na gravação em partes e no arquivo do recuo do corte, e uma vez
 * só. A faixa de outra reunião não leva a gravação.
 */
describe("a reunião da agenda que carrega depois do Iniciar ou do arquivo", () => {
  const CARREGANDO = { data: undefined, isLoading: true, isError: false, error: null };
  const CARREGADA = { data: DA_AGENDA, isLoading: false, isError: false, error: null };
  const OUTRA = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const respirar = () => act(async () => { await new Promise(resolver => setTimeout(resolver, 50)); });

  function escreverEAutorizar() {
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Minha reunião" } });
    fireEvent.click(screen.getByRole("checkbox"));
  }

  it("em partes, a faixa que carrega depois do Iniciar liga a gravação em curso, e o Encerrar não liga de novo", async () => {
    duble.obterDaAgenda.mockReturnValue(CARREGANDO);
    const { rerender } = abrir(`/gravar?agendada=${AGENDADA}`);
    escreverEAutorizar();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(ligar()).not.toHaveBeenCalled();
    duble.obterDaAgenda.mockReturnValue(CARREGADA);
    rerender(<Meetings />);
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalled());
    await respirar();
    expect(ligar()).toHaveBeenCalledTimes(1);
  });

  it("em partes, a faixa que carrega enquanto o servidor cria a reunião liga a gravação quando o microfone abre", async () => {
    duble.obterDaAgenda.mockReturnValue(CARREGANDO);
    let soltar: (reuniao: { id: string }) => void = () => {};
    duble.utils.client.meetings.iniciarGravacao.mutate.mockReset().mockImplementation(() => new Promise(resolver => { soltar = resolver; }));
    const { rerender } = abrir(`/gravar?agendada=${AGENDADA}`);
    escreverEAutorizar();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    duble.obterDaAgenda.mockReturnValue(CARREGADA);
    rerender(<Meetings />);
    await waitFor(() => expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument());
    await act(async () => { soltar({ id: VINICOLA }); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    await waitFor(() => expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    await respirar();
    expect(ligar()).toHaveBeenCalledTimes(1);
  });

  it("o arquivo do recuo do corte: a faixa que carrega enquanto o arquivo é lido liga a reunião criada", async () => {
    duble.obterDaAgenda.mockReturnValue(CARREGANDO);
    let soltarDuracao: (segundos: number) => void = () => {};
    duble.duracao.mockImplementation(() => new Promise(resolver => { soltarDuracao = resolver; }));
    const { rerender } = abrir(`/gravar?agendada=${AGENDADA}`);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: "Minha reunião" } });
    enviarArquivo();
    duble.obterDaAgenda.mockReturnValue(CARREGADA);
    rerender(<Meetings />);
    await waitFor(() => expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument());
    await act(async () => { soltarDuracao(30); });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(ligar()).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA });
    expect(ligar()).toHaveBeenCalledTimes(1);
  });

  it("a faixa que carrega depois com outra reunião da agenda não leva a gravação", async () => {
    duble.obterDaAgenda.mockReturnValue(CARREGANDO);
    const { rerender } = abrir(`/gravar?agendada=${AGENDADA}`);
    escreverEAutorizar();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    duble.obterDaAgenda.mockReturnValue({ ...CARREGADA, data: { ...DA_AGENDA, id: OUTRA } });
    rerender(<Meetings />);
    await waitFor(() => expect(screen.getByText(/Da sua agenda:/)).toBeInTheDocument());
    await respirar();
    expect(ligar()).not.toHaveBeenCalled();
  });
});
