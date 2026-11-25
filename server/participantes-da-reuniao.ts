import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { auditLogs, connections, meetingParticipants, meetings, userProfiles, users } from "../drizzle/schema";
import { CONTA_DA_DONA, contasDasVozes, NOME_DO_FALANTE_MAX } from "@shared/const";
import {
  CONVITE_DA_REUNIAO_VALE_MS, CONVITES_POR_JANELA, FORMATO_DO_CONVITE, JANELA_DOS_CONVITES_MS,
  PARTICIPANTES_POR_REUNIAO_MAX, RECUSAS_DOS_PARTICIPANTES,
} from "@shared/participantes-da-reuniao";
import { criarTeto } from "./assistente-de-texto";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * As participantes da reunião (R1b do desenho de 16/11/2026, decisão do
 * Roberto de 22/11). A dona convida por um link de uso único ou uma das
 * conexões aceitas dela; quem aceita passa a ler a reunião na própria conta
 * (resumo, transcrição, gravação e o Pergunte), sem mudar nada. A leitura em
 * si passa pelas consultas do link aberto, com a credencial da participante
 * (server/link-aberto-da-reuniao.ts, reuniaoDaParticipante, abaixo).
 *
 * Regras que valem em todo o módulo:
 * - o que muda é da dona: a dona no WHERE, a reunião visível (reuniaoVisivel:
 *   nem excluída, nem na lixeira) e a linha travada na transação;
 * - ninguém vê o nome de ninguém sem o próprio aceite: o convite por link não
 *   tem nome até ser aceito, e a participante vê só as que aceitaram;
 * - não há convite por e-mail digitado: revelaria quem é membro, e o e-mail das
 *   contas não é verificado;
 * - a prova da confirmação da dona (as pessoas que falaram autorizaram) vai na
 *   transação do convite, por tx.insert(auditLogs); os outros registros (o
 *   convite, a entrada, a saída e a remoção) vão também na transação, para
 *   "quem deu acesso à minha reunião?" ter resposta.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type BancoOuTransacao = Banco | Transacao;

/** Quem pediu, para a auditoria. */
export type ProvaDaPessoa = { userId: number; ipAddress: string; userAgent: string | null | undefined };
/** A confirmação da dona de que as pessoas que falaram autorizaram compartilhar com as participantes. */
export type AutorizacaoDasPessoas = { idioma: string; textoExibido: string };
/** A conta que pede (a dona ou a participante). */
export type Conta = { id: number; openId: string };

export const ACAO_PARTICIPANTES_AUTORIZADAS = "MEETING_PARTICIPANTS_AUTHORIZED";
export const ACAO_CONVITE_CRIADO = "MEETING_PARTICIPANT_INVITED";
export const ACAO_CONVITE_CANCELADO = "MEETING_PARTICIPANT_INVITE_CANCELED";
export const ACAO_PARTICIPANTE_ENTROU = "MEETING_PARTICIPANT_JOINED";
export const ACAO_CONVITE_RECUSADO = "MEETING_PARTICIPANT_DECLINED";
export const ACAO_PARTICIPANTE_REMOVIDA = "MEETING_PARTICIPANT_REMOVED";
export const ACAO_PARTICIPANTE_SAIU = "MEETING_PARTICIPANT_LEFT";

/**
 * O teto dos convites da dona, em memória como os outros (zera a cada deploy).
 * Criado no primeiro uso: este módulo entra no ciclo de importação do
 * meeting-service (pelas vozes, H3c), e o criarTeto ainda não existe quando
 * ele é carregado.
 */
let teto: ReturnType<typeof criarTeto> | null = null;
export function tetoDosConvites() {
  teto ??= criarTeto(CONVITES_POR_JANELA, JANELA_DOS_CONVITES_MS, RECUSAS_DOS_PARTICIPANTES.muitosConvites);
  return teto;
}

const recusa = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });
const reuniaoNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DOS_PARTICIPANTES.reuniaoNaoEncontrada);
const conviteInvalido = () => recusa("NOT_FOUND", RECUSAS_DOS_PARTICIPANTES.conviteInvalido);
const participanteNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DOS_PARTICIPANTES.participanteNaoEncontrada);

