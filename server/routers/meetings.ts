import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { FORMATO_DO_FALANTE, NOME_DO_FALANTE_MAX, TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN, VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { VERSOES_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { VERSOES_DO_AVISO_DO_DOCUMENTO } from "@shared/aviso-do-documento";
import { ORIGENS_DE_DOCUMENTO } from "@shared/documento-da-reuniao";
import { iniciarDocumento, tetoDosDocumentos } from "../documento-da-reuniao";
import { escolhaDoIdioma, IDIOMA_DA_REUNIAO_PADRAO, IDIOMAS_DA_REUNIAO } from "@shared/idioma-da-reuniao";
import { createPrivateContact, exigirDb } from "../db";
import { meetingContactSuggestions, meetingEntities, meetings, privateContacts, userProfiles } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { procedimentoDaReuniao } from "../guarda-da-lixeira";
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
import { perguntarAReuniao, perguntarDuranteAGravacao, RecusaDaReuniaoComIA, TAMANHO_MAXIMO_DA_PERGUNTA } from "../reuniao-com-ia";
import { transcricaoDuranteAGravacao } from "../transcricao-durante-a-gravacao";
import { criarTeto } from "../assistente-de-texto";
import { audioDoResumoDaDona } from "../resumo-em-audio";
import { decidirComplemento, pedirComplemento } from "../complemento-pela-busca";
import {
  desligarLinkAberto,
  LinkAbertoRecusado,
  ligarLinkAbertoComOpcoes,
  mudarAudioDoLink,
  novaSenhaDoLink,
  tirarSenhaDoLink,
} from "../link-aberto-da-reuniao";
import { ipDaCliente } from "../ip-da-cliente";
import { encerrarGravacaoEmPartes, iniciarReuniaoEmPartes, PARTES_NO_MAXIMO, RecusaDaParte } from "../fatias-de-reuniao";
import { acrescentarItemDoResumo, confirmarItensDoResumo, decidirItemDoResumo, editarItemDoResumo, marcarAcaoFeita, pedirResumoDaDona, refazerResumoDaDona, resumoGuardadoDaDona } from "../resumo-guardado";
import { depoisDeMexerNoItem, prepararAcaoDoItem } from "../acoes-na-google";
import { decidirTituloSugerido } from "../decidir-titulo-sugerido";
import { ROTULO_DA_AGENDA_MAX } from "@shared/acoes-na-agenda";
import { FUSO_MAX } from "@shared/agenda";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { MODELOS_DE_RESUMO } from "@shared/modelos-de-resumo";
import { mapaMentalDaDona, pedirMapaDaDona } from "../mapa-mental-guardado";
import { traduzirResumoDaDona } from "../traducao-do-resumo";
import { rascunharEmailDeRetorno } from "../email-de-retorno";
import { RELACOES_DO_EMAIL, TONS_DO_EMAIL } from "@shared/email-de-retorno";
import { CAMPO_DO_ITEM_DO_RESUMO_MAX, SECOES_DO_RESUMO, TEXTO_DO_ITEM_DO_RESUMO_MAX } from "@shared/item-do-resumo";
import { EXPORTACOES_POR_JANELA, FORMATOS_DA_EXPORTACAO, JANELA_DA_EXPORTACAO_MS, MENSAGEM_EXPORTACOES_DEMAIS } from "@shared/exportar-reuniao";
import { exportarReuniao } from "../exportar-reuniao";
import { EMAIL_DO_PARTICIPANTE_MAX, PARTICIPANTES_DA_AGENDADA_MAX } from "@shared/agenda";
import { definirEnvioAutomaticoDoResumo, mandarResumoPorEmail, mandarResumoPorEmailDeNovo, painelDoResumoPorEmail } from "../resumo-por-email";
import {
  AUDIOS_POR_JANELA, FORMATOS_DO_AUDIO, JANELA_DO_AUDIO_MS, RECUSAS_DO_AUDIO, ROTA_DO_AUDIO_BAIXADO, VALIDADE_DO_ENDERECO_DO_AUDIO_MS,
  nomeDoArquivoDoAudio, tamanhoEstimadoDoAudio,
} from "@shared/baixar-audio";
import { balcaoDoAudio, ffmpegDisponivel, prepararAudioDaReuniao } from "../baixar-audio-da-reuniao";
import { TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE, VERSOES_DO_AVISO_DO_YOUTUBE } from "@shared/youtube";
import { pedirResumoDoVideo, RecusaDoVideo, refazerResumoDoVideo, type ContaQuePede } from "../youtube";
import { atualizarDetalhesDaReuniao, conferirContatoEContexto } from "../detalhes-da-reuniao";
import { ETIQUETA_MAX, ETIQUETAS_POR_REUNIAO_MAX, ONDE_FOI_MAX } from "@shared/detalhes-da-reuniao";
import { buscarNasReunioes } from "../busca-de-reunioes";
import {
  BUSCAS_POR_JANELA, JANELA_DA_BUSCA_MS, MENSAGEM_BUSCAS_DEMAIS, ORIGENS_DO_FILTRO, PERIODOS_DO_FILTRO, TERMO_DA_BUSCA_MAX, TERMO_DA_BUSCA_MIN,
} from "@shared/busca-de-reunioes";
import { juntarReunioes, RecusaDaJuncao } from "../juntar-reunioes";
import { JANELA_DA_JUNCAO_MS, JUNCOES_POR_JANELA, RECUSAS_DA_JUNCAO, REUNIOES_POR_JUNCAO_MAX } from "@shared/juntar-reunioes";
import { registrarLegendaLigada } from "../legenda-ao-vivo";
import { JANELA_DA_LEGENDA_MS, LEGENDAS_POR_JANELA, RECUSAS_DA_LEGENDA, TEXTO_DO_AVISO_DA_LEGENDA_MAX, VERSOES_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";
import { editarTranscricao, RecusaDaEdicao } from "../editar-transcricao";
import {
  EDICOES_POR_JANELA, JANELA_DA_EDICAO_MS, LOCALIZAR_MAX, RECUSAS_DA_EDICAO, SUBSTITUIR_POR_MAX, TEXTO_CORRIDO_MAX, TEXTO_DO_TRECHO_MAX,
} from "@shared/editar-transcricao";
import { apagarPasta, criarPasta, editarPasta, listarPastas, moverParaPasta, RecusaDaPasta } from "../pastas-de-reunioes";
import { CORES_DA_PASTA, ICONES_DA_PASTA, NOME_DA_PASTA_MAX, REUNIOES_POR_ACAO_MAX } from "@shared/pastas-de-reunioes";
import { apagarDeVez, esvaziarLixeira, listarLixeira, mandarParaALixeira, RecusaDaLixeira, restaurarDaLixeira, type ProvaDaLixeira } from "../lixeira-de-reunioes";
import { REUNIOES_POR_EXCLUSAO_MAX } from "@shared/lixeira-de-reunioes";

// O que a dona pede ao editar a transcrição (H18): o zod barra a forma e o
// tamanho; quem confere a posição do trecho, a voz e o texto vazio, e recusa
// com o código traduzível, é o serviço (server/editar-transcricao.ts). A
// posição conta as falas da transcrição, como a lista da tela.
const posicaoDoTrecho = z.number().int().min(0).max(1_000_000);
const operacaoDaEdicao = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("texto"), indice: posicaoDoTrecho, texto: z.string().max(TEXTO_DO_TRECHO_MAX) }),
  z.object({ tipo: z.literal("voz"), indice: posicaoDoTrecho, falante: z.string().regex(FORMATO_DO_FALANTE) }),
  z.object({
    tipo: z.literal("substituir"),
    // Sem aparar: "R$ " e " ," são o que a dona quer achar; só espaço sozinho não.
    localizar: z.string().min(1).max(LOCALIZAR_MAX).refine(valor => valor.trim().length > 0),
    substituirPor: z.string().max(SUBSTITUIR_POR_MAX),
    diferenciarMaiusculas: z.boolean().optional(),
  }),
  z.object({ tipo: z.literal("textoCorrido"), texto: z.string().max(TEXTO_CORRIDO_MAX) }),
  z.object({ tipo: z.literal("restaurar"), indice: posicaoDoTrecho }),
  z.object({ tipo: z.literal("restaurarTudo") }),
]);

