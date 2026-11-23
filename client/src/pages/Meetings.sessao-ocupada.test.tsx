import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { _reiniciarParaTestes } from "@/hooks/useImportacaoEmPartes";
import { motivoDaOcupacao, sessaoOcupada } from "@/lib/sessao-ocupada";
import { RetomadaDosDescartes } from "@/components/RetomadaDosDescartes";
import { instalarReconhecimentoFalso } from "@/test/reconhecimento-falso";
import Meetings from "./Meetings";

/**
 * A sessão ocupada no gravador de reuniões (PR S): gravando ou enviando, a
 * sessão fica ocupada (lib/sessao-ocupada.ts), e o Sair e o fechar da aba
 * perguntam antes. O envio ocupa à parte, sem depender da página: ele segue no
 * ar mesmo que a dona saia da tela, e só libera quando termina. A validação que
 * recusa o envio (título, autorização) não ocupa nada. Desde a G14 o gravador
 * grava sempre em partes: o áudio gravado e ainda por revisar ("Transcrever
 * áudio"), que era do envio único do ?envioUnico=1, não existe mais; o envio
 * único só sobra no arquivo do recuo do corte (o formato que o corte reconhece
 * mas não lê).
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
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      // A gravação em partes (G9; o padrão do /gravar desde a G13b) chama o servidor por aqui.
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: { meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() }, // G15a: a transcrição durante a gravação, sem nenhuma parte pronta (função comum: o mockReset do projeto client zeraria um vi.fn).
        transcricaoDaGravacao: { query: async () => ({ status: "recording", emPartes: true, agora: Date.now(), partes: [], falas: [], nomes: {} }) } } },
    },
    enviarParte: vi.fn(),
    // A cópia no aparelho (G9): o teste da cópia que falta (G13b) a faz falhar,
    // e o do Descartar confere que a da gravação descartada sai.
    guardarParte: vi.fn(),
    apagarPartesDaReuniao: vi.fn(),
    // O corte do arquivo (H9a, H9b e H9c), que roda num Worker.
    cortar: vi.fn(),
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
vi.mock("@/lib/corte-do-arquivo-no-worker", () => ({ cortarArquivoNoWorker: (...a: unknown[]) => duble.cortar(...a) }));
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
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      traduzirResumo: duble.registrar("traduzirResumo"),
      perguntar: duble.registrar("perguntar"),
      perguntarDuranteAGravacao: duble.registrar("perguntarDuranteAGravacao"),
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
  // A gravação em partes, a única desde a G14: o servidor dela responde, salvo no teste que diz outro.
  duble.utils.client.meetings.iniciarGravacao.mutate.mockResolvedValue({ id: VINICOLA });
  duble.utils.client.meetings.encerrarGravacao.mutate.mockResolvedValue({ partes: 1 });
  duble.utils.client.meetings.delete.mutate.mockResolvedValue({ success: true });
  duble.enviarParte.mockResolvedValue({ tipo: "recebida" });
  // O corte reconhece o M4A e não lê o ALAC: o arquivo curto vai pelo recuo do
  // corte, o envio único que a G14 manteve. A importação em curso mora fora da
  // tela (decisão 5 da H9a): a de um teste anterior não vale aqui.
  duble.cortar.mockResolvedValue({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" });
  _reiniciarParaTestes();
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
 * O gravador, que desde a G14 grava sempre em partes (o ?envioUnico=1, com a
 * revisão antes de enviar, saiu): a reunião nasce no Iniciar, e cada parte
 * sobe enquanto grava.
 */
function abrirOGravador() {
  window.history.replaceState(null, "", "/gravar");
  return render(<Meetings />);
}

/** O título, a autorização e o Iniciar: a gravação em partes começa. */
async function comecarAGravar() {
  fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
  expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
}

/**
 * O Encerrar e a entrega: a última parte sobe, o fim é declarado e a sessão
 * fica livre. Os testes que gravam terminam por aqui, e não pelo desmonte, que
 * também entrega (G13b), mas depois do fim do teste.
 */
async function encerrarEEntregar(partes = 1) {
  fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
  await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes }));
  await waitFor(() => expect(sessaoOcupada()).toBe(false));
}

