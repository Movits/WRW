import crypto from "crypto";
import type { Express } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nomesDosFalantes, VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { ROTA_DA_REUNIAO_ABERTA } from "@shared/rotas";
import { auditLogs, meetingAudioSlices, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import { ACAO_LINK_LIGADO, linkMostraOsNomes } from "./autorizacao-do-link-aberto";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { gravacaoParaOuvir } from "./meeting-service";
import { comCookiesDoPedido, cookiesDoPedido, entradaValida, gerarSenhaDoLink, hashDaSenhaDoLink } from "./senha-do-link-aberto";
import { storageGetSignedUrl } from "./storage";

/**
 * O link aberto da reunião: pedido do Roberto em 12/11/2026, "por enquanto".
 * A dona liga o link de uma reunião pronta, e quem tem o endereço
 * /r/{token} ouve a gravação, lê e traduz a transcrição e pede à IA o resumo e
 * respostas sobre a reunião, sem conta na WRW. Isto troca, por ora, a reunião
 * compartilhada só com participantes e com a administração (R1 do desenho em
 * docs/arquitetura/gravador-de-reunioes.md).
 *
 * O que o link NÃO abre: o que é da rede particular da dona (sugestões de
 * contato, entidades, pendências do Meu Network Inteligente), o nome dela e
 * qualquer mudança (excluir, reprocessar, decidir). As consultas daqui escolhem
 * as colunas uma a uma: privacidade é regra de consulta, não de tela. Os nomes
 * que a dona deu às vozes saem por decisão do Roberto de 16/11/2026 (H3b), e só
 * quando ela ligou o link com a confirmação que fala deles (verReuniaoPeloLink).
 *
 * O token é o segredo: 24 bytes aleatórios (192 bits) em base64url. Fica em
 * texto no banco, e não em hash, porque a dona copia o link de novo depois; quem
 * lê `meetings` já lê a transcrição ao lado. Desligar apaga o token, e o link
 * novo sai com outro valor: o endereço antigo para de abrir na hora.
 *
 * Desde a H23 (HN-57 do HiNoter), a dona pode pôr no link uma senha de 6
 * dígitos e escolher se ele leva o áudio. A senha é conferida em reuniaoDoLink,
 * o ponto por onde passa tudo o que o link abre: sem o cookie de quem acertou a
 * senha (server/senha-do-link-aberto.ts), a página, o resumo, o mapa, as
 * traduções, a pergunta e o áudio recusam. Sem o áudio, o link não manda a
 * gravação nem assina o endereço dela. O link ligado antes da H23 segue sem
 * senha e com o áudio até a dona mudar.
 */

const BYTES_DO_TOKEN = 24;
export const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Onde a página do link toca o áudio: `${ROTA_DO_AUDIO_DO_LINK}/{token}/audio`. */
export const ROTA_DO_AUDIO_DO_LINK = "/reuniao-aberta";

export const MENSAGEM_LINK_NAO_ENCONTRADO = "Este link de reunião não existe ou foi desligado.";
export const MENSAGEM_SO_REUNIAO_PRONTA = "Só dá para compartilhar uma reunião pronta.";
export const MENSAGEM_SENHA_DO_LINK_PEDIDA = "Este link pede a senha de 6 dígitos.";
export const MENSAGEM_LINK_DESLIGADO = "O link desta reunião está desligado.";
const MENSAGEM_REUNIAO_NAO_ENCONTRADA = "Reunião não encontrada.";

/** As mudanças da dona no link ligado (H23), cada uma com a linha dela em `audit_logs`, na mesma transação. */
export const ACAO_SENHA_DO_LINK_LIGADA = "MEETING_OPEN_LINK_PASSWORD_ON";
export const ACAO_SENHA_DO_LINK_TIRADA = "MEETING_OPEN_LINK_PASSWORD_OFF";
export const ACAO_AUDIO_DO_LINK = "MEETING_OPEN_LINK_AUDIO";

type CodigoDaRecusa = "NOT_FOUND" | "PRECONDITION_FAILED" | "UNAUTHORIZED";

/** Recusa com o código que o router repassa e a tela traduz. UNAUTHORIZED: o link pede a senha. */
export class LinkAbertoRecusado extends Error {
  readonly codigo: CodigoDaRecusa;
  constructor(codigo: CodigoDaRecusa, mensagem: string) {
    super(mensagem);
    this.name = "LinkAbertoRecusado";
    this.codigo = codigo;
  }
}

export function gerarTokenDoLink(): string {
  return crypto.randomBytes(BYTES_DO_TOKEN).toString("base64url");
}

export function enderecoDoAudioDoLink(token: string): string {
  return `${ROTA_DO_AUDIO_DO_LINK}/${token}/audio`;
}

// A ação mora em autorizacao-do-link-aberto.ts, que também lê a confirmação;
// sai daqui também, para quem já a importava deste módulo.
export { ACAO_LINK_LIGADO };

/** Quem pediu a mudança no link: a dona da sessão, com o IP e o navegador, para a auditoria. */
type ProvaDaDona = { userId: number; ipAddress: string; userAgent: string | undefined };
type ProvaDaConfirmacao = ProvaDaDona & {
  idioma: string; textoExibido: string;
  versaoDaAutorizacao?: typeof VERSAO_DA_AUTORIZACAO_COM_NOMES;
};

/** O que a dona escolhe ao ligar o link (H23). Sem escolha, o link de antes: sem senha e com o áudio. */
export type OpcoesDoLink = { comSenha?: boolean; incluirAudio?: boolean };

/** O link ligado e a senha dele, que sai só para quem acabou de criá-lo (null no link que já estava ligado, ou sem senha). */
export type LinkLigado = { token: string; senha: string | null };

// Os mesmos cortes do createAuditLog (server/security.ts).
function quemPediu(prova: ProvaDaDona) {
  return {
    userId: prova.userId,
    ipAddress: prova.ipAddress.substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
  };
}

// O freio da força bruta volta a zero junto com a senha nova, a tirada e o link desligado.
const FREIO_DO_LINK_ZERADO = { sharePasswordFailures: 0, sharePasswordFailedAt: null, sharePasswordLockedUntil: null };

/**
 * O link de antes da H23, sem senha e com o áudio: liga e devolve só o token
 * (ligarLinkAbertoComOpcoes, abaixo, faz o trabalho). É o que a tela manda
 * quando não escolhe nada, a aba aberta antes do deploy.
 */
export async function ligarLinkAberto(ownerId: string, meetingId: string, prova: ProvaDaConfirmacao): Promise<string> {
  return (await ligarLinkAbertoComOpcoes(ownerId, meetingId, prova)).token;
}

/**
 * Liga o link da reunião e devolve o token, ou devolve o que já está ligado.
 * O UPDATE só grava sobre token nulo: dois pedidos ao mesmo tempo (duplo
 * clique, duas abas) ficam com o MESMO link, porque o segundo não acha mais
 * token nulo e a leitura de depois devolve o do primeiro.
 *
 * A confirmação da dona de que as pessoas que falaram autorizaram é a única
 * prova de que a voz delas pode ficar aberta a quem tiver o link. Por isso ela
 * entra em `audit_logs` na MESMA transação, com IP e user-agent, por insert
 * direto que lança (o `createAuditLog` engole o erro): sem a linha, o link não
 * liga. É o padrão da declaração de maioridade (server/maioridade.ts). Como no
 * aceite do NDA da Deal Room, a linha guarda também o texto que a dona viu e o
 * idioma dele, com o hash: a frase da caixa vai mudar (a Cris revisa), e a
 * prova de um link antigo tem de dizer o que foi confirmado naquele dia.
 *
 * A linha guarda ainda a versão da confirmação (H3b): 2 quando a tela manda a
 * caixa que fala dos nomes das vozes, e 1 quando não manda nada, que é a aba
 * aberta antes do deploy, com a frase antiga. Só a versão 2 deixa o link
 * mostrar os nomes (linkMostraOsNomes, em autorizacao-do-link-aberto.ts).
 *
 * Desde a H23, a dona escolhe ao ligar a senha de 6 dígitos, gerada aqui, e se
 * o link leva o áudio, e a linha da auditoria diz como o link ficou. Tudo no
 * mesmo UPDATE que grava o token: o link pedido com senha nunca abre um
 * instante sem ela. A senha em texto volta só a quem criou o link; o banco
 * guarda o hash. O hash sai antes da transação, para o scrypt não segurar a
 * linha.
 */
export async function ligarLinkAbertoComOpcoes(
  ownerId: string,
  meetingId: string,
  prova: ProvaDaConfirmacao,
  opcoes: OpcoesDoLink = {},
): Promise<LinkLigado> {
  const comSenha = opcoes.comSenha === true;
  const incluirAudio = opcoes.incluirAudio !== false;
  const senha = comSenha ? gerarSenhaDoLink() : null;
  const hash = senha ? await hashDaSenhaDoLink(senha) : null;
  const tokenNovo = gerarTokenDoLink();
  const db = await exigirDb();
  return db.transaction(async tx => {
    const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId));
    await tx.update(meetings).set({ shareToken: tokenNovo, sharePasswordHash: hash, shareAudio: incluirAudio, ...FREIO_DO_LINK_ZERADO })
      .where(and(daDona, eq(meetings.status, "ready"), isNull(meetings.shareToken)));
    const [reuniao] = await tx.select({
      status: meetings.status, shareToken: meetings.shareToken, sharePasswordHash: meetings.sharePasswordHash, shareAudio: meetings.shareAudio,
    }).from(meetings).where(daDona).limit(1);
    // Lançar aqui desfaz o UPDATE.
    if (!reuniao || reuniao.status === "deleted") throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    // Em gravação, processando ou com falha não há o que compartilhar ainda.
    if (reuniao.status !== "ready" || !reuniao.shareToken) throw new LinkAbertoRecusado("PRECONDITION_FAILED", MENSAGEM_SO_REUNIAO_PRONTA);
    // O link já estava ligado (duplo clique, outra aba): fica como estava, e a
    // senha sorteada aqui não vale nada. A dona troca a senha para ver uma.
    const criou = reuniao.shareToken === tokenNovo;
    await tx.insert(auditLogs).values({
      ...quemPediu(prova),
      action: ACAO_LINK_LIGADO,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        autorizacaoDasPessoas: true,
        // Ausente vale 1: a aba velha, com a frase antiga, nunca grava "2".
        versaoDaAutorizacao: prova.versaoDaAutorizacao === VERSAO_DA_AUTORIZACAO_COM_NOMES ? VERSAO_DA_AUTORIZACAO_COM_NOMES : 1,
        idioma: prova.idioma,
        textoExibido: prova.textoExibido,
        textoHash: crypto.createHash("sha256").update(prova.textoExibido).digest("hex"),
        // Como o link ficou (H23): com o pedido de agora, ou como já estava.
        comSenha: reuniao.sharePasswordHash !== null,
        incluirAudio: reuniao.shareAudio,
      },
      status: "success",
      riskLevel: "medium",
    });
    return { token: reuniao.shareToken, senha: criou ? senha : null };
  });
}

