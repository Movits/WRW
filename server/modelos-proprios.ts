import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, gte, inArray } from "drizzle-orm";
import { meetings, meetingSummaries, modelosDeResumoProprios, preferenciasDoResumo, resumosRefeitos } from "../drizzle/schema";
import {
  ESTILO_DO_RESUMO_PADRAO, INSTRUCOES_DO_MODELO_MAX, INSTRUCOES_DO_PEDIDO_MAX, MODELO_DE_RESUMO_PADRAO, MODELOS_PROPRIOS_MAX,
  NOME_DO_MODELO_MAX, RECUSAS_DOS_MODELOS, REFAZERES_POR_DIA, ajusteDepoisDaResposta, escolhaComoTexto, escolhaDoTexto,
  estiloDoResumo, iconeDoModelo, modeloDeResumo,
  type EscolhaDoModelo, type EstiloDoResumo, type IconeDoModelo, type ModeloDeResumo, type RespostaDoTamanho,
} from "@shared/modelos-de-resumo";
import { exigirDb } from "./db";
import { reuniaoVisivel } from "./reuniao-visivel";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "@shared/const";
import type { Executor } from "./proximas-acoes";

/**
 * Os modelos de resumo da própria dona e as preferências dela (H4e do plano
 * do gravador; HN-35 do HiNoter): criar, editar e apagar os modelos (nome,
 * ícone e instruções), o modelo e o estilo padrão, o pedido feito antes de
 * gravar, a resposta a "O resumo teve o tamanho certo?" e o teto de custo do
 * "Refazer o resumo". Toda consulta leva a dona no WHERE: o modelo de outra
 * conta é "não encontrado". O link aberto não recebe nada disto.
 *
 * Quem escreve o resumo é a fila (server/fila-do-resumo.ts), que lê daqui o
 * modelo da dona e o ajuste do tamanho na hora de gerar.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
const DIA_MS = 24 * 60 * 60_000;
const DIACRITICOS = /[̀-ͯ]/g;

function naoEncontrado(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: RECUSAS_DOS_MODELOS.naoEncontrado });
}

/** O nome como fica guardado: sem espaços sobrando, até o máximo; vazio é null. */
export function normalizarNomeDoModelo(nome: string): string | null {
  const limpo = nome.replace(/\s+/g, " ").trim().slice(0, NOME_DO_MODELO_MAX).trim();
  return limpo || null;
}

/** A chave que diz se dois nomes são o mesmo: sem caixa e sem acento. */
export function chaveDoNomeDoModelo(nome: string): string {
  return (normalizarNomeDoModelo(nome) ?? "").normalize("NFD").replace(DIACRITICOS, "").toLocaleLowerCase("pt-BR");
}

/** As instruções como ficam guardadas: as quebras de linha ficam, os espaços nas pontas saem. */
export function normalizarInstrucoes(texto: string | null | undefined, maximo: number): string | null {
  const limpo = (texto ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, maximo).trim();
  return limpo || null;
}

export type ModeloProprio = { id: string; nome: string; icone: IconeDoModelo; instrucoes: string };

async function modelosDaDona(db: Executor, ownerId: string): Promise<ModeloProprio[]> {
  const linhas = await db.select({
    id: modelosDeResumoProprios.id, nome: modelosDeResumoProprios.nome, icone: modelosDeResumoProprios.icone, instrucoes: modelosDeResumoProprios.instrucoes,
  }).from(modelosDeResumoProprios)
    .where(eq(modelosDeResumoProprios.ownerId, ownerId))
    .orderBy(asc(modelosDeResumoProprios.createdAt), asc(modelosDeResumoProprios.id));
  return linhas.map(linha => ({ ...linha, icone: iconeDoModelo(linha.icone) ?? "📝" }));
}

/** O modelo da dona pelo id, ou undefined (de outra conta, apagado ou inexistente). */
export async function modeloProprioDaDona(db: Executor, ownerId: string, id: string): Promise<ModeloProprio | undefined> {
  const [linha] = await db.select({
    id: modelosDeResumoProprios.id, nome: modelosDeResumoProprios.nome, icone: modelosDeResumoProprios.icone, instrucoes: modelosDeResumoProprios.instrucoes,
  }).from(modelosDeResumoProprios)
    .where(and(eq(modelosDeResumoProprios.id, id), eq(modelosDeResumoProprios.ownerId, ownerId))).limit(1);
  return linha ? { ...linha, icone: iconeDoModelo(linha.icone) ?? "📝" } : undefined;
}

