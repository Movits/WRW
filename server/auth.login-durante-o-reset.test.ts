import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Login em andamento durante a redefinição de senha. O reset derruba as sessões
 * que existem quando ele roda, e um login que conferiu a senha ANTIGA e grava a
 * sessão depois disso escapava, com 8 h de acesso para quem o reset queria tirar.
 * Agora loginUser relê a senha da conta depois de gravar a sessão: se ela mudou,
 * a sessão cai e o login é recusado como senha errada. O login e o reset daqui
 * são as rotas de verdade, sobre um banco em memória.
 */

const SENHAS = vi.hoisted(() => ({
  antiga: "senha-antiga-123",
  nova: "senha-nova-456",
  hashAntigo: "hash-da-senha-antiga",
  hashNovo: "hash-da-senha-nova",
}));

type Sessao = { userId: number; sessionToken: string; isActive: boolean };

const banco = vi.hoisted(() => ({
  conta: {} as Record<string, unknown>,
  linkGasto: false,
  sessoes: [] as Sessao[],
  /** Roda uma vez, logo antes de o login gravar a sessão: o reset que cai nessa janela. */
  antesDeGravarASessao: null as null | (() => Promise<void>),
}));

vi.mock("./db", async importOriginal => {
  const dialeto = new MySqlDialect();
  /** A coluna e o valor de um `eq(coluna, valor)`; outro filtro não casa com nada. */
  const igualdade = (filtro: unknown) => {
    const { sql, params } = dialeto.sqlToQuery(filtro as SQL);
    return { coluna: /^`\w+`\.`(\w+)` = \?$/.exec(sql)?.[1], valor: params[0] };
  };
  const falso = {
    select: (campos?: Record<string, unknown>) => ({
      from: (tabela: Table) => ({
        where: (filtro: unknown) => ({
          limit: async () => {
            const nome = getTableName(tabela);
            // O link do reset: vale até ser gasto (o WHERE de verdade fica em auth.redefinir-senha.test.ts).
            if (nome === "password_reset_tokens") return banco.linkGasto ? [] : [{ id: 9, userId: 7 }];
            if (nome !== "users") throw new Error(`SELECT inesperado em ${nome}`);
            const { coluna, valor } = igualdade(filtro);
            if (!coluna || banco.conta[coluna] !== valor) return [];
            const linha = { ...banco.conta };
            return [campos ? Object.fromEntries(Object.keys(campos).map(c => [c, linha[c]])) : linha];
          },
        }),
      }),
    }),
    update: (tabela: Table) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (filtro: unknown) => {
          const nome = getTableName(tabela);
          if (nome === "password_reset_tokens") {
            const alcancou = !banco.linkGasto;
            banco.linkGasto = true;
            return [{ affectedRows: alcancou ? 1 : 0 }, undefined];
          }
          if (nome === "users") {
            Object.assign(banco.conta, valores);
            return [{ affectedRows: 1 }, undefined];
          }
          if (nome !== "sessions") throw new Error(`UPDATE inesperado em ${nome}`);
          // As sessões da conta (a revogação do reset) ou uma só, pelo token.
          const { coluna, valor } = igualdade(filtro);
          if (coluna !== "userId" && coluna !== "sessionToken") throw new Error(`filtro inesperado em sessions: ${coluna}`);
          const alcancadas = banco.sessoes.filter(s => s[coluna] === valor);
          for (const sessao of alcancadas) Object.assign(sessao, valores);
          return [{ affectedRows: alcancadas.length }, undefined];
        },
      }),
    }),
    insert: (tabela: Table) => ({
      values: async (valores: Record<string, unknown>) => {
        const nome = getTableName(tabela);
        if (nome === "audit_logs") return;
        if (nome !== "sessions") throw new Error(`INSERT inesperado em ${nome}`);
        const reset = banco.antesDeGravarASessao;
        banco.antesDeGravarASessao = null;
        if (reset) await reset();
        banco.sessoes.push({
          userId: valores.userId as number,
          sessionToken: valores.sessionToken as string,
          isActive: valores.isActive as boolean,
        });
      },
    }),
    transaction: async (tarefa: (tx: object) => Promise<unknown>): Promise<unknown> => tarefa(falso),
  };
  return { ...(await importOriginal<typeof import("./db")>()), exigirDb: async () => falso };
});

