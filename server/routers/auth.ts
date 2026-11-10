import { TRPCError } from "@trpc/server";
import { z } from "zod";
import crypto from "crypto";
import { eq, and, sql } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { publicProcedure, router } from "../_core/trpc";
import { exigirDb } from "../db";
import {
  ehErroDeBancoIndisponivel,
  ehErroDoDriverDeBanco,
  MENSAGEM_BANCO_INDISPONIVEL,
} from "../banco-indisponivel";
import { createAuditLog, invalidateSession } from "../security";
import { users, passwordResetTokens, passwordResetRequests } from "../../drizzle/schema";
import { registerUser, loginUser, toPublicUser } from "../auth";
import {
  hashPasswordResetToken,
  PASSWORD_RESET_ACCOUNT_LIMIT,
  PASSWORD_RESET_GENERIC_MESSAGE,
  PASSWORD_RESET_RATE_LIMIT,
  PASSWORD_RESET_RATE_WINDOW_MS,
  PASSWORD_RESET_TTL_MS,
} from "../password-reset-security";
import { criarTeto } from "../assistente-de-texto";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import { filaDoBcrypt } from "../fila-do-bcrypt";

// ============================================================
// AUTENTICAÇÃO
// ============================================================
// login e register embrulham o que loginUser/registerUser lançam em
// UNAUTHORIZED/BAD_REQUEST com a mensagem original, porque essas funções falam
// com a usuária por Error("E-mail ou senha incorretos."). Erro do banco não é
// mensagem para a usuária: relançado cru, o middleware de _core/trpc.ts traduz
// a queda em "banco indisponível" e o errorFormatter mascara o SQL dos demais.
const ehErroDeBanco = (err: unknown) => ehErroDeBancoIndisponivel(err) || ehErroDoDriverDeBanco(err);

// Tetos em memória pela rede real (ip-da-cliente.ts: CF-Connecting-IP, IPv6
// no /56), contados POR CHAMADA: um único HTTP em lote do tRPC
// ("/api/trpc/auth.register,auth.register,...") carrega quantas chamadas
// quiser, e o limite por minuto só enxerga o HTTP. A vaga é reservada ANTES do
// primeiro await: o que o banco conta (bloqueio de login, pedidos de
// recuperação) só é gravado depois de vários awaits, e chamadas simultâneas
// liam todas a contagem antiga.
//
// Os valores são chamadas, não pessoas: contam erro de digitação, clique
// duplo, "e-mail já cadastrado" e "conta sem senha". Para o lançamento de
// 16/09 (~200 pessoas no mesmo wi-fi, parte delas importadas que tentam
// entrar antes de pedir o link) a folga é de ~2 vezes. O custo de CPU de uma
// rajada fica na fila do bcrypt (fila-do-bcrypt.ts), não nestes números.
export const JANELA_DOS_TETOS_DE_AUTH_MS = 15 * 60_000;
export const CADASTROS_POR_REDE = 400;
export const LOGINS_POR_REDE = 600;
/**
 * Força bruta contra UMA conta: 10 tentativas a cada 15 min por rede + e-mail.
 * O bloqueio do banco (5 falhas por hora, server/security.ts) lê a contagem e
 * grava +1 sem trava — tentativas simultâneas passavam todas. Este teto não
 * atinge outra pessoa do mesmo wi-fi: a chave inclui o e-mail.
 */
export const LOGINS_POR_REDE_E_EMAIL = 10;

export const tetoDeCadastro = criarTeto(
  CADASTROS_POR_REDE,
  JANELA_DOS_TETOS_DE_AUTH_MS,
  "Muitos cadastros a partir desta rede. Aguarde alguns minutos e tente de novo.",
);
export const tetoDeLogin = criarTeto(
  LOGINS_POR_REDE,
  JANELA_DOS_TETOS_DE_AUTH_MS,
  "Muitas tentativas de entrada a partir desta rede. Aguarde alguns minutos e tente de novo.",
);
export const tetoDeLoginPorEmail = criarTeto(
  LOGINS_POR_REDE_E_EMAIL,
  JANELA_DOS_TETOS_DE_AUTH_MS,
  "Muitas tentativas de entrada com este e-mail. Aguarde alguns minutos e tente de novo.",
);
/**
 * "Esqueci minha senha", na memória e antes de qualquer await, com os mesmos
 * números das contagens do banco (que ficam: sobrevivem ao deploy). O da rede
 * responde TOO_MANY_REQUESTS com mensagem — vem antes de buscar a conta, então
 * não revela se ela existe. O do e-mail responde a frase genérica de sempre:
 * um erro ali contaria a quem pede quantos pedidos OUTRA pessoa fez para
 * aquele endereço.
 */
