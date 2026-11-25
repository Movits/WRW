import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import {
  agendaReunioes, auditLogs, connections, meetingFolderMembers, meetingFolders, meetingFolderTasks, meetings, userProfiles, users,
} from "../drizzle/schema";
import {
  AGENDA_DA_EQUIPE_MAX, CONVITE_DA_EQUIPE_VALE_MS, CONVITES_DA_EQUIPE_POR_JANELA, escreveTarefas, FORMATO_DO_CONVITE_DA_EQUIPE,
  JANELA_DOS_CONVITES_DA_EQUIPE_MS, MEMBRAS_POR_EQUIPE_MAX, RECUSAS_DA_EQUIPE, REUNIOES_DA_EQUIPE_MAX, TAREFAS_POR_EQUIPE_MAX,
  type PapelDaEquipe, type PapelNaEquipe,
} from "@shared/espacos-de-equipe";
import { prazoValido } from "@shared/proximas-acoes";
import { corDaPasta, iconeDaPasta } from "@shared/pastas-de-reunioes";
import { criarTeto } from "./assistente-de-texto";
import { exigirDb } from "./db";
import {
  comNovaTentativaNoDeadlock, gerarTokenDoConvite, hashDoConvite, nomeDaConta,
  type AutorizacaoDasPessoas, type Conta, type ProvaDaPessoa,
} from "./participantes-da-reuniao";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * Os espaços de equipe (R2 do plano do gravador; HN-62 no app de referência
 * da cliente). A equipe é uma pasta das reuniões da dona (H7d) com membras,
 * construída sobre as participantes da reunião (R1b):
 * - a dona convida por um link de uso único ou uma das conexões aceitas dela,
 *   com o papel escolhido ("member" ou "reader"); nunca por e-mail digitado;
 * - as reuniões da pasta ficam visíveis às membras ativas, nos dois papéis,
 *   pela mesma leitura da participante (server/link-aberto-da-reuniao.ts,
 *   reuniaoDaMembra, abaixo): sai da pasta, vai para a lixeira, a dona é
 *   desativada ou a membra sai, e a próxima leitura já recusa;
 * - as tarefas da equipe: a dona e as "member" escrevem, as "reader" só leem;
 * - a agenda da equipe: as reuniões marcadas que a dona pôs na pasta, sem os
 *   participantes (nome e e-mail de terceiros).
 *
 * Anonimato entre membras (decisão da cliente de 12/09, privacidade.md): o
 * nome de uma conta só aparece para quem ela aceitou aparecer. Quem aceita o
 * convite aparece para a dona e para as outras membras ATIVAS; o convite por
 * link não tem nome até ser aceito; as membras nunca veem os convites
 * pendentes; a dona vê o nome da conexão convidada, que já via.
 *
 * O que muda é da dona (a dona no WHERE e a pasta travada), menos as tarefas,
 * que as "member" também escrevem; a conferência do papel é feita na mesma
 * transação, com a linha da membra lida no banco, nunca pela tela.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type BancoOuTransacao = Banco | Transacao;

export const ACAO_EQUIPE_AUTORIZADA = "MEETING_FOLDER_TEAM_AUTHORIZED";
export const ACAO_CONVITE_DA_EQUIPE = "MEETING_FOLDER_MEMBER_INVITED";
export const ACAO_CONVITE_DA_EQUIPE_CANCELADO = "MEETING_FOLDER_MEMBER_INVITE_CANCELED";
export const ACAO_MEMBRA_ENTROU = "MEETING_FOLDER_MEMBER_JOINED";
export const ACAO_CONVITE_DA_EQUIPE_RECUSADO = "MEETING_FOLDER_MEMBER_DECLINED";
export const ACAO_MEMBRA_REMOVIDA = "MEETING_FOLDER_MEMBER_REMOVED";
export const ACAO_MEMBRA_SAIU = "MEETING_FOLDER_MEMBER_LEFT";
export const ACAO_PAPEL_MUDOU = "MEETING_FOLDER_MEMBER_ROLE_CHANGED";
export const ACAO_TAREFA_DA_EQUIPE = "MEETING_FOLDER_TASK_CHANGED";
export const ACAO_AGENDA_DA_EQUIPE = "MEETING_FOLDER_AGENDA_CHANGED";

let teto: ReturnType<typeof criarTeto> | null = null;
/** O teto dos convites da equipe, por dona, em memória (zera a cada deploy). */
export function tetoDosConvitesDaEquipe() {
  teto ??= criarTeto(CONVITES_DA_EQUIPE_POR_JANELA, JANELA_DOS_CONVITES_DA_EQUIPE_MS, RECUSAS_DA_EQUIPE.muitosConvites);
  return teto;
}

const recusa = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });
const equipeNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DA_EQUIPE.equipeNaoEncontrada);
const conviteInvalido = () => recusa("NOT_FOUND", RECUSAS_DA_EQUIPE.conviteInvalido);
const membraNaoEncontrada = () => recusa("NOT_FOUND", RECUSAS_DA_EQUIPE.membraNaoEncontrada);

function linhasAfetadas(resultado: unknown) {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | null | undefined)?.affectedRows ?? 0;
}

