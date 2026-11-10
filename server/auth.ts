import bcrypt from "bcryptjs";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { exigirDb } from "./db";
import { users, sessions } from "../drizzle/schema";
import { checkLoginRateLimit, recordLoginAttempt } from "./security";
import { requireSecret } from "./_core/env";
import { filaDoBcrypt } from "./fila-do-bcrypt";
import crypto from "crypto";

const JWT_SECRET = new TextEncoder().encode(requireSecret("JWT_SECRET"));
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 horas

// ─── Gerar openId único para usuários de email ───────────────
function generateOpenId(): string {
  return "email_" + crypto.randomBytes(16).toString("hex");
}

/**
 * Conta sem `passwordHash`. A mensagem antiga mandava "tentar com Google ou
 * outro provedor", e não existe login por provedor nenhum neste produto: quem
 * caía aqui ficava sem saída. São dois casos reais, e "Esqueci minha senha"
 * resolve os dois — o fluxo grava o hash no fim:
 *
 * - conta vinda da carga da base de participantes
 *   (`scripts/importar-participantes.mjs`), que nasce sem senha de propósito,
 *   porque senha não entra por planilha;
 * - conta antiga, herdada do Manus, com `loginMethod` que não é "email".
 *
 * Exportada para o script da carga instruir exatamente a mesma coisa que a tela
 * de login diz — se uma mudar, o teste da carga acusa a outra.
 */
export const MENSAGEM_CONTA_SEM_SENHA =
  'Esta conta ainda não tem senha. Use "Esqueci minha senha" para criar a sua e depois entre normalmente.';

// ─── Registrar novo usuário ───────────────────────────────────
export async function registerUser(params: {
  name: string;
  email: string;
  password: string;
}) {
  const db = await exigirDb();

  // Verificar se email já existe
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.email.toLowerCase().trim()))
    .limit(1);

  if (existing.length > 0) {
    throw new Error("Este e-mail já está cadastrado. Faça login ou use outro e-mail.");
  }

  // Validações básicas
  if (params.password.length < 8) {
    throw new Error("A senha deve ter pelo menos 8 caracteres.");
  }
  if (!params.email.includes("@")) {
    throw new Error("E-mail inválido.");
  }

  // Hash da senha
  // Na fila: poucas vagas simultâneas para a CPU não travar numa rajada (fila-do-bcrypt.ts).
  const passwordHash = await filaDoBcrypt.executar(() => bcrypt.hash(params.password, 12));
  const openId = generateOpenId();

  // Criar usuário
  const result = await db.insert(users).values({
    openId,
    name: params.name.trim(),
    email: params.email.toLowerCase().trim(),
    passwordHash,
    emailVerified: false,
    loginMethod: "email",
    // Governança (14/09/2026): todo cadastro nasce Bronze, "perfil em
    // qualificação". A Prata vem sozinha quando o perfil atende à régua de
    // shared/qualificacao-do-perfil.ts (server/nivel-do-perfil.ts). Bronze tem
    // os mesmos acessos que Prata: o nível mede qualificação, não permissão.
    role: "bronze",
    isActive: true,
    isVerified: false,
    onboardingCompleted: false,
    lastSignedIn: new Date(),
  });

  const userId = Number(result[0].insertId);
  return { userId, openId };
}

// ─── Login com email + senha ──────────────────────────────────
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
 * É a mesma cautela que o `safeName` logo abaixo já tinha. Fica como função
 * exportada para o teste poder prendê-la (server/auth.identificador-do-aplicativo.test.ts):
 * a troca de `??` por `||` é de um caractere e volta sem ninguém ver.
 */
export function identificadorDoAplicativo(): string {
  return process.env.VITE_APP_ID?.trim() || "mmm-os";
}

