import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { MENSAGEM_SENHA_DO_LINK_PEDIDA } from "@shared/senha-do-link";
import { MapaMentalDaReuniao } from "./MapaMental";

/**
 * O mapa mental na tela (H10): a árvore (raiz no título, ramos que abrem e
 * fecham, folhas e filhos), a direção pelo idioma do mapa, o padrão aberto no
 * computador e recolhido no celular, e os estados da consulta, para a dona e
 * pelo link. O tRPC é dublê: a consulta devolve o que o teste combina, e o
 * pedido registra o mutate e as opções. O que o servidor faz está em
 * server/mapa-mental*.test.ts.
 */

type Opcoes = { onSettled?: () => unknown };
type OpcoesDaConsulta = {
  retry: (tentativas: number, erro: unknown) => boolean;
  refetchInterval: (consulta: { state: { data?: { estado: string; edicao?: { refazendo?: boolean } }; error: unknown } }) => number | false;
  refetchOnWindowFocus?: boolean;
};
const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { mutate: ReturnType<typeof vi.fn>; opcoes: Opcoes; isPending: boolean; isError: boolean; error: unknown }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { mutate: vi.fn(), opcoes, isPending: false, isError: false, error: null });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: m.isPending, isError: m.isError, error: m.error, reset: vi.fn() };
    },
  });
  return {
    mutacoes,
    registrar,
    daDona: vi.fn(),
    doLink: vi.fn(),
    conexoes: vi.fn(() => ({ data: undefined })),
    opcoes: {} as { dona?: OpcoesDaConsulta; link?: OpcoesDaConsulta },
    utils: {
      meetings: { mapaMental: { invalidate: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
      reuniaoAberta: { mapaMental: { invalidate: vi.fn() }, resumoGuardado: { invalidate: vi.fn() } },
    },
  };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    meetings: {
      mapaMental: { useQuery: (entrada: unknown, opcoes: OpcoesDaConsulta) => { duble.opcoes.dona = opcoes; return duble.daDona(entrada); } },
      pedirMapa: duble.registrar("pedirMapa"),
      // H10b: editar, voltar ao da IA e refazer em outro estilo.
      editarMapa: duble.registrar("editarMapa"),
      refazerMapa: duble.registrar("refazerMapa"),
      // N5: as pessoas e as conexões da reunião, para o ramo "Conexões desta reunião".
      conexoes: { useQuery: (...args: unknown[]) => duble.conexoes(...args) },
    },
    reuniaoAberta: {
      mapaMental: { useQuery: (entrada: unknown, opcoes: OpcoesDaConsulta) => { duble.opcoes.link = opcoes; return duble.doLink(entrada); } },
      pedirMapa: duble.registrar("pedirMapaPeloLink"),
    },
  },
}));

const REUNIAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const TITULO = "Reunião com a vinícola";
const MAPA = {
  ramos: [
    { rotulo: "Exportação de café", folhas: [{ rotulo: "Contêiner sai de Santos", filhos: ["12 de março"] }, { rotulo: "Seguro da carga", filhos: [] }] },
    { rotulo: "Transportadora", folhas: [{ rotulo: "Contrato não será renovado", filhos: [] }] },
    { rotulo: "Feiras de 2027", folhas: [] },
  ],
};

