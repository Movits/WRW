import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { registrarDispositivo, removerDispositivo } from "../push-no-celular";
import { sessionTokenDoPedido } from "../sessao";

// ============================================================
// PUSH NO CELULAR: o app das lojas guarda e tira o token do aparelho
// ============================================================
// As regras estão em server/push-no-celular.ts. O token fica preso à sessão
// do pedido; o texto do push sai no idioma mandado aqui (o da tela do app).
const TOKEN = z.string().min(1).max(255);

export const pushNoCelularRouter = router({
  registrar: protectedProcedure
    .input(z.object({
      token: TOKEN,
      plataforma: z.enum(["ios", "android"]),
      idioma: z.string().min(1).max(12),
    }))
    .mutation(async ({ ctx, input }) => {
      const resultado = await registrarDispositivo({
        userId: ctx.user.id,
        sessionToken: await sessionTokenDoPedido(ctx.req),
        token: input.token,
        plataforma: input.plataforma,
        idioma: input.idioma,
      });
      if (!resultado.ok) throw new TRPCError({ code: "BAD_REQUEST", message: resultado.erro });
      return { ok: true as const };
    }),

  remover: protectedProcedure
    .input(z.object({ token: TOKEN }))
    .mutation(async ({ ctx, input }) => ({ removido: await removerDispositivo({ userId: ctx.user.id, token: input.token }) })),
});
