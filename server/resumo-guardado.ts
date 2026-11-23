import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, max, ne, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { reuniaoForaDeVista, reuniaoVisivel } from "./reuniao-visivel";
import { exigirReuniaoDoLink } from "./link-aberto-da-reuniao";
import { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { MODELO_DE_RESUMO_PADRAO, modeloDeResumo, type ModeloDeResumo } from "@shared/modelos-de-resumo";
import { ITENS_DO_RESUMO_MAX, secaoTemAssunto, secaoTemResponsavel, type SecaoDoItem } from "@shared/item-do-resumo";
import { mesmoTitulo, tituloSugeridoValido } from "@shared/titulo-sugerido";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { MENSAGEM_SEM_TRANSCRICAO } from "./reuniao-com-ia";
import { apagarAcaoDoItem, criarDoItem, escreverFeita, garantirAcoesDosItensConfirmados, levarEdicaoDoItemAAcao, type Executor } from "./proximas-acoes";
import { transcricaoEstaEditada, trechosNaTranscricaoDeAgora } from "./editar-transcricao";
import { consultasDoComplemento, fonteDoComplemento } from "@shared/complemento-pela-busca";

/** As colunas do complemento pela busca (H4i), lidas com o item. */
const COLUNAS_DO_COMPLEMENTO = {
  complementText: meetingSummaryItems.complementText,
  complementSourceUrl: meetingSummaryItems.complementSourceUrl,
  complementSourceTitle: meetingSummaryItems.complementSourceTitle,
  complementQueries: meetingSummaryItems.complementQueries,
  complementStatus: meetingSummaryItems.complementStatus,
};
type ColunasDoComplemento = {
  complementText: string | null; complementSourceUrl: string | null; complementSourceTitle: string | null;
  complementQueries: unknown; complementStatus: string | null;
};
export type ComplementoNaTela = { texto: string; fonte: string | null; titulo: string | null; consultas: string[]; situacao: "pending" | "confirmed" };

/**
 * O complemento pela busca (H4i) como a tela o recebe. A dona vê o que espera
 * a decisão e o confirmado; o link aberto, só o confirmado (`soConfirmado`), sem
 * as consultas. A fonte passa de novo pela conferência (só https).
 */
export function complementoNaTela(linha: ColunasDoComplemento, soConfirmado: boolean): ComplementoNaTela | null {
  const situacao = linha.complementStatus === "confirmed" ? "confirmed" : linha.complementStatus === "pending" ? "pending" : null;
  if (!situacao || !linha.complementText || (soConfirmado && situacao !== "confirmed")) return null;
  return {
    texto: linha.complementText,
    fonte: fonteDoComplemento(linha.complementSourceUrl),
    titulo: linha.complementSourceTitle,
    consultas: soConfirmado ? [] : consultasDoComplemento(linha.complementQueries),
    situacao,
  };
}

/**
 * O resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), como a tela o lê e o decide. Quem
 * gera é a fila do resumo (server/fila-do-resumo.ts); aqui só se pede, lê e
 * decide. Toda consulta leva a dona no WHERE: reunião de outra dona é "não
 * encontrada". Banco fora do ar sobe como erro, nunca vira "sem resumo".
 */

export type EstadoDoResumo = "sem_resumo" | "pendente" | "gerando" | "pronto" | "falhou";
type Banco = Awaited<ReturnType<typeof exigirDb>>;

// As frases das recusas moram em shared/const.ts: a tela as reconhece pelo
// texto exato para traduzi-las.
export { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA };

// "Gerando" só com uma reserva viva: na espera depois de uma falha passageira a
// linha também tem prazo no futuro, mas ninguém está gerando.
function estadoDe(linha: { status: string; lockedUntil: number | null; lockToken: string | null } | undefined, agora: number): EstadoDoResumo {
  if (!linha) return "sem_resumo";
  if (linha.status === "ready") return "pronto";
  if (linha.status === "failed") return "falhou";
  return linha.lockToken && linha.lockedUntil !== null && Number(linha.lockedUntil) > agora ? "gerando" : "pendente";
}

const COLUNAS_DO_RESUMO = {
  id: meetingSummaries.id,
  status: meetingSummaries.status,
  lockedUntil: meetingSummaries.lockedUntil,
  lockToken: meetingSummaries.lockToken,
  emoji: meetingSummaries.emoji,
  language: meetingSummaries.language,
  lastError: meetingSummaries.lastError,
  template: meetingSummaries.template,
  version: meetingSummaries.version,
  // Quando a fila gravou a versão de agora: a transcrição editada depois disso
  // (H18) faz a tela oferecer "Refazer o resumo".
  generatedAt: meetingSummaries.generatedAt,
  // Se a transcrição que essa versão leu estava editada (nulo: de antes da H18,
  // leu a da IA): voltar tudo ao original devolve a que ela leu.
  transcriptEdited: meetingSummaries.transcriptEdited,
  // O título que a IA sugere (só para a dona; o link não o recebe).
  suggestedTitle: meetingSummaries.suggestedTitle,
  suggestedTitleStatus: meetingSummaries.suggestedTitleStatus,
};

/**
 * O resumo que já teve uma versão gravada e não está pronto: está sendo
 * refeito ("Refazer como…", H4d) ou o refazer falhou. Os itens no banco são
 * os da versão anterior, que segue valendo até a nova ser gravada: a dona e o
 * link continuam a vê-la. A versão sobe só quando a fila grava um resumo:
 * fora de 'ready', versão acima de zero quer dizer que houve uma. Editar e
 * acrescentar (H4f) não a sobem (ver editarItemDoResumo).
 */
function temVersaoAnterior(linha: { status: string; version: number } | undefined): boolean {
  return !!linha && linha.status !== "ready" && linha.version > 0;
}

/**
 * Decidir só sobre o resumo que não está na fila: o pronto ou o que falhou.
 * Na fila, os itens vão ser trocados pela versão nova. No refazer que falhou
 * (H4d), nenhuma geração está em curso e a versão anterior segue valendo: a
 * dona confirma, ignora e marca, e o próximo refazer guarda o que ela
 * confirmar.
 */
const foraDaFila = (status: string) => status === "ready" || status === "failed";

/**
 * A reunião da dona, não apagada e fora da lixeira (H7d), ou NOT_FOUND. O mapa mental
 * (server/mapa-mental-guardado.ts) usa a mesma. `travar`: numa transação, a
 * linha fica presa até o fim dela, e o estado lido é o mais novo.
 */
export async function reuniaoDaDona(db: Executor, ownerId: string, meetingId: string, travar = false) {
  const consulta = db.select({ status: meetings.status, title: meetings.title }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
  const [reuniao] = await (travar ? consulta.for("update") : consulta);
  if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  return reuniao;
}

async function linhaDoResumo(db: Executor, ownerId: string, meetingId: string, travar = false) {
  const consulta = db.select(COLUNAS_DO_RESUMO).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1);
  const [linha] = await (travar ? consulta.for("update") : consulta);
  return linha;
}

/**
 * O resumo da reunião para a dona: o estado, o modelo e todos os itens, na
 * ordem do formato (os ignorados também, que a tela recolhe e deixa desfazer).
 * Enquanto o resumo é refeito com outro modelo (H4d), ou se a nova versão
 * falhou, os itens são os da versão anterior (`versaoAnterior`): enquanto a
 * nova é escrita, a tela os mostra só para ler, porque decidir é recusado até
 * ela chegar; se a nova falhou, a dona segue decidindo sobre a anterior.
 */
export async function resumoGuardadoDaDona(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  const linha = await linhaDoResumo(db, ownerId, meetingId);
  const estado = estadoDe(linha, Date.now());
  const lidos = linha
    ? await db.select({
      id: meetingSummaryItems.id,
      section: meetingSummaryItems.section,
      position: meetingSummaryItems.position,
      subject: meetingSummaryItems.subject,
      text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee,
      due: meetingSummaryItems.due,
      excerpt: meetingSummaryItems.excerpt,
      startSeconds: meetingSummaryItems.startSeconds,
      status: meetingSummaryItems.status,
      done: meetingSummaryItems.done,
      // Quem escreveu e se a dona editou (H4f): a tela marca o que é dela.
      origin: meetingSummaryItems.origin,
      editedAt: meetingSummaryItems.editedAt,
      ...COLUNAS_DO_COMPLEMENTO,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, ownerId)))
      .orderBy(asc(meetingSummaryItems.position))
    : [];
  const itens = lidos.map(({ complementText, complementSourceUrl, complementSourceTitle, complementQueries, complementStatus, ...item }) =>
    ({ ...item, complemento: complementoNaTela({ complementText, complementSourceUrl, complementSourceTitle, complementQueries, complementStatus }, false) }));
  return {
    estado, emoji: linha?.emoji ?? null, idioma: linha?.language ?? null, modelo: linha ? modeloDeResumo(linha.template) ?? MODELO_DE_RESUMO_PADRAO : null,
    erro: estado === "falhou" ? linha?.lastError ?? null : null, versaoAnterior: temVersaoAnterior(linha), itens,
    tituloSugerido: tituloSugeridoNaTela(estado, linha, reuniao.title),
    transcricaoEditadaDepois: await transcricaoEditadaDepoisDoResumo(db, ownerId, meetingId, linha),
  };
}

