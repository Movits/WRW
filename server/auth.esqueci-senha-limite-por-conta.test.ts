import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  process.env.FRONTEND_URL ??= "https://exemplo-de-teste.invalid";
});

/**
 * ESQUECI A SENHA: LIMITE POR CONTA, E O DE IP AFROUXADO.
 *
 * As participantes importadas nascem sem senha e só entram por este fluxo. Com
 * 3 pedidos por IP a cada 15 min, a sala do lançamento (mesmo wi-fi) dividia
 * os 3. O limite por IP sobe para 300, e o que impede encher de e-mails a caixa
 * de UMA pessoa passa a ser o limite por e-mail e por conta (3 em 15 min).
 *
 * As contagens do banco leem e só gravam depois de vários awaits: pedidos
 * simultâneos (um HTTP em lote do tRPC basta) liam todos a contagem velha, e
 * 100 pedidos mandavam 100 e-mails. Por isso há tetos em memória antes do
 * primeiro await, com os mesmos números.
 */

const E_MAIL_CADASTRADO = "importada@exemplo.test";

const estado = vi.hoisted(() => ({
  pedidosDoIp: 0,
  pedidosDaConta: 0,
  insercoes: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  // Inserções e atualizações na ordem em que acontecem, para conferir que o link
  // anterior é cancelado ANTES de o novo ser gravado.
  operacoes: [] as Array<{ op: "insert" | "update"; tabela: string; valores: Record<string, unknown>; filtro?: unknown }>,
  filtrosDeContagem: [] as Array<{ tabela: string; filtro: unknown }>,
  sendEmail: vi.fn(async (_dados: unknown) => true),
}));

vi.mock("./_core/email", () => ({
  sendEmail: estado.sendEmail,
  buildPasswordResetEmail: () => ({ html: "<p>oi</p>", text: "oi" }),
}));

vi.mock("./db", () => ({
  exigirDb: async () => ({
    select: () => ({
      from: (tabela: Table) => ({
        where: (filtro: unknown) => ({
          limit: async () => [{ id: 7, name: "Importada", email: E_MAIL_CADASTRADO }],
          // Cada contagem responde pela SUA tabela: a do IP em
          // password_reset_requests, a da conta em password_reset_tokens. O
          // filtro fica guardado para o teste conferir QUEM está sendo contado.
          then: (resolver: (linhas: unknown[]) => unknown) => {
            const nome = getTableName(tabela);
            estado.filtrosDeContagem.push({ tabela: nome, filtro });
            if (nome === "password_reset_requests") return resolver([{ count: estado.pedidosDoIp }]);
            if (nome === "password_reset_tokens") return resolver([{ count: estado.pedidosDaConta }]);
            throw new Error(`contagem inesperada em ${nome}`);
          },
        }),
      }),
    }),
    insert: (tabela: Table) => ({
      values: async (valores: Record<string, unknown>) => {
        estado.insercoes.push({ tabela: getTableName(tabela), valores });
        estado.operacoes.push({ op: "insert", tabela: getTableName(tabela), valores });
      },
    }),
    update: (tabela: Table) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (filtro: unknown) => {
          estado.operacoes.push({ op: "update", tabela: getTableName(tabela), valores, filtro });
        },
      }),
    }),
  }),
}));

import { appRouter } from "./routers";
import { tetoDeRecuperacaoPorEmail, tetoDeRecuperacaoPorRede } from "./routers/auth";
import {
  PASSWORD_RESET_ACCOUNT_LIMIT,
  PASSWORD_RESET_GENERIC_MESSAGE,
  PASSWORD_RESET_RATE_LIMIT,
} from "./password-reset-security";
import type { TrpcContext } from "./_core/context";

const IP_REAL = "198.51.100.23";

