import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * auth.resetPassword derruba as sessões abertas, grava PASSWORD_RESET e gasta o
 * link num UPDATE condicional, na mesma transação que troca a senha. Antes, as
 * sessões de 8 h seguiam vivas depois do reset (e quem redefine muitas vezes
 * desconfia de acesso alheio), nada ia para a auditoria, e dois envios do mesmo
 * link passavam juntos: o SELECT decidia e o UPDATE era incondicional. O banco
 * falso daqui desfaz o que a transação gravou quando ela lança, como o MySQL; o
 * rollback de verdade só um banco real prova. Os códigos de que a tela depende
 * (a fila do bcrypt cheia, a senha curta) estão em
 * auth.redefinir-senha-codigos.test.ts, e o login em andamento durante o reset,
 * em auth.login-durante-o-reset.test.ts.
 */

type Atualizacao = {
  op: "update";
  tabela: string;
  valores: Record<string, unknown>;
  filtro: unknown;
  /** Pelo `tx` de uma transação, e não direto pelo banco. */
  naTransacao: boolean;
};
type Operacao =
  | { op: "select"; tabela: string; campos: string[]; filtro: unknown }
  | Atualizacao
  | { op: "begin" | "commit" | "rollback" | "hash" | "revogar" | "auditar" };

const estado = vi.hoisted(() => ({
  /** O que o SELECT do link devolve enquanto o link não foi gravado como gasto. */
  linhasDoLink: [] as unknown[],
  /** Linhas que cada UPDATE do link alcança, na ordem das chamadas; sem valor, 1. */
  alcancadas: [] as number[],
  /** Quando definido, o UPDATE do link lança este erro (o banco caiu). */
  erroAoGastar: null as unknown,
  /** Quando definido, o UPDATE da senha lança este erro (o banco caiu no meio da transação). */
  erroAoTrocarSenha: null as unknown,
  /** Quando definida, cada hash espera por ela antes de terminar. */
  barreiraDoHash: null as null | (() => Promise<void>),
  /** Tudo o que a rota fez, na ordem, inclusive o que a transação desfez. */
  operacoes: [] as Operacao[],
  /** Só o que ficou no banco: UPDATE fora de transação, ou de transação confirmada. */
  gravadas: [] as Atualizacao[],
}));

const espioes = vi.hoisted(() => ({
  revogar: vi.fn(async (_userId: number) => { estado.operacoes.push({ op: "revogar" }); }),
  auditar: vi.fn(async (_registro: Record<string, unknown>) => { estado.operacoes.push({ op: "auditar" }); }),
  invalidar: vi.fn(async (_token: string) => {}),
  hash: vi.fn(async (_senha: string, _custo: number) => {
    estado.operacoes.push({ op: "hash" });
    await estado.barreiraDoHash?.();
    return "hash-da-senha-nova";
  }),
}));

vi.mock("./db", async importOriginal => {
  // `pendentes` nulo é o banco fora de transação: o UPDATE fica gravado na
  // hora. Pelo `tx`, ele só fica gravado se a transação confirmar; se ela
  // lançar, é desfeito.
  const banco = (pendentes: Atualizacao[] | null): object => ({
    select: (campos: Record<string, unknown>) => ({
      from: (tabela: Table) => ({
        where: (filtro: unknown) => ({
          limit: async () => {
            estado.operacoes.push({ op: "select", tabela: getTableName(tabela), campos: Object.keys(campos ?? {}), filtro });
            // O link gravado como gasto some da busca, como o `usedAt IS NULL` faria.
            const gasto = estado.gravadas.some(g => g.tabela === "password_reset_tokens");
            return gasto ? [] : estado.linhasDoLink;
          },
        }),
      }),
    }),
    update: (tabela: Table) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (filtro: unknown) => {
          const nome = getTableName(tabela);
          if (nome === "password_reset_tokens" && estado.erroAoGastar) throw estado.erroAoGastar;
          if (nome === "users" && estado.erroAoTrocarSenha) throw estado.erroAoTrocarSenha;
          const atualizacao: Atualizacao = { op: "update", tabela: nome, valores, filtro, naTransacao: pendentes !== null };
          estado.operacoes.push(atualizacao);
          const alcancadas = nome === "password_reset_tokens" ? (estado.alcancadas.shift() ?? 1) : 1;
          if (alcancadas > 0) (pendentes ?? estado.gravadas).push(atualizacao);
          // Como o mysql2: o cabeçalho do resultado vem na primeira posição.
          return [{ affectedRows: alcancadas }, undefined];
        },
      }),
    }),
    transaction: async (tarefa: (tx: object) => Promise<unknown>) => {
      estado.operacoes.push({ op: "begin" });
      const daTransacao: Atualizacao[] = [];
      try {
        const resultado = await tarefa(banco(daTransacao));
        estado.gravadas.push(...daTransacao);
        estado.operacoes.push({ op: "commit" });
        return resultado;
      } catch (erro) {
        estado.operacoes.push({ op: "rollback" });
        throw erro;
      }
    },
  });
  return { ...(await importOriginal<typeof import("./db")>()), exigirDb: async () => banco(null) };
});