/**
 * A dona mudou a transcrição (H18) depois que a fila gravou a versão de agora
 * do resumo: os itens e o mapa mental saíram da versão anterior, e a tela
 * oferece "Refazer o resumo". Só com uma versão gravada e fora da fila: o
 * resumo na fila (o primeiro, ou o refazer pedido) já vai ler a versão nova. A edição trava a reunião antes de
 * pegar a hora, como a gravação do resumo: a que chega depois do resumo gravado
 * tem sempre a hora maior (server/editar-transcricao.ts).
 *
 * Mudar depois do resumo não basta: a versão da IA é uma só. O resumo que leu
 * a versão da IA (transcript_edited falso, ou nulo no resumo de antes da H18)
 * diante da transcrição que voltou inteira a ela ("Voltar tudo ao original",
 * ou o único trecho mudado de volta) leu o que está na tela: o aviso não sai,
 * e a dona não gasta uma chamada à IA por nada. O resumo que leu uma versão
 * editada continua de outra versão diante de qualquer mudança depois dele,
 * mesmo a volta ao original.
 */
async function transcricaoEditadaDepoisDoResumo(
  db: Executor, ownerId: string, meetingId: string,
  linha: { status: string; version: number; generatedAt: number | null; transcriptEdited: boolean | null } | undefined,
): Promise<boolean> {
  // Na fila (o refazer pedido), a versão nova já vai ler a transcrição editada.
  if (!linha || linha.status === "pending" || !linha.version || linha.generatedAt === null) return false;
  const [transcricao] = await db.select({ editadaEm: meetingTranscripts.editedAt, editada: transcricaoEstaEditada }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  if (transcricao?.editadaEm == null || Number(transcricao.editadaEm) <= Number(linha.generatedAt)) return false;
  return linha.transcriptEdited === true || Number(transcricao.editada) === 1;
}

/**
 * O título que a IA sugeriu, enquanto espera a dona: só com o resumo pronto,
 * só a sugestão pendente e só quando ela é outro título (a igual ao de agora
 * não pede nada). Passa de novo pela conferência: a linha antiga, gravada sem
 * ela, não chega à tela fora da regra.
 */
function tituloSugeridoNaTela(estado: EstadoDoResumo, linha: { suggestedTitle: string | null; suggestedTitleStatus: string | null } | undefined, tituloAtual: string): string | null {
  if (estado !== "pronto" || linha?.suggestedTitleStatus !== "pending") return null;
  const titulo = tituloSugeridoValido(linha.suggestedTitle);
  return titulo && !mesmoTitulo(titulo, tituloAtual) ? titulo : null;
}

/**
 * Pede o resumo de uma reunião pronta: cria o trabalho para a fila, ou reabre
 * o que falhou. Resumo pendente ou pronto não muda. `antesDeCriar` roda só
 * quando há trabalho novo (é o teto de pedidos à IA, que pode recusar
 * lançando, e devolve como soltar a vaga): pedir de novo o que já está na fila
 * não gasta vaga, e o pedido que perdeu a corrida para outro igual a devolve.
 *
 * Com o modelo (H4d), o resumo novo nasce nele, e o que falhou reabre nele.
 * Com `refazer`, também o resumo pronto volta à fila no modelo pedido: os
 * itens ficam onde estão até a versão nova ser gravada, e a fila guarda os
 * confirmados e os feitos (server/fila-do-resumo.ts). Refazer em outro modelo
 * o resumo que ainda está na fila é conflito: o modelo da geração em curso não
 * muda no meio; no mesmo modelo, é o pedido repetido e não muda nada.
 *
 * Pelo link (`peloLink`), só o primeiro resumo que falhou reabre. O refazer
 * que falhou é da dona: reabri-lo gastaria a vaga do link e trocaria os itens
 * que ela ainda não conferiu. O pedido não muda nada, e o link segue mostrando
 * a versão anterior.
 *
 * O pedido do mapa mental passa por aqui quando ainda não há resumo pronto: o
 * mapa vem com ele.
 */
export type AntesDeCriar = () => (() => void) | void;
export async function pedirResumoDaReuniao(db: Banco, ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar, pedido: { modelo?: ModeloDeResumo; refazer?: boolean; peloLink?: boolean } = {}) {
  const [transcricao] = await db.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  if (!transcricao) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  const linha = await linhaDoResumo(db, ownerId, meetingId);
  const agora = Date.now();
  if (!linha) {
    const soltarVaga = antesDeCriar();
    try {
      await db.insert(meetingSummaries).values({
        id: crypto.randomUUID(), meetingId, ownerId, status: "pending", template: pedido.modelo ?? MODELO_DE_RESUMO_PADRAO, createdAt: agora, updatedAt: agora,
      });
    } catch (erro) {
      // Outro pedido criou o trabalho entre a leitura e aqui (índice único por
      // reunião): o trabalho existe, que é o que se queria, e a vaga volta.
      if (!ehChaveRepetida(erro)) throw erro;
      soltarVaga?.();
    }
  } else if (pedido.peloLink && linha.status === "failed" && temVersaoAnterior(linha)) {
    // O refazer que falhou é da dona (ver acima): nada muda, nem a vaga.
    return;
  } else if (linha.status === "failed" || (pedido.refazer && linha.status === "ready")) {
    const soltarVaga = antesDeCriar();
    const r = await db.update(meetingSummaries).set({
      status: "pending", ...(pedido.modelo ? { template: pedido.modelo } : {}),
      attempts: 0, lastError: null, lockedUntil: null, lockToken: null, updatedAt: agora,
    }).where(and(eq(meetingSummaries.id, linha.id), eq(meetingSummaries.ownerId, ownerId), eq(meetingSummaries.status, linha.status)));
    // Outro pedido reabriu (ou refez) antes: a vaga volta.
    if (!linhasAfetadas(r)) soltarVaga?.();
  } else if (pedido.refazer && pedido.modelo && linha.status === "pending" && linha.template !== pedido.modelo) {
    throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  }
}

/** O MySQL recusou por índice único (ER_DUP_ENTRY), no erro ou na causa dele (o drizzle embrulha o do driver). */
function ehChaveRepetida(erro: unknown): boolean {
  for (let atual: unknown = erro, i = 0; atual && i < 5; atual = (atual as { cause?: unknown }).cause, i++) {
    if ((atual as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

/**
 * A dona pede (ou pede de novo, depois de uma falha) o resumo de uma reunião
 * pronta, no modelo que escolheu; sem modelo, o resumo novo é o Geral e o que
 * falhou reabre no modelo em que estava.
 */
export async function pedirResumoDaDona(ownerId: string, meetingId: string, antesDeCriar: AntesDeCriar, modelo?: ModeloDeResumo) {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  if (reuniao.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  await pedirResumoDaReuniao(db, ownerId, meetingId, antesDeCriar, { modelo });
  return resumoGuardadoDaDona(ownerId, meetingId);
}

/**
 * "Refazer como…" (H4d): a dona manda refazer o resumo da reunião pronta em
 * outro modelo (ou no mesmo, para uma versão nova). Os itens que ela confirmou,
 * as ações feitas e os itens que ela escreveu ou editou (H4f), mesmo ignorados,
 * ficam; os outros pendentes e ignorados são trocados quando a fila gravar a
 * versão nova. Gasta uma vaga do teto, como pedir o resumo.
 */
export async function refazerResumoDaDona(ownerId: string, meetingId: string, modelo: ModeloDeResumo, antesDeCriar: AntesDeCriar) {
  const db = await exigirDb();
  const reuniao = await reuniaoDaDona(db, ownerId, meetingId);
  if (reuniao.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
  await pedirResumoDaReuniao(db, ownerId, meetingId, antesDeCriar, { modelo, refazer: true });
  return resumoGuardadoDaDona(ownerId, meetingId);
}

/**
 * O item da dona e o estado do resumo dele. Só se decide sobre o resumo fora
 * da fila (pronto, ou o refazer que falhou) de reunião pronta: enquanto o
 * resumo é refeito, os itens vão ser trocados.
 *
 * Roda na transação da decisão e trava a reunião, o resumo e o item até o fim
 * dela, nesta ordem (a da fila do resumo, server/fila-do-resumo.ts). A
 * exclusão, que marca a reunião 'deleted' antes de apagar, espera a decisão, e
 * a próxima ação que a decisão criar (H5a) se solta com os outros derivados.
 * Os estados vêm das leituras travadas, que leem a versão mais nova da linha:
 * o do item decide o que o Desfazer devolve (estadoDaDecisao).
 */
async function itemParaDecidir(db: Executor, ownerId: string, itemId: string) {
  const [onde] = await db.select({ summaryId: meetingSummaryItems.summaryId, meetingId: meetingSummaryItems.meetingId }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
  if (!onde) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  const [reuniao] = await db.select({ status: meetings.status, trashedAt: meetings.trashedAt }).from(meetings)
    .where(and(eq(meetings.id, onde.meetingId), eq(meetings.ownerId, ownerId))).for("update");
  const [resumo] = await db.select({ status: meetingSummaries.status }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.id, onde.summaryId), eq(meetingSummaries.ownerId, ownerId))).for("update");
  if (!reuniao || !resumo || reuniaoForaDeVista(reuniao)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  if (!foraDaFila(resumo.status) || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  const [item] = await db.select({
    id: meetingSummaryItems.id,
    section: meetingSummaryItems.section,
    status: meetingSummaryItems.status,
    origin: meetingSummaryItems.origin,
    editedAt: meetingSummaryItems.editedAt,
    // O feito e o estado de antes do Ignorar: o Desfazer volta a ele.
    done: meetingSummaryItems.done,
    doneAt: meetingSummaryItems.doneAt,
    statusBeforeIgnore: meetingSummaryItems.statusBeforeIgnore,
    doneAtBeforeIgnore: meetingSummaryItems.doneAtBeforeIgnore,
  }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1).for("update");
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  return item;
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * O item que a dona escreveu, acrescentado ou editado (H4f), não volta a
 * "para conferir": não há o que conferir na palavra dela, e o link aberto
 * mostraria o aviso de que a IA o gerou. Desfazer o ignorar o devolve
 * confirmado.
 */
function escritoPelaDona(item: { origin: string; editedAt: number | null }): boolean {
  return item.origin === "owner" || item.editedAt !== null;
}

type DecisaoDoItem = "pending" | "confirmed" | "ignored";

/**
 * O que a decisão grava no item. Ignorar guarda o estado de antes (o status e
 * a hora do feito; ignorar de novo não o apaga). O Desfazer da tela pede
 * 'pending' para o item ignorado e volta a esse estado: a ação confirmada e
 * feita volta confirmada e feita (H4f: o Ignorar do formulário vale também
 * para o item já confirmado). O ignorado sem estado guardado volta pendente.
 * O item escrito pela dona nunca volta a "para conferir". Fora do Desfazer,
 * item que deixa de estar confirmado perde a marca de feito: só ação
 * confirmada se marca.
 */
function estadoDaDecisao(item: Awaited<ReturnType<typeof itemParaDecidir>>, pedido: DecisaoDoItem, agora: number) {
  if (pedido === "ignored") {
    return {
      status: pedido,
      decidedAt: agora,
      done: false,
      doneAt: null,
      ...(item.status === "ignored" ? {} : { statusBeforeIgnore: item.status, doneAtBeforeIgnore: item.done ? item.doneAt ?? agora : null }),
    };
  }
  const desfazer = pedido === "pending" && item.status === "ignored";
  const voltaPara = desfazer ? item.statusBeforeIgnore ?? "pending" : pedido;
  const status = voltaPara === "pending" && escritoPelaDona(item) ? "confirmed" : voltaPara;
  const feitoEm = desfazer && status === "confirmed" ? item.doneAtBeforeIgnore ?? null : null;
  return {
    status,
    decidedAt: status === "pending" ? null : agora,
    ...(status !== "confirmed" ? { done: false, doneAt: null } : feitoEm !== null ? { done: true, doneAt: feitoEm } : {}),
    statusBeforeIgnore: null,
    doneAtBeforeIgnore: null,
  };
}

/**
 * Confirma, ignora ou volta a pendente um item do resumo (o estado gravado
 * está em estadoDaDecisao).
 *
 * A próxima ação (H5a) acompanha o estado que fica gravado, e não o pedido,
 * na mesma transação: o item que fica confirmado tem a ação (o confirmado
 * agora a ganha; o escrito pela dona, que o pedido de "para conferir" deixa
 * confirmado, fica com a dele, com o prazo, o contato e o evento; o Desfazer
 * que devolve um ignorado confirmado a cria de novo); o que deixa de estar
 * confirmado a perde (a tela pede confirmação antes). Devolve se a ação saiu,
 * para quem chama tirar o evento dela da Google Agenda (H5c) só nesse caso.
 */
export async function decidirItemDoResumo(ownerId: string, itemId: string, pedido: DecisaoDoItem): Promise<{ acaoSaiu: boolean }> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const item = await itemParaDecidir(tx, ownerId, itemId);
    const agora = Date.now();
    const estado = estadoDaDecisao(item, pedido, agora);
    const r = await tx.update(meetingSummaryItems).set({ ...estado, updatedAt: agora })
      .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
    if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    if (estado.status === "confirmed") {
      await criarDoItem(tx, ownerId, itemId, agora);
      return { acaoSaiu: false };
    }
    return { acaoSaiu: (await apagarAcaoDoItem(tx, ownerId, itemId)) > 0 };
  });
}

/**
 * Confirma de uma vez os itens ainda pendentes do resumo da reunião, fora da
 * fila (pronto, ou o refazer que falhou). As ações e tarefas confirmadas ganham
 * a próxima ação na mesma transação, e as confirmadas antes da H5a também.
 */
export async function confirmarItensDoResumo(ownerId: string, meetingId: string): Promise<number> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    // A reunião e o resumo travados até o fim, nesta ordem, como em itemParaDecidir.
    const reuniao = await reuniaoDaDona(tx, ownerId, meetingId, true);
    const linha = await linhaDoResumo(tx, ownerId, meetingId, true);
    if (!linha || !foraDaFila(linha.status) || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    const agora = Date.now();
    const r = await tx.update(meetingSummaryItems).set({ status: "confirmed", decidedAt: agora, updatedAt: agora })
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.status, "pending")));
    await garantirAcoesDosItensConfirmados(tx, ownerId, meetingId, agora);
    return linhasAfetadas(r);
  });
}

/**
 * Marca ou desmarca a caixa de uma ação do resumo. Marcar como feita também a
 * confirma: quem marca que fez está dizendo que a ação existiu. A próxima ação
 * dela nasce, se ainda não existia, e a marca de feita vai para as duas pela
 * mesma escrita (escreverFeita), na mesma transação.
 */
export async function marcarAcaoFeita(ownerId: string, itemId: string, feito: boolean) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const item = await itemParaDecidir(tx, ownerId, itemId);
    if (item.section !== "action") throw new TRPCError({ code: "BAD_REQUEST", message: MENSAGEM_SO_ACAO_TEM_CAIXA });
    const agora = Date.now();
    if (feito) {
      const r = await tx.update(meetingSummaryItems).set({
        status: "confirmed" as const, decidedAt: sql`coalesce(${meetingSummaryItems.decidedAt}, ${agora})`, updatedAt: agora,
      }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
      if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
      await criarDoItem(tx, ownerId, itemId, agora);
    }
    await escreverFeita(tx, ownerId, { itemId }, feito, agora);
  });
}

