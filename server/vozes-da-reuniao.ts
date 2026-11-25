import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { meetings, meetingTranscripts } from "../drizzle/schema";
import { CONTA_DA_DONA, contasDasVozes, FORMATO_DO_FALANTE, nomesDosFalantes, vozesJuntadas } from "@shared/const";
import { RECUSAS_DAS_VOZES } from "@shared/vozes-da-reuniao";
import { exigirDb } from "./db";
import { nomesDasContasDasVozes, participacaoAtivaDaReuniao } from "./participantes-da-reuniao";
import { reuniaoVisivel } from "./reuniao-visivel";

/**
 * As vozes das participantes (H3c do desenho de 16/11/2026): a dona liga cada
 * voz {Fn} à conta de quem falou (ela mesma ou uma participante ATIVA; o nome
 * da conta vira o nome da voz) e junta as vozes que são a mesma pessoa ("F3 é
 * a mesma pessoa que F1", a voz partida da gravação em partes).
 *
 * - speaker_accounts guarda "owner" ou o id da PARTICIPAÇÃO, nunca o users.id,
 *   e o nome é resolvido na hora de ler: a participante que sai, é removida ou
 *   exclui a conta some da voz sem passo novo na exclusão;
 * - speaker_merges guarda { voz: principal }, sem cadeia: a principal não se
 *   junta a outra, e juntar uma voz que já é principal de outras leva essas
 *   outras para a principal nova;
 * - o nome da conta vence o nome livre (speaker_names); a voz ligada à conta
 *   perde a ligação quando a dona digita um nome livre nela (nomearFalante);
 * - nada disto vai à IA: os nomes só trocam o rótulo na tela.
 *
 * Só a dona muda, com a linha travada (FOR UPDATE) e a reunião pronta, como
 * nomearFalante, e sem tocar em updated_at (a ficha de quem processa).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type BancoOuTransacao = Banco | Transacao;

const recusa = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });

/** Quem lê: com os nomes ou não (H3b) e, com eles, se as contas das participantes resolvem (padrão: sim). */
export type OpcoesDasVozes = { comNomes: boolean; contasDasParticipantes?: boolean };

/** O que a tela usa para mostrar as vozes: os nomes (já com as contas) e as juntadas. */
export type VozesParaQuemLe = { nomes: Record<string, string>; juntadas: Record<string, string> };

/**
 * As vozes como quem lê as vê. Nesta ordem, voz a voz: a conta ligada válida
 * (o nome do perfil ou o da conta), o nome livre e nada (a tela mostra
 * "Falante n"). As juntadas saem à parte, sem dado pessoal: a tela mostra a
 * voz juntada com o nome, ou o rótulo, da principal.
 *
 * `comNomes` falso (o link ligado com a confirmação antiga, H3b) devolve os
 * nomes vazios e só as juntadas. `contasDasParticipantes` falso (a membra da
 * equipe, R2) resolve só a conta da dona: a voz ligada à conta de uma
 * participante fica sem nome ("Falante n"), nem o livre de antes da ligação.
 */
export async function vozesParaQuemLe(
  ex: BancoOuTransacao,
  reuniao: { id: string; ownerId: string; speakerNames: unknown; speakerAccounts: unknown; speakerMerges: unknown },
  opcoes: OpcoesDasVozes,
): Promise<VozesParaQuemLe> {
  const juntadas = vozesJuntadas(reuniao.speakerMerges);
  if (!opcoes.comNomes) return { nomes: {}, juntadas };
  const nomes = nomesDosFalantes(reuniao.speakerNames);
  let contas = contasDasVozes(reuniao.speakerAccounts);
  if (opcoes.contasDasParticipantes === false) {
    const soDaDona: Record<string, string> = {};
    for (const [voz, conta] of Object.entries(contas)) {
      if (conta === CONTA_DA_DONA) soDaDona[voz] = conta;
      else delete nomes[voz];
    }
    contas = soDaDona;
  }
  if (Object.keys(contas).length) Object.assign(nomes, await nomesDasContasDasVozes(ex, reuniao, contas));
  return { nomes, juntadas };
}

/** As vozes da reunião pelo id, lidas pela própria consulta (o link e a participante). */
export async function vozesDaReuniao(ex: BancoOuTransacao, reuniao: { id: string; ownerId: string }, opcoes: OpcoesDasVozes): Promise<VozesParaQuemLe> {
  const [linha] = await ex.select({ speakerNames: meetings.speakerNames, speakerAccounts: meetings.speakerAccounts, speakerMerges: meetings.speakerMerges })
    .from(meetings).where(and(eq(meetings.id, reuniao.id), eq(meetings.ownerId, reuniao.ownerId))).limit(1);
  if (!linha) return { nomes: {}, juntadas: {} };
  return vozesParaQuemLe(ex, { ...reuniao, ...linha }, opcoes);
}

