import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { router } from "../_core/trpc";
import { adminProcedure } from "./_procedures";
import { exigirDb, listUsers, updateOpportunity } from "../db";
import {
  createAuditLog,
  getAuditLogs as getSecurityAuditLogs,
  getSecurityEvents,
  getSecurityStats,
  lockUserAccount,
  resolveSecurityEvent,
  revokeAllUserSessions,
  cleanupExpiredSessions,
} from "../security";
import { users } from "../../drizzle/schema";

// ============================================================
// PAINEL ADMINISTRATIVO
// ============================================================
export const adminRouter = router({
  getStats: adminProcedure.query(async ({ ctx }) => {
    await createAuditLog({ userId: ctx.user.id, action: "ADMIN_VIEW_STATS", resource: "admin_panel", status: "success", riskLevel: "medium" });
    return getSecurityStats();
  }),

  getUsers: adminProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0), role: z.string().optional(), search: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await createAuditLog({ userId: ctx.user.id, action: "ADMIN_LIST_USERS", resource: "users", status: "success", riskLevel: "medium" });
      return listUsers({ role: input.role, search: input.search, limit: input.limit, offset: input.offset });
    }),

  getAuditLogs: adminProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      await createAuditLog({ userId: ctx.user.id, action: "ADMIN_VIEW_AUDIT_LOGS", resource: "audit_logs", status: "success", riskLevel: "medium" });
      return getSecurityAuditLogs(input.limit, input.offset);
    }),

  getSecurityEvents: adminProcedure
    .input(z.object({ resolved: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      return getSecurityEvents(input.resolved);
    }),

  resolveEvent: adminProcedure
    .input(z.object({ eventId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await resolveSecurityEvent(input.eventId, ctx.user.id);
      return { success: true };
    }),

  updateUserRole: adminProcedure
    .input(z.object({
      userId: z.number(),
      role: z.enum(["bronze", "silver", "gold", "admin", "president"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();

      // Ouro = Presidente: membras Ouro podem conceder/revogar Status Ouro para outras
      if (input.role === "gold" && ctx.user.role !== "president" && ctx.user.role !== "gold" && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "O Status Ouro é a categoria premium da rede. Apenas membros Ouro podem conceder ou revogar este status."
        });
      }

      // Membras Ouro podem promover outras ao nível president (compat. legado)
      if (input.role === "president" && ctx.user.role !== "president" && ctx.user.role !== "gold" && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Apenas membros Ouro podem nomear outros para funções especiais."
        });
      }

      // Buscar o role atual para verificar se está revogando Ouro
      const [targetUser] = await db.select({ role: users.role, name: users.name }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (targetUser?.role === "gold" && input.role !== "gold" && ctx.user.role !== "president" && ctx.user.role !== "gold" && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Apenas membros Ouro podem revogar o Status Ouro."
        });
      }

      await db.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
      await createAuditLog({
        userId: ctx.user.id,
        action: input.role === "gold" ? "PRESIDENT_GRANT_GOLD" : (targetUser?.role === "gold" ? "PRESIDENT_REVOKE_GOLD" : "ADMIN_UPDATE_USER_ROLE"),
        resource: "users",
        resourceId: String(input.userId),
        details: { newRole: input.role, previousRole: targetUser?.role },
        status: "success",
        riskLevel: "high"
      });
      return { success: true };
    }),

  toggleUserStatus: adminProcedure
    .input(z.object({ userId: z.number(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      await db.update(users).set({ isActive: input.isActive }).where(eq(users.id, input.userId));
      // Desativar derruba as sessões. Só a conta inativa não bastava: as linhas
      // em sessions seguiam ativas, e ao reativar a conta qualquer sessão usada
      // nos últimos 90 dias (server/duracao-da-sessao.ts) voltava a valer —
      // inclusive a de quem motivou a desativação.
      if (!input.isActive) await revokeAllUserSessions(input.userId);
      await createAuditLog({ userId: ctx.user.id, action: input.isActive ? "ADMIN_ACTIVATE_USER" : "ADMIN_DEACTIVATE_USER", resource: "users", resourceId: String(input.userId), status: "success", riskLevel: "high" });
      return { success: true };
    }),

  revokeUserSessions: adminProcedure
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await revokeAllUserSessions(input.userId);
      return { success: true };
    }),

  lockAccount: adminProcedure
    .input(z.object({ userId: z.number(), reason: z.string().min(10).max(500) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível bloquear sua própria conta" });
      await lockUserAccount(input.userId, ctx.user.id, input.reason);
      return { success: true };
    }),

  // Moderar oportunidades pendentes
  getPendingOpportunities: adminProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const { opportunities } = await import("../../drizzle/schema");
    return db.select().from(opportunities)
      .where(eq(opportunities.status, "pending"))
      .orderBy(opportunities.createdAt)
      .limit(50);
  }),

  moderateOpportunity: adminProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      action: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await updateOpportunity(input.opportunityId, {
        status: input.action === "approve" ? "active" : "rejected",
        moderatedBy: ctx.user.id,
        moderationNote: input.note,
        moderatedAt: new Date(),
      });
      await createAuditLog({ userId: ctx.user.id, action: `ADMIN_${input.action.toUpperCase()}_OPPORTUNITY`, resource: "opportunities", resourceId: String(input.opportunityId), status: "success", riskLevel: "medium" });
      return { success: true };
    }),

  cleanupSessions: adminProcedure.mutation(async ({ ctx }) => {
    const cleaned = await cleanupExpiredSessions();
    return { cleaned };
  }),

  getActiveSessions: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      await createAuditLog({ userId: ctx.user.id, action: "ADMIN_VIEW_SESSIONS", resource: "sessions", status: "success", riskLevel: "medium" });
      const db = await exigirDb();
      const { sessions: sessionsTable } = await import("../../drizzle/schema");
      if (!sessionsTable) return [];
      return db.select({
        id: sessionsTable.id,
        userId: sessionsTable.userId,
        ipAddress: sessionsTable.ipAddress,
        userAgent: sessionsTable.userAgent,
        lastActivityAt: sessionsTable.lastActivityAt,
        expiresAt: sessionsTable.expiresAt,
        userName: users.name,
      })
        .from(sessionsTable)
        .innerJoin(users, eq(users.id, sessionsTable.userId))
        .where(eq(sessionsTable.isActive, true))
        .orderBy(desc(sessionsTable.lastActivityAt))
        .limit(input.limit);
    }),
});