/**
 * Desliga o link: quem tem o endereço perde o acesso na hora. Desligar duas
 * vezes não é erro. A senha sai junto: o link novo sai com o que a dona
 * escolher na hora de ligar.
 */
export async function desligarLinkAberto(ownerId: string, meetingId: string): Promise<void> {
  const db = await exigirDb();
  const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId));
  await db.update(meetings).set({ shareToken: null, sharePasswordHash: null, ...FREIO_DO_LINK_ZERADO }).where(daDona);
  const [reuniao] = await db.select({ id: meetings.id }).from(meetings).where(daDona).limit(1);
  if (!reuniao) throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
}

type Transacao = Parameters<Parameters<Awaited<ReturnType<typeof exigirDb>>["transaction"]>[0]>[0];

/**
 * A reunião da dona com o link ligado, com a linha travada até o fim da
 * transação, ou a recusa: outra conta e reunião excluída levam NOT_FOUND; o
 * link desligado, PRECONDITION_FAILED.
 */
async function linkLigadoDaDona(tx: Transacao, ownerId: string, meetingId: string) {
  const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId));
  const [reuniao] = await tx.select({
    status: meetings.status, shareToken: meetings.shareToken, sharePasswordHash: meetings.sharePasswordHash, shareAudio: meetings.shareAudio,
  }).from(meetings).where(daDona).limit(1).for("update");
  if (!reuniao || reuniao.status === "deleted") throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  if (reuniao.status !== "ready" || !reuniao.shareToken) throw new LinkAbertoRecusado("PRECONDITION_FAILED", MENSAGEM_LINK_DESLIGADO);
  return { ...reuniao, daDona };
}

