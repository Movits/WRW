import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { meetings, meetingSummaries, meetingSummaryItems, privateContacts, proximasAcoes } from "../drizzle/schema";
import { exigirDb } from "./db";
import { agendarLembreteDaAcao, esquecerLembrete } from "./lembretes";
import { destinoDaAcaoNaAgenda, estadoDaAcaoAoEscrever, type DestinoDaAcaoNaAgenda } from "@shared/acoes-na-agenda";
import { nomesDosFalantes } from "@shared/const";
import { estadoNaGoogle, type EstadoNaGoogle } from "@shared/google-agenda-eventos";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import {
  indexarRedeParaSugerir,
  MENSAGEM_ACAO_NAO_ENCONTRADA,
  MENSAGEM_CONTATO_FORA_DA_REDE,
  RESPONSAVEL_DA_ACAO_MAX,
  SECOES_QUE_VIRAM_ACAO,
  sugerirContatoNaRede,
} from "@shared/proximas-acoes";

/**
 * As próximas ações da dona (H5a do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): o que ela confirmou como ação ou
 * tarefa no resumo guardado de uma reunião e o que anotou à mão. Toda consulta
 * leva a dona no WHERE, e banco fora do ar sobe como erro, nunca como lista
 * vazia (server/CLAUDE.md).
 *
 * O item confirmado e a ação andam juntos, sempre na mesma transação:
 * - confirmar (um item, todos, ou marcar a ação feita no resumo) cria a ação
 *   (criarDoItem, garantirAcoesDosItensConfirmados), em server/resumo-guardado.ts;
 * - desconfirmar apaga a ação, e apagar a ação na lista desconfirma o item;
 * - "feita" tem uma escrita só (escreverFeita), que marca a ação e o item.
 *
 * Quem decide trava a reunião antes (SELECT ... FOR UPDATE): a exclusão, que
 * marca a reunião 'deleted' antes de apagar os derivados, espera a decisão, e a
 * ação que ela criar se solta junto com o resto (soltarAcoesDaReuniao).
 *
 * O lembrete no sino (H15, server/lembretes.ts) anda com o prazo: anotar e
 * editar o prazo o agendam, na mesma transação; apagar a ação o esquece. A
 * feita não precisa de escrita: o laço confere a ação no disparo.
 *
 * O estado da ação na Google Agenda (H5c, proximas_acoes.google) muda nas
 * mesmas escritas: anotar e editar o gravam pelo destino da ação
 * (shared/acoes-na-agenda.ts), e marcar feita o zera, porque a feita sai da
 * agenda. A conversa com a Google vem depois, em server/acoes-na-google.ts.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
/** O banco ou uma transação aberta por quem chama: é ela que decide a atomicidade. */
export type Executor = Pick<Transacao, "select" | "selectDistinct" | "insert" | "update" | "delete">;

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

const acaoNaoEncontrada = () => new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_ACAO_NAO_ENCONTRADA });

// ── do item do resumo à ação ────────────────────────────────────────────────

const COLUNAS_DO_ITEM = {
  id: meetingSummaryItems.id,
  meetingId: meetingSummaryItems.meetingId,
  section: meetingSummaryItems.section,
  subject: meetingSummaryItems.subject,
  text: meetingSummaryItems.text,
  assignee: meetingSummaryItems.assignee,
  due: meetingSummaryItems.due,
  excerpt: meetingSummaryItems.excerpt,
  status: meetingSummaryItems.status,
  done: meetingSummaryItems.done,
  doneAt: meetingSummaryItems.doneAt,
};
type ItemParaAcao = {
  id: string; meetingId: string; subject: string | null; text: string; assignee: string | null;
  due: string | null; excerpt: string; done: boolean; doneAt: number | null;
};

/**
 * O que a ação copia do item. A tarefa tem assunto ("Contrato com o
 * importador") e um parágrafo: o assunto vira o texto, e o parágrafo, o
 * detalhe. A ação do topo do resumo é uma frase só. Os rótulos de voz ficam
 * como estão: quem troca pelo nome é a tela (shared/vozes-no-texto.ts).
 */
