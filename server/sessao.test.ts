import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { jwtVerify } from "jose";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * A sessão de usuária nasce só em abrirSessao (server/sessao.ts): a linha em
 * `sessions` e o token (JWT) com o sessionToken dela, os dois com a janela de
 * 90 dias desde o último uso (server/duracao-da-sessao.ts). É o caminho do
 * login por senha e será o da passkey. O sdk recusa token de usuária sem
 * sessionToken (server/sdk-sessao-sem-token.test.ts), e a varredura de
 * server/sessao-guarda.test.ts impede outro arquivo de assinar JWT.
 */

const banco = vi.hoisted(() => ({
  linhas: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  /** exigirDb lança, como sem DATABASE_URL. */
  semBanco: false,
  /** O erro que o INSERT lança, montado com os valores que ele recebeu. */
  falhaNoInsert: null as null | ((valores: Record<string, unknown>) => Error),
}));

vi.mock("./db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const { BancoIndisponivel } = await import("./banco-indisponivel");
  return {
    exigirDb: async () => {
      if (banco.semBanco) throw new BancoIndisponivel();
      return {
        insert: (tabela: Parameters<typeof getTableName>[0]) => ({
          values: async (valores: Record<string, unknown>) => {
            if (banco.falhaNoInsert) throw banco.falhaNoInsert(valores);
            banco.linhas.push({ tabela: getTableName(tabela), valores });
          },
        }),
      };
    },
  };
});

import { BancoIndisponivel } from "./banco-indisponivel";
import { DURACAO_DA_SESSAO_MS } from "./duracao-da-sessao";
import { abrirSessao, identificadorDoAplicativo, ipGravadoNaSessao } from "./sessao";

const NOVENTA_DIAS_MS = 90 * 24 * 60 * 60 * 1000;
const SEGREDO = new TextEncoder().encode(process.env.JWT_SECRET);
const USUARIA = { id: 7, openId: "email_abc", name: "  Membra Teste  ", email: "membra@exemplo.test" };

/** O erro que o driver lança com o banco fora do ar: a mensagem do Drizzle leva os parâmetros. */
const quedaNoInsert = (valores: Record<string, unknown>) =>
  new DrizzleQueryError(
    "insert into `sessions` (`userId`, `sessionToken`, `ipAddress`, `userAgent`, `expiresAt`, `isActive`) values (?, ?, ?, ?, ?, ?)",
    Object.values(valores),
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), { code: "ECONNREFUSED", errno: -111 }),
  );

let log: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;
/** Tudo o que foi para o log nesta execução, numa string só. */
const registrado = () => JSON.stringify([...log.mock.calls, ...erro.mock.calls]);

const appIdOriginal = process.env.VITE_APP_ID;

beforeEach(() => {
  banco.linhas = [];
  banco.semBanco = false;
  banco.falhaNoInsert = null;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  erro = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (appIdOriginal === undefined) delete process.env.VITE_APP_ID;
  else process.env.VITE_APP_ID = appIdOriginal;
});

