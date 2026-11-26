import crypto from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { filaDeCruzamento, users } from "../drizzle/schema";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { indexarPendentes, limparOrfas, maioresIdsDosItens } from "./indice-de-cruzamento";

/**
 * A fila do cruzamento grande (N4b, docs/arquitetura/entidades.md, seção 8).
 *
 * Dois trabalhos não cabem num pedido HTTP na conta de uma entidade com dezenas
 * de milhares de associados: a busca da base inteira na rede global e o
 * recálculo do motor privado. Os dois vêm para cá (`procurarConexoesNaRedeGlobal`
 * e `recalculatePrivateMatches` decidem pelo tamanho) e rodam no próprio
 * processo, em lotes, com o laço de `iniciarFilaDeCruzamento`:
 *
 *   - "global": CONTATOS_POR_LOTE contatos por rodada, em ordem de id, com o
 *     cursor gravado; cada lote pergunta ao índice e registra as conexões com
 *     os tetos de sempre por rodada e por contraparte;
 *   - "privado": o recálculo inteiro numa rodada, já indexado (sem o laço
 *     quadrático) e devolvendo a vez ao servidor no meio.
 *
 * Um trabalho vivo por dona e tipo: o pedido que chega com ele na fila só marca
 * `de_novo`, e ele recomeça do início ao terminar. O termo do Smart Match é
 * conferido na hora de rodar (revogado, o trabalho termina sem cruzar). A
 * reserva (`lock_token`, `locked_until`) vence sozinha se o processo cair; o
 * SIGTERM a devolve. O mesmo laço mantém o índice (`indexarPendentes` e
 * `limparOrfas`).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
export type TipoDoCruzamento = "global" | "privado";

/** De quanto em quanto tempo o laço olha a fila. */
export const INTERVALO_DA_FILA_MS = 2000;
/**
 * A reserva de um lote: passado isso sem terminar, outra rodada o retoma. O recálculo privado da
 * conta grande é um lote só (e registra as conexões internas uma a uma): 30 minutos de folga.
 */
export const RESERVA_DO_LOTE_MS = 30 * 60_000;
/** Falhas seguidas antes de o trabalho desistir. */
export const TENTATIVAS_DO_CRUZAMENTO = 3;
/** Por quanto tempo uma volta do laço roda lotes antes de devolver a vez. */
const TEMPO_POR_VOLTA_MS = 1500;

let parada = false;
const reservasVivas = new Map<string, number>();

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

/**
 * Põe um cruzamento na fila (ou marca o vivo para recomeçar). Idempotente
 * para a mesma dona e tipo: a fila nunca tem dois vivos.
 */
export async function enfileirarCruzamento(trabalho: { ownerId: string; userId: number; tipo: TipoDoCruzamento }): Promise<{ id: number; novo: boolean }> {
  const db = await exigirDb();
  const agora = Date.now();
  const [vivo] = await db.select({ id: filaDeCruzamento.id }).from(filaDeCruzamento).where(and(
    eq(filaDeCruzamento.ownerId, trabalho.ownerId), eq(filaDeCruzamento.tipo, trabalho.tipo), eq(filaDeCruzamento.estado, "pendente"),
  )).limit(1);
  if (vivo) {
    await db.update(filaDeCruzamento).set({ deNovo: true, atualizadaEm: agora }).where(eq(filaDeCruzamento.id, vivo.id));
    return { id: vivo.id, novo: false };
  }
  const [resultado] = await db.insert(filaDeCruzamento).values({
    ownerId: trabalho.ownerId, userId: trabalho.userId, tipo: trabalho.tipo, criadaEm: agora, atualizadaEm: agora,
  });
  return { id: Number((resultado as unknown as { insertId: number }).insertId), novo: true };
}

/** O recálculo privado de uma conta grande (quem chama só tem o openId da dona). */
export async function enfileirarRecalculoPrivado(ownerId: string): Promise<void> {
  const db = await exigirDb();
  const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, ownerId)).limit(1);
  if (!conta) return;
  await enfileirarCruzamento({ ownerId, userId: conta.id, tipo: "privado" });
}

type Trabalho = typeof filaDeCruzamento.$inferSelect;

