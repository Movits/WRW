import { TRPCError } from "@trpc/server";
import { and, eq, ne, or } from "drizzle-orm";
import { contactAssets, contactNeeds, privateContacts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { indexarContatos } from "./indice-de-cruzamento";
import { slugifyMatchTag } from "./match-service";
import { RECUSAS_DO_ITEM_DA_FICHA, type TipoDoItemDaFicha } from "@shared/possui-procura-da-ficha";

/**
 * Acrescentar e corrigir, na ficha do contato, o que ele possui e o que ele
 * procura (T45, 24/11: só o chat acrescentava, e só a ficha removia). O que a
 * dona escreve aqui é a palavra dela, como o "Adicionar" de Conexões
 * Inteligentes (matches.addAsset): não passa pela IA, então não há origem de IA
 * nem cartão a confirmar. O que a IA tira do chat continua entrando só pelo
 * cartão que a dona confirma (server/routers/enrichment.ts); corrigir aqui um
 * item que veio do chat é a dona dizendo o que vale.
 *
 * Privacidade é regra de consulta: o owner_id vai em todo WHERE. Contato ou
 * item de outra dona (ou que não existe) sai como NOT_FOUND, sem revelar se
 * existe. Banco fora do ar é erro (exigirDb), nunca "nada mudou".
 */

const tabelaDo = (tipo: TipoDoItemDaFicha) => (tipo === "possui" ? contactAssets : contactNeeds);

function rotuloESlug(rotulo: string) {
  const limpo = rotulo.trim().replace(/\s+/g, " ");
  const slug = slugifyMatchTag(limpo);
  // Sem nenhuma letra ou número ("—", "!!!"): o cruzamento não teria o que comparar.
  if (!limpo || !slug) throw new TRPCError({ code: "BAD_REQUEST", message: RECUSAS_DO_ITEM_DA_FICHA.semTexto });
  return { rotulo: limpo, slug };
}

/** O contato tem outro item igual (pelo slug ou pelo texto), fora `menosOId`? */
async function jaTem(db: Awaited<ReturnType<typeof exigirDb>>, tipo: TipoDoItemDaFicha, ownerId: string, contactId: number, slug: string, rotulo: string, menosOId?: number) {
  const tabela = tabelaDo(tipo);
  const [igual] = await db.select({ id: tabela.id }).from(tabela).where(and(
    eq(tabela.ownerId, ownerId), eq(tabela.contactId, contactId),
    or(eq(tabela.tagSlug, slug), eq(tabela.tagLabel, rotulo)),
    menosOId === undefined ? undefined : ne(tabela.id, menosOId),
  )).limit(1);
  return !!igual;
}

/** Acrescenta um item ao possui ou ao procura do contato da dona. Devolve o id novo. */
export async function acrescentarItemDaFicha(ownerId: string, contactId: number, tipo: TipoDoItemDaFicha, texto: string) {
  const { rotulo, slug } = rotuloESlug(texto);
  const db = await exigirDb();
  const [contato] = await db.select({ id: privateContacts.id }).from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  if (!contato) throw new TRPCError({ code: "NOT_FOUND" });
  if (await jaTem(db, tipo, ownerId, contactId, slug, rotulo)) throw new TRPCError({ code: "CONFLICT", message: RECUSAS_DO_ITEM_DA_FICHA.repetido });
  const agora = Date.now();
  const [inserido] = await db.insert(tabelaDo(tipo)).values({ ownerId, contactId, tagSlug: slug, tagLabel: rotulo, createdAt: agora, updatedAt: agora });
  return { id: Number((inserido as { insertId?: unknown }).insertId), contactId };
}

/**
 * Corrige o texto de um item do possui ou do procura. A categoria e a
 * descrição ficam como estão; o slug acompanha o texto novo, e o cruzamento é
 * refeito por quem chama. As chaves de cruzamento do contato são refeitas na
 * mesma transação do UPDATE (server/indice-de-cruzamento.ts): a varredura do
 * índice só acha item sem chave e chave sem item, e o rótulo antigo ficaria no
 * índice para sempre, com o par do rótulo novo fora da busca na rede global.
 */
export async function editarItemDaFicha(ownerId: string, id: number, tipo: TipoDoItemDaFicha, texto: string) {
  const { rotulo, slug } = rotuloESlug(texto);
  const db = await exigirDb();
  const tabela = tabelaDo(tipo);
  const [item] = await db.select({ contactId: tabela.contactId }).from(tabela)
    .where(and(eq(tabela.id, id), eq(tabela.ownerId, ownerId))).limit(1);
  if (!item) throw new TRPCError({ code: "NOT_FOUND" });
  if (await jaTem(db, tipo, ownerId, item.contactId, slug, rotulo, id)) throw new TRPCError({ code: "CONFLICT", message: RECUSAS_DO_ITEM_DA_FICHA.repetido });
  await db.transaction(async tx => {
    await tx.update(tabela).set({ tagLabel: rotulo, tagSlug: slug, updatedAt: Date.now() })
      .where(and(eq(tabela.id, id), eq(tabela.ownerId, ownerId)));
    await indexarContatos(tx, ownerId, [item.contactId]);
  });
  return { id, contactId: item.contactId };
}
