import crypto from "crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } from "../drizzle/schema";
import { idiomaDaReuniao, IDIOMA_DA_REUNIAO_PADRAO } from "@shared/idioma-da-reuniao";
import { MODELO_DE_RESUMO_PADRAO, modeloDeResumo } from "@shared/modelos-de-resumo";
import { conferirMapaMental, type MapaMental } from "@shared/mapa-mental";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { FalhaDaIA } from "./ia-em-json";
import { avisarReuniaoPronta } from "./lembretes";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { soltarAcoesDaReuniao } from "./proximas-acoes";
import { gerarMapaMental } from "./mapa-mental";
import { gerarResumoDaReuniao } from "./resumo-da-reuniao";
import { numeracaoDoResumoRefeito } from "./resumo-refeito";
import { envioAutomaticoDoResumo } from "./resumo-por-email";

/**
 * A fila do resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), no próprio MySQL, no molde da
 * fila de transcrição (server/fila-de-transcricao.ts).
 *
 * Cada linha 'pending' de meeting_summaries é um trabalho: a rodada reserva uma
 * (UPDATE condicional com o token da execução), pede o resumo à IA e grava os
 * itens numa transação que confere a reunião (pronta, da dona) e a reserva.
 * Excluir ou reprocessar a reunião no meio apaga a linha do resumo: a gravação
 * acha zero linhas e descarta tudo, sem item órfão. Um deploy no meio não perde
 * o trabalho: a reserva vence e outra rodada o retoma. Laço e temporizador
 * próprios: o resumo nunca segura a fila de transcrição.
 *
 * O mapa mental (H10) é o mesmo trabalho, em duas fases da mesma linha:
 * gravado o resumo, ela fica 'ready' com o mapa 'pending', e a mesma rodada a
 * reserva de novo e pede o mapa, numa chamada à parte. O resumo já está
 * gravado: o mapa que falha não o derruba. O mapa tem as próprias tentativas
 * (as mesmas 3, com a mesma espera) e o próprio código de erro; a dona pede
 * de novo pela aba do mapa (server/mapa-mental-guardado.ts), que também serve
 * às reuniões resumidas antes de o mapa existir.
 */

const INTERVALO_DA_RODADA_MS = 5_000;
// Cobre a pior geração (gerarResumoDaReuniao: 180 s por chamada, 200 s de
// orçamento, e na reunião longa uma chamada por janela mais a junção) com folga.
// O mapa mental tem reserva própria, com 150 s de orçamento por chamada.
const DURACAO_DA_RESERVA_MS = 15 * 60_000;
export const TENTATIVAS_DO_RESUMO = 3;

type Banco = Awaited<ReturnType<typeof exigirDb>>;
// Os testes rodam a fila só sobre as reuniões de uma dona: o Vitest roda os
// arquivos em paralelo no mesmo banco.
type Escopo = { ownerId?: string };

// As reservas desta instância, do token para a linha: o SIGTERM devolve
// exatamente estas, pela chave de cada linha.
const tokensVivos = new Map<string, string>();
let parada = false;

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/** Código curto para last_error: nunca o texto da IA ou do driver. */
function codigoDoErro(erro: unknown): string {
  return erro instanceof FalhaDaIA ? erro.codigo : "ERRO";
}

// As duas fases do trabalho de uma linha: o resumo, e depois o mapa mental.
// O modelo do resumo (H4d) vai junto: a fase do resumo escreve nele.
type Fase = "resumo" | "mapa";
type Alvo = { id: string; meetingId: string; ownerId: string; template: string };

/** A linha que é trabalho da fase: o resumo pendente, ou o mapa pendente de um resumo pronto. */
function naFila(fase: Fase) {
  return fase === "resumo"
    ? eq(meetingSummaries.status, "pending")
    : and(eq(meetingSummaries.status, "ready"), eq(meetingSummaries.mindMapStatus, "pending"));
}