/** O hash do token do convite: só ele fica no banco. */
export function hashDoConvite(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Um token novo de convite: 24 bytes aleatórios (192 bits), 32 caracteres em base64url. */
export function gerarTokenDoConvite(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function linhasAfetadas(resultado: unknown) {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | null | undefined)?.affectedRows ?? 0;
}

/** Chave duplicada (ER_DUP_ENTRY) em qualquer ponto da cadeia de `cause` (o drizzle embrulha o erro do driver). */
function ehChaveDuplicada(erro: unknown) {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

/** Deadlock do InnoDB (ER_LOCK_DEADLOCK) em qualquer ponto da cadeia de `cause`. */
function ehDeadlock(erro: unknown) {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_LOCK_DEADLOCK" || errno === 1213) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Roda a transação de novo quando o InnoDB a escolhe como vítima de um
 * deadlock (dois aceites do mesmo convite ao mesmo tempo travam as mesmas
 * linhas em ordens diferentes). A transação vítima foi desfeita inteira, e a
 * nova leitura decide: o convite que a outra usou já não abre, e a perdedora
 * recebe o código traduzido, não o erro cru do banco. Até 3 tentativas.
 */
export async function comNovaTentativaNoDeadlock<T>(trabalho: () => Promise<T>, tentativas = 3): Promise<T> {
  for (let vez = 1; ; vez += 1) {
    try {
      return await trabalho();
    } catch (erro) {
      if (vez >= tentativas || !ehDeadlock(erro)) throw erro;
    }
  }
}

// Os mesmos cortes do createAuditLog (server/security.ts).
function linhaDeAuditoria(prova: ProvaDaPessoa, action: string, meetingId: string, details: Record<string, unknown>, riskLevel: "low" | "medium" = "low") {
  return {
    userId: prova.userId,
    ipAddress: prova.ipAddress.substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
    action,
    resource: "meetings",
    resourceId: meetingId,
    details,
    status: "success" as const,
    riskLevel,
  };
}

/**
 * O nome que a conta mostra às outras: o nome do perfil ou, sem ele, o nome
 * da conta, cortado como o nome de uma voz (60 caracteres). Nunca o e-mail.
 */
export function nomeDaConta(displayName: string | null | undefined, nome: string | null | undefined): string {
  const escolhido = displayName?.trim() || nome?.trim() || "";
  return escolhido.slice(0, NOME_DO_FALANTE_MAX);
}

/** A reunião da dona que recebe participantes, com a linha travada: visível e pronta. */
async function reuniaoDaDonaTravada(tx: Transacao, ownerId: string, meetingId: string) {
  const [reuniao] = await tx.select({ id: meetings.id, status: meetings.status, title: meetings.title }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel()))
    .limit(1).for("update");
  if (!reuniao) throw reuniaoNaoEncontrada();
  if (reuniao.status !== "ready") throw recusa("PRECONDITION_FAILED", RECUSAS_DOS_PARTICIPANTES.soReuniaoPronta);
  return reuniao;
}

/**
 * Os convites vencidos da reunião saem quando a dona abre o painel ou cria
 * outro convite (limpeza preguiçosa: o hash não identifica ninguém, e assim
 * não entra job novo no boot). O convite vencido nunca abre, saia ou não.
 */
async function limparConvitesVencidos(ex: BancoOuTransacao, ownerId: string, meetingId: string, agora: number) {
  await ex.delete(meetingParticipants).where(and(
    eq(meetingParticipants.ownerId, ownerId), eq(meetingParticipants.meetingId, meetingId),
    eq(meetingParticipants.status, "invited"), lt(meetingParticipants.expiresAt, agora),
  ));
}

/** A dona já confirmou, nesta reunião, que as pessoas que falaram autorizaram compartilhar com as participantes? */
async function jaAutorizou(ex: BancoOuTransacao, donaId: number, meetingId: string): Promise<boolean> {
  const [linha] = await ex.select({ id: auditLogs.id }).from(auditLogs)
    .where(and(eq(auditLogs.action, ACAO_PARTICIPANTES_AUTORIZADAS), eq(auditLogs.resource, "meetings"), eq(auditLogs.resourceId, meetingId), eq(auditLogs.userId, donaId)))
    .limit(1);
  return !!linha;
}

/**
 * A confirmação da dona, uma vez por reunião (P8 do desenho, decisão vetável:
 * vale para TODA reunião até o aviso de gravação novo, com o texto da Cris,
 * dizer que as participantes ouvem). A prova (a frase que ela viu, o idioma e
 * o hash) vai na transação do convite, como a do link aberto.
 */
async function exigirAutorizacao(tx: Transacao, prova: ProvaDaPessoa, meetingId: string, autorizacao: AutorizacaoDasPessoas | undefined) {
  if (await jaAutorizou(tx, prova.userId, meetingId)) return;
  if (!autorizacao) throw recusa("PRECONDITION_FAILED", RECUSAS_DOS_PARTICIPANTES.autorizacaoPedida);
  await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_PARTICIPANTES_AUTORIZADAS, meetingId, {
    autorizacaoDasPessoas: true,
    idioma: autorizacao.idioma,
    textoExibido: autorizacao.textoExibido,
    textoHash: crypto.createHash("sha256").update(autorizacao.textoExibido).digest("hex"),
  }, "medium"));
}

