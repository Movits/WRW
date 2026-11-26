import crypto from "node:crypto";
import { and, asc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { filaDeCruzamento, users } from "../drizzle/schema";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { indexarPendentes, indexarPendentesDesde, ITENS_POR_VARREDURA, limparOrfas, maioresIdsDosItens, type MarcaDosItens } from "./indice-de-cruzamento";

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
 *     cursor gravado; cada lote pergunta ao índice e registra as conexões. O
 *     cursor só anda até o último contato cruzado POR INTEIRO (o lote que para
 *     no orçamento recomeça dele). Não há teto de registros (decisão do Roberto
 *     de 26/11): todo par que combina é registrado, uma vez só (a chave do par),
 *     e a linha guarda só quantas conexões o trabalho registrou;
 *   - "privado": o recálculo inteiro numa rodada, já indexado (sem o laço
 *     quadrático) e devolvendo a vez ao servidor no meio.
 *
 * Um trabalho vivo por dona e tipo, garantido no banco (índice único com
 * `vivo`): o pedido que chega com ele na fila só marca `de_novo`, e ele recomeça
 * do início ao terminar. O termo do Smart Match é conferido na hora de rodar
 * (revogado, o trabalho termina sem cruzar).
 *
 * A reserva (`lock_token`, `locked_until`) é curta e renovada enquanto o lote
 * roda; vence sozinha se o processo cair. Cada reserva conta uma tentativa (zera
 * quando o lote termina bem): o lote que derruba o processo (falta de memória,
 * SIGKILL) desiste depois de TENTATIVAS_DO_CRUZAMENTO, em vez de voltar para
 * sempre. Antes de cada bloco de gravação, o lote confere que a linha e a
 * reserva ainda são dele (a exclusão da conta apaga a linha; outra instância pode
 * ter tomado a reserva) e para sem gravar se não forem. O SIGTERM não devolve a
 * reserva de lote em andamento: encurta-a para depois do fim do processo. O
 * mesmo laço mantém o índice (`indexarPendentes` e `limparOrfas`).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
export type TipoDoCruzamento = "global" | "privado";

/** De quanto em quanto tempo o laço olha a fila. */
export const INTERVALO_DA_FILA_MS = 2000;
/**
 * A reserva de um lote, renovada a cada RENOVACAO_DA_RESERVA_MS enquanto ele roda: passado isso sem
 * renovar (o processo caiu), outra rodada o retoma. O recálculo privado da conta grande é um lote só
 * e leva minutos; a renovação é que o segura, não a folga.
 */
export const RESERVA_DO_LOTE_MS = 2 * 60_000;
export const RENOVACAO_DA_RESERVA_MS = 30_000;
/**
 * No SIGTERM, a reserva do lote em andamento passa a vencer daqui a isto: depois do fim do processo
 * antigo (`server/_core/index.ts` sai em até 10 s), para a instância nova não rodar o mesmo lote junto.
 */
export const PRAZO_DO_DESLIGAMENTO_MS = 15_000;
/** Reservas sem o lote terminar bem antes de o trabalho desistir. */
export const TENTATIVAS_DO_CRUZAMENTO = 3;
/** Por quanto tempo uma volta do laço roda lotes antes de devolver a vez. */
const TEMPO_POR_VOLTA_MS = 1500;

let parada = false;
const reservasVivas = new Map<string, number>();

function linhas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

/** A linha da fila sumiu (a exclusão da conta) ou a reserva passou a outra rodada: o lote para sem gravar. */
export class ReservaPerdida extends Error {
  constructor() { super("A reserva do trabalho de cruzamento não é mais deste lote."); this.name = "ReservaPerdida"; }
}

/**
 * Põe um cruzamento na fila (ou marca o vivo para recomeçar). Idempotente
 * para a mesma dona e tipo, também com dois pedidos ao mesmo tempo: o índice
 * único (dona, tipo, vivo) recusa o segundo vivo, e o INSERT vira a marca de_novo.
 */
export async function enfileirarCruzamento(trabalho: { ownerId: string; userId: number; tipo: TipoDoCruzamento }): Promise<{ id: number; novo: boolean }> {
  const db = await exigirDb();
  const agora = Date.now();
  await db.insert(filaDeCruzamento).values({
    ownerId: trabalho.ownerId, userId: trabalho.userId, tipo: trabalho.tipo, vivo: true, criadaEm: agora, atualizadaEm: agora,
  }).onDuplicateKeyUpdate({ set: { deNovo: true, atualizadaEm: agora } });
  const [vivo] = await db.select({ id: filaDeCruzamento.id, deNovo: filaDeCruzamento.deNovo }).from(filaDeCruzamento).where(and(
    eq(filaDeCruzamento.ownerId, trabalho.ownerId), eq(filaDeCruzamento.tipo, trabalho.tipo), eq(filaDeCruzamento.vivo, true),
  )).limit(1);
  // O vivo que já existia ganhou de_novo; o que acabou de nascer, não.
  if (!vivo) return { id: 0, novo: false };
  return { id: Number(vivo.id), novo: !vivo.deNovo };
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
  const daDona = escopo.ownerId ? eq(filaDeCruzamento.ownerId, escopo.ownerId) : undefined;
  // O trabalho cuja reserva venceu sem o lote terminar, TENTATIVAS vezes, derrubou o processo nelas: desiste.
  await db.update(filaDeCruzamento).set({
    estado: "falhou", vivo: null, lockToken: null, lockedUntil: null, atualizadaEm: agora,
    erro: `O lote parou sem terminar ${TENTATIVAS_DO_CRUZAMENTO} vezes (o processo caiu no meio).`,
  }).where(and(
    eq(filaDeCruzamento.estado, "pendente"), isNotNull(filaDeCruzamento.lockedUntil), lt(filaDeCruzamento.lockedUntil, agora),
    gte(filaDeCruzamento.tentativas, TENTATIVAS_DO_CRUZAMENTO), daDona,
  ));
  const livres = and(
    eq(filaDeCruzamento.estado, "pendente"),
    or(isNull(filaDeCruzamento.lockedUntil), lt(filaDeCruzamento.lockedUntil, agora)),
    lt(filaDeCruzamento.tentativas, TENTATIVAS_DO_CRUZAMENTO),
    daDona,
  );
  // O que foi mexido há mais tempo primeiro: os trabalhos se revezam por lote, e a base grande não segura a fila.
  const [candidato] = await db.select().from(filaDeCruzamento).where(livres).orderBy(asc(filaDeCruzamento.atualizadaEm), asc(filaDeCruzamento.id)).limit(1);
  if (!candidato) return null;
  const token = crypto.randomUUID();
  // A reserva conta a tentativa: se o processo cair no meio do lote, ela já está contada.
  const r = await db.update(filaDeCruzamento).set({
    lockToken: token, lockedUntil: agora + RESERVA_DO_LOTE_MS, tentativas: sql`${filaDeCruzamento.tentativas} + 1`,
  }).where(and(eq(filaDeCruzamento.id, candidato.id), livres));
  if (!linhas(r)) return null;
  reservasVivas.set(token, candidato.id);
  return { trabalho: { ...candidato, tentativas: candidato.tentativas + 1 }, token };
}

/**
 * Uma rodada: reserva o trabalho pendente mais antigo e roda UM lote dele.
 * Devolve o que fez, ou null sem trabalho. Exportada para os testes e para a
 * medida de carga; em produção, quem chama é o laço.
 */
export async function rodarUmLote(escopo: { ownerId?: string } = {}): Promise<{ trabalhoId: number; tipo: TipoDoCruzamento; terminou: boolean; conexoes: number; abandonado?: boolean } | null> {
  if (parada) return null;
  const db = await exigirDb();
  const agora = Date.now();
  const reserva = await reservar(db, escopo, agora);
  if (!reserva) return null;
  const { trabalho, token } = reserva;
  const minha = and(eq(filaDeCruzamento.id, trabalho.id), eq(filaDeCruzamento.lockToken, token));
  const situacao = { perdida: false };
  // A reserva é curta: o lote a renova enquanto roda. Renovar não casou linha = a reserva não é mais dele.
  const renovacao = setInterval(() => {
    if (parada || situacao.perdida) return;
    db.update(filaDeCruzamento).set({ lockedUntil: Date.now() + RESERVA_DO_LOTE_MS }).where(minha)
      .then(r => { if (!linhas(r)) situacao.perdida = true; })
      .catch(erro => console.warn(`[Cruzamento] não deu para renovar a reserva do trabalho ${trabalho.id}:`, descreverErroDeBanco(erro).slice(0, 300)));
  }, RENOVACAO_DA_RESERVA_MS);
  renovacao.unref?.();
  /** Antes de cada bloco de gravação: a linha e a reserva ainda são deste lote? */
  const antesDeGravar = async () => {
    if (situacao.perdida) throw new ReservaPerdida();
    const [linha] = await db.select({ id: filaDeCruzamento.id }).from(filaDeCruzamento).where(minha).limit(1);
    if (!linha) { situacao.perdida = true; throw new ReservaPerdida(); }
  };
  try {
    const { hasValidConsent } = await import("./routers/consent");
    const autorizada = await hasValidConsent(trabalho.userId, "termo_smart_match");
    let terminou = true;
    let conexoes = 0;
    let processados = 0;
    let proximoCursor = 0;
    if (autorizada && trabalho.tipo === "global") {
      const { cruzarUmLoteNaRedeGlobal } = await import("./network-rede-global");
      const lote = await cruzarUmLoteNaRedeGlobal({ id: trabalho.userId, openId: trabalho.ownerId }, Number(trabalho.cursor), undefined, { antesDeGravar });
      conexoes = lote.conexoes;
      processados = lote.processados;
      terminou = lote.proximoId === null;
      proximoCursor = lote.proximoId ?? 0;
    } else if (autorizada) {
      const [conta] = await db.select({ email: users.email }).from(users).where(eq(users.id, trabalho.userId)).limit(1);
      const { recalculatePrivateMatches } = await import("./match-service");
      const r = await recalculatePrivateMatches(trabalho.ownerId, conta?.email ?? null, { naFila: true, antesDeGravar });
      processados = r.total;
    }
    const fim = Date.now();
    if (!terminou) {
      await db.update(filaDeCruzamento).set({
        cursor: proximoCursor, processados: sql`${filaDeCruzamento.processados} + ${processados}`,
        conexoes: sql`${filaDeCruzamento.conexoes} + ${conexoes}`,
        tentativas: 0, lockToken: null, lockedUntil: null, atualizadaEm: fim,
      }).where(minha);
    } else {
      // Terminou. O pedido que chegou no meio (de_novo) recomeça do início, com a contagem zerada;
      // senão, concluída, e a vaga de vivo se abre para o próximo pedido.
      await db.update(filaDeCruzamento).set({
        estado: sql`case when ${filaDeCruzamento.deNovo} then 'pendente' else 'concluida' end`,
        vivo: sql`case when ${filaDeCruzamento.deNovo} then 1 else null end`,
        conexoes: sql`case when ${filaDeCruzamento.deNovo} then 0 else ${filaDeCruzamento.conexoes} + ${conexoes} end`,
        cursor: 0, deNovo: false, processados: sql`${filaDeCruzamento.processados} + ${processados}`,
        tentativas: 0, lockToken: null, lockedUntil: null, atualizadaEm: fim,
      }).where(minha);
    }
    return { trabalhoId: trabalho.id, tipo: trabalho.tipo, terminou, conexoes };
  } catch (erro) {
    if (erro instanceof ReservaPerdida) {
      console.info(`[Cruzamento] o trabalho ${trabalho.id} saiu da fila ou passou a outra rodada no meio do lote: parou sem gravar o resto.`);
      return { trabalhoId: trabalho.id, tipo: trabalho.tipo, terminou: false, conexoes: 0, abandonado: true };
    }
    if (ehErroDeBancoIndisponivel(erro)) {
      // A reserva não fica presa até vencer: tenta soltá-la (o banco pode ter voltado) sem engolir o erro de origem.
      // A queda do banco não é culpa do trabalho: a tentativa desta reserva não conta.
      try {
        await db.update(filaDeCruzamento).set({
          lockToken: null, lockedUntil: null, tentativas: sql`greatest(${filaDeCruzamento.tentativas} - 1, 0)`,
        }).where(minha);
      } catch (erroAoSoltar) {
        console.warn(`[Cruzamento] não deu para soltar a reserva do trabalho ${trabalho.id}:`, descreverErroDeBanco(erroAoSoltar).slice(0, 300));
      }
      throw erro;
    }
    // Só o SQL, nunca os parâmetros (podem trazer dado pessoal): no log e na linha.
    const mensagem = descreverErroDeBanco(erro).slice(0, 300);
    console.warn(`[Cruzamento] o lote do trabalho ${trabalho.id} falhou:`, mensagem);
    const desistiu = trabalho.tentativas >= TENTATIVAS_DO_CRUZAMENTO;
    await db.update(filaDeCruzamento).set({
      erro: mensagem, estado: desistiu ? "falhou" : "pendente", vivo: desistiu ? null : true,
      lockToken: null, lockedUntil: null, atualizadaEm: Date.now(),
    }).where(minha);
    return { trabalhoId: trabalho.id, tipo: trabalho.tipo, terminou: desistiu, conexoes: 0 };
  } finally {
    clearInterval(renovacao);
    reservasVivas.delete(token);
  }
}

/** De quanto em quanto tempo a manutenção do índice começa uma passada pela tabela inteira (e as órfãs). */
export const VARREDURA_COMPLETA_DO_INDICE_MS = 10 * 60_000;
/** Folga da varredura curta: item gravado por transação que terminou fora de ordem. */
const FOLGA_DA_MARCA = 2000;
let marca: MarcaDosItens | null = null;
let ultimaVarreduraCompleta = 0;
/** O cursor da passada pela tabela inteira em andamento (null: nenhuma). */
let passada: MarcaDosItens | null = null;
const FIM_DO_LADO = Number.MAX_SAFE_INTEGER;

/**
 * O índice em dia. A cada volta do laço, os itens novos desde a última marca
 * (com folga), para não varrer as duas tabelas a cada 2 s. De 10 em 10 minutos
 * (ou com `completa`) começa uma passada pela tabela inteira, em ordem de id e
 * em lotes de ITENS_POR_VARREDURA: a passada que não acaba numa volta continua
 * na seguinte, do cursor (a troca de VERSAO_DAS_CHAVES reindexa tudo assim,
 * sem esperar 10 minutos por lote). No fim da passada, as chaves órfãs.
 * Devolve quantas linhas mexeu; zero quer dizer índice em dia.
 */
export async function manterOIndice(opcoes: { completa?: boolean } = {}): Promise<number> {
  const db = await exigirDb();
  const agora = Date.now();
  const novaMarca = await maioresIdsDosItens(db);
  let mexidas = 0;
  if (marca) {
    const curtas = await indexarPendentes(db, undefined, { tem: Math.max(0, marca.tem - FOLGA_DA_MARCA), precisa: Math.max(0, marca.precisa - FOLGA_DA_MARCA) });
    mexidas += curtas;
    // Se a volta curta não deu conta de tudo, a marca não anda: a próxima continua de onde estava.
    if (curtas === 0) marca = novaMarca;
  }
  if (opcoes.completa || passada || !marca || agora - ultimaVarreduraCompleta > VARREDURA_COMPLETA_DO_INDICE_MS) {
    const desde = passada ?? { tem: 0, precisa: 0 };
    const r = await indexarPendentesDesde(db, ITENS_POR_VARREDURA, desde);
    mexidas += r.total;
    if (r.proximo.tem === null && r.proximo.precisa === null) {
      mexidas += await limparOrfas(db);
      passada = null;
      ultimaVarreduraCompleta = agora;
      if (!marca) marca = novaMarca;
    } else {
      passada = { tem: r.proximo.tem ?? FIM_DO_LADO, precisa: r.proximo.precisa ?? FIM_DO_LADO };
    }
  }
  return mexidas;
}

/** Só para os testes: a manutenção do índice esquece a marca e a passada (como num processo novo). */
export function esquecerAMarcaDoIndice() {
  marca = null;
  passada = null;
  ultimaVarreduraCompleta = 0;
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

/**
 * Desligamento: para de reservar e de renovar. A reserva do lote em andamento NÃO
 * é devolvida (a instância nova rodaria o mesmo lote junto com este, que ainda
 * roda até o processo sair): ela passa a vencer em PRAZO_DO_DESLIGAMENTO_MS,
 * depois do fim do processo, e a tentativa dela não conta. Se o lote terminar
 * antes, a gravação final dele solta a reserva como sempre.
 */
export async function pararFilaDeCruzamento(): Promise<{ trabalhos: number }> {
  parada = true;
  clearTimeout(timer);
  const reservas = Array.from(reservasVivas.entries());
  if (!reservas.length) return { trabalhos: 0 };
  const db = await exigirDb();
  let trabalhos = 0;
  for (const [token, id] of reservas) {
    trabalhos += linhas(await db.update(filaDeCruzamento).set({
      lockedUntil: Date.now() + PRAZO_DO_DESLIGAMENTO_MS, tentativas: sql`greatest(${filaDeCruzamento.tentativas} - 1, 0)`,
    }).where(and(eq(filaDeCruzamento.id, id), eq(filaDeCruzamento.lockToken, token))));
  }
  return { trabalhos };
}

/** Só para os testes: a fila volta a aceitar rodadas. */
export function religarParaTestes() {
  parada = false;
}
