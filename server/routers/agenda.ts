import { z } from "zod";
import {
  DURACAO_DA_AGENDADA_MAX,
  DURACAO_DA_AGENDADA_MIN,
  EMAIL_DO_PARTICIPANTE_MAX,
  fusoCanonico,
  LEMBRETES_DA_AGENDA,
  LOCAL_DA_AGENDADA_MAX,
  NOME_DO_PARTICIPANTE_MAX,
  PARTICIPANTES_DA_AGENDADA_MAX,
  FUSO_MAX,
} from "@shared/agenda";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import { protectedProcedure, router } from "../_core/trpc";
import {
  atualizarNaAgenda,
  criarNaAgenda,
  excluirDaAgenda,
  ligarGravacaoNaAgenda,
  listarAgendaDaDona,
  obterDaAgenda,
} from "../agenda-de-reunioes";

/**
 * A agenda de reuniões (H16a do plano do gravador). Só a dona: a conta é sempre
 * a da sessão, e o serviço (server/agenda-de-reunioes.ts) a leva no WHERE de
 * tudo. A entrada é conferida aqui, antes de chegar ao banco.
 */

// Inícios fora disto são erro de digitação ou de relógio, não reunião.
const INICIO_MIN = Date.UTC(2020, 0, 1);
const INICIO_MAX = Date.UTC(2100, 0, 1);

/** Texto opcional: vazio depois do trim vira nulo. */
const textoOpcional = (maximo: number) => z.string().trim().max(maximo).nullish().transform(valor => valor ? valor : null);

const participante = z.object({
  nome: textoOpcional(NOME_DO_PARTICIPANTE_MAX),
  email: z.string().trim().max(EMAIL_DO_PARTICIPANTE_MAX).nullish()
    .transform(valor => valor ? valor.toLowerCase() : null)
    .refine(valor => valor === null || z.string().email().safeParse(valor).success, "E-mail do participante inválido."),
}).refine(p => Boolean(p.nome || p.email), "O participante precisa de um nome ou de um e-mail.");

export const entradaDaAgendada = z.object({
  titulo: z.string().trim().min(TITULO_DA_REUNIAO_MIN).max(TITULO_DA_REUNIAO_MAX),
  inicioEm: z.number().int().min(INICIO_MIN).max(INICIO_MAX),
  duracaoMinutos: z.number().int().min(DURACAO_DA_AGENDADA_MIN).max(DURACAO_DA_AGENDADA_MAX),
  // O nome canônico da IANA é o que fica gravado; o que o Intl não conhece é recusado.
  fuso: z.string().trim().min(1).max(FUSO_MAX).transform((valor, ctx) => {
    const canonico = fusoCanonico(valor);
    if (!canonico) {
      ctx.addIssue({ code: "custom", message: "Fuso horário desconhecido." });
      return z.NEVER;
    }
    return canonico;
  }),
  local: textoOpcional(LOCAL_DA_AGENDADA_MAX),
  participantes: z.array(participante).max(PARTICIPANTES_DA_AGENDADA_MAX).default([]),
  // Nulo (ou ausente) é sem lembrete.
  lembreteMinutos: z.number().int().nullish().transform(valor => valor ?? null)
    .refine(valor => valor === null || (LEMBRETES_DA_AGENDA as readonly number[]).includes(valor), "Lembrete fora das opções."),
});

const idDaAgendada = z.string().uuid();

export const agendaRouter = router({
  listar: protectedProcedure.query(({ ctx }) => listarAgendaDaDona(ctx.user.openId)),

  obter: protectedProcedure
    .input(z.object({ id: idDaAgendada }))
    .query(({ ctx, input }) => obterDaAgenda(ctx.user.openId, input.id)),

  criar: protectedProcedure
    .input(entradaDaAgendada)
    .mutation(({ ctx, input }) => criarNaAgenda(ctx.user.openId, input)),

  atualizar: protectedProcedure
    .input(entradaDaAgendada.extend({ id: idDaAgendada }))
    .mutation(({ ctx, input }) => {
      const { id, ...dados } = input;
      return atualizarNaAgenda(ctx.user.openId, id, dados);
    }),

  excluir: protectedProcedure
    .input(z.object({ id: idDaAgendada }))
    .mutation(async ({ ctx, input }) => {
      await excluirDaAgenda(ctx.user.openId, input.id);
      return { ok: true as const };
    }),

  // O "Gravar agora" (Meetings.tsx): a gravação recém-criada fica ligada à reunião marcada.
  ligarGravacao: protectedProcedure
    .input(z.object({ id: idDaAgendada, meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ligarGravacaoNaAgenda(ctx.user.openId, input.id, input.meetingId);
      return { ok: true as const };
    }),
});
