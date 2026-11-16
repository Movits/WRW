import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Banco fora do ar é ERRO, não "sem dados".
 *
 * Antes, getDb() devolvia null e cada helper de db.ts fazia `if (!db) return
 * []`: uma queda do banco aparecia na tela como lista vazia, perfil
 * inexistente, contato apagado. Agora os helpers usam exigirDb(), que lança
 * BancoIndisponivel, e o middleware de server/_core/trpc.ts traduz a exceção
 * numa resposta única para todo procedimento.
 *
 * Só que exigirDb() cobre apenas a conexão NÃO CONFIGURADA. Em produção a
 * DATABASE_URL existe sempre, drizzle(url) cria o pool sem conectar, e a queda
 * real do Aiven chega na primeira query como erro do driver mysql2
 * (ECONNREFUSED, ETIMEDOUT, PROTOCOL_CONNECTION_LOST...) dentro de um
 * DrizzleQueryError. Este arquivo cobre as duas origens e as peças que as
 * tratam: ehErroDeBancoIndisponivel, o middleware, o errorFormatter (o SQL do
 * DrizzleQueryError não pode chegar ao navegador), o contexto, o auth.me, o
 * login, o getGroups e o health.
 */

// db.ts precisa de JWT_SECRET ao carregar. DATABASE_URL sai de propósito para
// getDb() devolver null neste arquivo; cada arquivo de teste tem o próprio
// registro de módulos, então o cache interno de db.ts nasce vazio aqui.
const dubles = vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  delete process.env.DATABASE_URL;
  return {
    getUserById: vi.fn<(id: number) => Promise<unknown>>(),
    loginUser: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    registerUser: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    // Quando definido, getDb/exigirDb entregam este objeto em vez do real.
    bancoFalso: null as null | Record<string, unknown>,
  };
});

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));

// O módulo real, com getDb/exigirDb desviáveis por teste e um helper dublê que
// lança o erro que o driver lançaria com o banco fora do ar.
vi.mock("./db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    getDb: async () => dubles.bancoFalso ?? original.getDb(),
    exigirDb: async () => dubles.bancoFalso ?? original.exigirDb(),
    getUserById: (id: number) => dubles.getUserById(id),
  };
});

vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return {
    ...original,
    loginUser: (...args: unknown[]) => dubles.loginUser(...args),
    registerUser: (...args: unknown[]) => dubles.registerUser(...args),
  };
});

const {
  BancoIndisponivel,
  MENSAGEM_BANCO_INDISPONIVEL,
  MENSAGEM_ERRO_DE_CONSULTA,
  descreverErroDeBanco,
  ehErroDeBancoIndisponivel,
  ehErroDoDriverDeBanco,
} = await import("./banco-indisponivel");
const { exigirDb, getDb, getUserById } = await import("./db");
const { publicProcedure, protectedProcedure, router } = await import("./_core/trpc");
const { createContext } = await import("./_core/context");
const { sdk } = await import("./_core/sdk");
const { authRouter } = await import("./routers/auth");
const { connectionsRouter } = await import("./routers/connections");
const { systemRouter } = await import("./_core/systemRouter");

const semUsuaria = { user: null, req: { headers: {}, socket: {} }, res: { cookie: () => {} } };
const comUsuaria = (role = "silver") => ({
  ...semUsuaria,
  user: { id: 1, openId: "email_teste", email: "t@local", role, isActive: true },
});

// O SQL que o Drizzle põe na mensagem: é o que NÃO pode chegar ao navegador.
const SQL_SENSIVEL = "select `id`, `email`, `passwordHash` from `users` where `users`.`email` = ?";

/** O erro do driver como ele chega de verdade: DrizzleQueryError -> erro com code. */
function erroDoDriver(code: string, mensagem = code, extras: Record<string, unknown> = {}) {
  const causa = Object.assign(new Error(mensagem), { code, ...extras });
  return new DrizzleQueryError(SQL_SENSIVEL, ["ana@exemplo.com"], causa);
}
const quedaDoBanco = () => erroDoDriver("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:3306", { errno: -111 });
const tabelaAusente = () => erroDoDriver("ER_NO_SUCH_TABLE", "Table 'defaultdb.strategic_groups' doesn't exist", { errno: 1146, sqlState: "42S02" });

