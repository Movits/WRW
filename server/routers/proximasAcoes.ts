import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  apagarProximaAcao,
  criarProximaAcao,
  editarProximaAcao,
  ligarContato,
  listarProximasAcoes,
  marcarProximaAcaoFeita,
  proximasAcoesDoPainel,
} from "../proximas-acoes";
import { DETALHE_DA_ACAO_MAX, prazoValido, RESPONSAVEL_DA_ACAO_MAX, TEXTO_DA_ACAO_MAX } from "@shared/proximas-acoes";

/**
 * As próximas ações da dona (H5a): a página /proximas-acoes e o cartão do
 * Dashboard. Só a dona, a da sessão, no WHERE de tudo (server/proximas-acoes.ts).
 * As de reunião nascem ao confirmar o item no resumo (meetings.decidirItemDoResumo
 * e as irmãs); aqui se lê, anota, edita, marca, liga contato e apaga.
 */

const texto = z.string().trim().min(1).max(TEXTO_DA_ACAO_MAX);
// Vazio apaga o campo: chega como null.
const opcional = (max: number) => z.string().trim().max(max).nullable().optional().transform(valor => (valor ? valor : valor === undefined ? undefined : null));
const prazo = z.string().nullable().optional().refine(valor => !valor || prazoValido(valor), { message: "Prazo inválido." })
  .transform(valor => (valor ? valor : valor === undefined ? undefined : null));
const id = z.string().uuid();

export const proximasAcoesRouter = router({
  listar: protectedProcedure
    .input(z.object({ filtro: z.enum(["abertas", "todas"]).default("abertas") }))
    .query(({ ctx, input }) => listarProximasAcoes(ctx.user.openId, input.filtro)),

  doPainel: protectedProcedure.query(({ ctx }) => proximasAcoesDoPainel(ctx.user.openId)),

  criar: protectedProcedure
    .input(z.object({
      texto,
      detalhe: opcional(DETALHE_DA_ACAO_MAX),
      responsavel: opcional(RESPONSAVEL_DA_ACAO_MAX),
      prazo,
      contactId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(({ ctx, input }) => criarProximaAcao(ctx.user.openId, input)),

  editar: protectedProcedure
    .input(z.object({
      id,
      texto: texto.optional(),
      detalhe: opcional(DETALHE_DA_ACAO_MAX),
      responsavel: opcional(RESPONSAVEL_DA_ACAO_MAX),
      prazo,
    }))
    .mutation(async ({ ctx, input }) => {
      const { id: acaoId, ...campos } = input;
      await editarProximaAcao(ctx.user.openId, acaoId, campos);
      return { ok: true as const };
    }),

  marcarFeita: protectedProcedure
    .input(z.object({ id, feita: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await marcarProximaAcaoFeita(ctx.user.openId, input.id, input.feita);
      return { ok: true as const };
    }),

  ligarContato: protectedProcedure
    .input(z.object({ id, contactId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ligarContato(ctx.user.openId, input.id, input.contactId);
      return { ok: true as const };
    }),

  apagar: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      await apagarProximaAcao(ctx.user.openId, input.id);
      return { ok: true as const };
    }),
});
