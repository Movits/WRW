import { z } from "zod";
import {
  BUSCA_DA_CONSULTA_MAX,
  COMPLEMENTO_DO_MOTIVO_MAX,
  COMPLEMENTO_DO_MOTIVO_MIN,
  MOTIVOS_DA_CONSULTA,
} from "@shared/consulta-da-administracao";
import { router } from "../_core/trpc";
import { abrirReuniaoNaConsulta, listarReunioesParaAAdministracao, type QuemConsulta } from "../consulta-da-administracao";
import { ipDaCliente } from "../ip-da-cliente";
import { plataformaProcedure } from "./_procedures";

/**
 * A consulta das reuniões pela administração (R1a): só a staff (admin e
 * presidente), pelo plataformaProcedure; Ouro sem cargo leva FORBIDDEN. As
 * regras moram em server/consulta-da-administracao.ts: a lista e cada
 * abertura ficam na auditoria, e abrir pede o motivo antes de ler.
 */
function quemConsulta(ctx: { user: { id: number }; req: Parameters<typeof ipDaCliente>[0] & { headers: Record<string, unknown> } }): QuemConsulta {
  const agente = ctx.req.headers["user-agent"];
  return { userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: typeof agente === "string" ? agente : null };
}

export const consultaDeReunioesRouter = router({
  listar: plataformaProcedure
    .input(z.object({
      busca: z.string().trim().max(BUSCA_DA_CONSULTA_MAX).optional(),
      comLinkAberto: z.boolean().optional(),
      antes: z.object({ criadaEm: z.number().int().nonnegative(), id: z.string().uuid() }).optional(),
    }).optional())
    .query(({ ctx, input }) => listarReunioesParaAAdministracao(quemConsulta(ctx), input ?? {})),

  // Uma mutação, e não uma consulta: cada abertura grava uma linha na
  // auditoria, e o navegador não pode repeti-la sozinho (foco, reconexão).
  abrir: plataformaProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      motivo: z.enum(MOTIVOS_DA_CONSULTA),
      complemento: z.string().trim().min(COMPLEMENTO_DO_MOTIVO_MIN).max(COMPLEMENTO_DO_MOTIVO_MAX),
    }))
    .mutation(({ ctx, input }) => abrirReuniaoNaConsulta(quemConsulta(ctx), input.meetingId, { motivo: input.motivo, complemento: input.complemento })),
});