function ehChaveDuplicada(erro: unknown) {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

// Os mesmos cortes do createAuditLog (server/security.ts).
function linhaDeAuditoria(prova: ProvaDaPessoa, action: string, pastaId: string, details: Record<string, unknown>, riskLevel: "low" | "medium" = "low") {
  return {
    userId: prova.userId,
    ipAddress: prova.ipAddress.substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
    action,
    resource: "meeting_folders",
    resourceId: pastaId,
    details,
    status: "success" as const,
    riskLevel,
  };
}

/** A pasta da dona, travada até o fim da transação. */
async function pastaDaDonaTravada(tx: Transacao, ownerId: string, pastaId: string) {
  const [pasta] = await tx.select({ id: meetingFolders.id, nome: meetingFolders.name }).from(meetingFolders)
    .where(and(eq(meetingFolders.id, pastaId), eq(meetingFolders.ownerId, ownerId))).limit(1).for("update");
  if (!pasta) throw equipeNaoEncontrada();
  return pasta;
}

async function limparConvitesVencidos(ex: BancoOuTransacao, ownerId: string, pastaId: string, agora: number) {
  await ex.delete(meetingFolderMembers).where(and(
    eq(meetingFolderMembers.ownerId, ownerId), eq(meetingFolderMembers.folderId, pastaId),
    eq(meetingFolderMembers.status, "invited"), lt(meetingFolderMembers.expiresAt, agora),
  ));
}

/** A dona já confirmou, nesta pasta, que as pessoas que falaram autorizaram compartilhar com a equipe? */
async function jaAutorizou(ex: BancoOuTransacao, donaId: number, pastaId: string): Promise<boolean> {
  const [linha] = await ex.select({ id: auditLogs.id }).from(auditLogs)
    .where(and(eq(auditLogs.action, ACAO_EQUIPE_AUTORIZADA), eq(auditLogs.resource, "meeting_folders"), eq(auditLogs.resourceId, pastaId), eq(auditLogs.userId, donaId)))
    .limit(1);
  return !!linha;
}

/**
 * A confirmação da dona, uma vez por pasta (decisão vetável, como a P8 da
 * R1b): as pessoas que falaram nas reuniões desta pasta, e nas que ela puser
 * nela, autorizaram compartilhar com a equipe. A prova (a frase que ela viu, o
 * idioma e o hash) vai na transação do convite.
 */
async function exigirAutorizacao(tx: Transacao, prova: ProvaDaPessoa, pastaId: string, autorizacao: AutorizacaoDasPessoas | undefined) {
  if (await jaAutorizou(tx, prova.userId, pastaId)) return;
  if (!autorizacao) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_EQUIPE.autorizacaoPedida);
  await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_EQUIPE_AUTORIZADA, pastaId, {
    autorizacaoDasPessoas: true,
    idioma: autorizacao.idioma,
    textoExibido: autorizacao.textoExibido,
    textoHash: crypto.createHash("sha256").update(autorizacao.textoExibido).digest("hex"),
  }, "medium"));
}

async function exigirVaga(tx: Transacao, ownerId: string, pastaId: string) {
  const [contagem] = await tx.select({ quantas: sql<number>`count(*)` }).from(meetingFolderMembers)
    .where(and(eq(meetingFolderMembers.ownerId, ownerId), eq(meetingFolderMembers.folderId, pastaId)));
  if (Number(contagem?.quantas ?? 0) >= MEMBRAS_POR_EQUIPE_MAX) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_EQUIPE.equipeCheia);
}

/** Um convite por link de uso único para a equipe, com o papel. O token sai só nesta resposta. */
export async function criarConviteDaEquipe(dona: Conta, pastaId: string, papel: PapelDaEquipe, prova: ProvaDaPessoa, autorizacao?: AutorizacaoDasPessoas): Promise<{ token: string; expiraEm: number }> {
  const soltarVaga = tetoDosConvitesDaEquipe().reservar(dona.openId);
  try {
    const db = await exigirDb();
    const token = gerarTokenDoConvite();
    const agora = Date.now();
    const expiraEm = agora + CONVITE_DA_EQUIPE_VALE_MS;
    await db.transaction(async tx => {
      await pastaDaDonaTravada(tx, dona.openId, pastaId);
      await limparConvitesVencidos(tx, dona.openId, pastaId, agora);
      await exigirVaga(tx, dona.openId, pastaId);
      await exigirAutorizacao(tx, prova, pastaId, autorizacao);
      const id = crypto.randomUUID();
      await tx.insert(meetingFolderMembers).values({
        id, folderId: pastaId, ownerId: dona.openId, userId: null, role: papel, status: "invited", source: "link",
        inviteTokenHash: hashDoConvite(token), invitedAt: agora, expiresAt: expiraEm, acceptedAt: null, createdAt: agora, updatedAt: agora,
      });
      await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_CONVITE_DA_EQUIPE, pastaId, { membraId: id, origem: "link", papel }));
    });
    return { token, expiraEm };
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

/**
 * Convida uma conexão ACEITA da dona para a equipe (os nomes já foram
 * revelados nos dois sentidos). A conexão que não é dela, que não está aceita
 * ou cuja conta foi desativada é recusada com o mesmo código, sem dizer qual.
 */
