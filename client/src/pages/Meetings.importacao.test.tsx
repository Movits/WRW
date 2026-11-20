import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/_core/hooks/useAuth";
import { _reiniciarParaTestes } from "@/hooks/useImportacaoEmPartes";
import { lerBlob, type CorteDoArquivo } from "@/lib/corte-comum";
import { cortarArquivo } from "@/lib/corte-do-arquivo";
import type { OpcoesDoCorteNoWorker } from "@/lib/corte-do-arquivo-no-worker";
import { liberarTodas, sessaoOcupada } from "@/lib/sessao-ocupada";
import { id3v2, juntar, MPEG1_128K, quadroDeEtiqueta, quadros } from "@/test/mp3-sintetico";
import Meetings from "./Meetings";

/**
 * O arquivo enviado em partes no gravador (H9a, H9b e H9c): no /gravar, todo
 * arquivo vai ao corte (o Worker é um dublê que corta de verdade, na página),
 * que reconhece o formato pelos bytes, e sobe parte a parte pelo caminho da
 * gravação em partes, com o andamento e o Cancelar na tela. No ?envioUnico=1,
 * tudo segue no envio único (Meetings.rotas.test.tsx); em partes, só o arquivo
 * curto de um formato que o corte não lê.
 *
 * O tRPC é o dublê de Meetings.agenda.test.tsx.
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
    cortar: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      agenda: { listar: { invalidate: vi.fn(async () => undefined) } },
      auth: { me: { getData: vi.fn(), fetch: vi.fn() } },
      client: {
        meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() } },
        agenda: { ligarGravacao: { mutate: vi.fn() } },
      },
    },
    enviarParte: vi.fn(),
    guardarParte: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/lib/corte-do-arquivo-no-worker", () => ({ cortarArquivoNoWorker: (...a: unknown[]) => duble.cortar(...a) }));
vi.mock("@/lib/envio-das-partes", () => ({
  enviarParte: (...a: unknown[]) => duble.enviarParte(...a),
  enviarPendentes: async () => ({ restantes: 0, semSessao: false }),
  travaDoNavegador: async (_nome: string, trabalho: () => Promise<unknown>) => trabalho(),
}));
vi.mock("@/lib/partes-no-aparelho", () => ({
  guardarParte: (...a: unknown[]) => duble.guardarParte(...a),
  apagarParte: async () => undefined,
  apagarPartesDaReuniao: async () => undefined,
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
      traduzirResumo: duble.registrar("traduzirResumo"),
      perguntar: duble.registrar("perguntar"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
    },
    reuniaoAberta: { pedirResumo: duble.registrar("pedirResumoPeloLink"), perguntar: duble.registrar("perguntarPeloLink"), traduzirResumo: duble.registrar("traduzirResumoPeloLink") },
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogleAAcao") },
    networkInteligente: { pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) } },
    agenda: { obter: { useQuery: (...args: unknown[]) => duble.obterDaAgenda(...args) } },
  },
}));

const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const AGENDADA = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const DA_AGENDA = {
  id: AGENDADA, titulo: "Conversa com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17, 0), duracaoMinutos: 60, fuso: "America/Sao_Paulo",
  local: null, participantes: [], lembreteMinutos: 15, google: null, googleConvites: false, createdAt: 1, updatedAt: 2, gravacao: null,
};
const PLACEHOLDER_DO_TITULO = "Ex.: Conversa com investidor";
/** Um MP3 de verdade, com ID3 e Xing: 90 quadros de 26 ms, cortados em partes de 1 s (3 partes). */
const MP3 = juntar(id3v2(500), quadroDeEtiqueta(MPEG1_128K, "Xing"), quadros(MPEG1_128K, 90));
const arquivoMp3 = (nome = "reuniao-da-glenda.mp3") => new File([MP3], nome, { type: "audio/mpeg" });