export function camposDaAcaoDoItem(item: Pick<ItemParaAcao, "subject" | "text" | "assignee" | "due" | "excerpt">) {
  const assunto = item.subject?.trim();
  return {
    texto: assunto || item.text,
    detalhe: assunto ? item.text : null,
    responsavel: item.assignee,
    prazoDito: item.due,
    trecho: item.excerpt,
  };
}

/** Idempotente pelo índice único (dona, item): a ação que já existe fica como está. */
async function inserirAcoesDosItens(ex: Executor, ownerId: string, itens: readonly ItemParaAcao[], agora: number) {
  if (!itens.length) return;
  const linhas = itens.map(item => ({
    id: crypto.randomUUID(),
    ownerId,
    origem: "reuniao" as const,
    meetingId: item.meetingId,
    itemId: item.id,
    ...camposDaAcaoDoItem(item),
    feita: item.done,
    feitaEm: item.done ? item.doneAt ?? agora : null,
    createdAt: agora,
    updatedAt: agora,
  }));
  await ex.insert(proximasAcoes).values(linhas).onDuplicateKeyUpdate({ set: { itemId: sql`${proximasAcoes.itemId}` } });
}

/**
 * A próxima ação de um item confirmado do resumo (ação ou tarefa), na
 * transação de quem confirma. Outro item (foco, decisão...), item não
 * confirmado ou de outra dona: nada. Devolve se o item vira ação.
 */
export async function criarDoItem(ex: Executor, ownerId: string, itemId: string, agora = Date.now()): Promise<boolean> {
  const [item] = await ex.select(COLUNAS_DO_ITEM).from(meetingSummaryItems)
    .where(and(eq(meetingSummaryItems.id, itemId), eq(meetingSummaryItems.ownerId, ownerId))).limit(1);
  if (!item || item.status !== "confirmed" || !(SECOES_QUE_VIRAM_ACAO as readonly string[]).includes(item.section)) return false;
  await inserirAcoesDosItens(ex, ownerId, [item], agora);
  return true;
}

/**
 * As ações que faltam aos itens confirmados (ação ou tarefa) de uma reunião
 * com o resumo pronto: os confirmados antes da H5a e o "Confirmar todos".
 * Idempotente: a leitura só acha item sem ação, e o índice único segura a
 * corrida. Quem chama trava a reunião na transação. Devolve quantas criou.
 */
export async function garantirAcoesDosItensConfirmados(ex: Executor, ownerId: string, meetingId: string, agora = Date.now()): Promise<number> {
  const faltando = await ex.select(COLUNAS_DO_ITEM).from(meetingSummaryItems)
    .innerJoin(meetingSummaries, and(
      eq(meetingSummaries.id, meetingSummaryItems.summaryId), eq(meetingSummaries.ownerId, meetingSummaryItems.ownerId),
      eq(meetingSummaries.status, "ready"),
    ))
    .leftJoin(proximasAcoes, and(eq(proximasAcoes.itemId, meetingSummaryItems.id), eq(proximasAcoes.ownerId, meetingSummaryItems.ownerId)))
    .where(and(
      eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.meetingId, meetingId),
      inArray(meetingSummaryItems.section, [...SECOES_QUE_VIRAM_ACAO]), eq(meetingSummaryItems.status, "confirmed"),
      isNull(proximasAcoes.id),
    ));
  await inserirAcoesDosItens(ex, ownerId, faltando, agora);
  return faltando.length;
}

/**
 * Trava a reunião da dona até o fim da transação e diz se ela está pronta.
 * A exclusão marca 'deleted' com um UPDATE nesta linha: espera quem a travou.
 */
export async function travarReuniaoPronta(ex: Executor, ownerId: string, meetingId: string): Promise<boolean> {
  const [reuniao] = await ex.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).for("update");
  return reuniao?.status === "ready";
}

/**
 * O backfill das ações da dona, antes de ler a lista: cada reunião pronta com
 * item confirmado sem ação ganha as dela, numa transação com a reunião travada.
 * Na leitura comum a consulta não acha nada e não escreve.
 */
