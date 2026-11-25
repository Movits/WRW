import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { lazy, Suspense, type ComponentType } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Switch } from "wouter";
import i18n from "@/i18n";
import { PageTransition } from "@/components/PageTransition";
import { CODIGO_ERRO_INTERROMPIDO, MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_ERRO_DE_CONSULTA } from "@shared/const";
import { liberarTodas, sessaoOcupada } from "@/lib/sessao-ocupada";
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
    resumoGuardado: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn(async () => undefined) }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      // A gravação em partes, o padrão desde a G13b: ao montar, a página retoma
      // o que ficou no aparelho, e para isso lê a conta e fala com o servidor.
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: { meetings: { iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() },
        // O restaurar do detalhe da reunião que está na lixeira (H7d).
        restaurarDaLixeira: { mutate: vi.fn() },
        // G15a: a transcrição durante a gravação, sem nenhuma parte pronta (função comum: o mockReset do projeto client zeraria um vi.fn).
        transcricaoDaGravacao: { query: async () => ({ status: "recording", emPartes: true, agora: Date.now(), partes: [], falas: [], nomes: {} }) } } },
    },
    // O envio de cada parte da gravação em partes (a rota binária, fora do tRPC).
    enviarParte: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// A gravação em partes: os testes de gravação em curso rodam nos dois modos
// (revisão da G13b), e as partes sobem por aqui, com a cópia no aparelho, que o
// jsdom não tem (sem IndexedDB).
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
vi.mock("@/lib/trpc", () => ({
  trpc: {
    // As equipes da conta e os convites (R2): nenhuma, nesta tela.
    equipes: { minhas: { useQuery: () => ({ data: { equipes: [], convites: [] } }) }, responderConvite: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    useUtils: () => duble.utils,
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
      // As reuniões compartilhadas com a conta e os convites (R1b): nenhum, nesta tela.
      compartilhadasComigo: { useQuery: () => ({ data: { reunioes: [], convites: [] } }) },
      responderConviteDeConexao: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      mandarParaALixeira: duble.registrar("mandarParaALixeira"),
      // A tela da lixeira (?lixeira=1), vazia: o que ela faz está em components/LixeiraDeReunioes.test.tsx.
      lixeira: { useQuery: () => ({ data: [], isLoading: false, isError: false, error: null, refetch: () => undefined, dataUpdatedAt: 0 }) },
      restaurarDaLixeira: duble.registrar("restaurarDaLixeira"),
      apagarDeVez: duble.registrar("apagarDeVez"),
      reprocess: duble.registrar("reprocess"),
      // O vídeo do YouTube (H13): o botão da lista e o "Tentar de novo" do detalhe.
      resumirVideoDoYoutube: duble.registrar("resumirVideoDoYoutube"),
      refazerVideoDoYoutube: duble.registrar("refazerVideoDoYoutube"),
      resumoGuardado: { useQuery: (...args: unknown[]) => duble.resumoGuardado(...args) },
      // R1a: as datas das consultas da administração (nenhuma).
      consultasDaAdministracao: { useQuery: () => ({ data: [], isError: false, error: null, refetch: () => undefined }) },
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
      traduzirResumo: duble.registrar("traduzirResumo"),
      perguntar: duble.registrar("perguntar"),
      perguntarDuranteAGravacao: duble.registrar("perguntarDuranteAGravacao"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
      ligarLinkAberto: duble.registrar("ligarLinkAberto"),
      desligarLinkAberto: duble.registrar("desligarLinkAberto"),
      // A senha e o áudio do link ligado (H23).
      novaSenhaDoLink: duble.registrar("novaSenhaDoLink"),
      tirarSenhaDoLink: duble.registrar("tirarSenhaDoLink"),
      mudarAudioDoLink: duble.registrar("mudarAudioDoLink"),
    },
    reuniaoAberta: {
      pedirResumo: duble.registrar("pedirResumoPeloLink"),
      perguntar: duble.registrar("perguntarPeloLink"),
      traduzirResumo: duble.registrar("traduzirResumoPeloLink"),
    },
    // O "Tentar de novo" do evento da próxima ação que ficou na Google Agenda (H5c): o resumo guardado o monta.
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
    networkInteligente: {
      pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) },
    },
  },
}));

