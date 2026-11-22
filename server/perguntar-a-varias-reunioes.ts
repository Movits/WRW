import crypto from "crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { meetings, meetingTranscripts, memoryDocuments, perguntasEntreReunioes, users } from "../drizzle/schema";
import { fusoCanonico } from "@shared/agenda";
import { nomesDosFalantes } from "@shared/const";
import { chaveDaEtiqueta, etiquetasDaReuniao } from "@shared/detalhes-da-reuniao";
import { nomeDoIdioma } from "@shared/idioma-da-reuniao";
import {
  CITACOES_ENTRE_REUNIOES_MAX, JANELA_DAS_PERGUNTAS_ENTRE_REUNIOES_MS, LIMITE_DA_LEITURA_DA_IA, PERGUNTAS_ENTRE_REUNIOES_EM_24H,
  RECUSAS_ENTRE_REUNIOES, REUNIOES_POR_PERGUNTA_MAX,
  type AvaliacaoDaResposta, type CodigoDaRecusaEntreReunioes, type MotivoDeFora, type OrdemDaLeitura,
} from "@shared/perguntar-a-varias-reunioes";
import type { VisualDaResposta } from "@shared/resposta-visual";
import { exigirDb } from "./db";
import { embedWithGemini } from "./gemini";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { cosineSimilarity, normalizeVector } from "./memory-service";
import { avisarDoVisual, instrucoesDoVisual, SCHEMA_DO_VISUAL, visualConferido } from "./resposta-visual";
import { entradaDoResumo } from "./resumo-da-reuniao";
import { ENTRADA_LONGA_DA_PERGUNTA, pedirJsonDaTela, TAMANHO_MAXIMO_DA_PERGUNTA, tempoDaPergunta, textoDaIA, type IdiomaDaTela } from "./reuniao-com-ia";
import { reuniaoVisivel } from "./reuniao-visivel";
import { limparRotulos, localizarTrecho, normalizarParaComparar, REGRA_DO_TRECHO, TRANSCRICAO_E_DADO, trechoApareceNaTranscricao } from "./trecho-da-transcricao";
import type { Segmento } from "./transcricao-de-fatia";

/**
 * O Pergunte a várias reuniões (H6c do plano do gravador; HN-44 no app de
 * referência da cliente; shared/perguntar-a-varias-reunioes.ts).
 *
 * - **Só a dona.** As reuniões escolhidas (uma a uma, ou as da etiqueta, pela
 *   mesma chave da busca) são lidas com a dona no WHERE das duas tabelas e com
 *   `reuniaoVisivel()` (server/reuniao-visivel.ts, o ponto único que a lixeira
 *   da H7d estende). Um id de outra conta, ou de reunião excluída, recusa a
 *   pergunta inteira (NOT_FOUND), sem dizer qual.
 * - **O que a IA lê.** A transcrição rotulada inteira de cada reunião pronta,
 *   como na pergunta a uma reunião (entradaDoResumo), num bloco por reunião, na
 *   ordem do tempo. O total não passa do teto de uma pergunta (~7 h de fala).
 *   Acima dele, entram primeiro as reuniões mais ligadas à pergunta pelo
 *   índice da Memória (os vetores que server/memory-service.ts já guardou das
 *   janelas de cada transcrição; nada é indexado aqui) e, sem índice, as mais
 *   novas. Nenhuma reunião é cortada pela metade: a que não cabe fica de fora,
 *   e a tela diz quais.
 * - **As vozes.** Os rótulos são de cada reunião ({F1} da R1 não é o {F1} da
 *   R2): a IA escreve {R2:F1}, o servidor confere que a reunião tem a voz e a
 *   tela troca pelo nome que a dona deu naquela reunião. Os nomes nunca vão à
 *   IA. Rótulo sem a reunião, com mais de uma lida, derruba a resposta.
 * - **As citações.** De 1 a 5, cada uma com a reunião, conferida na
 *   transcrição DELA e com o segundo em que começa. O "número de fontes" é
 *   quantas reuniões diferentes as citações sustentam.
 * - **Os tetos.** O custo de uma pergunta é o da entrada: até ~7 h de fala
 *   (cerca de US$ 0,08 no preço de 16/11). A pergunta gasta uma vaga do teto de
 *   pedidos à IA da dona a cada 100 mil caracteres começados (de 1 a 4) e
 *   conta no teto de 24 h (PERGUNTAS_ENTRE_REUNIOES_EM_24H), contado no banco,
 *   com a conta da dona travada, como o resumo por e-mail.
 * - **O que fica guardado.** Uma linha por pergunta que foi à IA, sem a
 *   pergunta, a resposta, as citações nem as reuniões: só quantas, o tamanho,
 *   como terminou, o modelo e a avaliação da dona (perguntas_entre_reunioes).
 * - **O visual** (H6d) é o da pergunta a uma reunião (server/resposta-visual.ts),
 *   com as vozes no formato daqui.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

type CodigoTrpcDaRecusa = "NOT_FOUND" | "PRECONDITION_FAILED" | "PAYLOAD_TOO_LARGE" | "TOO_MANY_REQUESTS";

/** A recusa com o código tRPC e o código da tela (RECUSAS_ENTRE_REUNIOES), que o router repassa. */
export class RecusaEntreReunioes extends Error {
  readonly codigoTrpc: CodigoTrpcDaRecusa;
  constructor(codigoTrpc: CodigoTrpcDaRecusa, codigo: CodigoDaRecusaEntreReunioes) {
    super(codigo);
    this.name = "RecusaEntreReunioes";
    this.codigoTrpc = codigoTrpc;
  }
}

