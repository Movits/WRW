import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { FORMATO_DA_SENHA_DO_LINK, normalizarSenhaDoLink, type ResultadoDaEntradaNoLink } from "@shared/senha-do-link";
import { getSessionCookieOptions } from "../_core/cookies";
import { publicProcedure, router } from "../_core/trpc";
import { criarTeto } from "../assistente-de-texto";
import { BancoIndisponivel, descreverErroDeBanco, ehErroDoDriverDeBanco } from "../banco-indisponivel";
import { entrarNoLink } from "../entrada-no-link-aberto";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import { exigirReuniaoDoLink, verReuniaoPeloLink } from "../link-aberto-da-reuniao";
import { comCookiesDoPedido } from "../senha-do-link-aberto";
import { MEETING_TRANSCRIPT_LANGUAGES, translatePrivateMeetingTranscript } from "../meeting-service";
import { perguntarAReuniao, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { pedirResumoPeloLink, resumoGuardadoPeloLink } from "../resumo-guardado";
import { mapaMentalPeloLink, pedirMapaPeloLink } from "../mapa-mental-guardado";
import { traduzirResumoPeloLink } from "../traducao-do-resumo";
import { anexosPeloLink } from "../anexos-do-resumo";
import { comRecusaTraduzida, segundaVagaDaPerguntaLonga } from "./meetings";

/**
 * A reunião aberta pelo link (pedido do Roberto em 12/11/2026, "por enquanto"):
 * procedimentos PÚBLICOS, sem sessão. O token é a credencial: link que não
 * existe, desligado ou de conta desativada responde NOT_FOUND, igual. Só
 * leitura e IA; mudar a reunião continua com a dona, em routers/meetings.ts.
 *
 * O link com senha (H23) responde UNAUTHORIZED a tudo até quem o recebeu
 * acertar a senha em `entrar`, que grava o cookie da entrada. Quem confere é
 * reuniaoDoLink (server/link-aberto-da-reuniao.ts), com os cookies que
 * `procedimentoDoLink` põe no contexto do pedido.
 */

// O token vai cru ao banco, que o recusa se não tiver o formato: com o zod
// limitando só o tamanho, link cortado e link desligado recebem a mesma resposta.
const tokenDoLink = z.string().max(128);

// Todo procedimento que lê a reunião pelo token passa por aqui: os cookies do
// pedido ficam à vista de reuniaoDoLink, que confere a entrada no link com
// senha. `entrar`, que é quem grava a entrada, não precisa.
const procedimentoDoLink = publicProcedure.use(({ ctx, next }) => comCookiesDoPedido(ctx.req.headers.cookie, () => next()));

// A senha como a tela a manda, com os algarismos de outros teclados já em
// 0-9 (normalizarSenhaDoLink). Fora do formato, BAD_REQUEST, sem gastar
// tentativa: a tela não manda senha assim.
const senhaDoLink = z.string().max(32).transform(normalizarSenhaDoLink).pipe(z.string().regex(FORMATO_DA_SENHA_DO_LINK));

// Cada pedido de resumo novo, pergunta e tradução nova é um pedido pago à IA,
// agora feito por quem não tem conta. Dois tetos, os dois pela REUNIÃO (não pelo token: a
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
 * A segunda vaga da pergunta sobre reunião longa não passa por aqui: ela só é
 * tomada depois de ler a transcrição, quando o tamanho é conhecido (ver
 * `perguntar`, abaixo).
 */
function reservarVagaDaIA(reuniaoId: string, pedido: Pedido): () => void {
  const daVisitante = `${reuniaoId}:${chaveDeRede(ipDaCliente(pedido))}`;
  tetoDaIADoVisitanteDoLink.conferir(daVisitante);
  tetoDaIADoLinkAberto.conferir(reuniaoId);
  const soltarDaVisitante = tetoDaIADoVisitanteDoLink.reservar(daVisitante);
  const soltarDaReuniao = tetoDaIADoLinkAberto.reservar(reuniaoId);
  // Para quem não chegou a usar a vaga (o resumo pedido duas vezes ao mesmo tempo).
  return () => { soltarDaVisitante(); soltarDaReuniao(); };
}

export const MENSAGEM_TRADUCAO_INDISPONIVEL = "A tradução não respondeu agora. Tente de novo em instantes.";

export const reuniaoAbertaRouter = router({
  // A senha do link (H23). Certa, grava o cookie HttpOnly da entrada, preso ao
  // token e à senha, e a página relê a reunião. A resposta é a mesma para a
  // senha errada e para o link que não existe, foi desligado ou não tem senha:
  // a página da senha não diz se o link existe. O freio da força bruta
  // responde "espera", com os segundos que faltam (server/entrada-no-link-aberto.ts).
  entrar: publicProcedure
    .input(z.object({ token: tokenDoLink, senha: senhaDoLink }))
    .mutation(async ({ ctx, input }): Promise<ResultadoDaEntradaNoLink> => {
      const resultado = await entrarNoLink(input.token, input.senha, ipDaCliente(ctx.req));
      if (!resultado.entrou) return resultado;
      ctx.res.cookie(resultado.cookie.nome, resultado.cookie.valor, { ...getSessionCookieOptions(ctx.req), maxAge: resultado.cookie.maxAgeMs });
      return { entrou: true };
    }),

  // A reunião do link, com os nomes que a dona deu às vozes só quando ela
  // ligou o link com a confirmação que fala deles (H3b, verReuniaoPeloLink).
  ver: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => verReuniaoPeloLink(input.token))),

  traduzir: procedimentoDoLink
    .input(z.object({ token: tokenDoLink, language: z.enum(MEETING_TRANSCRIPT_LANGUAGES) }))
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

  // O resumo guardado (H4), só leitura: sem ids, sem os itens ignorados e
  // com as vozes como rótulo, que a página troca com o `vozes` do `ver`. Pedir
  // o resumo que a reunião ainda não tem gasta uma vaga dos dois tetos; pedir
  // o que já está na fila, não.
  resumoGuardado: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => resumoGuardadoPeloLink(input.token))),

  pedirResumo: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(() => pedirResumoPeloLink(input.token, reuniaoId => reservarVagaDaIA(reuniaoId, ctx.req)))),

  // As fotos e os desenhos do resumo (H4g e H4h), só leitura: o id, o tipo e
  // o endereço pela rota do link, que confere a entrada a cada imagem.
  anexos: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => anexosPeloLink(input.token))),

  // O mapa mental (H10), só leitura, como o resumo. Pedir o mapa que a
  // reunião ainda não tem (ou que falhou) gasta uma vaga dos dois tetos;
  // pedir o que já está na fila, ou pronto, não.
  mapaMental: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .query(({ input }) => comRecusaTraduzida(() => mapaMentalPeloLink(input.token))),

  pedirMapa: procedimentoDoLink
    .input(z.object({ token: tokenDoLink }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(() => pedirMapaPeloLink(input.token, reuniaoId => reservarVagaDaIA(reuniaoId, ctx.req)))),

  // A tradução do resumo guardado (H11): o resumo inteiro no idioma de quem lê,
  // sem ids e sem os ignorados, como o resumoGuardado. Gasta uma vaga dos dois
  // tetos só quando a IA é chamada de fato: a tradução guardada, e a que já
  // está na IA, não contam.
  traduzirResumo: procedimentoDoLink
    .input(z.object({ token: tokenDoLink, idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES) }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      try {
        return await traduzirResumoPeloLink(reuniao, input.idioma, () => { reservarVagaDaIA(reuniao.id, ctx.req); });
      } catch (erro) {
        // Como na tradução da transcrição: o teto e a IA fora saem com o código,
        // e o erro do banco segue para o middleware. O resto não vai cru a quem
        // não tem conta, e o log não leva o token.
        if (erro instanceof TRPCError || erro instanceof BancoIndisponivel || ehErroDoDriverDeBanco(erro)) throw erro;
        console.error(`[LinkAberto] a tradução do resumo da reunião ${reuniao.id} falhou: ${descreverErroDeBanco(erro)}`);
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_INDISPONIVEL });
      }
    })),

  // A pergunta gasta uma vaga dos dois tetos antes de ler a transcrição: com
  // um teto cheio, a rajada é recusada sem ler o banco. A pergunta recusada
  // depois da leitura (reunião longa demais, sem transcrição) fica com essa
  // vaga, como a da dona: a recusa não chama a IA, mas leu o banco.
  //
  // A pergunta sobre reunião longa (mais de 100 mil caracteres na entrada da
  // IA, cerca de 1h45 de fala) custa mais, porque a IA cobra pelo tamanho da
  // entrada, e gasta uma SEGUNDA vaga do teto da reunião
  // (segundaVagaDaPerguntaLonga, em routers/meetings.ts): o link inteiro faz no
  // máximo 30 perguntas longas a cada 10 minutos, em vez de 60. Essa vaga só se
  // confere depois de ler a transcrição. Com uma vaga só sobrando, então, cada
  // pergunta longa lê o banco antes de ser recusada (e devolve a primeira vaga).
  // Aceito: é uma leitura por pedido, que o rate limit global segura, e
  // nenhuma chega à IA.
  //
  // O teto da visitante segue contando uma por pergunta: ele reparte o link
  // entre quem o recebeu, e o gasto total é o da reunião.
  perguntar: procedimentoDoLink
    .input(z.object({
      token: tokenDoLink,
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(async () => {
      const reuniao = await exigirReuniaoDoLink(input.token);
      const soltarVaga = reservarVagaDaIA(reuniao.id, ctx.req);
      return perguntarAReuniao(reuniao.ownerId, reuniao.id, input.pergunta, input.idioma,
        segundaVagaDaPerguntaLonga(() => tetoDaIADoLinkAberto.reservar(reuniao.id), soltarVaga));
    })),
});