beforeEach(() => {
  dubles.bancoFalso = null;
  dubles.getUserById.mockReset();
  dubles.loginUser.mockReset();
  dubles.registerUser.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exigirDb", () => {
  it("getDb continua devolvendo null sem conexão; exigirDb lança BancoIndisponivel", async () => {
    expect(await getDb()).toBeNull();
    await expect(exigirDb()).rejects.toBeInstanceOf(BancoIndisponivel);
  });

  it("a mensagem da exceção é a mesma que chega à usuária", () => {
    const erro = new BancoIndisponivel();
    expect(erro.name).toBe("BancoIndisponivel");
    expect(erro.message).toBe(MENSAGEM_BANCO_INDISPONIVEL);
  });
});

describe("ehErroDeBancoIndisponivel reconhece a queda real, não só a classe", () => {
  it.each([
    ["BancoIndisponivel", new BancoIndisponivel()],
    ["DrizzleQueryError com cause ECONNREFUSED", quedaDoBanco()],
    ["cause ETIMEDOUT (connect timeout do mysql2)", erroDoDriver("ETIMEDOUT", "connect ETIMEDOUT")],
    ["cause ENOTFOUND (DNS do Aiven)", erroDoDriver("ENOTFOUND", "getaddrinfo ENOTFOUND mmm-mysql.aivencloud.com")],
    ["cause EAI_AGAIN", erroDoDriver("EAI_AGAIN")],
    ["cause ECONNRESET", erroDoDriver("ECONNRESET", "read ECONNRESET")],
    ["cause PROTOCOL_CONNECTION_LOST", erroDoDriver("PROTOCOL_CONNECTION_LOST", "Connection lost: The server closed the connection.")],
    ["cause ER_CON_COUNT_ERROR (Too many connections)", erroDoDriver("ER_CON_COUNT_ERROR", "Too many connections", { errno: 1040 })],
    ["só o errno 1040, sem code", new DrizzleQueryError("select 1", [], Object.assign(new Error("Too many connections"), { errno: 1040 }))],
    ["mensagem 'connection is in closed state', sem code", new DrizzleQueryError("select 1", [], new Error("Can't add new command when connection is in closed state"))],
    ["pool esgotado ('Queue limit reached.')", new DrizzleQueryError("select 1", [], new Error("Queue limit reached."))],
    ["erro cru do driver, sem o Drizzle por cima", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["TRPCError embrulhando o DrizzleQueryError", new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: quedaDoBanco() })],
    ["AggregateError (IPv4 + IPv6) com ECONNREFUSED dentro", new DrizzleQueryError("select 1", [], Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1:3306"), { code: "ECONNREFUSED" })], "AggregateError"), { code: "ECONNREFUSED" }))],
  ])("%s -> indisponível", (_nome, erro) => {
    expect(ehErroDeBancoIndisponivel(erro)).toBe(true);
  });

  it.each([
    ["tabela ausente (ER_NO_SUCH_TABLE)", tabelaAusente()],
    ["chave duplicada (ER_DUP_ENTRY)", erroDoDriver("ER_DUP_ENTRY", "Duplicate entry", { errno: 1062, sqlState: "23000" })],
    ["coluna inexistente (ER_BAD_FIELD_ERROR)", erroDoDriver("ER_BAD_FIELD_ERROR", "Unknown column", { errno: 1054 })],
    ["SQL inválido (ER_PARSE_ERROR)", erroDoDriver("ER_PARSE_ERROR", "You have an error in your SQL syntax", { errno: 1064 })],
    ["um Error qualquer", new Error("outra coisa")],
    ["TRPCError FORBIDDEN", new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito" })],
    ["null", null],
    ["undefined", undefined],
    ["string", "ECONNREFUSED"],
  ])("%s -> o banco respondeu, não é queda", (_nome, erro) => {
    expect(ehErroDeBancoIndisponivel(erro)).toBe(false);
  });

  it("cadeia de cause circular não trava", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(ehErroDeBancoIndisponivel(a)).toBe(false);
  });
});

describe("ehErroDoDriverDeBanco e descreverErroDeBanco", () => {
  it("reconhece o DrizzleQueryError e o erro de SQL do driver", () => {
    expect(ehErroDoDriverDeBanco(tabelaAusente())).toBe(true);
    expect(ehErroDoDriverDeBanco(quedaDoBanco())).toBe(true);
    expect(ehErroDoDriverDeBanco(Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }))).toBe(true);
    expect(ehErroDoDriverDeBanco(new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: tabelaAusente() }))).toBe(true);
  });

  it("não confunde erro comum com erro do driver", () => {
    expect(ehErroDoDriverDeBanco(new Error("outra coisa"))).toBe(false);
    expect(ehErroDoDriverDeBanco(new TRPCError({ code: "BAD_REQUEST", message: "Token inválido" }))).toBe(false);
    expect(ehErroDoDriverDeBanco(null)).toBe(false);
  });

  it("a descrição para o log traz código e mensagem de cada elo, mas não os parâmetros", () => {
    const texto = descreverErroDeBanco(quedaDoBanco());
    expect(texto).toContain("ECONNREFUSED");
    expect(texto).toContain("Failed query:");
    expect(texto).not.toContain("ana@exemplo.com");
  });
});

