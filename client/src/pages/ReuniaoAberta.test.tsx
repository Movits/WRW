import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import ReuniaoAberta from "./ReuniaoAberta";

/**
 * A página do link aberto, /r/{token} (pedido do Roberto em 12/11/2026): quem
 * recebeu o link vê a reunião sem conta. O tRPC é um dublê: `ver` devolve o que
 * o teste combina, e `traduzir` registra o mutate e as opções. O resumo
 * guardado e o "Pergunte à reunião" viram marcadores que mostram o que
 * receberam (o comportamento deles está em components/ResumoGuardado.test.tsx e
 * components/ReuniaoComIA.test.tsx). Um teste monta o "Pergunte à reunião" de
 * verdade, para provar o elo da página com ele: as vozes com os nomes que o
 * link recebeu (H3b), "Falante n" na voz sem nome, e o "▶" que leva o player
 * da barra ao ponto.
 */

type OpcoesDaConsulta = {
  retry: (tentativas: number, erro: unknown) => boolean;
  refetchOnReconnect: (consulta: { state: { error: unknown } }) => boolean;
};
type OpcoesDoResumo = {
  enabled: boolean;
  retry: (tentativas: number, erro: unknown) => boolean;
  refetchInterval: (consulta: { state: { data?: { estado: string }; error: unknown } }) => number | false;
};

const duble = vi.hoisted(() => ({
  // As fotos e os desenhos do resumo (H4g e H4h) pela rota do link.
  anexos: [] as Array<{ id: string; tipo: string; url: string }>,
  entradaDosAnexos: null as unknown,
  ver: vi.fn(),
  opcoesDaConsulta: null as OpcoesDaConsulta | null,
  resumoGuardado: vi.fn(),
  opcoesDoResumo: null as OpcoesDoResumo | null,
  traduzir: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false },
  // A senha do link (H23): a tela da senha manda os 6 dígitos por aqui.
  entrar: { mutate: vi.fn(), isPending: false },
  // A tradução do resumo guardado (H11): a página pede pelo link; a mutação da dona nunca é chamada aqui.
  traduzirResumo: { mutate: vi.fn() },
  traduzirResumoDaDona: { mutate: vi.fn() },
  // As props que o "Pergunte à reunião" e o resumo receberam da página, na última vez.
  propsDaPergunta: null as Record<string, unknown> | null,
  propsDoResumo: null as Record<string, unknown> | null,
  propsDoMapa: null as Record<string, unknown> | null,
  // Ligado, a página monta o "Pergunte à reunião" de verdade, que lê a
  // resposta da pergunta pelo link daqui (o `data` da mutação).
  perguntaDeVerdade: false,
  respostaDaPergunta: undefined as unknown,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    // A tradução do resumo relê o resumo quando o servidor diz que ele mudou.
    useUtils: () => ({ reuniaoAberta: { resumoGuardado: { invalidate: vi.fn() }, anexos: { invalidate: vi.fn() } } }),
    // O "Pergunte à reunião" de verdade pede as três mutações de pergunta a
    // cada render (a da dona, a da gravação em curso, G15a, e a do link); a
    // tradução do resumo da dona nunca é chamada aqui.
    meetings: {
      traduzirResumo: { useMutation: () => duble.traduzirResumoDaDona },
      perguntar: { useMutation: () => ({ data: undefined, mutate: vi.fn(), isPending: false, isError: false, error: null }) },
      perguntarDuranteAGravacao: { useMutation: () => ({ data: undefined, mutate: vi.fn(), isPending: false, isError: false, error: null }) },
    },
    reuniaoAberta: {
      ver: {
        useQuery: (entrada: unknown, opcoes: OpcoesDaConsulta) => {
          duble.opcoesDaConsulta = opcoes;
          return duble.ver(entrada);
        },
      },
      traduzir: { useMutation: () => duble.traduzir },
      anexos: { useQuery: (entrada: unknown) => { duble.entradaDosAnexos = entrada; return { data: duble.anexos, error: null }; } },
      entrar: { useMutation: () => duble.entrar },
      traduzirResumo: { useMutation: () => duble.traduzirResumo },
      resumoGuardado: {
        useQuery: (entrada: unknown, opcoes: OpcoesDoResumo) => {
          duble.opcoesDoResumo = opcoes;
          return duble.resumoGuardado(entrada);
        },
      },
      perguntar: { useMutation: () => ({ data: duble.respostaDaPergunta, mutate: vi.fn(), isPending: false, isError: false, error: null }) },
    },
  },
}));
// O marcador da pergunta mostra o token, e o "▶" de uma citação chama o
// aoIrPara da página com 615 s (10:15). Com `perguntaDeVerdade`, a página
// monta o componente de verdade.
vi.mock("@/components/ReuniaoComIA", async importOriginal => {
  const real = await importOriginal<typeof import("@/components/ReuniaoComIA")>();
  return {
    PergunteAReuniao: (props: { token: string; aoIrPara?: (segundo: number) => void }) => {
      duble.propsDaPergunta = props;
      if (duble.perguntaDeVerdade) return <real.PergunteAReuniao {...props}/>;
      return <div data-testid="pergunte">{props.token}{props.aoIrPara && <button type="button" onClick={() => props.aoIrPara?.(615)}>▶ da pergunta</button>}</div>;
    },
  };
});
// O marcador do resumo mostra o token e o estado que recebeu, e o "▶" dele
// chama o aoIrPara da página com 610 s (10:10). A tradução (H11) que a página
// passa aparece em outro marcador, com os textos que ela poria no resumo.
type TraducaoRecebida = { estado: string; idioma: string; aplicar: (dados: unknown) => { itens?: Array<{ text: string }> } | undefined };
vi.mock("@/components/ResumoGuardado", () => ({
  ResumoGuardado: (props: { token: string; consulta: { data?: { estado: string } }; nomes?: Record<string, string>; aoIrPara?: (segundo: number) => void; traducao?: TraducaoRecebida }) => {
    duble.propsDoResumo = props;
    const { token, consulta, aoIrPara, traducao } = props;
    return <>
      <div data-testid="resumo">{token} {consulta.data?.estado}{aoIrPara && <button type="button" onClick={() => aoIrPara(610)}>▶ do resumo</button>}</div>
      <div data-testid="traducao-do-resumo">{traducao?.estado} {traducao?.idioma} {traducao?.aplicar(consulta.data)?.itens?.map(item => item.text).join(" | ")}</div>
    </>;
  },
}));
// O mapa mental (H10) vira um marcador que mostra o que recebeu; o
// comportamento dele está em components/MapaMental.test.tsx.
// A tradução (H11) que a página passa aparece nele (o estado e o rótulo
// "Prazos" traduzido), e o botão faz o papel do mapa que fica pronto.
type TraducaoDoMapaRecebida = { estado: string; traduzirRotulo: (rotulo: string) => string };
vi.mock("@/components/MapaMental", () => ({
  MapaMentalDaReuniao: (props: {
    token?: string; meetingId?: string; titulo: string; emoji?: string | null; traducao?: TraducaoDoMapaRecebida; aoMudarRotulos?: (rotulos: string[]) => void; aoPedirSenha?: () => void; documento?: boolean;
  }) => {
    duble.propsDoMapa = props;
    const { token, meetingId, titulo, emoji, traducao, aoMudarRotulos } = props;
    return <div data-testid="mapa-mental">{token} | {meetingId ?? "sem id"} | {titulo} | {emoji ?? "sem emoji"}
      <span data-testid="traducao-do-mapa">{traducao?.estado} {traducao?.traduzirRotulo("Prazos")}</span>
      {aoMudarRotulos && <button type="button" onClick={() => aoMudarRotulos(["Prazos"])}>rótulos do mapa</button>}
    </div>;
  },
}));

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const VISTA = {
  titulo: "Reunião com a Ana",
  criadaEm: 1_700_000_000_000,
  transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR" },
  gravacao: { url: `/reuniao-aberta/${TOKEN}/audio`, mimeType: "audio/mp4", durationSeconds: 95, expiresAt: 1_800_000_000_000 },
  gravacaoExpirada: false,
};
const pronta = (data: unknown = VISTA) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const emErro = (code: string, refetch = vi.fn()) => ({
  data: undefined, isLoading: false, isError: true, error: { message: "frase do servidor", data: { code } }, refetch,
});

