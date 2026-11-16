import crypto from "crypto";
import { parse as parseCookieHeader } from "cookie";
import type { Request, Response } from "express";
import * as jose from "jose";
import { COOKIE_NAME } from "@shared/const";
import { sessions, type User } from "../drizzle/schema";
import { getSessionCookieOptions } from "./_core/cookies";
import { requireSecret } from "./_core/env";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { DURACAO_DA_SESSAO_MS, RENOVAR_O_TOKEN_A_CADA_MS } from "./duracao-da-sessao";

// ─── O módulo da sessão de usuária ────────────────────────────
// A sessão nasce só em `abrirSessao`: grava a linha em `sessions` e assina o
// token (JWT) com o `sessionToken` dela. O `sdk.authenticateRequest`
// (server/_core/sdk.ts) confere essa linha em toda requisição, e é ela que
// sair, redefinir a senha, desativar e excluir a conta derrubam; por isso o sdk
// recusa token de usuária sem `sessionToken` (só o cron passa sem ele). O login
// por senha (`loginUser`, server/auth.ts) abre a sessão por aqui, e a passkey
// vai abrir pelo mesmo caminho. A guarda server/sessao-guarda.test.ts falha se
// outro arquivo do servidor assinar JWT.
//
// Este módulo não importa server/auth.ts: auth.ts importa este, e o contrário
// fecharia um ciclo.

const JWT_SECRET = new TextEncoder().encode(requireSecret("JWT_SECRET"));

/**
 * O `appId` que vai no JWT. NUNCA vazio: `sdk.verifySession` exige
 * `isNonEmptyString(appId)` (server/_core/sdk.ts) e recusa a sessão inteira
 * sem ele — a pessoa loga, a sessão é criada no banco, e no request seguinte
 * já está deslogada, com "[Auth] Session payload missing required fields" no
 * log.
 *
 * O defeito que isto fecha (achado pelo Gabryel na #139): o código usava
 * `process.env.VITE_APP_ID ?? "mmm-os"`, e `??` só cai no padrão com
 * null/undefined. O `.env.example` traz `VITE_APP_ID=` — vazio —, o dotenv
 * entrega string VAZIA, que não é nullish, e o appId ia vazio. Ou seja: quem
 * seguisse o README ("cp .env.example .env") não conseguia ficar logado.
 *
 * É a mesma cautela que o `safeName` de `abrirSessao` já tinha. Fica como função
 * exportada para o teste poder prendê-la (server/auth.identificador-do-aplicativo.test.ts):
 * a troca de `??` por `||` é de um caractere e volta sem ninguém ver.
 */
export function identificadorDoAplicativo(): string {
  return process.env.VITE_APP_ID?.trim() || "mmm-os";
}

/**
 * O IP que a sessão grava: o primeiro item, sem espaços, no tamanho da coluna
 * (45). Sem IP, "unknown". O login usa o mesmo valor como chave do bloqueio
 * quando não recebe a de rede.
 */
export function ipGravadoNaSessao(ip?: string): string {
  return ip ? ip.split(",")[0].trim().substring(0, 45) : "unknown";
}

type DadosDoToken = { openId: string; appId: string; name: string; sessionToken: string };

/**
 * O token (JWT) da sessão, num lugar só: a abertura da sessão (`abrirSessao`)
 * e a renovação assinam aqui. Ele leva o `sessionToken`, que o sdk confere no
 * banco em toda requisição (é o que faz sair da conta, redefinir a senha e
 * desativar a conta valerem na hora), e vence junto com a janela da sessão
 * (server/duracao-da-sessao.ts).
 */
async function assinarTokenDaSessao(dados: DadosDoToken): Promise<string> {
  return new jose.SignJWT({ ...dados })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + DURACAO_DA_SESSAO_MS) / 1000))
    .sign(JWT_SECRET);
}

/** O que a sessão precisa saber da conta: o id da linha e os campos do token. */
export type UsuariaDaSessao = Pick<User, "id" | "openId" | "name" | "email">;

export type SessaoAberta = {
  /** O token (JWT) que vai no cookie (`gravarCookieDaSessao`). */
  token: string;
  /** Quando a linha vence se a sessão não for usada; cada uso empurra o prazo. */
  expiresAt: Date;
  /** A chave da linha em `sessions`: é por ela que esta sessão cai (`invalidateSessionByToken`). */
  sessionToken: string;
};

/**
 * Abre a sessão: grava a linha em `sessions` e assina o token com o
 * `sessionToken` dela, os dois com a janela de 90 dias
 * (server/duracao-da-sessao.ts). Quem chama já conferiu a conta (senha,
 * passkey, conta ativa) e grava o cookie depois (`gravarCookieDaSessao`). Sem a
 * linha não há token: banco fora do ar é erro.
 */
