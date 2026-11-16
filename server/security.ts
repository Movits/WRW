/**
 * WRW - Módulo de Segurança Corporativa (Cofre Digital)
 * Camada de segurança de nível bancário com:
 * - Criptografia AES-256-GCM
 * - Rate limiting e proteção contra brute force
 * - Logs de auditoria imutáveis
 * - Detecção de atividades suspeitas
 * - Controle de acesso baseado em funções (RBAC)
 */

import crypto from "crypto";
import { eq, and, desc, gt, gte, notInArray, sql, count } from "drizzle-orm";
import { exigirDb } from "./db";
import { requireSecret } from "./_core/env";
import { DURACAO_DA_SESSAO_MS } from "./duracao-da-sessao";
import {
  auditLogs,
  loginAttempts,
  securityEvents,
  platformNotifications,
  sessions,
  users,
  trustedDevices,
} from "../drizzle/schema";

// ============================================================
// CONFIGURAÇÕES DE SEGURANÇA
// ============================================================
const SECURITY_CONFIG = {
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 30,
  ENCRYPTION_ALGORITHM: "aes-256-gcm",
  HASH_ALGORITHM: "sha256",
  SALT_ROUNDS: 12,
};

// V-08: Chave de criptografia SEPARADA do JWT_SECRET
// Usa VAULT_ENCRYPTION_KEY dedicada; se não definida, deriva de JWT_SECRET + salt fixo
// para manter compatibilidade com dados existentes
function getEncryptionKey(): Buffer {
  const vaultKey = process.env.VAULT_ENCRYPTION_KEY;
  if (vaultKey && vaultKey.length >= 32) {
    return crypto.createHash("sha256").update(vaultKey).digest();
  }
  // Fallback: deriva do JWT_SECRET com salt dedicado ao vault (diferente do uso de sessão)
  const secret = requireSecret("JWT_SECRET");
  return crypto.createHash("sha256").update(secret + ":vault-encryption-salt-v1").digest();
}

// ============================================================
// CRIPTOGRAFIA AES-256-GCM
// ============================================================
export function encryptData(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(SECURITY_CONFIG.ENCRYPTION_ALGORITHM, key, iv) as crypto.CipherGCM;

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // Formato: iv:authTag:encryptedData
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptData(encryptedText: string): string {
  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encrypted] = encryptedText.split(":");

    if (!ivHex || !authTagHex || !encrypted) {
      throw new Error("Invalid encrypted data format");
    }

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(SECURITY_CONFIG.ENCRYPTION_ALGORITHM, key, iv) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    throw new Error("Falha na descriptografia: dados corrompidos ou chave inválida");
  }
}

export function hashData(data: string): string {
  return crypto.createHash(SECURITY_CONFIG.HASH_ALGORITHM).update(data).digest("hex");
}

// ============================================================
// RATE LIMITING E PROTEÇÃO CONTRA BRUTE FORCE
// ============================================================
export async function checkLoginRateLimit(
  identifier: string,
  ipAddress: string
): Promise<{ allowed: boolean; remainingAttempts: number; blockedUntil?: Date }> {
  const db = await exigirDb();

  const windowStart = new Date(Date.now() - 60 * 60 * 1000); // Última hora

  const existing = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.ipAddress, ipAddress),
        gte(loginAttempts.updatedAt, windowStart)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return { allowed: true, remainingAttempts: SECURITY_CONFIG.MAX_LOGIN_ATTEMPTS };
  }

  const attempt = existing[0];

  // Verificar se está bloqueado
  if (attempt.blockedUntil && attempt.blockedUntil > new Date()) {
    return {
      allowed: false,
      remainingAttempts: 0,
      blockedUntil: attempt.blockedUntil,
    };
  }

  const remaining = Math.max(0, SECURITY_CONFIG.MAX_LOGIN_ATTEMPTS - attempt.attemptCount);
  return { allowed: remaining > 0, remainingAttempts: remaining };
}

