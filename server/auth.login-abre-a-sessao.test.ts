import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { DrizzleQueryError } from "drizzle-orm";
import { jwtVerify } from "jose";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * O login por senha passou a abrir a sessão por abrirSessao (server/sessao.ts),
 * o caminho que a passkey vai usar. O que a usuária e o banco veem não muda: a
 * mesma ordem de gravações, a releitura da senha depois de gravar a sessão (PR
 * #176), o mesmo cookie de 90 dias (gravarCookieDaSessao) e as mesmas
 * mensagens. A rota é a de verdade, sobre um banco em memória que anota cada
 * passo.
 */

const banco = vi.hoisted(() => ({
  conta: {} as Record<string, unknown>,
  sessoes: [] as Array<Record<string, unknown>>,
  ordem: [] as string[],
  /** O erro que o INSERT da sessão lança, quando definido. */
  falhaNaSessao: null as null | Error,
}));

vi.mock("./db", async importOriginal => {
  const { getTableName } = await import("drizzle-orm");
  type Tabela = Parameters<typeof getTableName>[0];
  const falso = {
    select: (campos?: Record<string, unknown>) => ({
      from: (tabela: Tabela) => ({
        where: () => ({
          limit: async () => {
            const nome = getTableName(tabela);
            if (nome !== "users") throw new Error(`SELECT inesperado em ${nome}`);
            banco.ordem.push(campos ? `SELECT users (${Object.keys(campos).join(",")})` : "SELECT users");
            const linha = { ...banco.conta };
            return [campos ? Object.fromEntries(Object.keys(campos).map(coluna => [coluna, linha[coluna]])) : linha];
          },
        }),
      }),
    }),
    update: (tabela: Tabela) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async () => {
          banco.ordem.push(`UPDATE ${getTableName(tabela)} (${Object.keys(valores).join(",")})`);
          return [{ affectedRows: 1 }, undefined];
        },
      }),
    }),
    insert: (tabela: Tabela) => ({
      values: async (valores: Record<string, unknown>) => {
        const nome = getTableName(tabela);
        if (nome === "sessions" && banco.falhaNaSessao) throw banco.falhaNaSessao;
        banco.ordem.push(nome === "audit_logs" ? `INSERT audit_logs (${valores.action})` : `INSERT ${nome}`);
        if (nome === "sessions") banco.sessoes.push(valores);
      },
    }),
  };
  return { ...(await importOriginal<typeof import("./db")>()), exigirDb: async () => falso };
});

// O bloqueio por tentativas só anota o passo; a auditoria é a de verdade.
vi.mock("./security", async importOriginal => ({
  ...(await importOriginal<typeof import("./security")>()),
  checkLoginRateLimit: async () => ({ allowed: true, remainingAttempts: 5 }),
  recordLoginAttempt: async (_identificador: string, _chave: string, sucesso: boolean) => {
    banco.ordem.push(`LOGIN_ATTEMPT ${sucesso}`);
  },
}));

import { COOKIE_NAME } from "@shared/const";
import { loginUser } from "./auth";
import { DURACAO_DA_SESSAO_MS } from "./duracao-da-sessao";
import { authRouter, tetoDeLogin, tetoDeLoginPorEmail } from "./routers/auth";
import { identificadorDoAplicativo } from "./sessao";
import type { TrpcContext } from "./_core/context";

const SEGREDO = new TextEncoder().encode(process.env.JWT_SECRET);
const SENHA = "senha-certa-123";
const NOVENTA_DIAS_MS = 90 * 24 * 60 * 60 * 1000;

const contexto = () =>
  ({
    user: null,
    req: { headers: { "user-agent": "vitest" }, ip: "203.0.113.7", socket: { remoteAddress: "203.0.113.7" } },
    res: { cookie: vi.fn(() => banco.ordem.push("COOKIE")), clearCookie: vi.fn() },
  }) as unknown as TrpcContext;

const entrar = (ctx: TrpcContext, password = SENHA) =>
  authRouter.createCaller(ctx).login({ email: "membra@exemplo.test", password });

