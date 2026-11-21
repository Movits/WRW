import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { emailDoParticipanteValido } from "@shared/agenda";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import {
  DESTINATARIAS_POR_ENVIO_MAX,
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  EMAILS_POR_DONA_EM_24H,
  EMAILS_POR_REUNIAO_EM_24H,
  emailComparavel,
  JANELA_DOS_TETOS_MS,
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO,
  PENDENTE_PRESO_MS,
  TENTATIVAS_POR_EMAIL_MAX,
  type EstadoDoResumoPorEmail,
  type OrigemDoResumoPorEmail,
} from "@shared/resumo-por-email";
import { rotaDaReuniao, rotaDaReuniaoAberta } from "@shared/rotas";
import { ehReuniaoDeDocumento } from "@shared/documento-da-reuniao";
import { idDoVideoDaReuniao } from "@shared/youtube";
import { agendaReunioes, auditLogs, meetings, meetingSummaries, resumoPorEmail, users } from "../drizzle/schema";
import { sendEmailBatch } from "./_core/email";
import { participantesDe } from "./agenda-de-reunioes";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { montarEmailDoResumo, type ModeloDoEmailDoResumo } from "./email-do-resumo";
import { ligarLinkAbertoNaTransacao, type EstadoDoLinkLigado } from "./link-aberto-da-reuniao";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";

/**
 * O resumo por e-mail (H22 do plano do gravador; HN-54 do HiNoter e R-33 da
 * reunião de 11/11/2026). Com um toque no detalhe da reunião, a dona manda o
 * link aberto (/r/{token}, o mesmo do "Compartilhar por link") para ela mesma,
 * para participantes da agenda da reunião (H16a) e para e-mails que ela
 * digita. Quem recebe não precisa de conta: o link abre o que já abria, com os
 * nomes das vozes pela regra da H3b. O e-mail não leva nada da reunião além do
 * título; o nome da conta da dona vai para quem recebe saber de quem é.
 *
 * As regras, nesta ordem, numa transação só:
 *  1. a conta da dona travada (dois envios dela contam o teto um depois do
 *     outro) e a reunião dela, pronta e com um resumo já gravado. Reunião de
 *     outra conta é "não encontrada", como a que não existe;
 *  2. quem recebe: as participantes escolhidas têm de estar na agenda da
 *     reunião, os e-mails digitados passam pela regra do e-mail da agenda e
 *     ninguém recebe duas vezes (sem diferença de caixa);
 *  3. os tetos por reunião e por dona, nas últimas 24 h (shared/resumo-por-email.ts);
 *  4. o link aberto ligado: desligado, só com a palavra da dona de que as
 *     pessoas autorizaram (a mesma caixa do "Compartilhar", versão 2), que vai
 *     para a auditoria (ligarLinkAbertoNaTransacao);
 *  5. uma linha 'pendente' por e-mail e a auditoria MEETING_SUMMARY_EMAILED,
 *     com quantos, de que origem e o hash de cada endereço (não o endereço).
 *     Quem já tem nesta reunião um e-mail que não saiu o recebe de novo pela
 *     mesma linha, e quem tem um saindo agora fica de fora (separarPeloQueJaHa):
 *     o mesmo e-mail não vai duas vezes, e a linha nova é a única que conta no teto.
 * Depois, fora da transação, a Resend: o que ela aceita vira 'enviado', o que
 * não aceita vira 'falhou', e o pedido fica guardado para o "Tentar de novo".
 * Nada aqui diz se um e-mail digitado é de alguém da WRW.
 *
 * O envio automático (desligado por padrão, users.resumoPorEmailAutomatico)
 * manda só para a dona, quando o primeiro resumo da reunião fica pronto, com o
 * link da reunião na conta dela, e não o link aberto: ligar o link pede a
 * palavra dela, reunião a reunião (decisão do Roberto de 12/11/2026).
 *
 * O texto segue o link como ele está na hora do envio (H23): sem o áudio, não
 * promete a gravação; com a senha, diz que ela não vai no e-mail e a quem
 * pedi-la. A senha nunca vai no e-mail: o banco só tem o hash. O link que o
 * envio liga é o de antes da H23, sem senha e com o áudio.
 *
 * A reunião sem gravação (a de documento, H12 e H12b, e a de vídeo do YouTube,
 * H13; reuniaoSemGravacao) não tem áudio a levar: o envio liga o link dela sem
 * o áudio, como o "Compartilhar", e o e-mail nunca promete a gravação, nem no
 * link que já estava ligado com o share_audio verdadeiro (o padrão da coluna).
 * O texto também não diz que ela foi gravada, nem fala de "quem gravou"
 * (emailDoResumo.*SemGravacao).
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];
type Executor = Pick<Transacao, "select">;

/** A auditoria de cada envio, do mandar de novo e da troca do envio automático. */
export const ACAO_RESUMO_POR_EMAIL = "MEETING_SUMMARY_EMAILED";
export const ACAO_RESUMO_POR_EMAIL_DE_NOVO = "MEETING_SUMMARY_EMAIL_RETRIED";
export const ACAO_ENVIO_AUTOMATICO_DO_RESUMO = "MEETING_SUMMARY_EMAIL_AUTO";

