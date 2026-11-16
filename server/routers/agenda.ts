import { z } from "zod";
import {
  DURACAO_DA_AGENDADA_MAX,
  DURACAO_DA_AGENDADA_MIN,
  EMAIL_DO_PARTICIPANTE_MAX,
  emailDoParticipanteValido,
  fusoCanonico,
  LEMBRETES_DA_AGENDA,
  LOCAL_DA_AGENDADA_MAX,
  NOME_DO_PARTICIPANTE_MAX,
  PARTICIPANTES_DA_AGENDADA_MAX,
  FUSO_MAX,
  reuniaoJaAcabou,
} from "@shared/agenda";
import { TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import {
  atualizarNaAgenda,
  criarNaAgenda,
  ligarGravacaoNaAgenda,
  listarAgendaDaDona,
  obterDaAgenda,
} from "../agenda-de-reunioes";
import {
  acessoDaGoogle,
  enviarParaGoogle,
  excluirComAGoogle,
  existeNaAgenda,
  lerParaGoogle,
  MENSAGEM_AINDA_NA_AGENDA,
  tirarEventoDaGoogle,
  type ContaDaAgenda,
} from "../agenda-na-google";
import { googleAgendaConectada } from "../google-agenda";

/**
 * A agenda de reuniões (H16a do plano do gravador). Só a dona: a conta é sempre
 * a da sessão, e o serviço (server/agenda-de-reunioes.ts) a leva no WHERE de
 * tudo. A entrada é conferida aqui, antes de chegar ao banco.
 *
 * Com a Google Agenda conectada (H16c), marcar, mudar e excluir também criam,
 * mudam e tiram o evento lá: primeiro o banco, depois a Google
 * (server/agenda-na-google.ts). A falha da Google não desfaz o que a dona
 * salvou: a resposta diz `naGoogle: "falhou"` com o motivo, e a tela mostra
 * "Tentar de novo". O token da Google é lido antes de gravar (acessoDaGoogle):
 * o banco fora do ar nessa leitura é erro com nada salvo, e salvar de novo não
 * duplica a reunião.
 */

const contaDa = (usuaria: { id: number; openId: string }): ContaDaAgenda => ({ id: usuaria.id, openId: usuaria.openId });

// Inícios fora disto são erro de digitação ou de relógio, não reunião.
const INICIO_MIN = Date.UTC(2020, 0, 1);
const INICIO_MAX = Date.UTC(2100, 0, 1);

/** Texto opcional: vazio depois do trim vira nulo. */
const textoOpcional = (maximo: number) => z.string().trim().max(maximo).nullish().transform(valor => valor ? valor : null);

const participante = z.object({
  nome: textoOpcional(NOME_DO_PARTICIPANTE_MAX),
  // A mesma regra da tela (shared/agenda.ts): o que a tela deixa passar, aqui passa.
  email: z.string().trim().max(EMAIL_DO_PARTICIPANTE_MAX).nullish()
    .transform(valor => valor ? valor.toLowerCase() : null)
    .refine(valor => valor === null || emailDoParticipanteValido(valor), "E-mail do participante inválido."),
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
  // "A Google manda o convite pela sua conta" (H16c): desmarcado por padrão.
  googleConvites: z.boolean().default(false),
});

const idDaAgendada = z.string().uuid();

export const agendaRouter = router({
  listar: protectedProcedure.query(({ ctx }) => listarAgendaDaDona(ctx.user.openId)),

  obter: protectedProcedure
    .input(z.object({ id: idDaAgendada }))
    .query(({ ctx, input }) => obterDaAgenda(ctx.user.openId, input.id)),

  // Com a Google Agenda conectada, a reunião nasce "pendente" na Google, e o
  // evento é criado logo depois de o banco gravar. A que já acabou fica só na
  // WRW: na Google, nem evento nem convite para uma reunião que já houve.
  criar: protectedProcedure
    .input(entradaDaAgendada)
    .mutation(async ({ ctx, input }): Promise<{ id: string } & ResultadoNaGoogle> => {
      const conta = contaDa(ctx.user);
      const naGoogle = !reuniaoJaAcabou(input, Date.now()) && await googleAgendaConectada(conta.id);
      const acesso = naGoogle ? await acessoDaGoogle(conta) : null;
      const { id, updatedAt } = await criarNaAgenda(conta.openId, input, { naGoogle });
      if (!acesso) return { id, naGoogle: null };
      return { id, ...(await enviarParaGoogle(conta, { ...input, id, google: "pendente", updatedAt }, { acesso })) };
    }),

  // A que já acabou só muda o evento que já está na Google, sem avisar os
  // convidados (enviarParaGoogle).
  atualizar: protectedProcedure
    .input(entradaDaAgendada.extend({ id: idDaAgendada }))
    .mutation(async ({ ctx, input }): Promise<{ id: string } & ResultadoNaGoogle> => {
      const { id, ...dados } = input;
      const conta = contaDa(ctx.user);
      const naGoogle = await googleAgendaConectada(conta.id);
      const acesso = naGoogle ? await acessoDaGoogle(conta) : null;
      const { updatedAt } = await atualizarNaAgenda(conta.openId, id, dados, { naGoogle });
      if (!acesso) return { id, naGoogle: null };
      return { id, ...(await enviarParaGoogle(conta, { ...dados, id, google: "pendente", updatedAt }, { acesso })) };
    }),

  // A linha sai, e depois o evento (excluirComAGoogle): a reunião que já
  // acabou fica na Google como histórico; a que foi para lá, sem a Google
  // Agenda conectada agora, volta "falhou" com o motivo, e a tela avisa que o
  // evento continua lá. A escolha do convite volta à tela para o "Tentar de
  // novo" (tirarDaGoogle), já que a linha não existe mais.
  excluir: protectedProcedure
    .input(z.object({ id: idDaAgendada }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; avisarConvidados: boolean } & ResultadoNaGoogle> => ({
      ok: true,
      ...(await excluirComAGoogle(contaDa(ctx.user), input.id)),
    })),

  // "Tentar de novo" e "Pôr na Google Agenda": manda a versão que está no banco.
  mandarParaGoogle: protectedProcedure
    .input(z.object({ id: idDaAgendada }))
    .mutation(async ({ ctx, input }): Promise<ResultadoNaGoogle> => {
      const conta = contaDa(ctx.user);
      return enviarParaGoogle(conta, await lerParaGoogle(conta.openId, input.id));
    }),

  // O "Tentar de novo" da exclusão que não tirou o evento da Google: a linha já
  // saiu, então a tela manda a escolha do convite que a reunião tinha. Só tira o
  // evento de reunião que não está mais na agenda, e só da Google da própria
  // dona (o token é o dela).
  tirarDaGoogle: protectedProcedure
    .input(z.object({ id: idDaAgendada, avisarConvidados: z.boolean() }))
    .mutation(async ({ ctx, input }): Promise<ResultadoNaGoogle> => {
      const conta = contaDa(ctx.user);
      if (await existeNaAgenda(conta.openId, input.id)) throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_AINDA_NA_AGENDA });
      return tirarEventoDaGoogle(conta, input.id, input.avisarConvidados);
    }),

  // O "Gravar agora" (Meetings.tsx): a gravação recém-criada fica ligada à reunião marcada.
  ligarGravacao: protectedProcedure
    .input(z.object({ id: idDaAgendada, meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ligarGravacaoNaAgenda(ctx.user.openId, input.id, input.meetingId);
      return { ok: true as const };
    }),
});
