import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { auditLogs, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";
import { nomesDosFalantes } from "@shared/const";
import { ACAO_REUNIAO_EXPORTADA, MENSAGEM_EXPORTAR_SO_PRONTA, type FormatoDaExportacao } from "@shared/exportar-reuniao";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { exigirDb } from "./db";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";

/**
 * Exportar a reunião (H8): o conteúdo do PDF que a dona baixa. Só em PDF por
 * enquanto (decisão do Roberto de 16/11/2026; shared/exportar-reuniao.ts), e
 * o PDF é montado pela impressão do aparelho dela, na tela.
 *
 * Uma transação só lê a reunião, a transcrição, os nomes das vozes e os itens
 * do resumo, e grava a auditoria MEETING_EXPORTED por insert direto que lança
 * (o createAuditLog engole o erro): se a linha não entra, a transação volta
 * atrás e nada é exportado, porque o arquivo sai da WRW e não volta. É o
 * padrão do link aberto (ligarLinkAberto, em server/link-aberto-da-reuniao.ts).
 *
 * O que sai:
 * - o título, o emoji do resumo e a data da reunião;
 * - a transcrição com as falas, os tempos e os nomes que a dona deu às vozes
 *   (nomesDosFalantes); sem falas (o envio único de antes), o texto corrido;
 * - SÓ os itens do resumo que a dona confirmou (nada extraído por IA sai da
 *   WRW sem a conferência dela): nem os para conferir, nem os ignorados, nem o
 *   trecho, o tempo e a confiança de cada item.
 *
 * O que não sai: o que é da rede particular da dona (sugestões de contato,
 * entidades, pendências do Meu Network Inteligente), o token do link aberto e
 * o áudio. Toda consulta leva a dona no WHERE: reunião de outra conta, ou
 * excluída, é "não encontrada". Só reunião pronta: em gravação, processando ou
 * com falha, a transcrição ainda não é a final.
 *
 * A auditoria guarda o formato, o idioma e as contagens, nunca o conteúdo: o
 * painel da administração lê audit_logs.
 */

type Secao = (typeof meetingSummaryItems.$inferSelect)["section"];

export type ItemExportado = {
  secao: Secao;
  assunto: string | null;
  texto: string;
  responsavel: string | null;
  prazo: string | null;
  feita: boolean;
};

export type FalaExportada = ReturnType<typeof segmentosDoContrato>[number];

export type ReuniaoExportada = {
  titulo: string;
  emoji: string | null;
  criadaEm: number;
  /** O idioma da reunião: os rótulos do PDF saem nele, dos 10 JSONs da tela. */
  idioma: IdiomaDaReuniao;
  duracaoSegundos: number | null;
  /** Os nomes que a dona deu às vozes ({ F1: "Ana" }). */
  nomes: Record<string, string>;
  /** Só os confirmados, na ordem do resumo. */
  itens: ItemExportado[];
  /**
   * Null sem transcrição. Com falas, o texto corrido não vai (as falas já são
   * o texto, e a resposta não dobra de tamanho); sem falas, vai só ele.
   */
  transcricao: { texto: string | null; falas: FalaExportada[] } | null;
  exportadaEm: number;
};

export type PedidoDeExportacao = {
  formato: FormatoDaExportacao;
  userId: number;
  ipAddress: string;
  userAgent: string | undefined;
};

export async function exportarReuniao(ownerId: string, meetingId: string, pedido: PedidoDeExportacao): Promise<ReuniaoExportada> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({
      title: meetings.title,
      status: meetings.status,
      language: meetings.language,
      createdAt: meetings.createdAt,
      speakerNames: meetings.speakerNames,
    }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted")))
      .limit(1);
    // Lançar aqui desfaz a transação: nada foi gravado ainda.
    if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    if (reuniao.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_EXPORTAR_SO_PRONTA });

    const [transcricao] = await tx.select({
      transcript: meetingTranscripts.transcript,
      segments: meetingTranscripts.segments,
      language: meetingTranscripts.language,
      durationSeconds: meetingTranscripts.durationSeconds,
    }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId)))
      .limit(1);

    const [resumo] = await tx.select({ id: meetingSummaries.id, emoji: meetingSummaries.emoji }).from(meetingSummaries)
      .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId)))
      .limit(1);
    // Os confirmados valem em qualquer estado do resumo: o "Refazer como…"
    // (H4d) os guarda, e só os outros itens são trocados pela versão nova.
    const itens: ItemExportado[] = resumo
      ? await tx.select({
        secao: meetingSummaryItems.section,
        assunto: meetingSummaryItems.subject,
        texto: meetingSummaryItems.text,
        responsavel: meetingSummaryItems.assignee,
        prazo: meetingSummaryItems.due,
        feita: meetingSummaryItems.done,
      }).from(meetingSummaryItems)
        .where(and(
          eq(meetingSummaryItems.summaryId, resumo.id),
          eq(meetingSummaryItems.ownerId, ownerId),
          eq(meetingSummaryItems.status, "confirmed"),
        ))
        .orderBy(asc(meetingSummaryItems.position))
      : [];

    const falas = segmentosDoContrato(transcricao?.segments);
    const idioma = idiomaDaReuniao(transcricao?.language) ?? idiomaDaReuniao(reuniao.language) ?? IDIOMA_DA_REUNIAO_PADRAO;
    await tx.insert(auditLogs).values({
      userId: pedido.userId,
      action: ACAO_REUNIAO_EXPORTADA,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        formato: pedido.formato,
        idioma,
        itensConfirmados: itens.length,
        falas: falas.length,
        comTranscricao: !!transcricao,
      },
      // Os mesmos cortes do createAuditLog (server/security.ts).
      ipAddress: pedido.ipAddress.split(",")[0].trim().substring(0, 45),
      userAgent: pedido.userAgent ? pedido.userAgent.substring(0, 500) : null,
      status: "success",
      // O conteúdo sai da WRW com a voz e as falas de outras pessoas: médio, como ligar o link aberto.
      riskLevel: "medium",
    });

    return {
      titulo: reuniao.title,
      emoji: resumo?.emoji ?? null,
      criadaEm: Number(reuniao.createdAt),
      idioma,
      duracaoSegundos: transcricao?.durationSeconds ?? null,
      nomes: nomesDosFalantes(reuniao.speakerNames),
      itens: itens.map(item => ({ ...item, feita: !!item.feita })),
      transcricao: transcricao ? { texto: falas.length ? null : transcricao.transcript, falas } : null,
      exportadaEm: Date.now(),
    };
  });
}
