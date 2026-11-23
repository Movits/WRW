import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, eq, gte, isNotNull, ne } from "drizzle-orm";
import { meetings as ar } from "../client/src/i18n/locales/ar.json";
import { meetings as de } from "../client/src/i18n/locales/de.json";
import { meetings as en } from "../client/src/i18n/locales/en.json";
import { meetings as es } from "../client/src/i18n/locales/es.json";
import { meetings as fr } from "../client/src/i18n/locales/fr.json";
import { meetings as hi } from "../client/src/i18n/locales/hi.json";
import { meetings as ja } from "../client/src/i18n/locales/ja.json";
import { meetings as ptBR } from "../client/src/i18n/locales/pt-BR.json";
import { meetings as ru } from "../client/src/i18n/locales/ru.json";
import { meetings as zh } from "../client/src/i18n/locales/zh.json";
import { auditLogs, meetings, resumoEmAudio } from "../drizzle/schema";
import { nomesDosFalantes } from "@shared/const";
import { falasDoResumo, type ItemDaFala, type TraduzirFala } from "@shared/falas-do-resumo";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, idiomaFalado, nomeDoIdiomaEm, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import {
  ACAO_AUDIO_DO_RESUMO_BAIXADO, AUDIOS_DO_RESUMO_POR_DIA, RECUSAS_DO_AUDIO_DO_RESUMO, TEXTO_DO_AUDIO_DO_RESUMO_MAX, VOZ_DO_GEMINI_PADRAO,
} from "@shared/resumo-em-audio";
import { modeloDaVozDoResumo } from "./_core/modelos-de-ia";
import { codificarVozEmMp3, MP3_DO_RESUMO_MAX_BYTES } from "./conversao-do-audio";
import { exigirDb } from "./db";
import { falarComGemini, type FalaDoGemini } from "./gemini";
import { MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { resumoGuardadoDaDona } from "./resumo-guardado";
import { reuniaoVisivel } from "./reuniao-visivel";
import { aplicarTraducao, lerConteudo, oQueFalta } from "./traducao-do-resumo";
import { lerResumoParaTraduzir } from "./traducao-do-resumo-banco";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";

/**
 * "Baixar o áudio do resumo" (H19b; regras em shared/resumo-em-audio.ts): o
 * texto que a voz do aparelho lê (shared/falas-do-resumo.ts), na voz do Gemini,
 * em MP3, guardado no bucket e servido de novo.
 *
 * - Só a dona, da reunião visível (fora da lixeira e não excluída), e só o
 *   resumo que está na tela: o pronto, ou a versão anterior do refazer (H4d).
 *   Os itens ignorados ficam de fora, e os "para conferir" são anunciados como
 *   na voz do aparelho; o complemento pela busca (H4i) entra só confirmado.
 * - No idioma do resumo ou no de uma tradução JÁ pronta (H11): a voz não
 *   traduz nada, e o idioma que ainda não foi traduzido é recusado.
 * - Gera uma vez por texto e idioma: a chave é o hash do modelo, da voz, do
 *   idioma e do texto. O mesmo pedido de novo lê o MP3 do bucket, sem IA e sem
 *   gastar o teto. Texto novo (a dona confirmou, editou, refez) gera de novo, e
 *   o MP3 antigo do mesmo idioma sai do bucket.
 * - Teto: AUDIOS_DO_RESUMO_POR_DIA gerações por dona em 24 h, contadas nas
 *   linhas de resumo_em_audio (a que falhou também). Um pedido igual em curso
 *   espera o primeiro, sem gerar duas vezes.
 * - Cada download grava a auditoria MEETING_SUMMARY_AUDIO_DOWNLOADED (o arquivo
 *   sai da WRW) antes de devolver os bytes: sem a linha, nada sai.
 * - O texto do resumo vai à Google para virar voz (o mesmo provedor do resto da
 *   IA); o MP3 fica no bucket até a reunião ser excluída (meeting-service.ts).
 */

type Traducoes = Record<string, unknown>;
const TEXTOS: Record<IdiomaDaReuniao, Traducoes> = {
  "pt-BR": ptBR, en, es, fr, de, ar, zh, hi, ja, ru,
};

/** O `t` do servidor, com as chaves meetings.* do idioma (e o pt-BR quando falta), com {{nome}} trocado. */
export function traducaoDoServidor(idioma: IdiomaDaReuniao): TraduzirFala {
  const ler = (base: Traducoes, chave: string): string | null => {
    const partes = chave.replace(/^meetings\./, "").split(".");
    let atual: unknown = base;
    for (const parte of partes) {
      if (!atual || typeof atual !== "object" || !Object.prototype.hasOwnProperty.call(atual, parte)) return null;
      atual = (atual as Record<string, unknown>)[parte];
    }
    return typeof atual === "string" ? atual : null;
  };
  return (chave, opcoes = {}) => {
    const molde = ler(TEXTOS[idioma], chave) ?? ler(TEXTOS[IDIOMA_DA_REUNIAO_PADRAO], chave) ?? chave;
    return molde.replace(/\{\{\s*(\w+)\s*\}\}/g, (_inteiro, nome: string) => (nome in opcoes ? String(opcoes[nome]) : ""));
  };
}

const recusa = (code: "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "BAD_REQUEST", codigo: string) =>
  new TRPCError({ code, message: codigo });

export type TextoDoAudio = { texto: string; idioma: string; titulo: string };

/**
 * O texto que a voz lê, no idioma pedido (ou no do resumo). Lança NOT_FOUND
 * para a reunião de outra dona, excluída ou na lixeira; a recusa semResumo sem
 * item à vista; traduzaAntes para o idioma sem tradução pronta.
 */
export async function textoDoAudioDoResumo(ownerId: string, meetingId: string, idiomaPedido?: string | null): Promise<TextoDoAudio> {
  const db = await exigirDb();
  const [reuniao] = await db.select({ title: meetings.title, speakerNames: meetings.speakerNames }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
  if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  const resumo = await resumoGuardadoDaDona(ownerId, meetingId);
  const naTela = resumo.estado === "pronto" || resumo.versaoAnterior;
  const visiveis = naTela ? resumo.itens.filter(item => item.status !== "ignored") : [];
  if (!visiveis.length) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO_DO_RESUMO.semResumo);
  const original = idiomaFalado(resumo.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const pedido = idiomaPedido ? idiomaFalado(idiomaPedido) : original;
  if (!pedido) throw recusa("BAD_REQUEST", RECUSAS_DO_AUDIO_DO_RESUMO.traduzaAntes);

  let itens: Array<(typeof visiveis)[number]> = visiveis;
  if (pedido !== original) {
    const destino = idiomaDaReuniao(pedido);
    if (!destino) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO_DO_RESUMO.traduzaAntes);
    const leitura = await lerResumoParaTraduzir(ownerId, meetingId, destino);
    if (leitura.estado !== "pronto") throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO_DO_RESUMO.traduzaAntes);
    const conteudo = lerConteudo(leitura.guardado);
    // Só a tradução inteira do que está à vista: a voz não lê meio resumo em outra língua.
    const aVista = new Set(visiveis.map(item => item.id));
    if (oQueFalta(leitura.itens.filter(item => aVista.has(item.id)), [], conteudo).itens.length) {
      throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO_DO_RESUMO.traduzaAntes);
    }
    itens = aplicarTraducao(visiveis, conteudo);
  }
  // Os títulos e os rótulos vêm dos 10 idiomas da tela; o idioma fora deles fica com os do padrão (como na voz do aparelho).
  const rotulos = idiomaDaReuniao(pedido) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const t = traducaoDoServidor(rotulos);
  const traduzidoDe = pedido !== original ? nomeDoIdiomaEm(original, rotulos) : null;
  const daFala: ItemDaFala[] = itens.map(item => ({
    section: item.section, status: item.status, subject: item.subject, text: item.text, assignee: item.assignee, due: item.due,
    complemento: item.complemento?.situacao === "confirmed" ? { texto: item.complemento.texto } : null,
  }));
  const texto = falasDoResumo(t, daFala, nomesDosFalantes(reuniao.speakerNames), traduzidoDe).join("\n");
  if (texto.length > TEXTO_DO_AUDIO_DO_RESUMO_MAX) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO_DO_RESUMO.longo);
  return { texto, idioma: pedido, titulo: reuniao.title };
}

