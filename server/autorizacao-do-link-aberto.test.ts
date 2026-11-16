import { describe, expect, it } from "vitest";
import { DrizzleQueryError, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLogs } from "../drizzle/schema";
import { ACAO_LINK_LIGADO, linkMostraOsNomes } from "./autorizacao-do-link-aberto";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";

/**
 * Se o link aberto mostra os nomes das vozes (H3b): a última confirmação da
 * dona, lida da auditoria. Aqui o banco é um dublê que devolve as linhas
 * combinadas e guarda o WHERE, renderizado pelo dialeto do MySQL; a consulta
 * de verdade, contra o MariaDB, está em link-aberto-da-reuniao.integracao.test.ts.
 */

const dialeto = new MySqlDialect();

/** Com `falha`, o banco cai na leitura: o limit rejeita com ela, como o driver faria. */
function bancoCom(linhas: Array<{ details: unknown }>, falha?: unknown) {
  const pedido: { tabela?: unknown; where?: { sql: string; params: unknown[] }; ordem?: unknown; limite?: number } = {};
  const banco = {
    select: () => ({
      from: (tabela: unknown) => {
        pedido.tabela = tabela;
        return {
          where: (condicao: SQL) => {
            const { sql, params } = dialeto.sqlToQuery(condicao);
            pedido.where = { sql, params };
            return {
              orderBy: (ordem: unknown) => {
                pedido.ordem = ordem;
                return {
                  limit: async (n: number) => {
                    pedido.limite = n;
                    if (falha) throw falha;
                    return linhas.slice(0, n);
                  },
                };
              },
            };
          },
        };
      },
    }),
  };
  return { banco: banco as never, pedido };
}

describe("linkMostraOsNomes (H3b)", () => {
  it("só a confirmação da versão 2 mostra os nomes", async () => {
    expect(await linkMostraOsNomes(bancoCom([{ details: { autorizacaoDasPessoas: true, versaoDaAutorizacao: 2 } }]).banco, "reuniao-1")).toBe(true);
  });

  it.each([
    ["a versão 1", [{ details: { autorizacaoDasPessoas: true, versaoDaAutorizacao: 1 } }]],
    ["a linha de antes da H3b, sem a versão", [{ details: { autorizacaoDasPessoas: true, idioma: "pt-BR" } }]],
    ["nenhuma linha", []],
    ["detalhes nulos", [{ details: null }]],
    ["a versão como texto", [{ details: { versaoDaAutorizacao: "2" } }]],
    ["detalhes que não são objeto", [{ details: "versaoDaAutorizacao: 2" }]],
  ])("%s: os nomes não saem", async (_caso, linhas) => {
    expect(await linkMostraOsNomes(bancoCom(linhas).banco, "reuniao-1")).toBe(false);
  });

  it("lê a linha mais nova de ligar o link daquela reunião, pela ação e pelo id da reunião", async () => {
    const { banco, pedido } = bancoCom([]);
    await linkMostraOsNomes(banco, "reuniao-1");
    expect(pedido.tabela).toBe(auditLogs);
    expect(pedido.where).toEqual({
      sql: "(`audit_logs`.`action` = ? and `audit_logs`.`resourceId` = ?)",
      params: [ACAO_LINK_LIGADO, "reuniao-1"],
    });
    expect(ACAO_LINK_LIGADO).toBe("MEETING_OPEN_LINK_ON");
    // A mais nova pelo id, que cresce a cada insert; uma linha só.
    expect(dialeto.sqlToQuery(pedido.ordem as SQL).sql).toBe("`audit_logs`.`id` desc");
    expect(pedido.limite).toBe(1);
  });

  // Banco fora do ar é erro, nunca "sem nomes". Um `.catch(() => false)` aqui
  // faria o link mostrar "Falante n" sem ninguém ver a queda, e o painel da
  // dona mandaria desligar o link e compartilhar de novo, trocando sem motivo
  // o endereço que ela já mandou.
  it("o banco cai na leitura da auditoria: o erro do driver sobe, e não vira 'o link não mostra os nomes'", async () => {
    const queda = new DrizzleQueryError(
      "select `details` from `audit_logs` where (`audit_logs`.`action` = ? and `audit_logs`.`resourceId` = ?) order by `audit_logs`.`id` desc limit ?",
      [ACAO_LINK_LIGADO, "reuniao-1", 1],
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), { code: "ECONNREFUSED" }),
    );
    // É a queda que o resto do servidor reconhece como "banco indisponível".
    expect(ehErroDeBancoIndisponivel(queda)).toBe(true);
    await expect(linkMostraOsNomes(bancoCom([{ details: { versaoDaAutorizacao: 2 } }], queda).banco, "reuniao-1")).rejects.toBe(queda);
  });
});
