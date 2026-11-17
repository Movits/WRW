import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { FORMATO_DO_FALANTE, NOME_DO_FALANTE_MAX, TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN, VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { VERSOES_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { IDIOMA_DA_REUNIAO_PADRAO, IDIOMAS_DA_REUNIAO, idiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { createPrivateContact, exigirDb } from "../db";
import { meetingContactSuggestions, meetingEntities, meetings, privateContacts, userProfiles } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { createAuditLog } from "../security";
import { decidirPendenciasDaPessoaSugerida } from "../network-extracao";
import { candidatosParaVincular, conexoesDaReuniao } from "../reuniao-no-match";
import { hasValidConsent } from "./consent";
import {
  ALLOWED_MEETING_AUDIO_TYPES,
  deletePrivateMeeting,
  getPrivateMeeting,
  iniciarReprocessamento,
  listPrivateMeetings,
  MAX_MEETING_DURATION_SECONDS,
  MEETING_TRANSCRIPT_LANGUAGES,
  processMeetingRecording,
  ReprocessamentoRecusado,
  ReuniaoForaDoEstado,
  ReuniaoTomadaPorOutraExecucao,
  translatePrivateMeetingTranscript,
  nomearFalante,
} from "../meeting-service";
import { perguntarAReuniao, RecusaDaReuniaoComIA, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { criarTeto } from "../assistente-de-texto";
import { desligarLinkAberto, LinkAbertoRecusado, ligarLinkAberto } from "../link-aberto-da-reuniao";
import { ipDaCliente } from "../ip-da-cliente";
import { encerrarGravacaoEmPartes, iniciarReuniaoEmPartes, PARTES_NO_MAXIMO, RecusaDaParte } from "../fatias-de-reuniao";
import { acrescentarItemDoResumo, confirmarItensDoResumo, decidirItemDoResumo, editarItemDoResumo, marcarAcaoFeita, pedirResumoDaDona, refazerResumoDaDona, resumoGuardadoDaDona } from "../resumo-guardado";
import { depoisDeMexerNoItem, prepararAcaoDoItem } from "../acoes-na-google";
import { ROTULO_DA_AGENDA_MAX } from "@shared/acoes-na-agenda";
import { FUSO_MAX } from "@shared/agenda";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { MODELOS_DE_RESUMO } from "@shared/modelos-de-resumo";
import { mapaMentalDaDona, pedirMapaDaDona } from "../mapa-mental-guardado";
import { traduzirResumoDaDona } from "../traducao-do-resumo";
import { rascunharEmailDeRetorno } from "../email-de-retorno";
import { RELACOES_DO_EMAIL, TONS_DO_EMAIL } from "@shared/email-de-retorno";
import { CAMPO_DO_ITEM_DO_RESUMO_MAX, SECOES_DO_RESUMO, TEXTO_DO_ITEM_DO_RESUMO_MAX } from "@shared/item-do-resumo";

// O que a dona escreve num item do resumo (H4f): o texto é obrigatório; o
// assunto, o responsável e o prazo, vazios ou ausentes, viram nulos.
const campoDoItemDoResumo = z.string().trim().max(CAMPO_DO_ITEM_DO_RESUMO_MAX).nullish().transform(valor => valor || null);
const camposDoItemDoResumo = {
  texto: z.string().trim().min(1).max(TEXTO_DO_ITEM_DO_RESUMO_MAX),
  assunto: campoDoItemDoResumo,
  responsavel: campoDoItemDoResumo,
  prazo: campoDoItemDoResumo,
};
// O fuso do aparelho e os rótulos da tela, para o evento da próxima ação na
// Google Agenda (H5c), como na lista (routers/proximasAcoes.ts).
const pedidoDaTelaParaAGoogle = {
  fuso: z.string().trim().max(FUSO_MAX).nullish(),
  rotulos: z.object({ voz: z.string().max(ROTULO_DA_AGENDA_MAX), responsavel: z.string().max(ROTULO_DA_AGENDA_MAX) }).nullish(),
};

// Reprocessar custa IA (até 10 MB ao Gemini, mais a extração) e roda fora da
// requisição. A tomada no banco já impede dois reprocessamentos da MESMA
// reunião; este teto brando segura quem reprocessa uma reunião atrás da outra,
// ou a mesma que falha de novo, em laço. Em memória, como o do FAQ: basta à
// instância única do Render e zera a cada deploy. Só conta pedido aceito.
const REPROCESSOS_POR_JANELA = 3;
const JANELA_DE_REPROCESSO_MS = 10 * 60_000;
const reprocessosPorDona = new Map<string, number[]>();

/** Só para os testes: o teto é estado de módulo. */
export function esquecerTentativasDeReprocesso() {
  reprocessosPorDona.clear();
}

// Cada pergunta manda a transcrição inteira à IA (até 400 mil caracteres,
// server/reuniao-com-ia.ts), cada resumo pedido é uma geração paga na fila e
// cada rascunho de e-mail de retorno (H20) manda os itens confirmados do
// resumo. Teto brando por dona, os três somados, em memória como o do
// reprocesso. A pergunta e o rascunho contam todo pedido que passa da
// validação, até o recusado: a recusa não chama a IA, e assim também não serve
// de sonda. A pergunta sobre reunião longa conta duas
// (segundaVagaDaPerguntaLonga): a dona faz até 10 delas a cada 10 minutos. O
// pedido de resumo só conta quando cria trabalho novo
// (server/resumo-guardado.ts).
export const PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA = 20;
export const tetoDaIADaReuniao = criarTeto(
  PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA,
  10 * 60_000,
  "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.",
);

/**
 * A pergunta sobre reunião longa (mais de 100 mil caracteres na entrada da IA,
 * cerca de 1h45 de fala) custa mais, porque a IA cobra pelo tamanho da
 * entrada: ela gasta uma SEGUNDA vaga do teto. O tamanho só se conhece depois
 * de ler a transcrição, então a vaga é tomada no `antesDeChamarAIA` de
 * perguntarAReuniao, antes da IA. Recusada a segunda, a primeira volta: a
 * recusa do teto não gasta vaga. Vale para a dona (aqui) e para o link aberto
 * (routers/reuniaoAberta.ts).
 */
export function segundaVagaDaPerguntaLonga(reservarSegunda: () => unknown, soltarPrimeira: () => void) {
  return ({ longa }: { longa: boolean }) => {
    if (!longa) return;
    try {
      reservarSegunda();
    } catch (erro) {
      soltarPrimeira();
      throw erro;
    }
  };
}

// A tradução do resumo guardado (H11) para a dona: cada pedido que chama a IA
// de fato (o item editado ou acrescentado, outro idioma, o mapa que chegou)
// gasta uma vaga; a tradução guardada e a que já está na IA, não. Teto próprio,
// por dona e em memória como os outros: a tela pede a tradução de novo a cada
// item que a dona corrige, e corrigir o resumo não pode gastar as vagas do
// Pergunte. Sem ele, editar e traduzir em laço chamava a IA sem limite.
export const TRADUCOES_DO_RESUMO_POR_JANELA = 30;
export const tetoDaTraducaoDoResumo = criarTeto(
  TRADUCOES_DO_RESUMO_POR_JANELA,
  10 * 60_000,
  "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo.",
);

/** Devolve a vaga de um pedido que não foi aceito. */
function devolverVagaDeReprocesso(openId: string, momento: number) {
  const vagas = reprocessosPorDona.get(openId);
  const posicao = vagas?.indexOf(momento) ?? -1;
  if (vagas && posicao >= 0) vagas.splice(posicao, 1);
}

export const MENSAGEM_REUNIAO_PROCESSANDO = "Esta reunião está sendo processada de novo. Espere terminar para decidir.";
export const MENSAGEM_SUGESTAO_JA_DECIDIDA = "Esta pessoa já foi decidida. Atualize a tela para ver como ficou.";

/**
 * Durante um reprocessamento, as sugestões e entidades da tentativa anterior
 * vão ser apagadas e substituídas: decidir sobre elas agora criaria um contato
 * a partir de uma sugestão que some, e a mesma pessoa voltaria como sugestão
 * nova para ser criada de novo.
 */
async function recusarSeReuniaoProcessando(db: Awaited<ReturnType<typeof exigirDb>>, ownerId: string, meetingId: string) {
  const [reuniao] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (reuniao?.status === "processing") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_REUNIAO_PROCESSANDO });
}

/**
 * As recusas da pergunta e do link aberto saem com o código que a tela
 * traduz. O router do link aberto (reuniaoAberta.ts) usa a mesma.
 */
export async function comRecusaTraduzida<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaDaReuniaoComIA || erro instanceof LinkAbertoRecusado) {
      throw new TRPCError({ code: erro.codigo, message: erro.message });
    }
    throw erro;
  }
}