const semReservaViva = (agora: number) => or(isNull(meetingSummaries.lockedUntil), lt(meetingSummaries.lockedUntil, agora));

/**
 * Resumo pendente vencido o prazo das tentativas, sem reserva viva (o processo
 * caiu em todas, sem o SIGTERM): ninguém mais o reservaria. Vira falha, e a
 * tela oferece tentar de novo. O mapa esgotado falha sozinho: o resumo
 * continua pronto. Aqui não sai o aviso de reunião pronta no sino (H15), que
 * registrarFalha dá: é o caso raro, e a varredura é em lote.
 *
 * Trava só pela chave: os esgotados saem de uma leitura sem trava, e cada um
 * vira falha num UPDATE pelo id que repete as condições (a linha que mudou no
 * meio, reservada ou pedida de novo, não casa mais e fica). O UPDATE pelo
 * intervalo do índice (estado, locked_until) travava o vão inteiro, com os
 * resumos de outras donas; a reserva, a gravação do resumo e o pedido movem a
 * linha dentro desse índice e se travavam com ele (deadlock no CI de 18/11,
 * com os arquivos de integração em paralelo no mesmo banco).
 */
async function desistirDosEsgotados(db: Banco, agora: number, escopo: Escopo) {
  const esgotado = (fase: Fase) => and(
    naFila(fase),
    sql`${meetingSummaries.attempts} >= ${TENTATIVAS_DO_RESUMO}`,
    semReservaViva(agora),
    escopo.ownerId ? eq(meetingSummaries.ownerId, escopo.ownerId) : undefined,
  );
  const desistencia = {
    resumo: { status: "failed" as const, lastError: "TENTATIVAS_ESGOTADAS" },
    mapa: { mindMapStatus: "failed" as const, mindMapError: "TENTATIVAS_ESGOTADAS" },
  };
  for (const fase of ["resumo", "mapa"] as const) {
    const esgotados = await db.select({ id: meetingSummaries.id }).from(meetingSummaries).where(esgotado(fase));
    for (const { id } of esgotados) {
      await db.update(meetingSummaries).set({ ...desistencia[fase], lockToken: null, lockedUntil: null, updatedAt: agora })
        .where(and(eq(meetingSummaries.id, id), esgotado(fase)));
    }
  }
}

/** O trabalho mais antigo da fase, sem reserva viva, de reunião pronta de conta ativa. */
async function maisAntigo(db: Banco, agora: number, escopo: Escopo, fase: Fase) {
  const [alvo] = await db.select({ id: meetingSummaries.id, meetingId: meetingSummaries.meetingId, ownerId: meetingSummaries.ownerId, template: meetingSummaries.template, updatedAt: meetingSummaries.updatedAt })
    .from(meetingSummaries)
    .innerJoin(meetings, and(eq(meetings.id, meetingSummaries.meetingId), eq(meetings.ownerId, meetingSummaries.ownerId)))
    .innerJoin(users, eq(users.openId, meetingSummaries.ownerId))
    .where(and(
      naFila(fase),
      semReservaViva(agora),
      lt(meetingSummaries.attempts, TENTATIVAS_DO_RESUMO),
      eq(meetings.status, "ready"),
      eq(users.isActive, true),
      escopo.ownerId ? eq(meetingSummaries.ownerId, escopo.ownerId) : undefined,
    ))
    .orderBy(asc(meetingSummaries.updatedAt))
    .limit(1);
  return alvo ? { id: alvo.id, meetingId: alvo.meetingId, ownerId: alvo.ownerId, template: alvo.template, updatedAt: Number(alvo.updatedAt), fase } : undefined;
}

/**
 * O trabalho mais antigo das duas fases: um resumo pendente ou o mapa
 * pendente de um resumo pronto. Uma consulta por fase, cada uma pelo índice
 * do seu estado: juntas num OR, o banco varreria todos os resumos prontos a
 * cada rodada.
 */
