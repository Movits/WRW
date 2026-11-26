import { z } from "zod";
import { TEXTO_DO_CONSENTIMENTO_DE_VOZ_MAX, TAMANHO_MAXIMO_DA_AMOSTRA } from "@shared/perfil-de-voz";
import { protectedProcedure, router } from "../_core/trpc";
import { ipDaCliente } from "../ip-da-cliente";
import { desligarPerfilDeVoz, estadoDoPerfilDeVoz, gravarPerfilDeVoz, ouvirPerfilDeVoz } from "../perfil-de-voz";

/**
 * O perfil de voz da dona no Perfil (H3d; regra em server/perfil-de-voz.ts e
 * shared/perfil-de-voz.ts). Só a conta da sessão, pelo openId dela: nenhum
 * procedimento recebe o id de outra conta, e nenhum é público. A recusa sai
 * como CÓDIGO (RECUSAS_DO_PERFIL_DE_VOZ), que a tela traduz.
 */
const quemPede = (ctx: { req: Parameters<typeof ipDaCliente>[0] }) => ({ ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] });

export const perfilDeVozRouter = router({
  /** Tem perfil? Com a duração e as datas; nunca a chave do bucket. */
  estado: protectedProcedure.query(({ ctx }) => estadoDoPerfilDeVoz(ctx.user.openId)),

  /** Grava ou regrava a amostra. A primeira gravação exige o consentimento da caixa (desmarcada por padrão). */
  gravar: protectedProcedure
    .input(z.object({
      // O base64 de 1 MB, com folga para o cabeçalho do FileReader.
      audioBase64: z.string().min(1).max(Math.ceil(TAMANHO_MAXIMO_DA_AMOSTRA / 3) * 4 + 200),
      mimeType: z.string().max(40),
      duracaoMs: z.number().int().nonnegative(),
      consentimento: z.object({
        versaoDoTexto: z.string().max(40),
        idioma: z.string().max(12),
        textoExibido: z.string().max(TEXTO_DO_CONSENTIMENTO_DE_VOZ_MAX),
      }).optional(),
    }))
    .mutation(({ ctx, input }) => gravarPerfilDeVoz(ctx.user.openId, input, quemPede(ctx))),

  /** A amostra para a dona ouvir (só ela). Mutação para não ficar no cache do React Query. */
  ouvir: protectedProcedure.mutation(({ ctx }) => ouvirPerfilDeVoz(ctx.user.openId)),

  /** Desliga: a amostra sai do bucket com todas as versões, a linha sai e a revogação fica registrada. */
  desligar: protectedProcedure.mutation(({ ctx }) => desligarPerfilDeVoz(ctx.user.openId, quemPede(ctx))),
});