export type Preferencias = { padrao: EscolhaDoModelo; estilo: EstiloDoResumo; ajusteDoTamanho: number };

/**
 * As preferências da dona; sem linha, o Geral equilibrado sem ajuste. O padrão
 * que aponta para um modelo dela que não existe mais volta ao Geral (apagar
 * já o solta; isto é a defesa).
 */
export async function preferenciasDaDona(db: Executor, ownerId: string): Promise<Preferencias> {
  const [linha] = await db.select({
    modeloPadrao: preferenciasDoResumo.modeloPadrao, modeloProprioPadraoId: preferenciasDoResumo.modeloProprioPadraoId,
    estiloPadrao: preferenciasDoResumo.estiloPadrao, ajusteDoTamanho: preferenciasDoResumo.ajusteDoTamanho,
  }).from(preferenciasDoResumo).where(eq(preferenciasDoResumo.ownerId, ownerId)).limit(1);
  if (!linha) return { padrao: { tipo: "pronto", modelo: MODELO_DE_RESUMO_PADRAO }, estilo: ESTILO_DO_RESUMO_PADRAO, ajusteDoTamanho: 0 };
  let padrao: EscolhaDoModelo = { tipo: "pronto", modelo: MODELO_DE_RESUMO_PADRAO };
  if (linha.modeloPadrao === "ia") padrao = { tipo: "ia" };
  else if (linha.modeloPadrao === "proprio" && linha.modeloProprioPadraoId) {
    if (await modeloProprioDaDona(db, ownerId, linha.modeloProprioPadraoId)) padrao = { tipo: "proprio", id: linha.modeloProprioPadraoId };
  } else {
    const pronto = modeloDeResumo(linha.modeloPadrao);
    if (pronto) padrao = { tipo: "pronto", modelo: pronto };
  }
  return { padrao, estilo: estiloDoResumo(linha.estiloPadrao) ?? ESTILO_DO_RESUMO_PADRAO, ajusteDoTamanho: Number(linha.ajusteDoTamanho) || 0 };
}

/** Os modelos da dona e as preferências dela, como a tela os lê. */
export async function modelosEPreferenciasDaDona(ownerId: string) {
  const db = await exigirDb();
  const [proprios, preferencias] = [await modelosDaDona(db, ownerId), await preferenciasDaDona(db, ownerId)];
  return { proprios, padrao: escolhaComoTexto(preferencias.padrao), estilo: preferencias.estilo, ajusteDoTamanho: preferencias.ajusteDoTamanho };
}

type DadosDoModelo = { nome: string; icone: string; instrucoes: string };

function conferirDados(dados: DadosDoModelo): { nome: string; icone: IconeDoModelo; instrucoes: string } {
  const nome = normalizarNomeDoModelo(dados.nome);
  const icone = iconeDoModelo(dados.icone);
  const instrucoes = normalizarInstrucoes(dados.instrucoes, INSTRUCOES_DO_MODELO_MAX);
  if (!nome || !icone || !instrucoes) throw new TRPCError({ code: "BAD_REQUEST", message: "Dados do modelo inválidos." });
  return { nome, icone, instrucoes };
}

/**
 * As linhas dos modelos da dona travadas até o fim da transação: duas criações
 * ao mesmo tempo não passam juntas do teto nem gravam o mesmo nome. Trava pelo
 * índice da dona (owner_id, created_at), só o intervalo dela.
 */
async function modelosTravados(tx: Executor, ownerId: string) {
  return tx.select({ id: modelosDeResumoProprios.id, nome: modelosDeResumoProprios.nome }).from(modelosDeResumoProprios)
    .where(eq(modelosDeResumoProprios.ownerId, ownerId)).for("update");
}

export async function criarModeloProprio(ownerId: string, dados: DadosDoModelo) {
  const conferidos = conferirDados(dados);
  const db = await exigirDb();
  const id = crypto.randomUUID();
  await db.transaction(async tx => {
    const atuais = await modelosTravados(tx, ownerId);
    if (atuais.length >= MODELOS_PROPRIOS_MAX) throw new TRPCError({ code: "BAD_REQUEST", message: RECUSAS_DOS_MODELOS.demais });
    const chave = chaveDoNomeDoModelo(conferidos.nome);
    if (atuais.some(modelo => chaveDoNomeDoModelo(modelo.nome) === chave)) throw new TRPCError({ code: "CONFLICT", message: RECUSAS_DOS_MODELOS.nomeRepetido });
    const agora = Date.now();
    await tx.insert(modelosDeResumoProprios).values({ id, ownerId, ...conferidos, createdAt: agora, updatedAt: agora });
  });
  return { id };
}