export async function convidarConexaoParaEquipe(dona: Conta, pastaId: string, conexaoId: number, papel: PapelDaEquipe, prova: ProvaDaPessoa, autorizacao?: AutorizacaoDasPessoas): Promise<{ membraId: string }> {
  const soltarVaga = tetoDosConvitesDaEquipe().reservar(dona.openId);
  try {
    const db = await exigirDb();
    const agora = Date.now();
    const membraId = crypto.randomUUID();
    await db.transaction(async tx => {
      await pastaDaDonaTravada(tx, dona.openId, pastaId);
      const [conexao] = await tx.select({ requesterId: connections.requesterId, recipientId: connections.recipientId }).from(connections)
        .where(and(eq(connections.id, conexaoId), eq(connections.status, "accepted"), or(eq(connections.requesterId, dona.id), eq(connections.recipientId, dona.id))))
        .limit(1);
      const outraId = conexao ? (conexao.requesterId === dona.id ? conexao.recipientId : conexao.requesterId) : null;
      const [outra] = outraId && outraId !== dona.id
        ? await tx.select({ id: users.id }).from(users).where(and(eq(users.id, outraId), eq(users.isActive, true))).limit(1)
        : [];
      if (!outra) throw recusa("BAD_REQUEST", RECUSAS_DA_EQUIPE.conexaoInvalida);
      await limparConvitesVencidos(tx, dona.openId, pastaId, agora);
      const [ja] = await tx.select({ id: meetingFolderMembers.id }).from(meetingFolderMembers)
        .where(and(eq(meetingFolderMembers.folderId, pastaId), eq(meetingFolderMembers.userId, outra.id))).limit(1);
      if (ja) throw recusa("CONFLICT", RECUSAS_DA_EQUIPE.jaEstaNaEquipe);
      await exigirVaga(tx, dona.openId, pastaId);
      await exigirAutorizacao(tx, prova, pastaId, autorizacao);
      try {
        await tx.insert(meetingFolderMembers).values({
          id: membraId, folderId: pastaId, ownerId: dona.openId, userId: outra.id, role: papel, status: "invited", source: "connection",
          inviteTokenHash: null, invitedAt: agora, expiresAt: agora + CONVITE_DA_EQUIPE_VALE_MS, acceptedAt: null, createdAt: agora, updatedAt: agora,
        });
      } catch (erro) {
        if (ehChaveDuplicada(erro)) throw recusa("CONFLICT", RECUSAS_DA_EQUIPE.jaEstaNaEquipe);
        throw erro;
      }
      await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_CONVITE_DA_EQUIPE, pastaId, { membraId, origem: "connection", papel }));
    });
    return { membraId };
  } catch (erro) {
    soltarVaga();
    throw erro;
  }
}

/** A linha da membra (ativa ou convidada) da equipe da dona, travada. */
async function membraDaDonaTravada(tx: Transacao, ownerId: string, membraId: string) {
  const [linha] = await tx.select({ id: meetingFolderMembers.id, folderId: meetingFolderMembers.folderId, status: meetingFolderMembers.status, role: meetingFolderMembers.role })
    .from(meetingFolderMembers)
    .where(and(eq(meetingFolderMembers.id, membraId), eq(meetingFolderMembers.ownerId, ownerId)))
    .limit(1).for("update");
  if (!linha) throw membraNaoEncontrada();
  return linha;
}

/**
 * A dona tira uma membra (ativa ou com o convite pendente): o acesso acaba na
 * hora. `soConvite`: o "Cancelar convite", que só tira o convite não aceito.
 */
export async function removerMembra(ownerId: string, membraId: string, prova: ProvaDaPessoa, opcoes: { soConvite?: boolean } = {}): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const linha = await membraDaDonaTravada(tx, ownerId, membraId);
    if (opcoes.soConvite && linha.status !== "invited") throw membraNaoEncontrada();
    await tx.delete(meetingFolderMembers).where(and(eq(meetingFolderMembers.id, linha.id), eq(meetingFolderMembers.ownerId, ownerId)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, linha.status === "invited" ? ACAO_CONVITE_DA_EQUIPE_CANCELADO : ACAO_MEMBRA_REMOVIDA, linha.folderId, { membraId: linha.id }));
  });
}

/** A dona muda o papel de uma membra (ou de um convite pendente). */
export async function mudarPapel(ownerId: string, membraId: string, papel: PapelDaEquipe, prova: ProvaDaPessoa): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const linha = await membraDaDonaTravada(tx, ownerId, membraId);
    if (linha.role === papel) return;
    await tx.update(meetingFolderMembers).set({ role: papel, updatedAt: Date.now() })
      .where(and(eq(meetingFolderMembers.id, linha.id), eq(meetingFolderMembers.ownerId, ownerId)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_PAPEL_MUDOU, linha.folderId, { membraId: linha.id, de: linha.role, para: papel }));
  });
}

