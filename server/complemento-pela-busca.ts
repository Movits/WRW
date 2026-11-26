import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, eq, gte, isNotNull } from "drizzle-orm";
import { buscasDoComplemento, meetings, meetingSummaries, meetingSummaryItems } from "../drizzle/schema";
import {
  BUSCAS_DO_COMPLEMENTO_POR_DIA, COMPLEMENTO_MAX, CONSULTAS_DO_COMPLEMENTO_MAX, consultasDoComplemento, fonteDoComplemento, RECUSAS_DO_COMPLEMENTO,
} from "@shared/complemento-pela-busca";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado, nomeDoIdioma } from "@shared/idioma-da-reuniao";
import { modeloDaBusca } from "./_core/modelos-de-ia";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { buscarComGemini, type RespostaDaBusca } from "./gemini";
import { MENSAGEM_ITEM_NAO_ENCONTRADO } from "@shared/const";
import { reuniaoForaDeVista } from "./reuniao-visivel";

/**
 * O complemento pela busca na web (H4i; regras em shared/complemento-pela-busca.ts).
 *
 * - Só a dona, item a item, no resumo que está na tela e fora da fila (o
 *   pronto, ou o refazer que falhou), de reunião pronta e visível; o item
 *   ignorado não se completa.
 * - Vai à IA só o texto do item (o assunto e o texto, com os rótulos de voz
 *   crus, sem nomes) e o idioma; o trecho da transcrição não vai: é a fala das
 *   pessoas, e a busca não precisa dele (decisão vetável).
 * - A resposta só vale com uma fonte da busca (groundingChunks); sem fonte, ou
 *   com a IA dizendo que não achou, nada é gravado e a dona lê "não achei".
 * - O complemento nasce 'pending' no item, com a fonte e as consultas: só a
 *   dona o vê, marcado "fora da reunião, a conferir". Confirmar o leva ao
 *   resumo (o link aberto, a Memória e o áudio do resumo); descartar apaga as
 *   colunas. Pedir de novo troca o que esperava a decisão.
 * - Teto: BUSCAS_DO_COMPLEMENTO_POR_DIA buscas por dona em 24 h, contadas em
 *   buscas_do_complemento (a que falhou também), antes de chamar a IA.
 */

export const NAO_ACHEI = "NAO_ENCONTRADO";

/** O pedido à IA: completar só a referência dita pela metade, curto, no idioma do resumo. */
export function promptDoComplemento(item: { subject: string | null; text: string }, idioma: string): string {
  const alvo = [item.subject, item.text].filter(Boolean).join(": ");
  return [
    "Um item do resumo de uma reunião cita uma referência dita pela metade (o número de uma lei ou de uma norma, o nome de uma empresa, de um órgão ou de um programa).",
    "Use a busca na web para identificar a referência completa e responda só com ela, em uma ou duas frases curtas, sem repetir o item e sem opinião.",
    `Escreva em ${nomeDoIdioma(idiomaFalado(idioma) ?? IDIOMA_DA_REUNIAO_PADRAO)}. Rótulos como {F1} são vozes da reunião: não os pesquise.`,
    `Se a busca não identificar com segurança a referência, responda só ${NAO_ACHEI}.`,
    "",
    `Item: ${alvo}`,
  ].join("\n");
}

/** O que a busca devolveu, já conferido: o texto (até COMPLEMENTO_MAX), a primeira fonte https e as consultas. Nulo: não achou. */
export function complementoDaResposta(resposta: RespostaDaBusca): { texto: string; fonte: string; titulo: string | null; consultas: string[] } | null {
  const texto = resposta.texto.replace(/\s+/g, " ").trim();
  if (!texto || texto.toUpperCase().includes(NAO_ACHEI)) return null;
  const fonte = resposta.fontes.map(candidata => ({ url: fonteDoComplemento(candidata.url), titulo: candidata.titulo })).find(candidata => candidata.url);
  if (!fonte?.url) return null;
  const cortado = texto.length > COMPLEMENTO_MAX ? `${texto.slice(0, COMPLEMENTO_MAX - 1).trimEnd()}…` : texto;
  return {
    texto: cortado,
    fonte: fonte.url,
    titulo: fonte.titulo ? fonte.titulo.trim().slice(0, 300) || null : null,
    consultas: consultasDoComplemento(resposta.consultas).slice(0, CONSULTAS_DO_COMPLEMENTO_MAX),
  };
}

