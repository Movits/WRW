import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Editar a transcrição (H18) no detalhe da reunião: a barra só na reunião
 * pronta que não é documento; a marca "editado" nos trechos que a dona mudou;
 * o texto e a voz de um trecho, que vão ao servidor em dois pedidos, cada um
 * com a revisão que o anterior devolveu, e com a posição do trecho na lista;
 * localizar e substituir com a contagem; voltar um trecho ao original; e o
 * aviso de que o resumo é de antes da edição, com "Refazer o resumo" no modelo
 * de agora.
 */

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, ReturnType<typeof vi.fn>> = {};
  const mutacao = (nome: string) => ({
    useMutation: () => ({ mutate: (mutacoes[nome] ??= vi.fn()), mutateAsync: async () => {}, isPending: false }),
  });
  return {
    mutacoes,
    mutacao,
    list: vi.fn(),
    get: vi.fn(),
    pendencias: vi.fn(),
    resumoGuardado: vi.fn(),
    editarTranscricao: vi.fn(),
    utils: {
      meetings: {
        list: { invalidate: vi.fn() }, pastas: { invalidate: vi.fn() }, lixeira: { invalidate: vi.fn() }, get: { invalidate: vi.fn(), setData: vi.fn() },
        resumoGuardado: { invalidate: vi.fn() }, mapaMental: { invalidate: vi.fn() },
      },
      reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() } },
      networkInteligente: { pendencias: { reset: vi.fn() } },
      auth: { me: { getData: () => ({ openId: "dona-1" }), fetch: vi.fn() } },
      client: {
        meetings: {
          iniciarGravacao: { mutate: vi.fn() }, encerrarGravacao: { mutate: vi.fn() }, delete: { mutate: vi.fn() },
          editarTranscricao: { mutate: (entrada: unknown) => duble.editarTranscricao(entrada) },
          transcricaoDaGravacao: { query: async () => ({ status: "recording", emPartes: true, agora: Date.now(), partes: [], falas: [], nomes: {} }) },
        },
      },
    },
  };
});

vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      list: { useQuery: () => duble.list() },
      get: { useQuery: () => duble.get() },
      resumoGuardado: { useQuery: () => duble.resumoGuardado() },
      conexoes: { useQuery: () => ({ data: undefined }) },
      // As pastas e a lixeira (H7d): a lista lê as pastas, e o "Excluir" do detalhe manda para a lixeira.
      pastas: { useQuery: () => ({ data: [], isLoading: false, isSuccess: true, isError: false, error: null, refetch: () => undefined }) },
      ...Object.fromEntries([
        "create", "submitRecording", "decideEntity", "decideContactSuggestion", "translateTranscript", "delete", "reprocess",
        "resumirVideoDoYoutube", "refazerVideoDoYoutube", "pedirResumo", "refazerResumo", "decidirItemDoResumo", "confirmarItensDoResumo",
        "marcarAcaoFeita", "traduzirResumo", "perguntar", "perguntarDuranteAGravacao", "rascunharEmailDeRetorno", "ligarLinkAberto",
        "desligarLinkAberto", "novaSenhaDoLink", "tirarSenhaDoLink", "mudarAudioDoLink", "mandarParaALixeira",
      ].map(nome => [nome, duble.mutacao(nome)])),
    },
    reuniaoAberta: { pedirResumo: duble.mutacao("reuniaoAberta.pedirResumo"), perguntar: duble.mutacao("reuniaoAberta.perguntar"), traduzirResumo: duble.mutacao("reuniaoAberta.traduzirResumo") },
    proximasAcoes: { tirarDaGoogle: duble.mutacao("tirarDaGoogle") },
    networkInteligente: { pendencias: { useQuery: () => duble.pendencias() } },
  },
}));

import { toast } from "sonner";
import Meetings from "./Meetings";