export async function recordLoginAttempt(
  identifier: string,
  ipAddress: string,
  success: boolean
): Promise<void> {
  const db = await exigirDb();

  const windowStart = new Date(Date.now() - 60 * 60 * 1000);

  const existing = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.ipAddress, ipAddress),
        gte(loginAttempts.updatedAt, windowStart)
      )
    )
    .limit(1);

  if (success) {
    // Limpar tentativas após login bem-sucedido
    if (existing.length > 0) {
      await db.delete(loginAttempts).where(eq(loginAttempts.id, existing[0].id));
    }
    return;
  }

  if (existing.length === 0) {
    await db.insert(loginAttempts).values({
      identifier,
      ipAddress,
      success: false,
      attemptCount: 1,
    });
  } else {
    const newCount = existing[0].attemptCount + 1;
    const shouldBlock = newCount >= SECURITY_CONFIG.MAX_LOGIN_ATTEMPTS;
    const blockedUntil = shouldBlock
      ? new Date(Date.now() + SECURITY_CONFIG.LOCKOUT_DURATION_MINUTES * 60 * 1000)
      : null;

    await db
      .update(loginAttempts)
      .set({
        attemptCount: newCount,
        blockedUntil: blockedUntil ?? undefined,
      })
      .where(eq(loginAttempts.id, existing[0].id));

    // Registrar evento de segurança se bloqueado
    if (shouldBlock) {
      await createSecurityEvent(null, "brute_force_attempt", "critical", ipAddress, {
        identifier,
        attemptCount: newCount,
      });
    }
  }
}

// ============================================================
// LOGS DE AUDITORIA IMUTÁVEIS
// ============================================================
export async function createAuditLog(params: {
  userId?: number | null;
  action: string;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  status?: "success" | "failure" | "blocked";
  riskLevel?: "low" | "medium" | "high" | "critical";
}): Promise<void> {
  try {
    const db = await exigirDb();

    // x-forwarded-for can contain multiple IPs (client, proxy1, proxy2...)
    // Take only the first (real client IP) and truncate to 45 chars max (IPv6 max = 39 chars)
    const rawIp = params.ipAddress ?? null;
    const cleanIp = rawIp ? rawIp.split(',')[0].trim().substring(0, 45) : null;

    // Truncate userAgent to 500 chars to avoid oversized text payloads
    const cleanUa = params.userAgent ? params.userAgent.substring(0, 500) : null;

    await db.insert(auditLogs).values({
      userId: params.userId ?? null,
      action: params.action,
      resource: params.resource ?? null,
      resourceId: params.resourceId ?? null,
      details: params.details ?? null,
      ipAddress: cleanIp,
      userAgent: cleanUa,
      status: params.status ?? "success",
      riskLevel: params.riskLevel ?? "low",
    });
  } catch (erro) {
    // A falha da auditoria nunca derruba a aplicação — mas também não pode
    // ser invisível: há registros (ex.: CONTACT_EXCHANGE_BLOCKED, A13) que
    // sustentam cláusula contratual, e um buraco silencioso na trilha só
    // seria descoberto quando ela fizesse falta.
    console.error("[Auditoria] falha ao gravar registro:", params.action, erro instanceof Error ? erro.message : erro);
  }
}

// ============================================================
// EVENTOS DE SEGURANÇA
// ============================================================
/**
 * Alerta repetido não vira linha nova enquanto a janela não fecha.
 *
 * Sem isso, `detectSessionAnomaly` — que roda em TODA requisição autenticada —
 * grava uma linha a cada vez que a condição continua valendo. Em 13 dias, 26
 * contas de TESTE produziram 851 eventos não resolvidos (678 deles de
 * "multiple_sessions"), e a lista de segurança do painel deixou de ser legível:
 * o alerta que importa fica soterrado pela repetição do que já se sabe.
 *
 * A janela vale por (conta, tipo de evento). É consulta indexada
 * (`security_userId_idx`) e só roda quando o código já decidiu alertar, então
 * não custa nada no caminho comum, em que não há alerta nenhum.
 */
const JANELA_DE_REPETICAO_MS = 30 * 60 * 1000;

/** Tipo de evento como o banco o conhece, sem repetir a união de dez literais. */
type TipoDeEventoDeSeguranca = (typeof securityEvents.$inferInsert)["eventType"];

/**
 * Eventos críticos que NÃO alimentam o bloqueio automático.
 *
 * `multiple_sessions` nasce crítico a partir de 20 sessões simultâneas, e 20
 * sessões é a Rede aberta com muitas fotos, não invasão: contando-o, uma conta
 * Prata ou Ouro se autobloqueava sozinha (revisão do Nicolas, 14/09/2026). O
 * evento continua sendo registrado e aparece no painel de segurança; ele só não
 * conta mais para fechar a conta.
 *
 * `account_locked` fica de fora para o bloqueio não se realimentar: ele é
 * gravado como crítico pela própria função de bloqueio.
 */