export type EscolhaDasReunioes = { meetingIds: string[]; etiqueta?: undefined } | { etiqueta: string; meetingIds?: undefined };

/** Uma reunião que a dona pode escolher para perguntar: pronta e com transcrição. */
export type ReuniaoParaPerguntar = {
  id: string;
  titulo: string;
  criadaEm: number;
  etiquetas: string[];
  origem: string | null;
  /** O tamanho da transcrição, para a tela estimar as horas de fala. */
  caracteres: number;
};

/** Quantas reuniões a lista da tela traz, das mais novas para as mais velhas. */
export const REUNIOES_NA_LISTA_MAX = 500;

/** A transcrição da reunião, só da dona, no join: a dona vai nas duas tabelas. */
const transcricaoDaDona = (ownerId: string) => and(eq(meetingTranscripts.meetingId, meetings.id), eq(meetingTranscripts.ownerId, ownerId));
const caracteresDaTranscricao = sql<number | null>`char_length(${meetingTranscripts.transcript})`;

/**
 * As reuniões que a dona pode escolher: as prontas, com transcrição, das mais
 * novas para as mais velhas. O tamanho sai do SQL (CHAR_LENGTH): a transcrição
 * não viaja até o servidor só para ser medida.
 */
export async function reunioesParaPerguntar(ownerId: string): Promise<ReuniaoParaPerguntar[]> {
  const db = await exigirDb();
  const linhas = await db.select({
    id: meetings.id, titulo: meetings.title, criadaEm: meetings.createdAt, etiquetas: meetings.etiquetas, origem: meetings.origem,
    caracteres: caracteresDaTranscricao,
  }).from(meetings)
    .innerJoin(meetingTranscripts, transcricaoDaDona(ownerId))
    .where(and(eq(meetings.ownerId, ownerId), eq(meetings.status, "ready"), reuniaoVisivel()))
    .orderBy(desc(meetings.createdAt), asc(meetings.id))
    .limit(REUNIOES_NA_LISTA_MAX);
  return linhas
    .filter(linha => Number(linha.caracteres) > 0)
    .map(linha => ({
      id: linha.id, titulo: linha.titulo, criadaEm: Number(linha.criadaEm), etiquetas: etiquetasDaReuniao(linha.etiquetas),
      origem: linha.origem ?? null, caracteres: Number(linha.caracteres),
    }));
}

/** Uma reunião escolhida, antes de ler a transcrição. */
type ReuniaoEscolhida = { id: string; titulo: string; criadaEm: number; nomes: Record<string, string>; caracteres: number; pronta: boolean };

/**
 * As reuniões da escolha, da dona e visíveis. Uma a uma: todas têm de ser
 * dela (senão NOT_FOUND, sem dizer qual); a que não está pronta fica de fora,
 * com o motivo. Pela etiqueta: as prontas com a etiqueta (pela chave, sem
 * caixa), as mais novas primeiro, até REUNIOES_POR_PERGUNTA_MAX.
 */
async function reunioesDaEscolha(db: Banco, ownerId: string, escolha: EscolhaDasReunioes): Promise<{ escolhidas: ReuniaoEscolhida[]; alemDoMaximo: number }> {
  const colunas = {
    id: meetings.id, titulo: meetings.title, criadaEm: meetings.createdAt, status: meetings.status, speakerNames: meetings.speakerNames,
    etiquetas: meetings.etiquetas, caracteres: caracteresDaTranscricao,
  };
  type Linha = { id: string; titulo: string; criadaEm: number; status: string; speakerNames: unknown; caracteres: number | null };
  const escolhida = (linha: Linha): ReuniaoEscolhida => ({
    id: linha.id, titulo: linha.titulo, criadaEm: Number(linha.criadaEm), nomes: nomesDosFalantes(linha.speakerNames),
    caracteres: Number(linha.caracteres ?? 0), pronta: linha.status === "ready" && Number(linha.caracteres ?? 0) > 0,
  });
  if (escolha.meetingIds) {
    const ids = Array.from(new Set(escolha.meetingIds));
    const linhas = await db.select(colunas).from(meetings)
      .leftJoin(meetingTranscripts, transcricaoDaDona(ownerId))
      .where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, ids), reuniaoVisivel()));
    if (linhas.length !== ids.length) throw new RecusaEntreReunioes("NOT_FOUND", RECUSAS_ENTRE_REUNIOES.naoEncontrada);
    return { escolhidas: linhas.map(escolhida), alemDoMaximo: 0 };
  }
  const chave = chaveDaEtiqueta(escolha.etiqueta);
  const linhas = await db.select(colunas).from(meetings)
    .innerJoin(meetingTranscripts, transcricaoDaDona(ownerId))
    .where(and(eq(meetings.ownerId, ownerId), eq(meetings.status, "ready"), isNotNull(meetings.etiquetas), reuniaoVisivel()))
    .orderBy(desc(meetings.createdAt), asc(meetings.id));
  const comAEtiqueta = linhas
    .filter(linha => Number(linha.caracteres ?? 0) > 0 && etiquetasDaReuniao(linha.etiquetas).some(etiqueta => chaveDaEtiqueta(etiqueta) === chave))
    .map(escolhida);
  if (!comAEtiqueta.length) throw new RecusaEntreReunioes("PRECONDITION_FAILED", RECUSAS_ENTRE_REUNIOES.semReuniao);
  return { escolhidas: comAEtiqueta.slice(0, REUNIOES_POR_PERGUNTA_MAX), alemDoMaximo: Math.max(0, comAEtiqueta.length - REUNIOES_POR_PERGUNTA_MAX) };
}