export async function editarModeloProprio(ownerId: string, id: string, dados: DadosDoModelo) {
  const conferidos = conferirDados(dados);
  const db = await exigirDb();
  await db.transaction(async tx => {
    const atuais = await modelosTravados(tx, ownerId);
    if (!atuais.some(modelo => modelo.id === id)) naoEncontrado();
    const chave = chaveDoNomeDoModelo(conferidos.nome);
    if (atuais.some(modelo => modelo.id !== id && chaveDoNomeDoModelo(modelo.nome) === chave)) throw new TRPCError({ code: "CONFLICT", message: RECUSAS_DOS_MODELOS.nomeRepetido });
    await tx.update(modelosDeResumoProprios).set({ ...conferidos, updatedAt: Date.now() })
      .where(and(eq(modelosDeResumoProprios.id, id), eq(modelosDeResumoProprios.ownerId, ownerId)));
  });
  return { id };
}

/**
 * Apaga o modelo da dona e, na mesma transação, solta o que apontava para ele:
 * os resumos feitos com ele ficam no Geral (os itens não mudam; só o nome do
 * modelo na tela) e o padrão dela volta ao Geral. O pedido feito antes de
 * gravar que o citava é conferido de novo na hora de usar.
 */
export async function apagarModeloProprio(ownerId: string, id: string) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const atuais = await modelosTravados(tx, ownerId);
    if (!atuais.some(modelo => modelo.id === id)) naoEncontrado();
    await tx.delete(modelosDeResumoProprios).where(and(eq(modelosDeResumoProprios.id, id), eq(modelosDeResumoProprios.ownerId, ownerId)));
    await tx.update(meetingSummaries).set({ customTemplateId: null })
      .where(and(eq(meetingSummaries.ownerId, ownerId), eq(meetingSummaries.customTemplateId, id)));
    await tx.update(preferenciasDoResumo).set({ modeloPadrao: MODELO_DE_RESUMO_PADRAO, modeloProprioPadraoId: null, updatedAt: Date.now() })
      .where(and(eq(preferenciasDoResumo.ownerId, ownerId), eq(preferenciasDoResumo.modeloProprioPadraoId, id)));
  });
  return { id };
}

/**
 * As colunas de meeting_summaries que uma escolha grava. O modelo da dona tem
 * de ser dela (NOT_FOUND com o código). "A IA escolhe" grava o Geral até a
 * fila pedir a escolha.
 */
export async function colunasDaEscolha(db: Executor, ownerId: string, escolha: EscolhaDoModelo): Promise<{ template: ModeloDeResumo; customTemplateId: string | null; aiTemplate: "pending" | null }> {
  if (escolha.tipo === "pronto") return { template: escolha.modelo, customTemplateId: null, aiTemplate: null };
  if (escolha.tipo === "ia") return { template: MODELO_DE_RESUMO_PADRAO, customTemplateId: null, aiTemplate: "pending" };
  if (!(await modeloProprioDaDona(db, ownerId, escolha.id))) naoEncontrado();
  return { template: MODELO_DE_RESUMO_PADRAO, customTemplateId: escolha.id, aiTemplate: null };
}

export async function definirPreferencias(ownerId: string, pedido: { padrao: string; estilo: EstiloDoResumo }) {
  const escolha = escolhaDoTexto(pedido.padrao);
  if (!escolha) throw new TRPCError({ code: "BAD_REQUEST", message: "Modelo inválido." });
  const db = await exigirDb();
  if (escolha.tipo === "proprio" && !(await modeloProprioDaDona(db, ownerId, escolha.id))) naoEncontrado();
  const colunas = {
    modeloPadrao: escolha.tipo === "pronto" ? escolha.modelo : escolha.tipo === "ia" ? "ia" : "proprio",
    modeloProprioPadraoId: escolha.tipo === "proprio" ? escolha.id : null,
    estiloPadrao: pedido.estilo,
    updatedAt: Date.now(),
  };
  await db.insert(preferenciasDoResumo).values({ ownerId, ...colunas }).onDuplicateKeyUpdate({ set: colunas });
  return modelosEPreferenciasDaDona(ownerId);
}