/** O ALAC do Gravador do iPhone: o corte reconhece o M4A e não lê o áudio, e o arquivo curto vai pelo recuo do corte. */
const arquivoDoRecuo = () => new File(["som"], "memo.m4a", { type: "audio/x-m4a" });

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
  it("gravando ocupa, e fechar a aba pergunta; encerrada, a última parte e o fim sobem e a sessão fica livre", async () => {
    abrirOGravador();
    expect(sessaoOcupada()).toBe(false);
    expect(fecharAba()).toBe(false);
    await comecarAGravar();
    expect(motivoDaOcupacao()).toBe("gravando");
    expect(fecharAba()).toBe(true);
    // Desde a G14 não há áudio por revisar depois do Encerrar: ele vai ao servidor.
    await encerrarEEntregar();
    expect(fecharAba()).toBe(false);
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
  });

  it("sair da página no meio do envio do recuo do corte, com o create ainda no ar: o pedido segue e a sessão, ocupada, até ele terminar", async () => {
    duble.duracao.mockResolvedValue(30);
    const { unmount } = abrirOGravador();
    const envio = envioNoAr();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivoDoRecuo()] } });
    await waitFor(() => expect(duble.mutacao("create").mutateAsync).toHaveBeenCalled());
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
    // O envio é avulso: a página desmontada não o solta.
    unmount();
    expect(motivoDaOcupacao()).toBe("enviando");
    expect(fecharAba()).toBe(true);
    await act(async () => { envio.criar(); });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ recuoDoCorte: true })));
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => { envio.terminar(); });
    expect(sessaoOcupada()).toBe(false);
  });

  it("o envio de arquivo ocupa do clique ao fim, inclusive quando termina recusado", async () => {
    // O corte no ar: a sessão já está ocupada enquanto o arquivo é lido.
    let entregarCorte: (corte: unknown) => void = () => {};
    duble.cortar.mockImplementation(() => new Promise(resolver => { entregarCorte = resolver; }));
    let entregarDuracao: (segundos: number | null) => void = () => {};
    duble.duracao.mockImplementation(() => new Promise(resolver => { entregarDuracao = resolver; }));
    pendentes.push(() => { entregarCorte({ ok: false, codigo: "DANIFICADO" }); entregarDuracao(null); });
    abrirOGravador();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivoDoRecuo()] } });
    expect(motivoDaOcupacao()).toBe("enviando");
    // O corte não lê o ALAC: o recuo do corte lê a duração, e segue ocupando.
    await act(async () => { entregarCorte({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" }); });
    await waitFor(() => expect(duble.duracao).toHaveBeenCalled());
    expect(motivoDaOcupacao()).toBe("enviando");
    // Sem duração legível, o envio para antes do servidor: a ocupação sai junto.
    await act(async () => { entregarDuracao(null); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Este arquivo usa ALAC, que a WRW ainda não lê. Converta-o para MP3 ou M4A e envie de novo."));
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
    // O recuo do corte, o envio único que a G14 manteve.
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivoDoRecuo()] } });
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalled());
    expect(motivoDaOcupacao()).toBe("enviando");
    await act(async () => { envio.terminar(); });
    expect(sessaoOcupada()).toBe(false);
  });
});