/** A reunião de um documento da Memória: o meetingId do metadata, ou a chave sem a janela ("id#2"). */
function reuniaoDoDocumento(documento: { sourceId: string; metadata: unknown }): string {
  const metadata = documento.metadata as Record<string, unknown> | null;
  return typeof metadata?.meetingId === "string" ? metadata.meetingId : documento.sourceId.split("#")[0];
}

/** O embedding da pergunta tem pressa: uma tentativa, 8 s. Sem ele, a ordem é a das mais novas. */
const EMBEDDING_DA_PERGUNTA = { tentativas: 1, timeoutMs: 8_000 };

/**
 * O quanto cada reunião escolhida se liga à pergunta, pelo índice da Memória:
 * a maior semelhança entre a pergunta e as janelas da transcrição que a
 * Memória já indexou. Nada é indexado aqui (a reindexação pode levar 30 s);
 * reunião ainda sem vetor fica sem nota. Sem o embedding da pergunta (a IA
 * fora do ar) ou sem nenhum vetor, null: a ordem cai para as mais novas, e a
 * tela diz isso. O banco fora do ar continua erro.
 */
async function relevanciaPelaMemoria(db: Banco, ownerId: string, pergunta: string, ids: readonly string[]): Promise<Map<string, number> | null> {
  let consulta: number[];
  try {
    consulta = normalizeVector(await embedWithGemini(pergunta, "RETRIEVAL_QUERY", EMBEDDING_DA_PERGUNTA));
  } catch (erro) {
    console.warn(`[Pergunte a várias] sem a ordem da Memória: o embedding da pergunta falhou (${erro instanceof Error ? erro.name : typeof erro}).`);
    return null;
  }
  const documentos = await db.select({ sourceId: memoryDocuments.sourceId, metadata: memoryDocuments.metadata, embedding: memoryDocuments.embedding })
    .from(memoryDocuments).where(and(eq(memoryDocuments.ownerId, ownerId), eq(memoryDocuments.sourceType, "meeting")));
  const escolhidas = new Set(ids);
  const notas = new Map<string, number>();
  for (const documento of documentos) {
    const meetingId = reuniaoDoDocumento(documento);
    const vetor = documento.embedding;
    if (!escolhidas.has(meetingId) || !Array.isArray(vetor) || vetor.length !== consulta.length) continue;
    const nota = cosineSimilarity(consulta, vetor);
    if (nota > (notas.get(meetingId) ?? -Infinity)) notas.set(meetingId, nota);
  }
  return notas.size ? notas : null;
}

/** Uma reunião que a IA lê, com o número dela na pergunta (R1, R2...), na ordem do tempo. */
export type ReuniaoLida = {
  numero: number;
  meetingId: string;
  titulo: string;
  criadaEm: number;
  nomes: Record<string, string>;
  /** A transcrição como está guardada: é nela que a citação é conferida. */
  texto: string;
  segmentos: Segmento[];
  /** O que vai à IA: a transcrição rotulada ({F1}: fala) e as vozes dela. */
  entrada: { texto: string; rotulada: boolean; vozes: ReadonlySet<string> };
};

/**
 * A data da reunião (AAAA-MM-DD) no fuso do aparelho de quem pergunta, para a
 * IA dizer o mesmo dia que a tela mostra; sem um fuso que o Intl conheça, em UTC.
 */
export function dataNoFuso(criadaEm: number, fuso: string | null | undefined): string {
  const canonico = fuso ? fusoCanonico(fuso) : null;
  if (!canonico) return new Date(criadaEm).toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: canonico, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(criadaEm));
}

/** A linha que abre o bloco de cada reunião no pedido à IA. O título é da dona: sem quebra de linha e sem "===". */
export function cabecalhoDaReuniao(numero: number, titulo: string, criadaEm: number, fuso: string | null = null): string {
  const limpo = titulo.replace(/\s+/g, " ").replace(/={2,}/g, "=").trim().slice(0, 120);
  return `=== Reunião R${numero} · ${limpo} · ${dataNoFuso(criadaEm, fuso)} ===`;
}

/** O bloco de uma reunião: o cabeçalho e a transcrição rotulada. */
function blocoDaReuniao(reuniao: Pick<ReuniaoLida, "numero" | "titulo" | "criadaEm" | "entrada">, fuso: string | null): string {
  return `${cabecalhoDaReuniao(reuniao.numero, reuniao.titulo, reuniao.criadaEm, fuso)}\n${reuniao.entrada.texto}`;
}

