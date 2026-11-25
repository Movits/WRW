import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, chavesDeAcesso, contasGoogle, sessions, users, type User } from "../drizzle/schema";
import { MINUTOS_PARA_CADASTRAR_CHAVE } from "@shared/chaves-de-acesso";
import {
  ERRO_DA_CONTA_GOOGLE,
  ROTA_RETORNO_ENTRAR_COM_GOOGLE,
  type ModoDeEntrarComGoogle,
  type ResultadoDaContaGoogle,
} from "@shared/entrar-com-google";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { decryptData, encryptData, checkLoginRateLimit, invalidateSession, linhasAlcancadas, recordLoginAttempt } from "./security";
import { abrirSessao, type SessaoAberta } from "./sessao";

/**
 * Entrar com a conta Google (A8 da auditoria, HN-80 do HiNoter). Apple fica para
 * depois (decisão do Roberto). Reaproveita o cliente OAuth da Google Agenda
 * (GOOGLE_OAUTH_CLIENT_ID e _SECRET, server/google-oauth.ts) com um URI de
 * retorno próprio e só os escopos `openid` e `email`.
 *
 * O que vale aqui:
 * - state, PKCE (S256) e nonce na ida, guardados num cookie cifrado de 10 min;
 * - o id_token vem do endpoint de token da Google, pelo TLS, em troca do código,
 *   do segredo e do verificador (OpenID Connect 3.1.3.7: a assinatura pode
 *   ficar sem conferir); são conferidos o destinatário, o emissor, o prazo, o
 *   nonce, o `sub` e o `email_verified`;
 * - a conta decide pelo `sub` (contas_google), nunca pelo e-mail: conta da WRW
 *   com o mesmo e-mail e sem a conta Google ligada NÃO é ligada sozinha
 *   (`conta-existe`): a pessoa entra com a senha e liga no Perfil;
 * - a sessão é a do login (abrirSessao, 90 dias), com o mesmo bloqueio por
 *   tentativas (checkLoginRateLimit) e a auditoria na transação;
 * - nenhum token da Google fica guardado, e nenhum é revogado: a Google revoga
 *   por conta Google e projeto, e revogar derrubaria a Google Agenda da mesma
 *   conta Google.
 */

export const ESCOPOS_DA_ENTRADA = ["openid", "email"] as const;
const EMISSORES_DO_ID_TOKEN = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** A folga de relógio aceita no `exp` do id_token. */
const FOLGA_DO_RELOGIO_MS = 2 * 60_000;

export const ACAO_ENTRADA = "LOGIN";
export const METODO_DA_ENTRADA = "google";
export const ACAO_LIGADA = "GOOGLE_ACCOUNT_LINKED";
export const ACAO_DESLIGADA = "GOOGLE_ACCOUNT_UNLINKED";

// ── configuração ───────────────────────────────────────────────────────────

export type ConfiguracaoDaEntradaComGoogle = {
  clientId: string;
  clientSecret: string;
  /** A origem pública do site (FRONTEND_URL), sem caminho e sem barra no fim. */
  origem: string;
  /** O host da origem, em minúsculas: a ida e a volta só funcionam nele. */
  host: string;
  /** `<FRONTEND_URL>/api/entrar-com-google/retorno`, cadastrado no Google Cloud. */
  redirectUri: string;
};

/**
 * A configuração lida do ambiente A CADA CHAMADA, ou null (o botão some e as
 * rotas dão 404). Pede, além do cliente OAuth e do FRONTEND_URL (https, ou
 * http só no localhost), `ENTRAR_COM_GOOGLE=ligado`: o cliente OAuth já existe
 * em produção para a Google Agenda, e sem esta chave o botão apareceria para
 * todo mundo assim que o código entrasse, antes de o URI de retorno estar
 * cadastrado no Google Cloud e com o app em modo Teste (só os testadores
 * entram; os outros param numa página de erro da Google).
 */