/**
 * O que a dona escreve num item (H4f), já aparado e validado pela entrada do
 * procedimento: o texto é obrigatório; o assunto, o responsável e o prazo vêm
 * nulos quando vazios. Os rótulos de voz ({F2}) chegam prontos da tela
 * (shared/vozes-na-edicao.ts): o servidor nunca resolve nem desfaz um nome.
 */
export type CamposDoItem = { texto: string; assunto: string | null; responsavel: string | null; prazo: string | null };

/**
 * Os campos como a seção os guarda: só as tarefas têm assunto, e só as ações
 * e as tarefas têm responsável e prazo (o formato da cliente). O que a seção
 * não tem fica nulo, venha o que vier.
 */
function camposDaSecao(secao: SecaoDoItem, campos: CamposDoItem) {
  return {
    text: campos.texto,
    subject: secaoTemAssunto(secao) ? campos.assunto : null,
    assignee: secaoTemResponsavel(secao) ? campos.responsavel : null,
    due: secaoTemResponsavel(secao) ? campos.prazo : null,
  };
}

type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/**
 * Dentro da transação, trava a reunião e o resumo, nesta ordem (a mesma da
 * gravação do resumo, server/fila-do-resumo.ts), e exige a reunião pronta e o
 * resumo com uma versão que vale na tela: o pronto, ou o refazer que falhou
 * (H4d), em que a dona segue decidindo e editando a versão anterior (o próximo
 * refazer guarda o que ela escreveu). Na fila, os itens vão ser trocados. A
 * exclusão, que marca 'deleted' antes de apagar, espera a transação e leva
 * junto o que ela gravou: nunca sobra item de reunião apagada.
 */
