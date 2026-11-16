import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { meetings, meetingTranscripts, users } = await import("../drizzle/schema");
const { getPrivateMeeting, gravarResultadoDaReuniao, nomearFalante } = await import("./meeting-service");
const { appRouter } = await import("./routers");

/**
 * Os nomes das vozes (H3) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts).
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-nomes-${crypto.randomUUID()}`;
const OUTRA = `teste-nomes-${crypto.randomUUID()}`;
const REUNIAO = crypto.randomUUID();

describe.skipIf(!temBanco)("Nomes das vozes da reunião (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    const agora = Date.now();
    await db.insert(meetings).values({ id: REUNIAO, ownerId: DONA, title: "Reunião com vozes", status: "ready", consentGranted: true, createdAt: agora, updatedAt: agora });
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    for (const dona of [DONA, OUTRA]) await db.delete(users).where(eq(users.openId, dona));
  });

  it("dá nome, guarda os dois juntos, tira com nome vazio, e o detalhe da dona traz os nomes", async () => {
    expect(await nomearFalante(DONA, REUNIAO, "F1", "  Ana  ")).toEqual({ F1: "Ana" });
    expect(await nomearFalante(DONA, REUNIAO, "F2", "Bia")).toEqual({ F1: "Ana", F2: "Bia" });
    expect((await getPrivateMeeting(DONA, REUNIAO))?.meeting.speakerNames).toEqual({ F1: "Ana", F2: "Bia" });
    expect(await nomearFalante(DONA, REUNIAO, "F1", "   ")).toEqual({ F2: "Bia" });
    expect(await nomearFalante(DONA, REUNIAO, "F2", "")).toEqual({});
    const [linha] = await (await getDb())!.select({ nomes: meetings.speakerNames }).from(meetings).where(eq(meetings.id, REUNIAO));
    expect(linha.nomes).toBeNull();
  });

  it("dois nomes salvos ao mesmo tempo não se apagam (linha travada)", async () => {
    await Promise.all([nomearFalante(DONA, REUNIAO, "F1", "Ana"), nomearFalante(DONA, REUNIAO, "F2", "Bia"), nomearFalante(DONA, REUNIAO, "F3", "Cris")]);
    expect((await getPrivateMeeting(DONA, REUNIAO))?.meeting.speakerNames).toEqual({ F1: "Ana", F2: "Bia", F3: "Cris" });
  });

  it("outra conta não nomeia (NOT_FOUND pela rota) e não vê nada", async () => {
    expect(await nomearFalante(OUTRA, REUNIAO, "F1", "Intrusa")).toBeNull();
    const rota = appRouter.createCaller({ user: { openId: OUTRA, role: "silver", onboardingCompleted: true } } as never);
    await expect(rota.meetings.nomearFalante({ meetingId: REUNIAO, falante: "F1", nome: "Intrusa" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getPrivateMeeting(DONA, REUNIAO))?.meeting.speakerNames?.F1).toBe("Ana");
  });

  it("reunião inexistente ou excluída não recebe nome", async () => {
    expect(await nomearFalante(DONA, crypto.randomUUID(), "F1", "Ana")).toBeNull();
    const db = (await getDb())!;
    const excluida = crypto.randomUUID();
    const agora = Date.now();
    await db.insert(meetings).values({ id: excluida, ownerId: DONA, title: "Excluída", status: "deleted", consentGranted: true, createdAt: agora, updatedAt: agora });
    try {
      expect(await nomearFalante(DONA, excluida, "F1", "Ana")).toBeNull();
    } finally {
      await db.delete(meetings).where(eq(meetings.id, excluida));
    }
  });

  it("reprocessar zera os nomes: a transcrição nova renumera as vozes", async () => {
    const db = (await getDb())!;
    const reuniao = crypto.randomUUID();
    const ficha = Date.now();
    await db.insert(meetings).values({ id: reuniao, ownerId: DONA, title: "Reprocessada", status: "ready", consentGranted: true, createdAt: ficha, updatedAt: ficha });
    try {
      await nomearFalante(DONA, reuniao, "F1", "Ana");
      await db.update(meetings).set({ status: "processing", updatedAt: ficha }).where(eq(meetings.id, reuniao));
      await gravarResultadoDaReuniao(db, {
        meetingId: reuniao, ownerId: DONA, ficha, limparAntes: true, durationSeconds: 30,
        transcription: { text: "Nova transcrição.", segments: [], language: "pt-BR" },
        extraction: { entities: [], contacts: [] } as never,
      });
      const [linha] = await db.select({ nomes: meetings.speakerNames, status: meetings.status }).from(meetings).where(eq(meetings.id, reuniao));
      expect(linha.status).toBe("ready");
      expect(linha.nomes).toBeNull();
    } finally {
      await db.delete(meetings).where(eq(meetings.id, reuniao));
    }
  });

  it("falante fora do formato é recusado antes do banco", async () => {
    await expect(nomearFalante(DONA, REUNIAO, "Falante 1", "Ana")).rejects.toThrow("Falante inválido");
    const rota = appRouter.createCaller({ user: { openId: DONA, role: "silver", onboardingCompleted: true } } as never);
    await expect(rota.meetings.nomearFalante({ meetingId: REUNIAO, falante: "F0", nome: "Ana" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