/** O convite por link pelo token: a linha pendente, a pasta da dona e a conta da dona ativa. */
async function conviteDoToken(ex: BancoOuTransacao, token: string, agora: number, travar: boolean) {
  if (!FORMATO_DO_CONVITE_DA_EQUIPE.test(token)) return null;
  const consulta = ex.select({
    id: meetingFolderMembers.id, folderId: meetingFolderMembers.folderId, ownerId: meetingFolderMembers.ownerId, role: meetingFolderMembers.role,
    expiresAt: meetingFolderMembers.expiresAt, nome: meetingFolders.name, donaNome: users.name, donaDisplayName: userProfiles.displayName,
  }).from(meetingFolderMembers)
    .innerJoin(meetingFolders, and(eq(meetingFolders.id, meetingFolderMembers.folderId), eq(meetingFolders.ownerId, meetingFolderMembers.ownerId)))
    .innerJoin(users, eq(users.openId, meetingFolderMembers.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(
      eq(meetingFolderMembers.inviteTokenHash, hashDoConvite(token)), eq(meetingFolderMembers.status, "invited"),
      eq(meetingFolderMembers.source, "link"), eq(users.isActive, true),
    ))
    .limit(1);
  const [linha] = travar ? await consulta.for("update") : await consulta;
  if (!linha || linha.expiresAt === null || linha.expiresAt <= agora) return null;
  return linha;
}

/**
 * O que a página do convite mostra a quem o abriu (logada): o nome da equipe,
 * o nome da dona, o papel e o aviso. O convite que não existe, venceu ou já
 * foi usado responde igual (`valido: false`), sem nome nenhum.
 */
export async function verConviteDaEquipe(token: string, conta: Conta): Promise<
  { valido: false } | { valido: true; pastaId: string; nome: string; nomeDaDona: string; papel: PapelDaEquipe; propria: boolean; jaEsta: boolean; expiraEm: number }
> {
  const db = await exigirDb();
  const convite = await conviteDoToken(db, token, Date.now(), false);
  if (!convite) return { valido: false };
  const propria = convite.ownerId === conta.openId;
  const [ja] = propria ? [] : await db.select({ id: meetingFolderMembers.id }).from(meetingFolderMembers)
    .where(and(eq(meetingFolderMembers.folderId, convite.folderId), eq(meetingFolderMembers.userId, conta.id), eq(meetingFolderMembers.status, "active"))).limit(1);
  return {
    valido: true, pastaId: convite.folderId, nome: convite.nome, nomeDaDona: nomeDaConta(convite.donaDisplayName, convite.donaNome),
    papel: convite.role, propria, jaEsta: !!ja, expiraEm: Number(convite.expiresAt),
  };
}

/**
 * Aceita o convite por link: um UPDATE condicional sobre o hash ainda válido
 * preenche o userId, apaga o hash e ativa a membra. De dois aceites ao mesmo
 * tempo, só um vence. A dona que abre o próprio convite é recusada. A conta
 * que já está na equipe entra direto, e o convite fica para outra pessoa; a
 * que tinha um convite de conexão pendente nesta equipe o vê aceito, com o
 * papel que a dona deu a ele.
 */
export async function aceitarConviteDaEquipe(token: string, conta: Conta, prova: ProvaDaPessoa): Promise<{ pastaId: string }> {
  const db = await exigirDb();
  const agora = Date.now();
  return comNovaTentativaNoDeadlock(() => db.transaction(async tx => {
    const convite = await conviteDoToken(tx, token, agora, true);
    if (!convite) throw conviteInvalido();
    if (convite.ownerId === conta.openId) throw recusa("BAD_REQUEST", RECUSAS_DA_EQUIPE.conviteDaPropriaDona);
    const [existente] = await tx.select({ id: meetingFolderMembers.id, status: meetingFolderMembers.status }).from(meetingFolderMembers)
      .where(and(eq(meetingFolderMembers.folderId, convite.folderId), eq(meetingFolderMembers.userId, conta.id))).limit(1).for("update");
    if (existente) {
      if (existente.status === "invited") {
        await tx.update(meetingFolderMembers).set({ status: "active", expiresAt: null, acceptedAt: agora, updatedAt: agora })
          .where(and(eq(meetingFolderMembers.id, existente.id), eq(meetingFolderMembers.status, "invited")));
        await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_MEMBRA_ENTROU, convite.folderId, { membraId: existente.id, origem: "connection" }));
      }
      return { pastaId: convite.folderId };
    }
    const resultado = await tx.update(meetingFolderMembers).set({
      userId: conta.id, status: "active", inviteTokenHash: null, expiresAt: null, acceptedAt: agora, updatedAt: agora,
    }).where(and(
      eq(meetingFolderMembers.id, convite.id), eq(meetingFolderMembers.inviteTokenHash, hashDoConvite(token)), eq(meetingFolderMembers.status, "invited"),
    ));
    if (!linhasAfetadas(resultado)) throw conviteInvalido();
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_MEMBRA_ENTROU, convite.folderId, { membraId: convite.id, origem: "link" }));
    return { pastaId: convite.folderId };
  }));
}