describe("Reuniões — a validação que recusa o envio não ocupa a sessão", () => {
  const audio = () => new File(["som"], "reuniao.mp3", { type: "audio/mpeg" });
  // O formato e o tamanho não são mais recusados aqui: desde a H9b todo arquivo
  // vai ao corte, que ocupa a sessão enquanto lê (Meetings.importacao.test.tsx).
  it.each([
    { caso: "sem título", titulo: "", marcar: true, arquivo: audio },
    { caso: "sem a autorização", titulo: "Conversa com a Bia", marcar: false, arquivo: audio },
  ])("o arquivo $caso é recusado sem ocupar a sessão", async ({ titulo, marcar, arquivo }) => {
    abrirOGravador();
    if (titulo) fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: titulo } });
    if (marcar) fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivo()] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(duble.duracao).not.toHaveBeenCalled();
    expect(duble.cortar).not.toHaveBeenCalled();
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
    await comecarAGravar();

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
    // O logout é um dublê, e a página continua montada: o Encerrar entrega a
    // gravação antes do fim do teste.
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(duble.utils.client.meetings.encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("com a sessão livre (nada gravado), o Sair sai direto", async () => {
    abrirOGravador();
    await clicarEmSair();
    expect(duble.mutacoes.logout.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
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

  it("o ?envioUnico=1 de antes (sem efeito desde a G14) grava em partes do mesmo jeito: a reunião nasce no Iniciar, e o Encerrar entrega", async () => {
    window.history.replaceState(null, "", "/gravar?envioUnico=1");
    render(<Meetings />);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledWith(expect.objectContaining({ origem: "gravacao" }));
    expect(await screen.findByRole("button", { name: "Descartar gravação" })).toBeInTheDocument();
    await encerrarEEntregar();
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    expect(duble.mutacao("create").mutateAsync).not.toHaveBeenCalled();
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
  });

  // G17: o fone Bluetooth que cai no meio da gravação. A trilha falsa tem o
  // readyState e o "ended" do navegador. O relógio de parede é falso só para a
  // parte que caiu ter duração (a de menos de 1 s não sai); o setTimeout fica
  // real, para o waitFor.
  it("G17: o microfone que cai: o cartão avisa, a gravação espera sem encerrar e segue sozinha quando outro microfone abre; a parte que caiu sobe como as outras", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["Date"] });
    try {
      const ouvintes = new Set<() => void>();
      const trilha = {
        readyState: "live", stop: vi.fn(),
        addEventListener: (tipo: string, ouvinte: () => void) => { if (tipo === "ended") ouvintes.add(ouvinte); },
        removeEventListener: (tipo: string, ouvinte: () => void) => { ouvintes.delete(ouvinte); },
      };
      const outra = { readyState: "live", stop: vi.fn() };
      let liberarOutro: (fluxo: unknown) => void = () => {};
      const getUserMedia = vi.fn()
        .mockResolvedValueOnce({ getTracks: () => [trilha], getAudioTracks: () => [trilha] })
        .mockImplementationOnce(() => new Promise(resolver => { liberarOutro = resolver; }));
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
      abrirEmPartes();
      preencher();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
      await screen.findByRole("button", { name: /Encerrar gravação/ });
      vi.setSystemTime(Date.now() + 60_000);
      await act(async () => {
        trilha.readyState = "ended";
        for (const ouvinte of Array.from(ouvintes)) ouvinte();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("O microfone desconectou");
      expect(screen.getByText("Sem microfone: esperando")).toBeInTheDocument();
      // Nada a pausar sem microfone; o Encerrar e o Descartar continuam.
      expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Descartar gravação/ })).toBeInTheDocument();
      await waitFor(() => expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String)));
      expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      // Outro microfone (o do aparelho) abre: a gravação segue, e a tela avisa.
      await act(async () => { liberarOutro({ getTracks: () => [outra], getAudioTracks: () => [outra] }); });
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith("O microfone voltou: a gravação seguiu.", expect.objectContaining({ id: "gravacao-microfone" }));
      vi.setSystemTime(Date.now() + 30_000);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
      await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 2 }));
      expect(outra.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    // A tela inteira, com o envio das partes: na máquina carregada (outros
    // agentes rodando testes ao mesmo tempo), passava dos 5 s do padrão.
  }, 20_000);

  it("G17: sem microfone, o Tentar de novo do cartão pede o microfone na hora", async () => {
    const ouvintes = new Set<() => void>();
    const trilha = {
      readyState: "live", stop: vi.fn(),
      addEventListener: (tipo: string, ouvinte: () => void) => { if (tipo === "ended") ouvintes.add(ouvinte); },
      removeEventListener: (tipo: string, ouvinte: () => void) => { ouvintes.delete(ouvinte); },
    };
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getTracks: () => [trilha], getAudioTracks: () => [trilha] })
      .mockRejectedValue(new DOMException("negado", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    abrirEmPartes();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    await screen.findByRole("button", { name: /Encerrar gravação/ });
    await act(async () => {
      trilha.readyState = "ended";
      for (const ouvinte of Array.from(ouvintes)) ouvinte();
    });
    // O navegador recusou o microfone na volta: o cartão diz como liberar.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Libere o microfone para este site"));
    const pedidos = getUserMedia.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" })); });
    expect(getUserMedia.mock.calls.length).toBe(pedidos + 1);
  }, 20_000);

  it("G15a: durante a gravação, o texto das partes que a fila já transcreveu aparece no gravador, com o atraso e o Pergunte sobre o que já foi dito", async () => {
    const consulta = duble.utils.client.meetings.transcricaoDaGravacao;
    const original = consulta.query;
    const pedidos: unknown[] = [];
    consulta.query = async (entrada: unknown) => {
      pedidos.push(entrada);
      return {
        status: "recording", emPartes: true, agora: Date.now(), nomes: {},
        partes: [{ seq: 0, estado: "transcrita", inicioSegundos: 0, duracaoSegundos: 600, chegouEm: Date.now() - 90_000, prontaEm: Date.now(), atrasoSegundos: 90 }],
        falas: [{ seq: 0, segmentos: [{ inicio: 4, fim: 9, falante: "F1", texto: "Bom dia, Bia, vamos falar da feira." }] }],
      };
    };
    try {
      abrirEmPartes();
      preencher();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
      expect(await screen.findByText("Bom dia, Bia, vamos falar da feira.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Transcrição até agora" })).toBeInTheDocument();
      expect(screen.getByText(/texto pronto 1 min 30 s depois de a parte chegar/)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Pergunte sobre o que já foi dito" })).toBeInTheDocument();
      expect(pedidos).toEqual([{ meetingId: VINICOLA, desde: 0 }]);
    } finally {
      consulta.query = original;
    }
  }, 20_000);

  it("G15b: a legenda ao vivo do navegador aparece no gravador, acima da transcrição das partes; liga depois do aviso, pausa com a gravação e sai com o Encerrar", async () => {
    const falso = instalarReconhecimentoFalso();
    const ligar = vi.fn(async () => ({ success: true }));
    const cliente = duble.utils.client.meetings as Record<string, unknown>;
    cliente.ligarLegendaAoVivo = { mutate: ligar };
    try {
      abrirEmPartes();
      preencher();
      expect(screen.queryByRole("heading", { name: "Legenda ao vivo" })).not.toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
      const legenda = await screen.findByRole("heading", { name: "Legenda ao vivo" });
      const transcricao = await screen.findByRole("heading", { name: "Transcrição até agora" });
      // As duas convivem: a legenda (o rascunho imediato) antes do texto das partes (o que fica na reunião).
      expect(legenda.compareDocumentPosition(transcricao) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Nada ouve antes do aviso e da confirmação.
      expect(falso.criados).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Ligar a legenda" }));
      const aviso = await screen.findByRole("alertdialog");
      fireEvent.click(within(aviso).getByRole("checkbox"));
      await act(async () => { fireEvent.click(within(aviso).getByRole("button", { name: "Ligar a legenda" })); });
      expect(ligar).toHaveBeenCalledWith(expect.objectContaining({ meetingId: VINICOLA, concordanciaDasPessoas: true }));
      expect(falso.atual()).toMatchObject({ lang: "pt-BR", emCurso: true });
      falso.resultados(["Bom dia, Bia, vamos falar da feira."]);
      expect(screen.getByText("Bom dia, Bia, vamos falar da feira.")).toBeInTheDocument();

      // A pausa da gravação para a legenda (o áudio deixa de ir ao serviço do navegador), e o Continuar a religa.
      fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
      expect(falso.atual().emCurso).toBe(false);
      expect(screen.getByText(/Legenda pausada junto com a gravação/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
      expect(falso.atual().emCurso).toBe(true);

      // O Encerrar tira a legenda da tela e solta o reconhecimento: nada dela fica.
      const ultimo = falso.atual();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ })); });
      expect(ultimo.chamadas.abort).toBe(1);
      expect(screen.queryByText("Bom dia, Bia, vamos falar da feira.")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Legenda ao vivo" })).not.toBeInTheDocument();
    } finally {
      delete cliente.ligarLegendaAoVivo;
    }
  }, 20_000);

  it("G15b: onde o navegador não tem o reconhecimento de voz, o gravador não mostra a legenda, e a transcrição das partes segue", async () => {
    abrirEmPartes();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(await screen.findByRole("heading", { name: "Transcrição até agora" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Legenda ao vivo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ligar a legenda" })).not.toBeInTheDocument();
  }, 20_000);
});

describe("Reuniões — gravação longa no celular (G10)", () => {
  it("Pausar e Continuar gravando; pausada, a sessão segue ocupada e o Encerrar continua lá", async () => {
    abrirOGravador();
    await comecarAGravar();
    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    expect(screen.getByRole("status")).toHaveTextContent("Gravação pausada");
    expect(motivoDaOcupacao()).toBe("gravando");
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
    // O Encerrar entrega pelas partes (desde a G14 não há o áudio por revisar).
    await encerrarEEntregar();
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
    await encerrarEEntregar();
  });

  it("sem a tela acesa (navegador sem Wake Lock ou que recusou), avisa", async () => {
    abrirOGravador();
    await iniciar();
    expect(await screen.findByRole("note")).toHaveTextContent(/Mantenha esta tela aberta/);
    await encerrarEEntregar();
  });

  it("navegador sem pause(): o Pausar não aparece", async () => {
    const pausar = GravadorFalso.prototype.pause;
    (GravadorFalso.prototype as { pause?: unknown }).pause = undefined;
    try {
      abrirOGravador();
      await iniciar();
      expect(await screen.findByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
      await encerrarEEntregar();
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
    await encerrarEEntregar();
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

  it("o ?envioUnico=1 de antes não volta aos 10 min nem à revisão do envio único (G14): a gravação segue em partes depois deles", async () => {
    await iniciar("/gravar?envioUnico=1");
    expect(screen.getByText("A cada hora de gravação, confirme que ela continua. Limite: 12 horas.")).toBeInTheDocument();
    expect(screen.queryByText(/10 minutos ou 10 MB/)).not.toBeInTheDocument();
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    await passar(10 * 60_000);
    // Aos 10 min a parte 0 fecha e sobe, e a gravação continua, sem a revisão.
    expect(screen.getByRole("button", { name: /Encerrar gravação/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    vi.useRealTimers();
    await waitFor(() => expect(partesEnviadas()).toEqual([[VINICOLA, 0]]));
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 2 }));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });
});

/**
 * G13b: a gravação em partes vira o padrão para todas. O /gravar grava em
 * partes, e o ?emPartes=1 da G9 continua aceito; o ?envioUnico=1, a saída de
 * suporte da G13b, saiu na G14 e também grava em partes. Os avisos que eram silenciosos passam a aparecer (a parte
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

  it.each(["/gravar", "/gravar?emPartes=1", "/gravar?envioUnico=1"])("%s grava em partes: sob o relógio, o aviso de hora e as 12 h, e o teto do arquivo (em partes, H9a, H9b e H9c); a reunião nasce no Iniciar", async caminho => {
    window.history.replaceState(null, "", caminho);
    render(<Meetings />);
    expect(screen.getByText("A cada hora de gravação, confirme que ela continua. Limite: 12 horas.")).toBeInTheDocument();
    expect(screen.queryByText(/10 minutos ou 10 MB/)).not.toBeInTheDocument();
    // O arquivo enviado: todos os formatos em partes, até 12 h (H9a, H9b e H9c).
    expect(screen.getByText("Áudio ou vídeo (MP3, M4A, MP4, MOV, WAV, OGG, WebM, FLAC, AAC): até 12 horas.")).toBeInTheDocument();
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Encerrar gravação/ })); });
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it.each(["/gravar", "/gravar?envioUnico=1"])("%s: a reunião nasce no Iniciar, o Descartar aparece no meio, e sair da tela gravando entrega o que foi gravado (G13b; o ?envioUnico=1 sem efeito desde a G14)", async caminho => {
    window.history.replaceState(null, "", caminho);
    const pagina = render(<Meetings />);
    preencher();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Descartar gravação" })).toBeInTheDocument();
    // Sair da tela gravando em partes entrega o que foi gravado (revisão da G13b).
    pagina.unmount();
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
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
