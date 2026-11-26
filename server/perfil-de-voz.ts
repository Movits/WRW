import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  DURACAO_MAXIMA_DA_AMOSTRA_MS, DURACAO_MINIMA_DA_AMOSTRA_MS, GRAVACOES_DA_AMOSTRA_POR_JANELA, HASHES_DO_TEXTO_DO_PERFIL_DE_VOZ, JANELA_DA_AMOSTRA_MS,
  PREFIXO_DO_PERFIL_DE_VOZ, RECUSAS_DO_PERFIL_DE_VOZ, TAMANHO_MAXIMO_DA_AMOSTRA, TEXTO_DO_CONSENTIMENTO_DE_VOZ_MAX,
  TIPOS_DA_AMOSTRA, VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ, type TipoDaAmostra, type VersaoDoTextoDoPerfilDeVoz,
} from "@shared/perfil-de-voz";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { users, voiceProfileConsents, voiceProfiles } from "../drizzle/schema";
import { exigirDb } from "./db";
import { ObjetoAusenteNoStorageError, storageApagarTodasAsVersoes, storageGetBytes, storagePut } from "./storage";

/**
 * O perfil de voz da dona (H3d do desenho de 16/11; HN-24 da auditoria,
 * aprovado pelo Roberto em 24/11/2026; regra em shared/perfil-de-voz.ts).
 *
 * A dona grava cerca de 30 s da própria voz, lendo o texto da tela. A amostra
 * fica no bucket, sob perfis-de-voz/<openId>/ (prefixo que o proxy
 * /manus-storage nega a todo mundo), e vai junto no pedido de transcrição de
 * cada parte das reuniões dela (server/fila-de-transcricao.ts), para a IA dar
 * à voz dela o rótulo fixo, que a montagem liga à conta dela (H3c). Nada daqui
 * entra sozinho: a dona corrige no "Quem é cada voz" como já corrige hoje.
 *
 * É dado biométrico (LGPD art. 11). Os pontos técnicos da Cris (25/11/2026):
 * - o consentimento é próprio e separado do aceite dos Termos: a primeira
 *   gravação só passa com a caixa marcada (a versão do texto, o idioma e o texto
 *   exibido vão junto), e o registro (voice_profile_consents) guarda a data, a
 *   hora, a versão e o texto de cada consentimento e de cada revogação, sem a
 *   voz, e sobrevive à exclusão do perfil;
 * - a exclusão é DEFINITIVA: desligar apaga o objeto do bucket com todas as
 *   versões (o B2 guarda versões; o DELETE simples só esconderia a voz) e a
 *   linha do perfil, na mesma transação que grava a revogação. Se o bucket não
 *   confirmar, nada muda e a dona tenta de novo. Regravar troca o objeto do
 *   mesmo jeito: o antigo sai com todas as versões antes de a troca valer.
 *   A exclusão da conta (server/exclusao-de-conta.ts) faz o mesmo.
 *
 * Só a dona lê e muda o próprio perfil: toda consulta tem o owner_id no WHERE,
 * e nenhum procedimento recebe o id de outra conta. Banco fora do ar sobe como
 * erro (o middleware do tRPC o traduz); nunca vira "sem perfil".
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** O que a dona vê do próprio perfil: nunca a chave do bucket. */
export type EstadoDoPerfilDeVoz =
  | { ativo: false }
  | { ativo: true; duracaoMs: number; criadoEm: number; atualizadoEm: number };

/** A palavra da dona ao marcar a caixa, como vai para o registro. */
export type ConsentimentoDoPerfilDeVoz = {
  versaoDoTexto: string;
  /** O idioma da tela em que o texto foi mostrado. */
  idioma: string;
  /** A caixa e o texto de apoio, como apareceram na tela. */
  textoExibido: string;
};

export type QuemPede = { ipAddress: string; userAgent: string | undefined };

const recusa = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });

// ─── O teto de gravações (em memória, como os tetos dos routers) ────────────
const gravacoesPorDona = new Map<string, number[]>();

/** Conta uma gravação aceita; lança DEMAIS acima do teto. Exportada para o teste zerar. */
export function contarGravacaoDaAmostra(ownerId: string, agora = Date.now()) {
  const recentes = (gravacoesPorDona.get(ownerId) ?? []).filter(quando => agora - quando < JANELA_DA_AMOSTRA_MS);
  if (recentes.length >= GRAVACOES_DA_AMOSTRA_POR_JANELA) {
    gravacoesPorDona.set(ownerId, recentes);
    throw recusa("TOO_MANY_REQUESTS", RECUSAS_DO_PERFIL_DE_VOZ.demais);
  }
  recentes.push(agora);
  gravacoesPorDona.set(ownerId, recentes);
}

export function zerarTetoDaAmostraParaTestes() {
  gravacoesPorDona.clear();
}

// ─── A amostra: tipo, tamanho, duração e conteúdo ───────────────────────────

/**
 * O conteúdo confere com o tipo declarado? Pelos primeiros bytes de cada
 * formato que o gravador do navegador entrega: webm (EBML), ogg ("OggS"), wav
 * ("RIFF"..."WAVE") e mp4 ("ftyp" no byte 4). Um arquivo qualquer com o tipo
 * de áudio não entra no bucket nem vai ao Gemini.
 */
export function conteudoConfereComOTipo(bytes: Buffer, tipo: TipoDaAmostra): boolean {
  if (bytes.length < 12) return false;
  switch (tipo) {
    case "audio/webm": return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "audio/ogg": return bytes.subarray(0, 4).toString("latin1") === "OggS";
    case "audio/wav": return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE";
    case "audio/mp4": return bytes.subarray(4, 8).toString("latin1") === "ftyp";
  }
}

const EXTENSAO: Record<TipoDaAmostra, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mp4": "m4a" };

/**
 * A amostra que a tela mandou, decodificada e conferida. O base64 pode vir com
 * o cabeçalho do FileReader ("data:audio/webm;codecs=opus;base64,"), como no
 * envio da reunião (decodeMeetingAudio, em server/meeting-service.ts).
 */
export function decodificarAmostra(input: { audioBase64: string; mimeType: string; duracaoMs: number }): { bytes: Buffer; tipo: TipoDaAmostra; duracaoMs: number } {
  const invalida = () => recusa("BAD_REQUEST", RECUSAS_DO_PERFIL_DE_VOZ.amostraInvalida);
  if (!(TIPOS_DA_AMOSTRA as readonly string[]).includes(input.mimeType)) throw invalida();
  const tipo = input.mimeType as TipoDaAmostra;
  if (!Number.isFinite(input.duracaoMs) || input.duracaoMs < DURACAO_MINIMA_DA_AMOSTRA_MS || input.duracaoMs > DURACAO_MAXIMA_DA_AMOSTRA_MS + 1_000) throw invalida();
  const limpo = input.audioBase64.trim().replace(/^data:.*?;base64,/i, "").replace(/\s/g, "");
  // O teto antes de decodificar: 4 letras de base64 por 3 bytes.
  if (!limpo || limpo.length > Math.ceil(TAMANHO_MAXIMO_DA_AMOSTRA / 3) * 4 || !/^[A-Za-z0-9+/=]+$/.test(limpo)) throw invalida();
  const bytes = Buffer.from(limpo, "base64");
  if (!bytes.length || bytes.length > TAMANHO_MAXIMO_DA_AMOSTRA || !conteudoConfereComOTipo(bytes, tipo)) throw invalida();
  return { bytes, tipo, duracaoMs: Math.min(Math.round(input.duracaoMs), DURACAO_MAXIMA_DA_AMOSTRA_MS) };
}

