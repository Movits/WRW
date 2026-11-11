import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import superjson from "superjson";
import { initTRPC } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "@shared/const";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  chaveDoLimite,
  criarDiagnosticoDoIp,
  criarLimitador,
  criarLimiteDaApi,
  criarLimiteGeral,
  LIMITES_DA_API,
  LIMITES_GERAIS,
  MENSAGEM_DO_LIMITE,
  pularNoLimiteGeral,
} from "./_core/limite-de-requisicoes";

/**
 * O limite por minuto diante do lançamento de 16/09 (~200 pessoas, muitas no
 * mesmo wi-fi). O que se trava, com servidor HTTP de verdade e os limitadores
 * que server/_core/index.ts monta:
 *
 * 1. Arquivo estático não conta no limite geral (antes, cada /assets gastava 1
 *    dos 200/min).
 * 2. Pessoas logadas no mesmo IP têm balde próprio (300/min cada) e não gastam
 *    o do IP; anônimas no mesmo IP continuam limitadas, agora em 1200/min.
 * 3. X-Forwarded-For e True-Client-IP forjados não abrem balde novo; fora do
 *    Render, nem o CF-Connecting-IP.
 * 4. O 429 da API chega ao cliente tRPC como erro com mensagem, e não como
 *    "Unable to transform response from server" (tela em branco).
 */

const SEGREDO = "segredo-do-limite-somente-para-testes";
const NO_RENDER = { RENDER: "true" } as NodeJS.ProcessEnv;
const FORA_DO_RENDER = {} as NodeJS.ProcessEnv;

const abertos: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (abertos.length) await abertos.pop()!();
});

