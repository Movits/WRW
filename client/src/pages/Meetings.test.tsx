import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { esperarTituloPequeno } from "@/test/titulo-da-janela";
import Meetings from "./Meetings";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { MENSAGEM_FALHA_DA_MONTAGEM, MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO, MENSAGEM_PARTES_SEM_TRANSCRICAO } from "@shared/const";

/**
 * Etapa 3 — a tela de Reuniões (reverificação de 04/09), em duas frentes.
 *
 * Erro de consulta: a lista falhando virava "Nenhuma reunião registrada" com
 * as reuniões intactas no banco, e o detalhe falhando virava um spinner
 * eterno (isLoading false, data undefined → o ramo do spinner nunca saía).
 *
 * Detalhe da reunião: "Excluir" apagava áudio, transcrição, traduções e
 * sugestões com um clique, sem confirmação, num botão colado ao selo de
 * status; e a caixa de falha renderizava o que viesse em processing_error —
 * inclusive o código ERRO_INTERROMPIDO da varredura de reuniões presas. Em
 * processamento o botão continua vivo (o servidor compensa o que gravaria;
 * desabilitá-lo deixava uma reunião morta pelo deploy presa E inexcluível),
 * e o modal avisa que o trabalho em curso será descartado.
 *
 * O tRPC vira um dublê no molde de EnrichmentChat.test.tsx: cada useMutation
 * registra o `mutate` (e as opções) para o teste conferir se o servidor foi
 * chamado e disparar o onError. O AppHeader (menu global, sino, idioma) fica
 * de fora porque não é o que se prova aqui.
 */

type Opcoes = { onSuccess?: (data: unknown, vars: unknown) => void; onError?: (erro: unknown, vars: unknown) => void; onSettled?: () => void };

// vi.mock é içado para o topo do arquivo; o que as fábricas usam precisa
// nascer em vi.hoisted, senão é lido antes de existir.
const duble = vi.hoisted(() => {
  // `data` é o que a mutação já respondeu (o Pergunte à reunião lê a resposta dali).
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn>; mutateAsync: ReturnType<typeof vi.fn>; data?: unknown }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn(), mutateAsync: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, mutateAsync: m.mutateAsync, isPending: false, data: m.data };
    },
  });
  const transcricaoDaGravacao = vi.fn();
  return {
    mutacoes,
    registrar,
    transcricaoDaGravacao,
    list: vi.fn(),
    get: vi.fn(),
    pendencias: vi.fn(),
    duracao: vi.fn(),
    resumoGuardado: vi.fn(),
    conexoes: vi.fn(),
    candidatos: vi.fn(),
    buscaNaRede: vi.fn(),
    painelDoEmail: vi.fn(),
    utils: {
      meetings: {
        list: { invalidate: vi.fn() }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() }, resumoGuardado: { invalidate: vi.fn() }, conexoes: { invalidate: vi.fn() },
        resumoPorEmail: { invalidate: vi.fn(), setData: vi.fn() },
      },
      auth: { me: { invalidate: vi.fn() } },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      // G15a: a transcrição durante a gravação. Função comum, que lê o dublê do
      // teste: o mockReset do projeto client zera o vi.fn a cada teste, e sem
      // resposta combinada vale uma reunião sem nenhuma parte pronta.
      // O "Desfazer" do aviso da lixeira (H7d) restaura pelo cliente do tRPC.
      client: { meetings: {
        transcricaoDaGravacao: { query: async (entrada: unknown) => (await transcricaoDaGravacao(entrada)) ?? { status: "uploading", emPartes: true, agora: Date.now(), partes: [], falas: [], nomes: {} } },
        restaurarDaLixeira: { mutate: vi.fn() },
      } },
    },
  };
});

// warning e dismiss: o Iniciar da gravação em partes (a única desde a G14) fecha os avisos da gravação anterior.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
// A gravação em partes (o padrão desde a G13b) retoma, a cada 30 s, o que
// ficou no aparelho, com a página aberta em qualquer das três rotas: o relógio
// dela entraria na contagem dos testes da tradução longa (G8), que provam que
// nenhuma pergunta fica agendada. Esta suíte é da lista e do detalhe; a
// gravação em partes está em hooks/useGravacaoEmPartes.test.ts e em
// Meetings.sessao-ocupada.test.tsx.
// As opções que a página passa ficam à mão (opcoesDaGravacaoEmPartes) para os
// testes chamarem os avisos dela como o hook chamaria; o iniciar, para os
// testes do idioma conferirem o que vai ao servidor quando a reunião nasce.
const opcoesDaGravacaoEmPartes = vi.hoisted(() => ({ atual: null as null | { aoEncerrarSemAudio?: (meetingId: string) => void }, iniciar: vi.fn() }));
vi.mock("@/hooks/useGravacaoEmPartes", () => ({
  PARTE_SEGUNDOS: 600,
  useGravacaoEmPartes: (opcoes: { aoEncerrarSemAudio?: (meetingId: string) => void }) => {
    opcoesDaGravacaoEmPartes.atual = opcoes;
    return { iniciar: opcoesDaGravacaoEmPartes.iniciar, cancelar: vi.fn(), descartar: vi.fn(), receberParte: vi.fn(), enviando: false };
  },
}));
// O header lê sessão e notificações pelo tRPC real; não é o que está em teste.
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// As fotos e os desenhos do resumo (H4g e H4h) têm o teste deles (AnexosDoResumo.test.tsx): aqui, só onde entram.
vi.mock("@/components/AnexosDoResumo", () => ({ AnexosDoResumo: (props: { meetingId?: string; comLinkAberto?: boolean }) => <div data-testid="anexos-do-resumo" data-reuniao={props.meetingId} data-link={String(!!props.comLinkAberto)}/> }));
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
      reprocess: duble.registrar("reprocess"),
      // O vídeo do YouTube (H13): o botão da lista e o "Tentar de novo" do detalhe.
      resumirVideoDoYoutube: duble.registrar("resumirVideoDoYoutube"),
      refazerVideoDoYoutube: duble.registrar("refazerVideoDoYoutube"),
      resumoGuardado: { useQuery: (...args: unknown[]) => duble.resumoGuardado(...args) },
      // R1a: as datas das consultas da administração (nenhuma).
      consultasDaAdministracao: { useQuery: () => ({ data: [], isError: false, error: null, refetch: () => undefined }) },
      // N5: as conexões que nasceram da reunião e o "Vincular a um contato".
      conexoes: { useQuery: (...args: unknown[]) => duble.conexoes(...args) },
      candidatosParaVincular: { useQuery: (...args: unknown[]) => duble.candidatos(...args) },
      pedirResumo: duble.registrar("pedirResumo"),
      decidirItemDoResumo: duble.registrar("decidirItemDoResumo"),
      // O grupo voz: baixar o áudio do resumo (H19b) e o complemento pela busca (H4i).
      audioDoResumo: duble.registrar("audioDoResumo"),
      pedirComplemento: duble.registrar("pedirComplemento"),
      decidirComplemento: duble.registrar("decidirComplemento"),
      confirmarItensDoResumo: duble.registrar("confirmarItensDoResumo"),
      marcarAcaoFeita: duble.registrar("marcarAcaoFeita"),
      traduzirResumo: duble.registrar("traduzirResumo"),
      // As do formulário do item do resumo (H4f), que só monta quando a dona o abre.
      editarItemDoResumo: duble.registrar("editarItemDoResumo"),
      acrescentarItemDoResumo: duble.registrar("acrescentarItemDoResumo"),
      perguntar: duble.registrar("perguntar"),
      perguntarDuranteAGravacao: duble.registrar("perguntarDuranteAGravacao"),
      rascunharEmailDeRetorno: duble.registrar("rascunharEmailDeRetorno"),
      ligarLinkAberto: duble.registrar("ligarLinkAberto"),
      desligarLinkAberto: duble.registrar("desligarLinkAberto"),
      // A senha e o áudio do link ligado (H23).
      novaSenhaDoLink: duble.registrar("novaSenhaDoLink"),
      tirarSenhaDoLink: duble.registrar("tirarSenhaDoLink"),
      mudarAudioDoLink: duble.registrar("mudarAudioDoLink"),
      // O PDF da reunião (H8): só monta quando a dona abre o aviso do "Baixar PDF".
      exportar: duble.registrar("exportar"),
      // O resumo por e-mail (H22): só monta o painel quando a dona o abre.
      resumoPorEmail: { useQuery: (...args: unknown[]) => duble.painelDoEmail(...args) },
      mandarResumoPorEmail: duble.registrar("mandarResumoPorEmail"),
      mandarResumoPorEmailDeNovo: duble.registrar("mandarResumoPorEmailDeNovo"),
      envioAutomaticoDoResumo: duble.registrar("envioAutomaticoDoResumo"),
      // O áudio da reunião (H8c): só monta quando a dona abre o aviso do "Baixar o áudio".
      baixarAudio: duble.registrar("baixarAudio"),
      // O título que a IA sugeriu: só monta quando há sugestão.
      decidirTituloSugerido: duble.registrar("decidirTituloSugerido"),
    },
    reuniaoAberta: {
      pedirResumo: duble.registrar("pedirResumoPeloLink"),
      perguntar: duble.registrar("perguntarPeloLink"),
      traduzirResumo: duble.registrar("traduzirResumoPeloLink"),
    },
    // O "Tentar de novo" do evento da próxima ação que ficou na Google Agenda (H5c): o resumo guardado o monta.
    proximasAcoes: { tirarDaGoogle: duble.registrar("tirarDaGoogle") },
    // Meu Network Inteligente: as sugestões de Tenho/Preciso por pessoa da reunião.
    networkInteligente: {
      pendencias: { useQuery: (...args: unknown[]) => duble.pendencias(...args) },
      // N5: a dona decide cada item ali mesmo.
      confirmarPendencia: duble.registrar("confirmarPendencia"),
      ignorarPendencia: duble.registrar("ignorarPendencia"),
    },
    // N5: a busca do "Vincular a um contato" na rede da dona.
    network: { list: { useQuery: (...args: unknown[]) => duble.buscaNaRede(...args) } },
  },
}));
// O jsdom não carrega mídia: a leitura da duração pelo navegador é dublada
// (e provada em lib/duracao-no-navegador.test.ts).
vi.mock("@/lib/duracao-no-navegador", () => ({ lerDuracaoNoNavegador: (...args: unknown[]) => duble.duracao(...args) }));
// O mapa mental (H10) vira um marcador que mostra o que recebeu; o
// comportamento dele está em components/MapaMental.test.tsx. A tradução (H11)
// que a página passa aparece nele (o estado e o rótulo "Prazos" traduzido), e
// o botão faz o papel do mapa que fica pronto e avisa a página dos rótulos.
type TraducaoDoMapaRecebida = { estado: string; traduzirRotulo: (rotulo: string) => string };
vi.mock("@/components/MapaMental", () => ({
  MapaMentalDaReuniao: ({ meetingId, titulo, emoji, traducao, aoMudarRotulos }: {
    meetingId: string; titulo: string; emoji?: string | null; traducao?: TraducaoDoMapaRecebida; aoMudarRotulos?: (rotulos: string[]) => void;
  }) => (
    <div data-testid="mapa-mental">{meetingId} | {titulo} | {emoji ?? "sem emoji"}
      <span data-testid="traducao-do-mapa">{traducao?.estado} {traducao?.traduzirRotulo("Prazos")}</span>
      {aoMudarRotulos && <button type="button" onClick={() => aoMudarRotulos(["Prazos"])}>rótulos do mapa</button>}
    </div>
  ),
}));

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); m.mutateAsync.mockReset(); m.data = undefined; }
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.conexoes.mockReturnValue({ data: undefined, isError: false, error: null, refetch: vi.fn() });
  duble.candidatos.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });
  duble.buscaNaRede.mockReturnValue({ data: undefined, isError: false, error: null, refetch: vi.fn() });
  // O resumo guardado da reunião (H4c): sem resumo, salvo o teste que diz outro.
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() });
  // A URL escolhe o ramo da tela (lista, gravador, detalhe), e o setup limpa só
  // o state do histórico: sem isto, o detalhe aberto num teste abriria o seguinte.
  window.history.replaceState(null, "", "/meetings");
});