function abrir() {
  window.history.replaceState(null, "", `/r/${TOKEN}`);
  return render(<Route path="/r/:token" component={ReuniaoAberta}/>);
}

// A página abre na aba Resumo (H4c); a transcrição e a tradução ficam na aba
// Transcrição.
function abrirNaTranscricao() {
  const tela = abrir();
  fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
  return tela;
}

beforeEach(() => {
  duble.anexos = [];
  duble.entradaDosAnexos = null;
  duble.ver.mockReset();
  duble.opcoesDaConsulta = null;
  duble.opcoesDoResumo = null;
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, itens: [] }, isError: false, error: null, refetch: vi.fn() });
  duble.traduzir = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false };
  duble.entrar = { mutate: vi.fn(), isPending: false };
  duble.traduzirResumo = { mutate: vi.fn() };
  duble.traduzirResumoDaDona = { mutate: vi.fn() };
  duble.propsDaPergunta = null;
  duble.propsDoResumo = null;
  duble.propsDoMapa = null;
  duble.perguntaDeVerdade = false;
  duble.respostaDaPergunta = undefined;
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Reunião aberta pelo link", () => {
  it("pede a reunião pelo token da URL e mostra título, gravação pela rota do link, transcrição e a IA", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    expect(duble.ver).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.getByText("REUNIÃO COMPARTILHADA")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Reunião com a Ana" })).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/audio`);
    // A linha da duração; o 01:35 aparece também na barra do player (o total, D1b).
    expect(screen.getByText(/Duração: 01:35/)).toBeInTheDocument();
    expect(screen.getByTestId("resumo")).toHaveTextContent(`${TOKEN} sem_resumo`);
    expect(screen.getByTestId("pergunte")).toHaveTextContent(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    // Nada do que é só da dona: nem excluir, nem os contatos, nem baixar o PDF (H8) ou o áudio (H8c).
    expect(screen.queryByRole("button", { name: /Excluir/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Contatos/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Baixar PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Baixar o áudio/ })).not.toBeInTheDocument();
    expect(container.querySelector('a[download], a[href*="baixar-audio"]')).toBeNull();
  });

  it("as fotos e os desenhos do resumo (H4g e H4h) aparecem na aba Resumo, pela rota do link, sem botão de tirar", () => {
    duble.ver.mockReturnValue(pronta());
    duble.anexos = [{ id: "a1", tipo: "photo", url: `/reuniao-aberta/${TOKEN}/anexo/a1` }, { id: "a2", tipo: "drawing", url: `/reuniao-aberta/${TOKEN}/anexo/a2` }];
    abrir();
    expect(duble.entradaDosAnexos).toEqual({ token: TOKEN });
    expect(screen.getByAltText("Foto 1")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/anexo/a1`);
    expect(screen.getByAltText("Desenho 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Tirar / })).not.toBeInTheDocument();
  });

  it("abre na aba Resumo, como no app de referência; a Transcrição fica na outra aba", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    const resumo = screen.getByRole("button", { name: "Resumo" });
    const transcricao = screen.getByRole("button", { name: "Transcrição" });
    expect(resumo).toHaveAttribute("aria-pressed", "true");
    expect(transcricao).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("resumo")).toBeInTheDocument();
    expect(screen.queryByText("Combinamos a entrega na sexta.")).not.toBeInTheDocument();
    fireEvent.click(transcricao);
    expect(transcricao).toHaveAttribute("aria-pressed", "true");
    expect(resumo).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    expect(screen.queryByTestId("resumo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pergunte")).not.toBeInTheDocument();
  });

  it("a transcrição que a dona editou (H18) diz isso a quem lê; a da IA, não", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { ...VISTA.transcricao, editada: true } }));
    const { unmount } = abrir();
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.getByText("Transcrição revisada por quem gravou a reunião.")).toBeInTheDocument();
    unmount();
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { ...VISTA.transcricao, editada: false } }));
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.queryByText("Transcrição revisada por quem gravou a reunião.")).not.toBeInTheDocument();
  });

  it("trocar de aba não corta o áudio nem perde a tradução", () => {
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    const audio = document.querySelector("audio");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "es" } });
    const { onSuccess } = duble.traduzir.mutate.mock.calls[0][1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Acordamos la entrega el viernes." }));
    fireEvent.click(screen.getByRole("button", { name: "Resumo" }));
    expect(document.querySelector("audio")).toBe(audio);
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(document.querySelector("audio")).toBe(audio);
    expect(screen.getByText("Acordamos la entrega el viernes.")).toBeInTheDocument();
    // A volta à aba não pede a tradução de novo.
    expect(duble.traduzir.mutate).toHaveBeenCalledTimes(1);
  });

  it("link que não existe ou foi desligado: aviso traduzido, sem tentar de novo", () => {
    duble.ver.mockReturnValue(emErro("NOT_FOUND"));
    abrir();
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
    expect(screen.getByRole("link", { name: "Conhecer a Marquesa Global Match" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /Tentar/ })).not.toBeInTheDocument();
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(duble.opcoesDaConsulta!.refetchOnReconnect({ state: { error: { data: { code: "NOT_FOUND" } } } })).toBe(false);
  });

  it("servidor fora do ar não é 'link desligado': erro com tentar de novo", () => {
    const refetch = vi.fn();
    duble.ver.mockReturnValue(emErro("INTERNAL_SERVER_ERROR", refetch));
    abrir();
    expect(screen.queryByText(/não está mais disponível/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tentar/ }));
    expect(refetch).toHaveBeenCalled();
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(duble.opcoesDaConsulta!.retry(3, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });

  it("gravação vencida: diz que expirou e que a transcrição continua", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: true }));
    const { container } = abrir();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByText(/passou dos 30 dias/)).toBeInTheDocument();
  });

  it("gravação vencida que ainda não saiu do bucket: diz que está saindo, não que 'foi apagada'", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: false, gravacaoSaindo: true }));
    const { container } = abrir();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByText(/O app ainda está apagando o áudio do armazenamento/)).toBeInTheDocument();
    expect(screen.queryByText(/foi apagada/)).not.toBeInTheDocument();
  });

  it("sem transcrição: a IA não aparece e a tela diz que a transcrição não está disponível", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: null }));
    abrir();
    expect(screen.queryByTestId("resumo")).not.toBeInTheDocument();
    // Sem texto para resumir, a consulta do resumo nem sai.
    expect(duble.opcoesDoResumo!.enabled).toBe(false);
    expect(screen.queryByTestId("pergunte")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.getByText("A transcrição ainda não está disponível.")).toBeInTheDocument();
  });

  it("áudio que não carrega: aviso sem mandar entrar na conta, que quem abriu o link não tem", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByText("Não foi possível carregar o áudio agora. Recarregue a página e tente de novo.")).toBeInTheDocument();
    expect(screen.queryByText(/entre de novo/)).not.toBeInTheDocument();
  });

  it("o player fica na barra fixa do rodapé (H4b), com o aviso dentro dela, e a página reserva o espaço", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    const barra = screen.getByRole("region", { name: "Gravação" });
    expect(barra.querySelector("audio")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/audio`);
    expect(container.querySelector("main")!.className).toContain("pb-36");
    fireEvent.error(barra.querySelector("audio")!);
    expect(within(barra).getByRole("status")).toHaveTextContent("Não foi possível carregar o áudio agora.");
  });

  it("em partes, a do meio que não carrega pula para a seguinte, e o aviso segue na barra quando a seguinte carrega (D1b)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const parte = (seq: number) => ({ seq, url: `/reuniao-aberta/${TOKEN}/audio?parte=${seq}`, mimeType: "audio/mp4", inicioSegundos: seq * 600, duracaoSegundos: 600 });
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: { ...VISTA.gravacao, durationSeconds: 1800, partes: [parte(0), parte(1), parte(2)] } }));
    abrir();
    const barra = screen.getByRole("region", { name: "Gravação" });
    const audio = barra.querySelector("audio")!;
    fireEvent.click(within(barra).getByRole("button", { name: "Tocar" }));
    fireEvent.ended(audio);
    fireEvent.error(audio);
    expect(audio.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=2`);
    fireEvent.loadedMetadata(audio);
    fireEvent.loadedData(audio);
    // Sem o aviso, o salto de 10 a 20 min ficaria sem explicação.
    expect(within(barra).getByRole("status")).toHaveTextContent("Não foi possível carregar o áudio agora.");
  });

  it("em pt-BR mostra o original sem pedir tradução; trocar o idioma traduz pelo token", () => {
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    expect(duble.traduzir.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "es" } });
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "es" }, expect.anything());
    const { onSuccess } = duble.traduzir.mutate.mock.calls[0][1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Acordamos la entrega el viernes." }));
    expect(screen.getByText("Acordamos la entrega el viernes.")).toBeInTheDocument();
    // De volta ao original: o texto da transcrição, e o erro de antes sai.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pt-BR" } });
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    expect(duble.traduzir.reset).toHaveBeenCalled();
  });

  it("reunião em inglês com a tela em pt-BR: traduz para o pt-BR, e o inglês é o original (G1b)", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { texto: "We agreed on Friday.", idioma: "en" } }));
    abrirNaTranscricao();
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "pt-BR" }, expect.anything());
    expect(screen.getByRole("option", { name: /English \(original\)/ })).toBeInTheDocument();
    duble.traduzir.mutate.mockClear();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(duble.traduzir.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("We agreed on Friday.")).toBeInTheDocument();
  });

  it("G16: reunião em italiano pelo link, com a tela em pt-BR: traduz, e a lista ganha \"Italiano (original)\", que volta ao original", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { texto: "Abbiamo concordato venerdì.", idioma: "it" } }));
    abrirNaTranscricao();
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "pt-BR" }, expect.anything());
    expect(screen.getByRole("option", { name: "Italiano (original)" })).toBeInTheDocument();
    duble.traduzir.mutate.mockClear();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "it" } });
    expect(duble.traduzir.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Abbiamo concordato venerdì.")).toBeInTheDocument();
  });

  it("reunião longa: 'em andamento' mostra o aviso e pergunta de novo em 5 s (G8)", async () => {
    vi.useFakeTimers();
    try {
      duble.ver.mockReturnValue(pronta());
      abrirNaTranscricao();
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "es" } });
      const pedidos = duble.traduzir.mutate.mock.calls;
      act(() => (pedidos[0][1] as { onSuccess: (r: unknown) => void }).onSuccess({ language: "es", text: null, cached: false, emAndamento: true }));
      // Há também o status da barra do player (H4b): o aviso é o status com este texto.
      expect(screen.getByText(/A reunião é longa/).closest("[role=status]")).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(pedidos).toHaveLength(2);
      expect(pedidos[1][0]).toEqual({ token: TOKEN, language: "es" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reunião em partes (D1): falas por falante, e clicar no tempo leva o player à parte certa", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.ver.mockReturnValue(pronta({
      ...VISTA,
      transcricao: { texto: "Oi. Tchau.", idioma: "pt-BR", segmentos: [
        { inicio: 1, fim: 2, falante: "F1", texto: "Oi." },
        { inicio: 610, fim: 612, falante: "F2", texto: "Tchau." },
      ] },
      gravacao: { ...VISTA.gravacao, partes: [
        { seq: 0, url: `/reuniao-aberta/${TOKEN}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
        { seq: 1, url: `/reuniao-aberta/${TOKEN}/audio?parte=1`, mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 60 },
      ] },
    }));
    abrirNaTranscricao();
    expect(screen.getAllByText("Falante 2").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:10" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=1`);
  });

  it("com a tela em inglês, já abre pedindo a tradução para o inglês", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "en" }, expect.anything());
  });

  it("tradução que falhou: avisa e mostra o original", () => {
    duble.traduzir = { ...duble.traduzir, isError: true };
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fr" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível traduzir a transcrição.");
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
  });
});