export async function garantirAcoesDaDona(ownerId: string): Promise<number> {
  const db = await exigirDb();
  const reunioes = await db.selectDistinct({ meetingId: meetingSummaryItems.meetingId }).from(meetingSummaryItems)
    .innerJoin(meetings, and(
      eq(meetings.id, meetingSummaryItems.meetingId), eq(meetings.ownerId, meetingSummaryItems.ownerId), eq(meetings.status, "ready"),
    ))
    .leftJoin(proximasAcoes, and(eq(proximasAcoes.itemId, meetingSummaryItems.id), eq(proximasAcoes.ownerId, meetingSummaryItems.ownerId)))
    .where(and(
      eq(meetingSummaryItems.ownerId, ownerId), inArray(meetingSummaryItems.section, [...SECOES_QUE_VIRAM_ACAO]),
      eq(meetingSummaryItems.status, "confirmed"), isNull(proximasAcoes.id),
    ))
    .limit(50);
  let criadas = 0;
  for (const { meetingId } of reunioes) {
    criadas += await db.transaction(async tx => (await travarReuniaoPronta(tx, ownerId, meetingId))
      ? garantirAcoesDosItensConfirmados(tx, ownerId, meetingId)
      : 0);
  }
  return criadas;
}

/**
 * O item deixou de estar confirmado: a ação dele sai (na transação de quem
 * desconfirma), e o lembrete no sino e os avisos dela saem junto (H15).
 */
export async function apagarAcaoDoItem(ex: Executor, ownerId: string, itemId: string) {
  const daDona = and(eq(proximasAcoes.ownerId, ownerId), eq(proximasAcoes.itemId, itemId));
  const saem = await ex.select({ id: proximasAcoes.id }).from(proximasAcoes).where(daDona);
  await ex.delete(proximasAcoes).where(daDona);
  for (const acao of saem) await esquecerLembrete(ex, ownerId, "acao", acao.id);
}

/**
 * A única escrita de "feita": a caixa da ação no resumo e a da lista passam por
 * aqui, e a ação e o item mudam juntos, na transação de quem chama. Pelo item,
 * acha a ação dele; pela ação, o item dela (nulo na manual e na solta).
 */
export async function escreverFeita(
  ex: Executor, ownerId: string, alvo: { itemId: string } | { acaoId: string; itemId: string | null }, feita: boolean, agora: number,
) {
  const quando = feita ? agora : null;
  if (alvo.itemId) {
    await ex.update(meetingSummaryItems).set({ done: feita, doneAt: quando, updatedAt: agora })
      .where(and(eq(meetingSummaryItems.id, alvo.itemId), eq(meetingSummaryItems.ownerId, ownerId)));
  }
  const daAcao = "acaoId" in alvo ? eq(proximasAcoes.id, alvo.acaoId) : eq(proximasAcoes.itemId, alvo.itemId);
  // A feita sai da Google Agenda (H5c): o estado zera aqui, e quem chamou tira o
  // evento depois (server/acoes-na-google.ts). Reabrir não mexe no estado: quem
  // reabre manda a ação de novo, se ela tem prazo.
  return linhasAfetadas(await ex.update(proximasAcoes).set({ feita, feitaEm: quando, ...(feita ? { google: null } : {}), updatedAt: agora })
    .where(and(eq(proximasAcoes.ownerId, ownerId), daAcao)));
}

// ── a reunião que sai ───────────────────────────────────────────────────────
// (O contato que sai: apagarRastroDoContato, em server/db.ts, anula contact_id.)

/**
 * Os textos da ação com os nomes que a dona deu às vozes no lugar dos rótulos.
 * A voz sem nome fica como rótulo ({F2}), e a tela mostra "Falante 2" no idioma
 * de quem lê: o servidor não escreve texto de tela.
 */
export function textosComNomes(
  acao: { texto: string; detalhe: string | null; responsavel: string | null },
  nomes: Readonly<Record<string, string>>,
) {
  const trocar = (texto: string) => vozesNoTexto(texto, nomes, numero => `{F${numero}}`);
  return {
    texto: trocar(acao.texto),
    detalhe: acao.detalhe === null ? null : trocar(acao.detalhe),
    responsavel: acao.responsavel === null ? null : trocar(acao.responsavel).slice(0, RESPONSAVEL_DA_ACAO_MAX),
  };
}