async function proximoTrabalho(db: Banco, agora: number, escopo: Escopo): Promise<(Alvo & { fase: Fase }) | undefined> {
  const resumo = await maisAntigo(db, agora, escopo, "resumo");
  const mapa = await maisAntigo(db, agora, escopo, "mapa");
  const alvo = resumo && mapa ? (mapa.updatedAt < resumo.updatedAt ? mapa : resumo) : resumo ?? mapa;
  return alvo && { id: alvo.id, meetingId: alvo.meetingId, ownerId: alvo.ownerId, template: alvo.template, fase: alvo.fase };
}

async function reservar(db: Banco, id: string, agora: number, fase: Fase): Promise<string | null> {
  const token = crypto.randomUUID();
  tokensVivos.set(token, id);
  const r = await db.update(meetingSummaries).set({
    lockToken: token, lockedUntil: agora + DURACAO_DA_RESERVA_MS,
    attempts: sql`${meetingSummaries.attempts} + 1`, updatedAt: agora,
  }).where(and(
    eq(meetingSummaries.id, id), naFila(fase),
    semReservaViva(agora),
    lt(meetingSummaries.attempts, TENTATIVAS_DO_RESUMO),
  ));
  if (linhas(r)) return token;
  tokensVivos.delete(token);
  return null;
}

/**
 * Devolve a reserva sem gastar a tentativa: a geração não chegou a ser gravada
 * por um motivo que não é falha dela (desligamento, reunião fora de 'ready',
 * transcrição trocada). Sem isto, a linha ficaria presa até a reserva vencer.
 */