describe("Reunião aberta pelo link — o erro da tradução diz o que houve e deixa tentar de novo", () => {
  const comErro = (code: string, message = "frase do servidor") => {
    duble.traduzir = { ...duble.traduzir, isError: true, error: { message, data: { code } } } as typeof duble.traduzir;
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fr" } });
    return screen.getByRole("alert");
  };

  it.each([
    ["TOO_MANY_REQUESTS", "frase do servidor", "Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo."],
    ["NOT_FOUND", "frase do servidor", "Este link não existe ou não está mais disponível."],
    ["INTERNAL_SERVER_ERROR", MENSAGEM_BANCO_INDISPONIVEL, "Banco de dados indisponível; tente de novo em instantes"],
    ["SERVICE_UNAVAILABLE", "A tradução não respondeu agora.", "Não foi possível traduzir a transcrição."],
  ])("%s: a frase certa, no idioma de quem lê", (code, message, frase) => {
    expect(comErro(code, message)).toHaveTextContent(frase);
  });

  it("mensagem de servidor que a tela não conhece não aparece crua", () => {
    const alerta = comErro("INTERNAL_SERVER_ERROR", "LLM invoke failed: 500 detalhe interno");
    expect(alerta).not.toHaveTextContent(/LLM invoke failed/);
    expect(alerta).toHaveTextContent("Não foi possível traduzir a transcrição.");
  });

  it("Tentar de novo pede a mesma tradução outra vez, pelo token", () => {
    comErro("SERVICE_UNAVAILABLE");
    duble.traduzir.mutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Tentar/ }));
    expect(duble.traduzir.mutate).toHaveBeenCalledWith({ token: TOKEN, language: "fr" }, expect.anything());
  });

  it("o texto da transcrição segue a direção dele mesmo, e o idioma dele vai para o leitor de tela", () => {
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    const original = screen.getByText("Combinamos a entrega na sexta.");
    expect(original).toHaveAttribute("dir", "auto");
    expect(original).toHaveAttribute("lang", "pt-BR");
  });

  it("o subtítulo da tradução fala com quem lê, não com a dona", () => {
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    expect(screen.getByText("Escolha o idioma em que você quer ler a transcrição.")).toBeInTheDocument();
  });

  it("gravação de mais de 1 h mostra a duração em H:MM:SS, como no detalhe da dona (G13a)", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: { ...VISTA.gravacao, durationSeconds: 4_500 } }));
    abrir();
    // A linha da duração; o 1:15:00 aparece também na barra do player (o total, D1b).
    expect(screen.getByText(/Duração: 1:15:00/)).toBeInTheDocument();
    expect(screen.queryByText(/75:00/)).not.toBeInTheDocument();
  });

  it("a linha da gravação tem um separador só", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    const linha = screen.getByText(/Duração: 01:35/);
    expect(linha.textContent).not.toMatch(/·\s*·/);
  });
});

