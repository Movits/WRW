import { and, eq, isNull, or } from "drizzle-orm";
import { auditLogs, meetings, meetingSummaries, meetingTranscripts } from "../drizzle/schema";
import { conferirMapaMental, nosDoMapa } from "@shared/mapa-mental";
import {
  ACAO_MAPA_EDITADO, ACAO_MAPA_REFEITO, conferirMapaEditado, mesmoMapa, RECUSAS_DO_MAPA,
  type CodigoDaRecusaDoMapa, type EstiloDoMapa,
} from "@shared/mapa-mental-edicao";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * O mapa mental editável (H10b da auditoria de 16/11; HN-40 do app de
 * referência da cliente). Onde fica cada versão (meeting_summaries), como a
 * transcrição da H18 mas ao contrário nas colunas:
 * - `mind_map` guarda o mapa como a IA o escreveu, e só a fila o grava;
 * - `mind_map_edited` guarda o mapa da dona, quando ela o mudou. A tela e o
 *   link aberto mostram este quando existe (mapaQueVale,
 *   shared/mapa-mental-edicao.ts), e a tradução do resumo (H11) traduz os
 *   rótulos dele. "Voltar ao da IA" o apaga;
 * - `mind_map_revision` sobe a cada mudança: a tela manda a revisão que viu,
 *   e a de outra aba é recusada (MAPA_MUDOU), em vez de desfeita em silêncio.
 *
 * "Refazer em outro estilo" põe o mapa de volta na fila do resumo, no estilo
 * pedido (`mind_map_style`), com o mapa de agora à vista até o novo ficar
 * pronto (server/mapa-mental-guardado.ts). O novo substitui a edição, o que a
 * tela avisa antes (server/fila-do-resumo.ts, gravarMapa). Ele gasta uma vaga
 * do teto comum de pedidos à IA e uma do teto do refazer
 * (REFAZERES_DO_MAPA_POR_JANELA), que o router reserva.
 *
 * Cada mudança é uma transação: a reunião travada primeiro (a ordem da fila do
 * resumo), pela reuniaoVisivel() (a reunião na lixeira é "não encontrada"),
 * depois a linha do resumo, a revisão conferida e a auditoria por insert
 * direto, que lança: sem a linha da auditoria, nada muda. A auditoria leva o
 * tipo, as contagens, o estilo e a revisão, nunca os rótulos (são a fala das
 * pessoas). Só a dona edita: o link aberto só lê.
 */

const MENSAGEM_REUNIAO_NAO_ENCONTRADA = "Reunião não encontrada.";

type CodigoTrpc = "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" | "BAD_REQUEST";

/** A recusa: o código do tRPC e, na mensagem, o código que a tela traduz. */
export class RecusaDoMapa extends Error {
  constructor(readonly codigoTrpc: CodigoTrpc, codigo: CodigoDaRecusaDoMapa | typeof MENSAGEM_REUNIAO_NAO_ENCONTRADA) {
    super(codigo);
  }
}

/** Quem pediu, para a auditoria. */
export type ProvaDoMapa = { userId: number; ipAddress: string; userAgent: string | null | undefined };

export type PedidoDoMapa =
  | { tipo: "salvar"; revisao: number; mapa: unknown }
  | { tipo: "voltar"; revisao: number };

export type MapaMudado = { mudou: boolean; revisao: number; editado: boolean };

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof exigirDb>>["transaction"]>[0]>[0];

async function linhaTravada(tx: Tx, ownerId: string, meetingId: string) {
  const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).for("update");
  if (!reuniao) throw new RecusaDoMapa("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  if (reuniao.status !== "ready") throw new RecusaDoMapa("PRECONDITION_FAILED", RECUSAS_DO_MAPA.semMapa);
  const [linha] = await tx.select({
    id: meetingSummaries.id,
    status: meetingSummaries.status,
    mindMap: meetingSummaries.mindMap,
    mindMapStatus: meetingSummaries.mindMapStatus,
    mindMapEdited: meetingSummaries.mindMapEdited,
    mindMapRevision: meetingSummaries.mindMapRevision,
    mindMapStyle: meetingSummaries.mindMapStyle,
    mindMapPreviousStyle: meetingSummaries.mindMapPreviousStyle,
  }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).for("update");
  return linha;
}

function auditoria(prova: ProvaDoMapa, acao: string, meetingId: string, details: Record<string, unknown>) {
  return {
    userId: prova.userId,
    action: acao,
    resource: "meetings",
    resourceId: meetingId,
    details,
    // Os mesmos cortes do createAuditLog (server/security.ts).
    ipAddress: prova.ipAddress.split(",")[0].trim().substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
    status: "success" as const,
    riskLevel: "low" as const,
  };
}

/**
 * A dona salva o mapa que editou, ou volta ao da IA. O mapa só se edita
 * pronto: na fila (a IA está refazendo) é REFAZENDO, sem mapa é SEM_MAPA. O
 * mapa salvo igual ao da IA volta a ser o da IA (a coluna da edição sai); o
 * igual ao de agora não grava nem entra na auditoria.
 */