/** Os pedaços do texto que vão, um por chamada, à voz do Gemini: por linha, até `limite` caracteres. */
export function pedacosDoTexto(texto: string, limite = 3_000): string[] {
  const pedacos: string[] = [];
  let atual = "";
  for (const linha of texto.split("\n")) {
    if (!linha.trim()) continue;
    for (let de = 0; de < linha.length; de += limite) {
      const parte = linha.slice(de, de + limite);
      if (atual && atual.length + 1 + parte.length > limite) {
        pedacos.push(atual);
        atual = parte;
      } else {
        atual = atual ? `${atual}\n${parte}` : parte;
      }
    }
  }
  if (atual) pedacos.push(atual);
  return pedacos;
}

/** A chave do cache: o mesmo modelo, a mesma voz, o mesmo idioma e o mesmo texto. */
export function hashDoAudio(modelo: string, voz: string, idioma: string, texto: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([modelo, voz, idioma, texto])).digest("hex");
}

export type DependenciasDoAudioDoResumo = {
  falar: (texto: string, modelo: string, voz: string) => Promise<FalaDoGemini>;
  codificar: (pcm: Buffer, amostrasPorSegundo: number) => Promise<Buffer>;
  guardar: (chave: string, mp3: Buffer) => Promise<string>;
  ler: (chave: string) => Promise<Buffer>;
  apagar: (chave: string) => Promise<void>;
  ffmpegDisponivel: () => Promise<boolean>;
};

