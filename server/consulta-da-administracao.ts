import type { Express } from "express";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { nomesDosFalantes, vozesJuntadas } from "@shared/const";
import { avisoPreveOAcesso } from "@shared/aviso-de-gravacao";
import { padraoDoLike } from "@shared/busca-de-reunioes";
import {
  ACAO_CONSULTA_DA_ADMINISTRACAO,
  ACAO_LISTA_DA_ADMINISTRACAO,
  MINUTOS_DO_PASSE_DO_AUDIO,
  RECUSAS_DA_CONSULTA,
  REUNIOES_POR_PAGINA_NA_CONSULTA,
  type MotivoDaConsulta,
} from "@shared/consulta-da-administracao";
import { auditLogs, meetingAudioSlices, meetingRecordings, meetingTranscripts, meetings, userProfiles, users } from "../drizzle/schema";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { transcricaoEstaEditada } from "./editar-transcricao";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { gravacaoParaOuvir } from "./meeting-service";
import { resumoParaLeitura } from "./resumo-guardado";
import { reuniaoVisivel } from "./reuniao-visivel";
import { storageGetSignedUrl } from "./storage";
import { sdk } from "./_core/sdk";

/**
 * A consulta da administração a uma reunião gravada (R1a do desenho de
 * 16/11/2026, com as decisões do Roberto de 22/11 e a frase da Cris no aviso
 * de gravação 2026-11-23). Só a staff (admin e presidente, pelo
 * plataformaProcedure de routers/_procedures.ts; nunca Ouro sem cargo) chega
 * aqui, e só por este módulo: os routers da dona (meetings.*) continuam com a
 * dona no WHERE, e a administração que não é dona leva NOT_FOUND ali.
 *
 * As regras, na consulta:
 * - abrir pede o MOTIVO (categoria e texto), e a linha MEETING_ADMIN_READ vai
 *   à auditoria por tx.insert, na mesma transação que confere a reunião, ANTES
 *   de qualquer leitura do conteúdo. Se a auditoria falhar, nada é lido;
 * - a reunião excluída ou na lixeira (reuniaoVisivel) é "não encontrada";
 * - a reunião gravada antes do aviso que anuncia a consulta (ou juntada com
 *   uma assim) fica FECHADA: o aviso daquela hora dizia "Só você acessa";
 * - nunca sai a rede particular da dona (contatos, entidades, sugestões,
 *   pendências), o contact_id, o context_id, o token do link nem o owner_id;
 * - a lista também fica na auditoria (MEETINGS_ADMIN_LIST), com as contas
 *   cujas reuniões saíram: "quem viu as minhas reuniões?" tem resposta;
 * - a dona vê a data de cada consulta (consultasDaAdministracaoDaDona), nunca
 *   o motivo nem quem consultou.
 *
 * As perguntas à IA guardadas (o histórico do Pergunte, H6b) ainda não existem
 * na main: a consulta as mostrará quando a H6b entrar. Hoje nenhuma pergunta é
 * guardada, então não há o que mostrar.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type Leitor = Pick<Transacao, "select">;

/** Quem consulta: a conta da staff, com o IP e o navegador, para a auditoria. */
export type QuemConsulta = { userId: number; ipAddress: string; userAgent: string | null };

export type MotivoRegistrado = { motivo: MotivoDaConsulta; complemento: string };

// Os mesmos cortes do createAuditLog (server/security.ts).
function autoria(quem: QuemConsulta) {
  return {
    userId: quem.userId,
    ipAddress: quem.ipAddress.split(",")[0].trim().substring(0, 45),
    userAgent: quem.userAgent ? quem.userAgent.substring(0, 500) : null,
  };
}

const naoEncontrada = () => new TRPCError({ code: "NOT_FOUND", message: RECUSAS_DA_CONSULTA.naoEncontrada });

// ─── A lista ────────────────────────────────────────────────────────────────

export type FiltrosDaLista = { busca?: string; comLinkAberto?: boolean; antes?: { criadaEm: number; id: string } };

/**
 * Todas as reuniões visíveis (nem excluídas nem na lixeira), das mais novas
 * para as mais antigas, 30 por página. Em cada uma, só o que a escolha pede:
 * título, data, status, de onde veio, o nome da dona, se o link está ligado
 * (sem o token) e se a reunião pode ser consultada pelo aviso dela. A busca
 * vai como padrão de LIKE parametrizado, com %, _ e ! escapados, no título, no
 * nome e no e-mail da dona (o e-mail não volta na resposta).
 *
 * "Pode ser consultada" olha só a versão do aviso da própria reunião; a
 * juntada com uma reunião anterior ao aviso é recusada ao abrir.
 */