// H7d: as reuniões de uma ação de várias (mover, mandar para a lixeira,
// restaurar) e o nome da pasta, que o serviço apara, junta os espaços e corta
// (shared/pastas-de-reunioes.ts); aqui só o teto do pedido.
const idsDaAcao = z.array(z.string().uuid()).min(1).max(REUNIOES_POR_ACAO_MAX);
const nomeDaPastaNoPedido = z.string().max(NOME_DA_PASTA_MAX * 4);

/** As recusas das pastas saem com o código tRPC e o código que a tela traduz. */
async function comRecusaDaPasta<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaDaPasta) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
    throw erro;
  }
}

/** As recusas da lixeira, pela mesma regra. */
async function comRecusaDaLixeira<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaDaLixeira) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
    throw erro;
  }
}

/** Quem pede, para a auditoria da lixeira. */
function provaDaDona(ctx: { user: { id: number }; req: Parameters<typeof ipDaCliente>[0] & { headers: Record<string, unknown> } }): ProvaDaLixeira {
  const agente = ctx.req.headers["user-agent"];
  return { userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: typeof agente === "string" ? agente : null };
}

// Os e-mails que a tela manda ao resumo por e-mail (H22): o zod só barra o
// tamanho; quem conta, valida e recusa com a frase traduzível é o serviço
// (server/resumo-por-email.ts).
const emailsDoPedido = z.array(z.string().trim().max(EMAIL_DO_PARTICIPANTE_MAX)).max(PARTICIPANTES_DA_AGENDADA_MAX);

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

// Exportar a reunião (H8) lê a transcrição inteira (até 16 MiB) e grava uma
// linha de auditoria a cada vez: teto próprio por dona, em memória como os
// outros, de 30 exportações a cada 10 minutos. Só conta a exportação que saiu:
// a recusa (outra conta, reunião que não está pronta) e a falha (banco fora do
// ar, auditoria que não entrou) devolvem a vaga.
export const tetoDaExportacao = criarTeto(EXPORTACOES_POR_JANELA, JANELA_DA_EXPORTACAO_MS, MENSAGEM_EXPORTACOES_DEMAIS);

// Cada senha nova do link aberto (H23) é um scrypt e uma linha de auditoria:
// teto próprio por dona, em memória como os outros, de 20 a cada 10 minutos,
// somando a senha nova e o ligar com senha. Só conta a senha que saiu: a
// recusa (outra conta, link desligado), a falha e o ligar do link que já
// estava ligado devolvem a vaga.
export const SENHAS_DO_LINK_POR_JANELA = 20;
export const tetoDasSenhasDoLink = criarTeto(
  SENHAS_DO_LINK_POR_JANELA,
  10 * 60_000,
  "Muitas senhas novas em sequência. Aguarde alguns minutos e tente de novo.",
);
// Baixar o áudio (H8c) converte a reunião inteira com o ffmpeg, na instância de
// 1 CPU: teto próprio por dona, de 10 áudios a cada hora, em memória como os
// outros. Só conta o áudio preparado: a recusa (outra conta, ainda gravando,
// áudio vencido, instância ocupada) e a falha (banco fora do ar, auditoria que
// não entrou) devolvem a vaga. A recusa sai como código (RECUSAS_DO_AUDIO), que
// a tela traduz.
export const tetoDoAudio = criarTeto(AUDIOS_POR_JANELA, JANELA_DO_AUDIO_MS, RECUSAS_DO_AUDIO.demais);

// A busca entre as reuniões (H7b) lê as transcrições da dona a cada pedido:
// teto próprio por dona, de 120 buscas a cada 10 minutos, em memória como os
// outros. A tela só pergunta a partir de 3 letras, e espera a dona parar de
// digitar. A recusa sai como código (MENSAGEM_BUSCAS_DEMAIS), que a tela traduz.
export const tetoDaBusca = criarTeto(BUSCAS_POR_JANELA, JANELA_DA_BUSCA_MS, MENSAGEM_BUSCAS_DEMAIS);

// Juntar reuniões (H17) refaz a extração e o resumo pela IA (e transcreve de
// novo o que veio do envio único): teto próprio por dona, de 3 junções a cada
// 10 minutos. Só conta a junção que entrou; a recusa devolve a vaga.
export const tetoDaJuncao = criarTeto(JUNCOES_POR_JANELA, JANELA_DA_JUNCAO_MS, RECUSAS_DA_JUNCAO.demais);

// Ligar a legenda ao vivo (G15b) grava uma linha de auditoria a cada vez: teto
// próprio por dona, de 30 a cada hora, em memória como os outros (a tela pede
// uma vez por gravação). Só conta o ligar aceito; a recusa e a falha devolvem
// a vaga. A recusa sai como código (RECUSAS_DA_LEGENDA), que a tela traduz.
export const tetoDaLegenda = criarTeto(LEGENDAS_POR_JANELA, JANELA_DA_LEGENDA_MS, RECUSAS_DA_LEGENDA.demais);
// Editar a transcrição (H18) regrava as falas da reunião e uma linha de
// auditoria a cada mudança: teto próprio por dona, de 200 edições a cada 10
// minutos, em memória como os outros. Só conta a edição aceita; a recusa e o
// pedido que não mudou nada devolvem a vaga.
export const tetoDaEdicao = criarTeto(EDICOES_POR_JANELA, JANELA_DA_EDICAO_MS, RECUSAS_DA_EDICAO.demais);

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