/** Quantos envios o painel mostra, do mais novo ao mais velho. */
export const ENVIOS_NO_PAINEL_MAX = 60;

/** A dona, como o router a conhece (ctx.user). */
export type DonaDoEnvio = { id: number; openId: string };

/** De onde veio o pedido, para a auditoria. */
export type RequisicaoDoEnvio = { ipAddress: string; userAgent: string | undefined };

/** O pedido da tela: quem recebe e, com o link desligado, a palavra da dona para ligá-lo. */
export type PedidoDoResumoPorEmail = {
  paraMim: boolean;
  participantes: string[];
  outros: string[];
  autorizacao?: { idioma: string; textoExibido: string; versaoDaAutorizacao?: typeof VERSAO_DA_AUTORIZACAO_COM_NOMES };
};

export type Destinataria = { email: string; origem: OrigemDoResumoPorEmail };

function recusa(code: "NOT_FOUND" | "BAD_REQUEST" | "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE", message: string): TRPCError {
  return new TRPCError({ code, message });
}

/** A origem dos links do e-mail (FRONTEND_URL), sem barra no fim, ou null. */
function siteDosLinks(): string | null {
  const site = process.env.FRONTEND_URL?.trim().replace(/\/+$/, "");
  return site || null;
}

/** O hash do endereço na auditoria: prova para quem foi, sem guardar o endereço em claro. */
export function hashDoEmail(email: string): string {
  return crypto.createHash("sha256").update(emailComparavel(email)).digest("hex");
}

/** O tinyint(1) chega como booleano pelo Drizzle, mas pode chegar como 0 e 1. */
function ligado(valor: unknown): boolean {
  return valor === true || valor === 1;
}

/**
 * Quem recebe, sem repetir ninguém: a dona (o e-mail da conta, nunca o que a
 * tela manda), as participantes escolhidas, que têm de estar na agenda da
 * reunião (a grafia gravada lá vale), e os e-mails digitados. A primeira origem
 * vence: a dona que digita o próprio e-mail recebe o dela. Recusa com a frase
 * do motivo, que a tela traduz.
 */
export function destinatariasDoPedido(
  pedido: Pick<PedidoDoResumoPorEmail, "paraMim" | "participantes" | "outros">,
  contexto: { emailDaDona: string | null; daAgenda: string[] },
): Destinataria[] {
  const vistas = new Set<string>();
  const lista: Destinataria[] = [];
  const somar = (email: string, origem: OrigemDoResumoPorEmail) => {
    const chave = emailComparavel(email);
    if (vistas.has(chave)) return;
    vistas.add(chave);
    lista.push({ email: email.trim(), origem });
  };
  if (pedido.paraMim) {
    if (!contexto.emailDaDona) throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA);
    somar(contexto.emailDaDona, "dona");
  }
  const agenda = new Map(contexto.daAgenda.map(email => [emailComparavel(email), email.trim()]));
  for (const escolhida of pedido.participantes) {
    const naAgenda = agenda.get(emailComparavel(escolhida));
    if (!naAgenda) throw recusa("BAD_REQUEST", MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA);
    somar(naAgenda, "participante");
  }
  const digitados = pedido.outros.map(email => email.trim()).filter(Boolean);
  if (new Set(digitados.map(emailComparavel)).size > EMAILS_DIGITADOS_POR_ENVIO_MAX) throw recusa("BAD_REQUEST", MENSAGEM_RESUMO_POR_EMAIL_DEMAIS);
  for (const email of digitados) {
    if (!emailDoParticipanteValido(email)) throw recusa("BAD_REQUEST", MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO);
    somar(email, "digitado");
  }
  if (!lista.length) throw recusa("BAD_REQUEST", MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA);
  if (lista.length > DESTINATARIAS_POR_ENVIO_MAX) throw recusa("BAD_REQUEST", MENSAGEM_RESUMO_POR_EMAIL_DEMAIS);
  return lista;
}

/** As participantes da reunião da agenda ligada a esta gravação, só as que têm e-mail válido. */
async function participantesComEmail(ex: Executor, ownerId: string, meetingId: string): Promise<Array<{ nome: string | null; email: string }>> {
  const [agenda] = await ex.select({ participantes: agendaReunioes.participantes }).from(agendaReunioes)
    .where(and(eq(agendaReunioes.meetingId, meetingId), eq(agendaReunioes.ownerId, ownerId)))
    .limit(1);
  const vistas = new Set<string>();
  const lista: Array<{ nome: string | null; email: string }> = [];
  for (const participante of participantesDe(agenda?.participantes)) {
    const email = participante.email?.trim();
    if (!email || !emailDoParticipanteValido(email) || vistas.has(emailComparavel(email))) continue;
    vistas.add(emailComparavel(email));
    lista.push({ nome: participante.nome?.trim() || null, email });
  }
  return lista;
}

/**
 * Os tetos, contados nas linhas das últimas 24 h: primeiro o da reunião, que
 * diz mais à dona, depois o dela. A linha da reunião excluída perde o endereço
 * e fica: segue contando para a dona.
 */
