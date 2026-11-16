import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingSummaryTranslations } from "../drizzle/schema";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { conferirMapaMental, rotulosDoMapaMental } from "@shared/mapa-mental";
import { exigirDb } from "./db";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";

/**
 * O banco da tradução do resumo guardado (H11): o que server/traducao-do-resumo.ts
 * lê para decidir o que falta traduzir e onde grava o que a IA traduziu. Toda
 * consulta leva a dona no WHERE: reunião de outra dona é "não encontrada".
 * Banco fora do ar sobe como erro, nunca vira "sem resumo". O formato do
 * conteúdo guardado é do outro módulo: aqui ele passa como dado.
 */

type Item = typeof meetingSummaryItems.$inferSelect;

/**
 * Um item do resumo como a tradução o lê e devolve (o trecho vai junto, mas
 * nunca à IA). A origem e a marca da edição (H4f) também nunca vão à IA: o
 * link as recebe só como "escrito pela dona".
 */
export type ItemParaTraduzir = Pick<Item, "id" | "section" | "subject" | "text" | "assignee" | "due" | "excerpt" | "startSeconds" | "status" | "origin" | "editedAt">;

export type LeituraParaTraduzir =
  | { estado: "sem_resumo" }
  | { estado: "original" }
  | {
      estado: "pronto";
      resumoId: string;
      versao: number;
      idiomaOriginal: IdiomaDaReuniao;
      itens: ItemParaTraduzir[];
      rotulosDoMapa: string[];
      // O conteúdo guardado para este idioma, só se saiu deste resumo e desta versão.
      guardado: unknown;
      // O resumo está sendo refeito (H4d): vale só a tradução guardada, sem IA.
      soGuardada: boolean;
    };

/**
 * A versão do resumo que a tela mostra, como resumo-guardado.ts a define:
 * - "pronta": o resumo pronto, ou a versão anterior do refazer que falhou
 *   (H4d), que a dona segue decidindo e editando e o link segue mostrando;
 * - "so_guardada": a versão anterior, enquanto o refazer escreve a nova. Ela
 *   fica na tela, e a tradução guardada dela também; traduzir agora gastaria
 *   IA com itens que vão ser trocados;
 * - null: o primeiro resumo, ainda na fila ou que falhou, sem versão gravada.
 */
function versaoNaTela(status: string | null, versao: number | null): "pronta" | "so_guardada" | null {
  if (status === "ready") return "pronta";
  if (versao === null || versao <= 0) return null;
  if (status === "failed") return "pronta";
  return status === "pending" ? "so_guardada" : null;
}

/**
 * Os rótulos do mapa mental da reunião (H10), para traduzir junto com o
 * resumo: só os do mapa pronto, e só da árvore que ainda passa na conferência,
 * a mesma que a tela recebe (server/mapa-mental-guardado.ts). Sem mapa
 * pronto, não há rótulo a traduzir; o mapa que fica pronto depois pede a
 * tradução de novo pela tela, e o servidor traduz só os rótulos que faltam.
 */
function rotulosDoMapa(status: string | null, bruto: unknown): string[] {
  if (status !== "ready") return [];
  const mapa = conferirMapaMental(bruto);
  return mapa ? rotulosDoMapaMental(mapa) : [];
}

/**
 * O resumo que a tela mostra, de uma reunião pronta da dona (versaoNaTela),
 * com os itens (todos, também os ignorados, que a dona vê recolhidos) e a
 * tradução guardada para o idioma pedido. "original": o resumo já está nesse
 * idioma, não há o que traduzir.
 */
