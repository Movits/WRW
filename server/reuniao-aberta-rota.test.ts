import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O link aberto da reunião nos routers: reuniaoAberta.* (público, sem sessão)
 * e meetings.ligarLinkAberto / desligarLinkAberto (da dona). O módulo do link,
 * a IA e a tradução são dublados; as consultas de verdade estão em
 * link-aberto-da-reuniao.integracao.test.ts, e o caminho da tradução até a IA
 * em meeting-service.test.ts.
 */

const exigirReuniaoDoLink = vi.fn();
const verReuniaoPeloLink = vi.fn();
const ligarLinkAberto = vi.fn();
const desligarLinkAberto = vi.fn();
const resumirReuniao = vi.fn();
const perguntarAReuniao = vi.fn();
const translatePrivateMeetingTranscript = vi.fn();
const createAuditLog = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./link-aberto-da-reuniao")>(),
  exigirReuniaoDoLink: (...args: unknown[]) => exigirReuniaoDoLink(...args),
  verReuniaoPeloLink: (...args: unknown[]) => verReuniaoPeloLink(...args),
  ligarLinkAberto: (...args: unknown[]) => ligarLinkAberto(...args),
  desligarLinkAberto: (...args: unknown[]) => desligarLinkAberto(...args),
}));
vi.mock("./reuniao-com-ia", async importOriginal => ({
  ...await importOriginal<typeof import("./reuniao-com-ia")>(),
  resumirReuniao: (...args: unknown[]) => resumirReuniao(...args),
  perguntarAReuniao: (...args: unknown[]) => perguntarAReuniao(...args),
}));
vi.mock("./meeting-service", async importOriginal => ({
  ...await importOriginal<typeof import("./meeting-service")>(),
  translatePrivateMeetingTranscript: (...args: unknown[]) => translatePrivateMeetingTranscript(...args),
}));
vi.mock("./security", async importOriginal => ({
  ...await importOriginal<typeof import("./security")>(),
  createAuditLog: (...args: unknown[]) => createAuditLog(...args),
}));

const { appRouter } = await import("./routers");
const { tetoDaIADoLinkAberto, PEDIDOS_A_IA_POR_LINK_POR_JANELA } = await import("./routers/reuniaoAberta");
const { LinkAbertoRecusado, MENSAGEM_LINK_NAO_ENCONTRADO } = await import("./link-aberto-da-reuniao");

const TOKEN = "A".repeat(32);
const OUTRO_TOKEN = "B".repeat(32);
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const REUNIAO = { id: ID, ownerId: "dona-1", title: "Reunião de teste", createdAt: 1_700_000_000_000 };
const RESUMO_VAZIO = { topicos: [], decisoes: [], tarefas: [] };

const semSessao = () => appRouter.createCaller({
  user: null, req: { headers: {}, socket: {} }, res: { cookie: () => {}, clearCookie: () => {} },
} as never);
const daDona = (openId = "dona-1") => appRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} }, res: { cookie: () => {}, clearCookie: () => {} },
} as never);

const linkNaoEncontrado = () => new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_LINK_NAO_ENCONTRADO);

beforeEach(() => {
  tetoDaIADoLinkAberto.esquecer();
  for (const dublê of [exigirReuniaoDoLink, verReuniaoPeloLink, ligarLinkAberto, desligarLinkAberto, resumirReuniao, perguntarAReuniao, translatePrivateMeetingTranscript, createAuditLog]) {
    dublê.mockReset();
  }
  exigirReuniaoDoLink.mockImplementation(async (token: string) => {
    if (token === TOKEN || token === OUTRO_TOKEN) return REUNIAO;
    throw linkNaoEncontrado();
  });
  resumirReuniao.mockResolvedValue(RESUMO_VAZIO);
  perguntarAReuniao.mockResolvedValue({ respondida: false });
});
afterEach(() => { vi.useRealTimers(); });

