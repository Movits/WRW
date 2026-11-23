import crypto from "crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { auditLogs, meetings, users } from "../drizzle/schema";
import { escolhaDoIdioma, IDIOMA_AUTOMATICO, IDIOMA_DA_REUNIAO_PADRAO, idiomaDaTranscricao, type EscolhaDoIdioma } from "@shared/idioma-da-reuniao";
import {
  erroDoYoutubeSeRepete, idDoVideoDoYoutube, SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX, urlCanonicaDoYoutube, VIDEOS_DO_YOUTUBE_POR_DIA,
  type CodigoDeErroDoYoutube, type VersaoDoAvisoDoYoutube,
} from "@shared/youtube";
import { textoTemFala } from "@shared/fala-na-transcricao";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { reuniaoForaDeVista } from "./reuniao-visivel";
import { geminiPost, GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError, prazoEsgotadoNoGemini, raciocinioBaixo } from "./gemini";
import { modeloDeAudio, modeloDeAudioReserva } from "./_core/modelos-de-ia";
import {
  extrairDadosDaReuniao, gravarResultadoDaReuniao, MENSAGEM_REPROCESSO_EM_CONFLITO, MENSAGEM_REUNIAO_NAO_ENCONTRADA,
  ReuniaoExcluidaDuranteProcessamento, ReuniaoTomadaPorOutraExecucao,
} from "./meeting-service";
import { entradaDoResumo } from "./resumo-da-reuniao";
import { linhaDoIdioma, normalizarSegmentos, PADRAO_DO_TEMPO, PROPRIEDADE_DO_IDIOMA, REGRA_DO_IDIOMA_DA_FALA, type Segmento } from "./transcricao-de-fatia";

/**
 * O resumo de um vídeo do YouTube (H13 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), como no HiNoter que a Dra.
 * Glenda viu: a dona cola o link de um vídeo público e ganha a reunião com a
 * transcrição por falante, o resumo guardado, o mapa mental e o Pergunte.
 *
 * O SERVIDOR NUNCA BUSCA A URL. Do link colado sai só o id
 * (idDoVideoDoYoutube, em shared/youtube.ts, a mesma regra da tela), e a
 * reunião guarda a URL canônica montada por ele (`meetings.source_url`). Quem
 * lê o vídeo é o Gemini, pela própria URL (`file_data.file_uri`), e só a
 * primeira hora (`video_metadata.end_offset`). A resposta volta no contrato da
 * transcrição em partes (`{inicio, fim, falante, texto}`, com os tempos em
 * texto "MM:SS", como a fatia pede desde a #219: server/transcricao-de-fatia.ts),
 * e daí em diante é o caminho de sempre: a extração lê as falas com o rótulo da
 * voz, e gravarResultadoDaReuniao grava a transcrição, as sugestões, o pedido
 * do resumo guardado (a fila do resumo faz o resumo e o mapa) e a reunião
 * pronta, tudo arbitrado pela FICHA, como no reprocesso.
 *
 * O pedido responde na hora, com a reunião em 'processing', e o trabalho segue
 * em segundo plano; a tela consulta a cada 5 s. Um deploy no meio deixa a
 * reunião em 'processing', e a varredura de interrompidas a marca como falha
 * (ERRO_INTERROMPIDO) em até 20 min; o "Tentar de novo" (refazerResumoDoVideo)
 * lê o vídeo outra vez.
 *
 * O TETO é de VIDEOS_DO_YOUTUBE_POR_DIA vídeos por dona a cada 24 h, contados
 * no banco (a auditoria do pedido), e não em memória: um teto de um dia que
 * zerasse a cada deploy não seguraria nada. Excluir a reunião não devolve a
 * vaga, e o "Tentar de novo" gasta uma, porque cada um manda o vídeo à IA.
 *
 * O CONSENTIMENTO grava a versão do aviso do YouTube (consentNoticeVersion),
 * como a G4 no gravador, na reunião e na auditoria do pedido, com IP e
 * user-agent, na mesma transação que cria a reunião.
 */

