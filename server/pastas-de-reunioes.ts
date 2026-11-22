import crypto from "crypto";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { meetingFolders, meetings, users } from "../drizzle/schema";
import {
  chaveDoNomeDaPasta, corDaPasta, iconeDaPasta, normalizarNomeDaPasta, PASTAS_POR_DONA_MAX, RECUSAS_DAS_PASTAS, REUNIOES_POR_ACAO_MAX,
  type CorDaPasta, type IconeDaPasta,
} from "@shared/pastas-de-reunioes";
import { exigirDb } from "./db";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * As pastas das reuniões (H7d do plano do gravador; HN-67 no app de referência
 * da cliente): nome, ícone e cor, e as reuniões da dona dentro delas
 * (meetings.folder_id). Tudo pela dona: a pasta de outra conta é "não
 * encontrada", como a que não existe, e nenhuma consulta daqui lê reunião ou
 * pasta de outra conta. A reunião na lixeira não entra nem sai de pasta e não
 * conta no número da pasta (reuniaoVisivel); ela guarda a pasta e volta para
 * ela ao ser restaurada, se a pasta ainda existir. Mover não mexe no
 * updated_at da reunião, que é a ficha de quem a processa.
 */

/** A recusa das pastas, com o código tRPC e o código que a tela traduz (RECUSAS_DAS_PASTAS). */
export class RecusaDaPasta extends Error {
  constructor(readonly codigoTrpc: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED", codigo: string) {
    super(codigo);
    this.name = "RecusaDaPasta";
  }
}

export type PastaDaDona = { id: string; nome: string; icone: IconeDaPasta; cor: CorDaPasta; reunioes: number; createdAt: number };

/** As pastas da dona, na ordem em que nasceram, com quantas reuniões (fora da lixeira) cada uma tem. */
export async function listarPastas(ownerId: string): Promise<PastaDaDona[]> {
  const db = await exigirDb();
  const pastas = await db.select({
    id: meetingFolders.id, nome: meetingFolders.name, icone: meetingFolders.icon, cor: meetingFolders.color, createdAt: meetingFolders.createdAt,
  }).from(meetingFolders).where(eq(meetingFolders.ownerId, ownerId)).orderBy(asc(meetingFolders.createdAt), asc(meetingFolders.id));
  if (!pastas.length) return [];
  const contagens = await db.select({ pasta: meetings.folderId, total: count() }).from(meetings)
    .where(and(eq(meetings.ownerId, ownerId), isNotNull(meetings.folderId), reuniaoVisivel()))
    .groupBy(meetings.folderId);
  const porPasta = new Map(contagens.map(linha => [linha.pasta, Number(linha.total)]));
  return pastas.map(pasta => ({
    id: pasta.id, nome: pasta.nome, icone: iconeDaPasta(pasta.icone), cor: corDaPasta(pasta.cor),
    reunioes: porPasta.get(pasta.id) ?? 0, createdAt: Number(pasta.createdAt),
  }));
}

type Transacao = Parameters<Parameters<Awaited<ReturnType<typeof exigirDb>>["transaction"]>[0]>[0];

/**
 * Trava a conta da dona até o fim da transação: duas pastas criadas ao mesmo
 * tempo (duas abas, o duplo toque) não passam juntas pelo teto nem pelo nome
 * repetido.
 */
async function travarAConta(tx: Transacao, ownerId: string) {
  await tx.select({ id: users.id }).from(users).where(eq(users.openId, ownerId)).for("update");
}

async function conferirNomeLivre(tx: Transacao, ownerId: string, nome: string, salvo?: string) {
  const chave = chaveDoNomeDaPasta(nome);
  const outras = await tx.select({ id: meetingFolders.id, nome: meetingFolders.name }).from(meetingFolders).where(eq(meetingFolders.ownerId, ownerId));
  if (outras.some(outra => outra.id !== salvo && chaveDoNomeDaPasta(outra.nome) === chave)) {
    throw new RecusaDaPasta("CONFLICT", RECUSAS_DAS_PASTAS.nomeRepetido);
  }
}

function nomeOuRecusa(nome: string): string {
  const normalizado = normalizarNomeDaPasta(nome);
  if (!normalizado) throw new RecusaDaPasta("BAD_REQUEST", RECUSAS_DAS_PASTAS.nomeInvalido);
  return normalizado;
}

