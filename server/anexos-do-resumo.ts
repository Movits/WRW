import crypto from "crypto";
import type { Express, Request } from "express";
import { and, asc, count, eq, gt } from "drizzle-orm";
import {
  ANEXO_BYTES_MAX, ANEXOS_POR_JANELA, ANEXOS_POR_REUNIAO_MAX, enderecoDoAnexoDoLink, JANELA_DOS_ANEXOS_MS, RECUSAS_DOS_ANEXOS, ROTA_DO_ANEXO_DO_LINK,
  type AnexoDaDona, type AnexoDoLink, type CodigoDaRecusaDoAnexo, type FormatoDeAnexo, type TipoDeAnexo,
} from "@shared/anexos-do-resumo";
import { auditLogs, meetingAttachments, meetings } from "../drizzle/schema";
import { criarTeto } from "./assistente-de-texto";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { exigirReuniaoDoLink, LinkAbertoRecusado } from "./link-aberto-da-reuniao";
import { MEETING_AUDIO_TTL_MS } from "./meeting-service";
import { reuniaoVisivel } from "./reuniao-visivel";
import { comCookiesDoPedido, type LeitoraDoLink } from "./senha-do-link-aberto";
import { leitoraDaRota } from "./leitora-do-link";
import { CACHE_DE_ARQUIVO_PRIVADO, storageApagarTodasAsVersoes, storageGetSignedUrl, storagePut } from "./storage";

/**
 * Os anexos do resumo da reunião (H4g e H4h do plano do gravador; HN-32 e
 * HN-33 no app de referência da cliente): a dona anexa fotos (a foto do quadro
 * branco, do slide, do cartão, de quem estava lá) e desenhos ou escrita à mão
 * feitos na tela de desenho, que chegam como imagem. Os dois são o mesmo
 * anexo, com o tipo `photo` ou `drawing`.
 *
 * O caminho do envio é o da mídia de contexto (routers/contexts.ts): a imagem
 * chega em base64 numa requisição só, já reduzida no aparelho
 * (client/src/lib/reduzir-imagem.ts, a régua da #149, que também tira o EXIF).
 * Aqui ela é conferida pelo CONTEÚDO (JPEG, PNG ou WebP; o tipo declarado não
 * conta) e perde os metadados que sobraram (tirarMetadados): quando a redução
 * recua e o original sobe como veio, a foto do celular traz o EXIF com o GPS de
 * onde foi tirada, e a imagem pode sair pelo link aberto.
 *
 * A ordem é a do documento da reunião (server/documento-da-reuniao.ts): o
 * objeto sobe com a chave exata, e a linha entra numa transação com a reunião
 * travada; se a transação não grava, o objeto sai. A linha é o ponteiro: a
 * exclusão da reunião (apagarDerivadosDaReuniao), a da conta
 * (server/exclusao-de-conta.ts) e a varredura dos 30 dias
 * (limparGravacoesVencidas) tiram o objeto com todas as versões e só então a
 * linha. O prazo é o do áudio (MEETING_AUDIO_TTL_MS, 30 dias contados do envio).
 *
 * A reunião na lixeira (H7d) não aceita nem mostra anexo (reuniaoVisivel); os
 * anexos dela ficam com ela e voltam ao restaurar, e seguem vencendo no prazo.
 * O reprocesso não toca nos anexos: eles são da dona, não da IA. A junção
 * (H17) os leva para a reunião que fica.
 *
 * O link aberto (server/link-aberto-da-reuniao.ts) mostra os anexos só pela
 * rota dele (registrarRotaDoAnexoDoLink), que passa por exigirReuniaoDoLink: o
 * link com senha (H23) pede a entrada de quem a acertou, e o desligado, o da
 * lixeira e o da conta desativada não abrem. A opção de tirar o áudio do link
 * não tira os anexos: são o resumo, não a voz (decisão vetável, no relatório).
 *
 * Custo de IA: nenhum. A imagem não vai à IA.
 */