export async function listarReunioesParaAAdministracao(quem: QuemConsulta, filtros: FiltrosDaLista, db?: Banco) {
  const banco = db ?? await exigirDb();
  const condicoes: SQL[] = [reuniaoVisivel()!];
  const termo = filtros.busca?.trim();
  if (termo) {
    const padrao = padraoDoLike(termo);
    const comoLike = (coluna: unknown) => sql`${coluna} LIKE ${padrao} ESCAPE '!'`;
    condicoes.push(or(comoLike(meetings.title), comoLike(users.name), comoLike(users.email), comoLike(userProfiles.displayName))!);
  }
  if (filtros.comLinkAberto) condicoes.push(isNotNull(meetings.shareToken));
  if (filtros.antes) {
    condicoes.push(or(
      lt(meetings.createdAt, filtros.antes.criadaEm),
      and(eq(meetings.createdAt, filtros.antes.criadaEm), lt(meetings.id, filtros.antes.id)),
    )!);
  }
  const linhas = await banco.select({
    id: meetings.id,
    titulo: meetings.title,
    criadaEm: meetings.createdAt,
    status: meetings.status,
    origem: meetings.origem,
    linkLigado: sql<number>`(${meetings.shareToken} is not null)`,
    versaoDoAviso: meetings.consentNoticeVersion,
    donaId: users.id,
    nomeDaConta: users.name,
    nomeDoPerfil: userProfiles.displayName,
  }).from(meetings)
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(...condicoes))
    .orderBy(desc(meetings.createdAt), desc(meetings.id))
    .limit(REUNIOES_POR_PAGINA_NA_CONSULTA + 1);
  const pagina = linhas.slice(0, REUNIOES_POR_PAGINA_NA_CONSULTA);
  const donas = Array.from(new Set(pagina.map(linha => linha.donaId))).sort((a, b) => a - b);
  // A leitura atravessa as reuniões de todas as donas: sem a linha, nada sai.
  // Fica a busca (o que se procurou) e as contas que apareceram.
  await banco.insert(auditLogs).values({
    ...autoria(quem),
    action: ACAO_LISTA_DA_ADMINISTRACAO,
    resource: "meetings",
    details: { busca: termo || null, comLinkAberto: !!filtros.comLinkAberto, pagina: filtros.antes ? "seguinte" : "primeira", reunioes: pagina.length, donas },
    status: "success",
    riskLevel: "medium",
  });
  const ultima = pagina[pagina.length - 1];
  return {
    reunioes: pagina.map(linha => ({
      id: linha.id,
      titulo: linha.titulo,
      criadaEm: Number(linha.criadaEm),
      status: linha.status,
      origem: linha.origem,
      dona: (linha.nomeDoPerfil?.trim() || linha.nomeDaConta?.trim() || null),
      linkLigado: !!Number(linha.linkLigado),
      podeConsultar: avisoPreveOAcesso(linha.versaoDoAviso),
    })),
    proxima: linhas.length > REUNIOES_POR_PAGINA_NA_CONSULTA && ultima ? { criadaEm: Number(ultima.criadaEm), id: ultima.id } : null,
  };
}

// ─── Abrir uma reunião ──────────────────────────────────────────────────────

/** Até quantas reuniões a corrente de juntadas é seguida: passou disso, a consulta fica fechada. */
const JUNTADAS_SEGUIDAS_MAX = 200;

/**
 * As versões do aviso de gravação de cada reunião que foi juntada nesta (H17,
 * server/juntar-reunioes.ts), seguindo a corrente: a juntada que já era uma
 * junção. A prova fica na auditoria MEETINGS_JOINED, porque as linhas das
 * juntadas saem e o áudio delas segue na reunião que ficou. Null: a corrente
 * passou do teto, e a consulta fica fechada.
 */