describe("Reunião aberta pelo link — direção e anúncios", () => {
  it("o título da dona segue a direção dele mesmo", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("dir", "auto");
  });

  it("\"Traduzindo\" é anunciado ao leitor de tela", () => {
    duble.traduzir = { ...duble.traduzir, isPending: true };
    duble.ver.mockReturnValue(pronta());
    abrirNaTranscricao();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "es" } });
    // Há também o status da barra do player (H4b): o anúncio é o status com este texto.
    expect(screen.getByText(/Traduzindo/).closest("[role=status]")).not.toBeNull();
  });
});

// T25, como no detalhe da dona: a tradução automática para o idioma da tela
// diz que é tradução e leva ao original.
describe("Reunião aberta pelo link — o aviso de tradução automática (T25)", () => {
  const EM_INGLES = { ...VISTA, transcricao: { texto: "We will sign on Friday. Send me the draft.", idioma: "en", segmentos: [
    { inicio: 5, fim: 12, falante: "F1", texto: "We will sign on Friday." },
    { inicio: 13, fim: 20, falante: "F2", texto: "Send me the draft." },
  ] } };

  it("reunião em inglês aberta com a tela em pt-BR: a tradução vem com o aviso, e 'Ver original' volta às falas com falante e horário", () => {
    duble.ver.mockReturnValue(pronta(EM_INGLES));
    abrirNaTranscricao();
    expect(duble.traduzir.mutate).toHaveBeenCalledTimes(1);
    const { onSuccess } = duble.traduzir.mutate.mock.calls[0][1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Vamos assinar na sexta. Me mande a minuta." }));
    expect(screen.getByText("Vamos assinar na sexta. Me mande a minuta.")).toBeInTheDocument();
    expect(screen.getByText("Tradução automática para o português.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
    expect(screen.getByRole("combobox")).toHaveValue("en");
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Falante 1")).toBeInTheDocument();
    expect(within(falas).getByText("We will sign on Friday.")).toBeInTheDocument();
    expect(within(falas).getByRole("button", { name: "Ouvir a partir de 00:13" })).toBeInTheDocument();
    // O original já estava aqui: nada é pedido de novo, e o estado da tradução sai.
    expect(duble.traduzir.mutate).toHaveBeenCalledTimes(1);
    expect(duble.traduzir.reset).toHaveBeenCalled();
  });

  it("'Ver original' some com o aviso e deixa o foco no seletor do idioma, que mostra o original, em vez de largá-lo no <body>", () => {
    duble.ver.mockReturnValue(pronta(EM_INGLES));
    abrirNaTranscricao();
    const { onSuccess } = duble.traduzir.mutate.mock.calls[0][1] as { onSuccess: (r: { text: string }) => void };
    act(() => onSuccess({ text: "Vamos assinar na sexta. Me mande a minuta." }));
    const verOriginal = screen.getByRole("button", { name: "Ver original" });
    verOriginal.focus();
    fireEvent.click(verOriginal);
    expect(verOriginal).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("en");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("tela no idioma da reunião: as falas, sem o aviso e sem pedir tradução", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR", segmentos: [
      { inicio: 5, fim: 12, falante: "F1", texto: "Combinamos a entrega na sexta." },
    ] } }));
    abrirNaTranscricao();
    expect(duble.traduzir.mutate).not.toHaveBeenCalled();
    expect(within(document.querySelector("ol")!).getByText("Falante 1")).toBeInTheDocument();
    expect(screen.queryByText(/Tradução automática/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver original" })).not.toBeInTheDocument();
  });
});

describe("Reunião aberta pelo link — o resumo guardado (H4c)", () => {
  it("vem pelo token e pergunta de novo a cada 5 s enquanto é gerado; o link desligado para a consulta", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.resumoGuardado).toHaveBeenCalledWith({ token: TOKEN });
    const opcoes = duble.opcoesDoResumo!;
    expect(opcoes.enabled).toBe(true);
    const com = (estado: string, error: unknown = null) => opcoes.refetchInterval({ state: { data: { estado }, error } });
    expect(com("pendente")).toBe(5_000);
    expect(com("gerando")).toBe(5_000);
    expect(com("pronto")).toBe(false);
    expect(com("falhou")).toBe(false);
    expect(com("pendente", { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(opcoes.retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(opcoes.retry(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
  });

  it("o erro que persiste (500, banco fora do ar, rede) também para a repetição: nenhum visitante fica perguntando para sempre", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    const { refetchInterval } = duble.opcoesDoResumo!;
    const com = (estado: string, error: unknown) => refetchInterval({ state: { data: { estado }, error } });
    expect(com("pendente", { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(com("gerando", { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    // O erro da rede chega sem código.
    expect(com("pendente", new Error("Failed to fetch"))).toBe(false);
    // A releitura que dá certo limpa o erro, e a repetição volta.
    expect(com("pendente", null)).toBe(5_000);
  });

  it("o emoji do resumo vai antes do título, sem mudar o nome do título", () => {
    duble.ver.mockReturnValue(pronta());
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: "🚢", itens: [] }, isError: false, error: null, refetch: vi.fn() });
    abrir();
    const titulo = screen.getByRole("heading", { level: 1, name: "Reunião com a Ana" });
    expect(titulo.textContent).toBe("🚢Reunião com a Ana");
    expect(titulo).toHaveAttribute("dir", "auto");
  });

  it("o '▶' do resumo leva o player da barra ao ponto, na parte certa", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.ver.mockReturnValue(pronta({
      ...VISTA,
      gravacao: { ...VISTA.gravacao, partes: [
        { seq: 0, url: `/reuniao-aberta/${TOKEN}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
        { seq: 1, url: `/reuniao-aberta/${TOKEN}/audio?parte=1`, mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 60 },
      ] },
    }));
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "▶ do resumo" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=1`);
  });

  it("sem gravação, o resumo não ganha o '▶'", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: true }));
    abrir();
    expect(screen.getByTestId("resumo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "▶ do resumo" })).not.toBeInTheDocument();
  });

  it("o '▶' de uma citação do Pergunte à reunião leva o mesmo player da barra ao ponto, na parte certa (H6)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.ver.mockReturnValue(pronta({
      ...VISTA,
      gravacao: { ...VISTA.gravacao, partes: [
        { seq: 0, url: `/reuniao-aberta/${TOKEN}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
        { seq: 1, url: `/reuniao-aberta/${TOKEN}/audio?parte=1`, mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 60 },
      ] },
    }));
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "▶ da pergunta" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=1`);
    expect(document.querySelectorAll("audio")).toHaveLength(1);
  });

  it("com o 'Pergunte à reunião' de verdade: a resposta leva os nomes que o link recebeu, a voz sem nome é 'Falante n', e o '▶' da citação leva o player da barra à parte certa (H6, H3b)", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.perguntaDeVerdade = true;
    duble.respostaDaPergunta = {
      respondida: true,
      resposta: "{F1} propôs a entrega na sexta, e {F2} concordou.",
      citacoes: [{ trecho: "Combinamos a entrega na sexta", inicioSegundos: 615 }],
      trecho: "Combinamos a entrega na sexta",
    };
    duble.ver.mockReturnValue(pronta({
      ...VISTA,
      vozes: { F1: "Ana" },
      gravacao: { ...VISTA.gravacao, partes: [
        { seq: 0, url: `/reuniao-aberta/${TOKEN}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
        { seq: 1, url: `/reuniao-aberta/${TOKEN}/audio?parte=1`, mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 60 },
      ] },
    }));
    abrir();
    expect(screen.getByText("Ana propôs a entrega na sexta, e Falante 2 concordou.")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:15" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=1`);
  });

  it("sem gravação, a pergunta não ganha o '▶', e segue pedindo pelo token, nunca pela reunião da dona", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: true }));
    abrir();
    expect(screen.getByTestId("pergunte")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "▶ da pergunta" })).not.toBeInTheDocument();
    expect(duble.propsDaPergunta).toMatchObject({ token: TOKEN });
    expect(duble.propsDaPergunta).not.toHaveProperty("meetingId");
  });
});

describe("Reunião aberta pelo link — os nomes das vozes (H3b)", () => {
  const COM_FALAS = {
    ...VISTA,
    transcricao: { texto: "Oi. Tchau.", idioma: "pt-BR", segmentos: [
      { inicio: 1, fim: 2, falante: "F1", texto: "Oi." },
      { inicio: 3, fim: 5, falante: "F2", texto: "Tchau." },
    ] },
  };

  // Os nomes se conferem com toEqual, nunca com toMatchObject: no toMatchObject,
  // `nomes: {}` casa com qualquer mapa, até com { F1: "Ana" }, e com undefined.
  it("os nomes que o link recebeu chegam ao resumo, à pergunta e à transcrição; a voz sem nome segue 'Falante n'", () => {
    duble.ver.mockReturnValue(pronta({ ...COM_FALAS, vozes: { F1: "Ana" } }));
    abrir();
    expect(duble.propsDoResumo).toMatchObject({ token: TOKEN });
    expect(duble.propsDoResumo?.nomes).toEqual({ F1: "Ana" });
    expect(duble.propsDaPergunta).toMatchObject({ token: TOKEN });
    expect(duble.propsDaPergunta?.nomes).toEqual({ F1: "Ana" });
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Ana")).toBeInTheDocument();
    expect(within(falas).getByText("Falante 2")).toBeInTheDocument();
    expect(within(falas).queryByText("Falante 1")).not.toBeInTheDocument();
    // O tempo de fala também leva o nome; e quem tem o link não renomeia nada.
    const tempoDeFala = screen.getByText("Tempo de fala").parentElement!;
    expect(tempoDeFala).toHaveTextContent("Ana");
    expect(tempoDeFala).toHaveTextContent("Falante 2");
    expect(screen.queryByTitle("Dar nome a esta voz")).not.toBeInTheDocument();
  });

  // D2 no link: ouvir só uma voz com o nome que o link já recebeu (H3b); só
  // troca o que toca e o que a lista mostra, sem pedir nada novo ao servidor.
  it("ouvir só uma voz pelo link: o botão usa o nome que o link recebeu, e a barra diz qual voz toca", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    duble.ver.mockReturnValue(pronta({ ...COM_FALAS, vozes: { F1: "Ana" } }));
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    fireEvent.click(screen.getByRole("button", { name: "Ouvir só a voz de Ana" }));
    const barra = screen.getByRole("region", { name: "Gravação" });
    expect(within(barra).getByText("Ouvindo só: Ana")).toBeInTheDocument();
    expect(within(document.querySelector("ol")!).queryByText("Tchau.")).not.toBeInTheDocument();
    fireEvent.click(within(barra).getByRole("button", { name: "Ouvir todas as vozes" }));
    expect(within(document.querySelector("ol")!).getByText("Tchau.")).toBeInTheDocument();
  });

  it("link ligado com a confirmação antiga: o servidor manda vozes vazio, e toda voz é 'Falante n'", () => {
    duble.ver.mockReturnValue(pronta({ ...COM_FALAS, vozes: {} }));
    abrir();
    expect(duble.propsDoResumo?.nomes).toEqual({});
    expect(duble.propsDaPergunta?.nomes).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    const falas = document.querySelector("ol")!;
    expect(within(falas).getByText("Falante 1")).toBeInTheDocument();
    expect(within(falas).getByText("Falante 2")).toBeInTheDocument();
  });

  it("a resposta de um servidor de antes da H3b, sem o campo, também mostra 'Falante n', sem quebrar a página", () => {
    duble.ver.mockReturnValue(pronta(COM_FALAS));
    abrir();
    // O mapa vazio, e não undefined: a página põe o `?? {}` antes de passar adiante.
    expect(duble.propsDoResumo?.nomes).toEqual({});
    expect(duble.propsDaPergunta?.nomes).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(within(document.querySelector("ol")!).getByText("Falante 1")).toBeInTheDocument();
  });
});

describe("Reunião aberta pelo link — a aba Mapa mental (H10)", () => {
  const abaDoMapa = () => screen.getByRole("button", { name: "Mapa mental" });

  it("é a terceira aba, como no app de referência; mostra o mapa pelo token, com o título e o emoji do resumo", () => {
    duble.ver.mockReturnValue(pronta());
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: "🍷", itens: [] }, isError: false, error: null, refetch: vi.fn() });
    abrir();
    const abas = screen.getAllByRole("button").filter(botao => botao.hasAttribute("aria-pressed")).map(aba => aba.textContent);
    expect(abas).toEqual(["Resumo", "Transcrição", "Mapa mental"]);
    expect(screen.queryByTestId("mapa-mental")).not.toBeInTheDocument();

    fireEvent.click(abaDoMapa());

    expect(abaDoMapa()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mapa-mental")).toHaveTextContent(`${TOKEN} | sem id | Reunião com a Ana | 🍷`);
    expect(screen.queryByTestId("resumo")).not.toBeInTheDocument();
  });

  it("trocar para o mapa e voltar não corta o áudio", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    const audio = document.querySelector("audio");
    fireEvent.click(abaDoMapa());
    expect(document.querySelector("audio")).toBe(audio);
    fireEvent.click(screen.getByRole("button", { name: "Resumo" }));
    expect(document.querySelector("audio")).toBe(audio);
  });

  it("sem texto na transcrição, a aba diz que o mapa vem com a transcrição, sem pedir nada", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, transcricao: { texto: "  ", idioma: "pt-BR" } }));
    abrir();
    fireEvent.click(abaDoMapa());
    expect(screen.queryByTestId("mapa-mental")).not.toBeInTheDocument();
    expect(screen.getByText("O mapa mental aparece aqui quando a transcrição da reunião estiver pronta.")).toBeInTheDocument();
  });
});

