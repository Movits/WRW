import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A senha e o áudio do link aberto (H23) nos routers: reuniaoAberta.entrar
 * (público, grava o cookie da entrada), o contexto dos cookies em todo
 * procedimento que lê a reunião pelo token, e meetings.ligarLinkAberto,
 * novaSenhaDoLink, tirarSenhaDoLink e mudarAudioDoLink (da dona). Os serviços
 * são dublados; as consultas de verdade estão em
 * link-com-senha.integracao.test.ts.
 */

const entrarNoLink = vi.fn();
const exigirReuniaoDoLink = vi.fn();
const verReuniaoPeloLink = vi.fn();
const ligarLinkAbertoComOpcoes = vi.fn();
const novaSenhaDoLink = vi.fn();
const tirarSenhaDoLink = vi.fn();
const mudarAudioDoLink = vi.fn();

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./entrada-no-link-aberto", async importOriginal => ({
  ...await importOriginal<typeof import("./entrada-no-link-aberto")>(),
  entrarNoLink: (...args: unknown[]) => entrarNoLink(...args),
}));
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./link-aberto-da-reuniao")>(),
  exigirReuniaoDoLink: (...args: unknown[]) => exigirReuniaoDoLink(...args),
  verReuniaoPeloLink: (...args: unknown[]) => verReuniaoPeloLink(...args),
  ligarLinkAbertoComOpcoes: (...args: unknown[]) => ligarLinkAbertoComOpcoes(...args),
  novaSenhaDoLink: (...args: unknown[]) => novaSenhaDoLink(...args),
  tirarSenhaDoLink: (...args: unknown[]) => tirarSenhaDoLink(...args),
  mudarAudioDoLink: (...args: unknown[]) => mudarAudioDoLink(...args),
}));

const { appRouter } = await import("./routers");
const { SENHAS_DO_LINK_POR_JANELA, tetoDasSenhasDoLink } = await import("./routers/meetings");
const { LinkAbertoRecusado, MENSAGEM_SENHA_DO_LINK_PEDIDA } = await import("./link-aberto-da-reuniao");
const { cookiesDoPedido } = await import("./senha-do-link-aberto");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { MENSAGEM_BANCO_INDISPONIVEL, UNAUTHED_ERR_MSG } = await import("@shared/const");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const COOKIES = "wrw_link_0123456789abcdef01234567=1800000000.assinatura; outro=x";
const ENTRADA = { nome: "wrw_link_0123456789abcdef01234567", valor: "1800000000.assinatura", maxAgeMs: 12 * 60 * 60_000 };

type CookieGravado = { nome: string; valor: string; opcoes: Record<string, unknown> };
function visitante(opcoes: { cookie?: string; ip?: string; https?: boolean } = {}) {
  const gravados: CookieGravado[] = [];
  const caller = appRouter.createCaller({
    user: null,
    req: { headers: opcoes.cookie ? { cookie: opcoes.cookie } : {}, ip: opcoes.ip ?? "203.0.113.10", socket: {}, protocol: opcoes.https ? "https" : "http" },
    res: { cookie: (nome: string, valor: string, o: Record<string, unknown>) => gravados.push({ nome, valor, opcoes: o }), clearCookie: () => {} },
  } as never);
  return { caller, gravados };
}
const daDona = (openId = "dona-1") => appRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: { "user-agent": "Navegador de teste" }, ip: "198.51.100.7", socket: {} },
  res: { cookie: () => {}, clearCookie: () => {} },
} as never);
const PROVA = { userId: 7, ipAddress: "198.51.100.7", userAgent: "Navegador de teste" };

beforeEach(() => {
  tetoDasSenhasDoLink.esquecer();
  for (const duble of [entrarNoLink, exigirReuniaoDoLink, verReuniaoPeloLink, ligarLinkAbertoComOpcoes, novaSenhaDoLink, tirarSenhaDoLink, mudarAudioDoLink]) duble.mockReset();
});

