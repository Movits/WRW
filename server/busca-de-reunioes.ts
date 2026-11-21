import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { meetings, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { nomesDosFalantes } from "@shared/const";
import {
  inicioDoPeriodo, padraoDoLike, RESULTADOS_DA_BUSCA_MAX, TRECHO_ANTES, TRECHO_TAMANHO,
  type FiltrosDaBusca,
} from "@shared/busca-de-reunioes";

/**
 * A busca no servidor entre as reuniões da dona (H7b do plano do gravador): o
 * termo na transcrição e nos itens do resumo que não foram ignorados, com os
 * mesmos filtros da tela (shared/busca-de-reunioes.ts).
 *
 * - A dona vai no WHERE das duas tabelas (a da transcrição ou a do item, e a da
 *   reunião), e a reunião excluída (status 'deleted', no meio da exclusão) não
 *   aparece.
 * - O termo vai como padrão de LIKE, parametrizado e com `%`, `_` e `!`
 *   escapados (`ESCAPE '!'`): o que a dona digita nunca vira curinga nem SQL.
 * - O trecho sai do próprio SQL (SUBSTRING em volta do LOCATE): a transcrição
 *   inteira (até 16 MiB) não viaja do banco ao servidor por resultado.
 * - A comparação segue a colação da coluna (utf8mb4, sem caixa e sem acento).
 *
 * Devolve até RESULTADOS_DA_BUSCA_MAX resultados, das reuniões mais novas para
 * as mais velhas, e `maisResultados` quando havia mais. Os itens do resumo
 * levam o token da voz ({F1}) como está guardado, com os nomes que a dona deu
 * às vozes daquela reunião: quem troca o token pelo nome é a tela
 * (shared/vozes-no-texto.ts), como em todo lugar.
 */

export type ResultadoDaBusca =
  | { tipo: "transcricao"; meetingId: string; titulo: string; criadaEm: number; trecho: string; nomes: Record<string, string> }
  | {
    tipo: "item"; meetingId: string; titulo: string; criadaEm: number; trecho: string; nomes: Record<string, string>;
    itemId: string; secao: string; assunto: string | null; inicioSegundos: number | null;
  };

/** Os filtros da reunião no SQL: a dona, sem as excluídas, e os da tela. */
function condicoesDaReuniao(ownerId: string, filtros: FiltrosDaBusca, agora: number): SQL[] {
  const condicoes: SQL[] = [eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted")];
  // A etiqueta como guardada (a tela oferece as da própria dona); JSON_CONTAINS
  // recebe o texto como documento JSON, parametrizado.
  if (filtros.etiqueta) condicoes.push(sql`JSON_CONTAINS(${meetings.etiquetas}, ${JSON.stringify(filtros.etiqueta)})`);
  if (filtros.origem === "documento") condicoes.push(inArray(meetings.origem, ["pdf", "foto"]));
  else if (filtros.origem === "youtube") condicoes.push(eq(meetings.origem, "youtube"));
  else if (filtros.origem === "audio") condicoes.push(or(isNull(meetings.origem), inArray(meetings.origem, ["gravacao", "arquivo", "aba"]))!);
  const inicio = inicioDoPeriodo(filtros.periodo, agora);
  if (inicio !== null) condicoes.push(gte(meetings.createdAt, inicio));
  if (filtros.contactId) condicoes.push(eq(meetings.contactId, filtros.contactId));
  if (filtros.contextId) condicoes.push(eq(meetings.contextId, filtros.contextId));
  return condicoes;
}

const comoLike = (coluna: unknown, padrao: string) => sql`${coluna} LIKE ${padrao} ESCAPE '!'`;
/** O trecho em volta da primeira ocorrência, cortado no SQL; sem ocorrência (LOCATE 0), o começo. */
const trechoEmVolta = (coluna: unknown, termo: string) =>
  sql<string>`SUBSTRING(${coluna}, GREATEST(LOCATE(${termo}, ${coluna}) - ${TRECHO_ANTES}, 1), ${TRECHO_TAMANHO})`;

export async function buscarNasReunioes(ownerId: string, termoBruto: string, filtros: FiltrosDaBusca = {}, agora = Date.now()) {
  const termo = termoBruto.trim();
  const padrao = padraoDoLike(termo);
  const db = await exigirDb();
  const daReuniao = condicoesDaReuniao(ownerId, filtros, agora);
  const limite = RESULTADOS_DA_BUSCA_MAX + 1;

  const naTranscricao = await db.select({
    meetingId: meetings.id, titulo: meetings.title, criadaEm: meetings.createdAt, speakerNames: meetings.speakerNames,
    trecho: trechoEmVolta(meetingTranscripts.transcript, termo),
  }).from(meetingTranscripts)
    .innerJoin(meetings, and(eq(meetings.id, meetingTranscripts.meetingId), eq(meetings.ownerId, meetingTranscripts.ownerId)))
    .where(and(eq(meetingTranscripts.ownerId, ownerId), ...daReuniao, comoLike(meetingTranscripts.transcript, padrao)))
    .orderBy(desc(meetings.createdAt), asc(meetings.id))
    .limit(limite);

  const nosItens = await db.select({
    meetingId: meetings.id, titulo: meetings.title, criadaEm: meetings.createdAt, speakerNames: meetings.speakerNames,
    itemId: meetingSummaryItems.id, secao: meetingSummaryItems.section, assunto: meetingSummaryItems.subject,
    texto: meetingSummaryItems.text, inicioSegundos: meetingSummaryItems.startSeconds,
  }).from(meetingSummaryItems)
    .innerJoin(meetings, and(eq(meetings.id, meetingSummaryItems.meetingId), eq(meetings.ownerId, meetingSummaryItems.ownerId)))
    .where(and(
      eq(meetingSummaryItems.ownerId, ownerId), ne(meetingSummaryItems.status, "ignored"), ...daReuniao,
      or(comoLike(meetingSummaryItems.text, padrao), comoLike(meetingSummaryItems.subject, padrao), comoLike(meetingSummaryItems.assignee, padrao)),
    ))
    .orderBy(desc(meetings.createdAt), asc(meetings.id), asc(meetingSummaryItems.position))
    .limit(limite);

  // Mais novas primeiro; na mesma reunião, o trecho da transcrição antes dos itens.
  const resultados: ResultadoDaBusca[] = [
    ...naTranscricao.map(linha => ({
      tipo: "transcricao" as const, meetingId: linha.meetingId, titulo: linha.titulo, criadaEm: Number(linha.criadaEm),
      trecho: String(linha.trecho ?? ""), nomes: nomesDosFalantes(linha.speakerNames),
    })),
    ...nosItens.map(linha => ({
      tipo: "item" as const, meetingId: linha.meetingId, titulo: linha.titulo, criadaEm: Number(linha.criadaEm),
      trecho: linha.texto, nomes: nomesDosFalantes(linha.speakerNames),
      itemId: linha.itemId, secao: linha.secao, assunto: linha.assunto, inicioSegundos: linha.inicioSegundos,
    })),
  ].sort((a, b) => b.criadaEm - a.criadaEm || a.meetingId.localeCompare(b.meetingId) || (a.tipo === b.tipo ? 0 : a.tipo === "transcricao" ? -1 : 1));

  return {
    resultados: resultados.slice(0, RESULTADOS_DA_BUSCA_MAX),
    maisResultados: resultados.length > RESULTADOS_DA_BUSCA_MAX,
  };
}