async function exigirVaga(tx: Transacao, ownerId: string, meetingId: string) {
  const [contagem] = await tx.select({ quantas: sql<number>`count(*)` }).from(meetingParticipants)
    .where(and(eq(meetingParticipants.ownerId, ownerId), eq(meetingParticipants.meetingId, meetingId)));
  if (Number(contagem?.quantas ?? 0) >= PARTICIPANTES_POR_REUNIAO_MAX) throw recusa("PRECONDITION_FAILED", RECUSAS_DOS_PARTICIPANTES.reuniaoCheia);
}

/**
 * Um convite por link de uso único: devolve o token (só nesta resposta; o
 * banco guarda o hash) e quando ele vence. Gasta uma vaga do teto da dona
 * antes de abrir a transação; a recusa e a falha a devolvem.
 */
export async function criarConvite(ownerId: string, meetingId: string, prova: ProvaDaPessoa, autorizacao?: AutorizacaoDasPessoas): Promise<{ token: string; expiraEm: number }> {
  const soltarVaga = tetoDosConvites().reservar(ownerId);
  try {
    const db = await exigirDb();
    const token = gerarTokenDoConvite();
    const agora = Date.now();
    const expiraEm = agora + CONVITE_DA_REUNIAO_VALE_MS;
    await db.transaction(async tx => {
      await reuniaoDaDonaTravada(tx, ownerId, meetingId);
      await limparConvitesVencidos(tx, ownerId, meetingId, agora);
      await exigirVaga(tx, ownerId, meetingId);
      await exigirAutorizacao(tx, prova, meetingId, autorizacao);
      const id = crypto.randomUUID();
      await tx.insert(meetingParticipants).values({
        id, meetingId, ownerId, userId: null, status: "invited", source: "link", inviteTokenHash: hashDoConvite(token),
        invitedAt: agora, expiresAt: expiraEm, acceptedAt: null, createdAt: agora, updatedAt: agora,
      });
      await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_CONVITE_CRIADO, meetingId, { participanteId: id, origem: "link" }));
    });
    return { token, expiraEm };
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

/**
 * Convida uma conexão ACEITA da dona (os nomes já foram revelados nos dois
 * sentidos, getConnectionsForUser): o convite aparece na conta da convidada,
 * que aceita ou recusa. A conexão que não é dela, que não está aceita ou cuja
 * conta foi desativada é recusada com o mesmo código, sem dizer qual.
 */