/** A reunião da dona, pronta e visível, com a linha travada e as colunas das vozes. */
async function reuniaoTravada(tx: Transacao, ownerId: string, meetingId: string) {
  const [reuniao] = await tx.select({
    status: meetings.status, speakerNames: meetings.speakerNames, speakerAccounts: meetings.speakerAccounts, speakerMerges: meetings.speakerMerges,
  }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1).for("update");
  if (!reuniao) throw recusa("NOT_FOUND", RECUSAS_DAS_VOZES.reuniaoNaoEncontrada);
  if (reuniao.status !== "ready") throw recusa("CONFLICT", RECUSAS_DAS_VOZES.soReuniaoPronta);
  return reuniao;
}

/** As vozes que aparecem nas falas da transcrição (F1, F2...). */
async function vozesDasFalas(tx: Transacao, ownerId: string, meetingId: string): Promise<Set<string>> {
  const [transcricao] = await tx.select({ segmentos: meetingTranscripts.segments }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  const vozes = new Set<string>();
  if (Array.isArray(transcricao?.segmentos)) {
    for (const segmento of transcricao.segmentos as unknown[]) {
      const falante = (segmento as { falante?: unknown } | null)?.falante;
      if (typeof falante === "string" && FORMATO_DO_FALANTE.test(falante)) vozes.add(falante);
    }
  }
  return vozes;
}

/**
 * Liga a voz a uma conta: "owner" (a própria dona) ou o id de uma
 * participação ATIVA desta reunião. null desliga. A participação convidada e
 * ainda não aceita, a de outra reunião e a que não existe são recusadas com o
 * mesmo código.
 */
export async function ligarVozAConta(ownerId: string, meetingId: string, falante: string, conta: string | null): Promise<Record<string, string>> {
  if (!FORMATO_DO_FALANTE.test(falante)) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.vozInvalida);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const reuniao = await reuniaoTravada(tx, ownerId, meetingId);
    const contas = contasDasVozes(reuniao.speakerAccounts);
    if (conta === null) delete contas[falante];
    else {
      if (conta !== CONTA_DA_DONA && !(await participacaoAtivaDaReuniao(tx, ownerId, meetingId, conta))) {
        throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.contaInvalida);
      }
      contas[falante] = conta;
    }
    await tx.update(meetings).set({ speakerAccounts: Object.keys(contas).length ? contas : null })
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "ready")));
    return contas;
  });
}

/**
 * Junta `voz` à `principal` ("F3 é a mesma pessoa que F1"). Recusa a voz
 * juntada a si mesma, a voz que não está nas falas e a principal que já está
 * juntada a outra (sem cadeia). As vozes que apontavam para `voz` passam a
 * apontar para a principal nova. O nome e a conta da voz juntada ficam
 * guardados, sem uso: "Separar" os devolve.
 */
export async function juntarVozes(ownerId: string, meetingId: string, voz: string, principal: string): Promise<Record<string, string>> {
  if (!FORMATO_DO_FALANTE.test(voz) || !FORMATO_DO_FALANTE.test(principal)) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.vozInvalida);
  if (voz === principal) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.juntarASiMesma);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const reuniao = await reuniaoTravada(tx, ownerId, meetingId);
    const vozes = await vozesDasFalas(tx, ownerId, meetingId);
    if (!vozes.has(voz) || !vozes.has(principal)) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.vozInvalida);
    const juntadas = vozesJuntadas(reuniao.speakerMerges);
    if (principal in juntadas) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.principalJuntada);
    for (const [outra, alvo] of Object.entries(juntadas)) if (alvo === voz) juntadas[outra] = principal;
    juntadas[voz] = principal;
    await tx.update(meetings).set({ speakerMerges: juntadas })
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "ready")));
    return juntadas;
  });
}

/** Separa a voz juntada: ela volta com o nome e a conta que tinha. Separar a que não está juntada não é erro. */
export async function separarVoz(ownerId: string, meetingId: string, voz: string): Promise<Record<string, string>> {
  if (!FORMATO_DO_FALANTE.test(voz)) throw recusa("BAD_REQUEST", RECUSAS_DAS_VOZES.vozInvalida);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const reuniao = await reuniaoTravada(tx, ownerId, meetingId);
    const juntadas = vozesJuntadas(reuniao.speakerMerges);
    if (!(voz in juntadas)) return juntadas;
    delete juntadas[voz];
    await tx.update(meetings).set({ speakerMerges: Object.keys(juntadas).length ? juntadas : null })
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "ready")));
    return juntadas;
  });
}

/**
 * O nome livre (H3) dado a uma voz ligada a conta tira a ligação: a dona
 * escolheu "Outra pessoa" no seletor. Roda dentro da transação de
 * nomearFalante, com a linha já travada.
 */
export async function soltarContaDaVozNaTransacao(tx: Transacao, ownerId: string, meetingId: string, falante: string, speakerAccounts: unknown) {
  const contas = contasDasVozes(speakerAccounts);
  if (!(falante in contas)) return;
  delete contas[falante];
  await tx.update(meetings).set({ speakerAccounts: Object.keys(contas).length ? contas : null })
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
}