const VINICOLA = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const BIA = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const TITULOS: Record<string, string> = { [VINICOLA]: "Reunião com a vinícola", [BIA]: "Reunião com a Bia" };
const reuniao = (id: string) => ({ id, title: TITULOS[id], status: "ready", processingError: null, createdAt: Date.UTC(2026, 8, 4, 12), updatedAt: Date.UTC(2026, 8, 4, 12) });

/**
 * Os dois endereços do gravador, para os testes de sair da tela com a gravação
 * em curso (revisão da G13b): o /gravar de sempre e o /gravar?envioUnico=1, a
 * saída de suporte da G13b para o envio único de antes. Ela saiu na G14, e a URL
 * antiga que ainda a trouxer grava em partes do mesmo jeito: a reunião nasce no
 * Iniciar, e sair da tela gravando ENTREGA o que foi gravado. A gravação, a
 * revisão e o Transcrever do envio único saíram com ela; o envio de arquivo que
 * sobrou nele (o recuo do corte) está em Meetings.importacao.test.tsx.
 */
const MODOS = [
  { modo: "o /gravar", gravar: "/gravar", lista: "/meetings" },
  { modo: "o ?envioUnico=1 de antes (sem efeito desde a G14)", gravar: "/gravar?envioUnico=1", lista: "/meetings?envioUnico=1" },
] as const;
const ENCERRADA_AO_SAIR = "A gravação foi encerrada ao sair da tela. O que foi gravado segue para a transcrição.";
const FINS = "wrw:fins-de-gravacao-pendentes";
const DESCARTES = "wrw:descartes-de-gravacao-pendentes";
const { iniciarGravacao, encerrarGravacao, delete: excluirReuniao } = duble.utils.client.meetings;

/** O que a gravação em partes pede ao servidor responde, salvo no teste que diz outro. */
function servidorDaGravacaoEmPartes() {
  iniciarGravacao.mutate.mockResolvedValue({ id: VINICOLA });
  encerrarGravacao.mutate.mockResolvedValue({ partes: 1 });
  excluirReuniao.mutate.mockResolvedValue({ success: true });
  duble.enviarParte.mockResolvedValue({ tipo: "recebida" });
  localStorage.removeItem(FINS);
  localStorage.removeItem(DESCARTES);
}

function abrirEm(caminho: string) {
  window.history.replaceState(null, "", caminho);
  return render(<Meetings />);
}

