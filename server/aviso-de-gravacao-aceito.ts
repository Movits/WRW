import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { MENSAGEM_AVISO_DE_GRAVACAO_NAO_ACEITO, VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { recordingNoticeAcceptances } from "../drizzle/schema";
import { exigirDb } from "./db";

/**
 * O aceite do aviso de gravação na CONTA (gravar com um toque, decisão do
 * Roberto de 26/11/2026, no estilo do HiNoter): o aviso de gravação
 * (meetings.consentNotice) aparece só na primeira vez que a dona grava, e de
 * novo uma vez quando a versão vigente muda (shared/aviso-de-gravacao.ts). O
 * aceite fica no servidor, uma linha por (dona, versão), para valer em todo
 * aparelho, e não só no navegador.
 *
 * Cada reunião continua com o próprio registro do aviso (consent_granted,
 * consent_at e consent_notice_version, PR #193): o início da gravação só cria
 * a reunião com uma versão que a dona aceitou aqui (conferirAvisoAceito), então
 * a linha da reunião prova que a dona tinha aceitado o aviso daquela versão
 * quando gravou.
 */

export type QuemAceita = { ipAddress: string; userAgent: string | undefined };

/** O estado do aviso vigente para a dona: aceito (com a data) ou ainda não. */
export async function estadoDoAvisoDeGravacao(ownerId: string): Promise<{ versaoVigente: string; aceitoEm: number | null }> {
  const aceitoEm = await quandoAceitou(ownerId, VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO);
  return { versaoVigente: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, aceitoEm };
}

async function quandoAceitou(ownerId: string, versao: string): Promise<number | null> {
  const db = await exigirDb();
  const [linha] = await db.select({ createdAt: recordingNoticeAcceptances.createdAt }).from(recordingNoticeAcceptances)
    .where(and(eq(recordingNoticeAcceptances.ownerId, ownerId), eq(recordingNoticeAcceptances.versaoDoAviso, versao)))
    .limit(1);
  return linha ? Number(linha.createdAt) : null;
}

/**
 * Registra o aceite da versão vigente. Repetido (duas abas, o duplo toque), não
 * cria outra linha nem muda a data do primeiro aceite: o índice único (dona,
 * versão) segura, e o ON DUPLICATE KEY não troca nada.
 */
export async function aceitarAvisoDeGravacao(ownerId: string, dados: { idioma?: string | null; quem?: QuemAceita; agora?: number }): Promise<{ versao: string; aceitoEm: number }> {
  const db = await exigirDb();
  const agora = dados.agora ?? Date.now();
  await db.insert(recordingNoticeAcceptances).values({
    id: crypto.randomUUID(),
    ownerId,
    versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO,
    idioma: dados.idioma ? dados.idioma.substring(0, 12) : null,
    ipAddress: dados.quem ? dados.quem.ipAddress.substring(0, 45) : null,
    userAgent: dados.quem?.userAgent ? dados.quem.userAgent.substring(0, 500) : null,
    createdAt: agora,
  }).onDuplicateKeyUpdate({ set: { ownerId } });
  const aceitoEm = await quandoAceitou(ownerId, VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO);
  return { versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO, aceitoEm: aceitoEm ?? agora };
}

/**
 * Antes de a reunião nascer com uma versão do aviso: a dona precisa ter aceitado
 * essa versão na conta. Sem versão (a aba de antes do aviso versionado), nada a
 * conferir, como antes. Recusa com PRECONDITION_FAILED e a frase de
 * shared/aviso-de-gravacao.ts, que a tela traduz.
 */
export async function conferirAvisoAceito(ownerId: string, versao: string | null | undefined): Promise<void> {
  if (!versao) return;
  if (await quandoAceitou(ownerId, versao) !== null) return;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_AVISO_DE_GRAVACAO_NAO_ACEITO });
}