const TIPOS_FORA_DO_BLOQUEIO_AUTOMATICO: TipoDeEventoDeSeguranca[] = [
  "multiple_sessions",
  "account_locked",
];

/**
 * Quantas linhas o comando alcançou. O mysql2 devolve o cabeçalho do resultado
 * na primeira posição e liga CLIENT_FOUND_ROWS, então num UPDATE `affectedRows`
 * conta a linha que o WHERE ENCONTROU, e não a que mudou de valor — é o que uma
 * trava otimista quer. Sem cabeçalho reconhecível, zero: quem não consegue
 * provar que escreveu não age como se tivesse escrito.
 *
 * Exportada para a mesma trava fora deste arquivo (o consumo do link de
 * redefinir a senha, em routers/auth.ts), em vez de outra cópia.
 */
export function linhasAlcancadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | null | undefined)?.affectedRows ?? 0;
}

/**
 * Grava o evento SE não houver igual na janela, num comando só, e devolve se a
 * linha nasceu.
 *
 * Antes eram dois comandos — um SELECT e, se ele não achasse nada, um INSERT —
 * com uma ida e volta ao banco entre eles. Duas requisições simultâneas da mesma
 * conta liam "não existe" antes de qualquer uma gravar, e a mesma condição
 * virava várias linhas; linha crítica repetida empurra a conta na direção do
 * bloqueio automático, que conta eventos críticos. O
 * `insert ... select ... where not exists` decide e grava no MESMO comando, então
 * não sobra janela entre a leitura e a escrita.
 *
 * O fecho definitivo seria um índice único de (conta, tipo, janela) com
 * `insert ignore`, mas ele pede migração e este conserto não cria nenhuma
 * (revisão do Nicolas, 14/09/2026): fica anotado como o próximo passo.
 */
async function gravarEventoSeNaoHouverIgualNaJanela(
  userId: number,
  eventType: TipoDeEventoDeSeguranca,
  severity: "info" | "warning" | "critical",
  ipAddress: string | null,
  details: Record<string, unknown> | null,
  janelaMs: number
): Promise<boolean> {
  const db = await exigirDb();
  const desde = new Date(Date.now() - janelaMs);
  const detalhes = details === null ? null : JSON.stringify(details);

  const resultado = await db.execute(sql`
    insert into ${securityEvents}
      (${sql.identifier("userId")}, ${sql.identifier("eventType")}, ${sql.identifier("severity")},
       ${sql.identifier("ipAddress")}, ${sql.identifier("details")}, ${sql.identifier("resolved")})
    select ${userId}, ${eventType}, ${severity}, ${ipAddress}, ${detalhes}, false
      from dual
     where not exists (
       select 1
         from ${securityEvents} as anterior
        where anterior.${sql.identifier("userId")} = ${userId}
          and anterior.${sql.identifier("eventType")} = ${eventType}
          and anterior.${sql.identifier("createdAt")} >= ${desde}
     )
  `);

  return linhasAlcancadas(resultado) > 0;
}

