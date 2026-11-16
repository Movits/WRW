import crypto from "crypto";
import { and, asc, eq, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  agendaReunioes, lembretes, meetings, meetingSummaryItems, platformNotifications, proximasAcoes, users,
} from "../drizzle/schema";
import { fusoCanonico } from "@shared/agenda";
import { nomesDosFalantes } from "@shared/const";
import {
  FUSO_PADRAO_DOS_LEMBRETES,
  horarioDoLembreteDaAcao,
  horarioDoLembreteDaAgenda,
  rotaDaProximaAcao,
  type HorarioDoLembrete,
  type ParametrosDaReuniaoPronta,
  type ParametrosDoLembrete,
  type ResumoDaReuniaoPronta,
} from "@shared/lembretes";
import { rotaDaReuniao, rotaGravarDaAgenda } from "@shared/rotas";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";

/**
 * Os lembretes e os avisos do gravador no sino (H15 do plano do gravador,
 * docs/arquitetura/gravador-de-reunioes.md).
 *
 * - **Agendar:** as escritas da próxima ação (H5a, server/proximas-acoes.ts) e
 *   da agenda (H16a, server/agenda-de-reunioes.ts) gravam a hora do lembrete na
 *   mesma transação delas; apagar a origem apaga o lembrete e os avisos dela.
 *   A ação feita não precisa de escrita aqui: o laço confere no disparo.
 * - **Disparar:** o laço reserva os que venceram por token, a cada 60 s, lê a
 *   origem (o texto de agora, com os nomes das vozes) e grava o aviso no sino e
 *   a marca de disparado na mesma transação: ou os dois, ou nenhum.
 * - **Reunião pronta:** a fila do resumo (server/fila-do-resumo.ts) avisa na
 *   transação em que o resumo fica pronto, ou falha de vez.
 * - **Reunião excluída:** os avisos dela saem com ela (deletePrivateMeeting).
 *
 * O aviso não guarda frase de tela: o sino a escreve pelo tipo e pelos
 * parâmetros, no idioma de quem lê (shared/lembretes.ts). Banco fora do ar é
 * erro, nunca "nada a avisar" (server/CLAUDE.md).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
/** O banco ou a transação de quem chama: é ela que decide a atomicidade. */
export type Executor = Pick<Transacao, "select" | "insert" | "update" | "delete">;

export type OrigemDoLembrete = "acao" | "agenda";

/** De quanto em quanto tempo o laço procura lembretes vencidos. */
const INTERVALO_DO_LACO_MS = 60_000;
/** A reserva de uma rodada: vencida, outra rodada (ou outra instância) retoma. */
const DURACAO_DA_RESERVA_MS = 2 * 60_000;
/** Quantos lembretes uma rodada reserva de uma vez. */
export const LEMBRETES_POR_RODADA = 100;
/** O tamanho de platform_notifications.title. */
const TITULO_DO_AVISO_MAX = 200;
/** Os tipos de aviso que este módulo escreve e apaga; os outros não são tocados. */
const TIPOS_DO_GRAVADOR = ["lembrete", "reuniao_pronta"] as const;

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/** O título que fica em platform_notifications.title, cortado por caractere (sem partir um emoji). */
function tituloDoAviso(texto: string): string {
  const caracteres = Array.from(texto.trim());
  return caracteres.length > TITULO_DO_AVISO_MAX ? `${caracteres.slice(0, TITULO_DO_AVISO_MAX - 1).join("")}…` : caracteres.join("");
}

// ── agendar ─────────────────────────────────────────────────────────────────

/**
 * Grava a hora do lembrete de uma origem, na transação de quem a escreve.
 *
 * - Sem hora (sem prazo, sem lembrete), ou com o aviso já sem serventia: o
 *   lembrete sai.
 * - A mesma hora de antes: fica como está, pendente ou já disparado. Editar o
 *   texto não repete o aviso, e o laço que está avisando agora não perde a vez.
 * - Outra hora, ainda por vir: o lembrete volta a pendente, nessa hora.
 * - Outra hora, que já passou: nada a avisar, e o lembrete sai.
 */