// A função pura que tira o id do link, e a URL que a reunião guarda.
export { idDoVideoDoYoutube, urlCanonicaDoYoutube };

/** O que a auditoria registra a cada vídeo que vai à IA. É também o que o teto conta. */
export const ACAO_DO_VIDEO_DO_YOUTUBE = "MEETING_YOUTUBE_REQUESTED";

// Os quadros que o Gemini tira do vídeo, por segundo. A fala vem do áudio; os
// quadros só ajudam a ler um nome escrito na tela. Um quadro a cada 5 s, em
// baixa resolução (70 tokens por quadro na família 3 do Gemini, 66 na 2.5),
// põe a hora inteira em cerca de 165 mil tokens de entrada (o áudio é 32 por
// segundo), contra uns 370 mil com um quadro por segundo. A documentação aceita
// de 0 a 24 quadros por segundo, e menos de 1 para vídeo longo e parado.
export const QUADROS_POR_SEGUNDO_DO_VIDEO = 0.2;
// Uma hora de fala corrida passa de 20 mil tokens de JSON: o teto de saída dos
// modelos Flash, e não o da parte de 10 min (32 mil, em server/gemini.ts).
export const SAIDA_MAXIMA_DO_VIDEO = 65_536;
// Os prazos cabem nos 15 min em que a reunião pode ficar em 'processing'
// antes de a varredura de interrompidas dá-la como falha (LIMITE_PROCESSAMENTO_MS).
// Cada chamada tem até 8 min. A nova tentativa no mesmo modelo só sai se a
// falha veio cedo (orçamento de 4 min), e a reserva só se o principal falhou
// em menos de 2 min: o pior caso, uma falha aos 3 min e a nova tentativa
// estourando o prazo, fica em 11 min. Com o vídeo transcrito, a ficha se
// renova (renovarFicha), e a extração ganha outros 15 min.
const TIMEOUT_DO_VIDEO_MS = 8 * 60_000;
const ORCAMENTO_DO_VIDEO_MS = 4 * 60_000;
const RESERVA_SO_ATE_MS = 2 * 60_000;

const DESCRICAO_DO_TEMPO = 'Tempo da fala contado do começo do vídeo, como texto "MM:SS" (a partir de uma hora, "H:MM:SS").';

// O responseSchema do Gemini, no contrato da transcrição em partes
// (server/transcricao-de-fatia.ts): os tempos são TEXTO com padrão, nunca
// número, e a ordem das propriedades é a do contrato.
const ESQUEMA_DA_RESPOSTA_DO_VIDEO = {
  type: "OBJECT",
  properties: {
    segmentos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          inicio: { type: "STRING", description: DESCRICAO_DO_TEMPO, pattern: PADRAO_DO_TEMPO },
          fim: { type: "STRING", description: DESCRICAO_DO_TEMPO, pattern: PADRAO_DO_TEMPO },
          falante: { type: "STRING" },
          texto: { type: "STRING" },
        },
        required: ["inicio", "fim", "falante", "texto"],
        propertyOrdering: ["inicio", "fim", "falante", "texto"],
      },
    },
  },
  required: ["segmentos"],
} as const;

// "Detectar sozinho" (G16): cada fala ganha o código do idioma, depois do
// texto, como na fatia (server/transcricao-de-fatia.ts).
const ESQUEMA_DA_RESPOSTA_DO_VIDEO_COM_IDIOMA = {
  type: "OBJECT",
  properties: {
    segmentos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { ...ESQUEMA_DA_RESPOSTA_DO_VIDEO.properties.segmentos.items.properties, idioma: PROPRIEDADE_DO_IDIOMA },
        required: [...ESQUEMA_DA_RESPOSTA_DO_VIDEO.properties.segmentos.items.required, "idioma"],
        propertyOrdering: [...ESQUEMA_DA_RESPOSTA_DO_VIDEO.properties.segmentos.items.propertyOrdering, "idioma"],
      },
    },
  },
  required: ["segmentos"],
} as const;

