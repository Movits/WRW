import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * scripts/migrar.mjs roda no BOOT de produção e não desfaz DDL com rollback.
 * Se a conexão cai depois do primeiro CREATE TABLE de uma migração, a tabela
 * fica criada e a migração sem anotar; no deploy seguinte o mesmo CREATE
 * devolvia ER_TABLE_EXISTS_ERROR, fora da lista tolerada, e todo boot abortava
 * até alguém mexer à mão no banco de produção. Aqui se prova, sem banco
 * (mysql2 é dublê), que a tabela idêntica converge e a homônima de outro
 * desenho continua parando.
 */

const conexaoFalsa = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(async () => {}),
}));

vi.mock("mysql2/promise", () => ({
  default: { createConnection: vi.fn(async () => conexaoFalsa) },
}));

// @ts-expect-error módulo .mjs sem tipos (o tsconfig exclui *.test.ts do pnpm check)
import { comandoJaValiaNoBanco, lerCreateTable, migrar } from "../scripts/migrar.mjs";

const DRIZZLE = join(__dirname, "..", "drizzle");
const lerSql = (tag: string) => readFileSync(join(DRIZZLE, `${tag}.sql`), "utf8");
const comandosDe = (sql: string) => sql.split("--> statement-breakpoint").map(c => c.trim()).filter(Boolean);
const tags: string[] = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8").replace(/^﻿/, ""))
  .entries.map((e: { tag: string }) => e.tag);

type Linha = { COLUMN_NAME: string; COLUMN_TYPE: string };
const linhasDasColunas = (colunas: Map<string, string>): Linha[] =>
  [...colunas].map(([nome, definicao]) => ({ COLUMN_NAME: nome, COLUMN_TYPE: definicao.split(" ")[0] }));

function erroMysql(code: string) {
  return Object.assign(new Error(code), { code });
}

const CREATE_COM_ENUM = [
  "CREATE TABLE `tabela_x` (",
  "\t`id` varchar(36) NOT NULL,",
  "\t`tipo` enum('a','b') NOT NULL,",
  "\tCONSTRAINT `tabela_x_id` PRIMARY KEY(`id`)",
  ");",
].join("\n");

describe("lerCreateTable", () => {
  it("lê nome e colunas de todo CREATE TABLE versionado, inclusive os com CRLF", () => {
    let vistos = 0;
    for (const tag of tags) {
      for (const comando of comandosDe(lerSql(tag))) {
        if (!/^CREATE TABLE/i.test(comando)) continue;
        const criacao = lerCreateTable(comando);
        expect(criacao, `${tag}: ${comando.slice(0, 60)}`).not.toBeNull();
        expect(criacao.colunas.size, `${tag}: ${criacao.tabela}`).toBeGreaterThan(0);
        // Linha de CONSTRAINT não é coluna.
        expect([...criacao.colunas.keys()].some((c: string) => /^CONSTRAINT/i.test(c))).toBe(false);
        vistos++;
      }
    }
    expect(vistos).toBeGreaterThan(1);
  });

  it("não confunde CRLF com parte da definição", () => {
    const criacao = lerCreateTable(CREATE_COM_ENUM.replace(/\n/g, "\r\n"));
    expect(criacao.tabela).toBe("tabela_x");
    expect([...criacao.colunas]).toEqual([
      ["id", "varchar(36) NOT NULL"],
      ["tipo", "enum('a','b') NOT NULL"],
    ]);
  });

  it("devolve null para o que não é CREATE TABLE", () => {
    expect(lerCreateTable("CREATE INDEX `i` ON `t` (`c`);")).toBeNull();
  });
});

