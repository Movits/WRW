import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Os códigos de erro de auth.resetPassword. A tela de redefinir a senha decide
 * por eles (client/src/pages/ResetPassword.tsx): BAD_REQUEST é o link vencido ou
 * inválido, e TOO_MANY_REQUESTS (a fila do bcrypt cheia) é "muitas entradas ao
 * mesmo tempo, aguarde segundos". Se a rota passasse a embrulhar a fila cheia
 * num BAD_REQUEST, quem tem um link válido leria "link inválido", pediria
 * outro, e o pedido novo cancelaria o link que ainda valia. O mesmo contrato,
 * para o login e o cadastro, está em auth.limite-por-ip.test.ts. A rota só grava
 * (gasta o link e troca a senha, numa transação) depois do hash, que passa pela
 * fila: com a fila cheia, nada é gravado e o link continua valendo (a transação,
 * as sessões e a auditoria: auth.redefinir-senha.test.ts).
 */

type Gravacao = { tabela: string; valores: Record<string, unknown>; filtro: unknown };
const banco = vi.hoisted(() => ({ linhas: [] as unknown[], gravacoes: [] as Gravacao[] }));
const fila = vi.hoisted(() => ({ executar: vi.fn() }));

vi.mock("./db", async importOriginal => {
  const falso = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => banco.linhas }) }) }),
    // Guarda O QUE foi gravado e ONDE, e não só quantas vezes. Devolve o
    // cabeçalho do mysql2 com a linha alcançada: o link só é gasto quando o
    // UPDATE condicional o alcança.
    update: (tabela: Table) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (filtro: unknown) => {
          banco.gravacoes.push({ tabela: getTableName(tabela), valores, filtro });
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    // A auditoria do reset também conta como gravação.
    insert: (tabela: Table) => ({
      values: async (valores: Record<string, unknown>) => {
        banco.gravacoes.push({ tabela: getTableName(tabela), valores, filtro: null });
      },
    }),
    // O link e a senha vão numa transação, aqui sobre o mesmo banco falso. O
    // que ela desfaz quando lança é assunto de auth.redefinir-senha.test.ts.
    transaction: async (tarefa: (tx: object) => Promise<unknown>): Promise<unknown> => tarefa(falso),
  };
  return { ...(await importOriginal<typeof import("./db")>()), exigirDb: async () => falso };
});

vi.mock("./fila-do-bcrypt", () => ({ filaDoBcrypt: { executar: fila.executar } }));

import { authRouter } from "./routers/auth";
import type { TrpcContext } from "./_core/context";

const contexto = {
  user: null,
  req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
  res: { cookie: vi.fn(), clearCookie: vi.fn() },
} as unknown as TrpcContext;

// O id do token e o da conta diferentes, para a troca de um pelo outro aparecer.
const TOKEN_VALIDO = { id: 9, userId: 7 };
const redefinir = (newPassword = "senha123") =>
  authRouter.createCaller(contexto).resetPassword({ token: "x".repeat(20), newPassword });
const parametros = (filtro: unknown) => new MySqlDialect().sqlToQuery(filtro as SQL).params;

beforeEach(() => {
  banco.linhas = [];
  banco.gravacoes = [];
  fila.executar.mockReset();
});

describe("auth.resetPassword — os códigos de que a tela depende", () => {
  it("a fila do bcrypt cheia chega como TOO_MANY_REQUESTS com a mensagem, e não como link inválido", async () => {
    banco.linhas = [TOKEN_VALIDO];
    const cheia = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas entradas e cadastros ao mesmo tempo." });
    fila.executar.mockRejectedValueOnce(cheia);
    await expect(redefinir()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: cheia.message });
    // Nada foi gravado: a senha não mudou e o token continua valendo.
    expect(banco.gravacoes).toEqual([]);
  });

  it("sem token válido no banco (vencido, usado ou inexistente) chega como BAD_REQUEST, sem passar pela fila", async () => {
    await expect(redefinir()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fila.executar).not.toHaveBeenCalled();
    expect(banco.gravacoes).toEqual([]);
  });

  it("senha de 7 caracteres é recusada pela entrada (BAD_REQUEST); a tela barra antes de enviar", async () => {
    banco.linhas = [TOKEN_VALIDO];
    await expect(redefinir("senha12")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fila.executar).not.toHaveBeenCalled();
  });

  it("com o link válido, grava o hash na conta dona do link e marca aquele token como usado", async () => {
    banco.linhas = [TOKEN_VALIDO];
    // Como a fila de verdade: roda a tarefa que a rota entrega (o bcrypt de custo 12).
    fila.executar.mockImplementationOnce((tarefa: () => Promise<unknown>) => tarefa());
    await expect(redefinir()).resolves.toEqual({ success: true });
    expect(fila.executar).toHaveBeenCalledTimes(1);

    const senha = banco.gravacoes.find(g => g.tabela === "users");
    expect(Object.keys(senha?.valores ?? {})).toEqual(["passwordHash"]);
    const gravado = senha!.valores.passwordHash as string;
    // O hash da senha NOVA, e não a senha em texto puro nem o hash de outra coisa.
    expect(gravado).not.toBe("senha123");
    expect(await bcrypt.compare("senha123", gravado)).toBe(true);
    expect(bcrypt.getRounds(gravado)).toBe(12);
    expect(parametros(senha!.filtro)).toEqual([TOKEN_VALIDO.userId]);

    const token = banco.gravacoes.find(g => g.tabela === "password_reset_tokens");
    expect(token?.valores.usedAt).toBeInstanceOf(Date);
    expect(parametros(token!.filtro)).toEqual([TOKEN_VALIDO.id]);
  });
});