async function gravarHorario(
  ex: Executor, ownerId: string, origem: OrigemDoLembrete, origemId: string, horario: HorarioDoLembrete | null, agora: number,
) {
  const [atual] = await ex.select({ id: lembretes.id, dispararEm: lembretes.dispararEm, expiraEm: lembretes.expiraEm })
    .from(lembretes)
    .where(and(eq(lembretes.ownerId, ownerId), eq(lembretes.origem, origem), eq(lembretes.origemId, origemId)))
    .limit(1);
  const doAtual = atual ? and(eq(lembretes.id, atual.id), eq(lembretes.ownerId, ownerId)) : undefined;
  const mesmaHora = !!atual && !!horario && Number(atual.dispararEm) === horario.dispararEm;
  if (!horario || horario.expiraEm <= agora || (horario.dispararEm <= agora && !mesmaHora)) {
    if (doAtual) await ex.delete(lembretes).where(doAtual);
    return;
  }
  if (mesmaHora) {
    if (doAtual && Number(atual.expiraEm) !== horario.expiraEm) {
      await ex.update(lembretes).set({ expiraEm: horario.expiraEm, updatedAt: agora }).where(doAtual);
    }
    return;
  }
  // A reserva de uma rodada em curso cai junto: a marca dela confere o token.
  const pendente = {
    dispararEm: horario.dispararEm, expiraEm: horario.expiraEm, disparadoEm: null, lockToken: null, lockedUntil: null, updatedAt: agora,
  };
  if (doAtual) {
    await ex.update(lembretes).set(pendente).where(doAtual);
    return;
  }
  // Duas escritas da mesma origem ao mesmo tempo: o índice único fica com uma linha.
  await ex.insert(lembretes).values({ id: crypto.randomUUID(), ownerId, origem, origemId, ...pendente, createdAt: agora })
    .onDuplicateKeyUpdate({ set: pendente });
}

/**
 * O lembrete da próxima ação: às 9h do dia do prazo, no fuso do aparelho de
 * quem marcou o prazo (o que o Intl não conhece, ou nenhum, cai no padrão).
 * Prazo nulo tira o lembrete.
 */
export async function agendarLembreteDaAcao(
  ex: Executor, ownerId: string, acaoId: string, prazo: string | null, fuso: string | null | undefined, agora: number = Date.now(),
) {
  const fusoDoLembrete = (fuso ? fusoCanonico(fuso) : null) ?? FUSO_PADRAO_DOS_LEMBRETES;
  await gravarHorario(ex, ownerId, "acao", acaoId, horarioDoLembreteDaAcao(prazo, fusoDoLembrete), agora);
}

/** O lembrete da reunião da agenda: os minutos escolhidos antes do início. Sem lembrete (nulo), sai. */
export async function agendarLembreteDaAgenda(
  ex: Executor, ownerId: string, agendaId: string,
  reuniao: { inicioEm: number; duracaoMinutos: number; lembreteMinutos: number | null },
  agora: number = Date.now(),
) {
  await gravarHorario(ex, ownerId, "agenda", agendaId, horarioDoLembreteDaAgenda(reuniao), agora);
}

/** O endereço do aviso de cada origem: é por ele que o aviso se acha para sair. */
function enderecoDoLembrete(origem: OrigemDoLembrete, origemId: string): string {
  return origem === "acao" ? rotaDaProximaAcao(origemId) : rotaGravarDaAgenda(origemId);
}

/**
 * A origem saiu (a ação apagada, a reunião tirada da agenda): o lembrete dela
 * e os avisos que ela já deu saem junto, na transação de quem apaga.
 */
export async function esquecerLembrete(ex: Executor, ownerId: string, origem: OrigemDoLembrete, origemId: string) {
  await ex.delete(lembretes).where(and(eq(lembretes.ownerId, ownerId), eq(lembretes.origem, origem), eq(lembretes.origemId, origemId)));
  await apagarAvisosDoEndereco(ex, ownerId, enderecoDoLembrete(origem, origemId));
}

// ── os avisos no sino ───────────────────────────────────────────────────────

/** O id da conta (platform_notifications.userId) da dona, que a rede particular chama pelo openId. */
async function contaDaDona(ex: Executor, ownerId: string): Promise<number | null> {
  const [conta] = await ex.select({ id: users.id }).from(users).where(eq(users.openId, ownerId)).limit(1);
  return conta?.id ?? null;
}

