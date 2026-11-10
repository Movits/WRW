import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createPrivateContact, exigirDb } from "../db";
import { meetingContactSuggestions, meetingEntities, meetings, privateContacts } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { createAuditLog } from "../security";
import { decidirPendenciasDaPessoaSugerida } from "../network-extracao";
import {
  ALLOWED_MEETING_AUDIO_TYPES,
  deletePrivateMeeting,
  getPrivateMeeting,
  iniciarReprocessamento,
  listPrivateMeetings,
  MAX_MEETING_DURATION_SECONDS,
  MEETING_TRANSCRIPT_LANGUAGES,
  processMeetingRecording,
  ReprocessamentoRecusado,
  ReuniaoForaDoEstado,
  ReuniaoTomadaPorOutraExecucao,
  translatePrivateMeetingTranscript,
} from "../meeting-service";
import { perguntarAReuniao, RecusaDaReuniaoComIA, resumirReuniao, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { criarTeto } from "../assistente-de-texto";

// Reprocessar custa IA (até 10 MB ao Gemini, mais a extração) e roda fora da
// requisição. A tomada no banco já impede dois reprocessamentos da MESMA
// reunião; este teto brando segura quem reprocessa uma reunião atrás da outra,
// ou a mesma que falha de novo, em laço. Em memória, como o do FAQ: basta à
// instância única do Render e zera a cada deploy. Só conta pedido aceito.
const REPROCESSOS_POR_JANELA = 3;
const JANELA_DE_REPROCESSO_MS = 10 * 60_000;
const reprocessosPorDona = new Map<string, number[]>();

/** Só para os testes: o teto é estado de módulo. */
export function esquecerTentativasDeReprocesso() {
  reprocessosPorDona.clear();
}

// Cada resumo e cada pergunta mandam até 24 mil caracteres da transcrição à
// IA, e cada chamada é paga. Teto brando por dona, resumo e perguntas somados,
// em memória como o do reprocesso. Conta todo pedido que passa da validação,
// até o recusado: a recusa não chama a IA, e assim também não serve de sonda.
export const PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA = 20;
export const tetoDaIADaReuniao = criarTeto(
  PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA,
  10 * 60_000,
  "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.",
);

/** Devolve a vaga de um pedido que não foi aceito. */
function devolverVagaDeReprocesso(openId: string, momento: number) {
  const vagas = reprocessosPorDona.get(openId);
  const posicao = vagas?.indexOf(momento) ?? -1;
  if (vagas && posicao >= 0) vagas.splice(posicao, 1);
}

export const MENSAGEM_REUNIAO_PROCESSANDO = "Esta reunião está sendo processada de novo. Espere terminar para decidir.";
export const MENSAGEM_SUGESTAO_JA_DECIDIDA = "Esta pessoa já foi decidida. Atualize a tela para ver como ficou.";

/**
 * Durante um reprocessamento, as sugestões e entidades da tentativa anterior
 * vão ser apagadas e substituídas: decidir sobre elas agora criaria um contato
 * a partir de uma sugestão que some, e a mesma pessoa voltaria como sugestão
 * nova para ser criada de novo.
 */
async function recusarSeReuniaoProcessando(db: Awaited<ReturnType<typeof exigirDb>>, ownerId: string, meetingId: string) {
  const [reuniao] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (reuniao?.status === "processing") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_REUNIAO_PROCESSANDO });
}

/** As recusas do resumo e da pergunta saem com o código que a tela traduz. */
async function comRecusaTraduzida<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaDaReuniaoComIA) throw new TRPCError({ code: erro.codigo, message: erro.message });
    throw erro;
  }
}

const createMeetingInput = z.object({
  title: z.string().trim().min(2).max(200),
  contactId: z.number().int().positive().optional().nullable(),
  contextId: z.string().uuid().optional().nullable(),
  language: z.string().min(2).max(12).default("pt"),
  consentGranted: z.literal(true),
});

