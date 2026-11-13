import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * O sdk.authenticateRequest confere no banco a sessão de toda usuária: é o que
 * faz sair, redefinir a senha, desativar e excluir a conta valerem na hora. O
 * token (JWT) sem sessionToken (o do assinador antigo do sdk, com 1 ano de
 * validade, ou um token da época do Manus) passava sem essa conferência e
 * escapava da revogação — com a sessão de 90 dias, pesava ainda mais. Agora ele
 * é recusado como a sessão revogada, quem o tinha precisa entrar de novo, e o
 * cron (openId `cron_`, claim taskUid) segue como estava.
 */

const dubles = vi.hoisted(() => ({
  validateSessionToken: vi.fn(async (_token: string): Promise<number | null> => 7),
  createAuditLog: vi.fn(async (_dados: Record<string, unknown>) => undefined),
  detectSessionAnomaly: vi.fn(async (_userId: number, _ip: string, _ua: string, _token?: string | null) => undefined),
  getUserByOpenId: vi.fn(async (_openId: string): Promise<unknown> => ({ id: 7, openId: "email_x", isActive: true })),
  upsertUser: vi.fn(async (_dados: Record<string, unknown>) => undefined),
}));

vi.mock("./security", () => ({
  validateSession: vi.fn(),
  validateSessionToken: dubles.validateSessionToken,
  createAuditLog: dubles.createAuditLog,
  createSecurityEvent: vi.fn(async () => undefined),
  detectSessionAnomaly: dubles.detectSessionAnomaly,
}));

vi.mock("./db", () => ({
  getUserByOpenId: dubles.getUserByOpenId,
  upsertUser: dubles.upsertUser,
  exigirDb: async () => {
    throw new Error("este teste não grava sessão");
  },
}));

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { HttpError } from "@shared/_core/errors";
import { sdk } from "./_core/sdk";
import { createContext } from "./_core/context";

const SEGREDO = new TextEncoder().encode(process.env.JWT_SECRET);
const DA_USUARIA = { openId: "email_x", appId: "mmm-os", name: "Membra" };
const TOKEN_DA_SESSAO = "a1".repeat(32);

/** Um JWT assinado com o segredo de verdade, com as claims dadas. */
const jwt = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setExpirationTime("1h").sign(SEGREDO);

/** O formato exato do assinador antigo do sdk: sem sessionToken, sem iat e com 1 ano de validade. */
const jwtDoAssinadorAntigo = () =>
  new SignJWT({ ...DA_USUARIA })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor((Date.now() + ONE_YEAR_MS) / 1000))
    .sign(SEGREDO);

const requisicao = (cookie: string) =>
  ({
    headers: { cookie: `${COOKIE_NAME}=${cookie}`, "user-agent": "vitest" },
    protocol: "https",
    ip: "203.0.113.7",
    socket: { remoteAddress: "203.0.113.7" },
  }) as never;

/** O erro da autenticação, ou falha o teste se ela passou. */
async function recusa(cookie: string): Promise<HttpError> {
  const resultado = await sdk.authenticateRequest(requisicao(cookie)).then(
    usuaria => ({ passou: usuaria }),
    (erro: unknown) => ({ erro }),
  );
  expect(resultado, "a autenticação deveria ter sido recusada").toHaveProperty("erro");
  const { erro } = resultado as { erro: unknown };
  expect(erro).toBeInstanceOf(HttpError);
  return erro as HttpError;
}

beforeEach(() => {
  for (const duble of Object.values(dubles)) duble.mockClear();
  dubles.validateSessionToken.mockImplementation(async () => 7);
});

