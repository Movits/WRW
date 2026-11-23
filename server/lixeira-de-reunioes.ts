import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { auditLogs, meetings } from "../drizzle/schema";
import { REUNIOES_POR_ACAO_MAX } from "@shared/pastas-de-reunioes";
import { dentroDoPrazoDaLixeira, podeIrParaALixeira, PRAZO_DA_LIXEIRA_MS, RECUSAS_DA_LIXEIRA, REUNIOES_POR_EXCLUSAO_MAX } from "@shared/lixeira-de-reunioes";
import { exigirDb } from "./db";
import { estaNaLixeira } from "./reuniao-visivel";
import { deletePrivateMeeting, MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { LINK_DESLIGADO } from "./link-aberto-da-reuniao";
import { apagarAvisosDaReuniao } from "./lembretes";

/**
 * A lixeira das reuniões (H7d do plano do gravador; HN-67 no app de referência
 * da cliente). É exclusão ADIADA:
 *
 * - **Mandar para a lixeira** grava `meetings.trashed_at` e, na mesma
 *   transação, desliga o link aberto (com a senha, como o "Desligar" da dona),
 *   tira os avisos da reunião do sino e grava MEETINGS_TRASHED. Desde então a
 *   reunião sai de toda consulta (server/reuniao-visivel.ts e a guarda dos
 *   procedimentos pelo id, server/guarda-da-lixeira.ts), e as filas não a
 *   pegam: o trabalho dela espera e volta se a dona a restaurar. O que já
 *   estava na IA termina e fica guardado nela, sem aparecer. Nada sai da
 *   reunião, e o updated_at (a ficha de quem a processa) não muda. A parte
 *   atrasada da gravação já encerrada ('uploading', a que a retomada do
 *   aparelho manda depois) entra e espera com ela (server/fatias-de-reuniao.ts).
 * - O **Excluir imediato** (meetings.delete, o do descarte da gravação) tira a
 *   reunião de vez também da lixeira: é o único procedimento pelo id sem a
 *   guarda, além dos da própria lixeira.
 * - **Restaurar**, dentro dos 30 dias (PRAZO_DA_LIXEIRA_MS), só apaga o
 *   trashed_at: a reunião volta como estava, na pasta dela (se a pasta ainda
 *   existe), com o link desligado. MEETINGS_RESTORED.
 * - **Apagar de vez** (uma, várias ou "Esvaziar a lixeira") e o fim dos 30 dias
 *   (a varredura, esvaziarLixeiraVencida) excluem pelo caminho de sempre,
 *   deletePrivateMeeting, que leva o áudio do bucket e todos os derivados.
 *
 * O áudio segue o próprio prazo (30 dias desde o envio, MEETING_AUDIO_TTL_MS):
 * a lixeira não o estende nem o encurta.
 */

export type ProvaDaLixeira = { userId: number; ipAddress: string; userAgent: string | null | undefined };

/** A recusa da lixeira, com o código tRPC e o código que a tela traduz. */
export class RecusaDaLixeira extends Error {
  constructor(readonly codigoTrpc: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT", codigo: string) {
    super(codigo);
    this.name = "RecusaDaLixeira";
  }
}

function idsDoPedido(idsPedidos: readonly string[], maximo = REUNIOES_POR_ACAO_MAX): string[] {
  const ids = Array.from(new Set(idsPedidos));
  if (!ids.length || ids.length > maximo) throw new RecusaDaLixeira("BAD_REQUEST", "LIXEIRA_PEDIDO_INVALIDO");
  return ids;
}

function ipDaProva(prova: ProvaDaLixeira) {
  return { ipAddress: prova.ipAddress.split(",")[0].trim().substring(0, 45), userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null };
}

/**
 * Manda as reuniões da dona para a lixeira, todas ou nenhuma: a de outra conta
 * (ou a que não existe, ou a que está sendo excluída) é NOT_FOUND, e a gravação
 * em partes ainda no ar é CONFLICT (LIXEIRA_GRAVANDO). A que já estava na
 * lixeira fica como estava (o prazo dela não recomeça). As linhas são travadas
 * na ordem do id, como na junção, para duas ações que dividem uma reunião não
 * se travarem em ordens opostas.
 */
export async function mandarParaALixeira(ownerId: string, idsPedidos: readonly string[], prova: ProvaDaLixeira) {
  const ids = idsDoPedido(idsPedidos);
  const db = await exigirDb();
  const agora = Date.now();
  return db.transaction(async tx => {
    const linhas = await tx.select({
      id: meetings.id, status: meetings.status, audioPipeline: meetings.audioPipeline, trashedAt: meetings.trashedAt, shareToken: meetings.shareToken,
    }).from(meetings).where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, ids))).orderBy(asc(meetings.id)).for("update");
    const vivas = linhas.filter(linha => linha.status !== "deleted");
    if (vivas.length !== ids.length) throw new RecusaDaLixeira("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    if (vivas.some(linha => !podeIrParaALixeira(linha))) throw new RecusaDaLixeira("CONFLICT", RECUSAS_DA_LIXEIRA.gravando);
    const novas = vivas.filter(linha => !estaNaLixeira(linha.trashedAt)).map(linha => linha.id);
    if (!novas.length) return { naLixeira: 0, linksDesligados: 0 };
    const linksDesligados = vivas.filter(linha => !estaNaLixeira(linha.trashedAt) && linha.shareToken !== null).map(linha => linha.id);
    // O link desligado como no "Desligar" da dona (LINK_DESLIGADO): sem token e
    // sem a senha. Restaurar não o religa: a dona liga de novo, com outro endereço.
    await tx.update(meetings).set({ trashedAt: agora, ...LINK_DESLIGADO })
      .where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, novas), isNull(meetings.trashedAt)));
    // O aviso de pronta (com o título) sai do sino: ele levaria à reunião que
    // agora é "não encontrada". Restaurar não o devolve.
    for (const id of novas) await apagarAvisosDaReuniao(tx, ownerId, id);
    await tx.insert(auditLogs).values({
      userId: prova.userId,
      action: "MEETINGS_TRASHED",
      resource: "meetings",
      resourceId: novas.length === 1 ? novas[0] : null,
      // Só ids: nenhum título, nome ou fala.
      details: { reunioes: novas, linksDesligados },
      ...ipDaProva(prova),
      status: "success",
      riskLevel: "low",
    });
    return { naLixeira: novas.length, linksDesligados: linksDesligados.length };
  });
}

