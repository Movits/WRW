import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { aiMatchSuggestions, contactAssets, contactNeeds, privateContacts } from "../../drizzle/schema";
import { exigirDb } from "../db";
// Todo recálculo daqui também registra as conexões internas novas (Meu Network
// Inteligente, item 16): o registro mora no fim de recalculatePrivateMatches.
import { recalculatePrivateMatches, slugifyMatchTag } from "../match-service";
import { protectedProcedure, router } from "../_core/trpc";
import { origemDasConexoes } from "../reuniao-no-match";
import { hasValidConsent } from "./consent";

const matchItem = z.object({ contactId: z.number().int().positive(), tagLabel: z.string().trim().min(2).max(200), category: z.string().trim().max(120).optional(), description: z.string().trim().max(2000).optional() });

/**
 * Etapa 11: todo procedimento do cruzamento nasce daqui, e é isso que faz a
 * trava parar de depender de alguém lembrar.
 *
 * Antes cada procedimento chamava a checagem na primeira linha, e dois foram
 * esquecidos — `contacts` devolvia a rede inteira e `updateStatus` deixava
 * operar matches a quem havia revogado. Não foi descuido isolado: é o modo de
 * falha que o desenho previu. `docs/arquitetura/fluxos.md` pede consentimento
 * como condição da consulta, "assim um esquecimento no código não vira
 * vazamento".
 *
 * Condição no banco é o alvo, e depende da migração para políticas de linha que
 * ainda não existe. Enquanto isso, o middleware é o mais próximo: um ponto só,
 * e não há como escrever um procedimento distraído neste router — para escapar
 * é preciso trocar `smartMatchProcedure` por `protectedProcedure` de propósito.
 *
 * A trava fica aqui e não no procedimento protegido porque recusar o termo não
 * pode derrubar o resto do app: só desliga o cruzamento.
 */
const smartMatchProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await hasValidConsent(ctx.user.id, "termo_smart_match"))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "SMART_MATCH_CONSENT_REQUIRED" });
  }
  return next();
});

async function assertOwnedContact(ownerId: string, contactId: number) {
  const db = await exigirDb();
  const contact = (await db.select().from(privateContacts).where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1))[0];
  if (!contact) throw new Error("Contato não encontrado na sua rede privada.");
  return { db, contact };
}

export const intelligentMatchesRouter = router({
  list: smartMatchProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const [matches, contacts] = await Promise.all([
      db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, ctx.user.openId)).orderBy(desc(aiMatchSuggestions.matchScore)),
      db.select().from(privateContacts).where(eq(privateContacts.ownerId, ctx.user.openId)),
    ]);
    const names = new Map(contacts.map(contact => [contact.id, { name: contact.fullName, company: contact.company, jobTitle: contact.jobTitle }]));
    // N5: a reunião de que a conexão nasceu (o item confirmado que ela cita), com o trecho.
    const origens = await origemDasConexoes(ctx.user.openId, matches);
    return matches.map(match => ({
      ...match, contactA: names.get(match.contactAId), contactB: names.get(match.contactBId), origem: origens.get(match.id) ?? null,
    }));
  }),

  // Devolve, junto com cada contato, o que já foi registrado para ele. A tela
  // precisa disso para que "o que possui" e "o que procura" mostrem coisas
  // diferentes: sem isso, trocar de aba não mudava nada no que aparecia, e as
  // duas viravam a mesma tela na cabeça de quem estava usando.
  //
  // Vem tudo de uma vez em vez de uma consulta por contato selecionado: é a
  // agenda particular de uma pessoa, não um catálogo, e assim trocar de contato
  // ou de aba não espera servidor.
  contacts: smartMatchProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const [contatos, possui, procura] = await Promise.all([
      db.select({ id: privateContacts.id, fullName: privateContacts.fullName, company: privateContacts.company })
        .from(privateContacts).where(eq(privateContacts.ownerId, ctx.user.openId)),
      db.select({ id: contactAssets.id, contactId: contactAssets.contactId, label: contactAssets.tagLabel, category: contactAssets.category })
        .from(contactAssets).where(eq(contactAssets.ownerId, ctx.user.openId)),
      db.select({ id: contactNeeds.id, contactId: contactNeeds.contactId, label: contactNeeds.tagLabel, category: contactNeeds.category })
        .from(contactNeeds).where(eq(contactNeeds.ownerId, ctx.user.openId)),
    ]);
    const porContato = <T extends { contactId: number }>(itens: T[], id: number) => itens.filter(i => i.contactId === id);
    return contatos.map(contato => ({
      ...contato,
      possui: porContato(possui, contato.id),
      procura: porContato(procura, contato.id),
    }));
  }),

  addAsset: smartMatchProcedure.input(matchItem).mutation(async ({ ctx, input }) => {
    const { db } = await assertOwnedContact(ctx.user.openId, input.contactId); const timestamp = Date.now();
    await db.insert(contactAssets).values({ ownerId: ctx.user.openId, contactId: input.contactId, tagSlug: slugifyMatchTag(input.tagLabel), tagLabel: input.tagLabel, category: input.category || null, description: input.description || null, createdAt: timestamp, updatedAt: timestamp });
    return recalculatePrivateMatches(ctx.user.openId, ctx.user.email);
  }),

  addNeed: smartMatchProcedure.input(matchItem).mutation(async ({ ctx, input }) => {
    const { db } = await assertOwnedContact(ctx.user.openId, input.contactId); const timestamp = Date.now();
    await db.insert(contactNeeds).values({ ownerId: ctx.user.openId, contactId: input.contactId, tagSlug: slugifyMatchTag(input.tagLabel), tagLabel: input.tagLabel, category: input.category || null, description: input.description || null, createdAt: timestamp, updatedAt: timestamp });
    return recalculatePrivateMatches(ctx.user.openId, ctx.user.email);
  }),

  // Remover um item registrado errado. Sem isto, um "possui" digitado no campo
  // errado era permanente — e a limpeza de órfãos do recálculo, que existe para
  // quando a razão de um match some, nunca tinha como acontecer de verdade.
  removeAsset: smartMatchProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await exigirDb();
    await db.delete(contactAssets).where(and(eq(contactAssets.id, input.id), eq(contactAssets.ownerId, ctx.user.openId)));
    return recalculatePrivateMatches(ctx.user.openId);
  }),

  removeNeed: smartMatchProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await exigirDb();
    await db.delete(contactNeeds).where(and(eq(contactNeeds.id, input.id), eq(contactNeeds.ownerId, ctx.user.openId)));
    return recalculatePrivateMatches(ctx.user.openId);
  }),

  recalculate: smartMatchProcedure.mutation(async ({ ctx }) => {
    return recalculatePrivateMatches(ctx.user.openId, ctx.user.email);
  }),

  updateStatus: smartMatchProcedure.input(z.object({ id: z.string().uuid(), status: z.enum(["viewed", "accepted", "dismissed"]) })).mutation(async ({ ctx, input }) => {
    const db = await exigirDb(); const timestamp = Date.now();
    const patch = input.status === "viewed" ? { status: input.status, viewedAt: timestamp, updatedAt: timestamp } : input.status === "accepted" ? { status: input.status, acceptedAt: timestamp, updatedAt: timestamp } : { status: input.status, dismissedAt: timestamp, updatedAt: timestamp };
    await db.update(aiMatchSuggestions).set(patch).where(and(eq(aiMatchSuggestions.id, input.id), eq(aiMatchSuggestions.ownerId, ctx.user.openId)));
    return { ok: true };
  }),
});