describe("Reunião aberta pelo link — a tradução do resumo (H11)", () => {
  const ITENS = [
    { section: "action", subject: null, text: "{F2} envia a proposta", assignee: "{F2}", due: null, excerpt: "eu mando a proposta", startSeconds: 5, status: "pending" },
    { section: "decision", subject: null, text: "Renovar o contrato", assignee: null, due: null, excerpt: "vamos renovar", startSeconds: 9, status: "confirmed" },
  ];
  const resumoPronto = (idioma: string | null = "pt-BR") => ({ data: { estado: "pronto", emoji: null, idioma, itens: ITENS }, isError: false, error: null, refetch: vi.fn() });
  type Pedido = [{ token: string; idioma: string }, { onSuccess: (resposta: unknown) => void; onError: (erro: unknown) => void }];

  it("com a tela em outro idioma, pede pelo link a tradução no idioma da tela, e o resumo traduzido entra no lugar", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.ver.mockReturnValue(pronta());
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrir();

    expect(duble.traduzirResumo.mutate).toHaveBeenCalledWith({ token: TOKEN, idioma: "en" }, expect.anything());
    expect(duble.traduzirResumoDaDona.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("traducao-do-resumo")).toHaveTextContent("traduzindo en {F2} envia a proposta | Renovar o contrato");

    const [, { onSuccess }] = duble.traduzirResumo.mutate.mock.calls[0] as Pedido;
    act(() => onSuccess({
      estado: "pronta", idioma: "en", mapa: {},
      itens: [{ ...ITENS[0], text: "{F2} sends the proposal" }, { ...ITENS[1], text: "Renew the contract" }],
    }));
    expect(screen.getByTestId("traducao-do-resumo")).toHaveTextContent("pronta en {F2} sends the proposal | Renew the contract");
  });

  it("com a tela no idioma do resumo, não pede nada", () => {
    duble.ver.mockReturnValue(pronta());
    duble.resumoGuardado.mockReturnValue(resumoPronto("pt-BR"));
    abrir();
    expect(duble.traduzirResumo.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("traducao-do-resumo")).toHaveTextContent("original pt-BR");
  });

  it("sem resumo pronto, nem pede nem oferece a escolha do idioma", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.traduzirResumo.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("traducao-do-resumo")).toHaveTextContent("inativa");
  });

  it("o mapa mental recebe a mesma tradução; o mapa que avisa os rótulos pede de novo pelo link, e os rótulos chegam traduzidos", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.ver.mockReturnValue(pronta());
    duble.resumoGuardado.mockReturnValue(resumoPronto());
    abrir();
    const [, { onSuccess }] = duble.traduzirResumo.mutate.mock.calls[0] as Pedido;
    act(() => onSuccess({ estado: "pronta", idioma: "en", mapa: {}, itens: ITENS }));
    fireEvent.click(screen.getByRole("button", { name: "Mind map" }));
    expect(screen.getByTestId("traducao-do-mapa")).toHaveTextContent("pronta Prazos");

    fireEvent.click(screen.getByRole("button", { name: "rótulos do mapa" }));
    expect(duble.traduzirResumo.mutate).toHaveBeenCalledTimes(2);
    expect(duble.traduzirResumo.mutate.mock.calls[1][0]).toEqual({ token: TOKEN, idioma: "en" });
    const [, segundo] = duble.traduzirResumo.mutate.mock.calls[1] as Pedido;
    act(() => segundo.onSuccess({ estado: "pronta", idioma: "en", mapa: { Prazos: "Deadlines" }, itens: ITENS }));
    expect(screen.getByTestId("traducao-do-mapa")).toHaveTextContent("pronta Deadlines");
  });
});