/** Um erro do vídeo com o código que a tela traduz (CODIGOS_DE_ERRO_DO_YOUTUBE). */
export class ErroDoVideoDoYoutube extends Error {
  constructor(readonly codigo: CodigoDeErroDoYoutube, opcoes?: { cause?: unknown }) {
    super(codigo, opcoes);
    this.name = "ErroDoVideoDoYoutube";
  }
}

/**
 * A recusa de um pedido, antes de qualquer trabalho: o router a traduz em
 * TRPCError com este código, e a mensagem é o código do vídeo (a tela traduz)
 * ou a frase de sempre do reprocesso.
 */
export class RecusaDoVideo extends Error {
  constructor(readonly codigoTrpc: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS", mensagem: string) {
    super(mensagem);
    this.name = "RecusaDoVideo";
  }
}

export const MENSAGEM_REUNIAO_NAO_E_DO_YOUTUBE = "Esta reunião não veio de um vídeo do YouTube.";

/**
 * As instruções da transcrição do vídeo, no molde da fatia (promptDaFatia):
 * com "Detectar sozinho" (G16), sem o idioma e com o código do idioma de cada
 * fala; com o idioma escolhido, as de sempre.
 */
export function promptDoVideo(idioma: EscolhaDoIdioma): string {
  return [
    "Transcreva integralmente a fala deste vídeo do YouTube (só a primeira hora dele chega a você).",
    linhaDoIdioma(idioma),
    "Regras:",
    "1) Transcrição literal: não resuma, não corrija e não invente. Preserve nomes próprios, empresas, números, telefones e e-mails.",
    '2) "inicio" e "fim" são o tempo da fala contado do começo do vídeo, escrito como texto "MM:SS" (minutos e segundos, cada um com dois dígitos: "00:07", "12:05", "59:58"); só a partir de uma hora, "H:MM:SS" ("1:00:00"). Nunca escreva o tempo como número. Transcreva até o fim do que chegou a você.',
    '3) Separe as vozes: cada fala é um item, e "falante" é "F1", "F2", "F3"... A mesma voz fica sempre com o mesmo rótulo. Nunca use nomes de pessoas no rótulo, nem quando o nome aparece escrito no vídeo.',
    "4) Quebre falas longas em itens de até 1 minuto, com o mesmo falante.",
    "5) Música (cantada ou não), ruído longo ou trecho que não dá para entender: uma marca curta entre colchetes, na língua da fala em volta (em português: [música], [ruído], [inaudível]). Não transcreva letra de música. Silêncio não vira item.",
    "6) Texto que só aparece escrito no vídeo, sem que ninguém o diga, não é fala e não vira item.",
    '7) Vídeo sem fala nenhuma: devolva "segmentos" vazio.',
    ...(idioma === IDIOMA_AUTOMATICO ? [`8) ${REGRA_DO_IDIOMA_DA_FALA}`] : []),
  ].join("\n");
}

/**
 * O corpo do pedido ao Gemini (generateContent): o vídeo pela URL canônica,
 * cortado na primeira hora, com poucos quadros em baixa resolução, e a
 * resposta em JSON no contrato da transcrição. O vídeo vai antes do texto,
 * como a documentação do Gemini pede para um vídeo só.
 */