/**
 * Solta as próximas ações de uma reunião que vai ser excluída (`reuniaoSai`) ou
 * refeita (o reprocesso, que apaga os itens e zera os nomes das vozes). A ação
 * fica com a dona, mas deixa de depender do que sai:
 * - os nomes das vozes viram texto, porque o mapa (meetings.speaker_names) e a
 *   numeração das vozes não sobrevivem;
 * - item_id vira nulo: o item sai;
 * - na exclusão, meeting_id e o trecho também, porque o trecho é fala da
 *   transcrição apagada.
 * Roda antes de os itens e a reunião saírem (apagarDerivadosSemGravacao), sem
 * transação própria: cada UPDATE é por ação, e repetir não muda nada.
 */
export async function soltarAcoesDaReuniao(ex: Executor, ownerId: string, meetingId: string, reuniaoSai: boolean, agora = Date.now()): Promise<number> {
  const acoes = await ex.select({
    id: proximasAcoes.id, texto: proximasAcoes.texto, detalhe: proximasAcoes.detalhe,
    responsavel: proximasAcoes.responsavel, itemId: proximasAcoes.itemId,
  }).from(proximasAcoes).where(and(eq(proximasAcoes.ownerId, ownerId), eq(proximasAcoes.meetingId, meetingId)));
  // Já solta (reprocessada antes) e a reunião fica: nada a fazer.
  const aSoltar = acoes.filter(acao => acao.itemId !== null || reuniaoSai);
  if (!aSoltar.length) return 0;
  // Os nomes só são lidos quando há ação ainda presa ao item: as soltas já os têm no texto.
  let nomes: Record<string, string> = {};
  if (aSoltar.some(acao => acao.itemId !== null)) {
    const [reuniao] = await ex.select({ speakerNames: meetings.speakerNames }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
    nomes = nomesDosFalantes(reuniao?.speakerNames);
  }
  for (const acao of aSoltar) {
    await ex.update(proximasAcoes).set({
      ...(acao.itemId !== null ? textosComNomes(acao, nomes) : {}),
      itemId: null,
      ...(reuniaoSai ? { meetingId: null, trecho: null } : {}),
      updatedAt: agora,
    }).where(and(eq(proximasAcoes.id, acao.id), eq(proximasAcoes.ownerId, ownerId)));
  }
  return aSoltar.length;
}

// ── a lista ─────────────────────────────────────────────────────────────────

/** Até quantas ações a página mostra de uma vez. */
export const LIMITE_DA_LISTA = 300;
/** Quantas abertas o cartão do Dashboard mostra. */
export const ABERTAS_NO_PAINEL = 5;
/** Até quantas ações ligadas a um contato o perfil dele mostra (H5b). */
export const ACOES_NO_PERFIL_DO_CONTATO = 100;
/** Os nomes da rede que a sugestão de contato lê, no máximo (só id e nome, pelo índice). */
export const CONTATOS_PARA_SUGERIR = 5000;

export type FiltroDasAcoes = "abertas" | "todas";

async function lerAcoes(db: Banco, ownerId: string, opcoes: { soAbertas: boolean; limite: number; contactId?: number }) {
  const linhas = await db.select({
    id: proximasAcoes.id,
    texto: proximasAcoes.texto,
    detalhe: proximasAcoes.detalhe,
    responsavel: proximasAcoes.responsavel,
    prazo: proximasAcoes.prazo,
    prazoDito: proximasAcoes.prazoDito,
    origem: proximasAcoes.origem,
    feita: proximasAcoes.feita,
    feitaEm: proximasAcoes.feitaEm,
    trecho: proximasAcoes.trecho,
    google: proximasAcoes.google,
    createdAt: proximasAcoes.createdAt,
    updatedAt: proximasAcoes.updatedAt,
    meetingId: proximasAcoes.meetingId,
    contactId: proximasAcoes.contactId,
    tituloDaReuniao: meetings.title,
    vozesDaReuniao: meetings.speakerNames,
    itemVivo: meetingSummaryItems.id,
    nomeDoContato: privateContacts.fullName,
  }).from(proximasAcoes)
    // A reunião, o item e o contato só valem se ainda são da dona: o ponteiro
    // velho (excluído no meio de uma escrita) não traz nada de ninguém.
    .leftJoin(meetings, and(eq(meetings.id, proximasAcoes.meetingId), eq(meetings.ownerId, proximasAcoes.ownerId), ne(meetings.status, "deleted")))
    .leftJoin(meetingSummaryItems, and(eq(meetingSummaryItems.id, proximasAcoes.itemId), eq(meetingSummaryItems.ownerId, proximasAcoes.ownerId)))
    .leftJoin(privateContacts, and(eq(privateContacts.id, proximasAcoes.contactId), eq(privateContacts.ownerId, proximasAcoes.ownerId)))
    .where(and(
      eq(proximasAcoes.ownerId, ownerId),
      opcoes.soAbertas ? eq(proximasAcoes.feita, false) : undefined,
      opcoes.contactId !== undefined ? eq(proximasAcoes.contactId, opcoes.contactId) : undefined,
    ))
    // As abertas primeiro; entre elas, por prazo, e as sem prazo no fim. O id
    // desempata (as do mesmo INSERT têm a mesma data): a lista não troca de
    // ordem entre uma leitura e outra.
    .orderBy(asc(proximasAcoes.feita), sql`${proximasAcoes.prazo} is null`, asc(proximasAcoes.prazo), asc(proximasAcoes.createdAt), asc(proximasAcoes.id))
    .limit(opcoes.limite);
  return linhas.map(linha => {
    const reuniaoViva = linha.meetingId !== null && linha.tituloDaReuniao !== null;
    // Os nomes das vozes só enquanto a ação está presa ao item da reunião viva:
    // solta, a numeração das vozes pode ser outra, e os nomes já estão no texto.
    const presaAoItem = reuniaoViva && linha.itemVivo !== null;
    return {
      id: linha.id,
      texto: linha.texto,
      detalhe: linha.detalhe,
      responsavel: linha.responsavel,
      prazo: linha.prazo,
      prazoDito: linha.prazoDito,
      origem: linha.origem,
      feita: linha.feita,
      feitaEm: linha.feitaEm,
      trecho: linha.trecho,
      // O estado na Google Agenda (H5c) e a última mudança, que é a revisão do .ics.
      google: estadoNaGoogle(linha.google),
      createdAt: linha.createdAt,
      updatedAt: linha.updatedAt,
      reuniao: reuniaoViva ? { id: linha.meetingId as string, titulo: linha.tituloDaReuniao as string, itemId: presaAoItem ? linha.itemVivo : null } : null,
      vozes: presaAoItem ? nomesDosFalantes(linha.vozesDaReuniao) : {},
      contato: linha.contactId !== null && linha.nomeDoContato !== null ? { id: linha.contactId, nome: linha.nomeDoContato } : null,
    };
  });
}
export type ProximaAcaoNaTela = Awaited<ReturnType<typeof lerAcoes>>[number];

async function contarAbertas(db: Banco, ownerId: string): Promise<number> {
  const [linha] = await db.select({ abertas: sql<number>`count(*)` }).from(proximasAcoes)
    .where(and(eq(proximasAcoes.ownerId, ownerId), eq(proximasAcoes.feita, false)));
  return Number(linha?.abertas ?? 0);
}

/**
 * O contato que o responsável de cada ação aberta sem contato aponta
 * (sugerirContatoPeloNome, sem IA). O responsável é lido como a tela o
 * mostra: o rótulo de voz com nome vira o nome; sem nome, não sugere nada.
 *
 * A rede é indexada uma vez por leitura, e cada ação só consulta o índice: o
 * custo é o da rede mais o das ações, não o produto dos dois (a leitura da
 * lista roda a cada mutação, e o laço de eventos é um só). A rede maior que o
 * teto não foi lida inteira: a homônima de fora da leitura faria a sugestão
 * apontar a pessoa errada, e aí não se sugere nada.
 */
async function sugestoesDeContato(db: Banco, ownerId: string, acoes: readonly ProximaAcaoNaTela[]) {
  const sugestoes = new Map<string, { id: number; nome: string }>();
  const candidatas = acoes
    .filter(acao => !acao.feita && !acao.contato && acao.responsavel)
    .map(acao => ({ id: acao.id, nome: vozesNoTexto(acao.responsavel as string, acao.vozes, () => "").trim() }))
    .filter(candidata => candidata.nome.length >= 2);
  if (!candidatas.length) return sugestoes;
  // Um a mais que o teto: é como se sabe que a rede passou dele.
  const contatos = await db.select({ id: privateContacts.id, fullName: privateContacts.fullName }).from(privateContacts)
    .where(eq(privateContacts.ownerId, ownerId)).limit(CONTATOS_PARA_SUGERIR + 1);
  if (contatos.length > CONTATOS_PARA_SUGERIR) return sugestoes;
  const rede = indexarRedeParaSugerir(contatos);
  for (const candidata of candidatas) {
    const contato = sugerirContatoNaRede(candidata.nome, rede);
    if (contato) sugestoes.set(candidata.id, { id: contato.id, nome: contato.fullName });
  }
  return sugestoes;
}

/** A página /proximas-acoes: as abertas ou todas, com a sugestão de contato. */
export async function listarProximasAcoes(ownerId: string, filtro: FiltroDasAcoes) {
  await garantirAcoesDaDona(ownerId);
  const db = await exigirDb();
  const acoes = await lerAcoes(db, ownerId, { soAbertas: filtro === "abertas", limite: LIMITE_DA_LISTA });
  const sugestoes = await sugestoesDeContato(db, ownerId, acoes);
  return {
    acoes: acoes.map(acao => ({ ...acao, contatoSugerido: sugestoes.get(acao.id) ?? null })),
    abertas: await contarAbertas(db, ownerId),
    limite: LIMITE_DA_LISTA,
  };
}

/** O cartão do Dashboard: as 5 abertas por prazo e quantas abertas há. */
export async function proximasAcoesDoPainel(ownerId: string) {
  await garantirAcoesDaDona(ownerId);
  const db = await exigirDb();
  const acoes = await lerAcoes(db, ownerId, { soAbertas: true, limite: ABERTAS_NO_PAINEL });
  return { acoes, abertas: await contarAbertas(db, ownerId) };
}

/**
 * As ações que a dona ligou a um contato da rede dela (H5b): a seção do perfil
 * do contato e os eventos da linha do tempo
 * (server/network-perfil-do-contato.ts). Todas, as abertas primeiro e por
 * prazo, como na página. Quem chama já conferiu que o contato é da dona; o
 * WHERE leva a dona de novo.
 *
 * Não completa as ações que faltam (garantirAcoesDaDona): a ação que nasce do
 * item do resumo não tem contato, e só a dona a liga a um. Por isso o perfil
 * só lê, e não escreve.
 */
export async function proximasAcoesDoContato(ownerId: string, contactId: number) {
  const db = await exigirDb();
  return lerAcoes(db, ownerId, { soAbertas: false, limite: ACOES_NO_PERFIL_DO_CONTATO, contactId });
}

// ── o que a dona faz na lista ───────────────────────────────────────────────

/** O contato tem de ser da rede da dona. */
async function exigirContatoDaDona(ex: Executor, ownerId: string, contactId: number) {
  const [contato] = await ex.select({ id: privateContacts.id }).from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  if (!contato) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_CONTATO_FORA_DA_REDE });
}