async function subir(montar: (app: Express) => void): Promise<string> {
  const app = express();
  // Como em produção: com trust proxy 1, req.ip é o ÚLTIMO item do X-Forwarded-For.
  app.set("trust proxy", 1);
  montar(app);
  const servidor = createServer(app);
  await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
  abertos.push(
    () =>
      new Promise<void>(resolve => {
        servidor.closeAllConnections();
        servidor.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

async function sessao(openId: string, segredo = SEGREDO, validade = "1h") {
  const jwt = await new SignJWT({ openId, appId: "mmm-os", name: "Membra" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(validade)
    .sign(new TextEncoder().encode(segredo));
  return `${COOKIE_NAME}=${jwt}`;
}

function rateLimit(resposta: Response): { limit: number; remaining: number } | null {
  const valor = resposta.headers.get("ratelimit");
  if (!valor) return null;
  const campos = Object.fromEntries(valor.split(",").map(par => par.trim().split("=")));
  return { limit: Number(campos.limit), remaining: Number(campos.remaining) };
}

/** `total` pedidos, `lote` por vez; devolve os status. */
async function emLotes(total: number, pedir: (i: number) => Promise<Response>, lote = 50): Promise<number[]> {
  const status: number[] = [];
  for (let inicio = 0; inicio < total; inicio += lote) {
    const respostas = await Promise.all(
      Array.from({ length: Math.min(lote, total - inicio) }, (_, j) => pedir(inicio + j)),
    );
    for (const r of respostas) {
      status.push(r.status);
      await r.arrayBuffer();
    }
  }
  return status;
}

describe("valores do lançamento", () => {
  it("API: 300/min por conta e 1200/min por IP; geral: 600 e 600", () => {
    expect(LIMITES_DA_API).toEqual({ usuaria: 300, ip: 1200 });
    expect(LIMITES_GERAIS).toEqual({ usuaria: 600, ip: 600 });
  });
});

describe("pularNoLimiteGeral", () => {
  const pedido = (method: string, url: string) => ({ method, url, path: url.split("?")[0] });

  it("pula estáticos do build e de client/public em GET e HEAD", () => {
    for (const url of ["/assets/index-DpIvNu2D.js", "/brand/favicon-32.png", "/images/hero-globo.webp", "/manifest.webmanifest"]) {
      expect(pularNoLimiteGeral(pedido("GET", url), FORA_DO_RENDER)).toBe(true);
      expect(pularNoLimiteGeral(pedido("HEAD", url), FORA_DO_RENDER)).toBe(true);
    }
  });

  it("conta a página, o storage, o cron e qualquer POST, mesmo em caminho de estático", () => {
    for (const url of ["/", "/dashboard", "/manus-storage/x.png", "/api/scheduled/cleanup-sessions", "/assetsX", "/favicon.ico", "/manifest.json"]) {
      expect(pularNoLimiteGeral(pedido("GET", url), FORA_DO_RENDER)).toBe(false);
    }
    expect(pularNoLimiteGeral(pedido("POST", "/assets/x.js"), FORA_DO_RENDER)).toBe(false);
  });

  it("pula /api/trpc (tem limite próprio), mas não um caminho que só começa igual", () => {
    expect(pularNoLimiteGeral(pedido("POST", "/api/trpc/auth.login?batch=1"), FORA_DO_RENDER)).toBe(true);
    expect(pularNoLimiteGeral(pedido("GET", "/api/trpcX"), FORA_DO_RENDER)).toBe(false);
  });

  it("em dev, continua pulando os módulos do Vite e tudo fora de /api/", () => {
    const dev = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(pularNoLimiteGeral(pedido("GET", "/client/src/main.tsx"), dev)).toBe(true);
    expect(pularNoLimiteGeral(pedido("GET", "/@vite/client"), dev)).toBe(true);
    expect(pularNoLimiteGeral(pedido("GET", "/src/App.tsx.hot-update.js"), dev)).toBe(true);
    expect(pularNoLimiteGeral(pedido("GET", "/api/scheduled/x"), dev)).toBe(false);
  });

  it("fora de dev, nome de módulo do Vite não pula nada — nem escondido na query string", () => {
    for (const url of [
      "/manus-storage/abc?x=.hot-update.js",
      "/qualquer?x=.hot-update.js",
      "/@vite/client",
      "/node_modules/.vite/deps/react.js",
    ]) {
      expect(pularNoLimiteGeral(pedido("GET", url), FORA_DO_RENDER)).toBe(false);
    }
  });
});

describe("chaveDoLimite", () => {
  const req = (cookie?: string) => ({
    headers: { ...(cookie ? { cookie } : {}), "cf-connecting-ip": "198.51.100.23" },
    ip: "10.226.0.9",
    socket: {} as never,
  });

  it("sessão válida conta pela conta; sem sessão, pelo IP real", async () => {
    expect(await chaveDoLimite(req(await sessao("email_a")), SEGREDO, NO_RENDER)).toEqual({ chave: "usuaria:email_a", tipo: "usuaria" });
    expect(await chaveDoLimite(req(), SEGREDO, NO_RENDER)).toEqual({ chave: "ip:198.51.100.23", tipo: "ip" });
  });

  it("JWT assinado com outro segredo, vencido ou lixo conta pelo IP", async () => {
    expect((await chaveDoLimite(req(await sessao("email_a", "outro-segredo")), SEGREDO, NO_RENDER)).tipo).toBe("ip");
    expect((await chaveDoLimite(req(await sessao("email_a", SEGREDO, "-1s")), SEGREDO, NO_RENDER)).tipo).toBe("ip");
    expect((await chaveDoLimite(req(`${COOKIE_NAME}=nao-e-jwt`), SEGREDO, NO_RENDER)).tipo).toBe("ip");
  });

  it("sem segredo configurado, ninguém ganha balde de conta", async () => {
    expect((await chaveDoLimite(req(await sessao("email_a")), "", NO_RENDER)).tipo).toBe("ip");
  });
});

describe("limite geral de produção: estático não conta", () => {
  it("20 arquivos estáticos não gastam nada, e a página ainda tem 599 de 600", async () => {
    const base = await subir(app => {
      app.use(criarLimiteGeral({ segredo: SEGREDO, ambiente: FORA_DO_RENDER }));
      app.get("*", (_req, res) => res.send("ok"));
    });

    for (let i = 0; i < 20; i++) {
      const estatico = await fetch(`${base}/assets/index-${i}.js`);
      expect(estatico.status).toBe(200);
      expect(rateLimit(estatico)).toBeNull();
    }
    const pagina = await fetch(`${base}/`);
    expect(pagina.status).toBe(200);
    // O limite antigo contava cada estático: sobrariam 179 de 200.
    expect(rateLimit(pagina)).toEqual({ limit: 600, remaining: 599 });
  });
});

describe("limite da API de produção: 200 pessoas no mesmo IP", () => {
  const IP_DO_EVENTO = "198.51.100.23";

  it("200 pessoas logadas no mesmo IP, 7 pedidos cada (1400), passam todas e não gastam o balde do IP", { timeout: 60_000 }, async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: NO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const cookies = await Promise.all(Array.from({ length: 200 }, (_, i) => sessao(`email_pessoa_${i}`)));

    const status = await emLotes(200 * 7, i =>
      fetch(`${base}/api/trpc/notifications.list`, {
        headers: { cookie: cookies[i % 200], "cf-connecting-ip": IP_DO_EVENTO },
      }),
    );
    expect(status.filter(s => s !== 200)).toEqual([]);

    const umaDelas = await fetch(`${base}/api/trpc/notifications.list`, {
      headers: { cookie: cookies[0], "cf-connecting-ip": IP_DO_EVENTO },
    });
    expect(rateLimit(umaDelas)).toEqual({ limit: 300, remaining: 300 - 8 });

    // O IP não foi tocado: a primeira anônima dele tem o balde cheio.
    const anonima = await fetch(`${base}/api/trpc/auth.me`, { headers: { "cf-connecting-ip": IP_DO_EVENTO } });
    expect(rateLimit(anonima)).toEqual({ limit: 1200, remaining: 1199 });
  });

  it("uma conta sozinha para em 300/min, sem travar outra conta nem as anônimas do mesmo IP", { timeout: 60_000 }, async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: NO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const [a, b] = [await sessao("email_a"), await sessao("email_b")];
    const pedir = (cookie?: string) =>
      fetch(`${base}/api/trpc/x`, { headers: { ...(cookie ? { cookie } : {}), "cf-connecting-ip": IP_DO_EVENTO } });

    const status = await emLotes(300, () => pedir(a));
    expect(status.filter(s => s !== 200)).toEqual([]);
    expect((await pedir(a)).status).toBe(429);
    expect((await pedir(b)).status).toBe(200);
    expect((await pedir()).status).toBe(200);
  });

  it("anônimas no mesmo IP: 1200 passam e a 1201ª leva 429", { timeout: 60_000 }, async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: NO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const pedir = () => fetch(`${base}/api/trpc/auth.register`, { method: "POST", headers: { "cf-connecting-ip": IP_DO_EVENTO } });

    const status = await emLotes(1200, pedir);
    expect(status.filter(s => s !== 200)).toEqual([]);
    const excedente = await pedir();
    expect(excedente.status).toBe(429);
    // Outra rede não é afetada.
    const outraRede = await fetch(`${base}/api/trpc/auth.register`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.99" } });
    expect(outraRede.status).toBe(200);
  });
});

describe("cabeçalho forjado não abre balde novo", () => {
  it("no Render: mesmo CF-Connecting-IP com X-Forwarded-For e True-Client-IP trocando a cada pedido gasta o MESMO balde", async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: NO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const restantes: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${base}/api/trpc/system.health`, {
        headers: {
          "cf-connecting-ip": "198.51.100.23",
          // Com trust proxy 1 e a chave antiga (req.ip), cada um destes era um balde novo.
          "x-forwarded-for": `203.0.113.${i}, 10.226.0.${i}`,
          "true-client-ip": `192.0.2.${i}`,
        },
      });
      restantes.push(rateLimit(r)!.remaining);
    }
    expect(restantes).toEqual([1199, 1198, 1197, 1196, 1195]);
  });

  it("fora do Render: trocar o CF-Connecting-IP também não abre balde novo", async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: FORA_DO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const restantes: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await fetch(`${base}/api/trpc/system.health`, { headers: { "cf-connecting-ip": `198.51.100.${i}` } });
      restantes.push(rateLimit(r)!.remaining);
    }
    expect(restantes).toEqual([1199, 1198, 1197]);
  });

  it("JWT com outro segredo conta como anônima (limite do IP), não como conta", async () => {
    const base = await subir(app => {
      app.use("/api/trpc", criarLimiteDaApi({ segredo: SEGREDO, ambiente: NO_RENDER }));
      app.all("/api/trpc/*", (_req, res) => res.json({ ok: true }));
    });
    const r = await fetch(`${base}/api/trpc/x`, {
      headers: { cookie: await sessao("email_a", "outro-segredo"), "cf-connecting-ip": "198.51.100.23" },
    });
    expect(rateLimit(r)).toEqual({ limit: 1200, remaining: 1199 });
  });
});

describe("o 429 da API chega à tela com mensagem", () => {
  const t = initTRPC.create({ transformer: superjson });
  const roteador = t.router({ ping: t.procedure.query(() => "pong") });

  async function clienteAtras(limitador: express.RequestHandler) {
    const base = await subir(app => {
      app.use("/api/trpc", limitador);
      app.use("/api/trpc", createExpressMiddleware({ router: roteador, createContext: () => ({}) }));
    });
    return createTRPCClient<typeof roteador>({ links: [httpBatchLink({ url: `${base}/api/trpc`, transformer: superjson })] });
  }

  it("o cliente tRPC de verdade recebe TRPCClientError com a mensagem, TOO_MANY_REQUESTS e 429", async () => {
    const cliente = await clienteAtras(criarLimitador({ limites: { usuaria: 1, ip: 1 }, segredo: SEGREDO, ambiente: FORA_DO_RENDER }));

    expect(await cliente.ping.query()).toBe("pong");
    const erro = await cliente.ping.query().catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TRPCClientError);
    const clientError = erro as TRPCClientError<typeof roteador>;
    expect(clientError.message).toBe(MENSAGEM_DO_LIMITE);
    expect(clientError.data?.code).toBe("TOO_MANY_REQUESTS");
    expect(clientError.data?.httpStatus).toBe(429);
    // Sem path: ForgotPassword e ResetPassword usam a falta dele para separar
    // este 429 do TOO_MANY_REQUESTS lançado dentro da rota.
    expect(clientError.data?.path).toBeUndefined();
    // A tela traduz a frase do servidor (no pt-BR, a mesma frase), e não mostra
    // o genérico de "servidor indisponível".
    expect(mensagemDeErroParaTela(clientError, chave => `[${chave}]`)).toBe("[errors.tooManyRequests]");
  });

  it("num lote, todas as chamadas recebem a mesma mensagem", async () => {
    const cliente = await clienteAtras(criarLimitador({ limites: { usuaria: 1, ip: 1 }, segredo: SEGREDO, ambiente: FORA_DO_RENDER }));
    await cliente.ping.query();

    const erros = await Promise.all([cliente.ping.query().catch(e => e), cliente.ping.query().catch(e => e)]);
    expect(erros.map(e => (e as Error).message)).toEqual([MENSAGEM_DO_LIMITE, MENSAGEM_DO_LIMITE]);
  });

  it("controle: com o corpo antigo ({ error: '...' }) o cliente lançava 'Unable to transform response from server'", async () => {
    let pedidos = 0;
    const cliente = await clienteAtras((_req, res, next) => {
      pedidos += 1;
      if (pedidos > 1) {
        res.status(429).json({ error: "Limite de API excedido. Tente novamente em breve." });
        return;
      }
      next();
    });
    await cliente.ping.query();
    const erro = (await cliente.ping.query().catch((e: unknown) => e)) as Error;
    expect(erro.message).toBe("Unable to transform response from server");
  });

  it("fora da API, o 429 é texto puro com a mesma frase", async () => {
    const base = await subir(app => {
      app.use(criarLimitador({ limites: { usuaria: 1, ip: 1 }, segredo: SEGREDO, ambiente: FORA_DO_RENDER }));
      app.get("*", (_req, res) => res.send("ok"));
    });
    await (await fetch(`${base}/`)).text();
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(429);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await r.text()).toBe(MENSAGEM_DO_LIMITE);
  });
});

describe("montagem em server/_core/index.ts", () => {
  const fonte = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
  const posicao = (trecho: string) => {
    const i = fonte.indexOf(trecho);
    expect(i, `não achei ${trecho} em index.ts`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("os dois limitadores vêm ANTES de qualquer leitor de corpo e do tRPC", () => {
    const geral = posicao("app.use(globalLimiter)");
    const api = posicao('app.use("/api/trpc", apiLimiter)');
    const primeiroLeitor = Math.min(posicao("app.use(corpoGrandeParaUploads)"), posicao("express.json("), posicao("express.urlencoded("));
    const trpc = posicao("createExpressMiddleware(");
    expect(geral).toBeLessThan(api);
    expect(api).toBeLessThan(primeiroLeitor);
    expect(api).toBeLessThan(trpc);
  });

  it("com o limite antes do leitor, o pedido excedente com JSON malformado leva 429 e não é lido", async () => {
    let lidos = 0;
    const base = await subir(app => {
      app.use("/api/trpc", criarLimitador({ limites: { usuaria: 1, ip: 1 }, segredo: SEGREDO, ambiente: FORA_DO_RENDER }));
      app.use((req, _res, next) => {
        lidos += 1;
        next();
      });
      app.use(express.json({ limit: "5mb" }));
      app.post("/api/trpc/x", (_req, res) => res.json({ ok: true }));
    });
    const malformado = () =>
      fetch(`${base}/api/trpc/x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{".repeat(1024) });

    expect((await malformado()).status).toBe(400);
    expect((await malformado()).status).toBe(429);
    expect(lidos).toBe(1);
  });
});

describe("criarDiagnosticoDoIp", () => {
  it("uma linha só, com contagens e sem nenhum IP", () => {
    const registrar = vi.fn();
    const diagnostico = criarDiagnosticoDoIp(4, registrar);
    const next = vi.fn();
    const pedidos = [
      { "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": "198.51.100.23, 172.71.0.1, 10.226.0.9" },
      { "cf-connecting-ip": "198.51.100.24", "x-forwarded-for": "203.0.113.7, 198.51.100.24, 172.71.0.1" },
      { "cf-connecting-ip": "nao-e-ip" },
      {},
      { "cf-connecting-ip": "198.51.100.25", "x-forwarded-for": "198.51.100.25" },
    ];
    for (const headers of pedidos) diagnostico({ headers } as never, {} as never, next);

    expect(next).toHaveBeenCalledTimes(5);
    expect(registrar).toHaveBeenCalledTimes(1);
    const linha = String(registrar.mock.calls[0][0]);
    expect(linha).toContain("primeiros 4 pedidos");
    expect(linha).toContain("2 com CF-Connecting-IP válido");
    expect(linha).toContain("1 iguais ao primeiro item");
    expect(linha).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
  });
});