/** A convidada aceita ou recusa o convite de conexão para a equipe. */
export async function responderConviteDaEquipe(conta: Conta, membraId: string, aceitar: boolean, prova: ProvaDaPessoa): Promise<{ pastaId: string }> {
  const db = await exigirDb();
  const agora = Date.now();
  return db.transaction(async tx => {
    const [linha] = await tx.select({ id: meetingFolderMembers.id, folderId: meetingFolderMembers.folderId, expiresAt: meetingFolderMembers.expiresAt })
      .from(meetingFolderMembers)
      .innerJoin(users, eq(users.openId, meetingFolderMembers.ownerId))
      .where(and(
        eq(meetingFolderMembers.id, membraId), eq(meetingFolderMembers.userId, conta.id), eq(meetingFolderMembers.status, "invited"), eq(users.isActive, true),
      )).limit(1).for("update");
    if (!linha || linha.expiresAt === null || linha.expiresAt <= agora) throw conviteInvalido();
    if (aceitar) {
      await tx.update(meetingFolderMembers).set({ status: "active", expiresAt: null, acceptedAt: agora, updatedAt: agora })
        .where(and(eq(meetingFolderMembers.id, linha.id), eq(meetingFolderMembers.status, "invited")));
    } else {
      await tx.delete(meetingFolderMembers).where(and(eq(meetingFolderMembers.id, linha.id), eq(meetingFolderMembers.userId, conta.id)));
    }
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, aceitar ? ACAO_MEMBRA_ENTROU : ACAO_CONVITE_DA_EQUIPE_RECUSADO, linha.folderId, { membraId: linha.id, origem: "connection" }));
    return { pastaId: linha.folderId };
  });
}

/** A membra sai da equipe: o acesso às reuniões, às tarefas e à agenda acaba. */
export async function sairDaEquipe(conta: Conta, pastaId: string, prova: ProvaDaPessoa): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [linha] = await tx.select({ id: meetingFolderMembers.id }).from(meetingFolderMembers)
      .where(and(eq(meetingFolderMembers.folderId, pastaId), eq(meetingFolderMembers.userId, conta.id), eq(meetingFolderMembers.status, "active")))
      .limit(1).for("update");
    if (!linha) throw membraNaoEncontrada();
    await tx.delete(meetingFolderMembers).where(and(eq(meetingFolderMembers.id, linha.id), eq(meetingFolderMembers.userId, conta.id)));
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_MEMBRA_SAIU, pastaId, { membraId: linha.id }));
  });
}

/**
 * O papel da conta na equipe: a dona da pasta, ou a membra ATIVA de uma pasta
 * cuja dona está ativa. Null para todo o resto (a pasta que não existe, a de
 * outra conta, o convite pendente, a dona desativada), igual.
 */
export async function papelNaEquipe(ex: BancoOuTransacao, conta: Conta, pastaId: string, opcoes: { travar?: boolean } = {}): Promise<{ papel: PapelNaEquipe; ownerId: string } | null> {
  const [pasta] = await ex.select({ ownerId: meetingFolders.ownerId }).from(meetingFolders).where(eq(meetingFolders.id, pastaId)).limit(1);
  if (!pasta) return null;
  if (pasta.ownerId === conta.openId) return { papel: "owner", ownerId: pasta.ownerId };
  const consulta = ex.select({ role: meetingFolderMembers.role }).from(meetingFolderMembers)
    .innerJoin(users, eq(users.openId, meetingFolderMembers.ownerId))
    .where(and(
      eq(meetingFolderMembers.folderId, pastaId), eq(meetingFolderMembers.ownerId, pasta.ownerId),
      eq(meetingFolderMembers.userId, conta.id), eq(meetingFolderMembers.status, "active"), eq(users.isActive, true),
    )).limit(1);
  const [membra] = opcoes.travar ? await consulta.for("update") : await consulta;
  return membra ? { papel: membra.role, ownerId: pasta.ownerId } : null;
}

async function exigirPapel(ex: BancoOuTransacao, conta: Conta, pastaId: string, opcoes: { travar?: boolean } = {}) {
  const papel = await papelNaEquipe(ex, conta, pastaId, opcoes);
  if (!papel) throw equipeNaoEncontrada();
  return papel;
}

/**
 * A equipe como a conta a vê:
 * - a dona: a pasta, as membras com os convites pendentes (o convite por link
 *   sem nome até ser aceito), o papel de cada uma e se já deu a confirmação;
 * - a membra: a pasta, o papel dela, o nome da dona e só os nomes das membras
 *   ATIVAS, sem ids e sem os convites.
 */