describe("token de usuária sem sessionToken é recusado", () => {
  it("403, a auditoria registra o motivo próprio sem o token, e nada segue (sem conferência no banco nem lastSignedIn)", async () => {
    const cookie = await jwt(DA_USUARIA);

    const erro = await recusa(cookie);

    expect(erro).toMatchObject({ statusCode: 403, message: "Session missing sessionToken" });
    expect(dubles.validateSessionToken).not.toHaveBeenCalled();
    expect(dubles.detectSessionAnomaly).not.toHaveBeenCalled();
    expect(dubles.upsertUser).not.toHaveBeenCalled();
    expect(dubles.createAuditLog).toHaveBeenCalledTimes(1);
    expect(dubles.createAuditLog).toHaveBeenCalledWith({
      userId: 7,
      action: "REVOKED_SESSION_ACCESS_ATTEMPT",
      resource: "auth",
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
      status: "failure",
      riskLevel: "high",
      details: { reason: "Token JWT válido mas sem sessionToken: não há sessão no banco para conferir" },
    });
    // O motivo não é o da sessão revogada, e o token não vai para a trilha.
    const auditoria = JSON.stringify(dubles.createAuditLog.mock.calls);
    expect(auditoria).not.toContain("sessão revogada");
    expect(auditoria).not.toContain(cookie);
    expect(auditoria).not.toContain(cookie.split(".")[2]);
  });

  it("o formato exato do assinador antigo do sdk (1 ano, sem iat) também é recusado", async () => {
    const erro = await recusa(await jwtDoAssinadorAntigo());

    expect(erro).toMatchObject({ statusCode: 403, message: "Session missing sessionToken" });
    expect(dubles.validateSessionToken).not.toHaveBeenCalled();
    expect(dubles.upsertUser).not.toHaveBeenCalled();
  });

  it.each([
    ["vazio", ""],
    ["número", 123],
    ["nulo", null],
  ])("sessionToken %s conta como ausente", async (_nome, valor) => {
    const erro = await recusa(await jwt({ ...DA_USUARIA, sessionToken: valor }));

    expect(erro).toMatchObject({ statusCode: 403, message: "Session missing sessionToken" });
    expect(dubles.validateSessionToken).not.toHaveBeenCalled();
  });

  it("conta desativada continua recusada antes, com a mensagem de sempre", async () => {
    dubles.getUserByOpenId.mockResolvedValueOnce({ id: 7, openId: "email_x", isActive: false });

    const erro = await recusa(await jwt(DA_USUARIA));

    expect(erro).toMatchObject({ statusCode: 403, message: "Esta conta foi desativada. Entre em contato com o suporte." });
    expect(dubles.createAuditLog).not.toHaveBeenCalled();
  });

  it("o assinador antigo saiu do sdk", () => {
    expect((sdk as unknown as Record<string, unknown>).signSession).toBeUndefined();
  });

  it("no createContext: sem usuária, o cookie sai do navegador e nada é renovado (quem o tinha precisa entrar de novo)", async () => {
    const res = { cookie: vi.fn(), clearCookie: vi.fn() };

    const ctx = await createContext({ req: requisicao(await jwtDoAssinadorAntigo()), res } as never);

    expect(ctx.user).toBeNull();
    expect(ctx.bancoIndisponivel).toBe(false);
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ maxAge: -1, httpOnly: true, path: "/" }));
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe("token com sessionToken: a conferência no banco de sempre", () => {
  it("sessão ativa: passa, o banco confere aquele token e a usuária volta", async () => {
    const cookie = await jwt({ ...DA_USUARIA, sessionToken: TOKEN_DA_SESSAO });

    await expect(sdk.authenticateRequest(requisicao(cookie))).resolves.toMatchObject({ id: 7, openId: "email_x" });
    expect(dubles.validateSessionToken).toHaveBeenCalledWith(TOKEN_DA_SESSAO);
    expect(dubles.detectSessionAnomaly).toHaveBeenCalledWith(7, "203.0.113.7", "vitest", TOKEN_DA_SESSAO);
    expect(dubles.createAuditLog).not.toHaveBeenCalled();
    expect(dubles.upsertUser).toHaveBeenCalledTimes(1);
  });

  it("sessão revogada: 403 como antes, com o motivo da revogação", async () => {
    dubles.validateSessionToken.mockImplementation(async () => null);

    const erro = await recusa(await jwt({ ...DA_USUARIA, sessionToken: TOKEN_DA_SESSAO }));

    expect(erro).toMatchObject({ statusCode: 403, message: "Session has been revoked" });
    expect(dubles.validateSessionToken).toHaveBeenCalledWith(TOKEN_DA_SESSAO);
    expect(dubles.createAuditLog).toHaveBeenCalledTimes(1);
    expect(dubles.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "REVOKED_SESSION_ACCESS_ATTEMPT",
        details: { reason: "Token JWT válido mas sessão revogada no banco" },
      }),
    );
    expect(dubles.upsertUser).not.toHaveBeenCalled();
  });
});

