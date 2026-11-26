import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

import bcrypt from "bcryptjs";
import { getDb } from "./db";
import { auditLogs, contasGoogle, loginAttempts, passwordResetTokens, sessions, users } from "../drizzle/schema";
import { authRouter } from "./routers/auth";
import { hashPasswordResetToken } from "./password-reset-security";
import { sdk } from "./_core/sdk";
import { abrirSessao } from "./sessao";
import { COOKIE_NAME } from "@shared/const";
import { ERRO_DA_CONTA_GOOGLE } from "@shared/entrar-com-google";
import {
  ACAO_DESLIGADA,
  ACAO_LIGADA,
  configuracaoDaEntradaComGoogle,
} from "./entrar-com-google";
import { registrarRotasDeEntrarComGoogle } from "./rotas-de-entrar-com-google";
import { contaGoogleRouter } from "./routers/contaGoogle";
import type { TrpcContext } from "./_core/context";

/**
 * "Continuar com Google" (A8) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula), pelo HTTP de verdade: a ida, a tela da Google
 * (o dublê do fetch devolve o id_token com o nonce que a ida mandou) e a volta,
 * com a sessão de verdade (sdk.authenticateRequest). O que se prova: criar a
 * conta só no cadastro, entrar pelo sub, nunca ligar sozinho a conta que já
 * tem o e-mail, o ligar com sessão recente, desligar, a redefinição de senha
 * tirar o vínculo e a auditoria na transação.
 */

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const CLIENTE = "id-do-cliente.apps.googleusercontent.com";

let servidor: Server;
let base = "";
const buscar = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let identidadeDaGoogle: Record<string, unknown> = {};

type Conta = typeof users.$inferSelect;
const idsDeContas = new Set<number>();
const emails = new Set<string>();

async function db() {
  return (await getDb())!;
}

const novoEmail = (nome: string) => {
  const email = `eg-${nome}-${crypto.randomUUID().slice(0, 8)}@exemplo.test`;
  emails.add(email);
  return email;
};
const novoSub = () => `sub-${crypto.randomUUID()}`;

async function criarConta(email: string, senha: string | null = "senha-de-teste", ativa = true): Promise<Conta> {
  const openId = `eg-${crypto.randomUUID()}`;
  await (await db()).insert(users).values({
    openId, email, name: "Teste Google", onboardingCompleted: true, isActive: ativa,
    passwordHash: senha ? bcrypt.hashSync(senha, 4) : null,
  });
  const [conta] = await (await db()).select().from(users).where(eq(users.openId, openId)).limit(1);
  idsDeContas.add(conta.id);
  return conta;
}

async function contaPeloEmail(email: string) {
  const [conta] = await (await db()).select().from(users).where(eq(users.email, email)).limit(1);
  if (conta) idsDeContas.add(conta.id);
  return conta ?? null;
}

const vinculosDe = async (userId: number) => (await db()).select().from(contasGoogle).where(eq(contasGoogle.userId, userId));
const vinculoDoSub = async (sub: string) => (await db()).select().from(contasGoogle).where(eq(contasGoogle.googleSub, sub));
const auditoriaDe = async (userId: number, acao: string) =>
  (await db()).select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, acao)));
const sessoesAtivas = async (userId: number) =>
  (await db()).select().from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.isActive, true)));

function cookieDa(resposta: Response, nome: string): string | null {
  const todos = resposta.headers.getSetCookie?.() ?? [resposta.headers.get("set-cookie") ?? ""];
  const achado = todos.find(c => c.startsWith(`${nome}=`) && !/Expires=Thu, 01 Jan 1970/.test(c));
  return achado ? achado.split(";")[0] : null;
}