const recusa = (code: "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "NOT_FOUND", codigo: string) => new TRPCError({ code, message: codigo });
const DIA_MS = 24 * 60 * 60_000;
type Executor = Pick<Awaited<ReturnType<typeof exigirDb>>, "select">;

/** O item da dona, da reunião visível e pronta, no resumo fora da fila, e não ignorado. */
async function itemParaCompletar(db: Executor, ownerId: string, itemId: string, travar = false) {
  const consulta = db.select({
    id: meetingSummaryItems.id, meetingId: meetingSummaryItems.meetingId, summaryId: meetingSummaryItems.summaryId,
    status: meetingSummaryItems.status, subject: meetingSummaryItems.subject, text: meetingSummaryItems.text,
    complementText: meetingSummaryItems.complementText, complementStatus: meetingSummaryItems.complementStatus,
  }).from(meetingSummaryItems).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
  const [item] = await (travar ? consulta.for("update") : consulta);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  const [reuniao] = await db.select({ status: meetings.status, trashedAt: meetings.trashedAt }).from(meetings)
    .where(and(eq(meetings.id, item.meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (reuniaoForaDeVista(reuniao)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  const [resumo] = await db.select({ status: meetingSummaries.status, language: meetingSummaries.language }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.id, item.summaryId), eq(meetingSummaries.ownerId, ownerId))).limit(1);
  const foraDaFila = resumo?.status === "ready" || resumo?.status === "failed";
  if (!resumo || !foraDaFila || reuniao!.status !== "ready" || item.status === "ignored") {
    throw recusa("PRECONDITION_FAILED", RECUSAS_DO_COMPLEMENTO.itemForaDoResumo);
  }
  return { ...item, idioma: resumo.language ?? IDIOMA_DA_REUNIAO_PADRAO };
}

export type DependenciasDaBusca = { buscar: (prompt: string, modelo: string) => Promise<RespostaDaBusca> };
const PADRAO: DependenciasDaBusca = { buscar: buscarComGemini };

/** A dona pede o complemento de um item. Devolve o que ficou esperando a decisão dela. */
export async function pedirComplemento(ownerId: string, itemId: string, deps: DependenciasDaBusca = PADRAO) {
  const db = await exigirDb();
  const item = await itemParaCompletar(db, ownerId, itemId);
  const agora = Date.now();
  const [usadas] = await db.select({ n: count() }).from(buscasDoComplemento)
    .where(and(eq(buscasDoComplemento.ownerId, ownerId), gte(buscasDoComplemento.createdAt, agora - DIA_MS)));
  if (Number(usadas?.n ?? 0) >= BUSCAS_DO_COMPLEMENTO_POR_DIA) throw recusa("TOO_MANY_REQUESTS", RECUSAS_DO_COMPLEMENTO.demais);
  const modelo = modeloDaBusca();
  const id = crypto.randomUUID();
  await db.insert(buscasDoComplemento).values({ id, ownerId, situacao: "pendente", modelo, createdAt: agora, updatedAt: agora });
  const marcar = (situacao: "achou" | "nao_achou" | "falhou") =>
    db.update(buscasDoComplemento).set({ situacao, updatedAt: Date.now() }).where(and(eq(buscasDoComplemento.id, id), eq(buscasDoComplemento.ownerId, ownerId)));

  let resposta: RespostaDaBusca;
  try {
    resposta = await deps.buscar(promptDoComplemento(item, item.idioma), modelo);
  } catch (erro) {
    await marcar("falhou");
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    console.warn("[Complemento] a busca no Gemini falhou:", erro instanceof Error ? erro.message : erro);
    throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_COMPLEMENTO.ia);
  }
  const achado = complementoDaResposta(resposta);
  if (!achado) {
    await marcar("nao_achou");
    throw recusa("PRECONDITION_FAILED", RECUSAS_DO_COMPLEMENTO.naoAchou);
  }
  // Grava numa transação que relê o item travado: o resumo pode ter sido
  // refeito, ou o item ignorado, enquanto a busca rodava.
  await db.transaction(async tx => {
    await itemParaCompletar(tx, ownerId, itemId, true);
    const momento = Date.now();
    await tx.update(meetingSummaryItems).set({
      complementText: achado.texto, complementSourceUrl: achado.fonte, complementSourceTitle: achado.titulo,
      complementQueries: achado.consultas, complementStatus: "pending", complementAt: momento, updatedAt: momento,
    }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
  });
  await marcar("achou");
  return { texto: achado.texto, fonte: achado.fonte, titulo: achado.titulo, consultas: achado.consultas, situacao: "pending" as const };
}

/**
 * A dona decide o complemento que espera: confirmar o leva ao resumo;
 * descartar apaga as colunas (descartar o confirmado também o tira do resumo).
 */
export async function decidirComplemento(ownerId: string, itemId: string, decisao: "confirmar" | "descartar") {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const item = await itemParaCompletar(tx, ownerId, itemId, true);
    if (!item.complementText || !item.complementStatus) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_COMPLEMENTO.ausente);
    const agora = Date.now();
    const onde = and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId), isNotNull(meetingSummaryItems.complementText));
    if (decisao === "confirmar") {
      await tx.update(meetingSummaryItems).set({ complementStatus: "confirmed", updatedAt: agora }).where(onde);
    } else {
      await tx.update(meetingSummaryItems).set({
        complementText: null, complementSourceUrl: null, complementSourceTitle: null, complementQueries: null,
        complementStatus: null, complementAt: null, updatedAt: agora,
      }).where(onde);
    }
  });
}