const sha256 = (texto: string) => crypto.createHash("sha256").update(texto).digest("hex");

/**
 * O consentimento que a tela mandou serve? A versão tem de ser uma que o
 * servidor conhece, e o texto exibido tem de ser o daquela versão no idioma
 * informado (HASHES_DO_TEXTO_DO_PERFIL_DE_VOZ): o registro só guarda o texto
 * que a Cris aprovou, nunca um que a requisição inventou.
 */
export function consentimentoValido(consentimento: ConsentimentoDoPerfilDeVoz | undefined): consentimento is ConsentimentoDoPerfilDeVoz & { versaoDoTexto: VersaoDoTextoDoPerfilDeVoz } {
  if (!consentimento) return false;
  if (!(VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ as readonly string[]).includes(consentimento.versaoDoTexto)) return false;
  if (!consentimento.textoExibido.trim() || consentimento.textoExibido.length > TEXTO_DO_CONSENTIMENTO_DE_VOZ_MAX) return false;
  const esperado = HASHES_DO_TEXTO_DO_PERFIL_DE_VOZ[consentimento.versaoDoTexto as VersaoDoTextoDoPerfilDeVoz];
  return Object.hasOwn(esperado, consentimento.idioma) && esperado[consentimento.idioma] === sha256(consentimento.textoExibido);
}

/** A linha do registro de um consentimento ou de uma revogação. */
function linhaDoRegistro(ownerId: string, evento: "consentiu" | "revogou", origem: "dona" | "exclusao_da_conta", dados: {
  versaoDoTexto: string; idioma?: string | null; textoExibido?: string | null; quem?: QuemPede; agora: number;
}) {
  const texto = dados.textoExibido ?? null;
  return {
    id: crypto.randomUUID(),
    ownerId,
    evento,
    origem,
    versaoDoTexto: dados.versaoDoTexto.slice(0, 40),
    idioma: dados.idioma ? dados.idioma.slice(0, 12) : null,
    textoExibido: texto,
    textoHash: texto ? sha256(texto) : null,
    // Os mesmos cortes do createAuditLog (server/security.ts).
    ipAddress: dados.quem ? dados.quem.ipAddress.substring(0, 45) : null,
    userAgent: dados.quem?.userAgent ? dados.quem.userAgent.substring(0, 500) : null,
    createdAt: dados.agora,
  };
}

/** A versão do texto que a dona aceitou por último (a revogação registra a mesma). */
async function versaoDoUltimoConsentimento(ex: Pick<Banco, "select">, ownerId: string): Promise<string> {
  const [ultimo] = await ex.select({ versao: voiceProfileConsents.versaoDoTexto }).from(voiceProfileConsents)
    .where(and(eq(voiceProfileConsents.ownerId, ownerId), eq(voiceProfileConsents.evento, "consentiu")))
    .orderBy(desc(voiceProfileConsents.createdAt)).limit(1);
  return ultimo?.versao ?? "desconhecida";
}

// ─── Os procedimentos da dona ────────────────────────────────────────────────

export async function estadoDoPerfilDeVoz(ownerId: string): Promise<EstadoDoPerfilDeVoz> {
  const db = await exigirDb();
  const [perfil] = await db.select({ duracaoMs: voiceProfiles.durationMs, criadoEm: voiceProfiles.createdAt, atualizadoEm: voiceProfiles.updatedAt })
    .from(voiceProfiles).where(eq(voiceProfiles.ownerId, ownerId)).limit(1);
  return perfil ? { ativo: true, ...perfil } : { ativo: false };
}

/** As dependências do bucket, injetáveis para o teste. */
export type BucketDoPerfil = {
  guardar: (chave: string, bytes: Buffer, tipo: string) => Promise<void>;
  apagar: (chave: string) => Promise<void>;
  ler: (chave: string) => Promise<Buffer>;
};