export const tetoDeRecuperacaoPorRede = criarTeto(
  PASSWORD_RESET_RATE_LIMIT,
  PASSWORD_RESET_RATE_WINDOW_MS,
  "Muitos pedidos de recuperação de senha a partir desta rede. Aguarde alguns minutos e tente de novo.",
);
export const tetoDeRecuperacaoPorEmail = criarTeto(
  PASSWORD_RESET_ACCOUNT_LIMIT,
  PASSWORD_RESET_RATE_WINDOW_MS,
  PASSWORD_RESET_GENERIC_MESSAGE,
);

/** E-mail como chave de teto: normalizado e curto (o zod não limita o tamanho). */
const chaveDoEmail = (email: string) => email.trim().toLowerCase().slice(0, 320);

export const authRouter = router({
  // Público de propósito: sem sessão, devolve null e a tela manda para o login.
  // Mas "sem sessão porque o banco caiu" (ctx.bancoIndisponivel, ver
  // _core/context.ts) não pode virar null: null é exatamente o que o client
  // lê como "não autenticada", e a usuária logada seria expulsa para o login
  // enquanto o banco estivesse fora do ar.
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user && ctx.bancoIndisponivel) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
    }
    return toPublicUser(ctx.user);
  }),

  register: publicProcedure
    .input(z.object({
      name: z.string().min(2).max(100),
      email: z.string().email(),
      password: z.string().min(8),
    }))
    .mutation(async ({ ctx, input }) => {
      // Fora do try: o catch abaixo transformaria o TOO_MANY_REQUESTS em BAD_REQUEST.
      tetoDeCadastro.reservar(chaveDeRede(ipDaCliente(ctx.req)));
      try {
        const { userId } = await registerUser(input);
        return { success: true, userId };
      } catch (err: any) {
        // A fila do bcrypt cheia (TOO_MANY_REQUESTS) chega à tela como é.
        if (err instanceof TRPCError || ehErroDeBanco(err)) throw err;
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      // Antes era o X-Forwarded-For cru, e loginUser usava o primeiro item —
      // escrito pelo cliente. Trocá-lo a cada tentativa driblava o bloqueio por
      // e-mail + IP.
      const ip = ipDaCliente(ctx.req);
      const rede = chaveDeRede(ip);
      const ua = ctx.req.headers["user-agent"];
      // Fora do try: o catch abaixo transformaria o TOO_MANY_REQUESTS em UNAUTHORIZED.
      tetoDeLogin.reservar(rede);
      tetoDeLoginPorEmail.reservar(`${rede}|${chaveDoEmail(input.email)}`);
      try {
        // O bloqueio do banco conta pela rede (/56); a sessão guarda o IP cru.
        const { token, user, expiresAt } = await loginUser({ email: input.email, password: input.password, ip, chaveDoBloqueio: rede, userAgent: ua });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
        await createAuditLog({ userId: user.id, action: "LOGIN", resource: "auth", ipAddress: ip, userAgent: ua, status: "success", riskLevel: "low" });
        return { success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, onboardingCompleted: user.onboardingCompleted } };
      } catch (err: any) {
        // A fila do bcrypt cheia (TOO_MANY_REQUESTS) chega à tela como é.
        if (err instanceof TRPCError || ehErroDeBanco(err)) throw err;
        throw new TRPCError({ code: "UNAUTHORIZED", message: err.message });
      }
    }),

  forgotPassword: publicProcedure
    .input(z.object({
      email: z.string().email(),
    }))
    .mutation(async ({ ctx, input }) => {
      const genericResponse = { success: true, message: PASSWORD_RESET_GENERIC_MESSAGE };
      // IP real, e IPv6 agrupado no /56 (ip-da-cliente.ts). Era o primeiro item
      // do X-Forwarded-For: forjável por quem abusa e, para o público honesto
      // do mesmo wi-fi, um balde só de 3 pedidos.
      const ipAddress = chaveDeRede(ipDaCliente(ctx.req)).slice(0, 64);
      // Os tetos em memória vêm ANTES do primeiro await. As contagens do banco
      // abaixo leem e só gravam depois de outros awaits: 100 pedidos
      // simultâneos (um HTTP em lote basta) liam todos "zero" e mandavam 100
      // e-mails para a mesma caixa.
      tetoDeRecuperacaoPorRede.reservar(ipAddress);
      try {
        tetoDeRecuperacaoPorEmail.reservar(chaveDoEmail(input.email));
      } catch {
        console.warn(
          `[PasswordReset] Pedido recusado pelo limite de ${PASSWORD_RESET_ACCOUNT_LIMIT} por e-mail em ${PASSWORD_RESET_RATE_WINDOW_MS / 60_000} min.`,
        );
        return genericResponse;
      }
      const db = await exigirDb();

      const windowStart = new Date(Date.now() - PASSWORD_RESET_RATE_WINDOW_MS);
      const [rateWindow] = await db.select({ count: sql<number>`COUNT(*)` })
        .from(passwordResetRequests)
        .where(and(
          eq(passwordResetRequests.ipAddress, ipAddress),
          sql`${passwordResetRequests.createdAt} >= ${windowStart}`,
        ));
      // A mesma resposta é retornada ao exceder o limite para não revelar informações.
      if (Number(rateWindow?.count ?? 0) >= PASSWORD_RESET_RATE_LIMIT) {
        // ...mas o limite não pode ser invisível para NÓS. Sem esta linha, o
        // pedido recusado some sem deixar rastro: a tela mostra o mesmo "Pedido
        // recebido" de qualquer outro pedido, nenhum e-mail sai, e não há nada
        // no log do Render que explique o silêncio. Foi o relato "o esqueci a
        // senha não chega" (Gabriel, reteste de 15/09), com este limite ainda
        // em 3: a partir da quarta tentativa em 15 minutos nada mais saía, sem
        // aviso. Hoje ele é 300, e o teto em memória (tetoDeRecuperacaoPorRede,
        // acima) recusa antes, com TOO_MANY_REQUESTS e aviso na tela. Este ramo
        // só dispara quando a memória não tem a contagem que o banco tem: deploy
        // ou reinício dentro da janela; a chave desta rede tirada do teto quando
        // ele passa de MAXIMO_DE_CHAVES_POR_TETO redes (criarTeto, em
        // assistente-de-texto.ts); ou, por instantes, no fim da janela, porque a
        // memória marca o pedido ao reservar e o banco só ao gravar, um pouco
        // depois, e o mesmo pedido sai antes da conta da memória. Em todos os
        // casos a recusa segue sem aviso na tela.
        //
        // O log NÃO leva o IP nem o e-mail: quem investiga precisa saber que o
        // limite disparou, não quem o disparou, e a tabela
        // `password_reset_requests` já guarda o IP para quem precisar auditar.
        console.warn(
          `[PasswordReset] Pedido recusado pelo limite de ${PASSWORD_RESET_RATE_LIMIT} por IP em ${PASSWORD_RESET_RATE_WINDOW_MS / 60_000} min.`,
        );
        return genericResponse;
      }
      await db.insert(passwordResetRequests).values({ id: crypto.randomUUID(), ipAddress });

      const normalizedEmail = input.email.trim().toLowerCase();
      // Buscar usuário pelo e-mail
      const [user] = await db.select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);
      // Sempre retornar sucesso para não revelar se o e-mail existe (segurança)
      if (!user) return genericResponse;
      // Limite por CONTA: com o IP afrouxado para o evento, é ele que impede
      // encher de e-mails a caixa de uma pessoa. Conta só o que gera e-mail
      // (conta que existe); a resposta é a mesma, então não vira oráculo, e o
      // log não leva e-mail nem IP.
      const [pedidosDaConta] = await db.select({ count: sql<number>`COUNT(*)` })
        .from(passwordResetTokens)
        .where(and(
          eq(passwordResetTokens.userId, user.id),
          sql`${passwordResetTokens.createdAt} >= ${windowStart}`,
        ));
      if (Number(pedidosDaConta?.count ?? 0) >= PASSWORD_RESET_ACCOUNT_LIMIT) {
        console.warn(
          `[PasswordReset] Pedido recusado pelo limite de ${PASSWORD_RESET_ACCOUNT_LIMIT} por conta em ${PASSWORD_RESET_RATE_WINDOW_MS / 60_000} min (userId ${user.id}).`,
        );
        return genericResponse;
      }
      // Invalidar tokens anteriores do mesmo usuário
      await db.update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, user.id), sql`${passwordResetTokens.usedAt} IS NULL`));
      // Token opaco de uso único; apenas seu hash é armazenado no banco.
      const rawToken = crypto.randomBytes(48).toString("hex");
      const tokenHash = hashPasswordResetToken(rawToken);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS); // 1 hora
      await db.insert(passwordResetTokens).values({ userId: user.id, token: tokenHash, expiresAt });
      // Não aceitar origem do cliente: evita que um link de reset aponte para domínio malicioso.
      // E sem FRONTEND_URL não se inventa domínio: o fallback antigo apontava para o
      // endereço morto do Manus, e o link chegaria quebrado na caixa de entrada.
      const frontendUrl = process.env.FRONTEND_URL;
      if (!frontendUrl) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Variável de ambiente FRONTEND_URL não definida: ela é a origem dos links de recuperação de senha e não tem valor padrão.",
        });
      }
      const siteOrigin = frontendUrl.replace(/\/+$/, "");
      const resetUrl = `${siteOrigin}/reset-password?token=${encodeURIComponent(rawToken)}`;
      // Enviar e-mail via Resend
      try {
        const { sendEmail, buildPasswordResetEmail } = await import("../_core/email");
        const { html, text } = buildPasswordResetEmail(user.name || "Membro", resetUrl);
        const emailSent = await sendEmail({
          to: user.email!,
          subject: "Redefina sua senha — WRW",
          html,
          text,
        });
        // A falha de envio NÃO pode virar erro para quem chamou. Este
        // procedimento responde sempre a mesma coisa de propósito: e-mail que
        // não existe já sai por `if (!user) return genericResponse` lá em cima.
        // Se o e-mail cadastrado respondesse 500 quando a Resend falha, bastaria
        // estourar a cota diária (o plano gratuito tem teto de 100 por dia) para
        // transformar este endereço num oráculo: 500 = a conta existe, 200 = não
        // existe. O problema de entrega é NOSSO e sai no log, não na resposta.
        //
        // O log também não leva o e-mail da usuária: `userId` identifica a linha
        // para quem for investigar, sem espalhar dado pessoal pelos registros do
        // Render.
        if (!emailSent) {
          console.error(`[PasswordReset] A Resend não aceitou a solicitação de envio (userId ${user.id}).`);
        }
      } catch (error) {
        console.error(`[PasswordReset] Falha ao enviar e-mail de recuperação (userId ${user.id}):`, error);
      }
      return genericResponse;
    }),

  resetPassword: publicProcedure
    .input(z.object({
      token: z.string().min(10),
      newPassword: z.string().min(8),
    }))
    .mutation(async ({ input }) => {
      const db = await exigirDb();
      const tokenHash = hashPasswordResetToken(input.token);
      // Buscar token válido
      const [resetToken] = await db.select()
        .from(passwordResetTokens)
        .where(and(
          eq(passwordResetTokens.token, tokenHash),
          sql`${passwordResetTokens.usedAt} IS NULL`,
          sql`${passwordResetTokens.expiresAt} > NOW()`
        ))
        .limit(1);
      if (!resetToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Token inválido ou expirado. Solicite um novo link de recuperação." });
      }
      // Atualizar senha (na fila do bcrypt, como o cadastro e o login)
      const bcrypt = await import("bcryptjs");
      const passwordHash = await filaDoBcrypt.executar(() => bcrypt.hash(input.newPassword, 12));
      await db.update(users).set({ passwordHash }).where(eq(users.id, resetToken.userId));
      // Marcar token como usado
      await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, resetToken.id));
      return { success: true };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.user) {
      await createAuditLog({ userId: ctx.user.id, action: "LOGOUT", resource: "auth", ipAddress: ctx.req.headers["x-forwarded-for"] as string, userAgent: ctx.req.headers["user-agent"], status: "success", riskLevel: "low" });
    }
    const cookies = ctx.req.headers.cookie;
    if (cookies) {
      const cookieMatch = cookies.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
      if (cookieMatch?.[1]) {
        try {
          const jwtPayload = JSON.parse(Buffer.from(cookieMatch[1].split(".")[1], "base64url").toString("utf8"));
          if (jwtPayload?.sessionToken) await invalidateSession(jwtPayload.sessionToken).catch(() => {});
          else await invalidateSession(cookieMatch[1]).catch(() => {});
        } catch { await invalidateSession(cookieMatch[1]).catch(() => {}); }
      }
    }
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return { success: true } as const;
  }),
});
