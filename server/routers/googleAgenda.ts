import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { desconectarGoogleAgenda, estadoDaGoogleAgenda } from "../google-agenda";
import { configuracaoDaGoogleAgendaPara } from "../google-oauth";
import { ipDaCliente } from "../ip-da-cliente";

/**
 * A conexão com a Google Agenda na tela do Perfil (H16b do plano do gravador).
 * Conectar não passa por aqui: é a navegação para /api/google-agenda/conectar
 * (server/rotas-da-google-agenda.ts). Só a conta da sessão, e nenhum
 * procedimento público.
 *
 * A recusa sai com o código do tRPC, e a tela escolhe a frase no idioma de quem
 * lê (client/src/components/ConexaoGoogleAgenda.tsx); a frase daqui fica para o log.
 */
export const MENSAGEM_GOOGLE_AGENDA_INDISPONIVEL = "A conexão com a Google Agenda não está disponível.";

export const googleAgendaRouter = router({
  /**
   * Disponível (as cinco variáveis no ambiente, com a conta em
   * GOOGLE_AGENDA_LIBERADA_PARA), conectada, com que conta e se parou de funcionar.
   */
  estado: protectedProcedure.query(({ ctx }) => estadoDaGoogleAgenda(ctx.user.id)),

  /** Revoga na Google, apaga a conexão e grava a prova, na mesma transação. */
  desconectar: protectedProcedure.mutation(({ ctx }) => {
    // Sem as variáveis, ou com a conta fora da lista, a função some também
    // aqui: a seção do Perfil nem aparece.
    if (!configuracaoDaGoogleAgendaPara(ctx.user.id)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_GOOGLE_AGENDA_INDISPONIVEL });
    return desconectarGoogleAgenda(ctx.user.id, { ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] });
  }),
});
