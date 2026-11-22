import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLogs, meetings } from "../drizzle/schema";
import { RECUSAS_DA_LEGENDA, VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";

/**
 * A prova da legenda ao vivo (G15b, server/legenda-ao-vivo.ts) com o banco
 * dublado: a leitura da reunião vai travada, na transação, pela dona, sem a
 * excluída; a linha da auditoria entra na MESMA transação, com o texto que a
 * dona viu e o hash; a recusa não grava nada; a auditoria que falha sobe como
 * erro (sem a linha, a legenda não liga). O que o banco de verdade guarda está
 * em server/legenda-ao-vivo.integracao.test.ts.
 */

const dialeto = new MySqlDialect();
type Leitura = { condicao: { sql: string; params: unknown[] }; travada: boolean };
const estado = vi.hoisted(() => ({
  reuniao: null as { status: string } | null,
  leituras: [] as Array<{ condicao: unknown; travada: boolean }>,
  inseridas: [] as Array<{ tabela: unknown; dados: Record<string, unknown>; naTransacao: boolean }>,
  transacoes: 0,
  auditoriaFora: false,
}));

function banco(naTransacao: boolean) {
  return {
    select: () => ({
      from: () => ({
        where: (condicao: unknown) => {
          const leitura = { condicao, travada: false };
          estado.leituras.push(leitura);
          const consulta = {
            limit: () => consulta,
            for: (modo: string) => {
              leitura.travada = modo === "update";
              return consulta;
            },
            then: (resolver: (linhas: unknown[]) => unknown, rejeitar: (erro: unknown) => unknown) =>
              Promise.resolve(estado.reuniao ? [estado.reuniao] : []).then(resolver, rejeitar),
          };
          return consulta;
        },
      }),
    }),
    insert: (tabela: unknown) => ({
      values: async (dados: Record<string, unknown>) => {
        if (estado.auditoriaFora && tabela === auditLogs) throw new Error("Connection lost: The server closed the connection.");
        estado.inseridas.push({ tabela, dados, naTransacao });
      },
    }),
  };
}

vi.mock("./db", () => ({
  exigirDb: async () => ({
    ...banco(false),
    transaction: async (trabalho: (tx: unknown) => Promise<unknown>) => {
      estado.transacoes += 1;
      return trabalho(banco(true));
    },
  }),
}));
// O serviço só lê a frase da reunião não encontrada: o resto do meeting-service não entra.
vi.mock("./meeting-service", () => ({ MENSAGEM_REUNIAO_NAO_ENCONTRADA: "Reunião não encontrada." }));
// A regra da reunião que a dona vê é a de verdade, contada: tem de vir do ponto
// único (server/reuniao-visivel.ts), onde a lixeira da H7d entra.
const visivel = vi.hoisted(() => ({ chamadas: 0 }));
vi.mock("./reuniao-visivel", async importOriginal => {
  const real = await importOriginal<typeof import("./reuniao-visivel")>();
  return {
    ...real,
    reuniaoVisivel: () => {
      visivel.chamadas += 1;
      return real.reuniaoVisivel();
    },
  };
});

const { ACAO_LEGENDA_LIGADA, registrarLegendaLigada } = await import("./legenda-ao-vivo");

const DONA = "dona-da-legenda";
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TEXTO = "Ligar a legenda ao vivo?\nNo Chrome, ele costuma mandar o áudio a um servidor do Google para virar texto.";
const prova = (extra: Partial<Parameters<typeof registrarLegendaLigada>[2]> = {}) => ({
  userId: 7, ipAddress: "203.0.113.7", userAgent: "Navegador de teste/1.0", versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA,
  idioma: "pt-BR", textoExibido: TEXTO, ...extra,
});
const condicaoLida = (): Leitura => {
  const [leitura] = estado.leituras;
  return { condicao: dialeto.sqlToQuery(leitura.condicao as never), travada: leitura.travada };
};

beforeEach(() => {
  estado.reuniao = { status: "recording" };
  estado.leituras = [];
  estado.inseridas = [];
  estado.transacoes = 0;
  estado.auditoriaFora = false;
  visivel.chamadas = 0;
});

describe("registrarLegendaLigada (G15b)", () => {
  it("a reunião da dona que está gravando: a linha da auditoria entra na mesma transação da leitura travada, com o texto e o hash", async () => {
    await registrarLegendaLigada(DONA, ID, prova());
    expect(estado.transacoes).toBe(1);
    const { condicao, travada } = condicaoLida();
    expect(travada).toBe(true);
    // A dona, a reunião e a regra da reunião que ela ainda vê (sem a excluída), tudo no WHERE.
    expect(condicao.sql).toMatch(/`meetings`\.`id` = \?/);
    expect(condicao.sql).toMatch(/`meetings`\.`owner_id` = \?/);
    expect(condicao.sql).toMatch(/`meetings`\.`status` <> \?/);
    expect(condicao.params).toEqual([ID, DONA, "deleted"]);
    expect(estado.inseridas).toHaveLength(1);
    const [linha] = estado.inseridas;
    expect(linha.tabela).toBe(auditLogs);
    expect(linha.naTransacao).toBe(true);
    expect(linha.dados).toEqual({
      userId: 7,
      ipAddress: "203.0.113.7",
      userAgent: "Navegador de teste/1.0",
      action: ACAO_LEGENDA_LIGADA,
      resource: "meetings",
      resourceId: ID,
      details: {
        concordanciaDasPessoas: true,
        versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA,
        idioma: "pt-BR",
        textoExibido: TEXTO,
        textoHash: crypto.createHash("sha256").update(TEXTO).digest("hex"),
      },
      status: "success",
      riskLevel: "low",
    });
    expect(ACAO_LEGENDA_LIGADA).toBe("MEETING_LIVE_CAPTION_ON");
  });

  it("a reunião que não é da dona, a excluída ou a que não existe: NOT_FOUND, sem nada gravado", async () => {
    estado.reuniao = null;
    await expect(registrarLegendaLigada(DONA, ID, prova())).rejects.toMatchObject({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    expect(estado.inseridas).toEqual([]);
  });

  it.each(["uploading", "processing", "ready", "failed", "draft"])("a reunião em %s (não grava mais, ou ainda não): a recusa com o código, sem nada gravado", async status => {
    estado.reuniao = { status };
    await expect(registrarLegendaLigada(DONA, ID, prova())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_LEGENDA.foraDaGravacao });
    expect(estado.inseridas).toEqual([]);
  });

  it("a auditoria que falha sobe como erro: sem a linha, a legenda não liga", async () => {
    estado.auditoriaFora = true;
    await expect(registrarLegendaLigada(DONA, ID, prova())).rejects.toThrow("Connection lost");
  });

  it("os cortes do createAuditLog: IP até 45 e navegador até 500 caracteres; sem navegador, nulo", async () => {
    await registrarLegendaLigada(DONA, ID, prova({ ipAddress: "1".repeat(60), userAgent: "a".repeat(800) }));
    expect(estado.inseridas[0].dados).toMatchObject({ ipAddress: "1".repeat(45), userAgent: "a".repeat(500) });
    estado.inseridas = [];
    await registrarLegendaLigada(DONA, ID, prova({ userAgent: undefined }));
    expect(estado.inseridas[0].dados.userAgent).toBeNull();
  });

  it("a reunião que a dona vê vem de reuniaoVisivel(), o ponto único em que a lixeira (H7d) entra, uma vez por pedido", async () => {
    await registrarLegendaLigada(DONA, ID, prova());
    expect(visivel.chamadas).toBe(1);
    estado.reuniao = null;
    await expect(registrarLegendaLigada(DONA, ID, prova())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(visivel.chamadas).toBe(2);
  });

  it("lê só a reunião (nenhuma outra tabela é escrita além da auditoria)", async () => {
    await registrarLegendaLigada(DONA, ID, prova());
    expect(estado.inseridas.map(linha => linha.tabela)).toEqual([auditLogs]);
    expect(estado.inseridas.some(linha => linha.tabela === meetings)).toBe(false);
  });
});