export function pedidoDoVideoAoGemini(input: { urlCanonica: string; idioma: EscolhaDoIdioma; modelo: string }) {
  return {
    contents: [{ parts: [
      {
        file_data: { file_uri: input.urlCanonica },
        video_metadata: { start_offset: "0s", end_offset: `${SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX}s`, fps: QUADROS_POR_SEGUNDO_DO_VIDEO },
      },
      { text: promptDoVideo(input.idioma) },
    ] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: SAIDA_MAXIMA_DO_VIDEO,
      thinkingConfig: raciocinioBaixo(input.modelo),
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      responseMimeType: "application/json",
      responseSchema: input.idioma === IDIOMA_AUTOMATICO ? ESQUEMA_DA_RESPOSTA_DO_VIDEO_COM_IDIOMA : ESQUEMA_DA_RESPOSTA_DO_VIDEO,
    },
  };
}

type RespostaDoVideo = {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

// A recusa que é da configuração do servidor (chave, faturamento, modelo), e
// não do vídeo: o JSON do Google diz qual é. A que fala de tokens é o vídeo
// grande demais para a IA ler de uma vez.
const RECUSA_DA_CONFIGURACAO = /API[ _-]?key|billing|SERVICE_DISABLED|has not been used|is not found for API version|not supported for generateContent|location is not supported/i;
const RECUSA_PELO_TAMANHO = /token count|maximum number of tokens|exceeds the maximum|too (?:long|large)/i;

/**
 * O código do erro do vídeo para cada falha. O Gemini responde 400 tanto ao
 * vídeo privado ou não listado (só vídeo público funciona) quanto ao pedido
 * malformado, sem dizer qual dos dois: a recusa que não é da configuração nem
 * do tamanho é dada como vídeo indisponível, que é a causa provável aqui (o
 * pedido é sempre o mesmo). Cortada em MAX_TOKENS é fala demais para uma
 * resposta; parada por outro motivo (SAFETY, RECITATION...) é recusa da IA. O
 * prazo esgotado do lado do Gemini (504, DEADLINE_EXCEEDED) chega como recusa,
 * mas é a IA que não deu conta a tempo: vem antes do ramo da recusa.
 */
export function codigoDaFalhaDoVideo(erro: unknown): CodigoDeErroDoYoutube {
  if (erro instanceof ErroDoVideoDoYoutube) return erro.codigo;
  if (erro instanceof GeminiRespostaCortadaError) return erro.motivo === "MAX_TOKENS" ? "YOUTUBE_LONGO_DEMAIS" : "YOUTUBE_IA_RECUSOU";
  if (prazoEsgotadoNoGemini(erro)) return "YOUTUBE_IA_INDISPONIVEL";
  if (erro instanceof GeminiRecusouChamadaError) {
    if (erro.status === 401 || RECUSA_DA_CONFIGURACAO.test(erro.detalhe)) return "YOUTUBE_IA_RECUSOU";
    if (erro.status === 413 || RECUSA_PELO_TAMANHO.test(erro.detalhe)) return "YOUTUBE_LONGO_DEMAIS";
    return "YOUTUBE_VIDEO_PRIVADO";
  }
  // Lotado, sem cota ou sem resposta no prazo (GeminiCotaEsgotadaError também).
  if (erro instanceof GeminiIndisponivelError) return "YOUTUBE_IA_INDISPONIVEL";
  return "YOUTUBE_FALHOU";
}

/**
 * Se alguém fala: algum texto com letra ou número fora das marcas entre
 * colchetes ([música]). A regra é a mesma da tela (textoTemFala, em
 * shared/fala-na-transcricao.ts).
 */
export function temFala(segmentos: readonly Segmento[]): boolean {
  return segmentos.some(segmento => !segmento.lacuna && textoTemFala(segmento.texto));
}

export type TranscricaoDoVideo = { segmentos: Segmento[]; texto: string; duracaoSegundos: number; modelo: string };

/**
 * Pede ao Gemini a transcrição do vídeo e a devolve no contrato: tempos em
 * segundos desde o começo do vídeo, falantes F1, F2..., o texto corrido (sem
 * os rótulos, como na montagem das partes) e a duração, que é o fim da última
 * fala (no máximo a hora que foi à IA). Tudo o que dá errado sai como
 * ErroDoVideoDoYoutube, com o código; o detalhe vai só ao log.
 */
export async function transcreverVideoDoYoutube(input: { url: string; idioma?: string }): Promise<TranscricaoDoVideo> {
  const id = idDoVideoDoYoutube(input.url);
  if (!id) throw new ErroDoVideoDoYoutube("YOUTUBE_LINK_INVALIDO");
  const urlCanonica = urlCanonicaDoYoutube(id);
  // A escolha da reunião: um idioma falado (G16) ou "Detectar sozinho".
  const idioma = escolhaDoIdioma(input.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const opcoes = { timeoutMs: TIMEOUT_DO_VIDEO_MS, orcamentoMs: ORCAMENTO_DO_VIDEO_MS };
  const inicio = Date.now();
  let modelo = modeloDeAudio();
  let payload: RespostaDoVideo;
  try {
    payload = await geminiPost<RespostaDoVideo>(`/models/${modelo}:generateContent`, pedidoDoVideoAoGemini({ urlCanonica, idioma, modelo }), undefined, opcoes);
  } catch (erro) {
    // A mesma cartada do áudio (server/gemini.ts): o modelo lotado tenta a
    // reserva, que tem cota própria. A recusa (4xx) não melhora em outro
    // modelo, e a reserva que começa tarde passaria do prazo da varredura.
    const reserva = modeloDeAudioReserva();
    const tentaAReserva = erro instanceof GeminiIndisponivelError && !(erro instanceof GeminiRecusouChamadaError)
      && reserva !== modelo && Date.now() - inicio < RESERVA_SO_ATE_MS;
    if (!tentaAReserva) throw new ErroDoVideoDoYoutube(codigoDaFalhaDoVideo(erro), { cause: erro });
    console.warn(`[YouTube] ${modelo} indisponível; tentando a reserva ${reserva}`);
    try {
      payload = await geminiPost<RespostaDoVideo>(`/models/${reserva}:generateContent`, pedidoDoVideoAoGemini({ urlCanonica, idioma, modelo: reserva }), 1, opcoes);
      modelo = reserva;
    } catch (erroDaReserva) {
      console.warn(`[YouTube] a reserva ${reserva} também falhou:`, erroDaReserva instanceof Error ? erroDaReserva.message : erroDaReserva);
      // A recusa da reserva fala do vídeo (privado, grande demais); a lotação
      // dela não diz mais que a do principal.
      throw new ErroDoVideoDoYoutube(codigoDaFalhaDoVideo(erroDaReserva instanceof GeminiRecusouChamadaError ? erroDaReserva : erro), { cause: erro });
    }
  }

  // O vídeo barrado pela IA antes de qualquer resposta.
  if (payload.promptFeedback?.blockReason) {
    console.warn(`[YouTube] ${modelo} barrou o vídeo (${payload.promptFeedback.blockReason})`);
    throw new ErroDoVideoDoYoutube("YOUTUBE_IA_RECUSOU");
  }
  const candidato = payload.candidates?.[0];
  const motivo = candidato?.finishReason ?? "SEM_MOTIVO";
  const uso = payload.usageMetadata ?? {};
  if (motivo !== "STOP") {
    console.error(`[YouTube] ${modelo} parou em ${motivo} (entrada ${uso.promptTokenCount ?? "?"}, saída ${uso.candidatesTokenCount ?? "?"}, raciocínio ${uso.thoughtsTokenCount ?? 0})`);
    throw new ErroDoVideoDoYoutube(motivo === "MAX_TOKENS" ? "YOUTUBE_LONGO_DEMAIS" : "YOUTUBE_IA_RECUSOU");
  }
  const texto = (candidato?.content?.parts ?? []).filter(parte => !parte.thought).map(parte => parte.text ?? "").join("").trim();
  let segmentos: Segmento[];
  try {
    // O teto da hora que foi à IA: a fala que o modelo marcar depois dele fica
    // presa nele (com a folga de 2 s), sem se perder, como na fatia.
    segmentos = normalizarSegmentos(JSON.parse(texto), 0, SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX);
  } catch (erro) {
    throw new ErroDoVideoDoYoutube("YOUTUBE_FALHOU", { cause: erro });
  }
  if (!temFala(segmentos)) throw new ErroDoVideoDoYoutube("YOUTUBE_SEM_FALA");
  const ultimoFim = segmentos.reduce((maior, segmento) => Math.max(maior, segmento.fim), 0);
  return {
    segmentos,
    texto: segmentos.map(segmento => segmento.texto).join("\n"),
    duracaoSegundos: Math.max(1, Math.round(Math.min(SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX, ultimoFim))),
    modelo,
  };
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/** Quem pede: o id da conta (trava e auditoria), o openId (dona da reunião) e de onde. */
export type ContaQuePede = { userId: number; openId: string; ipAddress: string; userAgent?: string | null };

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  return typeof linhas === "number" ? linhas : 0;
}

/**
 * A trava da conta e a conferência do teto, dentro da transação do pedido. A
 * trava (SELECT ... FOR UPDATE na linha da conta) enfileira os pedidos da
 * mesma dona: sem ela, dois pedidos ao mesmo tempo contavam 4 e entravam os
 * dois. A janela de 24 h é contada pelo relógio do banco, o mesmo que grava a
 * auditoria.
 */
async function travarAContaDaDona(tx: Transacao, userId: number) {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
}

/** Quantos vídeos a dona mandou à IA nas últimas 24 h, pela auditoria do pedido. */
export async function videosDasUltimas24h(tx: Banco | Transacao, userId: number): Promise<number> {
  const [linha] = await tx.select({ total: sql<number>`count(*)` }).from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.action, ACAO_DO_VIDEO_DO_YOUTUBE),
    gt(auditLogs.createdAt, sql`(now() - interval 1 day)`),
  ));
  return Number(linha?.total ?? 0);
}