export async function createSecurityEvent(
  userId: number | null,
  eventType: "failed_login" | "suspicious_ip" | "multiple_sessions" | "brute_force_attempt" | "unusual_location" | "account_locked" | "password_reset" | "mfa_failed" | "data_export" | "admin_access",
  severity: "info" | "warning" | "critical",
  ipAddress?: string,
  details?: Record<string, unknown>,
  opcoes?: { naoRepetirPorMs?: number }
): Promise<boolean> {
  const db = await exigirDb();

  // Devolve se o evento foi gravado: false quando a dedupe o barrou. Quem usa
  // é detectSessionAnomaly, que só passa a conhecer um IP depois de alertar.

  // Repetição do MESMO alerta, para a MESMA conta, dentro da janela: não grava.
  // Só quem pede (`naoRepetirPorMs`) é dedupado — evento de tentativa de força
  // bruta e bloqueio de conta continuam sendo gravados sempre, um por um.
  //
  // Quem pede dedupe grava pelo comando único acima: checar numa consulta e
  // gravar noutra deixava requisições simultâneas passarem as duas.
  if (userId && opcoes?.naoRepetirPorMs) {
    const gravou = await gravarEventoSeNaoHouverIgualNaJanela(
      userId,
      eventType,
      severity,
      ipAddress ?? null,
      details ?? null,
      opcoes.naoRepetirPorMs
    );
    if (!gravou) return false;
  } else {
    await db.insert(securityEvents).values({
      userId,
      eventType,
      severity,
      ipAddress: ipAddress ?? null,
      details: details ?? null,
      resolved: false,
    });
  }

  // Notificações de segurança crítica só para eventos realmente graves
  // (não para múltiplas sessões, que é comum em testes e uso normal)
  const criticalEventsToNotify = ["brute_force_attempt", "account_locked"];
  if (userId && severity === "critical" && criticalEventsToNotify.includes(eventType)) {
    await db.insert(platformNotifications).values({
      userId,
      type: "system",
      title: "⚠️ Alerta de Segurança",
      body: `Detectamos atividade suspeita na sua conta: ${eventType.replace(/_/g, " ")}. Se não foi você, altere sua senha imediatamente.`,
    });
  }

  // O bloqueio automático é avaliado AQUI, e não a cada requisição.
  //
  // Ele conta eventos críticos da conta na última hora, então o único instante
  // em que essa conta pode cruzar o limite é o instante em que um evento
  // crítico nasce — que é este. Antes, `getUserFromRequest` chamava a checagem
  // em TODA requisição autenticada: um SELECT por requisição que, entre dois
  // eventos críticos, só podia devolver o mesmo resultado de antes. E o caso
  // "a conta já está bloqueada" também não dependia dele: `getUserFromRequest`
  // recusa `isActive === false` antes, com a mensagem de conta desativada.
  //
  // Os tipos de `TIPOS_FORA_DO_BLOQUEIO_AUTOMATICO` não disparam a checagem:
  // não contam para o limite, então nem a consulta precisam custar.
  if (userId && severity === "critical" && !TIPOS_FORA_DO_BLOQUEIO_AUTOMATICO.includes(eventType)) {
    await checkAutoLockThreshold(userId, ipAddress).catch(() => false);
  }
  return true;
}

// ============================================================
// COFRE DIGITAL (STUB — migrado para userProfiles na plataforma FRAUEN)
// Mantido para compatibilidade com routers.ts existentes
// ============================================================
export async function saveToVault(
  userId: number,
  sensitiveData: Record<string, unknown>
): Promise<void> {
  // Vault migrado para userProfiles — dados são salvos via upsertUserProfile
  await createAuditLog({
    userId,
    action: "VAULT_UPDATE",
    resource: "user_profile",
    resourceId: String(userId),
    status: "success",
    riskLevel: "low",
  });
}

export async function getFromVault(userId: number): Promise<Record<string, unknown> | null> {
  // Vault migrado para userProfiles — retorna null para compatibilidade
  return null;
}

// ============================================================
// GERENCIAMENTO DE SESSÕES SEGURAS
// ============================================================
export async function validateSession(sessionToken: string): Promise<number | null> {
  const db = await exigirDb();

  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.sessionToken, sessionToken),
        eq(sessions.isActive, true),
        gte(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (result.length === 0) return null;

  // Atualizar última atividade
  await db
    .update(sessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(sessions.id, result[0].id));

  return result[0].userId;
}

export async function invalidateSession(sessionToken: string): Promise<void> {
  const db = await exigirDb();

  await db
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionToken, sessionToken));
}

