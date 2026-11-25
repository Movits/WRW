import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O link aberto da reunião nos routers: reuniaoAberta.* (público, sem sessão)
 * e meetings.ligarLinkAberto / desligarLinkAberto (da dona). O módulo do link,
 * a IA, o resumo guardado (a leitura e o pedido) e a tradução são dublados; as consultas de verdade estão em
 * link-aberto-da-reuniao.integracao.test.ts, e o caminho da tradução até a IA
 * em meeting-service.test.ts.
 */

const exigirReuniaoDoLink = vi.fn();
const verReuniaoPeloLink = vi.fn();
const ligarLinkAbertoComOpcoes = vi.fn();
const desligarLinkAberto = vi.fn();
const pedirResumoPeloLink = vi.fn();
const resumoGuardadoPeloLink = vi.fn();
const perguntarAReuniao = vi.fn();
const translatePrivateMeetingTranscript = vi.fn();
const createAuditLog = vi.fn();

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./link-aberto-da-reuniao")>(),
  exigirReuniaoDoLink: (...args: unknown[]) => exigirReuniaoDoLink(...args),
  verReuniaoPeloLink: (...args: unknown[]) => verReuniaoPeloLink(...args),
  ligarLinkAbertoComOpcoes: (...args: unknown[]) => ligarLinkAbertoComOpcoes(...args),
  desligarLinkAberto: (...args: unknown[]) => desligarLinkAberto(...args),
}));
vi.mock("./reuniao-com-ia", async importOriginal => ({
  ...await importOriginal<typeof import("./reuniao-com-ia")>(),
  perguntarAReuniao: (...args: unknown[]) => perguntarAReuniao(...args),
}));
vi.mock("./resumo-guardado", async importOriginal => ({
  ...await importOriginal<typeof import("./resumo-guardado")>(),
  pedirResumoPeloLink: (...args: unknown[]) => pedirResumoPeloLink(...args),
  resumoGuardadoPeloLink: (...args: unknown[]) => resumoGuardadoPeloLink(...args),
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
const {
  MENSAGEM_TRADUCAO_INDISPONIVEL,
  PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA,
  PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA,
  tetoDaIADoLinkAberto,
  tetoDaIADoVisitanteDoLink,
} = await import("./routers/reuniaoAberta");
const { LinkAbertoRecusado, MENSAGEM_LINK_NAO_ENCONTRADO } = await import("./link-aberto-da-reuniao");
const { MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR, RecusaDaReuniaoComIA } = await import("./reuniao-com-ia");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { MENSAGEM_BANCO_INDISPONIVEL } = await import("@shared/const");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const OUTRO_TOKEN = "ZyXwVuTsRqPoNmLkJiHgFeDcBa987654";
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OUTRA_REUNIAO = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REUNIAO = { id: ID, ownerId: "dona-1", title: "Reunião de teste", createdAt: 1_700_000_000_000 };
const PENDENTE = { estado: "pendente", emoji: null, itens: [] };
const NAO_RESPONDIDA = { respondida: false };
const LIGAR = {
  meetingId: ID, autorizacaoDasPessoas: true as const, idioma: "de" as const,
  textoExibido: "Ich bestätige, dass alle Personen, die in diesem Meeting gesprochen haben, zugestimmt haben.",
};

// O IP da visitante sai de req.ip fora do Render (server/ip-da-cliente.ts).
const semSessao = (ip = "203.0.113.10") => appRouter.createCaller({
  user: null, req: { headers: {}, ip, socket: {} }, res: { cookie: () => {}, clearCookie: () => {} },
} as never);
const daDona = (openId = "dona-1") => appRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: { "user-agent": "Navegador de teste" }, ip: "198.51.100.7", socket: {} },
  res: { cookie: () => {}, clearCookie: () => {} },
} as never);