describe("token que vence entre as duas verificações do JWT", () => {
  // O sdk confere o JWT no verifySession e de novo ao ler o sessionToken, com a
  // consulta da conta no meio. O token que vence nesse intervalo tem
  // sessionToken: só venceu. É recusado como qualquer token vencido, sem a
  // auditoria de token sem sessionToken, que acusaria um token antigo ou forjado.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Um JWT com sessionToken que vence no segundo `exp`, com o relógio parado 200 ms antes. */
  async function tokenPrestesAVencer() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const exp = Math.floor(Date.now() / 1000) + 60;
    vi.setSystemTime(exp * 1000 - 200);
    const cookie = await new SignJWT({ ...DA_USUARIA, sessionToken: TOKEN_DA_SESSAO })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(SEGREDO);
    return { cookie, exp };
  }

  it("vence durante a consulta da conta: 403 de cookie inválido, sem auditoria, e a falha vai ao log sem o token", async () => {
    const { cookie, exp } = await tokenPrestesAVencer();
    // A consulta da conta demora, e o prazo do token passa enquanto isso.
    dubles.getUserByOpenId.mockImplementationOnce(async () => {
      vi.setSystemTime(exp * 1000 + 100);
      return { id: 7, openId: "email_x", isActive: true };
    });
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const erro = await recusa(cookie);

      expect(erro).toMatchObject({ statusCode: 403, message: "Invalid session cookie" });
      // A primeira verificação passou: a conta chegou a ser consultada.
      expect(dubles.getUserByOpenId).toHaveBeenCalledTimes(1);
      expect(dubles.createAuditLog).not.toHaveBeenCalled();
      expect(dubles.validateSessionToken).not.toHaveBeenCalled();
      expect(dubles.upsertUser).not.toHaveBeenCalled();
      expect(aviso).toHaveBeenCalledWith(
        "[Auth] Session verification failed",
        expect.stringContaining('"exp" claim timestamp check failed'),
      );
      expect(JSON.stringify(aviso.mock.calls)).not.toContain(TOKEN_DA_SESSAO);
    } finally {
      aviso.mockRestore();
    }
  });

  it("controle: o mesmo token, sem o prazo passar durante a consulta, entra e a sessão é conferida no banco", async () => {
    const { cookie } = await tokenPrestesAVencer();

    await expect(sdk.authenticateRequest(requisicao(cookie))).resolves.toMatchObject({ id: 7, openId: "email_x" });
    expect(dubles.validateSessionToken).toHaveBeenCalledWith(TOKEN_DA_SESSAO);
    expect(dubles.createAuditLog).not.toHaveBeenCalled();
  });
});

describe("o cron segue como estava", () => {
  it("openId cron_ com taskUid passa sem sessionToken e sem tocar o banco", async () => {
    const cookie = await jwt({ openId: "cron_limpeza", appId: "mmm-os", name: "Tarefa", taskUid: "uid-1" });

    await expect(sdk.authenticateRequest(requisicao(cookie))).resolves.toMatchObject({
      id: -1,
      openId: "cron_limpeza",
      isCron: true,
      taskUid: "uid-1",
    });
    expect(dubles.getUserByOpenId).not.toHaveBeenCalled();
    expect(dubles.validateSessionToken).not.toHaveBeenCalled();
    expect(dubles.createAuditLog).not.toHaveBeenCalled();
  });

  it("cron sem taskUid continua recusado", async () => {
    const erro = await recusa(await jwt({ openId: "cron_limpeza", appId: "mmm-os", name: "Tarefa" }));
    expect(erro).toMatchObject({ statusCode: 403, message: "Cron session missing task_uid" });
  });
});