/** O Worker de mentira: corta de verdade, na página, em partes de 1 s. */
const corteDeVerdade = (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker): Promise<CorteDoArquivo> =>
  cortarArquivo(lerBlob(arquivo), arquivo.size, { ...opcoes, segundosPorParte: 1 });

const iniciarGravacao = () => duble.utils.client.meetings.iniciarGravacao.mutate;
const encerrarGravacao = () => duble.utils.client.meetings.encerrarGravacao.mutate;
const excluir = () => duble.utils.client.meetings.delete.mutate;

beforeEach(() => {
  vi.clearAllMocks();
  // A importação em curso mora fora da tela (decisão 5 da H9a): a de um teste anterior não vale aqui.
  _reiniciarParaTestes();
  // O descarte que falhou num teste fica guardado (lib/descartes-pendentes.ts), e a retomada do seguinte o repetiria.
  localStorage.clear();
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.obterDaAgenda.mockReturnValue({ data: DA_AGENDA, isLoading: false, isError: false, error: null });
  duble.duracao.mockResolvedValue(30);
  duble.cortar.mockImplementation(corteDeVerdade);
  duble.utils.auth.me.getData.mockReturnValue({ openId: "dona-1" });
  duble.mutacao("create").mutateAsync.mockResolvedValue({ id: "reuniao-do-envio-unico" });
  duble.mutacao("submitRecording").mutateAsync.mockResolvedValue({ success: true });
  duble.utils.client.agenda.ligarGravacao.mutate.mockResolvedValue({ ok: true });
  iniciarGravacao().mockResolvedValue({ id: VINICOLA });
  encerrarGravacao().mockResolvedValue({ partes: 3 });
  excluir().mockResolvedValue({ success: true });
  duble.enviarParte.mockResolvedValue({ tipo: "recebida" });
  duble.guardarParte.mockResolvedValue(undefined);
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role: "silver" },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
});

afterEach(() => {
  cleanup();
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  // O teste que falha no meio de uma importação deixa a sessão ocupada (o
  // ocupar é do módulo): sem isto, o seguinte falharia junto, por tabela.
  liberarTodas();
});

function abrir(caminho = "/gravar") {
  window.history.replaceState(null, "", caminho);
  return render(<Meetings />);
}

function enviar(arquivo: File, titulo = "Reunião com a Glenda") {
  if (titulo) fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO), { target: { value: titulo } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(document.querySelector<HTMLInputElement>("input[type='file']")!, { target: { files: [arquivo] } });
}

/** O envio da parte fica no ar até o teste soltar. */
function partesPresas() {
  const soltar: Array<() => void> = [];
  duble.enviarParte.mockImplementation(() => new Promise(resolver => soltar.push(() => resolver({ tipo: "recebida" }))));
  return async () => {
    await waitFor(() => expect(soltar.length).toBeGreaterThan(0));
    await act(async () => { soltar.shift()!(); });
  };
}