export type DadosDaAcao = {
  texto: string;
  detalhe?: string | null;
  responsavel?: string | null;
  prazo?: string | null;
  contactId?: number | null;
  /**
   * O fuso do aparelho de quem marca o prazo (IANA): o lembrete no sino sai às
   * 9h do dia do prazo nesse relógio (H15). Não fica na ação.
   */
  fuso?: string | null;
};

/**
 * Como a escrita trata a Google Agenda (H5c): `naGoogle` quando a dona a tem
 * conectada (mesmo com a conexão quebrada, que falha e pede "Reconectar"), e o
 * fuso e o relógio que dizem se o dia do prazo já acabou.
 */
export type GoogleNaEscrita = { naGoogle: boolean; fuso: string; agora: number };
/** O que a escrita decidiu para a Google: o destino da ação e o estado de antes. */
export type PassoNaGoogle = { destino: DestinoDaAcaoNaAgenda; googleAntes: EstadoNaGoogle | null };
/** O que a ação tinha antes de mudar: o prazo e o estado na Google Agenda (H5c), para quem chama tirar o evento ou mandá-lo de novo. */
export type AcaoAntesDeMudar = { prazo: string | null; googleAntes: EstadoNaGoogle | null };

/**
 * A ação que a dona anota à mão. Com `naGoogle` (a ação com prazo por vir e a
 * Google Agenda conectada), ela nasce "pendente" na Google: quem chama manda o
 * evento logo depois (server/acoes-na-google.ts).
 */