beforeEach(() => {
  // A marca da dica de instalação fica no localStorage, que o setup não limpa:
  // um teste que a fecha a esconderia nos seguintes.
  localStorage.removeItem("mmm:dica-de-instalacao");
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); }
  duble.list.mockReturnValue({ data: [reuniao(VINICOLA), reuniao(BIA)], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockImplementation(({ meetingId }: { meetingId: string }) => ({
    data: { meeting: reuniao(meetingId), transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }));
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  // O resumo guardado da reunião (H4c): sem resumo, salvo o teste que diz outro.
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
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
    expect(screen.getByText(/O áudio fica na sua conta por 30 dias/)).toBeInTheDocument();
  });

  // O foco vai ao último botão antes da dica, logo acima dela. Desde a H12 é o
  // "Resumir um PDF ou fotos de um texto", que fica abaixo do "Enviar arquivo de áudio".
  it("fechar a dica de instalação no gravador devolve o foco ao último botão antes dela, o 'Resumir um PDF ou fotos de um texto'", () => {
    abrirEm("/gravar");
    fireEvent.click(screen.getByRole("button", { name: "Fechar a dica de instalação" }));
    expect(screen.queryByRole("region", { name: "Instale a Marquesa Global Match como app" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resumir um PDF ou fotos de um texto/ })).toHaveFocus();
    expect(localStorage.getItem("mmm:dica-de-instalacao")).toBe("fechada");
  });

  it("a lista não fala mais em reuniões curtas: a gravação em partes vai até 12 h (G13b)", () => {
    abrirEm("/meetings");
    expect(screen.getByText("Grave reuniões com consentimento, revise a transcrição e confirme os contatos sugeridos.")).toBeInTheDocument();
    expect(screen.queryByText(/reuniões curtas/)).not.toBeInTheDocument();
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
    expect(screen.getByText("Mandar esta reunião para a lixeira?")).toBeInTheDocument();
    act(() => window.history.pushState(null, "", `/meetings/${BIA}`));
    expect(screen.getByText("Reunião com a Bia")).toBeInTheDocument();
    expect(screen.queryByText("Mandar esta reunião para a lixeira?")).not.toBeInTheDocument();
  });

  it("a lixeira (H7d) é a lista com ?lixeira=1: abre a tela dela, e o voltar dela leva à lista", async () => {
    abrirEm("/meetings");
    fireEvent.click(screen.getByRole("button", { name: "Lixeira" }));
    expect(window.location.pathname).toBe("/meetings");
    expect(window.location.search).toBe("?lixeira=1");
    expect(await screen.findByRole("heading", { name: "Lixeira" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nova reunião/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Voltar às reuniões/ }));
    expect(window.location.search).toBe("");
    expect(await screen.findByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
  });

  it("a reunião da dona que está na lixeira, aberta pelo endereço (favorito ou histórico): a tela diz que está na lixeira, restaura ali mesmo e leva à lixeira", async () => {
    // A guarda da lixeira devolve NOT_FOUND com o código dela (server/guarda-da-lixeira.ts).
    duble.get.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "REUNIAO_NA_LIXEIRA", data: { code: "NOT_FOUND" } }, refetch: vi.fn() });
    duble.utils.client.meetings.restaurarDaLixeira.mutate.mockResolvedValue({ restauradas: 1 });
    abrirEm(`/meetings/${VINICOLA}`);
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent("Esta reunião está na lixeira.");
    expect(aviso).toHaveTextContent("Ela fica na lixeira por 30 dias desde que foi para lá.");
    expect(aviso).not.toHaveTextContent("Reunião não encontrada");

    await act(async () => { fireEvent.click(within(aviso).getByRole("button", { name: "Restaurar" })); });
    expect(duble.utils.client.meetings.restaurarDaLixeira.mutate).toHaveBeenCalledWith({ meetingIds: [VINICOLA] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Reunião restaurada."));
    // Restaurada, a reunião abre aqui mesmo: o detalhe é relido.
    await waitFor(() => expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: VINICOLA }));

    // O outro caminho: a lixeira, pelo endereço dela.
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Lixeira" }));
    expect(window.location.search).toBe("?lixeira=1");
    expect(await screen.findByRole("heading", { name: "Lixeira" })).toBeInTheDocument();
  });

  it("a reunião que não existe, ou de outra conta, continua 'não encontrada', sem o restaurar", () => {
    duble.get.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } }, refetch: vi.fn() });
    abrirEm(`/meetings/${VINICOLA}`);
    expect(screen.getByRole("alert")).toHaveTextContent("Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta.");
    expect(screen.queryByRole("button", { name: "Restaurar" })).not.toBeInTheDocument();
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
    servidorDaGravacaoEmPartes();
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

  it.each(MODOS)("$modo: sair de /gravar gravando pelo menu devolve a URL ao gravador, avisa e não deixa o véu preto preso", async ({ gravar }) => {
    abrirComTransicao(gravar);
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
    // Ela leva a busca de quando a gravação começou (urlDaGravacao, H16a): o
    // ?envioUnico=1 de antes fica, sem efeito.
    expect(trocar.mock.calls.some(chamada => chamada[2] === gravar)).toBe(true);
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
    // O Encerrar entrega a gravação inteira: a última parte e o fim.
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
  });

  it.each(MODOS)("$modo: ir a uma reunião (/meetings/:id) gravando também devolve a URL ao gravador, com o microfone aberto", async ({ gravar }) => {
    abrirEm(gravar);
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

  it.each(MODOS)("$modo: sair de Reuniões gravando, para outra tela, desmonta a página e fecha o microfone", async ({ gravar }) => {
    const { unmount } = abrirEm(gravar);
    await comecarAGravar();
    expect(trilha.stop).not.toHaveBeenCalled();
    unmount();
    expect(trilha.stop).toHaveBeenCalled();
    // Sair ENTREGA como o Encerrar (revisão da G13b): a última parte sobe, o fim
    // é declarado, e o aviso fica até ser fechado, porque a dona já está em
    // outra tela. Nada é excluído. O ?envioUnico=1 de antes, que descartava, saiu
    // na G14: a URL antiga entrega do mesmo jeito.
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    expect(toast.info).toHaveBeenCalledWith(ENCERRADA_AO_SAIR, { id: "gravacao-encerrada-ao-sair", duration: Infinity, closeButton: true });
    expect(excluirReuniao.mutate).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINS)).toBeNull();
    expect(duble.mutacoes.submitRecording?.mutateAsync).not.toHaveBeenCalled();
  });

  it("em partes, a página que sai pelo fim da sessão (o Sair mesmo assim, excluir a conta) descarta como antes: nada sobe, nada avisa e a sessão não volta a ficar ocupada", async () => {
    const { unmount } = abrirEm("/gravar");
    await comecarAGravar();
    // O logout zera a conta no cache e solta as ocupações antes de a página sair.
    vi.spyOn(duble.utils.auth.me, "getData").mockReturnValue(null as unknown as { openId: string });
    act(() => liberarTodas());
    unmount();
    expect(trilha.stop).toHaveBeenCalled();
    await act(async () => { await new Promise(resolver => setTimeout(resolver, 10)); });
    expect(duble.enviarParte).not.toHaveBeenCalled();
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(sessaoOcupada()).toBe(false);
  });

  it("em partes, o fim que falha depois de sair da tela fica guardado, e a retomada o declara quando a dona volta a Reuniões (revisão da G13b)", async () => {
    encerrarGravacao.mutate.mockRejectedValueOnce(new Error("rede")).mockResolvedValue({ partes: 1 });
    const { unmount } = abrirEm("/gravar");
    await comecarAGravar();
    unmount();
    expect(trilha.stop).toHaveBeenCalled();
    // Com a conta que gravou (G13c): só ela o declara de novo.
    await waitFor(() => expect(JSON.parse(localStorage.getItem(FINS) ?? "{}")).toEqual({ [VINICOLA]: { partes: 1, dona: "dona-1" } }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), expect.any(String));
    // A dona volta a Reuniões: a retomada declara o fim guardado.
    abrirEm("/meetings");
    await waitFor(() => expect(localStorage.getItem(FINS)).toBeNull());
    expect(encerrarGravacao.mutate).toHaveBeenLastCalledWith({ meetingId: VINICOLA, partes: 1 });
  });

  it("em partes, sair da tela com o Iniciar esperando o servidor criar a reunião: ela é excluída quando nasce, nenhuma parte sobe e o microfone nem é pedido (revisão da G13b)", async () => {
    let criar: (reuniao: { id: string }) => void = () => {};
    iniciarGravacao.mutate.mockImplementation(() => new Promise(resolver => { criar = resolver; }));
    const pedirMicrofone = vi.fn(async () => ({ getTracks: () => [trilha] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    const { unmount } = abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    expect(iniciarGravacao.mutate).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { criar({ id: VINICOLA }); });
    await waitFor(() => expect(excluirReuniao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    // Nada fica aberto: o pedido de permissão do microfone não aparece em outra tela.
    expect(pedirMicrofone).not.toHaveBeenCalled();
    expect(trilha.stop).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(localStorage.getItem(DESCARTES)).toBeNull();
  });

  it.each(MODOS)("$modo: o voltar do navegador durante a gravação também volta ao gravador, sem véu preso", async ({ lista }) => {
    abrirComTransicao(lista);
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

  it("a dica de instalação fica abaixo dos botões, invisível no mesmo lugar enquanto grava, e volta quando a gravação é descartada", async () => {
    abrirEm("/gravar");
    const dica = () => screen.queryByRole("region", { name: "Instale a Marquesa Global Match como app" });
    // Pelo título, e não pela primeira seção: gravando, o texto das partes já
    // transcritas (G15a) também é uma seção, acima da dica.
    const secaoDaDica = () => Array.from(document.querySelectorAll<HTMLElement>("section[aria-labelledby]")).find(secao => secao.textContent?.includes("Instale a Marquesa Global Match como app"));
    expect(dica()).toBeInTheDocument();
    const enviar = screen.getByRole("button", { name: /Enviar arquivo de áudio/ });
    expect(enviar.compareDocumentPosition(dica()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await comecarAGravar();
    // Gravando: fora do leitor de tela e do teclado, mas no mesmo lugar. No
    // computador o cartão é centralizado, e tirá-la deslocaria o "Encerrar gravação".
    expect(dica()).not.toBeInTheDocument();
    expect(secaoDaDica()).toHaveStyle({ visibility: "hidden" });
    // Desde a G14 não há a revisão do áudio antes de enviar (era do envio único,
    // que saiu do gravador): o Descartar da gravação em partes devolve o
    // gravador vazio, com a dica.
    fireEvent.click(screen.getByRole("button", { name: "Descartar gravação" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Descartar gravação" })); });
    expect(await screen.findByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(dica()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Transcrever áudio/ })).not.toBeInTheDocument();
  });

  it("título de uma letra não abre o microfone nem cria a reunião: o aviso diz a regra do servidor, e o campo para em 200", async () => {
    const pedirMicrofone = vi.fn(async () => ({ getTracks: () => [trilha] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    abrirEm("/gravar");
    const campo = screen.getByPlaceholderText("Ex.: Conversa com investidor");
    expect(campo).toHaveAttribute("maxLength", "200");
    fireEvent.change(campo, { target: { value: "X" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    expect(toast.error).toHaveBeenCalledWith("O título precisa ter de 2 a 200 caracteres.");
    expect(screen.queryByRole("button", { name: /Encerrar gravação/ })).not.toBeInTheDocument();
    expect(iniciarGravacao.mutate).not.toHaveBeenCalled();
    expect(pedirMicrofone).not.toHaveBeenCalled();
  });

  it("o navegador que grava mp4 (Safari do iPhone, Chrome novo) manda as partes da reunião em mp4, e não no webm que o Gemini errava", async () => {
    const pedidos: Array<string | undefined> = [];
    vi.stubGlobal("MediaRecorder", class extends GravadorFalso {
      static isTypeSupported = (tipo: string) => tipo.startsWith("audio/mp4") || tipo.startsWith("audio/webm");
      constructor(_fluxo?: unknown, opcoes?: { mimeType?: string }) {
        super();
        pedidos.push(opcoes?.mimeType);
        this.mimeType = opcoes?.mimeType ?? "audio/webm";
      }
    });
    abrirEm("/gravar");
    await comecarAGravar();
    expect(pedidos.length).toBeGreaterThan(0);
    expect(new Set(pedidos)).toEqual(new Set(["audio/mp4;codecs=mp4a.40.2"]));
    fireEvent.click(screen.getByRole("button", { name: /Encerrar gravação/ }));
    await waitFor(() => expect(encerrarGravacao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA, partes: 1 }));
    expect(duble.enviarParte).toHaveBeenCalledWith(VINICOLA, 0, expect.any(Blob), "audio/mp4");
    expect(trilha.stop).toHaveBeenCalled();
  });

  it.each(MODOS)("$modo: o microfone que chega depois de a página sair é solto na hora, sem gravar", async ({ gravar }) => {
    let entregar: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    const pedirMicrofone = vi.fn(() => new Promise(resolver => { entregar = resolver; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    const criar = vi.spyOn(GravadorFalso.prototype, "start");
    const { unmount } = abrirEm(gravar);
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    // Em partes, o microfone é pedido depois de o servidor criar a reunião.
    await waitFor(() => expect(pedirMicrofone).toHaveBeenCalled());
    unmount();
    await act(async () => { entregar({ getTracks: () => [trilha] }); });
    expect(trilha.stop).toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
    // Nada foi gravado: não há o que entregar, nem aviso de gravação encerrada.
    expect(toast.info).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
    expect(encerrarGravacao.mutate).not.toHaveBeenCalled();
    // A reunião vazia desta tentativa sai.
    await waitFor(() => expect(excluirReuniao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
  });

  it.each(MODOS)("$modo: o microfone que chega depois de a dona ir do gravador à lista (a mesma página) é solto, sem gravar nem puxá-la de volta", async ({ gravar }) => {
    let entregar: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    const pedirMicrofone = vi.fn(() => new Promise(resolver => { entregar = resolver; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    const iniciar = vi.spyOn(GravadorFalso.prototype, "start");
    abrirEm(gravar);
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    await waitFor(() => expect(pedirMicrofone).toHaveBeenCalled());
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { entregar({ getTracks: () => [trilha] }); });
    expect(trilha.stop).toHaveBeenCalled();
    expect(iniciar).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/meetings");
    expect(screen.getByRole("button", { name: /Nova reunião/ })).toBeInTheDocument();
    expect(toast.info).not.toHaveBeenCalled();
    // A reunião vazia desta tentativa sai.
    await waitFor(() => expect(excluirReuniao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
    // De volta ao gravador, ele está livre para gravar.
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).not.toBeDisabled();
  });

  it("o servidor recusa criar a reunião no Iniciar e o erro vem sem mensagem: o aviso da gravação sai com a frase genérica, sem id, e o microfone nem é pedido", async () => {
    iniciarGravacao.mutate.mockRejectedValue(new Error(""));
    const pedirMicrofone = vi.fn(async () => ({ getTracks: () => [trilha] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
    // Um argumento só: sem reunião criada, o aviso não leva o id da reunião.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("meetings.sendRecordingError")));
    expect(toast.error).not.toHaveBeenCalledWith("");
    expect(pedirMicrofone).not.toHaveBeenCalled();
    expect(duble.enviarParte).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeEnabled();
    expect(screen.getByRole("checkbox")).not.toBeDisabled();
  });

  it.each(MODOS)("$modo: vários toques no menu durante a gravação dão um aviso só, com o mesmo id", async ({ gravar }) => {
    abrirEm(gravar);
    await comecarAGravar();
    for (let i = 0; i < 3; i++) act(() => window.history.pushState(null, "", "/meetings"));
    expect(window.location.pathname).toBe("/gravar");
    const avisos = vi.mocked(toast.info).mock.calls;
    expect(avisos).toHaveLength(3);
    for (const chamada of avisos) expect(chamada).toEqual(["Encerre a gravação antes de sair do gravador.", { id: "gravacao-em-curso" }]);
  });

  it.each(MODOS)("$modo: o microfone negado depois de a dona ir à lista não avisa fora do gravador nem fica guardado para a volta", async ({ gravar }) => {
    let negar: (erro: unknown) => void = () => {};
    const pedirMicrofone = vi.fn(() => new Promise((_resolver, rejeitar) => { negar = rejeitar; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    abrirEm(gravar);
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
    await waitFor(() => expect(pedirMicrofone).toHaveBeenCalled());
    act(() => window.history.pushState(null, "", "/meetings"));
    await act(async () => { negar(new DOMException("negado", "NotAllowedError")); });
    expect(toast.error).not.toHaveBeenCalled();
    // A reunião vazia desta tentativa sai.
    await waitFor(() => expect(excluirReuniao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
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

  it("com o banco fora do ar no Iniciar, o aviso da gravação sai no idioma da tela, e não na frase do servidor em português", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    iniciarGravacao.mutate.mockRejectedValue(new Error(MENSAGEM_BANCO_INDISPONIVEL));
    abrirEm("/gravar");
    fireEvent.change(screen.getByPlaceholderText(i18n.t("meetings.titlePlaceholder")), { target: { value: "Talk with Bia" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("meetings.startRecording")) })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t("errors.databaseUnavailable")));
    expect(i18n.t("errors.databaseUnavailable")).not.toBe(MENSAGEM_BANCO_INDISPONIVEL);
  });

});

describe("Reuniões — excluir, voltar à lista e link inválido", () => {
  it("mandar para a lixeira volta à lista trocando o histórico: o voltar não reabre a reunião que saiu", async () => {
    const trocar = vi.spyOn(window.history, "replaceState");
    abrirEm(`/meetings/${VINICOLA}`);
    trocar.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mandar para a lixeira" }));
    expect(duble.mutacoes.mandarParaALixeira.mutate).toHaveBeenCalledWith({ meetingIds: [VINICOLA] });
    await act(async () => { await duble.mutacoes.mandarParaALixeira.opcoes.onSuccess?.({ naLixeira: 1, linksDesligados: 0 }, { meetingIds: [VINICOLA] }); });
    expect(window.location.pathname).toBe("/meetings");
    expect(trocar.mock.calls.some(chamada => chamada[2] === "/meetings")).toBe(true);
  });

  it("a ida para a lixeira que termina depois de a pessoa sair do detalhe não a puxa de volta", async () => {
    abrirEm(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mandar para a lixeira" }));
    const aoTerminar = duble.mutacoes.mandarParaALixeira.opcoes.onSuccess;
    act(() => window.history.pushState(null, "", "/gravar"));
    await act(async () => { await aoTerminar?.({ naLixeira: 1, linksDesligados: 0 }, { meetingIds: [VINICOLA] }); });
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

  it("a ida para a lixeira que termina com o detalhe escondido (a dona foi a uma tela que ainda carrega) não a leva à lista", async () => {
    abrirNoApp(`/meetings/${VINICOLA}`);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mandar para a lixeira" }));
    act(() => window.history.pushState(null, "", "/memory"));
    expect(screen.getByText("Carregando a tela…")).toBeInTheDocument();
    expect(screen.getByText("Reunião com a vinícola")).not.toBeVisible();
    await act(async () => { await duble.mutacoes.mandarParaALixeira.opcoes.onSuccess?.({ naLixeira: 1, linksDesligados: 0 }, { meetingIds: [VINICOLA] }); });
    expect(window.location.pathname).toBe("/memory");
  });

  it.each(MODOS)("$modo: o microfone que o navegador entrega com a página escondida é solto na hora, sem gravar", async ({ gravar }) => {
    servidorDaGravacaoEmPartes();
    let entregarMicrofone: (fluxo: unknown) => void = () => {};
    const trilha = { stop: vi.fn() };
    const iniciar = vi.fn();
    const pedirMicrofone = vi.fn(() => new Promise(resolver => { entregarMicrofone = resolver; }));
    const microfoneOriginal = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() { return true; }
      state = "inactive";
      ondataavailable = null;
      onstop = null;
      start() { iniciar(); }
      stop() {}
    });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: pedirMicrofone } });
    try {
      const { entregarTela } = abrirNoApp(gravar);
      fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Conversa com a Bia" } });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ }));
      // Em partes, o microfone é pedido depois de o servidor criar a reunião.
      await waitFor(() => expect(pedirMicrofone).toHaveBeenCalled());
      // O pedido do microfone ainda aberto quando a dona vai a uma tela que ainda carrega.
      act(() => window.history.pushState(null, "", "/memory"));
      expect(screen.getByText("Carregando a tela…")).toBeInTheDocument();
      await act(async () => { entregarMicrofone({ getTracks: () => [trilha] }); });
      expect(trilha.stop).toHaveBeenCalled();
      expect(iniciar).not.toHaveBeenCalled();
      // A reunião vazia desta tentativa sai, e nada sobe.
      await waitFor(() => expect(excluirReuniao.mutate).toHaveBeenCalledWith({ meetingId: VINICOLA }));
      expect(duble.enviarParte).not.toHaveBeenCalled();
      await entregarTela();
      expect(await screen.findByRole("heading", { name: "Memória" })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/memory");
      // Nada gravava quando a página saiu de vez: nenhum aviso de gravação encerrada.
      expect(toast.info).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (microfoneOriginal) Object.defineProperty(navigator, "mediaDevices", microfoneOriginal);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });
});
