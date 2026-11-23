import crypto from "crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { auditLogs, meetingAttachments, meetingAudioSlices, meetingRecordings, meetings } from "../drizzle/schema";
import { exigirDb } from "./db";
import { foraDaLixeira } from "./reuniao-visivel";
import { ALLOWED_MEETING_AUDIO_TYPES, apagarDerivadosDaReuniaoJuntada, apagarDerivadosDoAlvoDaJuncao, MAX_MEETING_AUDIO_BYTES } from "./meeting-service";
import { LINK_DESLIGADO } from "./link-aberto-da-reuniao";
import { CAUSAS_DA_PARTE_SEM_AUDIO } from "./audio-guardado-das-partes";
import { FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS } from "./fatias-de-reuniao";
import { DURACAO_DA_FATIA_SEGUNDOS, MARCA_DE_OUTRA_REUNIAO, type Segmento } from "./transcricao-de-fatia";
import { chaveDoStorageDaDona } from "./storage";
import {
  GRAVACAO_EM_PARTES_SEGUNDOS_MAX, LIMITE_PROCESSAMENTO_MS, margemDoReprocesso, nomesDosFalantes, PARTES_POR_REUNIAO_MAX,
} from "@shared/const";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import { etiquetasDaReuniao, normalizarEtiquetas } from "@shared/detalhes-da-reuniao";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado } from "@shared/idioma-da-reuniao";
import { RECUSAS_DA_JUNCAO, REUNIOES_POR_JUNCAO_MAX, type CodigoDaRecusaDaJuncao } from "@shared/juntar-reunioes";

/**
 * Juntar reuniões (H17; HN-06 no app de referência): duas ou mais reuniões
 * gravadas viram uma só, a PRIMEIRA da ordem escolhida (o "alvo"). Tudo numa
 * transação, com as linhas das reuniões travadas, e sem bucket: nenhum áudio é
 * copiado, porque o objeto fica onde está e só a LINHA que aponta para ele muda
 * de reunião (a linha é o ponteiro, e nunca há um instante sem ponteiro).
 *
 * 1. As partes de cada reunião entram depois das partes da anterior: a posição
 *    (seq) e o início (offset) são deslocados, e as falas guardadas de cada
 *    parte (result) também, no tempo e no rótulo da voz. Os rótulos das
 *    reuniões seguintes começam depois dos da anterior (o F1 da segunda vira
 *    F3, se a primeira tinha F1 e F2): a mesma pessoa pode ganhar dois rótulos,
 *    mas duas pessoas nunca se fundem num só. Os nomes que a dona deu às vozes
 *    (H3) vão junto, nos rótulos novos.
 *    As falas das reuniões com idioma escolhido levam esse idioma (o campo
 *    `idioma` da fala, que a G16 grava no "Detectar sozinho"): com o alvo em
 *    "Detectar sozinho", o idioma da reunião juntada é o que mais aparece em
 *    todas as falas, e não só nas do alvo.
 * 2. A reunião de envio único (até 10 min, um arquivo só, da época do teto de
 *    10 minutos) não tem falas por voz guardadas: a gravação dela vira uma
 *    parte 'received', que a fila transcreve de novo. Daí em diante, para os
 *    rótulos seguirem uma conta só, todas as partes seguintes também são
 *    transcritas de novo, e os nomes das vozes delas saem. A primeira parte
 *    retranscrita de cada reunião leva a marca de outra conversa
 *    (MARCA_DE_OUTRA_REUNIAO): a fila a transcreve sem o contexto da reunião
 *    de antes, com os rótulos depois dos já usados, e as vozes (e os nomes)
 *    da reunião de antes não passam para as pessoas desta.
 * 3. O alvo volta a 'uploading' com o total de partes, e a fila
 *    (server/fila-de-transcricao.ts) monta a transcrição, refaz a extração e
 *    pede o resumo de novo, pelo mesmo caminho da gravação em partes. A IA só
 *    transcreve o que o passo 2 marcou. O que a IA gerou do alvo (só da
 *    primeira reunião) sai já na transação, como na montagem: até ela, a tela
 *    mostra o andamento das partes, e não o conteúdo antigo.
 * 4. As outras reuniões saem, com tudo o que a IA gerou delas (como na
 *    exclusão: as próximas ações se soltam com os nomes resolvidos, e os
 *    avisos do sino e o ponteiro da agenda saem), mas sem o áudio, que agora é
 *    do alvo.
 * 5. O link aberto do alvo é desligado: quem tinha o link autorizou a reunião
 *    de antes, e não as outras. A dona liga de novo, com a confirmação.
 * 6. A auditoria (MEETINGS_JOINED) vai na mesma transação, com a prova do
 *    aviso de gravação de cada reunião (a hora e a versão do aviso aceito):
 *    as linhas das outras saem, e o áudio delas segue na reunião que fica.
 *
 * 7. As fotos e os desenhos do resumo (H4g e H4h) das outras reuniões passam
 *    para a que fica, como o áudio: só a linha muda de reunião, o objeto e o
 *    prazo ficam. O teto de anexos por reunião vale para anexar, não aqui: a
 *    junção nunca apaga o que a dona anexou.
 *
 * O prazo de cada áudio não muda (30 dias desde o envio dele): a junção nunca
 * guarda áudio além do prazo, e o áudio mais novo não vence antes por ter sido
 * juntado ao mais velho (decisão vetável, anotada no relatório da H17).
 */