export function configuracaoDaEntradaComGoogle(ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDaEntradaComGoogle | null {
  if ((ambiente.ENTRAR_COM_GOOGLE ?? "").trim().toLowerCase() !== "ligado") return null;
  const clientId = ambiente.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = ambiente.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const frontendUrl = ambiente.FRONTEND_URL?.trim();
  if (!clientId || !clientSecret || !frontendUrl) return null;
  let url: URL;
  try {
    url = new URL(frontendUrl);
  } catch {
    return null;
  }
  const naMaquina = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && naMaquina)) return null;
  return {
    clientId,
    clientSecret,
    origem: url.origin,
    host: url.host.toLowerCase(),
    redirectUri: `${url.origin}${ROTA_RETORNO_ENTRAR_COM_GOOGLE}`,
  };
}

/**
 * O endereço da tela da Google: só `openid email`, sem `access_type=offline`
 * (nenhum refresh token), `prompt=select_account` (quem tem várias contas
 * Google escolhe qual), o nonce e o desafio do PKCE.
 */
export function urlDeAutorizacaoDaEntrada(
  config: ConfiguracaoDaEntradaComGoogle,
  ida: { state: string; desafio: string; nonce: string },
): string {
  const parametros = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ESCOPOS_DA_ENTRADA.join(" "),
    prompt: "select_account",
    state: ida.state,
    nonce: ida.nonce,
    code_challenge: ida.desafio,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${parametros.toString()}`;
}

// ── o cookie da ida ─────────────────────────────────────────────────────────

export const COOKIE_DA_IDA_DA_ENTRADA = "wrw_entrar_google";
export const PRAZO_DA_IDA_DA_ENTRADA_MS = 10 * 60_000;

export type IdaDaEntrada = {
  state: string;
  verificador: string;
  nonce: string;
  modo: ModoDeEntrarComGoogle;
  /** Só no modo `ligar`: a conta da sessão que começou. */
  userId: number | null;
  /** O `?voltar=` do login, já conferido por `voltarAceitavel`. */
  voltar: string | null;
  expiraEm: number;
};

/** O cookie, cifrado e autenticado (AES-256-GCM, encryptData): ninguém lê nem muda. */
export function selarIdaDaEntrada(ida: IdaDaEntrada): string {
  return encryptData(JSON.stringify({
    s: ida.state, v: ida.verificador, n: ida.nonce, m: ida.modo, u: ida.userId, r: ida.voltar, e: ida.expiraEm,
  }));
}

export type IdaDaEntradaAberta =
  | { ok: true; ida: IdaDaEntrada }
  | { ok: false; motivo: "ausente" | "adulterada" | "vencida" };

const MODOS = new Set<string>(["entrar", "cadastrar", "ligar"]);

export function abrirIdaDaEntrada(valor: string | undefined, agora: number = Date.now()): IdaDaEntradaAberta {
  if (!valor) return { ok: false, motivo: "ausente" };
  let dados: unknown;
  try {
    dados = JSON.parse(decryptData(valor));
  } catch {
    return { ok: false, motivo: "adulterada" };
  }
  const { s, v, n, m, u, r, e } = (dados && typeof dados === "object" ? dados : {}) as Record<string, unknown>;
  if (typeof s !== "string" || typeof v !== "string" || typeof n !== "string" || typeof m !== "string" || !MODOS.has(m)
    || !(u === null || typeof u === "number") || !(r === null || typeof r === "string") || typeof e !== "number") {
    return { ok: false, motivo: "adulterada" };
  }
  if (m === "ligar" && typeof u !== "number") return { ok: false, motivo: "adulterada" };
  if (e <= agora) return { ok: false, motivo: "vencida" };
  return { ok: true, ida: { state: s, verificador: v, nonce: n, modo: m as ModoDeEntrarComGoogle, userId: u, voltar: r, expiraEm: e } };
}

/** O nonce do OpenID Connect: 32 bytes aleatórios. */
export function gerarNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * O `?voltar=` que a ida guarda: caminho do próprio site, curto, sem barra
 * dupla no começo, barra invertida, espaço ou controle. A tela confere de novo
 * com `caminhoDeVoltaSeguro` (client/src/lib/caminho-de-volta.ts) antes de usar.
 */
export function voltarAceitavel(valor: unknown): string | null {
  if (typeof valor !== "string" || !valor.startsWith("/") || valor.startsWith("//") || valor.length > 512) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(valor)) return null;
  return valor;
}

// ── o id_token ──────────────────────────────────────────────────────────────

export type IdentidadeDaEntrada = { sub: string; email: string };

export type IdentidadeLida =
  | { ok: true; identidade: IdentidadeDaEntrada }
  | { ok: false; motivo: "invalido" | "email-nao-verificado" };

/**
 * A conta Google do id_token. Recusa (invalido) o token mal formado, de outro
 * destinatário, de outro emissor, vencido, sem o nonce da ida ou sem um `sub`
 * válido; recusa (email-nao-verificado) o e-mail que a Google não garante.
 */
export function lerIdentidadeDaEntrada(
  idToken: string | null,
  esperado: { clientId: string; nonce: string },
  agora: number = Date.now(),
): IdentidadeLida {
  const invalido = { ok: false, motivo: "invalido" } as const;
  if (!idToken) return invalido;
  const partes = idToken.split(".");
  if (partes.length !== 3) return invalido;
  let dados: Record<string, unknown>;
  try {
    const lido = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    if (!lido || typeof lido !== "object") return invalido;
    dados = lido as Record<string, unknown>;
  } catch {
    return invalido;
  }
  const aud = dados.aud;
  const paraNos = aud === esperado.clientId || (Array.isArray(aud) && aud.includes(esperado.clientId));
  if (!paraNos || !EMISSORES_DO_ID_TOKEN.has(String(dados.iss))) return invalido;
  if (typeof dados.exp !== "number" || dados.exp * 1000 + FOLGA_DO_RELOGIO_MS <= agora) return invalido;
  if (typeof dados.nonce !== "string" || !mesmoTexto(dados.nonce, esperado.nonce)) return invalido;
  const sub = typeof dados.sub === "string" ? dados.sub : "";
  if (!/^[\x21-\x7e]{1,255}$/.test(sub)) return invalido;
  const email = typeof dados.email === "string" ? dados.email.trim().toLowerCase() : "";
  // A Google manda `email_verified` como booleano; só `true` vale.
  if (dados.email_verified !== true || !email || email.length > 320 || !email.includes("@")) {
    return { ok: false, motivo: "email-nao-verificado" };
  }
  return { ok: true, identidade: { sub, email } };
}

function mesmoTexto(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── o banco ─────────────────────────────────────────────────────────────────

export type PedidoDaEntrada = { ip: string; rede: string; userAgent?: string };

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

function linhaDeAuditoria(dados: {
  userId: number;
  action: string;
  resourceId?: string | null;
  details: Record<string, unknown>;
  pedido: { ip?: string; userAgent?: string };
  riskLevel: "low" | "medium";
}): typeof auditLogs.$inferInsert {
  const ip = dados.pedido.ip ? dados.pedido.ip.split(",")[0].trim().substring(0, 45) : null;
  return {
    userId: dados.userId,
    action: dados.action,
    resource: "auth",
    resourceId: dados.resourceId ?? null,
    details: dados.details,
    ipAddress: ip || null,
    userAgent: dados.pedido.userAgent ? dados.pedido.userAgent.substring(0, 500) : null,
    status: "success",
    riskLevel: dados.riskLevel,
  };
}

/** ER_DUP_ENTRY (errno 1062) em qualquer ponto da cadeia de `cause`. */
function ehChaveDuplicada(erro: unknown): boolean {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

/** O nome que a conta nova recebe: o começo do e-mail (o escopo `profile` não é pedido). O cadastro pede o nome de exibição. */
export function nomeDaContaNova(email: string): string {
  const antes = email.split("@")[0]?.trim() ?? "";
  return (antes.length >= 2 ? antes : email).slice(0, 100);
}

const COLUNAS_DA_CONTA = {
  id: users.id,
  openId: users.openId,
  name: users.name,
  email: users.email,
  role: users.role,
  isActive: users.isActive,
  onboardingCompleted: users.onboardingCompleted,
};
type ContaDaEntrada = Pick<User, "id" | "openId" | "name" | "email" | "role" | "isActive" | "onboardingCompleted">;

export type ResultadoDaEntrada =
  | { ok: true; token: string; expiresAt: Date; usuaria: Pick<User, "id" | "name" | "onboardingCompleted">; contaNova: boolean }
  | { ok: false; resultado: ResultadoDaContaGoogle };

/**
 * A entrada pelos modos `entrar` e `cadastrar`, depois da troca do código:
 * 1. o `sub` ligado a uma conta: entra nela (o e-mail da Google não conta);
 * 2. sem vínculo, com conta da WRW no e-mail dela: `conta-existe`, sem ligar;
 * 3. sem vínculo e sem conta: no `entrar`, `sem-conta`; no `cadastrar`, cria a
 *    conta (Bronze, sem senha, e-mail verificado, cadastro por concluir) e o
 *    vínculo na mesma transação, com a auditoria, e entra.
 * Entrar segue `entrarNaConta`. Banco fora do ar sobe como é.
 */
export async function entrarComGoogle(
  identidade: IdentidadeDaEntrada,
  modo: "entrar" | "cadastrar",
  pedido: PedidoDaEntrada,
  agora: number = Date.now(),
): Promise<ResultadoDaEntrada> {
  const db = await exigirDb();
  const [vinculo] = await db.select().from(contasGoogle).where(eq(contasGoogle.googleSub, identidade.sub)).limit(1);
  if (vinculo) {
    const [conta] = await db.select(COLUNAS_DA_CONTA).from(users).where(eq(users.id, vinculo.userId)).limit(1);
    if (!conta) return { ok: false, resultado: "erro" };
    return entrarNaConta(conta, vinculo.id, identidade.sub, pedido, agora, false);
  }

  const [mesmoEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, identidade.email)).limit(1);
  if (mesmoEmail) return { ok: false, resultado: "conta-existe" };
  if (modo === "entrar") return { ok: false, resultado: "sem-conta" };

  const openId = `google_${crypto.randomBytes(16).toString("hex")}`;
  const idDoVinculo = crypto.randomUUID();
  try {
    await db.transaction(async tx => {
      const criada = await tx.insert(users).values({
        openId,
        name: nomeDaContaNova(identidade.email),
        email: identidade.email,
        passwordHash: null,
        // A Google garantiu o e-mail (email_verified).
        emailVerified: true,
        loginMethod: "google",
        // Como no cadastro por senha (server/auth.ts): toda conta nasce Bronze.
        role: "bronze",
        isActive: true,
        isVerified: false,
        onboardingCompleted: false,
        lastSignedIn: new Date(agora),
      });
      const userId = Number(criada[0].insertId);
      await tx.insert(contasGoogle).values({
        id: idDoVinculo, userId, googleSub: identidade.sub, emailGoogle: identidade.email, createdAt: agora, ultimoUsoEm: null,
      });
      await tx.insert(auditLogs).values(linhaDeAuditoria({
        userId, action: ACAO_LIGADA, resourceId: idDoVinculo, details: { origem: "cadastro", contaNova: true }, pedido, riskLevel: "low",
      }));
    });
  } catch (erro) {
    // Outra entrada criou a conta (o mesmo e-mail) ou o vínculo (o mesmo sub) ao mesmo tempo.
    if (ehChaveDuplicada(erro)) return { ok: false, resultado: "conta-existe" };
    throw erro;
  }
  const [conta] = await db.select(COLUNAS_DA_CONTA).from(users).where(eq(users.openId, openId)).limit(1);
  if (!conta) return { ok: false, resultado: "erro" };
  return entrarNaConta(conta, idDoVinculo, identidade.sub, pedido, agora, true);
}

/**
 * Abre a sessão da conta, como a entrada com chave de acesso
 * (server/chaves-de-acesso.ts): o bloqueio por tentativas do login (pelo
 * e-mail da conta e pela rede), a conta ativa, a sessão por `abrirSessao` e,
 * numa transação, a conta ainda ativa, o vínculo ainda de pé (UPDATE com a
 * conta e o sub no WHERE: desligado ao mesmo tempo, não alcança a linha), o
 * último acesso e a auditoria. Se a transação falha, a sessão cai.
 */
async function entrarNaConta(
  conta: ContaDaEntrada,
  idDoVinculo: string,
  sub: string,
  pedido: PedidoDaEntrada,
  agora: number,
  contaNova: boolean,
): Promise<ResultadoDaEntrada> {
  const db = await exigirDb();
  const identificador = conta.email?.trim().toLowerCase() || null;
  if (identificador) {
    const limite = await checkLoginRateLimit(identificador, pedido.rede);
    if (!limite.allowed) return { ok: false, resultado: "muitas-tentativas" };
  }
  if (!conta.isActive) return { ok: false, resultado: "desativada" };

  let sessao: SessaoAberta;
  try {
    sessao = await abrirSessao({ usuaria: conta, ip: pedido.ip, userAgent: pedido.userAgent });
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    console.error(`[Entrar com Google] a sessão não abriu (userId ${conta.id}): ${descreverErroDeBanco(erro)}`);
    return { ok: false, resultado: "erro" };
  }
  let recusa: ResultadoDaContaGoogle | null = null;
  try {
    await db.transaction(async tx => {
      const [agoraNaConta] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, conta.id)).limit(1);
      if (!agoraNaConta) { recusa = "erro"; throw new Error("conta sumiu"); }
      if (!agoraNaConta.isActive) { recusa = "desativada"; throw new Error("conta desativada"); }
      const uso = await tx.update(contasGoogle).set({ ultimoUsoEm: agora })
        .where(and(eq(contasGoogle.id, idDoVinculo), eq(contasGoogle.userId, conta.id), eq(contasGoogle.googleSub, sub)));
      if (linhasAlcancadas(uso) !== 1) { recusa = "erro"; throw new Error("o vínculo saiu no meio da entrada"); }
      await tx.update(users).set({ lastSignedIn: new Date(agora) }).where(eq(users.id, conta.id));
      await tx.insert(auditLogs).values(linhaDeAuditoria({
        userId: conta.id, action: ACAO_ENTRADA, resourceId: idDoVinculo, details: { metodo: METODO_DA_ENTRADA }, pedido, riskLevel: "low",
      }));
    });
  } catch (erro) {
    await invalidateSession(sessao.sessionToken).catch(falha => {
      console.error("[Entrar com Google] a sessão da entrada recusada não caiu:", falha instanceof Error ? falha.message : falha);
    });
    if (recusa) return { ok: false, resultado: recusa };
    throw erro;
  }
  if (identificador) {
    await recordLoginAttempt(identificador, pedido.rede, true).catch(erro => {
      console.error(`[Entrar com Google] as tentativas erradas não foram zeradas (userId ${conta.id}): ${descreverErroDeBanco(erro)}`);
    });
  }
  return {
    ok: true,
    token: sessao.token,
    expiresAt: sessao.expiresAt,
    usuaria: { id: conta.id, name: conta.name, onboardingCompleted: conta.onboardingCompleted },
    contaNova,
  };
}

/** A sessão do pedido pode começar a ligar? Recente (como cadastrar chave de acesso), ativa, da conta. */
export async function sessaoPodeLigar(userId: number, sessionToken: string | null): Promise<"ok" | "entre-de-novo"> {
  if (!sessionToken) return "entre-de-novo";
  const db = await exigirDb();
  const [sessao] = await db.select({
    userId: sessions.userId,
    isActive: sessions.isActive,
    expiresAt: sessions.expiresAt,
    // Pelo relógio do BANCO, como em COLUNAS_DA_SESSAO_QUE_CADASTRA.
    recente: sql<number>`(${sessions.createdAt} >= NOW() - INTERVAL ${MINUTOS_PARA_CADASTRAR_CHAVE} MINUTE)`,
  }).from(sessions).where(eq(sessions.sessionToken, sessionToken)).limit(1);
  if (!sessao || !sessao.isActive || sessao.userId !== userId || sessao.expiresAt.getTime() <= Date.now()) return "entre-de-novo";
  return Number(sessao.recente) === 1 ? "ok" : "entre-de-novo";
}

/**
 * Liga a conta Google à conta logada, numa transação que trava a linha da
 * sessão (a redefinição de senha derruba as sessões e apaga o vínculo na
 * transação dela: ou esta termina antes e o vínculo é apagado, ou encontra a
 * sessão derrubada). A conta Google em outra conta: `em-outra-conta`; a conta
 * já com outra conta Google: `outra-ligada`; a mesma: `ligada`, sem mudar nada.
 */
export async function ligarContaGoogle(
  userId: number,
  sessionToken: string | null,
  identidade: IdentidadeDaEntrada,
  pedido: { ip?: string; userAgent?: string },
  agora: number = Date.now(),
): Promise<ResultadoDaContaGoogle> {
  if (!sessionToken) return "entre-de-novo";
  const db = await exigirDb();
  try {
    return await db.transaction(async tx => {
      const [sessao] = await tx.select({ userId: sessions.userId, isActive: sessions.isActive, expiresAt: sessions.expiresAt })
        .from(sessions).where(eq(sessions.sessionToken, sessionToken)).limit(1).for("update");
      if (!sessao || !sessao.isActive || sessao.userId !== userId || sessao.expiresAt.getTime() <= agora) return "entre-de-novo";
      const [doSub] = await tx.select({ userId: contasGoogle.userId }).from(contasGoogle).where(eq(contasGoogle.googleSub, identidade.sub)).limit(1);
      if (doSub) return doSub.userId === userId ? "ligada" : "em-outra-conta";
      const [daConta] = await tx.select({ id: contasGoogle.id }).from(contasGoogle).where(eq(contasGoogle.userId, userId)).limit(1);
      if (daConta) return "outra-ligada";
      const id = crypto.randomUUID();
      await tx.insert(contasGoogle).values({ id, userId, googleSub: identidade.sub, emailGoogle: identidade.email, createdAt: agora, ultimoUsoEm: null });
      await tx.insert(auditLogs).values(linhaDeAuditoria({
        userId, action: ACAO_LIGADA, resourceId: id, details: { origem: "perfil" }, pedido, riskLevel: "medium",
      }));
      return "ligada";
    });
  } catch (erro) {
    // Outra volta ligou ao mesmo tempo (o mesmo sub, ou a mesma conta).
    if (ehChaveDuplicada(erro)) return "erro";
    throw erro;
  }
}

export type EstadoDaContaGoogle = { ligada: false } | { ligada: true; email: string | null; desde: number; temSenha: boolean };

export async function estadoDaContaGoogle(userId: number): Promise<EstadoDaContaGoogle> {
  const db = await exigirDb();
  const [linha] = await db.select({ email: contasGoogle.emailGoogle, desde: contasGoogle.createdAt })
    .from(contasGoogle).where(eq(contasGoogle.userId, userId)).limit(1);
  if (!linha) return { ligada: false };
  const [conta] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  return { ligada: true, email: linha.email, desde: Number(linha.desde), temSenha: Boolean(conta?.passwordHash) };
}

/**
 * Desliga a conta Google, com a auditoria na transação. Recusa quando a conta
 * não tem senha nem chave de acesso: sem o Google, ela só voltaria pelo
 * "Esqueci minha senha"; a tela pede para criar a senha antes.
 */
export async function desligarContaGoogle(userId: number, pedido: { ip?: string; userAgent?: string }): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [conta] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1).for("update");
    const [linha] = await tx.select({ id: contasGoogle.id }).from(contasGoogle).where(eq(contasGoogle.userId, userId)).limit(1);
    if (!conta || !linha) throw new TRPCError({ code: "NOT_FOUND", message: ERRO_DA_CONTA_GOOGLE.naoLigada });
    if (!conta.passwordHash) {
      const [chave] = await tx.select({ id: chavesDeAcesso.id }).from(chavesDeAcesso).where(eq(chavesDeAcesso.userId, userId)).limit(1);
      if (!chave) throw new TRPCError({ code: "PRECONDITION_FAILED", message: ERRO_DA_CONTA_GOOGLE.semSenha });
    }
    await tx.delete(contasGoogle).where(and(eq(contasGoogle.id, linha.id), eq(contasGoogle.userId, userId)));
    await tx.insert(auditLogs).values(linhaDeAuditoria({
      userId, action: ACAO_DESLIGADA, resourceId: linha.id, details: { origem: "perfil" }, pedido, riskLevel: "medium",
    }));
  });
}

/**
 * A redefinição de senha tira a conta Google, como tira as chaves de acesso: quem
 * tomou a conta e ligou a conta Google dele não fica com a porta depois que a
 * dona recupera a conta pelo e-mail. Na transação da redefinição.
 */
export async function apagarContaGoogleNaRedefinicaoDeSenha(tx: Transacao, userId: number, pedido: { ip?: string; userAgent?: string }): Promise<number> {
  const apagadas = linhasAlcancadas(await tx.delete(contasGoogle).where(eq(contasGoogle.userId, userId)));
  if (apagadas > 0) {
    await tx.insert(auditLogs).values(linhaDeAuditoria({
      userId, action: ACAO_DESLIGADA, details: { origem: "redefinicao_de_senha" }, pedido, riskLevel: "medium",
    }));
  }
  return apagadas;
}