/** O pedido do resumo guardado em meetings.summary_request (H4e, antes de gravar). */
export type PedidoDoResumo = { modelo: string; estilo: EstiloDoResumo; instrucoes: string | null };

/** O pedido guardado, se ainda tem a forma certa; null se não. */
export function pedidoGuardado(valor: unknown): { escolha: EscolhaDoModelo; estilo: EstiloDoResumo; instrucoes: string | null } | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const bruto = valor as Record<string, unknown>;
  const escolha = escolhaDoTexto(bruto.modelo);
  const estilo = estiloDoResumo(bruto.estilo);
  if (!escolha || !estilo) return null;
  const instrucoes = typeof bruto.instrucoes === "string" ? normalizarInstrucoes(bruto.instrucoes, INSTRUCOES_DO_PEDIDO_MAX) : null;
  return { escolha, estilo, instrucoes };
}

// Antes de a reunião ficar pronta o pedido ainda vale: o resumo nasce no fim
// do processamento (server/meeting-service.ts).
const ESTADOS_QUE_ACEITAM_O_PEDIDO = ["draft", "recording", "uploading", "processing"] as const;

/**
 * O pedido do resumo feito antes de gravar (ou durante a gravação): o modelo,
 * o estilo e as instruções para esta reunião. Null apaga o pedido, e o resumo
 * nasce com as preferências. Só na reunião visível da dona (fora da lixeira,
 * H7d) que ainda não ficou pronta; depois disso, quem muda o resumo é o
 * "Refazer o resumo" (PRECONDITION_FAILED com o código).
 */
export async function definirPedidoDoResumo(ownerId: string, meetingId: string, pedido: PedidoDoResumo | null) {
  const db = await exigirDb();
  let guardado: PedidoDoResumo | null = null;
  if (pedido) {
    const escolha = escolhaDoTexto(pedido.modelo);
    if (!escolha) throw new TRPCError({ code: "BAD_REQUEST", message: "Modelo inválido." });
    if (escolha.tipo === "proprio" && !(await modeloProprioDaDona(db, ownerId, escolha.id))) naoEncontrado();
    guardado = { modelo: escolhaComoTexto(escolha), estilo: pedido.estilo, instrucoes: normalizarInstrucoes(pedido.instrucoes, INSTRUCOES_DO_PEDIDO_MAX) };
  }
  const r = await db.update(meetings).set({ summaryRequest: guardado })
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel(), inArray(meetings.status, [...ESTADOS_QUE_ACEITAM_O_PEDIDO])));
  if (linhas(r)) return { pedido: guardado };
  const [reuniao] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
  if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_MODELOS.pedidoForaDeHora });
}

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

export type ColunasDoPedido = {
  template: ModeloDeResumo; customTemplateId: string | null; aiTemplate: "pending" | null;
  style: EstiloDoResumo; instructions: string | null;
};

/**
 * As colunas do primeiro resumo de uma reunião, quando ela fica pronta: o
 * pedido feito antes de gravar, se houver e ainda valer; se não, as
 * preferências da dona. O modelo da dona apagado depois do pedido cai no
 * padrão dela (e, se também não vale, no Geral).
 */