export async function versoesDasJuntadas(leitor: Leitor, meetingId: string): Promise<Array<string | null> | null> {
  const vistas = new Set<string>([meetingId]);
  const versoes: Array<string | null> = [];
  let fila = [meetingId];
  while (fila.length) {
    const linhas = await leitor.select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.action, "MEETINGS_JOINED"), inArray(auditLogs.resourceId, fila)));
    fila = [];
    for (const { details } of linhas) {
      const detalhes = (details && typeof details === "object" ? details : {}) as { juntadas?: unknown; avisosDeGravacao?: unknown };
      const avisos = Array.isArray(detalhes.avisosDeGravacao) ? detalhes.avisosDeGravacao : [];
      // Um aviso sem a forma esperada conta como ausente: fecha a consulta.
      for (const aviso of avisos) {
        const versao = aviso && typeof aviso === "object" ? (aviso as { consentNoticeVersion?: unknown }).consentNoticeVersion : null;
        versoes.push(typeof versao === "string" ? versao : null);
      }
      if (!avisos.length) versoes.push(null);
      for (const id of Array.isArray(detalhes.juntadas) ? detalhes.juntadas : []) {
        if (typeof id !== "string" || vistas.has(id)) continue;
        vistas.add(id);
        fila.push(id);
      }
    }
    if (vistas.size > JUNTADAS_SEGUIDAS_MAX) return null;
  }
  return versoes;
}

/** O que a transação confere da reunião antes de gravar a consulta: nada do conteúdo. */
type PortaDaReuniao = {
  id: string; ownerId: string; title: string; createdAt: number; status: string; language: string;
  audioPipeline: string; origem: string | null; speakerNames: unknown; speakerMerges: unknown; donaNome: string | null; donaPerfil: string | null;
};

/**
 * A transação da consulta: confere a reunião e grava a auditoria, nessa
 * ordem, antes de qualquer leitura do conteúdo. A leitura da reunião vai SEM a
 * dona no WHERE, de propósito: é a consulta da administração, e o
 * plataformaProcedure já barrou quem não é staff. Lançar aqui desfaz tudo.
 */
export async function registrarConsulta(tx: Pick<Transacao, "select" | "insert">, quem: QuemConsulta, meetingId: string, motivo: MotivoRegistrado): Promise<PortaDaReuniao> {
  const [reuniao] = await tx.select({
    id: meetings.id, ownerId: meetings.ownerId, title: meetings.title, createdAt: meetings.createdAt, status: meetings.status,
    language: meetings.language, audioPipeline: meetings.audioPipeline, origem: meetings.origem, speakerNames: meetings.speakerNames,
    speakerMerges: meetings.speakerMerges,
    versaoDoAviso: meetings.consentNoticeVersion,
    donaId: users.id, donaNome: users.name, donaPerfil: userProfiles.displayName,
  }).from(meetings)
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    // Sem a dona no WHERE: é a consulta da administração (ver acima).
    .where(and(eq(meetings.id, meetingId), reuniaoVisivel()))
    .limit(1);
  if (!reuniao) throw naoEncontrada();
  // Reunião gravada antes do aviso que anuncia a consulta, ou que absorveu o
  // áudio de uma assim: fechada à administração.
  if (!avisoPreveOAcesso(reuniao.versaoDoAviso)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_CONSULTA.anteriorAoAviso });
  const dasJuntadas = await versoesDasJuntadas(tx, meetingId);
  if (dasJuntadas === null || dasJuntadas.some(versao => !avisoPreveOAcesso(versao))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_CONSULTA.anteriorAoAviso });
  }
  await tx.insert(auditLogs).values({
    ...autoria(quem),
    action: ACAO_CONSULTA_DA_ADMINISTRACAO,
    resource: "meetings",
    resourceId: meetingId,
    details: { motivo: motivo.motivo, complemento: motivo.complemento, donaUserId: reuniao.donaId },
    status: "success",
    riskLevel: "high",
  });
  const { versaoDoAviso: _versao, donaId: _dona, ...porta } = reuniao;
  return { ...porta, createdAt: Number(porta.createdAt) };
}

/**
 * Abre a reunião para a administração: grava a consulta (registrarConsulta,
 * numa transação) e só então lê o conteúdo, com a mesma projeção do link
 * aberto (o resumo sem ids e sem ignorados, a transcrição no contrato dos
 * segmentos) e os nomes das vozes. O áudio sai pela rota da consulta
 * (enderecoDoAudioDaConsulta), nunca pelo proxy da dona: o endereço do proxy
 * traz o openId da dona e a chave do bucket.
 */