async function reservar(db: Banco, escopo: { ownerId?: string }, agora: number): Promise<{ trabalho: Trabalho; token: string } | null> {
  const livres = and(
    eq(filaDeCruzamento.estado, "pendente"),
    or(isNull(filaDeCruzamento.lockedUntil), lt(filaDeCruzamento.lockedUntil, agora)),
    escopo.ownerId ? eq(filaDeCruzamento.ownerId, escopo.ownerId) : undefined,
  );
  // O que foi mexido há mais tempo primeiro: os trabalhos se revezam por lote, e a base grande não segura a fila.
  const [candidato] = await db.select().from(filaDeCruzamento).where(livres).orderBy(asc(filaDeCruzamento.atualizadaEm), asc(filaDeCruzamento.id)).limit(1);
  if (!candidato) return null;
  const token = crypto.randomUUID();
  const r = await db.update(filaDeCruzamento).set({ lockToken: token, lockedUntil: agora + RESERVA_DO_LOTE_MS })
    .where(and(eq(filaDeCruzamento.id, candidato.id), livres));
  if (!linhas(r)) return null;
  reservasVivas.set(token, candidato.id);
  return { trabalho: candidato, token };
}

/**
 * Uma rodada: reserva o trabalho pendente mais antigo e roda UM lote dele.
 * Devolve o que fez, ou null sem trabalho. Exportada para os testes e para a
 * medida de carga; em produção, quem chama é o laço.
 */
export async function rodarUmLote(escopo: { ownerId?: string } = {}): Promise<{ trabalhoId: number; tipo: TipoDoCruzamento; terminou: boolean; conexoes: number } | null> {
  if (parada) return null;
  const db = await exigirDb();
  const agora = Date.now();
  const reserva = await reservar(db, escopo, agora);
  if (!reserva) return null;
  const { trabalho, token } = reserva;
  const minha = and(eq(filaDeCruzamento.id, trabalho.id), eq(filaDeCruzamento.lockToken, token));
  try {
    const { hasValidConsent } = await import("./routers/consent");
    const autorizada = await hasValidConsent(trabalho.userId, "termo_smart_match");
    let terminou = true;
    let conexoes = 0;
    let processados = 0;
    let proximoCursor = 0;
    if (autorizada && trabalho.tipo === "global") {
      const { cruzarUmLoteNaRedeGlobal } = await import("./network-rede-global");
      const lote = await cruzarUmLoteNaRedeGlobal({ id: trabalho.userId, openId: trabalho.ownerId }, Number(trabalho.cursor));
      conexoes = lote.conexoes;
      processados = lote.processados;
      terminou = lote.proximoId === null;
      proximoCursor = lote.proximoId ?? 0;
    } else if (autorizada) {
      const [conta] = await db.select({ email: users.email }).from(users).where(eq(users.id, trabalho.userId)).limit(1);
      const { recalculatePrivateMatches } = await import("./match-service");
      const r = await recalculatePrivateMatches(trabalho.ownerId, conta?.email ?? null, { naFila: true });
      processados = r.total;
    }
    const fim = Date.now();
    if (!terminou) {
      await db.update(filaDeCruzamento).set({
        cursor: proximoCursor, processados: sql`${filaDeCruzamento.processados} + ${processados}`,
        conexoes: sql`${filaDeCruzamento.conexoes} + ${conexoes}`, tentativas: 0, lockToken: null, lockedUntil: null, atualizadaEm: fim,
      }).where(minha);
    } else {
      // Terminou. O pedido que chegou no meio (de_novo) recomeça do início; senão, concluída.
      await db.update(filaDeCruzamento).set({
        estado: sql`case when ${filaDeCruzamento.deNovo} then 'pendente' else 'concluida' end`,
        cursor: 0, deNovo: false, processados: sql`${filaDeCruzamento.processados} + ${processados}`,
        conexoes: sql`${filaDeCruzamento.conexoes} + ${conexoes}`, tentativas: 0, lockToken: null, lockedUntil: null, atualizadaEm: fim,
      }).where(minha);
    }
    return { trabalhoId: trabalho.id, tipo: trabalho.tipo, terminou, conexoes };
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    const mensagem = (erro instanceof Error ? erro.message : String(erro)).slice(0, 300);
    console.warn(`[Cruzamento] o lote do trabalho ${trabalho.id} falhou:`, mensagem);
    const tentativas = trabalho.tentativas + 1;
    await db.update(filaDeCruzamento).set({
      tentativas, erro: mensagem, estado: tentativas >= TENTATIVAS_DO_CRUZAMENTO ? "falhou" : "pendente",
      lockToken: null, lockedUntil: null, atualizadaEm: Date.now(),
    }).where(minha);
    return { trabalhoId: trabalho.id, tipo: trabalho.tipo, terminou: tentativas >= TENTATIVAS_DO_CRUZAMENTO, conexoes: 0 };
  } finally {
    reservasVivas.delete(token);
  }
}

