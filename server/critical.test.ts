/**
 * Testes críticos para as procedures principais da WRW
 * Cobre: auth.register, auth.login, opportunities.create, admin.grantGold
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// server/auth.ts exige JWT_SECRET já na carga do módulo — vi.hoisted roda antes dos imports
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

// Banco dublado: estes testes provam AUTORIZAÇÃO e VALIDAÇÃO, não SQL. Sem o
// dublê, "allows role update when user is gold" executava um UPDATE de verdade
// em users.id = 2 no banco do .env de trabalho (que já foi o de produção).
const dbFalso: any = new Proxy(function () {}, {
  get: (_alvo, prop) => {
    if (prop === "then") return undefined; // não é uma Promise: `await` devolve o próprio dublê
    if (prop === "chamadas") return chamadas;
    return (...args: unknown[]) => {
      chamadas.push({ metodo: String(prop), args });
      return dbFalso;
    };
  },
  apply: () => dbFalso,
});
const chamadas: { metodo: string; args: unknown[] }[] = [];
vi.mock("./db", async () => {
  const { BancoIndisponivel } = await import("./banco-indisponivel");
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_alvo, prop) => {
        if (prop === "getDb") return async () => dbFalso;
        if (prop === "exigirDb") return async () => dbFalso;
        if (prop === "then" || prop === Symbol.toStringTag) return undefined;
        if (prop === "BancoIndisponivel") return BancoIndisponivel;
        return async () => undefined; // getUserByEmail etc.: "não existe"
      },
    }
  );
});
vi.mock("./security", () => ({
  createAuditLog: async () => {},
  createSecurityEvent: async () => {},
  checkLoginRateLimit: async () => ({ allowed: true }),
  recordLoginAttempt: async () => {},
}));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { TRPCError } from "@trpc/server";

// ─── Helpers ────────────────────────────────────────────────────────────────

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: { "user-agent": "vitest", "x-forwarded-for": "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(overrides: Partial<AuthenticatedUser> = {}): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user-openid",
    email: "test@frauen.com",
    name: "Test User",
    loginMethod: "email",
    role: "silver",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
  return {
    user,
    req: {
      protocol: "https",
      headers: { "user-agent": "vitest", "x-forwarded-for": "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createPresidentContext(): TrpcContext {
  return createAuthContext({ id: 99, role: "president", email: "president@frauen.com", name: "Presidente" });
}

// ─── auth.register ──────────────────────────────────────────────────────────

describe("auth.register", () => {
  it("rejects registration with password shorter than 8 characters", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.register({ name: "Ana Silva", email: "ana@test.com", password: "123" })
    ).rejects.toThrow();
  });

  it("rejects registration with invalid email format", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.register({ name: "Ana Silva", email: "not-an-email", password: "senha1234" })
    ).rejects.toThrow();
  });

  it("rejects registration with name too short", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.register({ name: "A", email: "ana@test.com", password: "senha1234" })
    ).rejects.toThrow();
  });
});

// ─── auth.login ─────────────────────────────────────────────────────────────

describe("auth.login", () => {
  it("rejects login with empty password", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.login({ email: "ana@test.com", password: "" })
    ).rejects.toThrow();
  });

  it("rejects login with invalid email format", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.login({ email: "not-valid", password: "senha1234" })
    ).rejects.toThrow();
  });
});

// ─── auth.me ────────────────────────────────────────────────────────────────

describe("auth.me", () => {
  it("returns null for unauthenticated users", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("returns user data for authenticated users", async () => {
    const ctx = createAuthContext({ id: 5, name: "Maria Santos", email: "maria@frauen.com" });
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).not.toBeNull();
    expect(result?.email).toBe("maria@frauen.com");
    expect(result?.name).toBe("Maria Santos");
  });
});

// ─── opportunities.create ───────────────────────────────────────────────────

describe("opportunities.create", () => {
  it("rejects creation when user is not authenticated", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.opportunities.create({
        title: "Parceria Internacional",
        description: "Oportunidade de parceria estratégica entre empresas de tecnologia.",
        type: "partnership",
        sector: "Tecnologia",
        country: "BR",
        isConfidential: false,
      })
    ).rejects.toThrow();
  });

  it("rejects creation with title too short", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.opportunities.create({
        title: "AB",
        description: "Descrição válida com mais de 20 caracteres para o teste.",
        type: "partnership",
        sector: "Tecnologia",
        country: "BR",
        isConfidential: false,
      })
    ).rejects.toThrow();
  });

  it("rejects creation with description too short", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.opportunities.create({
        title: "Título Válido da Oportunidade",
        description: "Curta",
        type: "partnership",
        sector: "Tecnologia",
        country: "BR",
        isConfidential: false,
      })
    ).rejects.toThrow();
  });
});

// ─── admin.updateUserRole (Gold Access) ─────────────────────────────────────

describe("admin.updateUserRole (Gold Access)", () => {
  it("rejects role update when user is not admin or president", async () => {
    const ctx = createAuthContext({ role: "silver" });
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.updateUserRole({ userId: 2, role: "gold" })
    ).rejects.toThrow();
  });

  it("allows role update when user is gold (Ouro = Presidente)", async () => {
    // Ouro = Presidente: membras Ouro têm acesso ao painel de governança e podem atualizar roles
    chamadas.length = 0;
    const ctx = createAuthContext({ role: "gold" });
    const caller = appRouter.createCaller(ctx);
    // Gold deve poder atualizar roles (não deve rejeitar), e o UPDATE vai para o dublê
    await expect(
      caller.admin.updateUserRole({ userId: 2, role: "president" })
    ).resolves.toMatchObject({ success: true });
    expect(chamadas.some(c => c.metodo === "update")).toBe(true);
  });
});

// ─── profile.get ────────────────────────────────────────────────────────────

describe("profile.get", () => {
  it("rejects profile query when user is not authenticated", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.profile.get()).rejects.toThrow();
  });
});

// ─── opportunities.list ─────────────────────────────────────────────────────

describe("opportunities.list", () => {
  it("rejects listing when user is not authenticated", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.opportunities.list({})).rejects.toThrow();
  });
});