/**
 * Uma senha nova para o link ligado (H23): liga a senha no link que não tinha,
 * ou troca a que havia. A anterior deixa de valer na hora, e quem entrou com
 * ela perde a entrada (o cookie é preso ao hash). Devolve a senha em texto,
 * a única vez que ela sai do servidor.
 */
export async function novaSenhaDoLink(ownerId: string, meetingId: string, prova: ProvaDaDona): Promise<string> {
  const senha = gerarSenhaDoLink();
  const hash = await hashDaSenhaDoLink(senha);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const reuniao = await linkLigadoDaDona(tx, ownerId, meetingId);
    await tx.update(meetings).set({ sharePasswordHash: hash, ...FREIO_DO_LINK_ZERADO }).where(reuniao.daDona);
    await tx.insert(auditLogs).values({
      ...quemPediu(prova),
      action: ACAO_SENHA_DO_LINK_LIGADA, resource: "meetings", resourceId: meetingId,
      details: { troca: reuniao.sharePasswordHash !== null },
      status: "success", riskLevel: "medium",
    });
    return senha;
  });
}

/**
 * Tira a senha do link ligado: quem tem o endereço volta a abrir sem senha.
 * Tirar o que não existe não é erro nem vai à auditoria.
 */
export async function tirarSenhaDoLink(ownerId: string, meetingId: string, prova: ProvaDaDona): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const reuniao = await linkLigadoDaDona(tx, ownerId, meetingId);
    if (reuniao.sharePasswordHash === null) return;
    await tx.update(meetings).set({ sharePasswordHash: null, ...FREIO_DO_LINK_ZERADO }).where(reuniao.daDona);
    await tx.insert(auditLogs).values({
      ...quemPediu(prova),
      action: ACAO_SENHA_DO_LINK_TIRADA, resource: "meetings", resourceId: meetingId,
      status: "success", riskLevel: "medium",
    });
  });
}