// Erro como o servidor devolve (envelope tRPC, com data.code): é a mensagem
// dele que a tela mostra. Sem o envelope, valeria o genérico traduzido.
const MENSAGEM = "Banco de dados indisponível. Tente de novo em instantes.";
const emErro = (refetch = vi.fn()) => ({ data: undefined, isLoading: false, isError: true, error: { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch });
const reuniao = { id: "m1", title: "Reunião com a Ana", status: "ready", createdAt: 1_700_000_000_000 };

describe("Reuniões — erro de consulta não é 'nenhuma reunião'", () => {
  it("lista em erro: mensagem do servidor e botão de tentar de novo, sem o estado vazio", () => {
    const refetch = vi.fn();
    duble.list.mockReturnValue(emErro(refetch));
    render(<Meetings />);

    expect(screen.getByRole("alert")).toHaveTextContent("Algo inesperado aconteceu");
    expect(screen.getByText(MENSAGEM)).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma reunião registrada")).not.toBeInTheDocument();
    expect(screen.queryByText("Carregando reuniões…")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("detalhe em erro: mensagem + voltar, em vez de spinner eterno", () => {
    duble.list.mockReturnValue({ data: [reuniao], isLoading: false, isError: false, error: null, refetch: vi.fn() });
    const refetchDetalhe = vi.fn();
    duble.get.mockReturnValue(emErro(refetchDetalhe));
    render(<Meetings />);

    fireEvent.click(screen.getByText("Reunião com a Ana"));

    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(document.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetchDetalhe).toHaveBeenCalledTimes(1);

    // Há caminho de volta: a lista reaparece.
    fireEvent.click(screen.getByRole("button", { name: /Todas as reuniões/ }));
    expect(screen.getByText("Reunião com a Ana")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

const REUNIAO = {
  id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ownerId: "dona", title: "Reunião com a vinícola",
  status: "ready", processingError: null as string | null, createdAt: Date.UTC(2026, 8, 4, 12), updatedAt: Date.UTC(2026, 8, 4, 12),
  // Como no servidor (COLUNAS_DA_REUNIAO_NA_TELA): envio único, sem partes.
  audioPipeline: "single" as "single" | "slices", expectedSlices: null as number | null,
  // De onde a reunião veio; no vídeo do YouTube (H13), a URL canônica dele.
  origem: null as string | null, sourceUrl: null as string | null,
};

/** Monta a lista com uma reunião e abre o detalhe dela. */
type Detalhe = { transcript: unknown; suggestions: unknown[]; recording: unknown; recordingExpired: boolean; recordingDeletionPending: boolean; audioParaBaixar: unknown };
function abrirDetalhe(reuniao: Partial<typeof REUNIAO> = {}, detalhe: Partial<Detalhe> = {}) {
  const meeting = { ...REUNIAO, ...reuniao };
  duble.list.mockReturnValue({ data: [meeting], isLoading: false });
  duble.get.mockReturnValue({
    data: { meeting, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false, audioParaBaixar: null, ...detalhe },
    isLoading: false,
  });
  render(<Meetings />);
  fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
  return meeting;
}

// A gravação em duas partes (0 a 600 s e 600 a 900 s). O "▶ mm:ss" e o ?t do
// link levam o player da barra à parte que cobre o segundo, e o src do único
// <audio> diz em qual parte ele está (blocos D1 e H4c).
const PARTES = [
  { seq: 0, url: "/manus-storage/meetings/dona/r/partes/0000-a.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600, expiresAt: Date.now() + 1e9 },
  { seq: 1, url: "/manus-storage/meetings/dona/r/partes/0001-b.m4a", mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 300, expiresAt: Date.now() + 1e9 },
];
const GRAVACAO = { url: PARTES[0].url, mimeType: "audio/mp4", durationSeconds: 900, sizeBytes: 0, expiresAt: Date.now() + 1e9, partes: PARTES };

const botaoExcluir = () => screen.getByRole("button", { name: /^Excluir$/ });
// O "Excluir" manda para a lixeira (H7d); só a gravação em partes ainda no ar é excluída na hora.
const tituloDoModal = () => screen.queryByText("Mandar esta reunião para a lixeira?");
const botaoConfirmar = () => screen.getByRole("button", { name: "Mandar para a lixeira" });
const tituloDaExclusaoNaHora = () => screen.queryByText("Excluir esta reunião?");

describe("Gravador — o fim sem nenhum áudio (G17)", () => {
  it("o microfone caiu no primeiro segundo: a reunião vazia saiu, a tela avisa e não vai ao detalhe dela", () => {
    const antes = window.location.href;
    try {
      window.history.replaceState(null, "", "/gravar");
      duble.list.mockReturnValue({ data: [], isLoading: false });
      render(<Meetings />);
      act(() => opcoesDaGravacaoEmPartes.atual!.aoEncerrarSemAudio!("8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"));
      expect(toast.error).toHaveBeenCalledWith("Nenhum áudio foi gravado. Tente de novo.");
      expect(window.location.pathname).toBe("/gravar");
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });
});

describe("Detalhe da reunião — excluir manda para a lixeira, com confirmação (H7d)", () => {
  it("clicar em Excluir abre o modal da lixeira e NÃO chama o servidor", () => {
    abrirDetalhe();

    expect(tituloDoModal()).not.toBeInTheDocument();
    fireEvent.click(botaoExcluir());

    expect(tituloDoModal()).toBeInTheDocument();
    // O título é pequeno, como o do "Descartar esta gravação?": o h3 sem classe
    // herdava 36 px no computador e quebrava em três linhas na janela estreita.
    esperarTituloPequeno(screen.getByRole("dialog", { name: "Mandar esta reunião para a lixeira?" }));
    // o texto diz o que muda (a lista, a busca e o link aberto) e o prazo para restaurar
    expect(screen.getByText(/sai da lista, da busca e do link aberto \(que é desligado\) e fica na lixeira por 30 dias/)).toBeInTheDocument();
    expect(duble.mutacoes.mandarParaALixeira?.mutate).not.toHaveBeenCalled();
    expect(duble.mutacoes.delete.mutate).not.toHaveBeenCalled();
  });

  it("confirmar no modal é o único caminho até a lixeira, com o id da reunião; a exclusão na hora não é chamada", () => {
    const meeting = abrirDetalhe();
    fireEvent.click(botaoExcluir());

    fireEvent.click(botaoConfirmar());

    expect(duble.mutacoes.mandarParaALixeira.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutacoes.mandarParaALixeira.mutate).toHaveBeenCalledWith({ meetingIds: [meeting.id] });
    expect(duble.mutacoes.delete.mutate).not.toHaveBeenCalled();
  });

  it("Cancelar fecha o modal sem mandar para a lixeira", () => {
    abrirDetalhe();
    fireEvent.click(botaoExcluir());

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(tituloDoModal()).not.toBeInTheDocument();
    expect(duble.mutacoes.mandarParaALixeira.mutate).not.toHaveBeenCalled();
  });

  it("o servidor recusou: o modal fecha e a dona lê o motivo no idioma da tela — não fica num modal preso com a reunião ainda lá", () => {
    const meeting = abrirDetalhe();
    fireEvent.click(botaoExcluir());
    fireEvent.click(botaoConfirmar());
    expect(tituloDoModal()).toBeInTheDocument();

    act(() => { duble.mutacoes.mandarParaALixeira.opcoes.onError?.({ message: "LIXEIRA_GRAVANDO", data: { code: "CONFLICT" } }, { meetingIds: [meeting.id] }); });

    expect(tituloDoModal()).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Uma gravação ainda está em andamento: encerre a gravação antes de mandá-la para a lixeira.");
    // a reunião continua aberta: o detalhe não foi trocado pela lista
    expect(screen.getByRole("button", { name: /^Excluir$/ })).toBeInTheDocument();
  });

  it("deu certo: o aviso diz o prazo e traz o Desfazer, que restaura a mesma reunião", async () => {
    const meeting = abrirDetalhe();
    fireEvent.click(botaoExcluir());
    fireEvent.click(botaoConfirmar());

    await act(async () => { await duble.mutacoes.mandarParaALixeira.opcoes.onSuccess?.({ naLixeira: 1, linksDesligados: 0 }, { meetingIds: [meeting.id] }); });

    expect(duble.utils.meetings.list.invalidate).toHaveBeenCalled();
    expect(duble.utils.meetings.lixeira.invalidate).toHaveBeenCalled();
    const [mensagem, opcoes] = vi.mocked(toast.success).mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void } }];
    expect(mensagem).toBe("Reunião na lixeira. Dá para restaurar por 30 dias.");
    expect(opcoes.action.label).toBe("Desfazer");
    await act(async () => { opcoes.action.onClick(); await Promise.resolve(); });
    await waitFor(() => expect(duble.utils.client.meetings.restaurarDaLixeira.mutate).toHaveBeenCalledWith({ meetingIds: [meeting.id] }));
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith("Reunião restaurada."));
  });

  it("a gravação em partes ainda no ar não vai para a lixeira: o modal é o da exclusão na hora, que nomeia tudo o que some", () => {
    const meeting = abrirDetalhe({ status: "recording", audioPipeline: "slices" });
    fireEvent.click(botaoExcluir());

    expect(tituloDoModal()).not.toBeInTheDocument();
    expect(tituloDaExclusaoNaHora()).toBeInTheDocument();
    esperarTituloPequeno(screen.getByRole("dialog", { name: "Excluir esta reunião?" }));
    // o texto nomeia tudo que some, e o que fica: as próximas ações confirmadas (H5a), soltas da reunião
    expect(screen.getByText(/áudio, a transcrição, as traduções e as sugestões de contato/)).toBeInTheDocument();
    expect(screen.getByText(/As próximas ações que você confirmou ficam na sua lista, sem o trecho da reunião\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Excluir reunião" }));
    expect(duble.mutacoes.delete.mutate).toHaveBeenCalledWith({ meetingId: meeting.id });
    expect(duble.mutacoes.mandarParaALixeira?.mutate).not.toHaveBeenCalled();

    // A recusa da exclusão na hora fecha o modal e mostra o motivo.
    act(() => { duble.mutacoes.delete.opcoes.onError?.(new Error("x"), { meetingId: meeting.id }); });
    expect(tituloDaExclusaoNaHora()).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("x");
  });
});

// H8: o "Baixar PDF" fica ao lado do selo de status, só na reunião pronta. O
// aviso, o pedido e a impressão estão em components/ExportarReuniao.test.tsx.
describe("Detalhe da reunião — baixar o PDF (H8)", () => {
  it("pronta, o detalhe tem o botão, e o aviso diz quantos itens confirmados vão no PDF; nada é pedido antes de confirmar", () => {
    duble.resumoGuardado.mockReturnValue({
      data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, versaoAnterior: false, itens: [{ id: "i1", status: "confirmed" }, { id: "i2", status: "pending" }, { id: "i3", status: "ignored" }] },
      isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
    });
    abrirDetalhe({ status: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Baixar PDF" }));
    expect(screen.getByRole("dialog", { name: "Baixar a reunião em PDF" })).toHaveTextContent("Itens do resumo confirmados que vão no PDF: 1.");
    expect(duble.mutacoes.exportar.mutate).not.toHaveBeenCalled();
  });

  // O servidor põe no PDF os itens confirmados que estão no banco: "não sei" não é zero.
  it.each([
    ["a consulta do resumo falhou (as 3 tentativas)", { data: undefined, isLoading: false, isSuccess: false, isError: true, error: { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch: vi.fn() }],
    ["o resumo ainda está chegando (rede lenta)", { data: undefined, isLoading: true, isSuccess: false, isError: false, error: null, refetch: vi.fn() }],
  ])("%s: o aviso não diz que nenhum item foi confirmado", (_caso, consulta) => {
    duble.resumoGuardado.mockReturnValue(consulta);
    abrirDetalhe({ status: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Baixar PDF" }));
    const aviso = screen.getByRole("dialog", { name: "Baixar a reunião em PDF" });
    expect(aviso).not.toHaveTextContent("Nenhum item do resumo foi confirmado");
    expect(aviso).not.toHaveTextContent("Itens do resumo confirmados que vão no PDF");
    expect(aviso).toHaveTextContent("só os itens do resumo que você confirmou");
  });

  it.each(["processing", "failed", "recording", "uploading"])("'%s': sem o botão (o servidor também recusa)", status => {
    abrirDetalhe({ status });
    expect(screen.queryByRole("button", { name: "Baixar PDF" })).not.toBeInTheDocument();
  });
});

// H8c: o "Baixar o áudio" fica na seção Gravação, só com a gravação encerrada e
// com o áudio guardado (desde 26/11/2026, até a dona excluir a reunião). O aviso, o pedido e o link de salvar estão em
// components/BaixarAudioDaReuniao.test.tsx.
describe("Detalhe da reunião — baixar o áudio (H8c)", () => {
  const botaoDoAudio = () => screen.queryByRole("button", { name: "Baixar o áudio" });
  // O que o servidor diz que se baixa (server/meeting-service.ts, gravacaoParaOuvir).
  const PARA_BAIXAR = { duracaoSegundos: 900, expiresAt: Date.now() + 1e9 };

  it.each(["ready", "processing", "failed"])("'%s' com o áudio no prazo: o botão abre o aviso, com o tamanho da gravação; nada é pedido antes de preparar", status => {
    abrirDetalhe({ status }, { recording: GRAVACAO, audioParaBaixar: PARA_BAIXAR });
    fireEvent.click(botaoDoAudio()!);
    const aviso = screen.getByRole("dialog", { name: "Baixar o áudio da reunião" });
    // 900 s a 64 kbps: 7,2 MB.
    expect(aviso).toHaveTextContent("Tamanho aproximado: 7 MB.");
    expect(duble.mutacoes.baixarAudio.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(aviso).getByRole("button", { name: "Preparar o arquivo" }));
    expect(duble.mutacoes.baixarAudio.mutate).toHaveBeenCalledWith(
      { meetingId: REUNIAO.id, formato: "mp3", nome: "Reunião com a vinícola - 2026-09-04" }, expect.anything(),
    );
  });

  it.each(["recording", "uploading"])("'%s' (a gravação ainda chega): sem o botão", status => {
    abrirDetalhe({ status, audioPipeline: "slices" }, { recording: GRAVACAO, audioParaBaixar: PARA_BAIXAR });
    expect(botaoDoAudio()).not.toBeInTheDocument();
  });

  it.each([
    ["saiu do bucket", { recording: null, recordingExpired: true }],
    ["ainda está saindo do bucket", { recording: null, recordingDeletionPending: true }],
  ])("sem o áudio guardado o botão some: %s", (_caso, detalhe) => {
    abrirDetalhe({ status: "ready" }, detalhe);
    expect(screen.getByRole("heading", { name: "Gravação" })).toBeInTheDocument();
    expect(botaoDoAudio()).not.toBeInTheDocument();
  });

  it("sem áudio guardado, sem o botão", () => {
    abrirDetalhe({ status: "ready" }, { recording: null, audioParaBaixar: null });
    expect(screen.getByText("Nenhum áudio guardado para esta reunião.")).toBeInTheDocument();
    expect(botaoDoAudio()).not.toBeInTheDocument();
  });

  // Revisão do pacote 4b: as partes que falharam na IA não tocam no player, mas
  // o áudio delas está no bucket e sai no arquivo. O botão segue o servidor, e
  // não a gravação que toca: na reunião que falhou inteira, antes ele sumia.
  it("a reunião que falhou inteira na IA: nada toca, mas o áudio guardado se baixa, com o aviso de por que não toca", () => {
    abrirDetalhe({ status: "failed", audioPipeline: "slices" }, { recording: null, audioParaBaixar: { duracaoSegundos: 1500, expiresAt: Date.now() + 1e9 } });
    expect(screen.getByText("O áudio desta reunião está guardado, mas não toca aqui porque a transcrição falhou. Você pode baixá-lo.")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum áudio guardado para esta reunião.")).not.toBeInTheDocument();
    fireEvent.click(botaoDoAudio()!);
    // 1.500 s a 64 kbps: 12 MB.
    expect(screen.getByRole("dialog", { name: "Baixar o áudio da reunião" })).toHaveTextContent("Tamanho aproximado: 12 MB.");
  });

  it("com a parte que falhou na IA depois das que tocam, o aviso leva a duração do arquivo, e não a do player", () => {
    abrirDetalhe({ status: "ready", audioPipeline: "slices" }, { recording: GRAVACAO, audioParaBaixar: { ...PARA_BAIXAR, duracaoSegundos: 1500 } });
    fireEvent.click(botaoDoAudio()!);
    expect(screen.getByRole("dialog", { name: "Baixar o áudio da reunião" })).toHaveTextContent("Tamanho aproximado: 12 MB.");
  });
});

// A junção do Pacote 4b com o 4d na mesma tela: o "Baixar o áudio" (H8c) é da
// dona e segue o áudio guardado (audioParaBaixar); tirar o áudio do link (H23)
// não o tira. O resumo por e-mail (H22), lá em cima, segue o link: sem o áudio,
// não promete a gravação. Cada painel chama só o seu pedido.
describe("Detalhe da reunião — o 'Baixar o áudio' (4b) e o resumo por e-mail (4d) na mesma reunião", () => {
  const TOKEN_DO_LINK = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const PARA_BAIXAR = { duracaoSegundos: 900, expiresAt: Date.now() + 1e9 };
  const comResumoPronto = () => {
    duble.resumoGuardado.mockReturnValue({
      data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, versaoAnterior: false, itens: [] },
      isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
    });
    duble.painelDoEmail.mockReturnValue({
      data: { idioma: "pt-BR", linkLigado: true, emailDaDona: "glenda@exemplo.invalid", nomeDaDona: "Glenda", automatico: false, participantes: [], envios: [], podeMandarDeNovo: false },
      isPending: false, isError: false, error: null,
    });
  };

  it("o link ligado sem o áudio e com senha: o e-mail não promete a gravação, e o 'Baixar o áudio' da dona continua e pede só o áudio", () => {
    comResumoPronto();
    abrirDetalhe({ status: "ready", shareToken: TOKEN_DO_LINK, linkComSenha: true, linkComAudio: false } as never, { recording: GRAVACAO, audioParaBaixar: PARA_BAIXAR });
    fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
    const painel = screen.getByRole("region", { name: "Mandar o resumo por e-mail" });
    expect(within(painel).getByText("Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na Marquesa Global Match.")).toBeInTheDocument();
    expect(painel.textContent).not.toMatch(/ouve a gravação/);

    // Com o painel do e-mail aberto, o botão da seção Gravação segue lá.
    fireEvent.click(screen.getByRole("button", { name: "Baixar o áudio" }));
    const aviso = screen.getByRole("dialog", { name: "Baixar o áudio da reunião" });
    fireEvent.click(within(aviso).getByRole("button", { name: "Preparar o arquivo" }));
    expect(duble.mutacoes.baixarAudio.mutate).toHaveBeenCalledWith(
      { meetingId: REUNIAO.id, formato: "mp3", nome: "Reunião com a vinícola - 2026-09-04" }, expect.anything(),
    );
    expect(duble.mutacoes.mandarResumoPorEmail.mutate).not.toHaveBeenCalled();
  });

  it("o link ligado com o áudio: o e-mail promete a gravação, e o 'Baixar o áudio' é o mesmo", () => {
    comResumoPronto();
    abrirDetalhe({ status: "ready", shareToken: TOKEN_DO_LINK, linkComSenha: false, linkComAudio: true } as never, { recording: GRAVACAO, audioParaBaixar: PARA_BAIXAR });
    fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
    const painel = screen.getByRole("region", { name: "Mandar o resumo por e-mail" });
    expect(within(painel).getByText("Pelo link, você lê o resumo e a transcrição, ouve a gravação enquanto ela estiver guardada e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na Marquesa Global Match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Baixar o áudio" })).toBeInTheDocument();
  });
});

describe("Detalhe da reunião — em processamento", () => {
  it("Excluir continua habilitado e manda para a lixeira: o trabalho em curso termina e fica guardado nela, sem o aviso de descarte", () => {
    const meeting = abrirDetalhe({ status: "processing" });

    const botao = botaoExcluir();
    expect(botao).toBeEnabled();
    fireEvent.click(botao);

    expect(tituloDoModal()).toBeInTheDocument();
    expect(screen.queryByText(/será descartado/)).not.toBeInTheDocument();
    expect(duble.mutacoes.mandarParaALixeira?.mutate).not.toHaveBeenCalled();

    fireEvent.click(botaoConfirmar());
    expect(duble.mutacoes.mandarParaALixeira.mutate).toHaveBeenCalledWith({ meetingIds: [meeting.id] });
    expect(duble.mutacoes.delete.mutate).not.toHaveBeenCalled();
  });
});

describe("Detalhe da reunião — a falha é explicada no idioma da dona", () => {
  it("o código ERRO_INTERROMPIDO aparece traduzido, nunca cru", () => {
    abrirDetalhe({ status: "failed", processingError: "ERRO_INTERROMPIDO" });

    expect(screen.getByText(/O processamento foi interrompido antes de terminar/)).toBeInTheDocument();
    expect(screen.queryByText(/ERRO_INTERROMPIDO/)).not.toBeInTheDocument();
  });

  it("outra mensagem de falha aparece como veio: o servidor já a escreveu para a dona", () => {
    abrirDetalhe({ status: "failed", processingError: "Arquivo de áudio inválido." });
    expect(screen.getByText("Arquivo de áudio inválido.")).toBeInTheDocument();
  });

  it("sem mensagem, a caixa usa o texto de reserva", () => {
    abrirDetalhe({ status: "failed", processingError: null });
    expect(screen.getByText(/O processamento não foi concluído/)).toBeInTheDocument();
  });

  // Conferência de tela do pacote 4b: as frases que a fila da gravação em partes
  // grava em processing_error saíam em português na tela em árabe (captura 32).
  it.each([
    [MENSAGEM_PARTES_SEM_TRANSCRICAO, "تعذّر تفريغ صوت هذا الاجتماع نصيًا."],
    [MENSAGEM_FALHA_DA_MONTAGEM, "تعذّرت معالجة هذا الاجتماع. حاول مرة أخرى لاحقًا."],
    [MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO, "توقف التسجيل قبل إرسال الصوت."],
  ])("a frase da fila \"%s\" sai no idioma da dona (árabe), e não em português", async (frase, emArabe) => {
    await i18n.changeLanguage("ar");
    try {
      abrirDetalhe({ status: "failed", audioPipeline: "slices", processingError: frase });
      expect(screen.getByText(emArabe)).toBeInTheDocument();
      expect(screen.queryByText(frase)).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });
});

const DIA = 24 * 60 * 60 * 1000;
const gravacao = (expiraEm: number) => ({ url: "/manus-storage/meetings/dona/r/rec.webm", mimeType: "audio/webm", durationSeconds: 95, sizeBytes: 2048, expiresAt: expiraEm });
const botaoReprocessar = () => screen.queryByRole("button", { name: /Reprocessar/ });
const sugestaoPendente = { id: "s1", fullName: "Ana Souza", jobTitle: null, company: null, email: null, status: "pending" };

describe("Detalhe da reunião — reprocessar a reunião que falhou", () => {
  it("com áudio guardado: a dica diz que ele continua guardado e que o resultado anterior é substituído, e o botão pede o reprocessamento com o id", () => {
    const meeting = abrirDetalhe({ status: "failed", processingError: "Não foi possível transcrever o áudio." }, { recording: gravacao(Date.now() + 20 * DIA) });
    expect(screen.getByText(/continua guardado\. Reprocessar.*substitui a transcrição/)).toBeInTheDocument();
    fireEvent.click(botaoReprocessar()!);
    expect(duble.mutacoes.reprocess.mutate).toHaveBeenCalledWith({ meetingId: meeting.id });
  });

  it("sem áudio guardado: nenhum botão, e o texto manda gravar ou enviar de novo", () => {
    abrirDetalhe({ status: "failed", processingError: "Arquivo de áudio inválido." });
    expect(botaoReprocessar()).not.toBeInTheDocument();
    expect(screen.getByText(/não está guardado, então não há o que reprocessar/)).toBeInTheDocument();
  });

  // Conferência de tela do pacote 4b (capturas 36 e 32): na reunião em partes que
  // falhou inteira na IA, nada toca (`recording` nulo), mas o áudio está no bucket,
  // a seção Gravação o oferece para baixar e o servidor o reprocessa
  // (reprocessarEmPartes). A caixa vermelha decidia pela gravação que toca e
  // mandava a dona apagar a reunião.
  it("a reunião em partes que falhou inteira na IA, com o áudio guardado: a caixa oferece o Reprocessar, e não manda apagar a reunião", () => {
    const meeting = abrirDetalhe({ status: "failed", audioPipeline: "slices", expectedSlices: 3, processingError: MENSAGEM_PARTES_SEM_TRANSCRICAO },
      { recording: null, audioParaBaixar: { duracaoSegundos: 1500, expiresAt: Date.now() + 20 * DIA } });
    expect(screen.queryByText(/não está guardado, então não há o que reprocessar/)).not.toBeInTheDocument();
    expect(screen.getByText(/continua guardado\. Reprocessar.*substitui a transcrição/)).toBeInTheDocument();
    // A seção Gravação, logo abaixo, diz o mesmo: o áudio está guardado.
    expect(screen.getByText(/O áudio desta reunião está guardado, mas não toca aqui/)).toBeInTheDocument();
    fireEvent.click(botaoReprocessar()!);
    expect(duble.mutacoes.reprocess.mutate).toHaveBeenCalledWith({ meetingId: meeting.id });
  });

  it.each(["ready", "processing"])("reunião %s não oferece reprocessar", status => {
    abrirDetalhe({ status }, { recording: gravacao(Date.now() + 20 * DIA) });
    expect(botaoReprocessar()).not.toBeInTheDocument();
  });

  it.each([
    ["CONFLICT", /não está com falha ou já está sendo processada/],
    ["PRECONDITION_FAILED", /Não é possível reprocessar esta reunião/],
    ["TOO_MANY_REQUESTS", /Muitas tentativas de reprocessar/],
    ["INTERNAL_SERVER_ERROR", /Não foi possível reprocessar a reunião/],
  ])("recusa %s vira a frase traduzida, não a mensagem crua do servidor", (code, frase) => {
    abrirDetalhe({ status: "failed" }, { recording: gravacao(Date.now() + 20 * DIA) });
    act(() => { duble.mutacoes.reprocess.opcoes.onError?.({ message: "mensagem do servidor", data: { code } }, { meetingId: REUNIAO.id }); });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(frase));
    expect(toast.error).not.toHaveBeenCalledWith("mensagem do servidor");
  });

  it("pedido aceito: a tela vira 'processing' na hora, sem esperar a releitura", () => {
    abrirDetalhe({ status: "failed" }, { recording: gravacao(Date.now() + 20 * DIA) });
    act(() => { duble.mutacoes.reprocess.opcoes.onSuccess?.({ status: "processing" }, { meetingId: REUNIAO.id }); });
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Reprocessamento iniciado/));
    expect(duble.utils.meetings.get.setData).toHaveBeenCalledTimes(1);
    const [chave, atualizar] = duble.utils.meetings.get.setData.mock.calls[0] as [unknown, (anterior: unknown) => { meeting: Record<string, unknown> } | undefined];
    expect(chave).toEqual({ meetingId: REUNIAO.id });
    expect(atualizar({ meeting: { ...REUNIAO, status: "failed", processingError: "x" } })?.meeting).toMatchObject({ status: "processing", processingError: null });
    expect(atualizar(undefined)).toBeUndefined();
  });

  it("o áudio sumiu do bucket: o motivo sai traduzido, sem a dica de 'continua guardado' e sem o botão", () => {
    abrirDetalhe({ status: "failed", processingError: "O áudio guardado desta reunião não foi encontrado." }, { recording: gravacao(Date.now() + 20 * DIA) });
    expect(botaoReprocessar()).not.toBeInTheDocument();
    expect(screen.queryByText(/continua guardado/)).not.toBeInTheDocument();
    expect(screen.getByText(/Não é possível reprocessar esta reunião/)).toBeInTheDocument();
  });

  it("…e em inglês o motivo aparece traduzido, não em português", async () => {
    await i18n.changeLanguage("en");
    try {
      abrirDetalhe({ status: "failed", processingError: "O áudio guardado desta reunião não foi encontrado." }, { recording: gravacao(Date.now() + 20 * DIA) });
      expect(screen.getByText("This meeting's stored audio was not found.")).toBeInTheDocument();
      expect(screen.queryByText("O áudio guardado desta reunião não foi encontrado.")).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });

  it("aceito ou recusado, a tela relê a reunião e a lista", () => {
    abrirDetalhe({ status: "failed" }, { recording: gravacao(Date.now() + 20 * DIA) });
    act(() => { duble.mutacoes.reprocess.opcoes.onSettled?.(); });
    expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
    expect(duble.utils.meetings.list.invalidate).toHaveBeenCalled();
  });

  it("sem transcrição e com o áudio vencido: não diz que 'a transcrição continua aqui' nem que houve gravação apagada", () => {
    abrirDetalhe({ status: "failed" }, { recordingExpired: true });
    expect(screen.queryByText(/A transcrição continua aqui/)).not.toBeInTheDocument();
    expect(screen.queryByText(/foi apagada/)).not.toBeInTheDocument();
    expect(screen.getByText("Não há áudio guardado desta reunião.")).toBeInTheDocument();
  });

  it("áudio vencido que ainda não saiu do bucket: a tela diz que está saindo, e não que 'foi apagada' nem que não há áudio guardado", () => {
    abrirDetalhe({}, { transcript: { id: "t1", transcript: "Oi.", language: "pt-BR" }, recordingDeletionPending: true });
    expect(screen.getByText("Esta gravação já não pode ser ouvida. O app ainda está apagando o áudio do armazenamento.")).toBeInTheDocument();
    expect(screen.queryByText(/foi apagada/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhum áudio guardado/)).not.toBeInTheDocument();
  });
});

// Achado 7 da bancada de 16/11: a pessoa só citada virava um cartão igual ao das participantes.
describe("Detalhe da reunião — quem participou e quem só foi citada", () => {
  const abaContatos = () => screen.getByRole("button", { name: /Contatos/ });

  it("a citada sai à parte, compacta e marcada; as duas seguem com Criar contato", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [
      { ...sugestaoPendente, presence: "present", phone: null, existingContactId: null },
      { ...sugestaoPendente, id: "s2", fullName: "Sônia Pacheco", company: "Embalagens Girassol", presence: "mentioned", phone: null, existingContactId: null },
    ] });
    fireEvent.click(abaContatos());
    const citadas = screen.getByRole("region", { name: "Pessoas citadas" });
    expect(within(citadas).getByText("Foram mencionadas na conversa, mas não participaram da reunião.")).toBeInTheDocument();
    expect(within(citadas).getByText("Sônia Pacheco")).toBeInTheDocument();
    expect(within(citadas).getByText("Não participou")).toBeInTheDocument();
    expect(within(citadas).queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Criar contato/ })).toHaveLength(2);
    fireEvent.click(within(citadas).getByRole("button", { name: /Criar contato/ }));
    expect(duble.mutacoes.decideContactSuggestion.mutate).toHaveBeenCalledWith({ suggestionId: "s2", action: "create" });
  });

  it("sugestão anterior à marca (sem presença) fica com as participantes, e a seção das citadas não aparece", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [sugestaoPendente] });
    fireEvent.click(abaContatos());
    expect(screen.getByRole("heading", { level: 2, name: "Ana Souza" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pessoas citadas" })).not.toBeInTheDocument();
  });
});

describe("Detalhe da reunião — enquanto processa", () => {
  const abaContatos = () => screen.getByRole("button", { name: /Contatos/ });

  it("mostra a faixa de processamento e pausa as decisões sobre as sugestões da tentativa anterior", () => {
    abrirDetalhe({ status: "processing" }, { suggestions: [sugestaoPendente] });
    expect(screen.getByRole("status")).toHaveTextContent("Transcrevendo e analisando a reunião");
    fireEvent.click(abaContatos());
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Criar contato/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Disponível quando o processamento terminar/)).toBeInTheDocument();
  });

  it("com a reunião pronta, as decisões voltam", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [sugestaoPendente] });
    fireEvent.click(abaContatos());
    expect(screen.getByRole("button", { name: /Criar contato/ })).toBeInTheDocument();
  });

  it("decisão recusada (já decidida em outra aba): mostra a frase do servidor e relê a sugestão", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [sugestaoPendente] });
    fireEvent.click(abaContatos());
    fireEvent.click(screen.getByRole("button", { name: /Criar contato/ }));
    expect(duble.mutacoes.decideContactSuggestion.mutate).toHaveBeenCalledWith({ suggestionId: sugestaoPendente.id, action: "create" });
    duble.utils.meetings.get.invalidate.mockClear();
    const frase = "Esta pessoa já foi decidida. Atualize a tela para ver como ficou.";
    act(() => {
      duble.mutacoes.decideContactSuggestion.opcoes.onError?.({ message: frase, data: { code: "CONFLICT" } }, undefined);
      duble.mutacoes.decideContactSuggestion.opcoes.onSettled?.();
    });
    expect(toast.error).toHaveBeenCalledWith(frase);
    expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
  });

  it("detalhe e lista só consultam sozinhos enquanto há reunião processando", () => {
    abrirDetalhe({ status: "failed" });
    const detalhe = duble.get.mock.calls[0][1] as { refetchInterval: (consulta: unknown) => number | false };
    expect(detalhe.refetchInterval({ state: { data: { meeting: { status: "processing" } } } })).toBe(5000);
    expect(detalhe.refetchInterval({ state: { data: { meeting: { status: "failed" } } } })).toBe(false);
    expect(detalhe.refetchInterval({ state: { data: undefined } })).toBe(false);
    const lista = duble.list.mock.calls[0][1] as { refetchInterval: (consulta: unknown) => number | false };
    expect(lista.refetchInterval({ state: { data: [{ status: "ready" }, { status: "processing" }] } })).toBe(10000);
    expect(lista.refetchInterval({ state: { data: [{ status: "ready" }] } })).toBe(false);
  });

  it.each([
    ["ready", "success", "Reunião processada. Revise a transcrição e as sugestões."],
    ["failed", "error", "Não foi possível processar a reunião."],
  ] as const)("quando o processamento termina em %s, a tela avisa", (fim, tipo, frase) => {
    const meeting = { ...REUNIAO, status: "processing" };
    const detalheCom = (status: string) => ({
      data: { meeting: { ...meeting, status }, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false,
    });
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue(detalheCom("processing"));
    const { rerender } = render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(toast[tipo]).not.toHaveBeenCalled();

    duble.get.mockReturnValue(detalheCom(fim));
    rerender(<Meetings />);

    expect(toast[tipo]).toHaveBeenCalledWith(frase, { id: `reuniao-${fim === "ready" ? "processada" : "falhou"}-${REUNIAO.id}` });
  });

  it.each(["ready", "failed"])("abrir uma reunião %s não dispara aviso de término: só a troca a partir de 'processing' avisa", status => {
    abrirDetalhe({ status });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("na lista, uma consulta periódica que falha não troca as reuniões pela tela de erro", () => {
    duble.list.mockReturnValue({
      data: [{ ...REUNIAO, status: "processing" }], isLoading: false, isError: true,
      error: { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch: vi.fn(),
    });
    render(<Meetings />);
    expect(screen.getByRole("button", { name: /Reunião com a vinícola/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reunião excluída em outro lugar (NOT_FOUND) enquanto processava: a tela diz que não existe e para de consultar e de tentar", () => {
    const meeting = { ...REUNIAO, status: "processing" };
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue({
      data: { meeting, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: true, error: { message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } }, refetch: vi.fn(),
    });
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    // A frase da tela, e não a do servidor (que também começa por "Reunião não
    // encontrada."), e sem o tentar de novo: com a reunião já na tela, o
    // NOT_FOUND troca o detalhe pelo aviso definitivo.
    expect(screen.getByRole("alert")).toHaveTextContent(i18n.t("meetings.meetingNotFound"));
    expect(screen.queryByRole("button", { name: /Tentar novamente/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Transcrevendo e analisando/)).not.toBeInTheDocument();

    const opcoes = duble.get.mock.calls[0][1] as { refetchInterval: (consulta: unknown) => number | false; retry: (tentativas: number, erro: unknown) => boolean };
    const naoEncontrada = { data: { code: "NOT_FOUND" } };
    expect(opcoes.refetchInterval({ state: { data: { meeting: { status: "processing" } }, error: naoEncontrada } })).toBe(false);
    expect(opcoes.retry(0, naoEncontrada)).toBe(false);
    expect(opcoes.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(opcoes.retry(3, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });

  it("uma consulta periódica que falha não troca a reunião pela tela de erro", () => {
    const meeting = { ...REUNIAO, status: "processing" };
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue({
      data: { meeting, transcript: null, entities: [], suggestions: [], recording: null, recordingExpired: false },
      isLoading: false, isError: true, error: { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } }, refetch: vi.fn(),
    });
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(screen.getByRole("heading", { name: "Reunião com a vinícola" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("em processamento, a transcrição da tentativa anterior não é mandada traduzir", async () => {
    await i18n.changeLanguage("en");
    try {
      abrirDetalhe({ status: "processing" }, { transcript: { id: "t1", transcript: "Fala da reunião.", language: "pt" } });
      expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });

  it("…e com a reunião pronta, a tradução automática segue como antes", async () => {
    await i18n.changeLanguage("en");
    try {
      abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Fala da reunião.", language: "pt" } });
      expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, language: "en" }, expect.anything());
      // A resposta é aplicada pelo callback do próprio pedido, que só vale para o
      // último; no hook não há onSuccess que aplique uma resposta atrasada.
      const [, opcoesDoPedido] = duble.mutacoes.translateTranscript.mutate.mock.calls[0] as [unknown, { onSuccess?: unknown }];
      expect(opcoesDoPedido.onSuccess).toBeInstanceOf(Function);
      expect(duble.mutacoes.translateTranscript.opcoes.onSuccess).toBeUndefined();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });

  it("transcrição trocada: a tradução anterior sai da tela antes do pedido novo, e se ele falhar não sobra tradução de outro texto", async () => {
    await i18n.changeLanguage("en");
    try {
      const meeting = { ...REUNIAO, status: "ready" };
      const detalheCom = (transcricao: { id: string; transcript: string }) => ({
        data: { meeting, transcript: { ...transcricao, language: "pt" }, entities: [], suggestions: [], recording: null, recordingExpired: false },
        isLoading: false,
      });
      duble.list.mockReturnValue({ data: [meeting], isLoading: false });
      duble.get.mockReturnValue(detalheCom({ id: "t1", transcript: "Fala antiga." }));
      const { rerender } = render(<Meetings />);
      fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
      fireEvent.click(screen.getByRole("button", { name: /Transcri/ }));

      const [, primeiroPedido] = duble.mutacoes.translateTranscript.mutate.mock.calls[0] as [unknown, { onSuccess: (resultado: { text: string }) => void }];
      act(() => { primeiroPedido.onSuccess({ text: "Old talk, translated." }); });
      expect(screen.getByText("Old talk, translated.")).toBeInTheDocument();

      // Um reprocessamento trocou a transcrição; o pedido novo sai e ainda não respondeu.
      duble.get.mockReturnValue(detalheCom({ id: "t2", transcript: "Fala nova." }));
      rerender(<Meetings />);

      expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Old talk, translated.")).not.toBeInTheDocument();
      expect(screen.getByText("Fala nova.")).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });
});

// A duração do arquivo lida pelo navegador (revisão adversarial de 15/09: sem
// lê-la, a tela mandava 60 s, e um .webm de 25 minutos passava pela conferência
// dos 10 minutos) só vale, desde a G14, no recuo do corte, o arquivo curto que
// ainda vai pelo envio único: os casos dela (ilegível, longa demais e dentro do
// limite) estão em Meetings.importacao.test.tsx. Todo outro arquivo vai em
// partes, e o servidor mede cada parte nos bytes.

describe("Idioma da reunião (G1b) e versão do aviso (G4)", () => {
  const TRANSCRICAO_ABA = /^Transcrição$/;

  /**
   * O gravador do /gravar com o idioma escolhido, até o Iniciar: desde a G14 a
   * gravação é sempre em partes, e o idioma e a versão do aviso vão ao servidor
   * quando a reunião nasce (o iniciar do hook, dublado nesta suíte). O microfone
   * é negado logo depois: o que interessa aqui é o que o Iniciar mandou.
   */
  async function iniciarNoIdioma(idioma: string | null, titulo: string) {
    duble.list.mockReturnValue({ data: [], isLoading: false });
    vi.stubGlobal("MediaRecorder", class { static isTypeSupported() { return true; } });
    const microfone = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { throw new DOMException("negado", "NotAllowedError"); } } });
    try {
      window.history.replaceState(null, "", "/gravar");
      render(<Meetings />);
      const seletor = screen.getByLabelText("Idioma da reunião") as HTMLSelectElement;
      if (idioma) fireEvent.change(seletor, { target: { value: idioma } });
      fireEvent.change(screen.getByPlaceholderText("Ex.: Conversa com investidor"), { target: { value: titulo } });
      fireEvent.click(screen.getByRole("checkbox"));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Iniciar gravação/ })); });
      await waitFor(() => expect(opcoesDaGravacaoEmPartes.iniciar).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
      if (microfone) Object.defineProperty(navigator, "mediaDevices", microfone);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  }

  it("o gravador começa no idioma da tela e manda o idioma escolhido e a versão do aviso", async () => {
    duble.list.mockReturnValue({ data: [], isLoading: false });
    window.history.replaceState(null, "", "/gravar");
    const { unmount } = render(<Meetings />);
    expect((screen.getByLabelText("Idioma da reunião") as HTMLSelectElement).value).toBe("pt-BR");
    unmount();
    await iniciarNoIdioma("en", "Call with Ana");
    expect(opcoesDaGravacaoEmPartes.iniciar).toHaveBeenCalledWith({ title: "Call with Ana", language: "en", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
    // Nada pelo envio único, que saiu do gravador na G14.
  });

  it("com a tela em inglês, o gravador já começa em inglês", async () => {
    await i18n.changeLanguage("en");
    try {
      duble.list.mockReturnValue({ data: [], isLoading: false });
      render(<Meetings />);
      fireEvent.click(screen.getByRole("button", { name: /New meeting/ }));
      expect((screen.getByLabelText("Meeting language") as HTMLSelectElement).value).toBe("en");
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });

  it("a dica do idioma não promete transcrever tudo nele: quem fala outro idioma sai no idioma em que falou (T25)", () => {
    duble.list.mockReturnValue({ data: [], isLoading: false });
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Nova reunião/ }));
    expect(screen.getByText("O idioma principal da conversa. Quem falar em outro idioma é transcrito no idioma em que falou; a tradução fica na aba Transcrição.")).toBeInTheDocument();
    expect(screen.queryByText(/A IA transcreve neste idioma/)).not.toBeInTheDocument();
  });

  it("nos 10 idiomas, a dica cita a aba Transcrição pelo nome que ela tem na tela; em alemão e francês, o outro idioma sai no idioma em que foi dito, não 'nesta língua' (T25)", () => {
    for (const { code } of LANGUAGES) {
      const traduzir = i18n.getFixedT(code);
      expect(traduzir("meetings.meetingLanguageHint"), code).toContain(traduzir("meetings.transcriptTab"));
    }
    expect(i18n.getFixedT("de")("meetings.meetingLanguageHint")).toContain("wird in der Sprache transkribiert, in der es gesagt wurde");
    expect(i18n.getFixedT("fr")("meetings.meetingLanguageHint")).toContain("est transcrit dans la langue dans laquelle il a été dit");
  });

  it("reunião em inglês com a tela em pt-BR: o original é o inglês, e o pt-BR é TRADUZIDO", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Long talk.", language: "en" } });
    expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, language: "pt-BR" }, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: TRANSCRICAO_ABA }));
    expect(screen.getByRole("option", { name: /English \(original\)/ })).toBeInTheDocument();
  });

  it("reunião em inglês com a tela em inglês: mostra o original, sem pedir tradução", async () => {
    await i18n.changeLanguage("en");
    try {
      abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Long talk.", language: "en" } });
      expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });

  it("G16: o gravador oferece \"Detectar sozinho\", com a dica dele, e manda \"auto\"", async () => {
    duble.list.mockReturnValue({ data: [], isLoading: false });
    window.history.replaceState(null, "", "/gravar");
    const { unmount } = render(<Meetings />);
    const seletor = screen.getByLabelText("Idioma da reunião") as HTMLSelectElement;
    expect(within(seletor).getByRole("option", { name: "🌐 Detectar sozinho" })).toBeInTheDocument();
    fireEvent.change(seletor, { target: { value: "auto" } });
    expect(screen.getByText(/A IA reconhece o idioma de cada fala/)).toBeInTheDocument();
    unmount();
    await iniciarNoIdioma("auto", "Call with Ana");
    expect(opcoesDaGravacaoEmPartes.iniciar).toHaveBeenCalledWith(expect.objectContaining({ language: "auto" }));
  });

  it("G16: um idioma fora dos 10 da tela (italiano) está na lista e vai ao servidor", async () => {
    await iniciarNoIdioma("it", "Riunione");
    expect((screen.getByLabelText("Idioma da reunião") as HTMLSelectElement).value).toBe("it");
    expect(opcoesDaGravacaoEmPartes.iniciar).toHaveBeenCalledWith(expect.objectContaining({ title: "Riunione", language: "it" }));
  });

  it("G16: reunião em italiano com a tela em pt-BR: o pt-BR é TRADUZIDO, e a lista ganha \"Italiano (original)\", que volta ao original", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Parliamo del contratto.", language: "it" } });
    expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, language: "pt-BR" }, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: TRANSCRICAO_ABA }));
    const original = screen.getByRole("option", { name: "Italiano (original)" });
    expect(original).toBeInTheDocument();
    duble.mutacoes.translateTranscript.mutate.mockClear();
    fireEvent.change(original.closest("select")!, { target: { value: "it" } });
    expect(screen.getByText(/Parliamo del contratto\./)).toBeInTheDocument();
    expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
  });

  it("G16: com \"Detectar sozinho\", a aba da transcrição diz os idiomas que a IA reconheceu e o do resumo", () => {
    abrirDetalhe({ status: "ready", language: "auto" } as Partial<typeof REUNIAO>, { transcript: {
      id: "t1", transcript: "Good morning.\nBom dia.", language: "en",
      segments: [{ inicio: 0, fim: 60, falante: "F1", texto: "Good morning.", idioma: "en" }, { inicio: 60, fim: 100, falante: "F2", texto: "Bom dia.", idioma: "pt-BR" }],
    } });
    fireEvent.click(screen.getByRole("button", { name: TRANSCRICAO_ABA }));
    expect(screen.getByRole("note")).toHaveTextContent(/Idiomas reconhecidos pela IA: inglês \(60\s?%\), português \(40\s?%\)\. O resumo sai em inglês/);
  });

  it("o título sugerido pela IA aparece só com a sugestão, e \"Usar este título\" pede o uso", () => {
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: "📱", idioma: "pt-BR", erro: null, itens: [], tituloSugerido: "Lançamento nas lojas" }, isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Fala.", language: "pt-BR" } });
    const caixa = screen.getByRole("region", { name: "Título sugerido pela IA" });
    expect(caixa).toHaveTextContent("📱Lançamento nas lojas");
    fireEvent.click(within(caixa).getByRole("button", { name: "Usar este título" }));
    expect(duble.mutacoes.decidirTituloSugerido.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, usar: true });
  });

  it("reunião antiga gravada como 'pt' com a tela em pt-BR: o original, sem pedir tradução", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Fala antiga.", language: "pt" } });
    expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: TRANSCRICAO_ABA }));
    expect(screen.getByRole("option", { name: /Português \(original\)/ })).toBeInTheDocument();
  });
});

