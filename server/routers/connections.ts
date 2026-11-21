import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { goldProcedure } from "./_procedures";
import { exigirDb } from "../db";
import { ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { exigirTextoSemContato } from "../bloqueio-de-contato";
import { users } from "../../drizzle/schema";
import { veAsConexoesSugeridas } from "@shared/qualificacao-do-perfil";
// U3: a frase mora em shared/const.ts para a tela a traduzir (client/src/lib/mensagem-de-erro.ts).
import { MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO } from "@shared/const";

// ============================================================
// CONEXÕES ENTRE USUÁRIOS
// ============================================================

/**
 * A trilha da revelação: duas linhas, uma por parte.
 *
 * É a travessia NOMINAL entre duas donas — a partir daqui cada uma sabe o nome da
 * outra —, do mesmo naipe do `GOLD_ACERVO_READ` do acervo Ouro, e pelo mesmo
 * motivo: "quem passou a saber quem eu sou?" precisa ter resposta. Como a
 * revelação é simétrica, a trilha também é: `audit_userId_idx` faz a busca por
 * pessoa ser barata, e cada linha aponta a contraparte.
 *
 * Gravada só no instante em que o status vira `accepted`, nunca a cada leitura da
 * lista — senão a trilha vira ruído e a consulta ganha escrita.
 *
 * `via` diz quem virou a chave: a destinatária aceitando, o segundo clique do
 * interesse mútuo, ou o distribuidor aprovando um pedido que já era recíproco
 * (routers/distribuicao.ts).
 */
export async function registrarRevelacao(
  connectionId: number | null,
  umLado: number,
  outroLado: number,
  via: "aceite" | "interesse_mutuo" | "distribuidor",
) {
  const { createAuditLog } = await import("../security");
  const resourceId = connectionId === null ? undefined : String(connectionId);
  for (const [quem, contraparte] of [[umLado, outroLado], [outroLado, umLado]] as const) {
    await createAuditLog({
      userId: quem,
      action: "MATCH_IDENTITY_REVEALED",
      resource: "connections",
      resourceId,
      details: { contraparte, via },
      status: "success",
      riskLevel: "medium",
    });
  }
}

/**
 * O aviso do interesse mútuo, com as frases pedidas pela cliente (grupo, 14/09/2026:
 * "match" passou a ser "conexão" em toda a plataforma). Um texto só para os três
 * caminhos que revelam os nomes: o aceite da destinatária, o segundo clique em
 * "Demonstrar Interesse" sobre pedido já encaminhado e a aprovação, pelo
 * distribuidor, de um pedido que já era recíproco. Sem nome no corpo: quem é a
 * outra pessoa, a aba Conexões mostra. Falha no sino não desfaz a conexão.
 */
export const AVISO_DE_NOVA_CONEXAO = {
  title: "Nova conexão!",
  body: "Vocês criaram uma conexão! Os nomes já aparecem na aba Conexões.",
} as const;

export async function avisarNovaConexao(userIds: number[]) {
  try {
    const { createNotification } = await import("../db");
    for (const userId of userIds) {
      await createNotification({ userId, type: "interest_received", ...AVISO_DE_NOVA_CONEXAO, actionUrl: "/dashboard" });
    }
  } catch (_) { /* a conexão já está gravada; o sino é acessório */ }
}

/**
 * O pedido novo nasce esperando o distribuidor. Aviso no sino de quem distribui
 * (menos a própria solicitante: ninguém decide o próprio pedido); sem nenhum
 * distribuidor ativo, a presidência é avisada de que há pedido esperando. O
 * corpo não diz QUEM pediu nem para quem — a fila é que mostra, com auditoria.
 * Falha no aviso não desfaz o pedido, que já está gravado.
 */
async function avisarQuemDistribui(solicitanteId: number) {
  try {
    const { idsDosDistribuidoresAtivos, idsDaPresidenciaAtiva, createNotification } = await import("../db");
    const distribuidores = (await idsDosDistribuidoresAtivos()).filter(id => id !== solicitanteId);
    const haDistribuidor = distribuidores.length > 0;
    const destinatarios = haDistribuidor ? distribuidores : (await idsDaPresidenciaAtiva()).filter(id => id !== solicitanteId);
    const aviso = haDistribuidor
      ? {
        title: "Pedido de interesse para analisar",
        body: "Um pedido de interesse do Smart Match está esperando a sua conferência na fila de distribuição.",
      }
      : {
        title: "Pedido de interesse esperando sem distribuidor",
        body: "Um pedido de interesse do Smart Match ficou esperando e nenhum distribuidor está ativo. Conceda o poder de distribuição no Painel Ouro, aba Distribuição.",
      };
    for (const userId of destinatarios) {
      await createNotification({ userId, type: "system", ...aviso, actionUrl: "/president" });
    }
  } catch (_) { /* o pedido já está gravado; o sino é acessório */ }
}

export const connectionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { getConnectionsForUser } = await import("../db");
    return getConnectionsForUser(ctx.user.id);
  }),

  // Demonstrar interesse pelo CARTÃO, não pela pessoa: a entrada é o `matchId`,
  // que o navegador já recebia para dispensar. O `targetUserId` saiu porque ele
  // era um id real aceito sem conferência nenhuma — qualquer conta podia pedir
  // conexão a qualquer usuária e, com o `list` de antes, ler nome e empresa da
  // base inteira. O bilhete também saiu: ele é texto livre e o bloqueio A13 barra
  // telefone e e-mail, não nome, então atravessaria o anonimato numa linha.
  send: protectedProcedure
    .input(z.object({ matchId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      // U3: a Bronze não vê os cartões (matches.list sai vazio para ela), e o
      // interesse por um cartão que ela não vê também espera o cadastro
      // completo — senão um `matchId` adivinhado furaria a trava pela API e
      // revelaria o nome com o aceite. Antes do banco: nada é lido nem gravado.
      // O pedido que ela RECEBE continua respondível (`respond`), como antes.
      if (!veAsConexoesSugeridas(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO });
      }
      const { resolverAlvoDoMatch, sendConnectionRequest } = await import("../db");
      const { createAuditLog } = await import("../security");
      const alvo = await resolverAlvoDoMatch(ctx.user.id, input.matchId);
      if (alvo == null) {
        // Tentativa de agir por uma alça que não é desta usuária: registrar, para
        // que varredura de `matchId` não seja silenciosa.
        await createAuditLog({
          userId: ctx.user.id, action: "MATCH_HANDLE_INVALID", resource: "connections.send",
          resourceId: String(input.matchId), status: "blocked", riskLevel: "high",
        });
        throw new TRPCError({ code: "NOT_FOUND", message: "Conexão sugerida não encontrada" });
      }
      // Etapa 11 de novo, aqui: uma lista velha aberta no navegador não pode
      // furar a revogação do termo feita depois que ela carregou.
      const { usersComConsentimento } = await import("./consent");
      const comTermo = await usersComConsentimento([alvo], "termo_smart_match");
      if (!comTermo.has(alvo)) throw new TRPCError({ code: "NOT_FOUND", message: "Conexão sugerida não encontrada" });
      // E a CONTA do alvo tem de estar ativa, como no `respond`. Este clique
      // também é um aceite quando o alvo já tinha pedido e o pedido foi
      // encaminhado: sem esta linha, o caminho do "Demonstrar interesse"
      // revelava os dois nomes de uma conta desativada, enquanto o botão
      // "Aceitar e revelar" recusava — a mesma conexão com duas portas de
      // travas diferentes (achado da revisão de privacidade de 16/09).
      const { idsDeContasAtivas } = await import("../db");
      const ativas = await idsDeContasAtivas([alvo]);
      if (!ativas.has(alvo)) throw new TRPCError({ code: "NOT_FOUND", message: "Conexão sugerida não encontrada" });

      const resultado = await sendConnectionRequest(ctx.user.id, alvo);
      if (resultado.revelou) {
        await registrarRevelacao(resultado.connectionId, ctx.user.id, alvo, "interesse_mutuo");
        // Quem clicou vê o resultado na tela; o sino avisa a outra parte.
        await avisarNovaConexao([alvo]);
      }
      // Pedido novo: fica em análise até o distribuidor conferir e encaminhar.
      // A destinatária não é avisada aqui — ela só fica sabendo se for encaminhado.
      if (resultado.emAnalise) await avisarQuemDistribui(ctx.user.id);
      // Resposta IGUAL em todos os casos que não são erro: pedido novo, pedido
      // repetido, em análise, não encaminhado, recusado ou bloqueado. Antes, o
      // `CONFLICT` distinguível dizia a quem perguntasse que aquela pessoa já
      // tinha recusado.
      return { success: true, revelou: resultado.revelou };
    }),

  respond: protectedProcedure
    .input(z.object({
      connectionId: z.number().int(),
      accept: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { respondToConnection, lerPedidoDeMatch, idsDeContasAtivas } = await import("../db");
      if (input.accept) {
        // As travas do `distribuicao.decidir`, lidas de novo no aceite (revisão
        // do Nicolas na #136): depois de o pedido ser encaminhado, quem pediu
        // pode ter revogado o termo do Smart Match — `consent.revoke` só grava
        // `revokedAt` e não mexe no pedido — ou ter tido a conta desativada; e
        // quem aceita pode ter revogado o dela. A linha `pending` continua
        // aparecendo na aba Conexões, porque `connections.list` não olha o termo.
        // Sem esta trava, o aceite revelava os dois nomes de quem já tinha
        // tirado o consentimento, e ainda avisava a pessoa.
        //
        // Só roda para a destinatária de um pedido `pending`: id alheio ou linha
        // em outro estado seguem para o banco e recebem o mesmo "nada mudou" de
        // sempre, sem virar oráculo. A recusa não revela nada e segue livre.
        const pedido = await lerPedidoDeMatch(input.connectionId);
        if (pedido && pedido.recipientId === ctx.user.id && pedido.status === "pending") {
          const { usersComConsentimento } = await import("./consent");
          const comTermo = await usersComConsentimento([pedido.requesterId, ctx.user.id], "termo_smart_match");
          if (!comTermo.has(ctx.user.id)) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Autorize o termo do Smart Match para aceitar e revelar os nomes." });
          }
          // A conta de quem aceita está ativa: o sdk recusa sessão de conta desativada.
          const ativas = await idsDeContasAtivas([pedido.requesterId]);
          if (!comTermo.has(pedido.requesterId) || !ativas.has(pedido.requesterId)) {
            // Erro, e não o `success` de sempre: a tela diria "Conexão aceita"
            // sem nada ter sido aceito. O pedido pendente é anônimo, então a
            // mensagem não conta a quem aceita quem saiu.
            throw new TRPCError({ code: "NOT_FOUND", message: "Este pedido não está mais disponível." });
          }
        }
      }
      const resultado = await respondToConnection(input.connectionId, ctx.user.id, input.accept);
      if (resultado.revelou && resultado.contraparte !== null) {
        await registrarRevelacao(input.connectionId, ctx.user.id, resultado.contraparte, "aceite");
        // Quem aceitou vê o resultado na tela; o sino avisa a solicitante.
        await avisarNovaConexao([resultado.contraparte]);
      }
      return { success: true };
    }),

  // Mensagens diretas (apenas Ouro)
  getMessages: goldProcedure
    .input(z.object({ recipientId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await exigirDb();
      const { directMessages } = await import("../../drizzle/schema");
      const { or } = await import("drizzle-orm");
      const rows = await db.select().from(directMessages)
        .where(
          or(
            and(eq(directMessages.senderId, ctx.user.id), eq(directMessages.recipientId, input.recipientId)),
            and(eq(directMessages.senderId, input.recipientId), eq(directMessages.recipientId, ctx.user.id))
          )
        )
        .orderBy(directMessages.createdAt)
        .limit(100);
      // Map encryptedContent -> content for frontend compatibility
      return rows.map(r => ({ ...r, content: r.encryptedContent }));
    }),

  sendMessage: goldProcedure
    .input(z.object({
      recipientId: z.number().int(),
      content: z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      // A13: mensagem direta é o canal mais óbvio para trocar contato.
      await exigirTextoSemContato(ctx.user.id, "connections.sendMessage", input.content, input.recipientId);
      const db = await exigirDb();
      const { directMessages } = await import("../../drizzle/schema");
      await db.insert(directMessages).values({
        senderId: ctx.user.id,
        recipientId: input.recipientId,
        encryptedContent: input.content, // stored as plaintext for now
      });
      return { success: true };
    }),

  getConversations: goldProcedure.query(async ({ ctx }) => {
    const db = await exigirDb();
    const { directMessages } = await import("../../drizzle/schema");
    const { or, max, count } = await import("drizzle-orm");
    // Buscar todas as pessoas com quem o usuário trocou mensagens
    const sent = await db.selectDistinct({ userId: directMessages.recipientId })
      .from(directMessages).where(eq(directMessages.senderId, ctx.user.id));
    const received = await db.selectDistinct({ userId: directMessages.senderId })
      .from(directMessages).where(eq(directMessages.recipientId, ctx.user.id));
    const allIds = [...sent.map(r => r.userId), ...received.map(r => r.userId)];
    const userIds = allIds.filter((id, i) => id !== null && allIds.indexOf(id) === i) as number[];
    if (userIds.length === 0) return [];
    const otherUsers = await db.select({ id: users.id, name: users.name, role: users.role })
      .from(users).where(sql`${users.id} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`);
    return otherUsers.map(u => ({ userId: u.id, otherUser: u, lastMessage: null, unread: 0 }));
  }),

  getGroups: goldProcedure.query(async ({ ctx }) => {
    // Retornar grupos estratégicos (tabela strategic_groups se existir).
    // O catch existe para a TABELA AUSENTE não derrubar a tela; a queda real do
    // banco chega pela mesma consulta, como erro de conexão do driver, e essa
    // não pode virar "nenhum grupo": sobe para o middleware traduzir.
    const db = await exigirDb();
    try {
      const { strategicGroups } = await import("../../drizzle/schema");
      return await db.select().from(strategicGroups).limit(50);
    } catch (erro) {
      if (ehErroDeBancoIndisponivel(erro)) throw erro;
      return [];
    }
  }),
});
