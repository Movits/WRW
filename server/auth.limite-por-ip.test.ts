import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Cadastro e login contam POR CHAMADA e pelo IP real (CF-Connecting-IP no
 * Render). Um HTTP em lote do tRPC leva quantas chamadas quiser, então o limite
 * por minuto não basta. E o bloqueio por e-mail + IP do loginUser usava o
 * primeiro item do X-Forwarded-For, que o cliente escreve: trocar o cabeçalho
 * a cada tentativa driblava o bloqueio. Esse bloqueio (no banco) também lê e
 * grava sem trava, então tentativas simultâneas passavam todas: o teto em
 * memória por rede + e-mail é o que segura a força bruta contra uma conta.
 */

const dubles = vi.hoisted(() => ({
  registerUser: vi.fn(async (_params: { name: string; email: string; password: string }) => ({ userId: 1, openId: "email_x" })),
  loginUser: vi.fn(async (_params: { email: string; password: string; ip?: string; userAgent?: string }): Promise<unknown> => {
    throw new Error("E-mail ou senha incorretos.");
  }),
  createAuditLog: vi.fn(async (_dados: { ipAddress?: string }) => undefined),
}));

vi.mock("./auth", () => ({
  registerUser: dubles.registerUser,
  loginUser: dubles.loginUser,
  toPublicUser: (u: unknown) => u,
  gravarCookieDaSessao: vi.fn(),
}));

vi.mock("./security", async importOriginal => ({
  ...(await importOriginal<typeof import("./security")>()),
  createAuditLog: dubles.createAuditLog,
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  exigirDb: async () => {
    throw new Error("este teste não fala com o banco");
  },
}));

import {
  authRouter,
  CADASTROS_POR_REDE,
  LOGINS_POR_REDE,
  LOGINS_POR_REDE_E_EMAIL,
  tetoDeCadastro,
  tetoDeLogin,
  tetoDeLoginPorEmail,
} from "./routers/auth";
import type { TrpcContext } from "./_core/context";

const IP_DO_EVENTO = "198.51.100.23";

let sequencia = 0;
/** Cada chamada com X-Forwarded-For e True-Client-IP diferentes, como faria quem forja. */
function contexto(ipReal = IP_DO_EVENTO): TrpcContext {
  sequencia += 1;
  return {
    user: null,
    req: {
      headers: {
        "cf-connecting-ip": ipReal,
        "x-forwarded-for": `203.0.113.${sequencia % 250}, ${ipReal}, 10.226.0.9`,
        "true-client-ip": `192.0.2.${sequencia % 250}`,
        "user-agent": "vitest",
      },
      ip: "10.226.0.9",
      socket: { remoteAddress: "10.226.0.9" },
    },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  } as unknown as TrpcContext;
}

const cadastrar = (ipReal?: string) =>
  authRouter.createCaller(contexto(ipReal)).register({ name: "Membra", email: `m${sequencia}@exemplo.test`, password: "senha-forte-123" });
/** Cada tentativa com um e-mail diferente: o teto por rede, sem o por e-mail. */
const entrar = (ipReal?: string) =>
  authRouter.createCaller(contexto(ipReal)).login({ email: `m${sequencia}@exemplo.test`, password: "errada" });
/** Sempre a mesma conta: o teto por rede + e-mail. */
const entrarNaMesmaConta = (ipReal?: string, email = "membra@exemplo.test") =>
  authRouter.createCaller(contexto(ipReal)).login({ email, password: "errada" });

async function codigoDoErro(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
    return "ok";
  } catch (erro) {
    return erro instanceof TRPCError ? erro.code : String(erro);
  }
}