// ============================================================
// QUERIES PARA PAINEL ADMINISTRATIVO
// ============================================================
export async function getAuditLogs(limit = 50, offset = 0, userId?: number) {
  const db = await exigirDb();

  const query = db
    .select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      userName: users.name,
      action: auditLogs.action,
      resource: auditLogs.resource,
      status: auditLogs.status,
      riskLevel: auditLogs.riskLevel,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  if (userId !== undefined) {
    return db
      .select({
        id: auditLogs.id,
        userId: auditLogs.userId,
        userName: users.name,
        action: auditLogs.action,
        resource: auditLogs.resource,
        status: auditLogs.status,
        riskLevel: auditLogs.riskLevel,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);
  }

  return query;
}

export async function getSecurityEvents(resolved = false, limit = 50) {
  const db = await exigirDb();

  return db
    .select({
      id: securityEvents.id,
      userId: securityEvents.userId,
      userName: users.name,
      eventType: securityEvents.eventType,
      severity: securityEvents.severity,
      ipAddress: securityEvents.ipAddress,
      resolved: securityEvents.resolved,
      createdAt: securityEvents.createdAt,
    })
    .from(securityEvents)
    .leftJoin(users, eq(securityEvents.userId, users.id))
    .where(eq(securityEvents.resolved, resolved))
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
}

export async function getSecurityStats() {
  const db = await exigirDb();

  const [totalUsers] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const [activeSessionsCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(and(eq(sessions.isActive, true), gte(sessions.expiresAt, new Date())));
  const [unresolvedEvents] = await db
    .select({ count: sql<number>`count(*)` })
    .from(securityEvents)
    .where(eq(securityEvents.resolved, false));
  const [todayLogs] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));

  return {
    totalUsers: totalUsers?.count ?? 0,
    activeSessions: activeSessionsCount?.count ?? 0,
    unresolvedSecurityEvents: unresolvedEvents?.count ?? 0,
    todayAuditLogs: todayLogs?.count ?? 0,
  };
}

export async function getUserSecurityNotifications(userId: number) {
  const db = await exigirDb();

  return db
    .select()
    .from(platformNotifications)
    .where(and(eq(platformNotifications.userId, userId), eq(platformNotifications.isRead, false)))
    .orderBy(desc(platformNotifications.createdAt))
    .limit(10);
}

// V-02: markNotificationRead com verificação de ownership (IDOR fix)
export async function markNotificationRead(notificationId: number, userId: number): Promise<void> {
  const db = await exigirDb();

  // Só atualiza se a notificação pertence ao usuário solicitante
  await db
    .update(platformNotifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(platformNotifications.id, notificationId), eq(platformNotifications.userId, userId)));
}

export async function resolveSecurityEvent(eventId: number, resolvedBy: number): Promise<void> {
  const db = await exigirDb();

  await db
    .update(securityEvents)
    .set({ resolved: true, resolvedAt: new Date(), resolvedBy })
    .where(eq(securityEvents.id, eventId));
}

export async function getUserActiveSessions(userId: number) {
  const db = await exigirDb();

  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.isActive, true),
        gte(sessions.expiresAt, new Date())
      )
    )
    .orderBy(desc(sessions.lastActivityAt));
}

export async function getAllUsers(limit = 100, offset = 0) {
  const db = await exigirDb();

  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      isVerified: users.isVerified,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);
}

// ============================================================
// DETECÇÃO DE ANOMALIAS DE SESSÃO
// ============================================================

/**
 * Quantas sessões a amostra traz para comparar IP e dispositivo. Não é o
 * limite do alerta: quando a amostra enche, a contagem real é pedida à parte.
 */
const TAMANHO_DA_AMOSTRA = 10;

/** A partir de quantas sessões simultâneas o alerta é gravado. */
const LIMITE_DE_SESSOES_SIMULTANEAS = 10;

/** A partir de quantas o alerta deixa de ser aviso e vira crítico. */
const LIMITE_CRITICO_DE_SESSOES = 20;

/**
 * Detecta anomalias na sessão atual comparando IP e User-Agent
 * com as sessões ativas do usuário. Gera alertas automáticos
 * quando detecta acesso de localização ou dispositivo diferente.
 *
 * RODA EM TODA REQUISIÇÃO AUTENTICADA (`server/_core/index.ts` → `sdk.ts`),
 * então cada consulta a mais aqui é uma consulta a mais por requisição de
 * cada usuária. É por isso que a contagem exata só é pedida quando a amostra
 * enche, e que o alerta repetido é barrado antes de virar linha no banco.
 */
