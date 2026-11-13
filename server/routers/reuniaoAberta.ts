import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { criarTeto } from "../assistente-de-texto";
import { exigirReuniaoDoLink, verReuniaoPeloLink } from "../link-aberto-da-reuniao";
import { MEETING_TRANSCRIPT_LANGUAGES, translatePrivateMeetingTranscript } from "../meeting-service";
import { perguntarAReuniao, resumirReuniao, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { comRecusaTraduzida } from "./meetings";

/**
 * A reunião aberta pelo link (pedido do Roberto em 12/11/2026, "por enquanto"):
 * procedimentos PÚBLICOS, sem sessão. O token é a credencial: link que não
 * existe, desligado ou de conta desativada responde NOT_FOUND, igual. Só
 * leitura e IA; mudar a reunião continua com a dona, em routers/meetings.ts.
 */

// O token vai cru ao banco, que o recusa se não tiver o formato: com o zod
// limitando só o tamanho, link cortado e link desligado recebem a mesma resposta.
const tokenDoLink = z.string().max(128);

// Cada resumo, pergunta e tradução nova é um pedido pago à IA, agora feito por
// quem não tem conta. Teto por link, somando os três, em memória como o da dona
// (zera a cada deploy). A tradução já guardada não conta: só chega aqui o que
// vai mesmo à IA.
export const PEDIDOS_A_IA_POR_LINK_POR_JANELA = 20;
export const tetoDaIADoLinkAberto = criarTeto(
  PEDIDOS_A_IA_POR_LINK_POR_JANELA,
  10 * 60_000,
  "Muitos pedidos à IA por este link em sequência. Aguarde alguns minutos e tente de novo.",
);

export const reuniaoAbertaRouter = router({
  ver: publicProcedure
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => verReuniaoPeloLink(input.token))),

  traduzir: publicProcedure
    .input(z.object({ token: tokenDoLink, language: z.enum(["en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"]) }))
    .mutation(({ input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      return translatePrivateMeetingTranscript(reuniao.ownerId, reuniao.id, input.language,
        () => tetoDaIADoLinkAberto.reservar(input.token));
    })),

  resumir: publicProcedure
    .input(z.object({ token: tokenDoLink, idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES) }))
    .mutation(({ input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      tetoDaIADoLinkAberto.reservar(input.token);
      return resumirReuniao(reuniao.ownerId, reuniao.id, input.idioma);
    })),

  perguntar: publicProcedure
    .input(z.object({
      token: tokenDoLink,
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(({ input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      tetoDaIADoLinkAberto.reservar(input.token);
      return perguntarAReuniao(reuniao.ownerId, reuniao.id, input.pergunta, input.idioma);
    })),
});
