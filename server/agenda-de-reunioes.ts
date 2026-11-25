import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import type { ParticipanteDaAgenda } from "@shared/agenda";
import { estadoNaGoogle, type EstadoNaGoogle } from "@shared/google-agenda-eventos";
import { agendaReunioes, meetings } from "../drizzle/schema";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";
import { agendarLembreteDaAgenda, esquecerLembrete } from "./lembretes";
import { ehColisaoDeChave } from "./network-codigo-anonimo";

/**
 * A agenda de reuniões da dona (H16a do plano do gravador): marcar, mudar,
 * tirar e ligar a gravação feita pelo "Gravar agora". Toda consulta leva a dona
 * no WHERE: a reunião marcada por outra conta é "não encontrada". Banco fora do
 * ar sobe como erro, nunca vira "agenda vazia" (server/CLAUDE.md).
 *
 * As recusas saem com o código do tRPC, e a tela escolhe a frase no idioma de
 * quem lê pelo código (pages/Agenda.tsx); as frases daqui ficam para o log.
 *
 * A Google Agenda (H16c): primeiro o banco, depois a Google. Marcar e mudar já
 * gravam o estado na Google ("pendente" quando a dona tem a Google Agenda
 * conectada), e a rota manda o evento em seguida (server/agenda-na-google.ts).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** Teto de reuniões na agenda de uma dona, contra quem a encha por engano ou de propósito. */
export const AGENDA_MAXIMO_POR_DONA = 1000;
/** Quantas a tela recebe de cada lado: as próximas (e a que está acontecendo) e as que já acabaram. */
export const PROXIMAS_NO_MAXIMO = 200;
export const ANTERIORES_NO_MAXIMO = 50;

export const MENSAGEM_AGENDADA_NAO_ENCONTRADA = "Reunião agendada não encontrada.";
export const MENSAGEM_GRAVACAO_NAO_ENCONTRADA = "Gravação não encontrada.";
export const MENSAGEM_GRAVACAO_JA_LIGADA = "Esta gravação já está ligada a outra reunião da agenda.";
export const MENSAGEM_AGENDA_CHEIA = "A agenda chegou ao limite de reuniões. Exclua as antigas para marcar novas.";

/** O que a dona escreve; já conferido e limpo pela rota (server/routers/agenda.ts). */
export type DadosDaAgendada = {
  titulo: string;
  inicioEm: number;
  duracaoMinutos: number;
  fuso: string;
  local: string | null;
  participantes: ParticipanteDaAgenda[];
  lembreteMinutos: number | null;
  /** A Google manda o convite pela conta da dona (H16c); falso por padrão. */
  googleConvites: boolean;
};

/**
 * A reunião vai para a Google Agenda da dona (H16c)? A rota responde antes de
 * gravar (googleAgendaConectada, em server/google-agenda.ts).
 */
export type OpcoesDaGoogle = { naGoogle: boolean };

/**
 * A gravação ligada, só quando ainda é da dona, não foi excluída e não está na
 * lixeira (H7d). A exclusão volta o ponteiro a nulo (soltarGravacaoDaAgenda); a
 * junção cobre a corrida entre as duas, e o ponteiro solto aparece como "sem
 * gravação". A gravação na lixeira também aparece como "sem gravação": o
 * "Gravar agora" volta, e gravar de novo troca o ponteiro, como sempre.
 */
const JUNCAO_DA_GRAVACAO = and(
  eq(meetings.id, agendaReunioes.meetingId),
  eq(meetings.ownerId, agendaReunioes.ownerId),
  reuniaoVisivel(),
);

const COLUNAS = {
  id: agendaReunioes.id,
  titulo: agendaReunioes.titulo,
  inicioEm: agendaReunioes.inicioEm,
  duracaoMinutos: agendaReunioes.duracaoMinutos,
  fuso: agendaReunioes.fuso,
  local: agendaReunioes.local,
  participantes: agendaReunioes.participantes,
  lembreteMinutos: agendaReunioes.lembreteMinutos,
  google: agendaReunioes.google,
  googleConvites: agendaReunioes.googleConvites,
  // A equipe (R2) em que a dona pôs a reunião, ou nula.
  folderId: agendaReunioes.folderId,
  createdAt: agendaReunioes.createdAt,
  updatedAt: agendaReunioes.updatedAt,
  gravacaoId: meetings.id,
  gravacaoStatus: meetings.status,
};

type Linha = {
  id: string;
  titulo: string;
  inicioEm: number;
  duracaoMinutos: number;
  fuso: string;
  local: string | null;
  participantes: unknown;
  lembreteMinutos: number | null;
  google: string | null;
  googleConvites: unknown;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  gravacaoId: string | null;
  gravacaoStatus: string | null;
};

