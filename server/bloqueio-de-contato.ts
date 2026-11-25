import { TRPCError } from "@trpc/server";
import { encontrarContatosEmTexto, mascararTrecho } from "@shared/contato-em-texto";
import { createAuditLog } from "./security";

/**
 * A13 — a porta única do bloqueio de contato em texto livre.
 *
 * Recusa a mensagem quando há e-mail/telefone (o servidor não grava nem
 * repassa — critério 1 do cartão) e REGISTRA a tentativa na trilha de
 * auditoria (critério 2), com os trechos mascarados: o registro é o que
 * sustenta a cláusula de non-circumvention da etapa 13.
 */
export async function exigirTextoSemContato(
  userId: number,
  canal: string,
  texto: string | null | undefined,
  // Para quem/para onde o contato iria (id da sala, da destinatária, da
  // oportunidade): sem isso o registro prova a tentativa mas não sustenta a
  // cláusula — "tentou mandar contato PARA QUEM?" precisa ter resposta.
  alvo?: string | number,
): Promise<void> {
  if (!texto) return;
  const achados = encontrarContatosEmTexto(texto);
  if (!achados.length) return;

  await createAuditLog({
    userId,
    action: "CONTACT_EXCHANGE_BLOCKED",
    resource: canal,
    resourceId: alvo === undefined ? undefined : String(alvo),
    details: {
      achados: achados.map(achado => ({ tipo: achado.tipo, trecho: mascararTrecho(achado.trecho) })),
    },
    status: "blocked",
    riskLevel: "medium",
  });

  const tipos = Array.from(new Set(achados.map(achado => (achado.tipo === "email" ? "e-mail" : "telefone"))));
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `Sua mensagem parece conter ${tipos.join(" e ")}. Pelas regras da Marquesa Global Match, dados de contato ` +
      "não circulam entre as partes — as tratativas acontecem pela plataforma, com o consultor " +
      "de negócios. Remova o contato e envie de novo. A tentativa fica registrada.",
  });
}