/** Cria a pasta. Recusas: o nome vazio, o nome repetido e o teto de pastas da dona. */
export async function criarPasta(ownerId: string, dados: { nome: string; icone: IconeDaPasta; cor: CorDaPasta }): Promise<{ id: string }> {
  const nome = nomeOuRecusa(dados.nome);
  const db = await exigirDb();
  const agora = Date.now();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    await travarAConta(tx, ownerId);
    const [contagem] = await tx.select({ total: count() }).from(meetingFolders).where(eq(meetingFolders.ownerId, ownerId));
    if (Number(contagem?.total ?? 0) >= PASTAS_POR_DONA_MAX) throw new RecusaDaPasta("PRECONDITION_FAILED", RECUSAS_DAS_PASTAS.demais);
    await conferirNomeLivre(tx, ownerId, nome);
    await tx.insert(meetingFolders).values({ id, ownerId, name: nome, icon: dados.icone, color: dados.cor, createdAt: agora, updatedAt: agora });
  });
  return { id };
}

/** Muda o nome, o ícone ou a cor da pasta da dona; campo ausente não muda. */
export async function editarPasta(ownerId: string, pastaId: string, dados: { nome?: string; icone?: IconeDaPasta; cor?: CorDaPasta }): Promise<void> {
  const nome = dados.nome === undefined ? undefined : nomeOuRecusa(dados.nome);
  const db = await exigirDb();
  await db.transaction(async tx => {
    await travarAConta(tx, ownerId);
    const daDona = and(eq(meetingFolders.id, pastaId), eq(meetingFolders.ownerId, ownerId));
    const [pasta] = await tx.select({ id: meetingFolders.id }).from(meetingFolders).where(daDona).limit(1);
    if (!pasta) throw new RecusaDaPasta("NOT_FOUND", RECUSAS_DAS_PASTAS.naoEncontrada);
    if (nome !== undefined) await conferirNomeLivre(tx, ownerId, nome, pastaId);
    await tx.update(meetingFolders).set({
      ...(nome !== undefined ? { name: nome } : {}),
      ...(dados.icone !== undefined ? { icon: dados.icone } : {}),
      ...(dados.cor !== undefined ? { color: dados.cor } : {}),
      updatedAt: Date.now(),
    }).where(daDona);
  });
}

/**
 * Apaga a pasta da dona. As reuniões dela NÃO saem: ficam sem pasta, na mesma
 * transação (também as que estão na lixeira, que voltariam a uma pasta que não
 * existe mais).
 */
export async function apagarPasta(ownerId: string, pastaId: string): Promise<{ soltas: number }> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const daDona = and(eq(meetingFolders.id, pastaId), eq(meetingFolders.ownerId, ownerId));
    const [pasta] = await tx.select({ id: meetingFolders.id }).from(meetingFolders).where(daDona).limit(1).for("update");
    if (!pasta) throw new RecusaDaPasta("NOT_FOUND", RECUSAS_DAS_PASTAS.naoEncontrada);
    const soltas = await tx.update(meetings).set({ folderId: null }).where(and(eq(meetings.ownerId, ownerId), eq(meetings.folderId, pastaId)));
    await tx.delete(meetingFolders).where(daDona);
    return { soltas: linhasAfetadas(soltas) };
  });
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return Number((cabecalho as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * Põe as reuniões da dona numa pasta dela, ou as tira de pasta (`pastaId`
 * nulo), todas ou nenhuma: a pasta de outra conta é PASTA_NAO_ENCONTRADA, e a
 * reunião de outra conta, a que não existe, a excluída e a da lixeira são
 * "não encontrada". A pasta fica travada até o fim, para não ser apagada no
 * meio e deixar reuniões apontando para nada.
 */
export async function moverParaPasta(ownerId: string, idsPedidos: readonly string[], pastaId: string | null): Promise<{ movidas: number }> {
  const ids = Array.from(new Set(idsPedidos));
  if (!ids.length || ids.length > REUNIOES_POR_ACAO_MAX) throw new RecusaDaPasta("BAD_REQUEST", "PASTA_PEDIDO_INVALIDO");
  const db = await exigirDb();
  return db.transaction(async tx => {
    if (pastaId !== null) {
      const [pasta] = await tx.select({ id: meetingFolders.id }).from(meetingFolders)
        .where(and(eq(meetingFolders.id, pastaId), eq(meetingFolders.ownerId, ownerId))).limit(1).for("update");
      if (!pasta) throw new RecusaDaPasta("NOT_FOUND", RECUSAS_DAS_PASTAS.naoEncontrada);
    }
    const daDona = and(eq(meetings.ownerId, ownerId), inArray(meetings.id, ids), reuniaoVisivel());
    const achadas = await tx.select({ id: meetings.id }).from(meetings).where(daDona).orderBy(asc(meetings.id)).for("update");
    if (achadas.length !== ids.length) throw new RecusaDaPasta("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    await tx.update(meetings).set({ folderId: pastaId }).where(daDona);
    return { movidas: achadas.length };
  });
}
