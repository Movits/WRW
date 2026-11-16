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
 * verdade, para provar o elo da página com ele: as vozes como "Falante n" e o
 * "▶" que leva o player da barra ao ponto.
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
  ver: vi.fn(),
  opcoesDaConsulta: null as OpcoesDaConsulta | null,
  resumoGuardado: vi.fn(),
  opcoesDoResumo: null as OpcoesDoResumo | null,
  traduzir: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false },
  // As props que o "Pergunte à reunião" recebeu da página, na última vez.
  propsDaPergunta: null as Record<string, unknown> | null,
  // Ligado, a página monta o "Pergunte à reunião" de verdade, que lê a
  // resposta da pergunta pelo link daqui (o `data` da mutação).
  perguntaDeVerdade: false,
  respostaDaPergunta: undefined as unknown,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    reuniaoAberta: {
      ver: {
        useQuery: (entrada: unknown, opcoes: OpcoesDaConsulta) => {
          duble.opcoesDaConsulta = opcoes;
          return duble.ver(entrada);
        },
      },
      traduzir: { useMutation: () => duble.traduzir },
      resumoGuardado: {
        useQuery: (entrada: unknown, opcoes: OpcoesDoResumo) => {
          duble.opcoesDoResumo = opcoes;
          return duble.resumoGuardado(entrada);
        },
      },
      perguntar: { useMutation: () => ({ data: duble.respostaDaPergunta, mutate: vi.fn(), isPending: false, isError: false, error: null }) },
    },
    // O "Pergunte à reunião" de verdade pede as duas mutações a cada render.
    meetings: { perguntar: { useMutation: () => ({ data: undefined, mutate: vi.fn(), isPending: false, isError: false, error: null }) } },
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
// chama o aoIrPara da página com 610 s (10:10).
vi.mock("@/components/ResumoGuardado", () => ({
  ResumoGuardado: ({ token, consulta, aoIrPara }: { token: string; consulta: { data?: { estado: string } }; aoIrPara?: (segundo: number) => void }) => (
    <div data-testid="resumo">{token} {consulta.data?.estado}{aoIrPara && <button type="button" onClick={() => aoIrPara(610)}>▶ do resumo</button>}</div>
  ),
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
  duble.ver.mockReset();
  duble.opcoesDaConsulta = null;
  duble.opcoesDoResumo = null;
  duble.resumoGuardado.mockReturnValue({ data: { estado: "sem_resumo", emoji: null, itens: [] }, isError: false, error: null, refetch: vi.fn() });
  duble.traduzir = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false };
  duble.propsDaPergunta = null;
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
    expect(screen.getByText(/01:35/)).toBeInTheDocument();
    expect(screen.getByTestId("resumo")).toHaveTextContent(`${TOKEN} sem_resumo`);
    expect(screen.getByTestId("pergunte")).toHaveTextContent(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "Transcrição" }));
    expect(screen.getByText("Combinamos a entrega na sexta.")).toBeInTheDocument();
    // Nada do que é só da dona.
    expect(screen.queryByRole("button", { name: /Excluir/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Contatos/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Conhecer a WRW" })).toHaveAttribute("href", "/");
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
    expect(screen.getByText(/1:15:00/)).toBeInTheDocument();
    expect(screen.queryByText(/75:00/)).not.toBeInTheDocument();
  });

  it("a linha da gravação tem um separador só", () => {
    duble.ver.mockReturnValue(pronta());
    abrir();
    const linha = screen.getByText(/01:35/);
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

  it("com o 'Pergunte à reunião' de verdade: as vozes da resposta são 'Falante n', e o '▶' da citação leva o player da barra à parte certa (H6)", () => {
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
      gravacao: { ...VISTA.gravacao, partes: [
        { seq: 0, url: `/reuniao-aberta/${TOKEN}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
        { seq: 1, url: `/reuniao-aberta/${TOKEN}/audio?parte=1`, mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 60 },
      ] },
    }));
    abrir();
    expect(screen.getByText("Falante 1 propôs a entrega na sexta, e Falante 2 concordou.")).toBeInTheDocument();
    expect(screen.queryByText(/\{F\d\}/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 10:15" }));
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(`/reuniao-aberta/${TOKEN}/audio?parte=1`);
  });

  it("sem gravação, a pergunta não ganha o '▶'; e o link nunca passa os nomes das vozes à pergunta", () => {
    duble.ver.mockReturnValue(pronta({ ...VISTA, gravacao: null, gravacaoExpirada: true }));
    abrir();
    expect(screen.getByTestId("pergunte")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "▶ da pergunta" })).not.toBeInTheDocument();
    expect(duble.propsDaPergunta).not.toHaveProperty("nomes");
    expect(duble.propsDaPergunta).not.toHaveProperty("meetingId");
  });
});
