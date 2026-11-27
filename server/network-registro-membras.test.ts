import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Registro das conexões, lacunas fechadas em 14/09 (noite). Drizzle de verdade
 * sobre um cliente mysql2 falso, no molde de network-registro.test.ts: as
 * asserções leem o SQL e os parâmetros que chegariam ao banco.
 *
 * 1. PLATFORM_MATCH: o par de membras é gravado com as duas contas como
 *    participantes; o que já está registrado com a mesma nota não é escrito
 *    de novo, e nota nova só regrava pelo upsert (que não rebaixa etapa).
 * 2. O registro que roda no fim de um cálculo engole a falha comum (log) e
 *    relança banco fora do ar.
 * 3. A lista da plataforma filtra por origem e por etapa NA CONSULTA.
 */

type Resposta = unknown[][] | { affectedRows: number } | Error;
const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  responder: (_sql: string, _params: unknown[]): unknown => undefined,
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const resposta = estado.responder(config.sql, params) as Resposta | undefined;
      if (resposta instanceof Error) throw resposta;
      if (resposta && !Array.isArray(resposta)) return [resposta, []];
      if (/^\s*(insert|update|delete)/i.test(config.sql)) return [{ affectedRows: 1 }, []];
      return [resposta ?? [], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const {
  chaveDoPar, listarTodasAsConexoes, motivoEntreMembras, registrarConexoesEntreMembras,
  registrarConexoesEntreMembrasDepoisDoCalculo, registrarConexoesInternasDepoisDoRecalculo,
} = await import("./network-registro");

const avisos = vi.spyOn(console, "warn").mockImplementation(() => undefined);
const quedaDoBanco = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" });

beforeEach(() => {
  estado.consultas = [];
  estado.responder = () => undefined;
  avisos.mockClear();
});

const inserts = (tabela: string) => estado.consultas.filter(c => new RegExp(`^insert into \`${tabela}\``).test(c.sql));

describe("PLATFORM_MATCH — a conexão entre membras", () => {
  it("a chave não tem direção: a rodada de A e a de B dão a mesma linha", () => {
    const membro = (userId: number) => ({ tipo: "membro" as const, userId });
    expect(chaveDoPar("PLATFORM_MATCH", membro(7), membro(3))).toBe("PLATFORM_MATCH|membro:3|membro:7");
    expect(chaveDoPar("PLATFORM_MATCH", membro(3), membro(7))).toBe(chaveDoPar("PLATFORM_MATCH", membro(7), membro(3)));
  });

  it("grava o par novo com as duas contas; o já registrado com a mesma nota não é escrito de novo", async () => {
    estado.responder = (sql) => {
      if (/select `chave_do_par`, `pontuacao` from `conexoes_registradas`/.test(sql)) return [["PLATFORM_MATCH|membro:1|membro:3", 55]];
      if (/select `id` from `conexoes_registradas`/.test(sql)) return [["conexao-12"]];
      return undefined;
    };

    expect(await registrarConexoesEntreMembras(1, [{ outraUserId: 2, pontuacao: 72.4 }, { outraUserId: 3, pontuacao: 55 }])).toBe(1);

    const leitura = estado.consultas[0];
    expect(leitura.sql).toContain("`conexoes_registradas`.`chave_do_par` in (?, ?)");
    expect(leitura.params).toEqual(["PLATFORM_MATCH|membro:1|membro:2", "PLATFORM_MATCH|membro:1|membro:3"]);

    const [cabecalho, ...outros] = inserts("conexoes_registradas");
    expect(outros).toHaveLength(0);
    expect(cabecalho.params).toEqual(expect.arrayContaining(["PLATFORM_MATCH", "PLATFORM_MATCH|membro:1|membro:2", 72, "identificada", "sem_negocio", "[]", motivoEntreMembras(72)]));
    // O upsert não mexe em etapa nem em comissão.
    expect(cabecalho.sql).toMatch(/on duplicate key update `motivo` = \?, `itens` = \?, `pontuacao` = \?, `updated_at` = \?$/);

    const [participantes] = inserts("conexoes_participantes");
    expect(participantes.params).toEqual(expect.arrayContaining(["conexao-12", "a", "membro", 1, "b", 2]));
    expect(participantes.params.filter(p => p === true)).toHaveLength(0); // membra não é originadora
  });

  it("nota nova regrava o registro (motivo e pontuação), sem criar outra linha", async () => {
    estado.responder = (sql) => {
      if (/select `chave_do_par`, `pontuacao` from `conexoes_registradas`/.test(sql)) return [["PLATFORM_MATCH|membro:1|membro:2", 60]];
      if (/select `id` from `conexoes_registradas`/.test(sql)) return [["conexao-12"]];
      return undefined;
    };
    expect(await registrarConexoesEntreMembras(1, [{ outraUserId: 2, pontuacao: 72 }])).toBe(1);
    expect(inserts("conexoes_registradas")[0].params).toContain(72);
  });

  it("o motivo não carrega dado de ninguém: só a origem e a nota", () => {
    expect(motivoEntreMembras(71.6)).toBe(
      "Conexão sugerida pelo motor de perfis entre dois membros da plataforma, com o termo do Smart Match aceito pelos dois: compatibilidade de 72%.",
    );
  });

  it("sem par, nenhuma consulta", async () => {
    await registrarConexoesEntreMembrasDepoisDoCalculo(1, []);
    expect(await registrarConexoesEntreMembras(1, [])).toBe(0);
    expect(estado.consultas).toHaveLength(0);
  });
});

describe("registro no fim de um cálculo — falha comum vira log, banco fora do ar vira erro", () => {
  it("conexões internas: erro de SQL fica no log e não sobe", async () => {
    estado.responder = () => new Error("Unknown column 'codigo_anonimo'");
    await expect(registrarConexoesInternasDepoisDoRecalculo("dona-9")).resolves.toBeUndefined();
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it("conexões internas: banco fora do ar sobe", async () => {
    estado.responder = () => quedaDoBanco();
    await expect(registrarConexoesInternasDepoisDoRecalculo("dona-9")).rejects.toThrow();
    expect(avisos).not.toHaveBeenCalled();
  });

  it("conexões entre membras: as mesmas duas regras", async () => {
    estado.responder = () => new Error("Table 'conexoes_registradas' doesn't exist");
    await expect(registrarConexoesEntreMembrasDepoisDoCalculo(1, [{ outraUserId: 2, pontuacao: 50 }])).resolves.toBeUndefined();
    estado.responder = () => quedaDoBanco();
    await expect(registrarConexoesEntreMembrasDepoisDoCalculo(1, [{ outraUserId: 2, pontuacao: 50 }])).rejects.toThrow();
  });
});

describe("lista da plataforma — filtros na consulta", () => {
  it("origem e etapa vão no WHERE, como parâmetros", async () => {
    expect(await listarTodasAsConexoes({ origem: "PLATFORM_MATCH", status: "fechada" })).toEqual([]);
    const [leitura] = estado.consultas;
    expect(leitura.sql).toContain("(`conexoes_registradas`.`origem` = ? and `conexoes_registradas`.`status` = ?)");
    expect(leitura.params).toEqual(expect.arrayContaining(["PLATFORM_MATCH", "fechada"]));
  });

  it("sem filtro, sem WHERE", async () => {
    await listarTodasAsConexoes();
    expect(estado.consultas[0].sql).not.toContain(" where ");
  });
});