export async function dependenciasPadrao(): Promise<DependenciasDoAudioDoResumo> {
  const bucket = await import("./storage");
  const { ffmpegDisponivel } = await import("./baixar-audio-da-reuniao");
  return {
    falar: falarComGemini,
    codificar: (pcm, taxa) => codificarVozEmMp3(pcm, taxa),
    guardar: async (chave, mp3) => (await bucket.storagePut(chave, mp3, "audio/mpeg", { cacheControl: bucket.CACHE_DE_ARQUIVO_PRIVADO })).key,
    ler: chave => bucket.storageGetBytes(chave, MP3_DO_RESUMO_MAX_BYTES),
    apagar: chave => bucket.storageApagarTodasAsVersoes(chave),
    ffmpegDisponivel,
  };
}

export type PedidoDoAudioDoResumo = { userId: number; ipAddress: string; userAgent: string | undefined };
export type AudioDoResumo = { mp3Base64: string; idioma: string; titulo: string; reaproveitado: boolean };

const emCurso = new Map<string, Promise<{ chave: string; bytes: Buffer; reaproveitado: boolean }>>();
const DIA_MS = 24 * 60 * 60_000;

async function gerarOuReaproveitar(ownerId: string, meetingId: string, texto: TextoDoAudio, deps: DependenciasDoAudioDoResumo) {
  const db = await exigirDb();
  const modelo = modeloDaVozDoResumo();
  const voz = VOZ_DO_GEMINI_PADRAO;
  const hash = hashDoAudio(modelo, voz, texto.idioma, texto.texto);
  const [guardado] = await db.select({ id: resumoEmAudio.id, chave: resumoEmAudio.storageKey }).from(resumoEmAudio)
    .where(and(eq(resumoEmAudio.ownerId, ownerId), eq(resumoEmAudio.meetingId, meetingId), eq(resumoEmAudio.language, texto.idioma),
      eq(resumoEmAudio.textHash, hash), eq(resumoEmAudio.situacao, "pronto"), isNotNull(resumoEmAudio.storageKey))).limit(1);
  if (guardado?.chave) {
    try {
      return { chave: guardado.chave, bytes: await deps.ler(guardado.chave), reaproveitado: true };
    } catch (erro) {
      // O objeto sumiu do bucket (ou não se lê): a linha perde a chave e gera de novo.
      console.warn(`[Áudio do resumo] o MP3 guardado não foi lido; gerando de novo: ${guardado.chave}`, erro instanceof Error ? erro.message : erro);
      await db.update(resumoEmAudio).set({ storageKey: null, updatedAt: Date.now() }).where(and(eq(resumoEmAudio.id, guardado.id), eq(resumoEmAudio.ownerId, ownerId)));
    }
  }

  if (!(await deps.ffmpegDisponivel())) throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_AUDIO_DO_RESUMO.indisponivel);
  const agora = Date.now();
  const [usados] = await db.select({ n: count() }).from(resumoEmAudio)
    .where(and(eq(resumoEmAudio.ownerId, ownerId), gte(resumoEmAudio.createdAt, agora - DIA_MS)));
  if (Number(usados?.n ?? 0) >= AUDIOS_DO_RESUMO_POR_DIA) throw recusa("TOO_MANY_REQUESTS", RECUSAS_DO_AUDIO_DO_RESUMO.demais);
  const id = crypto.randomUUID();
  await db.insert(resumoEmAudio).values({
    id, ownerId, meetingId, language: texto.idioma, textHash: hash, situacao: "pendente", modelo, createdAt: agora, updatedAt: agora,
  });

  let mp3: Buffer;
  try {
    const falas: FalaDoGemini[] = [];
    for (const pedaco of pedacosDoTexto(texto.texto)) falas.push(await deps.falar(pedaco, modelo, voz));
    const taxa = falas[0]?.amostrasPorSegundo ?? 24_000;
    if (falas.some(fala => fala.amostrasPorSegundo !== taxa)) throw new Error("A voz do Gemini mudou de taxa entre os pedaços.");
    mp3 = await deps.codificar(Buffer.concat(falas.map(fala => fala.pcm)), taxa);
  } catch (erro) {
    await db.update(resumoEmAudio).set({ situacao: "falhou", updatedAt: Date.now() }).where(and(eq(resumoEmAudio.id, id), eq(resumoEmAudio.ownerId, ownerId)));
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    console.warn("[Áudio do resumo] a voz do Gemini ou o ffmpeg falhou:", erro instanceof Error ? erro.message : erro);
    throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_AUDIO_DO_RESUMO.ia);
  }

  let chave: string;
  try {
    chave = await deps.guardar(`meetings/${ownerId}/resumo-em-audio/${meetingId}-${texto.idioma}.mp3`, mp3);
  } catch (erro) {
    await db.update(resumoEmAudio).set({ situacao: "falhou", updatedAt: Date.now() }).where(and(eq(resumoEmAudio.id, id), eq(resumoEmAudio.ownerId, ownerId)));
    console.warn("[Áudio do resumo] o bucket recusou o MP3:", erro instanceof Error ? erro.message : erro);
    throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_AUDIO_DO_RESUMO.indisponivel);
  }
  await db.update(resumoEmAudio).set({ situacao: "pronto", storageKey: chave, bytes: mp3.length, durationMs: null, updatedAt: Date.now() })
    .where(and(eq(resumoEmAudio.id, id), eq(resumoEmAudio.ownerId, ownerId)));

  // A reunião saiu (lixeira ou exclusão) enquanto a voz era gerada: o MP3 novo sai também.
  const [aindaVisivel] = await db.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), reuniaoVisivel())).limit(1);
  if (!aindaVisivel) {
    await tirarDoBucket(ownerId, [{ id, chave }], deps);
    throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
  }
  // O MP3 de um texto antigo, no mesmo idioma, sai do bucket: só o de agora fica.
  const antigos = await db.select({ id: resumoEmAudio.id, chave: resumoEmAudio.storageKey }).from(resumoEmAudio)
    .where(and(eq(resumoEmAudio.ownerId, ownerId), eq(resumoEmAudio.meetingId, meetingId), eq(resumoEmAudio.language, texto.idioma),
      ne(resumoEmAudio.id, id), isNotNull(resumoEmAudio.storageKey)));
  await tirarDoBucket(ownerId, antigos.filter((linha): linha is { id: string; chave: string } => !!linha.chave), deps);
  return { chave, bytes: mp3, reaproveitado: false };
}