const consulta = (data: unknown) => ({ data, isError: false, error: null as unknown, refetch: vi.fn() });
const pronto = (idioma: string | null = "pt-BR") => consulta({ estado: "pronto", idioma, erro: null, mapa: MAPA });
const comEstado = (estado: string, erro: string | null = null) => consulta({ estado, idioma: "pt-BR", erro, mapa: null });
const comErro = (c: ReturnType<typeof consulta>, error: unknown) => ({ ...c, isError: true, error });
const daDona = (c: ReturnType<typeof consulta>) => {
  duble.daDona.mockReturnValue(c);
  return render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} emoji="☕"/>);
};
const doLink = (c: ReturnType<typeof consulta>) => {
  duble.doLink.mockReturnValue(c);
  return render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO}/>);
};
const arvore = () => screen.getByTestId("arvore-do-mapa");
const ramo = (nome: string) => within(arvore()).getByRole("button", { name: nome });
const folhasDe = (botao: HTMLElement) => document.getElementById(botao.getAttribute("aria-controls")!)!;
const mutacao = (nome: string) => duble.mutacoes[nome];
const preparar = (nome: string, estado: Partial<{ isPending: boolean; isError: boolean; error: unknown }>) => {
  duble.mutacoes[nome] ??= { mutate: vi.fn(), opcoes: {}, isPending: false, isError: false, error: null };
  Object.assign(duble.mutacoes[nome], estado);
};

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) { m.mutate.mockReset(); Object.assign(m, { isPending: false, isError: false, error: null }); }
  duble.daDona.mockReset();
  duble.doLink.mockReset();
  duble.conexoes.mockReset();
  duble.conexoes.mockReturnValue({ data: undefined });
  for (const area of [duble.utils.meetings, duble.utils.reuniaoAberta]) {
    area.mapaMental.invalidate.mockReset();
    area.resumoGuardado.invalidate.mockReset();
  }
  duble.opcoes = {};
});
afterEach(async () => {
  Reflect.deleteProperty(window, "matchMedia");
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("Mapa mental — a árvore", () => {
  it("a raiz é o título com o emoji do resumo; ramos, folhas e filhos à vista; o aviso de que a IA montou", () => {
    daDona(pronto());
    expect(duble.daDona).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(screen.getByRole("heading", { level: 2, name: "Mapa mental da reunião" })).toBeInTheDocument();
    expect(screen.getByText("Montado pela IA a partir da transcrição. Confira na transcrição antes de usar.")).toBeInTheDocument();
    expect(within(arvore()).getByText(TITULO)).toBeInTheDocument();
    expect(within(arvore()).getByText("☕")).toHaveAttribute("aria-hidden", "true");
    expect(ramo("Exportação de café")).toHaveAttribute("aria-expanded", "true");
    expect(within(arvore()).getByText("Contêiner sai de Santos")).toBeVisible();
    expect(within(arvore()).getByText("12 de março")).toBeVisible();
    expect(within(arvore()).getByText("Contrato não será renovado")).toBeVisible();
  });

  // Conferência de tela de 20/11/2026 (captura 06a): no mapa do documento (H12),
  // o aviso mandava conferir "na transcrição", que o documento não tem.
  it.each([
    ["da dona", () => { duble.daDona.mockReturnValue(pronto()); return render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} documento/>); }],
    ["pelo link", () => { duble.doLink.mockReturnValue(pronto()); return render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO} documento/>); }],
  ])("o mapa de um documento (%s): o aviso fala do texto do documento, nunca da transcrição", (_caso, montar) => {
    montar();
    expect(screen.getByText("Montado pela IA a partir do texto do documento. Confira no texto antes de usar.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/transcrição/);
  });

  it("o ramo abre e fecha ao toque; recolhido, mostra quantas folhas guarda, sem mudar o nome do botão", () => {
    daDona(pronto());
    const exportacao = ramo("Exportação de café");
    fireEvent.click(exportacao);
    expect(exportacao).toHaveAttribute("aria-expanded", "false");
    expect(folhasDe(exportacao)).not.toBeVisible();
    expect(within(exportacao).getByText("+2")).toHaveAttribute("aria-hidden", "true");
    // Os outros ramos não mudam.
    expect(ramo("Transportadora")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(exportacao);
    expect(exportacao).toHaveAttribute("aria-expanded", "true");
    expect(folhasDe(exportacao)).toBeVisible();
  });

  it("Recolher todos e Abrir todos valem para todos os ramos", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Recolher todos os ramos" }));
    expect(ramo("Exportação de café")).toHaveAttribute("aria-expanded", "false");
    expect(ramo("Transportadora")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Contrato não será renovado")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Abrir todos os ramos" }));
    expect(ramo("Exportação de café")).toHaveAttribute("aria-expanded", "true");
    expect(ramo("Transportadora")).toHaveAttribute("aria-expanded", "true");
  });

  it("no celular, os ramos começam recolhidos: o contorno abre como a lista dos assuntos", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
    daDona(pronto());
    expect(matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
    expect(ramo("Exportação de café")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Contêiner sai de Santos")).not.toBeVisible();
    fireEvent.click(ramo("Exportação de café"));
    expect(screen.getByText("Contêiner sai de Santos")).toBeVisible();
  });

  it("o ramo sem folhas é só texto, sem botão de abrir", () => {
    daDona(pronto());
    expect(within(arvore()).getByText("Feiras de 2027")).toBeInTheDocument();
    expect(within(arvore()).queryByRole("button", { name: "Feiras de 2027" })).not.toBeInTheDocument();
    expect(within(arvore()).getAllByRole("button")).toHaveLength(2);
  });

  it.each([["ar", "rtl"], ["pt-BR", "ltr"], ["pt", "ltr"], ["de", "ltr"]])("o mapa em '%s' cresce em %s, com o lang do mapa", (idioma, direcao) => {
    daDona(pronto(idioma));
    expect(arvore()).toHaveAttribute("dir", direcao);
    expect(arvore()).toHaveAttribute("lang", idioma === "pt" ? "pt-BR" : idioma);
  });

  it("a direção é a do mapa, não a da tela: em árabe, o mapa em português segue da esquerda para a direita; sem idioma, vale a da página", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const { unmount } = daDona(pronto("pt-BR"));
    expect(arvore()).toHaveAttribute("dir", "ltr");
    unmount();
    daDona(pronto(null));
    expect(arvore()).not.toHaveAttribute("dir");
  });

  it("pelo link: a mesma árvore, pedida pelo token, sem emoji quando o resumo não tem", () => {
    doLink(pronto());
    expect(duble.doLink).toHaveBeenCalledWith({ token: TOKEN });
    expect(duble.daDona).not.toHaveBeenCalled();
    expect(within(arvore()).getByText(TITULO)).toBeInTheDocument();
    expect(ramo("Transportadora")).toHaveAttribute("aria-expanded", "true");
    expect(duble.opcoes.link?.refetchOnWindowFocus).toBe(false);
  });
});