export async function convidarConexao(dona: Conta, meetingId: string, conexaoId: number, prova: ProvaDaPessoa, autorizacao?: AutorizacaoDasPessoas): Promise<{ participanteId: string }> {
  const soltarVaga = tetoDosConvites().reservar(dona.openId);
  try {
    const db = await exigirDb();
    const agora = Date.now();
    const participanteId = crypto.randomUUID();
    await db.transaction(async tx => {
      await reuniaoDaDonaTravada(tx, dona.openId, meetingId);
      const [conexao] = await tx.select({ requesterId: connections.requesterId, recipientId: connections.recipientId }).from(connections)
        .where(and(eq(connections.id, conexaoId), eq(connections.status, "accepted"), or(eq(connections.requesterId, dona.id), eq(connections.recipientId, dona.id))))
        .limit(1);
      const outraId = conexao ? (conexao.requesterId === dona.id ? conexao.recipientId : conexao.requesterId) : null;
      const [outra] = outraId && outraId !== dona.id
        ? await tx.select({ id: users.id }).from(users).where(and(eq(users.id, outraId), eq(users.isActive, true))).limit(1)
        : [];
      if (!outra) throw recusa("BAD_REQUEST", RECUSAS_DOS_PARTICIPANTES.conexaoInvalida);
      await limparConvitesVencidos(tx, dona.openId, meetingId, agora);
      const [ja] = await tx.select({ id: meetingParticipants.id }).from(meetingParticipants)
        .where(and(eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.userId, outra.id))).limit(1);
      if (ja) throw recusa("CONFLICT", RECUSAS_DOS_PARTICIPANTES.jaParticipa);
      await exigirVaga(tx, dona.openId, meetingId);
      await exigirAutorizacao(tx, prova, meetingId, autorizacao);
      try {
        await tx.insert(meetingParticipants).values({
          id: participanteId, meetingId, ownerId: dona.openId, userId: outra.id, status: "invited", source: "connection", inviteTokenHash: null,
          invitedAt: agora, expiresAt: agora + CONVITE_DA_REUNIAO_VALE_MS, acceptedAt: null, createdAt: agora, updatedAt: agora,
        });
      } catch (erro) {
        // Dois convites à mesma conexão ao mesmo tempo: o índice único decide.
        if (ehChaveDuplicada(erro)) throw recusa("CONFLICT", RECUSAS_DOS_PARTICIPANTES.jaParticipa);
        throw erro;
      }
      await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_CONVITE_CRIADO, meetingId, { participanteId, origem: "connection" }));
    });
    return { participanteId };
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

/**
 * Tira a voz ligada à participação que saiu (H3c), na mesma transação: a
 * participante removida ou que saiu some das vozes. A leitura já ignora a
 * referência sem participação ativa; isto só não deixa a referência guardada.
 */
async function soltarVozesDaParticipacao(tx: Transacao, ownerId: string, meetingId: string, participanteId: string) {
  const [reuniao] = await tx.select({ speakerAccounts: meetings.speakerAccounts }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1).for("update");
  if (!reuniao) return;
  const contas = contasDasVozes(reuniao.speakerAccounts);
  const ficam = Object.fromEntries(Object.entries(contas).filter(([, conta]) => conta !== participanteId));
  if (Object.keys(ficam).length === Object.keys(contas).length) return;
  await tx.update(meetings).set({ speakerAccounts: Object.keys(ficam).length ? ficam : null })
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
}

/**
 * A dona tira uma participante (ativa ou com o convite pendente): o acesso
 * acaba na hora, e as vozes dela voltam ao nome livre ou a "Falante n".
 * `soConvite`: o "Cancelar convite", que só tira o convite ainda não aceito.
 */
export async function removerParticipante(ownerId: string, participanteId: string, prova: ProvaDaPessoa, opcoes: { soConvite?: boolean } = {}): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [linha] = await tx.select({ id: meetingParticipants.id, meetingId: meetingParticipants.meetingId, status: meetingParticipants.status })
      .from(meetingParticipants)
      .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
      .where(and(eq(meetingParticipants.id, participanteId), eq(meetingParticipants.ownerId, ownerId), reuniaoVisivel()))
      .limit(1).for("update");
    if (!linha || (opcoes.soConvite && linha.status !== "invited")) throw participanteNaoEncontrada();
    await tx.delete(meetingParticipants).where(and(eq(meetingParticipants.id, linha.id), eq(meetingParticipants.ownerId, ownerId)));
    await soltarVozesDaParticipacao(tx, ownerId, linha.meetingId, linha.id);
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, linha.status === "invited" ? ACAO_CONVITE_CANCELADO : ACAO_PARTICIPANTE_REMOVIDA, linha.meetingId, { participanteId: linha.id }));
  });
}