const BUCKET_REAL: BucketDoPerfil = {
  guardar: async (chave, bytes, tipo) => { await storagePut(chave, bytes, tipo, { chaveExata: true }); },
  apagar: chave => storageApagarTodasAsVersoes(chave),
  ler: chave => storageGetBytes(chave, TAMANHO_MAXIMO_DA_AMOSTRA),
};

/** A chave nova de uma amostra da dona: o openId no caminho prova a posse (a exclusão da conta confere). */
export function chaveDaAmostra(ownerId: string, tipo: TipoDaAmostra): string {
  return `${PREFIXO_DO_PERFIL_DE_VOZ}/${ownerId}/${crypto.randomUUID()}.${EXTENSAO[tipo]}`;
}

/**
 * Grava (ou regrava) a amostra. Sem perfil, exige o consentimento válido e o
 * registra na mesma transação que cria o perfil. Com perfil, regravar não pede
 * a caixa de novo (o consentimento segue de pé), e a amostra antiga sai do
 * bucket com todas as versões ANTES de a troca valer: se o bucket não
 * confirmar, a transação desfaz e o perfil fica com a antiga.
 *
 * Ordem: a amostra nova sobe primeiro (fora da transação); a transação trava a
 * conta e a linha da dona, confere o consentimento, apaga a antiga e grava.
 * Qualquer falha depois do upload tira a nova do bucket (melhor esforço).
 *
 * A conta travada (FOR UPDATE) fecha a corrida com a exclusão da conta: sem a
 * linha de users, nada nasce; com ela travada, o DELETE da conta espera o
 * commit, e o perfil que nascer depois de a exclusão ler as chaves fica para a
 * varredura (regra 7 de server/exclusao-de-conta.ts), que o acha sem a conta.
 *
 * A antiga sai do bucket DENTRO da transação, antes do commit, de propósito
 * (regra da Cris): sai depois, com o bucket recusando, e a voz antiga ficaria
 * no bucket sem ponteiro. O custo é o commit que falhar depois disso deixar a
 * linha apontando para um objeto que já saiu: a dona vê o perfil ligado, o
 * "ouvir" dá SEM_PERFIL e a fila segue sem a amostra (amostraDaVozDaDona) até
 * ela regravar ou desligar.
 */
export async function gravarPerfilDeVoz(
  ownerId: string,
  input: { audioBase64: string; mimeType: string; duracaoMs: number; consentimento?: ConsentimentoDoPerfilDeVoz },
  quem: QuemPede,
  bucket: BucketDoPerfil = BUCKET_REAL,
): Promise<EstadoDoPerfilDeVoz> {
  const amostra = decodificarAmostra(input);
  const db = await exigirDb();
  // Sem perfil e sem a caixa: recusa antes de gastar o bucket e o teto.
  const [existente] = await db.select({ id: voiceProfiles.id }).from(voiceProfiles).where(eq(voiceProfiles.ownerId, ownerId)).limit(1);
  if (!existente && !consentimentoValido(input.consentimento)) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido);
  contarGravacaoDaAmostra(ownerId);

  const chave = chaveDaAmostra(ownerId, amostra.tipo);
  try {
    await bucket.guardar(chave, amostra.bytes, amostra.tipo);
  } catch (erro) {
    console.error("[PerfilDeVoz] o bucket recusou guardar a amostra:", erro instanceof Error ? erro.message : erro);
    throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_PERFIL_DE_VOZ.bucket);
  }
  const agora = Date.now();
  try {
    await db.transaction(async tx => {
      // A conta que pede ainda existe? (a exclusão da conta pode ter passado no meio)
      const [conta] = await tx.select({ id: users.id }).from(users).where(eq(users.openId, ownerId)).limit(1).for("update");
      if (!conta) throw recusa("UNAUTHORIZED", UNAUTHED_ERR_MSG);
      const [atual] = await tx.select({ id: voiceProfiles.id, chave: voiceProfiles.storageKey }).from(voiceProfiles)
        .where(eq(voiceProfiles.ownerId, ownerId)).limit(1).for("update");
      if (atual) {
        await tx.update(voiceProfiles).set({ storageKey: chave, mimeType: amostra.tipo, bytes: amostra.bytes.length, durationMs: amostra.duracaoMs, updatedAt: agora })
          .where(and(eq(voiceProfiles.id, atual.id), eq(voiceProfiles.ownerId, ownerId)));
        await apagarDoBucket(bucket, atual.chave);
        return;
      }
      // O perfil saiu entre a primeira leitura e aqui (outra aba desligou):
      // sem a caixa, não nasce de novo.
      if (!consentimentoValido(input.consentimento)) throw recusa("PRECONDITION_FAILED", RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido);
      await tx.insert(voiceProfiles).values({
        id: crypto.randomUUID(), ownerId, storageKey: chave, mimeType: amostra.tipo, bytes: amostra.bytes.length, durationMs: amostra.duracaoMs,
        createdAt: agora, updatedAt: agora,
      });
      await tx.insert(voiceProfileConsents).values(linhaDoRegistro(ownerId, "consentiu", "dona", { ...input.consentimento, quem, agora }));
    });
  } catch (erro) {
    try {
      await bucket.apagar(chave);
    } catch (erroDoBucket) {
      console.error(`[PerfilDeVoz] a amostra nova ficou no bucket depois de uma falha; precisa de remoção manual: ${chave}`, erroDoBucket instanceof Error ? erroDoBucket.message : erroDoBucket);
    }
    throw erro;
  }
  return estadoDoPerfilDeVoz(ownerId);
}