describe("comandoJaValiaNoBanco", () => {
  it("coluna e índice duplicados convergem sem consultar o banco", async () => {
    const consultar = vi.fn();
    expect(await comandoJaValiaNoBanco(erroMysql("ER_DUP_FIELDNAME"), "ALTER TABLE ...", consultar, "b")).toEqual({ converge: true });
    expect(await comandoJaValiaNoBanco(erroMysql("ER_DUP_KEYNAME"), "CREATE INDEX ...", consultar, "b")).toEqual({ converge: true });
    expect(consultar).not.toHaveBeenCalled();
  });

  it("outro erro (queda de conexão) não converge", async () => {
    const consultar = vi.fn();
    const veredito = await comandoJaValiaNoBanco(erroMysql("PROTOCOL_CONNECTION_LOST"), CREATE_COM_ENUM, consultar, "b");
    expect(veredito.converge).toBe(false);
    expect(consultar).not.toHaveBeenCalled();
  });

  it("tabela que já existe com as colunas do CREATE converge, conferida no banco certo", async () => {
    const consultar = vi.fn(async () => [
      { COLUMN_NAME: "id", COLUMN_TYPE: "varchar(36)" },
      { COLUMN_NAME: "tipo", COLUMN_TYPE: "enum('a','b','c')" },
    ]);
    const veredito = await comandoJaValiaNoBanco(erroMysql("ER_TABLE_EXISTS_ERROR"), CREATE_COM_ENUM, consultar, "banco_teste");
    expect(veredito).toEqual({ converge: true });
    expect(consultar).toHaveBeenCalledWith(expect.stringContaining("information_schema.COLUMNS"), ["banco_teste", "tabela_x"]);
  });

  it("homônima sem uma coluna do CREATE não converge e diz o que falta", async () => {
    const consultar = vi.fn(async () => [{ COLUMN_NAME: "id", COLUMN_TYPE: "varchar(36)" }]);
    const veredito = await comandoJaValiaNoBanco(erroMysql("ER_TABLE_EXISTS_ERROR"), CREATE_COM_ENUM, consultar, "b");
    expect(veredito.converge).toBe(false);
    expect(veredito.motivo).toContain("coluna tipo");
  });

  it("homônima com enum sem um valor do CREATE não converge", async () => {
    const consultar = vi.fn(async () => [
      { COLUMN_NAME: "id", COLUMN_TYPE: "varchar(36)" },
      { COLUMN_NAME: "tipo", COLUMN_TYPE: "enum('a')" },
    ]);
    const veredito = await comandoJaValiaNoBanco(erroMysql("ER_TABLE_EXISTS_ERROR"), CREATE_COM_ENUM, consultar, "b");
    expect(veredito.converge).toBe(false);
    expect(veredito.motivo).toContain("enum tipo sem b");
  });

  it("tabela que já existe sem o banco a encontrar (nenhuma coluna) não converge", async () => {
    const consultar = vi.fn(async () => []);
    const veredito = await comandoJaValiaNoBanco(erroMysql("ER_TABLE_EXISTS_ERROR"), CREATE_COM_ENUM, consultar, "b");
    expect(veredito.converge).toBe(false);
  });
});

describe("migrar: a migração que caiu depois de um CREATE TABLE se refaz no deploy seguinte", () => {
  // A última migração do journal que cria tabela; as anteriores já constam em _migracoes.
  const indice = tags.map(tag => /^CREATE TABLE/im.test(lerSql(tag))).lastIndexOf(true);
  const tag = tags[indice];
  const primeiroCreate = comandosDe(lerSql(tag)).find(c => /^CREATE TABLE/i.test(c))!;
  const criacao = lerCreateTable(primeiroCreate);

  // Só os espiões de saída são restaurados: no Vitest 2, restoreAllMocks também
  // apagaria a implementação do dublê de createConnection.
  let espioes: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    espioes = [
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    conexaoFalsa.query.mockReset();
  });
  afterEach(() => espioes.forEach(e => e.mockRestore()));

  function montarBanco(colunasNoBanco: Linha[]) {
    conexaoFalsa.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT tag FROM")) return [tags.slice(0, indice).map(t => ({ tag: t }))];
      if (sql === primeiroCreate) throw erroMysql("ER_TABLE_EXISTS_ERROR");
      if (sql.includes("information_schema.COLUMNS")) return [colunasNoBanco];
      return [[]];
    });
  }
  const anotou = (t: string) =>
    conexaoFalsa.query.mock.calls.some(([sql, params]) => String(sql).startsWith("INSERT INTO `_migracoes`") && params?.[0] === t);

  it("pré-condição: há migração com CREATE TABLE para exercitar", () => {
    expect(indice).toBeGreaterThan(0);
    expect(criacao.colunas.size).toBeGreaterThan(0);
  });

  it("tabela idêntica já criada: aplica o resto e anota a migração", async () => {
    montarBanco(linhasDasColunas(criacao.colunas));
    const resultado = await migrar("mysql://u:p@localhost:3306/banco_teste");
    expect(resultado).toEqual({ ok: true, aplicadas: tags.length - indice });
    expect(anotou(tag)).toBe(true);
    expect(conexaoFalsa.end).toHaveBeenCalled();
  });

  it("homônima de outro desenho: para sem anotar a migração", async () => {
    montarBanco(linhasDasColunas(criacao.colunas).slice(1));
    const resultado = await migrar("mysql://u:p@localhost:3306/banco_teste");
    expect(resultado).toEqual({ ok: false, aplicadas: 0 });
    expect(anotou(tag)).toBe(false);
  });
});