/**
 * Tira os MP3 do bucket e apaga a chave da linha (a linha fica para o teto). O
 * que o bucket recusar fica com a chave, e a próxima geração do mesmo idioma
 * (ou a exclusão da reunião) tenta de novo.
 */
export async function tirarDoBucket(ownerId: string, linhas: Array<{ id: string; chave: string }>, deps: Pick<DependenciasDoAudioDoResumo, "apagar">) {
  const db = await exigirDb();
  for (const linha of linhas) {
    try {
      await deps.apagar(linha.chave);
    } catch (erro) {
      console.warn(`[Áudio do resumo] o MP3 ficou no bucket: ${linha.chave}`, erro instanceof Error ? erro.message : erro);
      continue;
    }
    await db.update(resumoEmAudio).set({ storageKey: null, updatedAt: Date.now() }).where(and(eq(resumoEmAudio.id, linha.id), eq(resumoEmAudio.ownerId, ownerId)));
  }
}

/**
 * O MP3 do resumo para a dona baixar: o guardado, se o texto não mudou; senão,
 * gerado agora (dentro do teto). Grava a auditoria antes de devolver.
 */
export async function audioDoResumoDaDona(
  ownerId: string, meetingId: string, idioma: string | null | undefined, pedido: PedidoDoAudioDoResumo,
  deps?: DependenciasDoAudioDoResumo,
): Promise<AudioDoResumo> {
  const texto = await textoDoAudioDoResumo(ownerId, meetingId, idioma);
  const usar = deps ?? await dependenciasPadrao();
  const chaveDoPedido = `${ownerId}\n${meetingId}\n${texto.idioma}\n${hashDoAudio("", "", texto.idioma, texto.texto)}`;
  let promessa = emCurso.get(chaveDoPedido);
  if (!promessa) {
    promessa = gerarOuReaproveitar(ownerId, meetingId, texto, usar).finally(() => emCurso.delete(chaveDoPedido));
    emCurso.set(chaveDoPedido, promessa);
  }
  const { bytes, reaproveitado } = await promessa;
  const db = await exigirDb();
  // Sem a linha da auditoria, nada sai: o insert lança e a resposta é o erro.
  await db.insert(auditLogs).values({
    userId: pedido.userId, action: ACAO_AUDIO_DO_RESUMO_BAIXADO, resource: "meetings", resourceId: meetingId,
    details: { idioma: texto.idioma, bytes: bytes.length, reaproveitado, caracteres: texto.texto.length },
    ipAddress: pedido.ipAddress, userAgent: pedido.userAgent ?? null, status: "success", riskLevel: "low",
  });
  return { mp3Base64: bytes.toString("base64"), idioma: texto.idioma, titulo: texto.titulo, reaproveitado };
}

/** Só para os testes: o mapa dos pedidos em curso é estado de módulo. */
export function esquecerPedidosEmCurso() {
  emCurso.clear();
}