export async function criarProximaAcao(ownerId: string, dados: DadosDaAcao, opcoes: { naGoogle?: boolean } = {}): Promise<{ id: string }> {
  const db = await exigirDb();
  if (dados.contactId) await exigirContatoDaDona(db, ownerId, dados.contactId);
  const agora = Date.now();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    await tx.insert(proximasAcoes).values({
      id, ownerId, origem: "manual", texto: dados.texto, detalhe: dados.detalhe || null, responsavel: dados.responsavel || null,
      prazo: dados.prazo || null, contactId: dados.contactId ?? null, feita: false,
      google: opcoes.naGoogle ? "pendente" : null, createdAt: agora, updatedAt: agora,
    });
    // O lembrete no sino (H15), junto com a ação: às 9h do dia do prazo.
    await agendarLembreteDaAcao(tx, ownerId, id, dados.prazo || null, dados.fuso, agora);
  });
  return { id };
}

/**
 * Texto, detalhe, responsável e prazo, de qualquer ação da dona. Só muda o que
 * veio. O prazo novo (ou nenhum) reagenda o lembrete no sino na mesma
 * transação (H15); o texto novo não precisa: o lembrete o lê no disparo.
 *
 * Com `google` (H5c), a ação é lida travada antes, e o estado na Google muda
 * na mesma escrita, pelo destino que ela fica tendo (estadoDaAcaoAoEscrever):
 * a que sai da agenda (sem prazo) zera; a que vai, ou já estava, fica
 * "pendente", para quem chama mandar a versão nova; a que estava lá, sem a
 * Google Agenda conectada agora, fica "falhou", porque a Google ficou com a
 * versão antiga. Devolve o que decidiu.
 */