async function travarResumoPronto(tx: Transacao, ownerId: string, meetingId: string, naoAchou: string) {
  const [reuniao] = await tx.select({ status: meetings.status, trashedAt: meetings.trashedAt }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1).for("update");
  if (!reuniao || reuniaoForaDeVista(reuniao)) throw new TRPCError({ code: "NOT_FOUND", message: naoAchou });
  const [resumo] = await tx.select({ id: meetingSummaries.id, status: meetingSummaries.status, version: meetingSummaries.version }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1).for("update");
  const versaoNaTela = !!resumo && (resumo.status === "ready" || (resumo.status === "failed" && temVersaoAnterior(resumo)));
  if (!resumo || !versaoNaTela || reuniao.status !== "ready") throw new TRPCError({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
  return resumo;
}

/**
 * A dona edita o texto, o assunto (das tarefas), o responsável e o prazo de um
 * item do resumo pronto (H4f). O item editado vale como confirmado: é a palavra
 * dela, e o link aberto o mostra assim, sem o aviso de que a IA o gerou. A
 * origem não muda; o edited_at marca a edição, só quando algo mudou (salvar
 * sem mudar nada é confirmar). A marca de feito da ação fica como estava.
 *
 * A versão do resumo não sobe: ela marca a geração da fila. A tradução (H11)
 * acha o item editado pela impressão digital do texto e o acrescentado pelo id
 * novo, e manda à IA só ele. Subir a versão aqui jogava fora a tradução
 * guardada inteira, e cada correção custava a tradução do resumo e do mapa.
 *
 * A próxima ação do item (H5a) anda com ele, na mesma transação: a ação ou
 * tarefa que fica confirmada a ganha, se faltava, e a que já existia leva o
 * texto novo onde ainda tem a cópia do item (levarEdicaoDoItemAAcao). Devolve
 * o id da ação que mudou, para quem chama mandar a versão nova à Google Agenda
 * (H5c); nulo, se nenhuma mudou.
 */
export async function editarItemDoResumo(ownerId: string, itemId: string, campos: CamposDoItem): Promise<{ acaoQueMudou: string | null }> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [onde] = await tx.select({ summaryId: meetingSummaryItems.summaryId, meetingId: meetingSummaryItems.meetingId }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
    if (!onde) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    const resumo = await travarResumoPronto(tx, ownerId, onde.meetingId, MENSAGEM_ITEM_NAO_ENCONTRADO);
    // O item é de outro resumo da mesma reunião (o resumo foi refeito entre a
    // leitura e a trava): não existe mais.
    if (resumo.id !== onde.summaryId) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    // O item lido travado, depois da reunião e do resumo: a versão mais nova,
    // que é a que a próxima ação copiou.
    const [item] = await tx.select({
      section: meetingSummaryItems.section,
      status: meetingSummaryItems.status,
      subject: meetingSummaryItems.subject,
      text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee,
      due: meetingSummaryItems.due,
      excerpt: meetingSummaryItems.excerpt,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1).for("update");
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    const novos = camposDaSecao(item.section, campos);
    const mudou = novos.text !== item.text || novos.subject !== item.subject || novos.assignee !== item.assignee || novos.due !== item.due;
    const agora = Date.now();
    const r = await tx.update(meetingSummaryItems).set({
      ...novos,
      status: "confirmed",
      ...(item.status === "confirmed" ? {} : { decidedAt: agora }),
      ...(mudou ? { editedAt: agora } : {}),
      updatedAt: agora,
    }).where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId)));
    if (!linhasAfetadas(r)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    const acaoQueMudou = mudou ? await levarEdicaoDoItemAAcao(tx, ownerId, itemId, item, { ...item, ...novos }, agora) : null;
    await criarDoItem(tx, ownerId, itemId, agora);
    return { acaoQueMudou };
  });
}