// linhasAlcancadas fica a de verdade: é ela que decide se o link foi gasto por ESTE envio.
vi.mock("./security", async importOriginal => ({
  ...(await importOriginal<typeof import("./security")>()),
  revokeAllUserSessions: espioes.revogar,
  createAuditLog: espioes.auditar,
  invalidateSession: espioes.invalidar,
}));

// O bcrypt de custo 12 de verdade roda em auth.redefinir-senha-codigos.test.ts.
vi.mock("bcryptjs", () => {
  const compare = vi.fn(async () => false);
  return { default: { hash: espioes.hash, compare }, hash: espioes.hash, compare };
});

import { authRouter } from "./routers/auth";
import { hashPasswordResetToken } from "./password-reset-security";
import { BancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "./banco-indisponivel";
import type { TrpcContext } from "./_core/context";

// No Render, quem pediu vem no CF-Connecting-IP; o req.ip é o proxy interno, e
// o primeiro item do X-Forwarded-For é o que o cliente escreveu. Os três são
// diferentes para a auditoria mostrar de onde tirou o IP.
const IP_DA_CLIENTE = "198.51.100.23";
const IP_DO_PROXY = "10.226.0.9";
const IP_FORJADO = "203.0.113.7";
const contexto = {
  user: null,
  req: {
    headers: {
      "user-agent": "vitest",
      "cf-connecting-ip": IP_DA_CLIENTE,
      "x-forwarded-for": `${IP_FORJADO}, ${IP_DA_CLIENTE}, ${IP_DO_PROXY}`,
    },
    ip: IP_DO_PROXY,
    socket: { remoteAddress: IP_DO_PROXY },
  },
  res: { cookie: vi.fn(), clearCookie: vi.fn() },
} as unknown as TrpcContext;
const RENDER_ORIGINAL = process.env.RENDER;

// O id do link e o da conta diferentes, para a troca de um pelo outro aparecer.
const LINK = { id: 9, userId: 7 };
// Do tamanho do link de verdade: 48 bytes em hexadecimal.
const TOKEN_CRU = "f".repeat(96);
const SENHA_NOVA = "senha-nova-123";
const MENSAGEM_DO_LINK_INVALIDO = "Token inválido ou expirado. Solicite um novo link de recuperação.";

const redefinir = () =>
  authRouter.createCaller(contexto).resetPassword({ token: TOKEN_CRU, newPassword: SENHA_NOVA });
const consulta = (filtro: unknown) => new MySqlDialect().sqlToQuery(filtro as SQL);
const passos = () =>
  estado.operacoes.map(o => {
    if (o.op === "select") return `select:${o.tabela}`;
    if (o.op === "update") return `${o.naTransacao ? "tx." : ""}update:${o.tabela}`;
    return o.op;
  });
const selecoes = () =>
  estado.operacoes.filter((o): o is Extract<Operacao, { op: "select" }> => o.op === "select");
const atualizacoes = (tabela: string) =>
  estado.operacoes.filter((o): o is Atualizacao => o.op === "update" && o.tabela === tabela);
/** As tabelas do que ficou gravado, na ordem. */
const gravadas = () => estado.gravadas.map(g => g.tabela);

/** O middleware de _core/trpc.ts registra a queda do banco no console; aqui ela é esperada. */
async function comAQuedaNoConsole(tarefa: () => Promise<unknown>) {
  const erroNoConsole = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await tarefa();
  } finally {
    erroNoConsole.mockRestore();
  }
}

beforeEach(() => {
  // ipDaCliente só lê o CF-Connecting-IP no Render.
  process.env.RENDER = "true";
  estado.linhasDoLink = [];
  estado.alcancadas = [];
  estado.erroAoGastar = null;
  estado.erroAoTrocarSenha = null;
  estado.barreiraDoHash = null;
  estado.operacoes = [];
  estado.gravadas = [];
  vi.clearAllMocks();
});