/** Quem pede, para a auditoria. */
export type ProvaDoAnexo = { userId: number; ipAddress: string; userAgent: string | null | undefined };

/** Recusa com o código que a tela traduz e o código tRPC que o router repassa. */
export class RecusaDoAnexo extends Error {
  constructor(readonly codigoTrpc: "BAD_REQUEST" | "NOT_FOUND" | "PRECONDITION_FAILED" | "SERVICE_UNAVAILABLE", readonly codigo: CodigoDaRecusaDoAnexo) {
    super(codigo);
    this.name = "RecusaDoAnexo";
  }
}

const naoEncontrado = () => new RecusaDoAnexo("NOT_FOUND", RECUSAS_DOS_ANEXOS.naoEncontrado);

/** O teto de envios por dona, em memória como os outros (instância única do Render; zera a cada deploy). */
export const tetoDosAnexos = criarTeto(ANEXOS_POR_JANELA, JANELA_DOS_ANEXOS_MS, RECUSAS_DOS_ANEXOS.muitosEnvios);

/** O formato pelo começo do arquivo; null quando não é JPEG, PNG nem WebP. */
export function formatoDoConteudo(bytes: Buffer): FormatoDeAnexo | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * JPEG sem os segmentos de metadados: APP1 (EXIF, com o GPS, e XMP), APP13
 * (IPTC) e os comentários (COM). Ficam o JFIF (APP0), o perfil de cor (APP2) e
 * o Adobe (APP14), que mudam como a imagem se desenha. Do início dos dados da
 * imagem (SOS) em diante, tudo é copiado como está. Null quando a estrutura
 * não se lê (a imagem quebrada não sobe).
 *
 * A orientação mora no EXIF: a foto em pé de um celular que subiu crua (a
 * redução recuou) pode aparecer deitada. Aceito: a redução, o caminho comum,
 * já endireita a foto antes de tirar o EXIF.
 */
function jpegSemMetadados(bytes: Buffer): Buffer | null {
  const partes: Buffer[] = [bytes.subarray(0, 2)];
  let posicao = 2;
  while (posicao < bytes.length) {
    if (bytes[posicao] !== 0xff) return null;
    // Bytes 0xFF repetidos antes do marcador são preenchimento.
    let marcadorEm = posicao + 1;
    while (marcadorEm < bytes.length && bytes[marcadorEm] === 0xff) marcadorEm += 1;
    if (marcadorEm >= bytes.length) return null;
    const marcador = bytes[marcadorEm];
    // Marcadores sem tamanho (RSTn, TEM, SOI): passam.
    if ((marcador >= 0xd0 && marcador <= 0xd8) || marcador === 0x01) {
      partes.push(Buffer.from([0xff, marcador]));
      posicao = marcadorEm + 1;
      continue;
    }
    if (marcador === 0xd9) {
      partes.push(bytes.subarray(posicao));
      return Buffer.concat(partes);
    }
    if (marcadorEm + 2 >= bytes.length) return null;
    const tamanho = bytes.readUInt16BE(marcadorEm + 1);
    if (tamanho < 2) return null;
    const fim = marcadorEm + 1 + tamanho;
    if (fim > bytes.length) return null;
    if (marcador === 0xda) {
      // Início dos dados da imagem: daqui ao fim, sem mexer.
      partes.push(bytes.subarray(posicao));
      return Buffer.concat(partes);
    }
    const ehMetadado = marcador === 0xe1 || marcador === 0xed || marcador === 0xfe;
    if (!ehMetadado) partes.push(Buffer.from([0xff, marcador]), bytes.subarray(marcadorEm + 1, fim));
    posicao = fim;
  }
  return null;
}