/** De quanto em quanto tempo a manutenção do índice varre as tabelas inteiras (e as órfãs). */
export const VARREDURA_COMPLETA_DO_INDICE_MS = 10 * 60_000;
/** Folga da varredura curta: item gravado por transação que terminou fora de ordem. */
const FOLGA_DA_MARCA = 2000;
let marca: { tem: number; precisa: number } | null = null;
let ultimaVarreduraCompleta = 0;

/**
 * O índice em dia. A cada volta do laço, só os itens novos desde a última
 * marca (com folga), para não varrer as duas tabelas a cada 2 s; de 10 em 10
 * minutos (ou com `completa`), as tabelas inteiras e as chaves órfãs.
 * Devolve quantas linhas mexeu.
 */
export async function manterOIndice(opcoes: { completa?: boolean } = {}): Promise<number> {
  const db = await exigirDb();
  const agora = Date.now();
  const novaMarca = await maioresIdsDosItens(db);
  let mexidas: number;
  if (opcoes.completa || !marca || agora - ultimaVarreduraCompleta > VARREDURA_COMPLETA_DO_INDICE_MS) {
    mexidas = (await indexarPendentes(db)) + (await limparOrfas(db));
    ultimaVarreduraCompleta = agora;
  } else {
    mexidas = await indexarPendentes(db, undefined, { tem: Math.max(0, marca.tem - FOLGA_DA_MARCA), precisa: Math.max(0, marca.precisa - FOLGA_DA_MARCA) });
  }
  // Se a volta não deu conta de tudo, a marca não anda: a próxima continua de onde estava.
  if (mexidas === 0 || !marca) marca = mexidas === 0 ? novaMarca : { tem: 0, precisa: 0 };
  return mexidas;
}

/**
 * Roda até não haver mais trabalho (da dona, se dada): para os testes e a
 * medida de carga, que não esperam o laço. Mantém o índice antes.
 */
export async function rodarFilaAteEsvaziar(escopo: { ownerId?: string } = {}): Promise<{ lotes: number; conexoes: number }> {
  while ((await manterOIndice({ completa: true })) > 0) { /* até o índice ficar em dia */ }
  let lotes = 0;
  let conexoes = 0;
  for (;;) {
    const feito = await rodarUmLote(escopo);
    if (!feito) break;
    lotes += 1;
    conexoes += feito.conexoes;
  }
  return { lotes, conexoes };
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Liga o laço (no boot do servidor, com banco). */
export function iniciarFilaDeCruzamento(intervaloMs = INTERVALO_DA_FILA_MS) {
  parada = false;
  const volta = async () => {
    await manterOIndice();
    const ate = Date.now() + TEMPO_POR_VOLTA_MS;
    while (!parada && Date.now() < ate) {
      if (!(await rodarUmLote())) break;
    }
  };
  const proxima = () => {
    if (parada) return;
    timer = setTimeout(() => {
      // Uma volta por vez, e ela nunca rejeita solta (derrubaria o processo): todo erro vira log.
      volta()
        .catch(erro => console.error("[Cruzamento] a volta da fila falhou:", descreverErroDeBanco(erro)))
        .finally(proxima);
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/** Desligamento: para de reservar e devolve as reservas desta instância. */
export async function pararFilaDeCruzamento(): Promise<{ trabalhos: number }> {
  parada = true;
  clearTimeout(timer);
  const reservas = Array.from(reservasVivas.entries());
  if (!reservas.length) return { trabalhos: 0 };
  const db = await exigirDb();
  let trabalhos = 0;
  for (const [token, id] of reservas) {
    trabalhos += linhas(await db.update(filaDeCruzamento).set({ lockToken: null, lockedUntil: null })
      .where(and(eq(filaDeCruzamento.id, id), eq(filaDeCruzamento.lockToken, token))));
  }
  reservasVivas.clear();
  return { trabalhos };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}