/** Os avisos do gravador da dona que levam a um endereço. Os de outros tipos ficam. */
export async function apagarAvisosDoEndereco(ex: Executor, ownerId: string, endereco: string) {
  const contaId = await contaDaDona(ex, ownerId);
  if (contaId === null) return;
  await ex.delete(platformNotifications).where(and(
    eq(platformNotifications.userId, contaId),
    inArray(platformNotifications.type, [...TIPOS_DO_GRAVADOR]),
    eq(platformNotifications.actionUrl, endereco),
  ));
}

/** A reunião excluída leva os avisos dela (o de pronta, com o título): nada dela fica no sino. */
export function apagarAvisosDaReuniao(ex: Executor, ownerId: string, meetingId: string) {
  return apagarAvisosDoEndereco(ex, ownerId, rotaDaReuniao(meetingId));
}

/**
 * O aviso "a reunião ficou pronta": a transcrição terminou e o resumo também
 * (pronto, ou falhou de vez; aí a transcrição está lá, e a tela oferece tentar
 * o resumo de novo). Na transação de quem marca o resumo, com a reunião
 * travada: só a reunião pronta, da dona, de conta ativa. Um aviso por reunião:
 * o de antes (o resumo refeito) sai. Devolve se avisou.
 */
export async function avisarReuniaoPronta(ex: Executor, ownerId: string, meetingId: string, resumo: ResumoDaReuniaoPronta): Promise<boolean> {
  const [reuniao] = await ex.select({ titulo: meetings.title, contaId: users.id }).from(meetings)
    .innerJoin(users, and(eq(users.openId, meetings.ownerId), eq(users.isActive, true)))
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "ready")))
    .limit(1);
  if (!reuniao) return false;
  const endereco = rotaDaReuniao(meetingId);
  await ex.delete(platformNotifications).where(and(
    eq(platformNotifications.userId, reuniao.contaId),
    eq(platformNotifications.type, "reuniao_pronta"),
    eq(platformNotifications.actionUrl, endereco),
  ));
  const parametros: ParametrosDaReuniaoPronta = { titulo: reuniao.titulo, resumo };
  await ex.insert(platformNotifications).values({
    userId: reuniao.contaId, type: "reuniao_pronta", title: tituloDoAviso(reuniao.titulo), body: null,
    actionUrl: endereco, parametros, isRead: false,
  });
  return true;
}

// ── o laço ──────────────────────────────────────────────────────────────────

type Reservado = {
  id: string;
  ownerId: string;
  origem: OrigemDoLembrete;
  origemId: string;
  dispararEm: number;
  expiraEm: number;
  contaId: number | null;
  contaAtiva: boolean | null;
};

type Conteudo =
  | { tipo: "avisar"; titulo: string; endereco: string; parametros: ParametrosDoLembrete }
  /** A origem não existe mais (ou tirou o lembrete): o lembrete sai. */
  | { tipo: "sumiu" }
  /** A origem existe e não pede aviso agora (a ação foi feita): marca sem avisar. */
  | { tipo: "sem_aviso" }
  /** A hora da origem não é a do lembrete: ele volta a esperar a hora certa. */
  | { tipo: "outra_hora"; horario: HorarioDoLembrete };

/**
 * A próxima ação, lida no disparo. Os rótulos de voz se resolvem aqui (regra 2
 * do plano): presa ao item da reunião viva, os nomes vêm da reunião; a voz sem
 * nome fica rótulo, e o sino mostra "Falante n" no idioma de quem lê. Solta, os
 * nomes já estão no texto (soltarAcoesDaReuniao).
 */
