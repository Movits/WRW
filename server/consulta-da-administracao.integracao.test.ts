import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

// O bucket é dublê: a leitura do áudio vencido o tira do bucket, e este
// arquivo não pode falar com um bucket de verdade.
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: async () => {},
}));
import { getDb } from "./db";
import { auditLogs, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import {
  abrirReuniaoNaConsulta,
  chaveDoAudioDaConsulta,
  consultasDaAdministracaoDaDona,
  listarReunioesParaAAdministracao,
} from "./consulta-da-administracao";
import { ACAO_CONSULTA_DA_ADMINISTRACAO, ACAO_LISTA_DA_ADMINISTRACAO, RECUSAS_DA_CONSULTA } from "@shared/consulta-da-administracao";

/**
 * A consulta da administração (R1a) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, pula). O que só o banco prova: a reunião lida sem a
 * dona no WHERE, mas só a visível; a linha da auditoria com o motivo; o passe
 * do áudio pela hora do banco (59 minutos abre, 61 não); a lista com a busca
 * escapada e as donas na auditoria; e as datas que a dona vê.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const MARCA = crypto.randomUUID().slice(0, 8);
const DONA = `teste-consulta-${crypto.randomUUID()}`;
const OUTRA = `teste-consulta-${crypto.randomUUID()}`;
const ADMIN = `teste-consulta-${crypto.randomUUID()}`;
const NOVA = crypto.randomUUID();
const ANTIGA = crypto.randomUUID();
const NA_LIXEIRA = crypto.randomUUID();
const EXCLUIDA = crypto.randomUUID();
const AGORA = Date.now();
const CHAVE = `meetings/${DONA}/${NOVA}/recording.mp4`;
const MOTIVO = { motivo: "seguranca" as const, complemento: "Relato de ameaça na reunião, pedido da usuária." };

const reuniao = (id: string, extra: Partial<typeof meetings.$inferInsert> = {}) => ({
  id, ownerId: DONA, title: `Consulta ${MARCA} ${id.slice(0, 4)}`, status: "ready" as const,
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA, consentNoticeVersion: "2026-11-23", ...extra,
});

let adminId = 0;
let donaId = 0;
const quem = () => ({ userId: adminId, ipAddress: "203.0.113.20", userAgent: "vitest-consulta" });

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message?: string };
  }
  throw new Error("era para recusar");
}

describe.skipIf(!temBanco)("Consulta da administração no banco (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: DONA, name: `Dona ${MARCA}`, email: `dona-${MARCA}@teste.invalid` },
      { openId: OUTRA },
      { openId: ADMIN, role: "admin" },
    ]);
    const contas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [DONA, ADMIN]));
    adminId = contas.find(conta => conta.openId === ADMIN)!.id;
    donaId = contas.find(conta => conta.openId === DONA)!.id;
    await db.insert(meetings).values([
      { ...reuniao(NOVA), speakerNames: { F1: "Ana" } as never, speakerMerges: { F2: "F1" } as never },
      reuniao(ANTIGA, { consentNoticeVersion: "2026-11-14", createdAt: AGORA - 1000 }),
      reuniao(NA_LIXEIRA, { trashedAt: AGORA }),
      reuniao(EXCLUIDA, { status: "deleted" }),
    ]);
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: NOVA, ownerId: DONA, transcript: "Combinamos a entrega na sexta.", language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(meetingRecordings).values({
      id: crypto.randomUUID(), meetingId: NOVA, ownerId: DONA, storageKey: CHAVE, storageUrl: `/manus-storage/${CHAVE}`,
      mimeType: "audio/mp4", sizeBytes: 1024, durationSeconds: 90, expiresAt: AGORA + 86_400_000, createdAt: AGORA,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await apagarPelaChave(db, meetingRecordings, eq(meetingRecordings.ownerId, DONA));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    if (adminId) await apagarPelaChave(db, auditLogs, eq(auditLogs.userId, adminId));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA, ADMIN]));
  });

  it("abre a reunião de outra conta com a transcrição, o resumo, as vozes e o áudio pela rota da consulta, e grava o motivo", async () => {
    const vista = await abrirReuniaoNaConsulta(quem(), NOVA, MOTIVO);
    expect(vista).toMatchObject({
      titulo: `Consulta ${MARCA} ${NOVA.slice(0, 4)}`, dona: `Dona ${MARCA}`, vozes: { F1: "Ana" }, juntadas: { F2: "F1" },
      transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR", segmentos: [] },
      resumo: { estado: expect.any(String), itens: [] },
      gravacao: { durationSeconds: 90, partes: [{ seq: 0, url: `/consulta-da-administracao/${NOVA}/audio` }] },
    });
    const texto = JSON.stringify(vista);
    expect(texto).not.toContain(DONA);
    expect(texto).not.toContain(CHAVE);
    const db = (await getDb())!;
    const linhas = await db.select({ details: auditLogs.details, riskLevel: auditLogs.riskLevel, ipAddress: auditLogs.ipAddress })
      .from(auditLogs).where(and(eq(auditLogs.userId, adminId), eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO), eq(auditLogs.resourceId, NOVA)));
    expect(linhas).toEqual([{ details: { ...MOTIVO, donaUserId: donaId }, riskLevel: "high", ipAddress: "203.0.113.20" }]);
  });

  it("a gravada antes do aviso fica fechada; a da lixeira, a excluída e a que não existe são 'não encontrada'; nenhuma deixa linha", async () => {
    expect(await recusa(abrirReuniaoNaConsulta(quem(), ANTIGA, MOTIVO))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_CONSULTA.anteriorAoAviso });
    for (const id of [NA_LIXEIRA, EXCLUIDA, crypto.randomUUID()]) {
      expect(await recusa(abrirReuniaoNaConsulta(quem(), id, MOTIVO))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_CONSULTA.naoEncontrada });
    }
    const db = (await getDb())!;
    const linhas = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO), inArray(auditLogs.resourceId, [ANTIGA, NA_LIXEIRA, EXCLUIDA])));
    expect(linhas).toEqual([]);
  });

  it("o áudio só sai com a consulta aberta na última hora, por quem a abriu, e da reunião visível", async () => {
    await abrirReuniaoNaConsulta(quem(), NOVA, MOTIVO);
    expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBe(CHAVE);
    // Outra conta, sem consulta sua: nada.
    expect(await chaveDoAudioDaConsulta(adminId + 999_999, NOVA, undefined)).toBeNull();
    const db = (await getDb())!;
    // As consultas passam a ter 61 minutos (no relógio do banco): o passe venceu.
    await db.update(auditLogs).set({ createdAt: sql`(NOW() - INTERVAL 61 MINUTE)` as never })
      .where(and(eq(auditLogs.userId, adminId), eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO), eq(auditLogs.resourceId, NOVA)));
    expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBeNull();
    // Com 59 minutos, ainda vale.
    await db.update(auditLogs).set({ createdAt: sql`(NOW() - INTERVAL 59 MINUTE)` as never })
      .where(and(eq(auditLogs.userId, adminId), eq(auditLogs.action, ACAO_CONSULTA_DA_ADMINISTRACAO), eq(auditLogs.resourceId, NOVA)));
    expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBe(CHAVE);
    // A reunião foi para a lixeira depois da consulta: o áudio para na hora.
    await db.update(meetings).set({ trashedAt: Date.now() }).where(eq(meetings.id, NOVA));
    try {
      expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBeNull();
    } finally {
      await db.update(meetings).set({ trashedAt: null }).where(eq(meetings.id, NOVA));
    }
    // A dona junta à reunião, dentro da hora, uma gravada antes do aviso: o passe não serve mais o áudio.
    const juntada = crypto.randomUUID();
    await db.insert(auditLogs).values({
      userId: donaId, action: "MEETINGS_JOINED", resource: "meetings", resourceId: NOVA, status: "success", riskLevel: "low",
      details: { juntadas: [juntada], avisosDeGravacao: [{ id: NOVA, consentNoticeVersion: "2026-11-23" }, { id: juntada, consentNoticeVersion: "2026-11-14" }] },
    });
    try {
      expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBeNull();
    } finally {
      await db.delete(auditLogs).where(and(eq(auditLogs.userId, donaId), eq(auditLogs.action, "MEETINGS_JOINED"), eq(auditLogs.resourceId, NOVA)));
    }
    expect(await chaveDoAudioDaConsulta(adminId, NOVA, undefined)).toBe(CHAVE);
  });

  it("a lista acha pela busca (título, nome ou e-mail da dona, com % escapado), tira as invisíveis e grava as donas", async () => {
    const lista = await listarReunioesParaAAdministracao(quem(), { busca: `Dona ${MARCA}` });
    expect(lista.reunioes.map(r => r.id).sort()).toEqual([ANTIGA, NOVA].sort());
    expect(lista.reunioes.find(r => r.id === NOVA)).toMatchObject({ dona: `Dona ${MARCA}`, linkLigado: false, podeConsultar: true });
    expect(lista.reunioes.find(r => r.id === ANTIGA)?.podeConsultar).toBe(false);
    expect(JSON.stringify(lista)).not.toContain(DONA);
    expect(JSON.stringify(lista)).not.toContain("@teste.invalid");
    expect((await listarReunioesParaAAdministracao(quem(), { busca: `dona-${MARCA}@teste` })).reunioes).toHaveLength(2);
    // "%" é letra, não curinga.
    expect((await listarReunioesParaAAdministracao(quem(), { busca: `Consulta ${MARCA}%` })).reunioes).toHaveLength(0);
    expect((await listarReunioesParaAAdministracao(quem(), { busca: `Dona ${MARCA}`, comLinkAberto: true })).reunioes).toHaveLength(0);
    const db = (await getDb())!;
    const [linha] = await db.select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.userId, adminId), eq(auditLogs.action, ACAO_LISTA_DA_ADMINISTRACAO)))
      .orderBy(auditLogs.id).limit(1);
    expect(linha.details).toMatchObject({ busca: `Dona ${MARCA}`, reunioes: 2, donas: [donaId] });
  });

  it("a dona vê as datas das consultas da reunião dela, sem o motivo nem quem; a outra conta leva NOT_FOUND", async () => {
    const datas = await consultasDaAdministracaoDaDona(DONA, NOVA);
    expect(datas.length).toBeGreaterThanOrEqual(2);
    for (const data of datas) expect(Number.isFinite(data)).toBe(true);
    expect(await consultasDaAdministracaoDaDona(DONA, ANTIGA)).toEqual([]);
    expect(await recusa(consultasDaAdministracaoDaDona(OUTRA, NOVA))).toMatchObject({ code: "NOT_FOUND" });
  });
});