async function conferirTetos(ex: Executor, ownerId: string, meetingId: string, novos: number, agora: number): Promise<void> {
  const desde = agora - JANELA_DOS_TETOS_MS;
  const [daReuniao] = await ex.select({ total: count() }).from(resumoPorEmail)
    .where(and(eq(resumoPorEmail.ownerId, ownerId), eq(resumoPorEmail.meetingId, meetingId), gt(resumoPorEmail.createdAt, desde)));
  if (Number(daReuniao?.total ?? 0) + novos > EMAILS_POR_REUNIAO_EM_24H) throw recusa("TOO_MANY_REQUESTS", MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO);
  const [daDona] = await ex.select({ total: count() }).from(resumoPorEmail)
    .where(and(eq(resumoPorEmail.ownerId, ownerId), gt(resumoPorEmail.createdAt, desde)));
  if (Number(daDona?.total ?? 0) + novos > EMAILS_POR_DONA_EM_24H) throw recusa("TOO_MANY_REQUESTS", MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA);
}

/** A reunião da dona, travada até o fim da transação, ou NOT_FOUND. */
async function reuniaoTravada(tx: Transacao, ownerId: string, meetingId: string) {
  const [reuniao] = await tx.select({
    status: meetings.status, titulo: meetings.title, idioma: meetings.language, token: meetings.shareToken,
    senhaDoLink: meetings.sharePasswordHash, audioDoLink: meetings.shareAudio,
    // De onde a reunião veio: a de documento e a de vídeo não têm gravação.
    origem: meetings.origem, sourceUrl: meetings.sourceUrl,
  })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)))
    .for("update");
  if (!reuniao || reuniao.status === "deleted") throw recusa("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  return reuniao;
}

/**
 * A reunião sem gravação: a que nasceu de um documento (H12 e H12b) e a que
 * veio de um vídeo do YouTube (H13), pela mesma regra da tela e do link
 * (ehReuniaoDeDocumento e idDoVideoDaReuniao). O link dela não tem áudio a
 * levar, e o e-mail não fala de gravação.
 */
export function reuniaoSemGravacao(reuniao: { origem: string | null; sourceUrl: string | null }): boolean {
  return ehReuniaoDeDocumento(reuniao.origem) || idDoVideoDaReuniao(reuniao) !== null;
}

/**
 * O link aberto ligado e como ele está (H23), com a leitura do link
 * (reuniaoDoLink): hash que não é nulo pede a senha, e só o `true` do banco
 * leva o áudio. Null com o link desligado. Na reunião sem gravação, o link
 * nunca leva o áudio, valha o que valer o share_audio: o link ligado antes
 * desta regra ficou com o padrão da coluna, verdadeiro.
 */
export function linkDaReuniao(reuniao: {
  token: string | null; senhaDoLink: string | null; audioDoLink: boolean | null; origem: string | null; sourceUrl: string | null;
}): EstadoDoLinkLigado | null {
  if (!reuniao.token) return null;
  return { token: reuniao.token, comSenha: reuniao.senhaDoLink !== null, comAudio: reuniao.audioDoLink === true && !reuniaoSemGravacao(reuniao) };
}

/** Há um resumo gravado (a versão sobe a cada resumo que a fila grava; o refeito mantém a anterior à vista). */
async function temResumoGravado(ex: Executor, ownerId: string, meetingId: string): Promise<{ versao: number } | null> {
  const [resumo] = await ex.select({ versao: meetingSummaries.version }).from(meetingSummaries)
    .where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId)))
    .limit(1);
  return resumo && Number(resumo.versao) > 0 ? { versao: Number(resumo.versao) } : null;
}

/** Uma linha desta reunião que ainda não saiu: 'falhou', ou 'pendente' (saindo agora, ou presa num envio que não terminou). */
export type LinhaQueNaoSaiu = {
  id: string;
  destinatario: string;
  origem: OrigemDoResumoPorEmail;
  idioma: string;
  loteId: string;
  status: "pendente" | "falhou";
  tentativas: number;
  updatedAt: number;
};

/** As linhas que a dona mandou nesta reunião (não as automáticas, que levam o link da conta) e que ainda não saíram. */
async function linhasQueNaoSairam(ex: Executor, ownerId: string, meetingId: string): Promise<LinhaQueNaoSaiu[]> {
  const linhas = await ex.select({
    id: resumoPorEmail.id, destinatario: resumoPorEmail.destinatario, origem: resumoPorEmail.origem, idioma: resumoPorEmail.idioma,
    loteId: resumoPorEmail.loteId, status: resumoPorEmail.status, tentativas: resumoPorEmail.tentativas, updatedAt: resumoPorEmail.updatedAt,
  }).from(resumoPorEmail).where(and(
    eq(resumoPorEmail.ownerId, ownerId),
    eq(resumoPorEmail.meetingId, meetingId),
    eq(resumoPorEmail.automatico, false),
    isNotNull(resumoPorEmail.destinatario),
    inArray(resumoPorEmail.status, ["pendente", "falhou"]),
  ));
  return linhas.map(linha => ({
    id: linha.id,
    destinatario: linha.destinatario as string,
    origem: linha.origem as OrigemDoResumoPorEmail,
    idioma: linha.idioma,
    loteId: linha.loteId,
    status: linha.status as "pendente" | "falhou",
    tentativas: Number(linha.tentativas),
    updatedAt: Number(linha.updatedAt),
  }));
}

