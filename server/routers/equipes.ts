import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { MEETING_TRANSCRIPT_LANGUAGES } from "../meeting-service";
import { ipDaCliente } from "../ip-da-cliente";
import {
  aceitarConviteDaEquipe, agendaDaEquipe, apagarTarefaDaEquipe, convidarConexaoParaEquipe, criarConviteDaEquipe, criarTarefaDaEquipe,
  editarTarefaDaEquipe, listarTarefasDaEquipe, marcarTarefaDaEquipe, minhasEquipes, mudarPapel, porNaAgendaDaEquipe, removerMembra,
  responderConviteDaEquipe, reunioesDaEquipe, sairDaEquipe, verConviteDaEquipe, verEquipe,
} from "../espacos-de-equipe";
import { PAPEIS_DA_EQUIPE, RESPONSAVEL_DA_TAREFA_MAX, TEXTO_DA_TAREFA_MAX } from "@shared/espacos-de-equipe";
import type { ProvaDaPessoa } from "../participantes-da-reuniao";

/**
 * Os espaços de equipe (R2, server/espacos-de-equipe.ts): a pasta da dona com
 * membras, as reuniões da pasta, as tarefas e a agenda da equipe. Tudo pela
 * sessão (protectedProcedure); quem pode o quê é conferido no serviço, no
 * banco, pelo papel da conta na pasta. Nenhum procedimento daqui recebe o id de
 * uma reunião: a leitura das reuniões da equipe é a da participante (R1b), pelo
 * link aberto com a credencial, que passa por reuniaoVisivel().
 * Recusas como código que a tela traduz (shared/espacos-de-equipe.ts).
 */

type Contexto = { user: { id: number; openId: string }; req: Parameters<typeof ipDaCliente>[0] & { headers: Record<string, unknown> } };

function prova(ctx: Contexto): ProvaDaPessoa {
  const agente = ctx.req.headers["user-agent"];
  return { userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: typeof agente === "string" ? agente : null };
}
const conta = (ctx: Contexto) => ({ id: ctx.user.id, openId: ctx.user.openId });

const pastaId = z.string().uuid();
const papel = z.enum(PAPEIS_DA_EQUIPE);
// A confirmação da dona de que as pessoas que falaram autorizaram (o primeiro convite da equipe).
const autorizacao = z.object({
  idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
  textoExibido: z.string().trim().min(1).max(1000),
}).optional();
const texto = z.string().trim().min(1).max(TEXTO_DA_TAREFA_MAX);
// Vazio apaga o campo: chega como null.
const opcional = (max: number) => z.string().trim().max(max).nullable().optional().transform(valor => (valor ? valor : valor === undefined ? undefined : null));
// O formato é conferido no serviço, com o código traduzido.
const prazo = z.string().max(10).nullable().optional().transform(valor => (valor ? valor : valor === undefined ? undefined : null));