export async function abrirReuniaoNaConsulta(quem: QuemConsulta, meetingId: string, motivo: MotivoRegistrado, db?: Banco) {
  const banco = db ?? await exigirDb();
  const porta = await banco.transaction(tx => registrarConsulta(tx, quem, meetingId, motivo));
  const [transcricao] = await banco.select({
    texto: meetingTranscripts.transcript, idioma: meetingTranscripts.language, segmentos: meetingTranscripts.segments, editada: transcricaoEstaEditada,
  }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, porta.id), eq(meetingTranscripts.ownerId, porta.ownerId)))
    .limit(1);
  const resumo = await resumoParaLeitura(banco, porta.ownerId, porta.id);
  const emPartes = porta.audioPipeline === "slices";
  const { recording, recordingExpired, recordingDeletionPending } = await gravacaoParaOuvir(banco, porta.ownerId, porta.id, {
    createdAt: porta.createdAt, status: porta.status as Parameters<typeof gravacaoParaOuvir>[3]["status"], emPartes,
  });
  const endereco = enderecoDoAudioDaConsulta(porta.id);
  return {
    titulo: porta.title,
    criadaEm: porta.createdAt,
    idioma: porta.language,
    status: porta.status,
    origem: porta.origem,
    dona: porta.donaPerfil?.trim() || porta.donaNome?.trim() || null,
    transcricao: transcricao
      ? { texto: transcricao.texto, idioma: transcricao.idioma, segmentos: segmentosDoContrato(transcricao.segmentos), editada: !!Number(transcricao.editada) }
      : null,
    resumo,
    // Os nomes que a dona deu às vozes e as vozes que ela juntou (H3c, "F3 é
    // a mesma pessoa que F1"), para a fala não ficar com outra voz. Os nomes
    // das contas ligadas às vozes (speaker_accounts) não saem: a participante
    // aceitou aparecer para a dona, as participantes e o link, não para a
    // administração.
    vozes: nomesDosFalantes(porta.speakerNames),
    juntadas: vozesJuntadas(porta.speakerMerges),
    gravacao: recording
      ? {
          mimeType: recording.mimeType, durationSeconds: recording.durationSeconds, expiresAt: recording.expiresAt,
          partes: recording.partes.map(parte => ({
            seq: parte.seq, url: emPartes ? `${endereco}?parte=${parte.seq}` : endereco,
            mimeType: parte.mimeType, inicioSegundos: parte.inicioSegundos, duracaoSegundos: parte.duracaoSegundos,
          })),
        }
      : null,
    gravacaoExpirada: recordingExpired,
    gravacaoSaindo: recordingDeletionPending,
    // Até quando o áudio toca sem abrir a consulta de novo (o passe).
    passeDoAudioAte: Date.now() + MINUTOS_DO_PASSE_DO_AUDIO * 60_000,
  };
}

// ─── O que a dona vê ────────────────────────────────────────────────────────

/** Quantas datas de consulta a dona vê de uma vez. */
const CONSULTAS_NA_TELA_DA_DONA = 100;

/**
 * As datas em que a administração consultou a reunião da dona, das mais novas
 * para as mais antigas. Só a data: nem o motivo, nem quem consultou. A dona
 * vai no WHERE (a reunião é dela e está visível); NOT_FOUND para as outras.
 */
export async function consultasDaAdministracaoDaDona(ownerId: string, meetingId: string, db?: Banco): Promise<number[]> {
  const banco = db ?? await exigirDb();
  const [daDona] = await banco.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel()))
    .limit(1);
  if (!daDona) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." });
  const linhas = await banco.select({ em: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO), eq(auditLogs.resourceId, meetingId)))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(CONSULTAS_NA_TELA_DA_DONA);
  return linhas.map(linha => new Date(linha.em as unknown as string | number | Date).getTime());
}

// ─── O áudio, pela rota da consulta ─────────────────────────────────────────

export const ROTA_DO_AUDIO_DA_CONSULTA = "/consulta-da-administracao";
const FORMATO_DO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function enderecoDoAudioDaConsulta(meetingId: string): string {
  return `${ROTA_DO_AUDIO_DA_CONSULTA}/${encodeURIComponent(meetingId)}/audio`;
}

/**
 * A chave do áudio que a consulta toca, ou null. Só com a consulta ABERTA:
 * uma linha MEETING_ADMIN_READ desta conta para esta reunião nos últimos 60
 * minutos (a hora conta no relógio do banco, onde a linha foi gravada), e a
 * reunião ainda visível. Vencida a hora, a tela abre a consulta de novo, com
 * outro motivo e outra linha. O aviso de gravação é conferido de novo a cada
 * pedido, como em registrarConsulta: a dona pode juntar à reunião, dentro da
 * hora, uma reunião gravada antes do aviso, e o áudio dela fica fechado.
 */