/** Os pedaços de texto e de EXIF do PNG (tEXt, zTXt, iTXt e eXIf) saem; o resto fica como está, com o CRC dele. */
function pngSemMetadados(bytes: Buffer): Buffer | null {
  const partes: Buffer[] = [bytes.subarray(0, 8)];
  let posicao = 8;
  while (posicao + 12 <= bytes.length) {
    const tamanho = bytes.readUInt32BE(posicao);
    const tipo = bytes.toString("latin1", posicao + 4, posicao + 8);
    const fim = posicao + 12 + tamanho;
    if (fim > bytes.length) return null;
    if (!["tEXt", "zTXt", "iTXt", "eXIf"].includes(tipo)) partes.push(bytes.subarray(posicao, fim));
    posicao = fim;
    if (tipo === "IEND") return Buffer.concat(partes);
  }
  return null;
}

/**
 * Os pedaços EXIF e "XMP " do WebP saem, o tamanho do RIFF é refeito e, no
 * cabeçalho estendido (VP8X), os bits que anunciam os dois são apagados.
 */
function webpSemMetadados(bytes: Buffer): Buffer | null {
  const partes: Buffer[] = [];
  let posicao = 12;
  while (posicao + 8 <= bytes.length) {
    const tipo = bytes.toString("latin1", posicao, posicao + 4);
    const tamanho = bytes.readUInt32LE(posicao + 4);
    const fim = posicao + 8 + tamanho + (tamanho % 2);
    if (posicao + 8 + tamanho > bytes.length) return null;
    const pedaco = Buffer.from(bytes.subarray(posicao, Math.min(fim, bytes.length)));
    if (tipo === "VP8X" && tamanho >= 1) pedaco[8] &= ~(0x08 | 0x04);
    if (tipo !== "EXIF" && tipo !== "XMP ") partes.push(pedaco);
    posicao = fim;
  }
  if (!partes.length) return null;
  const corpo = Buffer.concat(partes);
  const cabecalho = Buffer.alloc(12);
  cabecalho.write("RIFF", 0, "latin1");
  cabecalho.writeUInt32LE(corpo.length + 4, 4);
  cabecalho.write("WEBP", 8, "latin1");
  return Buffer.concat([cabecalho, corpo]);
}

/** A imagem sem os metadados (o GPS de onde a foto foi tirada, o aparelho, o autor). Null quando a estrutura não se lê. */
export function tirarMetadados(bytes: Buffer, formato: FormatoDeAnexo): Buffer | null {
  if (formato === "image/jpeg") return jpegSemMetadados(bytes);
  if (formato === "image/png") return pngSemMetadados(bytes);
  return webpSemMetadados(bytes);
}

const EXTENSAO: Record<FormatoDeAnexo, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Os bytes do base64 que a tela manda (com ou sem o cabeçalho "data:"), conferidos e sem metadados. */
export function prepararImagemDoAnexo(base64: string): { bytes: Buffer; formato: FormatoDeAnexo } {
  const normalizado = base64.trim().replace(/^data:[^,]*;base64,/i, "").replace(/\s/g, "");
  if (!normalizado || !/^[A-Za-z0-9+/=]+$/.test(normalizado)) throw new RecusaDoAnexo("BAD_REQUEST", RECUSAS_DOS_ANEXOS.formato);
  const crus = Buffer.from(normalizado, "base64");
  if (!crus.length || crus.length > ANEXO_BYTES_MAX) throw new RecusaDoAnexo("BAD_REQUEST", RECUSAS_DOS_ANEXOS.grandeDemais);
  const formato = formatoDoConteudo(crus);
  if (!formato) throw new RecusaDoAnexo("BAD_REQUEST", RECUSAS_DOS_ANEXOS.formato);
  const limpos = tirarMetadados(crus, formato);
  if (!limpos) throw new RecusaDoAnexo("BAD_REQUEST", RECUSAS_DOS_ANEXOS.formato);
  return { bytes: limpos, formato };
}

function quemPediu(prova: ProvaDoAnexo) {
  return {
    userId: prova.userId,
    ipAddress: prova.ipAddress.split(",")[0].trim().substring(0, 45),
    userAgent: prova.userAgent ? prova.userAgent.substring(0, 500) : null,
  };
}