/**
 * A dona acrescenta um item à mão ao resumo pronto (H4f): no fim da seção,
 * confirmado, com a origem 'owner', sem trecho, sem tempo e sem confiança. O
 * resumo guarda até ITENS_DO_RESUMO_MAX itens. A ação ou tarefa acrescentada
 * já é próxima ação (H5a). Devolve o id do item novo.
 */
export async function acrescentarItemDoResumo(ownerId: string, meetingId: string, secao: SecaoDoItem, campos: CamposDoItem): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    const resumo = await travarResumoPronto(tx, ownerId, meetingId, MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const [contagem] = await tx.select({ itens: count(), ultima: max(meetingSummaryItems.position) }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, resumo.id), eq(meetingSummaryItems.ownerId, ownerId)));
    if (Number(contagem?.itens ?? 0) >= ITENS_DO_RESUMO_MAX) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_CHEIO });
    const agora = Date.now();
    // A tela agrupa por seção na ordem da posição: o último do resumo é o último da seção.
    const ultima = contagem?.ultima ?? null;
    await tx.insert(meetingSummaryItems).values({
      id, summaryId: resumo.id, meetingId, ownerId, section: secao, position: ultima === null ? 0 : Number(ultima) + 1,
      ...camposDaSecao(secao, campos), excerpt: "", startSeconds: null,
      origin: "owner", status: "confirmed", done: false, decidedAt: agora, createdAt: agora, updatedAt: agora,
    });
    // Confirmada ao nascer: a ação ou tarefa ganha a próxima ação (H5a) na mesma transação.
    await criarDoItem(tx, ownerId, id, agora);
  });
  return id;
}

