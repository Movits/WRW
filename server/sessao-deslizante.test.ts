import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Login persistente (pedido do Roberto em 10/11/2026): quem já entrou não
 * digita e-mail e senha de novo. A sessão dura 90 dias desde o ÚLTIMO USO
 * (server/duracao-da-sessao.ts), e não mais 8 h desde o login:
 *
 * - o banco empurra `sessions.expiresAt` a cada requisição autenticada
 *   (`validateSessionToken`);
 * - o token e o cookie são reemitidos uma vez por dia (`renovarCookieDaSessao`,
 *   chamado pelo createContext só depois de o sdk autenticar).
 *
 * O que encerra a sessão continua sendo a linha no banco: o token renovado leva
 * o mesmo `sessionToken`, então sair, redefinir a senha e desativar a conta
 * seguem valendo na hora. E o token sem `sessionToken` (o do sdk.signSession,
 * que escapa da revogação) nunca é renovado.
 */

const banco = vi.hoisted(() => ({
  sessao: null as null | { userId: number; isActive: boolean; expiresAt: Date | null },
  atualizacoes: [] as Record<string, unknown>[],
  /** Os valores do WHERE de cada UPDATE, na ordem. */
  filtros: [] as unknown[][],
  /** O próximo UPDATE falha como o banco fora do ar. */
  falhar: false,
}));

vi.mock("./db", () => ({
  exigirDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (banco.sessao ? [banco.sessao] : []) }),
      }),
    }),
    update: () => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (condicao: unknown) => {
          if (banco.falhar) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          banco.atualizacoes.push(valores);
          const { MySqlDialect } = await import("drizzle-orm/mysql-core");
          banco.filtros.push(new MySqlDialect().sqlToQuery(condicao as never).params);
        },
      }),
    }),
  }),
}));

const autenticar = vi.hoisted(() => vi.fn());
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: autenticar } }));

import * as jose from "jose";
import { COOKIE_NAME } from "@shared/const";
import { gravarCookieDaSessao, renovarCookieDaSessao } from "./auth";
import { DURACAO_DA_SESSAO_MS, RENOVAR_O_TOKEN_A_CADA_MS } from "./duracao-da-sessao";
import { validateSessionToken } from "./security";
import { createContext } from "./_core/context";
import { ForbiddenError } from "@shared/_core/errors";
import { BancoIndisponivel } from "./banco-indisponivel";
import { authRouter } from "./routers/auth";

const SEGREDO = new TextEncoder().encode(process.env.JWT_SECRET);
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const DADOS = { openId: "email_abc", appId: "mmm-os", name: "Membra", sessionToken: "s".repeat(64) };

/** Um token como o do login, emitido `emitidoHaMs` atrás e vencendo `duraMs` depois disso. */
async function token(opcoes: { emitidoHaMs?: number; duraMs?: number; dados?: Record<string, unknown>; segredo?: Uint8Array } = {}) {
  const emitido = Date.now() - (opcoes.emitidoHaMs ?? 0);
  return new jose.SignJWT(opcoes.dados ?? DADOS)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(Math.floor(emitido / 1000))
    .setExpirationTime(Math.floor((emitido + (opcoes.duraMs ?? DURACAO_DA_SESSAO_MS)) / 1000))
    .sign(opcoes.segredo ?? SEGREDO);
}

function requisicao(cookie?: string) {
  return {
    headers: cookie ? { cookie: `outro=1; ${COOKIE_NAME}=${cookie}` } : {},
    protocol: "https",
  } as never;
}

function resposta() {
  return { cookie: vi.fn(), clearCookie: vi.fn() };
}

/** O que foi gravado no cookie da sessão, já decodificado. */
async function cookieGravado(res: ReturnType<typeof resposta>) {
  expect(res.cookie).toHaveBeenCalledTimes(1);
  const [nome, valor, opcoes] = res.cookie.mock.calls[0];
  const { payload } = await jose.jwtVerify(valor, SEGREDO, { algorithms: ["HS256"] });
  return { nome, payload, opcoes };
}