export async function detectSessionAnomaly(
  userId: number,
  currentIp: string,
  currentUserAgent: string,
  /**
   * O sessionToken desta requisição. Com ele, depois de alertar sobre IP novo,
   * a sessão passa a guardar esse IP: o alerta sai UMA vez por troca de rede.
   * Sem isso, como o IP da sessão só era gravado no login e a sessão agora
   * dura 90 dias desde o último uso (server/duracao-da-sessao.ts), toda
   * requisição depois de trocar de wi-fi para 4G gravava um SUSPICIOUS_ACCESS
   * de risco alto, por meses.
   */
  sessionToken?: string | null
): Promise<void> {
  const db = await exigirDb();

  // A sessão precisa estar ativa E NÃO VENCIDA.
  //
  // Sem o filtro de validade, sessão vencida que ninguém desativou ainda
  // contava como simultânea. E ninguém desativa sozinho: `cleanupExpiredSessions`
  // só roda quando alguém abre o painel administrativo. Em produção, em 12/09,
  // havia 80 sessões vencidas ainda marcadas como ativas — eram elas que
  // enchiam a contagem e disparavam o alerta de "múltiplas sessões".
  const agora = new Date();
  const filtroDeSessoesVivas = and(
    eq(sessions.userId, userId),
    eq(sessions.isActive, true),
    gt(sessions.expiresAt, agora),
    gte(sessions.lastActivityAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
  );

  // A amostra serve para comparar IP e dispositivo; dez bastam para isso.
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(filtroDeSessoesVivas)
    .orderBy(desc(sessions.lastActivityAt))
    .limit(TAMANHO_DA_AMOSTRA);

  if (recentSessions.length === 0) return;

  // Verificar se o IP atual é diferente de todos os IPs recentes
  const knownIps = new Set(recentSessions.map(s => s.ipAddress).filter(Boolean));
  const isNewIp = currentIp !== "unknown" && !knownIps.has(currentIp);

  // Verificar se o User-Agent atual é diferente dos recentes
  const currentUaFingerprint = hashData(currentUserAgent);
  const knownFingerprints = new Set(recentSessions.map(s => s.deviceFingerprint).filter(Boolean));
  const isNewDevice = !knownFingerprints.has(currentUaFingerprint);

  // O NÚMERO DE SESSÕES SIMULTÂNEAS, e não o tamanho da amostra.
  //
  // Antes, `activeSessions` era `recentSessions.length` — uma lista com
  // `.limit(10)`. Duas consequências: o campo `activeSessions` gravado no
  // evento era SEMPRE 10, em todas as linhas do painel, e o ramo
  // `activeSessions >= 20 ? "critical" : "warning"` era inalcançável por
  // construção, porque dez nunca chega a vinte. A contagem de verdade só é
  // pedida quando a amostra enche, que é o único caso em que ela pode mudar
  // alguma coisa — no caminho comum continua sendo uma consulta só.
  let activeSessions = recentSessions.length;
  if (activeSessions >= TAMANHO_DA_AMOSTRA) {
    const contagem = await db.select({ n: count() }).from(sessions).where(filtroDeSessoesVivas);
    activeSessions = Number(contagem[0]?.n ?? activeSessions);
  }

  // Alertar sobre novo IP (possível acesso de localização diferente)
  let alertouIpNovo = false;
  if (isNewIp && recentSessions.length > 0) {
    alertouIpNovo = await createSecurityEvent(
      userId,
      "suspicious_ip",
      "warning",
      currentIp,
      {
        newIp: currentIp,
        knownIps: Array.from(knownIps),
        message: "Acesso detectado de endereço IP diferente dos registros anteriores",
      },
      { naoRepetirPorMs: JANELA_DE_REPETICAO_MS }
    ).catch(() => false);
  }

  // Alertar sobre múltiplas sessões simultâneas apenas em volume muito alto
  // (threshold elevado para não gerar alertas em uso normal ou testes)
  if (activeSessions >= LIMITE_DE_SESSOES_SIMULTANEAS) {
    await createSecurityEvent(
      userId,
      "multiple_sessions",
      activeSessions >= LIMITE_CRITICO_DE_SESSOES ? "critical" : "warning",
      currentIp,
      {
        activeSessions,
        message: `${activeSessions} sessões simultâneas detectadas`,
      },
      { naoRepetirPorMs: JANELA_DE_REPETICAO_MS }
    ).catch(() => {});
  }

  // Novo dispositivo com IP diferente (alta suspeita), só junto com o alerta de
  // IP novo que a dedupe deixou passar: no máximo um por conta a cada 30 min.
  // Com a sessão de 90 dias, olhar só o IP gravava uma linha de risco alto por
  // requisição de um IP ainda não aprendido (cada foto do storageProxy, inclusive)
  // enquanto a dedupe barrava o suspicious_ip. "Novo dispositivo" hoje é sempre
  // verdadeiro: o login não grava deviceFingerprint na sessão.
  if (alertouIpNovo && isNewDevice) {
    await createAuditLog({
      userId,
      action: "SUSPICIOUS_ACCESS",
      resource: "session",
      ipAddress: currentIp,
      userAgent: currentUserAgent,
      status: "failure",
      riskLevel: "high",
      details: {
        reason: "Novo IP e novo dispositivo detectados simultaneamente",
        knownIpsCount: knownIps.size,
      },
    }).catch(() => {});
  }

  // Alertado o IP novo, a sessão passa a conhecê-lo (ver `sessionToken` acima).
  // SÓ se o alerta foi gravado: a dedupe de 30 min não olha o IP, então um
  // terceiro IP dentro da janela (o de quem copiou o token, por exemplo) seria
  // "conhecido" sem nunca ter virado evento. Barrado, ele segue novo e alerta
  // quando a janela fechar. A coluna tem 45 caracteres, como no insert do login.
  if (alertouIpNovo && sessionToken) {
    await db
      .update(sessions)
      .set({ ipAddress: currentIp.slice(0, 45) })
      .where(eq(sessions.sessionToken, sessionToken));
  }
}

// ============================================================
// LIMPEZA DE SESSÕES EXPIRADAS
// ============================================================

/**
 * Remove sessões expiradas do banco de dados.
 * Deve ser chamado periodicamente (ex: job diário).
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = await exigirDb();

  const result = await db
    .update(sessions)
    .set({ isActive: false })
    .where(
      and(
        eq(sessions.isActive, true),
        sql`${sessions.expiresAt} < NOW()`
      )
    );

  return (result as any)[0]?.affectedRows ?? 0;
}

// ============================================================
// REVOGAÇÃO DE TODAS AS SESSÕES DO USUÁRIO
// ============================================================

/**
 * Revoga todas as sessões ativas de um usuário.
 * Usado em caso de comprometimento de conta ou logout forçado pelo admin.
 */
export async function revokeAllUserSessions(userId: number): Promise<void> {
  const db = await exigirDb();

  await db
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.userId, userId));
}