async function conferirOTeto(tx: Transacao, userId: number) {
  if (await videosDasUltimas24h(tx, userId) >= VIDEOS_DO_YOUTUBE_POR_DIA) throw new RecusaDoVideo("TOO_MANY_REQUESTS", "YOUTUBE_TETO_DIARIO");
}

/**
 * A prova do pedido: quem pediu, de onde e com qual versão do aviso. Insert
 * direto na transação (o createAuditLog engole o erro): sem a linha, a reunião
 * não nasce. Nada do vídeo vai aqui, nem a URL: a auditoria é lida pela
 * administração, e o que a dona assiste é dela.
 */
async function registrarOPedido(tx: Transacao, conta: ContaQuePede, meetingId: string, detalhes: { versaoDoAviso: string | null; refazer: boolean }) {
  await tx.insert(auditLogs).values({
    userId: conta.userId,
    action: ACAO_DO_VIDEO_DO_YOUTUBE,
    resource: "meetings",
    resourceId: meetingId,
    details: { origem: "youtube", consentNoticeVersion: detalhes.versaoDoAviso, refazer: detalhes.refazer },
    // Os mesmos cortes do createAuditLog (server/security.ts).
    ipAddress: conta.ipAddress ? conta.ipAddress.split(",")[0].trim().substring(0, 45) : null,
    userAgent: conta.userAgent ? conta.userAgent.substring(0, 500) : null,
    status: "success",
    riskLevel: "low",
  });
}