describe("reuniaoAberta — público, sem sessão", () => {
  it("ver devolve o que o serviço monta para o link", async () => {
    const vista = { titulo: "Reunião de teste", criadaEm: 1, transcricao: null, gravacao: null, gravacaoExpirada: false };
    verReuniaoPeloLink.mockResolvedValue(vista);
    await expect(semSessao().reuniaoAberta.ver({ token: TOKEN })).resolves.toEqual(vista);
    expect(verReuniaoPeloLink).toHaveBeenCalledWith(TOKEN);
  });

  it("link que não existe ou foi desligado sai como NOT_FOUND, com a frase do serviço", async () => {
    verReuniaoPeloLink.mockRejectedValue(linkNaoEncontrado());
    await expect(semSessao().reuniaoAberta.ver({ token: "cortado" })).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_LINK_NAO_ENCONTRADO });
    await expect(semSessao().reuniaoAberta.resumir({ token: "cortado", idioma: "pt-BR" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(resumirReuniao).not.toHaveBeenCalled();
  });

  it("resumo e pergunta vão ao serviço com a dona e a reunião DO LINK, nunca com algo vindo de quem pede", async () => {
    await semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "en" });
    await semSessao().reuniaoAberta.perguntar({ token: TOKEN, idioma: "ja", pergunta: "  Qual o prazo?  " });
    expect(exigirReuniaoDoLink).toHaveBeenCalledWith(TOKEN);
    expect(resumirReuniao).toHaveBeenCalledWith("dona-1", ID, "en");
    expect(perguntarAReuniao).toHaveBeenCalledWith("dona-1", ID, "Qual o prazo?", "ja");
  });

  it("a tradução vai com a dona e a reunião do link e leva o teto como antesDeChamarAIA", async () => {
    translatePrivateMeetingTranscript.mockResolvedValue({ language: "en", text: "Talk.", cached: true });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" })).resolves.toEqual({ language: "en", text: "Talk.", cached: true });
    expect(translatePrivateMeetingTranscript).toHaveBeenCalledWith("dona-1", ID, "en", expect.any(Function));
  });

  it("a dona não precisa de sessão para nada disso, mas ligar e desligar o link pedem sessão", async () => {
    verReuniaoPeloLink.mockResolvedValue({});
    await expect(semSessao().reuniaoAberta.ver({ token: TOKEN })).resolves.toEqual({});
    await expect(semSessao().meetings.ligarLinkAberto({ meetingId: ID, autorizacaoDasPessoas: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().meetings.desligarLinkAberto({ meetingId: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(ligarLinkAberto).not.toHaveBeenCalled();
    expect(desligarLinkAberto).not.toHaveBeenCalled();
  });
});

describe(`reuniaoAberta — teto de ${PEDIDOS_A_IA_POR_LINK_POR_JANELA} pedidos à IA a cada 10 minutos por link`, () => {
  it("resumo, pergunta e tradução nova somam no mesmo teto; passado ele, TOO_MANY_REQUESTS sem chamar a IA; outro link passa", async () => {
    // A tradução nova roda o teto, como o serviço faz antes de ir à IA.
    translatePrivateMeetingTranscript.mockImplementation(async (_dona: string, _id: string, language: string, antes?: () => void) => {
      antes?.();
      return { language, text: "x", cached: false };
    });
    const terco = Math.floor(PEDIDOS_A_IA_POR_LINK_POR_JANELA / 3);
    for (let i = 0; i < terco; i++) await semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" });
    for (let i = 0; i < terco; i++) await semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "es" });
    for (let i = 2 * terco; i < PEDIDOS_A_IA_POR_LINK_POR_JANELA; i++) {
      await semSessao().reuniaoAberta.perguntar({ token: TOKEN, idioma: "pt-BR", pergunta: "Quem falou?" });
    }

    await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(semSessao().reuniaoAberta.perguntar({ token: TOKEN, idioma: "pt-BR", pergunta: "Quem falou?" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "fr" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(resumirReuniao).toHaveBeenCalledTimes(terco);
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_LINK_POR_JANELA - 2 * terco);

    await expect(semSessao().reuniaoAberta.resumir({ token: OUTRO_TOKEN, idioma: "pt-BR" })).resolves.toEqual(RESUMO_VAZIO);
  });

  it("tradução que já está guardada não gasta vaga", async () => {
    translatePrivateMeetingTranscript.mockResolvedValue({ language: "en", text: "x", cached: true });
    for (let i = 0; i < PEDIDOS_A_IA_POR_LINK_POR_JANELA + 5; i++) await semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" });
    await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" })).resolves.toEqual(RESUMO_VAZIO);
  });

  it("link que não abre não gasta vaga de quem tem o link certo", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_POR_LINK_POR_JANELA + 5; i++) {
      await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN.toLowerCase(), idioma: "pt-BR" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" })).resolves.toEqual(RESUMO_VAZIO);
  });

  it("a janela é de 10 minutos", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    for (let i = 0; i < PEDIDOS_A_IA_POR_LINK_POR_JANELA; i++) await semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" });
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 - 1);
    await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000);
    await expect(semSessao().reuniaoAberta.resumir({ token: TOKEN, idioma: "pt-BR" })).resolves.toEqual(RESUMO_VAZIO);
  });
});

describe("meetings.ligarLinkAberto e desligarLinkAberto — só a dona, com auditoria", () => {
  it("ligar exige a palavra da dona de que as pessoas da reunião autorizaram", async () => {
    for (const entrada of [{ meetingId: ID }, { meetingId: ID, autorizacaoDasPessoas: false }]) {
      await expect(daDona().meetings.ligarLinkAberto(entrada as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(ligarLinkAberto).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("ligado, devolve o token e registra quem ligou, em qual reunião", async () => {
    ligarLinkAberto.mockResolvedValue(TOKEN);
    await expect(daDona().meetings.ligarLinkAberto({ meetingId: ID, autorizacaoDasPessoas: true })).resolves.toEqual({ token: TOKEN });
    expect(ligarLinkAberto).toHaveBeenCalledWith("dona-1", ID);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, action: "MEETING_OPEN_LINK_ON", resource: "meetings", resourceId: ID, details: { autorizacaoDasPessoas: true },
    }));
  });

  it("recusado pelo serviço, sai com o código que a tela traduz e sem auditoria de sucesso", async () => {
    ligarLinkAberto.mockRejectedValue(new LinkAbertoRecusado("PRECONDITION_FAILED", "Só dá para compartilhar uma reunião pronta."));
    await expect(daDona().meetings.ligarLinkAberto({ meetingId: ID, autorizacaoDasPessoas: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    desligarLinkAberto.mockRejectedValue(new LinkAbertoRecusado("NOT_FOUND", "Reunião não encontrada."));
    await expect(daDona("outra").meetings.desligarLinkAberto({ meetingId: ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("desligar vai com a dona da sessão e fica registrado", async () => {
    desligarLinkAberto.mockResolvedValue(undefined);
    await expect(daDona().meetings.desligarLinkAberto({ meetingId: ID })).resolves.toEqual({ success: true });
    expect(desligarLinkAberto).toHaveBeenCalledWith("dona-1", ID);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, action: "MEETING_OPEN_LINK_OFF", resourceId: ID }));
  });
});
