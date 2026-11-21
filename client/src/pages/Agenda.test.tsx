import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { fusoDoAparelho } from "@shared/agenda";
import { quandoDaReuniao } from "@shared/agenda-links";
import Agenda, { entradaDoFormulario, mensagemDoErroDaAgenda, mensagemDoErroDeTirarDaGoogle, motivoSemGoogleNaTela, rotuloDaDuracao } from "./Agenda";

/**
 * A agenda de reuniões (H16a), com o tRPC dublado. Prova o que a dona vê e o
 * que vai ao servidor: a falha da leitura é erro (nunca "nenhuma reunião"), o
 * "Gravar agora" abre o gravador com a reunião marcada, os convites abrem o app
 * dela com a mensagem pronta (os e-mails só no e-mail e no botão da Google
 * dela, nunca na mensagem), o .ics sai do navegador e o formulário manda a hora
 * do aparelho com o fuso dele. Com a Google Agenda conectada (H16c), o cartão
 * mostra o estado da reunião lá, com "Tentar de novo", e o formulário ganha o
 * convite pela Google, desmarcado.
 */

type Opcoes = { onSuccess?: (data: unknown, vars: unknown) => unknown; onError?: (erro: unknown, vars: unknown) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const mutacao = (nome: string) => (mutacoes[nome] ??= { opcoes: {}, mutate: vi.fn() });
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = mutacao(nome);
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false, variables: undefined };
    },
  });
  return {
    mutacao, registrar, listar: vi.fn(), estadoGoogle: vi.fn(),
    utils: { agenda: { listar: { invalidate: vi.fn() } }, googleAgenda: { estado: { invalidate: vi.fn() } } },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => duble.utils,
    agenda: {
      listar: { useQuery: (...args: unknown[]) => duble.listar(...args) },
      criar: duble.registrar("criar"),
      atualizar: duble.registrar("atualizar"),
      excluir: duble.registrar("excluir"),
      mandarParaGoogle: duble.registrar("mandarParaGoogle"),
      tirarDaGoogle: duble.registrar("tirarDaGoogle"),
    },
    googleAgenda: {
      estado: { useQuery: (...args: unknown[]) => duble.estadoGoogle(...args) },
    },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const GRAVACAO = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DAQUI_A_UM_DIA = Date.now() + 24 * 60 * 60_000;
const reuniao = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  titulo: "Conversa com a Bia",
  inicioEm: DAQUI_A_UM_DIA,
  duracaoMinutos: 90,
  fuso: "America/Sao_Paulo",
  local: "https://meet.google.com/abc-defg-hij",
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
  lembreteMinutos: 15,
  createdAt: 1,
  updatedAt: 2,
  google: null,
  googleConvites: false,
  gravacao: null,
  ...extra,
});
const lista = (proximas: unknown[], anteriores: unknown[] = []) => ({ data: { proximas, anteriores }, isLoading: false, isError: false, error: null, refetch: vi.fn() });
/** O estado da Google Agenda (googleAgenda.estado, da H16b), como a consulta devolve. */
const estadoGoogle = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...extra });
const SEM_GOOGLE = { disponivel: false };
const CONECTADA = { disponivel: true, origem: "https://wrwglobal.org", conectada: true, email: "dona@exemplo.com", falha: null };

let criarUrl: ReturnType<typeof vi.fn>;
let originais: { criar: unknown; revogar: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  for (const nome of ["criar", "atualizar", "excluir", "mandarParaGoogle", "tirarDaGoogle"]) duble.mutacao(nome).mutate.mockReset();
  duble.utils.agenda.listar.invalidate.mockReset();
  duble.utils.googleAgenda.estado.invalidate.mockReset();
  duble.listar.mockReturnValue(lista([reuniao()]));
  duble.estadoGoogle.mockReturnValue(estadoGoogle(SEM_GOOGLE));
  window.history.replaceState(null, "", "/agenda");
  originais = { criar: URL.createObjectURL, revogar: URL.revokeObjectURL };
  criarUrl = vi.fn(() => "blob:agenda");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: criarUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originais.criar });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originais.revogar });
  await i18n.changeLanguage("pt-BR");
});

