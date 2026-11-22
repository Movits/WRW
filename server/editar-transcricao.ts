import { and, eq, sql } from "drizzle-orm";
import { auditLogs, meetings, meetingTranscripts, meetingTranscriptTranslations } from "../drizzle/schema";
import { FORMATO_DO_FALANTE } from "@shared/const";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import {
  ACAO_TRANSCRICAO_EDITADA, RECUSAS_DA_EDICAO, substituirNoTexto,
  type CodigoDaRecusaDaEdicao, type OperacaoDaEdicao,
} from "@shared/editar-transcricao";
import { exigirDb } from "./db";
import { conferidorDeTrechos } from "./trecho-da-transcricao";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * Editar a transcrição (H18 da auditoria de 16/11; HN-23 e HN-27 do app de
 * referência da cliente). A dona corrige o texto de um trecho, troca a voz de
 * um trecho, localiza e substitui em todos, e volta um trecho, ou tudo, ao que
 * a IA escreveu (shared/editar-transcricao.ts).
 *
 * Onde fica cada versão (meeting_transcripts):
 * - `transcript` e `segments` guardam a versão que a dona vê, e todo leitor lê
 *   essa: o resumo refeito, o mapa mental, o Pergunte, a busca entre reuniões,
 *   a Memória (o updated_at muda a assinatura dela), a exportação, a tradução,
 *   o "ouvir só esta voz" e o link aberto;
 * - `original_transcript` e `original_segments` guardam o que a IA escreveu,
 *   copiado na primeira edição. Servem à conferência do que a IA tirou da
 *   transcrição original (as pendências da extração, ditosNaReuniao em
 *   server/network-extracao.ts), ao "Voltar ao original" e à prova do que
 *   mudou. Só a dona os lê: o link aberto nunca os seleciona;
 * - `edited_at` e `revision` dizem quando e quantas vezes a transcrição mudou.
 *   A fila do resumo descarta o resumo e o mapa escritos sobre uma revisão
 *   anterior (server/fila-do-resumo.ts), e a tradução não guarda a de outra
 *   revisão (server/meeting-service.ts).
 *
 * Cada mudança é uma transação: a reunião travada antes da transcrição (a
 * ordem da fila do resumo, que grava o resumo travando a reunião primeiro), a
 * revisão que a tela viu conferida, as traduções da transcrição apagadas (são
 * da versão anterior) e a auditoria MEETING_TRANSCRIPT_EDITED por insert
 * direto, que lança: sem a linha da auditoria, nada muda. A auditoria leva só
 * o tipo, as contagens e a revisão, nunca a fala, o termo procurado ou o nome.
 *
 * Só a dona edita, e só a reunião pronta: em gravação, processamento ou
 * junção, a transcrição ainda vai ser trocada. O documento (PDF ou fotos) não
 * se edita aqui. Editar muda só o texto: a gravação continua como foi gravada.
 */

// A mesma frase do resto do servidor (server/meeting-service.ts), escrita aqui
// para este módulo não importar o serviço das reuniões, que importa este.
const MENSAGEM_REUNIAO_NAO_ENCONTRADA = "Reunião não encontrada.";

type CodigoTrpc = "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" | "BAD_REQUEST";

/** A recusa da edição: o código do tRPC e, na mensagem, o código que a tela traduz. */
export class RecusaDaEdicao extends Error {
  constructor(readonly codigoTrpc: CodigoTrpc, codigo: CodigoDaRecusaDaEdicao | typeof MENSAGEM_REUNIAO_NAO_ENCONTRADA) {
    super(codigo);
  }
}

/** Um segmento como está guardado: JSON livre, com os campos do contrato e o que mais vier (o idioma da fala, G16). */
type SegmentoGuardado = Record<string, unknown>;

/**
 * O segmento do contrato `{inicio, fim, falante, texto, lacuna?}`: a mesma
 * régua de segmentosDoContrato (server/link-aberto-da-reuniao.ts) e de
 * segmentosValidos (a tela), que a posição de um trecho tem de seguir.
 */
function ehFalaDoContrato(s: unknown): s is SegmentoGuardado {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const { inicio, fim, falante, texto } = s as SegmentoGuardado;
  return Number.isFinite(inicio) && Number.isFinite(fim) && typeof falante === "string" && typeof texto === "string";
}

/**
 * As falas do contrato, cada uma com o lugar dela na lista guardada. A
 * posição que a tela manda (`indice`) conta só estas, como a lista da tela; o
 * lugar na lista guardada é o que a edição muda, para nenhum outro campo do
 * segmento se perder.
 */
