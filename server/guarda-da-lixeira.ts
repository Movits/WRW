import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { meetingContactSuggestions, meetingEntities, meetings, meetingSummaryItems } from "../drizzle/schema";
import { RECUSAS_DA_LIXEIRA } from "@shared/lixeira-de-reunioes";
import { exigirDb } from "./db";
import { protectedProcedure } from "./_core/trpc";

/**
 * A guarda da lixeira nos procedimentos que leem ou mexem numa reunião pelo id
 * (H7d). A reunião na lixeira é "não encontrada" (NOT_FOUND) para todos eles,
 * salvo os da própria lixeira (mandar, restaurar e apagar de vez), que usam o
 * protectedProcedure e se conferem sozinhos (server/lixeira-de-reunioes.ts), e
 * o Excluir imediato (meetings.delete, o do descarte da gravação), que tira a
 * reunião de vez esteja ela onde estiver.
 *
 * A mensagem é o código REUNIAO_NA_LIXEIRA, e não a frase da reunião de outra
 * conta: a dona que abre pelo favorito ou pelo histórico uma reunião dela que
 * está na lixeira lê "Esta reunião está na lixeira", com o restaurar. Não abre
 * enumeração: a guarda só lê as reuniões da própria dona, e o id de outra
 * conta passa por ela sem achar nada e leva a frase do serviço, como sempre.
 *
 * Lê o pedido CRU (a guarda vem antes do zod) atrás dos campos que apontam
 * para uma reunião: meetingId e meetingIds, itemId (o item do resumo), entityId
 * (a entidade) e suggestionId (a pessoa sugerida). O que não tem a forma de um
 * id fica para o zod recusar. Uma consulta pelo índice por campo presente; o
 * pedido sem nenhum deles não consulta nada.
 *
 * Não é a única defesa: os serviços que já recusavam a reunião excluída
 * recusam também a da lixeira, na mesma leitura (reuniaoForaDeVista, em
 * server/reuniao-visivel.ts), e as consultas entre reuniões (a lista, a busca,
 * a Memória, o link aberto, as filas e os motores) filtram por conta própria.
 * A guarda cobre o procedimento que não lia o status, e o que entrar depois:
 * server/guarda-da-lixeira.test.ts varre o router.
 */

const FORMATO_DO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Quantos ids da lista a guarda confere (a lista maior o zod recusa depois). */
const IDS_POR_PEDIDO_MAX = 100;

const umId = (valor: unknown): string | null => (typeof valor === "string" && FORMATO_DO_ID.test(valor) ? valor : null);

/** Os campos do pedido que apontam para uma reunião, já com a forma de id. */
export function idsDoPedido(pedido: unknown) {
  const campos = pedido && typeof pedido === "object" ? pedido as Record<string, unknown> : {};
  const reunioes = new Set<string>();
  const unica = umId(campos.meetingId);
  if (unica) reunioes.add(unica);
  if (Array.isArray(campos.meetingIds)) {
    for (const valor of campos.meetingIds.slice(0, IDS_POR_PEDIDO_MAX)) {
      const id = umId(valor);
      if (id) reunioes.add(id);
    }
  }
  return { reunioes: Array.from(reunioes), itemId: umId(campos.itemId), entityId: umId(campos.entityId), suggestionId: umId(campos.suggestionId) };
}

const naLixeira = () => new TRPCError({ code: "NOT_FOUND", message: RECUSAS_DA_LIXEIRA.naLixeira });

/**
 * Recusa (NOT_FOUND, com o código REUNIAO_NA_LIXEIRA) o pedido que aponta para
 * uma reunião da dona que está na lixeira. A reunião de outra conta não é lida
 * aqui: o serviço a recusa como sempre, com a frase dele.
 */
export async function recusarSeNaLixeira(ownerId: string, pedido: unknown): Promise<void> {
  const { reunioes, itemId, entityId, suggestionId } = idsDoPedido(pedido);
  if (!reunioes.length && !itemId && !entityId && !suggestionId) return;
  const db = await exigirDb();
  const lixo = and(eq(meetings.ownerId, ownerId), isNotNull(meetings.trashedAt));
  if (reunioes.length) {
    const [achada] = await db.select({ id: meetings.id }).from(meetings).where(and(lixo, inArray(meetings.id, reunioes))).limit(1);
    if (achada) throw naLixeira();
  }
  if (itemId) {
    const [achado] = await db.select({ id: meetingSummaryItems.id }).from(meetingSummaryItems)
      .innerJoin(meetings, and(eq(meetings.id, meetingSummaryItems.meetingId), eq(meetings.ownerId, meetingSummaryItems.ownerId)))
      .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId), lixo)).limit(1);
    if (achado) throw naLixeira();
  }
  if (entityId) {
    const [achada] = await db.select({ id: meetingEntities.id }).from(meetingEntities)
      .innerJoin(meetings, and(eq(meetings.id, meetingEntities.meetingId), eq(meetings.ownerId, meetingEntities.ownerId)))
      .where(and(eq(meetingEntities.id, entityId), eq(meetingEntities.ownerId, ownerId), lixo)).limit(1);
    if (achada) throw naLixeira();
  }
  if (suggestionId) {
    const [achada] = await db.select({ id: meetingContactSuggestions.id }).from(meetingContactSuggestions)
      .innerJoin(meetings, and(eq(meetings.id, meetingContactSuggestions.meetingId), eq(meetings.ownerId, meetingContactSuggestions.ownerId)))
      .where(and(eq(meetingContactSuggestions.id, suggestionId), eq(meetingContactSuggestions.ownerId, ownerId), lixo)).limit(1);
    if (achada) throw naLixeira();
  }
}

/**
 * O procedimento da dona que aponta para uma reunião: o protectedProcedure com
 * a guarda da lixeira antes do zod. Todo procedimento de server/routers/
 * meetings.ts usa este, fora os da própria lixeira. A guarda é o último
 * middleware deste construtor: a varredura do router a acha por ali.
 */
export const procedimentoDaReuniao = protectedProcedure.use(async function guardaDaLixeira({ ctx, getRawInput, next }) {
  await recusarSeNaLixeira(ctx.user.openId, await getRawInput());
  return next();
});