export async function mudarMapaDaDona(ownerId: string, meetingId: string, pedido: PedidoDoMapa, prova: ProvaDoMapa): Promise<MapaMudado> {
  let novo: ReturnType<typeof conferirMapaEditado> | null = null;
  if (pedido.tipo === "salvar") {
    novo = conferirMapaEditado(pedido.mapa);
    if (!novo.ok) throw new RecusaDoMapa("BAD_REQUEST", novo.codigo);
  }
  const db = await exigirDb();
  return db.transaction(async tx => {
    const linha = await linhaTravada(tx, ownerId, meetingId);
    const daIA = linha ? conferirMapaMental(linha.mindMap) : null;
    const editadoAgora = linha ? conferirMapaMental(linha.mindMapEdited) : null;
    if (!linha || (!daIA && !editadoAgora)) throw new RecusaDoMapa("PRECONDITION_FAILED", RECUSAS_DO_MAPA.semMapa);
    if (linha.mindMapStatus === "pending") throw new RecusaDoMapa("CONFLICT", RECUSAS_DO_MAPA.refazendo);
    const revisaoDeAgora = Number(linha.mindMapRevision);
    if (revisaoDeAgora !== pedido.revisao) throw new RecusaDoMapa("CONFLICT", RECUSAS_DO_MAPA.mudou);

    // O que fica na coluna da edição: null é "o da IA".
    let editado: typeof editadoAgora;
    if (pedido.tipo === "voltar") {
      editado = null;
    } else {
      const mapa = (novo as { ok: true; mapa: NonNullable<typeof editadoAgora> }).mapa;
      editado = daIA && mesmoMapa(mapa, daIA) ? null : mapa;
    }
    const igual = editado === null ? editadoAgora === null : editadoAgora !== null && mesmoMapa(editado, editadoAgora);
    // Sem o da IA (a árvore guardada deixou de passar na conferência), voltar não tem para onde.
    if (editado === null && !daIA) throw new RecusaDoMapa("PRECONDITION_FAILED", RECUSAS_DO_MAPA.semMapa);
    if (igual) return { mudou: false, revisao: revisaoDeAgora, editado: editadoAgora !== null };

    const agora = Date.now();
    const revisao = revisaoDeAgora + 1;
    await tx.update(meetingSummaries).set({
      mindMapEdited: editado, mindMapEditedAt: editado ? agora : null, mindMapRevision: revisao, updatedAt: agora,
    }).where(and(eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId)));
    await tx.insert(auditLogs).values(auditoria(prova, ACAO_MAPA_EDITADO, meetingId, {
      operacao: pedido.tipo,
      // Só contagens: os rótulos são a fala das pessoas.
      ramos: editado ? editado.ramos.length : daIA!.ramos.length,
      nos: nosDoMapa(editado ?? daIA!),
      revisao,
      voltouAoDaIA: editado === null,
    }));
    return { mudou: true, revisao, editado: editado !== null };
  });
}

/**
 * "Refazer em outro estilo": o mapa volta à fila do resumo no estilo pedido.
 * Precisa do resumo pronto e de um mapa pronto ou que falhou (sem mapa, o
 * caminho é o "Gerar mapa mental"), da transcrição e da revisão que a tela
 * viu. `antesDeGastar` reserva as vagas dos tetos e devolve como soltá-las: o
 * pedido recusado aqui dentro não gasta. A edição de agora fica guardada até o
 * mapa novo chegar, e segue à vista se a IA falhar.
 */
export async function refazerMapaNoEstilo(
  ownerId: string, meetingId: string, pedido: { revisao: number; estilo: EstiloDoMapa }, prova: ProvaDoMapa,
  antesDeGastar: () => (() => void),
): Promise<{ revisao: number }> {
  const db = await exigirDb();
  const soltar = antesDeGastar();
  try {
    return await db.transaction(async tx => {
      const linha = await linhaTravada(tx, ownerId, meetingId);
      if (!linha || linha.status !== "ready" || !(linha.mindMapStatus === "ready" || linha.mindMapStatus === "failed")) {
        if (linha?.mindMapStatus === "pending") throw new RecusaDoMapa("CONFLICT", RECUSAS_DO_MAPA.refazendo);
        throw new RecusaDoMapa("PRECONDITION_FAILED", RECUSAS_DO_MAPA.semMapa);
      }
      if (Number(linha.mindMapRevision) !== pedido.revisao) throw new RecusaDoMapa("CONFLICT", RECUSAS_DO_MAPA.mudou);
      const [transcricao] = await tx.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
        .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
      if (!transcricao) throw new RecusaDoMapa("PRECONDITION_FAILED", RECUSAS_DO_MAPA.semMapa);

      const agora = Date.now();
      const revisao = Number(linha.mindMapRevision) + 1;
      // O estilo do mapa que segue à vista até o novo chegar: o do mapa pronto,
      // ou, se o refazer anterior falhou, o do mapa de antes dele.
      const estiloAVista = linha.mindMapStatus === "failed" && linha.mindMapPreviousStyle ? linha.mindMapPreviousStyle : linha.mindMapStyle ?? "overview";
      await tx.update(meetingSummaries).set({
        mindMapPreviousStyle: estiloAVista,
        mindMapStyle: pedido.estilo, mindMapStatus: "pending", mindMapError: null,
        attempts: 0, lockedUntil: null, lockToken: null, mindMapRevision: revisao, updatedAt: agora,
      }).where(and(
        eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId), eq(meetingSummaries.status, "ready"),
        or(eq(meetingSummaries.mindMapStatus, "ready"), eq(meetingSummaries.mindMapStatus, "failed"), isNull(meetingSummaries.mindMapStatus)),
      ));
      await tx.insert(auditLogs).values(auditoria(prova, ACAO_MAPA_REFEITO, meetingId, {
        estilo: pedido.estilo,
        estiloAnterior: estiloAVista,
        tinhaEdicao: conferirMapaMental(linha.mindMapEdited) !== null,
        revisao,
      }));
      return { revisao };
    });
  } catch (erro) {
    soltar();
    throw erro;
  }
}
