import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { meetings } from "../../drizzle/schema";
import { apagarPelaChave } from "./apagar-pela-chave";

/**
 * A forma dos DELETEs da limpeza dos testes de integração
 * (server/test/apagar-pela-chave.ts): um por linha, pela chave. É a forma que
 * não deixa o otimizador varrer a tabela. Com `id IN (...)` cobrindo quase a
 * tabela toda (banco de testes pequeno), o plano vira "ALL" e o DELETE trava
 * cada linha e vão de `meetings`, como o DELETE pela dona fazia: foi o deadlock
 * do INSERT do link aberto. A trava contra o banco real está no
 * apagar-pela-chave.integracao.test.ts.
 */
function bancoFalso(ids: string[]) {
  const deletes: Array<{ sql: string; params: unknown[] }> = [];
  const dialeto = new MySqlDialect();
  const banco = {
    select: () => ({ from: () => ({ where: async () => ids.map(id => ({ id })) }) }),
    delete: () => ({
      where: async (condicao: unknown) => {
        const { sql, params } = dialeto.sqlToQuery(condicao as never);
        deletes.push({ sql, params });
        return [{ affectedRows: 1 }, []];
      },
    }),
  };
  return { banco: banco as never, deletes };
}

describe("apagarPelaChave", () => {
  it("um DELETE por linha, pela chave, e nunca pela condição nem por uma lista de ids", async () => {
    const { banco, deletes } = bancoFalso(["a", "b", "c"]);
    expect(await apagarPelaChave(banco, meetings, eq(meetings.ownerId, "dona"))).toBe(3);
    expect(deletes).toEqual([
      { sql: "`meetings`.`id` = ?", params: ["a"] },
      { sql: "`meetings`.`id` = ?", params: ["b"] },
      { sql: "`meetings`.`id` = ?", params: ["c"] },
    ]);
  });

  it("nada achado: nenhum DELETE", async () => {
    const { banco, deletes } = bancoFalso([]);
    expect(await apagarPelaChave(banco, meetings, eq(meetings.ownerId, "dona"))).toBe(0);
    expect(deletes).toEqual([]);
  });
});