export async function verEquipe(conta: Conta, pastaId: string) {
  const db = await exigirDb();
  const acesso = await exigirPapel(db, conta, pastaId);
  const [pasta] = await db.select({ nome: meetingFolders.name, icone: meetingFolders.icon, cor: meetingFolders.color }).from(meetingFolders)
    .where(and(eq(meetingFolders.id, pastaId), eq(meetingFolders.ownerId, acesso.ownerId))).limit(1);
  if (!pasta) throw equipeNaoEncontrada();
  const ehDona = acesso.papel === "owner";
  if (ehDona) await limparConvitesVencidos(db, conta.openId, pastaId, Date.now());
  const linhas = await db.select({
    id: meetingFolderMembers.id, userId: meetingFolderMembers.userId, status: meetingFolderMembers.status, source: meetingFolderMembers.source,
    role: meetingFolderMembers.role, expiresAt: meetingFolderMembers.expiresAt, nome: users.name, displayName: userProfiles.displayName, ativa: users.isActive,
  }).from(meetingFolderMembers)
    .leftJoin(users, eq(users.id, meetingFolderMembers.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, meetingFolderMembers.userId))
    .where(and(eq(meetingFolderMembers.folderId, pastaId), eq(meetingFolderMembers.ownerId, acesso.ownerId)))
    .orderBy(asc(meetingFolderMembers.invitedAt))
    .limit(MEMBRAS_POR_EQUIPE_MAX + 10);
  const daPasta = { pastaId, nome: pasta.nome, icone: iconeDaPasta(pasta.icone), cor: corDaPasta(pasta.cor) };
  if (acesso.papel === "owner") {
    return {
      ...daPasta,
      papel: "owner" as const,
      autorizado: await jaAutorizou(db, conta.id, pastaId),
      membras: linhas.map(linha => ({
        id: linha.id, status: linha.status, origem: linha.source, papel: linha.role,
        nome: linha.userId !== null && linha.ativa ? nomeDaConta(linha.displayName, linha.nome) : null,
        expiraEm: linha.status === "invited" ? Number(linha.expiresAt) : null,
      })),
    };
  }
  const [dona] = await db.select({ nome: users.name, displayName: userProfiles.displayName }).from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.openId, acesso.ownerId)).limit(1);
  return {
    ...daPasta,
    papel: acesso.papel,
    nomeDaDona: nomeDaConta(dona?.displayName, dona?.nome),
    membras: linhas.filter(linha => linha.status === "active" && linha.ativa)
      .map(linha => ({ nome: nomeDaConta(linha.displayName, linha.nome), papel: linha.role, souEu: linha.userId === conta.id })),
  };
}

/** As equipes de que a conta é membra ativa e os convites de conexão pendentes, com o nome da dona. */
export async function minhasEquipes(conta: Conta) {
  const db = await exigirDb();
  const agora = Date.now();
  const linhas = await db.select({
    membraId: meetingFolderMembers.id, pastaId: meetingFolderMembers.folderId, status: meetingFolderMembers.status, papel: meetingFolderMembers.role,
    expiresAt: meetingFolderMembers.expiresAt, nome: meetingFolders.name, icone: meetingFolders.icon, cor: meetingFolders.color,
    donaNome: users.name, donaDisplayName: userProfiles.displayName,
  }).from(meetingFolderMembers)
    .innerJoin(meetingFolders, and(eq(meetingFolders.id, meetingFolderMembers.folderId), eq(meetingFolders.ownerId, meetingFolderMembers.ownerId)))
    .innerJoin(users, eq(users.openId, meetingFolderMembers.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(eq(meetingFolderMembers.userId, conta.id), eq(users.isActive, true)))
    .orderBy(asc(meetingFolders.name))
    .limit(200);
  const saida = (linha: (typeof linhas)[number]) => ({
    pastaId: linha.pastaId, nome: linha.nome, icone: iconeDaPasta(linha.icone), cor: corDaPasta(linha.cor), papel: linha.papel,
    nomeDaDona: nomeDaConta(linha.donaDisplayName, linha.donaNome),
  });
  return {
    equipes: linhas.filter(linha => linha.status === "active").map(saida),
    convites: linhas.filter(linha => linha.status === "invited" && linha.expiresAt !== null && linha.expiresAt > agora)
      .map(linha => ({ ...saida(linha), membraId: linha.membraId, expiraEm: Number(linha.expiresAt) })),
  };
}

/** As reuniões da equipe: as da pasta, visíveis e prontas (a da lixeira some), as mais novas primeiro. */
export async function reunioesDaEquipe(conta: Conta, pastaId: string) {
  const db = await exigirDb();
  const acesso = await exigirPapel(db, conta, pastaId);
  const linhas = await db.select({ id: meetings.id, titulo: meetings.title, criadaEm: meetings.createdAt }).from(meetings)
    .where(and(eq(meetings.ownerId, acesso.ownerId), eq(meetings.folderId, pastaId), eq(meetings.status, "ready"), reuniaoVisivel()))
    .orderBy(desc(meetings.createdAt))
    .limit(REUNIOES_DA_EQUIPE_MAX);
  return linhas.map(linha => ({ id: linha.id, titulo: linha.titulo, criadaEm: Number(linha.criadaEm) }));
}

/**
 * A reunião que a membra lê, pela mesma credencial da participante
 * ("participante:<id>", server/link-aberto-da-reuniao.ts): a reunião visível
 * e pronta, numa pasta de que a conta é membra ATIVA (nos dois papéis), de
 * dona ativa, e não da própria conta. Null para todo o resto, igual.
 */
export async function reuniaoDaMembra(conta: Conta, meetingId: string) {
  const db = await exigirDb();
  const [linha] = await db.select({
    id: meetings.id, ownerId: meetings.ownerId, title: meetings.title, status: meetings.status, createdAt: meetings.createdAt,
    audioPipeline: meetings.audioPipeline, origem: meetings.origem, sourceUrl: meetings.sourceUrl,
  }).from(meetings)
    .innerJoin(meetingFolderMembers, and(
      eq(meetingFolderMembers.folderId, meetings.folderId), eq(meetingFolderMembers.ownerId, meetings.ownerId),
      eq(meetingFolderMembers.userId, conta.id), eq(meetingFolderMembers.status, "active"),
    ))
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .where(and(
      eq(meetings.id, meetingId), isNotNull(meetings.folderId), reuniaoVisivel(), eq(meetings.status, "ready"),
      eq(users.isActive, true), ne(meetings.ownerId, conta.openId),
    ))
    .limit(1);
  return linha ?? null;
}

// ── As tarefas da equipe ────────────────────────────────────────────────

export type DadosDaTarefa = { texto: string; responsavel?: string | null; prazo?: string | null };

function prazoOuRecusa(prazo: string | null | undefined): string | null | undefined {
  if (prazo === undefined || prazo === null) return prazo;
  if (!prazoValido(prazo)) throw recusa("BAD_REQUEST", RECUSAS_DA_EQUIPE.prazoInvalido);
  return prazo;
}

/** As tarefas da equipe, para todos os papéis: as abertas primeiro, por prazo (sem prazo no fim). */
export async function listarTarefasDaEquipe(conta: Conta, pastaId: string) {
  const db = await exigirDb();
  const acesso = await exigirPapel(db, conta, pastaId);
  const linhas = await db.select({
    id: meetingFolderTasks.id, texto: meetingFolderTasks.texto, responsavel: meetingFolderTasks.responsavel, prazo: meetingFolderTasks.prazo,
    feita: meetingFolderTasks.feita, feitaEm: meetingFolderTasks.feitaEm, criadaEm: meetingFolderTasks.createdAt,
  }).from(meetingFolderTasks)
    .where(and(eq(meetingFolderTasks.ownerId, acesso.ownerId), eq(meetingFolderTasks.folderId, pastaId)))
    .orderBy(asc(meetingFolderTasks.feita), sql`${meetingFolderTasks.prazo} is null`, asc(meetingFolderTasks.prazo), asc(meetingFolderTasks.createdAt))
    .limit(TAREFAS_POR_EQUIPE_MAX);
  return {
    podeEscrever: escreveTarefas(acesso.papel),
    tarefas: linhas.map(linha => ({ ...linha, feitaEm: linha.feitaEm === null ? null : Number(linha.feitaEm), criadaEm: Number(linha.criadaEm) })),
  };
}

/**
 * Abre a transação de escrita de uma tarefa: o papel conferido no banco, com
 * a linha da membra travada (a dona que a muda para leitora ao mesmo tempo
 * espera), e a leitora recusada. FOR UPDATE, e não FOR SHARE: o MariaDB do CI
 * não aceita a forma FOR SHARE.
 */
async function comPapelQueEscreve<T>(conta: Conta, pastaId: string, trabalho: (tx: Transacao, ownerId: string) => Promise<T>): Promise<T> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const acesso = await exigirPapel(tx, conta, pastaId, { travar: true });
    if (!escreveTarefas(acesso.papel)) throw recusa("FORBIDDEN", RECUSAS_DA_EQUIPE.soLeitura);
    return trabalho(tx, acesso.ownerId);
  });
}

