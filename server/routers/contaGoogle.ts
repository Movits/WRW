import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { configuracaoDaEntradaComGoogle, desligarContaGoogle, estadoDaContaGoogle } from "../entrar-com-google";
import { ipDaCliente } from "../ip-da-cliente";

/**
 * Entrar com a conta Google (A8) nas telas. Entrar, cadastrar e ligar não passam
 * por aqui: são a navegação para /api/entrar-com-google/ir
 * (server/rotas-de-entrar-com-google.ts). As recusas saem com o código
 * (ERRO_DA_CONTA_GOOGLE), e a tela escolhe a frase no idioma de quem lê.
 */
export const contaGoogleRouter = router({
  /**
   * Público: o login e o cadastro mostram o botão só com a função ligada. Leva
   * só a origem pública (o FRONTEND_URL), que o botão usa para começar no host certo.
   */
  disponivel: publicProcedure.query(() => {
    const config = configuracaoDaEntradaComGoogle();
    return config ? { disponivel: true as const, origem: config.origem } : { disponivel: false as const };
  }),

  /**
   * A conta Google ligada à conta da sessão (o e-mail dela, desde quando e se a
   * conta tem senha). Com a função desligada, o estado vem do mesmo jeito (a
   * tela mostra o Desligar a quem tem uma ligada), sem a origem: ligar não começa.
   */
  estado: protectedProcedure.query(async ({ ctx }) => {
    const config = configuracaoDaEntradaComGoogle();
    const estado = await estadoDaContaGoogle(ctx.user.id);
    return config
      ? { disponivel: true as const, origem: config.origem, ...estado }
      : { disponivel: false as const, origem: null, ...estado };
  }),

  /**
   * Desliga a conta Google, com a auditoria na transação. Funciona mesmo com a
   * função desligada: quem ligou pode sempre tirar.
   */
  desligar: protectedProcedure.mutation(async ({ ctx }) => {
    await desligarContaGoogle(ctx.user.id, { ip: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] });
    return { ok: true as const };
  }),
});