async function conteudoDaAcao(db: Banco, lembrete: Reservado): Promise<Conteudo> {
  const [acao] = await db.select({
    texto: proximasAcoes.texto,
    prazo: proximasAcoes.prazo,
    feita: proximasAcoes.feita,
    reuniaoViva: meetings.id,
    vozes: meetings.speakerNames,
    itemVivo: meetingSummaryItems.id,
  }).from(proximasAcoes)
    .leftJoin(meetings, and(eq(meetings.id, proximasAcoes.meetingId), eq(meetings.ownerId, proximasAcoes.ownerId), ne(meetings.status, "deleted")))
    .leftJoin(meetingSummaryItems, and(eq(meetingSummaryItems.id, proximasAcoes.itemId), eq(meetingSummaryItems.ownerId, proximasAcoes.ownerId)))
    .where(and(eq(proximasAcoes.id, lembrete.origemId), eq(proximasAcoes.ownerId, lembrete.ownerId)))
    .limit(1);
  if (!acao) return { tipo: "sumiu" };
  if (acao.feita || !acao.prazo) return { tipo: "sem_aviso" };
  const presaAoItem = acao.reuniaoViva !== null && acao.itemVivo !== null;
  const texto = presaAoItem ? vozesNoTexto(acao.texto, nomesDosFalantes(acao.vozes), numero => `{F${numero}}`) : acao.texto;
  return {
    tipo: "avisar", titulo: texto, endereco: rotaDaProximaAcao(lembrete.origemId),
    parametros: { origem: "acao", texto, prazo: acao.prazo },
  };
}

/** A reunião da agenda, lida no disparo: o título, a hora e o fuso de agora. */
async function conteudoDaAgenda(db: Banco, lembrete: Reservado): Promise<Conteudo> {
  const [reuniao] = await db.select({
    titulo: agendaReunioes.titulo,
    inicioEm: agendaReunioes.inicioEm,
    duracaoMinutos: agendaReunioes.duracaoMinutos,
    fuso: agendaReunioes.fuso,
    lembreteMinutos: agendaReunioes.lembreteMinutos,
  }).from(agendaReunioes)
    .where(and(eq(agendaReunioes.id, lembrete.origemId), eq(agendaReunioes.ownerId, lembrete.ownerId)))
    .limit(1);
  if (!reuniao) return { tipo: "sumiu" };
  const inicioEm = Number(reuniao.inicioEm);
  const horario = horarioDoLembreteDaAgenda({ inicioEm, duracaoMinutos: reuniao.duracaoMinutos, lembreteMinutos: reuniao.lembreteMinutos });
  if (!horario) return { tipo: "sumiu" };
  if (horario.dispararEm !== Number(lembrete.dispararEm)) return { tipo: "outra_hora", horario };
  return {
    tipo: "avisar", titulo: reuniao.titulo, endereco: rotaGravarDaAgenda(lembrete.origemId),
    parametros: { origem: "agenda", titulo: reuniao.titulo, inicioEm, fuso: reuniao.fuso },
  };
}

/** Um lembrete reservado por esta rodada. Devolve se o aviso saiu. */
async function dispararUm(db: Banco, lembrete: Reservado, token: string, agora: number): Promise<boolean> {
  const daReserva = and(eq(lembretes.id, lembrete.id), eq(lembretes.lockToken, token));
  const marcarSemAviso = async () => {
    await db.update(lembretes).set({ disparadoEm: agora, lockToken: null, lockedUntil: null, updatedAt: agora }).where(daReserva);
    return false;
  };
  const contaId = lembrete.contaId;
  // A conta saiu ou foi desativada, ou o aviso já não serve (o dia do prazo
  // passou, a reunião acabou: um deploy longo no meio): marca, sem avisar.
  if (contaId === null || !lembrete.contaAtiva || agora >= Number(lembrete.expiraEm)) return marcarSemAviso();
  const conteudo = lembrete.origem === "acao" ? await conteudoDaAcao(db, lembrete) : await conteudoDaAgenda(db, lembrete);
  if (conteudo.tipo === "sumiu") {
    await db.delete(lembretes).where(daReserva);
    return false;
  }
  if (conteudo.tipo === "sem_aviso") return marcarSemAviso();
  if (conteudo.tipo === "outra_hora") {
    await db.update(lembretes).set({
      dispararEm: conteudo.horario.dispararEm, expiraEm: conteudo.horario.expiraEm, lockToken: null, lockedUntil: null, updatedAt: agora,
    }).where(daReserva);
    return false;
  }
  // A marca e o aviso, juntos. A marca confere a reserva: reagendar ou apagar
  // no meio tirou o token, e aí nada sai.
  return db.transaction(async tx => {
    const marcado = await tx.update(lembretes).set({ disparadoEm: agora, lockToken: null, lockedUntil: null, updatedAt: agora })
      .where(and(daReserva, isNull(lembretes.disparadoEm)));
    if (!linhasAfetadas(marcado)) return false;
    await tx.insert(platformNotifications).values({
      userId: contaId, type: "lembrete", title: tituloDoAviso(conteudo.titulo), body: null,
      actionUrl: conteudo.endereco, parametros: conteudo.parametros, isRead: false,
    });
    return true;
  });
}