/**
 * O "Arquivo .ics" solta o endereço do arquivo 10 s depois do clique
 * (baixarIcs, em Agenda.tsx). Com o relógio de verdade, esse timer disparava
 * depois do fim do teste, quando o afterEach já tinha devolvido o
 * URL.revokeObjectURL do jsdom, que não existe: o arquivo, que leva mais de
 * 10 s com a máquina carregada, derrubava a suíte com "URL.revokeObjectURL is
 * not a function" (CI local de 21/11/2026). Com o relógio falso, o teste vê o
 * endereço sair, e nenhum timer sobra.
 */
function clicarNoIcs() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(screen.getByRole("button", { name: /Arquivo \.ics/ }));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:agenda");
  } finally {
    vi.useRealTimers();
  }
}

describe("Agenda — a lista", () => {
  it("carregando: o aviso de carregamento, nada de 'nenhuma reunião'", () => {
    duble.listar.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    render(<Agenda/>);
    expect(screen.getByText("Carregando a agenda…")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma reunião marcada")).not.toBeInTheDocument();
  });

  it("falha na leitura é erro com Tentar de novo, nunca a agenda vazia", () => {
    const refetch = vi.fn();
    duble.listar.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } }, refetch });
    render(<Agenda/>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma reunião marcada")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button"));
    expect(refetch).toHaveBeenCalled();
  });

  it("sem nenhuma reunião, o convite para marcar a primeira", () => {
    duble.listar.mockReturnValue(lista([], []));
    render(<Agenda/>);
    expect(screen.getByText("Nenhuma reunião marcada")).toBeInTheDocument();
  });

  it("o cartão mostra título, quando (no fuso da reunião), o link da chamada, quem vai e o lembrete", () => {
    render(<Agenda/>);
    const cartao = screen.getByRole("article", { name: "Conversa com a Bia" });
    // Comparado pelo textContent: o Intl põe espaços finos no intervalo, que o getByText normalizaria.
    const quando = quandoDaReuniao({ inicioMs: DAQUI_A_UM_DIA, duracaoMinutos: 90, fuso: "America/Sao_Paulo" }, "pt-BR");
    expect(Array.from(cartao.querySelectorAll("p")).some(p => p.textContent === quando)).toBe(true);
    const link = within(cartao).getByRole("link", { name: "https://meet.google.com/abc-defg-hij" });
    expect(link).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(cartao).getByText("Ana, Bia, cris@exemplo.com")).toBeInTheDocument();
    expect(within(cartao).getByText(/15 minutos antes/)).toBeInTheDocument();
  });

  it("local que não é link inteiro sai como texto, nunca como href", () => {
    duble.listar.mockReturnValue(lista([reuniao({ local: "javascript:alert(1)" })]));
    render(<Agenda/>);
    const cartao = screen.getByRole("article", { name: "Conversa com a Bia" });
    expect(within(cartao).getByText("javascript:alert(1)").tagName).toBe("P");
  });

  it("Gravar agora abre o gravador com a reunião marcada, com a lista de Reuniões logo atrás no histórico", async () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Gravar agora/ }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/gravar?agendada=${ID}`);
    // O voltar do navegador cai em Reuniões, a mesma página do gravador, que
    // devolve a ele quem está gravando (Meetings.agenda.test.tsx); na agenda, o
    // gravador desmontaria e a gravação se perderia.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/meetings"));
  });

  it("com a gravação ligada: Abrir a gravação, o estado dela, e Gravar de novo no lugar de Gravar agora", () => {
    duble.listar.mockReturnValue(lista([reuniao({ gravacao: { id: GRAVACAO, status: "ready" } })]));
    render(<Agenda/>);
    expect(screen.queryByRole("button", { name: /Gravar agora/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gravar de novo/ })).toBeInTheDocument();
    expect(screen.getByText(/Gravação: Pronta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Abrir a gravação/ }));
    expect(window.location.pathname).toBe(`/meetings/${GRAVACAO}`);
  });

  // O envio que falha deixa ligada uma reunião sem áudio, em "Gravação pendente"
  // (a ligação vem logo depois de criar a reunião): gravar de novo a mesma
  // reunião não pode depender de excluir essa em Reuniões.
  it.each([["recording", "Gravação pendente"], ["failed", "Falhou"]])("com a gravação ligada em '%s', Gravar de novo abre o gravador com a mesma reunião", async (status, rotulo) => {
    duble.listar.mockReturnValue(lista([reuniao({ gravacao: { id: GRAVACAO, status } })]));
    render(<Agenda/>);
    expect(screen.getByText(`Gravação: ${rotulo}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gravar de novo/ }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/gravar?agendada=${ID}`);
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/meetings"));
  });

  it("a reunião em curso ganha o selo 'Acontecendo agora'", () => {
    duble.listar.mockReturnValue(lista([reuniao({ inicioEm: Date.now() - 10 * 60_000, duracaoMinutos: 60 })]));
    render(<Agenda/>);
    expect(screen.getByText("Acontecendo agora")).toBeInTheDocument();
  });

  it("as que já acabaram ficam numa seção à parte", () => {
    duble.listar.mockReturnValue(lista([], [reuniao({ id: GRAVACAO, titulo: "Reunião de ontem", inicioEm: Date.now() - 2 * 24 * 60 * 60_000 })]));
    render(<Agenda/>);
    expect(screen.getByText("Nenhuma reunião pela frente.")).toBeInTheDocument();
    const anteriores = screen.getByRole("region", { name: "Já aconteceram" });
    expect(within(anteriores).getByRole("article", { name: "Reunião de ontem" })).toBeInTheDocument();
  });
});

describe("Agenda — convites e calendário", () => {
  it("WhatsApp: a mensagem pronta tem o convite, quando, onde e o link da Google, sem nenhum e-mail", () => {
    render(<Agenda/>);
    const link = screen.getByRole("link", { name: /WhatsApp/ });
    expect(link).toHaveAttribute("target", "_blank");
    const texto = new URL(link.getAttribute("href")!).searchParams.get("text")!;
    expect(texto).toContain("Convite para a reunião “Conversa com a Bia”");
    expect(texto).toContain("Quando: ");
    expect(texto).toContain("Onde: https://meet.google.com/abc-defg-hij");
    expect(texto).toContain("Adicionar à sua Google Agenda: https://calendar.google.com/calendar/render?");
    expect(texto).not.toContain("ana@exemplo.com");
    expect(texto).not.toContain("cris@exemplo.com");
  });

  it("e-mail: os convidados com e-mail em cópia oculta, o assunto e a mesma mensagem", () => {
    render(<Agenda/>);
    const href = screen.getByRole("link", { name: /E-mail/ }).getAttribute("href")!;
    expect(href.startsWith("mailto:?bcc=ana@exemplo.com,cris@exemplo.com&")).toBe(true);
    const consulta = new URLSearchParams(href.slice("mailto:?".length));
    expect(consulta.get("subject")).toBe("Convite: Conversa com a Bia");
    expect(consulta.get("body")).toContain("Convite para a reunião “Conversa com a Bia”");
  });

  it("Google Agenda da dona: o evento com os convidados que têm e-mail", () => {
    render(<Agenda/>);
    const link = screen.getByRole("link", { name: /Google Agenda/ });
    const parametros = new URL(link.getAttribute("href")!).searchParams;
    expect(parametros.get("text")).toBe("Conversa com a Bia");
    expect(parametros.get("add")).toBe("ana@exemplo.com,cris@exemplo.com");
    expect(parametros.get("ctz")).toBe("America/Sao_Paulo");
  });

  it(".ics: feito no navegador, como text/calendar, com o nome do título", async () => {
    const cliques: string[] = [];
    const clicar = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { cliques.push(this.download); });
    render(<Agenda/>);
    clicarNoIcs();
    expect(criarUrl).toHaveBeenCalledTimes(1);
    const arquivo = criarUrl.mock.calls[0][0] as Blob;
    expect(arquivo.type).toBe("text/calendar;charset=utf-8");
    const conteudo = await arquivo.text();
    expect(conteudo).toContain("SUMMARY:Conversa com a Bia");
    expect(conteudo).toContain(`UID:${ID}@wrwglobal.org`);
    expect(conteudo).toContain("TRIGGER:-PT15M");
    expect(cliques).toEqual(["Conversa-com-a-Bia.ics"]);
    clicar.mockRestore();
  });

  it(".ics da reunião mudada: o mesmo UID, com o SEQUENCE maior e o LAST-MODIFIED da última mudança", async () => {
    const criada = Date.UTC(2026, 10, 10, 9, 0);
    duble.listar.mockReturnValue(lista([reuniao({ createdAt: criada, updatedAt: criada + 60 * 60_000 })]));
    const clicar = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Agenda/>);
    clicarNoIcs();
    const linhas = (await (criarUrl.mock.calls[0][0] as Blob).text()).replace(/\r\n /g, "").split("\r\n");
    expect(linhas).toContain(`UID:${ID}@wrwglobal.org`);
    expect(linhas).toContain("SEQUENCE:3600");
    expect(linhas).toContain("LAST-MODIFIED:20261110T100000Z");
    clicar.mockRestore();
  });
});

describe("Agenda — marcar, editar e excluir", () => {
  function preencher(titulo: string) {
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: titulo } });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2026-11-20" } });
    fireEvent.change(screen.getByLabelText("Hora"), { target: { value: "14:00" } });
  }

  it("marcar: a hora do aparelho vira o instante, o fuso dele vai junto, e as linhas vazias de participante saem", () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    preencher("  Reunião com investidor  ");
    fireEvent.change(screen.getByLabelText("Duração"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Local ou link da chamada"), { target: { value: " Av. Paulista, 1000 " } });
    fireEvent.click(screen.getByRole("button", { name: /Adicionar participante/ }));
    fireEvent.click(screen.getByRole("button", { name: /Adicionar participante/ }));
    fireEvent.change(screen.getByLabelText("Nome 1"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail 1"), { target: { value: "ana@exemplo.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.mutacao("criar").mutate).toHaveBeenCalledWith({
      titulo: "Reunião com investidor",
      inicioEm: new Date(2026, 10, 20, 14, 0).getTime(),
      duracaoMinutos: 90,
      fuso: fusoDoAparelho(),
      local: "Av. Paulista, 1000",
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }],
      lembreteMinutos: 15,
      googleConvites: false,
    });
  });

  it("sem título ou com e-mail ruim, nada vai ao servidor e a dona lê o porquê", () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(toast.error).toHaveBeenCalledWith("Dê um título à reunião.");
    preencher("Reunião");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar participante/ }));
    fireEvent.change(screen.getByLabelText("E-mail 1"), { target: { value: "ana-arroba-exemplo" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(toast.error).toHaveBeenCalledWith("Confira o e-mail do participante 1.");
    expect(duble.mutacao("criar").mutate).not.toHaveBeenCalled();
  });

  // A regra é a do servidor (emailDoParticipanteValido): com a regra frouxa de
  // antes, estes iam ao servidor, voltavam BAD_REQUEST, e a dona lia só
  // "Confira os campos", sem saber qual participante corrigir.
  it.each([
    ["o ponto que o iPhone põe depois de dois espaços", "ana@exemplo.com.  "],
    ["o acento", "joão@exemplo.com.br"],
    ["os dois pontos seguidos", "ana@exemplo..com"],
  ])("e-mail com %s: a tela aponta o participante, e nada vai ao servidor", (_caso, email) => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    preencher("Reunião");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar participante/ }));
    fireEvent.click(screen.getByRole("button", { name: /Adicionar participante/ }));
    fireEvent.change(screen.getByLabelText("E-mail 1"), { target: { value: "ana@exemplo.com" } });
    fireEvent.change(screen.getByLabelText("E-mail 2"), { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(toast.error).toHaveBeenCalledWith("Confira o e-mail do participante 2.");
    expect(duble.mutacao("criar").mutate).not.toHaveBeenCalled();
  });

  it("salvou: aviso, a lista relida e o formulário fecha; falhou: o código vira frase da tela", async () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    await act(async () => { await duble.mutacao("criar").opcoes.onError?.({ message: "Fuso horário desconhecido.", data: { code: "BAD_REQUEST" } }, {}); });
    expect(toast.error).toHaveBeenCalledWith("Confira os campos e tente de novo.");
    expect(screen.getByLabelText("Título")).toBeInTheDocument();
    await act(async () => { await duble.mutacao("criar").opcoes.onSuccess?.({ id: ID }, {}); });
    expect(toast.success).toHaveBeenCalledWith("Reunião marcada.");
    expect(duble.utils.agenda.listar.invalidate).toHaveBeenCalled();
    expect(screen.queryByLabelText("Título")).not.toBeInTheDocument();
  });

  it("editar: o formulário vem preenchido e salva pela id, com o novo título", () => {
    duble.listar.mockReturnValue(lista([reuniao({ inicioEm: new Date(2026, 10, 20, 14, 0).getTime(), local: null })]));
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect(screen.getByLabelText("Título")).toHaveValue("Conversa com a Bia");
    expect(screen.getByLabelText("Data")).toHaveValue("2026-11-20");
    expect(screen.getByLabelText("Hora")).toHaveValue("14:00");
    expect(screen.getByLabelText("Nome 1")).toHaveValue("Ana");
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Conversa com a Bia e a Cris" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.mutacao("atualizar").mutate).toHaveBeenCalledWith(expect.objectContaining({
      id: ID, titulo: "Conversa com a Bia e a Cris", inicioEm: new Date(2026, 10, 20, 14, 0).getTime(),
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
    }));
    expect(duble.mutacao("criar").mutate).not.toHaveBeenCalled();
  });

  it("excluir pede confirmação; Manter desiste, Excluir manda a id", () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /^Excluir/ }));
    expect(screen.getByText("Tirar “Conversa com a Bia” da agenda? A gravação, se houver, continua em Reuniões.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(screen.queryByText(/Tirar “Conversa com a Bia”/)).not.toBeInTheDocument();
    expect(duble.mutacao("excluir").mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Excluir/ }));
    const confirmacao = screen.getByText(/Tirar “Conversa com a Bia”/).parentElement!;
    fireEvent.click(within(confirmacao).getByRole("button", { name: "Excluir" }));
    expect(duble.mutacao("excluir").mutate).toHaveBeenCalledWith({ id: ID });
  });
});

describe("Agenda — funções da tela", () => {
  const t = i18n.getFixedT("pt-BR");

  it("o erro sai pelo código, no idioma da tela", () => {
    expect(mensagemDoErroDaAgenda(t, { data: { code: "NOT_FOUND" } })).toBe("Esta reunião não está mais na sua agenda. Atualize a tela.");
    expect(mensagemDoErroDaAgenda(t, { data: { code: "PRECONDITION_FAILED" } })).toBe("Sua agenda chegou ao limite de reuniões. Exclua as antigas para marcar novas.");
    expect(mensagemDoErroDaAgenda(t, { data: { code: "CONFLICT" } })).toBe("Esta gravação já está ligada a outra reunião da agenda.");
    // Sem o envelope do tRPC (a rede caiu): a frase genérica traduzida, não o texto técnico.
    expect(mensagemDoErroDaAgenda(t, new Error("Failed to fetch"))).toBe(t("errorBoundary.serverUnavailable"));
    expect(mensagemDoErroDaAgenda(i18n.getFixedT("en"), { data: { code: "NOT_FOUND" } })).toBe("This meeting is no longer in your schedule. Refresh the page.");
  });

  it("a duração no idioma de quem lê", () => {
    expect(rotuloDaDuracao(45, "pt-BR")).toBe(new Intl.NumberFormat("pt-BR", { style: "unit", unit: "minute", unitDisplay: "short" }).format(45));
    expect(rotuloDaDuracao(120, "pt-BR")).toBe(new Intl.NumberFormat("pt-BR", { style: "unit", unit: "hour", unitDisplay: "short" }).format(2));
    expect(rotuloDaDuracao(90, "en")).toContain("30");
  });

  it("data ou hora vazias não viram instante", () => {
    const base = { titulo: "Reunião", data: "", hora: "14:00", duracaoMinutos: 60, local: "", participantes: [], lembrete: "" };
    expect(entradaDoFormulario(base, t)).toEqual({ erro: "Escolha a data e a hora." });
    expect(entradaDoFormulario({ ...base, data: "2026-11-20", hora: "" }, t)).toEqual({ erro: "Escolha a data e a hora." });
    expect(entradaDoFormulario({ ...base, data: "2026-11-20" }, t, "Europe/Lisbon")).toMatchObject({ entrada: { fuso: "Europe/Lisbon", lembreteMinutos: null } });
  });
});

describe("Agenda — a Google Agenda conectada (H16c)", () => {
  const ANTEONTEM = Date.now() - 2 * 24 * 60 * 60_000;
  const cartao = () => screen.getByRole("article", { name: "Conversa com a Bia" });

  it("sem a Google Agenda: o link de criar evento da H16a, e nada de estado nem de convite pela Google", () => {
    render(<Agenda/>);
    expect(within(cartao()).getByRole("link", { name: /Google Agenda/ })).toBeInTheDocument();
    expect(screen.queryByText("Na sua Google Agenda")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    expect(screen.queryByLabelText("A Google manda o convite pela sua conta")).not.toBeInTheDocument();
  });

  it("enquanto o estado da Google carrega, nem o link (criaria o evento em dobro) nem o estado", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(undefined, { isLoading: true }));
    render(<Agenda/>);
    expect(within(cartao()).queryByRole("link", { name: /Google Agenda/ })).not.toBeInTheDocument();
    expect(within(cartao()).queryByText("Na sua Google Agenda")).not.toBeInTheDocument();
  });

  it("a consulta da Google com erro é erro com Tentar de novo, nunca 'não conectada'", () => {
    const refetch = vi.fn();
    duble.estadoGoogle.mockReturnValue(estadoGoogle(undefined, {
      isError: true, refetch, error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } },
    }));
    render(<Agenda/>);
    const alerta = screen.getByRole("alert");
    expect(within(alerta).getByText(/Não deu para saber se a sua Google Agenda está conectada/)).toBeInTheDocument();
    fireEvent.click(within(alerta).getByRole("button"));
    expect(refetch).toHaveBeenCalled();
    expect(within(cartao()).queryByRole("link", { name: /Google Agenda/ })).not.toBeInTheDocument();
  });

  it("conectada e a reunião lá: 'Na sua Google Agenda', no lugar do link", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(CONECTADA));
    duble.listar.mockReturnValue(lista([reuniao({ google: "ok" })]));
    render(<Agenda/>);
    expect(within(cartao()).getByText("Na sua Google Agenda")).toBeInTheDocument();
    expect(within(cartao()).queryByRole("link", { name: /Google Agenda/ })).not.toBeInTheDocument();
    expect(within(cartao()).queryByRole("button", { name: /Tentar de novo/ })).not.toBeInTheDocument();
  });

  it.each([["falhou"], ["pendente"]])("conectada e a reunião '%s': 'Ainda não está' e Tentar de novo manda a reunião", estado => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(CONECTADA));
    duble.listar.mockReturnValue(lista([reuniao({ google: estado })]));
    render(<Agenda/>);
    expect(within(cartao()).getByText("Ainda não está na sua Google Agenda")).toBeInTheDocument();
    fireEvent.click(within(cartao()).getByRole("button", { name: /Tentar de novo/ }));
    expect(duble.mutacao("mandarParaGoogle").mutate).toHaveBeenCalledWith({ id: ID });
  });

  it("a reunião marcada antes de conectar: 'Pôr na Google Agenda' nas que vão acontecer; nas que já foram, nada", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(CONECTADA));
    duble.listar.mockReturnValue(lista([reuniao()], [reuniao({ id: GRAVACAO, titulo: "Reunião de ontem", inicioEm: ANTEONTEM })]));
    render(<Agenda/>);
    fireEvent.click(within(cartao()).getByRole("button", { name: /Pôr na Google Agenda/ }));
    expect(duble.mutacao("mandarParaGoogle").mutate).toHaveBeenCalledWith({ id: ID });
    const deOntem = screen.getByRole("article", { name: "Reunião de ontem" });
    expect(within(deOntem).queryByRole("button", { name: /Pôr na Google Agenda/ })).not.toBeInTheDocument();
    expect(within(deOntem).queryByRole("link", { name: /Google Agenda/ })).not.toBeInTheDocument();
  });

  it("a conexão que parou de funcionar: o aviso no topo leva ao Perfil", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle({ ...CONECTADA, falha: "revogada" }));
    render(<Agenda/>);
    expect(screen.getByText(/A conexão com a Google Agenda parou de funcionar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir o Perfil" }));
    expect(window.location.pathname).toBe("/profile");
  });

  it("o formulário: a reunião vai para a Google, e o convite pela Google vem desmarcado; marcado, vai junto", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(CONECTADA));
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    expect(screen.getByText("A reunião vai também para a sua Google Agenda.")).toBeInTheDocument();
    const convite = screen.getByLabelText("A Google manda o convite pela sua conta");
    expect(convite).not.toBeChecked();
    // Desmarcado, os participantes nem entram no evento (server/google-agenda-eventos.ts).
    expect(convite).toHaveAccessibleDescription(/Desmarcado, o evento fica só na sua agenda, sem os convidados./);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Reunião com investidor" } });
    fireEvent.click(convite);
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.mutacao("criar").mutate).toHaveBeenCalledWith(expect.objectContaining({ titulo: "Reunião com investidor", googleConvites: true }));
  });

  it("editar traz o convite como estava", () => {
    duble.estadoGoogle.mockReturnValue(estadoGoogle(CONECTADA));
    duble.listar.mockReturnValue(lista([reuniao({ google: "ok", googleConvites: true })]));
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect(screen.getByLabelText("A Google manda o convite pela sua conta")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(duble.mutacao("atualizar").mutate).toHaveBeenCalledWith(expect.objectContaining({ id: ID, googleConvites: true }));
  });

  it("salvou na WRW e a Google falhou: o aviso de sempre e outro com o porquê", async () => {
    render(<Agenda/>);
    fireEvent.click(screen.getByRole("button", { name: /Marcar reunião/ }));
    await act(async () => { await duble.mutacao("criar").opcoes.onSuccess?.({ id: ID, naGoogle: "falhou", motivo: "revogada" }, {}); });
    expect(toast.success).toHaveBeenCalledWith("Reunião marcada.");
    expect(toast.warning).toHaveBeenCalledWith("A reunião está salva na WRW, mas não foi para a sua Google Agenda. Reconecte a Google Agenda no Perfil.", expect.anything());
    // Deu certo na Google, ou nada foi tentado: só o aviso de sempre.
    vi.mocked(toast.warning).mockClear();
    await act(async () => { await duble.mutacao("atualizar").opcoes.onSuccess?.({ id: ID, naGoogle: "ok" }, {}); });
    await act(async () => { await duble.mutacao("atualizar").opcoes.onSuccess?.({ id: ID, naGoogle: null }, {}); });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("excluiu e o evento ficou na Google: o aviso traz Tentar de novo, que tira o evento com o convite que a reunião tinha", async () => {
    render(<Agenda/>);
    await act(async () => { await duble.mutacao("excluir").opcoes.onSuccess?.({ ok: true, avisarConvidados: true, naGoogle: "falhou", motivo: "google" }, { id: ID }); });
    expect(toast.success).toHaveBeenCalledWith("Reunião tirada da agenda.");
    const [texto, opcoes] = vi.mocked(toast.warning).mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(texto).toBe("A reunião saiu da agenda da WRW, mas continua na sua Google Agenda. A Google não respondeu. Tente de novo em instantes.");
    expect(opcoes.action.label).toBe("Tentar de novo");
    opcoes.action.onClick();
    expect(duble.mutacao("tirarDaGoogle").mutate).toHaveBeenCalledWith({ id: ID, avisarConvidados: true });
  });

  it("excluiu, e só reconectar resolveria: o aviso manda apagar o evento por lá, sem Tentar de novo", async () => {
    render(<Agenda/>);
    await act(async () => { await duble.mutacao("excluir").opcoes.onSuccess?.({ ok: true, avisarConvidados: false, naGoogle: "falhou", motivo: "revogada" }, { id: ID }); });
    const [texto, opcoes] = vi.mocked(toast.warning).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(texto).toBe("A reunião saiu da agenda da WRW, mas continua na sua Google Agenda. Se quiser, apague o evento por lá.");
    expect(opcoes).not.toHaveProperty("action");
  });

  it("Tentar de novo: deu certo, o aviso de sucesso; não deu, o porquê; e a lista é relida", async () => {
    render(<Agenda/>);
    await act(async () => { await duble.mutacao("mandarParaGoogle").opcoes.onSuccess?.({ naGoogle: "ok" }, { id: ID }); });
    expect(toast.success).toHaveBeenCalledWith("A reunião está na sua Google Agenda.");
    await act(async () => { await duble.mutacao("mandarParaGoogle").opcoes.onSuccess?.({ naGoogle: "falhou", motivo: "nao-conectada" }, { id: ID }); });
    expect(toast.warning).toHaveBeenCalledWith("A reunião está salva na WRW, mas não foi para a sua Google Agenda. Conecte a Google Agenda no Perfil.", expect.anything());
    expect(duble.utils.agenda.listar.invalidate).toHaveBeenCalledTimes(2);
  });

  it("Tentar de novo na reunião que já acabou e não está na Google: o aviso de que ela fica só na WRW, nunca 'está na sua Google Agenda'", async () => {
    render(<Agenda/>);
    await act(async () => { await duble.mutacao("mandarParaGoogle").opcoes.onSuccess?.({ naGoogle: null }, { id: ID }); });
    expect(toast.info).toHaveBeenCalledWith("Esta reunião já aconteceu e fica só na agenda da WRW.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(duble.utils.agenda.listar.invalidate).toHaveBeenCalled();
  });

  it("a Google recusou a conexão, ou ela saiu em outra aba: o estado da conexão é relido, e o aviso do topo vem sem recarregar a página", async () => {
    render(<Agenda/>);
    const relido = duble.utils.googleAgenda.estado.invalidate;
    await act(async () => { await duble.mutacao("atualizar").opcoes.onSuccess?.({ id: ID, naGoogle: "falhou", motivo: "revogada" }, {}); });
    expect(relido).toHaveBeenCalledTimes(1);
    await act(async () => { await duble.mutacao("mandarParaGoogle").opcoes.onSuccess?.({ naGoogle: "falhou", motivo: "nao-conectada" }, { id: ID }); });
    await act(async () => { await duble.mutacao("excluir").opcoes.onSuccess?.({ ok: true, avisarConvidados: false, naGoogle: "falhou", motivo: "revogada" }, { id: ID }); });
    await act(async () => { await duble.mutacao("tirarDaGoogle").opcoes.onSuccess?.({ naGoogle: "falhou", motivo: "nao-conectada" }, {}); });
    expect(relido).toHaveBeenCalledTimes(4);
    // A Google fora do ar, ou tudo certo: a conexão é a mesma, e nada é relido.
    await act(async () => { await duble.mutacao("criar").opcoes.onSuccess?.({ id: ID, naGoogle: "falhou", motivo: "google" }, {}); });
    await act(async () => { await duble.mutacao("mandarParaGoogle").opcoes.onSuccess?.({ naGoogle: "ok" }, { id: ID }); });
    await act(async () => { await duble.mutacao("excluir").opcoes.onSuccess?.({ ok: true, avisarConvidados: false, naGoogle: null }, { id: ID }); });
    expect(relido).toHaveBeenCalledTimes(4);
  });

  it("tirar da Google: deu certo, o aviso; a reunião que ainda está na agenda, a frase própria", async () => {
    render(<Agenda/>);
    await act(async () => { await duble.mutacao("tirarDaGoogle").opcoes.onSuccess?.({ naGoogle: "ok" }, {}); });
    expect(toast.success).toHaveBeenCalledWith("A reunião saiu da sua Google Agenda.");
    await act(async () => { await duble.mutacao("tirarDaGoogle").opcoes.onError?.({ message: "x", data: { code: "CONFLICT" } }, {}); });
    expect(toast.error).toHaveBeenCalledWith("Esta reunião ainda está na sua agenda. Atualize a tela.");
  });

  it("as frases da Google no idioma da tela", () => {
    const en = i18n.getFixedT("en");
    expect(motivoSemGoogleNaTela(en, "revogada")).toBe("Reconnect Google Calendar in your Profile.");
    expect(motivoSemGoogleNaTela(en, "google")).toBe("Google didn't respond. Try again in a moment.");
    expect(mensagemDoErroDeTirarDaGoogle(en, { data: { code: "CONFLICT" } })).toBe("This meeting is still in your schedule. Refresh the page.");
    expect(mensagemDoErroDeTirarDaGoogle(en, { data: { code: "NOT_FOUND" } })).toBe("This meeting is no longer in your schedule. Refresh the page.");
  });
});