/**
 * Se o link ligado leva o áudio (H23). Desligado, a página do link deixa de
 * receber a gravação e a rota do áudio recusa na hora; quem já tinha o áudio
 * carregado segue ouvindo até a URL assinada vencer (1 hora), como ao desligar
 * o link. A mesma escolha de novo não muda nada nem vai à auditoria.
 */
export async function mudarAudioDoLink(ownerId: string, meetingId: string, incluirAudio: boolean, prova: ProvaDaDona): Promise<void> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const reuniao = await linkLigadoDaDona(tx, ownerId, meetingId);
    if (reuniao.shareAudio === incluirAudio) return;
    await tx.update(meetings).set({ shareAudio: incluirAudio }).where(reuniao.daDona);
    await tx.insert(auditLogs).values({
      ...quemPediu(prova),
      action: ACAO_AUDIO_DO_LINK, resource: "meetings", resourceId: meetingId,
      details: { incluirAudio },
      status: "success", riskLevel: incluirAudio ? "medium" : "low",
    });
  });
}

/**
 * A reunião por trás de um link ligado; null quando não há (link que não
 * existe, desligado, de reunião que não está pronta ou de conta inativa); ou
 * "senha", quando o link tem senha e o pedido não traz o cookie de quem a
 * acertou (H23). Só reunião pronta, de conta ativa: a conta desativada pela
 * administração (ou pelo bloqueio automático) deixa de servir o que
 * compartilhou, como deixa de entrar.
 *
 * Os cookies vêm do contexto do pedido (comCookiesDoPedido, que o router do
 * link e a rota do áudio abrem). Fora dele não há cookie, e o link com senha
 * recusa.
 */
