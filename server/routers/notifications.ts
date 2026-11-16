import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getNotifications, markNotificationsRead } from "../db";
import { markNotificationRead } from "../security";

// ============================================================
// NOTIFICAÇÕES
// ============================================================
export const notificationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getNotifications(ctx.user.id, 30);
  }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await markNotificationsRead(ctx.user.id);
    return { success: true };
  }),

  // Marcar lido aviso por aviso (H15): tocar um aviso no sino o marca, e os
  // outros continuam novos. Só o da própria conta: o id de outra não muda nada.
  markRead: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await markNotificationRead(input.id, ctx.user.id);
      return { success: true };
    }),
});