/** O convite por link pelo token: a linha pendente, a reunião visível e pronta, e a conta da dona ativa. */
async function conviteDoToken(ex: BancoOuTransacao, token: string, agora: number, travar: boolean) {
  if (!FORMATO_DO_CONVITE.test(token)) return null;
  const consulta = ex.select({
    id: meetingParticipants.id, meetingId: meetingParticipants.meetingId, ownerId: meetingParticipants.ownerId,
    expiresAt: meetingParticipants.expiresAt, titulo: meetings.title, donaId: users.id,
    donaNome: users.name, donaDisplayName: userProfiles.displayName,
  }).from(meetingParticipants)
    .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
    .innerJoin(users, eq(users.openId, meetingParticipants.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(
      eq(meetingParticipants.inviteTokenHash, hashDoConvite(token)), eq(meetingParticipants.status, "invited"), eq(meetingParticipants.source, "link"),
      reuniaoVisivel(), eq(meetings.status, "ready"), eq(users.isActive, true),
    ))
    .limit(1);
  const [linha] = travar ? await consulta.for("update") : await consulta;
  if (!linha || linha.expiresAt === null || linha.expiresAt <= agora) return null;
  return linha;
}

/**
 * O que a página do convite mostra a quem o abriu (logada): o título, o nome
 * da dona e o aviso. O convite que não existe, venceu ou já foi usado responde
 * igual (`valido: false`), sem título nem nome. `propria`: a dona abriu o
 * próprio convite; `jaParticipa`: a conta já está na reunião.
 */
export async function verConvite(token: string, conta: Conta): Promise<
  { valido: false } | { valido: true; meetingId: string; titulo: string; nomeDaDona: string; propria: boolean; jaParticipa: boolean; expiraEm: number }
> {
  const db = await exigirDb();
  const convite = await conviteDoToken(db, token, Date.now(), false);
  if (!convite) return { valido: false };
  const propria = convite.ownerId === conta.openId;
  const [ja] = propria ? [] : await db.select({ id: meetingParticipants.id }).from(meetingParticipants)
    .where(and(eq(meetingParticipants.meetingId, convite.meetingId), eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "active"))).limit(1);
  return {
    valido: true, meetingId: convite.meetingId, titulo: convite.titulo, nomeDaDona: nomeDaConta(convite.donaDisplayName, convite.donaNome),
    propria, jaParticipa: !!ja, expiraEm: Number(convite.expiresAt),
  };
}

/**
 * Aceita o convite por link: um UPDATE condicional sobre o hash ainda válido
 * preenche o userId, apaga o hash e ativa a participação. De dois aceites ao
 * mesmo tempo, só um vence (a linha travada, e o hash no WHERE). A dona que
 * abre o próprio convite é recusada. A conta que já participa entra direto, e
 * o convite fica para outra pessoa; a que tinha um convite de conexão pendente
 * nesta reunião o vê aceito, e o link também fica.
 */
