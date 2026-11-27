import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { protectedProcedure, router } from "../_core/trpc";
import { exigirDb } from "../db";
import { ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { exigirTextoSemContato } from "../bloqueio-de-contato";
import { createNotification } from "../db";
import { storagePut } from "../storage";
import { decodeDocumentoBase64, MAX_DOCUMENTO_BASE64_CHARS } from "../documento-base64";
import { getRequestIp } from "../password-reset-security";

import {
  dealClosures,
  dealRooms,
  dealRoomMessages,
  dealRoomDocuments,
  ndaAcceptances,
  opportunities,
  users,
} from "../../drizzle/schema";
import { eq, and, desc, sql } from "drizzle-orm";

/**
 * A sala com negócio registrado fica fechada. Conserta a sala que ficou aberta
 * com o registro já gravado (a corrida com a outra parte, ou linha de antes da
 * transação), sem mexer na que já está fechada.
 */
async function garantirSalaFechada(
  db: Awaited<ReturnType<typeof exigirDb>>,
  room: { id: number; status: string },
) {
  if (room.status === "closed") return;
  await db.update(dealRooms).set({ status: "closed" }).where(eq(dealRooms.id, room.id));
}

// Helper: verifica se o usuário é Ouro ou superior
const isGoldOrAbove = (role?: string | null) =>
  role === "gold" || role === "president" || role === "admin";

export const dealRoomRouter = router({

  // Demonstrar interesse e abrir Deal Room
  openRoom: protectedProcedure
    .input(z.object({
      opportunityId: z.number().int(),
      message: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // A13: a mensagem de apresentação chega à dona ANTES do NDA — é o canal
      // gêmeo do expressInterest e passa pela mesma porta.
      await exigirTextoSemContato(ctx.user.id, "deal_room.openRoom", input.message, input.opportunityId);
      const db = await exigirDb();

      const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1);
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade não encontrada" });
      if (opp.publishedBy === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Você não pode demonstrar interesse na sua própria oportunidade" });

      const [existing] = await db.select().from(dealRooms)
        .where(and(
          eq(dealRooms.opportunityId, input.opportunityId),
          eq(dealRooms.interestedId, ctx.user.id)
        )).limit(1);

      if (existing) return { roomId: existing.id, isNew: false };

      const result = await db.insert(dealRooms).values({
        opportunityId: input.opportunityId,
        ownerId: opp.publishedBy,
        interestedId: ctx.user.id,
        status: "awaiting_nda",
        ndaAcceptedByOwner: false,
        ndaAcceptedByInterested: false,
        interestMessage: input.message || null,
      });

      const roomId = Number((result as any)[0].insertId);

      await createNotification({
        userId: opp.publishedBy,
        type: "interest_received",
        title: "💼 Nova solicitação de Deal Room",
        body: `Um membro demonstrou interesse em "${opp.title}" e aguarda seu aceite do NDA para abrir a sala de negociação.`,
        actionUrl: `/deal-room/${roomId}`,
        isRead: false,
      });

      return { roomId, isNew: true };
    }),

  // Aceitar o NDA digitalmente
  acceptNDA: protectedProcedure
    .input(z.object({
      roomId: z.number().int(),
      // Trilha de auditoria (etapa 13): o texto do NDA vem do i18n do cliente
      // e varia por idioma, então o cliente manda o que exibiu. Opcionais para
      // não quebrar chamadas antigas; IP e user-agent saem sempre do servidor.
      locale: z.string().max(10).optional(),
      textoExibido: z.string().max(20_000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
      if (room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });

      const isOwner = room.ownerId === ctx.user.id;
      const now = new Date();

      // A prova antes do estado: se o INSERT falhar, o aceite não acontece —
      // um aceite sem trilha é exatamente o que a etapa 13 quer eliminar.
      await db.insert(ndaAcceptances).values({
        dealRoomId: input.roomId,
        userId: ctx.user.id,
        papel: isOwner ? "owner" : "interested",
        // getRequestIp corta em 64, mas a coluna é varchar(45) (o máximo de um
        // IPv6) — o corte extra evita erro de inserção em modo estrito.
        ipAddress: getRequestIp(ctx.req.headers["x-forwarded-for"], ctx.req.socket?.remoteAddress).slice(0, 45),
        userAgent: ctx.req.headers["user-agent"] ?? null,
        locale: input.locale ?? null,
        textoExibido: input.textoExibido ?? null,
        textoHash: input.textoExibido
          ? createHash("sha256").update(input.textoExibido).digest("hex")
          : null,
      });

      if (isOwner) {
        await db.update(dealRooms)
          .set({ ndaAcceptedByOwner: true, ndaAcceptedByOwnerAt: now })
          .where(eq(dealRooms.id, input.roomId));
      } else {
        await db.update(dealRooms)
          .set({ ndaAcceptedByInterested: true, ndaAcceptedByInterestedAt: now })
          .where(eq(dealRooms.id, input.roomId));
      }

      const [updated] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (updated.ndaAcceptedByOwner && updated.ndaAcceptedByInterested) {
        await db.update(dealRooms).set({ status: "active" }).where(eq(dealRooms.id, input.roomId));

        // Mensagem de boas-vindas do sistema (senderId = 0)
        const welcomeMsg = [
          "🎉 **Boas-vindas à Deal Room!**",
          "",
          "Ambas as partes assinaram o NDA (Acordo de Confidencialidade). Esta sala de negociação privada está agora ativa.",
          "",
          "**📋 Regras de conduta desta sala:**",
          "• Mantenha todas as informações compartilhadas em estrita confidencialidade.",
          "• Seja objetivo e respeitoso em todas as comunicações.",
          "• Não compartilhe dados sensíveis fora desta plataforma.",
          "• Documentos enviados aqui são protegidos pelo NDA assinado.",
          "• Em caso de descumprimento, a sala poderá ser encerrada.",
          "",
          "**🔐 Lembrete NDA:** Ao assinar este acordo, ambas as partes se comprometeram a não divulgar, reproduzir ou usar as informações trocadas nesta sala para fins que não sejam a negociação em curso.",
          "",
          "Boa negociação! 🤝",
        ].join("\n");
        await db.insert(dealRoomMessages).values({
          dealRoomId: input.roomId,
          senderId: 0,
          content: welcomeMsg,
          isRead: false,
        });

        const otherUserId = isOwner ? room.interestedId : room.ownerId;
        await createNotification({
          userId: otherUserId,
          type: "new_message",
          title: "🔐 Deal Room ativado!",
          body: "Ambas as partes assinaram o NDA. A sala de negociação privada está aberta.",
          actionUrl: `/deal-room/${input.roomId}`,
          isRead: false,
        });
        await createNotification({
          userId: ctx.user.id,
          type: "new_message",
          title: "🔐 Deal Room ativado!",
          body: "Ambas as partes assinaram o NDA. A sala de negociação privada está aberta.",
          actionUrl: `/deal-room/${input.roomId}`,
          isRead: false,
        });
      } else {
        const otherUserId = isOwner ? room.interestedId : room.ownerId;
        await createNotification({
          userId: otherUserId,
          type: "new_message",
          title: "📝 NDA assinado — aguardando você",
          body: "A outra parte já assinou o Termo de Confidencialidade. Acesse o Deal Room para assinar também.",
          actionUrl: `/deal-room/${input.roomId}`,
          isRead: false,
        });
      }

      return { success: true };
    }),

  // Buscar dados da sala
  getRoom: protectedProcedure
    .input(z.object({ roomId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
            // Ouro pode acessar qualquer sala
      if (!isGoldOrAbove(ctx.user.role) && room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });
      // A13/D3 (Glenda, 31/08): os contatos das partes aparecem somente para
      // o consultor de negócios, JAMAIS entre as partes. O e-mail saía aqui no
      // payload para a contraparte (a tela só mostrava o nome, mas o dado
      // chegava ao navegador) — a coluna nem é mais selecionada.
      const [owner] = await db.select({ id: users.id, name: users.name })
        .from(users).where(eq(users.id, room.ownerId)).limit(1);
      const [interested] = await db.select({ id: users.id, name: users.name })
        .from(users).where(eq(users.id, room.interestedId)).limit(1);
      const [opp] = await db.select({ id: opportunities.id, title: opportunities.title, type: opportunities.type })
        .from(opportunities).where(eq(opportunities.id, room.opportunityId)).limit(1);

      return { ...room, owner, interested, opportunity: opp };
    }),

  // Listar Deal Rooms da usuária logada
  listRooms: protectedProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();

    const rooms = await db.select().from(dealRooms)
      .where(sql`(${dealRooms.ownerId} = ${ctx.user.id} OR ${dealRooms.interestedId} = ${ctx.user.id})`)
      .orderBy(desc(dealRooms.updatedAt))
      .limit(50);

    const enriched = await Promise.all(rooms.map(async (room) => {
      const [opp] = await db.select({ id: opportunities.id, title: opportunities.title })
        .from(opportunities).where(eq(opportunities.id, room.opportunityId)).limit(1);
      const [other] = await db.select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, room.ownerId === ctx.user.id ? room.interestedId : room.ownerId))
        .limit(1);
      return { ...room, opportunityTitle: opp?.title || "Oportunidade", otherPartyName: other?.name || "Membro" };
    }));

    return enriched;
  }),

  // Enviar mensagem no chat
  sendMessage: protectedProcedure
    .input(z.object({
      roomId: z.number().int(),
      content: z.string().min(1).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
      // Ouro pode acessar qualquer sala
      if (!isGoldOrAbove(ctx.user.role) && room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });
      if (room.status !== "active")
        throw new TRPCError({ code: "BAD_REQUEST", message: "O NDA precisa ser assinado por ambas as partes antes de enviar mensagens." });

      // A13: e-mail/telefone não circulam entre as partes — recusa e registra.
      await exigirTextoSemContato(ctx.user.id, "deal_room.sendMessage", input.content, input.roomId);

      await db.insert(dealRoomMessages).values({
        dealRoomId: input.roomId,
        senderId: ctx.user.id,
        content: input.content,
      });

      const recipientId = room.ownerId === ctx.user.id ? room.interestedId : room.ownerId;
      await createNotification({
        userId: recipientId,
        type: "new_message",
        title: "💬 Nova mensagem no Deal Room",
        body: input.content.substring(0, 100) + (input.content.length > 100 ? "..." : ""),
        actionUrl: `/deal-room/${input.roomId}`,
        isRead: false,
      });

      return { success: true };
    }),

  // Listar mensagens do chat
  getMessages: protectedProcedure
    .input(z.object({ roomId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
            // Ouro pode acessar qualquer sala
      if (!isGoldOrAbove(ctx.user.role) && room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });
      return db.select({
        id: dealRoomMessages.id,
        senderId: dealRoomMessages.senderId,
        content: dealRoomMessages.content,
        isRead: dealRoomMessages.isRead,
        createdAt: dealRoomMessages.createdAt,
      }).from(dealRoomMessages)
        .where(eq(dealRoomMessages.dealRoomId, input.roomId))
        .orderBy(dealRoomMessages.createdAt)
        .limit(200);
    }),

  // Upload de documento confidencial
  uploadDocument: protectedProcedure
    .input(z.object({
      roomId: z.number().int(),
      name: z.string().max(300),
      // Cabo do schema; a mensagem amigável de 10 MB sai de decodeDocumentoBase64.
      fileBase64: z.string().min(1).max(MAX_DOCUMENTO_BASE64_CHARS),
      mimeType: z.string().max(100),
      sizeBytes: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
      if (room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });
      if (room.status !== "active")
        throw new TRPCError({ code: "BAD_REQUEST", message: "O NDA precisa ser assinado antes de compartilhar documentos." });

      // A13: o NOME do documento também é texto livre que a contraparte lê
      // ("planilha - liga 11 99999 8888.xlsx"). O conteúdo do arquivo não é
      // varrido (fora do alcance); o nome, sim.
      await exigirTextoSemContato(ctx.user.id, "deal_room.uploadDocument", input.name, input.roomId);

      // 10 MB por documento, validado antes de tocar o storage (documento-base64.ts).
      const buffer = decodeDocumentoBase64(input.fileBase64);
      const fileKey = `deal-rooms/${input.roomId}/${Date.now()}-${input.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { url } = await storagePut(fileKey, buffer, input.mimeType);

      await db.insert(dealRoomDocuments).values({
        dealRoomId: input.roomId,
        uploadedBy: ctx.user.id,
        name: input.name,
        fileKey,
        url,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes || buffer.length,
      });

      return { success: true, url };
    }),

    // Listar documentos da sala
  listDocuments: protectedProcedure
    .input(z.object({ roomId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
      // Ouro pode acessar qualquer sala
      if (!isGoldOrAbove(ctx.user.role) && room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id)
        throw new TRPCError({ code: "FORBIDDEN" });
      return db.select().from(dealRoomDocuments)
        .where(eq(dealRoomDocuments.dealRoomId, input.roomId))
        .orderBy(desc(dealRoomDocuments.createdAt))
        .limit(100);
    }),

  // Listar TODAS as Deal Rooms — acesso exclusivo para Ouro
  listAllRooms: protectedProcedure.query(async ({ ctx }) => {
    if (!isGoldOrAbove(ctx.user.role))
      throw new TRPCError({ code: "FORBIDDEN", message: "Acesso exclusivo para membros Ouro" });
    const db = await exigirDb();
    const rooms = await db.select().from(dealRooms)
      .orderBy(desc(dealRooms.updatedAt))
      .limit(200);
    const enriched = await Promise.all(rooms.map(async (room) => {
      const [opp] = await db.select({ id: opportunities.id, title: opportunities.title })
        .from(opportunities).where(eq(opportunities.id, room.opportunityId)).limit(1);
      const [owner] = await db.select({ id: users.id, name: users.name })
        .from(users).where(eq(users.id, room.ownerId)).limit(1);
      const [interested] = await db.select({ id: users.id, name: users.name })
        .from(users).where(eq(users.id, room.interestedId)).limit(1);
      return {
        ...room,
        opportunityTitle: opp?.title || "Oportunidade",
        ownerName: owner?.name || "Membro",
        interestedName: interested?.name || "Membro",
      };
    }));
    return enriched;
  }),
  /**
   * A11 / etapa 12 — encerrar a negociação registrando o negócio e a comissão.
   *
   * A decisão D2 da cliente é que o dinheiro NÃO passa pela plataforma nesta
   * versão. Então o que o site faz é registrar: valor do negócio, honorários da
   * intermediação, percentual combinado e a comissão que isso dá. Sem esse
   * registro, cobrar depois é palavra contra palavra — e era isso que faltava
   * para a A11 deixar de ser meio cartão.
   *
   * Isto não mexe no registro das conexões (conexoes_registradas): lá a
   * comissão é só status, e as duas trilhas ainda não se ligam.
   *
   * O TETO DE 50% INCIDE SOBRE OS HONORÁRIOS DA INTERMEDIAÇÃO.
   *
   * A primeira versão deste procedimento calculava a comissão sobre o LUCRO
   * declarado, lendo assim a decisão D1 de 31/08. Em 12/09/2026 a pergunta foi
   * feita direto — "o teto de 50% incide sobre o lucro ou sobre o valor do
   * negócio?" — e a Dra. Glenda respondeu: "Incide sobre o valor dos honorários
   * da intermediação do negócio". Não é nenhum dos dois que a pergunta ofereceu:
   * é o que a plataforma cobra para intermediar.
   *
   * O percentual em si é caso a caso e, pela mesma resposta, quem o define é a
   * Diretoria Comercial, "por critérios que serão definidos em outra ocasião".
   * Ou seja: o servidor NÃO tem como calcular o percentual, só recusar acima do
   * teto. Quando os critérios existirem, é aqui que eles entram.
   *
   * Quem declara, pela mesma resposta, é o CONSULTOR DE NEGÓCIOS — papel que
   * ainda não existe no sistema (etapa 12). Enquanto não existir, quem registra
   * é uma das partes, e `closedByUserId` guarda quem foi.
   *
   * Encerrar é evento único: `deal_closure_room_unique` garante uma linha por
   * sala, e encerrar de novo devolve o registro que já existe em vez de criar
   * outro (mesmo tratamento de corrida do consent.accept).
   */
  closeRoom: protectedProcedure
    .input(z.object({
      roomId: z.number().int(),
      currency: z.enum(["BRL", "USD", "EUR"]).default("BRL"),
      dealValue: z.number().positive().max(99_999_999_999.99),
      intermediationFee: z.number().nonnegative().max(99_999_999_999.99),
      commissionPercent: z.number().min(0).max(50),
      notes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();

      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "Sala não encontrada." });
      // Quem encerra é quem negociou. Ouro entra em sala alheia para acompanhar,
      // mas registrar negócio dos outros não é leitura: é ato de parte.
      if (room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só quem participa da negociação pode encerrá-la." });
      }
      if (room.status === "awaiting_nda") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A sala ainda aguarda o aceite do acordo pelas duas partes." });
      }
      // Os honorários não podem ser maiores que o próprio negócio: é erro de
      // digitação comum, e inflaria a comissão devida.
      if (input.intermediationFee > input.dealValue) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Os honorários da intermediação não podem ser maiores que o valor do negócio." });
      }

      const [jaFechado] = await db.select().from(dealClosures).where(eq(dealClosures.roomId, input.roomId)).limit(1);
      if (jaFechado) {
        await garantirSalaFechada(db, room);
        return { success: true, closure: jaFechado, jaEstavaFechado: true };
      }

      // Duas casas, arredondadas uma vez só: o valor gravado é o que a fatura vai
      // cobrar, então não pode depender de quem recalcula depois.
      const comissao = Math.round(input.intermediationFee * input.commissionPercent) / 100;

      // O registro e a sala fechada andam juntos: numa transação, para não sobrar
      // negócio registrado com a sala ainda aberta (ou o contrário).
      try {
        await db.transaction(async tx => {
          await tx.insert(dealClosures).values({
            roomId: input.roomId,
            opportunityId: room.opportunityId,
            closedByUserId: ctx.user.id,
            currency: input.currency,
            dealValue: input.dealValue.toFixed(2),
            intermediationFee: input.intermediationFee.toFixed(2),
            commissionPercent: input.commissionPercent.toFixed(2),
            commissionAmount: comissao.toFixed(2),
            notes: input.notes ?? null,
          });
          await tx.update(dealRooms).set({ status: "closed" }).where(eq(dealRooms.id, input.roomId));
        });
      } catch (erro) {
        // Banco fora do ar é erro, nunca "já estava fechado".
        if (ehErroDeBancoIndisponivel(erro)) throw erro;
        // Corrida perdida: a outra parte encerrou no mesmo instante e o índice
        // único recusou esta linha. O resultado que esta chamada pediu já aconteceu.
        const [agora] = await db.select().from(dealClosures).where(eq(dealClosures.roomId, input.roomId)).limit(1);
        if (!agora) throw erro;
        await garantirSalaFechada(db, room);
        return { success: true, closure: agora, jaEstavaFechado: true };
      }

      // A outra parte precisa saber que o negócio foi registrado, e com que
      // números — é ela quem vai conferir se bate com o que combinaram. O negócio
      // já está gravado: falhar o aviso não pode virar erro para quem encerrou.
      const outraParte = room.ownerId === ctx.user.id ? room.interestedId : room.ownerId;
      try {
        await createNotification({
          userId: outraParte,
          type: "deal_closed",
          title: "Negociação encerrada e registrada",
          body: `Valor ${input.currency} ${input.dealValue.toFixed(2)}, honorários da intermediação ${input.intermediationFee.toFixed(2)}, comissão de ${input.commissionPercent.toFixed(2)}% sobre eles = ${input.currency} ${comissao.toFixed(2)}.`,
          actionUrl: `/deal-room/${input.roomId}`,
        });
      } catch (erro) {
        // Só a sala e o tipo do erro no log: nem valores nem quem são as partes.
        const codigo = (erro as { code?: unknown })?.code;
        console.error(
          `[DealRoom] o aviso do encerramento da sala ${input.roomId} não foi gravado; o negócio está registrado.`,
          erro instanceof Error ? erro.name : typeof erro,
          typeof codigo === "string" ? codigo : "",
        );
      }

      const [closure] = await db.select().from(dealClosures).where(eq(dealClosures.roomId, input.roomId)).limit(1);
      return { success: true, closure, jaEstavaFechado: false };
    }),

  /** O registro do negócio desta sala, se já houver. */
  getClosure: protectedProcedure
    .input(z.object({ roomId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [room] = await db.select().from(dealRooms).where(eq(dealRooms.id, input.roomId)).limit(1);
      if (!room) throw new TRPCError({ code: "NOT_FOUND" });
      if (!isGoldOrAbove(ctx.user.role) && room.ownerId !== ctx.user.id && room.interestedId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const [closure] = await db.select().from(dealClosures).where(eq(dealClosures.roomId, input.roomId)).limit(1);
      return closure ?? null;
    }),
});