async function reuniaoDoLink(token: string) {
  if (!FORMATO_DO_TOKEN.test(token)) return null;
  const db = await exigirDb();
  const [reuniao] = await db.select({
    id: meetings.id,
    ownerId: meetings.ownerId,
    title: meetings.title,
    status: meetings.status,
    createdAt: meetings.createdAt,
    shareToken: meetings.shareToken,
    audioPipeline: meetings.audioPipeline,
    sharePasswordHash: meetings.sharePasswordHash,
    shareAudio: meetings.shareAudio,
    contaAtiva: users.isActive,
  }).from(meetings)
    .innerJoin(users, eq(users.openId, meetings.ownerId))
    .where(eq(meetings.shareToken, token))
    .limit(1);
  // A coluna herda a collation do banco, que não distingue maiúsculas (a
  // ressalva de server/db.ts sobre os nomes de contexto): no SQL, "AbC..." e
  // "abc..." acham a mesma linha. A igualdade exata fica aqui, em JS, para a
  // variação de caixa não abrir o link nem virar outro balde do teto.
  if (!reuniao || reuniao.shareToken !== token || reuniao.status !== "ready" || !reuniao.contaAtiva) return null;
  // As duas regras da H23 falham fechadas: hash que não é nulo pede a entrada,
  // e só o `true` do banco serve o áudio.
  if (reuniao.sharePasswordHash !== null && !entradaValida(token, reuniao.sharePasswordHash, cookiesDoPedido())) return "senha" as const;
  return {
    id: reuniao.id, ownerId: reuniao.ownerId, title: reuniao.title, createdAt: reuniao.createdAt, emPartes: reuniao.audioPipeline === "slices",
    comAudio: reuniao.shareAudio === true,
  };
}

/** Os segmentos no contrato do desenho ({inicio, fim, falante, texto, lacuna?}), sem outro campo. */
export function segmentosDoContrato(bruto: unknown): Array<{ inicio: number; fim: number; falante: string; texto: string; lacuna?: true }> {
  if (!Array.isArray(bruto)) return [];
  const saida: Array<{ inicio: number; fim: number; falante: string; texto: string; lacuna?: true }> = [];
  for (const s of bruto) {
    if (!s || typeof s !== "object") continue;
    const { inicio, fim, falante, texto, lacuna } = s as Record<string, unknown>;
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || typeof falante !== "string" || typeof texto !== "string") continue;
    saida.push({ inicio: Number(inicio), fim: Number(fim), falante: falante.slice(0, 4), texto, ...(lacuna === true ? { lacuna: true as const } : {}) });
  }
  return saida;
}

/**
 * A reunião do link, ou a recusa: NOT_FOUND para o link que não existe e o
 * desligado, que parecem iguais; UNAUTHORIZED para o link com senha sem a
 * entrada de quem a acertou (H23).
 */
export async function exigirReuniaoDoLink(token: string) {
  const reuniao = await reuniaoDoLink(token);
  if (!reuniao) throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_LINK_NAO_ENCONTRADO);
  if (reuniao === "senha") throw new LinkAbertoRecusado("UNAUTHORIZED", MENSAGEM_SENHA_DO_LINK_PEDIDA);
  return reuniao;
}

/**
 * Os nomes que a dona deu às vozes, para a página do link (H3b, decisão do
 * Roberto de 16/11/2026): só se o link foi ligado com a confirmação que fala
 * deles; senão, nenhum, e a página mostra "Falante n". Saem por
 * nomesDosFalantes, como na tela da dona: só as chaves F1 a F99, cada nome
 * aparado e cortado em 60 caracteres, e o par inválido da coluna (JSON livre)
 * cai. Nada além do mapa: nem o nome da dona, nem conta, nem id.
 */
