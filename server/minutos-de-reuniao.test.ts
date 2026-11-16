import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — minutos de reunião (spec da Glenda de 14/09,
 * itens 3, 4 e 25). Drizzle de verdade sobre um cliente mysql2 falso.
 *
 * O que se trava:
 * 1. O gratuito é o MESMO número que o servidor aplica ao receber a gravação:
 *    desde a G13b, as 12 h da gravação em partes, o padrão para todas.
 * 2. A mensalidade é estrutura: sem integração de pagamento a ampliação NÃO
 *    está disponível, e o motivo vai junto. Nenhum preço é inventado.
 * 3. Sem assinatura ativa de plano ativo, vale o gratuito; plano configurado
 *    nunca reduz o que a usuária já tem; assinatura vencida não vale.
 * 4. O consumo do mês é da dona e conta a partir do dia 1 (UTC); reprocessar
 *    a mesma reunião não conta de novo.
 */

type Resposta = unknown[][] | { affectedRows: number };
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

const minutos = await import("./minutos-de-reuniao");
const { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } = await import("@shared/const");
const { exigirDb } = await import("./db");
const schema = await import("../drizzle/schema");

const AGORA = Date.UTC(2026, 8, 14, 21, 30);
const QUEM = { id: 9, openId: "dona-9" };

beforeEach(() => {
  estado.consultas = [];
  estado.responder = () => undefined;
});

describe("minutos — o gratuito", () => {
  it("12 horas por reunião, o mesmo teto da gravação em partes, e não mais os 10 minutos do envio único (G13b)", () => {
    expect(minutos.LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS).toBe(12 * 60 * 60);
    expect(minutos.LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS).toBe(GRAVACAO_EM_PARTES_SEGUNDOS_MAX);
  });

  it("sem assinatura: plano gratuito, sem limite mensal adotado", async () => {
    const plano = await minutos.resolverPlanoDeMinutos(QUEM.id, AGORA);
    expect(plano).toEqual({ plano: "gratuito", nome: null, limitePorReuniaoSegundos: 12 * 60 * 60, limiteMensalSegundos: null });
    const [leitura] = estado.consultas;
    expect(leitura.sql).toContain("`assinaturas_de_minutos`.`userId` = ?");
    expect(leitura.sql).toContain("`assinaturas_de_minutos`.`status` = ?");
    expect(leitura.sql).toContain("`planos_de_minutos`.`ativo` = ?");
    expect(leitura.params).toEqual(expect.arrayContaining([9, "ativa", true]));
  });
});

describe("minutos — a mensalidade é estrutura, não cobrança", () => {
  it("sem integração de pagamento: a ampliação não está disponível e o motivo é dito", async () => {
    expect(minutos.INTEGRACAO_DE_PAGAMENTO_CONFIGURADA).toBe(false);
    const resumo = await minutos.resumoDeMinutos(QUEM, AGORA);
    expect(resumo.ampliacao).toEqual({ disponivel: false, dependeDe: "integracao_de_pagamento" });
  });

  it("assinatura ativa de plano configurado: vale o plano, mas nunca abaixo do gratuito", async () => {
    // fimEm, limitePorReuniaoSegundos, limiteMensalSegundos, nome
    estado.responder = sql => (/from `assinaturas_de_minutos`/.test(sql) ? [[null, 300, 36_000, "Plano configurado"]] : undefined);
    const plano = await minutos.resolverPlanoDeMinutos(QUEM.id, AGORA);
    expect(plano).toEqual({ plano: "pago", nome: "Plano configurado", limitePorReuniaoSegundos: 12 * 60 * 60, limiteMensalSegundos: 36_000 });
  });

  it("assinatura vencida não vale", async () => {
    estado.responder = sql => (/from `assinaturas_de_minutos`/.test(sql) ? [[AGORA - 1, 3600, null, "Plano"]] : undefined);
    expect((await minutos.resolverPlanoDeMinutos(QUEM.id, AGORA)).plano).toBe("gratuito");
  });

  it("nenhum plano nasce com o sistema: preço, minutos e periodicidade são colunas vazias para o administrador", () => {
    const colunas = Object.values(schema.planosDeMinutos).map(coluna => coluna as { name?: string; notNull?: boolean; default?: unknown });
    for (const nome of ["preco_centavos", "minutos_adicionais", "limite_por_reuniao_segundos", "limite_mensal_segundos", "periodicidade", "nome", "moeda"]) {
      const coluna = colunas.find(c => c.name === nome)!;
      expect(coluna, nome).toBeDefined();
      expect(coluna.notNull, nome).toBe(false);
      expect(coluna.default, nome).toBeUndefined();
    }
    expect(colunas.find(c => c.name === "ativo")!.default).toBe(false);
  });
});

describe("minutos — o consumo", () => {
  it("o mês começa no dia 1, 00:00 UTC", () => {
    expect(minutos.inicioDoMesUtc(AGORA)).toBe(Date.UTC(2026, 8, 1));
  });

  it("soma só o consumo da dona desde o início do mês", async () => {
    estado.responder = sql => (/from `consumo_de_minutos`/.test(sql) ? [["1530"]] : undefined);
    const resumo = await minutos.resumoDeMinutos(QUEM, AGORA);
    expect(resumo.usadosNoMesSegundos).toBe(1530);
    const leitura = estado.consultas.find(c => /from `consumo_de_minutos`/.test(c.sql))!;
    expect(leitura.sql).toContain("`consumo_de_minutos`.`owner_id` = ?");
    expect(leitura.sql).toContain("`consumo_de_minutos`.`created_at` >= ?");
    expect(leitura.params).toEqual(["dona-9", Date.UTC(2026, 8, 1)]);
  });

  it("registrar é idempotente por reunião: a duplicata não soma de novo", async () => {
    const db = await exigirDb();
    await minutos.registrarConsumoDeMinutos(db, { ownerId: "dona-9", origem: "reuniao", referencia: "reuniao-1", segundos: 299.6 });
    const [insert] = estado.consultas;
    expect(insert.sql).toMatch(/^insert into `consumo_de_minutos`/);
    expect(insert.sql).toContain("on duplicate key update `segundos` = `consumo_de_minutos`.`segundos`");
    expect(insert.params).toEqual(expect.arrayContaining(["dona-9", "reuniao", "reuniao-1", 300]));
  });
});