afterEach(() => {
  if (RENDER_ORIGINAL === undefined) delete process.env.RENDER;
  else process.env.RENDER = RENDER_ORIGINAL;
});

describe("auth.resetPassword — derruba as sessões, audita e gasta o link uma vez só", () => {
  it("com o link válido: calcula o hash, gasta o link e troca a senha numa transação, e só então derruba as sessões e grava PASSWORD_RESET", async () => {
    estado.linhasDoLink = [LINK];
    await expect(redefinir()).resolves.toEqual({ success: true });

    expect(passos()).toEqual([
      "select:password_reset_tokens",
      "hash",
      "begin",
      "tx.update:password_reset_tokens",
      "tx.update:users",
      "commit",
      "revogar",
      "auditar",
    ]);
    expect(gravadas()).toEqual(["password_reset_tokens", "users"]);

    // (1) Busca pelo hash do link, nunca pelo link cru, e só o id e a conta.
    const [busca] = selecoes();
    expect(busca.campos).toEqual(["id", "userId"]);
    expect(consulta(busca.filtro).params).toEqual([hashPasswordResetToken(TOKEN_CRU)]);

    // (2) O hash da senha nova, de custo 12.
    expect(espioes.hash).toHaveBeenCalledTimes(1);
    expect(espioes.hash).toHaveBeenCalledWith(SENHA_NOVA, 12);

    // (3) O UPDATE do link é condicional e vai pelo id daquele link.
    const [consumo] = atualizacoes("password_reset_tokens");
    expect(Object.keys(consumo.valores)).toEqual(["usedAt"]);
    expect(consumo.valores.usedAt).toBeInstanceOf(Date);
    const sqlDoConsumo = consulta(consumo.filtro);
    expect(sqlDoConsumo.params).toEqual([LINK.id]);
    expect(sqlDoConsumo.sql).toMatch(/`id` = \?/);
    expect(sqlDoConsumo.sql).toMatch(/`usedAt` IS NULL/);
    expect(sqlDoConsumo.sql).toMatch(/`expiresAt` > NOW\(\)/);

    // (4) O hash vai para a conta dona do link.
    const [senha] = atualizacoes("users");
    expect(senha.valores).toEqual({ passwordHash: "hash-da-senha-nova" });
    expect(consulta(senha.filtro).params).toEqual([LINK.userId]);

    // (5) Todas as sessões da conta, uma vez.
    expect(espioes.revogar).toHaveBeenCalledTimes(1);
    expect(espioes.revogar).toHaveBeenCalledWith(LINK.userId);

    // (6) A auditoria, com a conta, o IP de quem pediu (o CF-Connecting-IP, e
    // não o proxy do req.ip nem o primeiro item do X-Forwarded-For) e o
    // navegador, e nada além disso.
    expect(espioes.auditar).toHaveBeenCalledTimes(1);
    expect(espioes.auditar.mock.calls[0][0]).toEqual({
      userId: LINK.userId,
      action: "PASSWORD_RESET",
      resource: "auth",
      ipAddress: IP_DA_CLIENTE,
      userAgent: "vitest",
      status: "success",
      riskLevel: "medium",
    });
    const auditado = JSON.stringify(espioes.auditar.mock.calls);
    expect(auditado).not.toContain(TOKEN_CRU);
    expect(auditado).not.toContain(hashPasswordResetToken(TOKEN_CRU));
    expect(auditado).not.toContain(SENHA_NOVA);
  });

  it("link inválido, vencido ou já usado: BAD_REQUEST, e nada é gasto, trocado, revogado nem auditado", async () => {
    await expect(redefinir()).rejects.toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_DO_LINK_INVALIDO });

    expect(passos()).toEqual(["select:password_reset_tokens"]);
    // "Vencido" e "já usado" são o WHERE da busca, que o banco falso não avalia.
    const sqlDaBusca = consulta(selecoes()[0].filtro).sql;
    expect(sqlDaBusca).toMatch(/`usedAt` IS NULL/);
    expect(sqlDaBusca).toMatch(/`expiresAt` > NOW\(\)/);
    expect(espioes.hash).not.toHaveBeenCalled();
    expect(espioes.revogar).not.toHaveBeenCalled();
    expect(espioes.auditar).not.toHaveBeenCalled();
  });

  it("link gasto por outro envio depois do SELECT (0 linhas): o mesmo BAD_REQUEST, a transação é desfeita e a senha não muda", async () => {
    estado.linhasDoLink = [LINK];
    estado.alcancadas = [0];
    await expect(redefinir()).rejects.toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_DO_LINK_INVALIDO });

    expect(passos()).toEqual([
      "select:password_reset_tokens",
      "hash",
      "begin",
      "tx.update:password_reset_tokens",
      "rollback",
    ]);
    expect(gravadas()).toEqual([]);
    expect(espioes.revogar).not.toHaveBeenCalled();
    expect(espioes.auditar).not.toHaveBeenCalled();
  });

  it("dois envios do mesmo link ao mesmo tempo: os dois calculam o hash, mas só um troca a senha, derruba as sessões e audita", async () => {
    // Os dois leem o link antes de qualquer um gastá-lo: o primeiro fica parado
    // no hash, antes da transação, enquanto o segundo lê o link e chega ao hash;
    // só então os dois seguem. O banco deixa um só alcançar a linha. A ordem é
    // fixa (o segundo só começa com o primeiro no hash), e um envio que cair
    // antes do hash abre a barreira: o teste falha pela asserção, mostrando o
    // erro, e não por tempo esgotado.
    let chegaram = 0;
    let soltar!: () => void;
    const osDoisNoHash = new Promise<void>(resolver => { soltar = () => resolver(); });
    let primeiroNoHash!: () => void;
    const primeiroChegou = new Promise<void>(resolver => { primeiroNoHash = () => resolver(); });
    estado.barreiraDoHash = () => {
      chegaram += 1;
      if (chegaram === 1) primeiroNoHash();
      if (chegaram === 2) soltar();
      return osDoisNoHash;
    };
    estado.linhasDoLink = [LINK];
    estado.alcancadas = [1, 0];
    const primeiro = redefinir();
    void primeiro.catch(() => {}).finally(primeiroNoHash);
    await primeiroChegou;
    const segundo = redefinir();
    void segundo.catch(() => {}).finally(soltar);
    const resultados = await Promise.allSettled([primeiro, segundo]);

    expect(resultados.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const recusados = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(recusados).toHaveLength(1);
    expect(recusados[0].reason).toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_DO_LINK_INVALIDO });
    expect(selecoes()).toHaveLength(2);
    expect(espioes.hash).toHaveBeenCalledTimes(2);
    expect(atualizacoes("password_reset_tokens")).toHaveLength(2);
    // Do envio que perdeu, nada ficou: um gasto do link e uma troca de senha.
    expect(gravadas()).toEqual(["password_reset_tokens", "users"]);
    expect(atualizacoes("users")).toHaveLength(1);
    expect(espioes.revogar).toHaveBeenCalledTimes(1);
    expect(espioes.auditar).toHaveBeenCalledTimes(1);
  });

  it("banco fora do ar ao gastar o link é erro de banco, e não link inválido; a transação é desfeita e nada muda", async () => {
    estado.linhasDoLink = [LINK];
    estado.erroAoGastar = new BancoIndisponivel();
    await comAQuedaNoConsole(() =>
      expect(redefinir()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL }),
    );

    expect(passos()).toEqual(["select:password_reset_tokens", "hash", "begin", "rollback"]);
    expect(gravadas()).toEqual([]);
    expect(espioes.revogar).not.toHaveBeenCalled();
    expect(espioes.auditar).not.toHaveBeenCalled();
  });

  it("erro no UPDATE de users: a transação desfaz o gasto do link, a senha não muda, e o reenvio com o mesmo link funciona", async () => {
    estado.linhasDoLink = [LINK];
    estado.erroAoTrocarSenha = new BancoIndisponivel();
    await comAQuedaNoConsole(() =>
      expect(redefinir()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL }),
    );

    expect(passos()).toEqual([
      "select:password_reset_tokens",
      "hash",
      "begin",
      "tx.update:password_reset_tokens",
      "rollback",
    ]);
    // O link continua valendo e a senha continua a antiga: nada ficou gravado.
    expect(gravadas()).toEqual([]);
    expect(espioes.revogar).not.toHaveBeenCalled();
    expect(espioes.auditar).not.toHaveBeenCalled();

    // A tela manda tentar de novo, e o mesmo link funciona.
    estado.erroAoTrocarSenha = null;
    await expect(redefinir()).resolves.toEqual({ success: true });
    expect(gravadas()).toEqual(["password_reset_tokens", "users"]);
    expect(espioes.revogar).toHaveBeenCalledTimes(1);
    expect(espioes.auditar).toHaveBeenCalledTimes(1);
  });
});
