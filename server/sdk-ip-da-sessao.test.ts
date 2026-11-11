import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * A detecção de anomalia compara o IP da requisição com o que o login gravou
 * na sessão. O login passou a gravar o IP real (ipDaCliente: CF-Connecting-IP
 * no Render); se o sdk continuasse lendo o primeiro item do X-Forwarded-For,
 * quem está atrás de um proxy que acrescenta esse cabeçalho pareceria vir de IP
 * novo em toda requisição — um SUSPICIOUS_ACCESS de risco alto a cada uma.
 */

const dubles = vi.hoisted(() => ({
  detectSessionAnomaly: vi.fn(async (_userId: number, _ip: string, _ua: string) => undefined),
}));

vi.mock("./security", () => ({
  validateSession: vi.fn(),
  validateSessionToken: vi.fn(async () => 7),
  createAuditLog: vi.fn(async () => undefined),
  createSecurityEvent: vi.fn(async () => undefined),
  detectSessionAnomaly: dubles.detectSessionAnomaly,
}));

vi.mock("./db", () => ({
  getUserByOpenId: vi.fn(async () => ({ id: 7, openId: "email_x", isActive: true })),
  upsertUser: vi.fn(async () => undefined),
}));

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "./_core/sdk";

describe("sdk.authenticateRequest: o IP da anomalia é o mesmo que o login grava", () => {
  beforeEach(() => {
    process.env.RENDER = "true";
    dubles.detectSessionAnomaly.mockClear();
  });
  afterEach(() => {
    delete process.env.RENDER;
  });

  it("no Render, usa o CF-Connecting-IP, não o primeiro item do X-Forwarded-For", async () => {
    const cookie = await sdk.signSession({ openId: "email_x", appId: "mmm-os", name: "Membra" });
    const req = {
      headers: {
        cookie: `${COOKIE_NAME}=${cookie}`,
        "cf-connecting-ip": "198.51.100.23",
        "x-forwarded-for": "10.1.2.3, 198.51.100.23, 10.226.0.9",
        "user-agent": "vitest",
      },
      ip: "10.226.0.9",
      socket: { remoteAddress: "10.226.0.9" },
    };

    await sdk.authenticateRequest(req as never);

    // O quarto argumento é o sessionToken: o token do sdk.signSession não leva um.
    expect(dubles.detectSessionAnomaly).toHaveBeenCalledWith(7, "198.51.100.23", "vitest", null);
  });
});

/**
 * Revisão da PR #179: o sdk entrega à detecção de anomalia o sessionToken do
 * token do login, e é com ele que a sessão passa a conhecer o IP novo depois
 * do alerta (server/security.ts). Sem este fio, o alerta de IP novo voltaria
 * a sair em toda requisição de quem trocou de rede, pelos 90 dias da sessão.
 */
describe("sdk.authenticateRequest: o sessionToken do login chega à detecção de anomalia", () => {
  beforeEach(() => dubles.detectSessionAnomaly.mockClear());

  it("token com sessionToken: o quarto argumento é ele", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ openId: "email_x", appId: "mmm-os", name: "Membra", sessionToken: "s".repeat(64) })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = {
      headers: { cookie: `${COOKIE_NAME}=${token}`, "user-agent": "vitest" },
      ip: "203.0.113.9",
      socket: { remoteAddress: "203.0.113.9" },
    };

    await sdk.authenticateRequest(req as never);

    expect(dubles.detectSessionAnomaly).toHaveBeenCalledWith(7, expect.any(String), "vitest", "s".repeat(64));
  });
});
