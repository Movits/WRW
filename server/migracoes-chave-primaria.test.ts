import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O MySQL de produção (Aiven) roda com `sql_require_primary_key` e recusa
 * `CREATE TABLE` sem chave primária. O MariaDB do CI não tem essa trava, então
 * a migração passava aqui e derrubava o deploy lá: foi o que aconteceu com a
 * 0030 em 25/11/2026 (a `importacao_documentos_vistos` tinha só índice único).
 * Este teste lê cada migração e exige a chave primária em toda tabela criada.
 */
const PASTA = join(__dirname, "..", "drizzle");

function tabelasSemChavePrimaria(): string[] {
  const faltas: string[] = [];
  for (const arquivo of readdirSync(PASTA).filter(nome => nome.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(PASTA, arquivo), "utf8");
    for (const comando of sql.split("--> statement-breakpoint")) {
      const criacao = comando.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`([^`]+)`/i);
      if (criacao && !/PRIMARY KEY/i.test(comando)) faltas.push(`${arquivo}: ${criacao[1]}`);
    }
  }
  return faltas;
}

describe("migrações: toda tabela nasce com chave primária", () => {
  it("nenhum CREATE TABLE sem PRIMARY KEY (o Aiven recusa)", () => {
    expect(tabelasSemChavePrimaria()).toEqual([]);
  });
});