export async function editarProximaAcao(
  ownerId: string, acaoId: string, campos: Partial<Omit<DadosDaAcao, "contactId">>, google?: GoogleNaEscrita,
): Promise<PassoNaGoogle | undefined> {
  const db = await exigirDb();
  const valores = {
    ...(campos.texto !== undefined ? { texto: campos.texto } : {}),
    ...(campos.detalhe !== undefined ? { detalhe: campos.detalhe || null } : {}),
    ...(campos.responsavel !== undefined ? { responsavel: campos.responsavel || null } : {}),
    ...(campos.prazo !== undefined ? { prazo: campos.prazo || null } : {}),
  };
  const agora = Date.now();
  const daDona = and(eq(proximasAcoes.id, acaoId), eq(proximasAcoes.ownerId, ownerId));
  return db.transaction(async tx => {
    let passo: PassoNaGoogle | undefined;
    let estado: { google?: EstadoNaGoogle | null } = {};
    if (google) {
      const [antes] = await tx.select({ prazo: proximasAcoes.prazo, feita: proximasAcoes.feita, google: proximasAcoes.google })
        .from(proximasAcoes).where(daDona).for("update");
      if (!antes) throw acaoNaoEncontrada();
      const prazo = campos.prazo !== undefined ? campos.prazo || null : antes.prazo ?? null;
      passo = { destino: destinoDaAcaoNaAgenda({ prazo, feita: Boolean(antes.feita) }, google.fuso, google.agora), googleAntes: estadoNaGoogle(antes.google) };
      estado = { google: estadoDaAcaoAoEscrever(passo.destino, passo.googleAntes, google.naGoogle) };
    }
    const r = await tx.update(proximasAcoes).set({ ...valores, ...estado, updatedAt: agora }).where(daDona);
    if (!linhasAfetadas(r)) throw acaoNaoEncontrada();
    if (campos.prazo !== undefined) await agendarLembreteDaAcao(tx, ownerId, acaoId, campos.prazo || null, campos.fuso, agora);
    return passo;
  });
}