export async function chaveDoAudioDaConsulta(adminId: number, meetingId: string, parte: number | undefined, db?: Banco): Promise<string | null> {
  if (!FORMATO_DO_ID.test(meetingId)) return null;
  const banco = db ?? await exigirDb();
  const [reuniao] = await banco.select({ ownerId: meetings.ownerId, audioPipeline: meetings.audioPipeline, versaoDoAviso: meetings.consentNoticeVersion }).from(meetings)
    .innerJoin(auditLogs, and(
      eq(auditLogs.resourceId, meetings.id),
      eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO),
      eq(auditLogs.userId, adminId),
      sql`${auditLogs.createdAt} >= (NOW() - INTERVAL ${MINUTOS_DO_PASSE_DO_AUDIO} MINUTE)`,
    ))
    .where(and(eq(meetings.id, meetingId), reuniaoVisivel()))
    .limit(1);
  if (!reuniao || !avisoPreveOAcesso(reuniao.versaoDoAviso)) return null;
  const dasJuntadas = await versoesDasJuntadas(banco, meetingId);
  if (dasJuntadas === null || dasJuntadas.some(versao => !avisoPreveOAcesso(versao))) return null;
  const agora = Date.now();
  if (reuniao.audioPipeline === "slices") {
    const [linha] = await banco.select({ storageKey: meetingAudioSlices.storageKey, expiresAt: meetingAudioSlices.expiresAt, status: meetingAudioSlices.status })
      .from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, reuniao.ownerId), eq(meetingAudioSlices.seq, parte ?? 0)))
      .limit(1);
    if (!linha || linha.expiresAt <= agora || (linha.status !== "received" && linha.status !== "transcribed")) return null;
    return linha.storageKey;
  }
  const [gravacao] = await banco.select({ storageKey: meetingRecordings.storageKey, expiresAt: meetingRecordings.expiresAt })
    .from(meetingRecordings)
    .where(and(eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.ownerId, reuniao.ownerId)))
    .orderBy(desc(meetingRecordings.createdAt))
    .limit(1);
  if (!gravacao || gravacao.expiresAt <= agora) return null;
  return gravacao.storageKey;
}

type Sessao = { id: number; role: string | null };

/**
 * A rota do áudio da consulta: sessão (401), staff (403), consulta aberta e
 * gravação no prazo (404), e só então o 307 para a URL assinada, sem cache.
 * As dependências entram por parâmetro só para o teste da rota trocá-las.
 */
export function registrarRotaDoAudioDaConsulta(
  app: Express,
  { autenticar, acharChave, assinar }: {
    autenticar: (req: Parameters<typeof sdk.authenticateRequest>[0]) => Promise<Sessao>;
    acharChave: (adminId: number, meetingId: string, parte?: number) => Promise<string | null>;
    assinar: (chave: string) => Promise<string>;
  } = { autenticar: req => sdk.authenticateRequest(req), acharChave: (adminId, meetingId, parte) => chaveDoAudioDaConsulta(adminId, meetingId, parte), assinar: storageGetSignedUrl },
) {
  app.get(`${ROTA_DO_AUDIO_DA_CONSULTA}/:meetingId/audio`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    let sessao: Sessao;
    try {
      sessao = await autenticar(req);
    } catch (erro) {
      // Banco fora do ar não é "sem sessão" (a mesma regra do proxy da dona).
      if (ehErroDeBancoIndisponivel(erro)) {
        console.error(`[ConsultaDaAdministracao] banco indisponível ao ler a sessão: ${descreverErroDeBanco(erro)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      res.status(401).send("Não autenticado");
      return;
    }
    if (sessao.role !== "admin" && sessao.role !== "president") {
      res.status(403).send("Sem acesso a este arquivo");
      return;
    }
    let chave: string | null;
    try {
      const parte = /^\d{1,4}$/.test(String(req.query.parte ?? "")) ? Number(req.query.parte) : undefined;
      chave = await acharChave(sessao.id, String(req.params.meetingId ?? ""), parte);
    } catch (erro) {
      if (ehErroDeBancoIndisponivel(erro)) {
        console.error(`[ConsultaDaAdministracao] banco indisponível ao achar o áudio: ${descreverErroDeBanco(erro)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      console.error(`[ConsultaDaAdministracao] a busca do áudio falhou: ${descreverErroDeBanco(erro)}`);
      res.status(500).send("Erro ao buscar a gravação");
      return;
    }
    if (!chave) {
      res.status(404).send("Gravação não encontrada ou consulta vencida");
      return;
    }
    try {
      res.redirect(307, await assinar(chave));
    } catch (erro) {
      console.error(`[ConsultaDaAdministracao] a URL assinada do áudio falhou: ${descreverErroDeBanco(erro)}`);
      res.status(503).send("Storage não configurado ou indisponível");
    }
  });
}