type CodigoTrpc = "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED";

/** Recusa da junção: o código tRPC e o código que a tela traduz. Nada foi escrito. */
export class RecusaDaJuncao extends Error {
  constructor(readonly codigoTrpc: CodigoTrpc, codigo: CodigoDaRecusaDaJuncao | "REUNIAO_NAO_ENCONTRADA" | "JUNCAO_INVALIDA") {
    super(codigo);
  }
}

type StatusDaParte = "uploading" | "received" | "transcribed" | "failed";

export type ParteParaJuntar = {
  id: string; seq: number; status: StatusDaParte; durationMs: number; offsetMs: number | null;
  result: unknown; lastError: string | null; expiresAt: number;
};
export type GravacaoParaJuntar = {
  id: string; storageKey: string; storageUrl: string; mimeType: string; sizeBytes: number; durationSeconds: number; expiresAt: number; createdAt: number;
};
export type ReuniaoParaJuntar = {
  id: string; status: string; audioPipeline: "single" | "slices"; origem: string | null; consentGranted: boolean;
  /** O idioma escolhido para a reunião (G16): "auto" é o "Detectar sozinho"; nulo, o padrão de antes da escolha. */
  language?: string | null;
  expectedSlices: number | null; speakerNames: unknown; etiquetas: unknown; ondeFoi: string | null;
  contactId: number | null; contextId: string | null; shareToken: string | null;
  partes: ParteParaJuntar[];
  /** A gravação do envio único (a mais recente da reunião); nula na reunião em partes. */
  gravacao: GravacaoParaJuntar | null;
};

/** Uma parte que muda: de reunião, de posição, de início, nas falas ou no estado. */
export type ParteQueMuda = {
  id: string; seq: number; offsetMs: number | null; result: unknown; status: StatusDaParte;
  /** Volta à fila para ser transcrita de novo (as tentativas e o erro zeram). */
  retranscrever: boolean;
};
/** A gravação do envio único que vira uma parte da reunião juntada. */
export type GravacaoQueViraParte = Omit<GravacaoParaJuntar, "durationSeconds" | "id"> & {
  gravacaoId: string; seq: number; durationMs: number;
  /** A gravação de uma reunião que não é a primeira: outra conversa (MARCA_DE_OUTRA_REUNIAO). */
  outraReuniao: boolean;
};

export type PlanoDaJuncao = {
  partes: ParteQueMuda[];
  gravacoes: GravacaoQueViraParte[];
  /** As posições da reunião juntada (com as lacunas das reuniões de origem): o teto de partes e o tempo contam por elas. */
  esperadas: number;
  /**
   * As linhas de parte que a reunião juntada fica tendo, e o expected_slices que
   * ela grava. Não são as posições: a parte que nunca chegou numa reunião de
   * origem já é lacuna definitiva (a montagem dela esperou as 24 h), e com o
   * total das posições a fila esperaria por ela de novo, 24 h depois da parte
   * mais nova. A montagem ainda vê as lacunas, porque conta até a maior posição.
   */
  linhas: number;
  duracaoSegundos: number;
  retranscreve: boolean;
  nomes: Record<string, string> | null;
  etiquetas: string[] | null;
  ondeFoi: string | null;
  contactId: number | null;
  contextId: string | null;
};