export type ReuniaoDaAgenda = Omit<Linha, "participantes" | "google" | "googleConvites" | "gravacaoId" | "gravacaoStatus"> & {
  participantes: ParticipanteDaAgenda[];
  /** O estado na Google Agenda da dona (H16c); nulo quando a reunião nunca foi para lá. */
  google: EstadoNaGoogle | null;
  googleConvites: boolean;
  gravacao: { id: string; status: string } | null;
};

/** O tinyint(1) chega como booleano pelo Drizzle, mas pode chegar como 0 e 1. */
export function convitesPelaGoogle(valor: unknown): boolean {
  return valor === true || valor === 1;
}

/** A coluna JSON chega como texto no MariaDB e como objeto no MySQL (jsonCompat); aqui só passa o que tem a forma certa. */
export function participantesDe(valor: unknown): ParticipanteDaAgenda[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .map(p => ({
      nome: typeof p.nome === "string" && p.nome.trim() ? p.nome : null,
      email: typeof p.email === "string" && p.email.trim() ? p.email : null,
    }))
    .filter(p => p.nome || p.email);
}

function paraTela(linha: Linha): ReuniaoDaAgenda {
  const { gravacaoId, gravacaoStatus, participantes, google, googleConvites, ...resto } = linha;
  return {
    ...resto,
    inicioEm: Number(resto.inicioEm),
    createdAt: Number(resto.createdAt),
    updatedAt: Number(resto.updatedAt),
    participantes: participantesDe(participantes),
    google: estadoNaGoogle(google),
    googleConvites: convitesPelaGoogle(googleConvites),
    gravacao: gravacaoId && gravacaoStatus ? { id: gravacaoId, status: gravacaoStatus } : null,
  };
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  return typeof linhas === "number" ? linhas : 0;
}

function naoEncontrada(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_AGENDADA_NAO_ENCONTRADA });
}

/**
 * A agenda da dona em duas listas: as próximas, com a que ainda está
 * acontecendo (o fim depois de agora), da mais perto à mais longe; e as que já
 * acabaram, da mais recente à mais antiga.
 */
export async function listarAgendaDaDona(ownerId: string, agora: number = Date.now()) {
  const db = await exigirDb();
  const daDona = eq(agendaReunioes.ownerId, ownerId);
  const fim = sql`(${agendaReunioes.inicioEm} + ${agendaReunioes.duracaoMinutos} * 60000)`;
  const proximas = await db.select(COLUNAS).from(agendaReunioes).leftJoin(meetings, JUNCAO_DA_GRAVACAO)
    .where(and(daDona, sql`${fim} >= ${agora}`))
    .orderBy(asc(agendaReunioes.inicioEm))
    .limit(PROXIMAS_NO_MAXIMO);
  const anteriores = await db.select(COLUNAS).from(agendaReunioes).leftJoin(meetings, JUNCAO_DA_GRAVACAO)
    .where(and(daDona, sql`${fim} < ${agora}`))
    .orderBy(desc(agendaReunioes.inicioEm))
    .limit(ANTERIORES_NO_MAXIMO);
  return { proximas: (proximas as Linha[]).map(paraTela), anteriores: (anteriores as Linha[]).map(paraTela) };
}

/** Uma reunião da agenda da dona, ou NOT_FOUND. O gravador a lê para o "Gravar agora". */
export async function obterDaAgenda(ownerId: string, id: string): Promise<ReuniaoDaAgenda> {
  const db = await exigirDb();
  const [linha] = await db.select(COLUNAS).from(agendaReunioes).leftJoin(meetings, JUNCAO_DA_GRAVACAO)
    .where(and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId)))
    .limit(1);
  if (!linha) throw naoEncontrada();
  return paraTela(linha as Linha);
}

/**
 * Marca a reunião. Com a Google Agenda conectada, ela nasce "pendente" na
 * Google, e a rota manda o evento em seguida. O `updatedAt` devolvido é a
 * ficha do envio: a Google só fica "ok" se a linha ainda for esta versão.
 */
export async function criarNaAgenda(ownerId: string, dados: DadosDaAgendada, opcoes: OpcoesDaGoogle = { naGoogle: false }): Promise<{ id: string; updatedAt: number }> {
  const db = await exigirDb();
  const [contagem] = await db.select({ total: count() }).from(agendaReunioes).where(eq(agendaReunioes.ownerId, ownerId));
  if (Number(contagem?.total ?? 0) >= AGENDA_MAXIMO_POR_DONA) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_AGENDA_CHEIA });
  }
  const agora = Date.now();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    await tx.insert(agendaReunioes).values({
      id, ownerId, ...dados, googleConvites: dados.googleConvites === true,
      google: opcoes.naGoogle ? "pendente" : null, meetingId: null, createdAt: agora, updatedAt: agora,
    });
    // O lembrete no sino (H15), junto com a reunião: os minutos escolhidos antes do início.
    await agendarLembreteDaAgenda(tx, ownerId, id, dados, agora);
  });
  return { id, updatedAt: agora };
}