describe("Tradução de reunião longa em segundo plano (G8)", () => {
  it("'em andamento': mostra o aviso da reunião longa e pergunta de novo a cada 5 s, até a tradução chegar", async () => {
    vi.useFakeTimers();
    try {
      abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Fala longa.", language: "en" } });
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      const pedidos = duble.mutacoes.translateTranscript.mutate.mock.calls;
      expect(pedidos).toHaveLength(1);
      act(() => { (pedidos[0][1] as { onSuccess: (r: unknown) => void }).onSuccess({ language: "pt-BR", text: null, cached: false, emAndamento: true }); });
      expect(screen.getByRole("status")).toHaveTextContent("A reunião é longa");
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(pedidos).toHaveLength(2);
      act(() => { (pedidos[1][1] as { onSuccess: (r: unknown) => void }).onSuccess({ language: "pt-BR", text: "Fala longa traduzida.", cached: true }); });
      expect(screen.getByText("Fala longa traduzida.")).toBeInTheDocument();
      expect(screen.queryByText(/A reunião é longa/)).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(pedidos).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("erro depois de um 'em andamento' desliga o aviso: ele não gira para sempre", async () => {
    vi.useFakeTimers();
    try {
      abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Long talk.", language: "en" } });
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      const pedidos = duble.mutacoes.translateTranscript.mutate.mock.calls;
      act(() => { (pedidos[0][1] as { onSuccess: (r: unknown) => void }).onSuccess({ language: "pt-BR", text: null, cached: false, emAndamento: true }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      act(() => { (pedidos[1][1] as { onError: (e: unknown) => void }).onError(new Error("cota")); });
      expect(screen.queryByText(/A reunião é longa/)).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("voltar ao original cancela a pergunta agendada", async () => {
    vi.useFakeTimers();
    try {
      abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Long talk.", language: "en" } });
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      const pedidos = duble.mutacoes.translateTranscript.mutate.mock.calls;
      act(() => { (pedidos[0][1] as { onSuccess: (r: unknown) => void }).onSuccess({ language: "pt-BR", text: null, cached: false, emAndamento: true }); });
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(pedidos).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.getByText("Long talk.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * T25 (teste do Lucas, 20/11): o "Idioma de destino" começa no idioma do site,
 * e a reunião em inglês aberta com o site em português aparecia traduzida, em
 * texto corrido, sem nada que dissesse que era tradução. O inglês "sumia".
 */
describe("Detalhe da reunião — o aviso de tradução automática (T25)", () => {
  const FALAS_EM_INGLES = [
    { inicio: 5, fim: 12, falante: "F1", texto: "We will sign the contract on Friday." },
    { inicio: 13, fim: 20, falante: "F2", texto: "Great, send me the draft." },
  ];
  const EM_INGLES = { id: "t1", transcript: "We will sign the contract on Friday. Great, send me the draft.", language: "en", segments: FALAS_EM_INGLES };
  type PedidoDeTraducao = [unknown, { onSuccess: (resultado: unknown) => void; onError: (erro: unknown) => void }];
  const pedidos = () => duble.mutacoes.translateTranscript.mutate.mock.calls as PedidoDeTraducao[];

  it("reunião em inglês aberta com a tela em pt-BR: a tradução vem com o aviso, e 'Ver original' volta às falas com falante e horário", () => {
    abrirDetalhe({ status: "ready" }, { transcript: EM_INGLES });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(pedidos()).toHaveLength(1);
    act(() => { pedidos()[0][1].onSuccess({ language: "pt-BR", text: "Vamos assinar o contrato na sexta. Ótimo, me mande a minuta.", cached: false }); });
    expect(screen.getByText("Vamos assinar o contrato na sexta. Ótimo, me mande a minuta.")).toBeInTheDocument();
    expect(screen.getByText("Tradução automática para o português.")).toBeInTheDocument();
    expect(screen.queryByText("Falante 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
    expect(screen.getByRole("combobox")).toHaveValue("en");
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Falante 1")).toBeInTheDocument();
    expect(within(falas).getByText("We will sign the contract on Friday.")).toBeInTheDocument();
    expect(within(falas).getByRole("button", { name: "Ouvir a partir de 00:13" })).toBeInTheDocument();
    // O original já estava aqui: nada é pedido de novo.
    expect(pedidos()).toHaveLength(1);
  });

  it("'Ver original' some com o aviso e deixa o foco no seletor do idioma, que mostra o original, em vez de largá-lo no <body>", () => {
    abrirDetalhe({ status: "ready" }, { transcript: EM_INGLES });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    act(() => { pedidos()[0][1].onSuccess({ language: "pt-BR", text: "Vamos assinar o contrato na sexta. Ótimo, me mande a minuta.", cached: false }); });
    const verOriginal = screen.getByRole("button", { name: "Ver original" });
    verOriginal.focus();
    fireEvent.click(verOriginal);
    expect(verOriginal).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("en");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("tela no idioma da reunião: as falas, sem o aviso e sem pedir tradução", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Vamos assinar na sexta.", language: "pt-BR", segments: [{ inicio: 5, fim: 12, falante: "F1", texto: "Vamos assinar na sexta." }] } });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
    expect(within(document.querySelector("ol")!).getByText("Falante 1")).toBeInTheDocument();
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver original" })).not.toBeInTheDocument();
  });

  it("na espera da tradução da reunião longa, o aviso já leva ao original, e a pergunta agendada não sai", async () => {
    vi.useFakeTimers();
    try {
      abrirDetalhe({ status: "ready" }, { transcript: EM_INGLES });
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      act(() => { pedidos()[0][1].onSuccess({ language: "pt-BR", text: null, cached: false, emAndamento: true }); });
      expect(screen.getByText(/A reunião é longa/)).toBeInTheDocument();
      expect(screen.getByText("Tradução automática para o português.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
      expect(screen.queryByText(/A reunião é longa/)).not.toBeInTheDocument();
      expect(within(document.querySelector("ol")!).getByText("Falante 1")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(pedidos()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tradução que falhou deixa o original na tela, sem dizer que é tradução", () => {
    abrirDetalhe({ status: "ready" }, { transcript: EM_INGLES });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    act(() => { pedidos()[0][1].onError(new Error("cota")); });
    expect(screen.getByText(EM_INGLES.transcript)).toBeInTheDocument();
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
  });
});

describe("Detalhe da reunião — falantes, partes e andamento (D1)", () => {
  const SEGMENTOS = [
    { inicio: 5, fim: 20, falante: "F1", texto: "Vamos fechar o contrato." },
    { inicio: 620, fim: 640, falante: "F2", texto: "O frete fica para sexta." },
  ];

  it("a transcrição em partes aparece por falante, e clicar no tempo leva o player à parte certa", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Vamos fechar o contrato. O frete fica para sexta.", language: "pt-BR", segments: SEGMENTOS }, recording: GRAVACAO });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Falante 1")).toBeInTheDocument();
    expect(within(falas).getByText("Falante 2")).toBeInTheDocument();
    expect(screen.getByText("Tempo de fala")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:20" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
  });

  // O link para dentro da reunião chega direto ao endereço do detalhe, com ?t ou ?q.
  function abrirPeloLink(busca: string, transcricao: { language: string; segments: unknown[] } = { language: "pt-BR", segments: SEGMENTOS }) {
    const meeting = { ...REUNIAO, status: "ready" };
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue({
      data: { meeting, transcript: { id: "t1", transcript: "x", ...transcricao }, entities: [], suggestions: [], recording: GRAVACAO, recordingExpired: false },
      isLoading: false,
    });
    window.history.replaceState(null, "", `/meetings/${REUNIAO.id}${busca}`);
    render(<Meetings />);
  }

  it("o link com ?t abre a transcrição e já leva o player ao segundo pedido", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const antes = window.location.href;
    try {
      abrirPeloLink("?t=620");
      expect(screen.getByText("Tempo de fala")).toBeInTheDocument();
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  // Defeito 1 do teste manual T50 (23/11): o resultado da busca entre as
  // reuniões (?q) abria a reunião sem ir ao trecho encontrado.
  it("o link com ?q abre a transcrição no trecho do termo: a fala marcada e o player no tempo dela", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const antes = window.location.href;
    try {
      abrirPeloLink("?q=frete");
      expect(screen.getByRole("searchbox")).toHaveValue("frete");
      expect(document.querySelector("[data-fala-do-link]")).toHaveTextContent("O frete fica para sexta.");
      // A fala do frete começa aos 620 s, na segunda parte.
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  // A reunião em inglês com a tela em português (G16: o original de outro idioma é comum).
  const EM_INGLES = {
    language: "en",
    segments: [
      { inicio: 5, fim: 20, falante: "F1", texto: "We will sign the contract on Monday." },
      { inicio: 620, fim: 640, falante: "F2", texto: "Shipping stays for Friday." },
    ],
  };

  it("o ?q da busca, na reunião em outro idioma: a transcrição abre no original, com o termo, e nada é traduzido antes da escolha", () => {
    const antes = window.location.href;
    try {
      abrirPeloLink("?q=contract", EM_INGLES);
      expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole("combobox", { name: /Idioma/ })).toHaveValue("en");
      // A transcrição inteira, com a fala do termo marcada (defeito 1 do T50).
      expect(document.querySelectorAll("ol li")).toHaveLength(2);
      expect(document.querySelector("[data-fala-do-link]")).toHaveTextContent("We will sign the contract on Monday.");
      expect(screen.getByRole("searchbox")).toHaveValue("contract");
      expect(document.querySelector("mark")).toHaveTextContent("contract");
      // A dona ainda escolhe a tradução: aí, sim, o pedido sai.
      fireEvent.change(screen.getByRole("combobox", { name: /Idioma/ }), { target: { value: "pt-BR" } });
      expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, language: "pt-BR" }, expect.anything());
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  it("o ?t da Memória, na reunião em outro idioma, também abre as falas do original, com o tempo", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const antes = window.location.href;
    try {
      abrirPeloLink("?t=620", EM_INGLES);
      expect(duble.mutacoes.translateTranscript.mutate).not.toHaveBeenCalled();
      expect(screen.getByText("Tempo de fala")).toBeInTheDocument();
      expect(screen.getByText("Shipping stays for Friday.")).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  it("sem link para um ponto, a reunião em outro idioma abre traduzida para o idioma da tela, como antes", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "x", ...EM_INGLES }, recording: GRAVACAO });
    expect(duble.mutacoes.translateTranscript.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, language: "pt-BR" }, expect.anything());
  });

  it("o player é um só, fixo no rodapé, e é o mesmo em todas as abas (o áudio não para ao trocar)", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "x", language: "pt-BR", segments: SEGMENTOS }, recording: GRAVACAO });
    const barra = screen.getByRole("region", { name: "Gravação" });
    const audio = barra.querySelector("audio");
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(document.querySelector("audio")).toBe(audio);
    fireEvent.click(screen.getByRole("button", { name: /^Contatos/ }));
    expect(document.querySelector("audio")).toBe(audio);
  });

  it("outro ?t para a mesma reunião, sem remontar a tela, leva o mesmo player ao ponto novo", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const antes = window.location.href;
    try {
      abrirPeloLink("?t=620");
      const audio = document.querySelector("audio");
      expect(audio!.getAttribute("src")).toBe(PARTES[1].url);
      // Um link vindo do sino ou da busca, com a reunião já aberta.
      fireEvent.click(screen.getByRole("button", { name: /^Resumo$/ }));
      act(() => { window.history.pushState(null, "", `/meetings/${REUNIAO.id}?t=10`); });
      expect(screen.getByText("Tempo de fala")).toBeInTheDocument();
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[0].url);
      // A usuária vai a outro ponto pelo "▶" da transcrição; trocar de aba
      // (que redesenha a tela com a mesma busca) não a puxa de volta ao ?t.
      fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:20" }));
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
      fireEvent.click(screen.getByRole("button", { name: /^Resumo$/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  it("?t além das partes que chegaram, com a reunião ainda chegando: o pulo espera a parte, e vai quando ela chega", () => {
    const tocar = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const antes = window.location.href;
    try {
      const meeting = { ...REUNIAO, status: "uploading", audioPipeline: "slices" };
      const dado = (partes: typeof PARTES) => ({
        data: { meeting, transcript: null, entities: [], suggestions: [], recording: { ...GRAVACAO, partes }, recordingExpired: false, andamento: { recebidas: partes.length, transcritas: 0, esperadas: 2 } },
        isLoading: false,
      });
      duble.list.mockReturnValue({ data: [meeting], isLoading: false });
      duble.get.mockReturnValue(dado([PARTES[0]]));
      window.history.replaceState(null, "", `/meetings/${REUNIAO.id}?t=620`);
      const { rerender } = render(<Meetings />);
      // Só a parte 0 (0 a 600 s) chegou: o player não pula para o fim dela.
      expect(tocar).not.toHaveBeenCalled();
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[0].url);
      duble.get.mockReturnValue(dado(PARTES));
      rerender(<Meetings />);
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });

  it("sem áudio, não há barra do player nem o espaço dela", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "x", language: "pt-BR", segments: SEGMENTOS }, recording: null });
    expect(screen.queryByRole("region", { name: "Gravação" })).toBeNull();
    expect(document.querySelector("main")!.className).not.toContain("pb-36");
  });

  it("o áudio que não carrega vira o aviso na barra", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "x", language: "pt-BR", segments: SEGMENTOS }, recording: GRAVACAO });
    const barra = screen.getByRole("region", { name: "Gravação" });
    expect(within(barra).getByRole("status")).toHaveTextContent("");
    fireEvent.error(barra.querySelector("audio")!);
    expect(within(barra).getByRole("status")).not.toHaveTextContent(/^$/);
    expect(document.querySelector("main")!.className).toContain("pb-36");
  });

  it("a parte do meio que não carrega pula para a seguinte, e o aviso segue na barra quando a seguinte carrega (D1b)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const partes = [...PARTES, { seq: 2, url: "/manus-storage/meetings/dona/r/partes/0002-c.m4a", mimeType: "audio/mp4", inicioSegundos: 900, duracaoSegundos: 300, expiresAt: Date.now() + 1e9 }];
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "x", language: "pt-BR", segments: SEGMENTOS }, recording: { ...GRAVACAO, durationSeconds: 1200, partes } });
    const barra = screen.getByRole("region", { name: "Gravação" });
    const audio = barra.querySelector("audio")!;
    fireEvent.click(within(barra).getByRole("button", { name: "Tocar" }));
    fireEvent.ended(audio);
    fireEvent.error(audio);
    expect(audio.getAttribute("src")).toBe(partes[2].url);
    fireEvent.loadedMetadata(audio);
    fireEvent.loadedData(audio);
    // Sem o aviso, o salto de 10 a 15 min ficaria sem explicação.
    expect(within(barra).getByRole("status")).toHaveTextContent("Não foi possível carregar o áudio agora.");
  });

  it("a transcrição antiga, sem falantes, segue como texto corrido", () => {
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Fala antiga.", language: "pt", segments: [] } });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(screen.getByText("Fala antiga.")).toBeInTheDocument();
    expect(screen.queryByText("Falante 1")).not.toBeInTheDocument();
  });

  it("reunião em partes chegando: o andamento diz quantas chegaram e quantas foram transcritas", () => {
    abrirDetalhe({ status: "uploading", audioPipeline: "slices", expectedSlices: 3 } as never, { andamento: { recebidas: 2, transcritas: 1, esperadas: 3 } } as never);
    expect(screen.getByText(/Recebendo o áudio: 2 de 3/)).toBeInTheDocument();
    expect(screen.getByText("Transcrevendo: 1 de 3")).toBeInTheDocument();
    expect(screen.getAllByText("Recebendo o áudio").length).toBeGreaterThan(0);
  });

  // Conferência de tela do pacote 4b: em árabe o ícone girando ficava colado ao
  // texto ("جارٍ استلام الصوت"), porque a margem era a da direita (mr-2) também
  // na escrita da direita para a esquerda. A margem lógica (me-2) acompanha o ícone.
  it("em árabe, o ícone girando do andamento tem a margem do lado do texto (me-2, e não mr-2)", async () => {
    await i18n.changeLanguage("ar");
    try {
      abrirDetalhe({ status: "uploading", audioPipeline: "slices", expectedSlices: 3 } as never, { andamento: { recebidas: 2, transcritas: 1, esperadas: 3 } } as never);
      const caixa = screen.getByText(/جارٍ استلام الصوت: 2 من 3/).closest("[role=status]")!;
      const icone = caixa.querySelector("svg.animate-spin")!;
      expect(icone).toHaveClass("me-2");
      expect(icone).not.toHaveClass("mr-2");
    } finally {
      await i18n.changeLanguage("pt-BR");
    }
  });
});

describe("Detalhe da reunião — durante a gravação e ouvir só uma voz (G15a e D2)", () => {
  const SEGMENTOS = [
    { inicio: 5, fim: 20, falante: "F1", texto: "Vamos fechar o contrato." },
    { inicio: 620, fim: 640, falante: "F2", texto: "O frete fica para sexta." },
  ];

  it("G15a: a reunião em partes ainda chegando mostra, na aba Transcrição, o texto das partes prontas, com o Pergunte da gravação", async () => {
    duble.transcricaoDaGravacao.mockResolvedValue({
      status: "uploading", emPartes: true, agora: Date.now(), nomes: {},
      partes: [{ seq: 0, estado: "transcrita", inicioSegundos: 0, duracaoSegundos: 600, chegouEm: Date.now() - 60_000, prontaEm: Date.now(), atrasoSegundos: 45 }],
      falas: [{ seq: 0, segmentos: [{ inicio: 5, fim: 20, falante: "F1", texto: "Vamos fechar o contrato." }] }],
    });
    abrirDetalhe({ status: "uploading", audioPipeline: "slices", expectedSlices: 2 } as never, { andamento: { recebidas: 1, transcritas: 1, esperadas: 2 } } as never);
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(await screen.findByText("Vamos fechar o contrato.")).toBeInTheDocument();
    expect(duble.transcricaoDaGravacao).toHaveBeenCalledWith({ meetingId: REUNIAO.id, desde: 0 });
    expect(screen.getByText(/texto pronto 45 s depois de a parte chegar/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pergunte sobre o que já foi dito" })).toBeInTheDocument();
    expect(screen.queryByText("A transcrição ainda não está disponível.")).not.toBeInTheDocument();
  });

  it("G15a: a reunião do envio único sem transcrição segue dizendo que a transcrição não está pronta, sem consultar as partes", () => {
    abrirDetalhe({ status: "processing" }, {});
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(duble.transcricaoDaGravacao).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Transcrição até agora" })).not.toBeInTheDocument();
    expect(screen.getByText("A transcrição ainda não está disponível.")).toBeInTheDocument();
  });

  it("D2: ouvir só uma voz pela transcrição: a barra diz qual e toca a fala dela; Ouvir todas as vozes volta", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Vamos fechar o contrato. O frete fica para sexta.", language: "pt-BR", segments: SEGMENTOS }, recording: GRAVACAO });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ouvir só a voz de Falante 2" }));
    // A fala da voz 2 está na parte 2 (de 619,75 s): o player vai até ela.
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
    const barra = screen.getByRole("region", { name: "Gravação" });
    expect(within(barra).getByText("Ouvindo só: Falante 2")).toBeInTheDocument();
    // A lista mostra só as falas da voz escolhida.
    expect(within(document.querySelector("ol")!).queryByText("Vamos fechar o contrato.")).not.toBeInTheDocument();
    fireEvent.click(within(barra).getByRole("button", { name: "Ouvir todas as vozes" }));
    expect(within(barra).queryByText(/Ouvindo só/)).not.toBeInTheDocument();
    expect(within(document.querySelector("ol")!).getByText("Vamos fechar o contrato.")).toBeInTheDocument();
  });

  it("H3c: a voz juntada pela dona soma com a principal no tempo de fala e no ouvir só esta voz", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const segments = [
      { inicio: 0, fim: 25, falante: "F1", texto: "Bom dia a todas." },
      { inicio: 25, fim: 75, falante: "F2", texto: "Vamos fechar o contrato." },
      { inicio: 75, fim: 100, falante: "F3", texto: "O frete fica para sexta." },
    ];
    abrirDetalhe({ status: "ready", vozes: { nomes: { F2: "Participante Teste" }, juntadas: { F3: "F2" } } } as never,
      { transcript: { id: "t1", transcript: "x", language: "pt-BR", segments }, recording: GRAVACAO });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    const tempo = screen.getByText("Tempo de fala").parentElement!;
    // Uma linha só para a voz 2, com os 75 s dela e da voz 3 juntos (75%), e não 50% e 25%.
    expect(within(tempo).getAllByText("Participante Teste")).toHaveLength(1);
    expect(within(tempo).getByText(/· 75%/)).toBeInTheDocument();
    expect(within(tempo).queryByText(/· 50%/)).not.toBeInTheDocument();
    expect(within(tempo).queryByText("Falante 3")).not.toBeInTheDocument();
    // Ouvir só a voz dela mostra as falas das duas vozes juntadas.
    fireEvent.click(within(tempo).getByRole("button", { name: "Ouvir só a voz de Participante Teste" }));
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Vamos fechar o contrato.")).toBeInTheDocument();
    expect(within(falas).getByText("O frete fica para sexta.")).toBeInTheDocument();
    expect(within(falas).queryByText("Bom dia a todas.")).not.toBeInTheDocument();
  });
});

describe("Detalhe da reunião — pendências de Tenho/Preciso na aba Contatos", () => {
  const abaContatos = () => screen.getByRole("button", { name: /Contatos/ });
  // Quem Sou completo: todo FALTANDO na tela vem de Tenho/Preciso.
  const pessoaCompleta = { ...sugestaoPendente, phone: "+55 11 99999-0000", email: "ana@vinicola.com.br", existingContactId: null };
  const alertaDeFalta = () => screen.queryByText(/Faltam informações importantes/);

  it("lidas e vazias: FALTANDO em O Que Tenho e O Que Preciso, com o alerta", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [pessoaCompleta] });
    fireEvent.click(abaContatos());
    expect(screen.getAllByText("FALTANDO")).toHaveLength(2);
    expect(alertaDeFalta()).toBeInTheDocument();
  });

  it("ainda carregando: nenhum FALTANDO nem alerta, e a aba diz que carrega", () => {
    duble.pendencias.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { suggestions: [pessoaCompleta] });
    fireEvent.click(abaContatos());
    expect(screen.queryByText("FALTANDO")).not.toBeInTheDocument();
    expect(alertaDeFalta()).not.toBeInTheDocument();
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });

  it("consulta falhou: erro com tentar de novo, em vez de afirmar que falta informação", () => {
    const refetch = vi.fn();
    duble.pendencias.mockReturnValue(emErro(refetch));
    abrirDetalhe({ status: "ready" }, { suggestions: [pessoaCompleta] });
    fireEvent.click(abaContatos());
    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM);
    expect(screen.queryByText("FALTANDO")).not.toBeInTheDocument();
    expect(alertaDeFalta()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("o reprocessamento termina: as pendências DESTA reunião são relidas do zero (reset), não ficam as da tentativa anterior", () => {
    const meeting = { ...REUNIAO, status: "processing" };
    const detalheCom = (status: string) => ({
      data: { meeting: { ...meeting, status }, transcript: null, entities: [], suggestions: [pessoaCompleta], recording: null, recordingExpired: false },
      isLoading: false,
    });
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue(detalheCom("processing"));
    const { rerender } = render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(duble.utils.networkInteligente.pendencias.reset).not.toHaveBeenCalled();
    expect(duble.pendencias).toHaveBeenCalledWith({ meetingId: REUNIAO.id }, expect.anything());

    duble.get.mockReturnValue(detalheCom("ready"));
    rerender(<Meetings />);
    expect(duble.utils.networkInteligente.pendencias.reset).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
  });
});

describe("Detalhe da reunião — o resumo guardado e as perguntas pela IA (H4c)", () => {
  const TRANSCRICAO = { id: "t1", meetingId: REUNIAO.id, transcript: "Ana: vamos fechar o contrato até sexta-feira.", language: "pt" };
  const ITEM = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const ITENS = [
    { id: "a0000000-0000-4000-8000-000000000001", section: "action", position: 0, subject: null, text: "{F1} manda a minuta do contrato", assignee: "{F1}", due: null, excerpt: "eu mando a minuta do contrato", startSeconds: 42, status: "pending", done: false },
    { id: ITEM, section: "decision", position: 1, subject: null, text: "Fechar o contrato até sexta-feira.", assignee: null, due: null, excerpt: "vamos fechar o contrato até sexta-feira", startSeconds: 620, status: "confirmed", done: false },
  ];
  const resumoPronto = (emoji: string | null = "📄") => ({ data: { estado: "pronto", emoji, idioma: "pt-BR", erro: null, itens: ITENS }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  const opcoesDaConsulta = () => duble.resumoGuardado.mock.calls.at(-1)![1] as {
    enabled: boolean;
    refetchInterval: (consulta: { state: { data?: { estado: string }; error: unknown } }) => number | false;
    retry: (tentativas: number, erro: unknown) => boolean;
  };

  // O link para dentro da reunião chega direto ao endereço do detalhe.
  function abrirPeloLink(busca: string, reuniao: Record<string, unknown> = {}, detalhe: Partial<Detalhe> = {}) {
    const meeting = { ...REUNIAO, status: "ready", ...reuniao };
    duble.list.mockReturnValue({ data: [meeting], isLoading: false });
    duble.get.mockReturnValue({ data: { meeting, transcript: TRANSCRICAO, entities: [], suggestions: [], recording: null, recordingExpired: false, ...detalhe }, isLoading: false });
    window.history.replaceState(null, "", `/meetings/${REUNIAO.id}${busca}`);
    render(<Meetings />);
  }
  // O <audio> do player fixo no rodapé, um só para todas as abas.
  const audioDaBarra = () => screen.getByRole("region", { name: "Gravação" }).querySelector("audio")!;

  it("reunião pronta com transcrição: o resumo guardado e o Pergunte à reunião aparecem na aba Resumo; sem resumo, 'Gerar resumo' o pede", () => {
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    expect(duble.resumoGuardado).toHaveBeenCalledWith({ meetingId: REUNIAO.id }, expect.objectContaining({ enabled: true }));
    expect(screen.getByRole("heading", { name: "Resumo da reunião" })).toBeInTheDocument();
    expect(screen.getByText("Pergunte à reunião")).toBeInTheDocument();
    // As fotos e os desenhos do resumo (H4g e H4h), da reunião aberta, sem link ligado.
    expect(screen.getByTestId("anexos-do-resumo")).toHaveAttribute("data-reuniao", REUNIAO.id);
    expect(screen.getByTestId("anexos-do-resumo")).toHaveAttribute("data-link", "false");

    fireEvent.click(screen.getByRole("button", { name: /Gerar resumo/ }));

    // No modelo escolhido ao lado do botão: o Geral, de início (H4d).
    expect(duble.mutacoes.pedirResumo.mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id, modelo: "general" });
  });

  it.each([
    ["pronta sem transcrição", "ready", null],
    ["em processamento", "processing", TRANSCRICAO],
    ["com falha", "failed", TRANSCRICAO],
  ])("reunião %s: nem o resumo nem a pergunta aparecem", (_caso, status, transcript) => {
    abrirDetalhe({ status }, { transcript });
    expect(screen.queryByRole("heading", { name: "Resumo da reunião" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gerar resumo/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Pergunte à reunião")).not.toBeInTheDocument();
  });

  it.each(["processing", "failed", "recording"])("reunião em '%s': a consulta do resumo nem sai", status => {
    abrirDetalhe({ status }, { transcript: TRANSCRICAO });
    expect(opcoesDaConsulta().enabled).toBe(false);
  });

  it("a consulta pergunta de novo a cada 5 s enquanto o resumo está na fila ou sendo gerado, e para quando ele fica pronto ou falha", () => {
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const { refetchInterval } = opcoesDaConsulta();
    const com = (estado: string, error: unknown = null) => refetchInterval({ state: { data: { estado }, error } });
    expect(com("pendente")).toBe(5_000);
    expect(com("gerando")).toBe(5_000);
    expect(com("pronto")).toBe(false);
    expect(com("falhou")).toBe(false);
    expect(com("sem_resumo")).toBe(false);
    // A reunião excluída em outro lugar no meio da espera: para de perguntar.
    expect(com("pendente", { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(refetchInterval({ state: { error: null } })).toBe(false);
  });

  it("o erro que persiste (500, banco fora do ar, rede) também para a repetição; a releitura que dá certo a religa", () => {
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const { refetchInterval } = opcoesDaConsulta();
    const com = (estado: string, error: unknown) => refetchInterval({ state: { data: { estado }, error } });
    expect(com("pendente", { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(com("gerando", { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    // O erro da rede chega sem código.
    expect(com("pendente", new Error("Failed to fetch"))).toBe(false);
    expect(com("pendente", null)).toBe(5_000);
  });

  it("a consulta não tenta de novo o erro definitivo (reunião que não existe, link cortado); o 500 tenta até a terceira vez", () => {
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const { retry } = opcoesDaConsulta();
    expect(retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    const erro500 = { message: MENSAGEM, data: { code: "INTERNAL_SERVER_ERROR" } };
    expect(retry(0, erro500)).toBe(true);
    expect(retry(2, erro500)).toBe(true);
    expect(retry(3, erro500)).toBe(false);
  });

  it("o emoji do resumo vai antes do título da reunião, sem mudar o nome do título", () => {
    duble.resumoGuardado.mockReturnValue(resumoPronto("📄"));
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const titulo = screen.getByRole("heading", { level: 1, name: "Reunião com a vinícola" });
    expect(titulo.textContent).toBe("📄Reunião com a vinícola");
    expect(within(titulo).getByText("📄")).toHaveAttribute("aria-hidden", "true");
  });

  it("o e-mail de retorno (H20) aparece com o resumo pronto, entre o resumo e o Pergunte, e pede só com item confirmado", () => {
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrirDetalhe({ status: "ready", speakerNames: { F1: "Ana" } } as never, { transcript: TRANSCRICAO });
    const secao = screen.getByRole("region", { name: "E-mail de retorno" });
    const resumo = screen.getByRole("region", { name: "Resumo da reunião" });
    expect(resumo.compareDocumentPosition(secao) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // O idioma do e-mail começa no do resumo.
    expect(within(secao).getByRole("combobox", { name: "Idioma do e-mail" })).toHaveValue("pt-BR");
    // Um dos dois itens está confirmado: com o nome de quem recebe, o pedido sai.
    fireEvent.change(within(secao).getByRole("combobox", { name: "Para quem?" }), { target: { value: "Ana" } });
    fireEvent.click(within(secao).getByRole("button", { name: /Escrever rascunho/ }));
    expect(duble.mutacoes.rascunharEmailDeRetorno.mutate).toHaveBeenCalledWith({
      meetingId: REUNIAO.id, relacao: "external", tom: "professional", idioma: "pt-BR", vozDoDestinatario: "F1",
    }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("o e-mail de retorno é guardado pela página: a dona vai à Transcrição, volta antes da resposta, e a resposta aparece no Resumo", () => {
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrirDetalhe({ status: "ready", speakerNames: { F1: "Ana" } } as never, { transcript: TRANSCRICAO });
    const secao = () => screen.getByRole("region", { name: "E-mail de retorno" });
    fireEvent.change(within(secao()).getByRole("combobox", { name: "Para quem?" }), { target: { value: "Carla" } });
    fireEvent.click(within(secao()).getByRole("button", { name: /Escrever rascunho/ }));
    const [, opcoes] = duble.mutacoes.rascunharEmailDeRetorno.mutate.mock.calls[0];

    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(screen.queryByRole("region", { name: "E-mail de retorno" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Resumo$/ }));
    // A resposta chega depois da volta: o React Query chama o onSuccess do pedido.
    act(() => opcoes.onSuccess({ assunto: "Retorno para {DESTINATARIO}", corpo: "Olá, {DESTINATARIO}. {F1} manda a minuta." }));

    expect(within(secao()).getByRole("textbox", { name: "Assunto" })).toHaveValue("Retorno para Carla");
    expect(within(secao()).getByRole("textbox", { name: "Texto do e-mail" })).toHaveValue("Olá, Carla. Ana manda a minuta.");
    expect(within(secao()).getByRole("combobox", { name: "Para quem?" })).toHaveValue("Carla");
  });

  it("sem item confirmado, o e-mail de retorno pede para confirmar antes", () => {
    duble.resumoGuardado.mockReturnValue({ ...resumoPronto(), data: { ...resumoPronto().data, itens: ITENS.map(item => ({ ...item, status: "pending" })) } });
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const secao = screen.getByRole("region", { name: "E-mail de retorno" });
    expect(within(secao).getByText("Confirme ao menos um item do resumo para escrever o e-mail.")).toBeInTheDocument();
    expect(within(secao).getByRole("button", { name: /Escrever rascunho/ })).toBeDisabled();
  });

  it.each(["sem_resumo", "pendente", "gerando", "falhou"])("resumo '%s': o e-mail de retorno nem aparece", estado => {
    duble.resumoGuardado.mockReturnValue({ data: { estado, emoji: null, idioma: null, erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    expect(screen.queryByRole("region", { name: "E-mail de retorno" })).not.toBeInTheDocument();
  });

  it("os nomes das vozes vêm dos nomes que a dona deu (meeting.speakerNames)", () => {
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrirDetalhe({ status: "ready", speakerNames: { F1: "Ana" } } as never, { transcript: TRANSCRICAO });
    expect(screen.getByRole("checkbox", { name: "Ana manda a minuta do contrato" })).toBeInTheDocument();
    expect(screen.getByText("Responsável: Ana")).toBeInTheDocument();
  });

  it("o responsável sugere também quem falou na transcrição, sem nome e sem citação no resumo (H4f)", () => {
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    // O resumo cita só F1; F3 só falou.
    const segments = [
      { inicio: 5, fim: 20, falante: "F1", texto: "Eu mando a minuta do contrato." },
      { inicio: 30, fim: 45, falante: "F3", texto: "Eu ligo para o importador." },
    ];
    abrirDetalhe({ status: "ready" }, { transcript: { ...TRANSCRICAO, segments } });
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    const lista = document.getElementById(screen.getByLabelText("Responsável").getAttribute("list") ?? "");
    expect(Array.from(lista?.querySelectorAll("option") ?? []).map(opcao => opcao.getAttribute("value"))).toEqual(["Falante 1", "Falante 3"]);
  });

  it("o '▶ mm:ss' de um item do resumo leva o player da barra ao ponto do item, na parte certa", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO, recording: GRAVACAO });
    expect(audioDaBarra().getAttribute("src")).toBe(PARTES[0].url);
    // O item da decisão começa em 620 s (10:20), na segunda parte.
    const resumo = screen.getByRole("region", { name: "Resumo da reunião" });
    fireEvent.click(within(resumo).getByRole("button", { name: "Ouvir a partir de 10:20" }));
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(audioDaBarra().getAttribute("src")).toBe(PARTES[1].url);
  });

  it("?item abre a aba Resumo, mesmo com ?t, rola até o item e o destaca; o ?t ainda leva o player da barra ao ponto", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const rolados: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { rolados.push(this); };
    const antes = window.location.href;
    try {
      duble.resumoGuardado.mockReturnValue(resumoPronto());
      // O link da próxima ação ou do lembrete: o ?t é o segundo do item (10:20, na segunda parte).
      abrirPeloLink(`?t=620&item=${ITEM}`, {}, { recording: GRAVACAO });
      expect(screen.getByRole("heading", { name: "Resumo da reunião" })).toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      const item = screen.getByText("Fechar o contrato até sexta-feira.").closest("li")!;
      expect(item).toHaveAttribute("data-destacado", "true");
      expect(rolados).toEqual([item]);
      expect(document.querySelectorAll("[data-destacado]")).toHaveLength(1);
      // O ?item escolheu a aba; o ?t ainda levou o player, um só, à segunda parte.
      expect(document.querySelectorAll("audio")).toHaveLength(1);
      expect(audioDaBarra().getAttribute("src")).toBe(PARTES[1].url);
      // Trocar de aba e voltar ao Resumo não rola de novo até o mesmo item.
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Resumo$/ }));
      expect(screen.getByText("Fechar o contrato até sexta-feira.").closest("li")).toHaveAttribute("data-destacado", "true");
      expect(rolados).toHaveLength(1);
    } finally {
      window.history.replaceState(null, "", antes);
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("um ?item novo para a mesma reunião, aberta em outra aba, volta ao Resumo sem remontar a tela", () => {
    Element.prototype.scrollIntoView = function () {};
    const antes = window.location.href;
    try {
      duble.resumoGuardado.mockReturnValue(resumoPronto());
      abrirPeloLink("");
      fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
      expect(screen.queryByRole("heading", { name: "Resumo da reunião" })).not.toBeInTheDocument();
      act(() => { window.history.pushState(null, "", `/meetings/${REUNIAO.id}?item=${ITEM}`); });
      expect(screen.getByRole("heading", { name: "Resumo da reunião" })).toBeInTheDocument();
      expect(screen.getByText("Fechar o contrato até sexta-feira.").closest("li")).toHaveAttribute("data-destacado", "true");
    } finally {
      window.history.replaceState(null, "", antes);
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("?item de um item que não está mais no resumo: um aviso, e nada destacado", () => {
    const antes = window.location.href;
    try {
      duble.resumoGuardado.mockReturnValue(resumoPronto());
      abrirPeloLink("?item=9f9f9f9f-0000-4000-8000-000000000000");
      expect(screen.getByText("O item deste link não está mais no resumo.")).toBeInTheDocument();
      expect(document.querySelector("[data-destacado]")).toBeNull();
    } finally {
      window.history.replaceState(null, "", antes);
    }
  });
});

describe("Detalhe da reunião — o Pergunte à reunião com os tempos e as vozes (H6)", () => {
  const SEGMENTOS = [
    { inicio: 5, fim: 20, falante: "F1", texto: "Vamos fechar o contrato." },
    { inicio: 620, fim: 640, falante: "F2", texto: "O frete fica para sexta." },
  ];
  const TRANSCRICAO = { id: "t1", transcript: "Vamos fechar o contrato.\nO frete fica para sexta.", language: "pt-BR", segments: SEGMENTOS };
  const PARTES = [
    { seq: 0, url: "/manus-storage/meetings/dona/r/partes/0000-a.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600, expiresAt: Date.now() + 1e9 },
    { seq: 1, url: "/manus-storage/meetings/dona/r/partes/0001-b.m4a", mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 300, expiresAt: Date.now() + 1e9 },
  ];
  const GRAVACAO = { url: PARTES[0].url, mimeType: "audio/mp4", durationSeconds: 900, sizeBytes: 0, expiresAt: Date.now() + 1e9, partes: PARTES };
  // A resposta que a pergunta já recebeu do servidor (server/reuniao-com-ia.ts).
  const respondeu = () => {
    (duble.mutacoes.perguntar ??= { opcoes: {}, mutate: vi.fn(), mutateAsync: vi.fn() }).data = {
      respondida: true,
      resposta: "{F1} quer fechar o contrato, e {F2} cuida do frete.",
      citacoes: [{ trecho: "O frete fica para sexta", inicioSegundos: 620 }],
      trecho: "O frete fica para sexta",
    };
  };

  it("a resposta mostra o nome que a dona deu à voz, e o '▶' da citação leva o player da barra à parte certa", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    respondeu();
    abrirDetalhe({ status: "ready", speakerNames: { F1: "Ana" } } as never, { transcript: TRANSCRICAO, recording: GRAVACAO });
    expect(screen.getByText("Ana quer fechar o contrato, e Falante 2 cuida do frete.")).toBeInTheDocument();
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[0].url);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:20" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(PARTES[1].url);
  });

  it("sem gravação guardada, o tempo da citação é só texto", () => {
    respondeu();
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO, recording: null, recordingExpired: true });
    expect(screen.getByText("10:20")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });
});

describe("Detalhe da reunião — compartilhar por link (12/11/2026)", () => {
  it("reunião pronta: o painel aparece, e a reunião segue marcada como privada enquanto não há link", () => {
    abrirDetalhe({ status: "ready" });
    expect(screen.getByRole("heading", { name: "Compartilhar por link" })).toBeInTheDocument();
    expect(screen.getByText("REUNIÃO PRIVADA")).toBeInTheDocument();
  });

  it("com o link ligado, a reunião diz que está compartilhada e mostra o endereço", () => {
    abrirDetalhe({ status: "ready", shareToken: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" });
    expect(screen.getByText("REUNIÃO COMPARTILHADA POR LINK")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveValue(`${window.location.origin}/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345`);
  });

  it.each(["processing", "failed"])("reunião %s: não há o que compartilhar ainda", (status) => {
    abrirDetalhe({ status });
    expect(screen.queryByRole("heading", { name: /Compartilhar por link|Compartilhada por link/ })).not.toBeInTheDocument();
  });

  // Os nomes das vozes pelo link (H3b): o detalhe diz se o link ligado os mostra (meeting.linkMostraNomes).
  const TOKEN_DO_LINK = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const COM_FALAS = { id: "t1", transcript: "x", language: "pt-BR", segments: [
    { inicio: 5, fim: 20, falante: "F1", texto: "Vamos fechar o contrato." },
    { inicio: 620, fim: 640, falante: "F2", texto: "O frete fica para sexta." },
  ] };
  const abrirCampoDoNome = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dar nome a esta voz: Ana" }));
    return screen.getByRole("textbox", { name: "Nome do falante 1" });
  };

  // O aviso do painel fica acima das abas, fora da vista de quem nomeia a voz na
  // aba Transcrição: o próprio campo do nome diz que o nome não sai pelo link.
  it("link da confirmação antiga com vozes nomeadas: o painel avisa que o link não mostra os nomes, e o campo do nome também, com o jeito de mostrá-los (H3b)", () => {
    abrirDetalhe({ status: "ready", shareToken: TOKEN_DO_LINK, linkMostraNomes: false, speakerNames: { F1: "Ana" } } as never, { transcript: COM_FALAS });
    expect(screen.getByText(/não vê os nomes que você deu às vozes/)).toBeInTheDocument();
    expect(abrirCampoDoNome()).toHaveAccessibleDescription("Quem tem o link da reunião não vê este nome. Para mostrá-lo, desligue o link e compartilhe de novo.");
  });

  it("link que mostra os nomes: sem o aviso, e o campo do nome diz que o nome aparece também para quem tem o link (H3b)", () => {
    abrirDetalhe({ status: "ready", shareToken: TOKEN_DO_LINK, linkMostraNomes: true, speakerNames: { F1: "Ana" } } as never, { transcript: COM_FALAS });
    expect(screen.queryByText(/não vê os nomes que você deu às vozes/)).not.toBeInTheDocument();
    expect(abrirCampoDoNome()).toHaveAccessibleDescription("Este nome aparece também para quem tem o link da reunião.");
  });

  it("sem link, nem aviso nem dica: o nome fica só com a dona (H3b)", () => {
    abrirDetalhe({ status: "ready", speakerNames: { F1: "Ana" } } as never, { transcript: COM_FALAS });
    expect(screen.queryByText(/não vê os nomes que você deu às vozes/)).not.toBeInTheDocument();
    expect(abrirCampoDoNome()).not.toHaveAccessibleDescription();
  });

  // Pacote 4d: o painel do resumo por e-mail (H22) recebe do detalhe a senha e o
  // áudio do link ligado (H23), e o e-mail que ele mostra segue os dois.
  it("o resumo por e-mail recebe do detalhe a senha e o áudio do link ligado (Pacote 4d)", () => {
    duble.resumoGuardado.mockReturnValue({
      data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, versaoAnterior: false, itens: [] },
      isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
    });
    duble.painelDoEmail.mockReturnValue({
      data: { idioma: "pt-BR", linkLigado: true, emailDaDona: "glenda@exemplo.invalid", nomeDaDona: "Glenda", automatico: false, participantes: [], envios: [], podeMandarDeNovo: false },
      isPending: false, isError: false, error: null,
    });
    abrirDetalhe({ status: "ready", shareToken: TOKEN_DO_LINK, linkComSenha: true, linkComAudio: false } as never);
    fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
    expect(duble.painelDoEmail).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
    expect(screen.getByText("O link desta reunião pede senha, e a senha não vai no e-mail: mande-a à parte a quem receber.")).toBeInTheDocument();
    expect(screen.getByText("Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na Marquesa Global Match.")).toBeInTheDocument();
    expect(screen.getByText("Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a Glenda.")).toBeInTheDocument();
  });
});

describe("Detalhe da reunião — a aba Mapa mental (H10)", () => {
  const TRANSCRICAO = { id: "t1", meetingId: REUNIAO.id, transcript: "Vamos fechar o contrato até sexta-feira.", language: "pt-BR" };
  const abaDoMapa = () => screen.getByRole("button", { name: "Mapa mental" });

  it("fica entre a Transcrição e os Contatos, e mostra o mapa da reunião com o título e o emoji do resumo", () => {
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: "🍷", idioma: "pt-BR", erro: null, itens: [] }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    const abas = screen.getAllByRole("button").filter(botao => botao.hasAttribute("aria-pressed")).map(aba => aba.textContent);
    expect(abas).toEqual(["Resumo", "Transcrição", "Mapa mental", "Contatos (0)"]);
    expect(screen.queryByTestId("mapa-mental")).not.toBeInTheDocument();

    fireEvent.click(abaDoMapa());

    expect(abaDoMapa()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mapa-mental")).toHaveTextContent(`${REUNIAO.id} | Reunião com a vinícola | 🍷`);
    // A aba do mapa não leva o resumo nem a pergunta junto.
    expect(screen.queryByRole("heading", { name: "Resumo da reunião" })).not.toBeInTheDocument();
  });

  it.each([
    ["pronta sem transcrição", "ready", null],
    ["em processamento", "processing", TRANSCRICAO],
    ["com falha", "failed", TRANSCRICAO],
  ])("reunião %s: a aba diz que o mapa vem com a transcrição, sem pedir nada", (_caso, status, transcript) => {
    abrirDetalhe({ status }, { transcript });
    fireEvent.click(abaDoMapa());
    expect(screen.queryByTestId("mapa-mental")).not.toBeInTheDocument();
    expect(screen.getByText("O mapa mental aparece aqui quando a transcrição da reunião estiver pronta.")).toBeInTheDocument();
  });
});

/**
 * A tradução do resumo (H11) ligada na página da dona: a página pede a
 * tradução, passa ao resumo e ao mapa mental, e o mapa que fica pronto pede de
 * novo. Os componentes têm os próprios testes; aqui se prova que a página os
 * liga (sem as props, nada disto acontece e a suíte ficava verde).
 */
describe("Detalhe da reunião — a tradução do resumo e do mapa (H11), ligada na página", () => {
  const TRANSCRICAO = { id: "t1", meetingId: REUNIAO.id, transcript: "We will close the contract by Friday.", language: "en" };
  const ITENS_EM_INGLES = [
    { id: "a0000000-0000-4000-8000-000000000001", section: "decision", position: 0, subject: null, text: "Close the contract by Friday.", assignee: null, due: null, excerpt: "we will close the contract by Friday", startSeconds: 5, status: "confirmed", done: false, origin: "ai", editedAt: null },
  ];
  // O resumo foi escrito em inglês; a tela está em português.
  const resumoEmIngles = () => ({ data: { estado: "pronto", emoji: "📄", idioma: "en", erro: null, versaoAnterior: false, itens: ITENS_EM_INGLES }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  type Opcoes = { onSuccess: (resposta: unknown) => void; onError: (erro: unknown) => void };
  const pedidos = () => (duble.mutacoes.traduzirResumo?.mutate.mock.calls ?? []) as Array<[{ meetingId: string; idioma: string }, Opcoes]>;

  it("a página pede a tradução no idioma da tela, e o resumo traduzido entra na aba Resumo", () => {
    duble.resumoGuardado.mockReturnValue(resumoEmIngles());
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    expect(pedidos().map(([entrada]) => entrada)).toEqual([{ meetingId: REUNIAO.id, idioma: "pt-BR" }]);
    expect(screen.getByText("Close the contract by Friday.")).toBeInTheDocument();

    act(() => pedidos()[0][1].onSuccess({ estado: "pronta", idioma: "pt-BR", mapa: {}, itens: [{ id: ITENS_EM_INGLES[0].id, subject: null, text: "Fechar o contrato até sexta-feira.", due: null }] }));

    const resumo = screen.getByRole("region", { name: "Resumo da reunião" });
    expect(within(resumo).getByText("Fechar o contrato até sexta-feira.")).toBeInTheDocument();
    expect(within(resumo).getByText("Tradução automática pela IA. Original: English. Os trechos citados ficam no idioma original.")).toBeInTheDocument();
    expect(within(resumo).getByRole("combobox", { name: "Idioma do resumo" })).toHaveValue("pt-BR");
  });

  it("com a reunião em processamento, o resumo é da tentativa anterior: a página não pede tradução", () => {
    duble.resumoGuardado.mockReturnValue(resumoEmIngles());
    abrirDetalhe({ status: "processing" }, { transcript: TRANSCRICAO });
    expect(pedidos()).toEqual([]);
  });

  it("o mapa mental recebe a tradução da página; o mapa que avisa os rótulos pede a tradução de novo, e os rótulos chegam traduzidos", () => {
    duble.resumoGuardado.mockReturnValue(resumoEmIngles());
    abrirDetalhe({ status: "ready" }, { transcript: TRANSCRICAO });
    act(() => pedidos()[0][1].onSuccess({ estado: "pronta", idioma: "pt-BR", mapa: {}, itens: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Mapa mental" }));
    expect(screen.getByTestId("traducao-do-mapa")).toHaveTextContent("pronta Prazos");

    fireEvent.click(screen.getByRole("button", { name: "rótulos do mapa" }));
    expect(pedidos()).toHaveLength(2);
    expect(pedidos()[1][0]).toEqual({ meetingId: REUNIAO.id, idioma: "pt-BR" });
    act(() => pedidos()[1][1].onSuccess({ estado: "pronta", idioma: "pt-BR", mapa: { Prazos: "Deadlines em português" }, itens: [] }));
    expect(screen.getByTestId("traducao-do-mapa")).toHaveTextContent("pronta Deadlines em português");
  });

  it("com o link ligado, o formulário do item avisa que o que a dona salva aparece para quem tem o link", () => {
    duble.resumoGuardado.mockReturnValue(resumoEmIngles());
    abrirDetalhe({ status: "ready", shareToken: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" } as never, { transcript: TRANSCRICAO });
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar item" }));
    expect(screen.getByRole("form", { name: "Acrescentar item" })).toHaveAccessibleDescription("O link desta reunião está ligado: o que você salvar aqui aparece também para quem tem o link.");
  });
});

// N5: a reunião vira conexões e refina o perfil. As quatro saídas da pessoa,
// os itens decididos ali mesmo e a linha das conexões no resumo.
describe("Detalhe da reunião — a pessoa da reunião na N5", () => {
  const abaContatos = () => screen.getByRole("button", { name: /Contatos/ });
  const pessoa = { ...sugestaoPendente, phone: null, existingContactId: null, existingContactName: null, presence: "present", pareceSerADona: false };
  const itemDe = (id: string, campo: string, valor: string, sugestao = "s1") => ({
    id, meetingSuggestionId: sugestao, campo, valor, trecho: `disse ${valor.toLowerCase()}`, contactId: null, alvo: "contato", origem: "reuniao", confianca: 0.9,
  });

  it("pendente: Criar contato, Vincular a um contato, Sou eu e Ignorar; 'Sou eu' e 'Ignorar' decidem pelo servidor", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [pessoa] });
    fireEvent.click(abaContatos());
    for (const nome of [/Criar contato/, /Vincular a um contato/, /Sou eu/, /Ignorar/]) expect(screen.getByRole("button", { name: nome })).toBeInTheDocument();
    expect(screen.queryByText("É você?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sou eu/ }));
    expect(duble.mutacoes.decideContactSuggestion.mutate).toHaveBeenCalledWith({ suggestionId: "s1", action: "self" });
  });

  it("o nome ou o e-mail da conta: a tela pergunta 'É você?' ao lado do 'Sou eu'", () => {
    abrirDetalhe({ status: "ready" }, { suggestions: [{ ...pessoa, pareceSerADona: true }] });
    fireEvent.click(abaContatos());
    expect(screen.getByText("É você?")).toBeInTheDocument();
  });

  it("Vincular: a tela sugere o contato de mesmo nome, e escolher vincula a ele", () => {
    duble.candidatos.mockReturnValue({ data: [{ id: 42, nome: "Ana Souza", empresa: null, motivo: "nome" }], isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { suggestions: [pessoa] });
    fireEvent.click(abaContatos());
    fireEvent.click(screen.getByRole("button", { name: /Vincular a um contato/ }));
    expect(duble.candidatos).toHaveBeenCalledWith({ suggestionId: "s1" }, expect.anything());
    const painel = screen.getByRole("group", { name: "Vincular a qual contato?" });
    expect(within(painel).getByText(/mesmo nome/)).toBeInTheDocument();
    fireEvent.click(within(painel).getByRole("button", { name: /Ana Souza/ }));
    expect(duble.mutacoes.decideContactSuggestion.mutate).toHaveBeenCalledWith({ suggestionId: "s1", action: "link", contactId: 42 });
  });

  it("decidida: 'É você' e 'Vinculada a…' dizem como ficou, e os itens esperam a dona ali mesmo, com o trecho", () => {
    duble.pendencias.mockReturnValue({
      data: [itemDe("p1", "tenho", "Exportar café"), { ...itemDe("p2", "preciso", "Distribuidor no Chile", "s2"), alvo: "perfil" }],
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    abrirDetalhe({ status: "ready" }, { suggestions: [
      { ...pessoa, status: "linked", existingContactId: 42, existingContactName: "Ana Souza Lima" },
      { ...pessoa, id: "s2", fullName: "Glenda Souza", status: "self" },
    ] });
    fireEvent.click(abaContatos());
    expect(screen.getByText("Itens esperando você: 2")).toBeInTheDocument();
    expect(screen.getByText("Vinculada a Ana Souza Lima")).toBeInTheDocument();
    expect(screen.getByText("É você")).toBeInTheDocument();
    expect(screen.getByText("Trecho: “disse exportar café”")).toBeInTheDocument();
    // No "Sou eu", o aviso de que o item entra nas conexões, e a categoria da demanda.
    expect(screen.getByText(/entra no seu perfil e passa a gerar conexões/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Categoria" })).toHaveValue("outra_necessidade");
    const confirmar = screen.getAllByRole("button", { name: /Confirmar/ });
    fireEvent.click(confirmar[0]);
    expect(duble.mutacoes.confirmarPendencia.mutate).toHaveBeenCalledWith({ id: "p1" });
    fireEvent.click(confirmar[1]);
    expect(duble.mutacoes.confirmarPendencia.mutate).toHaveBeenCalledWith({ id: "p2", categoria: "outra_necessidade" });
    // Decidido o item, a tela relê o que espera a dona e as conexões da reunião.
    act(() => { duble.mutacoes.confirmarPendencia.opcoes.onSuccess?.({ promovidaAPrata: false }, undefined); });
    expect(duble.utils.meetings.conexoes.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
  });

  it("a aba Resumo diz quantas conexões a reunião gerou, com o caminho para elas; sem conexão, nada", () => {
    duble.conexoes.mockReturnValue({ data: { pessoas: [], totalDeConexoes: 3 }, isError: false, error: null, refetch: vi.fn() });
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Oi.", language: "pt-BR" } });
    expect(screen.getByText("Conexões geradas por esta reunião: 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver conexões" })).toHaveAttribute("href", "/intelligent-matches");
  });

  it("a consulta das conexões que falha é erro com tentar de novo, nunca 'nenhuma conexão'", () => {
    const refetch = vi.fn();
    duble.conexoes.mockReturnValue(emErro(refetch));
    abrirDetalhe({ status: "ready" }, { transcript: { id: "t1", transcript: "Oi.", language: "pt-BR" } });
    fireEvent.click(screen.getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Reuniões — o vídeo do YouTube (H13)", () => {
  // A reunião que veio de um vídeo: sem áudio nem player (a CSP não deixa
  // embutir o YouTube); o "▶" abre o vídeo no segundo, numa aba nova, e o
  // "Tentar de novo" lê o vídeo outra vez pela URL guardada.
  const ID_DO_VIDEO = "dQw4w9WgXcQ";
  const VIDEO = { origem: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${ID_DO_VIDEO}` };
  const noYoutube = (segundos: number) => `${VIDEO.sourceUrl}&t=${segundos}s`;
  const SEGMENTOS = [
    { inicio: 7, fim: 12, falante: "F1", texto: "Bem-vindas ao painel sobre exportação." },
    { inicio: 725, fim: 751, falante: "F2", texto: "Obrigada pelo convite." },
  ];
  const TRANSCRICAO = { id: "t1", transcript: "Bem-vindas ao painel sobre exportação.\nObrigada pelo convite.", language: "pt-BR", segments: SEGMENTOS };
  const refazer = () => duble.mutacoes.refazerVideoDoYoutube;

  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    duble.utils.meetings.get.setData.mockClear();
    duble.utils.meetings.get.invalidate.mockClear();
    duble.utils.meetings.list.invalidate.mockClear();
  });

  it("a lista marca a reunião que veio do YouTube, e o topo oferece resumir um vídeo ao lado da reunião nova", () => {
    duble.list.mockReturnValue({ data: [{ ...REUNIAO, ...VIDEO }, { ...REUNIAO, id: "outra", title: "Reunião gravada" }], isLoading: false });
    render(<Meetings />);
    expect(screen.getByRole("button", { name: /Resumir vídeo do YouTube/ })).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Reunião com a vinícola/ })).getByText("Vídeo do YouTube")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Reunião gravada/ })).queryByText("Vídeo do YouTube")).not.toBeInTheDocument();
  });

  it("pronta: o vídeo no lugar da gravação, com o link para o YouTube, e nenhum player", () => {
    abrirDetalhe({ status: "ready", ...VIDEO }, { transcript: TRANSCRICAO });
    expect(screen.getByRole("heading", { name: "Vídeo do YouTube" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir o vídeo no YouTube/ })).toHaveAttribute("href", VIDEO.sourceUrl);
    expect(screen.queryByRole("heading", { name: "Gravação" })).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum áudio guardado para esta reunião.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Gravação" })).not.toBeInTheDocument();
    expect(document.querySelector("audio, video, iframe")).toBeNull();
  });

  // Conferência de tela de 20/11/2026 (captura 14c): o painel de compartilhar da
  // reunião do YouTube falava da gravação, e a prova guardava a frase do áudio.
  it("compartilhar: o painel e a caixa falam do vídeo, e a prova guarda a frase do vídeo, nunca a da gravação", () => {
    abrirDetalhe({ status: "ready", ...VIDEO }, { transcript: TRANSCRICAO });
    expect(screen.getByText(/lê a transcrição e pede à IA o resumo e respostas sobre o vídeo/)).toBeInTheDocument();
    expect(screen.queryByText(/ouve a gravação/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    const frase = "Confirmo que posso compartilhar a transcrição deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu der às vozes.";
    fireEvent.click(screen.getByRole("checkbox", { name: frase }));
    fireEvent.click(screen.getByRole("button", { name: /Criar link/ }));
    expect(duble.mutacoes.ligarLinkAberto.mutate).toHaveBeenCalledWith(expect.objectContaining({ textoExibido: frase, versaoDaAutorizacao: 2 }));
  });

  // A junção do Pacote 4c com o 4d: o detalhe montava o resumo por e-mail (H22)
  // sem dizer que a reunião veio do YouTube, e o painel pedia a caixa da gravação
  // (a frase que vai para a prova) e prometia a gravação, também no link antigo.
  describe("o resumo por e-mail da reunião do YouTube", () => {
    const GRAVACAO = /gravaç|gravad|gravou|todas as pessoas que falaram/i;
    const painelDoEmail = (linkLigado: boolean) => {
      duble.resumoGuardado.mockReturnValue({
        data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, versaoAnterior: false, itens: [] },
        isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
      });
      duble.painelDoEmail.mockReturnValue({
        data: { idioma: "pt-BR", linkLigado, emailDaDona: "glenda@exemplo.invalid", nomeDaDona: "Glenda", automatico: false, participantes: [], envios: [], podeMandarDeNovo: false },
        isPending: false, isError: false, error: null,
      });
    };

    it("o link desligado: a caixa e a prova são a frase do vídeo, e a prévia não fala de gravação", () => {
      painelDoEmail(false);
      abrirDetalhe({ status: "ready", ...VIDEO }, { transcript: TRANSCRICAO });
      fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
      const painel = screen.getByRole("region", { name: "Mandar o resumo por e-mail" });
      expect(within(painel).getByText("Glenda compartilhou com você o resumo de “Reunião com a vinícola”, feito na Marquesa Global Match.")).toBeInTheDocument();
      expect(painel.textContent).not.toMatch(GRAVACAO);
      const frase = "Confirmo que posso compartilhar a transcrição deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu der às vozes.";
      fireEvent.click(within(painel).getByRole("checkbox", { name: /Para mim/ }));
      fireEvent.click(within(painel).getByRole("checkbox", { name: frase }));
      fireEvent.click(within(painel).getByRole("button", { name: "Mandar o resumo" }));
      expect(duble.mutacoes.mandarResumoPorEmail.mutate).toHaveBeenCalledWith(expect.objectContaining({
        meetingId: REUNIAO.id, autorizacao: expect.objectContaining({ textoExibido: frase, versaoDaAutorizacao: 2 }),
      }));
    });

    it("o link ligado antes, com o áudio (o padrão da coluna): a prévia segue sem a gravação", () => {
      painelDoEmail(true);
      abrirDetalhe({ status: "ready", ...VIDEO, shareToken: "AbCdEfGhIjKlMnOpQrStUvWxYz012345", linkComAudio: true } as never, { transcript: TRANSCRICAO });
      fireEvent.click(screen.getByRole("button", { name: "Mandar por e-mail" }));
      const painel = screen.getByRole("region", { name: "Mandar o resumo por e-mail" });
      expect(within(painel).getByText("Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na Marquesa Global Match.")).toBeInTheDocument();
      expect(painel.textContent).not.toMatch(GRAVACAO);
    });
  });

  it("a transcrição: o ▶ de cada fala abre o vídeo no YouTube no segundo dela, numa aba nova", () => {
    abrirDetalhe({ status: "ready", ...VIDEO }, { transcript: TRANSCRICAO });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    const link = screen.getByRole("link", { name: "Ver no YouTube a partir de 12:05 (abre em nova aba)" });
    expect(link).toHaveAttribute("href", noYoutube(725));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Ver no YouTube a partir de 00:07 (abre em nova aba)" })).toHaveAttribute("href", noYoutube(7));
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });

  it("o resumo guardado: o ▶ do item abre o vídeo no segundo da fala de onde ele saiu", () => {
    duble.resumoGuardado.mockReturnValue({
      data: { estado: "pronto", emoji: null, idioma: "pt-BR", erro: null, itens: [
        { id: "a0000000-0000-4000-8000-000000000009", section: "decision", position: 0, subject: null, text: "Abrir o mercado do Chile.", assignee: null, due: null, excerpt: "obrigada pelo convite", startSeconds: 725, status: "pending", done: false, origin: "ai", editedAt: null },
      ] },
      isLoading: false, isSuccess: true, isError: false, error: null, refetch: vi.fn(),
    });
    abrirDetalhe({ status: "ready", ...VIDEO }, { transcript: TRANSCRICAO });
    expect(screen.getByRole("link", { name: "Ver no YouTube a partir de 12:05 (abre em nova aba)" })).toHaveAttribute("href", noYoutube(725));
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });

  it("em processamento: a faixa diz que a IA está lendo o vídeo", () => {
    abrirDetalhe({ status: "processing", ...VIDEO });
    expect(screen.getByText(/A IA está lendo o vídeo e transcrevendo as falas/)).toBeInTheDocument();
  });

  it.each([
    ["YOUTUBE_SEM_FALA", "A IA não encontrou fala neste vídeo: só música, silêncio ou ruído."],
    ["YOUTUBE_LONGO_DEMAIS", "Este vídeo tem fala demais para a IA transcrever de uma vez. Tente um vídeo mais curto."],
  ])("com falha %s, que se repete com o mesmo vídeo: o motivo traduzido, e nenhum Tentar de novo (pagaria outra leitura para falhar igual)", (codigo, frase) => {
    abrirDetalhe({ status: "failed", processingError: codigo, ...VIDEO });
    expect(screen.getByText(frase)).toBeInTheDocument();
    expect(screen.queryByText(codigo)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar de novo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Tentar de novo lê o vídeo outra vez/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprocessar/ })).not.toBeInTheDocument();
  });

  it.each([
    ["YOUTUBE_VIDEO_PRIVADO", "A IA não conseguiu abrir este vídeo. Só vídeos públicos funcionam: confira se ele não é privado, não listado, removido ou restrito por idade ou região."],
    ["YOUTUBE_IA_INDISPONIVEL", "O serviço de IA está ocupado agora. Tente de novo em alguns minutos."],
    ["YOUTUBE_FALHOU", "Não foi possível resumir este vídeo. Tente de novo."],
    // A varredura de interrompidas (um deploy no meio) vale também para o vídeo.
    ["ERRO_INTERROMPIDO", "O processamento foi interrompido antes de terminar (o servidor reiniciou no meio)."],
  ])("com falha %s: o motivo traduzido, nunca o código cru, e o Tentar de novo do vídeo no lugar do Reprocessar", (codigo, frase) => {
    abrirDetalhe({ status: "failed", processingError: codigo, ...VIDEO });
    expect(screen.getByText(frase)).toBeInTheDocument();
    expect(screen.queryByText(codigo)).not.toBeInTheDocument();
    expect(screen.getByText("Tentar de novo lê o vídeo outra vez e conta no limite de 5 vídeos a cada 24 horas.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprocessar/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(refazer().mutate).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
    expect(duble.mutacoes.reprocess.mutate).not.toHaveBeenCalled();
  });

  it("…e em inglês o motivo aparece em inglês", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    try {
      abrirDetalhe({ status: "failed", processingError: "YOUTUBE_SEM_FALA", ...VIDEO });
      expect(screen.getByText("The AI found no speech in this video: only music, silence or noise.")).toBeInTheDocument();
    } finally {
      await act(async () => { await i18n.changeLanguage("pt-BR"); });
    }
  });

  it("Tentar de novo aceito: a tela vira 'processing' na hora; recusado, o toast traduz a recusa; e a tela relê a reunião e a lista", () => {
    abrirDetalhe({ status: "failed", processingError: "YOUTUBE_FALHOU", ...VIDEO });
    const { opcoes } = refazer();
    act(() => opcoes.onSuccess?.({ status: "processing" }, { meetingId: REUNIAO.id }));
    expect(toast.success).toHaveBeenCalledWith("A IA vai ler o vídeo de novo.");
    const [chave, atualizar] = duble.utils.meetings.get.setData.mock.calls.at(-1)! as [unknown, (anterior: unknown) => unknown];
    expect(chave).toEqual({ meetingId: REUNIAO.id });
    expect(atualizar({ meeting: { ...REUNIAO, ...VIDEO, status: "failed", processingError: "YOUTUBE_FALHOU" } }))
      .toMatchObject({ meeting: { status: "processing", processingError: null, origem: "youtube" } });

    act(() => opcoes.onError?.({ message: "YOUTUBE_TETO_DIARIO", data: { code: "TOO_MANY_REQUESTS" } }, { meetingId: REUNIAO.id }));
    expect(toast.error).toHaveBeenCalledWith("Você já mandou 5 vídeos à IA nas últimas 24 horas, o limite de um dia. Tente de novo mais tarde.");
    act(() => opcoes.onError?.({ message: "Esta reunião não está com falha.", data: { code: "CONFLICT" } }, { meetingId: REUNIAO.id }));
    expect(toast.error).toHaveBeenLastCalledWith("Esta reunião não está com falha ou já está sendo processada.");

    act(() => opcoes.onSettled?.());
    expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO.id });
    expect(duble.utils.meetings.list.invalidate).toHaveBeenCalled();
  });

  it("a reunião gravada continua com a gravação e o caminho de sempre, sem nada do vídeo", () => {
    abrirDetalhe({ status: "failed", processingError: "ERRO_INTERROMPIDO" }, { recording: GRAVACAO });
    expect(screen.queryByText(/Tentar de novo lê o vídeo/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Vídeo do YouTube" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gravação" })).toBeInTheDocument();
  });

  // Classe de lado físico (esquerda/direita), que não espelha em árabe.
  const LADO_FISICO = /^(?:[a-z0-9-]+:)*-?(?:left|right|ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-|$)/;
  const ladosFisicos = (raiz: Element) => [raiz, ...raiz.querySelectorAll("*")].flatMap(elemento => [...elemento.classList].filter(classe => LADO_FISICO.test(classe)));

  // O jsdom não mede layout: o teste fixa as classes que fazem o que é novo
  // caber numa tela de 375 px e espelhar em árabe.
  it.each(["pt-BR", "ar"])("em %s, a 375 px: a caixa da falha e o bloco do vídeo empilham no celular, os dois botões do topo também, e só há lados lógicos", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    try {
      abrirDetalhe({ status: "failed", processingError: "YOUTUBE_VIDEO_PRIVADO", ...VIDEO });
      expect(document.documentElement.dir).toBe(idioma === "ar" ? "rtl" : "ltr");
      expect(screen.getByText(i18n.t("meetings.youtube.errors.privateVideo"))).toBeInTheDocument();
      // A caixa da falha: o texto e o botão um em cima do outro no celular.
      const botao = screen.getByRole("button", { name: new RegExp(i18n.t("meetings.youtube.retryButton")) });
      expect(botao.parentElement).toHaveClass("flex-col", "sm:flex-row");
      expect(botao).toHaveClass("shrink-0");
      expect(ladosFisicos(botao.parentElement!.parentElement!)).toEqual([]);
      // O bloco do vídeo, no lugar da gravação.
      const video = screen.getByRole("link", { name: new RegExp(i18n.t("meetings.youtube.openOnYoutube")) }).closest("section")!;
      expect(ladosFisicos(video)).toEqual([]);

      // Na lista: os dois botões do topo empilham no celular, e a marca do vídeo fica no início da linha.
      fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("meetings.allMeetings")) }));
      const resumir = screen.getByRole("button", { name: new RegExp(i18n.t("meetings.youtube.openButton")) });
      expect(resumir.parentElement).toHaveClass("flex-col-reverse", "sm:flex-row");
      expect(ladosFisicos(resumir.parentElement!)).toEqual([]);
      const marca = within(screen.getByRole("button", { name: /Reunião com a vinícola/ })).getByText(i18n.t("meetings.youtube.listBadge"));
      expect(marca).toHaveClass("ms-2");
      expect(ladosFisicos(marca)).toEqual([]);
    } finally {
      await act(async () => { await i18n.changeLanguage("pt-BR"); });
    }
  });
});