// O bloqueio por tentativas não é o assunto daqui; a revogação e a auditoria são as de verdade.
vi.mock("./security", async importOriginal => ({
  ...(await importOriginal<typeof import("./security")>()),
  checkLoginRateLimit: async () => ({ allowed: true, remainingAttempts: 5 }),
  recordLoginAttempt: async () => undefined,
}));

// Cada senha confere só com o próprio hash; o custo do bcrypt não muda a ordem dos passos.
vi.mock("bcryptjs", () => {
  const hash = async () => SENHAS.hashNovo;
  const compare = async (senha: string, hash: string) =>
    (senha === SENHAS.antiga && hash === SENHAS.hashAntigo) || (senha === SENHAS.nova && hash === SENHAS.hashNovo);
  return { default: { hash, compare }, hash, compare };
});

import { authRouter, tetoDeLogin, tetoDeLoginPorEmail } from "./routers/auth";
import type { TrpcContext } from "./_core/context";

const contexto = () =>
  ({
    user: null,
    req: { headers: { "user-agent": "vitest" }, ip: "203.0.113.7", socket: { remoteAddress: "203.0.113.7" } },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  }) as unknown as TrpcContext;

const entrar = (ctx: TrpcContext) =>
  authRouter.createCaller(ctx).login({ email: "membra@exemplo.test", password: SENHAS.antiga });
const redefinir = () =>
  authRouter.createCaller(contexto()).resetPassword({ token: "f".repeat(96), newPassword: SENHAS.nova });
const ativas = () => banco.sessoes.filter(sessao => sessao.isActive);

beforeEach(() => {
  banco.conta = {
    id: 7,
    openId: "email_x",
    name: "Membra",
    email: "membra@exemplo.test",
    isActive: true,
    passwordHash: SENHAS.hashAntigo,
    role: "silver",
    onboardingCompleted: true,
  };
  banco.linkGasto = false;
  banco.sessoes = [];
  banco.antesDeGravarASessao = null;
  tetoDeLogin.esquecer();
  tetoDeLoginPorEmail.esquecer();
});

describe("login com a senha antiga em andamento durante a redefinição de senha", () => {
  it("reset entre a conferência da senha e a gravação da sessão: a sessão cai, o login é recusado como senha errada e nenhum cookie sai", async () => {
    let respostaDoReset: unknown;
    banco.antesDeGravarASessao = async () => {
      respostaDoReset = await redefinir();
    };
    const ctx = contexto();

    await expect(entrar(ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "E-mail ou senha incorretos." });

    // O reset foi até o fim antes de a sessão ser gravada.
    expect(respostaDoReset).toEqual({ success: true });
    expect(banco.conta.passwordHash).toBe(SENHAS.hashNovo);
    // A sessão nasceu depois da revogação do reset, e o próprio login a derrubou.
    expect(banco.sessoes).toHaveLength(1);
    expect(ativas()).toEqual([]);
    expect(ctx.res.cookie).not.toHaveBeenCalled();
  });

  it("sem reset no meio, o login entra: a sessão fica ativa e o cookie sai", async () => {
    const ctx = contexto();
    await expect(entrar(ctx)).resolves.toMatchObject({ success: true });

    expect(ativas()).toHaveLength(1);
    expect(ctx.res.cookie).toHaveBeenCalledTimes(1);
  });

  it("reset depois do login: a revogação do reset derruba a sessão que já existia", async () => {
    await expect(entrar(contexto())).resolves.toMatchObject({ success: true });
    expect(ativas()).toHaveLength(1);

    await expect(redefinir()).resolves.toEqual({ success: true });
    expect(banco.sessoes).toHaveLength(1);
    expect(ativas()).toEqual([]);
  });
});