// O idioma falado na reunião, normalizado pela função única ('pt' e 'pt-PT'
// viram 'pt-BR', 'en-US' vira 'en'). A tela antiga, ainda aberta depois do
// deploy, manda 'pt'; sem idioma vale o padrão. Fora dos 10, recusa: o código
// é gravado e decide o original da tradução.
export const idiomaDaReuniaoNaEntrada = z.string().max(12).optional().transform((valor, ctx) => {
  if (valor === undefined) return IDIOMA_DA_REUNIAO_PADRAO;
  const idioma = idiomaDaReuniao(valor);
  if (!idioma) {
    ctx.addIssue({ code: "custom", message: "Idioma da reunião não suportado." });
    return z.NEVER;
  }
  return idioma;
});

const createMeetingInput = z.object({
  title: z.string().trim().min(TITULO_DA_REUNIAO_MIN).max(TITULO_DA_REUNIAO_MAX),
  contactId: z.number().int().positive().optional().nullable(),
  contextId: z.string().uuid().optional().nullable(),
  language: idiomaDaReuniaoNaEntrada,
  consentGranted: z.literal(true),
  // A versão do aviso de gravação que a tela mostrou (shared/aviso-de-gravacao.ts).
  // Opcional: a aba aberta antes do aviso versionado não manda nenhuma, e a
  // reunião dela fica com a coluna nula, como as anteriores.
  consentNoticeVersion: z.enum(VERSOES_DO_AVISO_DE_GRAVACAO).optional(),
});