export async function aceitarConvite(token: string, conta: Conta, prova: ProvaDaPessoa): Promise<{ meetingId: string }> {
  const db = await exigirDb();
  const agora = Date.now();
  return comNovaTentativaNoDeadlock(() => db.transaction(async tx => {
    const convite = await conviteDoToken(tx, token, agora, true);
    if (!convite) throw conviteInvalido();
    if (convite.ownerId === conta.openId) throw recusa("BAD_REQUEST", RECUSAS_DOS_PARTICIPANTES.conviteDaPropriaDona);
    const [existente] = await tx.select({ id: meetingParticipants.id, status: meetingParticipants.status }).from(meetingParticipants)
      .where(and(eq(meetingParticipants.meetingId, convite.meetingId), eq(meetingParticipants.userId, conta.id))).limit(1).for("update");
    if (existente) {
      if (existente.status === "invited") {
        await tx.update(meetingParticipants).set({ status: "active", expiresAt: null, acceptedAt: agora, updatedAt: agora })
          .where(and(eq(meetingParticipants.id, existente.id), eq(meetingParticipants.status, "invited")));
        await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_PARTICIPANTE_ENTROU, convite.meetingId, { participanteId: existente.id, origem: "connection" }));
      }
      return { meetingId: convite.meetingId };
    }
    const resultado = await tx.update(meetingParticipants).set({
      userId: conta.id, status: "active", inviteTokenHash: null, expiresAt: null, acceptedAt: agora, updatedAt: agora,
    }).where(and(
      eq(meetingParticipants.id, convite.id), eq(meetingParticipants.inviteTokenHash, hashDoConvite(token)), eq(meetingParticipants.status, "invited"),
    ));
    if (!linhasAfetadas(resultado)) throw conviteInvalido();
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_PARTICIPANTE_ENTROU, convite.meetingId, { participanteId: convite.id, origem: "link" }));
    return { meetingId: convite.meetingId };
  }));
}

/** A convidada aceita ou recusa o convite de conexão que está na conta dela. */
export async function responderConviteDeConexao(conta: Conta, participanteId: string, aceitar: boolean, prova: ProvaDaPessoa): Promise<{ meetingId: string }> {
  const db = await exigirDb();
  const agora = Date.now();
  return db.transaction(async tx => {
    const [linha] = await tx.select({ id: meetingParticipants.id, meetingId: meetingParticipants.meetingId, expiresAt: meetingParticipants.expiresAt })
      .from(meetingParticipants)
      .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
      .innerJoin(users, eq(users.openId, meetingParticipants.ownerId))
      .where(and(
        eq(meetingParticipants.id, participanteId), eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "invited"),
        reuniaoVisivel(), eq(meetings.status, "ready"), eq(users.isActive, true),
      )).limit(1).for("update");
    if (!linha || linha.expiresAt === null || linha.expiresAt <= agora) throw conviteInvalido();
    if (aceitar) {
      await tx.update(meetingParticipants).set({ status: "active", expiresAt: null, acceptedAt: agora, updatedAt: agora })
        .where(and(eq(meetingParticipants.id, linha.id), eq(meetingParticipants.status, "invited")));
    } else {
      await tx.delete(meetingParticipants).where(and(eq(meetingParticipants.id, linha.id), eq(meetingParticipants.userId, conta.id)));
    }
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, aceitar ? ACAO_PARTICIPANTE_ENTROU : ACAO_CONVITE_RECUSADO, linha.meetingId, { participanteId: linha.id, origem: "connection" }));
    return { meetingId: linha.meetingId };
  });
}

/** A participante sai da reunião: o acesso acaba, e o nome dela sai das vozes (H3c). */
export async function sairDaReuniao(conta: Conta, meetingId: string, prova: ProvaDaPessoa): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    // A reunião na lixeira (H7d) está fora de vista também aqui: a participante nem a vê.
    const [linha] = await tx.select({ id: meetingParticipants.id, ownerId: meetingParticipants.ownerId }).from(meetingParticipants)
      .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
      .where(and(eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "active"), reuniaoVisivel()))
      .limit(1).for("update");
    if (!linha) throw participanteNaoEncontrada();
    await tx.delete(meetingParticipants).where(and(eq(meetingParticipants.id, linha.id), eq(meetingParticipants.userId, conta.id)));
    await soltarVozesDaParticipacao(tx, linha.ownerId, meetingId, linha.id);
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_PARTICIPANTE_SAIU, meetingId, { participanteId: linha.id }));
  });
}

/**
 * As reuniões compartilhadas com a conta (ativa) e os convites de conexão
 * pendentes, com o título, a data e o nome da dona. Só as reuniões visíveis,
 * prontas e de dona ativa: a da lixeira some e volta com o restaurar.
 */