/**
 * Tira as reuniões da lixeira, todas ou nenhuma: a que não é da dona (ou não
 * existe, ou está sendo excluída) é NOT_FOUND, e a que passou dos 30 dias é
 * CONFLICT (LIXEIRA_VENCIDA): a varredura está para excluí-la. A que não estava
 * na lixeira fica como estava.
 */
export async function restaurarDaLixeira(ownerId: string, idsPedidos: readonly string[], prova: ProvaDaLixeira) {
  const ids = idsDoPedido(idsPedidos);
  const db = await exigirDb();
  const agora = Date.now();
  return db.transaction(async tx => {
    const linhas = await tx.select({ id: meetings.id, status: meetings.status, trashedAt: meetings.trashedAt })
      .from(meetings).where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, ids))).orderBy(asc(meetings.id)).for("update");
    const vivas = linhas.filter(linha => linha.status !== "deleted");
    if (vivas.length !== ids.length) throw new RecusaDaLixeira("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const naLixeira = vivas.filter(linha => estaNaLixeira(linha.trashedAt));
    if (naLixeira.some(linha => !dentroDoPrazoDaLixeira(Number(linha.trashedAt), agora))) throw new RecusaDaLixeira("CONFLICT", RECUSAS_DA_LIXEIRA.vencida);
    if (!naLixeira.length) return { restauradas: 0 };
    const voltam = naLixeira.map(linha => linha.id);
    // O prazo se repete no WHERE: a varredura não exclui o que voltou, e o que
    // venceu entre a leitura e aqui não volta.
    await tx.update(meetings).set({ trashedAt: null }).where(and(
      eq(meetings.ownerId, ownerId), inArray(meetings.id, voltam), isNotNull(meetings.trashedAt), gt(meetings.trashedAt, agora - PRAZO_DA_LIXEIRA_MS),
    ));
    await tx.insert(auditLogs).values({
      userId: prova.userId,
      action: "MEETINGS_RESTORED",
      resource: "meetings",
      resourceId: voltam.length === 1 ? voltam[0] : null,
      details: { reunioes: voltam },
      ...ipDaProva(prova),
      status: "success",
      riskLevel: "low",
    });
    return { restauradas: voltam.length };
  });
}

