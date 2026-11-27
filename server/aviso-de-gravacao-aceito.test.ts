import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { MENSAGEM_AVISO_DE_GRAVACAO_NAO_ACEITO, VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/**
 * O aceite do aviso de gravação na conta (gravar com um toque, 26/11/2026). O
 * banco é um dublê que guarda as linhas por (dona, versão), como o índice único
 * da tabela recording_notice_acceptances: o insert repetido não cria outra linha
 * nem troca a data do primeiro aceite.
 */
const banco = vi.hoisted(() => {
  const linhas = new Map<string, { ownerId: string; versaoDoAviso: string; createdAt: number; idioma: string | null; ipAddress: string | null; userAgent: string | null }>();
  // O filtro da consulta: a dona e a versão que o where pediu (o dublê lê dos
  // valores que a função passou ao eq, guardados em ultimoFiltro).
  const ultimoFiltro: { ownerId?: string; versao?: string } = {};
  return { linhas, ultimoFiltro };
});

vi.mock("drizzle-orm", async original => {
  const real = await original<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (coluna: { name: string }, valor: string) => ({ coluna: coluna.name, valor }),
    and: (...condicoes: Array<{ coluna: string; valor: string }>) => {
      for (const c of condicoes) {
        if (c.coluna === "owner_id") banco.ultimoFiltro.ownerId = c.valor;
        if (c.coluna === "versao_do_aviso") banco.ultimoFiltro.versao = c.valor;
      }
      return condicoes;
    },
  };
});

vi.mock("./db", () => ({
  exigirDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const linha = banco.linhas.get(`${banco.ultimoFiltro.ownerId}|${banco.ultimoFiltro.versao}`);
            return linha ? [{ createdAt: linha.createdAt }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (valores: { ownerId: string; versaoDoAviso: string; createdAt: number; idioma: string | null; ipAddress: string | null; userAgent: string | null }) => ({
        onDuplicateKeyUpdate: async () => {
          const chave = `${valores.ownerId}|${valores.versaoDoAviso}`;
          if (!banco.linhas.has(chave)) banco.linhas.set(chave, valores);
        },
      }),
    }),
  }),
}));

import { aceitarAvisoDeGravacao, conferirAvisoAceito, estadoDoAvisoDeGravacao } from "./aviso-de-gravacao-aceito";

beforeEach(() => {
  banco.linhas.clear();
});

describe("o aviso de gravação aceito na conta", () => {
  it("antes do aceite, o estado diz que a versão vigente não foi aceita", async () => {
    expect(await estadoDoAvisoDeGravacao("dona-1")).toEqual({ versaoVigente: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, aceitoEm: null });
  });

  it("o aceite grava a versão vigente com a data, o idioma, o IP e o navegador; depois, o estado diz quando", async () => {
    const feito = await aceitarAvisoDeGravacao("dona-1", { idioma: "pt-BR", quem: { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" }, agora: 1_000 });
    expect(feito).toEqual({ versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, aceitoEm: 1_000 });
    expect(banco.linhas.get(`dona-1|${VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO}`)).toMatchObject({
      versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, idioma: "pt-BR", ipAddress: "203.0.113.9", userAgent: "Navegador de teste", createdAt: 1_000,
    });
    expect(await estadoDoAvisoDeGravacao("dona-1")).toEqual({ versaoVigente: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, aceitoEm: 1_000 });
    // O aceite é da conta: outra dona continua sem ele.
    expect((await estadoDoAvisoDeGravacao("dona-2")).aceitoEm).toBeNull();
  });

  it("aceitar de novo (outra aba, o duplo toque) não troca a data do primeiro aceite", async () => {
    await aceitarAvisoDeGravacao("dona-1", { agora: 1_000 });
    const denovo = await aceitarAvisoDeGravacao("dona-1", { agora: 9_000 });
    expect(denovo.aceitoEm).toBe(1_000);
    expect(banco.linhas.size).toBe(1);
  });

  it("o início da gravação recusa a versão que a dona não aceitou, e aceita a que ela aceitou", async () => {
    const recusa = await conferirAvisoAceito("dona-1", VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO).catch(erro => erro);
    expect(recusa).toBeInstanceOf(TRPCError);
    expect(recusa).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_AVISO_DE_GRAVACAO_NAO_ACEITO });
    await aceitarAvisoDeGravacao("dona-1", { agora: 1_000 });
    await expect(conferirAvisoAceito("dona-1", VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO)).resolves.toBeUndefined();
    // Uma versão anterior, que ela não aceitou na conta, segue recusada.
    await expect(conferirAvisoAceito("dona-1", "2026-11-14")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("sem versão (a aba de antes do aviso versionado), nada a conferir, como antes", async () => {
    await expect(conferirAvisoAceito("dona-1", undefined)).resolves.toBeUndefined();
    await expect(conferirAvisoAceito("dona-1", null)).resolves.toBeUndefined();
  });
});