/**
 * O resumo guardado pelo link aberto (decisão do Roberto de 12/11/2026): só
 * leitura, sem ids, sem a caixa de feito e sem os itens que a dona ignorou.
 * Os pendentes vão com o estado, para a tela avisar que a dona ainda não os
 * conferiu. Os rótulos de voz ({F2}) vão crus: a página do link os troca pelo
 * nome com o `vozes` de reuniaoAberta.ver (H3b), que só traz os nomes quando o
 * link foi ligado com a confirmação que fala deles; sem nome, "Falante 2". O
 * idioma em que a IA escreveu vai junto, como para a dona: a página do link o
 * traduz (H11) quando quem lê escolhe outro, e "Ouvir o resumo" (H19) lê com a
 * voz do aparelho nesse idioma.
 *
 * Enquanto a dona refaz o resumo (H4d), ou se o refazer falhou, o link segue
 * mostrando a versão anterior (`versaoAnterior`), com o que ela já confirmou.
 *
 * O item que a dona escreveu, acrescentado ou editado (H4f), vai com a marca
 * `escritoPelaDona`, um sim ou não, sem a origem nem a hora da edição: quem
 * tem o link sabe que o texto é de quem gravou e não da IA, e que o trecho do
 * item editado é o da versão da IA.
 *
 * Com a transcrição editada pela dona (H18), o link mostra a versão editada e
 * não pode expor a da IA: o trecho de cada item saiu da transcrição de quando
 * o resumo foi escrito, e o que não aparece mais na transcrição de agora (a
 * dona tirou ou corrigiu aquela fala) vai vazio. O item continua, com o tempo,
 * e a marca `trechoForaDaTranscricao` diz à página que o trecho existia.
 */