// A folga de cada bloco: o cabeçalho (até ~150 caracteres) e as linhas em branco entre eles.
const FOLGA_DO_BLOCO = 160;
// Os rótulos de voz ("{F1}: " no começo de cada linha) somam alguns por cento à
// transcrição medida no banco; 10% de folga decidem a ordem com segurança.
const FOLGA_DOS_ROTULOS = 1.1;

export type ReuniaoDeFora = { meetingId: string; titulo: string; motivo: MotivoDeFora };

/**
 * Quais reuniões a IA lê: na ordem dada (a da relevância ou a das mais novas),
 * cada uma entra se o bloco dela cabe no que sobra do teto; a que não cabe
 * fica de fora ("longa_demais" se não caberia nem sozinha) e a seguinte ainda
 * pode entrar. Função pura: os tamanhos já vêm medidos.
 */
export function escolherOQueCabe<T extends { id: string; tamanho: number }>(ordenadas: readonly T[], limite: number): { entram: T[]; deFora: Array<{ reuniao: T; motivo: "limite" | "longa_demais" }> } {
  const entram: T[] = [];
  const deFora: Array<{ reuniao: T; motivo: "limite" | "longa_demais" }> = [];
  let usado = 0;
  for (const reuniao of ordenadas) {
    const custo = reuniao.tamanho + FOLGA_DO_BLOCO;
    if (custo > limite) deFora.push({ reuniao, motivo: "longa_demais" });
    else if (usado + custo > limite) deFora.push({ reuniao, motivo: "limite" });
    else {
      entram.push(reuniao);
      usado += custo;
    }
  }
  return { entram, deFora };
}

/**
 * Lê as transcrições das reuniões que cabem e monta o que vai à IA. Duas
 * passadas: a primeira escolhe pelo tamanho que o banco mediu (sem carregar
 * transcrição nenhuma), a segunda pelo tamanho da entrada rotulada, que é o
 * que a IA lê (os rótulos somam letras); quem não coube na segunda fica de
 * fora com o motivo "limite".
 */
async function lerAsQueCabem(db: Banco, ownerId: string, ordenadas: readonly ReuniaoEscolhida[]): Promise<{ lidas: ReuniaoLida[]; deFora: ReuniaoDeFora[] }> {
  const primeira = escolherOQueCabe(ordenadas.map(reuniao => ({ ...reuniao, tamanho: reuniao.caracteres })), LIMITE_DA_LEITURA_DA_IA);
  const deFora: ReuniaoDeFora[] = primeira.deFora.map(({ reuniao, motivo }) => ({ meetingId: reuniao.id, titulo: reuniao.titulo, motivo }));
  if (!primeira.entram.length) return { lidas: [], deFora };
  const linhas = await db.select({ meetingId: meetingTranscripts.meetingId, transcript: meetingTranscripts.transcript, segments: meetingTranscripts.segments })
    .from(meetingTranscripts)
    .innerJoin(meetings, and(eq(meetings.id, meetingTranscripts.meetingId), eq(meetings.ownerId, ownerId)))
    .where(and(eq(meetingTranscripts.ownerId, ownerId), inArray(meetingTranscripts.meetingId, primeira.entram.map(reuniao => reuniao.id)), eq(meetings.status, "ready"), reuniaoVisivel()));
  const porId = new Map(linhas.map(linha => [linha.meetingId, linha]));
  const medidas = primeira.entram.flatMap(reuniao => {
    const linha = porId.get(reuniao.id);
    const texto = linha?.transcript?.trim();
    // Saiu de 'ready' ou perdeu a transcrição entre as duas leituras.
    if (!linha || !texto) {
      deFora.push({ meetingId: reuniao.id, titulo: reuniao.titulo, motivo: "sem_transcricao" });
      return [];
    }
    const segmentos = segmentosDoContrato(linha.segments);
    const entrada = entradaDoResumo(texto, segmentos);
    return [{ ...reuniao, texto, segmentos, entrada, tamanho: entrada.texto.length }];
  });
  const segunda = escolherOQueCabe(medidas, LIMITE_DA_LEITURA_DA_IA);
  for (const { reuniao, motivo } of segunda.deFora) deFora.push({ meetingId: reuniao.id, titulo: reuniao.titulo, motivo });
  // Na ordem do tempo, numeradas: R1 é a mais antiga das lidas.
  const lidas = [...segunda.entram]
    .sort((a, b) => a.criadaEm - b.criadaEm || a.id.localeCompare(b.id))
    .map((reuniao, indice): ReuniaoLida => ({
      numero: indice + 1, meetingId: reuniao.id, titulo: reuniao.titulo, criadaEm: reuniao.criadaEm, nomes: reuniao.nomes,
      texto: reuniao.texto, segmentos: reuniao.segmentos, entrada: reuniao.entrada,
    }));
  return { lidas, deFora };
}