type ExecucaoDoVideo = { meetingId: string; ownerId: string; ficha: number; urlCanonica: string; idioma: EscolhaDoIdioma; limparAntes: boolean };

/**
 * Pede o resumo de um vídeo: confere o link e o teto, cria a reunião já em
 * 'processing' (origem 'youtube', a URL canônica, o aviso aceito) e a
 * auditoria do pedido na mesma transação, e devolve o id. O trabalho (IA,
 * extração e gravação) segue em segundo plano, e `trabalho` nunca rejeita.
 */
export async function pedirResumoDoVideo(
  conta: ContaQuePede,
  pedido: { titulo: string; url: string; idioma: EscolhaDoIdioma; versaoDoAviso: VersaoDoAvisoDoYoutube },
): Promise<{ id: string; trabalho: Promise<void> }> {
  const id = idDoVideoDoYoutube(pedido.url);
  if (!id) throw new RecusaDoVideo("BAD_REQUEST", "YOUTUBE_LINK_INVALIDO");
  const urlCanonica = urlCanonicaDoYoutube(id);
  const db = await exigirDb();
  const meetingId = crypto.randomUUID();
  // A ficha é o updated_at com que a reunião nasce (gravarResultadoDaReuniao a confere).
  const ficha = Date.now();
  await db.transaction(async tx => {
    await travarAContaDaDona(tx, conta.userId);
    await conferirOTeto(tx, conta.userId);
    await tx.insert(meetings).values({
      id: meetingId,
      ownerId: conta.openId,
      title: pedido.titulo,
      status: "processing",
      consentGranted: true,
      consentAt: ficha,
      consentNoticeVersion: pedido.versaoDoAviso,
      language: pedido.idioma,
      origem: "youtube",
      sourceUrl: urlCanonica,
      createdAt: ficha,
      updatedAt: ficha,
    });
    await registrarOPedido(tx, conta, meetingId, { versaoDoAviso: pedido.versaoDoAviso, refazer: false });
  });
  const trabalho = executarVideoDoYoutube(db, { meetingId, ownerId: conta.openId, ficha, urlCanonica, idioma: pedido.idioma, limparAntes: false });
  return { id: meetingId, trabalho };
}