describe("Mapa mental — os estados", () => {
  it("carregando: o aviso, sem botão de pedir", () => {
    daDona(consulta(undefined));
    expect(screen.getByRole("status")).toHaveTextContent("Carregando o mapa mental…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("sem mapa: a dona gera pelo id; quem tem o link pede pelo token", () => {
    const { unmount } = daDona(comEstado("sem_mapa"));
    expect(screen.getByText("Esta reunião ainda não tem mapa mental.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gerar mapa mental/ }));
    expect(mutacao("pedirMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    unmount();
    doLink(comEstado("sem_mapa"));
    fireEvent.click(screen.getByRole("button", { name: /Pedir mapa mental/ }));
    expect(mutacao("pedirMapaPeloLink").mutate).toHaveBeenCalledWith({ token: TOKEN });
  });

  it.each(["pendente", "gerando"])("%s: o aviso de que a IA está montando o mapa, sem botão", estado => {
    daDona(comEstado(estado));
    expect(screen.getByRole("status")).toHaveTextContent("A IA está montando o mapa mental desta reunião.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("falhou: a frase e o Tentar de novo, que pede de novo; o mapa que a conferência recusou tem frase própria", () => {
    const { unmount } = daDona(comEstado("falhou", "IA_INDISPONIVEL"));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível gerar o mapa mental desta reunião.");
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    unmount();
    daDona(comEstado("falhou", "MAPA_INVALIDO"));
    expect(screen.getByRole("alert")).toHaveTextContent("A IA não encontrou assuntos suficientes nesta reunião para montar um mapa mental.");
  });

  it("no refazer do resumo que falhou (H4d), sem mapa pronto: a dona lê que o refazer falhou e tenta de novo; pelo link, o aviso de que a dona pediu uma nova versão, sem botão que não faria nada", () => {
    const doRefazer = consulta({ estado: "falhou", idioma: "pt-BR", erro: "RESPOSTA_CORTADA", mapa: null, versaoAnterior: true });
    const { unmount } = daDona(doRefazer);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível refazer o resumo, e o mapa mental vem com ele. Tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    unmount();

    preparar("pedirMapaPeloLink", { isError: true, error: { data: { code: "TOO_MANY_REQUESTS" } } });
    doLink(doRefazer);
    expect(screen.getByRole("status")).toHaveTextContent("A dona da reunião pediu uma nova versão do resumo, que ainda não está pronta. O mapa mental aparece aqui quando ela ficar pronta.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mutacao("pedirMapaPeloLink").mutate).not.toHaveBeenCalled();
  });

  it("pedindo: o botão fica travado; o pedido relê o mapa e o resumo (pedir o mapa pode criar ou reabrir o resumo) e só termina com as duas releituras", async () => {
    preparar("pedirMapa", { isPending: true });
    daDona(comEstado("sem_mapa"));
    expect(screen.getByRole("button", { name: /Gerar mapa mental/ })).toBeDisabled();
    let soltarResumo = () => {};
    duble.utils.meetings.resumoGuardado.invalidate.mockReturnValue(new Promise<void>(ok => { soltarResumo = ok; }));
    let terminou = false;
    void Promise.resolve(mutacao("pedirMapa").opcoes.onSettled?.()).then(() => { terminou = true; });
    expect(duble.utils.meetings.mapaMental.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(duble.utils.meetings.resumoGuardado.invalidate).toHaveBeenCalledWith({ meetingId: REUNIAO });
    expect(duble.utils.reuniaoAberta.resumoGuardado.invalidate).not.toHaveBeenCalled();
    // Com a releitura do resumo ainda no caminho, o pedido não terminou: o botão segue travado.
    await new Promise(ok => setTimeout(ok, 0));
    expect(terminou).toBe(false);
    soltarResumo();
    await vi.waitFor(() => expect(terminou).toBe(true));
  });

  it("pelo link, o pedido relê o mapa e o resumo do link, pelo token", () => {
    doLink(comEstado("sem_mapa"));
    void mutacao("pedirMapaPeloLink").opcoes.onSettled?.();
    expect(duble.utils.reuniaoAberta.mapaMental.invalidate).toHaveBeenCalledWith({ token: TOKEN });
    expect(duble.utils.reuniaoAberta.resumoGuardado.invalidate).toHaveBeenCalledWith({ token: TOKEN });
    expect(duble.utils.meetings.resumoGuardado.invalidate).not.toHaveBeenCalled();
  });

  it("o pedido recusado mostra a frase pelo código, no idioma da tela", () => {
    preparar("pedirMapa", { isError: true, error: { message: "Muitos pedidos à IA em sequência.", data: { code: "TOO_MANY_REQUESTS" } } });
    const { unmount } = daDona(comEstado("sem_mapa"));
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
    unmount();
    preparar("pedirMapaPeloLink", { isError: true, error: { message: "Link não encontrado.", data: { code: "NOT_FOUND" } } });
    doLink(comEstado("sem_mapa"));
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
  });

  it("erro de consulta é erro, nunca 'sem mapa' nem 'gerando': mostra o erro, e o tentar de novo relê", () => {
    const falha = comErro(consulta(undefined), { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } });
    daDona(falha);
    expect(screen.getByRole("alert")).toHaveTextContent("Algo inesperado aconteceu");
    expect(screen.queryByText("Esta reunião ainda não tem mapa mental.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
    expect(falha.refetch).toHaveBeenCalled();
  });

  it("a releitura que falha com o mapa pronto: o erro vai acima, e a árvore continua", () => {
    daDona(comErro(pronto(), { message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Algo inesperado aconteceu");
    expect(ramo("Exportação de café")).toBeInTheDocument();
  });

  it("reunião que não existe mais, ou link desligado no meio da visita: a frase definitiva, sem tentar de novo", () => {
    const { unmount } = daDona(comErro(consulta(undefined), { message: "Reunião não encontrada.", data: { code: "NOT_FOUND" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reunião não encontrada.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    doLink(comErro(consulta(undefined), { message: "Link não encontrado.", data: { code: "NOT_FOUND" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Este link não existe ou não está mais disponível.");
  });

  it("pelo link, a leitura recusada pela senha (H23): a página é avisada, a frase sai traduzida, sem tentar de novo, e a consulta não repete", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    const aoPedirSenha = vi.fn();
    duble.doLink.mockReturnValue(comErro(consulta(undefined), { message: MENSAGEM_SENHA_DO_LINK_PEDIDA, data: { code: "UNAUTHORIZED" } }));
    render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO} aoPedirSenha={aoPedirSenha}/>);
    expect(aoPedirSenha).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("This link asks for the 6-digit password.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(duble.opcoes.link!.retry(0, { data: { code: "UNAUTHORIZED" } })).toBe(false);
  });

  it("pelo link, o pedido do mapa recusado pela senha também avisa a página", () => {
    const aoPedirSenha = vi.fn();
    preparar("pedirMapaPeloLink", { isError: true, error: { message: MENSAGEM_SENHA_DO_LINK_PEDIDA, data: { code: "UNAUTHORIZED" } } });
    duble.doLink.mockReturnValue(comEstado("sem_mapa"));
    render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO} aoPedirSenha={aoPedirSenha}/>);
    expect(aoPedirSenha).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(MENSAGEM_SENHA_DO_LINK_PEDIDA);
  });

  it("a consulta repete a cada 5 s só com o mapa na fila e sem erro; não tenta de novo o erro definitivo", () => {
    daDona(comEstado("pendente"));
    const { refetchInterval, retry } = duble.opcoes.dona!;
    const com = (estado: string | undefined, error: unknown = null) => refetchInterval({ state: { data: estado ? { estado } : undefined, error } });
    expect(com("pendente")).toBe(5_000);
    expect(com("gerando")).toBe(5_000);
    for (const estado of ["pronto", "falhou", "sem_mapa", undefined]) expect(com(estado)).toBe(false);
    expect(com("pendente", { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    // H10b: o refazer chega como "pronto" com o mapa de antes; sem repetir, o aviso ficava preso.
    const refazendo = (refazendo: boolean, error: unknown = null) => refetchInterval({ state: { data: { estado: "pronto", edicao: { refazendo } }, error } });
    expect(refazendo(true)).toBe(5_000);
    expect(refazendo(false)).toBe(false);
    expect(refazendo(true, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(retry(0, { data: { code: "NOT_FOUND" } })).toBe(false);
    expect(retry(0, { data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(retry(2, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(retry(3, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });
});

/**
 * A tradução do mapa (H11): ela é a do resumo, que mora na página
 * (useTraducaoDoResumo, testado à parte). Aqui se prova o que o mapa faz: avisa
 * a página dos rótulos do mapa pronto e mostra os rótulos traduzidos, com o
 * idioma e a direção da tradução, só com ela pronta.
 */
describe("Mapa mental — a tradução do resumo (H11)", () => {
  const EM_ARABE: Record<string, string> = { "Exportação de café": "تصدير القهوة", "Transportadora": "شركة النقل" };
  const traducao = (estado: "pronta" | "traduzindo" | "erro" | "original", erro: unknown = null) => ({
    estado, idioma: "ar" as const, idiomaOriginal: "pt-BR" as const, erro, tentarDeNovo: vi.fn(),
    traduzirRotulo: (rotulo: string) => EM_ARABE[rotulo] ?? rotulo,
  });

  it("o mapa pronto avisa a página dos rótulos dele, uma vez cada, na ordem da árvore; sem mapa pronto, nada", () => {
    const aoMudarRotulos = vi.fn();
    duble.daDona.mockReturnValue(comEstado("pendente"));
    const { rerender } = render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} aoMudarRotulos={aoMudarRotulos}/>);
    expect(aoMudarRotulos).not.toHaveBeenCalled();
    duble.daDona.mockReturnValue(pronto());
    rerender(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} aoMudarRotulos={aoMudarRotulos}/>);
    expect(aoMudarRotulos).toHaveBeenCalledTimes(1);
    expect(aoMudarRotulos).toHaveBeenLastCalledWith([
      "Exportação de café", "Contêiner sai de Santos", "12 de março", "Seguro da carga",
      "Transportadora", "Contrato não será renovado", "Feiras de 2027",
    ]);
  });

  it("com a tradução pronta, os rótulos saem traduzidos, com o idioma e a direção dela; a raiz (o título) e o rótulo sem tradução ficam", () => {
    duble.daDona.mockReturnValue(pronto("pt-BR"));
    render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} traducao={traducao("pronta")}/>);
    expect(arvore()).toHaveAttribute("dir", "rtl");
    expect(arvore()).toHaveAttribute("lang", "ar");
    expect(ramo("تصدير القهوة")).toBeInTheDocument();
    expect(within(arvore()).getByText("شركة النقل")).toBeInTheDocument();
    expect(within(arvore()).getByText("Seguro da carga")).toBeInTheDocument();
    expect(within(arvore()).getByText(TITULO)).toBeInTheDocument();
  });

  it("pelo link, a mesma tradução", () => {
    duble.doLink.mockReturnValue(pronto("pt-BR"));
    render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO} traducao={traducao("pronta")}/>);
    expect(ramo("تصدير القهوة")).toBeInTheDocument();
  });

  it("com a tradução pronta, a aba diz que os rótulos são tradução da IA, e de que idioma, como a aba Resumo", () => {
    duble.daDona.mockReturnValue(pronto("pt-BR"));
    render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} traducao={traducao("pronta")}/>);
    expect(screen.getByText("Rótulos traduzidos automaticamente pela IA. Original: Português.")).toBeInTheDocument();
  });

  it("traduzindo: o aviso é anunciado, e a árvore fica no original até a tradução chegar", () => {
    duble.daDona.mockReturnValue(pronto("pt-BR"));
    render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} traducao={traducao("traduzindo")}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Traduzindo o mapa mental…");
    expect(ramo("Exportação de café")).toBeInTheDocument();
    expect(screen.queryByText(/traduzidos automaticamente/)).not.toBeInTheDocument();
  });

  it("erro: a frase sai pelo código, a árvore fica no original, e 'Tentar de novo' pede a tradução outra vez", () => {
    duble.daDona.mockReturnValue(pronto("pt-BR"));
    const t = traducao("erro", { message: "A tradução do resumo não respondeu agora.", data: { code: "SERVICE_UNAVAILABLE" } });
    const { unmount } = render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} traducao={t}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível traduzir o mapa mental agora. Ele aparece no idioma original.");
    expect(ramo("Exportação de café")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Tentar de novo" }));
    expect(t.tentarDeNovo).toHaveBeenCalledTimes(1);
    unmount();
    duble.doLink.mockReturnValue(pronto("pt-BR"));
    render(<MapaMentalDaReuniao token={TOKEN} titulo={TITULO} traducao={traducao("erro", { data: { code: "TOO_MANY_REQUESTS" } })}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
  });

  it("com a tradução que não está pronta (traduzindo, erro ou o original), o mapa fica no idioma e na direção dele", () => {
    for (const estado of ["traduzindo", "erro", "original"] as const) {
      duble.daDona.mockReturnValue(pronto("pt-BR"));
      const { unmount } = render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} traducao={traducao(estado)}/>);
      expect(arvore()).toHaveAttribute("dir", "ltr");
      expect(arvore()).toHaveAttribute("lang", "pt-BR");
      expect(ramo("Exportação de café")).toBeInTheDocument();
      unmount();
    }
  });
});

// N5: o ramo "Conexões desta reunião", montado na tela com o que a extração
// tirou das pessoas — só no mapa da dona, sem IA e sem tradução.
describe("Mapa mental — as conexões desta reunião (N5)", () => {
  const CONEXOES = {
    totalDeConexoes: 1,
    pessoas: [
      { id: "s1", nome: "Carla Dias", status: "created", citada: false, tenho: [{ valor: "Exportar café", confirmado: true }], preciso: [{ valor: "Contador", confirmado: false }], conexoes: [{ id: "c1", com: "Bruno Prado" }] },
      { id: "s2", nome: "Sônia Pacheco", status: "ignored", citada: true, tenho: [{ valor: "Embalagem", confirmado: false }], preciso: [], conexoes: [] },
      { id: "s3", nome: "Diego Reis", status: "pending", citada: false, tenho: [], preciso: [], conexoes: [] },
    ],
  };

  it("a dona vê o ramo depois dos ramos da IA: cada pessoa com o que tem, precisa e as conexões que nasceram dela", () => {
    duble.conexoes.mockReturnValue({ data: CONEXOES });
    daDona(pronto());
    expect(duble.conexoes).toHaveBeenCalledWith({ meetingId: REUNIAO }, expect.anything());
    const doRamo = ramo("Conexões desta reunião");
    expect(doRamo.closest("li")).toHaveAttribute("data-ramo-extra", "true");
    const folhas = folhasDe(doRamo);
    expect(within(folhas).getByText("Carla Dias")).toBeVisible();
    expect(within(folhas).getByText("Tem: Exportar café")).toBeVisible();
    expect(within(folhas).getByText("Precisa (a confirmar): Contador")).toBeVisible();
    expect(within(folhas).getByText("Conexão com Bruno Prado")).toBeVisible();
    // A ignorada e a pessoa sem nada a mostrar não viram folha.
    expect(within(folhas).queryByText("Sônia Pacheco")).not.toBeInTheDocument();
    expect(within(folhas).queryByText("Diego Reis")).not.toBeInTheDocument();
    expect(screen.getByText(/não aparece no link aberto/)).toBeInTheDocument();
  });

  it("o ramo não vai à tradução: os rótulos que a página traduz são só os da IA, e o ramo fica como está com a tradução pronta", () => {
    duble.conexoes.mockReturnValue({ data: CONEXOES });
    duble.daDona.mockReturnValue(pronto("pt-BR"));
    const aoMudarRotulos = vi.fn();
    render(<MapaMentalDaReuniao meetingId={REUNIAO} titulo={TITULO} aoMudarRotulos={aoMudarRotulos}
      traducao={{ estado: "pronta", idioma: "ar", idiomaOriginal: "pt-BR", erro: null, tentarDeNovo: vi.fn(), traduzirRotulo: rotulo => `«${rotulo}»` }}/>);
    expect(aoMudarRotulos.mock.calls.flat(2)).not.toContain("Carla Dias");
    expect(aoMudarRotulos.mock.calls.flat(2)).not.toContain("Tem: Exportar café");
    expect(ramo("Conexões desta reunião")).toBeInTheDocument();
    expect(within(arvore()).getByText("Carla Dias")).toBeInTheDocument();
  });

  // Revisão da N5: erro de consulta é erro, nunca "reunião sem conexões".
  it("a consulta das conexões que falha mostra o erro com tentar de novo, no lugar do ramo, e o resto do mapa fica", () => {
    const refetch = vi.fn();
    duble.conexoes.mockReturnValue({ data: undefined, isError: true, error: new Error(MENSAGEM_BANCO_INDISPONIVEL), refetch });
    daDona(pronto());
    expect(within(arvore()).queryByText("Conexões desta reunião")).not.toBeInTheDocument();
    expect(ramo("Exportação de café")).toBeInTheDocument();
    const alerta = screen.getByRole("alert");
    expect(within(alerta).getByText("O servidor não respondeu. Tente de novo em instantes.")).toBeInTheDocument();
    fireEvent.click(within(alerta).getByRole("button", { name: "↻ Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("sem pessoa com o que mostrar, não há ramo; pelo link, nem a consulta acontece", () => {
    duble.conexoes.mockReturnValue({ data: { totalDeConexoes: 0, pessoas: [CONEXOES.pessoas[2]] } });
    const { unmount } = daDona(pronto());
    expect(within(arvore()).queryByText("Conexões desta reunião")).not.toBeInTheDocument();
    unmount();
    duble.conexoes.mockClear();
    doLink(pronto());
    expect(duble.conexoes).not.toHaveBeenCalled();
    expect(within(arvore()).queryByText("Conexões desta reunião")).not.toBeInTheDocument();
  });
});

describe("Mapa mental — editar, estilos, zoom, tela cheia e baixar (H10b)", () => {
  const comEdicao = (edicao: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    consulta({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA, edicao: { revisao: 4, editado: false, editadoEm: null, refazendo: false, erroDoRefazer: null, ...edicao }, ...extra });
  const barra = () => screen.getByRole("toolbar", { name: "Ferramentas do mapa mental" });

  it("a dona tem zoom, tela cheia, baixar, editar e refazer; o link, só zoom e tela cheia", () => {
    const { unmount } = daDona(pronto());
    for (const nome of ["Diminuir o mapa", "Voltar ao tamanho normal", "Aumentar o mapa", "Tela cheia", "PDF", "JPEG", "Markdown", "Editar", "Refazer em outro estilo"]) {
      expect(within(barra()).getByRole("button", { name: nome })).toBeInTheDocument();
    }
    unmount();
    doLink(pronto());
    expect(within(barra()).getByRole("button", { name: "Tela cheia" })).toBeInTheDocument();
    for (const nome of ["PDF", "Markdown", "Editar", "Refazer em outro estilo"]) expect(within(barra()).queryByRole("button", { name: nome })).toBeNull();
  });

  it("o zoom muda o tamanho de verdade, com teto e piso, e volta ao normal", () => {
    daDona(pronto());
    const zoom = () => screen.getByTestId("zoom-do-mapa");
    expect(zoom().style.zoom).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Aumentar o mapa" }));
    expect(zoom().style.zoom).toBe("1.25");
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Aumentar o mapa" }));
    expect(zoom().style.zoom).toBe("2");
    expect(screen.getByRole("button", { name: "Aumentar o mapa" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao tamanho normal" }));
    expect(zoom().style.zoom).toBe("1");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Diminuir o mapa" }));
    expect(zoom().style.zoom).toBe("0.5");
    expect(screen.getByRole("button", { name: "Diminuir o mapa" })).toBeDisabled();
  });

  it("a tela cheia abre por cima da página com a barra e a árvore, e o Esc fecha", () => {
    doLink(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
    const camada = screen.getByRole("dialog", { name: "Mapa mental da reunião" });
    expect(within(camada).getByTestId("arvore-do-mapa")).toBeInTheDocument();
    expect(within(camada).getByRole("button", { name: "Sair da tela cheia" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("editar: renomear, descer, acrescentar e apagar na cópia; salvar manda o mapa e a revisão que a tela viu", () => {
    daDona(comEdicao({}));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const editor = screen.getByTestId("editor-do-mapa");
    fireEvent.change(within(editor).getByRole("textbox", { name: "Ramo 1" }), { target: { value: "Café para exportar" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Descer “Café para exportar”" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Apagar “Feiras de 2027” e o que sai dele" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Ramo" }));
    fireEvent.change(within(editor).getByRole("textbox", { name: "Ramo 3" }), { target: { value: "Próximos passos" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar o mapa" }));
    expect(mutacao("editarMapa").mutate).toHaveBeenCalledWith({
      meetingId: REUNIAO, revisao: 4,
      operacao: { tipo: "salvar", mapa: { ramos: [MAPA.ramos[1], { ...MAPA.ramos[0], rotulo: "Café para exportar" }, { rotulo: "Próximos passos", folhas: [] }] } },
    }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("editar: arrastar uma folha para outro ramo a leva para o fim dele", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const alca = document.querySelector('[data-caminho="0.1"] [draggable="true"]')!;
    const dados = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(alca, { dataTransfer: dados });
    fireEvent.dragOver(document.querySelector('[data-caminho="2"]')!, { dataTransfer: dados });
    fireEvent.drop(document.querySelector('[data-caminho="2"]')!, { dataTransfer: dados });
    expect(screen.getByRole("textbox", { name: "Ponto 1 de “Feiras de 2027”" })).toHaveValue("Seguro da carga");
    expect(screen.queryByRole("textbox", { name: "Ponto 2 de “Exportação de café”" })).toBeNull();
  });

  it("editar: o mapa fora das regras não sai da tela; a frase diz o que mudar; Cancelar descarta", () => {
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Ramo 2" }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar o mapa" }));
    expect(mutacao("editarMapa").mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Há um item vazio, com mais de 60 caracteres ou com a marca de uma voz ({F1}).");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("editor-do-mapa")).toBeNull();
    expect(ramo("Transportadora")).toBeInTheDocument();
  });

  it("editar: a recusa do servidor (outra aba mudou o mapa) sai traduzida no editor", () => {
    preparar("editarMapa", { isError: true, error: { message: "MAPA_MUDOU", data: { code: "CONFLICT" } } });
    daDona(pronto());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("O mapa mudou em outra aba ou foi refeito pela IA.");
  });

  it("o mapa editado diz quando; Voltar ao mapa da IA pede confirmação e manda o pedido", () => {
    daDona(comEdicao({ editado: true, editadoEm: Date.UTC(2026, 10, 20, 15, 0) }));
    expect(screen.getByText(/^Editado por você em /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao mapa da IA" }));
    const confirmar = screen.getByRole("alertdialog");
    expect(confirmar).toHaveTextContent("As suas edições saem do mapa.");
    fireEvent.click(within(confirmar).getByRole("button", { name: "Voltar ao mapa da IA" }));
    expect(mutacao("editarMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, revisao: 4, operacao: { tipo: "voltar" } }, expect.anything());
  });

  it("refazer em outro estilo: os 4 estilos com a ajuda, o aviso da IA e o das edições; confirma com o estilo e a revisão", () => {
    daDona(comEdicao({ editado: true }));
    fireEvent.click(screen.getByRole("button", { name: "Refazer em outro estilo" }));
    const painel = screen.getByRole("group", { name: "Refazer o mapa em outro estilo" });
    for (const nome of ["Visão geral", "Hierárquico", "Linha do tempo", "Conceito"]) expect(within(painel).getByRole("radio", { name: new RegExp(nome) })).toBeInTheDocument();
    expect(painel).toHaveTextContent("A IA monta o mapa de novo a partir da transcrição desta reunião");
    expect(painel).toHaveTextContent("O mapa novo substitui as suas edições.");
    fireEvent.click(within(painel).getByRole("radio", { name: /Linha do tempo/ }));
    fireEvent.click(within(painel).getByRole("button", { name: "Refazer o mapa" }));
    expect(mutacao("refazerMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO, revisao: 4, estilo: "timeline" }, expect.anything());
  });

  it("refazendo: o mapa de antes à vista com o aviso, e editar e refazer travados; o refazer que falhou oferece tentar de novo", () => {
    const { unmount } = daDona(comEdicao({ refazendo: true }, { estilo: "timeline" }));
    expect(screen.getByRole("status")).toHaveTextContent("A IA está refazendo o mapa no estilo Linha do tempo.");
    expect(screen.getByRole("button", { name: "Editar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refazer em outro estilo" })).toBeDisabled();
    expect(arvore()).toHaveAttribute("data-estilo", "timeline");
    unmount();
    daDona(comEdicao({ erroDoRefazer: "IA_INDISPONIVEL" }));
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível refazer o mapa em outro estilo.");
    fireEvent.click(within(alerta).getByRole("button", { name: /Tentar de novo/ }));
    expect(mutacao("pedirMapa").mutate).toHaveBeenCalledWith({ meetingId: REUNIAO });
  });

  it("o tentar de novo do refazer que falhou, recusado, mostra a frase do pedido", () => {
    preparar("pedirMapa", { isError: true, error: { message: "Muitos pedidos à IA em sequência.", data: { code: "TOO_MANY_REQUESTS" } } });
    daDona(comEdicao({ erroDoRefazer: "IA_INDISPONIVEL" }));
    expect(screen.getAllByRole("alert").map(a => a.textContent).join(" ")).toContain("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
  });

  it("o refazer recusado: o teto do refazer pelo código do mapa; o teto comum de pedidos à IA pela frase de sempre", () => {
    preparar("refazerMapa", { isError: true, error: { message: "MAPA_REFAZERES_DEMAIS", data: { code: "TOO_MANY_REQUESTS" } } });
    const { unmount } = daDona(comEdicao({}));
    fireEvent.click(screen.getByRole("button", { name: "Refazer em outro estilo" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Você já pediu muitas vezes para refazer mapas nesta hora.");
    unmount();
    preparar("refazerMapa", { isError: true, error: { message: "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.", data: { code: "TOO_MANY_REQUESTS" } } });
    daDona(comEdicao({}));
    fireEvent.click(screen.getByRole("button", { name: "Refazer em outro estilo" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Muitos pedidos em sequência. Aguarde alguns minutos e tente de novo.");
  });

  it.each(["hierarchical", "timeline", "concept"])("o estilo %s desenha todos os ramos, pontos e detalhes, também pelo link, com o nome do estilo", estilo => {
    doLink(consulta({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA, estilo }));
    expect(arvore()).toHaveAttribute("data-estilo", estilo);
    for (const texto of ["Exportação de café", "Contêiner sai de Santos", "12 de março", "Feiras de 2027"]) expect(within(arvore()).getByText(texto)).toBeVisible();
    expect(screen.getByText(/^Estilo: /)).toBeInTheDocument();
  });

  it("o estilo em árabe segue da direita para a esquerda", () => {
    doLink(consulta({ estado: "pronto", idioma: "ar", erro: null, mapa: MAPA, estilo: "timeline" }));
    expect(arvore()).toHaveAttribute("dir", "rtl");
  });

  it("baixar o Markdown entrega o arquivo com o título e a árvore", async () => {
    const criar = vi.fn((_blob: Blob) => "blob:mapa");
    const antes = { criar: URL.createObjectURL, revogar: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() });
    const clicar = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    daDona(pronto());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Markdown" })); });
    expect(clicar).toHaveBeenCalledTimes(1);
    const texto = await criar.mock.calls[0][0].text();
    expect(texto.startsWith(`# ☕ ${TITULO}\n`)).toBe(true);
    expect(texto).toContain("- **Exportação de café**\n  - Contêiner sai de Santos\n    - 12 de março");
    clicar.mockRestore();
    Object.assign(URL, { createObjectURL: antes.criar, revokeObjectURL: antes.revogar });
  });

  it("baixar o PDF sem canvas no aparelho: o aviso, sem quebrar a tela", async () => {
    const semCanvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    daDona(pronto());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "PDF" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível montar o arquivo neste aparelho.");
    expect(arvore()).toBeInTheDocument();
    semCanvas.mockRestore();
  });
});