/**
 * A ação da dona e, se ela ainda está presa ao item de uma reunião, a reunião
 * travada até o fim da transação (a ordem de quem decide no resumo: reunião
 * primeiro).
 */
async function acaoParaMudar(tx: Executor, ownerId: string, acaoId: string) {
  const [acao] = await tx.select({
    id: proximasAcoes.id, itemId: proximasAcoes.itemId, meetingId: proximasAcoes.meetingId,
    prazo: proximasAcoes.prazo, google: proximasAcoes.google,
  }).from(proximasAcoes).where(and(eq(proximasAcoes.id, acaoId), eq(proximasAcoes.ownerId, ownerId))).limit(1);
  if (!acao) throw acaoNaoEncontrada();
  if (acao.itemId && acao.meetingId) {
    await tx.select({ id: meetings.id }).from(meetings)
      .where(and(eq(meetings.id, acao.meetingId), eq(meetings.ownerId, ownerId))).for("update");
  }
  return acao;
}

/**
 * Marca ou desmarca a ação; o item do resumo dela muda junto (escreverFeita).
 * A feita sai da Google Agenda (H5c): devolve o prazo e o estado de antes, para
 * quem chama tirar o evento, ou mandá-lo de novo ao reabrir.
 */
export async function marcarProximaAcaoFeita(ownerId: string, acaoId: string, feita: boolean): Promise<AcaoAntesDeMudar> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const acao = await acaoParaMudar(tx, ownerId, acaoId);
    if (!(await escreverFeita(tx, ownerId, { acaoId: acao.id, itemId: acao.itemId }, feita, Date.now()))) throw acaoNaoEncontrada();
    return { prazo: acao.prazo ?? null, googleAntes: estadoNaGoogle(acao.google) };
  });
}

/**
 * Apaga a ação. A da reunião, ainda presa ao item, desconfirma o item: ele
 * volta a "para conferir" no resumo. É o mesmo par da decisão no resumo
 * (desconfirmar apaga a ação), e sem isso garantirAcoesDosItensConfirmados a
 * recriaria na próxima leitura. A tela pede a confirmação antes.
 */
export async function apagarProximaAcao(ownerId: string, acaoId: string): Promise<AcaoAntesDeMudar> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const acao = await acaoParaMudar(tx, ownerId, acaoId);
    const agora = Date.now();
    if (acao.itemId) {
      await tx.update(meetingSummaryItems).set({ status: "pending", decidedAt: null, done: false, doneAt: null, updatedAt: agora })
        .where(and(eq(meetingSummaryItems.id, acao.itemId), eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.status, "confirmed")));
    }
    await tx.delete(proximasAcoes).where(and(eq(proximasAcoes.id, acao.id), eq(proximasAcoes.ownerId, ownerId)));
    // O lembrete no sino e os avisos dela saem junto (H15).
    await esquecerLembrete(tx, ownerId, "acao", acao.id);
    // O evento na Google Agenda sai depois, por quem chama (H5c).
    return { prazo: acao.prazo ?? null, googleAntes: estadoNaGoogle(acao.google) };
  });
}

/**
 * Liga a ação a um contato da rede da dona, ou tira o contato (null). A posse
 * do contato é conferida: id de outra rede é "contato fora da sua rede".
 */
export async function ligarContato(ownerId: string, acaoId: string, contactId: number | null) {
  const db = await exigirDb();
  if (contactId !== null) await exigirContatoDaDona(db, ownerId, contactId);
  const r = await db.update(proximasAcoes).set({ contactId, updatedAt: Date.now() })
    .where(and(eq(proximasAcoes.id, acaoId), eq(proximasAcoes.ownerId, ownerId)));
  if (!linhasAfetadas(r)) throw acaoNaoEncontrada();
}