/**
 * O "Tentar de novo" da reunião do YouTube com falha: lê o vídeo outra vez
 * pela URL guardada. Só a dona, só reunião do YouTube, com falha e com o
 * consentimento; gasta uma vaga do teto (o vídeo vai de novo à IA) e entra na
 * auditoria. A tomada ('failed' → 'processing', com a ficha nova) vai na mesma
 * transação, com a linha travada: dois cliques não tomam a reunião duas vezes.
 * O que a tentativa anterior deixou sai depois de a IA dar certo (limparAntes).
 * A falha que se repete com o mesmo vídeo (erroDoYoutubeSeRepete: fala demais,
 * nenhuma fala) é recusada com o código dela, que a tela traduz, antes do teto:
 * não gasta vaga nem vai à IA.
 */
export async function refazerResumoDoVideo(conta: ContaQuePede, meetingId: string): Promise<{ trabalho: Promise<void> }> {
  const db = await exigirDb();
  const execucao = await db.transaction(async (tx): Promise<ExecucaoDoVideo> => {
    await travarAContaDaDona(tx, conta.userId);
    const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, conta.openId));
    const [reuniao] = await tx.select({
      status: meetings.status, origem: meetings.origem, sourceUrl: meetings.sourceUrl, consentGranted: meetings.consentGranted,
      consentNoticeVersion: meetings.consentNoticeVersion, language: meetings.language, updatedAt: meetings.updatedAt,
      processingError: meetings.processingError, trashedAt: meetings.trashedAt,
    }).from(meetings).where(daDona).limit(1).for("update");
    if (!reuniao || reuniaoForaDeVista(reuniao)) throw new RecusaDoVideo("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const id = reuniao.origem === "youtube" ? idDoVideoDoYoutube(reuniao.sourceUrl) : null;
    if (!id || !reuniao.consentGranted) throw new RecusaDoVideo("PRECONDITION_FAILED", MENSAGEM_REUNIAO_NAO_E_DO_YOUTUBE);
    if (reuniao.status !== "failed") throw new RecusaDoVideo("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
    if (erroDoYoutubeSeRepete(reuniao.processingError)) throw new RecusaDoVideo("PRECONDITION_FAILED", reuniao.processingError);
    await conferirOTeto(tx, conta.userId);
    // Estritamente maior que o updated_at lido, como a ficha do reprocesso.
    const ficha = Math.max(Date.now(), Number(reuniao.updatedAt) + 1);
    const tomada = await tx.update(meetings).set({ status: "processing", processingError: null, updatedAt: ficha })
      .where(and(daDona, eq(meetings.status, "failed")));
    if (!linhasAfetadas(tomada)) throw new RecusaDoVideo("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
    await registrarOPedido(tx, conta, meetingId, { versaoDoAviso: reuniao.consentNoticeVersion, refazer: true });
    return {
      meetingId, ownerId: conta.openId, ficha, urlCanonica: urlCanonicaDoYoutube(id),
      idioma: escolhaDoIdioma(reuniao.language) ?? IDIOMA_DA_REUNIAO_PADRAO, limparAntes: true,
    };
  });
  return { trabalho: executarVideoDoYoutube(db, execucao) };
}

/**
 * Renova a ficha depois da IA do vídeo, que pode levar minutos: a extração e a
 * gravação ganham os 15 min inteiros antes da varredura de interrompidas. Zero
 * linhas: a reunião foi excluída, ou outra execução a tomou (a varredura, um
 * "Tentar de novo" depois dela). Nada desta execução foi gravado ainda, então
 * não há o que limpar.
 */
async function renovarFicha(db: Banco, meetingId: string, ownerId: string, ficha: number): Promise<number> {
  const nova = Math.max(Date.now(), ficha + 1);
  const renovada = await db.update(meetings).set({ updatedAt: nova }).where(and(
    eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha),
  ));
  if (linhasAfetadas(renovada)) return nova;
  const [agora] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!agora || agora.status === "deleted") throw new ReuniaoExcluidaDuranteProcessamento();
  throw new ReuniaoTomadaPorOutraExecucao();
}

