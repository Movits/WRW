import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import Meetings from "./Meetings";
import { VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO } from "@shared/aviso-do-documento";

/**
 * A reunião que nasce de um documento (H12 e H12b) na tela de Reuniões: o
 * gravador ganha o "Resumir um PDF ou fotos de um texto", com o aviso e a
 * autorização do documento no lugar dos da gravação; a lista marca o
 * documento; e o detalhe troca o player e a transcrição pela aba "Texto do
 * documento" e acrescenta a aba "Páginas", com o arquivo guardado pela regra
 * dos 30 dias do áudio. As falhas da leitura chegam como código e saem no
 * idioma da tela.
 *
 * O tRPC é o dublê de Meetings.test.tsx (cada useMutation registra o mutate);
 * a aba das páginas vira um marcador (o leitor de PDF está em
 * components/PaginasDoDocumento.test.tsx), e o envio binário também (em
 * lib/envio-do-documento.test.ts). O jsdom não mede layout: a 375 px o que se
 * prova são as classes que fazem caber.
 */

type Opcoes = { onSuccess?: (data: unknown, vars: unknown) => void; onError?: (erro: unknown, vars: unknown) => void; onSettled?: () => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn>; mutateAsync: ReturnType<typeof vi.fn>; data?: unknown }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn(), mutateAsync: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, mutateAsync: m.mutateAsync, isPending: false, data: m.data };
    },
  });
  return {
    mutacoes,
    registrar,
    list: vi.fn(),
    get: vi.fn(),
    pendencias: vi.fn(),
    resumoGuardado: vi.fn(),
    conexoes: vi.fn(),
    candidatos: vi.fn(),
    buscaNaRede: vi.fn(),
    enviarDocumento: vi.fn(),
    excluirPeloCliente: vi.fn(),
    paginas: vi.fn(),
    mapa: vi.fn(),
    painelDoEmail: vi.fn(),
    utils: {
      meetings: { list: { invalidate: vi.fn() }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() }, conexoes: { invalidate: vi.fn() } },
      auth: { me: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      client: { meetings: { delete: { mutate: vi.fn() } } },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/useGravacaoEmPartes", () => ({
  PARTE_SEGUNDOS: 600,
  useGravacaoEmPartes: () => ({ iniciar: vi.fn(), cancelar: vi.fn(), descartar: vi.fn(), receberParte: vi.fn(), enviando: false }),
}));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      list: { useQuery: (...args: unknown[]) => duble.list(...args) },
      get: { useQuery: (...args: unknown[]) => duble.get(...args) },
      create: duble.registrar("create"),
      iniciarDocumento: duble.registrar("iniciarDocumento"),
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
      conexoes: { useQuery: (...args: unknown[]) => duble.conexoes(...args) },
      candidatosParaVincular: { useQuery: (...args: unknown[]) => duble.candidatos(...args) },
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      traduzirResumo: duble.registrar("traduzirResumo"),
      editarItemDoResumo: duble.registrar("editarItemDoResumo"),
      acrescentarItemDoResumo: duble.registrar("acrescentarItemDoResumo"),
      perguntar: duble.registrar("perguntar"),
      perguntarDuranteAGravacao: duble.registrar("perguntarDuranteAGravacao"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
      ligarLinkAberto: duble.registrar("ligarLinkAberto"),
      desligarLinkAberto: duble.registrar("desligarLinkAberto"),
      // A senha e o áudio do link ligado (H23), que o painel do Compartilhar monta.
      novaSenhaDoLink: duble.registrar("novaSenhaDoLink"),
      tirarSenhaDoLink: duble.registrar("tirarSenhaDoLink"),
      mudarAudioDoLink: duble.registrar("mudarAudioDoLink"),
      exportar: duble.registrar("exportar"),
      // O resumo por e-mail (H22): o painel só pede ao servidor quando a dona o abre.
      resumoPorEmail: { useQuery: (...args: unknown[]) => duble.painelDoEmail(...args) },
      mandarResumoPorEmail: duble.registrar("mandarResumoPorEmail"),
      mandarResumoPorEmailDeNovo: duble.registrar("mandarResumoPorEmailDeNovo"),
      envioAutomaticoDoResumo: duble.registrar("envioAutomaticoDoResumo"),
    },
    reuniaoAberta: {
      pedirResumo: duble.registrar("pedirResumoPeloLink"),
      perguntar: duble.registrar("perguntarPeloLink"),
      traduzirResumo: duble.registrar("traduzirResumoPeloLink"),
    },
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
    networkInteligente: {
      pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) },
      confirmarPendencia: duble.registrar("confirmarPendencia"),
      ignorarPendencia: duble.registrar("ignorarPendencia"),
    },
    network: { list: { useQuery: (...args: unknown[]) => duble.buscaNaRede(...args) } },
  },
}));
vi.mock("@/components/MapaMental", () => ({ MapaMentalDaReuniao: (props: Record<string, unknown>) => { duble.mapa(props); return <div data-testid="mapa-mental"/>; } }));
vi.mock("@/lib/envio-do-documento", () => ({ enviarDocumento: (...args: unknown[]) => duble.enviarDocumento(...args) }));
// A aba das páginas: um marcador que mostra o que recebeu.
vi.mock("@/components/PaginasDoDocumento", () => ({
  PaginasDoDocumento: (props: { meetingId: string; documento: { url: string } | null; documentoExpirado: boolean; documentoSaindo: boolean }) => {
    duble.paginas(props);
    return <div data-testid="paginas-do-documento">{props.meetingId} | {props.documento?.url ?? "sem arquivo"}</div>;
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const DIA = 24 * 60 * 60_000;
const DOCUMENTO = { url: `/manus-storage/meetings/dona/${ID}/documento-abcd1234.pdf`, mimeType: "application/pdf", sizeBytes: 123_456, expiresAt: Date.UTC(2026, 11, 20, 12) };
const REUNIAO = {
  id: ID, ownerId: "dona", title: "Proposta da feira", status: "ready", processingError: null as string | null,
  createdAt: Date.UTC(2026, 10, 20, 12), updatedAt: Date.UTC(2026, 10, 20, 12),
  audioPipeline: "single" as const, expectedSlices: null as number | null, origem: "pdf" as string | null,
};
const TRANSCRICAO = {
  id: "t1", language: "pt-BR",
  transcript: "Proposta de exportação de café para Lisboa.\n\nContato: Ana Souza.",
  segments: [{ pagina: 1, texto: "Proposta de exportação de café para Lisboa." }, { pagina: 2, texto: "" }, { pagina: 3, texto: "Contato: Ana Souza." }],
};

type Detalhe = { transcript: unknown; documento: unknown; documentoExpirado: boolean; documentoSaindo: boolean };
function abrirDetalhe(reuniao: Partial<typeof REUNIAO> = {}, detalhe: Partial<Detalhe> = {}) {
  const meeting = { ...REUNIAO, ...reuniao };
  duble.list.mockReturnValue({ data: [meeting], isLoading: false });
  duble.get.mockReturnValue({
    data: {
      meeting, transcript: TRANSCRICAO, entities: [], suggestions: [], recording: null, recordingExpired: false, recordingDeletionPending: false,
      andamento: null, documento: DOCUMENTO, documentoExpirado: false, documentoSaindo: false, ...detalhe,
    },
    isLoading: false,
  });
  const tela = render(<Meetings />);
  fireEvent.click(screen.getByRole("button", { name: /Proposta da feira/ }));
  return tela;
}

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); m.data = undefined; }
  duble.enviarDocumento.mockReset();
  duble.paginas.mockReset();
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.conexoes.mockReturnValue({ data: undefined, isError: false, error: null, refetch: vi.fn() });
  duble.candidatos.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });
  duble.buscaNaRede.mockReturnValue({ data: undefined, isError: false, error: null, refetch: vi.fn() });
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() });
  duble.painelDoEmail.mockReset();
  duble.painelDoEmail.mockReturnValue({ data: undefined, isPending: true, isLoading: true, isError: false, error: null, refetch: vi.fn() });
  // O detalhe aberto depois do envio, antes de o teste dizer o que ele mostra.
  duble.get.mockReturnValue({ data: undefined, isLoading: true });
  window.history.replaceState(null, "", "/meetings");
});
afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("O gravador: resumir um PDF ou fotos de um texto", () => {
  function abrirGravador() {
    duble.list.mockReturnValue({ data: [], isLoading: false });
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
  }

  it("o botão troca o microfone pelo documento, com o aviso e a autorização dele, e volta", () => {
    abrirGravador();
    expect(screen.getByText(/Confirmo que todas as pessoas participantes autorizaram a gravação/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resumir um PDF ou fotos de um texto" }));
    // O aviso e a caixa da gravação saem; ficam os do documento.
    expect(screen.queryByText(/Confirmo que todas as pessoas participantes autorizaram a gravação/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Iniciar gravação/ })).not.toBeInTheDocument();
    expect(screen.getByText(/O arquivo é lido pela IA do Google \(Gemini\)/)).toBeInTheDocument();
    expect(screen.getByText("Confirmo que posso usar este documento e autorizo o tratamento privado dele pela IA para gerar o resumo.")).toBeInTheDocument();
    // O título e o idioma continuam os do gravador.
    expect(screen.getByPlaceholderText("Ex.: Conversa com investidor")).toBeInTheDocument();
    expect(screen.getByLabelText("Idioma da reunião")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Voltar para a gravação/ }));
    expect(screen.getByRole("button", { name: /Iniciar gravação/ })).toBeInTheDocument();
  });

  it("o PDF enviado cria a reunião com o título, o idioma e a versão do aviso do documento, e a tela vai ao detalhe", async () => {
    abrirGravador();
    duble.mutacoes.iniciarDocumento?.mutateAsync.mockResolvedValue({ id: ID });
    fireEvent.click(screen.getByRole("button", { name: "Resumir um PDF ou fotos de um texto" }));
    duble.mutacoes.iniciarDocumento.mutateAsync.mockResolvedValue({ id: ID });
    duble.enviarDocumento.mockResolvedValue({ tipo: "recebido", repetido: false });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: "Contrato da exportadora" } });
    fireEvent.change(screen.getByLabelText("Idioma da reunião"), { target: { value: "es" } });
    const arquivo = new File(["%PDF-1.7\n%%EOF\n"], "contrato.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("entrada-do-pdf"), { target: { files: [arquivo] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar para resumir" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${ID}`));
    expect(duble.mutacoes.iniciarDocumento.mutateAsync).toHaveBeenCalledWith({
      title: "Contrato da exportadora", language: "es", consentGranted: true, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf",
    });
    expect(duble.enviarDocumento).toHaveBeenCalledWith(ID, arquivo);
    // Nada do caminho do áudio.
    expect(duble.mutacoes.create?.mutateAsync ?? vi.fn()).not.toHaveBeenCalled();
  });

  it("sem título: o aviso do título do gravador, e nada nasce", async () => {
    abrirGravador();
    fireEvent.click(screen.getByRole("button", { name: "Resumir um PDF ou fotos de um texto" }));
    fireEvent.change(screen.getByTestId("entrada-do-pdf"), { target: { files: [new File(["%PDF-1.7"], "a.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar para resumir" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dê um título para a reunião.");
    expect(duble.mutacoes.iniciarDocumento?.mutateAsync ?? vi.fn()).not.toHaveBeenCalled();
  });
});

describe("A lista: o documento é marcado e diz que recebe o documento", () => {
  it("o ícone do documento ao lado do título e o status do documento", () => {
    duble.list.mockReturnValue({ data: [{ ...REUNIAO, status: "uploading" }, { ...REUNIAO, id: "a2", title: "Reunião de áudio", origem: null, status: "uploading" }], isLoading: false });
    render(<Meetings />);
    const documento = screen.getByRole("button", { name: /Proposta da feira/ });
    expect(within(documento).getByLabelText("Documento")).toBeInTheDocument();
    expect(documento).toHaveTextContent("Recebendo o documento");
    const audio = screen.getByRole("button", { name: /Reunião de áudio/ });
    expect(within(audio).queryByLabelText("Documento")).not.toBeInTheDocument();
    expect(audio).toHaveTextContent("Recebendo o áudio");
  });
});

describe("O detalhe da reunião de documento", () => {
  it("as abas trocam a transcrição pelo texto do documento e acrescentam as páginas; não há player", () => {
    const { container } = abrirDetalhe();
    const barra = container.querySelector<HTMLElement>("div.overflow-x-auto.border-b")!;
    expect(within(barra).getAllByRole("button").map(aba => aba.textContent)).toEqual(["Resumo", "Texto do documento", "Páginas", "Mapa mental", "Contatos (0)"]);
    expect(screen.queryByRole("button", { name: "Transcrição" })).not.toBeInTheDocument();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByText("Gravação")).not.toBeInTheDocument();
    // O arquivo, no resumo: até quando fica e o atalho para as páginas.
    expect(screen.getByRole("heading", { name: "Arquivo" })).toBeInTheDocument();
    expect(screen.getByText("Arquivo guardado até 20/12/2026.")).toBeInTheDocument();
    expect(screen.getByText(/O link de compartilhamento mostra o texto e o resumo, nunca o arquivo/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Páginas" }).at(-1)!);
    expect(screen.getByTestId("paginas-do-documento")).toHaveTextContent(`${ID} | ${DOCUMENTO.url}`);
  });

  it("compartilhar: o painel diz que o link mostra o texto e o resumo, nunca o arquivo, e a prova guarda a frase do documento", () => {
    abrirDetalhe();
    expect(screen.getByText("Quem receber o link lê o texto do documento e pede à IA o resumo e respostas sobre ele, sem precisar de conta na WRW. O arquivo não sai pelo link. Excluir e reprocessar continuam só com você.")).toBeInTheDocument();
    expect(screen.queryByText(/ouve a gravação/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    const frase = "Confirmo que posso compartilhar este documento e autorizo que quem receber o link leia o texto lido dele e o resumo, sem o arquivo.";
    fireEvent.click(screen.getByRole("checkbox", { name: frase }));
    fireEvent.click(screen.getByRole("button", { name: "Criar link" }));
    expect(duble.mutacoes.ligarLinkAberto.mutate).toHaveBeenCalledWith(expect.objectContaining({ meetingId: ID, autorizacaoDasPessoas: true, textoExibido: frase, idioma: "pt-BR" }));
  });

  // A junção do Pacote 4c com o 4d: o detalhe montava o resumo por e-mail (H22)
  // sem dizer que a reunião é de documento, e o painel pedia a caixa da gravação
  // (a frase que vai para a prova) e prometia a gravação na prévia.
  it("o resumo por e-mail: a caixa e a prova são a frase do documento, e a prévia não fala de gravação", () => {
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, modelo: "geral", versaoAnterior: false, itens: [] }, isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() });
    duble.painelDoEmail.mockReturnValue({
      data: { idioma: "pt-BR", linkLigado: false, emailDaDona: "glenda@exemplo.invalid", nomeDaDona: "Glenda", automatico: false, participantes: [], envios: [], podeMandarDeNovo: false },
      isPending: false, isError: false, error: null,
    });
    abrirDetalhe();
    fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
    const painel = screen.getByRole("region", { name: "Mandar o resumo por e-mail" });
    expect(within(painel).getByText("Glenda compartilhou com você o resumo de “Proposta da feira”, feito na WRW.")).toBeInTheDocument();
    expect(within(painel).getByText("Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na WRW.")).toBeInTheDocument();
    expect(painel.textContent).not.toMatch(/gravaç|gravad|gravou|todas as pessoas que falaram/i);
    const frase = "Confirmo que posso compartilhar este documento e autorizo que quem receber o link leia o texto lido dele e o resumo, sem o arquivo.";
    fireEvent.click(within(painel).getByRole("checkbox", { name: /Para mim/ }));
    fireEvent.click(within(painel).getByRole("checkbox", { name: frase }));
    fireEvent.click(within(painel).getByRole("button", { name: "Mandar o resumo" }));
    expect(duble.mutacoes.mandarResumoPorEmail.mutate).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: ID, paraMim: true, autorizacao: expect.objectContaining({ textoExibido: frase, idioma: "pt-BR" }),
    }));
  });

  it("a aba do texto mostra o documento página a página, com a página sem texto", () => {
    abrirDetalhe();
    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getByRole("heading", { level: 2, name: "Texto do documento" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map(titulo => titulo.textContent)).toEqual(["Página 1", "Página 2", "Página 3"]);
    expect(screen.getByText("A IA não encontrou texto legível nesta página.")).toBeInTheDocument();
    expect(screen.getByText("Escolha um idioma para gerar uma versão traduzida do texto do documento.")).toBeInTheDocument();
  });

  it("a aba das páginas recebe o arquivo e o estado dos 30 dias", () => {
    abrirDetalhe({}, { documento: null, documentoExpirado: true });
    fireEvent.click(screen.getByRole("button", { name: "Páginas" }));
    expect(duble.paginas).toHaveBeenLastCalledWith({ meetingId: ID, documento: null, documentoExpirado: true, documentoSaindo: false });
  });

  it("o arquivo passou dos 30 dias: o resumo diz que saiu, e o texto lido continua", () => {
    abrirDetalhe({}, { documento: null, documentoExpirado: true });
    expect(screen.getByText("O arquivo passou dos 30 dias e foi apagado, como o app promete. O texto lido continua aqui.")).toBeInTheDocument();
    // Nunca que "a gravação" foi apagada.
    expect(screen.queryByText(/gravação passou dos 30 dias/)).not.toBeInTheDocument();
  });

  it("lendo: o aviso diz que lê o documento, e não que transcreve", () => {
    abrirDetalhe({ status: "processing" });
    expect(screen.getByText("Lendo o documento e preparando o resumo…")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Transcrevendo/)).not.toBeInTheDocument();
  });

  it("o documento que não chegou ao servidor: o aviso, no lugar de esperar para sempre", () => {
    abrirDetalhe({ status: "uploading" }, { transcript: null });
    expect(screen.getByText("O documento não chegou ao servidor. Exclua esta reunião e envie o arquivo de novo.")).toBeInTheDocument();
  });

  it("falhou com um código: a causa no idioma da tela e o reprocesso pelo arquivo guardado", () => {
    abrirDetalhe({ status: "failed", processingError: "IA_INDISPONIVEL" }, { transcript: null, documento: { ...DOCUMENTO, expiresAt: Date.now() + 10 * DIA } });
    expect(screen.getByText("A IA está sobrecarregada agora. Tente reprocessar daqui a alguns minutos.")).toBeInTheDocument();
    expect(screen.queryByText("IA_INDISPONIVEL")).not.toBeInTheDocument();
    expect(screen.getByText(/O arquivo deste documento continua guardado até/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reprocessar/ }));
    expect(duble.mutacoes.reprocess.mutate).toHaveBeenCalledWith({ meetingId: ID });
  });

  it("longo demais para uma leitura só: a causa diz o que fazer, e não há Reprocessar (o mesmo arquivo pararia de novo no mesmo ponto)", () => {
    abrirDetalhe({ status: "failed", processingError: "DOCUMENTO_LONGO_DEMAIS" }, { transcript: null, documento: { ...DOCUMENTO, expiresAt: Date.now() + 10 * DIA } });
    expect(screen.getByText("O documento é longo demais para uma leitura só. Divida o arquivo em partes menores e envie cada uma.")).toBeInTheDocument();
    expect(screen.queryByText("DOCUMENTO_LONGO_DEMAIS")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprocessar/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/O arquivo deste documento continua guardado até/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Não dá mais para reprocessar/)).not.toBeInTheDocument();
  });

  it.each([
    ["o arquivo sumiu do bucket", { processingError: "DOCUMENTO_AUSENTE" }, { documento: DOCUMENTO }],
    ["o arquivo vence antes de o reprocesso terminar", { processingError: "IA_INDISPONIVEL" }, { documento: { ...DOCUMENTO, expiresAt: Date.now() + 60_000 } }],
    ["não há arquivo", { processingError: "DOCUMENTO_FALHOU" }, { documento: null }],
  ])("falhou e %s: sem o botão, e o texto diz como tentar de novo", (_caso, reuniao, detalhe) => {
    abrirDetalhe({ status: "failed", ...reuniao }, { transcript: null, ...detalhe });
    expect(screen.queryByRole("button", { name: /Reprocessar/ })).not.toBeInTheDocument();
    expect(screen.getByText("Não dá mais para reprocessar este documento pelo arquivo guardado. Para tentar de novo, exclua esta reunião e envie o documento outra vez.")).toBeInTheDocument();
  });

  // Conferência de tela de 20/11/2026 (capturas 02b, 04a, 06a e 07a): o detalhe do
  // documento ainda falava de transcrição, de conversa e do que foi dito.
  it("o resumo, o Pergunte, as entidades, o mapa e a tradução falam do documento, nunca da transcrição, da conversa ou do que foi dito", () => {
    duble.resumoGuardado.mockReturnValue({
      data: {
        estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, modelo: "geral", versaoAnterior: false,
        itens: [
          { id: "i-acao", section: "action", position: 0, subject: null, text: "Enviar o orçamento do transporte", assignee: null, due: null, excerpt: "Ricardo envia o orçamento do transporte", startSeconds: null, status: "pending", done: false, origin: "ai", editedAt: null },
          { id: "i-foco", section: "focus", position: 1, subject: null, text: "Planejamento da feira", assignee: null, due: null, excerpt: "Ata da reunião de planejamento", startSeconds: null, status: "confirmed", done: false, origin: "ai", editedAt: null },
          { id: "i-editado", section: "decision", position: 2, subject: null, text: "Feira em março", assignee: null, due: null, excerpt: "a feira será no dia 18 de março", startSeconds: null, status: "confirmed", done: false, origin: "ai", editedAt: Date.UTC(2026, 10, 20, 13) },
        ],
      },
      isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
    });
    abrirDetalhe();
    expect(screen.getByRole("heading", { name: "Resumo do documento" })).toBeInTheDocument();
    expect(screen.getByText(/^Escrito pela IA a partir do texto do documento\./)).toBeInTheDocument();
    expect(screen.getByText("Trecho do documento", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Trecho do documento", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByText("Trecho original do documento", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pergunte ao documento" })).toBeInTheDocument();
    expect(screen.getByText("A resposta vem só do texto do documento, com os trechos que a sustentam.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nomes e empresas citados no documento" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/transcrição|conversa|foi dito|Pergunte à reunião|Resumo da reunião/);

    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getByText("Traduzir o texto do documento")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/transcrição|foi dito/);

    fireEvent.click(screen.getByRole("button", { name: "Mapa mental" }));
    expect(duble.mapa).toHaveBeenLastCalledWith(expect.objectContaining({ meetingId: ID, documento: true }));
  });

  it("a resposta do Pergunte mostra onde está no documento e o aviso de conferir pelos trechos do documento", () => {
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, modelo: "geral", versaoAnterior: false, itens: [] }, isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe();
    duble.mutacoes.perguntar.data = { respondida: true, resposta: "O prazo é 25/11/2026.", citacoes: [{ trecho: "Ricardo Tavares | 25/11/2026", inicioSegundos: null }] };
    fireEvent.change(screen.getByRole("textbox", { name: "Sua pergunta sobre o documento" }), { target: { value: "Qual é o prazo?" } });
    fireEvent.click(screen.getByRole("button", { name: /Perguntar/ }));
    expect(screen.getByText("Onde isso está no documento")).toBeInTheDocument();
    expect(screen.getByText("Sugestões da IA para você conferir com os trechos do documento. Nada disto foi gravado nem entra na sua rede sozinho.")).toBeInTheDocument();
    expect(screen.queryByText(/Onde isso foi dito|trechos da transcrição/)).not.toBeInTheDocument();
  });

  it("lendo o documento: o texto e o mapa esperam a leitura, e não a transcrição", () => {
    abrirDetalhe({ status: "processing" }, { transcript: null });
    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getByText("O texto do documento ainda não está disponível.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mapa mental" }));
    expect(screen.getByText("O mapa mental aparece aqui quando a leitura do documento terminar.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/transcrição/);
  });

  it("a leitura que termina com a tela aberta avisa que o documento foi lido, e não que a reunião foi processada", async () => {
    const { toast } = await import("sonner");
    vi.mocked(toast.success).mockClear();
    const { rerender } = abrirDetalhe({ status: "processing" }, { transcript: null });
    const anterior = duble.get.mock.results.at(-1)!.value as { data: { meeting: typeof REUNIAO } };
    duble.get.mockReturnValue({ data: { ...anterior.data, meeting: { ...anterior.data.meeting, status: "ready" }, transcript: TRANSCRICAO }, isLoading: false });
    rerender(<Meetings />);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Documento lido. Revise o texto e as sugestões.", expect.anything()));
  });

  it("o PDF corrompido que o Gemini não abre: a causa diz o que fazer, e não há Reprocessar (o mesmo arquivo falharia igual)", () => {
    abrirDetalhe({ status: "failed", processingError: "DOCUMENTO_ILEGIVEL" }, { transcript: null, documento: { ...DOCUMENTO, expiresAt: Date.now() + 10 * DIA } });
    expect(screen.getByText("A IA não conseguiu abrir este arquivo: ele parece estar corrompido ou danificado. Confira se ele abre no seu aparelho, salve-o de novo como PDF e envie outra vez.")).toBeInTheDocument();
    expect(screen.queryByText(/A IA recusou ler este documento/)).not.toBeInTheDocument();
    expect(screen.queryByText("DOCUMENTO_ILEGIVEL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprocessar/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/O arquivo deste documento continua guardado até/)).not.toBeInTheDocument();
  });

  it("a 375 px e em árabe: as abas rolam de lado sem quebrar, e tudo no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const { container } = abrirDetalhe();
    const barra = container.querySelector<HTMLElement>("div.overflow-x-auto.border-b")!;
    const abas = within(barra).getAllByRole("button");
    expect(abas.map(aba => aba.textContent)).toEqual(["الملخص", "نص المستند", "الصفحات", expect.any(String), expect.any(String)]);
    for (const aba of abas) expect(aba).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(screen.getByRole("heading", { name: "الملف" })).toBeInTheDocument();
    fireEvent.click(abas[1]);
    expect(screen.getByRole("heading", { level: 2, name: "نص المستند" })).toBeInTheDocument();
    // Com a tela em árabe, o texto já pede a tradução para o árabe, como a transcrição.
    expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: ID, language: "ar" }, expect.anything());
    expect(document.body.textContent).not.toMatch(/Texto do documento|Páginas|Arquivo guardado/);
  });

  it("com a tela no idioma do documento, o texto aparece página a página; noutro idioma, a tradução corrida", async () => {
    abrirDetalhe();
    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: ID, language: "en" }, expect.anything());
    const { onSuccess } = duble.mutacoes.translateTranscript.mutate.mock.calls.at(-1)![1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Coffee export proposal to Lisbon." }));
    expect(screen.getByText("Coffee export proposal to Lisbon.")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });
});