const MEETING_ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const REUNIAO = {
  id: MEETING_ID, title: "Reunião com a vinícola", status: "ready", processingError: null, language: "pt-BR", audioPipeline: "slices",
  origem: "gravacao", speakerNames: null, shareToken: null, createdAt: Date.UTC(2026, 10, 20, 12), updatedAt: Date.UTC(2026, 10, 20, 12),
};
const FALAS = [
  { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia, aqui é a Glenta." },
  { inicio: 4, fim: 9, falante: "F2", texto: "A proposta sai na sexta." },
  { inicio: 9, fim: 12, falante: "F1", texto: "Combinado." },
];
const transcricao = (edicao: Record<string, unknown>) => ({
  id: "tr-1", meetingId: MEETING_ID, transcript: FALAS.map(f => f.texto).join("\n"), segments: FALAS, language: "pt-BR", durationSeconds: 12,
  createdAt: 1, updatedAt: 1, edicao: { revisao: 3, editada: true, editadaEm: Date.UTC(2026, 10, 20, 15), originais: [{ indice: 0, texto: "Bom dia, aqui é a Glenda.", falante: "F1" }], ...edicao },
});
const detalhe = (extra: { meeting?: Record<string, unknown>; transcript?: unknown } = {}) => ({
  data: {
    meeting: { ...REUNIAO, ...extra.meeting }, transcript: extra.transcript === undefined ? transcricao({}) : extra.transcript,
    entities: [], suggestions: [], recording: null, recordingExpired: false,
  },
  isLoading: false, isError: false, error: null, refetch: vi.fn(),
});
const resumo = (extra: Record<string, unknown> = {}) => ({
  data: { estado: "pronto", emoji: null, idioma: "pt-BR", modelo: "sales", erro: null, versaoAnterior: false, itens: [], tituloSugerido: null, transcricaoEditadaDepois: false, ...extra },
  isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

beforeEach(() => {
  duble.list.mockReturnValue({ data: [REUNIAO], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.get.mockReturnValue(detalhe());
  duble.pendencias.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
  duble.resumoGuardado.mockReturnValue(resumo());
  let revisao = 3;
  duble.editarTranscricao.mockImplementation(async () => ({ mudou: true, revisao: ++revisao, editada: true, substituicoes: 1 }));
  for (const mutate of Object.values(duble.mutacoes)) mutate.mockReset();
  window.history.replaceState(null, "", "/meetings");
});

function abrirATranscricao(aba: RegExp = /^Transcrição$/) {
  render(<Meetings />);
  fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
  fireEvent.click(screen.getByRole("button", { name: aba }));
}

describe("Reuniões — editar a transcrição (H18)", () => {
  it("fora da edição: a barra diz quando a dona editou, e o trecho mudado leva a marca", () => {
    abrirATranscricao();
    expect(screen.getByRole("button", { name: "Editar a transcrição" })).toBeInTheDocument();
    expect(screen.getByText(/Você editou esta transcrição em/)).toBeInTheDocument();
    expect(screen.getAllByText("Editado por você")).toHaveLength(1);
    // Fora da edição, nenhum botão de trecho.
    expect(screen.queryByRole("button", { name: /Editar o trecho de/ })).not.toBeInTheDocument();
  });

  it("o texto e a voz de um trecho: dois pedidos, com a posição na lista e a revisão que o anterior devolveu", async () => {
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:04" }));
    const formulario = screen.getByRole("form", { name: "Editar" });
    fireEvent.change(within(formulario).getByLabelText("Texto do trecho"), { target: { value: "A proposta sai na segunda." } });
    const voz = within(formulario).getByLabelText("Voz") as HTMLSelectElement;
    // As vozes da transcrição e a primeira livre.
    expect(Array.from(voz.options).map(opcao => opcao.textContent)).toEqual(["Falante 1", "Falante 2", "Nova voz (Falante 3)"]);
    fireEvent.change(voz, { target: { value: "F3" } });
    await act(async () => { fireEvent.click(within(formulario).getByRole("button", { name: "Salvar" })); });

    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(2));
    expect(duble.editarTranscricao.mock.calls[0][0]).toEqual({ meetingId: MEETING_ID, transcricaoId: "tr-1", revisao: 3, operacao: { tipo: "texto", indice: 1, texto: "A proposta sai na segunda." } });
    expect(duble.editarTranscricao.mock.calls[1][0]).toEqual({ meetingId: MEETING_ID, transcricaoId: "tr-1", revisao: 4, operacao: { tipo: "voz", indice: 1, falante: "F3" } });
    // Depois de cada mudança, o detalhe e o resumo são relidos.
    expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Editar" })).not.toBeInTheDocument());
  });

  it("com a busca da transcrição filtrando, a posição mandada é a do trecho na lista inteira", async () => {
    window.history.replaceState(null, "", `/meetings/${MEETING_ID}?q=Combinado`);
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:09" }));
    fireEvent.change(screen.getByLabelText("Texto do trecho"), { target: { value: "Combinado, então." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(1));
    expect(duble.editarTranscricao.mock.calls[0][0]).toMatchObject({ operacao: { tipo: "texto", indice: 2, texto: "Combinado, então." } });
  });

  it("localizar e substituir conta antes de trocar, e voltar um trecho ao original manda a posição dele", async () => {
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    const substituir = screen.getByRole("button", { name: "Substituir tudo" });
    expect(substituir).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Localizar"), { target: { value: "glenta" } });
    expect(screen.getByText("Ocorrências: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Diferenciar maiúsculas e minúsculas"));
    expect(screen.getByText("Ocorrências: 0")).toBeInTheDocument();
    expect(substituir).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Diferenciar maiúsculas e minúsculas"));
    fireEvent.change(screen.getByLabelText("Substituir por"), { target: { value: "Glenda" } });
    await act(async () => { fireEvent.click(substituir); });
    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(1));
    expect(duble.editarTranscricao.mock.calls[0][0]).toMatchObject({ revisao: 3, operacao: { tipo: "substituir", localizar: "glenta", substituirPor: "Glenda", diferenciarMaiusculas: false } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Substituições feitas: 1"));

    // O original da IA do trecho mudado, e o "Voltar ao original" dele.
    expect(screen.getByText("Bom dia, aqui é a Glenda.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Voltar o trecho de 00:00 ao original" })); });
    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(2));
    expect(duble.editarTranscricao.mock.calls[1][0]).toMatchObject({ revisao: 4, operacao: { tipo: "restaurar", indice: 0 } });
  });

  it("voltar tudo ao original pede confirmação antes", async () => {
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar tudo ao original" }));
    expect(duble.editarTranscricao).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Voltar ao original" })); });
    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(1));
    expect(duble.editarTranscricao.mock.calls[0][0]).toMatchObject({ operacao: { tipo: "restaurarTudo" } });
  });

  it("a recusa do servidor vira aviso no idioma da tela, e o detalhe é relido (a revisão nova)", async () => {
    duble.editarTranscricao.mockRejectedValue({ message: "EDICAO_TRANSCRICAO_MUDOU", data: { code: "CONFLICT" } });
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:04" }));
    fireEvent.change(screen.getByLabelText("Texto do trecho"), { target: { value: "Outra aba." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A transcrição mudou em outra tela. A versão nova foi carregada: confira e edite de novo."));
    expect(duble.utils.meetings.get.invalidate).toHaveBeenCalledWith({ meetingId: MEETING_ID });
    // O formulário fica aberto, com o que a dona escreveu.
    expect(screen.getByLabelText("Texto do trecho")).toHaveValue("Outra aba.");
  });

  it("a transcrição de texto corrido se edita como um texto só", async () => {
    duble.get.mockReturnValue(detalhe({ transcript: { ...transcricao({ editada: false, editadaEm: null, originais: [], revisao: 0 }), segments: [], transcript: "Reunião com a Glenta." } }));
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    const campo = screen.getByLabelText("Texto da transcrição");
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.change(campo, { target: { value: "Reunião com a Glenda." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    await waitFor(() => expect(duble.editarTranscricao).toHaveBeenCalledTimes(1));
    expect(duble.editarTranscricao.mock.calls[0][0]).toMatchObject({ revisao: 0, operacao: { tipo: "textoCorrido", texto: "Reunião com a Glenda." } });
  });

  it("documento e reunião fora de 'ready' não têm a barra", () => {
    duble.get.mockReturnValue(detalhe({ meeting: { origem: "pdf" }, transcript: { ...transcricao({}), segments: [{ pagina: 1, texto: "Página um." }], transcript: "Página um." } }));
    const { unmount } = render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Texto do documento$/ }));
    expect(screen.getByText("Página um.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar a transcrição" })).not.toBeInTheDocument();
    unmount();
    window.history.replaceState(null, "", "/meetings");
    duble.get.mockReturnValue(detalhe({ meeting: { status: "processing" } }));
    abrirATranscricao();
    expect(screen.queryByRole("button", { name: "Editar a transcrição" })).not.toBeInTheDocument();
  });

  it("o resumo de antes da edição: o aviso nas duas abas, e 'Refazer o resumo' no modelo de agora", () => {
    duble.resumoGuardado.mockReturnValue(resumo({ transcricaoEditadaDepois: true }));
    render(<Meetings />);
    fireEvent.click(screen.getByRole("button", { name: /Reunião com a vinícola/ }));
    expect(screen.getByText(/Você editou a transcrição depois deste resumo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refazer o resumo" }));
    expect(duble.mutacoes.refazerResumo).toHaveBeenCalledWith({ meetingId: MEETING_ID, modelo: "sales" });
    fireEvent.click(screen.getByRole("button", { name: /^Transcrição$/ }));
    expect(screen.getByText(/Você editou a transcrição depois deste resumo/)).toBeInTheDocument();
  });

  it("sem edição depois do resumo, nenhum aviso", () => {
    abrirATranscricao();
    expect(screen.queryByText(/Você editou a transcrição depois deste resumo/)).not.toBeInTheDocument();
  });

  it("na tradução (a reunião em inglês, com a tela em português), 'Editar a transcrição' aparece e diz que abre o original; tocar nele volta ao original com a edição aberta", () => {
    duble.get.mockReturnValue(detalhe({ transcript: { ...transcricao({}), language: "en" } }));
    abrirATranscricao();
    // A vista padrão é a tradução para o idioma da tela: o seletor não está no original.
    const seletor = screen.getByLabelText("Idioma de destino") as HTMLSelectElement;
    expect(seletor.value).toBe("pt-BR");
    const editar = screen.getByRole("button", { name: "Editar a transcrição" });
    expect(editar).toHaveAccessibleDescription("A edição abre a transcrição no idioma original.");
    // Na tradução, nenhum trecho se edita (o texto traduzido é só para ler).
    expect(screen.queryByRole("button", { name: "Concluir" })).not.toBeInTheDocument();

    fireEvent.click(editar);
    expect(seletor.value).toBe("en");
    expect(screen.getByRole("button", { name: "Concluir" })).toBeInTheDocument();
    expect(screen.queryByText("A edição abre a transcrição no idioma original.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:04" }));
    expect(screen.getByRole("form", { name: "Editar" })).toBeInTheDocument();
  });

  it("o trecho apagado inteiro: o 'Salvar' para e a frase sob o campo diz por quê, com o jeito de tirar uma fala inteira", () => {
    abrirATranscricao();
    fireEvent.click(screen.getByRole("button", { name: "Editar a transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:04" }));
    const formulario = screen.getByRole("form", { name: "Editar" });
    const campo = within(formulario).getByLabelText("Texto do trecho");
    const frase = "O trecho não pode ficar vazio. Para tirar uma fala inteira, escreva, por exemplo, [removido].";
    expect(within(formulario).queryByText(frase)).not.toBeInTheDocument();

    fireEvent.change(campo, { target: { value: "   " } });
    expect(within(formulario).getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(within(formulario).getByText(frase)).toBeInTheDocument();
    expect(campo).toHaveAccessibleDescription(frase);
    expect(campo).toHaveAttribute("aria-invalid", "true");

    // O jeito que a frase ensina vale: o "Salvar" volta, e a frase sai.
    fireEvent.change(campo, { target: { value: "[removido]" } });
    expect(within(formulario).getByRole("button", { name: "Salvar" })).toBeEnabled();
    expect(within(formulario).queryByText(frase)).not.toBeInTheDocument();
    expect(campo).not.toHaveAttribute("aria-invalid");
  });
});