/**
 * O pedido novo diante do que já há nesta reunião. Quem tem uma linha que não
 * saiu e ainda pode sair (a mesma que o "Tentar de novo" mandaria) a recebe de
 * novo por ela, sem linha nova: o e-mail não vai em dobro (a linha velha
 * seguiria no "Tentar de novo") nem gasta o teto duas vezes. Quem tem o e-mail
 * saindo agora (outra aba mandou há instantes) fica de fora deste envio. Só
 * vale a linha do mesmo e-mail: o da dona (o link para ela guardar) e o das
 * outras pessoas têm textos diferentes.
 */
export function separarPeloQueJaHa(destinatarias: Destinataria[], anteriores: LinhaQueNaoSaiu[], agora: number) {
  const chave = (email: string, origem: OrigemDoResumoPorEmail) => `${origem === "dona" ? "dona" : "outra"}\n${emailComparavel(email)}`;
  const podeSairDeNovo = new Map<string, LinhaQueNaoSaiu>();
  const saindoAgora = new Set<string>();
  for (const linha of anteriores) {
    const k = chave(linha.destinatario, linha.origem);
    // A mesma regra do "Tentar de novo" (condicaoDoMandarDeNovo): a 'pendente' recente está saindo.
    const presa = linha.status === "pendente" && linha.updatedAt < agora - PENDENTE_PRESO_MS;
    if (linha.status === "pendente" && !presa) saindoAgora.add(k);
    else if (linha.tentativas < TENTATIVAS_POR_EMAIL_MAX && !podeSairDeNovo.has(k)) podeSairDeNovo.set(k, linha);
  }
  const novas: Destinataria[] = [];
  const deNovo: Array<{ destinataria: Destinataria; linha: LinhaQueNaoSaiu }> = [];
  const jaSaindo: Destinataria[] = [];
  for (const destinataria of destinatarias) {
    const k = chave(destinataria.email, destinataria.origem);
    const anterior = podeSairDeNovo.get(k);
    if (saindoAgora.has(k)) jaSaindo.push(destinataria);
    else if (anterior) deNovo.push({ destinataria, linha: anterior });
    else novas.push(destinataria);
  }
  return { novas, deNovo, jaSaindo };
}

type LinhaParaMandar = { id: string; destinatario: string; origem: OrigemDoResumoPorEmail; automatico: boolean; idioma: string };

/** Quanto a resposta da Resend pode demorar antes de o pedido ficar 'falhou' (e a dona, sem a roda girando). */
export const PRAZO_DA_RESEND_MS = 30_000;

/**
 * A promessa, ou o valor de `seEstourar` passado o prazo. O que a Resend
 * aceitar depois do prazo pode sair mesmo assim: o "Tentar de novo" mandaria
 * de novo. Aceito: é raro, e sem o prazo a tela da dona ficaria presa.
 */
export function comPrazo<T>(promessa: Promise<T>, ms: number, seEstourar: () => T): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<T>(resolve => {
    relogio = setTimeout(() => resolve(seEstourar()), ms);
  });
  return Promise.race([promessa, estouro]).finally(() => clearTimeout(relogio));
}

/**
 * Manda as linhas pela Resend e grava o resultado de cada uma. O e-mail é
 * montado agora, com o link de agora: o "Tentar de novo" depois de desligar e
 * ligar o link manda o link novo, e o texto segue a senha e o áudio dele
 * (H23). A reunião sem gravação (`semGravacao`) leva o texto que não fala de
 * gravação. A falha da Resend não lança: a linha fica 'falhou', e quem chama
 * decide a resposta.
 */