const linkNaoEncontrado = () => new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_LINK_NAO_ENCONTRADO);
const pedirResumo = (token = TOKEN, ip?: string) => semSessao(ip).reuniaoAberta.pedirResumo({ token });
const perguntar = (token = TOKEN, ip?: string) => semSessao(ip).reuniaoAberta.perguntar({ token, idioma: "pt-BR", pergunta: "Quem falou?" });

beforeEach(() => {
  tetoDaIADoLinkAberto.esquecer();
  tetoDaIADoVisitanteDoLink.esquecer();
  for (const duble of [exigirReuniaoDoLink, verReuniaoPeloLink, ligarLinkAbertoComOpcoes, desligarLinkAberto, pedirResumoPeloLink, resumoGuardadoPeloLink, perguntarAReuniao, translatePrivateMeetingTranscript, createAuditLog]) {
    duble.mockReset();
  }
  // TOKEN e OUTRO_TOKEN abrem a MESMA reunião: é o caso da variação de caixa
  // num banco que não distingue maiúsculas, e o do link religado pela dona.
  exigirReuniaoDoLink.mockImplementation(async (token: string) => {
    if (token === TOKEN || token === OUTRO_TOKEN) return REUNIAO;
    if (token === "token-de-outra-reuniao-0123456789") return { ...REUNIAO, id: OUTRA_REUNIAO };
    throw linkNaoEncontrado();
  });
  // Como o serviço real: acha a reunião pelo token e, para o resumo que ainda
  // não existe, gasta a vaga dela antes de criar o trabalho.
  pedirResumoPeloLink.mockImplementation(async (token: string, antesDeCriar: (reuniaoId: string) => void) => {
    const reuniao = await exigirReuniaoDoLink(token);
    antesDeCriar(reuniao.id);
    return PENDENTE;
  });
  perguntarAReuniao.mockResolvedValue(NAO_RESPONDIDA);
});
afterEach(() => { vi.useRealTimers(); });

