import { TRPCError } from "@trpc/server";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  exigirDb,
  createPrivateContact, listPrivateContacts, getPrivateContactById,
  updatePrivateContact, deletePrivateContact, imagemUsadaPorOutroContato,
} from "../db";
import { recalculatePrivateMatches } from "../match-service";
import { hasValidConsent } from "./consent";
import { goldProcedure } from "./_procedures";
import { storagePut, storageDelete, chaveDoStorageDaDona, CACHE_DE_ARQUIVO_PRIVADO } from "../storage";
import {
  ALLOWED_CONTACT_IMAGE_TYPES, decodeContactImage, extensionForContactImage,
} from "../contact-media";
import { aiMatchSuggestions, contactAssets, contactNeeds } from "../../drizzle/schema";

// Caminho do proxy (/manus-storage/contacts/{openId}/...), não uma URL http
// completa — por isso os dois campos abaixo usam `.max(512)` simples, não
// `.url()`. Compartilhado entre create/update/upload para não desalinhar.
const chaveDaImagem = z.string().max(512).optional().nullable();

// Foto e cartão saem do bucket como melhor esforço — um storage fora do ar
// não pode impedir a usuária de apagar ou trocar a imagem na tela.
//
// `contatoId` é o contato que está soltando a imagem: se OUTRO contato da
// mesma dona ainda aponta para a mesma chave (duplicata nascida com a mesma
// foto), o objeto fica — apagá-lo quebraria a foto do contato que sobrou.
async function apagarImagemDoBucket(openId: string, storagePath: string | null | undefined, contatoId: number) {
  if (!storagePath) return;
  const chave = chaveDoStorageDaDona("contacts", openId, storagePath);
  if (!chave) return;
  try {
    if (await imagemUsadaPorOutroContato(openId, storagePath, contatoId)) {
      console.info("[Rede] imagem mantida no bucket: outro contato da dona ainda a usa:", chave);
      return;
    }
    await storageDelete(chave);
  } catch (erro) {
    console.warn("[Rede] objeto ficou no bucket:", erro instanceof Error ? erro.message : erro);
  }
}

// O cruzamento roda sozinho também quando um dado sai (padrão de `delete`):
// remover um "possui" muda o mapa, e as sugestões precisam refletir isso.
// Melhor esforço, e SEM e-mail — remoção não é notícia de oportunidade nova.
//
// Com o termo da etapa 11 vigente, o recálculo refaz o mapa inteiro. SEM o
// termo o recálculo não roda, e a sugestão cuja razão acabou de sair ficaria
// viva em ai_match_suggestions até o próximo — um fantasma que a usuária não
// vê nem consegue apagar. Molde de apagarRastroDoContato (db.ts): toda
// sugestão da dona cujo par inclua este contato sai; quando ela aceitar o
// termo, o recálculo recria o que ainda valer.
async function recalcularAposRemocao(
  db: Awaited<ReturnType<typeof exigirDb>>,
  user: { id: number; openId: string },
  contactId: number,
) {
  try {
    if (await hasValidConsent(user.id, "termo_smart_match")) {
      await recalculatePrivateMatches(user.openId);
      return;
    }
    await db.delete(aiMatchSuggestions).where(and(
      eq(aiMatchSuggestions.ownerId, user.openId),
      or(
        eq(aiMatchSuggestions.pairLowContactId, contactId),
        eq(aiMatchSuggestions.pairHighContactId, contactId),
      ),
    ));
  } catch (erro) {
    console.warn("[Rede] recálculo adiado após remoção:", erro instanceof Error ? erro.message : erro);
  }
}

// Apaga um item de possui/procura da agenda da dona. O owner_id vai no WHERE
// (privacidade é regra de consulta): id de outra dona apaga zero linhas e sai
// como NOT_FOUND, sem revelar se existe. O contato do item é lido ANTES do
// DELETE (também com o owner_id): depois de apagado não há mais como saber a
// quais sugestões de match a razão pertencia.
async function removerItemDaAgenda(
  tabela: typeof contactAssets | typeof contactNeeds,
  user: { id: number; openId: string },
  id: number,
) {
  const db = await exigirDb();
  const [item] = await db
    .select({ contactId: tabela.contactId })
    .from(tabela)
    .where(and(eq(tabela.id, id), eq(tabela.ownerId, user.openId)))
    .limit(1);
  if (!item) throw new TRPCError({ code: "NOT_FOUND" });
  const [resultado] = await db
    .delete(tabela)
    .where(and(eq(tabela.id, id), eq(tabela.ownerId, user.openId)));
  if (!((resultado as { affectedRows?: number }).affectedRows! > 0)) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  await recalcularAposRemocao(db, user, item.contactId);
  return { success: true };
}