export const meetingsRouter = router({
  list: protectedProcedure.query(({ ctx }) => listPrivateMeetings(ctx.user.openId)),

  get: protectedProcedure.input(z.object({ meetingId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const data = await getPrivateMeeting(ctx.user.openId, input.meetingId);
    if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return data;
  }),

  create: protectedProcedure.input(createMeetingInput).mutation(async ({ ctx, input }) => {
    const db = await exigirDb();
    const timestamp = Date.now();
    const id = crypto.randomUUID();
    await db.insert(meetings).values({
      id,
      ownerId: ctx.user.openId,
      title: input.title,
      contactId: input.contactId ?? null,
      contextId: input.contextId ?? null,
      status: "recording",
      consentGranted: true,
      consentAt: timestamp,
      language: input.language,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { id };
  }),

  submitRecording: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      audioBase64: z.string().min(20).max(14_000_000),
      mimeType: z.enum(ALLOWED_MEETING_AUDIO_TYPES),
      durationSeconds: z.number().positive().max(MAX_MEETING_DURATION_SECONDS),
      language: z.string().min(2).max(12).default("pt"),
    }))
    .mutation(async ({ ctx, input }) => {
      let result: Awaited<ReturnType<typeof processMeetingRecording>>;
      try {
        result = await processMeetingRecording({ ...input, ownerId: ctx.user.openId });
      } catch (erro) {
        if (erro instanceof ReuniaoForaDoEstado || erro instanceof ReuniaoTomadaPorOutraExecucao) {
          throw new TRPCError({ code: "CONFLICT", message: erro.message });
        }
        throw erro;
      }
      return { success: true, transcriptLength: result.transcript.length, entities: result.extraction.entities.length, contacts: result.extraction.contacts.length };
    }),

  // Reprocessa uma reunião com falha a partir do áudio que ficou guardado.
  // Devolve assim que a reunião é tomada ('processing'); o resultado aparece em
  // meetings.get e meetings.list. Recusas saem com o código que a tela traduz:
  // NOT_FOUND, CONFLICT (não está com falha, ou alguém chegou antes),
  // PRECONDITION_FAILED (sem áudio guardado utilizável) e TOO_MANY_REQUESTS.
  reprocess: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // A vaga é reservada ANTES do await. Conferir antes e registrar depois
      // deixava uma rajada simultânea (um lote tRPC, várias abas) ler o mapa
      // sem nenhuma vaga ocupada e passar inteira. Pedido não aceito devolve a vaga.
      const agora = Date.now();
      const recentes = (reprocessosPorDona.get(ctx.user.openId) ?? []).filter(momento => agora - momento < JANELA_DE_REPROCESSO_MS);
      if (recentes.length >= REPROCESSOS_POR_JANELA) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas tentativas de reprocessar em sequência. Aguarde alguns minutos e tente de novo." });
      }
      if (reprocessosPorDona.size > 5000) reprocessosPorDona.clear();
      recentes.push(agora);
      reprocessosPorDona.set(ctx.user.openId, recentes);
      let trabalho: Promise<void>;
      try {
        ({ trabalho } = await iniciarReprocessamento(ctx.user.openId, input.meetingId));
      } catch (erro) {
        devolverVagaDeReprocesso(ctx.user.openId, agora);
        if (erro instanceof ReprocessamentoRecusado) throw new TRPCError({ code: erro.codigo, message: erro.message });
        throw erro;
      }
      // `trabalho` nunca rejeita: iniciarReprocessamento termina todo erro em log.
      void trabalho;
      await createAuditLog({
        userId: ctx.user.id, action: "MEETING_REPROCESS_REQUESTED", resource: "meetings", resourceId: input.meetingId,
        status: "success", riskLevel: "low",
      });
      return { status: "processing" as const };
    }),

  translateTranscript: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), language: z.enum(["pt-BR", "en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"]) }))
    .mutation(async ({ ctx, input }) => {
      return translatePrivateMeetingTranscript(ctx.user.openId, input.meetingId, input.language);
    }),

  // Resumo da reunião pela IA (tópicos, decisões e tarefas, cada um com o trecho
  // que o sustenta) e perguntas sobre ela. Só a dona, só reunião pronta com
  // transcrição. Nada é gravado: a resposta vai só para a tela, para conferir.
  // Os dois dividem o teto de pedidos à IA (TOO_MANY_REQUESTS).
  resumir: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES) }))
    .mutation(async ({ ctx, input }) => {
      tetoDaIADaReuniao.reservar(ctx.user.openId);
      return comRecusaTraduzida(() => resumirReuniao(ctx.user.openId, input.meetingId, input.idioma));
    }),

  perguntar: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(async ({ ctx, input }) => {
      tetoDaIADaReuniao.reservar(ctx.user.openId);
      return comRecusaTraduzida(() => perguntarAReuniao(ctx.user.openId, input.meetingId, input.pergunta, input.idioma));
    }),

  decideEntity: protectedProcedure
    .input(z.object({ entityId: z.string().uuid(), status: z.enum(["confirmed", "ignored"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [entidade] = await db.select({ meetingId: meetingEntities.meetingId }).from(meetingEntities)
        .where(and(eq(meetingEntities.id, input.entityId), eq(meetingEntities.ownerId, ctx.user.openId))).limit(1);
      if (!entidade) throw new TRPCError({ code: "NOT_FOUND", message: "Entidade não encontrada." });
      await recusarSeReuniaoProcessando(db, ctx.user.openId, entidade.meetingId);
      const result = await db.update(meetingEntities)
        .set({ status: input.status, updatedAt: Date.now() })
        .where(and(eq(meetingEntities.id, input.entityId), eq(meetingEntities.ownerId, ctx.user.openId)));
      if (!(result as any)[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Entidade não encontrada." });
      return { success: true };
    }),

  decideContactSuggestion: protectedProcedure
    .input(z.object({
      suggestionId: z.string().uuid(),
      action: z.enum(["create", "link", "ignore"]),
      contactId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const daDona = and(eq(meetingContactSuggestions.id, input.suggestionId), eq(meetingContactSuggestions.ownerId, ctx.user.openId));
      const [suggestion] = await db.select().from(meetingContactSuggestions).where(daDona).limit(1);
      if (!suggestion) throw new TRPCError({ code: "NOT_FOUND", message: "Sugestão não encontrada." });
      if (suggestion.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_SUGESTAO_JA_DECIDIDA });
      await recusarSeReuniaoProcessando(db, ctx.user.openId, suggestion.meetingId);

      const status = input.action === "create" ? "created" as const : input.action === "link" ? "linked" as const : "ignored" as const;
      let linkedContactId: number | null = null;
      if (input.action === "link") {
        if (!input.contactId) throw new TRPCError({ code: "BAD_REQUEST", message: "Selecione um contato para vincular." });
        // Vincular só a contato DA dona: sem isto, um id de outra rede virava o
        // ponteiro da sugestão (e das pendências do Meu Network Inteligente).
        const [alvo] = await db.select({ id: privateContacts.id }).from(privateContacts)
          .where(and(eq(privateContacts.id, input.contactId), eq(privateContacts.ownerId, ctx.user.openId))).limit(1);
        if (!alvo) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado." });
        linkedContactId = input.contactId;
      }
      // Tomada: só UMA decisão tira a sugestão de 'pending', e antes de criar
      // contato ou mexer nas pendências. Sem o status no WHERE, o duplo clique
      // (ou a aba velha) criava um segundo contato e levava as pendências da IA
      // para ele, e um 'ignorar' tardio ignorava as do contato já criado.
      const [tomada] = await db.update(meetingContactSuggestions)
        .set({ status, existingContactId: linkedContactId, updatedAt: Date.now() })
        .where(and(daDona, eq(meetingContactSuggestions.status, "pending")));
      if (!(tomada as { affectedRows?: number } | undefined)?.affectedRows) {
        throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_SUGESTAO_JA_DECIDIDA });
      }
      if (input.action === "create") {
        try {
          linkedContactId = await createPrivateContact(ctx.user.openId, {
            fullName: suggestion.fullName,
            jobTitle: suggestion.jobTitle,
            company: suggestion.company,
            phone: suggestion.phone,
            email: suggestion.email,
          });
        } catch (erro) {
          // O contato não nasceu: a sugestão volta a pendente para a dona tentar de novo.
          await db.update(meetingContactSuggestions).set({ status: "pending", updatedAt: Date.now() })
            .where(and(daDona, eq(meetingContactSuggestions.status, "created"), isNull(meetingContactSuggestions.existingContactId)))
            .catch(erroAoDevolver => console.error("[meetings.decideContactSuggestion] a sugestão não voltou a pendente:", erroAoDevolver));
          throw erro;
        }
        await db.update(meetingContactSuggestions).set({ existingContactId: linkedContactId, updatedAt: Date.now() }).where(daDona);
      }
      // Meu Network Inteligente: O QUE TENHO / O QUE PRECISO que a IA tirou da
      // reunião para esta pessoa passam a apontar para o contato, AINDA
      // pendentes — criar o contato confirma o Quem Sou que a tela mostrou, não
      // o resto. Ignorar a pessoa ignora tudo que veio dela.
      await decidirPendenciasDaPessoaSugerida(db, {
        ownerId: ctx.user.openId,
        meetingSuggestionId: suggestion.id,
        meetingId: suggestion.meetingId,
        acao: input.action,
        contactId: linkedContactId,
        quemSouDaSugestao: { fullName: suggestion.fullName, phone: suggestion.phone, email: suggestion.email },
      });
      return { success: true, contactId: linkedContactId };
    }),

  delete: protectedProcedure.input(z.object({ meetingId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await deletePrivateMeeting(ctx.user.openId, input.meetingId);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return { success: true };
  }),
});
