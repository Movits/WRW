import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  listContextTypes, listContexts, createContext, getContextById,
  updateContext, deleteContext, linkContactToContext, unlinkContactFromContext,
  addContextParticipant, listContextsByContact,
  contextIsVisible, addContextMedia, getContextMediaById, deleteContextMedia,
  listContextMediaByContext, getPrivateContactById,
} from "../db";
import { storagePut, storageDelete, chaveDoStorageDaDona, CACHE_DE_ARQUIVO_PRIVADO } from "../storage";
import {
  ALLOWED_CONTEXT_MEDIA_TYPES, decodeContextMedia,
  extensionForContextMedia, sanitizeMediaFileName,
} from "../context-media";

// ─── Extensão: Módulo de Contextos (Onde e Como Conheceu) ─────────────────────
export const contextsRouter = router({
  // Listar tipos de contexto (catálogo fixo)
  listTypes: protectedProcedure.query(async () => {
    return listContextTypes();
  }),

  // Listar contextos da usuária
  list: protectedProcedure
    .input(z.object({
      q:        z.string().optional(),
      typeSlug: z.string().optional(),
      year:     z.number().int().optional(),
      country:  z.string().optional(),
      page:     z.number().int().min(1).default(1),
      limit:    z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      return listContexts(ctx.user.openId, input);
    }),

  // Criar contexto personalizado
  create: protectedProcedure
    .input(z.object({
      name:          z.string().min(1).max(100),
      contextTypeId: z.string().optional().nullable(),
      eventDate:     z.string().optional().nullable(),
      city:          z.string().max(100).optional().nullable(),
      country:       z.string().max(100).optional().nullable(),
      notes:         z.string().optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const id = await createContext(ctx.user.openId, {
        name: input.name,
        contextTypeId: input.contextTypeId ?? null,
        eventDate: input.eventDate ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        notes: input.notes ?? null,
        visibility: "private",
      });
      return { id };
    }),

  // Detalhar contexto
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const ctx2 = await getContextById(ctx.user.openId, input.id);
      if (!ctx2) throw new Error("NOT_FOUND");
      return ctx2;
    }),

  // Atualizar contexto
  update: protectedProcedure
    .input(z.object({
      id:            z.string(),
      name:          z.string().min(1).max(100).optional(),
      contextTypeId: z.string().optional().nullable(),
      eventDate:     z.string().optional().nullable(),
      city:          z.string().max(100).optional().nullable(),
      country:       z.string().max(100).optional().nullable(),
      notes:         z.string().optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const ok = await updateContext(ctx.user.openId, id, data);
      if (!ok) throw new Error("NOT_FOUND");
      return { success: true };
    }),

  // Excluir contexto (os anexos saem junto — registros e, melhor esforço, os
  // objetos no bucket)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Só LEITURA antes de saber se o contexto é dela: a lista de anexos vem
      // primeiro porque o deleteContext apaga as linhas de context_media, e o
      // bucket só é tocado DEPOIS do banco confirmar a posse. Antes, um id do
      // catálogo esvaziava o bucket da dona e depois respondia NOT_FOUND.
      const anexos = await listContextMediaByContext(ctx.user.openId, input.id);
      const ok = await deleteContext(ctx.user.openId, input.id);
      if (!ok) throw new Error("NOT_FOUND");
      for (const anexo of anexos) {
        const chave = chaveDoStorageDaDona("contexts", ctx.user.openId, anexo.storagePath);
        if (!chave) continue;
        try {
          await storageDelete(chave);
        } catch (erro) {
          console.warn("[Contextos] objeto ficou no bucket:", erro instanceof Error ? erro.message : erro);
        }
      }
      return { success: true };
    }),

  // Vincular contato ao contexto
  linkContact: protectedProcedure
    .input(z.object({
      contextId:        z.string(),
      contactId:        z.number().int(),
      eventDate:        z.string().optional().nullable(),
      // Mesmo teto de create/update: as colunas são varchar(100).
      city:             z.string().max(100).optional().nullable(),
      country:          z.string().max(100).optional().nullable(),
      notes:            z.string().max(1000).optional().nullable(),
      // SEM .default(): o default aqui chegava preenchido em TODA chamada e
      // sobrescrevia o tipo que a dona já tinha escolhido no vínculo antigo.
      // Ausente quer dizer "não mexa no que já está lá"; quem escolhe o
      // "profissional" de um vínculo NOVO é o db.ts, na hora do insert.
      relationshipType: z.enum(["pessoal", "profissional", "ambos"]).optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Posse ANTES de gravar, nos dois lados do vínculo — a mesma regra do
      // uploadMedia. Sem isso, qualquer contextId (inclusive o de um contexto
      // privado de outra dona) e qualquer contactId entravam em contact_contexts,
      // e listByContact devolvia nome/tipo do contexto alheio pela linha
      // gravada. NOT_FOUND nos dois casos: não se revela se o id existe.
      if (!(await contextIsVisible(ctx.user.openId, input.contextId))) {
        throw new Error("NOT_FOUND");
      }
      if (!(await getPrivateContactById(ctx.user.openId, input.contactId))) {
        throw new Error("NOT_FOUND");
      }
      // Data, cidade, país e notas descem como vieram: null = a dona apagou o
      // campo ao editar o vínculo (o db.ts limpa); ausente = não mexa. Trocar
      // null por undefined aqui fazia "atualizado" sem apagar nada (revisão da
      // PR #122). O tipo continua virando undefined: a coluna é NOT NULL.
      const { id, created } = await linkContactToContext(ctx.user.openId, {
        contactId: input.contactId,
        contextId: input.contextId,
        eventDate: input.eventDate,
        city: input.city,
        country: input.country,
        notes: input.notes,
        relationshipType: input.relationshipType ?? undefined,
      });
      // `created` sobe até a tela: um vínculo que já existia foi ATUALIZADO, e
      // dizer "vinculada!" nesse caso é avisar de algo que não aconteceu.
      return { id, created };
    }),

  // Contextos em que um contato apareceu (exibido no perfil do contato)
  listByContact: protectedProcedure
    .input(z.object({ contactId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      return listContextsByContact(ctx.user.openId, input.contactId);
    }),

  // Desvincular contato do contexto
  unlinkContact: protectedProcedure
    .input(z.object({ linkId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await unlinkContactFromContext(ctx.user.openId, input.linkId);
      if (!ok) throw new Error("NOT_FOUND");
      return { success: true };
    }),

  // Anexar foto ou documento ao contexto — mesmo caminho da gravação de
  // reunião: base64 numa requisição, validação aqui, storage S3 com a dona na
  // chave (o storageProxy só serve contexts/{dona}/... para a própria dona).
  uploadMedia: protectedProcedure
    .input(z.object({
      contextId:  z.string(),
      fileName:   z.string().min(1).max(255),
      mimeType:   z.enum(ALLOWED_CONTEXT_MEDIA_TYPES),
      dataBase64: z.string().min(1),
      caption:    z.string().max(255).optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!(await contextIsVisible(ctx.user.openId, input.contextId))) {
        throw new Error("NOT_FOUND");
      }
      const dados = decodeContextMedia(input.dataBase64, input.mimeType);
      const nome = sanitizeMediaFileName(input.fileName);
      const extensao = extensionForContextMedia(input.mimeType);
      const uploaded = await storagePut(
        `contexts/${ctx.user.openId}/${input.contextId}/${nome}.${extensao}`,
        dados,
        input.mimeType,
        { cacheControl: CACHE_DE_ARQUIVO_PRIVADO },
      );
      const id = await addContextMedia(ctx.user.openId, {
        contextId: input.contextId,
        storagePath: uploaded.url,
        fileType: input.mimeType,
        fileSize: dados.length,
        originalName: input.fileName,
        caption: input.caption ?? null,
      });
      return { id, storagePath: uploaded.url };
    }),

  // Remover um anexo do contexto
  deleteMedia: protectedProcedure
    .input(z.object({ mediaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const midia = await getContextMediaById(ctx.user.openId, input.mediaId);
      if (!midia) throw new Error("NOT_FOUND");
      // O registro sai sempre; o objeto no bucket sai como melhor esforço — um
      // storage fora do ar não pode impedir a usuária de tirar a foto da tela.
      const chave = chaveDoStorageDaDona("contexts", ctx.user.openId, midia.storagePath);
      if (chave) {
        try {
          await storageDelete(chave);
        } catch (erro) {
          console.warn("[Contextos] objeto ficou no bucket:", erro instanceof Error ? erro.message : erro);
        }
      }
      const ok = await deleteContextMedia(ctx.user.openId, input.mediaId);
      if (!ok) throw new Error("NOT_FOUND");
      return { success: true };
    }),

  // Adicionar participante avulso
  addParticipant: protectedProcedure
    .input(z.object({
      contextId: z.string(),
      name:      z.string().min(1).max(200),
      company:   z.string().max(200).optional().nullable(),
      role:      z.string().max(200).optional().nullable(),
      notes:     z.string().max(500).optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Participante avulso só entra em contexto que a dona pode ver (dela ou
      // do catálogo) — mesma porta do uploadMedia e do linkContact.
      if (!(await contextIsVisible(ctx.user.openId, input.contextId))) {
        throw new Error("NOT_FOUND");
      }
      const id = await addContextParticipant(ctx.user.openId, {
        contextId: input.contextId,
        name: input.name,
        company: input.company ?? undefined,
        role: input.role ?? undefined,
        notes: input.notes ?? undefined,
      });
      return { id };
    }),
});