async function vozesDoLink(db: Awaited<ReturnType<typeof exigirDb>>, reuniao: { id: string; ownerId: string }): Promise<Record<string, string>> {
  if (!(await linkMostraOsNomes(db, reuniao.id))) return {};
  const [linha] = await db.select({ speakerNames: meetings.speakerNames }).from(meetings)
    .where(and(eq(meetings.id, reuniao.id), eq(meetings.ownerId, reuniao.ownerId)))
    .limit(1);
  return nomesDosFalantes(linha?.speakerNames);
}

/**
 * O que a página do link mostra: título, data, transcrição, gravação e os
 * nomes das vozes. O endereço do áudio é o da rota do link, nunca o do proxy
 * da dona (/manus-storage/, que pede a sessão dela), e nada aqui traz o id da
 * dona, o da reunião ou a chave do bucket (a rota do áudio, abaixo, revela o
 * caminho no destino do 307). Sem o áudio (H23), a gravação nem é lida:
 * `audioIncluido` falso, sem gravação e sem os avisos dela.
 */
export async function verReuniaoPeloLink(token: string) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  // As falas por falante (D1) vão junto: são o mesmo texto da transcrição,
  // separado por voz e tempo, com o rótulo F1, F2... A página troca o rótulo
  // pelo nome do `vozes`, ou por "Falante n".
  const [transcricao] = await db.select({ texto: meetingTranscripts.transcript, idioma: meetingTranscripts.language, segmentos: meetingTranscripts.segments })
    .from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, reuniao.id), eq(meetingTranscripts.ownerId, reuniao.ownerId)))
    .limit(1);
  // Só reunião pronta tem link aberto (reuniaoDoLink recusa as outras).
  const { recording, recordingExpired, recordingDeletionPending } = reuniao.comAudio
    ? await gravacaoParaOuvir(db, reuniao.ownerId, reuniao.id, { createdAt: reuniao.createdAt, status: "ready", emPartes: reuniao.emPartes })
    : { recording: null, recordingExpired: false, recordingDeletionPending: false };
  const vozes = await vozesDoLink(db, reuniao);
  return {
    titulo: reuniao.title,
    criadaEm: reuniao.createdAt,
    // Só os campos do contrato do segmento, e só segmentos nesse formato: a coluna
    // é JSON livre, e nada além da fala, da voz e do tempo sai pelo link público.
    transcricao: transcricao ? { texto: transcricao.texto, idioma: transcricao.idioma, segmentos: segmentosDoContrato(transcricao.segmentos) } : null,
    gravacao: recording
      ? {
          url: enderecoDoAudioDoLink(token), mimeType: recording.mimeType, durationSeconds: recording.durationSeconds, expiresAt: recording.expiresAt,
          // Cada parte pela rota do link (nunca o proxy da dona), com ?parte.
          partes: recording.partes.map(p => ({
            seq: p.seq, url: reuniao.emPartes ? `${enderecoDoAudioDoLink(token)}?parte=${p.seq}` : enderecoDoAudioDoLink(token),
            mimeType: p.mimeType, inicioSegundos: p.inicioSegundos, duracaoSegundos: p.duracaoSegundos,
          })),
        }
      : null,
    // "Foi apagada" só quando o áudio saiu do bucket; vencido e ainda saindo é outro aviso.
    gravacaoExpirada: recordingExpired,
    gravacaoSaindo: recordingDeletionPending,
    // A dona tirou o áudio do link (H23): a página diz isso no lugar do player.
    audioIncluido: reuniao.comAudio,
    // O resumo guardado e a resposta da IA chegam com o rótulo ({F2}): a página
    // os troca pelo nome com este mesmo mapa. A IA nunca recebe os nomes.
    vozes,
  };
}

/**
 * A chave do áudio que o link toca agora, ou null: link desligado, com senha
 * sem a entrada, sem o áudio (H23), sem gravação ou com o áudio vencido.
 */