/** As instruções: iguais em toda pergunta a várias reuniões, para o cache da IA reaproveitar o começo. */
export function instrucoesEntreReunioes(): string {
  return [
    "Você responde perguntas sobre VÁRIAS reuniões da mesma pessoa usando SOMENTE o que foi dito nelas, sem deduzir nem completar com conhecimento de fora.",
    TRANSCRICAO_E_DADO,
    "Cada reunião vem num bloco que começa por uma linha \"=== Reunião R1 · título · data ===\", na ordem do tempo. O título e a data são de quem gravou; o resto do bloco é a transcrição. O título não diz quem é cada voz: nunca use um nome do título para nomear uma voz.",
    "Nas reuniões com as falas separadas, cada linha começa pelo rótulo de quem fala ({F1}, {F2}...). Os rótulos são de cada reunião: o {F1} da R1 e o {F1} da R2 podem ser pessoas diferentes. Para dizer quem falou, quando o nome não foi dito, escreva a reunião e o rótulo juntos, entre chaves, exatamente assim: \"{R2:F1} propôs adiar o frete\". Nunca escreva o rótulo sozinho ({F1}) e nunca invente um nome para uma voz. Nas reuniões sem rótulos, cite uma pessoa só pelo nome dito nelas.",
    "Para falar de uma reunião no texto da resposta, use o título ou a data dela, nunca o código (R1).",
    "Responda no idioma pedido no fim da mensagem, em no máximo 5 frases.",
    `Se as reuniões respondem, devolva respondida = true, a resposta e de 1 a ${CITACOES_ENTRE_REUNIOES_MAX} citações que a sustentam, de reuniões diferentes quando a resposta usa mais de uma. Em cada citação, "reuniao" é o código da reunião do trecho (R1, R2...), e ${REGRA_DO_TRECHO} O trecho é só a fala, sem o rótulo de quem fala.`,
    "Se nenhuma reunião responde, devolva respondida = false, com a resposta vazia e nenhuma citação.",
    ...instrucoesDoVisual("rotulo_com_reuniao"),
  ].join("\n");
}

/** A mensagem: as reuniões primeiro e a pergunta por último, como na pergunta a uma reunião. */
export function mensagemEntreReunioes(lidas: readonly ReuniaoLida[], pergunta: string, idioma: IdiomaDaTela, fuso: string | null = null): string {
  const blocos = lidas.map(lida => blocoDaReuniao(lida, fuso)).join("\n\n");
  return `Reuniões:\n\n${blocos}\n\nResponda em ${nomeDoIdioma(idioma)}.\nPergunta: ${pergunta.slice(0, TAMANHO_MAXIMO_DA_PERGUNTA)}`;
}

const SCHEMA_ENTRE_REUNIOES = {
  type: "object",
  properties: {
    respondida: { type: "boolean" },
    resposta: { type: "string", maxLength: 1500 },
    citacoes: {
      type: "array",
      items: {
        type: "object",
        properties: { reuniao: { type: "string", maxLength: 8 }, trecho: { type: "string", maxLength: 400 } },
        required: ["reuniao", "trecho"],
        additionalProperties: false,
      },
    },
    visual: SCHEMA_DO_VISUAL,
  },
  required: ["respondida", "resposta", "citacoes", "visual"],
  additionalProperties: false,
};

// O rótulo entre reuniões como a IA às vezes escreve ("{ R2 : F1 }", "{r2·f1}"); a forma da tela é "{R2:F1}".
const ROTULO_ENTRE_REUNIOES_SOLTO = /\{\s*R\s*([1-9]\d?)\s*[:·.\-–]?\s*F\s*([1-9]\d?)\s*\}/gi;
const ROTULO_ENTRE_REUNIOES = /\{R([1-9]\d?):(F[1-9]\d?)\}/g;
const ROTULO_SO_DA_VOZ = /\{(F[1-9]\d?)\}/g;
const TEM_ROTULO_SO_DA_VOZ = /\{F[1-9]\d?\}/;

/** Os rótulos entre reuniões na forma da tela. */
export function canonizarRotulos(texto: string): string {
  return texto.replace(ROTULO_ENTRE_REUNIOES_SOLTO, (_rotulo, reuniao: string, voz: string) => `{R${Number(reuniao)}:F${Number(voz)}}`);
}

export type VozesDoTexto = { texto: string } | { motivo: "voz_sem_reuniao" | "voz_inexistente"; detalhe: string };

/**
 * O texto com as vozes na forma da tela, conferidas: cada {Rn:Fm} tem de ser
 * uma voz que a reunião n rotulou. O rótulo sozinho ({F1}) só vale com uma
 * reunião lida (vira {R1:F1}); com várias, não se sabe de quem é.
 */
export function vozesConferidas(bruto: string, lidas: readonly ReuniaoLida[]): VozesDoTexto {
  let texto = canonizarRotulos(bruto);
  if (TEM_ROTULO_SO_DA_VOZ.test(texto)) {
    if (lidas.length !== 1) return { motivo: "voz_sem_reuniao", detalhe: `rótulo sem a reunião, com ${lidas.length} reuniões lidas` };
    texto = texto.replace(ROTULO_SO_DA_VOZ, (_rotulo, voz: string) => `{R1:${voz}}`);
  }
  const inexistentes = Array.from(texto.matchAll(ROTULO_ENTRE_REUNIOES))
    .filter(([, reuniao, voz]) => !lidas[Number(reuniao) - 1]?.entrada.vozes.has(voz))
    .map(([, reuniao, voz]) => `R${reuniao}:${voz}`);
  if (inexistentes.length) return { motivo: "voz_inexistente", detalhe: `${inexistentes.join(", ")} fora das vozes das reuniões lidas` };
  return { texto };
}