const ROTULO = /^F([1-9]\d*)$/;
/** O maior rótulo de voz que uma junção aceita (F99, o formato da transcrição em partes). */
export const MAIOR_ROTULO = 99;

function numeroDoRotulo(falante: unknown): number {
  const casou = typeof falante === "string" ? ROTULO.exec(falante) : null;
  return casou ? Number(casou[1]) : 0;
}

function deslocarRotulo(falante: string, deslocamento: number): string {
  const numero = numeroDoRotulo(falante);
  return numero && deslocamento ? `F${numero + deslocamento}` : falante;
}

function ehSegmento(valor: unknown): valor is Segmento {
  const s = valor as Segmento | null;
  return !!s && typeof s === "object" && typeof s.inicio === "number" && typeof s.fim === "number" && typeof s.falante === "string";
}

function deslocarSegmento(segmento: unknown, rotulos: number, segundos: number, idioma?: string | null): unknown {
  if (!ehSegmento(segmento)) return segmento;
  const comIdioma = idioma && !segmento.lacuna && typeof segmento.idioma !== "string" ? { idioma } : {};
  return { ...segmento, falante: deslocarRotulo(segmento.falante, rotulos), inicio: segmento.inicio + segundos, fim: segmento.fim + segundos, ...comIdioma };
}

/**
 * As falas guardadas de uma parte (o `result` da fila: segmentos, contexto
 * para a parte seguinte e, às vezes, as contagens dos tempos), com os rótulos
 * das vozes deslocados em `rotulos` e os tempos em `segundos`. Com `idioma`
 * (o escolhido para a reunião de origem), a fala sem idioma passa a tê-lo. O
 * resto fica.
 */
export function deslocarResultado(result: unknown, rotulos: number, segundos: number, idioma?: string | null): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as { segmentos?: unknown; contexto?: { falantes?: unknown; ultimasFalas?: unknown } };
  const saida: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  if (Array.isArray(r.segmentos)) saida.segmentos = r.segmentos.map(segmento => deslocarSegmento(segmento, rotulos, segundos, idioma));
  if (r.contexto && typeof r.contexto === "object") {
    saida.contexto = {
      ...r.contexto,
      falantes: Array.isArray(r.contexto.falantes) ? r.contexto.falantes.map(f => typeof f === "string" ? deslocarRotulo(f, rotulos) : f) : r.contexto.falantes,
      ultimasFalas: Array.isArray(r.contexto.ultimasFalas) ? r.contexto.ultimasFalas.map(s => deslocarSegmento(s, rotulos, segundos)) : r.contexto.ultimasFalas,
    };
  }
  return saida;
}

/** O maior rótulo de voz que a reunião usa: nas falas guardadas das partes, no contexto delas e nos nomes que a dona deu. */
export function maiorRotuloDaReuniao(reuniao: Pick<ReuniaoParaJuntar, "partes" | "speakerNames">): number {
  let maior = 0;
  for (const falante of Object.keys(nomesDosFalantes(reuniao.speakerNames))) maior = Math.max(maior, numeroDoRotulo(falante));
  for (const parte of reuniao.partes) {
    const r = parte.result as { segmentos?: unknown; contexto?: { falantes?: unknown } } | null;
    if (Array.isArray(r?.segmentos)) for (const s of r.segmentos) maior = Math.max(maior, numeroDoRotulo((s as { falante?: unknown })?.falante));
    if (Array.isArray(r?.contexto?.falantes)) for (const f of r.contexto.falantes) maior = Math.max(maior, numeroDoRotulo(f));
  }
  return maior;
}

/** A gravação do envio único pode virar parte? Os mesmos limites do envio e o espaço desta reunião desta dona no bucket. */
function gravacaoAproveitavel(ownerId: string, reuniao: ReuniaoParaJuntar): boolean {
  const g = reuniao.gravacao;
  if (!g) return false;
  if (!(ALLOWED_MEETING_AUDIO_TYPES as readonly string[]).includes(g.mimeType)) return false;
  if (!(g.sizeBytes > 0 && g.sizeBytes <= MAX_MEETING_AUDIO_BYTES) || !(g.durationSeconds > 0)) return false;
  const chave = chaveDoStorageDaDona("meetings", ownerId, g.storageKey);
  return !!chave && chave.startsWith(`meetings/${ownerId}/${reuniao.id}/`);
}