// Os tokens das rodadas desta instância: o SIGTERM devolve exatamente estes.
const tokensVivos = new Set<string>();
let parado = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Uma rodada: reserva os lembretes vencidos (até LEMBRETES_POR_RODADA, os mais
 * antigos primeiro) e dispara um por um. A falha de um vai ao log e não segura
 * os outros: a reserva dele vence, e outra rodada tenta de novo. Exportada para
 * os testes (com `agora` e a dona); em produção é o laço de iniciarLembretes.
 */
export async function rodarLembretesUmaVez(escopo: { ownerId?: string } = {}, agora: number = Date.now()): Promise<{ avisos: number }> {
  if (parado) return { avisos: 0 };
  const db = await exigirDb();
  const token = crypto.randomUUID();
  tokensVivos.add(token);
  try {
    const reservou = await db.update(lembretes).set({ lockToken: token, lockedUntil: agora + DURACAO_DA_RESERVA_MS })
      .where(and(
        isNull(lembretes.disparadoEm),
        lte(lembretes.dispararEm, agora),
        or(isNull(lembretes.lockedUntil), lt(lembretes.lockedUntil, agora)),
        escopo.ownerId ? eq(lembretes.ownerId, escopo.ownerId) : undefined,
      ))
      .orderBy(asc(lembretes.dispararEm))
      .limit(LEMBRETES_POR_RODADA);
    if (!linhasAfetadas(reservou)) return { avisos: 0 };
    const reservados = await db.select({
      id: lembretes.id, ownerId: lembretes.ownerId, origem: lembretes.origem, origemId: lembretes.origemId,
      dispararEm: lembretes.dispararEm, expiraEm: lembretes.expiraEm, contaId: users.id, contaAtiva: users.isActive,
    }).from(lembretes)
      .leftJoin(users, eq(users.openId, lembretes.ownerId))
      .where(eq(lembretes.lockToken, token));
    let avisos = 0;
    for (const lembrete of reservados) {
      // O desligamento devolve as reservas: o resto fica para o próximo processo.
      if (parado) break;
      try {
        if (await dispararUm(db, lembrete, token, agora)) avisos += 1;
      } catch (erro) {
        console.error("[Lembretes] o lembrete não foi disparado; a reserva vence e outra rodada tenta de novo:", descreverErroDeBanco(erro));
      }
    }
    return { avisos };
  } finally {
    tokensVivos.delete(token);
  }
}

/** Liga o laço dos lembretes (no boot do servidor, com banco). */
export function iniciarLembretes(intervaloMs = INTERVALO_DO_LACO_MS) {
  parado = false;
  const proxima = () => {
    if (parado) return;
    timer = setTimeout(() => {
      // Uma rodada por vez, e ela nunca rejeita solta (derrubaria o processo).
      rodarLembretesUmaVez()
        .catch(erro => console.error("[Lembretes] a rodada falhou:", descreverErroDeBanco(erro)))
        .finally(proxima);
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/**
 * Desligamento (SIGTERM do Render, SIGINT no dev): para de reservar e devolve
 * as reservas desta instância, para o próximo processo avisar na hora (e não
 * depois de a reserva vencer).
 */
export async function pararLembretes(): Promise<{ lembretes: number }> {
  parado = true;
  clearTimeout(timer);
  const tokens = Array.from(tokensVivos);
  if (!tokens.length) return { lembretes: 0 };
  let db: Banco;
  try {
    db = await exigirDb();
  } catch (erro) {
    console.error("[Lembretes] sem banco no desligamento; as reservas vencem sozinhas:", descreverErroDeBanco(erro));
    return { lembretes: 0 };
  }
  const devolvidos = await db.update(lembretes).set({ lockToken: null, lockedUntil: null })
    .where(and(inArray(lembretes.lockToken, tokens), isNull(lembretes.disparadoEm)));
  tokensVivos.clear();
  return { lembretes: linhasAfetadas(devolvidos) };
}

/** Só para os testes: o laço volta a aceitar rodadas. */
export function religarLembretesParaTestes() {
  parado = false;
}

export const _paraTestes = { tokensVivos };