/**
 * A lixeira da dona: as reuniões que ela mandou para lá e que ainda estão no
 * prazo, da mais recente na lixeira para a mais antiga. É a ÚNICA leitura da
 * lixeira, e só da própria dona: o título, a data, de onde veio e quando foi
 * para a lixeira (a tela mostra os dias que faltam). Nada de transcrição,
 * resumo ou link.
 */
export async function listarLixeira(ownerId: string, agora = Date.now()) {
  const db = await exigirDb();
  const linhas = await db.select({
    id: meetings.id, title: meetings.title, createdAt: meetings.createdAt, trashedAt: meetings.trashedAt,
    status: meetings.status, origem: meetings.origem, audioPipeline: meetings.audioPipeline,
  }).from(meetings).where(and(
    eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"), isNotNull(meetings.trashedAt), gt(meetings.trashedAt, agora - PRAZO_DA_LIXEIRA_MS),
  )).orderBy(desc(meetings.trashedAt), asc(meetings.id));
  return linhas.map(linha => ({ ...linha, createdAt: Number(linha.createdAt), trashedAt: Number(linha.trashedAt) }));
}

/**
 * Registra a exclusão sem volta de UMA reunião (o "Apagar de vez" e o
 * "Esvaziar a lixeira"), logo depois de ela sair: só o id. A exclusão não é
 * uma transação (deletePrivateMeeting tira o áudio do bucket), então a prova
 * vai por insert direto, que lança, uma linha por reunião antes da próxima
 * começar: a reunião que saiu nunca fica sem a linha dela porque outra do
 * mesmo pedido falhou depois, e a falha da auditoria derruba o pedido (a dona
 * vê o erro, e o log o registra) em vez de sumir no createAuditLog, que só a
 * escreve no console.
 */
async function auditarApagadaDeVez(db: Awaited<ReturnType<typeof exigirDb>>, prova: ProvaDaLixeira, id: string, acao: "MEETINGS_DELETED_FOREVER" | "MEETINGS_TRASH_EMPTIED") {
  await db.insert(auditLogs).values({
    userId: prova.userId, action: acao, resource: "meetings", resourceId: id,
    details: { reunioes: [id] }, ...ipDaProva(prova), status: "success", riskLevel: "low",
  });
}

/**
 * "Apagar de vez" na lixeira: só a reunião da dona que ESTÁ na lixeira (a de
 * fora, a de outra conta e a que não existe são NOT_FOUND, e nada sai). Cada
 * uma sai por deletePrivateMeeting, que só a toma se ela continuar na lixeira:
 * a que a dona restaurou no meio fica. Uma de cada vez, como o Excluir de
 * sempre: cada exclusão tira o áudio do bucket.
 */