/** A ida, a "tela da Google" e a volta. `sessao` é o cookie da sessão de quem liga. */
async function fluxo(modo: "entrar" | "cadastrar" | "ligar", opcoes: { sub: string; email: string; sessao?: string; idToken?: Record<string, unknown>; voltar?: string }) {
  const cabecalhos: Record<string, string> = opcoes.sessao ? { cookie: opcoes.sessao } : {};
  const voltar = opcoes.voltar ? `&voltar=${encodeURIComponent(opcoes.voltar)}` : "";
  const ida = await fetch(`${base}/api/entrar-com-google/ir?modo=${modo}${voltar}`, { redirect: "manual", headers: cabecalhos });
  const naGoogle = ida.headers.get("location") ?? "";
  if (!naGoogle.startsWith("https://accounts.google.com/")) return { ida, volta: null };
  const url = new URL(naGoogle);
  identidadeDaGoogle = {
    iss: "https://accounts.google.com", aud: CLIENTE, sub: opcoes.sub, email: opcoes.email, email_verified: true,
    nonce: url.searchParams.get("nonce"), exp: Math.floor(Date.now() / 1000) + 3600, ...opcoes.idToken,
  };
  const cookieDaIda = cookieDa(ida, "wrw_entrar_google")!;
  const volta = await fetch(`${base}/api/entrar-com-google/retorno?code=codigo-da-google&state=${encodeURIComponent(url.searchParams.get("state")!)}`, {
    redirect: "manual",
    headers: { cookie: [cookieDaIda, opcoes.sessao].filter(Boolean).join("; ") },
  });
  return { ida, volta };
}

const destino = (resposta: Response | null) => resposta?.headers.get("location") ?? null;

async function sessaoDe(conta: Conta) {
  const sessao = await abrirSessao({ usuaria: conta, ip: "127.0.0.1", userAgent: "vitest" });
  return { sessao, cookie: `${COOKIE_NAME}=${sessao.token}` };
}

