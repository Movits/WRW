import { TRPCError } from "@trpc/server";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { contexts, meetings, privateContacts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { etiquetasDaReuniao, normalizarEtiquetas, normalizarOndeFoi, RECUSAS_DOS_DETALHES } from "@shared/detalhes-da-reuniao";

/**
 * Os detalhes da reunião (H7c do plano do gravador): o título, as etiquetas, o
 * "Onde foi", o contato e o contexto. Só a dona lê e muda; a dona vai no WHERE
 * de tudo, e o link aberto não leva nada disto (server/link-aberto-da-reuniao.ts
 * escolhe as colunas dele).
 *
 * A posse do contato e do contexto (a antiga H7a) é conferida aqui, antes de
 * qualquer escrita, e vale para os quatro caminhos que gravam os ponteiros:
 * meetings.create, iniciarGravacao, iniciarDocumento e atualizarDetalhes.
 * Antes, um id de contato ou de contexto de outra conta entrava como ponteiro
 * da reunião. O contato tem de ser da dona; o contexto, dela ou do catálogo
 * (owner_id nulo), a mesma régua de contextIsVisible (server/db.ts) e do
 * vínculo do contato com o contexto (routers/contexts.ts).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Leitor = Pick<Banco, "select">;

export type PonteirosDaReuniao = { contactId?: number | null; contextId?: string | null };

/**
 * Recusa (NOT_FOUND, com o código que a tela traduz) o contato que não é da
 * dona e o contexto que ela não pode ver. O que não existe responde igual: o
 * id de outra conta não se sonda. Nulo ou ausente não confere nada, e nem abre
 * o banco. `ex` é a transação de quem chama, quando há uma.
 */
export async function conferirContatoEContexto(ownerId: string, ponteiros: PonteirosDaReuniao, ex?: Leitor): Promise<void> {
  const temContato = ponteiros.contactId !== null && ponteiros.contactId !== undefined;
  const temContexto = ponteiros.contextId !== null && ponteiros.contextId !== undefined;
  if (!temContato && !temContexto) return;
  const leitor = ex ?? await exigirDb();
  if (temContato) {
    const [contato] = await leitor.select({ id: privateContacts.id }).from(privateContacts)
      .where(and(eq(privateContacts.id, ponteiros.contactId!), eq(privateContacts.ownerId, ownerId))).limit(1);
    if (!contato) throw new TRPCError({ code: "NOT_FOUND", message: RECUSAS_DOS_DETALHES.contato });
  }
  if (temContexto) {
    const [contexto] = await leitor.select({ id: contexts.id }).from(contexts)
      .where(and(eq(contexts.id, ponteiros.contextId!), or(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)))).limit(1);
    if (!contexto) throw new TRPCError({ code: "NOT_FOUND", message: RECUSAS_DOS_DETALHES.contexto });
  }
}

/**
 * O nome do contato e o do contexto da reunião, só da rede da dona (o
 * contexto: dela ou do catálogo). O ponteiro que sobrou de antes da
 * conferência de posse, para o contato ou o contexto de outra conta, sai nulo:
 * o nome alheio nunca chega à tela.
 */
export async function nomesDosPonteiros(ex: Leitor, ownerId: string, ponteiros: { contactId: number | null; contextId: string | null }) {
  const [contato] = ponteiros.contactId === null ? [] : await ex.select({ id: privateContacts.id, nome: privateContacts.fullName }).from(privateContacts)
    .where(and(eq(privateContacts.id, ponteiros.contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  const [contexto] = ponteiros.contextId === null ? [] : await ex.select({ id: contexts.id, nome: contexts.name }).from(contexts)
    .where(and(eq(contexts.id, ponteiros.contextId), or(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)))).limit(1);
  return {
    contato: contato ? { id: Number(contato.id), nome: contato.nome } : null,
    contexto: contexto ? { id: contexto.id, nome: contexto.nome } : null,
  };
}

/** O que a dona pode mudar. Ausente: não mexe; nulo (ou lista vazia, nas etiquetas): tira. */
export type CamposDosDetalhes = {
  titulo?: string;
  etiquetas?: string[] | null;
  ondeFoi?: string | null;
  contactId?: number | null;
  contextId?: string | null;
};

export type DetalhesDaReuniao = {
  titulo: string;
  etiquetas: string[];
  ondeFoi: string | null;
  contato: { id: number; nome: string } | null;
  contexto: { id: string; nome: string } | null;
};

/**
 * Muda os detalhes da reunião da dona e devolve como ficaram. A reunião de
 * outra conta (ou excluída) é NOT_FOUND, sem escrever nada.
 *
 * O `updated_at` da reunião é a FICHA da execução que a está processando
 * (server/meeting-service.ts): mudá-lo no meio do processamento jogaria fora o
 * resultado da IA. Por isso ele só muda quando o TÍTULO muda e a reunião não
 * está em 'processing' (a linha está travada: o estado não muda no meio). É o
 * updated_at que avisa a Memória da reunião renomeada (a assinatura da base,
 * em server/memory-service.ts); as etiquetas, o "Onde foi", o contato e o
 * contexto não entram na Memória e não o tocam. Os detalhes valem em qualquer
 * estado.
 */
export async function atualizarDetalhesDaReuniao(ownerId: string, meetingId: string, campos: CamposDosDetalhes): Promise<DetalhesDaReuniao> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"));
    const [reuniao] = await tx.select({ titulo: meetings.title, status: meetings.status }).from(meetings).where(daDona).limit(1).for("update");
    if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    await conferirContatoEContexto(ownerId, { contactId: campos.contactId, contextId: campos.contextId }, tx);

    const mudancas: Partial<typeof meetings.$inferInsert> = {};
    if (campos.titulo !== undefined) {
      mudancas.title = campos.titulo.trim();
      if (mudancas.title !== reuniao.titulo && reuniao.status !== "processing") mudancas.updatedAt = Date.now();
    }
    if (campos.etiquetas !== undefined) mudancas.etiquetas = normalizarEtiquetas(campos.etiquetas);
    if (campos.ondeFoi !== undefined) mudancas.ondeFoi = normalizarOndeFoi(campos.ondeFoi);
    if (campos.contactId !== undefined) mudancas.contactId = campos.contactId;
    if (campos.contextId !== undefined) mudancas.contextId = campos.contextId;
    if (Object.keys(mudancas).length) await tx.update(meetings).set(mudancas).where(daDona);

    const [atual] = await tx.select({
      titulo: meetings.title, etiquetas: meetings.etiquetas, ondeFoi: meetings.ondeFoi, contactId: meetings.contactId, contextId: meetings.contextId,
    }).from(meetings).where(daDona).limit(1);
    const nomes = await nomesDosPonteiros(tx, ownerId, { contactId: atual.contactId === null ? null : Number(atual.contactId), contextId: atual.contextId });
    return { titulo: atual.titulo, etiquetas: etiquetasDaReuniao(atual.etiquetas), ondeFoi: atual.ondeFoi, ...nomes };
  });
}