function contexto(ipReal = IP_REAL): TrpcContext {
  return {
    user: null,
    req: {
      headers: { "cf-connecting-ip": ipReal, "x-forwarded-for": `203.0.113.7, ${ipReal}, 10.226.0.9` },
      ip: "10.226.0.9",
      socket: { remoteAddress: "10.226.0.9" },
    },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

const pedirRecuperacao = (email = E_MAIL_CADASTRADO, ipReal = IP_REAL) =>
  appRouter.createCaller(contexto(ipReal)).auth.forgotPassword({ email });
const tokensEmitidos = () => estado.insercoes.filter(i => i.tabela === "password_reset_tokens");

describe("esqueci a senha — limite por conta e IP real", () => {
  beforeEach(() => {
    process.env.RENDER = "true";
    estado.pedidosDoIp = 0;
    estado.pedidosDaConta = 0;
    estado.insercoes = [];
    estado.operacoes = [];
    estado.filtrosDeContagem = [];
    estado.sendEmail.mockClear();
    tetoDeRecuperacaoPorRede.esquecer();
    tetoDeRecuperacaoPorEmail.esquecer();
  });
  afterEach(() => {
    delete process.env.RENDER;
    vi.restoreAllMocks();
  });

  it("os valores: 300 por IP e 3 por conta, a cada 15 min", () => {
    expect(PASSWORD_RESET_RATE_LIMIT).toBe(300);
    expect(PASSWORD_RESET_ACCOUNT_LIMIT).toBe(3);
  });

  it("com 3 pedidos da conta na janela, nenhum e-mail sai, a resposta é a mesma e o log não leva e-mail nem IP", async () => {
    estado.pedidosDaConta = PASSWORD_RESET_ACCOUNT_LIMIT;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resposta = await pedirRecuperacao();

    expect(resposta).toEqual({ success: true, message: PASSWORD_RESET_GENERIC_MESSAGE });
    expect(estado.sendEmail).not.toHaveBeenCalled();
    expect(tokensEmitidos()).toEqual([]);
    expect(aviso).toHaveBeenCalledTimes(1);
    const registrado = String(aviso.mock.calls[0]?.[0] ?? "");
    expect(registrado).toContain("[PasswordReset]");
    expect(registrado).toContain("por conta");
    expect(registrado).not.toContain(E_MAIL_CADASTRADO);
    expect(registrado).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
  });

  it("a contagem por conta filtra pela conta encontrada e pela janela (sem o filtro, contaria os tokens de todo mundo)", async () => {
    await pedirRecuperacao();

    const daConta = estado.filtrosDeContagem.find(c => c.tabela === "password_reset_tokens");
    expect(daConta).toBeDefined();
    const { sql, params } = new MySqlDialect().sqlToQuery(daConta!.filtro as SQL);
    expect(sql).toContain("`password_reset_tokens`.`userId` = ?");
    expect(sql).toContain("`password_reset_tokens`.`createdAt` >= ?");
    expect(params).toContain(7);
  });

  it("com 2 pedidos da conta na janela, o e-mail sai", async () => {
    estado.pedidosDaConta = PASSWORD_RESET_ACCOUNT_LIMIT - 1;

    const resposta = await pedirRecuperacao();

    expect(resposta.message).toBe(PASSWORD_RESET_GENERIC_MESSAGE);
    expect(estado.sendEmail).toHaveBeenCalledTimes(1);
    expect(tokensEmitidos()).toHaveLength(1);
  });

  it("o pedido novo cancela os links anteriores da conta antes de gravar o seu (a tela promete 'cada pedido cancela o anterior')", async () => {
    await pedirRecuperacao();

    const cancelamento = estado.operacoes.findIndex(o => o.op === "update" && o.tabela === "password_reset_tokens");
    const novoToken = estado.operacoes.findIndex(o => o.op === "insert" && o.tabela === "password_reset_tokens");
    expect(cancelamento).toBeGreaterThanOrEqual(0);
    expect(novoToken).toBeGreaterThan(cancelamento);
    expect(estado.operacoes[cancelamento].valores.usedAt).toBeInstanceOf(Date);
    // Só os links ainda válidos desta conta: com o novo gravado antes, ele nasceria cancelado.
    const { sql, params } = new MySqlDialect().sqlToQuery(estado.operacoes[cancelamento].filtro as SQL);
    expect(params).toEqual([7]);
    // A cláusula inteira: a coluna da conta (e não o id do token), o "e" e o IS NULL.
    expect(sql).toBe("(`password_reset_tokens`.`userId` = ? and `password_reset_tokens`.`usedAt` IS NULL)");
  });

  it("o IP afrouxado: 299 pedidos da mesma rede e a importada ainda recebe o link (com o limite antigo, parava no 3º)", async () => {
    estado.pedidosDoIp = PASSWORD_RESET_RATE_LIMIT - 1;

    await pedirRecuperacao();

    expect(estado.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("o IP registrado para o limite é o CF-Connecting-IP, mesmo com X-Forwarded-For forjado", async () => {
    await pedirRecuperacao();

    const registro = estado.insercoes.find(i => i.tabela === "password_reset_requests");
    expect(registro?.valores.ipAddress).toBe(IP_REAL);
  });

  it("100 pedidos SIMULTÂNEOS para a mesma conta mandam no máximo 3 e-mails, com a mesma resposta para todos", async () => {
    // O banco responde "zero" a todas as contagens, como quando nenhuma
    // gravação chegou antes das leituras.
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    const respostas = await Promise.all(Array.from({ length: 100 }, () => pedirRecuperacao()));

    // Cada token gravado é um e-mail enviado logo em seguida. (O `sendEmail`
    // não serve de contador aqui: com o `import("../_core/email")` dinâmico do
    // procedimento carregado em paralelo, o Vitest entrega o dublê só a uma
    // parte das chamadas.)
    expect(tokensEmitidos()).toHaveLength(PASSWORD_RESET_ACCOUNT_LIMIT);
    for (const resposta of respostas) expect(resposta).toEqual({ success: true, message: PASSWORD_RESET_GENERIC_MESSAGE });
    // Maiúsculas não abrem teto novo.
    await pedirRecuperacao("IMPORTADA@Exemplo.test");
    expect(tokensEmitidos()).toHaveLength(PASSWORD_RESET_ACCOUNT_LIMIT);
    // O aviso do teto por e-mail não leva e-mail nem IP.
    const registrado = aviso.mock.calls.map(c => String(c[0])).join("\n");
    expect(registrado).toContain("por e-mail");
    expect(registrado).not.toContain("importada@");
    expect(registrado).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
  });

  it("a mesma rede, simultânea, para no 300º pedido com TOO_MANY_REQUESTS e mensagem (antes de buscar a conta); outra rede segue", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resultados = await Promise.all(
      Array.from({ length: PASSWORD_RESET_RATE_LIMIT + 20 }, (_, i) =>
        pedirRecuperacao(`pessoa${i}@exemplo.test`).then(
          () => "ok",
          (erro: unknown) => (erro instanceof TRPCError ? erro.code : String(erro)),
        ),
      ),
    );
    expect(resultados.filter(r => r === "ok")).toHaveLength(PASSWORD_RESET_RATE_LIMIT);
    expect(resultados.filter(r => r === "TOO_MANY_REQUESTS")).toHaveLength(20);
    // Os recusados não chegaram ao banco: nenhuma linha de pedido a mais.
    expect(estado.insercoes.filter(i => i.tabela === "password_reset_requests")).toHaveLength(PASSWORD_RESET_RATE_LIMIT);

    const erro = await pedirRecuperacao("mais-uma@exemplo.test").catch((e: unknown) => e);
    expect((erro as TRPCError).message).toMatch(/Muitos pedidos de recuperação de senha a partir desta rede/);

    await expect(pedirRecuperacao("outra-rede@exemplo.test", "203.0.113.99")).resolves.toEqual({
      success: true,
      message: PASSWORD_RESET_GENERIC_MESSAGE,
    });
  });
});
