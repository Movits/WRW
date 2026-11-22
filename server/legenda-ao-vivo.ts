import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { RECUSAS_DA_LEGENDA, type VersaoDoAvisoDaLegenda } from "@shared/legenda-ao-vivo";
import { auditLogs, meetings } from "../drizzle/schema";
import { exigirDb } from "./db";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";

/**
 * A legenda ao vivo do gravador (G15b; regra em shared/legenda-ao-vivo.ts). O
 * reconhecimento de voz é do navegador da dona, e o texto da legenda nunca
 * chega aqui: o servidor só guarda a PROVA de que, antes de ligar, ela viu o
 * aviso (no Chrome, o áudio costuma ir a um servidor do Google; a legenda não
 * separa quem fala e não fica guardada) e confirmou que as pessoas da reunião
 * concordam.
 *
 * A prova vai em `audit_logs` numa transação com a leitura travada da reunião,
 * por insert direto que lança (o `createAuditLog` engole o erro): sem a linha,
 * a tela não liga a legenda. Como no link aberto (server/link-aberto-da-reuniao.ts),
 * a linha guarda o texto que a dona viu, o idioma dele e o hash: o aviso vai
 * mudar com a revisão da Cris, e a prova de uma gravação antiga tem de dizer o
 * que foi confirmado naquele dia.
 *
 * Só a reunião da dona que está gravando: a de outra conta, a excluída e a que
 * não existe são NOT_FOUND, com a mesma frase; a que já não grava é recusada
 * com o código, que a tela traduz.
 */

/** Ação gravada em `audit_logs` a cada vez que a dona liga a legenda numa gravação, com a confirmação dela. */
export const ACAO_LEGENDA_LIGADA = "MEETING_LIVE_CAPTION_ON";

/** A palavra da dona ao ligar a legenda, como vai para a auditoria. */
export type ProvaDaLegenda = {
  userId: number;
  ipAddress: string;
  userAgent: string | undefined;
  versaoDoAviso: VersaoDoAvisoDaLegenda;
  /** O idioma da tela em que o aviso foi mostrado. */
  idioma: string;
  /** O aviso que a dona viu, com a caixa que ela marcou, como apareceu na tela. */
  textoExibido: string;
};

/**
 * A reunião que a dona ainda vê: o ponto único desta consulta. A regra da
 * lixeira (H7d, parte 1 do Pacote 5b) entra aqui, trocando esta condição pela
 * `reuniaoVisivel()` de server/reuniao-visivel.ts, sem mexer em quem chama.
 */
function reuniaoQueADonaVe() {
  return ne(meetings.status, "deleted");
}

/**
 * Registra a confirmação da dona antes de a legenda ligar. Lança NOT_FOUND
 * (reunião de outra conta, excluída ou que não existe) ou PRECONDITION_FAILED
 * com RECUSAS_DA_LEGENDA.foraDaGravacao (a reunião não está gravando). Banco
 * fora do ar sobe como erro: o middleware do tRPC o traduz, e a legenda não
 * liga sem a prova.
 */
export async function registrarLegendaLigada(ownerId: string, meetingId: string, prova: ProvaDaLegenda): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoQueADonaVe()))
      .limit(1).for("update");
    if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    // A legenda é da gravação em curso: encerrada (recebendo as últimas partes,
    // processando, pronta) ou com falha, não há o que legendar.
    if (reuniao.status !== "recording") throw new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_LEGENDA.foraDaGravacao });
    await tx.insert(auditLogs).values({
      // Os mesmos cortes do createAuditLog (server/security.ts).
      userId: prova.userId,
      ipAddress: prova.ipAddress.substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      action: ACAO_LEGENDA_LIGADA,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        concordanciaDasPessoas: true,
        versaoDoAviso: prova.versaoDoAviso,
        idioma: prova.idioma,
        textoExibido: prova.textoExibido,
        textoHash: crypto.createHash("sha256").update(prova.textoExibido).digest("hex"),
      },
      status: "success",
      riskLevel: "low",
    });
  });
}