/**
 * O trabalho em segundo plano: a IA lê o vídeo, a extração lê as falas com o
 * rótulo da voz (a mesma entrada do resumo guardado), e gravarResultadoDaReuniao
 * grava tudo e promove a reunião a 'ready'. Nunca rejeita: fora da requisição
 * não há quem capture o erro, e uma rejeição solta derruba o processo. A falha
 * vira o CÓDIGO do erro em processing_error, só se a reunião ainda é desta
 * execução (a ficha); excluída ou tomada por outra, sai sem escrever.
 */
export async function executarVideoDoYoutube(db: Banco, execucao: ExecucaoDoVideo): Promise<void> {
  let ficha = execucao.ficha;
  try {
    const transcricao = await transcreverVideoDoYoutube({ url: execucao.urlCanonica, idioma: execucao.idioma });
    ficha = await renovarFicha(db, execucao.meetingId, execucao.ownerId, ficha);
    const entrada = entradaDoResumo(transcricao.texto, transcricao.segmentos);
    const extraction = await extrairDadosDaReuniao(entrada.texto, { rotulada: entrada.rotulada });
    await gravarResultadoDaReuniao(db, {
      meetingId: execucao.meetingId, ownerId: execucao.ownerId, ficha, limparAntes: execucao.limparAntes,
      durationSeconds: transcricao.duracaoSegundos,
      // Com "Detectar sozinho" (G16), o idioma que mais aparece nas falas.
      transcription: { text: transcricao.texto, segments: transcricao.segmentos, language: idiomaDaTranscricao(execucao.idioma, transcricao.segmentos) },
      extraction,
    });
  } catch (erro) {
    if (erro instanceof ReuniaoExcluidaDuranteProcessamento || erro instanceof ReuniaoTomadaPorOutraExecucao) return;
    const codigo = codigoDaFalhaDoVideo(erro);
    // Sem o texto do vídeo nem da transcrição: a descrição tira os parâmetros do SQL.
    console.error(`[YouTube] o vídeo de uma reunião falhou (${codigo}):`, descreverErroDeBanco(erro));
    try {
      await db.update(meetings).set({ status: "failed", processingError: codigo, updatedAt: Date.now() }).where(and(
        eq(meetings.id, execucao.meetingId), eq(meetings.ownerId, execucao.ownerId),
        eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha),
      ));
    } catch (erroAoMarcar) {
      // Banco fora justo agora: a reunião fica 'processing', e a varredura de
      // interrompidas a dá como falha em até 20 min.
      console.error("[YouTube] não foi possível marcar a falha do vídeo:", descreverErroDeBanco(erroAoMarcar));
    }
  }
}