export const meetingsRouter = router({
  list: protectedProcedure.query(({ ctx }) => listPrivateMeetings(ctx.user.openId)),

  get: protectedProcedure.input(z.object({ meetingId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const data = await getPrivateMeeting(ctx.user.openId, input.meetingId);
    if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return data;
  }),

  create: protectedProcedure.input(createMeetingInput).mutation(async ({ ctx, input }) => {
    const db = await exigirDb();
    const timestamp = Date.now();
    const id = crypto.randomUUID();
    await db.insert(meetings).values({
      id,
      ownerId: ctx.user.openId,
      title: input.title,
      contactId: input.contactId ?? null,
      contextId: input.contextId ?? null,
      status: "recording",
      consentGranted: true,
      consentAt: timestamp,
      consentNoticeVersion: input.consentNoticeVersion ?? null,
      language: input.language,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { id };
  }),

  // A reunião gravada em partes (G5): nasce no início da gravação, cada parte
  // chega pela rota binária (server/_core/rota-das-partes.ts) e o fim diz
  // quantas partes houve. A tela que grava em partes é a G9.
  iniciarGravacao: protectedProcedure.input(createMeetingInput.extend({
    origem: z.enum(["gravacao", "arquivo", "aba"]).default("gravacao"),
  })).mutation(({ ctx, input }) => iniciarReuniaoEmPartes(ctx.user.openId, {
    title: input.title, language: input.language, consentNoticeVersion: input.consentNoticeVersion ?? null,
    origem: input.origem, contactId: input.contactId, contextId: input.contextId,
  })),

  encerrarGravacao: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), partes: z.number().int().min(1).max(PARTES_NO_MAXIMO) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await encerrarGravacaoEmPartes(ctx.user.openId, input.meetingId, input.partes);
      } catch (erro) {
        if (erro instanceof RecusaDaParte) {
          throw new TRPCError({ code: erro.codigo === "SEM_REUNIAO" ? "NOT_FOUND" : erro.codigo === "POSICAO" ? "BAD_REQUEST" : "CONFLICT", message: erro.message });
        }
        throw erro;
      }
    }),

  submitRecording: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      audioBase64: z.string().min(20).max(14_000_000),
      mimeType: z.enum(ALLOWED_MEETING_AUDIO_TYPES),
      durationSeconds: z.number().positive().max(MAX_MEETING_DURATION_SECONDS),
      language: idiomaDaReuniaoNaEntrada,
    }))
    .mutation(async ({ ctx, input }) => {
      let result: Awaited<ReturnType<typeof processMeetingRecording>>;
      try {
        result = await processMeetingRecording({ ...input, ownerId: ctx.user.openId });
      } catch (erro) {
        if (erro instanceof ReuniaoForaDoEstado || erro instanceof ReuniaoTomadaPorOutraExecucao) {
          throw new TRPCError({ code: "CONFLICT", message: erro.message });
        }
        throw erro;
      }
      return { success: true, transcriptLength: result.transcript.length, entities: result.extraction.entities.length, contacts: result.extraction.contacts.length };
    }),

  // Reprocessa uma reunião com falha a partir do áudio que ficou guardado.
  // Devolve assim que a reunião é tomada ('processing'); o resultado aparece em
  // meetings.get e meetings.list. Recusas saem com o código que a tela traduz:
  // NOT_FOUND, CONFLICT (não está com falha, ou alguém chegou antes),
  // PRECONDITION_FAILED (sem áudio guardado utilizável) e TOO_MANY_REQUESTS.
  reprocess: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // A vaga é reservada ANTES do await. Conferir antes e registrar depois
      // deixava uma rajada simultânea (um lote tRPC, várias abas) ler o mapa
      // sem nenhuma vaga ocupada e passar inteira. Pedido não aceito devolve a vaga.
      const agora = Date.now();
      const recentes = (reprocessosPorDona.get(ctx.user.openId) ?? []).filter(momento => agora - momento < JANELA_DE_REPROCESSO_MS);
      if (recentes.length >= REPROCESSOS_POR_JANELA) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas tentativas de reprocessar em sequência. Aguarde alguns minutos e tente de novo." });
      }
      if (reprocessosPorDona.size > 5000) reprocessosPorDona.clear();
      recentes.push(agora);
      reprocessosPorDona.set(ctx.user.openId, recentes);
      let trabalho: Promise<void>;
      try {
        ({ trabalho } = await iniciarReprocessamento(ctx.user.openId, input.meetingId));
      } catch (erro) {
        devolverVagaDeReprocesso(ctx.user.openId, agora);
        if (erro instanceof ReprocessamentoRecusado) throw new TRPCError({ code: erro.codigo, message: erro.message });
        throw erro;
      }
      // `trabalho` nunca rejeita: iniciarReprocessamento termina todo erro em log.
      void trabalho;
      await createAuditLog({
        userId: ctx.user.id, action: "MEETING_REPROCESS_REQUESTED", resource: "meetings", resourceId: input.meetingId,
        status: "success", riskLevel: "low",
      });
      return { status: "processing" as const };
    }),

  translateTranscript: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), language: z.enum(IDIOMAS_DA_REUNIAO) }))
    .mutation(async ({ ctx, input }) => {
      return translatePrivateMeetingTranscript(ctx.user.openId, input.meetingId, input.language);
    }),

  // O resumo GUARDADO (H4): gerado em segundo plano pela fila do resumo, cada
  // item pendente até a dona confirmar. Toda reunião que fica pronta já ganha
  // o pedido (gravarResultadoDaReuniao); pedir serve à reunião antiga e ao
  // resumo que falhou. Só a dona; a dona no WHERE de tudo
  // (server/resumo-guardado.ts). Pedir o resumo que ainda não existe (ou que
  // falhou) gasta uma vaga do teto de pedidos à IA, o mesmo das perguntas.
  resumoGuardado: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(({ ctx, input }) => resumoGuardadoDaDona(ctx.user.openId, input.meetingId)),

  // O modelo (H4d) é opcional: a reunião antiga ganha o resumo no modelo que a
  // dona escolheu; sem ele, o Geral (e o que falhou reabre no modelo de antes).
  pedirResumo: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), modelo: z.enum(MODELOS_DE_RESUMO).optional() }))
    .mutation(({ ctx, input }) => pedirResumoDaDona(ctx.user.openId, input.meetingId, () => tetoDaIADaReuniao.reservar(ctx.user.openId), input.modelo)),

  // "Refazer como…" (H4d): o resumo volta à fila no modelo escolhido; os itens
  // confirmados, os feitos e os que a dona escreveu ou editou (H4f) ficam, os
  // outros pendentes e ignorados são trocados. Gasta uma vaga do mesmo teto de
  // pedidos à IA.
  refazerResumo: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), modelo: z.enum(MODELOS_DE_RESUMO) }))
    .mutation(({ ctx, input }) => refazerResumoDaDona(ctx.user.openId, input.meetingId, input.modelo, () => tetoDaIADaReuniao.reservar(ctx.user.openId))),

  // O mapa mental (H10), na linha do resumo guardado: a fila o gera logo
  // depois do resumo, numa chamada à parte (server/fila-do-resumo.ts). Pedir
  // serve à reunião resumida antes do mapa e ao mapa que falhou, e gasta uma
  // vaga do mesmo teto de pedidos à IA (server/mapa-mental-guardado.ts).
  mapaMental: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(({ ctx, input }) => mapaMentalDaDona(ctx.user.openId, input.meetingId)),

  pedirMapa: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(({ ctx, input }) => pedirMapaDaDona(ctx.user.openId, input.meetingId, () => tetoDaIADaReuniao.reservar(ctx.user.openId))),

  // Desconfirmar apaga a próxima ação do item (H5a), e o evento dela sai da
  // Google Agenda depois (H5c, server/acoes-na-google.ts): o token vem antes da
  // escrita, e só quando a ação tem prazo. Quando o evento fica lá, a resposta
  // diz "falhou" com o id da ação, para o "Tentar de novo" da tela. Quem decide
  // se a ação saiu é o estado gravado, não o pedido: o item escrito pela dona
  // (H4f) que a tela pede de volta a "para conferir" fica confirmado, e a ação
  // dele, com o evento, fica.
  decidirItemDoResumo: protectedProcedure
    .input(z.object({ itemId: z.string().uuid(), status: z.enum(["pending", "confirmed", "ignored"]) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; acaoId: string | null } & ResultadoNaGoogle> => {
      const conta = { id: ctx.user.id, openId: ctx.user.openId };
      const preparo = input.status === "confirmed" ? null : await prepararAcaoDoItem(conta, input.itemId);
      const { acaoSaiu } = await decidirItemDoResumo(ctx.user.openId, input.itemId, input.status);
      if (!acaoSaiu) return { ok: true as const, acaoId: null, naGoogle: null };
      return { ok: true as const, ...(await depoisDeMexerNoItem(conta, preparo, false)) };
    }),

  confirmarItensDoResumo: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({ confirmados: await confirmarItensDoResumo(ctx.user.openId, input.meetingId) })),

  // A caixa da ação no resumo marca também a próxima ação dela (H5a): feita, ela
  // sai da Google Agenda; reaberta, volta, se o prazo ainda vem (H5c). O fuso
  // e os rótulos vêm da tela, como na lista (routers/proximasAcoes.ts).
  marcarAcaoFeita: protectedProcedure
    .input(z.object({ itemId: z.string().uuid(), feito: z.boolean(), ...pedidoDaTelaParaAGoogle }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; acaoId: string | null } & ResultadoNaGoogle> => {
      const conta = { id: ctx.user.id, openId: ctx.user.openId };
      const preparo = await prepararAcaoDoItem(conta, input.itemId);
      await marcarAcaoFeita(ctx.user.openId, input.itemId, input.feito);
      return { ok: true as const, ...(await depoisDeMexerNoItem(conta, preparo, !input.feito, { fuso: input.fuso, rotulos: input.rotulos })) };
    }),

  // A tradução do resumo guardado (H11) para o idioma de quem lê, em segundo
  // plano como a da transcrição: responde "traduzindo" enquanto a IA trabalha,
  // e a tela pergunta de novo. A tradução guardada não chama a IA e não gasta
  // vaga; a que chama gasta uma do teto próprio da tradução
  // (tetoDaTraducaoDoResumo), só quando a IA é chamada de fato.
  traduzirResumo: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), idioma: z.enum(IDIOMAS_DA_REUNIAO) }))
    .mutation(({ ctx, input }) => traduzirResumoDaDona(ctx.user.openId, input.meetingId, input.idioma,
      () => { tetoDaTraducaoDoResumo.reservar(ctx.user.openId); })),

  // A dona edita um item e acrescenta item à mão (H4f): o que ela escreve vale
  // como confirmado. Sem IA, então sem teto de pedidos; o resumo guarda até
  // ITENS_DO_RESUMO_MAX itens. A tradução que a tela pede depois traduz só o
  // item que mudou, e gasta a vaga dela.
  //
  // A próxima ação do item editado leva o texto novo (H5a), e o evento dela na
  // Google Agenda também (H5c), como a edição na lista: o token vem antes da
  // escrita, só quando a ação tem prazo, e o fuso e os rótulos vêm da tela.
  // Quando a Google falha, a resposta diz "falhou", e a lista mostra "Tentar de
  // novo" (a escrita deixou a ação "falhou" antes do envio).
  editarItemDoResumo: protectedProcedure
    .input(z.object({ itemId: z.string().uuid(), ...camposDoItemDoResumo, ...pedidoDaTelaParaAGoogle }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; acaoId: string | null } & ResultadoNaGoogle> => {
      const { itemId, fuso, rotulos, ...campos } = input;
      const conta = { id: ctx.user.id, openId: ctx.user.openId };
      const preparo = await prepararAcaoDoItem(conta, itemId);
      const { acaoQueMudou } = await editarItemDoResumo(ctx.user.openId, itemId, campos);
      if (!acaoQueMudou) return { ok: true as const, acaoId: null, naGoogle: null };
      return { ok: true as const, ...(await depoisDeMexerNoItem(conta, preparo, true, { fuso, rotulos })) };
    }),

  acrescentarItemDoResumo: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), secao: z.enum(SECOES_DO_RESUMO), ...camposDoItemDoResumo }))
    .mutation(async ({ ctx, input }) => {
      const { meetingId, secao, ...campos } = input;
      return { id: await acrescentarItemDoResumo(ctx.user.openId, meetingId, secao, campos) };
    }),

  perguntar: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaIADaReuniao.reservar(ctx.user.openId);
      return comRecusaTraduzida(() => perguntarAReuniao(ctx.user.openId, input.meetingId, input.pergunta, input.idioma,
        segundaVagaDaPerguntaLonga(() => tetoDaIADaReuniao.reservar(ctx.user.openId), soltarVaga)));
    }),

  // H20: o rascunho de um e-mail de retorno, escrito pela IA a partir dos itens
  // que a dona confirmou no resumo guardado (server/email-de-retorno.ts). O
  // servidor só devolve o texto: nada é gravado nem enviado, e a dona manda
  // pelo app de e-mail dela. O nome de quem recebe nem chega aqui (a tela o põe
  // no lugar da marca {DESTINATARIO}); só a voz dela, quando a tela a reconhece.
  rascunharEmailDeRetorno: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      relacao: z.enum(RELACOES_DO_EMAIL),
      tom: z.enum(TONS_DO_EMAIL),
      idioma: z.enum(IDIOMAS_DA_REUNIAO),
      vozDoDestinatario: z.string().regex(FORMATO_DO_FALANTE).optional(),
    }))
    .mutation(({ ctx, input }) => {
      tetoDaIADaReuniao.reservar(ctx.user.openId);
      return rascunharEmailDeRetorno(ctx.user.openId, input.meetingId, {
        relacao: input.relacao,
        tom: input.tom,
        idioma: input.idioma,
        vozDoDestinatario: input.vozDoDestinatario,
      });
    }),

  // O link aberto (pedido do Roberto em 12/11/2026, "por enquanto"): quem tem o
  // endereço ouve, lê e pergunta à IA sem conta na WRW (routers/reuniaoAberta.ts).
  // Só a dona liga e desliga, e só reunião pronta tem link. Ligar exige de novo
  // a palavra dela de que as pessoas da reunião autorizaram compartilhar: o
  // consentimento da gravação foi para um áudio privado. Essa palavra vai para
  // a auditoria na mesma transação que liga o link (ligarLinkAberto). Ligar o
  // que já está ligado devolve o mesmo link.
  ligarLinkAberto: protectedProcedure
    .input(z.object({
      meetingId: z.string().uuid(),
      autorizacaoDasPessoas: z.literal(true),
      // O texto da caixa que a dona viu, no idioma da tela dela: vai para a
      // prova, porque a frase muda com a revisão jurídica.
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      textoExibido: z.string().trim().min(1).max(1000),
      // A versão da caixa (H3b): a 2 fala dos nomes que a dona der às vozes, e
      // só com ela o link mostra os nomes. A aba aberta antes do deploy não
      // manda nada, e o serviço grava 1: a frase dela não falava dos nomes.
      versaoDaAutorizacao: z.literal(VERSAO_DA_AUTORIZACAO_COM_NOMES).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = await comRecusaTraduzida(() => ligarLinkAberto(ctx.user.openId, input.meetingId, {
        userId: ctx.user.id,
        ipAddress: ipDaCliente(ctx.req),
        userAgent: ctx.req.headers["user-agent"],
        idioma: input.idioma,
        textoExibido: input.textoExibido,
        versaoDaAutorizacao: input.versaoDaAutorizacao,
      }));
      return { token };
    }),

  desligarLinkAberto: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await comRecusaTraduzida(() => desligarLinkAberto(ctx.user.openId, input.meetingId));
      await createAuditLog({
        userId: ctx.user.id, action: "MEETING_OPEN_LINK_OFF", resource: "meetings", resourceId: input.meetingId,
        status: "success", riskLevel: "low",
      });
      return { success: true };
    }),

  decideEntity: protectedProcedure
    .input(z.object({ entityId: z.string().uuid(), status: z.enum(["confirmed", "ignored"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const [entidade] = await db.select({ meetingId: meetingEntities.meetingId }).from(meetingEntities)
        .where(and(eq(meetingEntities.id, input.entityId), eq(meetingEntities.ownerId, ctx.user.openId))).limit(1);
      if (!entidade) throw new TRPCError({ code: "NOT_FOUND", message: "Entidade não encontrada." });
      await recusarSeReuniaoProcessando(db, ctx.user.openId, entidade.meetingId);
      const result = await db.update(meetingEntities)
        .set({ status: input.status, updatedAt: Date.now() })
        .where(and(eq(meetingEntities.id, input.entityId), eq(meetingEntities.ownerId, ctx.user.openId)));
      if (!(result as any)[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Entidade não encontrada." });
      return { success: true };
    }),

  decideContactSuggestion: protectedProcedure
    .input(z.object({
      suggestionId: z.string().uuid(),
      // "self" (N5): "Sou eu". Nenhum contato nasce; o que a pessoa tem e
      // precisa passa a esperar a dona com destino no perfil dela.
      action: z.enum(["create", "link", "ignore", "self"]),
      contactId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await exigirDb();
      const daDona = and(eq(meetingContactSuggestions.id, input.suggestionId), eq(meetingContactSuggestions.ownerId, ctx.user.openId));
      const [suggestion] = await db.select().from(meetingContactSuggestions).where(daDona).limit(1);
      if (!suggestion) throw new TRPCError({ code: "NOT_FOUND", message: "Sugestão não encontrada." });
      if (suggestion.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_SUGESTAO_JA_DECIDIDA });
      await recusarSeReuniaoProcessando(db, ctx.user.openId, suggestion.meetingId);

      const status = ({ create: "created", link: "linked", ignore: "ignored", self: "self" } as const)[input.action];
      // No "Sou eu", o que o perfil já tem não volta a pedir confirmação.
      const [perfilDaDona] = input.action === "self"
        ? await db.select({ whatIHave: userProfiles.whatIHave, whatINeedDetails: userProfiles.whatINeedDetails }).from(userProfiles)
            .where(eq(userProfiles.userId, ctx.user.id)).limit(1)
        : [];
      let linkedContactId: number | null = null;
      if (input.action === "link") {
        if (!input.contactId) throw new TRPCError({ code: "BAD_REQUEST", message: "Selecione um contato para vincular." });
        // Vincular só a contato DA dona: sem isto, um id de outra rede virava o
        // ponteiro da sugestão (e das pendências do Meu Network Inteligente).
        const [alvo] = await db.select({ id: privateContacts.id }).from(privateContacts)
          .where(and(eq(privateContacts.id, input.contactId), eq(privateContacts.ownerId, ctx.user.openId))).limit(1);
        if (!alvo) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado." });
        linkedContactId = input.contactId;
      }
      // Tudo numa transação só (revisão do pacote P2B): a tomada, o contato
      // novo, o ponteiro da sugestão e as pendências. Com um commit por passo,
      // a conexão que caía depois do contato e antes das pendências deixava a
      // sugestão 'created', o contato sem cargo nem empresa e a dona sem como
      // repetir (CONFLICT, "já decidida"). Agora qualquer falha desfaz tudo, e
      // a sugestão continua pendente para ela tentar de novo.
      linkedContactId = await db.transaction(async tx => {
        // Tomada: só UMA decisão tira a sugestão de 'pending', e antes de criar
        // contato ou mexer nas pendências. Sem o status no WHERE, o duplo clique
        // (ou a aba velha) criava um segundo contato e levava as pendências da IA
        // para ele, e um 'ignorar' tardio ignorava as do contato já criado.
        const [tomada] = await tx.update(meetingContactSuggestions)
          .set({ status, existingContactId: linkedContactId, updatedAt: Date.now() })
          .where(and(daDona, eq(meetingContactSuggestions.status, "pending")));
        if (!(tomada as { affectedRows?: number } | undefined)?.affectedRows) {
          throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_SUGESTAO_JA_DECIDIDA });
        }
        let contactId = linkedContactId;
        if (input.action === "create") {
          // Só o QUEM SOU que a tela marcou: nome, telefone e e-mail, conferidos
          // contra a transcrição. Cargo e empresa vieram da IA e não entram
          // sozinhos (achado 6 da bancada de 16/11): viram pendências do contato
          // novo, em decidirPendenciasDaPessoaSugerida, para a dona confirmar.
          contactId = await createPrivateContact(ctx.user.openId, {
            fullName: suggestion.fullName,
            phone: suggestion.phone,
            email: suggestion.email,
          }, tx);
          await tx.update(meetingContactSuggestions).set({ existingContactId: contactId, updatedAt: Date.now() }).where(daDona);
        }
        // Meu Network Inteligente: O QUE TENHO / O QUE PRECISO que a IA tirou da
        // reunião para esta pessoa passam a apontar para o contato, AINDA
        // pendentes — criar o contato confirma o Quem Sou que a tela mostrou, não
        // o resto; cargo e empresa viram pendências também, se a transcrição os
        // diz, com a confiança da sugestão. Ignorar a pessoa ignora tudo que veio dela.
        await decidirPendenciasDaPessoaSugerida(tx, {
          ownerId: ctx.user.openId,
          meetingSuggestionId: suggestion.id,
          meetingId: suggestion.meetingId,
          acao: input.action,
          contactId,
          quemSouDaSugestao: {
            fullName: suggestion.fullName, phone: suggestion.phone, email: suggestion.email,
            jobTitle: suggestion.jobTitle, company: suggestion.company, confianca: suggestion.confidence,
          },
          perfilDaDona: perfilDaDona ?? undefined,
        });
        return contactId;
      });
      return { success: true, contactId: linkedContactId };
    }),

  // N5: os contatos da dona que podem ser a pessoa da reunião (o mesmo
  // e-mail, telefone ou nome), para o "Vincular a um contato".
  candidatosParaVincular: protectedProcedure
    .input(z.object({ suggestionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const candidatos = await candidatosParaVincular(ctx.user.openId, input.suggestionId);
      if (!candidatos) throw new TRPCError({ code: "NOT_FOUND", message: "Sugestão não encontrada." });
      return candidatos;
    }),

  // N5: cada pessoa da reunião com o que tem e precisa e as conexões que
  // nasceram dela — o ramo "Conexões desta reunião" do mapa mental e a linha
  // do resumo. Só para a dona: o link aberto não tem nada disto.
  conexoes: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const termoSmartMatch = await hasValidConsent(ctx.user.id, "termo_smart_match");
      const dados = await conexoesDaReuniao(ctx.user.openId, input.meetingId, { termoSmartMatch });
      if (!dados) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      return dados;
    }),

  /** H3: o nome de uma voz da transcrição por falante; nome vazio tira o nome. */
  nomearFalante: protectedProcedure
    .input(z.object({ meetingId: z.string().uuid(), falante: z.string().regex(FORMATO_DO_FALANTE), nome: z.string().max(NOME_DO_FALANTE_MAX * 2) }))
    .mutation(async ({ ctx, input }) => {
      const nomes = await nomearFalante(ctx.user.openId, input.meetingId, input.falante, input.nome);
      if (!nomes) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      return { nomes };
    }),
  delete: protectedProcedure.input(z.object({ meetingId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await deletePrivateMeeting(ctx.user.openId, input.meetingId);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return { success: true };
  }),
});