// ============================================================
// BLOQUEIO DE CONTA
// ============================================================

/**
 * Bloqueia uma conta de usuário e revoga todas as suas sessões.
 * Registra o evento de segurança correspondente.
 *
 * Devolve `true` quando a conta MUDOU de estado e `false` quando ela já estava
 * bloqueada. A condição vai no WHERE, e não num SELECT antes: sem ela o UPDATE
 * alcançava a linha toda vez, e dois cliques no painel (ou dois moderadores ao
 * mesmo tempo) regravavam `account_locked` e a auditoria numa conta que já
 * estava fechada.
 */
export async function lockUserAccount(
  targetUserId: number,
  adminId: number,
  reason: string
): Promise<boolean> {
  const db = await exigirDb();

  // Desativar conta — só se ainda estiver ativa
  const bloqueio = await db
    .update(users)
    .set({ isActive: false })
    .where(and(eq(users.id, targetUserId), eq(users.isActive, true)));
  if (linhasAlcancadas(bloqueio) === 0) return false;

  // Revogar todas as sessões
  await revokeAllUserSessions(targetUserId);

  // Registrar no log de auditoria
  await createAuditLog({
    userId: adminId,
    action: "ACCOUNT_LOCKED",
    resource: "user",
    resourceId: String(targetUserId),
    status: "success",
    riskLevel: "high",
    details: { reason, targetUserId },
  });

  // Criar evento de segurança
  await createSecurityEvent(
    targetUserId,
    "account_locked",
    "critical",
    undefined,
    { reason, lockedBy: adminId }
  );

  return true;
}

// ============================================================
// VALIDAÇÃO REAL DE SESSÃO NO BANCO (V-CRITICAL)
// Verifica se o token de sessão ainda está ativo no banco.
// Chamado dentro de sdk.authenticateRequest para revogação real.
// ============================================================

/**
 * Valida o token de sessão JWT contra o banco de dados.
 * Retorna o userId se a sessão está ativa e não expirou.
 * Retorna null se a sessão foi revogada, expirou ou não existe.
 */