async function mandarAsLinhas(
  db: Banco,
  ownerId: string,
  meetingId: string,
  linhas: LinhaParaMandar[],
  contexto: {
    site: string; link: EstadoDoLinkLigado | null; titulo: string; nomeDaDona: string | null;
    /** A reunião sem gravação (reuniaoSemGravacao). O automático não precisa: o texto dele não fala de gravação. */
    semGravacao?: boolean;
  },
): Promise<{ enviados: number; falharam: number }> {
  const emails = linhas.map(linha => {
    const modelo: ModeloDoEmailDoResumo = linha.automatico ? "pronto" : linha.origem === "dona" ? "dona" : "participante";
    const endereco = modelo === "pronto" || !contexto.link
      ? `${contexto.site}${rotaDaReuniao(meetingId)}`
      : `${contexto.site}${rotaDaReuniaoAberta(contexto.link.token)}`;
    const { assunto, html, text } = montarEmailDoResumo({
      modelo, idioma: idiomaDaReuniao(linha.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO, titulo: contexto.titulo, dona: contexto.nomeDaDona, endereco,
      link: contexto.link, semGravacao: contexto.semGravacao === true,
    });
    return { to: linha.destinatario, subject: assunto, html, text };
  });
  const nenhum = () => emails.map(() => false);
  // sendEmailBatch não lança: se lançar, é defeito de código, e o nome do erro
  // vai ao log (sem o endereço), para a falha não parecer ser da Resend.
  const mandados = sendEmailBatch(emails).catch((erro: unknown) => {
    console.error(`[ResumoPorEmail] sendEmailBatch lançou (reunião ${meetingId}): ${erro instanceof Error ? erro.name : "erro desconhecido"}`);
    return nenhum();
  });
  const aceitos = await comPrazo(mandados, PRAZO_DA_RESEND_MS, () => {
    console.error(`[ResumoPorEmail] a Resend não respondeu em ${PRAZO_DA_RESEND_MS / 1000} s (reunião ${meetingId}); os e-mails ficam para o "Tentar de novo".`);
    return nenhum();
  });
  const agora = Date.now();
  const saiu = linhas.filter((_, posicao) => aceitos[posicao] === true).map(linha => linha.id);
  const naoSaiu = linhas.filter((_, posicao) => aceitos[posicao] !== true).map(linha => linha.id);
  const tentativa = sql`${resumoPorEmail.tentativas} + 1`;
  if (saiu.length) {
    await db.update(resumoPorEmail).set({ status: "enviado", enviadoEm: agora, updatedAt: agora, tentativas: tentativa })
      .where(and(eq(resumoPorEmail.ownerId, ownerId), inArray(resumoPorEmail.id, saiu)));
  }
  if (naoSaiu.length) {
    await db.update(resumoPorEmail).set({ status: "falhou", updatedAt: agora, tentativas: tentativa })
      .where(and(eq(resumoPorEmail.ownerId, ownerId), inArray(resumoPorEmail.id, naoSaiu)));
    // Sem os endereços no log: o id da reunião basta para achar as linhas.
    console.error(`[ResumoPorEmail] ${naoSaiu.length} de ${linhas.length} e-mail(s) da reunião ${meetingId} não saíram; ficam para o "Tentar de novo".`);
  }
  return { enviados: saiu.length, falharam: naoSaiu.length };
}

export type ResultadoDoResumoPorEmail = { enviados: number; falharam: number; linkLigadoAgora: boolean };

/** O toque da dona: ver o comentário do módulo. */
export async function mandarResumoPorEmail(
  dona: DonaDoEnvio,
  meetingId: string,
  pedido: PedidoDoResumoPorEmail,
  requisicao: RequisicaoDoEnvio,
): Promise<ResultadoDoResumoPorEmail> {
  const site = siteDosLinks();
  if (!site) {
    // Sem a origem não há link para mandar: nada é gravado, e o link não liga.
    console.error("[ResumoPorEmail] FRONTEND_URL não definida: é a origem do link do e-mail, e não tem valor padrão.");
    throw recusa("SERVICE_UNAVAILABLE", MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU);
  }
  const db = await exigirDb();
  const agora = Date.now();
  const lote = crypto.randomUUID();
  const preparado = await db.transaction(async tx => {
    // A conta travada: os envios da mesma dona, em abas ou reuniões diferentes, contam o teto em fila.
    const [conta] = await tx.select({ email: users.email, nome: users.name }).from(users)
      .where(and(eq(users.id, dona.id), eq(users.openId, dona.openId))).for("update");
    if (!conta) throw recusa("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const reuniao = await reuniaoTravada(tx, dona.openId, meetingId);
    if (reuniao.status !== "ready" || !(await temResumoGravado(tx, dona.openId, meetingId))) {
      throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO);
    }
    const daAgenda = (await participantesComEmail(tx, dona.openId, meetingId)).map(participante => participante.email);
    const destinatarias = destinatariasDoPedido(pedido, { emailDaDona: conta.email?.trim() || null, daAgenda });
    const { novas, deNovo, jaSaindo } = separarPeloQueJaHa(destinatarias, await linhasQueNaoSairam(tx, dona.openId, meetingId), agora);
    // Só a linha nova conta no teto: a que volta a sair já contou quando nasceu.
    await conferirTetos(tx, dona.openId, meetingId, novas.length, agora);

    const semGravacao = reuniaoSemGravacao(reuniao);
    let link = linkDaReuniao(reuniao);
    const linkLigadoAgora = !link;
    if (!link) {
      if (!pedido.autorizacao) throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO);
      link = await ligarLinkAbertoNaTransacao(tx, dona.openId, meetingId, {
        userId: dona.id,
        ipAddress: requisicao.ipAddress,
        userAgent: requisicao.userAgent,
        idioma: pedido.autorizacao.idioma,
        textoExibido: pedido.autorizacao.textoExibido,
        versaoDaAutorizacao: pedido.autorizacao.versaoDaAutorizacao,
        origem: "resumo_por_email",
      }, {
        // Sem gravação, sem áudio a levar: o link sai como o "Compartilhar" o liga.
        incluirAudio: !semGravacao,
      });
    }

    const idioma: IdiomaDaReuniao = idiomaDaReuniao(reuniao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
    const linhasNovas = novas.map(destinataria => ({
      id: crypto.randomUUID(), meetingId, ownerId: dona.openId, loteId: lote,
      destinatario: destinataria.email, origem: destinataria.origem, idioma,
      status: "pendente" as const, automatico: false, tentativas: 0, createdAt: agora, updatedAt: agora,
    }));
    // Todas as pessoas já têm o e-mail saindo agora (outra aba mandou há instantes): nada a gravar nem a mandar.
    if (!linhasNovas.length && !deNovo.length) {
      return { linhas: [] as LinhaParaMandar[], link, titulo: reuniao.titulo, nomeDaDona: conta.nome?.trim() || null, linkLigadoAgora, semGravacao };
    }
    if (linhasNovas.length) await tx.insert(resumoPorEmail).values(linhasNovas);
    if (deNovo.length) {
      await tx.update(resumoPorEmail).set({ status: "pendente", updatedAt: agora })
        .where(and(eq(resumoPorEmail.ownerId, dona.openId), inArray(resumoPorEmail.id, deNovo.map(item => item.linha.id))));
    }
    const vaoAgora = [...novas, ...deNovo.map(item => item.destinataria)];
    // A prova do pedido, na mesma transação: sem ela, nada é gravado nem sai.
    await tx.insert(auditLogs).values({
      userId: dona.id,
      action: ACAO_RESUMO_POR_EMAIL,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        lote,
        quantidade: vaoAgora.length,
        porOrigem: {
          dona: vaoAgora.filter(d => d.origem === "dona").length,
          participante: vaoAgora.filter(d => d.origem === "participante").length,
          digitado: vaoAgora.filter(d => d.origem === "digitado").length,
        },
        idioma,
        linkLigadoAgora,
        automatico: false,
        destinatarios: vaoAgora.map(d => hashDoEmail(d.email)),
        // As que não saíram antes e voltam a sair agora, e as que já estavam saindo (de fora deste envio).
        ...(deNovo.length ? { deNovo: deNovo.length, lotesDeNovo: Array.from(new Set(deNovo.map(item => item.linha.loteId))) } : {}),
        ...(jaSaindo.length ? { jaSaindo: jaSaindo.length } : {}),
      },
      ipAddress: requisicao.ipAddress.substring(0, 45),
      userAgent: requisicao.userAgent ? requisicao.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "medium",
    });
    const linhas: LinhaParaMandar[] = [
      ...linhasNovas.map(linha => ({ id: linha.id, destinatario: linha.destinatario, origem: linha.origem, automatico: false, idioma: linha.idioma })),
      ...deNovo.map(({ linha }) => ({ id: linha.id, destinatario: linha.destinatario, origem: linha.origem, automatico: false, idioma: linha.idioma })),
    ];
    return { linhas, link, titulo: reuniao.titulo, nomeDaDona: conta.nome?.trim() || null, linkLigadoAgora, semGravacao };
  });

  if (!preparado.linhas.length) return { enviados: 0, falharam: 0, linkLigadoAgora: preparado.linkLigadoAgora };
  const resultado = await mandarAsLinhas(db, dona.openId, meetingId, preparado.linhas, {
    site, link: preparado.link, titulo: preparado.titulo, nomeDaDona: preparado.nomeDaDona, semGravacao: preparado.semGravacao,
  });
  // Nada saiu: o pedido está guardado ('falhou'), e a tela diz isso no idioma de quem lê.
  if (!resultado.enviados) throw recusa("SERVICE_UNAVAILABLE", MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU);
  return { ...resultado, linkLigadoAgora: preparado.linkLigadoAgora };
}