export function falasDoContrato(bruto: unknown): Array<{ lugar: number; segmento: SegmentoGuardado }> {
  if (!Array.isArray(bruto)) return [];
  const falas: Array<{ lugar: number; segmento: SegmentoGuardado }> = [];
  bruto.forEach((segmento, lugar) => {
    if (ehFalaDoContrato(segmento)) falas.push({ lugar, segmento });
  });
  return falas;
}

/**
 * O texto corrido das falas, como a montagem da transcrição o escreve
 * (montarTranscricao, em server/transcricao-de-fatia.ts, e o do vídeo do
 * YouTube): as falas na ordem, sem o rótulo da voz, uma por linha; o trecho
 * que não chegou fica de fora.
 */
export function textoCorridoDasFalas(bruto: unknown): string {
  return falasDoContrato(bruto).filter(({ segmento }) => segmento.lacuna !== true).map(({ segmento }) => String(segmento.texto)).join("\n");
}

/** O JSON com as chaves em ordem: o MySQL 8 devolve as chaves de um objeto JSON em outra ordem que a gravada. */
function canonico(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.keys(valor as Record<string, unknown>).sort().map(chave => [chave, canonico((valor as Record<string, unknown>)[chave])]));
  }
  return valor;
}

function mesmoJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonico(a)) === JSON.stringify(canonico(b));
}

/** O estado que a edição lê e escreve: a versão de agora e a da IA (null enquanto são a mesma). */
export type VersoesDaTranscricao = {
  texto: string;
  segmentos: unknown;
  originalTexto: string | null;
  originalSegmentos: unknown;
};

/** O que uma operação faz com a transcrição, antes de gravar. */
export type ResultadoDaOperacao =
  | { mudou: false; substituicoes: number }
  | { mudou: true; texto: string; segmentos: unknown; original: { texto: string; segmentos: unknown } | null; trechos: number; substituicoes: number };

const recusa = (codigo: CodigoDaRecusaDaEdicao, codigoTrpc: CodigoTrpc = "BAD_REQUEST") => new RecusaDaEdicao(codigoTrpc, codigo);

/** A fala na posição pedida, que não pode ser o trecho que não chegou. */
function falaNaPosicao(falas: ReturnType<typeof falasDoContrato>, indice: number) {
  const fala = Number.isInteger(indice) && indice >= 0 ? falas[indice] : undefined;
  if (!fala || fala.segmento.lacuna === true) throw recusa(RECUSAS_DA_EDICAO.trecho);
  return fala;
}

/** Quantos trechos são diferentes entre duas listas de falas do mesmo tamanho (o texto ou a voz). */
function trechosDiferentes(a: unknown, b: unknown): number {
  const de = falasDoContrato(a);
  const para = falasDoContrato(b);
  let diferentes = Math.abs(de.length - para.length);
  for (let i = 0; i < Math.min(de.length, para.length); i++) {
    if (de[i].segmento.texto !== para[i].segmento.texto || de[i].segmento.falante !== para[i].segmento.falante) diferentes += 1;
  }
  return diferentes;
}

/**
 * Aplica uma operação às versões da transcrição, sem banco (os testes a
 * exercitam direto). A transcrição em falas muda trecho a trecho, e o texto
 * corrido é refeito das falas; a de texto corrido muda como um texto só. A
 * lista de falas nunca muda de tamanho nem de ordem, e o tempo de cada trecho
 * não muda: só o texto e a voz. Ao fim, a versão igual à da IA devolve
 * `original` nulo (a transcrição deixa de estar editada); senão, `original` é
 * a da IA, copiada da versão de agora na primeira edição.
 */