export async function apagarDeVez(ownerId: string, idsPedidos: readonly string[], prova: ProvaDaLixeira) {
  const ids = idsDoPedido(idsPedidos, REUNIOES_POR_EXCLUSAO_MAX);
  const db = await exigirDb();
  const naLixeira = await db.select({ id: meetings.id }).from(meetings).where(and(
    eq(meetings.ownerId, ownerId), inArray(meetings.id, ids), ne(meetings.status, "deleted"), isNotNull(meetings.trashedAt),
  ));
  if (naLixeira.length !== ids.length) throw new RecusaDaLixeira("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  const apagadas: string[] = [];
  for (const id of ids) {
    if (!(await deletePrivateMeeting(ownerId, id, { soDaLixeira: true }))) continue;
    apagadas.push(id);
    await auditarApagadaDeVez(db, prova, id, "MEETINGS_DELETED_FOREVER");
  }
  return { apagadas: apagadas.length };
}

/**
 * "Esvaziar a lixeira": até REUNIOES_POR_EXCLUSAO_MAX reuniões por pedido, das
 * mais antigas na lixeira, e se ainda resta alguma (a tela pede de novo
 * enquanto restar).
 */
export async function esvaziarLixeira(ownerId: string, prova: ProvaDaLixeira) {
  const db = await exigirDb();
  const daLixeira = and(eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"), isNotNull(meetings.trashedAt));
  const lote = await db.select({ id: meetings.id }).from(meetings).where(daLixeira)
    .orderBy(asc(meetings.trashedAt), asc(meetings.id)).limit(REUNIOES_POR_EXCLUSAO_MAX);
  const apagadas: string[] = [];
  for (const { id } of lote) {
    if (!(await deletePrivateMeeting(ownerId, id, { soDaLixeira: true }))) continue;
    apagadas.push(id);
    await auditarApagadaDeVez(db, prova, id, "MEETINGS_TRASH_EMPTIED");
  }
  const [restantes] = await db.select({ id: meetings.id }).from(meetings).where(daLixeira).limit(1);
  return { apagadas: apagadas.length, restam: Boolean(restantes) };
}

/** Quantas reuniões vencidas a varredura exclui por passada, no máximo. */
export const LIXEIRA_VENCIDA_POR_PASSADA = 20;

export type ResultadoDaLixeiraVencida = { encontradas: number; apagadas: number };

/**
 * O fim dos 30 dias: a varredura (server/varredura-de-gravacoes.ts, no mesmo
 * laço do áudio vencido) exclui de vez a reunião que está na lixeira há mais do
 * que o prazo, pelo caminho de sempre. Varredura de SISTEMA, sem dona, como a
 * do áudio: não lê nem devolve dado de reunião além do id e da dona. A
 * exclusão só toma a reunião que continua na lixeira desde antes do corte, e
 * para entre uma reunião e outra quando o servidor está saindo (deveParar).
 * Banco fora do ar sobe como erro.
 *
 * Também a que já está 'deleted': o "Apagar de vez" que parou no meio (a
 * queda do banco depois da marca, antes de os derivados saírem) deixa a
 * reunião invisível para a dona (a lixeira e a lista não mostram 'deleted') e
 * fora do Esvaziar, com a transcrição e o resumo dentro. Só passado o prazo:
 * nenhum pedido de exclusão dura dias, então a varredura não corre ao lado de
 * um que ainda está em curso.
 */
export async function esvaziarLixeiraVencida(opcoes: { agora?: number; limite?: number; deveParar?: () => boolean } = {}): Promise<ResultadoDaLixeiraVencida> {
  const db = await exigirDb();
  const corte = (opcoes.agora ?? Date.now()) - PRAZO_DA_LIXEIRA_MS;
  const vencidas = await db.select({ id: meetings.id, ownerId: meetings.ownerId }).from(meetings)
    .where(and(isNotNull(meetings.trashedAt), lte(meetings.trashedAt, corte)))
    .orderBy(asc(meetings.trashedAt)).limit(opcoes.limite ?? LIXEIRA_VENCIDA_POR_PASSADA);
  let apagadas = 0;
  for (const { id, ownerId } of vencidas) {
    if (opcoes.deveParar?.()) break;
    if (await deletePrivateMeeting(ownerId, id, { naLixeiraAte: corte })) apagadas += 1;
  }
  return { encontradas: vencidas.length, apagadas };
}