export async function loginUser(params: {
  email: string;
  password: string;
  ip?: string;
  /**
   * A chave de rede do bloqueio por e-mail + IP: IPv6 agrupado no /56
   * (`chaveDeRede`, ip-da-cliente.ts), para quem tem IPv6 não zerar a contagem
   * trocando de endereço. A sessão continua gravando o IP cru (`ip`), que a
   * detecção de anomalia compara. Sem ela, vale o IP cru.
   */
  chaveDoBloqueio?: string;
  userAgent?: string;
}) {
  const db = await exigirDb();

  const safeIp = params.ip ? params.ip.split(",")[0].trim().substring(0, 45) : "unknown";
  const chaveDoBloqueio = params.chaveDoBloqueio ? params.chaveDoBloqueio.substring(0, 45) : safeIp;
  const identifier = params.email.toLowerCase().trim();

  // ─── Verificar rate limit de login (brute force protection) ───
  const rateCheck = await checkLoginRateLimit(identifier, chaveDoBloqueio);
  if (!rateCheck.allowed) {
    const blockedUntil = rateCheck.blockedUntil
      ? ` Tente novamente após ${rateCheck.blockedUntil.toLocaleTimeString("pt-BR")}.`
      : " Tente novamente em 30 minutos.";
    throw new Error(`Conta temporariamente bloqueada por excesso de tentativas.${blockedUntil}`);
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.email, identifier))
    .limit(1);

  if (userRows.length === 0) {
    // Registrar tentativa falha mesmo para e-mails inexistentes (evita timing attack)
    await recordLoginAttempt(identifier, chaveDoBloqueio, false).catch(() => {});
    throw new Error("E-mail ou senha incorretos.");
  }

  const user = userRows[0];

  if (!user.isActive) {
    throw new Error("Esta conta foi desativada. Entre em contato com o suporte.");
  }

  if (!user.passwordHash) {
    throw new Error(MENSAGEM_CONTA_SEM_SENHA);
  }

  const passwordHash = user.passwordHash;
  // Na fila: poucas vagas simultâneas para a CPU não travar numa rajada (fila-do-bcrypt.ts).
  const passwordOk = await filaDoBcrypt.executar(() => bcrypt.compare(params.password, passwordHash));
  if (!passwordOk) {
    // Registrar tentativa falha no banco
    await recordLoginAttempt(identifier, chaveDoBloqueio, false).catch(() => {});
    const remaining = rateCheck.remainingAttempts - 1;
    const hint = remaining > 0 ? ` (${remaining} tentativa${remaining !== 1 ? "s" : ""} restante${remaining !== 1 ? "s" : ""})` : " Conta será bloqueada na próxima tentativa.";
    throw new Error(`E-mail ou senha incorretos.${hint}`);
  }

  // Login bem-sucedido: limpar tentativas anteriores
  await recordLoginAttempt(identifier, chaveDoBloqueio, true).catch(() => {});

  // Atualizar lastSignedIn
  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

  // Criar sessão no banco
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // Truncar userAgent para caber no campo (text, mas por segurança limitamos a 500 chars)
  const safeUserAgent = params.userAgent ? params.userAgent.substring(0, 500) : null;
  // safeIp já declarado acima (reutilizado aqui para o insert de sessão)

  console.log("[Auth] Criando sessão no banco para userId:", user.id, "token:", sessionToken.substring(0, 8) + "...");
  try {
    await db.insert(sessions).values({
      userId: user.id,
      sessionToken,
      ipAddress: safeIp,
      userAgent: safeUserAgent,
      expiresAt,
      isActive: true,
    });
    console.log("[Auth] Sessão criada com sucesso para userId:", user.id);
  } catch (sessionErr: any) {
    console.error("[Auth] ERRO ao criar sessão no banco:", sessionErr?.message, "| userId:", user.id, "| expiresAt:", expiresAt.toISOString());
    throw new Error("Erro interno ao criar sessão. Tente novamente.");
  }

  // A redefinição de senha só derruba as sessões que já existem, e este login
  // pode ter conferido a senha antiga antes dela (a espera na fila do bcrypt
  // chega a 1 min). Por isso a conta é relida DEPOIS de gravar a sessão: se a
  // senha mudou, a sessão cai e o login é recusado como senha errada; se o
  // reset gravar a senha depois desta leitura, a revogação dele alcança a sessão.
  const [contaAgora] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (contaAgora?.passwordHash !== passwordHash) {
    await invalidateSessionByToken(sessionToken);
    throw new Error("E-mail ou senha incorretos.");
  }

  // Gerar JWT compatível com sdk.verifySession (campos: openId, appId, name)
  // IMPORTANTE: name deve ser string não-vazia (sdk.verifySession usa isNonEmptyString)
  const safeName = (user.name && user.name.trim().length > 0)
    ? user.name.trim()
    : (user.email ? user.email.split("@")[0] : "usuario");

  const safeAppId = identificadorDoAplicativo();

  const token = await new jose.SignJWT({
    openId: user.openId,                          // campo esperado pelo sdk.verifySession
    appId: safeAppId,                             // NUNCA vazio — sdk exige isNonEmptyString
    name: safeName,                               // NUNCA vazio — sdk exige isNonEmptyString
    sessionToken,                                  // para validação no banco (validateSessionToken)
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(JWT_SECRET);

  return { token, user, expiresAt };
}

// ─── Invalidar sessão no banco ────────────────────────────────
export async function invalidateSessionByToken(sessionToken: string) {
  const db = await exigirDb();
  await db
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionToken, sessionToken));
}

// Remove campos que jamais podem ir para o navegador. `ctx.user` é a linha
// crua da tabela `users`, e serializá-la inteira em auth.me/profile.get
// expunha o passwordHash de quem estivesse logado.
export function toPublicUser<T extends { passwordHash?: unknown }>(user: T | null | undefined) {
  if (!user) return user ?? null;
  const { passwordHash: _omitido, ...publico } = user as T & { passwordHash?: unknown };
  return publico;
}