describe("Reuniões — o MP3 enviado em partes (H9a)", () => {
  it("a dica do arquivo diz o teto e os formatos: áudio ou vídeo, até 12 h; o seletor oferece também o vídeo, o FLAC e o AAC", () => {
    abrir();
    expect(screen.getByText("Áudio ou vídeo (MP3, M4A, MP4, MOV, WAV, OGG, WebM, FLAC, AAC): até 12 horas.")).toBeInTheDocument();
    const aceitos = document.querySelector<HTMLInputElement>("input[type='file']")!.accept.split(",");
    expect(aceitos).toEqual(expect.arrayContaining(["audio/*", "video/mp4", "video/quicktime", ".mov", ".flac", ".aac", ".opus", ".mkv"]));
  });

  it("o MP3 vai em partes: a reunião nasce com a origem arquivo, cada parte sobe como audio/mpeg com o andamento na tela, e o fim leva ao detalhe", async () => {
    const subir = partesPresas();
    abrir();
    enviar(arquivoMp3());
    // A sessão fica ocupada do clique ao fim: fechar a aba no meio pergunta.
    expect(sessaoOcupada()).toBe(true);
    await waitFor(() => expect(iniciarGravacao()).toHaveBeenCalledWith({
      title: "Reunião com a Glenda", language: "pt-BR", consentNoticeVersion: expect.any(String), consentGranted: true, origem: "arquivo",
    }));
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Andamento do envio do arquivo" })).toHaveAttribute("aria-valuenow", "0");
    // O jsdom não tem Wake Lock: a tela acesa não está garantida, e o aviso diz que o envio para se ela apagar.
    expect(screen.getByRole("note")).toHaveTextContent("Mantenha esta tela aberta e o aparelho desbloqueado até o envio terminar");
    // O formulário trava, e os botões do gravador dão lugar ao andamento.
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Iniciar gravação/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar arquivo de áudio/ })).not.toBeInTheDocument();
    await subir();
    expect(await screen.findByText("Enviando o arquivo: parte 2 de 3")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Andamento do envio do arquivo" })).toHaveAttribute("aria-valuenow", "33");
    await subir();
    await subir();
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`));
    expect(duble.enviarParte.mock.calls.map(c => [c[0], c[1], c[3]])).toEqual([[VINICOLA, 0, "audio/mpeg"], [VINICOLA, 1, "audio/mpeg"], [VINICOLA, 2, "audio/mpeg"]]);
    // As três partes juntas são o áudio do arquivo, sem o ID3 e o Xing.
    const enviado = new Uint8Array(await new Blob(duble.enviarParte.mock.calls.map(c => c[2] as Blob)).arrayBuffer());
    expect(enviado).toEqual(quadros(MPEG1_128K, 90));
    // Nada pelo envio único.
    expect(duble.mutacao("create").mutateAsync).not.toHaveBeenCalled();
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
    expect(duble.duracao).not.toHaveBeenCalled();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("o MP3 acima de 10 MB não é mais recusado: vai ao corte", async () => {
    duble.cortar.mockResolvedValue({ ok: false, codigo: "DANIFICADO", formato: "mp3" });
    abrir();
    enviar(new File([new Uint8Array(11 * 1024 * 1024)], "longa.mp3", { type: "audio/mpeg" }));
    await waitFor(() => expect(duble.cortar).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalledWith("O arquivo de áudio deve ter no máximo 10 MB.");
  });

  it("Cancelar no meio: a reunião é excluída, nada mais sobe, o aviso diz que nada ficou, e o formulário volta", async () => {
    const subir = partesPresas();
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    expect(await screen.findByText("Cancelando o envio…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancelar envio/ })).toBeDisabled();
    // A parte que já subia termina; depois dela, a exclusão.
    await subir();
    await waitFor(() => expect(excluir()).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Envio cancelado. Nada deste arquivo ficou na WRW."));
    expect(duble.enviarParte).toHaveBeenCalledTimes(1);
    expect(encerrarGravacao()).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/gravar");
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /Enviar arquivo de áudio/ })).toBeInTheDocument();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("o Cancelar cuja exclusão falha avisa até ser fechado (a retomada a repete)", async () => {
    const subir = partesPresas();
    excluir().mockRejectedValue(new TypeError("Failed to fetch"));
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    await subir();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "O envio parou, mas a reunião dele ainda não foi excluída. O app tenta de novo sozinho enquanto estiver aberto; se ela aparecer na lista, exclua-a por lá.",
      expect.objectContaining({ duration: Infinity, closeButton: true }),
    ));
  });

  it("lendo o arquivo: a porcentagem na tela, e o Cancelar para a leitura sem criar reunião", async () => {
    duble.cortar.mockImplementation((_arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => {
      opcoes.aoLer?.(50, 100);
      return new Promise((_resolver, rejeitar) => opcoes.sinal?.addEventListener("abort", () => rejeitar(new DOMException("x", "AbortError"))));
    });
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Lendo o arquivo… 50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Andamento do envio do arquivo" })).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Envio cancelado. Nada deste arquivo ficou na WRW."));
    expect(iniciarGravacao()).not.toHaveBeenCalled();
    expect(excluir()).not.toHaveBeenCalled();
  });

  it.each([
    ["passa de 12 h", { ok: false, codigo: "LONGO_DEMAIS" }, "Este áudio passa de 12 horas, o limite de uma reunião."],
    ["está danificado", { ok: false, codigo: "DANIFICADO", formato: "mp4" }, "Não foi possível ler este arquivo: ele parece incompleto ou danificado. Confira se ele abre no seu aparelho e envie de novo."],
    ["não é áudio nem vídeo que se reconheça", { ok: false, codigo: "FORMATO_DESCONHECIDO" }, "Este arquivo não é um áudio ou vídeo que a WRW reconheça. Envie MP3, M4A, MP4, MOV, WAV, OGG, WebM, FLAC ou AAC."],
    ["é um vídeo sem áudio", { ok: false, codigo: "SEM_AUDIO", formato: "mp4" }, "Este vídeo não tem áudio para transcrever."],
    ["passaria de 200 partes", { ok: false, codigo: "MUITAS_PARTES", formato: "wav" }, "Este arquivo é grande demais para uma reunião. Converta-o para MP3 ou M4A, que ocupam menos, e envie de novo."],
  ] as const)("o arquivo que %s é recusado antes de a reunião nascer", async (_caso, corte, aviso) => {
    duble.cortar.mockResolvedValue(corte);
    abrir();
    enviar(arquivoMp3());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(aviso));
    expect(iniciarGravacao()).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(sessaoOcupada()).toBe(false);
  });

  it("o arquivo que não pôde ser lido: o aviso da leitura, sem reunião; o motivo fica no console, para quem atende a dona", async () => {
    const falha = new Error("o arquivo sumiu");
    duble.cortar.mockRejectedValue(falha);
    const consoleDeErro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      abrir();
      enviar(arquivoMp3());
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível ler o arquivo de áudio."));
      expect(iniciarGravacao()).not.toHaveBeenCalled();
      expect(consoleDeErro).toHaveBeenCalledWith(expect.stringContaining("[Importação]"), falha);
    } finally {
      consoleDeErro.mockRestore();
    }
  });

  it("o servidor que recusa criar a reunião: o aviso no idioma da tela, e o formulário volta", async () => {
    iniciarGravacao().mockRejectedValue(new Error(""));
    abrir();
    enviar(arquivoMp3());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível enviar o áudio."));
    expect(duble.enviarParte).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
  });

  it("sem título ou sem a autorização, nada é lido", async () => {
    abrir();
    enviar(arquivoMp3(), "");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Dê um título para a reunião."));
    expect(duble.cortar).not.toHaveBeenCalled();
  });

  it("a reunião da agenda (Gravar agora) fica ligada à reunião que o MP3 criou", async () => {
    abrir(`/gravar?agendada=${AGENDADA}`);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("Conversa com a Bia"));
    enviar(arquivoMp3(), "");
    await waitFor(() => expect(duble.utils.client.agenda.ligarGravacao.mutate).toHaveBeenCalledWith({ id: AGENDADA, meetingId: VINICOLA }));
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalled());
  });

  it("no ?envioUnico=1, a saída de suporte, o MP3 segue no envio único de antes", async () => {
    abrir("/gravar?envioUnico=1");
    enviar(arquivoMp3());
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ meetingId: "reuniao-do-envio-unico", mimeType: "audio/mpeg" })));
    expect(duble.cortar).not.toHaveBeenCalled();
    expect(iniciarGravacao()).not.toHaveBeenCalled();
  });

  it("o M4A, o vídeo e os outros formatos também vão ao corte, e cada parte sobe no tipo que o corte diz (H9b e H9c)", async () => {
    // Um corte de duas partes em MP4 fragmentado: os bytes novos (o começo de cada parte) e os trechos do arquivo.
    const arquivo = new File([Uint8Array.from({ length: 64 }, (_v, i) => i)], "reuniao.mov", { type: "video/quicktime" });
    const corte: CorteDoArquivo = {
      ok: true, formato: "mp4", mimeType: "audio/mp4", duracaoMs: 1500,
      partes: [
        { novos: Uint8Array.from([0xa1, 0xa2]), ordem: Float64Array.from([0, 0, 2, 1, 10, 20]), bytes: 12, duracaoMs: 1000 },
        { novos: Uint8Array.from([0xb1]), ordem: Float64Array.from([0, 0, 1, 1, 20, 24]), bytes: 5, duracaoMs: 500 },
      ],
    };
    duble.cortar.mockResolvedValue(corte);
    encerrarGravacao().mockResolvedValue({ partes: 2 });
    abrir();
    enviar(arquivo);
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 2 }));
    expect(duble.cortar).toHaveBeenCalledWith(arquivo, expect.anything());
    expect(duble.enviarParte.mock.calls.map(c => [c[1], c[3]])).toEqual([[0, "audio/mp4"], [1, "audio/mp4"]]);
    const bytes = async (blob: Blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
    expect(await bytes(duble.enviarParte.mock.calls[0][2] as Blob)).toEqual([0xa1, 0xa2, ...Array.from({ length: 10 }, (_v, i) => 10 + i)]);
    expect(await bytes(duble.enviarParte.mock.calls[1][2] as Blob)).toEqual([0xb1, 20, 21, 22, 23]);
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
  });

  it("o arquivo curto de um formato que o corte não lê segue no envio único de sempre (o Vorbis no WebM)", async () => {
    duble.cortar.mockResolvedValue({ ok: false, codigo: "SEM_SUPORTE", formato: "webm", detalhe: "Vorbis (WebM)" });
    abrir();
    enviar(new File(["som"], "reuniao.webm", { type: "audio/webm" }));
    await waitFor(() => expect(duble.mutacao("submitRecording").mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/webm" })));
    expect(duble.cortar).toHaveBeenCalled();
    expect(iniciarGravacao()).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it.each([
    ["acima de 10 MB (o ALAC do Gravador do iPhone)", new File([new Uint8Array(11 * 1024 * 1024)], "memo.m4a", { type: "audio/x-m4a" }), "ALAC"],
    ["num tipo que o envio único não aceita (o AVI)", new File(["x"], "reuniao.avi", { type: "video/x-msvideo" }), "AVI"],
  ] as const)("o arquivo sem suporte %s recebe o aviso com o formato, sem reunião", async (_caso, arquivo, formato) => {
    duble.cortar.mockResolvedValue({ ok: false, codigo: "SEM_SUPORTE", detalhe: formato });
    abrir();
    enviar(arquivo);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`Este arquivo usa ${formato}, que a WRW ainda não lê. Converta-o para MP3 ou M4A e envie de novo.`));
    expect(iniciarGravacao()).not.toHaveBeenCalled();
    expect(duble.mutacao("submitRecording").mutateAsync).not.toHaveBeenCalled();
  });
});

/**
 * A revisão do pacote 4a: a parte que não chega vai de novo antes da seguinte
 * (o arquivo é a cópia), o fim que falha não convida a mandar o arquivo de
 * novo, a sessão só acaba no Sair, a tela fica acesa durante o envio, e sair
 * de Reuniões no meio não para nem esconde o envio.
 */
describe("Reuniões — o MP3 em partes quando algo falha no meio (revisão do pacote 4a)", () => {
  const FINS = "wrw:fins-de-gravacao-pendentes";
  const SEM_COPIA = "Não foi possível guardar uma cópia da gravação neste aparelho. Ela continua sendo enviada, mas, se a internet cair, um trecho pode se perder.";

  it("a parte que não sobe vai de novo, lida do arquivo, antes de a seguinte entrar, mesmo sem a cópia no aparelho; o fim vai com as 3 partes", async () => {
    duble.guardarParte.mockRejectedValue(new Error("QuotaExceededError"));
    duble.enviarParte.mockResolvedValueOnce({ tipo: "passageira" });
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("A conexão falhou. Tentando enviar de novo a parte 1 de 3…")).toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledWith(SEM_COPIA, expect.anything());
    // A parte 2 não entra enquanto a 1 não chegou: nada vai para o aparelho, nem para o servidor.
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(duble.enviarParte.mock.calls.map(c => c[1])).toEqual([0]);
    expect(screen.getByRole("button", { name: /Cancelar envio/ })).toBeEnabled();
    // A conexão voltou.
    act(() => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(duble.enviarParte.mock.calls.map(c => c[1])).toEqual([0, 0, 1, 2]);
    const bytes = async (indice: number) => new Uint8Array(await (duble.enviarParte.mock.calls[indice][2] as Blob).arrayBuffer());
    expect(await bytes(1)).toEqual(await bytes(0));
    // Sem a cópia no aparelho, o aviso dela sai uma vez; o arquivo inteiro chegou mesmo assim.
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`));
  });

  it("o fim que falha por rede depois de todas as partes: sem o aviso de envio que falhou; o aviso diz que o app termina sozinho, a tela vai ao detalhe e o formulário volta limpo", async () => {
    encerrarGravacao().mockRejectedValue(new TypeError("Failed to fetch"));
    abrir();
    enviar(arquivoMp3());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      "O arquivo foi enviado, mas a confirmação do fim do envio ficou pendente. O app tenta de novo sozinho: não envie o arquivo outra vez.",
      expect.objectContaining({ duration: Infinity, closeButton: true }),
    ));
    expect(toast.error).not.toHaveBeenCalled();
    // O fim ficou guardado, com a conta, e a retomada o declara.
    expect(JSON.parse(localStorage.getItem(FINS)!)).toEqual({ [VINICOLA]: { partes: 3, dona: "dona-1" } });
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${VINICOLA}`));
    expect(duble.utils.meetings.list.invalidate).toHaveBeenCalled();
    // De volta ao gravador: o formulário está limpo, e o arquivo não volta a parecer "por enviar".
    act(() => { window.history.pushState(null, "", "/gravar"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(await screen.findByPlaceholderText(PLACEHOLDER_DO_TITULO)).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("o cache da conta que sai da memória no meio (getData sem nada, e não o null do Sair) não para o envio", async () => {
    const subir = partesPresas();
    duble.utils.auth.me.fetch.mockResolvedValue({ openId: "dona-1" });
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    // Cinco minutos sem nenhuma tela observando o auth.me: o React Query o tira do cache.
    duble.utils.auth.me.getData.mockReturnValue(undefined);
    await subir();
    await subir();
    await subir();
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(duble.enviarParte).toHaveBeenCalledTimes(3);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("o Sair (o cache da conta em null) para o envio sem mandar o resto", async () => {
    const subir = partesPresas();
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    duble.utils.auth.me.getData.mockReturnValue(null);
    await subir();
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
    expect(duble.enviarParte).toHaveBeenCalledTimes(1);
    expect(encerrarGravacao()).not.toHaveBeenCalled();
  });

  it("o servidor que responde que a sessão venceu (401) para o envio, com o aviso", async () => {
    duble.enviarParte.mockResolvedValueOnce({ tipo: "sem-sessao" });
    abrir();
    enviar(arquivoMp3());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("O envio do arquivo parou porque a sessão terminou. Entre de novo, exclua da lista a reunião que ficou incompleta e envie o arquivo outra vez."));
    expect(duble.enviarParte).toHaveBeenCalledTimes(1);
    expect(encerrarGravacao()).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
  });

  it("a reunião excluída em outro aparelho no meio do envio: o aviso da recusa, e o resto do arquivo não sobe", async () => {
    duble.enviarParte.mockResolvedValueOnce({ tipo: "recusada", codigo: "SEM_REUNIAO" });
    abrir();
    enviar(arquivoMp3());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Um trecho da gravação não foi guardado: a reunião foi excluída ou já não recebe áudio.", expect.anything()));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
    expect(duble.enviarParte).toHaveBeenCalledTimes(1);
    expect(encerrarGravacao()).not.toHaveBeenCalled();
    expect(duble.utils.meetings.list.invalidate).toHaveBeenCalled();
  });

  it("a tela fica acesa enquanto o arquivo sobe (Wake Lock) e é solta no fim; com ela garantida, no computador, só a dica de manter o app aberto", async () => {
    const sentinela = { released: false, release: vi.fn(async () => { sentinela.released = true; }) };
    const pedir = vi.fn(async () => sentinela);
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: pedir } });
    const subir = partesPresas();
    abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    await waitFor(() => expect(pedir).toHaveBeenCalledWith("screen"));
    expect(screen.getByText("Mantenha o app aberto até o envio terminar.")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(sentinela.release).not.toHaveBeenCalled();
    await subir();
    await subir();
    await subir();
    await waitFor(() => expect(sentinela.release).toHaveBeenCalled());
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it("no iPhone, mesmo com a tela acesa garantida, o aviso de manter a tela aberta durante o envio", async () => {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ released: false, release: async () => {} }) } });
    const agente = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    try {
      const subir = partesPresas();
      abrir();
      enviar(arquivoMp3());
      expect(await screen.findByRole("note")).toHaveTextContent("se a tela apagar ou você trocar de app, o envio para até você voltar");
      // O envio termina: a sessão não fica ocupada para o teste seguinte.
      await subir();
      await subir();
      await subir();
      await waitFor(() => expect(sessaoOcupada()).toBe(false));
    } finally {
      agente.mockRestore();
    }
  });

  it("sair de Reuniões no meio não para o envio: as partes seguintes sobem, o fim é declarado com o total, a URL não muda e a sessão fica ocupada até o fim", async () => {
    const subir = partesPresas();
    const pagina = abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    pagina.unmount();
    expect(sessaoOcupada()).toBe(true);
    await subir();
    await subir();
    expect(sessaoOcupada()).toBe(true);
    await subir();
    await waitFor(() => expect(encerrarGravacao()).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 3 }));
    expect(duble.enviarParte.mock.calls.map(c => c[1])).toEqual([0, 1, 2]);
    expect(excluir()).not.toHaveBeenCalled();
    // Quem saiu não é levada ao detalhe.
    expect(window.location.pathname).toBe("/gravar");
    await waitFor(() => expect(sessaoOcupada()).toBe(false));
  });

  it("voltar a Reuniões no meio: a tela nova mostra o andamento e o Cancelar da mesma importação, sem deixar mandar o arquivo de novo, e o Cancelar exclui a reunião dela", async () => {
    const subir = partesPresas();
    const pagina = abrir();
    enviar(arquivoMp3());
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    pagina.unmount();
    abrir();
    expect(await screen.findByText("Enviando o arquivo: parte 1 de 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar arquivo de áudio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Iniciar gravação/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    expect(await screen.findByText("Cancelando o envio…")).toBeInTheDocument();
    await subir();
    await waitFor(() => expect(excluir()).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Envio cancelado. Nada deste arquivo ficou na WRW."));
    expect(duble.enviarParte).toHaveBeenCalledTimes(1);
    expect(iniciarGravacao()).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /Enviar arquivo de áudio/ })).toBeInTheDocument());
  });
});