/** As linhas que o "Tentar de novo" manda: as que não saíram e as presas em 'pendente' (o envio que não terminou). */
function condicaoDoMandarDeNovo(ownerId: string, meetingId: string, agora: number) {
  return and(
    eq(resumoPorEmail.ownerId, ownerId),
    eq(resumoPorEmail.meetingId, meetingId),
    isNotNull(resumoPorEmail.destinatario),
    lt(resumoPorEmail.tentativas, TENTATIVAS_POR_EMAIL_MAX),
    or(
      eq(resumoPorEmail.status, "falhou"),
      and(eq(resumoPorEmail.status, "pendente"), lt(resumoPorEmail.updatedAt, agora - PENDENTE_PRESO_MS)),
    ),
  );
}

/**
 * O "Tentar de novo": manda outra vez o que não saiu desta reunião, até
 * TENTATIVAS_POR_EMAIL_MAX vezes por e-mail. Não cria linha, então não conta
 * outra vez nos tetos. O e-mail com o link aberto só sai com o link ligado: se
 * a dona o desligou depois da falha, ela manda de novo pelo painel, com a
 * confirmação.
 */
export async function mandarResumoPorEmailDeNovo(dona: DonaDoEnvio, meetingId: string, requisicao: RequisicaoDoEnvio): Promise<{ enviados: number; falharam: number }> {
  const site = siteDosLinks();
  if (!site) {
    console.error("[ResumoPorEmail] FRONTEND_URL não definida: é a origem do link do e-mail, e não tem valor padrão.");
    throw recusa("SERVICE_UNAVAILABLE", MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU);
  }
  const db = await exigirDb();
  const agora = Date.now();
  const preparado = await db.transaction(async tx => {
    const [conta] = await tx.select({ nome: users.name }).from(users)
      .where(and(eq(users.id, dona.id), eq(users.openId, dona.openId))).for("update");
    if (!conta) throw recusa("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    const reuniao = await reuniaoTravada(tx, dona.openId, meetingId);
    const linhas = await tx.select({
      id: resumoPorEmail.id, destinatario: resumoPorEmail.destinatario, origem: resumoPorEmail.origem,
      automatico: resumoPorEmail.automatico, idioma: resumoPorEmail.idioma, loteId: resumoPorEmail.loteId,
    }).from(resumoPorEmail).where(condicaoDoMandarDeNovo(dona.openId, meetingId, agora));
    if (!linhas.length) throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR);
    if (reuniao.status !== "ready") throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO);
    if (!reuniao.token && linhas.some(linha => !ligado(linha.automatico))) throw recusa("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO);
    const ids = linhas.map(linha => linha.id);
    await tx.update(resumoPorEmail).set({ status: "pendente", updatedAt: agora })
      .where(and(eq(resumoPorEmail.ownerId, dona.openId), inArray(resumoPorEmail.id, ids)));
    await tx.insert(auditLogs).values({
      userId: dona.id,
      action: ACAO_RESUMO_POR_EMAIL_DE_NOVO,
      resource: "meetings",
      resourceId: meetingId,
      details: { quantidade: ids.length, lotes: Array.from(new Set(linhas.map(linha => linha.loteId))) },
      ipAddress: requisicao.ipAddress.substring(0, 45),
      userAgent: requisicao.userAgent ? requisicao.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "low",
    });
    return {
      linhas: linhas.map(linha => ({
        id: linha.id, destinatario: linha.destinatario as string, origem: linha.origem as OrigemDoResumoPorEmail,
        automatico: ligado(linha.automatico), idioma: linha.idioma,
      })),
      link: linkDaReuniao(reuniao),
      titulo: reuniao.titulo,
      nomeDaDona: conta.nome?.trim() || null,
      semGravacao: reuniaoSemGravacao(reuniao),
    };
  });
  const resultado = await mandarAsLinhas(db, dona.openId, meetingId, preparado.linhas, {
    site, link: preparado.link, titulo: preparado.titulo, nomeDaDona: preparado.nomeDaDona, semGravacao: preparado.semGravacao,
  });
  if (!resultado.enviados) throw recusa("SERVICE_UNAVAILABLE", MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU);
  return resultado;
}