export async function validateSessionToken(sessionToken: string): Promise<number | null> {
  // Banco fora do ar lança BancoIndisponivel: a sessão não é validada e a
  // requisição falha com a mensagem certa, em vez de parecer sessão revogada.
  const db = await exigirDb();

  const result = await db
    .select({ userId: sessions.userId, isActive: sessions.isActive, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.sessionToken, sessionToken))
    .limit(1);

  if (result.length === 0) return null;

  const session = result[0];
  if (!session.isActive) return null;
  if (session.expiresAt && session.expiresAt < new Date()) {
    // Marcar como inativa para limpeza futura
    await db.update(sessions).set({ isActive: false }).where(eq(sessions.sessionToken, sessionToken));
    return null;
  }

  // Sessão deslizante (server/duracao-da-sessao.ts): o uso empurra o prazo no
  // mesmo UPDATE que grava a última atividade, sem consulta a mais.
  const agora = Date.now();
  await db
    .update(sessions)
    .set({ lastActivityAt: new Date(agora), expiresAt: new Date(agora + DURACAO_DA_SESSAO_MS) })
    .where(eq(sessions.sessionToken, sessionToken));

  return session.userId;
}

// ============================================================
// BLOQUEIO AUTOMÁTICO POR THRESHOLD DE EVENTOS CRÍTICOS
// ============================================================

const AUTO_LOCK_THRESHOLD = 20; // Número de eventos críticos para bloqueio automático (aumentado para evitar falsos positivos)
const AUTO_LOCK_WINDOW_MINUTES = 60; // Janela de tempo para contagem

/**
 * Verifica se um usuário deve ser bloqueado automaticamente
 * com base no número de eventos críticos recentes.
 * Se o threshold for atingido, bloqueia a conta automaticamente.
 */
export async function checkAutoLockThreshold(userId: number, ipAddress?: string): Promise<boolean> {
  const db = await exigirDb();

  const windowStart = new Date(Date.now() - AUTO_LOCK_WINDOW_MINUTES * 60 * 1000);

  const criticalEvents = await db
    .select({ id: securityEvents.id })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.userId, userId),
        eq(securityEvents.severity, "critical"),
        // A exclusão é da CONTAGEM, no próprio WHERE: sem ela, linhas de
        // `multiple_sessions` somam com uma tentativa de força bruta e fecham
        // a conta de quem só abriu a Rede em muitas abas.
        notInArray(securityEvents.eventType, TIPOS_FORA_DO_BLOQUEIO_AUTOMATICO),
        gte(securityEvents.createdAt, windowStart)
      )
    );

  if (criticalEvents.length < AUTO_LOCK_THRESHOLD) return false;

  // Verificar se a conta já está inativa (já bloqueada)
  const userResult = await db.select({ isActive: users.isActive, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!userResult[0]?.isActive) return true; // Já bloqueada

  // Isentar contas Presidente e Admin do bloqueio automático
  if (userResult[0]?.role === 'president' || userResult[0]?.role === 'admin') {
    return false;
  }

  // Bloquear automaticamente — SÓ quem ainda está ativa.
  //
  // Sem `isActive` no WHERE o UPDATE "dava certo" toda vez, e o bloqueio se
  // repetia: cada novo evento crítico dentro da janela regravava o mesmo
  // `account_locked`, com aviso no sino e linha de auditoria, numa conta que já
  // estava bloqueada. O SELECT logo acima não resolve sozinho — entre ele e o
  // UPDATE cabe outra requisição. Zero linhas alcançadas = já estava bloqueada:
  // a conta está no estado desejado, e nada mais precisa ser escrito.
  const bloqueio = await db
    .update(users)
    .set({ isActive: false })
    .where(and(eq(users.id, userId), eq(users.isActive, true)));
  if (linhasAlcancadas(bloqueio) === 0) return true;

  await revokeAllUserSessions(userId);

  // Registrar evento e log
  await createSecurityEvent(
    userId,
    "account_locked",
    "critical",
    ipAddress,
    {
      reason: `Bloqueio automático: ${criticalEvents.length} eventos críticos em ${AUTO_LOCK_WINDOW_MINUTES} minutos`,
      autoLocked: true,
      threshold: AUTO_LOCK_THRESHOLD,
    }
  ).catch(() => {});

  await createAuditLog({
    userId: null,
    action: "AUTO_LOCK_ACCOUNT",
    resource: "user",
    resourceId: String(userId),
    status: "success",
    riskLevel: "critical",
    ipAddress,
    details: {
      reason: "Threshold automático de eventos críticos atingido",
      criticalEventsCount: criticalEvents.length,
      windowMinutes: AUTO_LOCK_WINDOW_MINUTES,
    },
  }).catch(() => {});

  return true;
}