describe("reuniaoAberta.entrar — a senha de quem recebeu o link", () => {
  it("certa: grava o cookie HttpOnly da entrada (Lax, todo o site, 12 horas), e a resposta não leva o valor dele", async () => {
    entrarNoLink.mockResolvedValue({ entrou: true, cookie: ENTRADA });
    const { caller, gravados } = visitante({ https: true });
    await expect(caller.reuniaoAberta.entrar({ token: TOKEN, senha: "482913" })).resolves.toEqual({ entrou: true });
    expect(entrarNoLink).toHaveBeenCalledWith(TOKEN, "482913", "203.0.113.10");
    expect(gravados).toEqual([{
      nome: ENTRADA.nome, valor: ENTRADA.valor,
      opcoes: { httpOnly: true, path: "/", sameSite: "lax", secure: true, maxAge: ENTRADA.maxAgeMs },
    }]);
  });

  it("errada ou na espera: a resposta do serviço, sem cookie", async () => {
    for (const resultado of [{ entrou: false, motivo: "senha" }, { entrou: false, motivo: "espera", segundos: 42 }]) {
      entrarNoLink.mockResolvedValueOnce(resultado);
      const { caller, gravados } = visitante();
      await expect(caller.reuniaoAberta.entrar({ token: TOKEN, senha: "482913" })).resolves.toEqual(resultado);
      expect(gravados).toEqual([]);
    }
  });

  it("a senha chega normalizada: os algarismos do teclado árabe, do hindi e de largura cheia, e o espaço do meio", async () => {
    entrarNoLink.mockResolvedValue({ entrou: false, motivo: "senha" });
    for (const digitada of ["٤٨٢ ٩١٣", "४८२९१३", "４８２-９１３"]) {
      await visitante().caller.reuniaoAberta.entrar({ token: TOKEN, senha: digitada });
      expect(entrarNoLink).toHaveBeenLastCalledWith(TOKEN, "482913", "203.0.113.10");
    }
  });

  it("fora do formato é BAD_REQUEST e não gasta tentativa: o serviço nem é chamado", async () => {
    for (const senha of ["12345", "1234567", "abcdef", "", "1".repeat(33)]) {
      await expect(visitante().caller.reuniaoAberta.entrar({ token: TOKEN, senha }), senha).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(visitante().caller.reuniaoAberta.entrar({ token: "x".repeat(129), senha: "482913" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(entrarNoLink).not.toHaveBeenCalled();
  });

  it("banco fora do ar é erro, e não 'senha errada'", async () => {
    entrarNoLink.mockRejectedValue(new BancoIndisponivel());
    await expect(visitante().caller.reuniaoAberta.entrar({ token: TOKEN, senha: "482913" }))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
  });
});

/**
 * Quem confere a entrada é o serviço do link (reuniaoDoLink), com os cookies
 * que o procedimento põe no contexto do pedido. Um procedimento novo pelo
 * token que esquecesse o contexto deixaria o link com senha recusar sempre;
 * esta varredura pega o esquecimento, e a lista fechada pega o procedimento
 * que não entrou nela.
 */
describe("todo procedimento que lê a reunião pelo token leva os cookies do pedido ao serviço", () => {
  const PEDIDOS: Record<string, Record<string, unknown>> = {
    ver: { token: TOKEN },
    traduzir: { token: TOKEN, language: "en" },
    resumoGuardado: { token: TOKEN },
    pedirResumo: { token: TOKEN },
    mapaMental: { token: TOKEN },
    pedirMapa: { token: TOKEN },
    // As fotos e os desenhos do resumo (H4g e H4h).
    anexos: { token: TOKEN },
    traduzirResumo: { token: TOKEN, idioma: "en" },
    perguntar: { token: TOKEN, idioma: "pt-BR", pergunta: "Quem falou?" },
  };

  it("a lista cobre o router inteiro, fora o entrar", () => {
    const doLink = Object.keys(appRouter._def.procedures).filter(caminho => caminho.startsWith("reuniaoAberta.")).map(caminho => caminho.slice("reuniaoAberta.".length));
    expect(doLink.sort()).toEqual([...Object.keys(PEDIDOS), "entrar"].sort());
  });

  it.each(Object.keys(PEDIDOS))("%s: o serviço vê os cookies e a recusa da senha sai como UNAUTHORIZED, com a frase da senha", async procedimento => {
    const vistos: Array<string | undefined> = [];
    const pedirSenha = async () => {
      vistos.push(cookiesDoPedido());
      throw new LinkAbertoRecusado("UNAUTHORIZED", MENSAGEM_SENHA_DO_LINK_PEDIDA);
    };
    exigirReuniaoDoLink.mockImplementation(pedirSenha);
    verReuniaoPeloLink.mockImplementation(pedirSenha);
    const { caller } = visitante({ cookie: COOKIES });
    const chamada = (caller.reuniaoAberta as unknown as Record<string, (entrada: unknown) => Promise<unknown>>)[procedimento](PEDIDOS[procedimento]);
    const erro = await chamada.catch((e: unknown) => e);
    expect(erro).toMatchObject({ code: "UNAUTHORIZED", message: MENSAGEM_SENHA_DO_LINK_PEDIDA });
    // Não é o "faça login" da sessão: a tela não manda quem tem o link para o login.
    expect((erro as Error).message).not.toBe(UNAUTHED_ERR_MSG);
    expect(vistos).toEqual([COOKIES]);
    // Fora do pedido, o contexto não sobra.
    expect(cookiesDoPedido()).toBeUndefined();
  });
});

describe("meetings — a dona escolhe a senha e o áudio do link", () => {
  const LIGAR = {
    meetingId: ID, autorizacaoDasPessoas: true as const, idioma: "pt-BR" as const, textoExibido: "Confirmo.", versaoDaAutorizacao: 2 as const,
  };

  it("ligar leva as escolhas ao serviço, e a senha volta só nesta resposta", async () => {
    ligarLinkAbertoComOpcoes.mockResolvedValue({ token: TOKEN, senha: "482913" });
    await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: true, incluirAudio: false })).resolves.toEqual({ token: TOKEN, senha: "482913" });
    expect(ligarLinkAbertoComOpcoes).toHaveBeenCalledWith("dona-1", ID, expect.objectContaining(PROVA), { comSenha: true, incluirAudio: false });
    for (const ruim of [{ comSenha: "sim" }, { incluirAudio: 1 }]) {
      await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, ...ruim } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it(`ligar com senha gasta vaga do teto das senhas: a ${SENHAS_DO_LINK_POR_JANELA + 1}ª na janela é TOO_MANY_REQUESTS sem chegar ao serviço; a recusa e o link que já estava ligado não gastam`, async () => {
    ligarLinkAbertoComOpcoes.mockRejectedValue(new LinkAbertoRecusado("NOT_FOUND", "Reunião não encontrada."));
    for (let i = 0; i < SENHAS_DO_LINK_POR_JANELA + 5; i++) {
      await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // O link que já estava ligado: nenhuma senha saiu, e a vaga volta.
    ligarLinkAbertoComOpcoes.mockReset();
    ligarLinkAbertoComOpcoes.mockResolvedValue({ token: TOKEN, senha: null });
    for (let i = 0; i < SENHAS_DO_LINK_POR_JANELA + 5; i++) await daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: true });
    ligarLinkAbertoComOpcoes.mockResolvedValue({ token: TOKEN, senha: "482913" });
    for (let i = 0; i < SENHAS_DO_LINK_POR_JANELA; i++) await daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: true });
    ligarLinkAbertoComOpcoes.mockClear();
    await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: true })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(ligarLinkAbertoComOpcoes).not.toHaveBeenCalled();
    // É o mesmo teto da senha nova.
    await expect(daDona().meetings.novaSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(novaSenhaDoLink).not.toHaveBeenCalled();
    // Ligar sem senha não é scrypt e não conta; o teto é de cada dona.
    await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, comSenha: false })).resolves.toMatchObject({ token: TOKEN });
    await expect(daDona().meetings.ligarLinkAberto(LIGAR)).resolves.toMatchObject({ token: TOKEN });
    await expect(daDona("dona-2").meetings.ligarLinkAberto({ ...LIGAR, comSenha: true })).resolves.toEqual({ token: TOKEN, senha: "482913" });
  });

  it("senha nova: vai com a dona da sessão e a prova, e devolve a senha", async () => {
    novaSenhaDoLink.mockResolvedValue("482913");
    await expect(daDona().meetings.novaSenhaDoLink({ meetingId: ID })).resolves.toEqual({ senha: "482913" });
    expect(novaSenhaDoLink).toHaveBeenCalledWith("dona-1", ID, PROVA);
  });

  it(`senha nova: ${SENHAS_DO_LINK_POR_JANELA} a cada 10 minutos por dona; a recusa do serviço não gasta vaga`, async () => {
    novaSenhaDoLink.mockRejectedValue(new LinkAbertoRecusado("NOT_FOUND", "Reunião não encontrada."));
    for (let i = 0; i < SENHAS_DO_LINK_POR_JANELA + 5; i++) {
      await expect(daDona().meetings.novaSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    novaSenhaDoLink.mockReset();
    novaSenhaDoLink.mockResolvedValue("482913");
    for (let i = 0; i < SENHAS_DO_LINK_POR_JANELA; i++) await daDona().meetings.novaSenhaDoLink({ meetingId: ID });
    await expect(daDona().meetings.novaSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(novaSenhaDoLink).toHaveBeenCalledTimes(SENHAS_DO_LINK_POR_JANELA);
    // O teto é de cada dona.
    await expect(daDona("dona-2").meetings.novaSenhaDoLink({ meetingId: ID })).resolves.toEqual({ senha: "482913" });
  });

  it("tirar a senha e mudar o áudio vão com a dona da sessão; a recusa sai com o código que a tela traduz", async () => {
    tirarSenhaDoLink.mockResolvedValue(undefined);
    mudarAudioDoLink.mockResolvedValue(undefined);
    await expect(daDona().meetings.tirarSenhaDoLink({ meetingId: ID })).resolves.toEqual({ success: true });
    expect(tirarSenhaDoLink).toHaveBeenCalledWith("dona-1", ID, PROVA);
    await expect(daDona().meetings.mudarAudioDoLink({ meetingId: ID, incluirAudio: false })).resolves.toEqual({ success: true });
    expect(mudarAudioDoLink).toHaveBeenCalledWith("dona-1", ID, false, PROVA);
    await expect(daDona().meetings.mudarAudioDoLink({ meetingId: ID } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    tirarSenhaDoLink.mockRejectedValue(new LinkAbertoRecusado("PRECONDITION_FAILED", "O link desta reunião está desligado."));
    await expect(daDona().meetings.tirarSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    mudarAudioDoLink.mockRejectedValue(new LinkAbertoRecusado("NOT_FOUND", "Reunião não encontrada."));
    await expect(daDona("outra").meetings.mudarAudioDoLink({ meetingId: ID, incluirAudio: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sem sessão, nada disso: UNAUTHORIZED, sem chegar ao serviço", async () => {
    const { caller } = visitante();
    await expect(caller.meetings.novaSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.meetings.tirarSenhaDoLink({ meetingId: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.meetings.mudarAudioDoLink({ meetingId: ID, incluirAudio: false })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(novaSenhaDoLink).not.toHaveBeenCalled();
    expect(tirarSenhaDoLink).not.toHaveBeenCalled();
    expect(mudarAudioDoLink).not.toHaveBeenCalled();
  });

  it("o id da reunião é um uuid: o resto é BAD_REQUEST", async () => {
    await expect(daDona().meetings.novaSenhaDoLink({ meetingId: "../outra" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(novaSenhaDoLink).not.toHaveBeenCalled();
  });
});