/**
 * O plano da junção, sem escrever nada: confere cada reunião, na ordem, e diz
 * o que muda em cada parte, que gravação vira parte, o total, os nomes e os
 * detalhes que o alvo fica tendo. Recusa (RecusaDaJuncao) o que não pode.
 * Função pura: os testes provam a conta das posições, dos tempos e dos rótulos.
 */
export function planejarJuncao(ownerId: string, reunioes: readonly ReuniaoParaJuntar[], agora: number): PlanoDaJuncao {
  if (reunioes.length < 2 || reunioes.length > REUNIOES_POR_JUNCAO_MAX) throw new RecusaDaJuncao("BAD_REQUEST", "JUNCAO_INVALIDA");
  for (const reuniao of reunioes) {
    if (ehReuniaoDeDocumento(reuniao.origem) || reuniao.origem === "youtube") throw new RecusaDaJuncao("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.soAudio);
    if (reuniao.status !== "ready" || !reuniao.consentGranted) throw new RecusaDaJuncao("CONFLICT", RECUSAS_DA_JUNCAO.foraDoEstado);
    if (reuniao.audioPipeline === "slices") {
      if (!reuniao.partes.length) throw new RecusaDaJuncao("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.semAudio);
      // Pronta com parte ainda por resolver não acontece; se acontecer, não se mexe nela.
      if (reuniao.partes.some(parte => parte.status === "uploading" || parte.status === "received")) throw new RecusaDaJuncao("CONFLICT", RECUSAS_DA_JUNCAO.foraDoEstado);
    } else if (!gravacaoAproveitavel(ownerId, reuniao)) {
      throw new RecusaDaJuncao("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.semAudio);
    }
  }

  const partes: ParteQueMuda[] = [];
  const gravacoes: GravacaoQueViraParte[] = [];
  const nomes: Record<string, string> = {};
  let seqBase = 0;
  let linhas = 0;
  let tempoMs = 0;
  let rotulosUsados = 0;
  let retranscrever = false;
  const prazos: number[] = [];

  reunioes.forEach((reuniao, indice) => {
    if (reuniao.audioPipeline === "single") {
      const g = reuniao.gravacao!;
      const durationMs = Math.round(g.durationSeconds * 1000);
      gravacoes.push({
        gravacaoId: g.id, seq: seqBase, durationMs, storageKey: g.storageKey, storageUrl: g.storageUrl, mimeType: g.mimeType,
        sizeBytes: g.sizeBytes, expiresAt: g.expiresAt, createdAt: g.createdAt, outraReuniao: indice > 0,
      });
      prazos.push(g.expiresAt);
      seqBase += 1;
      linhas += 1;
      tempoMs += durationMs;
      // Daqui em diante, tudo é transcrito de novo, numa conta de rótulos só.
      retranscrever = true;
      return;
    }
    const porSeq = new Map(reuniao.partes.map(parte => [parte.seq, parte]));
    const esperadas = Math.max(reuniao.expectedSlices ?? 0, ...reuniao.partes.map(parte => parte.seq + 1));
    const deslocamentoDosRotulos = retranscrever ? 0 : rotulosUsados;
    // O alvo em partes, antes de qualquer retranscrição, fica como está.
    const ficaComoEsta = indice === 0 && !retranscrever;
    // A primeira parte retranscrita desta reunião começa outra conversa.
    let marcarOutraConversa = retranscrever && indice > 0;
    // O idioma escolhido para esta reunião vai às falas dela que não o têm.
    const idiomaDaReuniao = idiomaFalado(reuniao.language ?? IDIOMA_DA_REUNIAO_PADRAO);
    let tempoDaReuniaoMs = 0;
    for (let seq = 0; seq < esperadas; seq++) {
      const parte = porSeq.get(seq);
      // A parte que não chegou conta a duração padrão, como na montagem e no
      // contexto da fila (contextoDaAnterior).
      const duracao = parte?.durationMs ?? DURACAO_DA_FATIA_SEGUNDOS * 1000;
      if (parte) {
        prazos.push(parte.expiresAt);
        const semAudio = parte.status === "failed" && (CAUSAS_DA_PARTE_SEM_AUDIO as readonly string[]).includes(parte.lastError ?? "");
        if (retranscrever) {
          partes.push(semAudio
            // Sem áudio no bucket, a parte segue lacuna, só na posição nova.
            ? { id: parte.id, seq: seqBase + seq, offsetMs: null, result: null, status: "failed", retranscrever: false }
            : { id: parte.id, seq: seqBase + seq, offsetMs: null, result: marcarOutraConversa ? { [MARCA_DE_OUTRA_REUNIAO]: true } : null, status: "received", retranscrever: true });
          if (!semAudio) marcarOutraConversa = false;
        } else if (!ficaComoEsta) {
          partes.push({
            id: parte.id, seq: seqBase + seq,
            offsetMs: parte.offsetMs === null ? null : Number(parte.offsetMs) + tempoMs,
            result: deslocarResultado(parte.result, deslocamentoDosRotulos, tempoMs / 1000, idiomaDaReuniao),
            status: parte.status, retranscrever: false,
          });
        }
      }
      tempoDaReuniaoMs += duracao;
    }
    if (!retranscrever) {
      for (const [falante, nome] of Object.entries(nomesDosFalantes(reuniao.speakerNames))) {
        nomes[`F${numeroDoRotulo(falante) + deslocamentoDosRotulos}`] = nome;
      }
      rotulosUsados = deslocamentoDosRotulos + maiorRotuloDaReuniao(reuniao);
    }
    seqBase += esperadas;
    linhas += reuniao.partes.length;
    tempoMs += tempoDaReuniaoMs;
  });

  if (seqBase > PARTES_POR_REUNIAO_MAX || tempoMs / 1000 > GRAVACAO_EM_PARTES_SEGUNDOS_MAX + FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS || rotulosUsados > MAIOR_ROTULO) {
    throw new RecusaDaJuncao("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.longaDemais);
  }
  // O áudio tem de durar a junção inteira: a montagem (e a transcrição das
  // partes marcadas) segura o áudio vencido sem servi-lo, e o que vence antes
  // do fim seria lido ou relido depois do prazo. Na retranscrição vale a margem
  // do reprocesso, que cresce com as partes; sem ela, a do processamento.
  const margem = retranscrever ? margemDoReprocesso(seqBase) : LIMITE_PROCESSAMENTO_MS;
  if (prazos.some(prazo => prazo <= agora + margem)) throw new RecusaDaJuncao("PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.semAudio);

  const primeiro = <T>(valores: Array<T | null>) => valores.find((valor): valor is T => valor !== null && valor !== undefined) ?? null;
  return {
    partes, gravacoes, esperadas: seqBase, linhas, duracaoSegundos: Math.round(tempoMs / 1000), retranscreve: retranscrever,
    nomes: Object.keys(nomes).length ? nomes : null,
    etiquetas: normalizarEtiquetas(reunioes.flatMap(reuniao => etiquetasDaReuniao(reuniao.etiquetas))),
    ondeFoi: primeiro(reunioes.map(reuniao => reuniao.ondeFoi)),
    contactId: primeiro(reunioes.map(reuniao => reuniao.contactId === null ? null : Number(reuniao.contactId))),
    contextId: primeiro(reunioes.map(reuniao => reuniao.contextId)),
  };
}

/** O sha256 de uma parte que veio de uma gravação do envio único: um marcador, e não o do conteúdo, que ninguém releu (só serve ao reenvio da parte, que a reunião juntada não aceita). */
function marcadorDaGravacao(gravacaoId: string) {
  return crypto.createHash("sha256").update(`gravacao-juntada:${gravacaoId}`).digest("hex");
}

export type ProvaDaJuncao = { userId: number; ipAddress: string; userAgent: string | null | undefined };

/**
 * Junta as reuniões da dona, na ordem dada (a primeira fica). Responde quando
 * a transação termina: a reunião que fica está em 'uploading', e a fila a monta
 * em segundo plano (a tela acompanha por meetings.get). Recusas: RecusaDaJuncao
 * (nada foi escrito); a reunião de outra conta é NOT_FOUND, como a que não
 * existe.
 */
export async function juntarReunioes(ownerId: string, idsPedidos: readonly string[], prova: ProvaDaJuncao) {
  const ids = Array.from(new Set(idsPedidos));
  if (ids.length < 2 || ids.length > REUNIOES_POR_JUNCAO_MAX || ids.length !== idsPedidos.length) throw new RecusaDaJuncao("BAD_REQUEST", "JUNCAO_INVALIDA");
  const db = await exigirDb();
  const agora = Date.now();
  return db.transaction(async tx => {
    // Travadas na ordem do id (a do índice), para duas junções que dividem uma
    // reunião não se travarem em ordens opostas.
    const linhas = await tx.select({
      id: meetings.id, status: meetings.status, audioPipeline: meetings.audioPipeline, origem: meetings.origem,
      consentGranted: meetings.consentGranted, expectedSlices: meetings.expectedSlices, speakerNames: meetings.speakerNames,
      etiquetas: meetings.etiquetas, ondeFoi: meetings.ondeFoi, contactId: meetings.contactId, contextId: meetings.contextId,
      shareToken: meetings.shareToken, language: meetings.language, consentAt: meetings.consentAt, consentNoticeVersion: meetings.consentNoticeVersion,
      // A reunião na lixeira (H7d) não entra: é "não encontrada", como a de outra conta.
    }).from(meetings).where(and(eq(meetings.ownerId, ownerId), inArray(meetings.id, ids), foraDaLixeira())).orderBy(asc(meetings.id)).for("update");
    if (linhas.length !== ids.length) throw new RecusaDaJuncao("NOT_FOUND", "REUNIAO_NAO_ENCONTRADA");

    const partes = await tx.select({
      id: meetingAudioSlices.id, meetingId: meetingAudioSlices.meetingId, seq: meetingAudioSlices.seq, status: meetingAudioSlices.status,
      durationMs: meetingAudioSlices.durationMs, offsetMs: meetingAudioSlices.offsetMs, result: meetingAudioSlices.result,
      lastError: meetingAudioSlices.lastError, expiresAt: meetingAudioSlices.expiresAt,
    }).from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.meetingId, ids)))
      .orderBy(asc(meetingAudioSlices.seq));
    const gravacoesLidas = await tx.select({
      id: meetingRecordings.id, meetingId: meetingRecordings.meetingId, storageKey: meetingRecordings.storageKey, storageUrl: meetingRecordings.storageUrl,
      mimeType: meetingRecordings.mimeType, sizeBytes: meetingRecordings.sizeBytes, durationSeconds: meetingRecordings.durationSeconds,
      expiresAt: meetingRecordings.expiresAt, createdAt: meetingRecordings.createdAt,
    }).from(meetingRecordings)
      .where(and(eq(meetingRecordings.ownerId, ownerId), inArray(meetingRecordings.meetingId, ids)))
      .orderBy(desc(meetingRecordings.createdAt));

    const porId = new Map(linhas.map(linha => [linha.id, linha]));
    const reunioes: ReuniaoParaJuntar[] = ids.map(id => {
      const { consentAt: _hora, consentNoticeVersion: _versao, ...linha } = porId.get(id)!;
      return {
        ...linha, contactId: linha.contactId === null ? null : Number(linha.contactId),
        partes: linha.audioPipeline === "slices" ? partes.filter(parte => parte.meetingId === id).map(parte => ({
          ...parte, offsetMs: parte.offsetMs === null ? null : Number(parte.offsetMs), expiresAt: Number(parte.expiresAt),
        })) : [],
        // A gravação que o player toca: a mais recente (não há unicidade por reunião no banco).
        gravacao: linha.audioPipeline === "single" ? (() => {
          const g = gravacoesLidas.find(gravacao => gravacao.meetingId === id);
          return g ? { ...g, sizeBytes: Number(g.sizeBytes), expiresAt: Number(g.expiresAt), createdAt: Number(g.createdAt) } : null;
        })() : null,
      };
    });
    const plano = planejarJuncao(ownerId, reunioes, agora);
    const [alvo, ...fontes] = reunioes;

    for (const parte of plano.partes) {
      await tx.update(meetingAudioSlices).set({
        meetingId: alvo.id, seq: parte.seq, offsetMs: parte.offsetMs, result: parte.result, status: parte.status, updatedAt: agora,
        ...(parte.retranscrever ? { attempts: 0, lastError: null, lockToken: null, lockedUntil: null } : {}),
      }).where(and(eq(meetingAudioSlices.id, parte.id), eq(meetingAudioSlices.ownerId, ownerId)));
    }
    for (const gravacao of plano.gravacoes) {
      await tx.insert(meetingAudioSlices).values({
        id: crypto.randomUUID(), meetingId: alvo.id, ownerId, seq: gravacao.seq, status: "received",
        result: gravacao.outraReuniao ? { [MARCA_DE_OUTRA_REUNIAO]: true } : null,
        storageKey: gravacao.storageKey, storageUrl: gravacao.storageUrl, mimeType: gravacao.mimeType, sizeBytes: gravacao.sizeBytes,
        sha256: marcadorDaGravacao(gravacao.gravacaoId), durationMs: gravacao.durationMs, expiresAt: gravacao.expiresAt,
        createdAt: gravacao.createdAt, updatedAt: agora,
      });
      await tx.delete(meetingRecordings).where(and(eq(meetingRecordings.id, gravacao.gravacaoId), eq(meetingRecordings.ownerId, ownerId)));
    }
    // Gravação a mais de uma reunião de envio único (não há unicidade no banco):
    // vence agora, e a varredura a tira do bucket, como na exclusão.
    const aproveitadas = new Set(plano.gravacoes.map(gravacao => gravacao.gravacaoId));
    const sobras = gravacoesLidas.filter(gravacao => !aproveitadas.has(gravacao.id)).map(gravacao => gravacao.id);
    if (sobras.length) {
      await tx.update(meetingRecordings).set({ expiresAt: agora })
        .where(and(eq(meetingRecordings.ownerId, ownerId), inArray(meetingRecordings.id, sobras)));
    }

    // Antes de trocar os nomes: as próximas ações do alvo se soltam com os nomes de antes.
    await apagarDerivadosDoAlvoDaJuncao(tx, ownerId, alvo.id);
    // O link desligado como no "Desligar" da dona (LINK_DESLIGADO): sem token e sem a senha (H23).
    await tx.update(meetings).set({
      audioPipeline: "slices", status: "uploading", expectedSlices: plano.linhas, attempts: 0, lockToken: null, lockedUntil: null,
      processingError: null, updatedAt: agora, speakerNames: plano.nomes, ...LINK_DESLIGADO,
      etiquetas: plano.etiquetas, ondeFoi: plano.ondeFoi, contactId: plano.contactId, contextId: plano.contextId,
    }).where(and(eq(meetings.id, alvo.id), eq(meetings.ownerId, ownerId)));

    if (fontes.length) {
      await tx.update(meetingAttachments).set({ meetingId: alvo.id })
        .where(and(eq(meetingAttachments.ownerId, ownerId), inArray(meetingAttachments.meetingId, fontes.map(fonte => fonte.id))));
    }
    for (const fonte of fontes) {
      await apagarDerivadosDaReuniaoJuntada(tx, ownerId, fonte.id);
      await tx.delete(meetings).where(and(eq(meetings.id, fonte.id), eq(meetings.ownerId, ownerId)));
    }

    const linkAbertoDesligado = reunioes.some(reuniao => reuniao.shareToken);
    await tx.insert(auditLogs).values({
      userId: prova.userId,
      action: "MEETINGS_JOINED",
      resource: "meetings",
      resourceId: alvo.id,
      // Só ids, contagens, horas e versões: nenhum título, nome ou fala. A prova
      // do aviso de gravação de cada reunião (consent_at e consent_notice_version)
      // fica aqui, porque as linhas das juntadas saem e o áudio delas segue.
      details: {
        juntadas: fontes.map(fonte => fonte.id), partes: plano.esperadas, duracaoSegundos: plano.duracaoSegundos,
        retranscreve: plano.retranscreve, linkAbertoDesligado,
        avisosDeGravacao: ids.map(id => {
          const linha = porId.get(id)!;
          return { id, consentAt: linha.consentAt === null ? null : Number(linha.consentAt), consentNoticeVersion: linha.consentNoticeVersion };
        }),
      },
      ipAddress: prova.ipAddress.split(",")[0].trim().substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "low",
    });

    return {
      meetingId: alvo.id, partes: plano.esperadas, duracaoSegundos: plano.duracaoSegundos,
      retranscreve: plano.retranscreve, linkAbertoDesligado,
    };
  });
}