async function tirarObjetoSemPonteiro(chave: string) {
  try {
    await storageApagarTodasAsVersoes(chave);
  } catch (erro) {
    console.error(`[Anexos] a imagem ficou no bucket SEM ponteiro no banco; remoção manual: ${chave}`, erro instanceof Error ? erro.message : erro);
  }
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/** Quantos anexos a reunião tem e ainda valem (o vencido saindo não conta). */
async function anexosQueValem(banco: Banco | Transacao, ownerId: string, meetingId: string, agora: number): Promise<number> {
  const [linha] = await banco.select({ total: count() }).from(meetingAttachments)
    .where(and(eq(meetingAttachments.meetingId, meetingId), eq(meetingAttachments.ownerId, ownerId), gt(meetingAttachments.expiresAt, agora)));
  return Number(linha?.total ?? 0);
}

/** A reunião visível da dona (nem excluída nem na lixeira), ou a recusa NOT_FOUND, igual para a de outra conta. */
async function exigirReuniaoVisivel(banco: Banco | Transacao, ownerId: string, meetingId: string, travar = false) {
  const consulta = banco.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
  const [reuniao] = travar ? await consulta.for("update") : await consulta;
  if (!reuniao) throw naoEncontrado();
}

/**
 * Anexa uma imagem ao resumo da reunião. A reunião pode estar em qualquer
 * estado visível (gravando, processando, pronta): no app de referência, a foto
 * do slide entra no meio da reunião. Devolve o anexo como a tela o mostra.
 */
export async function anexarAoResumo(
  ownerId: string,
  meetingId: string,
  entrada: { tipo: TipoDeAnexo; dataBase64: string },
  prova: ProvaDoAnexo,
): Promise<AnexoDaDona> {
  tetoDosAnexos.conferir(ownerId);
  const { bytes, formato } = prepararImagemDoAnexo(entrada.dataBase64);
  const db = await exigirDb();
  const agora = Date.now();
  // Antes do bucket, uma leitura barata: a reunião de outra conta e a reunião
  // cheia não sobem nada.
  await exigirReuniaoVisivel(db, ownerId, meetingId);
  if (await anexosQueValem(db, ownerId, meetingId, agora) >= ANEXOS_POR_REUNIAO_MAX) {
    throw new RecusaDoAnexo("PRECONDITION_FAILED", RECUSAS_DOS_ANEXOS.demais);
  }
  const soltarVaga = tetoDosAnexos.reservar(ownerId);

  const id = crypto.randomUUID();
  const chave = `meetings/${ownerId}/${meetingId}/anexo-${id}.${EXTENSAO[formato]}`;
  try {
    await storagePut(chave, bytes, formato, { chaveExata: true, cacheControl: CACHE_DE_ARQUIVO_PRIVADO });
  } catch (erro) {
    soltarVaga();
    console.error("[Anexos] o bucket recusou a imagem:", erro instanceof Error ? erro.message : erro);
    throw new RecusaDoAnexo("SERVICE_UNAVAILABLE", RECUSAS_DOS_ANEXOS.bucket);
  }

  const linha = {
    id, meetingId, ownerId, kind: entrada.tipo, storageKey: chave, storageUrl: `/manus-storage/${chave}`, mimeType: formato,
    sizeBytes: bytes.length, expiresAt: agora + MEETING_AUDIO_TTL_MS, createdAt: agora,
  };
  try {
    await db.transaction(async tx => {
      // A reunião travada: a exclusão (que grava 'deleted' na mesma linha) e o
      // "mandar para a lixeira" esperam, ou vêm antes e este envio é recusado.
      await exigirReuniaoVisivel(tx, ownerId, meetingId, true);
      if (await anexosQueValem(tx, ownerId, meetingId, agora) >= ANEXOS_POR_REUNIAO_MAX) {
        throw new RecusaDoAnexo("PRECONDITION_FAILED", RECUSAS_DOS_ANEXOS.demais);
      }
      await tx.insert(meetingAttachments).values(linha);
      await tx.insert(auditLogs).values({
        ...quemPediu(prova),
        action: "MEETING_ATTACHMENT_ADDED", resource: "meetings", resourceId: meetingId,
        details: { anexoId: id, tipo: entrada.tipo, bytes: bytes.length },
        status: "success", riskLevel: "low",
      });
    });
  } catch (erro) {
    soltarVaga();
    await tirarObjetoSemPonteiro(chave);
    throw erro;
  }
  return { id, tipo: entrada.tipo, url: linha.storageUrl, mimeType: formato, criadoEm: agora, expiraEm: linha.expiresAt };
}

/** Os anexos que valem da reunião visível da dona, na ordem em que entraram. */
export async function anexosDaDona(ownerId: string, meetingId: string): Promise<AnexoDaDona[]> {
  const db = await exigirDb();
  await exigirReuniaoVisivel(db, ownerId, meetingId);
  const linhas = await db.select({
    id: meetingAttachments.id, kind: meetingAttachments.kind, storageUrl: meetingAttachments.storageUrl, mimeType: meetingAttachments.mimeType,
    createdAt: meetingAttachments.createdAt, expiresAt: meetingAttachments.expiresAt,
  }).from(meetingAttachments)
    .where(and(eq(meetingAttachments.meetingId, meetingId), eq(meetingAttachments.ownerId, ownerId), gt(meetingAttachments.expiresAt, Date.now())))
    .orderBy(asc(meetingAttachments.createdAt), asc(meetingAttachments.id));
  return linhas.map(l => ({ id: l.id, tipo: l.kind, url: l.storageUrl, mimeType: l.mimeType, criadoEm: Number(l.createdAt), expiraEm: Number(l.expiresAt) }));
}

/**
 * Tira um anexo: o objeto sai do bucket com todas as versões e só então a
 * linha, com a auditoria na mesma transação. Se o bucket recusar, a linha
 * vence na hora (some da tela e do link) e a varredura tenta de novo.
 */
export async function apagarAnexo(ownerId: string, meetingId: string, anexoId: string, prova: ProvaDoAnexo): Promise<{ saiuDoBucket: boolean }> {
  const db = await exigirDb();
  await exigirReuniaoVisivel(db, ownerId, meetingId);
  const [anexo] = await db.select({ storageKey: meetingAttachments.storageKey, expiresAt: meetingAttachments.expiresAt }).from(meetingAttachments)
    .where(and(eq(meetingAttachments.id, anexoId), eq(meetingAttachments.meetingId, meetingId), eq(meetingAttachments.ownerId, ownerId))).limit(1);
  if (!anexo || Number(anexo.expiresAt) <= Date.now()) throw naoEncontrado();
  let saiuDoBucket = true;
  try {
    await storageApagarTodasAsVersoes(anexo.storageKey);
  } catch (erro) {
    saiuDoBucket = false;
    console.warn(`[Anexos] a imagem ficou no bucket para a varredura: ${anexo.storageKey}`, erro instanceof Error ? erro.message : erro);
  }
  const doAnexo = and(eq(meetingAttachments.id, anexoId), eq(meetingAttachments.ownerId, ownerId));
  await db.transaction(async tx => {
    if (saiuDoBucket) await tx.delete(meetingAttachments).where(doAnexo);
    else await tx.update(meetingAttachments).set({ expiresAt: Date.now() }).where(doAnexo);
    await tx.insert(auditLogs).values({
      ...quemPediu(prova),
      action: "MEETING_ATTACHMENT_REMOVED", resource: "meetings", resourceId: meetingId,
      details: { anexoId, saiuDoBucket },
      status: "success", riskLevel: "low",
    });
  });
  return { saiuDoBucket };
}

/**
 * Os anexos pelo link aberto: só o id, o tipo e o endereço pela rota do link,
 * que confere a entrada a cada imagem. Nada da chave, da hora nem da dona.
 * Passa por exigirReuniaoDoLink: o link com senha sem a entrada recusa
 * (UNAUTHORIZED), e o desligado, o da lixeira e o da conta inativa são NOT_FOUND.
 */
export async function anexosPeloLink(token: string): Promise<AnexoDoLink[]> {
  const reuniao = await exigirReuniaoDoLink(token);
  const db = await exigirDb();
  const linhas = await db.select({ id: meetingAttachments.id, kind: meetingAttachments.kind }).from(meetingAttachments)
    .where(and(eq(meetingAttachments.meetingId, reuniao.id), eq(meetingAttachments.ownerId, reuniao.ownerId), gt(meetingAttachments.expiresAt, Date.now())))
    .orderBy(asc(meetingAttachments.createdAt), asc(meetingAttachments.id));
  return linhas.map(l => ({ id: l.id, tipo: l.kind, url: enderecoDoAnexoDoLink(token, l.id) }));
}

const FORMATO_DO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chave da imagem que o link entrega agora, ou null (link que não abre, senha sem a entrada, anexo de outra reunião ou vencido). */
export async function chaveDoAnexoDoLink(token: string, anexoId: string): Promise<string | null> {
  if (!FORMATO_DO_ID.test(anexoId)) return null;
  let reuniao: Awaited<ReturnType<typeof exigirReuniaoDoLink>>;
  try {
    reuniao = await exigirReuniaoDoLink(token);
  } catch (erro) {
    if (erro instanceof LinkAbertoRecusado) return null;
    throw erro;
  }
  const db = await exigirDb();
  const [anexo] = await db.select({ storageKey: meetingAttachments.storageKey }).from(meetingAttachments)
    .where(and(
      eq(meetingAttachments.id, anexoId), eq(meetingAttachments.meetingId, reuniao.id), eq(meetingAttachments.ownerId, reuniao.ownerId),
      gt(meetingAttachments.expiresAt, Date.now()),
    )).limit(1);
  return anexo?.storageKey ?? null;
}

/**
 * A rota da imagem do link aberto: 307 para a URL assinada, como a do áudio
 * (registrarRotasDoLinkAberto), com os cookies do pedido no contexto para o
 * link com senha. As dependências entram por parâmetro para o teste da rota.
 */
export function registrarRotaDoAnexoDoLink(
  app: Express,
  { acharChave, assinar, lerLeitora = leitoraDaRota }: {
    acharChave: (token: string, anexoId: string) => Promise<string | null>; assinar: (chave: string) => Promise<string>;
    lerLeitora?: (req: Request, token: string) => Promise<LeitoraDoLink | null>;
  } = { acharChave: chaveDoAnexoDoLink, assinar: storageGetSignedUrl },
) {
  app.get(`${ROTA_DO_ANEXO_DO_LINK}/:token/anexo/:anexoId`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    let chave: string | null;
    try {
      // A participante (R1b) abre a imagem pela sessão dela, com a credencial no endereço.
      const token = String(req.params.token ?? "");
      const leitora = await lerLeitora(req, token);
      chave = await comCookiesDoPedido(req.headers.cookie, () => acharChave(token, String(req.params.anexoId ?? "")), leitora);
    } catch (erro) {
      if (ehErroDeBancoIndisponivel(erro)) {
        console.error(`[Anexos] banco indisponível ao achar a imagem do link: ${descreverErroDeBanco(erro)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      // Sem o objeto do erro: os parâmetros da consulta trazem o token.
      console.error(`[Anexos] a busca da imagem do link falhou: ${descreverErroDeBanco(erro)}`);
      res.status(500).send("Erro ao buscar a imagem");
      return;
    }
    if (!chave) {
      res.status(404).send("Imagem não encontrada");
      return;
    }
    try {
      res.redirect(307, await assinar(chave));
    } catch (erro) {
      console.error(`[Anexos] a URL assinada da imagem falhou: ${descreverErroDeBanco(erro)}`);
      res.status(503).send("Storage não configurado ou indisponível");
    }
  });
}