export async function compartilhadasComigo(conta: Conta) {
  const db = await exigirDb();
  const agora = Date.now();
  const linhas = await db.select({
    participanteId: meetingParticipants.id, meetingId: meetingParticipants.meetingId, status: meetingParticipants.status,
    expiresAt: meetingParticipants.expiresAt, titulo: meetings.title, criadaEm: meetings.createdAt,
    donaNome: users.name, donaDisplayName: userProfiles.displayName,
  }).from(meetingParticipants)
    .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
    .innerJoin(users, eq(users.openId, meetingParticipants.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(eq(meetingParticipants.userId, conta.id), reuniaoVisivel(), eq(meetings.status, "ready"), eq(users.isActive, true)))
    .orderBy(asc(meetings.createdAt))
    .limit(500);
  const saida = (linha: (typeof linhas)[number]) => ({
    meetingId: linha.meetingId, titulo: linha.titulo, criadaEm: Number(linha.criadaEm), nomeDaDona: nomeDaConta(linha.donaDisplayName, linha.donaNome),
  });
  return {
    reunioes: linhas.filter(linha => linha.status === "active").map(saida).reverse(),
    convites: linhas.filter(linha => linha.status === "invited" && linha.expiresAt !== null && linha.expiresAt > agora)
      .map(linha => ({ ...saida(linha), participanteId: linha.participanteId, expiraEm: Number(linha.expiresAt) })).reverse(),
  };
}

/**
 * As participantes de uma reunião, para quem pode vê-las:
 * - a dona: todas, com os convites pendentes (o convite por link, sem nome
 *   até ser aceito; o de conexão, com o nome que ela já via), e se já deu a
 *   confirmação desta reunião;
 * - a participante ativa: só os nomes das que aceitaram e o da dona, sem ids.
 * Quem não é nenhuma das duas leva NOT_FOUND, como a reunião de outra conta.
 */
export async function participantesDaReuniao(conta: Conta, meetingId: string) {
  const db = await exigirDb();
  const agora = Date.now();
  const [reuniao] = await db.select({ ownerId: meetings.ownerId, status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), reuniaoVisivel())).limit(1);
  if (!reuniao) throw reuniaoNaoEncontrada();
  const ehDona = reuniao.ownerId === conta.openId;
  if (ehDona) await limparConvitesVencidos(db, conta.openId, meetingId, agora);
  const linhas = await db.select({
    id: meetingParticipants.id, userId: meetingParticipants.userId, status: meetingParticipants.status, source: meetingParticipants.source,
    expiresAt: meetingParticipants.expiresAt, acceptedAt: meetingParticipants.acceptedAt, invitedAt: meetingParticipants.invitedAt,
    nome: users.name, displayName: userProfiles.displayName, ativa: users.isActive,
  }).from(meetingParticipants)
    .leftJoin(users, eq(users.id, meetingParticipants.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, meetingParticipants.userId))
    .where(and(eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.ownerId, reuniao.ownerId)))
    .orderBy(asc(meetingParticipants.invitedAt))
    .limit(PARTICIPANTES_POR_REUNIAO_MAX + 10);
  if (ehDona) {
    return {
      papel: "dona" as const,
      autorizado: await jaAutorizou(db, conta.id, meetingId),
      participantes: linhas.map(linha => ({
        id: linha.id, status: linha.status, origem: linha.source,
        // O convite por link não tem nome até ser aceito; a conta desativada não mostra nome.
        nome: linha.userId !== null && linha.ativa ? nomeDaConta(linha.displayName, linha.nome) : null,
        expiraEm: linha.status === "invited" ? Number(linha.expiresAt) : null,
        entrouEm: linha.acceptedAt === null ? null : Number(linha.acceptedAt),
      })),
    };
  }
  const minha = linhas.find(linha => linha.userId === conta.id && linha.status === "active");
  if (!minha || reuniao.status !== "ready") throw reuniaoNaoEncontrada();
  const [dona] = await db.select({ nome: users.name, displayName: userProfiles.displayName, ativa: users.isActive }).from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.openId, reuniao.ownerId)).limit(1);
  if (!dona?.ativa) throw reuniaoNaoEncontrada();
  return {
    papel: "participante" as const,
    nomeDaDona: nomeDaConta(dona.displayName, dona.nome),
    participantes: linhas.filter(linha => linha.status === "active" && linha.ativa).map(linha => ({ nome: nomeDaConta(linha.displayName, linha.nome), souEu: linha.userId === conta.id })),
  };
}

