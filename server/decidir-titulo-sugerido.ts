import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { meetings, meetingSummaries } from "../drizzle/schema";
import { MENSAGEM_TITULO_SUGERIDO_INDISPONIVEL, tituloSugeridoValido } from "@shared/titulo-sugerido";
import { exigirDb } from "./db";
import { reuniaoDaDona } from "./resumo-guardado";

/**
 * A dona decide o título que a IA sugeriu com o resumo (shared/titulo-sugerido.ts):
 * "Usar este título" troca o título da reunião pela sugestão; "Manter o atual"
 * só guarda a decisão, e a sugestão some. Numa transação, com a reunião e o
 * resumo travados: a decisão dupla (dois cliques, duas abas) e o resumo
 * refeito no meio não se cruzam. A dona vai no WHERE das duas tabelas:
 * reunião de outra dona é NOT_FOUND. A sugestão que não está mais à espera (já
 * decidida, trocada por um resumo refeito, ou o resumo não está pronto) é
 * CONFLICT, sem efeito.
 *
 * O updated_at da reunião é a ficha do processamento (server/meeting-service.ts):
 * em 'processing' ele não muda, para o título não tomar a reunião de quem a
 * processa. Fora dele, o título novo muda o updated_at, como no
 * atualizarDetalhesDaReuniao (server/detalhes-da-reuniao.ts): é o updated_at
 * que avisa a Memória da reunião renomeada (a assinatura da base, em
 * server/memory-service.ts). A linha está travada: o estado não muda no meio.
 */
export async function decidirTituloSugerido(ownerId: string, meetingId: string, usar: boolean): Promise<{ titulo: string }> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const reuniao = await reuniaoDaDona(tx, ownerId, meetingId, true);
    const [linha] = await tx.select({
      id: meetingSummaries.id, status: meetingSummaries.status,
      suggestedTitle: meetingSummaries.suggestedTitle, suggestedTitleStatus: meetingSummaries.suggestedTitleStatus,
    }).from(meetingSummaries)
      .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1).for("update");
    const sugestao = linha?.status === "ready" && linha.suggestedTitleStatus === "pending" ? tituloSugeridoValido(linha.suggestedTitle) : null;
    if (!linha || !sugestao) throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_TITULO_SUGERIDO_INDISPONIVEL });
    if (usar) {
      const renomeia = sugestao !== reuniao.title && reuniao.status !== "processing";
      await tx.update(meetings).set(renomeia ? { title: sugestao, updatedAt: Date.now() } : { title: sugestao })
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
    }
    await tx.update(meetingSummaries).set({ suggestedTitleStatus: usar ? "confirmed" : "ignored", updatedAt: Date.now() })
      .where(and(eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId)));
    return { titulo: usar ? sugestao : reuniao.title };
  });
}