export async function lerResumoParaTraduzir(ownerId: string, meetingId: string, idioma: IdiomaDaReuniao): Promise<LeituraParaTraduzir> {
  const db = await exigirDb();
  const [linha] = await db.select({
    status: meetings.status,
    resumoId: meetingSummaries.id,
    statusDoResumo: meetingSummaries.status,
    versao: meetingSummaries.version,
    idiomaDoResumo: meetingSummaries.language,
    statusDoMapa: meetingSummaries.mindMapStatus,
    mapa: meetingSummaries.mindMap,
  }).from(meetings)
    .leftJoin(meetingSummaries, and(eq(meetingSummaries.meetingId, meetings.id), eq(meetingSummaries.ownerId, meetings.ownerId)))
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted")))
    .limit(1);
  if (!linha) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  // Em processamento, o resumo é da tentativa anterior e está para ser trocado:
  // traduzir agora gastaria IA com um texto que vai sumir.
  const naTela = linha.status === "ready" && linha.resumoId ? versaoNaTela(linha.statusDoResumo, linha.versao) : null;
  if (!naTela || !linha.resumoId || linha.versao === null) return { estado: "sem_resumo" };
  const idiomaOriginal = idiomaDaReuniao(linha.idiomaDoResumo) ?? IDIOMA_DA_REUNIAO_PADRAO;
  if (idiomaOriginal === idioma) return { estado: "original" };

  const itens = await db.select({
    id: meetingSummaryItems.id,
    section: meetingSummaryItems.section,
    subject: meetingSummaryItems.subject,
    text: meetingSummaryItems.text,
    assignee: meetingSummaryItems.assignee,
    due: meetingSummaryItems.due,
    excerpt: meetingSummaryItems.excerpt,
    startSeconds: meetingSummaryItems.startSeconds,
    status: meetingSummaryItems.status,
    origin: meetingSummaryItems.origin,
    editedAt: meetingSummaryItems.editedAt,
  }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.summaryId, linha.resumoId), eq(meetingSummaryItems.ownerId, ownerId)))
    .orderBy(asc(meetingSummaryItems.position));
  const [guardada] = await db.select({
    summaryId: meetingSummaryTranslations.summaryId,
    sourceVersion: meetingSummaryTranslations.sourceVersion,
    content: meetingSummaryTranslations.content,
  }).from(meetingSummaryTranslations)
    .where(and(
      eq(meetingSummaryTranslations.ownerId, ownerId),
      eq(meetingSummaryTranslations.meetingId, meetingId),
      eq(meetingSummaryTranslations.language, idioma),
    )).limit(1);
  const valeAinda = !!guardada && guardada.summaryId === linha.resumoId && guardada.sourceVersion === linha.versao;
  return {
    estado: "pronto",
    resumoId: linha.resumoId,
    versao: linha.versao,
    idiomaOriginal,
    itens,
    rotulosDoMapa: rotulosDoMapa(linha.statusDoMapa, linha.mapa),
    guardado: valeAinda ? guardada.content : null,
    soGuardada: naTela === "so_guardada",
  };
}

/**
 * Grava a tradução de um resumo, numa transação que trava a reunião, como a
 * gravação do resumo (server/fila-do-resumo.ts): a exclusão e o reprocessamento
 * esperam, e o que for gravado aqui sai junto com os outros derivados. Nada é
 * gravado (devolve false) se a reunião saiu de 'ready' ou se o resumo mudou
 * (refeito, reprocessado ou apagado) enquanto a IA traduzia: seria a tradução de
 * um texto que não existe mais. O resumo do refazer que falhou (H4d) aceita a
 * gravação, como o pronto: é a versão que vale na tela. `montar` recebe o
 * conteúdo guardado desta mesma versão (ou null) e devolve o que fica.
 */
export async function gravarTraducaoDoResumo(
  alvo: { ownerId: string; meetingId: string; idioma: IdiomaDaReuniao; resumoId: string; versao: number },
  montar: (guardado: unknown) => unknown,
  modelo: string | null,
): Promise<boolean> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, alvo.meetingId), eq(meetings.ownerId, alvo.ownerId))).for("update");
    if (reuniao?.status !== "ready") return false;
    const [resumo] = await tx.select({ id: meetingSummaries.id, status: meetingSummaries.status, versao: meetingSummaries.version })
      .from(meetingSummaries)
      .where(and(eq(meetingSummaries.meetingId, alvo.meetingId), eq(meetingSummaries.ownerId, alvo.ownerId))).for("update");
    if (!resumo || resumo.id !== alvo.resumoId || resumo.versao !== alvo.versao || versaoNaTela(resumo.status, resumo.versao) !== "pronta") return false;

    const daTraducao = and(
      eq(meetingSummaryTranslations.ownerId, alvo.ownerId),
      eq(meetingSummaryTranslations.meetingId, alvo.meetingId),
      eq(meetingSummaryTranslations.language, alvo.idioma),
    );
    const [atual] = await tx.select({
      summaryId: meetingSummaryTranslations.summaryId,
      sourceVersion: meetingSummaryTranslations.sourceVersion,
      content: meetingSummaryTranslations.content,
    }).from(meetingSummaryTranslations).where(daTraducao).for("update");
    // A tradução de outra versão do resumo não se aproveita: os itens dela são outros.
    const content = montar(atual && atual.summaryId === alvo.resumoId && atual.sourceVersion === alvo.versao ? atual.content : null);
    const agora = Date.now();
    if (atual) {
      await tx.update(meetingSummaryTranslations).set({
        summaryId: alvo.resumoId, sourceVersion: alvo.versao, content, ...(modelo ? { model: modelo } : {}), updatedAt: agora,
      }).where(daTraducao);
    } else {
      await tx.insert(meetingSummaryTranslations).values({
        id: crypto.randomUUID(), summaryId: alvo.resumoId, meetingId: alvo.meetingId, ownerId: alvo.ownerId, language: alvo.idioma,
        sourceVersion: alvo.versao, content, model: modelo, createdAt: agora, updatedAt: agora,
      });
    }
    return true;
  });
}