beforeEach(() => {
  banco.sessao = null;
  banco.atualizacoes = [];
  banco.falhar = false;
  banco.filtros = [];
  autenticar.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gravarCookieDaSessao: o cookie dura a janela inteira", () => {
  it("grava 90 dias, HttpOnly, SameSite=Lax e Secure no HTTPS", () => {
    const res = resposta();
    gravarCookieDaSessao(requisicao(), res as never, "jwt");
    expect(res.cookie).toHaveBeenCalledWith(COOKIE_NAME, "jwt", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      maxAge: DURACAO_DA_SESSAO_MS,
    });
  });

  it("a janela é de 90 dias e a renovação, de um dia", () => {
    expect(DURACAO_DA_SESSAO_MS).toBe(90 * DIA);
    expect(RENOVAR_O_TOKEN_A_CADA_MS).toBe(DIA);
  });
});

describe("renovarCookieDaSessao: token e cookie novos uma vez por dia", () => {
  it("token emitido agora: não reemite (nada de Set-Cookie em toda requisição)", async () => {
    const res = resposta();
    await renovarCookieDaSessao(requisicao(await token()), res as never);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("token com mais de um dia: reemite com o mesmo sessionToken e mais 90 dias", async () => {
    const res = resposta();
    await renovarCookieDaSessao(requisicao(await token({ emitidoHaMs: DIA + HORA })), res as never);
    const { nome, payload, opcoes } = await cookieGravado(res);
    expect(nome).toBe(COOKIE_NAME);
    expect(payload).toMatchObject(DADOS);
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now() + DURACAO_DA_SESSAO_MS - 60_000);
    expect(opcoes).toMatchObject({ httpOnly: true, maxAge: DURACAO_DA_SESSAO_MS });
  });

  it("token de 8 h emitido antes desta mudança: renova na hora, e quem já estava logada fica", async () => {
    const res = resposta();
    await renovarCookieDaSessao(requisicao(await token({ emitidoHaMs: HORA, duraMs: 8 * HORA })), res as never);
    const { payload } = await cookieGravado(res);
    expect(payload.sessionToken).toBe(DADOS.sessionToken);
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now() + DURACAO_DA_SESSAO_MS - 60_000);
  });

  it("token sem sessionToken (o do sdk.signSession, que escapa da revogação): nunca renova", async () => {
    const { sessionToken: _fora, ...semSessao } = DADOS;
    const res = resposta();
    await renovarCookieDaSessao(requisicao(await token({ emitidoHaMs: 2 * DIA, dados: semSessao })), res as never);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("token assinado com outro segredo, vencido ou ausente: não faz nada", async () => {
    const outro = new TextEncoder().encode("outro-segredo-qualquer");
    const res = resposta();
    await renovarCookieDaSessao(requisicao(await token({ emitidoHaMs: 2 * DIA, segredo: outro })), res as never);
    await renovarCookieDaSessao(requisicao(await token({ emitidoHaMs: 10 * HORA, duraMs: 8 * HORA })), res as never);
    await renovarCookieDaSessao(requisicao("nao-e-jwt"), res as never);
    await renovarCookieDaSessao(requisicao(), res as never);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe("validateSessionToken: o uso empurra o prazo da sessão no banco", () => {
  it("sessão viva: grava a atividade e um prazo de 90 dias a partir de agora, no mesmo UPDATE", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T12:00:00Z") });
    banco.sessao = { userId: 7, isActive: true, expiresAt: new Date("2026-11-10T13:00:00Z") };

    await expect(validateSessionToken(DADOS.sessionToken)).resolves.toBe(7);

    expect(banco.atualizacoes).toEqual([
      {
        lastActivityAt: new Date("2026-11-10T12:00:00Z"),
        expiresAt: new Date(Date.parse("2026-11-10T12:00:00Z") + DURACAO_DA_SESSAO_MS),
      },
    ]);
  });

  it("sessão vencida não ressuscita: recusa e só a marca como inativa", async () => {
    banco.sessao = { userId: 7, isActive: true, expiresAt: new Date(Date.now() - 1000) };
    await expect(validateSessionToken(DADOS.sessionToken)).resolves.toBeNull();
    expect(banco.atualizacoes).toEqual([{ isActive: false }]);
  });

  it("sessão revogada (saiu, redefiniu a senha, conta desativada): recusa sem tocar no prazo", async () => {
    banco.sessao = { userId: 7, isActive: false, expiresAt: new Date(Date.now() + DIA) };
    await expect(validateSessionToken(DADOS.sessionToken)).resolves.toBeNull();
    expect(banco.atualizacoes).toEqual([]);
  });
});

describe("createContext: renova só quem o sdk autenticou", () => {
  it("usuária autenticada com token de mais de um dia: sai com cookie novo", async () => {
    autenticar.mockResolvedValue({ id: 7 });
    const res = resposta();
    const ctx = await createContext({ req: requisicao(await token({ emitidoHaMs: 2 * DIA })), res } as never);
    expect(ctx.user).toEqual({ id: 7 });
    await cookieGravado(res);
  });

  it("sessão recusada pelo sdk (revogada, conta desativada): nenhum cookie novo", async () => {
    autenticar.mockRejectedValue(new Error("Session has been revoked"));
    const res = resposta();
    const ctx = await createContext({ req: requisicao(await token({ emitidoHaMs: 2 * DIA })), res } as never);
    expect(ctx.user).toBeNull();
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

/**
 * Revisão da PR #179: com o cookie de 90 dias, um cookie que o sdk recusa
 * (sessão revogada, conta desativada) ficava meses no navegador, gravando um
 * REVOKED_SESSION_ACCESS_ATTEMPT de risco alto a cada requisição. Dois caminhos
 * levavam a ele: a resposta atrasada de uma requisição em voo, que renovava o
 * cookie DEPOIS do "Sair", e redefinir a senha logada no mesmo navegador.
 */
describe("createContext: cookie recusado sai do navegador", () => {
  it("sessão revogada: apaga o cookie", async () => {
    autenticar.mockRejectedValue(ForbiddenError("Session has been revoked"));
    const res = resposta();
    await createContext({ req: requisicao(await token()), res } as never);
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ maxAge: -1, httpOnly: true, path: "/" }));
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("sem cookie da sessão: não manda Set-Cookie nenhum (visitante comum)", async () => {
    autenticar.mockRejectedValue(ForbiddenError("Invalid session cookie"));
    const res = resposta();
    await createContext({ req: requisicao(), res } as never);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it("banco fora do ar não é 'sessão recusada': o cookie fica", async () => {
    autenticar.mockRejectedValue(new BancoIndisponivel());
    const res = resposta();
    const ctx = await createContext({ req: requisicao(await token()), res } as never);
    expect(ctx.bancoIndisponivel).toBe(true);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});

/**
 * Revisão da PR #179: o logout engolia a falha do banco e respondia sucesso.
 * Com a sessão de 90 dias, a linha que não foi revogada deixava qualquer cópia
 * do token valendo e se renovando por meses.
 */
describe("auth.logout: só diz que saiu depois de revogar a linha no banco", () => {
  const sair = (cookie: string | undefined, res: ReturnType<typeof resposta>) =>
    authRouter.createCaller({ user: null, req: requisicao(cookie), res } as never).logout();

  it("revoga pelo sessionToken do token e apaga o cookie", async () => {
    banco.sessao = { userId: 7, isActive: true, expiresAt: new Date(Date.now() + DIA) };
    const res = resposta();
    await expect(sair(await token(), res)).resolves.toEqual({ success: true });
    expect(banco.atualizacoes).toEqual([{ isActive: false }]);
    expect(banco.filtros).toEqual([[DADOS.sessionToken]]);
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ maxAge: -1 }));
  });

  it("cookie que não é JWT: revoga pelo próprio valor", async () => {
    const res = resposta();
    await expect(sair("valor-antigo", res)).resolves.toEqual({ success: true });
    expect(banco.filtros).toEqual([["valor-antigo"]]);
  });

  it("banco fora do ar: responde erro (não diz que saiu), mas o cookie sai deste navegador", async () => {
    banco.falhar = true;
    const res = resposta();
    await expect(sair(await token(), res)).rejects.toThrow();
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.objectContaining({ maxAge: -1 }));
  });

  it("sem cookie: só responde que saiu", async () => {
    const res = resposta();
    await expect(sair(undefined, res)).resolves.toEqual({ success: true });
    expect(banco.atualizacoes).toEqual([]);
  });
});