describe("reuniaoAberta — público, sem sessão", () => {
  it("ver devolve o que o serviço monta para o link, com os nomes das vozes (H3b)", async () => {
    const vista = { titulo: "Reunião de teste", criadaEm: 1, transcricao: null, gravacao: null, gravacaoExpirada: false, vozes: { F1: "Ana" } };
    verReuniaoPeloLink.mockResolvedValue(vista);
    await expect(semSessao().reuniaoAberta.ver({ token: TOKEN })).resolves.toEqual(vista);
    expect(verReuniaoPeloLink).toHaveBeenCalledWith(TOKEN);
  });

  it("link que não existe ou foi desligado sai como NOT_FOUND, com a frase do serviço", async () => {
    verReuniaoPeloLink.mockRejectedValue(linkNaoEncontrado());
    await expect(semSessao().reuniaoAberta.ver({ token: "cortado" })).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_LINK_NAO_ENCONTRADO });
    await expect(pedirResumo("cortado")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(perguntar("cortado")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(perguntarAReuniao).not.toHaveBeenCalled();
  });

  it("o pedido do resumo vai ao serviço com o token, e a pergunta com a dona e a reunião DO LINK, nunca com algo vindo de quem pede", async () => {
    await expect(semSessao().reuniaoAberta.pedirResumo({ token: TOKEN })).resolves.toEqual(PENDENTE);
    await semSessao().reuniaoAberta.perguntar({ token: TOKEN, idioma: "ja", pergunta: "  Qual o prazo?  " });
    expect(pedirResumoPeloLink).toHaveBeenCalledWith(TOKEN, expect.any(Function));
    expect(exigirReuniaoDoLink).toHaveBeenCalledWith(TOKEN);
    // O último argumento toma a vaga a mais da reunião longa (ver o teto, abaixo).
    expect(perguntarAReuniao).toHaveBeenCalledWith("dona-1", ID, "Qual o prazo?", "ja", expect.any(Function));
  });

  it("o resumo a pedido de antes (reuniaoAberta.resumir) saiu do router: pelo link, o resumo é o guardado", () => {
    const procedimentos = appRouter._def.procedures;
    // Os vizinhos estão no mesmo registro: a ausência é do procedimento, não da forma da chave.
    expect("reuniaoAberta.resumoGuardado" in procedimentos).toBe(true);
    expect("reuniaoAberta.pedirResumo" in procedimentos).toBe(true);
    expect("reuniaoAberta.resumir" in procedimentos).toBe(false);
  });

  it("resumoGuardado aceita o token até 128 caracteres; acima disso é BAD_REQUEST, sem chegar ao serviço", async () => {
    resumoGuardadoPeloLink.mockResolvedValue(PENDENTE);
    await expect(semSessao().reuniaoAberta.resumoGuardado({ token: "x".repeat(129) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(resumoGuardadoPeloLink).not.toHaveBeenCalled();
    await expect(semSessao().reuniaoAberta.resumoGuardado({ token: "x".repeat(128) })).resolves.toEqual(PENDENTE);
    expect(resumoGuardadoPeloLink).toHaveBeenCalledWith("x".repeat(128));
  });

  it("a tradução vai com a dona e a reunião do link e leva o teto como antesDeChamarAIA", async () => {
    translatePrivateMeetingTranscript.mockResolvedValue({ language: "en", text: "Talk.", cached: true });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" })).resolves.toEqual({ language: "en", text: "Talk.", cached: true });
    expect(translatePrivateMeetingTranscript).toHaveBeenCalledWith("dona-1", ID, "en", expect.any(Function));
  });

  it("o link aceita pedir pt-BR: a reunião pode ter sido gravada em outro idioma (G1b)", async () => {
    translatePrivateMeetingTranscript.mockResolvedValue({ language: "pt-BR", text: "Fala.", cached: false });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "pt-BR" })).resolves.toEqual({ language: "pt-BR", text: "Fala.", cached: false });
    expect(translatePrivateMeetingTranscript).toHaveBeenCalledWith("dona-1", ID, "pt-BR", expect.any(Function));
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "it" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("falha da IA na tradução vira SERVICE_UNAVAILABLE com frase neutra: a mensagem do provedor não sai para quem não tem conta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    translatePrivateMeetingTranscript.mockRejectedValue(new Error("LLM invoke failed: 401 chave-secreta-do-provedor"));
    const erro = await semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" }).catch(e => e);
    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_INDISPONIVEL });
    expect(String(erro.message)).not.toContain("chave-secreta");
    // O log fica com a causa, sem o token, que abre a reunião.
    const registrado = vi.mocked(console.error).mock.calls.map(c => c.join(" ")).join("\n");
    expect(registrado).toContain("chave-secreta-do-provedor");
    expect(registrado).not.toContain(TOKEN);
  });

  it("na tradução, o teto e o banco fora do ar saem como são, não como falha da IA", async () => {
    translatePrivateMeetingTranscript.mockImplementationOnce(async (_d: string, _i: string, _l: string, antes: () => void) => {
      for (let i = 0; i <= PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) antes();
      return { language: "en", text: "x", cached: false };
    });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    translatePrivateMeetingTranscript.mockRejectedValueOnce(new BancoIndisponivel());
    await expect(semSessao("203.0.113.99").reuniaoAberta.traduzir({ token: TOKEN, language: "en" }))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
  });

  it("a dona não precisa de sessão para nada disso, mas ligar e desligar o link pedem sessão", async () => {
    verReuniaoPeloLink.mockResolvedValue({});
    await expect(semSessao().reuniaoAberta.ver({ token: TOKEN })).resolves.toEqual({});
    await expect(semSessao().meetings.ligarLinkAberto(LIGAR)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().meetings.desligarLinkAberto({ meetingId: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(ligarLinkAbertoComOpcoes).not.toHaveBeenCalled();
    expect(desligarLinkAberto).not.toHaveBeenCalled();
  });
});

describe(`reuniaoAberta — teto da IA: ${PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA} por visitante e ${PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA} por reunião, a cada 10 minutos`, () => {
  it("visitante: pedido de resumo novo, pergunta e tradução nova somam; passado o teto, TOO_MANY_REQUESTS sem chamar a IA; outro visitante passa", async () => {
    translatePrivateMeetingTranscript.mockImplementation(async (_d: string, _i: string, language: string, antes?: () => void) => {
      antes?.();
      return { language, text: "x", cached: false };
    });
    await pedirResumo();
    await pedirResumo();
    await semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "es" });
    for (let i = 3; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar();

    await expect(pedirResumo()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "fr" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA - 3);

    await expect(pedirResumo(TOKEN, "203.0.113.11")).resolves.toEqual(PENDENTE);
    await expect(perguntar(TOKEN, "203.0.113.11")).resolves.toEqual(NAO_RESPONDIDA);
  });

  it("o balde é da REUNIÃO, não do token: outra grafia do token (ou o link religado) não abre balde novo", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar(i % 2 ? TOKEN : OUTRO_TOKEN);
    await expect(perguntar(OUTRO_TOKEN)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar(TOKEN)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Outra reunião tem os próprios baldes.
    await expect(perguntar("token-de-outra-reuniao-0123456789")).resolves.toEqual(NAO_RESPONDIDA);
  });

  it(`reunião: ${PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA} no total entre visitantes; depois, nem quem ainda não pediu passa`, async () => {
    const visitantes = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA;
    for (let v = 0; v < visitantes; v++) {
      for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar(TOKEN, `203.0.113.${100 + v}`);
    }
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA);
    await expect(perguntar(TOKEN, "198.51.100.200")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA);
  });

  it("tradução que já está guardada não gasta vaga", async () => {
    translatePrivateMeetingTranscript.mockResolvedValue({ language: "en", text: "x", cached: true });
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA + 5; i++) await semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" });
    await expect(perguntar()).resolves.toEqual(NAO_RESPONDIDA);
  });

  it("link que não abre não gasta vaga de quem tem o link certo", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA + 5; i++) {
      await expect(perguntar("nenhuma-reuniao-tem-este-token-x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(perguntar()).resolves.toEqual(NAO_RESPONDIDA);
  });

  it("a janela é de 10 minutos", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar();
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 - 1);
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000);
    await expect(perguntar()).resolves.toEqual(NAO_RESPONDIDA);
  });
});

