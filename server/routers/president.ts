import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { router } from "../_core/trpc";
import { presidentProcedure } from "./_procedures";
import { exigirDb, grantGoldAccess, revokeGoldAccess, createNotification, listUsers, contarUsuarias } from "../db";
import { createAuditLog } from "../security";
import { users, goldAccessGrants, opportunities } from "../../drizzle/schema";
import { notifyHighCompatibilityForOpportunity } from "./matching";

// ============================================================
// PAINEL PRESIDENTES — GESTÃO DE ACESSO OURO
// ============================================================
export const presidentRouter = router({
  grantGold: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      reason: z.string().max(500).optional().default("Promovido pelo Presidente da MarquesaMatch"),
    }))
    .mutation(async ({ ctx, input }) => {
      // Buscar nome da usuária para personalizar a mensagem
      const db = await exigirDb();
      const [targetUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.userId)).limit(1);
      const userName = targetUser?.name || "";
      const firstName = userName.split(" ")[0] || "";
      await grantGoldAccess(input.userId, ctx.user.id, input.reason || "Promovido pelo Presidente da MarquesaMatch");
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_GRANT_GOLD", resource: "users", resourceId: String(input.userId), details: { reason: input.reason }, status: "success", riskLevel: "high" });
      // Notificar a usuária promovida com mensagem automática
      try {
        await createNotification({
          userId: input.userId,
          type: "gold_granted",
          // Ouro é a categoria premium da rede (Governança, 14/09/2026), não
          // prêmio por mérito: o texto fala de acesso, não de reconhecimento.
          title: "⭐ Boas-vindas ao Status Ouro!",
          body: `Olá${firstName ? ", " + firstName : ""}! Seu Status Ouro está ativo. Você passa a ter acesso em primeira mão a oportunidades selecionadas de negócios nacionais e internacionais e a encontros estratégicos da rede, conforme disponibilidade e regras da plataforma.`,
          actionUrl: "/dashboard",
        });
      } catch (_) { /* não bloquear se notificação falhar */ }
      // Enviar mensagem direta na caixa de mensagens da usuária promovida
      try {
        const { directMessages } = await import("../../drizzle/schema");
        const goldMsg = `⭐ Boas-vindas ao Status Ouro${firstName ? ", " + firstName : ""}!\n\nO Status Ouro é a categoria premium da MarquesaMatch. A partir de agora você tem acesso em primeira mão a oportunidades selecionadas, a Deal Rooms, Conexões Estratégicas, ao Painel Ouro e aos encontros estratégicos nacionais e internacionais da rede, conforme disponibilidade e regras da plataforma.\n\nObservação: ${input.reason || "Promovido pelo Presidente da MarquesaMatch"}\n\nEsteja onde as grandes oportunidades chegam primeiro. 🌟`;
        await db.insert(directMessages).values({
          senderId: ctx.user.id, // mensagem enviada pela presidente
          recipientId: input.userId,
          encryptedContent: goldMsg,
        });
      } catch (_) { /* não bloquear se mensagem falhar */ }
      return { success: true };
    }),

  revokeGold: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      reason: z.string().min(10).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      // O nível de volta sai do perfil (Prata se qualificado, Bronze se não).
      const novoNivel = await revokeGoldAccess(input.userId, ctx.user.id, input.reason);
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_REVOKE_GOLD", resource: "users", resourceId: String(input.userId), details: { reason: input.reason, newRole: novoNivel }, status: "success", riskLevel: "high" });
      // Notificar a usuária sobre a revogação, no mesmo vocabulário da concessão:
      // Ouro é categoria premium, não selo de reconhecimento.
      try {
        await createNotification({
          userId: input.userId,
          type: "gold_revoked",
          title: "Status Ouro revogado",
          body: `Seu Status Ouro, a categoria premium da MarquesaMatch, foi revogado por um Presidente da MarquesaMatch. Sua conta continua ativa como ${novoNivel === "bronze" ? "Bronze" : "Prata"}. Motivo: ${input.reason}`,
          actionUrl: "/dashboard",
        });
      } catch (_) { /* não bloquear se notificação falhar */ }
      return { success: true, novoNivel };
    }),

  getGoldGrants: presidentProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    return db.select({
      grant: goldAccessGrants,
      userName: users.name,
      userEmail: users.email,
    })
      .from(goldAccessGrants)
      .innerJoin(users, eq(users.id, goldAccessGrants.grantedTo))
      .orderBy(desc(goldAccessGrants.createdAt))
      .limit(100);
  }),

  listSilverUsers: presidentProcedure.query(async ({ ctx }) => {
    return listUsers({ role: "silver", limit: 100 });
  }),

  // Listar usuárias para gestão (conceder Ouro, nomear líder). A busca roda
  // NO BANCO e `total` é o COUNT com as mesmas condições: a versão anterior
  // aceitava `search` e o ignorava, devolvendo as 100 mais recentes com
  // total = tamanho da página; o painel filtrava em memória e a membra mais
  // antiga que a 100ª "não existia" para a presidente.
  listAllUsers: presidentProcedure
    .input(z.object({
      role: z.enum(["bronze", "silver", "gold", "president", "admin"]).optional(),
      // Vários níveis numa consulta só (a Gestão Ouro lista Bronze e Prata),
      // com a mesma paginação e o mesmo COUNT da busca por um nível.
      roles: z.array(z.enum(["bronze", "silver", "gold", "president", "admin"])).min(1).max(5).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(100),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const [usuarias, total] = await Promise.all([listUsers(input), contarUsuarias(input)]);
      return { users: usuarias, total };
    }),

  // Validar oportunidade estratégica (aprovar/rejeitar antes de publicar)
  validateOpportunity: presidentProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      status: z.enum(["approved", "rejected", "pending_info"]),
      note: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      // Buscar oportunidade e nome da publicadora
      const [oppRow] = await db.select({
        opp: opportunities,
        publisherName: users.name,
        publisherId: users.id,
      }).from(opportunities).innerJoin(users, eq(users.id, opportunities.publishedBy)).where(eq(opportunities.id, input.opportunityId)).limit(1);
      const firstName = (oppRow?.publisherName || "").split(" ")[0] || "";
      const publisherId = oppRow?.publisherId;
      // Atualizar status da oportunidade
      const newStatus = input.status === "approved" ? "active" : input.status === "rejected" ? "rejected" : "pending";
      await db.update(opportunities)
        .set({ status: newStatus as "active" | "rejected" | "pending", moderatedBy: ctx.user.id, moderationNote: input.note, moderatedAt: new Date() })
        .where(eq(opportunities.id, input.opportunityId));
      // Registrar validação
      await db.execute(
        sql`INSERT INTO president_validations (opportunityId, validatedBy, status, note) VALUES (${input.opportunityId}, ${ctx.user.id}, ${input.status}, ${input.note || ""}) ON DUPLICATE KEY UPDATE status=${input.status}, note=${input.note || ""}`
      );
      // Enviar notificação automática personalizada para a publicadora
      if (publisherId) {
        try {
          if (input.status === "approved") {
            await createNotification({
              userId: publisherId,
              type: "opportunity_approved",
              title: "✅ Sua proposta foi aprovada!",
              body: `Olá, ${firstName}. Analisamos a sua proposta e ela se encaixa muito bem no que buscamos.`,
              actionUrl: `/opportunities/${input.opportunityId}`,
            });
            // Só agora a oportunidade está pública — é o momento certo de
            // avisar as usuárias com alta compatibilidade.
            notifyHighCompatibilityForOpportunity(input.opportunityId).catch(e =>
              console.error("[President] Falha nos alertas de compatibilidade:", e)
            );
          } else if (input.status === "rejected") {
            await createNotification({
              userId: publisherId,
              type: "opportunity_rejected",
              title: "Proposta não aprovada",
              body: `Olá, ${firstName}. Agradecemos o envio da proposta e o seu tempo. No momento, essa oportunidade não está alinhada com as nossas prioridades e foco estratégico atual.`,
              actionUrl: `/opportunities/${input.opportunityId}`,
            });
          }
        } catch (_) { /* não bloquear */ }
      }
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_VALIDATE_OPPORTUNITY", resource: "opportunities", resourceId: String(input.opportunityId), details: { status: input.status, note: input.note }, status: "success", riskLevel: "medium" });
      return { success: true };
    }),

  // Solicitar informações adicionais sobre uma oportunidade
  requestInfo: presidentProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      infoNeeded: z.string().min(5).max(500), // ex: "detalhamento de custos"
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [oppRow] = await db.select({
        opp: opportunities,
        publisherName: users.name,
        publisherId: users.id,
      }).from(opportunities).innerJoin(users, eq(users.id, opportunities.publishedBy)).where(eq(opportunities.id, input.opportunityId)).limit(1);
      const firstName = (oppRow?.publisherName || "").split(" ")[0] || "";
      const publisherId = oppRow?.publisherId;
      if (!publisherId) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade não encontrada" });
      // Manter status como pending
      await db.execute(
        sql`INSERT INTO president_validations (opportunityId, validatedBy, status, note) VALUES (${input.opportunityId}, ${ctx.user.id}, 'pending_info', ${input.infoNeeded}) ON DUPLICATE KEY UPDATE status='pending_info', note=${input.infoNeeded}`
      );
      // Enviar mensagem automática personalizada
      await createNotification({
        userId: publisherId,
        type: "system",
        title: "📎 Informações adicionais solicitadas",
        body: `Olá, ${firstName}. Recebemos a sua proposta e temos interesse em avaliar melhor. Para seguirmos para a próxima etapa, você poderia nos enviar ${input.infoNeeded}? Ficamos no aguardo.`,
        actionUrl: `/opportunities/${input.opportunityId}`,
      });
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_REQUEST_INFO", resource: "opportunities", resourceId: String(input.opportunityId), details: { infoNeeded: input.infoNeeded }, status: "success", riskLevel: "low" });
      return { success: true };
    }),

  // Listar oportunidades pendentes de validação
  listPendingOpportunities: presidentProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    return db.select({
      opp: opportunities,
      publisherName: users.name,
      publisherEmail: users.email,
    })
      .from(opportunities)
      .innerJoin(users, eq(users.id, opportunities.publishedBy))
      .where(eq(opportunities.status, "pending"))
      .orderBy(desc(opportunities.createdAt))
      .limit(50);
  }),

  // Nomear líder nacional
  nominateLeader: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      region: z.string().min(2).max(100),
      specialty: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      // INSERT simples — permite múltiplos líderes (sem ON DUPLICATE KEY)
      await db.execute(
        sql`INSERT INTO national_leaders (userId, nominatedBy, region, specialty, isActive) VALUES (${input.userId}, ${ctx.user.id}, ${input.region}, ${input.specialty || ""}, 1)`
      );
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_NOMINATE_LEADER", resource: "users", resourceId: String(input.userId), details: { region: input.region }, status: "success", riskLevel: "medium" });
      return { success: true };
    }),

  // Revogar líder por ID do registro (não por userId)
  revokeLeader: presidentProcedure
    .input(z.object({
      leaderId: z.number().int(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      await db.execute(
        sql`UPDATE national_leaders SET isActive=0, revokedAt=NOW(), revokedBy=${ctx.user.id}, revokeReason=${input.reason || ""} WHERE id=${input.leaderId}`
      );
      await createAuditLog({ userId: ctx.user.id, action: "PRESIDENT_REVOKE_LEADER", resource: "national_leaders", resourceId: String(input.leaderId), details: { reason: input.reason }, status: "success", riskLevel: "medium" });
      return { success: true };
    }),

  // Buscar oportunidades de um líder específico
  getLeaderOpportunities: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [rows] = await db.execute(
        sql`SELECT o.id, o.title, o.type, o.status, o.complianceLevel, o.createdAt, o.country,
         u.name as publisherName, u.email as publisherEmail
         FROM opportunities o
         INNER JOIN users u ON u.id = o.publishedBy
         WHERE o.publishedBy = ${input.userId}
         ORDER BY o.createdAt DESC
         LIMIT ${input.limit}`
      ) as unknown as [Record<string, unknown>[], unknown];
      return Array.isArray(rows) ? rows : [];
    }),

  // Listar líderes nacionais (ativos)
  listLeaders: presidentProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const [rows] = await db.execute(
      sql`SELECT nl.id, nl.userId, nl.region, nl.specialty, nl.isActive, nl.createdAt, u.name, u.email, u.country FROM national_leaders nl INNER JOIN users u ON u.id = nl.userId WHERE nl.isActive = 1 ORDER BY nl.createdAt DESC LIMIT 100`
    ) as unknown as [Record<string, unknown>[], unknown];
    return Array.isArray(rows) ? rows : [];
  }),

  // Estatísticas gerais de governança
  getGovernanceStats: presidentProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const [totalUsers] = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
    const [bronzeCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.role, "bronze"));
    const [silverCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.role, "silver"));
    const [goldCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.role, "gold"));
    const [presidentCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.role, "president"));
    const [pendingOpps] = await db.select({ count: sql<number>`COUNT(*)` }).from(opportunities).where(eq(opportunities.status, "pending"));
    const [activeOpps] = await db.select({ count: sql<number>`COUNT(*)` }).from(opportunities).where(eq(opportunities.status, "active"));
    const [redOpps] = await db.select({ count: sql<number>`COUNT(*)` }).from(opportunities).where(eq(opportunities.complianceLevel, "red"));
    return {
      totalUsers: totalUsers.count,
      bronzeUsers: bronzeCount.count,
      silverUsers: silverCount.count,
      goldUsers: goldCount.count,
      presidentUsers: presidentCount.count,
      pendingOpportunities: pendingOpps.count,
      activeOpportunities: activeOpps.count,
      redFlagOpportunities: redOpps.count,
    };
  }),
});
