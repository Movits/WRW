import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { meetingSummaries, meetingTranscripts } from "../drizzle/schema";
import { conferirMapaMental, type MapaMental } from "@shared/mapa-mental";
import { exigirDb } from "./db";
import { exigirReuniaoDoLink } from "./link-aberto-da-reuniao";
import { MENSAGEM_SEM_TRANSCRICAO } from "./reuniao-com-ia";
import { pedirResumoDaReuniao, reuniaoDaDona, type AntesDeCriar } from "./resumo-guardado";

/**
 * O mapa mental da reunião (H10 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), como a tela o lê e o pede. Ele
 * mora na linha do resumo guardado (meeting_summaries) e é gerado pela fila do
 * resumo (server/fila-do-resumo.ts), logo depois do resumo; aqui só se lê e se
 * pede. Toda consulta leva a dona no WHERE: reunião de outra dona é "não
 * encontrada". Banco fora do ar sobe como erro, nunca vira "sem mapa".
 *
 * Pedir serve à reunião resumida antes de o mapa existir e ao mapa que falhou,
 * e gasta uma vaga do teto de pedidos à IA (o do resumo e das perguntas). Sem
 * resumo pronto, pedir o mapa é pedir o resumo: o mapa vem com ele.
 */

export type EstadoDoMapa = "sem_mapa" | "pendente" | "gerando" | "pronto" | "falhou";
type Banco = Awaited<ReturnType<typeof exigirDb>>;

type LinhaDoMapa = {
  status: string;
  lockedUntil: number | null;
  lockToken: string | null;
  lastError: string | null;
  mindMapStatus: string | null;
  mindMapError: string | null;
};

/**
 * O estado do mapa pela linha do resumo. Enquanto o resumo está na fila, o
 * mapa também está (ele vem logo depois). O resumo que falhou leva o mapa
 * junto: pedir de novo o refaz. "Gerando" só com uma reserva viva, como no
 * resumo: na espera depois de uma falha passageira, ninguém está gerando.
 */
export function estadoDoMapa(linha: LinhaDoMapa | undefined, agora: number): { estado: EstadoDoMapa; erro: string | null } {
  if (!linha) return { estado: "sem_mapa", erro: null };
  const reservaViva = !!linha.lockToken && linha.lockedUntil !== null && Number(linha.lockedUntil) > agora;
  if (linha.status === "pending") return { estado: reservaViva ? "gerando" : "pendente", erro: null };
  if (linha.status === "failed") return { estado: "falhou", erro: linha.lastError };
  if (linha.status !== "ready") return { estado: "sem_mapa", erro: null };
  switch (linha.mindMapStatus) {
    case "pending": return { estado: reservaViva ? "gerando" : "pendente", erro: null };
    case "ready": return { estado: "pronto", erro: null };
    case "failed": return { estado: "falhou", erro: linha.mindMapError };
    // Nulo: o resumo é de antes do mapa.
    default: return { estado: "sem_mapa", erro: null };
  }
}

const COLUNAS_DO_MAPA = {
  id: meetingSummaries.id,
  status: meetingSummaries.status,
  lockedUntil: meetingSummaries.lockedUntil,
  lockToken: meetingSummaries.lockToken,
  lastError: meetingSummaries.lastError,
  language: meetingSummaries.language,
  mindMap: meetingSummaries.mindMap,
  mindMapStatus: meetingSummaries.mindMapStatus,
  mindMapError: meetingSummaries.mindMapError,
};

async function linhaDoMapa(db: Banco, ownerId: string, meetingId: string) {
  const [linha] = await db.select(COLUNAS_DO_MAPA).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1);
  return linha;
}

/**
 * O que a tela recebe: o estado, o idioma em que o mapa foi escrito (o do
 * resumo, que decide a direção da árvore), o código do erro e, pronto, a
 * árvore conferida de novo. A árvore guardada que não passa mais na
 * conferência é falha, nunca um mapa pela metade.
 */
function paraATela(linha: Awaited<ReturnType<typeof linhaDoMapa>>, agora: number): {
  estado: EstadoDoMapa; idioma: string | null; erro: string | null; mapa: MapaMental | null;
} {
  const { estado, erro } = estadoDoMapa(linha, agora);
  if (estado !== "pronto") return { estado, idioma: linha?.language ?? null, erro, mapa: null };
  const mapa = conferirMapaMental(linha?.mindMap);
  if (!mapa) return { estado: "falhou", idioma: linha?.language ?? null, erro: "MAPA_INVALIDO", mapa: null };
  return { estado, idioma: linha?.language ?? null, erro: null, mapa };
}

/** O mapa mental da reunião para a dona. */
export async function mapaMentalDaDona(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  await reuniaoDaDona(db, ownerId, meetingId);
  return paraATela(await linhaDoMapa(db, ownerId, meetingId), Date.now());
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * Põe o mapa na fila. Sem resumo (ou com o resumo que falhou), pede o resumo,
 * e o mapa vem com ele. Com o resumo na fila, ou com o mapa na fila ou pronto,
 * nada muda e nada se gasta. Com o resumo pronto e o mapa ausente ou falho, o
 * mapa volta à fila do zero, com as tentativas dele; o pedido que perde a
 * corrida para outro igual devolve a vaga.
 */
async function pedirMapaDaReuniao(db: Banco, ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar) {
  const linha = await linhaDoMapa(db, ownerId, meetingId);
  if (!linha || linha.status === "failed") return pedirResumoDaReuniao(db, ownerId, meetingId, antesDeCriar);
  if (linha.status !== "ready" || linha.mindMapStatus === "pending" || linha.mindMapStatus === "ready") return;
  const [transcricao] = await db.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  if (!transcricao) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  const soltarVaga = antesDeCriar();
  const r = await db.update(meetingSummaries).set({
    mindMapStatus: "pending", mindMapError: null, attempts: 0, lockedUntil: null, lockToken: null, updatedAt: Date.now(),
  }).where(and(
    eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId), eq(meetingSummaries.status, "ready"),
    or(isNull(meetingSummaries.mindMapStatus), eq(meetingSummaries.mindMapStatus, "failed")),
  ));
  if (!linhasAfetadas(r)) soltarVaga?.();
}

/** A dona pede o mapa de uma reunião pronta (a antiga, ou o mapa que falhou). */
export async function pedirMapaDaDona(ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar) {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  if (reuniao.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  await pedirMapaDaReuniao(db, ownerId, meetingId, antesDeCriar);
  return mapaMentalDaDona(ownerId, meetingId);
}

/**
 * O mapa mental pelo link aberto (decisão do Roberto de 12/11/2026): só
 * leitura, com o mesmo formato da dona. Ele não leva quem falou (a conferência
 * não aceita rótulo de voz), então não há nome a esconder nem a mostrar.
 */
export async function mapaMentalPeloLink(token: string) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  return paraATela(await linhaDoMapa(db, reuniao.ownerId, reuniao.id), Date.now());
}

/** Quem tem o link pede o mapa que a reunião ainda não tem (ou que falhou). */
export async function pedirMapaPeloLink(token: string, antesDeCriar: (reuniaoId: string) => (() => void) | void) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  await pedirMapaDaReuniao(db, reuniao.ownerId, reuniao.id, () => antesDeCriar(reuniao.id));
  return mapaMentalPeloLink(token);
}