export type EnvioNoPainel = {
  id: string;
  destinatario: string | null;
  origem: OrigemDoResumoPorEmail;
  status: EstadoDoResumoPorEmail;
  automatico: boolean;
  createdAt: number;
  enviadoEm: number | null;
};

/**
 * O que o painel mostra à dona: o idioma do e-mail, o e-mail e o nome da conta
 * dela (para a prévia), as participantes da agenda com e-mail, os envios desta
 * reunião e se há o que mandar de novo. Tudo dela; reunião de outra conta é
 * "não encontrada".
 */
export async function painelDoResumoPorEmail(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  const [reuniao] = await db.select({ idioma: meetings.language, token: meetings.shareToken }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted")))
    .limit(1);
  if (!reuniao) throw recusa("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  const [conta] = await db.select({ email: users.email, nome: users.name, automatico: users.resumoPorEmailAutomatico }).from(users)
    .where(eq(users.openId, ownerId)).limit(1);
  const participantes = await participantesComEmail(db, ownerId, meetingId);
  const linhas = await db.select({
    id: resumoPorEmail.id, destinatario: resumoPorEmail.destinatario, origem: resumoPorEmail.origem, status: resumoPorEmail.status,
    automatico: resumoPorEmail.automatico, createdAt: resumoPorEmail.createdAt, enviadoEm: resumoPorEmail.enviadoEm,
  }).from(resumoPorEmail)
    .where(and(eq(resumoPorEmail.ownerId, ownerId), eq(resumoPorEmail.meetingId, meetingId)))
    .orderBy(desc(resumoPorEmail.createdAt))
    .limit(ENVIOS_NO_PAINEL_MAX);
  const [paraMandarDeNovo] = await db.select({ total: count() }).from(resumoPorEmail)
    .where(condicaoDoMandarDeNovo(ownerId, meetingId, Date.now()));
  const envios: EnvioNoPainel[] = linhas.map(linha => ({
    id: linha.id,
    destinatario: linha.destinatario,
    origem: linha.origem as OrigemDoResumoPorEmail,
    status: linha.status as EstadoDoResumoPorEmail,
    automatico: ligado(linha.automatico),
    createdAt: Number(linha.createdAt),
    enviadoEm: linha.enviadoEm === null ? null : Number(linha.enviadoEm),
  }));
  return {
    idioma: idiomaDaReuniao(reuniao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO,
    linkLigado: Boolean(reuniao.token),
    emailDaDona: conta?.email?.trim() || null,
    nomeDaDona: conta?.nome?.trim() || null,
    automatico: ligado(conta?.automatico),
    participantes,
    envios,
    podeMandarDeNovo: Number(paraMandarDeNovo?.total ?? 0) > 0,
  };
}

/** Liga ou desliga o envio automático da dona, com a auditoria na mesma transação. */
export async function definirEnvioAutomaticoDoResumo(dona: DonaDoEnvio, ligar: boolean, requisicao: RequisicaoDoEnvio): Promise<{ automatico: boolean }> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    await tx.update(users).set({ resumoPorEmailAutomatico: ligar })
      .where(and(eq(users.id, dona.id), eq(users.openId, dona.openId)));
    await tx.insert(auditLogs).values({
      userId: dona.id,
      action: ACAO_ENVIO_AUTOMATICO_DO_RESUMO,
      resource: "users",
      resourceId: String(dona.id),
      details: { ligado: ligar },
      ipAddress: requisicao.ipAddress.substring(0, 45),
      userAgent: requisicao.userAgent ? requisicao.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "low",
    });
  });
  return { automatico: ligar };
}

