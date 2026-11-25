import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "../_core/trpc";
import { presidentProcedure, distribuidorProcedure } from "./_procedures";
import {
  getUserById, listarDistribuidores, definirPoderDeDistribuicao, createNotification,
  listarPedidosEmAnalise, lerPedidoDeMatch, decidirPedidoDeMatch, listarHistoricoDeDistribuicao, idsDeContasAtivas,
} from "../db";
import { createAuditLog } from "../security";
import { avisarNovaConexao, registrarRevelacao } from "./connections";
import { insightParaExibir } from "../vocabulario-da-conexao";
import { mascararContatosEmTexto } from "@shared/contato-em-texto";
import { textoDaOutraNecessidade } from "@shared/o-que-busca";

// ============================================================
// DISTRIBUIÇÃO DO SMART MATCH
// ============================================================
// O distribuidor é a pessoa real que confere cada pedido de interesse (o clique
// em "Demonstrar Interesse") antes de encaminhá-lo à outra pessoa. O poder mora
// em `users.isDistributor` e acumula com qualquer nível: Ouro, presidente ou
// admin concedem e revogam por aqui (regra "Ouro = Presidente = admin"); a fila
// de análise, por sua vez, exige `distribuidorProcedure` (a flag, não o nível).
//
// Idempotência: conceder a quem já tem, ou revogar de quem não tem, responde
// sucesso sem gravar nada — sem auditoria nem notificação repetidas.

const TITULO_CONCEDIDO = "Você agora é distribuidor do Smart Match";
const CORPO_CONCEDIDO =
  "Um membro Ouro da Marquesa Global Match concedeu a você o poder de distribuição: a partir de agora, " +
  "os pedidos de interesse do Smart Match passam pela sua análise antes de chegar à outra pessoa. " +
  "A fila de análise fica no Painel Ouro, na aba Distribuição.";
const TITULO_REVOGADO = "Poder de distribuição revogado";

type PerfilCru = Awaited<ReturnType<typeof listarPedidosEmAnalise>>[number]["solicitante"];

// O que o distribuidor vê de cada parte. Sem id, e-mail, telefone, cofre, foto
// ou links: o que a consulta não seleciona não precisa ser escondido aqui; a bio
// é texto livre da pessoa e sai mascarada contra telefone e e-mail (A13).
function perfilParaAnalise(perfil: PerfilCru) {
  // "Outra necessidade" só vale com a opção marcada (como em necessidadesEscritasDoPerfil) e é texto livre: mascarada como a bio.
  const buscas = Array.isArray(perfil.seekingTypes) ? perfil.seekingTypes.filter((busca): busca is string => typeof busca === "string") : [];
  const outraNecessidade = textoDaOutraNecessidade(buscas, perfil.seekingOtherNeed);
  return {
    ...perfil,
    bio: perfil.bio ? mascararContatosEmTexto(perfil.bio) : null,
    seekingOtherNeed: outraNecessidade ? mascararContatosEmTexto(outraNecessidade) : null,
  };
}