describe("abrirSessao: a linha em sessions", () => {
  it("grava uma linha só, com os campos de hoje, que vence em 90 dias", async () => {
    const antes = Date.now();
    const sessao = await abrirSessao({ usuaria: USUARIA, ip: " 198.51.100.23 , 10.0.0.1", userAgent: "x".repeat(600) });
    const depois = Date.now();

    expect(banco.linhas).toEqual([
      {
        tabela: "sessions",
        valores: {
          userId: 7,
          sessionToken: sessao.sessionToken,
          // O primeiro item, sem espaços; o navegador cortado em 500.
          ipAddress: "198.51.100.23",
          userAgent: "x".repeat(500),
          expiresAt: sessao.expiresAt,
          isActive: true,
        },
      },
    ]);
    expect(sessao.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(DURACAO_DA_SESSAO_MS).toBe(NOVENTA_DIAS_MS);
    expect(sessao.expiresAt.getTime()).toBeGreaterThanOrEqual(antes + NOVENTA_DIAS_MS);
    expect(sessao.expiresAt.getTime()).toBeLessThanOrEqual(depois + NOVENTA_DIAS_MS);
  });

  it("sem IP grava 'unknown', sem navegador grava null, e IP comprido é cortado no tamanho da coluna", async () => {
    await abrirSessao({ usuaria: USUARIA });
    await abrirSessao({ usuaria: USUARIA, ip: "f".repeat(60) });

    expect(banco.linhas[0].valores).toMatchObject({ ipAddress: "unknown", userAgent: null });
    expect(banco.linhas[1].valores.ipAddress).toBe("f".repeat(45));
    // O mesmo valor que o login usa como chave do bloqueio quando não recebe a de rede.
    expect(ipGravadoNaSessao(undefined)).toBe("unknown");
    expect(ipGravadoNaSessao("")).toBe("unknown");
    expect(ipGravadoNaSessao(" 203.0.113.9 , 10.1.1.1")).toBe("203.0.113.9");
  });

  it("cada sessão tem o próprio token", async () => {
    const primeira = await abrirSessao({ usuaria: USUARIA });
    const segunda = await abrirSessao({ usuaria: USUARIA });
    expect(primeira.sessionToken).not.toBe(segunda.sessionToken);
    expect(banco.linhas.map(linha => linha.valores.sessionToken)).toEqual([primeira.sessionToken, segunda.sessionToken]);
  });
});

describe("abrirSessao: o token (JWT)", () => {
  it("leva openId, appId, name e o sessionToken da linha, e vence com a janela de 90 dias", async () => {
    const antes = Date.now();
    const sessao = await abrirSessao({ usuaria: USUARIA, ip: "198.51.100.23" });
    const depois = Date.now();

    const { payload, protectedHeader } = await jwtVerify(sessao.token, SEGREDO, { algorithms: ["HS256"] });

    expect(protectedHeader).toEqual({ alg: "HS256", typ: "JWT" });
    expect(Object.keys(payload).sort()).toEqual(["appId", "exp", "iat", "name", "openId", "sessionToken"]);
    expect(payload).toMatchObject({
      openId: "email_abc",
      appId: identificadorDoAplicativo(),
      name: "Membra Teste",
      sessionToken: sessao.sessionToken,
    });
    // O sdk confere este token no banco: é o da linha gravada.
    expect(payload.sessionToken).toBe(banco.linhas[0].valores.sessionToken);
    // 90 dias a partir da assinatura (o segundo de folga do exp é o arredondamento).
    expect(payload.exp! * 1000).toBeGreaterThanOrEqual(antes + NOVENTA_DIAS_MS - 1000);
    expect(payload.exp! * 1000).toBeLessThanOrEqual(depois + NOVENTA_DIAS_MS);
    // O setIssuedAt() lê o relógio antes do Date.now() do exp: se o segundo virar
    // entre as duas leituras, exp − iat ganha 1. A folga fica desse lado.
    expect(payload.exp! - payload.iat!).toBeGreaterThanOrEqual(NOVENTA_DIAS_MS / 1000);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(NOVENTA_DIAS_MS / 1000 + 1);
  });

  it("nome vazio vira o começo do e-mail, e sem e-mail vira 'usuario': o sdk recusa name vazio", async () => {
    const comEmail = await abrirSessao({ usuaria: { ...USUARIA, name: "   " } });
    const semNada = await abrirSessao({ usuaria: { ...USUARIA, name: null, email: null } });

    expect((await jwtVerify(comEmail.token, SEGREDO)).payload.name).toBe("membra");
    expect((await jwtVerify(semNada.token, SEGREDO)).payload.name).toBe("usuario");
  });

  it("o appId é o identificadorDoAplicativo: VITE_APP_ID vazio cai no padrão, valor de verdade é respeitado", async () => {
    process.env.VITE_APP_ID = "";
    const padrao = await abrirSessao({ usuaria: USUARIA });
    process.env.VITE_APP_ID = " mmm-producao ";
    const configurado = await abrirSessao({ usuaria: USUARIA });

    expect((await jwtVerify(padrao.token, SEGREDO)).payload.appId).toBe("mmm-os");
    expect((await jwtVerify(configurado.token, SEGREDO)).payload.appId).toBe("mmm-producao");
  });
});

describe("abrirSessao: o log nunca leva o token inteiro", () => {
  it("no caminho feliz, só o começo do token (e nada do JWT)", async () => {
    const sessao = await abrirSessao({ usuaria: USUARIA, ip: "198.51.100.23", userAgent: "vitest" });

    expect(registrado()).not.toContain(sessao.sessionToken);
    expect(registrado()).not.toContain(sessao.token);
    expect(registrado()).toContain(sessao.sessionToken.slice(0, 8));
  });

  it("o INSERT que falha não leva ao log os parâmetros do Drizzle (o token, o IP e o navegador)", async () => {
    let tokenTentado = "";
    banco.falhaNoInsert = valores => {
      tokenTentado = valores.sessionToken as string;
      return quedaNoInsert(valores);
    };

    await expect(abrirSessao({ usuaria: USUARIA, ip: "198.51.100.23", userAgent: "Navegador/1.0" })).rejects.toThrow();

    expect(tokenTentado).toMatch(/^[0-9a-f]{64}$/);
    expect(registrado()).not.toContain(tokenTentado);
    expect(registrado()).not.toContain("198.51.100.23");
    expect(registrado()).not.toContain("Navegador/1.0");
    // O motivo chega ao log, e o começo do token acha a tentativa.
    expect(registrado()).toContain("ECONNREFUSED");
    expect(registrado()).toContain(tokenTentado.slice(0, 8));
  });

  it("o token que aparecer na mensagem do próprio erro (chave duplicada) sai cortado", async () => {
    let tokenTentado = "";
    banco.falhaNoInsert = valores => {
      tokenTentado = valores.sessionToken as string;
      return new DrizzleQueryError(
        "insert into `sessions` (...) values (...)",
        [],
        Object.assign(new Error(`Duplicate entry '${tokenTentado}' for key 'sessions.sessionToken'`), { code: "ER_DUP_ENTRY", errno: 1062 }),
      );
    };

    await expect(abrirSessao({ usuaria: USUARIA })).rejects.toThrow();

    expect(registrado()).toContain("ER_DUP_ENTRY");
    expect(registrado()).not.toContain(tokenTentado);
  });
});

describe("abrirSessao: banco fora do ar é erro", () => {
  it("sem banco configurado: lança BancoIndisponivel, sem linha e sem token", async () => {
    banco.semBanco = true;
    await expect(abrirSessao({ usuaria: USUARIA })).rejects.toBeInstanceOf(BancoIndisponivel);
    expect(banco.linhas).toEqual([]);
  });

  it("queda do driver no INSERT: lança o erro de sempre do login e não devolve token", async () => {
    banco.falhaNoInsert = quedaNoInsert;
    await expect(abrirSessao({ usuaria: USUARIA })).rejects.toThrow(new Error("Erro interno ao criar sessão. Tente novamente."));
    expect(banco.linhas).toEqual([]);
  });
});