beforeEach(() => {
  banco.conta = {
    id: 7,
    openId: "email_x",
    name: "Membra",
    email: "membra@exemplo.test",
    isActive: true,
    passwordHash: bcrypt.hashSync(SENHA, 4),
    role: "silver",
    onboardingCompleted: true,
  };
  banco.sessoes = [];
  banco.ordem = [];
  banco.falhaNaSessao = null;
  tetoDeLogin.esquecer();
  tetoDeLoginPorEmail.esquecer();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth.login abre a sessão por abrirSessao, sem mudar o que se vê", () => {
  it("a ordem das gravações é a de antes: tentativa, lastSignedIn, sessão, releitura da senha, cookie, auditoria", async () => {
    const ctx = contexto();

    await expect(entrar(ctx)).resolves.toEqual({
      success: true,
      user: { id: 7, name: "Membra", email: "membra@exemplo.test", role: "silver", onboardingCompleted: true },
    });

    expect(banco.ordem).toEqual([
      "SELECT users",
      "LOGIN_ATTEMPT true",
      "UPDATE users (lastSignedIn)",
      "INSERT sessions",
      "SELECT users (passwordHash)",
      "COOKIE",
      "INSERT audit_logs (LOGIN)",
    ]);
  });

  it("o cookie é o de antes (HttpOnly, lax, 90 dias) e leva o token da sessão gravada", async () => {
    const ctx = contexto();
    const antes = Date.now();
    await entrar(ctx);
    const depois = Date.now();

    expect(banco.sessoes).toHaveLength(1);
    const [sessao] = banco.sessoes;
    expect(sessao).toMatchObject({ userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest", isActive: true });
    expect((sessao.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(antes + NOVENTA_DIAS_MS);
    expect((sessao.expiresAt as Date).getTime()).toBeLessThanOrEqual(depois + NOVENTA_DIAS_MS);

    expect(ctx.res.cookie).toHaveBeenCalledTimes(1);
    const [nome, token, opcoes] = vi.mocked(ctx.res.cookie).mock.calls[0] as unknown as [string, string, object];
    expect(nome).toBe(COOKIE_NAME);
    expect(DURACAO_DA_SESSAO_MS).toBe(NOVENTA_DIAS_MS);
    expect(opcoes).toEqual({ httpOnly: true, path: "/", sameSite: "lax", secure: false, maxAge: NOVENTA_DIAS_MS });

    const { payload } = await jwtVerify(token, SEGREDO, { algorithms: ["HS256"] });
    expect(payload).toMatchObject({ openId: "email_x", appId: identificadorDoAplicativo(), name: "Membra", sessionToken: sessao.sessionToken });
    expect(payload.exp! * 1000).toBeGreaterThanOrEqual(antes + NOVENTA_DIAS_MS - 1000);
    expect(payload.exp! * 1000).toBeLessThanOrEqual(depois + NOVENTA_DIAS_MS);
  });

  it("loginUser devolve o prazo e o token da linha gravada", async () => {
    const { token, user, expiresAt } = await loginUser({ email: "membra@exemplo.test", password: SENHA, ip: "203.0.113.7" });

    expect(user).toMatchObject({ id: 7, openId: "email_x" });
    expect(expiresAt).toBe(banco.sessoes[0].expiresAt);
    const { payload } = await jwtVerify(token, SEGREDO, { algorithms: ["HS256"] });
    expect(payload.sessionToken).toBe(banco.sessoes[0].sessionToken);
  });

  it("senha errada: a mensagem de sempre, sem sessão e sem cookie", async () => {
    const ctx = contexto();

    await expect(entrar(ctx, "errada")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "E-mail ou senha incorretos. (4 tentativas restantes)",
    });
    expect(banco.ordem).toEqual(["SELECT users", "LOGIN_ATTEMPT false"]);
    expect(ctx.res.cookie).not.toHaveBeenCalled();
  });

  it("a sessão não grava: a mensagem de sempre, sem cookie e sem auditoria de LOGIN", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    banco.falhaNaSessao = new DrizzleQueryError(
      "insert into `sessions` (...) values (...)",
      [],
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), { code: "ECONNREFUSED" }),
    );
    const ctx = contexto();

    await expect(entrar(ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Erro interno ao criar sessão. Tente novamente.",
    });
    expect(banco.ordem).toEqual(["SELECT users", "LOGIN_ATTEMPT true", "UPDATE users (lastSignedIn)"]);
    expect(ctx.res.cookie).not.toHaveBeenCalled();
  });
});