// ─── Minha Rede de Relacionamentos (Base Particular de Contatos) ──────────────
export const networkRouter = router({
  create: protectedProcedure
    .input(z.object({
      fullName:    z.string().min(1).max(200),
      photoUrl:    chaveDaImagem,
      cardImageUrl: chaveDaImagem,
      jobTitle:    z.string().max(200).optional().nullable(),
      company:     z.string().max(200).optional().nullable(),
      country:     z.string().max(100).optional().nullable(),
      state:       z.string().max(100).optional().nullable(),
      city:        z.string().max(100).optional().nullable(),
      phone:       z.string().max(50).optional().nullable(),
      whatsapp:    z.string().max(50).optional().nullable(),
      email:       z.string().email().optional().nullable(),
      linkedinUrl: z.string().url().optional().nullable(),
      instagram:   z.string().max(100).optional().nullable(),
      profileTags: z.array(z.string()).optional().nullable(),
      notes:       z.string().max(5000).optional().nullable(),
      // Etapa 8: o nível é escolha da dona; omitido, a coluna nasce 'privado'.
      nivelVisibilidade: z.enum(["privado", "ouro", "publico"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const id = await createPrivateContact(ctx.user.openId, input);
      return { id };
    }),

  // Foto do contato e cartão de visita (etapa 1, critérios 4 e 5) — mesmo
  // caminho da mídia de contexto: base64 numa requisição, validação aqui,
  // storage S3 com a dona na chave (o storageProxy só serve
  // contacts/{dona}/... para a própria dona). Sem contactId: o upload
  // acontece ANTES de o contato existir (a tela de criação já tem os campos
  // de imagem), a URL fica no formulário até "Salvar" gravar de fato.
  uploadPhoto: protectedProcedure
    .input(z.object({
      fileName:   z.string().min(1).max(255),
      mimeType:   z.enum(ALLOWED_CONTACT_IMAGE_TYPES),
      dataBase64: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const dados = decodeContactImage(input.dataBase64, input.mimeType);
      const extensao = extensionForContactImage(input.mimeType);
      const uploaded = await storagePut(`contacts/${ctx.user.openId}/foto.${extensao}`, dados, input.mimeType,
        { cacheControl: CACHE_DE_ARQUIVO_PRIVADO });
      return { url: uploaded.url };
    }),

  uploadCard: protectedProcedure
    .input(z.object({
      fileName:   z.string().min(1).max(255),
      mimeType:   z.enum(ALLOWED_CONTACT_IMAGE_TYPES),
      dataBase64: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const dados = decodeContactImage(input.dataBase64, input.mimeType);
      const extensao = extensionForContactImage(input.mimeType);
      const uploaded = await storagePut(`contacts/${ctx.user.openId}/cartao.${extensao}`, dados, input.mimeType,
        { cacheControl: CACHE_DE_ARQUIVO_PRIVADO });
      return { url: uploaded.url };
    }),

  // Etapa 8 — a vitrine coletiva: o que o ecossistema vê de um contato marcado
  // 'publico' é a OPORTUNIDADE, nunca a pessoa. As colunas pessoais nem são
  // selecionadas (privacidade.md), e o filtro roda no banco a cada leitura:
  // voltar o contato para 'privado' o tira daqui na requisição seguinte, sem
  // cache nem rotina de limpeza no meio.
  vitrine: protectedProcedure.query(async () => {
    const { listVitrineColetiva } = await import("../db");
    return listVitrineColetiva();
  }),

  // Etapa 10 — o acervo Ouro. Quem lê: só Status Ouro (goldProcedure, checado
  // a cada request). O que sai: só contatos que a dona marcou 'ouro', com o
  // termo da dona vigente — os dois filtros rodam no banco em listAcervoOuro,
  // então revogar qualquer um tira o acesso na leitura seguinte, sem cache.
  acervoOuro: goldProcedure.query(async ({ ctx }) => {
    const { listAcervoOuro } = await import("../db");
    const itens = await listAcervoOuro();
    // Primeira leitura NOMINAL que atravessa donas no app — fica na trilha de
    // auditoria, como as ações sensíveis do admin: "quem viu meus contatos
    // compartilhados?" precisa ter resposta.
    const { createAuditLog } = await import("../security");
    await createAuditLog({
      userId: ctx.user.id, action: "GOLD_ACERVO_READ", resource: "private_contacts",
      details: { itens: itens.length }, status: "success", riskLevel: "medium",
    });
    return itens;
  }),

  list: protectedProcedure
    .input(z.object({
      q:       z.string().optional(),
      tag:     z.string().optional(),
      country: z.string().optional(),
      page:    z.number().int().min(1).default(1),
      limit:   z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      return listPrivateContacts(ctx.user.openId, input);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const contact = await getPrivateContactById(ctx.user.openId, input.id);
      if (!contact) throw new Error("NOT_FOUND");
      return contact;
    }),

  update: protectedProcedure
    .input(z.object({
      id:          z.number().int(),
      fullName:    z.string().min(1).max(200).optional(),
      photoUrl:    chaveDaImagem,
      jobTitle:    z.string().max(200).optional().nullable(),
      company:     z.string().max(200).optional().nullable(),
      country:     z.string().max(100).optional().nullable(),
      state:       z.string().max(100).optional().nullable(),
      city:        z.string().max(100).optional().nullable(),
      phone:       z.string().max(50).optional().nullable(),
      whatsapp:    z.string().max(50).optional().nullable(),
      email:       z.string().email().optional().nullable(),
      linkedinUrl: z.string().url().optional().nullable(),
      instagram:   z.string().max(100).optional().nullable(),
      profileTags: z.array(z.string()).optional().nullable(),
      cardImageUrl: chaveDaImagem,
      notes:       z.string().max(5000).optional().nullable(),
      // Etapa 8: o nível muda a qualquer momento, e o efeito é imediato — a
      // vitrine filtra na leitura, então 'privado' some na requisição seguinte.
      nivelVisibilidade: z.enum(["privado", "ouro", "publico"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      // Buscado ANTES do update: é a única chance de saber qual era a imagem
      // velha, para tirá-la do bucket se a troca for confirmada.
      const antes = await getPrivateContactById(ctx.user.openId, id);
      const updated = await updatePrivateContact(ctx.user.openId, id, data);
      if (!updated) throw new Error("NOT_FOUND");
      if (antes) {
        if ("photoUrl" in data && data.photoUrl !== antes.photoUrl) {
          await apagarImagemDoBucket(ctx.user.openId, antes.photoUrl, id);
        }
        if ("cardImageUrl" in data && data.cardImageUrl !== antes.cardImageUrl) {
          await apagarImagemDoBucket(ctx.user.openId, antes.cardImageUrl, id);
        }
      }
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      // Buscado ANTES do delete: apagarRastroDoContato/deletePrivateContact
      // não devolvem a linha, e é dela que vêm photoUrl/cardImageUrl.
      const alvo = await getPrivateContactById(ctx.user.openId, input.id);
      const deleted = await deletePrivateContact(ctx.user.openId, input.id);
      if (!deleted) throw new Error("NOT_FOUND");
      if (alvo) {
        await apagarImagemDoBucket(ctx.user.openId, alvo.photoUrl, input.id);
        await apagarImagemDoBucket(ctx.user.openId, alvo.cardImageUrl, input.id);
      }
      // O cruzamento roda sozinho também na saída de dados, não só na entrada:
      // apagar contato muda o mapa de possui/procura, e as sugestões precisam
      // refletir isso sem ninguém clicar em atualizar. Melhor esforço e sem
      // e-mail — exclusão não é notícia de oportunidade nova.
      try {
        if (await hasValidConsent(ctx.user.id, "termo_smart_match")) {
          await recalculatePrivateMatches(ctx.user.openId);
        }
      } catch (erro) {
        console.warn("[Rede] recálculo adiado após exclusão:", erro instanceof Error ? erro.message : erro);
      }
      return { success: true };
    }),

  // ─── Possui / procura: dado da AGENDA, não do cruzamento ───────────────────
  // O chat de enriquecimento grava contact_assets/contact_needs sem exigir o
  // termo do Smart Match (é dado do contato), e a vitrine e o acervo Ouro já
  // expõem esses itens. Mas o único lugar que os listava e removia era o
  // router intelligentMatches, inteiro atrás da trava do termo: quem nunca
  // aceitou (ou revogou) não conseguia ver nem apagar um "possui" errado que
  // ela mesma confirmou. Ver e remover o próprio dado fica aqui, sem termo;
  // o cruzamento continua atrás da trava em matches.ts.
  assetsNeeds: protectedProcedure
    .input(z.object({ contactId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      // Posse conferida ANTES de ler as tabelas: contato de outra dona (ou
      // inexistente) sai como NOT_FOUND sem nenhuma consulta a mais.
      const contato = await getPrivateContactById(ctx.user.openId, input.contactId);
      if (!contato) throw new TRPCError({ code: "NOT_FOUND" });
      const db = await exigirDb();
      const [possui, procura] = await Promise.all([
        db.select({ id: contactAssets.id, label: contactAssets.tagLabel, category: contactAssets.category })
          .from(contactAssets)
          .where(and(eq(contactAssets.ownerId, ctx.user.openId), eq(contactAssets.contactId, input.contactId))),
        db.select({ id: contactNeeds.id, label: contactNeeds.tagLabel, category: contactNeeds.category })
          .from(contactNeeds)
          .where(and(eq(contactNeeds.ownerId, ctx.user.openId), eq(contactNeeds.contactId, input.contactId))),
      ]);
      return { possui, procura };
    }),

  removeAsset: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => removerItemDaAgenda(contactAssets, ctx.user, input.id)),

  removeNeed: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => removerItemDaAgenda(contactNeeds, ctx.user, input.id)),
});