export const distribuicaoRouter = router({
  // ─── O poder (Ouro, presidente ou admin) ───────────────────────────────────
  // Quem distribui hoje. Sem paginação: o poder é raro (uma ou poucas contas).
  listar: presidentProcedure.query(async () => listarDistribuidores()),

  conceder: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const alvo = await getUserById(input.userId);
      if (!alvo) throw new TRPCError({ code: "NOT_FOUND", message: "Conta não encontrada." });
      if (alvo.isDistributor === true) return { success: true as const };

      await definirPoderDeDistribuicao(input.userId, true);
      await createAuditLog({
        userId: ctx.user.id, action: "DISTRIBUTOR_GRANTED", resource: "users", resourceId: String(input.userId),
        details: { reason: input.reason ?? null }, status: "success", riskLevel: "high",
      });
      try {
        await createNotification({
          userId: input.userId, type: "system", title: TITULO_CONCEDIDO, body: CORPO_CONCEDIDO, actionUrl: "/president",
        });
      } catch (_) { /* não bloquear se a notificação falhar; a concessão já valeu */ }
      return { success: true as const };
    }),

  revogar: presidentProcedure
    .input(z.object({
      userId: z.number().int(),
      reason: z.string().min(10).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const alvo = await getUserById(input.userId);
      if (!alvo) throw new TRPCError({ code: "NOT_FOUND", message: "Conta não encontrada." });
      if (alvo.isDistributor !== true) return { success: true as const };

      await definirPoderDeDistribuicao(input.userId, false);
      await createAuditLog({
        userId: ctx.user.id, action: "DISTRIBUTOR_REVOKED", resource: "users", resourceId: String(input.userId),
        details: { reason: input.reason }, status: "success", riskLevel: "high",
      });
      try {
        await createNotification({
          userId: input.userId, type: "system", title: TITULO_REVOGADO,
          body: `Seu poder de distribuição do Smart Match foi revogado por um membro Ouro da Marquesa Global Match. Motivo: ${input.reason}`,
          actionUrl: "/dashboard",
        });
      } catch (_) { /* não bloquear se a notificação falhar */ }
      return { success: true as const };
    }),

  // ─── A fila (só quem tem o poder) ──────────────────────────────────────────
  // Os pedidos `in_review`, com as DUAS partes nomeadas, a nota do Smart Match na
  // direção do pedido e as travas que a aprovação vai reconferir (termo, conta
  // ativa, portão da demanda expressa). É a leitura nominal que atravessa donas,
  // como o acervo Ouro, e por isso fica na trilha de auditoria.
  fila: distribuidorProcedure.query(async ({ ctx }) => {
    const pedidos = await listarPedidosEmAnalise(ctx.user.id);
    const ids = Array.from(new Set(pedidos.flatMap(p => [p.requesterId, p.recipientId])));
    const { usersComConsentimento } = await import("./consent");
    const { matchesBloqueadosPelaDemandaExpressa } = await import("../matching");
    const comTermo = await usersComConsentimento(ids, "termo_smart_match");
    const bloqueados = await Promise.all(pedidos.map(async p =>
      (await matchesBloqueadosPelaDemandaExpressa(p.requesterId, [p.recipientId])).has(p.recipientId),
    ));
    await createAuditLog({
      userId: ctx.user.id, action: "DISTRIBUTOR_VIEW_QUEUE", resource: "connections",
      details: { pedidos: pedidos.length }, status: "success", riskLevel: "medium",
    });
    // Os ids das partes serviram às travas acima e PARAM aqui: a fila age pelo
    // `connectionId`. Lista-branca explícita, como em profileMatches.
    return pedidos.map((p, i) => ({
      connectionId: p.connectionId,
      createdAt: p.createdAt,
      reciprocado: p.reciprocatedAt !== null,
      solicitante: perfilParaAnalise(p.solicitante),
      destinataria: perfilParaAnalise(p.destinataria),
      // O insight do prompt antigo que fala em "match" não vai à tela (14/09: "match" virou "conexão").
      compatibilidade: p.compatibilidade && p.compatibilidade.overallScore !== null
        ? { ...p.compatibilidade, aiInsight: insightParaExibir(p.compatibilidade.aiInsight) }
        : null,
      bloqueadoPeloPortao: bloqueados[i],
      termoOk: { solicitante: comTermo.has(p.requesterId), destinataria: comTermo.has(p.recipientId) },
      ativas: { solicitante: p.solicitante.isActive === true, destinataria: p.destinataria.isActive === true },
    }));
  }),

  // A decisão. Um único UPDATE com `status = 'in_review'` no WHERE: a segunda
  // pessoa (ou a segunda aba) que decide o mesmo pedido leva CONFLICT e não
  // produz efeito nenhum. Aprovar reconfere as travas ANTES do UPDATE: o termo
  // pode ter sido revogado e o perfil pode ter mudado desde o clique.
  decidir: distribuidorProcedure
    .input(z.object({
      connectionId: z.number().int(),
      aprovar: z.boolean(),
      nota: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const pedido = await lerPedidoDeMatch(input.connectionId);
      if (!pedido) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
      if (pedido.requesterId === ctx.user.id || pedido.recipientId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Ninguém decide o próprio pedido de interesse." });
      }
      if (pedido.status !== "in_review") throw new TRPCError({ code: "CONFLICT", message: "Este pedido já foi decidido." });

      const nota = input.nota?.trim() || null;
      if (!input.aprovar && !nota) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Diga por que não encaminhou. A nota fica só na trilha interna." });
      }

      if (input.aprovar) {
        const partes = [pedido.requesterId, pedido.recipientId];
        const { usersComConsentimento } = await import("./consent");
        const comTermo = await usersComConsentimento(partes, "termo_smart_match");
        if (comTermo.size !== 2) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Uma das partes não tem o termo do Smart Match vigente." });
        }
        const ativas = await idsDeContasAtivas(partes);
        if (ativas.size !== 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Uma das contas está inativa." });
        const { matchesBloqueadosPelaDemandaExpressa } = await import("../matching");
        const bloqueados = await matchesBloqueadosPelaDemandaExpressa(pedido.requesterId, [pedido.recipientId]);
        if (bloqueados.has(pedido.recipientId)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "O portão da demanda expressa bloqueia este par: o serviço oferecido não responde a uma necessidade declarada.",
          });
        }
      }

      const statusFinal = !input.aprovar ? "not_forwarded" : pedido.reciprocatedAt !== null ? "accepted" : "pending";
      const decidiu = await decidirPedidoDeMatch(pedido.id, { statusFinal, moderatedBy: ctx.user.id, moderationNote: nota });
      if (!decidiu) throw new TRPCError({ code: "CONFLICT", message: "Outra pessoa acabou de decidir este pedido." });

      await createAuditLog({
        userId: ctx.user.id,
        action: input.aprovar ? "MATCH_REVIEW_APPROVED" : "MATCH_REVIEW_REJECTED",
        resource: "connections", resourceId: String(pedido.id),
        details: {
          requesterId: pedido.requesterId, recipientId: pedido.recipientId,
          reciprocado: pedido.reciprocatedAt !== null, statusFinal, nota,
        },
        status: "success", riskLevel: "medium",
      });
      if (statusFinal === "accepted") {
        await registrarRevelacao(pedido.id, pedido.requesterId, pedido.recipientId, "distribuidor");
      }

      // Avisos no sino. Recusa: só a solicitante, sem o motivo (a nota é interna);
      // a destinatária nunca soube do pedido e continua sem saber.
      try {
        if (statusFinal === "pending") {
          await createNotification({
            userId: pedido.recipientId, type: "interest_received",
            title: "Alguém demonstrou interesse em você",
            body: "Um membro da rede demonstrou interesse no seu perfil pelo Smart Match. Veja o pedido e decida se aceita revelar os nomes.",
            actionUrl: "/dashboard",
          });
          await createNotification({
            userId: pedido.requesterId, type: "system",
            title: "Seu interesse foi encaminhado",
            body: "O distribuidor conferiu a compatibilidade e encaminhou o seu pedido. Seu nome só aparece se a outra pessoa também demonstrar interesse.",
            actionUrl: "/dashboard",
          });
        } else if (statusFinal === "accepted") {
          // As duas partes: nenhuma delas agiu agora, quem virou a chave foi o distribuidor.
          await avisarNovaConexao([pedido.requesterId, pedido.recipientId]);
        } else {
          await createNotification({
            userId: pedido.requesterId, type: "system",
            title: "Interesse não encaminhado",
            body: "O distribuidor conferiu o seu pedido de interesse e não o encaminhou desta vez. A outra pessoa não foi avisada.",
            actionUrl: "/dashboard",
          });
        }
      } catch (_) { /* a decisão já está gravada; o sino é acessório */ }

      return { success: true as const, statusFinal };
    }),

  // As decisões já tomadas (de qualquer distribuidor), com os nomes das partes:
  // leitura nominal, auditada como a fila.
  historico: distribuidorProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const decisoes = await listarHistoricoDeDistribuicao(input.limit);
      await createAuditLog({
        userId: ctx.user.id, action: "DISTRIBUTOR_VIEW_QUEUE", resource: "connections",
        details: { escopo: "historico", decisoes: decisoes.length }, status: "success", riskLevel: "medium",
      });
      return decisoes;
    }),
});