/** A conta que pede o vídeo do YouTube, para a trava, o teto e a auditoria do pedido (server/youtube.ts). */
function contaQuePede(ctx: { user: { id: number; openId: string }; req: Parameters<typeof ipDaCliente>[0] }): ContaQuePede {
  const agente = ctx.req.headers["user-agent"];
  return { userId: ctx.user.id, openId: ctx.user.openId, ipAddress: ipDaCliente(ctx.req), userAgent: typeof agente === "string" ? agente : null };
}

/** As recusas do vídeo do YouTube saem com o código tRPC e o código do erro, que a tela traduz. */
async function comRecusaDoVideo<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof RecusaDoVideo) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
    throw erro;
  }
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
// deploy, manda 'pt'; sem idioma vale o padrão. G16: vale todo idioma que a IA
// transcreve (os 10 da tela e os outros) e "auto" ("Detectar sozinho"); fora
// disso, recusa: o código é gravado e decide o original da tradução.
export const idiomaDaReuniaoNaEntrada = z.string().max(12).optional().transform((valor, ctx) => {
  if (valor === undefined) return IDIOMA_DA_REUNIAO_PADRAO;
  const idioma = escolhaDoIdioma(valor);
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
  list: procedimentoDaReuniao.query(({ ctx }) => listPrivateMeetings(ctx.user.openId)),

  get: procedimentoDaReuniao.input(z.object({ meetingId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const data = await getPrivateMeeting(ctx.user.openId, input.meetingId);
    if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return data;
  }),

  // O envio único (meetings.submitRecording) nasce aqui. Desde a G14 a tela só
  // o usa para importar um arquivo (o recuo do corte), e manda a origem
  // 'arquivo': sem ela, a reunião ficava fora do filtro "Importadas" (H7d).
  // A origem segue opcional para a aba aberta antes disto, que fica nula.
  create: procedimentoDaReuniao.input(createMeetingInput.extend({
    origem: z.enum(["gravacao", "arquivo"]).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await exigirDb();
    // O contato e o contexto têm de ser da dona (o contexto: dela ou do
    // catálogo), antes de gravar o ponteiro (H7c).
    await conferirContatoEContexto(ctx.user.openId, input, db);
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
      origem: input.origem ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { id };
  }),

  // A reunião gravada em partes (G5): nasce no início da gravação, cada parte
  // chega pela rota binária (server/_core/rota-das-partes.ts) e o fim diz
  // quantas partes houve. A tela que grava em partes é a G9.
  iniciarGravacao: procedimentoDaReuniao.input(createMeetingInput.extend({
    origem: z.enum(["gravacao", "arquivo", "aba"]).default("gravacao"),
  })).mutation(async ({ ctx, input }) => {
    await conferirContatoEContexto(ctx.user.openId, input);
    return iniciarReuniaoEmPartes(ctx.user.openId, {
      title: input.title, language: input.language, consentNoticeVersion: input.consentNoticeVersion ?? null,
      origem: input.origem, contactId: input.contactId, contextId: input.contextId,
    });
  }),

  // A reunião que nasce de um documento (H12 e H12b): um PDF, ou as fotos de um
  // texto, que a tela junta num PDF. Nasce em 'uploading', com o consentimento
  // e a versão do aviso do documento (obrigatória: não há aba antiga sem ela);
  // o arquivo chega depois pela rota binária (server/_core/rota-do-documento.ts),
  // e a leitura segue em segundo plano (server/documento-da-reuniao.ts). Com o
  // teto da hora já cheio, nada nasce (TOO_MANY_REQUESTS): a reunião criada para
  // uma tentativa que a rota recusaria pelo teto ficava "recebendo o documento"
  // na lista quando a dona saía da tela (conferência de tela de 20/11/2026). Só
  // confere, sem gastar: a vaga é da rota, e só o documento aceito a gasta.
  iniciarDocumento: procedimentoDaReuniao.input(createMeetingInput.omit({ consentNoticeVersion: true }).extend({
    consentNoticeVersion: z.enum(VERSOES_DO_AVISO_DO_DOCUMENTO),
    origem: z.enum(ORIGENS_DE_DOCUMENTO),
  })).mutation(async ({ ctx, input }) => {
    tetoDosDocumentos.conferir(ctx.user.openId);
    await conferirContatoEContexto(ctx.user.openId, input);
    return iniciarDocumento(ctx.user.openId, {
      title: input.title, language: input.language, consentNoticeVersion: input.consentNoticeVersion,
      origem: input.origem, contactId: input.contactId, contextId: input.contextId,
    });
  }),

  encerrarGravacao: procedimentoDaReuniao
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

  // O envio único: o áudio inteiro, em base64, num pedido só, até 10 min e 10
  // MB. Desde a G14 o gravador do app não o usa mais (a gravação e o arquivo
  // vão em partes, pela rota das partes); a tela só o chama no recuo do corte,
  // o arquivo curto de um formato que o corte reconhece mas não lê (ALAC,
  // AC-3, o Vorbis no WebM), e manda `recuoDoCorte: true`. Ele fica aqui por
  // esse recuo e por um cliente de fora do repositório que ainda o chame (o
  // "app Expo" que o shared/const.ts cita): cada chamada deixa no log uma
  // linha, com a marca ou sem ela, e a chamada sem a marca é a desse cliente.
  // Tirar a rota, ou levar o recuo às partes, espera uma semana desse log
  // (docs/arquitetura/gravador-de-reunioes.md, G14). Os tetos ficam também
  // porque o reprocesso e a junção leem a gravação inteira das reuniões
  // antigas com eles (meeting-service.ts e juntar-reunioes.ts).
  submitRecording: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      audioBase64: z.string().min(20).max(14_000_000),
      mimeType: z.enum(ALLOWED_MEETING_AUDIO_TYPES),
      durationSeconds: z.number().positive().max(MAX_MEETING_DURATION_SECONDS),
      language: idiomaDaReuniaoNaEntrada,
      recuoDoCorte: z.literal(true).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { recuoDoCorte, ...envio } = input;
      console.info(`[Reuniões] envio único (submitRecording): ${recuoDoCorte ? "recuo do corte do arquivo" : "sem a marca do recuo do corte (cliente de fora do app?)"}, ${envio.mimeType}`);
      let result: Awaited<ReturnType<typeof processMeetingRecording>>;
      try {
        result = await processMeetingRecording({ ...envio, ownerId: ctx.user.openId });
      } catch (erro) {
        if (erro instanceof ReuniaoForaDoEstado || erro instanceof ReuniaoTomadaPorOutraExecucao) {
          throw new TRPCError({ code: "CONFLICT", message: erro.message });
        }
        throw erro;
      }
      return { success: true, transcriptLength: result.transcript.length, entities: result.extraction.entities.length, contacts: result.extraction.contacts.length };
    }),

  // O resumo de um vídeo do YouTube (H13, server/youtube.ts): a dona cola o
  // link de um vídeo público, a IA o lê pela própria URL (só a primeira hora)
  // e a reunião segue o caminho de sempre. Responde com o id assim que a
  // reunião nasce, em 'processing'; a tela acompanha por meetings.get. O
  // servidor nunca busca a URL. Recusas: BAD_REQUEST com YOUTUBE_LINK_INVALIDO
  // e TOO_MANY_REQUESTS com YOUTUBE_TETO_DIARIO (5 vídeos a cada 24 h, contados
  // no banco). A versão do aviso do YouTube é obrigatória: a tela que pede
  // vídeo já nasceu com ela.
  resumirVideoDoYoutube: procedimentoDaReuniao
    .input(z.object({
      title: z.string().trim().min(TITULO_DA_REUNIAO_MIN).max(TITULO_DA_REUNIAO_MAX),
      url: z.string().trim().min(1).max(TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE),
      language: idiomaDaReuniaoNaEntrada,
      consentGranted: z.literal(true),
      consentNoticeVersion: z.enum(VERSOES_DO_AVISO_DO_YOUTUBE),
    }))
    .mutation(({ ctx, input }) => comRecusaDoVideo(async () => {
      const { id, trabalho } = await pedirResumoDoVideo(contaQuePede(ctx), {
        titulo: input.title, url: input.url, idioma: input.language, versaoDoAviso: input.consentNoticeVersion,
      });
      // `trabalho` nunca rejeita: executarVideoDoYoutube termina todo erro em log.
      void trabalho;
      return { id };
    })),

  // O "Tentar de novo" da reunião do YouTube com falha: lê o vídeo outra vez
  // pela URL guardada e gasta uma vaga do mesmo teto. NOT_FOUND, CONFLICT (não
  // está com falha, ou alguém chegou antes), PRECONDITION_FAILED (não é do
  // YouTube, ou a falha se repete com o mesmo vídeo: a mensagem é o código
  // dela) e TOO_MANY_REQUESTS (o teto).
  refazerVideoDoYoutube: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(({ ctx, input }) => comRecusaDoVideo(async () => {
      const { trabalho } = await refazerResumoDoVideo(contaQuePede(ctx), input.meetingId);
      void trabalho;
      return { status: "processing" as const };
    })),

  // Reprocessa uma reunião com falha a partir do áudio que ficou guardado.
  // Devolve assim que a reunião é tomada ('processing'); o resultado aparece em
  // meetings.get e meetings.list. Recusas saem com o código que a tela traduz:
  // NOT_FOUND, CONFLICT (não está com falha, ou alguém chegou antes),
  // PRECONDITION_FAILED (sem áudio ou documento guardado utilizável, ou o
  // documento que falha igual com o mesmo arquivo) e TOO_MANY_REQUESTS.
  reprocess: procedimentoDaReuniao
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

  translateTranscript: procedimentoDaReuniao
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
  resumoGuardado: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(({ ctx, input }) => resumoGuardadoDaDona(ctx.user.openId, input.meetingId)),

  // O título que a IA sugeriu com o resumo: "Usar este título" (usar) troca o
  // título da reunião pela sugestão; "Manter o atual" só registra a decisão.
  // Sem IA, então sem teto. CONFLICT: a sugestão já não espera a dona.
  decidirTituloSugerido: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), usar: z.boolean() }))
    .mutation(({ ctx, input }) => decidirTituloSugerido(ctx.user.openId, input.meetingId, input.usar)),

  // O modelo (H4d) é opcional: a reunião antiga ganha o resumo no modelo que a
  // dona escolheu; sem ele, o Geral (e o que falhou reabre no modelo de antes).
  pedirResumo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), modelo: z.enum(MODELOS_DE_RESUMO).optional() }))
    .mutation(({ ctx, input }) => pedirResumoDaDona(ctx.user.openId, input.meetingId, () => tetoDaIADaReuniao.reservar(ctx.user.openId), input.modelo)),

  // "Refazer como…" (H4d): o resumo volta à fila no modelo escolhido; os itens
  // confirmados, os feitos e os que a dona escreveu ou editou (H4f) ficam, os
  // outros pendentes e ignorados são trocados. Gasta uma vaga do mesmo teto de
  // pedidos à IA.
  refazerResumo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), modelo: z.enum(MODELOS_DE_RESUMO) }))
    .mutation(({ ctx, input }) => refazerResumoDaDona(ctx.user.openId, input.meetingId, input.modelo, () => tetoDaIADaReuniao.reservar(ctx.user.openId))),

  // O mapa mental (H10), na linha do resumo guardado: a fila o gera logo
  // depois do resumo, numa chamada à parte (server/fila-do-resumo.ts). Pedir
  // serve à reunião resumida antes do mapa e ao mapa que falhou, e gasta uma
  // vaga do mesmo teto de pedidos à IA (server/mapa-mental-guardado.ts).
  mapaMental: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(({ ctx, input }) => mapaMentalDaDona(ctx.user.openId, input.meetingId)),

  pedirMapa: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(({ ctx, input }) => pedirMapaDaDona(ctx.user.openId, input.meetingId, () => tetoDaIADaReuniao.reservar(ctx.user.openId))),

  // Desconfirmar apaga a próxima ação do item (H5a), e o evento dela sai da
  // Google Agenda depois (H5c, server/acoes-na-google.ts): o token vem antes da
  // escrita, e só quando a ação tem prazo. Quando o evento fica lá, a resposta
  // diz "falhou" com o id da ação, para o "Tentar de novo" da tela. Quem decide
  // se a ação saiu é o estado gravado, não o pedido: o item escrito pela dona
  // (H4f) que a tela pede de volta a "para conferir" fica confirmado, e a ação
  // dele, com o evento, fica.
  decidirItemDoResumo: procedimentoDaReuniao
    .input(z.object({ itemId: z.string().uuid(), status: z.enum(["pending", "confirmed", "ignored"]) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; acaoId: string | null } & ResultadoNaGoogle> => {
      const conta = { id: ctx.user.id, openId: ctx.user.openId };
      const preparo = input.status === "confirmed" ? null : await prepararAcaoDoItem(conta, input.itemId);
      const { acaoSaiu } = await decidirItemDoResumo(ctx.user.openId, input.itemId, input.status);
      if (!acaoSaiu) return { ok: true as const, acaoId: null, naGoogle: null };
      return { ok: true as const, ...(await depoisDeMexerNoItem(conta, preparo, false)) };
    }),

  confirmarItensDoResumo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({ confirmados: await confirmarItensDoResumo(ctx.user.openId, input.meetingId) })),

  // A caixa da ação no resumo marca também a próxima ação dela (H5a): feita, ela
  // sai da Google Agenda; reaberta, volta, se o prazo ainda vem (H5c). O fuso
  // e os rótulos vêm da tela, como na lista (routers/proximasAcoes.ts).
  marcarAcaoFeita: procedimentoDaReuniao
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
  traduzirResumo: procedimentoDaReuniao
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
  editarItemDoResumo: procedimentoDaReuniao
    .input(z.object({ itemId: z.string().uuid(), ...camposDoItemDoResumo, ...pedidoDaTelaParaAGoogle }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; acaoId: string | null } & ResultadoNaGoogle> => {
      const { itemId, fuso, rotulos, ...campos } = input;
      const conta = { id: ctx.user.id, openId: ctx.user.openId };
      const preparo = await prepararAcaoDoItem(conta, itemId);
      const { acaoQueMudou } = await editarItemDoResumo(ctx.user.openId, itemId, campos);
      if (!acaoQueMudou) return { ok: true as const, acaoId: null, naGoogle: null };
      return { ok: true as const, ...(await depoisDeMexerNoItem(conta, preparo, true, { fuso, rotulos })) };
    }),

  acrescentarItemDoResumo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), secao: z.enum(SECOES_DO_RESUMO), ...camposDoItemDoResumo }))
    .mutation(async ({ ctx, input }) => {
      const { meetingId, secao, ...campos } = input;
      return { id: await acrescentarItemDoResumo(ctx.user.openId, meetingId, secao, campos) };
    }),

  // "Baixar o áudio do resumo" (H19b, server/resumo-em-audio.ts): o MP3 com a
  // voz do Gemini, gerado uma vez por texto e idioma e servido de novo do bucket.
  // O idioma é o do resumo ou o de uma tradução já pronta (H11).
  audioDoResumo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), idioma: z.string().min(2).max(12).optional() }))
    .mutation(async ({ ctx, input }) => audioDoResumoDaDona(ctx.user.openId, input.meetingId, input.idioma, {
      userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"],
    })),

  // O complemento pela busca na web (H4i, server/complemento-pela-busca.ts): a
  // dona pede num item; o que a busca achar espera a decisão dela.
  pedirComplemento: procedimentoDaReuniao
    .input(z.object({ itemId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => pedirComplemento(ctx.user.openId, input.itemId)),

  decidirComplemento: procedimentoDaReuniao
    .input(z.object({ itemId: z.string().uuid(), decisao: z.enum(["confirmar", "descartar"]) }))
    .mutation(async ({ ctx, input }) => {
      await decidirComplemento(ctx.user.openId, input.itemId, input.decisao);
      return { ok: true as const };
    }),

  perguntar: procedimentoDaReuniao
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

  // G15a: a transcrição durante a gravação, só para a dona. A tela do gravador
  // (e o detalhe da reunião em andamento) pergunta de tempos em tempos e recebe
  // o andamento de cada parte e o texto das partes prontas que ainda não tem
  // (`desde`). Sem IA: o texto é o que a fila já transcreveu. Reunião de outra
  // dona, ou excluída, é NOT_FOUND.
  transcricaoDaGravacao: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), desde: z.number().int().min(0).max(PARTES_NO_MAXIMO).default(0) }))
    .query(async ({ ctx, input }) => {
      const dados = await transcricaoDuranteAGravacao(ctx.user.openId, input.meetingId, input.desde);
      if (!dados) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      return dados;
    }),

  // G15a: perguntar à IA sobre o que já foi dito, com a reunião ainda gravando
  // (server/reuniao-com-ia.ts, perguntarDuranteAGravacao). O mesmo teto e as
  // mesmas recusas traduzidas da pergunta de sempre; nada é gravado.
  perguntarDuranteAGravacao: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      pergunta: z.string().trim().min(2).max(TAMANHO_MAXIMO_DA_PERGUNTA),
    }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaIADaReuniao.reservar(ctx.user.openId);
      return comRecusaTraduzida(() => perguntarDuranteAGravacao(ctx.user.openId, input.meetingId, input.pergunta, input.idioma,
        segundaVagaDaPerguntaLonga(() => tetoDaIADaReuniao.reservar(ctx.user.openId), soltarVaga)));
    }),

  // G15b: a legenda ao vivo é do navegador da dona, e o texto dela nunca vem
  // para cá. Antes de ligar, a tela manda a confirmação da dona, com o aviso
  // que ela viu (no Chrome, o áudio costuma ir a um servidor do Google), e o
  // servidor a grava na auditoria (server/legenda-ao-vivo.ts): sem a linha, a
  // legenda não liga. Só na reunião dela que está gravando.
  ligarLegendaAoVivo: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      concordanciaDasPessoas: z.literal(true),
      versaoDoAviso: z.enum(VERSOES_DO_AVISO_DA_LEGENDA),
      // O idioma da tela em que o aviso apareceu, e o aviso como apareceu.
      idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
      textoExibido: z.string().trim().min(1).max(TEXTO_DO_AVISO_DA_LEGENDA_MAX),
    }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaLegenda.reservar(ctx.user.openId);
      try {
        await registrarLegendaLigada(ctx.user.openId, input.meetingId, {
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
          versaoDoAviso: input.versaoDoAviso,
          idioma: input.idioma,
          textoExibido: input.textoExibido,
        });
      } catch (erro) {
        soltarVaga();
        throw erro;
      }
      return { success: true } as const;
    }),

  // H20: o rascunho de um e-mail de retorno, escrito pela IA a partir dos itens
  // que a dona confirmou no resumo guardado (server/email-de-retorno.ts). O
  // servidor só devolve o texto: nada é gravado nem enviado, e a dona manda
  // pelo app de e-mail dela. O nome de quem recebe nem chega aqui (a tela o põe
  // no lugar da marca {DESTINATARIO}); só a voz dela, quando a tela a reconhece.
  rascunharEmailDeRetorno: procedimentoDaReuniao
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

  // H8: o conteúdo do PDF da reunião, que a tela imprime (só PDF, decisão do
  // Roberto de 16/11/2026). Só a dona: o link aberto (routers/reuniaoAberta.ts)
  // não exporta. A leitura e a auditoria MEETING_EXPORTED vão na mesma
  // transação (server/exportar-reuniao.ts): sem a linha, nada sai. A vaga é
  // reservada antes do await, como a do reprocesso, e volta se a exportação
  // não sai.
  exportar: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), formato: z.enum(FORMATOS_DA_EXPORTACAO) }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaExportacao.reservar(ctx.user.openId);
      try {
        return await exportarReuniao(ctx.user.openId, input.meetingId, {
          formato: input.formato,
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
        });
      } catch (erro) {
        soltarVaga();
        throw erro;
      }
    }),

  // H8c: o áudio da reunião num arquivo só, em MP3 ou M4A. Este passo confere a
  // dona, a gravação encerrada e os 30 dias, e lê as partes e grava a auditoria
  // MEETING_AUDIO_DOWNLOADED na mesma transação (server/baixar-audio-da-reuniao.ts):
  // sem a linha, nenhum endereço sai. Devolve um endereço de uso único, que
  // vale 2 minutos e só para a sessão da dona; a rota GET
  // (server/_core/rota-do-audio-baixado.ts) o transmite enquanto converte. As
  // chaves das partes ficam no servidor. O link aberto (routers/reuniaoAberta.ts)
  // não baixa áudio. Ordem: o teto da dona, o ffmpeg, a vaga da instância e só
  // então a transação, para nenhuma recusa gravar auditoria.
  baixarAudio: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      formato: z.enum(FORMATOS_DO_AUDIO),
      // O nome que a tela sugere (o título e a data, como no PDF); o servidor o limpa.
      nome: z.string().max(300).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDoAudio.reservar(ctx.user.openId);
      let reserva: ReturnType<typeof balcaoDoAudio.reservar> | null = null;
      try {
        if (!await ffmpegDisponivel()) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: RECUSAS_DO_AUDIO.indisponivel });
        reserva = balcaoDoAudio.reservar();
        const audio = await prepararAudioDaReuniao(ctx.user.openId, input.meetingId, {
          formato: input.formato,
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
        });
        const nomeDoArquivo = nomeDoArquivoDoAudio(input.nome, input.formato);
        const ficha = reserva.emitir({ ownerId: ctx.user.openId, meetingId: input.meetingId, formato: input.formato, nomeDoArquivo, partes: audio.partes });
        return {
          endereco: `${ROTA_DO_AUDIO_BAIXADO}/${ficha}`,
          nomeDoArquivo,
          validadeMs: VALIDADE_DO_ENDERECO_DO_AUDIO_MS,
          tamanhoEstimadoBytes: tamanhoEstimadoDoAudio(audio.duracaoSegundos),
        };
      } catch (erro) {
        reserva?.soltar();
        soltarVaga();
        throw erro;
      }
    }),

  // O link aberto (pedido do Roberto em 12/11/2026, "por enquanto"): quem tem o
  // endereço ouve, lê e pergunta à IA sem conta na WRW (routers/reuniaoAberta.ts).
  // Só a dona liga e desliga, e só reunião pronta tem link. Ligar exige de novo
  // a palavra dela de que as pessoas da reunião autorizaram compartilhar: o
  // consentimento da gravação foi para um áudio privado. Essa palavra vai para
  // a auditoria na mesma transação que liga o link (ligarLinkAberto). Ligar o
  // que já está ligado devolve o mesmo link.
  //
  // Desde a H23, a dona escolhe ao ligar se o link pede a senha de 6 dígitos
  // e se leva o áudio. A senha volta em texto só nesta resposta (e na de
  // novaSenhaDoLink): o banco guarda o hash. A aba aberta antes do deploy não
  // manda as escolhas, e o link sai como antes, sem senha e com o áudio.
  ligarLinkAberto: procedimentoDaReuniao
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
      comSenha: z.boolean().optional(),
      incluirAudio: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Ligar com senha é um scrypt, como a senha nova: gasta uma vaga do
      // mesmo teto, antes do serviço. A vaga volta na recusa, na falha e
      // quando nenhuma senha saiu (o link já estava ligado).
      const soltarVaga = input.comSenha === true ? tetoDasSenhasDoLink.reservar(ctx.user.openId) : () => {};
      try {
        const ligado = await comRecusaTraduzida(() => ligarLinkAbertoComOpcoes(ctx.user.openId, input.meetingId, {
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
          idioma: input.idioma,
          textoExibido: input.textoExibido,
          versaoDaAutorizacao: input.versaoDaAutorizacao,
        }, { comSenha: input.comSenha, incluirAudio: input.incluirAudio }));
        if (ligado.senha === null) soltarVaga();
        return ligado;
      } catch (erro) {
        soltarVaga();
        throw erro;
      }
    }),

  // Uma senha nova para o link ligado (H23): liga a senha no link que não
  // tinha, ou troca a que havia, e a anterior deixa de valer na hora. A
  // auditoria vai na mesma transação.
  novaSenhaDoLink: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDasSenhasDoLink.reservar(ctx.user.openId);
      try {
        const senha = await comRecusaTraduzida(() => novaSenhaDoLink(ctx.user.openId, input.meetingId, {
          userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"],
        }));
        return { senha };
      } catch (erro) {
        soltarVaga();
        throw erro;
      }
    }),

  // Tira a senha do link ligado (H23): quem tem o endereço volta a abrir sem ela.
  tirarSenhaDoLink: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await comRecusaTraduzida(() => tirarSenhaDoLink(ctx.user.openId, input.meetingId, {
        userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"],
      }));
      return { success: true };
    }),

  // Se o link ligado leva o áudio e o player (H23). A regra vale na consulta do
  // link (server/link-aberto-da-reuniao.ts), não só na tela.
  mudarAudioDoLink: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), incluirAudio: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await comRecusaTraduzida(() => mudarAudioDoLink(ctx.user.openId, input.meetingId, input.incluirAudio, {
        userId: ctx.user.id, ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"],
      }));
      return { success: true };
    }),

  desligarLinkAberto: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await comRecusaTraduzida(() => desligarLinkAberto(ctx.user.openId, input.meetingId));
      await createAuditLog({
        userId: ctx.user.id, action: "MEETING_OPEN_LINK_OFF", resource: "meetings", resourceId: input.meetingId,
        status: "success", riskLevel: "low",
      });
      return { success: true };
    }),

  // H22: o resumo por e-mail (server/resumo-por-email.ts). Com um toque, a
  // WRW manda o link aberto da reunião à própria dona, às participantes da
  // agenda que ela escolher e a e-mails que ela digitar, com texto fixo no
  // idioma da reunião. O link desligado só liga com a mesma confirmação do
  // "Compartilhar por link", que vai para a auditoria junto com o envio. Tetos
  // por envio, por reunião e por dona; a Resend fora do ar deixa o pedido
  // guardado para o "Tentar de novo". Só a dona: reunião de outra conta é
  // "não encontrada".
  resumoPorEmail: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(({ ctx, input }) => painelDoResumoPorEmail(ctx.user.openId, input.meetingId)),

  mandarResumoPorEmail: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      paraMim: z.boolean(),
      participantes: emailsDoPedido,
      outros: emailsDoPedido,
      // Só quando o link está desligado: a palavra da dona, como em ligarLinkAberto.
      autorizacao: z.object({
        autorizacaoDasPessoas: z.literal(true),
        idioma: z.enum(MEETING_TRANSCRIPT_LANGUAGES),
        textoExibido: z.string().trim().min(1).max(1000),
        versaoDaAutorizacao: z.literal(VERSAO_DA_AUTORIZACAO_COM_NOMES).optional(),
      }).optional(),
    }))
    .mutation(({ ctx, input }) => comRecusaTraduzida(() => mandarResumoPorEmail(
      { id: ctx.user.id, openId: ctx.user.openId },
      input.meetingId,
      {
        paraMim: input.paraMim,
        participantes: input.participantes,
        outros: input.outros,
        autorizacao: input.autorizacao
          ? { idioma: input.autorizacao.idioma, textoExibido: input.autorizacao.textoExibido, versaoDaAutorizacao: input.autorizacao.versaoDaAutorizacao }
          : undefined,
      },
      { ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] },
    ))),

  mandarResumoPorEmailDeNovo: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .mutation(({ ctx, input }) => mandarResumoPorEmailDeNovo(
      { id: ctx.user.id, openId: ctx.user.openId },
      input.meetingId,
      { ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] },
    )),

  // O envio automático no fim da reunião (H22), desligado por padrão: vale
  // para a conta, e não para uma reunião.
  envioAutomaticoDoResumo: procedimentoDaReuniao
    .input(z.object({ ligado: z.boolean() }))
    .mutation(({ ctx, input }) => definirEnvioAutomaticoDoResumo(
      { id: ctx.user.id, openId: ctx.user.openId },
      input.ligado,
      { ipAddress: ipDaCliente(ctx.req), userAgent: ctx.req.headers["user-agent"] },
    )),

  decideEntity: procedimentoDaReuniao
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

  decideContactSuggestion: procedimentoDaReuniao
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
  candidatosParaVincular: procedimentoDaReuniao
    .input(z.object({ suggestionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const candidatos = await candidatosParaVincular(ctx.user.openId, input.suggestionId);
      if (!candidatos) throw new TRPCError({ code: "NOT_FOUND", message: "Sugestão não encontrada." });
      return candidatos;
    }),

  // N5: cada pessoa da reunião com o que tem e precisa e as conexões que
  // nasceram dela — o ramo "Conexões desta reunião" do mapa mental e a linha
  // do resumo. Só para a dona: o link aberto não tem nada disto.
  conexoes: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const termoSmartMatch = await hasValidConsent(ctx.user.id, "termo_smart_match");
      const dados = await conexoesDaReuniao(ctx.user.openId, input.meetingId, { termoSmartMatch });
      if (!dados) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      return dados;
    }),

  /** H3: o nome de uma voz da transcrição por falante; nome vazio tira o nome. */
  nomearFalante: procedimentoDaReuniao
    .input(z.object({ meetingId: z.string().uuid(), falante: z.string().regex(FORMATO_DO_FALANTE), nome: z.string().max(NOME_DO_FALANTE_MAX * 2) }))
    .mutation(async ({ ctx, input }) => {
      const nomes = await nomearFalante(ctx.user.openId, input.meetingId, input.falante, input.nome);
      if (!nomes) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      return { nomes };
    }),
  // H18: a dona edita a transcrição de uma reunião pronta dela (o texto ou a
  // voz de um trecho, localizar e substituir, voltar ao original), com a
  // transcrição e a revisão que a tela leu. Recusas como código que a tela
  // traduz (shared/editar-transcricao.ts): NOT_FOUND (outra conta, não
  // existe ou na lixeira, H7d: a guarda antes do zod e o serviço na leitura
  // travada), CONFLICT (não está pronta, ou a transcrição mudou),
  // PRECONDITION_FAILED (documento), BAD_REQUEST (trecho inválido, ou que
  // ficaria vazio) e TOO_MANY_REQUESTS (o teto). A auditoria vai na transação
  // da mudança (server/editar-transcricao.ts).
  editarTranscricao: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      // A transcrição que a tela leu: o servidor compara com a de agora.
      transcricaoId: z.string().min(1).max(64),
      revisao: z.number().int().min(0),
      operacao: operacaoDaEdicao,
    }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaEdicao.reservar(ctx.user.openId);
      try {
        const feita = await editarTranscricao(ctx.user.openId, input.meetingId, {
          transcricaoId: input.transcricaoId, revisao: input.revisao, operacao: input.operacao,
        }, {
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
        });
        if (!feita.mudou) soltarVaga();
        return feita;
      } catch (erro) {
        soltarVaga();
        if (erro instanceof RecusaDaEdicao) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
        throw erro;
      }
    }),
  // H7c: os detalhes da reunião (o título, as etiquetas, o "Onde foi", o
  // contato e o contexto). Campo ausente não muda; nulo (ou lista vazia) tira.
  // A posse do contato e do contexto é conferida antes de gravar; a reunião de
  // outra conta é NOT_FOUND. O link aberto não leva nada disto
  // (server/detalhes-da-reuniao.ts).
  atualizarDetalhes: procedimentoDaReuniao
    .input(z.object({
      meetingId: z.string().uuid(),
      titulo: z.string().trim().min(TITULO_DA_REUNIAO_MIN).max(TITULO_DA_REUNIAO_MAX).optional(),
      // O servidor normaliza (espaços, repetidas, o corte em ETIQUETA_MAX); aqui só o teto do pedido.
      etiquetas: z.array(z.string().max(ETIQUETA_MAX * 2)).max(ETIQUETAS_POR_REUNIAO_MAX * 2).nullable().optional(),
      ondeFoi: z.string().max(ONDE_FOI_MAX * 2).nullable().optional(),
      contactId: z.number().int().positive().nullable().optional(),
      contextId: z.string().uuid().nullable().optional(),
    }))
    .mutation(({ ctx, input }) => {
      const { meetingId, ...campos } = input;
      return atualizarDetalhesDaReuniao(ctx.user.openId, meetingId, campos);
    }),

  // H7b: a busca entre as reuniões da dona, na transcrição e nos itens do
  // resumo que não foram ignorados, com os filtros da tela
  // (server/busca-de-reunioes.ts). Até 30 resultados, com o teto de 120 buscas
  // a cada 10 minutos (tetoDaBusca). Consulta, e não mutação: a tela a pede a
  // cada termo; a vaga é gasta por pedido que passa da validação.
  buscar: procedimentoDaReuniao
    .input(z.object({
      termo: z.string().trim().min(TERMO_DA_BUSCA_MIN).max(TERMO_DA_BUSCA_MAX),
      etiqueta: z.string().max(ETIQUETA_MAX * 2).nullish(),
      origem: z.enum(ORIGENS_DO_FILTRO).nullish(),
      periodo: z.enum(PERIODOS_DO_FILTRO).nullish(),
      contactId: z.number().int().positive().nullish(),
      contextId: z.string().uuid().nullish(),
    }))
    .query(async ({ ctx, input }) => {
      const soltarVaga = tetoDaBusca.reservar(ctx.user.openId);
      const { termo, ...filtros } = input;
      try {
        return await buscarNasReunioes(ctx.user.openId, termo, filtros);
      } catch (erro) {
        soltarVaga();
        throw erro;
      }
    }),

  // H17: juntar duas ou mais reuniões numa só, na ordem dada (a primeira
  // fica). Responde quando a transação termina, com a reunião que fica em
  // 'uploading'; a fila monta a transcrição e refaz o resumo em segundo plano
  // (server/juntar-reunioes.ts). Recusas como código que a tela traduz:
  // NOT_FOUND (outra conta, ou não existe), CONFLICT (alguma não está pronta),
  // PRECONDITION_FAILED (documento ou YouTube, áudio vencido, longa demais),
  // BAD_REQUEST (repetida) e TOO_MANY_REQUESTS (o teto de junções).
  juntar: procedimentoDaReuniao
    .input(z.object({ meetingIds: z.array(z.string().uuid()).min(2).max(REUNIOES_POR_JUNCAO_MAX) }))
    .mutation(async ({ ctx, input }) => {
      const soltarVaga = tetoDaJuncao.reservar(ctx.user.openId);
      try {
        return await juntarReunioes(ctx.user.openId, input.meetingIds, {
          userId: ctx.user.id,
          ipAddress: ipDaCliente(ctx.req),
          userAgent: ctx.req.headers["user-agent"],
        });
      } catch (erro) {
        soltarVaga();
        if (erro instanceof RecusaDaJuncao) throw new TRPCError({ code: erro.codigoTrpc, message: erro.message });
        throw erro;
      }
    }),

  // H7d: as pastas da dona (server/pastas-de-reunioes.ts), com quantas
  // reuniões fora da lixeira cada uma tem. Nome, ícone e cor de listas
  // fechadas; as recusas saem como código (RECUSAS_DAS_PASTAS), que a tela
  // traduz. Sem IA nem bucket: sem teto.
  pastas: procedimentoDaReuniao.query(({ ctx }) => listarPastas(ctx.user.openId)),

  criarPasta: procedimentoDaReuniao
    .input(z.object({ nome: nomeDaPastaNoPedido, icone: z.enum(ICONES_DA_PASTA), cor: z.enum(CORES_DA_PASTA) }))
    .mutation(({ ctx, input }) => comRecusaDaPasta(() => criarPasta(ctx.user.openId, input))),

  editarPasta: procedimentoDaReuniao
    .input(z.object({
      pastaId: z.string().uuid(), nome: nomeDaPastaNoPedido.optional(), icone: z.enum(ICONES_DA_PASTA).optional(), cor: z.enum(CORES_DA_PASTA).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { pastaId, ...dados } = input;
      await comRecusaDaPasta(() => editarPasta(ctx.user.openId, pastaId, dados));
      return { success: true };
    }),

  // Apagar a pasta não apaga reunião: as dela ficam sem pasta.
  apagarPasta: procedimentoDaReuniao
    .input(z.object({ pastaId: z.string().uuid() }))
    .mutation(({ ctx, input }) => comRecusaDaPasta(() => apagarPasta(ctx.user.openId, input.pastaId))),

  // Põe as reuniões escolhidas numa pasta, ou as tira de pasta (pastaId nulo).
  // A guarda recusa a reunião da lixeira, e o serviço confere de novo.
  moverParaPasta: procedimentoDaReuniao
    .input(z.object({ meetingIds: idsDaAcao, pastaId: z.string().uuid().nullable() }))
    .mutation(({ ctx, input }) => comRecusaDaPasta(() => moverParaPasta(ctx.user.openId, input.meetingIds, input.pastaId))),

  // H7d: a lixeira (server/lixeira-de-reunioes.ts). Os ÚNICOS procedimentos
  // sem a guarda da lixeira: são os que leem ou mexem na reunião de lá, e cada
  // serviço confere sozinho a dona, a reunião de fora e o prazo de 30 dias.
  // Mandar para a lixeira desliga o link aberto e grava a auditoria na mesma
  // transação; apagar de vez segue a exclusão de sempre (deletePrivateMeeting).
  lixeira: protectedProcedure.query(({ ctx }) => listarLixeira(ctx.user.openId)),

  mandarParaALixeira: protectedProcedure
    .input(z.object({ meetingIds: idsDaAcao }))
    .mutation(({ ctx, input }) => comRecusaDaLixeira(() => mandarParaALixeira(ctx.user.openId, input.meetingIds, provaDaDona(ctx)))),

  restaurarDaLixeira: protectedProcedure
    .input(z.object({ meetingIds: idsDaAcao }))
    .mutation(({ ctx, input }) => comRecusaDaLixeira(() => restaurarDaLixeira(ctx.user.openId, input.meetingIds, provaDaDona(ctx)))),

  apagarDeVez: protectedProcedure
    .input(z.object({ meetingIds: z.array(z.string().uuid()).min(1).max(REUNIOES_POR_EXCLUSAO_MAX) }))
    .mutation(({ ctx, input }) => comRecusaDaLixeira(() => apagarDeVez(ctx.user.openId, input.meetingIds, provaDaDona(ctx)))),

  // Uma rodada por pedido (até REUNIOES_POR_EXCLUSAO_MAX reuniões); `restam`
  // diz à tela se pede de novo.
  esvaziarLixeira: protectedProcedure.mutation(({ ctx }) => esvaziarLixeira(ctx.user.openId, provaDaDona(ctx))),

  // O Excluir de sempre, imediato: o caminho do "Descartar" da gravação em
  // curso (useGravacaoEmPartes, os descartes pendentes e a retomada), do
  // documento que não subiu e da gravação ainda no ar. A tela da reunião
  // pronta manda para a lixeira (mandarParaALixeira).
  //
  // Sem a guarda da lixeira, de propósito: quem chama quer a reunião fora
  // agora, e a que foi para a lixeira por outro aparelho no meio também sai
  // (deletePrivateMeeting não olha o trashed_at). Com a guarda, o NOT_FOUND
  // dela era lido pelo descarte pendente como "já saiu", e a gravação que a
  // dona descartou ficava 30 dias restaurável na lixeira.
  delete: protectedProcedure.input(z.object({ meetingId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await deletePrivateMeeting(ctx.user.openId, input.meetingId);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    return { success: true };
  }),
});