/** Apaga a amostra com todas as versões; a recusa do bucket vira o código que a tela traduz (e a transação desfaz). */
async function apagarDoBucket(bucket: BucketDoPerfil, chave: string) {
  try {
    await bucket.apagar(chave);
  } catch (erro) {
    console.error("[PerfilDeVoz] o bucket recusou apagar a amostra; nada mudou:", erro instanceof Error ? erro.message : erro);
    throw recusa("INTERNAL_SERVER_ERROR", RECUSAS_DO_PERFIL_DE_VOZ.bucket);
  }
}

/**
 * Desliga o perfil: a amostra sai do bucket com todas as versões, a linha sai
 * e a revogação fica registrada, tudo na transação com a linha travada. Se o
 * bucket recusar, a transação desfaz e o perfil continua (a dona tenta de
 * novo). Sem perfil: SEM_PERFIL.
 */
export async function desligarPerfilDeVoz(ownerId: string, quem: QuemPede, bucket: BucketDoPerfil = BUCKET_REAL): Promise<EstadoDoPerfilDeVoz> {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [atual] = await tx.select({ id: voiceProfiles.id, chave: voiceProfiles.storageKey }).from(voiceProfiles)
      .where(eq(voiceProfiles.ownerId, ownerId)).limit(1).for("update");
    if (!atual) throw recusa("NOT_FOUND", RECUSAS_DO_PERFIL_DE_VOZ.semPerfil);
    const agora = Date.now();
    await tx.delete(voiceProfiles).where(and(eq(voiceProfiles.id, atual.id), eq(voiceProfiles.ownerId, ownerId)));
    await tx.insert(voiceProfileConsents).values(linhaDoRegistro(ownerId, "revogou", "dona", { versaoDoTexto: await versaoDoUltimoConsentimento(tx, ownerId), quem, agora }));
    await apagarDoBucket(bucket, atual.chave);
  });
  return { ativo: false };
}