describe("cadastro e login: teto por IP real, por chamada", () => {
  beforeEach(() => {
    process.env.RENDER = "true";
    tetoDeCadastro.esquecer();
    tetoDeLogin.esquecer();
    tetoDeLoginPorEmail.esquecer();
    dubles.registerUser.mockClear();
    dubles.loginUser.mockClear();
    dubles.createAuditLog.mockClear();
  });
  afterEach(() => {
    delete process.env.RENDER;
  });

  it("os valores: 400 cadastros e 600 logins por rede, 10 logins por rede + e-mail", () => {
    expect(CADASTROS_POR_REDE).toBe(400);
    expect(LOGINS_POR_REDE).toBe(600);
    expect(LOGINS_POR_REDE_E_EMAIL).toBe(10);
  });

  it("400 cadastros do mesmo IP passam; o 401º leva TOO_MANY_REQUESTS (não BAD_REQUEST) mesmo trocando o X-Forwarded-For", async () => {
    for (let i = 0; i < 400; i++) await cadastrar();
    expect(dubles.registerUser).toHaveBeenCalledTimes(400);

    expect(await codigoDoErro(cadastrar())).toBe("TOO_MANY_REQUESTS");
    expect(dubles.registerUser).toHaveBeenCalledTimes(400);
    // Outra rede não é afetada.
    expect(await codigoDoErro(cadastrar("203.0.113.200"))).toBe("ok");
  });

  it("IPv6: trocar de endereço dentro da mesma /56 não abre teto novo", async () => {
    for (let i = 0; i < 400; i++) await cadastrar(`2001:db8:abcd:12${(i % 256).toString(16).padStart(2, "0")}::${(i + 1).toString(16)}`);
    expect(await codigoDoErro(cadastrar("2001:db8:abcd:12ff::9999"))).toBe("TOO_MANY_REQUESTS");
  });

  it("600 tentativas de login do mesmo IP chegam ao loginUser; a 601ª leva TOO_MANY_REQUESTS (não UNAUTHORIZED)", async () => {
    for (let i = 0; i < 600; i++) expect(await codigoDoErro(entrar())).toBe("UNAUTHORIZED");
    expect(dubles.loginUser).toHaveBeenCalledTimes(600);

    expect(await codigoDoErro(entrar())).toBe("TOO_MANY_REQUESTS");
    expect(dubles.loginUser).toHaveBeenCalledTimes(600);
    expect(await codigoDoErro(entrar("203.0.113.200"))).toBe("UNAUTHORIZED");
  });

  it("força bruta contra UMA conta: 10 tentativas por rede + e-mail, mesmo SIMULTÂNEAS; outra conta do mesmo wi-fi segue entrando", async () => {
    // Todas no mesmo tique, como num HTTP em lote: o teto é reservado antes do
    // primeiro await, então a contagem não fica velha.
    const codigos = await Promise.all(Array.from({ length: 50 }, () => codigoDoErro(entrarNaMesmaConta())));
    expect(codigos.filter(c => c === "UNAUTHORIZED")).toHaveLength(10);
    expect(codigos.filter(c => c === "TOO_MANY_REQUESTS")).toHaveLength(40);
    expect(dubles.loginUser).toHaveBeenCalledTimes(10);

    // Maiúsculas não abrem teto novo.
    expect(await codigoDoErro(entrarNaMesmaConta(undefined, "MEMBRA@Exemplo.test"))).toBe("TOO_MANY_REQUESTS");
    // Outra pessoa no mesmo wi-fi não é afetada.
    expect(await codigoDoErro(entrarNaMesmaConta(undefined, "outra@exemplo.test"))).toBe("UNAUTHORIZED");
  });

  it("IPv6: trocar de endereço dentro da mesma /56 não zera a força bruta contra a conta, e o bloqueio do banco recebe a rede", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await codigoDoErro(entrarNaMesmaConta(`2001:db8:abcd:12${i.toString(16).padStart(2, "0")}::${(i + 1).toString(16)}`))).toBe("UNAUTHORIZED");
    }
    expect(await codigoDoErro(entrarNaMesmaConta("2001:db8:abcd:12ff::beef"))).toBe("TOO_MANY_REQUESTS");

    const chamada = dubles.loginUser.mock.calls[0][0] as { ip?: string; chaveDoBloqueio?: string };
    // A sessão guarda o IP cru; o bloqueio por e-mail + IP conta pela /56.
    expect(chamada.ip).toBe("2001:db8:abcd:1200::1");
    expect(chamada.chaveDoBloqueio).toBe("2001:db8:abcd:1200::/56");
  });

  it("a fila do bcrypt cheia chega à tela como TOO_MANY_REQUESTS com a mensagem, não como UNAUTHORIZED ou BAD_REQUEST", async () => {
    const cheia = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas entradas e cadastros ao mesmo tempo." });
    dubles.loginUser.mockRejectedValueOnce(cheia);
    dubles.registerUser.mockRejectedValueOnce(cheia);

    await expect(entrar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: cheia.message });
    await expect(cadastrar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: cheia.message });
  });

  it("o loginUser (bloqueio por e-mail + IP) e a auditoria recebem o CF-Connecting-IP, não o primeiro item do X-Forwarded-For", async () => {
    dubles.loginUser.mockResolvedValueOnce({
      token: "jwt",
      user: { id: 7, name: "Membra", email: "membra@exemplo.test", role: "silver", onboardingCompleted: true },
      expiresAt: new Date(),
    });

    await authRouter.createCaller(contexto()).login({ email: "membra@exemplo.test", password: "certa" });

    expect(dubles.loginUser.mock.calls[0][0].ip).toBe(IP_DO_EVENTO);
    expect(dubles.createAuditLog.mock.calls[0][0].ipAddress).toBe(IP_DO_EVENTO);
  });
});