describe("meetings.ligarLinkAberto e desligarLinkAberto — só a dona, com auditoria", () => {
  it("ligar exige a palavra da dona de que as pessoas da reunião autorizaram", async () => {
    for (const entrada of [
      { ...LIGAR, autorizacaoDasPessoas: undefined },
      { ...LIGAR, autorizacaoDasPessoas: false },
      // Sem a frase que a dona viu (ou com idioma fora da lista), não há prova.
      { ...LIGAR, textoExibido: "   " },
      { ...LIGAR, idioma: "xx" },
    ]) {
      await expect(daDona().meetings.ligarLinkAberto(entrada as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(ligarLinkAbertoComOpcoes).not.toHaveBeenCalled();
  });

  it("ligado, devolve o token; a prova (quem, IP, navegador) vai ao serviço, que a grava na mesma transação", async () => {
    ligarLinkAbertoComOpcoes.mockResolvedValue({ token: TOKEN, senha: null });
    await expect(daDona().meetings.ligarLinkAberto(LIGAR)).resolves.toEqual({ token: TOKEN, senha: null });
    // A aba de antes da H23 não manda as escolhas do link: o serviço liga sem senha e com o áudio.
    expect(ligarLinkAbertoComOpcoes).toHaveBeenCalledWith("dona-1", ID, {
      userId: 7, ipAddress: "198.51.100.7", userAgent: "Navegador de teste", idioma: "de", textoExibido: LIGAR.textoExibido,
    }, { comSenha: undefined, incluirAudio: undefined });
    // A aba de antes da H3b não manda a versão: o serviço grava 1.
    expect(ligarLinkAbertoComOpcoes.mock.calls[0][2].versaoDaAutorizacao).toBeUndefined();
    // Não há um segundo registro, que pudesse sumir em silêncio depois de o link ligar.
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("a caixa que fala dos nomes das vozes manda a versão 2, e ela vai ao serviço com a prova (H3b)", async () => {
    ligarLinkAbertoComOpcoes.mockResolvedValue({ token: TOKEN, senha: null });
    await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, versaoDaAutorizacao: 2 })).resolves.toEqual({ token: TOKEN, senha: null });
    expect(ligarLinkAbertoComOpcoes).toHaveBeenCalledWith("dona-1", ID, expect.objectContaining({ versaoDaAutorizacao: 2, textoExibido: LIGAR.textoExibido }), expect.anything());
  });

  it("versão que não é a 2 é BAD_REQUEST: a tela não inventa versão, e a aba velha não manda nenhuma", async () => {
    for (const versaoDaAutorizacao of [1, 3, "2", null]) {
      await expect(daDona().meetings.ligarLinkAberto({ ...LIGAR, versaoDaAutorizacao } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(ligarLinkAbertoComOpcoes).not.toHaveBeenCalled();
  });

  it("recusado pelo serviço, sai com o código que a tela traduz", async () => {
    ligarLinkAbertoComOpcoes.mockRejectedValue(new LinkAbertoRecusado("PRECONDITION_FAILED", "Só dá para compartilhar uma reunião pronta."));
    await expect(daDona().meetings.ligarLinkAberto(LIGAR)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
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

describe("reuniaoAberta.perguntar — a pergunta sobre reunião longa gasta 2 vagas do teto da reunião (H6)", () => {
  // Como o serviço real: lida a transcrição, avisa se a reunião é longa antes de chamar a IA.
  const comReuniao = (longa: boolean) => perguntarAReuniao.mockImplementation(
    async (_dona: string, _id: string, _pergunta: string, _idioma: string, antesDeChamarAIA?: (custo: { longa: boolean }) => void) => {
      antesDeChamarAIA?.({ longa });
      return NAO_RESPONDIDA;
    });
  // Visitantes diferentes, para o teto de cada uma (10) não ser o que recusa.
  const ip = (n: number) => `203.0.113.${Math.floor(n / PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA) + 1}`;

  it(`${PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / 2} perguntas longas enchem o teto da reunião; depois, nem a longa nem a curta passam`, async () => {
    comReuniao(true);
    const longas = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / 2;
    for (let i = 0; i < longas; i++) await expect(perguntar(TOKEN, ip(i))).resolves.toEqual(NAO_RESPONDIDA);
    await expect(perguntar(TOKEN, "198.51.100.20")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    comReuniao(false);
    await expect(perguntar(TOKEN, "198.51.100.21")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(perguntarAReuniao).toHaveBeenCalledTimes(longas);
  });

  it(`a pergunta curta segue gastando uma vaga: ${PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA} por reunião`, async () => {
    comReuniao(false);
    for (let i = 0; i < PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA; i++) await expect(perguntar(TOKEN, ip(i))).resolves.toEqual(NAO_RESPONDIDA);
    await expect(perguntar(TOKEN, "198.51.100.20")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("recusada a segunda vaga, a primeira volta: a recusa não gasta vaga", async () => {
    comReuniao(true);
    const longas = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / 2 - 1;
    for (let i = 0; i < longas; i++) await perguntar(TOKEN, ip(i));
    comReuniao(false);
    await perguntar(TOKEN, "198.51.100.20");
    // Sobra uma vaga: a pergunta longa toma a primeira, esbarra na segunda e a devolve.
    comReuniao(true);
    await expect(perguntar(TOKEN, "198.51.100.21")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // A vaga devolvida serve à pergunta curta, da mesma visitante.
    comReuniao(false);
    await expect(perguntar(TOKEN, "198.51.100.21")).resolves.toEqual(NAO_RESPONDIDA);
    await expect(perguntar(TOKEN, "198.51.100.22")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it(`o teto da visitante conta uma por pergunta, longa ou não: ${PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA} por visitante`, async () => {
    comReuniao(true);
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await expect(perguntar(TOKEN, "203.0.113.1")).resolves.toEqual(NAO_RESPONDIDA);
    await expect(perguntar(TOKEN, "203.0.113.1")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar(TOKEN, "203.0.113.2")).resolves.toEqual(NAO_RESPONDIDA);
  });

  it("reunião longa demais para perguntar: PAYLOAD_TOO_LARGE, o código que a tela traduz, e a recusa gasta UMA vaga de cada teto (leu o banco, não chamou a IA)", async () => {
    // Como o serviço real: a recusa vem antes do antesDeChamarAIA.
    perguntarAReuniao.mockRejectedValue(new RecusaDaReuniaoComIA("PAYLOAD_TOO_LARGE", MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR));
    // A visitante: as recusas dela enchem o teto dela (com zero vaga por recusa, a 11ª passaria).
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) {
      await expect(perguntar(TOKEN, ip(i))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR });
    }
    await expect(perguntar(TOKEN, ip(0))).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // A reunião: uma vaga por recusa, nem zero nem duas. Só a 61ª é recusada pelo teto.
    for (let i = PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i < PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA; i++) {
      await expect(perguntar(TOKEN, ip(i))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    }
    await expect(perguntar(TOKEN, "198.51.100.40")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA);
  });
});

describe("reuniaoAberta — a recusa de um teto não gasta a vaga do outro", () => {
  it("reunião cheia: a visitante nova é recusada sem perder vaga, e passa quando a reunião esvazia", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const visitantes = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA;
    for (let v = 0; v < visitantes; v++) {
      for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar(TOKEN, `203.0.113.${100 + v}`);
    }
    // Aos 9 minutos, a visitante nova bate na reunião cheia, muitas vezes.
    vi.setSystemTime(1_700_000_000_000 + 9 * 60_000);
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) {
      await expect(perguntar(TOKEN, "198.51.100.50")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    }
    // Aos 10 minutos a reunião esvazia, e o balde dela continua inteiro.
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000);
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await expect(perguntar(TOKEN, "198.51.100.50")).resolves.toEqual(NAO_RESPONDIDA);
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA + PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA);
  });

  it("visitante no limite: as recusas dela não gastam a vaga comum da reunião", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await perguntar(TOKEN, "203.0.113.1");
    for (let i = 0; i < 100; i++) await expect(perguntar(TOKEN, "203.0.113.1")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Sobram as 50 vagas comuns para as outras visitantes.
    const restantes = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA - PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA;
    for (let i = 0; i < restantes; i++) await perguntar(TOKEN, `198.51.100.${i % 50 + 1}`);
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA);
  });
});

describe("reuniaoAberta.traduzir — banco é banco, rede da IA é IA", () => {
  const comCausa = (erro: Error, causa: object) => Object.assign(erro, { cause: Object.assign(new Error("socket"), causa) });

  it("falha de rede com o provedor de IA (fetch failed, ECONNREFUSED na causa) vira SERVICE_UNAVAILABLE, não 'banco indisponível'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    translatePrivateMeetingTranscript.mockRejectedValue(comCausa(new TypeError("fetch failed"), { code: "ECONNREFUSED" }));
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" }))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_INDISPONIVEL });
  });

  it("a queda do banco numa consulta (DrizzleQueryError com ECONNREFUSED) segue como banco indisponível", async () => {
    const consulta = Object.assign(new Error("Failed query: select `id` from `meeting_transcripts` where ..."), { query: "select `id` from `meeting_transcripts` where ..." });
    translatePrivateMeetingTranscript.mockRejectedValue(comCausa(consulta, { code: "ECONNREFUSED" }));
    await expect(semSessao().reuniaoAberta.traduzir({ token: TOKEN, language: "en" }))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
  });
});