/**
 * O link com senha e o link sem o áudio (H23): a página mostra só a tela da
 * senha até quem recebeu o link acertar os 6 dígitos, e o link sem o áudio não
 * tem player. A tela da senha em si está em components/SenhaDoLinkAberto.test.tsx.
 */
describe("o link com senha e o link sem o áudio (H23)", () => {
  it("com senha: só a tela da senha, sem o título nem nada da reunião, e sem tentar de novo sozinha", () => {
    duble.ver.mockReturnValue(emErro("UNAUTHORIZED"));
    const { container } = abrir();
    expect(screen.getByRole("heading", { name: "Reunião protegida por senha" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Senha de 6 dígitos" })).toBeInTheDocument();
    expect(screen.queryByText("REUNIÃO COMPARTILHADA")).not.toBeInTheDocument();
    expect(screen.queryByText("frase do servidor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("resumo")).not.toBeInTheDocument();
    expect(container.querySelector("audio")).toBeNull();
    expect(duble.opcoesDaConsulta!.retry(0, { data: { code: "UNAUTHORIZED" } })).toBe(false);
    expect(duble.opcoesDaConsulta!.refetchOnReconnect({ state: { error: { data: { code: "UNAUTHORIZED" } } } })).toBe(false);
    expect(duble.opcoesDoResumo!.retry(0, { data: { code: "UNAUTHORIZED" } })).toBe(false);
  });

  it("a senha certa relê a reunião pelo mesmo token", () => {
    const refetch = vi.fn();
    duble.ver.mockReturnValue(emErro("UNAUTHORIZED", refetch));
    abrir();
    fireEvent.change(screen.getByRole("textbox", { name: "Senha de 6 dígitos" }), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir a reunião" }));
    expect(duble.entrar.mutate).toHaveBeenCalledWith({ token: TOKEN, senha: "482913" }, expect.anything());
    expect(refetch).not.toHaveBeenCalled();
    const { onSuccess } = duble.entrar.mutate.mock.calls[0][1] as { onSuccess: (resultado: unknown) => void };
    act(() => onSuccess({ entrou: true }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a entrada vence com a página aberta: o resumo recusa com UNAUTHORIZED, e a página relê a reunião (que traz a tela da senha)", () => {
    const refetch = vi.fn();
    duble.ver.mockReturnValue({ ...pronta(), refetch });
    duble.resumoGuardado.mockReturnValue({ data: undefined, isError: true, error: { data: { code: "UNAUTHORIZED" } }, refetch: vi.fn() });
    abrir();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a entrada vence com a pergunta, o mapa ou o áudio na tela: cada um relê a reunião, que traz a tela da senha", () => {
    const refetch = vi.fn();
    duble.ver.mockReturnValue({ ...pronta(), refetch });
    const { container } = abrir();
    act(() => (duble.propsDaPergunta!.aoPedirSenha as () => void)());
    expect(refetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Mapa mental" }));
    act(() => (duble.propsDoMapa!.aoPedirSenha as () => void)());
    expect(refetch).toHaveBeenCalledTimes(2);
    // Sem a entrada, a rota do áudio responde 404: o áudio que não carrega relê também.
    fireEvent.error(container.querySelector("audio")!);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("a tradução da transcrição recusou com a entrada vencida: com a senha de novo, ela é pedida outra vez (e não só limpa)", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.ver.mockReturnValue({ ...pronta(), isError: true, error: { data: { code: "UNAUTHORIZED" } }, refetch: vi.fn() });
    duble.traduzir = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: true, error: { data: { code: "UNAUTHORIZED" } } } as typeof duble.traduzir;
    abrir();
    expect(duble.traduzir.mutate).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "6-digit password" }), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the meeting" }));
    const { onSuccess } = duble.entrar.mutate.mock.calls[0][1] as { onSuccess: (resultado: unknown) => void };
    act(() => onSuccess({ entrou: true }));
    expect(duble.traduzir.mutate).toHaveBeenCalledTimes(2);
    expect(duble.traduzir.mutate.mock.calls[1][0]).toEqual({ token: TOKEN, language: "en" });
  });

  it("a tradução do resumo recusa com a entrada vencida: a página relê a reunião; com a senha de novo, a tradução é pedida outra vez", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    const refetch = vi.fn();
    duble.ver.mockReturnValue({ ...pronta(), refetch });
    duble.resumoGuardado.mockReturnValue({ data: { estado: "pronto", emoji: null, idioma: "pt-BR", itens: [{ section: "decision", subject: null, text: "Renovar o contrato", assignee: null, due: null, excerpt: "vamos renovar", startSeconds: 9, status: "confirmed" }] }, isError: false, error: null, refetch: vi.fn() });
    abrir();
    expect(duble.traduzirResumo.mutate).toHaveBeenCalledTimes(1);
    const [, { onError }] = duble.traduzirResumo.mutate.mock.calls[0] as [unknown, { onError: (erro: unknown) => void }];
    // A releitura da reunião já vem com a tela da senha.
    duble.ver.mockReturnValue({ ...pronta(), isError: true, error: { data: { code: "UNAUTHORIZED" } }, refetch });
    act(() => onError({ data: { code: "UNAUTHORIZED" } }));
    expect(refetch).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "6-digit password" }), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the meeting" }));
    const { onSuccess } = duble.entrar.mutate.mock.calls[0][1] as { onSuccess: (resultado: unknown) => void };
    act(() => onSuccess({ entrou: true }));
    expect(duble.traduzirResumo.mutate).toHaveBeenCalledTimes(2);
  });

  it("a tela da senha em árabe: a página da direita para a esquerda, o campo da esquerda para a direita", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    duble.ver.mockReturnValue(emErro("UNAUTHORIZED"));
    abrir();
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("heading", { name: "اجتماع محمي بكلمة مرور" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "كلمة مرور من 6 أرقام" })).toHaveAttribute("dir", "ltr");
  });

  it("sem o áudio: a página diz que o áudio não veio no link, sem player e sem a barra do rodapé", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: false, gravacaoSaindo: false, audioIncluido: false }));
    const { container } = abrir();
    expect(screen.getByText("Quem compartilhou esta reunião não incluiu o áudio neste link.")).toBeInTheDocument();
    expect(screen.getByText(/Leia a transcrição ou peça à IA um resumo/)).toBeInTheDocument();
    expect(screen.queryByText(/Ouça a gravação/)).not.toBeInTheDocument();
    // E não os avisos da gravação que não existe ou venceu: o áudio existe, só não veio pelo link.
    expect(screen.queryByText(/Nenhum áudio guardado|passou dos 30 dias/)).not.toBeInTheDocument();
    expect(container.querySelector("audio")).toBeNull();
    // Sem áudio, nada leva o player a um ponto: o resumo e a pergunta não recebem o "ir para".
    expect(duble.propsDoResumo?.aoIrPara).toBeUndefined();
    expect(duble.propsDaPergunta?.aoIrPara).toBeUndefined();
  });

  it("a resposta de um servidor de antes da H23 (sem audioIncluido) segue como antes: com a gravação", () => {
    duble.ver.mockReturnValue(pronta());
    const { container } = abrir();
    expect(container.querySelector("audio")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/audio`);
    expect(screen.queryByText(/não incluiu o áudio/)).not.toBeInTheDocument();
  });
});

// A reunião que nasceu de um documento (H12 e H12b): o link mostra o texto lido
// e o resumo, como mostra a transcrição de uma reunião de áudio, sem player,
// sem a seção da gravação e sem o arquivo, que o servidor nem manda
// (server/link-aberto-da-reuniao.ts; o texto chega corrido, sem as páginas).
describe("Reunião aberta pelo link — o documento (H12)", () => {
  const DOCUMENTO = {
    titulo: "Proposta da feira",
    criadaEm: 1_700_000_000_000,
    documento: true,
    transcricao: { texto: "Proposta de exportação de café para Lisboa.\n\nContato: Ana Souza.", idioma: "pt-BR", segmentos: [] },
    gravacao: null,
    gravacaoExpirada: false,
    gravacaoSaindo: false,
  };

  it("o texto do documento no lugar da transcrição, com o resumo e as perguntas, e nada de áudio nem do arquivo", () => {
    duble.ver.mockReturnValue(pronta(DOCUMENTO));
    const { container } = abrir();
    expect(screen.getByText("Quem enviou este documento compartilhou o link com você. Leia o texto do documento ou peça à IA um resumo e respostas sobre ele.")).toBeInTheDocument();
    expect(screen.getByTestId("resumo")).toHaveTextContent(TOKEN);
    expect(screen.getByTestId("pergunte")).toHaveTextContent(TOKEN);
    // Sem a seção da gravação, que diria "nenhum áudio guardado", e sem player.
    expect(screen.queryByText("Gravação")).not.toBeInTheDocument();
    expect(screen.queryByText(/áudio/)).not.toBeInTheDocument();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Transcrição" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getByRole("heading", { level: 2, name: "Texto do documento" })).toBeInTheDocument();
    expect(screen.getByText(/Proposta de exportação de café para Lisboa\./)).toBeInTheDocument();
    expect(screen.getByText("Escolha o idioma em que você quer ler o texto do documento.")).toBeInTheDocument();
    // Nenhum caminho para o arquivo guardado.
    expect(container.innerHTML).not.toMatch(/manus-storage|\/documento|pdfjs|\.pdf/);
  });

  // Conferência de tela de 20/11/2026 (captura 15b): o link aberto do documento
  // repetia "Trecho da transcrição" e "Traduzir o que foi dito nesta reunião".
  it("o resumo, o Pergunte e o mapa recebem que é documento, e a tradução fala do texto do documento", () => {
    duble.ver.mockReturnValue(pronta(DOCUMENTO));
    abrir();
    expect(duble.propsDoResumo).toMatchObject({ token: TOKEN, documento: true });
    expect(duble.propsDaPergunta).toMatchObject({ token: TOKEN, documento: true });
    fireEvent.click(screen.getByRole("button", { name: "Texto do documento" }));
    expect(screen.getByText("Traduzir o texto do documento")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/foi dito|transcrição/);
    fireEvent.click(screen.getByRole("button", { name: "Mapa mental" }));
    expect(duble.propsDoMapa).toMatchObject({ token: TOKEN, documento: true });
  });

  it("a reunião de áudio pelo link segue com os textos da transcrição", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(duble.propsDoResumo).toMatchObject({ documento: false });
    expect(duble.propsDaPergunta).toMatchObject({ documento: false });
  });

  it("em árabe: a aba e a introdução no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    duble.ver.mockReturnValue(pronta(DOCUMENTO));
    abrir();
    expect(screen.getByRole("button", { name: "نص المستند" })).toBeInTheDocument();
    expect(screen.getByText(/شارك معك الشخص الذي أرسل هذا المستند الرابط/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Texto do documento|Quem enviou/);
  });

  it("a resposta de um servidor de antes da H12 (sem o campo) segue como reunião de áudio", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    expect(screen.getByRole("button", { name: "Transcrição" })).toBeInTheDocument();
    expect(screen.getByText("Gravação")).toBeInTheDocument();
  });
});

describe("Reunião aberta pelo link — o vídeo do YouTube (H13)", () => {
  // A reunião que veio de um vídeo não tem gravação: o servidor manda só o id
  // do vídeo (videoDoYoutube), e o "▶" abre o YouTube no segundo, numa aba nova.
  const ID_DO_VIDEO = "dQw4w9WgXcQ";
  const DO_VIDEO = `https://www.youtube.com/watch?v=${ID_DO_VIDEO}`;
  const noYoutube = (segundos: number) => `${DO_VIDEO}&t=${segundos}s`;
  const VISTA_DO_VIDEO = {
    titulo: "Painel de exportação",
    criadaEm: 1_700_000_000_000,
    transcricao: { texto: "Bem-vindas ao painel.\nObrigada pelo convite.", idioma: "pt-BR", segmentos: [
      { inicio: 7, fim: 12, falante: "F1", texto: "Bem-vindas ao painel." },
      { inicio: 725, fim: 751, falante: "F2", texto: "Obrigada pelo convite." },
    ] },
    gravacao: null,
    // Sem linha de áudio e criada há mais de 30 dias: o servidor diz "expirada", mas não houve gravação.
    gravacaoExpirada: true,
    gravacaoSaindo: false,
    vozes: {},
    videoDoYoutube: ID_DO_VIDEO,
  };

  it("sem player: o link para o vídeo no lugar da gravação, a apresentação do vídeo, e nenhum aviso de gravação apagada", () => {
    duble.ver.mockReturnValue(pronta(VISTA_DO_VIDEO));
    const { container } = abrir();
    expect(screen.getByText(/Quem criou esta página a partir de um vídeo do YouTube compartilhou o link com você/)).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.openLink.intro"))).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Abrir o vídeo no YouTube/ });
    expect(link).toHaveAttribute("href", DO_VIDEO);
    expect(link).toHaveAttribute("target", "_blank");
    // O aviso de privacidade é da conta da dona: pelo link, não aparece.
    expect(screen.queryByText(/A Marquesa Global Match não guarda o vídeo/)).not.toBeInTheDocument();
    expect(container.querySelector("audio, video, iframe")).toBeNull();
    expect(screen.queryByText(i18n.t("meetings.recordingExpiredNotice"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.noRecordingStored"))).not.toBeInTheDocument();
  });

  it("o resumo e a pergunta recebem o link do vídeo no segundo, e não o player", () => {
    duble.ver.mockReturnValue(pronta(VISTA_DO_VIDEO));
    abrir();
    const resumo = duble.propsDoResumo as { aoIrPara?: unknown; linkDoTempo?: (segundo: number) => string };
    expect(resumo.aoIrPara).toBeUndefined();
    expect(resumo.linkDoTempo?.(725)).toBe(noYoutube(725));
    const pergunta = duble.propsDaPergunta as { aoIrPara?: unknown; linkDoTempo?: (segundo: number) => string };
    expect(pergunta.aoIrPara).toBeUndefined();
    expect(pergunta.linkDoTempo?.(7)).toBe(noYoutube(7));
  });

  it("a transcrição: o ▶ de cada fala abre o vídeo no YouTube no segundo dela", () => {
    duble.ver.mockReturnValue(pronta(VISTA_DO_VIDEO));
    abrirNaTranscricao();
    const link = screen.getByRole("link", { name: "Ver no YouTube a partir de 12:05 (abre em nova aba)" });
    expect(link).toHaveAttribute("href", noYoutube(725));
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });

  it("a reunião gravada continua com a gravação: sem campo do vídeo (servidor de antes da H13) ou com ele nulo", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, videoDoYoutube: null }));
    const { container } = abrir();
    expect(container.querySelector("audio")).toHaveAttribute("src", `/reuniao-aberta/${TOKEN}/audio`);
    expect(screen.queryByRole("link", { name: /Abrir o vídeo no YouTube/ })).not.toBeInTheDocument();
    expect((duble.propsDoResumo as { linkDoTempo?: unknown }).linkDoTempo).toBeUndefined();
  });

  it("em árabe, a 375 px: a página vira da direita para a esquerda, os textos do vídeo em árabe, o ▶ com o mesmo endereço e só lados lógicos no bloco do vídeo", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    // Um vídeo falado em árabe: com a tela no idioma do original, a transcrição aparece por fala (sem tradução).
    duble.ver.mockReturnValue(pronta({ ...VISTA_DO_VIDEO, transcricao: { ...VISTA_DO_VIDEO.transcricao, idioma: "ar" } }));
    abrir();
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText(i18n.t("meetings.youtube.linkIntro"))).toBeInTheDocument();
    const bloco = screen.getByRole("link", { name: new RegExp(i18n.t("meetings.youtube.openOnYoutube")) }).closest("section")!;
    const ladosFisicos = [bloco, ...bloco.querySelectorAll("*")].flatMap(elemento => [...elemento.classList]
      .filter(classe => /^(?:[a-z0-9-]+:)*-?(?:left|right|ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-|$)/.test(classe)));
    expect(ladosFisicos).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.transcriptTab") }));
    expect(screen.getByRole("link", { name: "المشاهدة على YouTube من 12:05 (يُفتح في علامة تبويب جديدة)" })).toHaveAttribute("href", noYoutube(725));
  });
});

