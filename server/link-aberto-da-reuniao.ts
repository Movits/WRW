import crypto from "crypto";
import type { Express } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ROTA_DA_REUNIAO_ABERTA } from "@shared/rotas";
import { auditLogs, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { gravacaoParaOuvir } from "./meeting-service";
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
 * as colunas uma a uma: privacidade é regra de consulta, não de tela.
 *
 * O token é o segredo: 24 bytes aleatórios (192 bits) em base64url. Fica em
 * texto no banco, e não em hash, porque a dona copia o link de novo depois; quem
 * lê `meetings` já lê a transcrição ao lado. Desligar apaga o token, e o link
 * novo sai com outro valor: o endereço antigo para de abrir na hora.
 */

const BYTES_DO_TOKEN = 24;
const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Onde a página do link toca o áudio: `${ROTA_DO_AUDIO_DO_LINK}/{token}/audio`. */
export const ROTA_DO_AUDIO_DO_LINK = "/reuniao-aberta";

export const MENSAGEM_LINK_NAO_ENCONTRADO = "Este link de reunião não existe ou foi desligado.";
export const MENSAGEM_SO_REUNIAO_PRONTA = "Só dá para compartilhar uma reunião pronta.";
const MENSAGEM_REUNIAO_NAO_ENCONTRADA = "Reunião não encontrada.";

/** Recusa com o código que o router repassa e a tela traduz. */
export class LinkAbertoRecusado extends Error {
  readonly codigo: "NOT_FOUND" | "PRECONDITION_FAILED";
  constructor(codigo: "NOT_FOUND" | "PRECONDITION_FAILED", mensagem: string) {
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

/** Ação gravada em `audit_logs` a cada vez que a dona liga o link, com a confirmação dela. */
export const ACAO_LINK_LIGADO = "MEETING_OPEN_LINK_ON";

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
 */
export async function ligarLinkAberto(
  ownerId: string,
  meetingId: string,
  prova: { userId: number; ipAddress: string; userAgent: string | undefined; idioma: string; textoExibido: string },
): Promise<string> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId));
    await tx.update(meetings).set({ shareToken: gerarTokenDoLink() })
      .where(and(daDona, eq(meetings.status, "ready"), isNull(meetings.shareToken)));
    const [reuniao] = await tx.select({ status: meetings.status, shareToken: meetings.shareToken }).from(meetings)
      .where(daDona).limit(1);
    // Lançar aqui desfaz o UPDATE.
    if (!reuniao || reuniao.status === "deleted") throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    // Em gravação, processando ou com falha não há o que compartilhar ainda.
    if (reuniao.status !== "ready" || !reuniao.shareToken) throw new LinkAbertoRecusado("PRECONDITION_FAILED", MENSAGEM_SO_REUNIAO_PRONTA);
    await tx.insert(auditLogs).values({
      userId: prova.userId,
      action: ACAO_LINK_LIGADO,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        autorizacaoDasPessoas: true,
        idioma: prova.idioma,
        textoExibido: prova.textoExibido,
        textoHash: crypto.createHash("sha256").update(prova.textoExibido).digest("hex"),
      },
      // Os mesmos cortes do createAuditLog (server/security.ts).
      ipAddress: prova.ipAddress.substring(0, 45),
      userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
      status: "success",
      riskLevel: "medium",
    });
    return reuniao.shareToken;
  });
}

/** Desliga o link: quem tem o endereço perde o acesso na hora. Desligar duas vezes não é erro. */
export async function desligarLinkAberto(ownerId: string, meetingId: string): Promise<void> {
  const db = await exigirDb();
  const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId));
  await db.update(meetings).set({ shareToken: null }).where(daDona);
  const [reuniao] = await db.select({ id: meetings.id }).from(meetings).where(daDona).limit(1);
  if (!reuniao) throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
}

/**
 * A reunião por trás de um link ligado, ou null. Só reunião pronta, de conta
 * ativa: a conta desativada pela administração (ou pelo bloqueio automático)
 * deixa de servir o que compartilhou, como deixa de entrar.
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
  return { id: reuniao.id, ownerId: reuniao.ownerId, title: reuniao.title, createdAt: reuniao.createdAt };
}

/** A reunião do link, ou a recusa NOT_FOUND: link que não existe e link desligado parecem iguais. */
export async function exigirReuniaoDoLink(token: string) {
  const reuniao = await reuniaoDoLink(token);
  if (!reuniao) throw new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_LINK_NAO_ENCONTRADO);
  return reuniao;
}

/**
 * O que a página do link mostra: título, data, transcrição e gravação. O
 * endereço do áudio é o da rota do link, nunca o do proxy da dona
 * (/manus-storage/, que pede a sessão dela), e nada aqui traz o id da dona, o
 * da reunião ou a chave do bucket (a rota do áudio, abaixo, revela o caminho
 * no destino do 307).
 */
export async function verReuniaoPeloLink(token: string) {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  const [transcricao] = await db.select({ texto: meetingTranscripts.transcript, idioma: meetingTranscripts.language })
    .from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, reuniao.id), eq(meetingTranscripts.ownerId, reuniao.ownerId)))
    .limit(1);
  const { recording, recordingExpired } = await gravacaoParaOuvir(db, reuniao.ownerId, reuniao.id, reuniao.createdAt);
  return {
    titulo: reuniao.title,
    criadaEm: reuniao.createdAt,
    transcricao: transcricao ?? null,
    gravacao: recording
      ? { url: enderecoDoAudioDoLink(token), mimeType: recording.mimeType, durationSeconds: recording.durationSeconds, expiresAt: recording.expiresAt }
      : null,
    gravacaoExpirada: recordingExpired,
  };
}

/** A chave do áudio que o link toca agora, ou null (link desligado, sem áudio ou áudio vencido). */
export async function chaveDoAudioDoLink(token: string): Promise<string | null> {
  const reuniao = await reuniaoDoLink(token);
  if (!reuniao) return null;
  const db = await exigirDb();
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
 * As dependências entram por parâmetro só para o teste da rota trocá-las.
 */
export function registrarRotasDoLinkAberto(
  app: Express,
  { acharChave, assinar }: { acharChave: (token: string) => Promise<string | null>; assinar: (chave: string) => Promise<string> } =
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
      chave = await acharChave(String(req.params.token ?? ""));
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