/**
 * A reunião que a participante lê, pela credencial dela (o link aberto, com
 * "participante:<id>"): a participação ATIVA desta conta, a reunião visível e
 * pronta, e a conta da dona ativa (a dona desativada corta as participantes,
 * como corta o link). Null para todo o resto, igual.
 */
export async function reuniaoDaParticipante(conta: Conta, meetingId: string) {
  const db = await exigirDb();
  const [linha] = await db.select({
    id: meetings.id, ownerId: meetings.ownerId, title: meetings.title, status: meetings.status, createdAt: meetings.createdAt,
    audioPipeline: meetings.audioPipeline, origem: meetings.origem, sourceUrl: meetings.sourceUrl,
  }).from(meetingParticipants)
    .innerJoin(meetings, and(eq(meetings.id, meetingParticipants.meetingId), eq(meetings.ownerId, meetingParticipants.ownerId)))
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .where(and(
      eq(meetingParticipants.meetingId, meetingId), eq(meetingParticipants.userId, conta.id), eq(meetingParticipants.status, "active"),
      reuniaoVisivel(), eq(meetings.status, "ready"), eq(users.isActive, true), ne(meetings.ownerId, conta.openId),
    ))
    .limit(1);
  return linha ?? null;
}

/**
 * Os nomes das contas ligadas às vozes (H3c), resolvidos na hora de ler: a
 * dona ("owner") e as participações ATIVAS desta reunião. A participação que
 * saiu, foi removida ou cuja conta foi excluída ou desativada não resolve: a
 * voz volta ao nome livre ou a "Falante n".
 */
export async function nomesDasContasDasVozes(ex: BancoOuTransacao, reuniao: { id: string; ownerId: string }, contas: Record<string, string>): Promise<Record<string, string>> {
  const participacoes = Array.from(new Set(Object.values(contas).filter(conta => conta !== CONTA_DA_DONA)));
  const porConta = new Map<string, string>();
  if (Object.values(contas).includes(CONTA_DA_DONA)) {
    const [dona] = await ex.select({ nome: users.name, displayName: userProfiles.displayName, ativa: users.isActive }).from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.openId, reuniao.ownerId)).limit(1);
    const nome = dona?.ativa ? nomeDaConta(dona.displayName, dona.nome) : "";
    if (nome) porConta.set(CONTA_DA_DONA, nome);
  }
  if (participacoes.length) {
    const linhas = await ex.select({ id: meetingParticipants.id, nome: users.name, displayName: userProfiles.displayName }).from(meetingParticipants)
      .innerJoin(users, and(eq(users.id, meetingParticipants.userId), eq(users.isActive, true)))
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(and(
        inArray(meetingParticipants.id, participacoes), eq(meetingParticipants.meetingId, reuniao.id),
        eq(meetingParticipants.ownerId, reuniao.ownerId), eq(meetingParticipants.status, "active"),
      ));
    for (const linha of linhas) {
      const nome = nomeDaConta(linha.displayName, linha.nome);
      if (nome) porConta.set(linha.id, nome);
    }
  }
  const saida: Record<string, string> = {};
  for (const [falante, conta] of Object.entries(contas)) {
    const nome = porConta.get(conta);
    if (nome) saida[falante] = nome;
  }
  return saida;
}

/** A participação ATIVA desta reunião (para ligar uma voz a ela): o id, ou null. */
export async function participacaoAtivaDaReuniao(ex: BancoOuTransacao, ownerId: string, meetingId: string, participanteId: string): Promise<boolean> {
  const [linha] = await ex.select({ id: meetingParticipants.id }).from(meetingParticipants)
    .where(and(
      eq(meetingParticipants.id, participanteId), eq(meetingParticipants.meetingId, meetingId),
      eq(meetingParticipants.ownerId, ownerId), eq(meetingParticipants.status, "active"),
    )).limit(1);
  return !!linha;
}