export async function colunasDoPrimeiroResumo(db: Executor, ownerId: string, meetingId: string): Promise<ColunasDoPedido> {
  const [reuniao] = await db.select({ pedido: meetings.summaryRequest }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  const preferencias = await preferenciasDaDona(db, ownerId);
  const pedido = pedidoGuardado(reuniao?.pedido);
  let escolha = pedido?.escolha ?? preferencias.padrao;
  if (escolha.tipo === "proprio" && !(await modeloProprioDaDona(db, ownerId, escolha.id))) escolha = preferencias.padrao;
  // O padrão das preferências já foi conferido (preferenciasDaDona): o modelo
  // dela que ele cita existe.
  const colunas = await colunasDaEscolha(db, ownerId, escolha);
  return { ...colunas, style: pedido?.estilo ?? preferencias.estilo, instructions: pedido?.instrucoes ?? null };
}

/**
 * "O resumo teve o tamanho certo?" (H4e, como no app web do HiNoter): a
 * resposta da dona ao resumo pronto desta reunião, ou null para desfazer. O
 * ajuste dela (de -2 a +2) muda pelo passo da resposta, tirado o da resposta
 * anterior ao mesmo resumo: trocar de ideia não soma duas vezes. Uma
 * transação trava o resumo e as preferências.
 */
export async function responderTamanhoDoResumo(ownerId: string, meetingId: string, resposta: RespostaDoTamanho | null) {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({ id: meetings.id }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
    if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    const [resumo] = await tx.select({ id: meetingSummaries.id, status: meetingSummaries.status, lengthFeedback: meetingSummaries.lengthFeedback })
      .from(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId))).limit(1).for("update");
    if (!resumo || resumo.status !== "ready") throw new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_MODELOS.pedidoForaDeHora });
    const [preferencias] = await tx.select({ ajuste: preferenciasDoResumo.ajusteDoTamanho }).from(preferenciasDoResumo)
      .where(eq(preferenciasDoResumo.ownerId, ownerId)).limit(1).for("update");
    const anterior = (resumo.lengthFeedback ?? null) as RespostaDoTamanho | null;
    const ajuste = ajusteDepoisDaResposta(preferencias?.ajuste ?? 0, anterior, resposta);
    const agora = Date.now();
    await tx.update(meetingSummaries).set({ lengthFeedback: resposta, updatedAt: agora })
      .where(and(eq(meetingSummaries.id, resumo.id), eq(meetingSummaries.ownerId, ownerId)));
    await tx.insert(preferenciasDoResumo).values({ ownerId, ajusteDoTamanho: ajuste, updatedAt: agora })
      .onDuplicateKeyUpdate({ set: { ajusteDoTamanho: ajuste, updatedAt: agora } });
    return { resposta, ajusteDoTamanho: ajuste };
  });
}

/**
 * O teto de custo do "Refazer o resumo" (H4e): até REFAZERES_POR_DIA refazeres
 * aceitos por dona nas últimas 24 h, contados em resumos_refeitos (só a dona e
 * a hora). Reserva a vaga gravando a linha e devolve como soltá-la, para o
 * refazer que não chegou a criar trabalho (o pedido repetido, a corrida
 * perdida). A contagem e a gravação não travam nada: duas abas no mesmo
 * instante podem passar uma do teto, que é brando (o teto de pedidos à IA, de
 * 20 a cada 10 minutos, segura a rajada).
 */
export async function reservarRefazer(db: Banco, ownerId: string, agora = Date.now()): Promise<() => Promise<void>> {
  const [{ n }] = await db.select({ n: count() }).from(resumosRefeitos)
    .where(and(eq(resumosRefeitos.ownerId, ownerId), gte(resumosRefeitos.createdAt, agora - DIA_MS)));
  if (Number(n) >= REFAZERES_POR_DIA) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DOS_MODELOS.refazeresDemais });
  const id = crypto.randomUUID();
  await db.insert(resumosRefeitos).values({ id, ownerId, createdAt: agora });
  let solta = false;
  return async () => {
    if (solta) return;
    solta = true;
    await db.delete(resumosRefeitos).where(and(eq(resumosRefeitos.id, id), eq(resumosRefeitos.ownerId, ownerId)));
  };
}

/** Quantos refazeres a dona ainda tem nas próximas 24 h (para a tela dizer antes de ela tentar). */
export async function refazeresQueRestam(ownerId: string, agora = Date.now()): Promise<number> {
  const db = await exigirDb();
  const [{ n }] = await db.select({ n: count() }).from(resumosRefeitos)
    .where(and(eq(resumosRefeitos.ownerId, ownerId), gte(resumosRefeitos.createdAt, agora - DIA_MS)));
  return Math.max(0, REFAZERES_POR_DIA - Number(n));
}

/**
 * O que a fila precisa para escrever o resumo da dona: o modelo dela (se o
 * resumo usa um e ele ainda existe), o ajuste do tamanho e, quando a IA vai
 * escolher, a lista dos modelos dela.
 */
export async function contextoDaGeracao(db: Executor, ownerId: string, pedido: { customTemplateId: string | null; aiTemplate: string | null }) {
  const preferencias = await preferenciasDaDona(db, ownerId);
  const modeloProprio = pedido.customTemplateId ? await modeloProprioDaDona(db, ownerId, pedido.customTemplateId) : undefined;
  const proprios = pedido.aiTemplate === "pending" ? await modelosDaDona(db, ownerId) : [];
  return { modeloProprio: modeloProprio ?? null, ajusteDoTamanho: preferencias.ajusteDoTamanho, proprios };
}