/**
 * Muda o que a dona escreveu. A gravação ligada fica como está; a hora ou o
 * lembrete novos reagendam o lembrete no sino, na mesma transação (H15).
 *
 * O estado na Google muda na mesma escrita: com a Google Agenda conectada,
 * "pendente" (a rota manda a versão nova em seguida); sem ela, a reunião que já
 * foi para lá fica "falhou", porque a Google ficou com a versão antiga, e a que
 * nunca foi continua nula. O `updatedAt` devolvido é a ficha do envio, como em
 * criarNaAgenda.
 */
export async function atualizarNaAgenda(ownerId: string, id: string, dados: DadosDaAgendada, opcoes: OpcoesDaGoogle = { naGoogle: false }): Promise<{ id: string; updatedAt: number }> {
  const db = await exigirDb();
  const agora = Date.now();
  const google = opcoes.naGoogle
    ? "pendente" as const
    : sql`CASE WHEN ${agendaReunioes.google} IS NULL THEN NULL ELSE ${"falhou"} END`;
  await db.transaction(async tx => {
    const resultado = await tx.update(agendaReunioes).set({ ...dados, google, updatedAt: agora })
      .where(and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId)));
    if (!linhasAfetadas(resultado)) throw naoEncontrada();
    await agendarLembreteDaAgenda(tx, ownerId, id, dados, agora);
  });
  return { id, updatedAt: agora };
}

/**
 * Tira a reunião da agenda. A gravação, se houver, continua em Reuniões; o
 * lembrete no sino e os avisos dela saem junto (H15).
 * Devolve o estado na Google e a escolha do convite da linha que saiu: a rota
 * tira o evento da Google em seguida (primeiro o banco), quando ele foi para lá.
 */
export async function excluirDaAgenda(ownerId: string, id: string): Promise<{ google: EstadoNaGoogle | null; googleConvites: boolean }> {
  const db = await exigirDb();
  const daDona = and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId));
  return db.transaction(async tx => {
    const [linha] = await tx.select({ google: agendaReunioes.google, googleConvites: agendaReunioes.googleConvites })
      .from(agendaReunioes).where(daDona).limit(1);
    if (!linha) throw naoEncontrada();
    const resultado = await tx.delete(agendaReunioes).where(daDona);
    if (!linhasAfetadas(resultado)) throw naoEncontrada();
    await esquecerLembrete(tx, ownerId, "agenda", id);
    return { google: estadoNaGoogle(linha.google), googleConvites: convitesPelaGoogle(linha.googleConvites) };
  });
}

/**
 * Liga a gravação que o "Gravar agora" criou à reunião marcada. As duas têm de
 * ser da dona, e a gravação não pode estar excluída. Gravar de novo a partir da
 * mesma reunião troca o ponteiro pela gravação nova; a mesma gravação em duas
 * reuniões da agenda é recusada (índice único, CONFLICT).
 */
export async function ligarGravacaoNaAgenda(ownerId: string, id: string, meetingId: string): Promise<void> {
  const db = await exigirDb();
  const [gravacao] = await db.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel()))
    .limit(1);
  if (!gravacao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_GRAVACAO_NAO_ENCONTRADA });
  let resultado: unknown;
  try {
    resultado = await db.update(agendaReunioes).set({ meetingId, updatedAt: Date.now() })
      .where(and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId)));
  } catch (erro) {
    if (ehColisaoDeChave(erro)) throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_GRAVACAO_JA_LIGADA });
    throw erro;
  }
  if (!linhasAfetadas(resultado)) throw naoEncontrada();
}

/**
 * A gravação excluída deixa a agenda: o ponteiro volta a nulo, e a reunião
 * marcada continua na agenda, pronta para outro "Gravar agora". Chamada pela
 * exclusão da reunião (apagarDerivadosDaReuniao, em server/meeting-service.ts),
 * antes do expurgo do bucket, com a dona no WHERE, e pela junção de reuniões
 * (server/juntar-reunioes.ts), dentro da transação dela: por isso só pede o
 * `update`.
 */
export async function soltarGravacaoDaAgenda(db: Pick<Banco, "update">, ownerId: string, meetingId: string): Promise<void> {
  await db.update(agendaReunioes).set({ meetingId: null, updatedAt: Date.now() })
    .where(and(eq(agendaReunioes.ownerId, ownerId), eq(agendaReunioes.meetingId, meetingId)));
}