async function devolverReserva(db: Banco, id: string, token: string) {
  await db.update(meetingSummaries).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingSummaries.attempts} - 1, 0)` })
    .where(and(eq(meetingSummaries.id, id), eq(meetingSummaries.lockToken, token)));
}

/**
 * Falha com a reserva ainda viva: espera curta e crescente, ou falha de vez.
 * Na fase do mapa, quem falha é só o mapa: o resumo continua pronto.
 *
 * A falha de vez do primeiro resumo avisa no sino que a reunião ficou pronta
 * sem o resumo (H15): a transcrição está lá, e a tela oferece tentar de novo.
 * A marca e o aviso vão juntos, numa transação. A falha do mapa e a do
 * resumo refeito (H4d, "Refazer como…": a versão anterior segue na tela) não
 * avisam nada, e o aviso de pronta que já está no sino fica, porque o resumo
 * continua lá.
 */
async function registrarFalha(
  db: Banco, alvo: { id: string; meetingId: string; ownerId: string }, token: string, codigo: string, definitiva: boolean, fase: Fase = "resumo",
) {
  const [linha] = await db.select({ attempts: meetingSummaries.attempts, version: meetingSummaries.version }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token))).limit(1);
  if (!linha) return;
  const deVez = definitiva || linha.attempts >= TENTATIVAS_DO_RESUMO;
  const desfecho = fase === "resumo"
    ? { status: deVez ? "failed" as const : "pending" as const, lastError: codigo }
    : { mindMapStatus: deVez ? "failed" as const : "pending" as const, mindMapError: codigo };
  // Sem versão anterior (version 0), a reunião ficou sem resumo nenhum: é o
  // que o aviso diz. O refazer que falha tem uma versão gravada, que vale.
  const avisar = deVez && fase === "resumo" && Number(linha.version) === 0;
  await db.transaction(async tx => {
    const r = await tx.update(meetingSummaries).set({
      ...desfecho, lockToken: null,
      lockedUntil: deVez ? null : Date.now() + linha.attempts * 60_000, updatedAt: Date.now(),
    }).where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token)));
    if (avisar && linhas(r)) await avisarReuniaoPronta(tx, alvo.ownerId, alvo.meetingId, "falhou");
  });
}

/**
 * O item que fica quando o resumo é refeito com outro modelo (H4d, "Refazer
 * como…"): o que a dona confirmou, a ação que ela marcou como feita e o item
 * que ela escreveu (H4f: acrescentado à mão ou editado), mesmo ignorado, para
 * a palavra dela não sumir com uma geração da IA e o Desfazer continuar
 * valendo. Os pendentes e os ignorados da IA são trocados pelos novos.
 */
type ItemAtual = { status: string; done: boolean; origin: string; editedAt: number | null };
const escritoPelaDona = (item: ItemAtual) => item.origin === "owner" || item.editedAt !== null;
const itemQueFica = (item: ItemAtual) => item.status === "confirmed" || item.done || escritoPelaDona(item);

/** A fase do resumo; true quando ele foi gravado (e o mapa vem em seguida). */
async function gerarUm(db: Banco, alvo: Alvo, token: string): Promise<boolean> {
  const [transcricao] = await db.select({
    id: meetingTranscripts.id, texto: meetingTranscripts.transcript, segmentos: meetingTranscripts.segments, idioma: meetingTranscripts.language,
  }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
  if (!transcricao) {
    await registrarFalha(db, alvo, token, "SEM_TRANSCRICAO", true);
    return false;
  }
  const idioma = idiomaDaReuniao(transcricao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  // O resumo refeito (H4d) leva à IA os itens que ficam, para ela não os
  // escrever de novo. No primeiro resumo não há item nenhum. O item da dona
  // que ela ignorou fica no resumo, recolhido, mas não vai à IA como
  // "confirmado".
  const itensAtuais = await db.select({
    section: meetingSummaryItems.section, subject: meetingSummaryItems.subject, text: meetingSummaryItems.text,
    status: meetingSummaryItems.status, done: meetingSummaryItems.done, origin: meetingSummaryItems.origin, editedAt: meetingSummaryItems.editedAt,
  }).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.summaryId, alvo.id), eq(meetingSummaryItems.ownerId, alvo.ownerId)))
    .orderBy(asc(meetingSummaryItems.position));
  const itensQueFicam = itensAtuais.filter(item => itemQueFica(item) && item.status !== "ignored")
    .map(({ section, subject, text }) => ({ section, subject, text }));

  let resumo: Awaited<ReturnType<typeof gerarResumoDaReuniao>>;
  try {
    resumo = await gerarResumoDaReuniao({
      transcricao: transcricao.texto, segmentos: segmentosDoContrato(transcricao.segmentos), idioma,
      modelo: modeloDeResumo(alvo.template) ?? MODELO_DE_RESUMO_PADRAO, itensQueFicam,
    });
  } catch (erro) {
    // Resposta cortada no teto de saída se repetiria com a mesma entrada: é
    // falha de vez. O resto (IA fora, JSON inválido) tenta de novo.
    const definitiva = erro instanceof FalhaDaIA && erro.codigo === "RESPOSTA_CORTADA";
    // Erro que não é da IA é bug ou banco: vai a pilha ao log, não só o código.
    console.error(`[Resumo] a geração falhou (${definitiva ? "sem nova tentativa" : "volta à fila"}):`, erro instanceof FalhaDaIA ? erro.codigo : erro instanceof Error ? erro.stack ?? descreverErroDeBanco(erro) : descreverErroDeBanco(erro));
    await registrarFalha(db, alvo, token, codigoDoErro(erro), definitiva);
    return false;
  }
  // O desligamento chegou durante a chamada à IA: as reservas já foram
  // devolvidas, e o próximo processo refaz o resumo.
  if (parada) return false;

  const agora = Date.now();
  let resultado: "gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada";
  try {
    resultado = await gravarResumo(db, alvo, token, transcricao, idioma, resumo, agora);
  } catch (erro) {
    // A IA já respondeu e o banco recusou (queda, deadlock): conta como falha
    // passageira, com espera, em vez de prender a linha até a reserva vencer.
    console.error("[Resumo] o resumo não foi gravado:", descreverErroDeBanco(erro));
    try {
      await registrarFalha(db, alvo, token, "ERRO_GRAVACAO", false);
    } catch (erroAoRegistrar) {
      console.error("[Resumo] nem a falha foi registrada; a reserva vence sozinha:", descreverErroDeBanco(erroAoRegistrar));
    }
    return false;
  }
  if (resultado === "reuniao_fora" || resultado === "transcricao_trocada") {
    console.warn(`[Resumo] descartado: ${resultado === "reuniao_fora" ? "a reunião saiu de 'ready'" : "a transcrição foi trocada"} durante a geração; a reserva volta à fila.`);
    await devolverReserva(db, alvo.id, token);
  } else if (resultado === "sem_reserva") {
    console.warn("[Resumo] descartado: a reserva não é mais desta rodada (reunião excluída ou reprocessada, ou outra rodada a retomou).");
  }
  return resultado === "gravou";
}

/**
 * Grava os itens e marca o resumo como pronto, numa transação. A reunião fica
 * travada até o fim: a exclusão (que marca 'deleted' antes de apagar) espera
 * esta transação, e o que ela gravar sai junto. No resumo refeito (H4d), os
 * itens que a dona confirmou, as ações feitas e os itens que ela escreveu
 * (H4f) ficam, renumerados, e só os pendentes e os ignorados da IA são
 * trocados. O mapa mental pronto (H10) também fica: ele sai só da
 * transcrição, que é a mesma, e não do modelo do resumo.
 */
async function gravarResumo(
  db: Banco, alvo: { id: string; meetingId: string; ownerId: string }, token: string,
  transcricao: { id: string }, idioma: string, resumo: Awaited<ReturnType<typeof gerarResumoDaReuniao>>, agora: number,
): Promise<"gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada"> {
  return db.transaction(async tx => {
    // A reunião travada até o fim: a exclusão (que marca 'deleted' antes de
    // apagar) espera esta transação, e o que ela gravar sai junto.
    const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, alvo.meetingId), eq(meetings.ownerId, alvo.ownerId))).for("update");
    const [ainda] = await tx.select({ id: meetingSummaries.id, mindMapStatus: meetingSummaries.mindMapStatus, mindMap: meetingSummaries.mindMap }).from(meetingSummaries)
      .where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token))).for("update");
    // Sem a linha com o meu token: a reunião foi reprocessada ou excluída, ou a
    // reserva venceu e outra rodada a tomou.
    if (!ainda) return "sem_reserva";
    if (reuniao?.status !== "ready") return "reuniao_fora";
    // A transcrição tem de ser a mesma que a IA leu.
    const [atual] = await tx.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
    if (atual?.id !== transcricao.id) return "transcricao_trocada";
    // Os itens de agora, lidos sem trava, e os que saem apagados pela chave:
    // travar a faixa do resumo no índice prende também o vão vizinho, e duas
    // gravações de resumos vizinhos se travam uma à outra (deadlock). A linha
    // do resumo, travada acima, já faz desta a única gravação dele, e a dona
    // não decide nem edita enquanto ele está na fila; mesmo assim, o item que
    // alguém confirmou, marcou como feito ou escreveu no meio não é apagado.
    const itensAtuais = await tx.select({
      id: meetingSummaryItems.id, section: meetingSummaryItems.section, position: meetingSummaryItems.position,
      text: meetingSummaryItems.text, status: meetingSummaryItems.status, done: meetingSummaryItems.done,
      origin: meetingSummaryItems.origin, editedAt: meetingSummaryItems.editedAt,
    }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, alvo.id), eq(meetingSummaryItems.ownerId, alvo.ownerId)));
    const queFicam = itensAtuais.filter(itemQueFica);
    const queSaem = itensAtuais.filter(item => !itemQueFica(item)).map(item => item.id);
    if (queSaem.length) {
      // A próxima ação presa a um item que sai se solta antes (H5a), como no
      // reprocesso: o nome das vozes vai para o texto, e a reunião e o trecho
      // ficam. Só a dos itens que saem: a do item que fica (confirmado, feito,
      // escrito pela dona) continua presa a ele, com o prazo, o contato e o
      // evento; solta, a leitura seguinte criaria outra ação para o mesmo item.
      // Item que sai não tem ação (desconfirmar a apaga): isto é a defesa.
      await soltarAcoesDaReuniao(tx, alvo.ownerId, alvo.meetingId, false, agora, queSaem);
      await tx.delete(meetingSummaryItems).where(and(
        inArray(meetingSummaryItems.id, queSaem), eq(meetingSummaryItems.ownerId, alvo.ownerId),
        ne(meetingSummaryItems.status, "confirmed"), eq(meetingSummaryItems.done, false),
        eq(meetingSummaryItems.origin, "ai"), isNull(meetingSummaryItems.editedAt),
      ));
    }
    const numeracao = numeracaoDoResumoRefeito(queFicam, resumo.itens);
    for (const { id, position } of numeracao.queFicam) {
      if (queFicam.find(item => item.id === id)?.position === position) continue;
      await tx.update(meetingSummaryItems).set({ position })
        .where(and(eq(meetingSummaryItems.id, id), eq(meetingSummaryItems.ownerId, alvo.ownerId)));
    }
    if (numeracao.novos.length) {
      await tx.insert(meetingSummaryItems).values(numeracao.novos.map(item => ({
        id: crypto.randomUUID(), summaryId: alvo.id, meetingId: alvo.meetingId, ownerId: alvo.ownerId,
        section: item.section, position: item.position, subject: item.subject, text: item.text, assignee: item.assignee, due: item.due,
        excerpt: item.excerpt, startSeconds: item.startSeconds, confidence: item.confidence.toFixed(3),
        status: "pending" as const, done: false, createdAt: agora, updatedAt: agora,
      })));
    }
    const r = await tx.update(meetingSummaries).set({
      status: "ready", transcriptId: transcricao.id, language: idioma, emoji: resumo.emoji, model: resumo.modelo,
      version: sql`${meetingSummaries.version} + 1`, generatedAt: agora,
      // A IA devolveu itens e a conferência tirou todos: fica registrado, e a
      // tela mostra o resumo vazio sem fingir que a reunião não teve conteúdo.
      lastError: !resumo.itens.length && resumo.recebidos ? "CONFERENCIA_TIROU_TUDO" : null,
      // A fase seguinte do mesmo trabalho (H10): o mapa entra na fila, do zero
      // e com as tentativas dele. O mapa pronto que ainda passa na conferência
      // fica: o resumo refeito em outro modelo (H4d) não muda a transcrição de
      // que ele saiu.
      ...(ainda.mindMapStatus === "ready" && conferirMapaMental(ainda.mindMap)
        ? {}
        : { mindMap: null, mindMapStatus: "pending" as const, mindMapGeneratedAt: null, mindMapError: null }),
      attempts: 0,
      lockToken: null, lockedUntil: null, updatedAt: agora,
    }).where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token)));
    if (!linhas(r)) return "sem_reserva";
    // O aviso "a reunião ficou pronta" no sino (H15), na mesma transação: o
    // resumo pronto e o aviso saem juntos, e a reunião segue travada.
    await avisarReuniaoPronta(tx, alvo.ownerId, alvo.meetingId, "pronto");
    return "gravou";
  });
}

/**
 * A fase do mapa mental (H10), com o resumo já pronto. Lê a transcrição de
 * novo, porque o mapa pode vir bem depois do resumo (a reunião antiga, o
 * pedido depois de uma falha). O mapa que a conferência não aceita (menos de
 * 2 ramos válidos) falha de vez: a mesma entrada daria o mesmo, e a dona pode
 * pedir de novo.
 */
async function gerarMapa(db: Banco, alvo: Alvo, token: string): Promise<void> {
  const [transcricao] = await db.select({ id: meetingTranscripts.id, texto: meetingTranscripts.transcript, idioma: meetingTranscripts.language })
    .from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
  if (!transcricao?.texto?.trim()) return registrarFalha(db, alvo, token, "SEM_TRANSCRICAO", true, "mapa");
  const idioma = idiomaDaReuniao(transcricao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;

  let mapa: MapaMental | null;
  try {
    mapa = await gerarMapaMental({ transcricao: transcricao.texto, idioma });
  } catch (erro) {
    const definitiva = erro instanceof FalhaDaIA && erro.codigo === "RESPOSTA_CORTADA";
    console.error(`[Mapa] a geração falhou (${definitiva ? "sem nova tentativa" : "volta à fila"}):`, erro instanceof FalhaDaIA ? erro.codigo : erro instanceof Error ? erro.stack ?? descreverErroDeBanco(erro) : descreverErroDeBanco(erro));
    return registrarFalha(db, alvo, token, codigoDoErro(erro), definitiva, "mapa");
  }
  // O desligamento chegou durante a chamada à IA: a reserva já voltou.
  if (parada) return;
  if (!mapa) return registrarFalha(db, alvo, token, "MAPA_INVALIDO", true, "mapa");

  let resultado: "gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada";
  try {
    resultado = await gravarMapa(db, alvo, token, transcricao, mapa, Date.now());
  } catch (erro) {
    console.error("[Mapa] o mapa não foi gravado:", descreverErroDeBanco(erro));
    try {
      await registrarFalha(db, alvo, token, "ERRO_GRAVACAO", false, "mapa");
    } catch (erroAoRegistrar) {
      console.error("[Mapa] nem a falha foi registrada; a reserva vence sozinha:", descreverErroDeBanco(erroAoRegistrar));
    }
    return;
  }
  if (resultado === "reuniao_fora" || resultado === "transcricao_trocada") {
    console.warn(`[Mapa] descartado: ${resultado === "reuniao_fora" ? "a reunião saiu de 'ready'" : "a transcrição foi trocada"} durante a geração; a reserva volta à fila.`);
    await devolverReserva(db, alvo.id, token);
  } else if (resultado === "sem_reserva") {
    console.warn("[Mapa] descartado: a reserva não é mais desta rodada (reunião excluída ou reprocessada, ou outra rodada a retomou).");
  }
}

/**
 * Grava o mapa no resumo pronto, numa transação, com as mesmas conferências
 * do resumo: a reunião travada e pronta, a reserva ainda minha e a mesma
 * transcrição que a IA leu.
 */
async function gravarMapa(
  db: Banco, alvo: Alvo, token: string, transcricao: { id: string }, mapa: MapaMental, agora: number,
): Promise<"gravou" | "sem_reserva" | "reuniao_fora" | "transcricao_trocada"> {
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, alvo.meetingId), eq(meetings.ownerId, alvo.ownerId))).for("update");
    const [ainda] = await tx.select({ id: meetingSummaries.id }).from(meetingSummaries)
      .where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token))).for("update");
    if (!ainda) return "sem_reserva";
    if (reuniao?.status !== "ready") return "reuniao_fora";
    const [atual] = await tx.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.meetingId, alvo.meetingId), eq(meetingTranscripts.ownerId, alvo.ownerId))).limit(1);
    if (atual?.id !== transcricao.id) return "transcricao_trocada";
    const r = await tx.update(meetingSummaries).set({
      mindMap: mapa, mindMapStatus: "ready", mindMapGeneratedAt: agora, mindMapError: null,
      lockToken: null, lockedUntil: null, updatedAt: agora,
    }).where(and(eq(meetingSummaries.id, alvo.id), eq(meetingSummaries.lockToken, token), naFila("mapa")));
    return linhas(r) > 0 ? "gravou" : "sem_reserva";
  });
}

/**
 * Reserva uma fase do trabalho e a executa. Devolve true só quando a fase era
 * o resumo e ele foi gravado: aí o mapa vem em seguida.
 */
async function executar(db: Banco, alvo: Alvo, fase: Fase, agora: number): Promise<boolean> {
  const token = await reservar(db, alvo.id, agora, fase);
  if (!token) return false;
  try {
    // O desligamento pode ter tirado a foto das reservas antes desta: devolve
    // na hora, sem chamar a IA.
    if (parada) {
      await devolverReserva(db, alvo.id, token);
      return false;
    }
    if (fase === "mapa") {
      await gerarMapa(db, alvo, token);
      return false;
    }
    return await gerarUm(db, alvo, token);
  } finally {
    tokensVivos.delete(token);
  }
}

/**
 * Uma rodada: desiste dos esgotados, reserva o trabalho pendente mais antigo e
 * o gera. Gravado o resumo, o mapa mental segue na mesma rodada, numa reserva
 * nova: é o mesmo trabalho, e a reunião não espera a fila dar a volta.
 * Exportada para os testes; em produção é o laço de iniciarFilaDoResumo.
 */
export async function rodarUmaVez(escopo: Escopo = {}): Promise<void> {
  if (parada) return;
  const db = await exigirDb();
  const agora = Date.now();
  await desistirDosEsgotados(db, agora, escopo);
  const alvo = await proximoTrabalho(db, agora, escopo);
  if (!alvo || parada) return;
  const resumoGravado = await executar(db, alvo, alvo.fase, agora);
  // O e-mail automático do resumo (H22), desligado por padrão: só para a dona
  // que o ligou, e só no primeiro resumo da reunião. Sem await: a Resend lenta
  // não segura o mapa nem o próximo resumo. Nunca rejeita (o erro vai ao log).
  if (resumoGravado) void envioAutomaticoDoResumo(alvo.ownerId, alvo.meetingId);
  if (resumoGravado && !parada) await executar(db, alvo, "mapa", Date.now());
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Liga o laço da fila do resumo (no boot do servidor, com banco). */
export function iniciarFilaDoResumo(intervaloMs = INTERVALO_DA_RODADA_MS) {
  parada = false;
  const proxima = () => {
    if (parada) return;
    timer = setTimeout(() => {
      // Uma rodada por vez, e ela nunca rejeita solta (derrubaria o processo):
      // todo erro vira log, e a reserva vence sozinha.
      rodarUmaVez()
        .catch(erro => console.error("[Resumo] a rodada falhou:", descreverErroDeBanco(erro)))
        .finally(proxima);
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/**
 * Desligamento (SIGTERM do Render, SIGINT no dev): para de reservar e devolve
 * as reservas desta instância, sem gastar a tentativa, para o próximo processo
 * retomar na hora. O trabalho em curso é abandonado: a gravação dele confere o
 * token, que já não vale.
 *
 * Cada reserva volta pela chave da linha, com o token no WHERE. O UPDATE por
 * `lock_token IN (...)` não tem índice para a coluna e varria os resumos na
 * fila de todas as donas, travando cada um: a gravação de um resumo vizinho,
 * que trava a linha dele e depois a move no índice, se travava com ele
 * (deadlock no CI de 18/11).
 */
export async function pararFilaDoResumo(): Promise<{ resumos: number }> {
  parada = true;
  clearTimeout(timer);
  const reservas = Array.from(tokensVivos);
  if (!reservas.length) return { resumos: 0 };
  let db: Banco;
  try {
    db = await exigirDb();
  } catch (erro) {
    console.error("[Resumo] sem banco no desligamento; as reservas vencem sozinhas:", descreverErroDeBanco(erro));
    return { resumos: 0 };
  }
  // As duas fases: o resumo pendente e o mapa pendente de um resumo pronto.
  let resumos = 0;
  for (const [token, id] of reservas) {
    const r = await db.update(meetingSummaries).set({ lockToken: null, lockedUntil: null, attempts: sql`greatest(${meetingSummaries.attempts} - 1, 0)` })
      .where(and(eq(meetingSummaries.id, id), eq(meetingSummaries.lockToken, token), or(naFila("resumo"), naFila("mapa"))));
    resumos += linhas(r);
  }
  tokensVivos.clear();
  return { resumos };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}

export const _paraTestes = { tokensVivos };
