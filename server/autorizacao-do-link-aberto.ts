import { and, desc, eq } from "drizzle-orm";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { auditLogs } from "../drizzle/schema";
import type { exigirDb } from "./db";

/**
 * A confirmação que a dona dá ao ligar o link aberto da reunião, lida da prova
 * que ela deixa em `audit_logs`. Mora à parte de link-aberto-da-reuniao.ts
 * porque o detalhe da dona (getPrivateMeeting, em meeting-service.ts) também a
 * lê, e link-aberto-da-reuniao.ts já importa de meeting-service.ts: no mesmo
 * arquivo, os dois módulos se importariam um ao outro.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** Ação gravada em `audit_logs` a cada vez que a dona liga o link, com a confirmação dela. */
export const ACAO_LINK_LIGADO = "MEETING_OPEN_LINK_ON";

/**
 * Se quem tem o link vê os nomes que a dona deu às vozes (H3b, decisão do
 * Roberto de 16/11/2026): só quando a última vez que ela ligou o link foi com a
 * confirmação que fala dos nomes (a versão 2). A linha de antes da H3b não tem
 * a versão e vale 1, como a falta de linha: o link ligado antes segue com
 * "Falante n" até a dona desligar e ligar de novo, porque a confirmação daquele
 * dia não falava dos nomes.
 *
 * A linha mais nova é a prova do que a dona confirmou por último. Só a dona
 * grava essa ação, e só sobre reunião dela (ligarLinkAberto confere a dona
 * antes do insert): a ação e o id da reunião bastam para achar a linha. O
 * índice da ação (audit_action_idx) restringe a busca às linhas de ligar link.
 * Banco fora do ar sobe como erro, nunca vira "sem nomes".
 */
export async function linkMostraOsNomes(db: Banco, meetingId: string): Promise<boolean> {
  const [linha] = await db.select({ details: auditLogs.details }).from(auditLogs)
    .where(and(eq(auditLogs.action, ACAO_LINK_LIGADO), eq(auditLogs.resourceId, meetingId)))
    // O id cresce a cada insert: desempata duas linhas do mesmo segundo.
    .orderBy(desc(auditLogs.id))
    .limit(1);
  const detalhes = linha?.details;
  if (!detalhes || typeof detalhes !== "object") return false;
  return (detalhes as { versaoDaAutorizacao?: unknown }).versaoDaAutorizacao === VERSAO_DA_AUTORIZACAO_COM_NOMES;
}