export async function criarTarefaDaEquipe(conta: Conta, pastaId: string, dados: DadosDaTarefa, prova: ProvaDaPessoa): Promise<{ id: string }> {
  const prazo = prazoOuRecusa(dados.prazo) ?? null;
  return comPapelQueEscreve(conta, pastaId, async (tx, ownerId) => {
    const [contagem] = await tx.select({ quantas: sql<number>`count(*)` }).from(meetingFolderTasks)
      .where(and(eq(meetingFolderTasks.ownerId, ownerId), eq(meetingFolderTasks.folderId, pastaId)));
    if (Number(contagem?.quantas ?? 0) >= TAREFAS_POR_EQUIPE_MAX) throw recusa("PRECONDITION_FAILED", RECUSAS_DA_EQUIPE.tarefasDemais);
    const id = crypto.randomUUID();
    const agora = Date.now();
    await tx.insert(meetingFolderTasks).values({
      id, folderId: pastaId, ownerId, texto: dados.texto, responsavel: dados.responsavel ?? null, prazo, feita: false, feitaEm: null, createdAt: agora, updatedAt: agora,
    });
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_TAREFA_DA_EQUIPE, pastaId, { tarefaId: id, mudanca: "criada" }));
    return { id };
  });
}

async function mudarTarefa(conta: Conta, pastaId: string, tarefaId: string, prova: ProvaDaPessoa, mudanca: string, campos: Partial<typeof meetingFolderTasks.$inferInsert> | null) {
  await comPapelQueEscreve(conta, pastaId, async (tx, ownerId) => {
    const daEquipe = and(eq(meetingFolderTasks.id, tarefaId), eq(meetingFolderTasks.ownerId, ownerId), eq(meetingFolderTasks.folderId, pastaId));
    const [tarefa] = await tx.select({ id: meetingFolderTasks.id }).from(meetingFolderTasks).where(daEquipe).limit(1).for("update");
    if (!tarefa) throw recusa("NOT_FOUND", RECUSAS_DA_EQUIPE.tarefaNaoEncontrada);
    if (campos) await tx.update(meetingFolderTasks).set({ ...campos, updatedAt: Date.now() }).where(daEquipe);
    else await tx.delete(meetingFolderTasks).where(daEquipe);
    await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_TAREFA_DA_EQUIPE, pastaId, { tarefaId, mudanca }));
  });
}