export function aplicarOperacao(versoes: VersoesDaTranscricao, operacao: OperacaoDaEdicao): ResultadoDaOperacao {
  const brutos = Array.isArray(versoes.segmentos) ? (versoes.segmentos as unknown[]) : [];
  const falas = falasDoContrato(brutos);
  const emFalas = falas.length > 0;
  const original = versoes.originalTexto !== null
    ? { texto: versoes.originalTexto, segmentos: versoes.originalSegmentos }
    : { texto: versoes.texto, segmentos: versoes.segmentos };
  let novosSegmentos: unknown = versoes.segmentos;
  let novoTexto = versoes.texto;
  let substituicoes = 0;

  const trocarFala = (lugar: number, segmento: SegmentoGuardado) => {
    const copia = brutos.slice();
    copia[lugar] = segmento;
    novosSegmentos = copia;
  };

  switch (operacao.tipo) {
    case "texto": {
      if (!emFalas) throw recusa(RECUSAS_DA_EDICAO.trecho);
      const fala = falaNaPosicao(falas, operacao.indice);
      const texto = operacao.texto.trim();
      if (!texto) throw recusa(RECUSAS_DA_EDICAO.vazio);
      if (texto !== fala.segmento.texto) trocarFala(fala.lugar, { ...fala.segmento, texto });
      break;
    }
    case "voz": {
      if (!emFalas) throw recusa(RECUSAS_DA_EDICAO.trecho);
      const fala = falaNaPosicao(falas, operacao.indice);
      if (!FORMATO_DO_FALANTE.test(operacao.falante)) throw recusa(RECUSAS_DA_EDICAO.trecho);
      if (operacao.falante !== fala.segmento.falante) trocarFala(fala.lugar, { ...fala.segmento, falante: operacao.falante });
      break;
    }
    case "substituir": {
      if (!operacao.localizar.trim()) throw recusa(RECUSAS_DA_EDICAO.trecho);
      const diferenciar = operacao.diferenciarMaiusculas === true;
      if (emFalas) {
        const copia = brutos.slice();
        for (const { lugar, segmento } of falas) {
          if (segmento.lacuna === true) continue;
          const troca = substituirNoTexto(String(segmento.texto), operacao.localizar, operacao.substituirPor, diferenciar);
          if (!troca.quantas) continue;
          // A troca que esvaziaria um trecho inteiro é recusada inteira: a fala some sem a dona ver qual.
          if (!troca.texto.trim()) throw recusa(RECUSAS_DA_EDICAO.vazio);
          substituicoes += troca.quantas;
          copia[lugar] = { ...segmento, texto: troca.texto };
        }
        if (substituicoes) novosSegmentos = copia;
      } else {
        const troca = substituirNoTexto(versoes.texto, operacao.localizar, operacao.substituirPor, diferenciar);
        if (troca.quantas && !troca.texto.trim()) throw recusa(RECUSAS_DA_EDICAO.vazio);
        substituicoes = troca.quantas;
        novoTexto = troca.texto;
      }
      break;
    }
    case "textoCorrido": {
      // A transcrição em falas muda trecho a trecho: o texto corrido dela é refeito das falas.
      if (emFalas) throw recusa(RECUSAS_DA_EDICAO.trecho);
      const texto = operacao.texto.trim();
      if (!texto) throw recusa(RECUSAS_DA_EDICAO.vazio);
      novoTexto = texto;
      break;
    }
    case "restaurar": {
      if (!emFalas) throw recusa(RECUSAS_DA_EDICAO.trecho);
      const fala = falaNaPosicao(falas, operacao.indice);
      if (versoes.originalTexto === null) break;
      const originais = Array.isArray(versoes.originalSegmentos) ? (versoes.originalSegmentos as unknown[]) : [];
      // A lista nunca muda de tamanho; outra (a transcrição refeita) não tem o trecho de volta.
      if (originais.length !== brutos.length || !ehFalaDoContrato(originais[fala.lugar])) throw recusa(RECUSAS_DA_EDICAO.trecho);
      if (!mesmoJson(originais[fala.lugar], fala.segmento)) trocarFala(fala.lugar, originais[fala.lugar] as SegmentoGuardado);
      break;
    }
    case "restaurarTudo": {
      if (versoes.originalTexto === null) break;
      novoTexto = versoes.originalTexto;
      novosSegmentos = versoes.originalSegmentos;
      break;
    }
  }

  // A transcrição em falas tem o texto corrido refeito das falas, e a igual à
  // da IA volta ao texto da IA, como estava.
  const igualAoOriginal = emFalas
    ? mesmoJson(novosSegmentos, original.segmentos)
    : novoTexto === original.texto && mesmoJson(novosSegmentos, original.segmentos);
  if (emFalas) novoTexto = igualAoOriginal ? original.texto : textoCorridoDasFalas(novosSegmentos);
  const mudou = novoTexto !== versoes.texto || !mesmoJson(novosSegmentos, versoes.segmentos);
  if (!mudou) return { mudou: false, substituicoes: 0 };
  return {
    mudou: true,
    texto: novoTexto,
    segmentos: novosSegmentos,
    original: igualAoOriginal ? null : original,
    trechos: emFalas ? trechosDiferentes(versoes.segmentos, novosSegmentos) : 1,
    substituicoes,
  };
}