/** A amostra para a dona ouvir: só ela, pelo próprio openId. O objeto que sumiu do bucket é SEM_PERFIL (a dona regrava). */
export async function ouvirPerfilDeVoz(ownerId: string, bucket: BucketDoPerfil = BUCKET_REAL): Promise<{ audioBase64: string; mimeType: string }> {
  const db = await exigirDb();
  const [perfil] = await db.select({ chave: voiceProfiles.storageKey, mimeType: voiceProfiles.mimeType }).from(voiceProfiles)
    .where(eq(voiceProfiles.ownerId, ownerId)).limit(1);
  if (!perfil) throw recusa("NOT_FOUND", RECUSAS_DO_PERFIL_DE_VOZ.semPerfil);
  try {
    const bytes = await bucket.ler(perfil.chave);
    return { audioBase64: bytes.toString("base64"), mimeType: perfil.mimeType };
  } catch (erro) {
    if (erro instanceof ObjetoAusenteNoStorageError) throw recusa("NOT_FOUND", RECUSAS_DO_PERFIL_DE_VOZ.semPerfil);
    throw erro;
  }
}

// ─── A fila de transcrição ──────────────────────────────────────────────────

/**
 * A amostra da dona para a transcrição de uma parte (server/fila-de-transcricao.ts),
 * ou null sem perfil. O objeto que sumiu do bucket também é null (a parte
 * segue sem a amostra, com aviso no log); o bucket fora do ar sobe como erro,
 * e a parte tenta de novo, como na leitura do próprio áudio dela.
 */
export async function amostraDaVozDaDona(db: Pick<Banco, "select">, ownerId: string, bucket: Pick<BucketDoPerfil, "ler"> = BUCKET_REAL): Promise<{ audio: Buffer; mimeType: string } | null> {
  const [perfil] = await db.select({ chave: voiceProfiles.storageKey, mimeType: voiceProfiles.mimeType }).from(voiceProfiles)
    .where(eq(voiceProfiles.ownerId, ownerId)).limit(1);
  if (!perfil) return null;
  try {
    return { audio: await bucket.ler(perfil.chave), mimeType: perfil.mimeType };
  } catch (erro) {
    if (!(erro instanceof ObjetoAusenteNoStorageError)) throw erro;
    console.warn("[PerfilDeVoz] a amostra da dona não está no bucket; a parte segue sem ela");
    return null;
  }
}

// ─── A exclusão da conta ─────────────────────────────────────────────────────

/**
 * A revogação que a exclusão da conta registra antes de o perfil sair
 * (server/exclusao-de-conta.ts): a mesma linha do desligar, com a origem
 * "exclusao_da_conta". Sem perfil, nada. Idempotente: se o último evento da
 * dona já é uma revogação (a exclusão caiu entre este registro e o DELETE do
 * perfil, e ela pediu de novo; ou o perfil ficou como ponteiro), não grava outra.
 */
export async function registrarRevogacaoNaExclusao(db: Pick<Banco, "select" | "insert">, ownerId: string): Promise<boolean> {
  const [perfil] = await db.select({ id: voiceProfiles.id }).from(voiceProfiles).where(eq(voiceProfiles.ownerId, ownerId)).limit(1);
  if (!perfil) return false;
  // Pela hora, e não pela ordem: o consentimento e a revogação podem cair no mesmo milissegundo.
  const ultimaHora = async (evento: "consentiu" | "revogou") => {
    const [linha] = await db.select({ quando: voiceProfileConsents.createdAt }).from(voiceProfileConsents)
      .where(and(eq(voiceProfileConsents.ownerId, ownerId), eq(voiceProfileConsents.evento, evento)))
      .orderBy(desc(voiceProfileConsents.createdAt)).limit(1);
    return linha?.quando;
  };
  const revogou = await ultimaHora("revogou");
  if (revogou !== undefined && revogou >= ((await ultimaHora("consentiu")) ?? 0)) return false;
  await db.insert(voiceProfileConsents).values(linhaDoRegistro(ownerId, "revogou", "exclusao_da_conta", {
    versaoDoTexto: await versaoDoUltimoConsentimento(db, ownerId), agora: Date.now(),
  }));
  return true;
}
