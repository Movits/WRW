import { z } from "zod";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { protectedProcedure, router } from "../_core/trpc";
import {
  apagarAcaoComAGoogle,
  criarAcaoComAGoogle,
  editarAcaoComAGoogle,
  mandarAcaoParaGoogle,
  marcarAcaoFeitaComAGoogle,
  tirarDaGoogleAAcaoQueSaiu,
} from "../acoes-na-google";
import { ligarContato, listarProximasAcoes, proximasAcoesDoPainel } from "../proximas-acoes";
import { ROTULO_DA_AGENDA_MAX } from "@shared/acoes-na-agenda";
import { DETALHE_DA_ACAO_MAX, prazoValido, RESPONSAVEL_DA_ACAO_MAX, TEXTO_DA_ACAO_MAX } from "@shared/proximas-acoes";
import { FUSO_MAX } from "@shared/agenda";

/**
 * As próximas ações da dona (H5a): a página /proximas-acoes e o cartão do
 * Dashboard. Só a dona, a da sessão, no WHERE de tudo (server/proximas-acoes.ts).
 * As de reunião nascem ao confirmar o item no resumo (meetings.decidirItemDoResumo
 * e as irmãs); aqui se lê, anota, edita, marca, liga contato e apaga.
 *
 * Com a Google Agenda conectada (H5c), anotar, editar, marcar e apagar também
 * criam, mudam e tiram o evento da ação lá: primeiro o banco, depois a Google
 * (server/acoes-na-google.ts). A falha da Google não desfaz o que a dona
 * salvou: a resposta diz `naGoogle: "falhou"` com o motivo, e a tela mostra
 * "Tentar de novo".
 */

const texto = z.string().trim().min(1).max(TEXTO_DA_ACAO_MAX);
// Vazio apaga o campo: chega como null.
const opcional = (max: number) => z.string().trim().max(max).nullable().optional().transform(valor => (valor ? valor : valor === undefined ? undefined : null));
const prazo = z.string().nullable().optional().refine(valor => !valor || prazoValido(valor), { message: "Prazo inválido." })
  .transform(valor => (valor ? valor : valor === undefined ? undefined : null));
const id = z.string().uuid();
// O fuso do aparelho, para o lembrete do prazo sair às 9h no relógio de quem
// marcou (H15) e o evento da ação ficar às 9h na agenda (H5c). O que o Intl não
// conhece cai no padrão (server/lembretes.ts): por ele, nada se recusa.
const fuso = z.string().trim().max(FUSO_MAX).nullish();
// Os rótulos do evento na Google Agenda, no idioma da tela (H5c): a voz sem nome
// ("Falante {n}") e o responsável ("Responsável: {nome}"). Fora da forma, o
// servidor usa os sem tradução (shared/acoes-na-agenda.ts): por eles, nada se recusa.
const rotulos = z.object({
  voz: z.string().max(ROTULO_DA_AGENDA_MAX),
  responsavel: z.string().max(ROTULO_DA_AGENDA_MAX),
}).nullish();

const contaDa = (usuaria: { id: number; openId: string }) => ({ id: usuaria.id, openId: usuaria.openId });

export const proximasAcoesRouter = router({
  listar: protectedProcedure
    .input(z.object({ filtro: z.enum(["abertas", "todas"]).default("abertas") }))
    .query(({ ctx, input }) => listarProximasAcoes(ctx.user.openId, input.filtro)),

  doPainel: protectedProcedure.query(({ ctx }) => proximasAcoesDoPainel(ctx.user.openId)),

  criar: protectedProcedure
    .input(z.object({
      texto,
      detalhe: opcional(DETALHE_DA_ACAO_MAX),
      responsavel: opcional(RESPONSAVEL_DA_ACAO_MAX),
      prazo,
      contactId: z.number().int().positive().nullable().optional(),
      fuso,
      rotulos,
    }))
    .mutation(({ ctx, input }): Promise<{ id: string } & ResultadoNaGoogle> => {
      const { rotulos: rotulosDaTela, ...dados } = input;
      return criarAcaoComAGoogle(contaDa(ctx.user), dados, { fuso: input.fuso, rotulos: rotulosDaTela });
    }),

  editar: protectedProcedure
    .input(z.object({
      id,
      texto: texto.optional(),
      detalhe: opcional(DETALHE_DA_ACAO_MAX),
      responsavel: opcional(RESPONSAVEL_DA_ACAO_MAX),
      prazo,
      fuso,
      rotulos,
    }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true } & ResultadoNaGoogle> => {
      const { id: acaoId, rotulos: rotulosDaTela, ...campos } = input;
      return { ok: true as const, ...(await editarAcaoComAGoogle(contaDa(ctx.user), acaoId, campos, { fuso: input.fuso, rotulos: rotulosDaTela })) };
    }),

  // Feita, a ação sai da Google Agenda; reaberta, volta, se o prazo ainda vem.
  marcarFeita: protectedProcedure
    .input(z.object({ id, feita: z.boolean(), fuso, rotulos }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true } & ResultadoNaGoogle> => ({
      ok: true as const,
      ...(await marcarAcaoFeitaComAGoogle(contaDa(ctx.user), input.id, input.feita, { fuso: input.fuso, rotulos: input.rotulos })),
    })),

  ligarContato: protectedProcedure
    .input(z.object({ id, contactId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ligarContato(ctx.user.openId, input.id, input.contactId);
      return { ok: true as const };
    }),

  // A ação sai, e depois o evento dela na Google Agenda. Quando o evento fica lá,
  // a tela oferece "Tentar de novo" (tirarDaGoogle).
  apagar: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true } & ResultadoNaGoogle> => ({
      ok: true as const,
      ...(await apagarAcaoComAGoogle(contaDa(ctx.user), input.id)),
    })),

  // "Pôr na Google Agenda" e "Tentar de novo" (H5c): manda a versão que está no banco.
  mandarParaGoogle: protectedProcedure
    .input(z.object({ id, fuso, rotulos }))
    .mutation(({ ctx, input }): Promise<ResultadoNaGoogle> =>
      mandarAcaoParaGoogle(contaDa(ctx.user), input.id, { fuso: input.fuso, rotulos: input.rotulos })),

  // O "Tentar de novo" de quando o evento não saiu da Google: só tira o evento
  // da ação apagada, feita ou sem prazo, e só da Google da própria dona (o token é o dela).
  tirarDaGoogle: protectedProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }): Promise<ResultadoNaGoogle> => tirarDaGoogleAAcaoQueSaiu(contaDa(ctx.user), input.id)),
});