/** Muda o texto, o responsável ou o prazo; campo ausente não muda, null apaga. */
export async function editarTarefaDaEquipe(conta: Conta, pastaId: string, tarefaId: string, dados: Partial<DadosDaTarefa>, prova: ProvaDaPessoa) {
  const prazo = prazoOuRecusa(dados.prazo);
  await mudarTarefa(conta, pastaId, tarefaId, prova, "editada", {
    ...(dados.texto !== undefined ? { texto: dados.texto } : {}),
    ...(dados.responsavel !== undefined ? { responsavel: dados.responsavel } : {}),
    ...(prazo !== undefined ? { prazo } : {}),
  });
}

export async function marcarTarefaDaEquipe(conta: Conta, pastaId: string, tarefaId: string, feita: boolean, prova: ProvaDaPessoa) {
  await mudarTarefa(conta, pastaId, tarefaId, prova, feita ? "feita" : "reaberta", { feita, feitaEm: feita ? Date.now() : null });
}

export async function apagarTarefaDaEquipe(conta: Conta, pastaId: string, tarefaId: string, prova: ProvaDaPessoa) {
  await mudarTarefa(conta, pastaId, tarefaId, prova, "apagada", null);
}

// ── A agenda da equipe ──────────────────────────────────────────────────

/**
 * A agenda da equipe, para todos os papéis: as reuniões marcadas da pasta que
 * ainda vêm (e a que está acontecendo), da mais perto à mais longe. Só o
 * título, a hora, a duração, o fuso e o local: os participantes (nome e
 * e-mail de terceiros, da base particular da dona) nunca saem daqui.
 */
export async function agendaDaEquipe(conta: Conta, pastaId: string, agora: number = Date.now()) {
  const db = await exigirDb();
  const acesso = await exigirPapel(db, conta, pastaId);
  const fim = sql`(${agendaReunioes.inicioEm} + ${agendaReunioes.duracaoMinutos} * 60000)`;
  const linhas = await db.select({
    id: agendaReunioes.id, titulo: agendaReunioes.titulo, inicioEm: agendaReunioes.inicioEm, duracaoMinutos: agendaReunioes.duracaoMinutos,
    fuso: agendaReunioes.fuso, local: agendaReunioes.local,
  }).from(agendaReunioes)
    .where(and(eq(agendaReunioes.ownerId, acesso.ownerId), eq(agendaReunioes.folderId, pastaId), gte(fim, agora)))
    .orderBy(asc(agendaReunioes.inicioEm))
    .limit(AGENDA_DA_EQUIPE_MAX);
  return linhas.map(linha => ({ ...linha, inicioEm: Number(linha.inicioEm) }));
}

/** A dona põe uma reunião da agenda dela na agenda da equipe (pastaId) ou a tira (null). */
export async function porNaAgendaDaEquipe(dona: Conta, agendaId: string, pastaId: string | null, prova: ProvaDaPessoa): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    if (pastaId !== null) await pastaDaDonaTravada(tx, dona.openId, pastaId);
    const daDona = and(eq(agendaReunioes.id, agendaId), eq(agendaReunioes.ownerId, dona.openId));
    const [linha] = await tx.select({ folderId: agendaReunioes.folderId }).from(agendaReunioes).where(daDona).limit(1).for("update");
    if (!linha) throw recusa("NOT_FOUND", RECUSAS_DA_EQUIPE.agendaNaoEncontrada);
    if (linha.folderId === pastaId) return;
    await tx.update(agendaReunioes).set({ folderId: pastaId }).where(daDona);
    const pastaDaAuditoria = pastaId ?? linha.folderId;
    if (pastaDaAuditoria) await tx.insert(auditLogs).values(linhaDeAuditoria(prova, ACAO_AGENDA_DA_EQUIPE, pastaDaAuditoria, { agendaId, mudanca: pastaId ? "posta" : "tirada" }));
  });
}

/**
 * A pasta apagada leva a equipe (H7d + R2), na transação de apagarPasta: as
 * membras e os convites, as tarefas, e a agenda volta a não ter equipe.
 */
export async function apagarEquipeDaPasta(tx: Pick<Transacao, "delete" | "update">, ownerId: string, pastaId: string): Promise<void> {
  await tx.delete(meetingFolderMembers).where(and(eq(meetingFolderMembers.ownerId, ownerId), eq(meetingFolderMembers.folderId, pastaId)));
  await tx.delete(meetingFolderTasks).where(and(eq(meetingFolderTasks.ownerId, ownerId), eq(meetingFolderTasks.folderId, pastaId)));
  await tx.update(agendaReunioes).set({ folderId: null }).where(and(eq(agendaReunioes.ownerId, ownerId), eq(agendaReunioes.folderId, pastaId)));
}