/** Quem pediu, para a auditoria: o id da conta, o IP e o navegador. */
export type ProvaDaEdicao = { userId: number; ipAddress: string; userAgent: string | null | undefined };

export type PedidoDeEdicao = {
  /** A transcrição e a revisão que a tela leu: outra é recusada (MUDOU). */
  transcricaoId: string;
  revisao: number;
  operacao: OperacaoDaEdicao;
};

export type EdicaoFeita = {
  mudou: boolean;
  revisao: number;
  /** A transcrição está diferente da que a IA escreveu. */
  editada: boolean;
  /** Quantas ocorrências a substituição trocou (0 nas outras operações). */
  substituicoes: number;
};

/**
 * A dona muda a transcrição de uma reunião pronta dela. Reunião de outra
 * conta, excluída ou na lixeira (H7d) é "não encontrada". Pedido que não muda
 * nada (o mesmo texto, a voz que já era, a busca sem ocorrência) não grava,
 * não sobe a revisão e não entra na auditoria.
 */
export async function editarTranscricao(ownerId: string, meetingId: string, pedido: PedidoDeEdicao, prova: ProvaDaEdicao): Promise<EdicaoFeita> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    // A reunião primeiro, como a fila do resumo (gravarResumo e gravarMapa):
    // a edição e a gravação de um resumo nunca se travam em ordens opostas, e
    // o resumo que a fila grava depois desta transação relê a revisão nova.
    // A reunião na lixeira (H7d) é "não encontrada", como a excluída: a
    // leitura travada é a mesma linha que o "mandar para a lixeira" muda, então
    // a edição que chega depois dele não passa, nem na corrida com a guarda.
    const [reuniao] = await tx.select({ status: meetings.status, origem: meetings.origem }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).for("update");
    if (!reuniao) throw new RecusaDaEdicao("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    if (ehReuniaoDeDocumento(reuniao.origem)) throw recusa(RECUSAS_DA_EDICAO.documento, "PRECONDITION_FAILED");
    if (reuniao.status !== "ready") throw recusa(RECUSAS_DA_EDICAO.foraDoEstado, "CONFLICT");

    const [linha] = await tx.select({
      id: meetingTranscripts.id, texto: meetingTranscripts.transcript, segmentos: meetingTranscripts.segments,
      originalTexto: meetingTranscripts.originalTranscript, originalSegmentos: meetingTranscripts.originalSegments,
      revisao: meetingTranscripts.revision,
    }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).for("update");
    // Sem a transcrição que a tela leu, ou com outra revisão: outra aba editou,
    // ou a transcrição foi refeita. A posição do trecho não vale mais.
    if (!linha || linha.id !== pedido.transcricaoId || Number(linha.revisao) !== pedido.revisao) throw recusa(RECUSAS_DA_EDICAO.mudou, "CONFLICT");

    const resultado = aplicarOperacao(
      { texto: linha.texto, segmentos: linha.segmentos, originalTexto: linha.originalTexto, originalSegmentos: linha.originalSegmentos },
      pedido.operacao,
    );
    if (!resultado.mudou) {
      return { mudou: false, revisao: Number(linha.revisao), editada: linha.originalTexto !== null, substituicoes: 0 };
    }

    // A hora depois das travas: o resumo gravado antes desta transação tem
    // generated_at menor, e a tela o mostra como de outra versão.
    const agora = Date.now();
    const revisao = Number(linha.revisao) + 1;
    // A versão da IA só é escrita quando muda: na primeira edição (copiada da
    // de agora) e quando tudo volta a ela (sai). Nas outras, fica como está,
    // e a edição não regrava duas vezes a transcrição de uma reunião longa.
    const originalMuda = (linha.originalTexto === null) !== (resultado.original === null);
    await tx.update(meetingTranscripts).set({
      transcript: resultado.texto,
      segments: resultado.segmentos,
      ...(originalMuda
        ? { originalTranscript: resultado.original?.texto ?? null, originalSegments: resultado.original ? resultado.original.segmentos ?? null : null }
        : {}),
      editedAt: agora,
      revision: revisao,
      // A assinatura da Memória lê o updated_at: a versão nova é indexada na próxima busca.
      updatedAt: agora,
    }).where(and(eq(meetingTranscripts.id, linha.id), eq(meetingTranscripts.ownerId, ownerId)));
    // As traduções guardadas são da versão anterior: a próxima leitura traduz a nova.
    await tx.delete(meetingTranscriptTranslations)
      .where(and(eq(meetingTranscriptTranslations.meetingId, meetingId), eq(meetingTranscriptTranslations.ownerId, ownerId)));
    await tx.insert(auditLogs).values({
      userId: prova.userId,
      action: ACAO_TRANSCRICAO_EDITADA,
      resource: "meetings",
      resourceId: meetingId,
      // Só o tipo, as contagens e a revisão: nunca a fala, o termo procurado
      // ou o nome de uma voz (o painel da administração lê audit_logs).
      details: {
        operacao: pedido.operacao.tipo,
        trechos: resultado.trechos,
        substituicoes: resultado.substituicoes,
        revisao,
        voltouAoOriginal: resultado.original === null,
      },
      // Os mesmos cortes do createAuditLog (server/security.ts).
      ipAddress: prova.ipAddress.split(",")[0].trim().substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      status: "success",
      // Muda o registro do que foi dito na reunião: médio, como exportar.
      riskLevel: "medium",
    });
    return { mudou: true, revisao, editada: resultado.original !== null, substituicoes: resultado.substituicoes };
  });
}