describe("o middleware do tRPC traduz a queda do banco", () => {
  const rotas = router({
    cai: publicProcedure.query(async () => { throw new BancoIndisponivel(); }),
    outro: publicProcedure.query(async () => { throw new Error("outra coisa"); }),
    // Um helper de db.ts, mockado, lançando o que o driver lança em produção.
    perfil: protectedProcedure.query(({ ctx }) => getUserById(ctx.user.id)),
    protegido: protectedProcedure.query(async () => "ok"),
  });

  it("BancoIndisponivel (sem DATABASE_URL): INTERNAL_SERVER_ERROR com a frase em português", async () => {
    await expect(rotas.createCaller(semUsuaria as never).cai()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });

  it("erro de conexão do driver (o caso real de produção): a MESMA resposta, e o detalhe no log", async () => {
    dubles.getUserById.mockRejectedValueOnce(quedaDoBanco());
    await expect(rotas.createCaller(comUsuaria() as never).perfil()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("erro de SQL do driver NÃO vira 'banco indisponível'", async () => {
    dubles.getUserById.mockRejectedValueOnce(tabelaAusente());
    await expect(rotas.createCaller(comUsuaria() as never).perfil()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.not.stringContaining(MENSAGEM_BANCO_INDISPONIVEL),
    });
  });

  it("outros erros passam sem ganhar a frase do banco", async () => {
    await expect(rotas.createCaller(semUsuaria as never).outro()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "outra coisa",
    });
  });

  it("procedimento protegido sem sessão: UNAUTHORIZED, como sempre", async () => {
    await expect(rotas.createCaller(semUsuaria as never).protegido()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("protegido com a sessão não lida por causa do banco: banco, e não UNAUTHORIZED", async () => {
    // Sem isto, a usuária logada era mandada para o login enquanto o banco
    // estava fora do ar, e o login respondia "banco indisponível".
    const ctx = { ...semUsuaria, bancoIndisponivel: true };
    await expect(rotas.createCaller(ctx as never).protegido()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });
});

describe("o que chega ao navegador (errorFormatter, pelo adaptador HTTP)", () => {
  const rotas = router({
    consultaQuebrada: publicProcedure.query(async () => { throw tabelaAusente(); }),
    bancoCaiu: publicProcedure.query(async () => { throw quedaDoBanco(); }),
    proibido: publicProcedure.query(async () => { throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito a membras com Status Ouro." }); }),
    limitado: publicProcedure.query(async () => { throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitos pedidos." }); }),
    comum: publicProcedure.query(async () => { throw new Error("outra coisa"); }),
  });

  async function chamar(caminho: string) {
    const resposta = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(`http://localhost/api/trpc/${caminho}`),
      router: rotas,
      createContext: () => semUsuaria as never,
    });
    const corpo = await resposta.json();
    // superjson: o shape do erro vai em error.json
    return { status: resposta.status, erro: corpo.error.json as { message: string; data: Record<string, unknown> }, texto: JSON.stringify(corpo) };
  }

  it("mensagem de DrizzleQueryError com SQL não chega ao client: vira frase neutra, sem stack", async () => {
    const { status, erro, texto } = await chamar("consultaQuebrada");
    expect(status).toBe(500);
    expect(erro.message).toBe(MENSAGEM_ERRO_DE_CONSULTA);
    expect(erro.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(erro.data.stack).toBeUndefined();
    expect(texto).not.toContain("passwordHash");
    expect(texto).not.toContain("Failed query");
    // O detalhe fica no log do servidor.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ER_NO_SUCH_TABLE"));
  });

  it("queda do banco pelo HTTP: a frase em português, e nada do SQL", async () => {
    const { status, erro, texto } = await chamar("bancoCaiu");
    expect(status).toBe(500);
    expect(erro.message).toBe(MENSAGEM_BANCO_INDISPONIVEL);
    expect(erro.data.stack).toBeUndefined();
    expect(texto).not.toContain("passwordHash");
  });

  it("TRPCError lançado de propósito pelo router passa intacto", async () => {
    const { status, erro } = await chamar("proibido");
    expect(status).toBe(403);
    expect(erro.message).toBe("Acesso restrito a membras com Status Ouro.");
    expect(erro.data.path).toBe("proibido");
  });

  it("o limite lançado pela rota chega com o path dela", async () => {
    // As telas do esqueci a senha e da redefinição separam por ele o limite da
    // rota do limite geral da API, que vem SEM path (limite-de-requisicoes.test.ts).
    const { status, erro } = await chamar("limitado");
    expect(status).toBe(429);
    expect(erro.data.code).toBe("TOO_MANY_REQUESTS");
    expect(erro.data.path).toBe("limitado");
  });

  it("erro comum, que não é do banco, mantém a própria mensagem", async () => {
    const { erro } = await chamar("comum");
    expect(erro.message).toBe("outra coisa");
  });
});

describe("createContext", () => {
  const requisicao = { req: { headers: {} }, res: {} } as never;

  it("anota bancoIndisponivel quando a sessão não pôde ser lida por causa do banco", async () => {
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new BancoIndisponivel());
    const ctx = await createContext(requisicao);
    expect(ctx.user).toBeNull();
    expect(ctx.bancoIndisponivel).toBe(true);
  });

  it("anota bancoIndisponivel também quando é o driver que falha (produção)", async () => {
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(quedaDoBanco());
    const ctx = await createContext(requisicao);
    expect(ctx.user).toBeNull();
    expect(ctx.bancoIndisponivel).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("sem sessão nenhuma, o contexto não culpa o banco", async () => {
    vi.mocked(sdk.authenticateRequest).mockRejectedValueOnce(new Error("Invalid session cookie"));
    const ctx = await createContext(requisicao);
    expect(ctx.user).toBeNull();
    expect(ctx.bancoIndisponivel).toBe(false);
  });
});

describe("auth.me", () => {
  it("com a sessão não lida por causa do banco, lança em vez de devolver null", async () => {
    // null é o que o client lê como "não autenticada" e manda para o login.
    const ctx = { ...semUsuaria, bancoIndisponivel: true };
    await expect(authRouter.createCaller(ctx as never).me()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });

  it("sem sessão e com o banco de pé, continua devolvendo null", async () => {
    await expect(authRouter.createCaller(semUsuaria as never).me()).resolves.toBeNull();
  });

  it("com sessão, devolve a usuária sem o passwordHash", async () => {
    const ctx = { ...comUsuaria(), user: { ...comUsuaria().user, passwordHash: "segredo" } };
    const eu = await authRouter.createCaller(ctx as never).me();
    expect(eu).toMatchObject({ id: 1, email: "t@local" });
    expect(eu).not.toHaveProperty("passwordHash");
  });
});

describe("auth.login e auth.register relançam erro de banco", () => {
  const entrada = { email: "ana@exemplo.com", password: "senha-forte-8" };

  it("login: queda do banco vira 'banco indisponível', não UNAUTHORIZED com o texto do driver", async () => {
    dubles.loginUser.mockRejectedValueOnce(quedaDoBanco());
    await expect(authRouter.createCaller(semUsuaria as never).login(entrada)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });

  it("login: erro de SQL do driver não vira UNAUTHORIZED com o SQL na mensagem", async () => {
    dubles.loginUser.mockRejectedValueOnce(tabelaAusente());
    await expect(authRouter.createCaller(semUsuaria as never).login(entrada)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("login: senha errada continua UNAUTHORIZED com a mensagem para a usuária", async () => {
    dubles.loginUser.mockRejectedValueOnce(new Error("E-mail ou senha incorretos."));
    await expect(authRouter.createCaller(semUsuaria as never).login(entrada)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "E-mail ou senha incorretos.",
    });
  });

  it("register: queda do banco vira 'banco indisponível', não BAD_REQUEST", async () => {
    dubles.registerUser.mockRejectedValueOnce(quedaDoBanco());
    await expect(authRouter.createCaller(semUsuaria as never).register({ name: "Ana Prova", ...entrada })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });

  it("register: e-mail repetido continua BAD_REQUEST", async () => {
    dubles.registerUser.mockRejectedValueOnce(new Error("Este e-mail já está cadastrado."));
    await expect(authRouter.createCaller(semUsuaria as never).register({ name: "Ana Prova", ...entrada })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Este e-mail já está cadastrado.",
    });
  });
});

describe("connections.getGroups", () => {
  const bancoQueFalhaCom = (erro: Error) => ({
    select: () => ({ from: () => ({ limit: async () => { throw erro; } }) }),
  });

  it("tabela ausente continua devolvendo lista vazia", async () => {
    dubles.bancoFalso = bancoQueFalhaCom(tabelaAusente());
    await expect(connectionsRouter.createCaller(comUsuaria("gold") as never).getGroups()).resolves.toEqual([]);
  });

  it("queda do banco não vira 'nenhum grupo': sobe como banco indisponível", async () => {
    dubles.bancoFalso = bancoQueFalhaCom(quedaDoBanco());
    await expect(connectionsRouter.createCaller(comUsuaria("gold") as never).getGroups()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: MENSAGEM_BANCO_INDISPONIVEL,
    });
  });
});

describe("system.health", () => {
  const chamar = () => {
    const status = vi.fn();
    const ctx = { ...semUsuaria, res: { status } };
    return { status, resultado: systemRouter.createCaller(ctx as never).health({ timestamp: 1 }) };
  };

  it("sem conexão configurada: ok:false e HTTP 503, sem lançar", async () => {
    const { status, resultado } = chamar();
    await expect(resultado).resolves.toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(503);
  });

  it("SELECT 1 falhando por queda do banco: ok:false e HTTP 503", async () => {
    dubles.bancoFalso = { execute: async () => { throw quedaDoBanco(); } };
    const { status, resultado } = chamar();
    await expect(resultado).resolves.toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(503);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("banco respondendo: ok:true e status intocado", async () => {
    dubles.bancoFalso = { execute: async () => [] };
    const { status, resultado } = chamar();
    await expect(resultado).resolves.toEqual({ ok: true, commit: null });
    expect(status).not.toHaveBeenCalled();
  });
});