export type CitacaoEntreReunioes = { reuniao: number; meetingId: string; trecho: string; inicioSegundos: number | null };

/** O número da reunião que a IA escreveu na citação ("R2", "r2", "2", "Reunião R2"), ou null. */
function numeroDaReuniao(valor: unknown, total: number): number | null {
  const achado = typeof valor === "string" ? /(\d{1,2})/.exec(valor) : null;
  const numero = achado ? Number(achado[1]) : NaN;
  return Number.isInteger(numero) && numero >= 1 && numero <= total ? numero : null;
}

/**
 * As citações que a transcrição da reunião citada sustenta, na ordem da IA,
 * sem repetidas e até CITACOES_ENTRE_REUNIOES_MAX, cada uma com o segundo em
 * que começa. A conferência é a da pergunta a uma reunião
 * (trechoApareceNaTranscricao), na transcrição da reunião que a citação diz:
 * o trecho certo atribuído à reunião errada sai.
 */
export function citacoesEntreReunioesConferidas(bruto: unknown, lidas: readonly ReuniaoLida[]): CitacaoEntreReunioes[] {
  const lista = Array.isArray(bruto) ? bruto.slice(0, 2 * CITACOES_ENTRE_REUNIOES_MAX) : [];
  const vistas = new Set<string>();
  const citacoes: CitacaoEntreReunioes[] = [];
  for (const item of lista) {
    if (citacoes.length >= CITACOES_ENTRE_REUNIOES_MAX) break;
    const campos = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const numero = numeroDaReuniao(campos.reuniao, lidas.length);
    if (numero === null) continue;
    const lida = lidas[numero - 1];
    // A IA às vezes copia o rótulo junto da fala ("{F2}:", "{R2:F1}:"): sai antes de conferir.
    const dito = typeof campos.trecho === "string" ? limparRotulos(canonizarRotulos(campos.trecho).replace(ROTULO_ENTRE_REUNIOES, " ").replace(/^\s*:\s*/, "")) : null;
    const trecho = textoDaIA(dito, 400);
    if (!trecho || !trechoApareceNaTranscricao(trecho, lida.texto)) continue;
    const chave = `${numero}|${normalizarParaComparar(trecho)}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    citacoes.push({ reuniao: numero, meetingId: lida.meetingId, trecho, inicioSegundos: localizarTrecho(trecho, lida.segmentos) });
  }
  return citacoes;
}

/** Quantas vagas do teto de pedidos à IA a pergunta gasta: uma a cada 100 mil caracteres começados, de 1 a 4. */
export function vagasDaPergunta(caracteres: number): number {
  return Math.min(4, Math.max(1, Math.ceil(caracteres / ENTRADA_LONGA_DA_PERGUNTA)));
}

/** Toma `quantas` vagas; se uma é recusada, as já tomadas voltam e a recusa sobe. Devolve como soltar todas. */
export function reservarVagas(quantas: number, reservar: () => () => void): () => void {
  const soltar: Array<() => void> = [];
  try {
    for (let i = 0; i < quantas; i++) soltar.push(reservar());
  } catch (erro) {
    for (const solta of soltar) solta();
    throw erro;
  }
  return () => { for (const solta of soltar) solta(); };
}

/** Quantas perguntas a várias reuniões a dona fez nas últimas 24 h. */
async function perguntasDasUltimas24h(db: Banco | Transacao, ownerId: string, agora: number): Promise<number> {
  const [linha] = await db.select({ total: sql<number>`count(*)` }).from(perguntasEntreReunioes)
    .where(and(eq(perguntasEntreReunioes.ownerId, ownerId), gt(perguntasEntreReunioes.createdAt, agora - JANELA_DAS_PERGUNTAS_ENTRE_REUNIOES_MS)));
  return Number(linha?.total ?? 0);
}

/**
 * A linha da pergunta, antes da IA, com o teto de 24 h conferido na mesma
 * transação, com a conta da dona travada (SELECT ... FOR UPDATE): duas
 * perguntas ao mesmo tempo contam uma depois da outra, como no resumo por
 * e-mail.
 */
async function registrarAPergunta(db: Banco, conta: ContaQuePergunta, dados: { escolhidas: number; lidas: number; caracteres: number }, agora: number): Promise<string> {
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(and(eq(users.id, conta.id), eq(users.openId, conta.openId))).limit(1).for("update");
    if (await perguntasDasUltimas24h(tx, conta.openId, agora) >= PERGUNTAS_ENTRE_REUNIOES_EM_24H) {
      throw new RecusaEntreReunioes("TOO_MANY_REQUESTS", RECUSAS_ENTRE_REUNIOES.tetoDiario);
    }
    const id = crypto.randomUUID();
    await tx.insert(perguntasEntreReunioes).values({
      id, ownerId: conta.openId, situacao: "pendente", reunioesEscolhidas: dados.escolhidas, reunioesLidas: dados.lidas,
      caracteres: dados.caracteres, createdAt: agora, updatedAt: agora,
    });
    return id;
  });
}

type ContaQuePergunta = { id: number; openId: string };

/** Uma reunião lida, como a tela a mostra na lista de fontes. */
export type FonteEntreReunioes = { numero: number; meetingId: string; titulo: string; criadaEm: number; nomes: Record<string, string>; citada: boolean };

export type RespostaEntreReunioes = {
  /** O id da linha da pergunta: é por ele que a dona avalia a resposta. */
  perguntaId: string;
  respondida: boolean;
  /** A resposta com as vozes como {R2:F1}; vazia na não respondida. */
  resposta: string;
  citacoes: CitacaoEntreReunioes[];
  visual: VisualDaResposta | null;
  /** As reuniões lidas, na ordem do tempo, com o número de cada uma (o da voz {R2:F1}). */
  reunioes: FonteEntreReunioes[];
  deFora: ReuniaoDeFora[];
  /** Quantas a escolha trouxe; pela etiqueta, as que passaram do máximo estão em `alemDoMaximo`. */
  escolhidas: number;
  alemDoMaximo: number;
  ordem: OrdemDaLeitura;
};

/** A pergunta que não vai à tela fica no log com o motivo e contagens, nunca a fala de ninguém. */
function naoRespondida(motivo: string, detalhe?: string) {
  const linha = `[Pergunte a várias] não respondida (${motivo})${detalhe ? `: ${detalhe}` : ""}`;
  if (motivo === "ia_disse_que_nao") console.info(linha);
  else console.warn(linha);
}

/**
 * A pergunta a várias reuniões da dona. `reservarVaga` toma uma vaga do teto
 * de pedidos à IA da dona e devolve como soltá-la (routers/perguntasEntreReunioes.ts
 * passa o tetoDaIADaReuniao): a pergunta toma vagasDaPergunta() delas, depois
 * de saber o tamanho e antes da IA.
 */
export async function perguntarAVariasReunioes(pedido: {
  conta: ContaQuePergunta;
  escolha: EscolhaDasReunioes;
  pergunta: string;
  idioma: IdiomaDaTela;
  /** O fuso do aparelho, para a data de cada reunião no pedido à IA (dataNoFuso). */
  fuso?: string | null;
  reservarVaga: () => () => void;
  agora?: number;
}): Promise<RespostaEntreReunioes> {
  const { conta, escolha, pergunta, idioma } = pedido;
  const agora = pedido.agora ?? Date.now();
  const db = await exigirDb();
  // O teto de 24 h já cheio recusa antes de ler qualquer transcrição; a conta
  // definitiva é a da transação, com a conta da dona travada.
  if (await perguntasDasUltimas24h(db, conta.openId, agora) >= PERGUNTAS_ENTRE_REUNIOES_EM_24H) {
    throw new RecusaEntreReunioes("TOO_MANY_REQUESTS", RECUSAS_ENTRE_REUNIOES.tetoDiario);
  }

  const { escolhidas, alemDoMaximo } = await reunioesDaEscolha(db, conta.openId, escolha);
  const prontas = escolhidas.filter(reuniao => reuniao.pronta);
  const semTranscricao: ReuniaoDeFora[] = escolhidas.filter(reuniao => !reuniao.pronta)
    .map(reuniao => ({ meetingId: reuniao.id, titulo: reuniao.titulo, motivo: "sem_transcricao" }));
  if (!prontas.length) throw new RecusaEntreReunioes("PRECONDITION_FAILED", RECUSAS_ENTRE_REUNIOES.semTranscricao);

  // Cabem todas? Senão, a ordem da Memória (ou a das mais novas) decide quem
  // entra. A conta é pelo tamanho que o banco mediu, com a folga dos rótulos
  // de voz ("{F1}: "), que a entrada da IA soma: a ordem tem de estar decidida
  // antes de medir a entrada.
  const maisNovasPrimeiro = (a: ReuniaoEscolhida, b: ReuniaoEscolhida) => b.criadaEm - a.criadaEm || a.id.localeCompare(b.id);
  const tamanhoDeTodas = prontas.reduce((total, reuniao) => total + reuniao.caracteres + FOLGA_DO_BLOCO, 0);
  let pelaMemoria = false;
  let ordenadas = [...prontas].sort(maisNovasPrimeiro);
  if (tamanhoDeTodas * FOLGA_DOS_ROTULOS > LIMITE_DA_LEITURA_DA_IA) {
    const notas = await relevanciaPelaMemoria(db, conta.openId, pergunta, prontas.map(reuniao => reuniao.id));
    if (notas) {
      pelaMemoria = true;
      ordenadas = [...prontas].sort((a, b) => (notas.get(b.id) ?? -Infinity) - (notas.get(a.id) ?? -Infinity) || maisNovasPrimeiro(a, b));
    }
  }
  const { lidas, deFora } = await lerAsQueCabem(db, conta.openId, ordenadas);
  if (!lidas.length) {
    // Nada coube: cada uma passava sozinha do teto, ou nenhuma tinha mais a transcrição.
    if (deFora.some(reuniao => reuniao.motivo === "longa_demais")) throw new RecusaEntreReunioes("PAYLOAD_TOO_LARGE", RECUSAS_ENTRE_REUNIOES.longasDemais);
    throw new RecusaEntreReunioes("PRECONDITION_FAILED", RECUSAS_ENTRE_REUNIOES.semTranscricao);
  }
  // A ordem só decidiu algo quando alguma reunião ficou de fora pelo limite.
  const ordem: OrdemDaLeitura = !deFora.some(reuniao => reuniao.motivo === "limite") ? "todas" : pelaMemoria ? "relevancia" : "recentes";

  const mensagem = mensagemEntreReunioes(lidas, pergunta, idioma, pedido.fuso ?? null);
  const caracteres = mensagem.length;
  const soltarVagas = reservarVagas(vagasDaPergunta(caracteres), pedido.reservarVaga);
  let perguntaId: string;
  try {
    perguntaId = await registrarAPergunta(db, conta, { escolhidas: escolhidas.length, lidas: lidas.length, caracteres }, agora);
  } catch (erro) {
    // A recusa do teto de 24 h (e a falha do banco) não chegou à IA: as vagas voltam.
    soltarVagas();
    throw erro;
  }
  const terminar = (campos: Partial<typeof perguntasEntreReunioes.$inferInsert>) => db.update(perguntasEntreReunioes)
    .set({ ...campos, updatedAt: Date.now() })
    .where(and(eq(perguntasEntreReunioes.id, perguntaId), eq(perguntasEntreReunioes.ownerId, conta.openId)));

  let dados: Record<string, unknown> = {};
  let modelo: string | null = null;
  try {
    ({ dados, modelo } = await pedirJsonDaTela(instrucoesEntreReunioes(), mensagem, "resposta_entre_reunioes", SCHEMA_ENTRE_REUNIOES, tempoDaPergunta(caracteres)));
  } catch (erro) {
    // A IA fora do ar (SERVICE_UNAVAILABLE, que a tela traduz) deixa a linha
    // como falha; ela conta no teto, porque o pedido foi à IA. Se nem isso
    // puder ser gravado (o banco fora do ar), o erro do banco é o que sobe.
    await terminar({ situacao: "falhou" });
    throw erro;
  }

  const base = {
    perguntaId, citacoes: [] as CitacaoEntreReunioes[], visual: null as VisualDaResposta | null,
    deFora: [...semTranscricao, ...deFora], escolhidas: escolhidas.length, alemDoMaximo, ordem,
  };
  const fontes = (citadas: ReadonlySet<number>): FonteEntreReunioes[] => lidas.map(lida => ({
    numero: lida.numero, meetingId: lida.meetingId, titulo: lida.titulo, criadaEm: lida.criadaEm, nomes: lida.nomes, citada: citadas.has(lida.numero),
  }));
  const semResposta = async (motivo: string, detalhe?: string): Promise<RespostaEntreReunioes> => {
    naoRespondida(motivo, detalhe);
    await terminar({ situacao: "nao_respondida", modelo });
    return { ...base, respondida: false, resposta: "", reunioes: fontes(new Set()) };
  };

  if (dados.respondida !== true) return semResposta("ia_disse_que_nao");
  const bruta = textoDaIA(dados.resposta, 1500);
  if (!bruta) return semResposta("resposta_vazia");
  const citacoes = citacoesEntreReunioesConferidas(dados.citacoes, lidas);
  if (!citacoes.length) {
    const recebidas = Array.isArray(dados.citacoes) ? dados.citacoes.length : 0;
    return semResposta("sem_citacao_conferida", `nenhuma de ${recebidas} citações está na transcrição da reunião citada`);
  }
  const vozes = vozesConferidas(bruta, lidas);
  if (!("texto" in vozes)) return semResposta(vozes.motivo, vozes.detalhe);

  const conferido = visualConferido(dados.visual, texto => {
    const doVisual = vozesConferidas(texto, lidas);
    return "texto" in doVisual ? doVisual.texto : null;
  });
  avisarDoVisual("Pergunte a várias", conferido);
  const citadas = new Set(citacoes.map(citacao => citacao.reuniao));
  await terminar({ situacao: "respondida", fontesCitadas: citadas.size, visual: conferido.visual?.tipo ?? null, modelo });
  return { ...base, respondida: true, resposta: vozes.texto, citacoes, visual: conferido.visual, reunioes: fontes(citadas) };
}

/**
 * A avaliação da resposta ("ajudou" ou "não ajudou"), só da dona e só da
 * pergunta que a IA respondeu (respondida ou não respondida). Avaliar de novo
 * troca a avaliação. Outra conta, ou a pergunta que não existe, é NOT_FOUND.
 */
export async function avaliarRespostaEntreReunioes(ownerId: string, perguntaId: string, nota: AvaliacaoDaResposta): Promise<{ avaliacao: AvaliacaoDaResposta }> {
  const db = await exigirDb();
  const agora = Date.now();
  const resultado: unknown = await db.update(perguntasEntreReunioes)
    .set({ avaliacao: nota, avaliadaEm: agora, updatedAt: agora })
    .where(and(
      eq(perguntasEntreReunioes.id, perguntaId),
      eq(perguntasEntreReunioes.ownerId, ownerId),
      inArray(perguntasEntreReunioes.situacao, ["respondida", "nao_respondida"]),
    ));
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  if (typeof linhas !== "number" || linhas < 1) throw new RecusaEntreReunioes("NOT_FOUND", RECUSAS_ENTRE_REUNIOES.perguntaNaoEncontrada);
  return { avaliacao: nota };
}