export async function abrirSessao(params: {
  usuaria: UsuariaDaSessao;
  ip?: string;
  userAgent?: string;
}): Promise<SessaoAberta> {
  const db = await exigirDb();
  const { usuaria } = params;

  // Criar sessão no banco
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + DURACAO_DA_SESSAO_MS);
  // O log leva só o começo do token: o bastante para achar a linha, nunca para usá-la.
  const inicioDoToken = sessionToken.substring(0, 8) + "...";

  // Truncar userAgent para caber no campo (text, mas por segurança limitamos a 500 chars)
  const safeUserAgent = params.userAgent ? params.userAgent.substring(0, 500) : null;

  console.log("[Auth] Criando sessão no banco para userId:", usuaria.id, "token:", inicioDoToken);
  try {
    await db.insert(sessions).values({
      userId: usuaria.id,
      sessionToken,
      ipAddress: ipGravadoNaSessao(params.ip),
      userAgent: safeUserAgent,
      expiresAt,
      isActive: true,
    });
    console.log("[Auth] Sessão criada com sucesso para userId:", usuaria.id);
  } catch (sessionErr) {
    // A mensagem do erro do Drizzle traz os parâmetros do INSERT (o token
    // inteiro, o IP e o navegador). descreverErroDeBanco tira os parâmetros, e
    // o token que aparecer em outro elo da cadeia (a chave duplicada, por
    // exemplo) sai cortado.
    const descricao = descreverErroDeBanco(sessionErr).replaceAll(sessionToken, inicioDoToken);
    console.error("[Auth] ERRO ao criar sessão no banco:", descricao, "| userId:", usuaria.id, "| expiresAt:", expiresAt.toISOString());
    throw new Error("Erro interno ao criar sessão. Tente novamente.");
  }

  // Gerar JWT compatível com sdk.verifySession (campos: openId, appId, name)
  // IMPORTANTE: name deve ser string não-vazia (sdk.verifySession usa isNonEmptyString)
  const safeName = (usuaria.name && usuaria.name.trim().length > 0)
    ? usuaria.name.trim()
    : (usuaria.email ? usuaria.email.split("@")[0] : "usuario");

  const token = await assinarTokenDaSessao({
    openId: usuaria.openId,                       // campo esperado pelo sdk.verifySession
    appId: identificadorDoAplicativo(),           // NUNCA vazio — sdk exige isNonEmptyString
    name: safeName,                               // NUNCA vazio — sdk exige isNonEmptyString
    sessionToken,                                  // para validação no banco (validateSessionToken)
  });

  return { token, expiresAt, sessionToken };
}

/** Grava o cookie da sessão com a mesma validade do token e da linha no banco. */
export function gravarCookieDaSessao(req: Request, res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: DURACAO_DA_SESSAO_MS });
}

/** Apaga o cookie da sessão neste navegador. */
export function limparCookieDaSessao(req: Request, res: Response) {
  res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(req), maxAge: -1 });
}

/** O valor do cookie da sessão que a requisição trouxe, se trouxe. */
export function cookieDaSessao(req: Request): string | undefined {
  return req.headers.cookie ? parseCookieHeader(req.headers.cookie)[COOKIE_NAME] : undefined;
}

/**
 * Mantém a sessão de quem está usando o app: reemite o token e o cookie quando
 * o token atual tem mais de um dia (RENOVAR_O_TOKEN_A_CADA_MS) ou vence antes
 * da janela inteira — é o caso dos tokens de 8 h emitidos antes da sessão
 * deslizante, que assim passam a durar sem novo login. O prazo no banco já foi
 * empurrado pelo `validateSessionToken` na mesma requisição.
 *
 * Só para requisição que o sdk JÁ autenticou (o createContext chama depois do
 * `authenticateRequest`), e só para token com `sessionToken`: o token sem ele
 * (o antigo, da época do Manus) escapa da revogação no banco e não pode ganhar
 * vida longa — e o sdk já o recusa antes de chegar aqui. Token inválido ou de
 * outro formato: não faz nada, quem decide se a requisição entra é o sdk.
 */
export async function renovarCookieDaSessao(req: Request, res: Response): Promise<void> {
  const atual = cookieDaSessao(req);
  if (!atual) return;
  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(atual, JWT_SECRET, { algorithms: ["HS256"] }));
  } catch {
    return;
  }
  const { openId, appId, name, sessionToken, exp } = payload as Record<string, unknown>;
  const texto = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!texto(openId) || !texto(appId) || !texto(name) || !texto(sessionToken)) return;
  const restaMs = typeof exp === "number" ? exp * 1000 - Date.now() : 0;
  if (restaMs > DURACAO_DA_SESSAO_MS - RENOVAR_O_TOKEN_A_CADA_MS) return;
  gravarCookieDaSessao(req, res, await assinarTokenDaSessao({ openId, appId, name, sessionToken }));
}
