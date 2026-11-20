import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, meetingAudioSlices, meetingRecordings, meetings, users } from "../drizzle/schema";
import { prepararAudioDaReuniao } from "./baixar-audio-da-reuniao";
import { ACAO_AUDIO_BAIXADO, RECUSAS_DO_AUDIO } from "@shared/baixar-audio";
import { MEETING_AUDIO_TTL_MS } from "./meeting-service";

/**
 * Baixar o áudio da reunião (H8c) contra um banco real DE TESTE. No CI é o
 * MariaDB criado do zero por scripts/criar-banco.mjs; sem DATABASE_URL_TESTES o
 * teste se pula (server/test/setup-banco.ts troca a DATABASE_URL por ela). As
 * regras estão no WHERE, e só o banco de verdade as prova:
 *
 * - só a dona: outra conta, reunião excluída e reunião que não existe levam
 *   NOT_FOUND, e nada é gravado em nome de ninguém;
 * - as partes saem na ordem de seq, só as que tocam, no tempo do player, e as
 *   chaves vêm da linha da própria reunião;
 * - a gravação que ainda chega, o áudio vencido e o que não existe são
 *   recusados com o código, sem auditoria;
 * - cada preparação aceita grava UMA linha MEETING_AUDIO_DOWNLOADED.
 *
 * Que a falha da auditoria desfaz tudo está em baixar-audio-da-reuniao.test.ts
 * (a transação dublada mostra o insert dentro dela e o rollback).
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-baixar-audio-${crypto.randomUUID()}`;
const OUTRA = `teste-baixar-audio-${crypto.randomUUID()}`;
const EM_PARTES = crypto.randomUUID();
const ENVIO_UNICO = crypto.randomUUID();
const GRAVANDO = crypto.randomUUID();
const VENCIDA = crypto.randomUUID();
const EXCLUIDA = crypto.randomUUID();
const SEM_AUDIO_ANTIGA = crypto.randomUUID();
const AGORA = Date.now();
const DIA = 24 * 60 * 60 * 1000;
const CONTA = 2_100_000_000 + Math.floor(Math.random() * 40_000_000);
const PEDIDO = { formato: "mp3" as const, userId: CONTA, ipAddress: "203.0.113.8", userAgent: "vitest-baixar-audio" };

const reuniao = (id: string, extra: Partial<typeof meetings.$inferInsert> = {}) => ({
  id, ownerId: DONA, title: "Reunião com a importadora", status: "ready" as const, language: "pt",
  consentGranted: true, consentAt: AGORA, createdAt: AGORA - 3 * DIA, updatedAt: AGORA, ...extra,
});
const parte = (meetingId: string, seq: number, extra: Partial<typeof meetingAudioSlices.$inferInsert> = {}) => {
  const id = crypto.randomUUID();
  const chave = `meetings/${DONA}/${meetingId}/partes/${String(seq).padStart(4, "0")}-${id.slice(0, 8)}.webm`;
  return {
    id, meetingId, ownerId: DONA, seq, status: "transcribed" as const, storageKey: chave, storageUrl: `/manus-storage/${chave}`,
    mimeType: "audio/webm", sizeBytes: 1000, sha256: crypto.randomBytes(32).toString("hex"), durationMs: 600_000,
    offsetMs: seq * 600_000, expiresAt: AGORA + 27 * DIA, createdAt: AGORA - 3 * DIA, updatedAt: AGORA, ...extra,
  };
};

async function auditorias() {
  const db = (await getDb())!;
  return db.select().from(auditLogs).where(and(eq(auditLogs.userId, CONTA), eq(auditLogs.action, ACAO_AUDIO_BAIXADO)));
}

describe.skipIf(!temBanco)("Baixar o áudio da reunião no banco (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    await db.insert(meetings).values([
      reuniao(EM_PARTES, { audioPipeline: "slices" }),
      reuniao(ENVIO_UNICO),
      reuniao(GRAVANDO, { audioPipeline: "slices", status: "recording" }),
      reuniao(VENCIDA, { audioPipeline: "slices", createdAt: AGORA - 40 * DIA }),
      reuniao(EXCLUIDA, { audioPipeline: "slices", status: "deleted" }),
      reuniao(SEM_AUDIO_ANTIGA, { createdAt: AGORA - MEETING_AUDIO_TTL_MS - DIA }),
    ]);
    await db.insert(meetingAudioSlices).values([
      // Fora da ordem de inserção, com formatos misturados, uma que falhou e uma ainda subindo.
      parte(EM_PARTES, 2, { mimeType: "audio/mpeg", offsetMs: null, durationMs: 300_000 }),
      parte(EM_PARTES, 0, { mimeType: "audio/mp4" }),
      parte(EM_PARTES, 1, { status: "failed" }),
      parte(EM_PARTES, 3, { status: "uploading", offsetMs: null }),
      parte(GRAVANDO, 0),
      parte(VENCIDA, 0, { expiresAt: AGORA - DIA }),
      parte(VENCIDA, 1, { expiresAt: AGORA - DIA }),
      parte(EXCLUIDA, 0),
    ]);
    await db.insert(meetingRecordings).values([
      // Duas gravações no envio único: sai a mais recente.
      { id: crypto.randomUUID(), meetingId: ENVIO_UNICO, ownerId: DONA, storageKey: `meetings/${DONA}/antiga.webm`, storageUrl: "/manus-storage/x", mimeType: "audio/webm", sizeBytes: 10, durationSeconds: 30, expiresAt: AGORA + DIA, createdAt: AGORA - 2 * DIA },
      { id: crypto.randomUUID(), meetingId: ENVIO_UNICO, ownerId: DONA, storageKey: `meetings/${DONA}/recente.m4a`, storageUrl: "/manus-storage/y", mimeType: "audio/m4a", sizeBytes: 10, durationSeconds: 95, expiresAt: AGORA + DIA, createdAt: AGORA - DIA },
    ]);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, DONA));
    await db.delete(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
    await db.delete(auditLogs).where(eq(auditLogs.userId, CONTA));
  });

  it("as partes que tocam saem na ordem de seq, no tempo do player, com as chaves da própria reunião; uma linha de auditoria", async () => {
    const antes = (await auditorias()).length;
    const preparado = await prepararAudioDaReuniao(DONA, EM_PARTES, PEDIDO);
    expect(preparado.partes.map(p => [p.seq, p.mimeType, p.inicioMs, p.duracaoMs])).toEqual([
      [0, "audio/mp4", 0, 600_000],
      // A 1 falhou e a 3 ainda sobe: ficam de fora, e a 2 começa depois do tempo da 1.
      [2, "audio/mpeg", 1_200_000, 300_000],
    ]);
    for (const p of preparado.partes) expect(p.storageKey.startsWith(`meetings/${DONA}/${EM_PARTES}/partes/`)).toBe(true);
    expect(preparado.duracaoSegundos).toBe(1500);
    const linhas = await auditorias();
    expect(linhas).toHaveLength(antes + 1);
    expect(linhas.at(-1)).toMatchObject({
      resource: "meetings", resourceId: EM_PARTES, status: "success", riskLevel: "medium",
      details: { formato: "mp3", partes: 2, duracaoSegundos: 1500, emPartes: true, formatosDeOrigem: ["audio/mp4", "audio/mpeg"] },
    });
    expect(JSON.stringify(linhas.at(-1))).not.toContain("partes/");
  });

  it("o envio único sai como uma parte só, da gravação mais recente", async () => {
    const preparado = await prepararAudioDaReuniao(DONA, ENVIO_UNICO, { ...PEDIDO, formato: "m4a" });
    expect(preparado).toEqual({
      partes: [{ seq: 0, storageKey: `meetings/${DONA}/recente.m4a`, mimeType: "audio/m4a", inicioMs: 0, duracaoMs: 95_000 }],
      duracaoSegundos: 95,
    });
  });

  it("outra conta leva NOT_FOUND na reunião da dona, e nada é gravado", async () => {
    const antes = (await auditorias()).length;
    await expect(prepararAudioDaReuniao(OUTRA, EM_PARTES, PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await auditorias()).toHaveLength(antes);
  });

  it("reunião excluída e reunião que não existe: NOT_FOUND; gravando: AUDIO_AINDA_GRAVANDO; nenhuma grava auditoria", async () => {
    const antes = (await auditorias()).length;
    await expect(prepararAudioDaReuniao(DONA, EXCLUIDA, PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepararAudioDaReuniao(DONA, crypto.randomUUID(), PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepararAudioDaReuniao(DONA, GRAVANDO, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.aindaGravando });
    expect(await auditorias()).toHaveLength(antes);
  });

  it("depois dos 30 dias, AUDIO_VENCIDO: nas partes vencidas e na reunião antiga sem linha de áudio; nenhuma grava auditoria", async () => {
    const antes = (await auditorias()).length;
    await expect(prepararAudioDaReuniao(DONA, VENCIDA, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "AUDIO_VENCIDO" });
    await expect(prepararAudioDaReuniao(DONA, SEM_AUDIO_ANTIGA, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "AUDIO_VENCIDO" });
    expect(await auditorias()).toHaveLength(antes);
  });

  it("preparar não muda a reunião nem as partes", async () => {
    const db = (await getDb())!;
    const [antes] = await db.select({ status: meetings.status, updatedAt: meetings.updatedAt }).from(meetings).where(eq(meetings.id, EM_PARTES));
    await prepararAudioDaReuniao(DONA, EM_PARTES, PEDIDO);
    const [depois] = await db.select({ status: meetings.status, updatedAt: meetings.updatedAt }).from(meetings).where(eq(meetings.id, EM_PARTES));
    expect(depois).toEqual(antes);
    const partes = await db.select({ seq: meetingAudioSlices.seq, status: meetingAudioSlices.status }).from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, EM_PARTES));
    expect(partes).toHaveLength(4);
  });
});