export async function chaveDoAudioDoLink(token: string, parte?: number): Promise<string | null> {
  const reuniao = await reuniaoDoLink(token);
  if (!reuniao || reuniao === "senha" || !reuniao.comAudio) return null;
  const db = await exigirDb();
  // A reunião em partes toca cada parte pela posição (?parte); sem ela, a primeira.
  if (reuniao.emPartes) {
    const [linha] = await db.select({ storageKey: meetingAudioSlices.storageKey, expiresAt: meetingAudioSlices.expiresAt, status: meetingAudioSlices.status })
      .from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.meetingId, reuniao.id), eq(meetingAudioSlices.ownerId, reuniao.ownerId), eq(meetingAudioSlices.seq, parte ?? 0)))
      .limit(1);
    if (!linha || linha.expiresAt <= Date.now() || (linha.status !== "received" && linha.status !== "transcribed")) return null;
    return linha.storageKey;
  }
  // A mais recente, como em gravacaoParaOuvir: é a que a página mostra.
  const [gravacao] = await db.select({ storageKey: meetingRecordings.storageKey, expiresAt: meetingRecordings.expiresAt })
    .from(meetingRecordings)
    .where(and(eq(meetingRecordings.meetingId, reuniao.id), eq(meetingRecordings.ownerId, reuniao.ownerId)))
    .orderBy(desc(meetingRecordings.createdAt))
    .limit(1);
  if (!gravacao || gravacao.expiresAt <= Date.now()) return null;
  return gravacao.storageKey;
}

/**
 * As duas rotas Express do link, antes do tRPC e da página:
 *  - a página /r/{token} é a mesma aplicação de sempre; o servidor só pede aos
 *    buscadores que não a guardem, se alguém publicar o endereço;
 *  - o áudio responde 307 para a URL assinada, como o proxy da dona, mas pelo
 *    token, sem sessão. O destino do 307 traz o caminho do arquivo no bucket
 *    (o openId da dona, aleatório, e o id da reunião), como no proxy da dona;
 *    nenhum dos dois abre nada sem sessão. A URL assinada vale 1 hora
 *    (server/storage.ts): desligar o link barra a página e os pedidos novos na
 *    hora, mas quem já tinha a gravação carregada segue ouvindo até ela vencer.
 *    O áudio do link com senha (H23) pede o cookie de quem a acertou, que o
 *    navegador manda junto com o pedido do player.
 * As dependências entram por parâmetro só para o teste da rota trocá-las.
 */
export function registrarRotasDoLinkAberto(
  app: Express,
  { acharChave, assinar }: { acharChave: (token: string, parte?: number) => Promise<string | null>; assinar: (chave: string) => Promise<string> } =
    { acharChave: chaveDoAudioDoLink, assinar: storageGetSignedUrl },
) {
  app.use(ROTA_DA_REUNIAO_ABERTA, (_req, res, next) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.get(`${ROTA_DO_AUDIO_DO_LINK}/:token/audio`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    let chave: string | null;
    try {
      // ?parte só vale como número inteiro pequeno; qualquer outra coisa é a primeira.
      const parte = /^\d{1,4}$/.test(String(req.query.parte ?? "")) ? Number(req.query.parte) : undefined;
      // Os cookies do pedido vão ao contexto: é por eles que o link com senha abre.
      chave = await comCookiesDoPedido(req.headers.cookie, () => acharChave(String(req.params.token ?? ""), parte));
    } catch (erro) {
      // Banco fora do ar não é "link desligado": 404 faria a página dizer que
      // a gravação sumiu. Fora do tRPC não há middleware que traduza.
      if (ehErroDeBancoIndisponivel(erro)) {
        console.error(`[LinkAberto] banco indisponível ao achar o áudio: ${descreverErroDeBanco(erro)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      // Sem o objeto do erro: o do drizzle traz os parâmetros da consulta, e
      // um deles é o token, que abre a reunião. A descrição tira os parâmetros.
      console.error(`[LinkAberto] a busca do áudio falhou: ${descreverErroDeBanco(erro)}`);
      res.status(500).send("Erro ao buscar a gravação");
      return;
    }
    if (!chave) {
      res.status(404).send("Gravação não encontrada");
      return;
    }
    try {
      res.redirect(307, await assinar(chave));
    } catch (erro) {
      console.error(`[LinkAberto] a URL assinada do áudio falhou: ${descreverErroDeBanco(erro)}`);
      res.status(503).send("Storage não configurado ou indisponível");
    }
  });
}
