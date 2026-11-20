import { COOKIE_NAME } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { jwtVerify, type JWTPayload } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import {
  validateSession,
  validateSessionToken,
  createAuditLog,
  createSecurityEvent,
  detectSessionAnomaly,
} from "../security";
import { ipDaCliente } from "../ip-da-cliente";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

class SDKServer {
  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  // A sessão de usuária não nasce aqui: nasce em `abrirSessao`
  // (server/sessao.ts), que grava a linha em `sessions` e põe o `sessionToken`
  // dela no token. O assinador que este arquivo tinha, herdado do Manus, fazia
  // token sem `sessionToken`, válido por 1 ano e fora do alcance da revogação;
  // saiu, e a guarda server/sessao-guarda.test.ts impede que volte.

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; appId: string; name: string } | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name } = payload as Record<string, unknown>;

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        !isNonEmptyString(name)
      ) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      return {
        openId,
        appId,
        name,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  /**
   * Sessão de cron: um JWT assinado com o JWT_SECRET, openId `cron_...` e a
   * claim `taskUid`. Antes o taskUid vinha do servidor de auth do Manus
   * (GetUserInfoWithJwt), que não existe mais; o próprio JWT passa a carregá-lo.
   */
  private async readCronTaskUid(cookieValue: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(cookieValue, this.getSessionSecret(), {
        algorithms: ["HS256"],
      });
      const taskUid = (payload as Record<string, unknown>).taskUid;
      return isNonEmptyString(taskUid) ? taskUid : null;
    } catch {
      return null;
    }
  }

  /**
   * O `sessionToken` que o token de usuária leva: a chave da linha em
   * `sessions` (server/sessao.ts). Sem ele, `null`.
   *
   * É a segunda verificação do JWT na requisição; a primeira é a do
   * verifySession, e entre as duas há a consulta da conta no banco. O token que
   * deixa de conferir nesse meio-tempo (na prática, o que vence durante a
   * consulta) é recusado como qualquer token vencido, e não como token sem
   * sessionToken: aquela auditoria, de risco alto, acusaria um token antigo ou
   * forjado onde a sessão só venceu.
   */
  private async readSessionToken(cookieValue: string): Promise<string | null> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(cookieValue, this.getSessionSecret(), {
        algorithms: ["HS256"],
      }));
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      throw ForbiddenError("Invalid session cookie");
    }
    const sessionToken = payload.sessionToken;
    return isNonEmptyString(sessionToken) ? sessionToken : null;
  }

  async authenticateRequest(req: Request): Promise<AuthenticatedUser> {
    // Regular authentication flow
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const taskUid = await this.readCronTaskUid(sessionCookie ?? "");
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(session, taskUid);
    }

    const sessionUserId = session.openId;
    const signedInAt = new Date();
    const user = await db.getUserByOpenId(sessionUserId);

    // Sem o OAuth do Manus não existe mais "sincronizar a conta da origem":
    // a usuária precisa existir no banco, senão a sessão é inválida.
    if (!user) {
      console.error("[Auth] Session user not found in DB:", sessionUserId);
      throw ForbiddenError("User not found");
    }

    if (!user.isActive) {
      throw ForbiddenError("Esta conta foi desativada. Entre em contato com o suporte.");
    }

    // O MESMO IP que o login grava na sessão (ipDaCliente): com o primeiro item
    // do X-Forwarded-For aqui e o CF-Connecting-IP lá, quem está atrás de um
    // proxy que acrescenta X-Forwarded-For pareceria vir de IP novo em toda
    // requisição, com um SUSPICIOUS_ACCESS de risco alto a cada uma.
    const ipAddress = ipDaCliente(req);
    const userAgent = req.headers["user-agent"] || "unknown";

    // HARDENING V-CRITICAL: Validar sessão no banco de dados (revogação real)
    // Extrai o sessionToken do payload JWT e verifica se ainda está ativo no banco.
    // A detecção de anomalia, lá embaixo, também usa o sessionToken.
    const sessionToken = await this.readSessionToken(sessionCookie ?? "");

    // Token de usuária sem sessionToken é recusado. Sem ele não há linha em
    // `sessions` para conferir, e sair, redefinir a senha, desativar ou excluir
    // a conta não o alcançam — com a sessão de 90 dias, isso pesava ainda mais.
    // Só o cron passa sem ele (pelo prefixo, lá em cima). Efeito: quem ainda
    // guardar um token antigo sem sessionToken (da época do Manus) precisa
    // entrar de novo; o createContext apaga do navegador o cookie recusado. A
    // auditoria usa a ação da sessão revogada, que a exclusão de conta preserva
    // (ACOES_DE_AUDITORIA_PRESERVADAS), com motivo próprio e sem o token.
    if (!sessionToken) {
      await createAuditLog({
        userId: user.id,
        action: "REVOKED_SESSION_ACCESS_ATTEMPT",
        resource: "auth",
        ipAddress,
        userAgent,
        status: "failure",
        riskLevel: "high",
        details: { reason: "Token JWT válido mas sem sessionToken: não há sessão no banco para conferir" },
      }).catch(() => {});
      throw ForbiddenError("Session missing sessionToken");
    }

    const userIdDaSessao = await validateSessionToken(sessionToken);
    if (userIdDaSessao === null) {
      await createAuditLog({
        userId: user.id,
        action: "REVOKED_SESSION_ACCESS_ATTEMPT",
        resource: "auth",
        ipAddress,
        userAgent,
        status: "failure",
        riskLevel: "high",
        details: { reason: "Token JWT válido mas sessão revogada no banco" },
      }).catch(() => {});
      throw ForbiddenError("Session has been revoked");
    }

    // O bloqueio automático NÃO é reavaliado aqui, de propósito.
    //
    // Ele conta eventos críticos da conta na última hora, e a contagem só muda
    // quando um evento crítico nasce — momento em que `createSecurityEvent`
    // (server/security.ts) chama a checagem. Reavaliar a cada requisição era um
    // SELECT por requisição que, entre dois eventos críticos, devolvia sempre o
    // mesmo resultado. A conta já bloqueada também não dependia dele: o
    // `!user.isActive` acima recusa a requisição antes de chegar nesta linha.

    // Detectar anomalias de sessão (IP diferente, UA diferente) — não-bloqueante
    await detectSessionAnomaly(user.id, ipAddress, userAgent, sessionToken).catch(() => {});

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    return user;
  }
}

const CRON_OPEN_ID_PREFIX = "cron_";

/** Result of `sdk.authenticateRequest`. Cron callbacks (`/api/scheduled/*`) set `isCron=true` and `taskUid`. */
export type AuthenticatedUser = User & {
  taskUid?: string;
  isCron?: boolean;
};

function buildCronUser(
  session: SessionPayload,
  taskUid: string
): AuthenticatedUser {
  const now = new Date();
  return {
    id: -1,
    openId: session.openId,
    name: session.name || "Scheduled Task",
    email: null,
    loginMethod: null,
    role: "silver",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid,
    isCron: true,
  } as AuthenticatedUser;
}

export const sdk = new SDKServer();
