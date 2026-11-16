import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * O bloqueio por tentativas (checkLoginRateLimit e recordLoginAttempt, em
 * server/security.ts) conta a última hora pelo relógio do BANCO: `updatedAt` é
 * gravado por ele, no fuso dele. A comparação antiga, com uma data do Node, só
 * acertava com o banco em UTC; no MariaDB local, em America/Buenos_Aires,
 * nenhuma tentativa caía na janela e o bloqueio nunca chegava (achado na A6). O
 * MariaDB do CI roda em UTC, e lá a comparação errada também passaria nos
 * testes de integração: por isso este teste prende o SQL do filtro.
 */

const banco = vi.hoisted(() => ({ filtros: [] as unknown[] }));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  exigirDb: async () => ({
    select: () => ({
      from: () => ({
        where: (filtro: unknown) => {
          banco.filtros.push(filtro);
          return { limit: async () => [] };
        },
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  }),
}));

import { checkLoginRateLimit, recordLoginAttempt } from "./security";

const consulta = (filtro: unknown) => new MySqlDialect().sqlToQuery(filtro as SQL);

beforeEach(() => {
  banco.filtros = [];
});

describe("a janela do bloqueio por tentativas é a última hora pelo relógio do banco", () => {
  it.each([
    ["checkLoginRateLimit", () => checkLoginRateLimit("membra@exemplo.test", "203.0.113.9")],
    ["recordLoginAttempt", () => recordLoginAttempt("membra@exemplo.test", "203.0.113.9", false)],
  ])("%s: `updatedAt` >= NOW() - INTERVAL 1 HOUR, e nenhuma data do Node nos parâmetros", async (_nome, chamar) => {
    await chamar();

    expect(banco.filtros).toHaveLength(1);
    const { sql, params } = consulta(banco.filtros[0]);
    expect(sql).toMatch(/`login_attempts`\.`updatedAt` >= NOW\(\) - INTERVAL 1 HOUR/);
    expect(params).toEqual(["membra@exemplo.test", "203.0.113.9"]);
    expect(params.some(valor => valor instanceof Date)).toBe(false);
  });
});