function caller(conta: Conta) {
  const ctx = { user: conta, req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" }, res: {} } as unknown as TrpcContext;
  return contaGoogleRouter.createCaller(ctx);
}

describe.skipIf(!temBanco)("Continuar com Google (A8), com o banco", () => {
  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", false);
    registrarRotasDeEntrarComGoogle(app, {
      configuracao: () => configuracaoDaEntradaComGoogle({
        ENTRAR_COM_GOOGLE: "ligado", GOOGLE_OAUTH_CLIENT_ID: CLIENTE, GOOGLE_OAUTH_CLIENT_SECRET: "segredo", FRONTEND_URL: base,
      }),
      autenticar: req => sdk.authenticateRequest(req),
      buscar: (url, init) => buscar(url, init),
      agora: () => Date.now(),
    });
    await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise(fim => servidor?.close(fim));
    const banco = await db();
    const ids = [...idsDeContas];
    if (ids.length) {
      await apagarPelaChave(banco, contasGoogle, inArray(contasGoogle.userId, ids));
      await apagarPelaChave(banco, sessions, inArray(sessions.userId, ids));
      await apagarPelaChave(banco, auditLogs, inArray(auditLogs.userId, ids));
      await apagarPelaChave(banco, passwordResetTokens, inArray(passwordResetTokens.userId, ids));
      await apagarPelaChave(banco, users, inArray(users.id, ids));
    }
    if (emails.size) await apagarPelaChave(banco, loginAttempts, inArray(loginAttempts.identifier, [...emails]));
  });

  beforeEach(() => {
    buscar.mockReset();
    buscar.mockImplementation(async () => new Response(JSON.stringify({
      access_token: "acesso-que-nao-fica", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/userinfo.email",
      id_token: [
        Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
        Buffer.from(JSON.stringify(identidadeDaGoogle)).toString("base64url"),
        "assinatura",
      ].join("."),
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("o cadastro cria a conta Bronze, sem senha, com o e-mail verificado, liga o sub e entra; a volta seguinte entra na mesma", async () => {
    const email = novoEmail("nova");
    const sub = novoSub();
    const { volta } = await fluxo("cadastrar", { sub, email });
    expect(destino(volta)).toBe("/login");
    const cookie = cookieDa(volta!, COOKIE_NAME);
    expect(cookie).not.toBeNull();

    const conta = await contaPeloEmail(email);
    expect(conta).toMatchObject({ role: "bronze", passwordHash: null, emailVerified: true, loginMethod: "google", onboardingCompleted: false });
    expect(await vinculosDe(conta!.id)).toEqual([expect.objectContaining({ googleSub: sub, emailGoogle: email })]);
    expect(await auditoriaDe(conta!.id, ACAO_LIGADA)).toHaveLength(1);
    expect((await auditoriaDe(conta!.id, "LOGIN")).map(l => l.details)).toEqual([{ metodo: "google" }]);
    // A sessão é a do login: a linha existe, e o sdk aceita o cookie.
    expect(await sessoesAtivas(conta!.id)).toHaveLength(1);
    const lida = await sdk.authenticateRequest({ headers: { cookie } } as never);
    expect(lida.id).toBe(conta!.id);
    // Nada foi revogado na Google (derrubaria a Google Agenda da mesma conta).
    expect(buscar.mock.calls.map(([url]) => url)).toEqual(["https://oauth2.googleapis.com/token"]);

    // O login, agora, entra na mesma conta, mesmo com o e-mail da Google mudado.
    const outra = await fluxo("entrar", { sub, email: novoEmail("mudou"), voltar: "/agenda" });
    expect(destino(outra.volta)).toBe("/login?voltar=%2Fagenda");
    expect(await sessoesAtivas(conta!.id)).toHaveLength(2);
    const [{ total }] = await (await db()).select({ total: sql<number>`count(*)` }).from(users).where(eq(users.email, email));
    expect(Number(total)).toBe(1);
  });

  it("no login, sem conta e sem vínculo, manda ao cadastro e não cria nada", async () => {
    const email = novoEmail("semconta");
    const { volta } = await fluxo("entrar", { sub: novoSub(), email });
    expect(destino(volta)).toBe("/register?conta-google=sem-conta");
    expect(await contaPeloEmail(email)).toBeNull();
    expect(cookieDa(volta!, COOKIE_NAME)).toBeNull();
  });

  it("a conta que já tem o e-mail NÃO é ligada sozinha: conta-existe, sem sessão e sem vínculo", async () => {
    const email = novoEmail("existe");
    const conta = await criarConta(email);
    for (const modo of ["entrar", "cadastrar"] as const) {
      const sub = novoSub();
      const { volta } = await fluxo(modo, { sub, email: email.toUpperCase() });
      expect(destino(volta)).toBe(`${modo === "entrar" ? "/login" : "/register"}?conta-google=conta-existe`);
      expect(cookieDa(volta!, COOKIE_NAME)).toBeNull();
      expect(await vinculoDoSub(sub)).toEqual([]);
    }
    expect(await vinculosDe(conta.id)).toEqual([]);
    expect(await sessoesAtivas(conta.id)).toEqual([]);
  });

  it("o e-mail não verificado pela Google não cria conta", async () => {
    const email = novoEmail("naoverif");
    const { volta } = await fluxo("cadastrar", { sub: novoSub(), email, idToken: { email_verified: false } });
    expect(destino(volta)).toBe("/register?conta-google=email-nao-verificado");
    expect(await contaPeloEmail(email)).toBeNull();
  });

  it("o id_token sem o nonce da ida é recusado", async () => {
    const email = novoEmail("nonce");
    const { volta } = await fluxo("cadastrar", { sub: novoSub(), email, idToken: { nonce: "de-outra-ida" } });
    expect(destino(volta)).toBe("/register?conta-google=erro");
    expect(await contaPeloEmail(email)).toBeNull();
  });

  it("a conta desativada não entra, e o bloqueio do login por senha vale também aqui", async () => {
    const desativada = await criarConta(novoEmail("desativada"), "senha", false);
    const subDesativada = novoSub();
    await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: desativada.id, googleSub: subDesativada, emailGoogle: null, createdAt: Date.now() });
    expect(destino((await fluxo("entrar", { sub: subDesativada, email: desativada.email! })).volta)).toBe("/login?conta-google=desativada");
    expect(await sessoesAtivas(desativada.id)).toEqual([]);

    const bloqueada = await criarConta(novoEmail("bloqueada"));
    const subBloqueada = novoSub();
    await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: bloqueada.id, googleSub: subBloqueada, emailGoogle: null, createdAt: Date.now() });
    await (await db()).insert(loginAttempts).values({ identifier: bloqueada.email!, ipAddress: "127.0.0.1", attemptCount: 99 });
    expect(destino((await fluxo("entrar", { sub: subBloqueada, email: bloqueada.email! })).volta)).toBe("/login?conta-google=muitas-tentativas");
    expect(await sessoesAtivas(bloqueada.id)).toEqual([]);
  });

  it("a auditoria que falha derruba a entrada: a sessão aberta cai e o cookie não sai", async () => {
    const conta = await criarConta(novoEmail("auditoria"));
    const sub = novoSub();
    await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: conta.id, googleSub: sub, emailGoogle: null, createdAt: Date.now() });
    const banco = await db();
    const original = banco.transaction.bind(banco);
    const espiao = vi.spyOn(banco, "transaction").mockImplementation(((tarefa: (tx: object) => Promise<unknown>, config?: unknown) =>
      original(async tx => tarefa(new Proxy(tx, {
        get(alvo, propriedade) {
          if (propriedade === "insert") {
            return (tabela: unknown) => tabela === auditLogs
              ? { values: async () => { throw new Error("auditoria fora do ar"); } }
              : alvo.insert(tabela as typeof auditLogs);
          }
          const valor = Reflect.get(alvo, propriedade, alvo);
          return typeof valor === "function" ? valor.bind(alvo) : valor;
        },
      })), config as never)) as typeof banco.transaction);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { volta } = await fluxo("entrar", { sub, email: conta.email! });
      expect(destino(volta)).toBe("/login?conta-google=erro");
      expect(cookieDa(volta!, COOKIE_NAME)).toBeNull();
    } finally {
      espiao.mockRestore();
    }
    expect(await sessoesAtivas(conta.id)).toEqual([]);
    const [vinculo] = await vinculosDe(conta.id);
    expect(vinculo.ultimoUsoEm).toBeNull();
  });

  describe("ligar no Perfil", () => {
    it("com a sessão recente, liga, audita, e a conta passa a entrar pelo Google", async () => {
      const conta = await criarConta(novoEmail("liga"));
      const { cookie } = await sessaoDe(conta);
      const sub = novoSub();
      const emailGoogle = novoEmail("gmail");
      const { volta } = await fluxo("ligar", { sub, email: emailGoogle, sessao: cookie });
      expect(destino(volta)).toBe("/profile?conta-google=ligada");
      expect(await vinculosDe(conta.id)).toEqual([expect.objectContaining({ googleSub: sub, emailGoogle })]);
      expect((await auditoriaDe(conta.id, ACAO_LIGADA)).map(l => l.details)).toEqual([{ origem: "perfil" }]);
      // Sem a função no ambiente do teste, o estado vem mesmo assim: a tela mostra o Desligar.
      expect(await caller(conta).estado()).toMatchObject({ disponivel: false, origem: null, ligada: true, email: emailGoogle, temSenha: true });

      const entrada = await fluxo("entrar", { sub, email: emailGoogle });
      expect(destino(entrada.volta)).toBe("/login");
      expect(cookieDa(entrada.volta!, COOKIE_NAME)).not.toBeNull();
    });

    it("a conta Google de outra conta e a segunda conta Google são recusadas", async () => {
      const primeira = await criarConta(novoEmail("primeira"));
      const segunda = await criarConta(novoEmail("segunda"));
      const sub = novoSub();
      expect(destino((await fluxo("ligar", { sub, email: novoEmail("g1"), sessao: (await sessaoDe(primeira)).cookie })).volta))
        .toBe("/profile?conta-google=ligada");
      expect(destino((await fluxo("ligar", { sub, email: novoEmail("g1b"), sessao: (await sessaoDe(segunda)).cookie })).volta))
        .toBe("/profile?conta-google=em-outra-conta");
      expect(destino((await fluxo("ligar", { sub: novoSub(), email: novoEmail("g2"), sessao: (await sessaoDe(primeira)).cookie })).volta))
        .toBe("/profile?conta-google=outra-ligada");
      expect(await vinculosDe(segunda.id)).toEqual([]);
      expect(await vinculosDe(primeira.id)).toHaveLength(1);
    });

    it("a sessão aberta há mais de 10 minutos pede para entrar de novo, antes da Google", async () => {
      const conta = await criarConta(novoEmail("velha"));
      const { sessao, cookie } = await sessaoDe(conta);
      await (await db()).update(sessions).set({ createdAt: sql`NOW() - INTERVAL 30 MINUTE` }).where(eq(sessions.sessionToken, sessao.sessionToken));
      const { ida, volta } = await fluxo("ligar", { sub: novoSub(), email: novoEmail("gv"), sessao: cookie });
      expect(destino(ida)).toBe("/profile?conta-google=entre-de-novo");
      expect(volta).toBeNull();
      expect(buscar).not.toHaveBeenCalled();
    });

    it("a sessão derrubada no meio (a redefinição de senha) não liga", async () => {
      const conta = await criarConta(novoEmail("derrubada"));
      const { sessao, cookie } = await sessaoDe(conta);
      const ida = await fetch(`${base}/api/entrar-com-google/ir?modo=ligar`, { redirect: "manual", headers: { cookie } });
      const url = new URL(ida.headers.get("location")!);
      identidadeDaGoogle = {
        iss: "https://accounts.google.com", aud: CLIENTE, sub: novoSub(), email: novoEmail("gd"), email_verified: true,
        nonce: url.searchParams.get("nonce"), exp: Math.floor(Date.now() / 1000) + 3600,
      };
      await (await db()).update(sessions).set({ isActive: false }).where(eq(sessions.sessionToken, sessao.sessionToken));
      const volta = await fetch(`${base}/api/entrar-com-google/retorno?code=c&state=${url.searchParams.get("state")}`, {
        redirect: "manual", headers: { cookie: `${cookieDa(ida, "wrw_entrar_google")}; ${cookie}` },
      });
      expect(destino(volta)).toBe("/profile?conta-google=erro");
      expect(await vinculosDe(conta.id)).toEqual([]);
    });
  });

  describe("desligar e a redefinição de senha", () => {
    it("desliga com auditoria; sem vínculo, NOT_FOUND", async () => {
      const conta = await criarConta(novoEmail("desliga"));
      await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: conta.id, googleSub: novoSub(), emailGoogle: null, createdAt: Date.now() });
      await caller(conta).desligar();
      expect(await vinculosDe(conta.id)).toEqual([]);
      expect((await auditoriaDe(conta.id, ACAO_DESLIGADA)).map(l => l.details)).toEqual([{ origem: "perfil" }]);
      await expect(caller(conta).desligar()).rejects.toMatchObject({ code: "NOT_FOUND", message: ERRO_DA_CONTA_GOOGLE.naoLigada });
    });

    it("a conta sem senha nem chave de acesso não desliga a única porta", async () => {
      const conta = await criarConta(novoEmail("semsenha"), null);
      await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: conta.id, googleSub: novoSub(), emailGoogle: null, createdAt: Date.now() });
      await expect(caller(conta).desligar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: ERRO_DA_CONTA_GOOGLE.semSenha });
      expect(await vinculosDe(conta.id)).toHaveLength(1);
      expect(await auditoriaDe(conta.id, ACAO_DESLIGADA)).toEqual([]);
    });

    it("a redefinição de senha tira o vínculo, com a auditoria na mesma transação", async () => {
      const conta = await criarConta(novoEmail("reset"));
      await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: conta.id, googleSub: novoSub(), emailGoogle: null, createdAt: Date.now() });
      const outra = await criarConta(novoEmail("reset-outra"));
      await (await db()).insert(contasGoogle).values({ id: crypto.randomUUID(), userId: outra.id, googleSub: novoSub(), emailGoogle: null, createdAt: Date.now() });
      const bruto = crypto.randomBytes(48).toString("hex");
      await (await db()).insert(passwordResetTokens).values({ userId: conta.id, token: hashPasswordResetToken(bruto), expiresAt: new Date(Date.now() + 60 * 60_000) });
      const ctx = { user: null, req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } }, res: { cookie: vi.fn(), clearCookie: vi.fn() } } as unknown as TrpcContext;
      await expect(authRouter.createCaller(ctx).resetPassword({ token: bruto, newPassword: "senha-nova-123" })).resolves.toEqual({ success: true });
      expect(await vinculosDe(outra.id)).toHaveLength(1);
      expect(await vinculosDe(conta.id)).toEqual([]);
      expect((await auditoriaDe(conta.id, ACAO_DESLIGADA)).map(l => l.details)).toEqual([{ origem: "redefinicao_de_senha" }]);
    });
  });
});