describe("migrar: a 0019 do pacote Resumo e IA chega ao banco que recebeu a 0019 de uma das branches", () => {
  // Antes da junção, duas 0019 rodaram em bancos locais: a do P2 (5bd80aa,
  // 0019_resumo-e-ia), com tudo menos a coluna presence, e a do P2B (6b8d690,
  // 0019_qualidade-da-ia), só com ela. O migrar.mjs compara só a tag: a 0019
  // final com a tag de uma delas seria dada como aplicada no banco que recebeu
  // aquela, e ele ficaria sem o que a outra trouxe. Com a do P2, sem a presence,
  // o detalhe da reunião quebra em "Unknown column 'presence'", e o db:migrate e
  // o nivelar-banco dizem que está tudo em dia. Com tag própria, a 0019 final
  // roda nos dois, e o que o banco já tem converge (comandoJaValiaNoBanco).
  const DAS_BRANCHES = [
    { tag: "0019_resumo-e-ia", criou: (comando: string) => !comando.includes("`presence`") },
    { tag: "0019_qualidade-da-ia", criou: (comando: string) => comando.includes("`presence`") },
  ];
  const indice = tags.findIndex(t => t.startsWith("0019_"));
  const final = tags[indice];
  const comandos = comandosDe(lerSql(final));
  // O erro que o MySQL dá ao comando que cria o que o banco já tem.
  const erroDeQuemJaTem = (comando: string) =>
    erroMysql(/^CREATE TABLE/i.test(comando) ? "ER_TABLE_EXISTS_ERROR" : /^CREATE (UNIQUE )?INDEX/i.test(comando) ? "ER_DUP_KEYNAME" : "ER_DUP_FIELDNAME");

  let espioes: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    espioes = [
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    conexaoFalsa.query.mockReset();
  });
  afterEach(() => espioes.forEach(e => e.mockRestore()));

  it("a 0019 final tem tag própria e leva a coluna presence", () => {
    expect(DAS_BRANCHES.map(d => d.tag)).not.toContain(final);
    expect(comandos.filter(c => c.includes("`presence`"))).toHaveLength(1);
  });

  it.each(DAS_BRANCHES)("banco com a $tag: roda a 0019 final, cria só o que faltava e a anota", async ({ tag: daBranch, criou }) => {
    const executados: string[] = [];
    conexaoFalsa.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT tag FROM")) return [[...tags.slice(0, indice), daBranch].map(t => ({ tag: t }))];
      if (comandos.includes(sql)) {
        if (criou(sql)) throw erroDeQuemJaTem(sql);
        executados.push(sql);
        return [[]];
      }
      // A tabela que a 0019 da branch criou, com as colunas do mesmo CREATE.
      if (sql.includes("information_schema.COLUMNS")) {
        const criacao = comandos.map(c => lerCreateTable(c)).find(c => c?.tabela === params?.[1]);
        return [criacao ? linhasDasColunas(criacao.colunas) : []];
      }
      return [[]];
    });

    const resultado = await migrar("mysql://u:p@localhost:3306/banco_teste");

    expect(resultado.ok).toBe(true);
    expect(executados).toEqual(comandos.filter(c => !criou(c)));
    expect(conexaoFalsa.query.mock.calls.some(([sql, params]) => String(sql).startsWith("INSERT INTO `_migracoes`") && params?.[0] === final)).toBe(true);
  });
});