/**
 * O que a tela da dona recebe sobre a edição da transcrição: a revisão (que
 * ela manda de volta ao editar), se está editada e desde quando, e, de cada
 * trecho que a dona mudou, o que a IA tinha escrito (o texto e a voz), pela
 * posição do trecho entre as falas. Só para a dona: o link aberto não recebe
 * nada disto.
 */
export type EdicaoDaTranscricao = {
  revisao: number;
  editada: boolean;
  editadaEm: number | null;
  originais: Array<{ indice: number; texto: string; falante: string }>;
};

export function edicaoDaTranscricao(linha: { segments: unknown; originalSegments: unknown; editada: boolean; editedAt: number | null; revision: number }): EdicaoDaTranscricao {
  const originais: EdicaoDaTranscricao["originais"] = [];
  if (linha.editada) {
    const lista = Array.isArray(linha.originalSegments) ? (linha.originalSegments as unknown[]) : [];
    falasDoContrato(linha.segments).forEach(({ lugar, segmento }, indice) => {
      const era = lista[lugar];
      if (!ehFalaDoContrato(era)) return;
      if (era.texto !== segmento.texto || era.falante !== segmento.falante) originais.push({ indice, texto: String(era.texto), falante: String(era.falante) });
    });
  }
  return { revisao: Number(linha.revision), editada: linha.editada, editadaEm: linha.editedAt === null ? null : Number(linha.editedAt), originais };
}

/**
 * "Está editada" pela consulta, sem ler o texto original: a coluna nula ou
 * não. É o que a lista (a junção avisa que as correções não passam para a
 * reunião juntada), o link aberto e a exportação leem.
 */
export const transcricaoEstaEditada = sql<number>`(${meetingTranscripts.originalTranscript} IS NOT NULL)`;

/**
 * O trecho de cada item do resumo que sai pelo link aberto (H18): o link
 * mostra a transcrição que a dona editou e não pode expor a da IA. O trecho de
 * um item saiu da transcrição de quando o resumo foi escrito; o que não
 * aparece mais na de agora (a dona tirou ou corrigiu aquela fala) vai vazio, e
 * a marca `trechoForaDaTranscricao` diz à página que ele existia. Sem edição,
 * todo trecho vai como está. O texto da IA nunca é lido aqui: só se a
 * transcrição está editada. Vale para o resumo pelo link
 * (resumoGuardadoPeloLink) e para a tradução dele (traduzirResumoPeloLink),
 * que leva o trecho junto, sem traduzir.
 */
export async function trechosNaTranscricaoDeAgora<T extends { excerpt: string }>(
  ownerId: string, meetingId: string, itens: readonly T[],
): Promise<Array<T & { trechoForaDaTranscricao: boolean }>> {
  let estaNaDeAgora: ((trecho: unknown) => boolean) | null = null;
  if (itens.some(item => item.excerpt)) {
    const db = await exigirDb();
    const [transcricao] = await db.select({ texto: meetingTranscripts.transcript, editada: transcricaoEstaEditada }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
    if (transcricao && Number(transcricao.editada)) estaNaDeAgora = conferidorDeTrechos(transcricao.texto);
  }
  return itens.map(item => {
    const trechoForaDaTranscricao = estaNaDeAgora !== null && !!item.excerpt && !estaNaDeAgora(item.excerpt);
    return { ...item, excerpt: trechoForaDaTranscricao ? "" : item.excerpt, trechoForaDaTranscricao };
  });
}