export const equipesRouter = router({
  /** As equipes de que a conta é membra e os convites de conexão pendentes. */
  minhas: protectedProcedure.query(({ ctx }) => minhasEquipes(conta(ctx))),

  /** A equipe como a conta a vê (dona: as membras e os convites; membra: só as ativas). */
  ver: protectedProcedure.input(z.object({ pastaId })).query(({ ctx, input }) => verEquipe(conta(ctx), input.pastaId)),

  reunioes: protectedProcedure.input(z.object({ pastaId })).query(({ ctx, input }) => reunioesDaEquipe(conta(ctx), input.pastaId)),

  criarConvite: protectedProcedure
    .input(z.object({ pastaId, papel, autorizacao }))
    .mutation(({ ctx, input }) => criarConviteDaEquipe(conta(ctx), input.pastaId, input.papel, prova(ctx), input.autorizacao)),

  convidarConexao: protectedProcedure
    .input(z.object({ pastaId, conexaoId: z.number().int().positive(), papel, autorizacao }))
    .mutation(({ ctx, input }) => convidarConexaoParaEquipe(conta(ctx), input.pastaId, input.conexaoId, input.papel, prova(ctx), input.autorizacao)),

  cancelarConvite: protectedProcedure
    .input(z.object({ membraId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => { await removerMembra(ctx.user.openId, input.membraId, prova(ctx), { soConvite: true }); return { ok: true as const }; }),

  removerMembra: protectedProcedure
    .input(z.object({ membraId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => { await removerMembra(ctx.user.openId, input.membraId, prova(ctx)); return { ok: true as const }; }),

  mudarPapel: protectedProcedure
    .input(z.object({ membraId: z.string().uuid(), papel }))
    .mutation(async ({ ctx, input }) => { await mudarPapel(ctx.user.openId, input.membraId, input.papel, prova(ctx)); return { ok: true as const }; }),

  verConvite: protectedProcedure
    .input(z.object({ token: z.string().max(64) }))
    .query(({ ctx, input }) => verConviteDaEquipe(input.token, conta(ctx))),

  aceitarConvite: protectedProcedure
    .input(z.object({ token: z.string().max(64) }))
    .mutation(({ ctx, input }) => aceitarConviteDaEquipe(input.token, conta(ctx), prova(ctx))),

  responderConvite: protectedProcedure
    .input(z.object({ membraId: z.string().uuid(), aceitar: z.boolean() }))
    .mutation(({ ctx, input }) => responderConviteDaEquipe(conta(ctx), input.membraId, input.aceitar, prova(ctx))),

  sair: protectedProcedure
    .input(z.object({ pastaId }))
    .mutation(async ({ ctx, input }) => { await sairDaEquipe(conta(ctx), input.pastaId, prova(ctx)); return { ok: true as const }; }),

  tarefas: protectedProcedure.input(z.object({ pastaId })).query(({ ctx, input }) => listarTarefasDaEquipe(conta(ctx), input.pastaId)),

  criarTarefa: protectedProcedure
    .input(z.object({ pastaId, texto, responsavel: opcional(RESPONSAVEL_DA_TAREFA_MAX), prazo }))
    .mutation(({ ctx, input }) => criarTarefaDaEquipe(conta(ctx), input.pastaId, { texto: input.texto, responsavel: input.responsavel, prazo: input.prazo }, prova(ctx))),

  editarTarefa: protectedProcedure
    .input(z.object({ pastaId, tarefaId: z.string().uuid(), texto: texto.optional(), responsavel: opcional(RESPONSAVEL_DA_TAREFA_MAX), prazo }))
    .mutation(async ({ ctx, input }) => {
      await editarTarefaDaEquipe(conta(ctx), input.pastaId, input.tarefaId, { texto: input.texto, responsavel: input.responsavel, prazo: input.prazo }, prova(ctx));
      return { ok: true as const };
    }),

  marcarTarefa: protectedProcedure
    .input(z.object({ pastaId, tarefaId: z.string().uuid(), feita: z.boolean() }))
    .mutation(async ({ ctx, input }) => { await marcarTarefaDaEquipe(conta(ctx), input.pastaId, input.tarefaId, input.feita, prova(ctx)); return { ok: true as const }; }),

  apagarTarefa: protectedProcedure
    .input(z.object({ pastaId, tarefaId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => { await apagarTarefaDaEquipe(conta(ctx), input.pastaId, input.tarefaId, prova(ctx)); return { ok: true as const }; }),

  agenda: protectedProcedure.input(z.object({ pastaId })).query(({ ctx, input }) => agendaDaEquipe(conta(ctx), input.pastaId)),

  /** A dona põe uma reunião da agenda dela na equipe (pastaId) ou a tira (null). */
  porNaAgenda: protectedProcedure
    .input(z.object({ agendaId: z.string().uuid(), pastaId: pastaId.nullable() }))
    .mutation(async ({ ctx, input }) => { await porNaAgendaDaEquipe(conta(ctx), input.agendaId, input.pastaId, prova(ctx)); return { ok: true as const }; }),
});
