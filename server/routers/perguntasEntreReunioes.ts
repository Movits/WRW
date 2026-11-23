import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { FUSO_MAX } from "@shared/agenda";
import { ETIQUETA_MAX } from "@shared/detalhes-da-reuniao";
import { AVALIACOES_DA_RESPOSTA, REUNIOES_POR_PERGUNTA_MAX } from "@shared/perguntar-a-varias-reunioes";
import { protectedProcedure, router } from "../_core/trpc";
import { MEETING_TRANSCRIPT_LANGUAGES } from "../meeting-service";
import {
  avaliarRespostaEntreReunioes, perguntarAVariasReunioes, RecusaEntreReunioes, reunioesParaPerguntar,
} from "../perguntar-a-varias-reunioes";
import { RecusaDaReuniaoComIA, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { tetoDaIADaReuniao } from "./meetings";

/**
 * O Pergunte a várias reuniões (H6c; server/perguntar-a-varias-reunioes.ts),
 * só para a dona: a lista das reuniões que ela pode escolher, a pergunta e a
 * avaliação da resposta. Num router à parte, e não em routers/meetings.ts:
 * nenhum procedimento daqui recebe UMA reunião pelo id, e quem consulta
 * reuniões passa pelo ponto único da regra de visibilidade
 * (server/reuniao-visivel.ts). Sem a guarda da lixeira (procedimentoDaReuniao):
 * o perguntar está na lista conferida de server/guarda-da-lixeira.test.ts, e
 * a reunião na lixeira escolhida uma a uma sai como VARIAS_REUNIAO_NAO_ENCONTRADA.
 *
 * As recusas saem com o código tRPC e o código da tela
 * (RECUSAS_ENTRE_REUNIOES), que ela traduz; a IA fora do ar sai como
 * SERVICE_UNAVAILABLE, com a mesma frase da pergunta a uma reunião.
 */
async function comRecusaTraduzida<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaEntreReunioes) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
    if (erro instanceof RecusaDaReuniaoComIA) throw new TRPCError({ code: erro.codigo, message: erro.message });
    throw erro;
  }
}

export const perguntasEntreReunioesRouter = router({
  /** As reuniões prontas, com transcrição, que a dona pode escolher. */
  reunioes: protectedProcedure.query(({ ctx }) => reunioesParaPerguntar(ctx.user.openId)),

  /**
   * A pergunta: as reuniões uma a uma (`meetingIds`) ou pela etiqueta, uma das
   * duas. Gasta de 1 a 4 vagas do teto de pedidos à IA da dona (o mesmo da
   * pergunta a uma reunião, pelo tamanho) e conta no teto de 24 h.
   */
  perguntar: protectedProcedure
    .input(z.object({
      meetingIds: z.array(z.string().uuid()).min(1).max(REUNIOES_POR_PERGUNTA_MAX).optional(),
      etiqueta: z.string().trim().min(1).max(ETIQUETA_MAX * 2).optional(),
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
      // O fuso do aparelho: a data de cada reunião vai à IA no dia que a tela mostra.
      fuso: z.string().trim().max(FUSO_MAX).nullish(),
    }).refine(entrada => (entrada.meetingIds === undefined) !== (entrada.etiqueta === undefined), {
      message: "Escolha as reuniões uma a uma ou por etiqueta, uma das duas.",
    }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(() => perguntarAVariasReunioes({
      conta: { id: ctx.user.id, openId: ctx.user.openId },
      escolha: input.etiqueta !== undefined ? { etiqueta: input.etiqueta } : { meetingIds: input.meetingIds ?? [] },
      pergunta: input.pergunta,
      idioma: input.idioma,
      fuso: input.fuso ?? null,
      reservarVaga: () => tetoDaIADaReuniao.reservar(ctx.user.openId),
    }))),

  /** "Ajudou" ou "Não ajudou": só da dona, e avaliar de novo troca a avaliação. */
  avaliar: protectedProcedure
    .input(z.object({ perguntaId: z.string().uuid(), nota: z.enum(AVALIACOES_DA_RESPOSTA) }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(() => avaliarRespostaEntreReunioes(ctx.user.openId, input.perguntaId, input.nota))),
});
