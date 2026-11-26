import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";
import {
  abrirSala, desligarLinkDeVisitante, encerrarSala, entrarComoVisitante, entrarNaSala, estadoDaSala, novoLinkDeVisitante, verLinkDeVisitante,
} from "../sala-de-video";
import type { ProvaDaPessoa } from "../participantes-da-reuniao";

/**
 * A sala de vídeo da reunião (V1, server/sala-de-video.ts): abrir, o estado,
 * a ficha da dona e das participantes (R1b), o link de visitante e o
 * encerrar. Quem pode o quê é conferido no serviço, no banco: o papel da conta
 * (Prata ou acima abre), a dona no WHERE e a participação ativa. Sem
 * DAILY_API_KEY e DAILY_DOMINIO, tudo recusa com SALA_INDISPONIVEL e o estado
 * diz que a função não existe. Recusas como código que a tela traduz
 * (shared/sala-de-video.ts).
 *
 * Os dois procedimentos públicos são do visitante sem conta, pelo segredo do
 * link (só o hash no banco), com teto de tentativas por rede e por link.
 */

type Contexto = { user: { id: number; openId: string; role: string }; req: Parameters<typeof ipDaCliente>[0] & { headers: Record<string, unknown> } };

function prova(ctx: Contexto): ProvaDaPessoa {
  const agente = ctx.req.headers["user-agent"];
  return { userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: typeof agente === "string" ? agente : null };
}
const conta = (ctx: Contexto) => ({ id: ctx.user.id, openId: ctx.user.openId, role: ctx.user.role });
const rede = (ctx: { req: Parameters<typeof ipDaCliente>[0] }) => chaveDeRede(ipDaCliente(ctx.req));

const meetingId = z.string().uuid();
const salaId = z.string().uuid();
// O formato do segredo é conferido no serviço, com o código traduzido (e gastando a tentativa).
const segredo = z.string().max(64);
// O aceite do aviso de gravação que a pessoa viu antes de entrar; a versão é conferida no serviço.
const aviso = z.object({ aceito: z.boolean(), versao: z.string().max(16) }).nullable().optional();

export const salaDeVideoRouter = router({
  /** O estado da sala da reunião, como a conta a vê (a dona: quem recebeu ficha; a participante: se há sala). */
  estado: protectedProcedure.input(z.object({ meetingId })).query(({ ctx, input }) => estadoDaSala(conta(ctx), input.meetingId)),

  /** A dona (Prata ou acima) abre a sala da reunião; abrir de novo devolve a sala aberta. */
  abrir: protectedProcedure.input(z.object({ meetingId })).mutation(({ ctx, input }) => abrirSala(conta(ctx), input.meetingId, prova(ctx))),

  /** A ficha de entrada da dona ou de uma participante ativa (a participante aceita o aviso antes). */
  entrar: protectedProcedure.input(z.object({ salaId, aviso })).mutation(({ ctx, input }) => entrarNaSala(conta(ctx), input.salaId, input.aviso ?? null)),

  /** A dona liga o link de visitante ou troca o segredo (o antigo para de abrir). O segredo sai só aqui. */
  linkDeVisitante: protectedProcedure.input(z.object({ salaId })).mutation(({ ctx, input }) => novoLinkDeVisitante(conta(ctx), input.salaId, prova(ctx))),

  desligarLinkDeVisitante: protectedProcedure
    .input(z.object({ salaId }))
    .mutation(async ({ ctx, input }) => { await desligarLinkDeVisitante(conta(ctx), input.salaId, prova(ctx)); return { ok: true as const }; }),

  /** A dona encerra a sala: fecha aqui e sai do Daily, o que tira quem está dentro. */
  encerrar: protectedProcedure.input(z.object({ salaId })).mutation(({ ctx, input }) => encerrarSala(conta(ctx), input.salaId, prova(ctx))),

  /** Público: o que a página do visitante mostra antes do nome (o nome da dona e a versão do aviso; nada da reunião). */
  verLinkDeVisitante: publicProcedure.input(z.object({ segredo })).query(({ ctx, input }) => verLinkDeVisitante(input.segredo, rede(ctx))),

  /** Público: o visitante entra só com o nome e o aceite do aviso. */
  entrarComoVisitante: publicProcedure
    .input(z.object({ segredo, nome: z.string().max(200), aviso }))
    .mutation(({ ctx, input }) => entrarComoVisitante(input.segredo, input.nome, input.aviso ?? null, rede(ctx))),
});