export async function resumoGuardadoPeloLink(token: string) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  const linha = await linhaDoResumo(db, reuniao.ownerId, reuniao.id);
  const estado = estadoDe(linha, Date.now());
  const versaoAnterior = temVersaoAnterior(linha);
  const lidos = linha && (estado === "pronto" || versaoAnterior)
    ? await db.select({
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
      ...COLUNAS_DO_COMPLEMENTO,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, linha.id), eq(meetingSummaryItems.ownerId, reuniao.ownerId), ne(meetingSummaryItems.status, "ignored")))
      .orderBy(asc(meetingSummaryItems.position))
    : [];
  // O complemento pela busca (H4i) só vai ao link confirmado pela dona.
  const itens = (await trechosNaTranscricaoDeAgora(reuniao.ownerId, reuniao.id, lidos))
    .map(({ origin, editedAt, complementText, complementSourceUrl, complementSourceTitle, complementQueries, complementStatus, ...item }) => ({
      ...item, escritoPelaDona: escritoPelaDona({ origin, editedAt }),
      complemento: complementoNaTela({ complementText, complementSourceUrl, complementSourceTitle, complementQueries, complementStatus }, true),
    }));
  return { estado, emoji: linha?.emoji ?? null, idioma: linha?.language ?? null, versaoAnterior, itens };
}

/**
 * Quem tem o link pede o resumo que a reunião ainda não tem (ou cujo primeiro
 * resumo falhou). O refazer que falhou é da dona, e o link não o reabre.
 */
export async function pedirResumoPeloLink(token: string, antesDeCriar: (reuniaoId: string) => (() => void) | void) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  await pedirResumoDaReuniao(db, reuniao.ownerId, reuniao.id, () => antesDeCriar(reuniao.id), { peloLink: true });
  return resumoGuardadoPeloLink(token);
}