/**
 * O envio automático, chamado pela fila do resumo (server/fila-do-resumo.ts)
 * logo depois de gravar um resumo. Só faz algo quando a dona ligou a opção, a
 * conta está ativa e tem e-mail, a reunião está pronta, o resumo é o primeiro
 * (versão 1) e a reunião ainda não teve e-mail automático: o "Refazer como…" e
 * o reprocesso não mandam de novo. Vai só para a dona, com o link da reunião
 * na conta dela, e conta no teto dela; com o teto cheio, não sai. Nunca lança:
 * a fila do resumo segue, e a falha fica no log e na linha 'falhou', que a
 * dona manda de novo pelo painel.
 */
export async function envioAutomaticoDoResumo(ownerId: string, meetingId: string): Promise<void> {
  try {
    const db = await exigirDb();
    const [opcao] = await db.select({ automatico: users.resumoPorEmailAutomatico }).from(users)
      .where(eq(users.openId, ownerId)).limit(1);
    if (!ligado(opcao?.automatico)) return;
    const site = siteDosLinks();
    if (!site) {
      console.error("[ResumoPorEmail] FRONTEND_URL não definida: o envio automático não tem link para mandar.");
      return;
    }
    const agora = Date.now();
    const lote = crypto.randomUUID();
    const preparado = await db.transaction(async tx => {
      const [conta] = await tx.select({ id: users.id, email: users.email, nome: users.name, automatico: users.resumoPorEmailAutomatico, ativa: users.isActive })
        .from(users).where(eq(users.openId, ownerId)).for("update");
      const email = conta?.email?.trim();
      if (!conta || !ligado(conta.automatico) || !ligado(conta.ativa) || !email || !emailDoParticipanteValido(email)) return null;
      const [reuniao] = await tx.select({ status: meetings.status, titulo: meetings.title, idioma: meetings.language }).from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).for("update");
      if (reuniao?.status !== "ready") return null;
      const resumo = await temResumoGravado(tx, ownerId, meetingId);
      if (resumo?.versao !== 1) return null;
      const [jaMandado] = await tx.select({ id: resumoPorEmail.id }).from(resumoPorEmail)
        .where(and(eq(resumoPorEmail.ownerId, ownerId), eq(resumoPorEmail.meetingId, meetingId), eq(resumoPorEmail.automatico, true)))
        .limit(1);
      if (jaMandado) return null;
      try {
        await conferirTetos(tx, ownerId, meetingId, 1, agora);
      } catch (erro) {
        if (erro instanceof TRPCError && erro.code === "TOO_MANY_REQUESTS") {
          console.warn(`[ResumoPorEmail] o envio automático da reunião ${meetingId} não saiu: a dona está no teto de e-mails do resumo.`);
          return null;
        }
        throw erro;
      }
      const idioma: IdiomaDaReuniao = idiomaDaReuniao(reuniao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
      const linha = {
        id: crypto.randomUUID(), meetingId, ownerId, loteId: lote, destinatario: email, origem: "dona" as const, idioma,
        status: "pendente" as const, automatico: true, tentativas: 0, createdAt: agora, updatedAt: agora,
      };
      await tx.insert(resumoPorEmail).values(linha);
      await tx.insert(auditLogs).values({
        userId: conta.id,
        action: ACAO_RESUMO_POR_EMAIL,
        resource: "meetings",
        resourceId: meetingId,
        details: {
          lote, quantidade: 1, porOrigem: { dona: 1, participante: 0, digitado: 0 }, idioma,
          linkLigadoAgora: false, automatico: true, destinatarios: [hashDoEmail(email)],
        },
        ipAddress: null,
        userAgent: null,
        status: "success",
        riskLevel: "low",
      });
      return { linha, titulo: reuniao.titulo, nomeDaDona: conta.nome?.trim() || null };
    });
    if (!preparado) return;
    await mandarAsLinhas(db, ownerId, meetingId, [preparado.linha], { site, link: null, titulo: preparado.titulo, nomeDaDona: preparado.nomeDaDona });
  } catch (erro) {
    console.error(`[ResumoPorEmail] o envio automático da reunião ${meetingId} falhou:`, descreverErroDeBanco(erro));
  }
}
