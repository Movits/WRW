import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { meetingAudioSlices, meetingTranscriptTranslations, meetingTranscripts, meetings } from "../drizzle/schema";

/**
 * Prova da migração 0014 contra um banco real DE TESTE. No CI é o MariaDB criado
 * do zero por scripts/criar-banco.mjs, com todas as migrações; sem
 * DATABASE_URL_TESTES o teste se pula (server/test/setup-banco.ts já trocou
 * DATABASE_URL por ela, então o .env de trabalho, que pode ser produção, nunca é
 * usado aqui). O que se prova:
 *
 * - a transcrição e a tradução são MEDIUMTEXT: com TEXT (64 KiB), o modo estrito
 *   recusava ("Data too long") a transcrição de uma reunião longa, depois de a
 *   IA já ter sido paga;
 * - 'uploading' é um estado aceito, e as colunas novas de `meetings` nascem com
 *   o padrão certo na linha que não as informa, como as que já existem em
 *   produção;
 * - a mesma parte do áudio (reunião, posição) não entra duas vezes.
 *
 * Dona e reunião com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-texto-longo-${crypto.randomUUID()}`;
const REUNIAO = crypto.randomUUID();
const AGORA = Date.now();

type Banco = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** O código do driver (ER_DUP_ENTRY...) em qualquer ponto da cadeia de `cause`. */
function codigoDoErro(erro: unknown): string | undefined {
  let atual = erro as { code?: unknown; cause?: unknown } | undefined;
  for (let passo = 0; atual && passo < 5; passo++) {
    if (typeof atual.code === "string") return atual.code;
    atual = atual.cause as typeof atual;
  }
  return undefined;
}

const parte = (seq: number) => ({
  id: crypto.randomUUID(),
  meetingId: REUNIAO,
  ownerId: DONA,
  seq,
  storageKey: `meetings/${DONA}/${REUNIAO}/partes/${seq}_teste.mp4`,
  storageUrl: `/manus-storage/meetings/${DONA}/${REUNIAO}/partes/${seq}_teste.mp4`,
  mimeType: "audio/mp4",
  sizeBytes: 1024,
  sha256: "0".repeat(64),
  durationMs: 600_000,
  expiresAt: AGORA + 60_000,
  createdAt: AGORA,
  updatedAt: AGORA,
});

async function limpar(db: Banco) {
  await db.delete(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, DONA));
  await db.delete(meetingTranscriptTranslations).where(eq(meetingTranscriptTranslations.ownerId, DONA));
  await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
  await db.delete(meetings).where(eq(meetings.ownerId, DONA));
}

describe.skipIf(!temBanco)("Reunião longa no banco: MEDIUMTEXT, estado 'uploading' e parte única (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(meetings).values({
      id: REUNIAO, ownerId: DONA, title: "Reunião longa de teste", status: "recording",
      consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) await limpar(db);
  });

  it("a reunião criada sem as colunas novas nasce com os padrões da 0014", async () => {
    const db = (await getDb())!;
    const [linha] = await db.select().from(meetings).where(eq(meetings.id, REUNIAO));
    expect(linha).toMatchObject({
      audioPipeline: "single", origem: null, consentNoticeVersion: null, expectedSlices: null,
      attempts: 0, lockedUntil: null, lockToken: null,
    });
  });

  it("'uploading' é um estado aceito da reunião", async () => {
    const db = (await getDb())!;
    await db.update(meetings).set({ status: "uploading", updatedAt: Date.now() }).where(eq(meetings.id, REUNIAO));
    const [linha] = await db.select({ status: meetings.status }).from(meetings).where(eq(meetings.id, REUNIAO));
    expect(linha.status).toBe("uploading");
  });

  it("guarda inteira uma transcrição de 70 KiB (o TEXT parava em 64 KiB)", async () => {
    const db = (await getDb())!;
    const texto = "palavra ".repeat(70 * 128); // 8 bytes por repetição: 70 KiB
    expect(Buffer.byteLength(texto, "utf8")).toBeGreaterThan(65_535);
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: REUNIAO, ownerId: DONA, transcript: texto,
      language: "pt", createdAt: AGORA, updatedAt: AGORA,
    });
    const [linha] = await db.select({ texto: meetingTranscripts.transcript })
      .from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, REUNIAO));
    expect(linha.texto).toBe(texto);
  });

  it("guarda inteira uma tradução de 150 KiB em russo (2 bytes por letra)", async () => {
    const db = (await getDb())!;
    const texto = "слово ".repeat(14_000); // 11 bytes por repetição
    expect(Buffer.byteLength(texto, "utf8")).toBeGreaterThan(150 * 1024);
    await db.insert(meetingTranscriptTranslations).values({
      id: crypto.randomUUID(), meetingId: REUNIAO, ownerId: DONA, language: "ru",
      translatedText: texto, createdAt: AGORA, updatedAt: AGORA,
    });
    const [linha] = await db.select({ texto: meetingTranscriptTranslations.translatedText })
      .from(meetingTranscriptTranslations).where(eq(meetingTranscriptTranslations.meetingId, REUNIAO));
    expect(linha.texto).toBe(texto);
  });

  it("a parte nasce 'uploading' e sem tentativas, e a mesma posição não entra duas vezes", async () => {
    const db = (await getDb())!;
    await db.insert(meetingAudioSlices).values(parte(0));
    const [primeira] = await db.select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, REUNIAO));
    expect(primeira).toMatchObject({ seq: 0, status: "uploading", attempts: 0, offsetMs: null, lockToken: null });

    let erro: unknown;
    try {
      await db.insert(meetingAudioSlices).values(parte(0));
    } catch (falha) {
      erro = falha;
    }
    expect(codigoDoErro(erro)).toBe("ER_DUP_ENTRY");

    await db.insert(meetingAudioSlices).values(parte(1));
    const partes = await db.select({ seq: meetingAudioSlices.seq }).from(meetingAudioSlices)
      .where(eq(meetingAudioSlices.meetingId, REUNIAO));
    expect(partes.map(linha => linha.seq).sort()).toEqual([0, 1]);
  });
});
