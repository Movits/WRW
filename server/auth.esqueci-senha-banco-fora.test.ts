import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

/**
 * ESQUECI A SENHA: A QUEDA DO BANCO NÃO GASTA O TETO POR E-MAIL.
 *
 * O teto em memória (3 por e-mail em 15 min) reserva a vaga antes do primeiro
 * await, para uma rajada simultânea não passar inteira. Mas a reserva era
 * gasta mesmo quando o pedido falhava em seguida: três quedas do banco
 * seguidas, e o quarto pedido, já com o banco de volta, saía "Pedido
 * recebido" sem e-mail nenhum. Agora o erro devolve a vaga; o pedido que
 * chega ao fim sem erro segue gastando-a.
 */

// Sem a chave da Resend no ambiente, nem o módulo de e-mail de verdade envia
// (o vitest.config.ts carrega o .env). O server/_core/email.ts lê as duas ao carregar.
const ambienteDoEmail = vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  process.env.FRONTEND_URL ??= "https://exemplo-de-teste.invalid";
  const guardado = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM };
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  return guardado;
});

afterAll(() => {
  for (const [nome, valor] of Object.entries(ambienteDoEmail)) {
    if (valor !== undefined) process.env[nome] = valor;
  }
});

const E_MAIL_CADASTRADO = "importada@exemplo.test";

const estado = vi.hoisted(() => ({
  // Quantas das próximas chamadas a exigirDb() caem.
  quedas: 0,
  pedidosDoIp: 0,
  insercoes: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  sendEmail: vi.fn(async (_dados: unknown) => true),
}));

vi.mock("./_core/email", () => ({
  sendEmail: estado.sendEmail,
  buildPasswordResetEmail: () => ({ html: "<p>oi</p>", text: "oi" }),
}));

vi.mock("./db", () => ({
  exigirDb: async () => {
    if (estado.quedas > 0) {
      estado.quedas--;
      const { BancoIndisponivel } = await import("./banco-indisponivel");
      throw new BancoIndisponivel();
    }
    return {
      select: () => ({
        from: (tabela: Table) => ({
          where: () => ({
            limit: async () => [{ id: 7, name: "Importada", email: E_MAIL_CADASTRADO }],
            // A contagem do IP responde o que o teste pede; a da conta, zero:
            // quem barra o quarto pedido é o teto em memória.
            then: (resolver: (linhas: unknown[]) => unknown) =>
              resolver([{ count: getTableName(tabela) === "password_reset_requests" ? estado.pedidosDoIp : 0 }]),
          }),
        }),
      }),
      insert: (tabela: Table) => ({
        values: async (valores: Record<string, unknown>) => {
          estado.insercoes.push({ tabela: getTableName(tabela), valores });
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
  },
}));

import { appRouter } from "./routers";
import { tetoDeRecuperacaoPorEmail, tetoDeRecuperacaoPorRede } from "./routers/auth";
import { PASSWORD_RESET_GENERIC_MESSAGE, PASSWORD_RESET_RATE_LIMIT } from "./password-reset-security";
import type { TrpcContext } from "./_core/context";

const IP_REAL = "198.51.100.23";

function contexto(): TrpcContext {
  return {
    user: null,
    req: {
      headers: { "cf-connecting-ip": IP_REAL },
      ip: "10.226.0.9",
      socket: { remoteAddress: "10.226.0.9" },
    },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

const pedirRecuperacao = () => appRouter.createCaller(contexto()).auth.forgotPassword({ email: E_MAIL_CADASTRADO });
const tokensEmitidos = () => estado.insercoes.filter(i => i.tabela === "password_reset_tokens");
const codigoDoErro = (erro: unknown) => (erro instanceof TRPCError ? erro.code : String(erro));

describe("esqueci a senha — a queda do banco devolve a vaga do teto por e-mail", () => {
  beforeEach(() => {
    process.env.RENDER = "true";
    estado.quedas = 0;
    estado.pedidosDoIp = 0;
    estado.insercoes = [];
    estado.sendEmail.mockClear();
    tetoDeRecuperacaoPorRede.esquecer();
    tetoDeRecuperacaoPorEmail.esquecer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.RENDER;
    vi.restoreAllMocks();
  });

  it("três quedas seguidas e, com o banco de volta, o quarto pedido grava o link e manda o e-mail", async () => {
    estado.quedas = 3;
    for (let i = 0; i < 3; i++) {
      expect(codigoDoErro(await pedirRecuperacao().catch((e: unknown) => e))).toBe("INTERNAL_SERVER_ERROR");
    }
    expect(tokensEmitidos()).toHaveLength(0);

    await expect(pedirRecuperacao()).resolves.toEqual({ success: true, message: PASSWORD_RESET_GENERIC_MESSAGE });
    expect(tokensEmitidos()).toHaveLength(1);
    expect(estado.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a recusa por rede da contagem do banco também devolve a vaga do e-mail", async () => {
    estado.pedidosDoIp = PASSWORD_RESET_RATE_LIMIT;
    for (let i = 0; i < 3; i++) {
      expect(codigoDoErro(await pedirRecuperacao().catch((e: unknown) => e))).toBe("TOO_MANY_REQUESTS");
    }

    estado.pedidosDoIp = 0;
    await pedirRecuperacao();
    expect(tokensEmitidos()).toHaveLength(1);
    expect(estado.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("o pedido que chega ao fim sem erro segue gastando a vaga: o quarto seguido não grava link", async () => {
    for (let i = 0; i < 3; i++) await pedirRecuperacao();
    expect(tokensEmitidos()).toHaveLength(3);

    await expect(pedirRecuperacao()).resolves.toEqual({ success: true, message: PASSWORD_RESET_GENERIC_MESSAGE });
    expect(tokensEmitidos()).toHaveLength(3);
    expect(estado.sendEmail).toHaveBeenCalledTimes(3);
  });
});
