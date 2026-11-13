import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { criarTeto } from "../assistente-de-texto";
import { BancoIndisponivel, descreverErroDeBanco, ehErroDoDriverDeBanco } from "../banco-indisponivel";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
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
// quem não tem conta. Dois tetos, os dois pela REUNIÃO (não pelo token: a
// variação de caixa e o link religado caem no mesmo balde), em memória como o
// da dona (zeram a cada deploy). A tradução já guardada não conta: só chega
// aqui o que vai mesmo à IA.
// - por visitante (rede do IP): quem abusa não tira a IA de quem mais recebeu o link;
// - por reunião: o total que o link inteiro pode gastar, somando os visitantes.
const JANELA_DO_TETO_MS = 10 * 60_000;
export const PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA = 10;
export const PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA = 60;
export const tetoDaIADoVisitanteDoLink = criarTeto(
  PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA,
  JANELA_DO_TETO_MS,
  "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.",
);
export const tetoDaIADoLinkAberto = criarTeto(
  PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA,
  JANELA_DO_TETO_MS,
  "Muitos pedidos à IA por este link em sequência. Aguarde alguns minutos e tente de novo.",
);

type Pedido = Parameters<typeof ipDaCliente>[0];

/**
 * Uma vaga nos dois tetos, ou nenhuma: os dois são conferidos antes de gravar
 * em qualquer um, e a recusa de um não gasta a vaga do outro (o teto não
 * devolve vaga). Tudo síncrono: nenhum pedido entra entre conferir e reservar.
 */
function reservarVagaDaIA(reuniaoId: string, pedido: Pedido) {
  const daVisitante = `${reuniaoId}:${chaveDeRede(ipDaCliente(pedido))}`;
  tetoDaIADoVisitanteDoLink.conferir(daVisitante);
  tetoDaIADoLinkAberto.conferir(reuniaoId);
  tetoDaIADoVisitanteDoLink.reservar(daVisitante);
  tetoDaIADoLinkAberto.reservar(reuniaoId);
}

export const MENSAGEM_TRADUCAO_INDISPONIVEL = "A tradução não respondeu agora. Tente de novo em instantes.";

export const reuniaoAbertaRouter = router({
  ver: publicProcedure
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => verReuniaoPeloLink(input.token))),

  traduzir: publicProcedure
    .input(z.object({ token: tokenDoLink, language: z.enum(["en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"]) }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      try {
        return await translatePrivateMeetingTranscript(reuniao.ownerId, reuniao.id, input.language,
          () => reservarVagaDaIA(reuniao.id, ctx.req));
      } catch (erro) {
        // O teto sai como está, e o erro do BANCO (queda ou não) segue para o
        // middleware, que o traduz. Não basta olhar o código de conexão: a
        // falha de rede com o provedor de IA traz o mesmo ECONNRESET na
        // `cause`, e viraria "banco indisponível". O resto é falha da IA ou do
        // provedor: a mensagem crua não vai a quem não tem conta, e o log não
        // leva o token.
        if (erro instanceof TRPCError || erro instanceof BancoIndisponivel || ehErroDoDriverDeBanco(erro)) throw erro;
        console.error(`[LinkAberto] a tradução da reunião ${reuniao.id} falhou: ${descreverErroDeBanco(erro)}`);
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_INDISPONIVEL });
      }
    })),

  resumir: publicProcedure
    .input(z.object({ token: tokenDoLink, idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES) }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      reservarVagaDaIA(reuniao.id, ctx.req);
      return resumirReuniao(reuniao.ownerId, reuniao.id, input.idioma);
    })),

  perguntar: publicProcedure
    .input(z.object({
      token: tokenDoLink,
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      reservarVagaDaIA(reuniao.id, ctx.req);
      return perguntarAReuniao(reuniao.ownerId, reuniao.id, input.pergunta, input.idioma);
    })),
});