// A junção do Pacote 4c (documento e vídeo do YouTube) com o 4d (o link sem o
// áudio, H23): o documento e o vídeo não têm gravação, então a frase deles vale
// com ou sem o áudio no link, e o aviso do áudio que ficou de fora não aparece.
describe("Reunião aberta pelo link — o documento e o vídeo com o áudio fora do link (4c com a H23)", () => {
  it("documento: a frase do documento, sem a frase nem o aviso do link sem o áudio", () => {
    duble.ver.mockReturnValue(pronta({
      titulo: "Proposta da feira", criadaEm: 1_700_000_000_000, documento: true, audioIncluido: false,
      transcricao: { texto: "Proposta de exportação de café.", idioma: "pt-BR", segmentos: [] },
      gravacao: null, gravacaoExpirada: false, gravacaoSaindo: false,
    }));
    abrir();
    expect(screen.getByText(i18n.t("meetings.document.openLinkIntro"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.openLink.introWithoutAudio"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.openLink.audioNotIncluded"))).not.toBeInTheDocument();
  });

  it("vídeo do YouTube: a frase do vídeo e o link para ele, sem a frase nem o aviso do link sem o áudio", () => {
    duble.ver.mockReturnValue(pronta({
      titulo: "Painel de exportação", criadaEm: 1_700_000_000_000, audioIncluido: false, videoDoYoutube: "dQw4w9WgXcQ",
      transcricao: { texto: "Bem-vindas ao painel.", idioma: "pt-BR", segmentos: [] },
      gravacao: null, gravacaoExpirada: false, gravacaoSaindo: false, vozes: {},
    }));
    abrir();
    expect(screen.getByText(i18n.t("meetings.youtube.linkIntro"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir o vídeo no YouTube/ })).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.openLink.introWithoutAudio"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("meetings.openLink.audioNotIncluded"))).not.toBeInTheDocument();
  });
});

describe("as vozes juntadas pela dona (H3c)", () => {
  it("a voz juntada aparece como a principal: o nome dela no resumo e na transcrição", () => {
    duble.ver.mockReturnValue(pronta({
      ...VISTA,
      transcricao: { texto: "Oi. Tchau.", idioma: "pt-BR", segmentos: [
        { inicio: 0, fim: 4, falante: "F1", texto: "Oi." }, { inicio: 4, fim: 10, falante: "F3", texto: "Tchau." },
      ] },
      vozes: { F1: "Ana" }, juntadas: { F3: "F1", F4: "F2" },
    }));
    abrir();
    // O resumo recebe o mapa com a juntada: {F3} vira Ana, e {F4} vira "Falante 2" (a principal sem nome).
    expect((duble.propsDoResumo as { nomes?: Record<string, string> }).nomes).toEqual({ F1: "Ana", F3: "Ana", F4: "Falante 2" });
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.queryByText("Falante 3")).not.toBeInTheDocument();
    expect(screen.getAllByText("Ana").length).toBeGreaterThan(0);
  });
});
