import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { apagarPelaChave } from "./test/apagar-pela-chave";
import { auditLogs, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } from "../drizzle/schema";
import { exportarReuniao, type ReuniaoExportada } from "./exportar-reuniao";
import { ACAO_REUNIAO_EXPORTADA, MENSAGEM_EXPORTAR_SO_PRONTA } from "@shared/exportar-reuniao";

/**
 * Exportar a reunião (H8) contra um banco real DE TESTE. No CI é o MariaDB
 * criado do zero por scripts/criar-banco.mjs; sem DATABASE_URL_TESTES o teste
 * se pula (server/test/setup-banco.ts troca a DATABASE_URL por ela, então o
 * .env de trabalho nunca é usado aqui). As regras estão no WHERE, e só o banco
 * de verdade as prova:
 *
 * - só os itens CONFIRMADOS saem, na ordem do resumo (nem os para conferir,
 *   nem os ignorados, nem os de outra reunião);
 * - outra conta, reunião excluída e reunião que não existe levam NOT_FOUND, e
 *   a reunião que não está pronta, PRECONDITION_FAILED; nenhuma grava auditoria;
 * - cada exportação grava UMA linha MEETING_EXPORTED, com as contagens e sem o conteúdo.
 *
 * Que a falha da auditoria desfaz a exportação está em exportar-reuniao.test.ts
 * (a transação dublada mostra o insert dentro dela e o rollback).
 *
 * Donas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-exportar-${crypto.randomUUID()}`;
const OUTRA = `teste-exportar-${crypto.randomUUID()}`;
const PRONTA = crypto.randomUUID();
const ANTIGA = crypto.randomUUID();
const PROCESSANDO = crypto.randomUUID();
const EXCLUIDA = crypto.randomUUID();
const AGORA = Date.now();
// userId fora de qualquer conta real: a limpeza das linhas de auditoria vai por ele.
const CONTA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
const OUTRA_CONTA = CONTA + 1;
const PEDIDO = { formato: "pdf" as const, userId: CONTA, ipAddress: "203.0.113.8", userAgent: "vitest-exportar" };

const reuniao = (id: string, status: "ready" | "processing" | "deleted", extra: Partial<typeof meetings.$inferInsert> = {}) => ({
  id, ownerId: DONA, title: `Reunião ${status} para exportar`, status, language: "pt",
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA, ...extra,
});

const RESUMO = crypto.randomUUID();
const RESUMO_DA_ANTIGA = crypto.randomUUID();
const item = (summaryId: string, meetingId: string, position: number, status: "pending" | "confirmed" | "ignored", texto: string, extra: Partial<typeof meetingSummaryItems.$inferInsert> = {}) => ({
  id: crypto.randomUUID(), summaryId, meetingId, ownerId: DONA, section: "action" as const, position, text: texto,
  excerpt: "trecho literal da transcrição", confidence: "0.900", status, createdAt: AGORA, updatedAt: AGORA, ...extra,
});

async function auditoriasDe(userId: number) {
  const db = (await getDb())!;
  return db.select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, ACAO_REUNIAO_EXPORTADA)));
}

describe.skipIf(!temBanco)("Exportar a reunião no banco (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    await db.insert(meetings).values([
      reuniao(PRONTA, "ready", { speakerNames: { F1: "  Ana Voz  ", F2: "   ", X1: "Fora" } as never }),
      reuniao(ANTIGA, "ready"),
      reuniao(PROCESSANDO, "processing"),
      reuniao(EXCLUIDA, "deleted"),
    ]);
    await db.insert(meetingTranscripts).values([
      {
        id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, transcript: "Bom dia. Fechamos na sexta.", language: "pt", durationSeconds: 95,
        segments: [
          { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia." },
          { inicio: 4, fim: 60, falante: "", texto: "", lacuna: true },
          { inicio: 60, fim: 95, falante: "F2", texto: "Fechamos na sexta." },
        ] as never,
        createdAt: AGORA, updatedAt: AGORA,
      },
      // A reunião de antes das falas: só o texto corrido.
      { id: crypto.randomUUID(), meetingId: ANTIGA, ownerId: DONA, transcript: "Texto corrido da reunião antiga.", language: "ar", createdAt: AGORA, updatedAt: AGORA },
      { id: crypto.randomUUID(), meetingId: PROCESSANDO, ownerId: DONA, transcript: "Transcrição da tentativa anterior.", language: "pt", createdAt: AGORA, updatedAt: AGORA },
      { id: crypto.randomUUID(), meetingId: EXCLUIDA, ownerId: DONA, transcript: "Transcrição de reunião excluída.", language: "pt", createdAt: AGORA, updatedAt: AGORA },
    ]);
    await db.insert(meetingSummaries).values([
      { id: RESUMO, meetingId: PRONTA, ownerId: DONA, status: "ready", language: "pt-BR", emoji: "🤝", version: 1, createdAt: AGORA, updatedAt: AGORA },
      // Outro resumo da dona, com item confirmado: não pode vazar para a PRONTA.
      { id: RESUMO_DA_ANTIGA, meetingId: ANTIGA, ownerId: DONA, status: "ready", language: "ar", version: 1, createdAt: AGORA, updatedAt: AGORA },
    ]);
    await db.insert(meetingSummaryItems).values([
      // Fora da ordem de inserção: a saída segue a posição.
      item(RESUMO, PRONTA, 3, "confirmed", "Revisar o contrato", { section: "task", subject: "Contrato com {F1}", assignee: "{F1}", due: "até sexta" }),
      item(RESUMO, PRONTA, 1, "confirmed", "{F2} manda a proposta", { assignee: "{F2}", due: "sexta-feira", done: true }),
      item(RESUMO, PRONTA, 2, "pending", "Item para conferir que não pode sair"),
      item(RESUMO, PRONTA, 4, "ignored", "Item ignorado que não pode sair", { section: "decision" }),
      item(RESUMO, PRONTA, 5, "confirmed", "A entrega fica para dezembro", { section: "decision", origin: "owner", excerpt: "" }),
      item(RESUMO_DA_ANTIGA, ANTIGA, 1, "confirmed", "Item confirmado de outra reunião"),
    ]);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    // Pela chave, uma linha por vez (server/test/apagar-pela-chave.ts): o DELETE
    // pela dona varre a tabela quando ela tem a maior parte das linhas, e trava
    // o INSERT de várias linhas de outro arquivo (ER_LOCK_DEADLOCK).
    await apagarPelaChave(db, meetingSummaryItems, eq(meetingSummaryItems.ownerId, DONA));
    await apagarPelaChave(db, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
    await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, [CONTA, OUTRA_CONTA]));
  });

  it("só os itens confirmados saem, na ordem do resumo, com o emoji, as falas, os tempos e os nomes válidos", async () => {
    const exportada: ReuniaoExportada = await exportarReuniao(DONA, PRONTA, PEDIDO);
    expect(exportada).toEqual({
      titulo: "Reunião ready para exportar",
      emoji: "🤝",
      criadaEm: AGORA,
      idioma: "pt-BR",
      duracaoSegundos: 95,
      nomes: { F1: "Ana Voz" },
      itens: [
        { secao: "action", assunto: null, texto: "{F2} manda a proposta", responsavel: "{F2}", prazo: "sexta-feira", feita: true },
        { secao: "task", assunto: "Contrato com {F1}", texto: "Revisar o contrato", responsavel: "{F1}", prazo: "até sexta", feita: false },
        { secao: "decision", assunto: null, texto: "A entrega fica para dezembro", responsavel: null, prazo: null, feita: false },
      ],
      transcricao: {
        texto: null,
        editada: false,
        falas: [
          { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia." },
          { inicio: 4, fim: 60, falante: "", texto: "", lacuna: true },
          { inicio: 60, fim: 95, falante: "F2", texto: "Fechamos na sexta." },
        ],
      },
      exportadaEm: expect.any(Number),
    });
    const texto = JSON.stringify(exportada);
    for (const fora of ["para conferir", "ignorado", "outra reunião", "trecho literal", DONA]) expect(texto).not.toContain(fora);
  });

  it("a reunião de antes das falas sai com o texto corrido, no idioma dela, e sem os itens de outra reunião", async () => {
    const exportada = await exportarReuniao(DONA, ANTIGA, PEDIDO);
    expect(exportada.transcricao).toEqual({ texto: "Texto corrido da reunião antiga.", falas: [], editada: false });
    expect(exportada.idioma).toBe("ar");
    expect(exportada.itens).toEqual([{ secao: "action", assunto: null, texto: "Item confirmado de outra reunião", responsavel: null, prazo: null, feita: false }]);
  });

  it("cada exportação grava UMA linha de auditoria, com o formato, o idioma e as contagens, e sem o conteúdo", async () => {
    const antes = (await auditoriasDe(CONTA)).length;
    await exportarReuniao(DONA, PRONTA, PEDIDO);
    const linhas = await auditoriasDe(CONTA);
    expect(linhas).toHaveLength(antes + 1);
    const ultima = linhas.find(linha => linha.resourceId === PRONTA)!;
    expect(ultima).toMatchObject({
      action: "MEETING_EXPORTED", resource: "meetings", resourceId: PRONTA, ipAddress: "203.0.113.8", userAgent: "vitest-exportar",
      status: "success", riskLevel: "medium",
      details: { formato: "pdf", idioma: "pt-BR", itensConfirmados: 3, falas: 3, comTranscricao: true },
    });
    const linha = JSON.stringify(ultima);
    for (const conteudo of ["Bom dia", "proposta", "Ana Voz", "Reunião ready"]) expect(linha).not.toContain(conteudo);
  });

  it("outra conta leva NOT_FOUND, e nada é gravado em nome dela", async () => {
    await expect(exportarReuniao(OUTRA, PRONTA, { ...PEDIDO, userId: OUTRA_CONTA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await auditoriasDe(OUTRA_CONTA)).toHaveLength(0);
  });

  it("reunião excluída e reunião que não existe: NOT_FOUND; em processamento: PRECONDITION_FAILED; nenhuma grava auditoria", async () => {
    const antes = (await auditoriasDe(CONTA)).length;
    await expect(exportarReuniao(DONA, EXCLUIDA, PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(exportarReuniao(DONA, crypto.randomUUID(), PEDIDO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(exportarReuniao(DONA, PROCESSANDO, PEDIDO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EXPORTAR_SO_PRONTA });
    expect(await auditoriasDe(CONTA)).toHaveLength(antes);
  });

  it("exportar não muda a reunião nem o resumo: os itens para conferir continuam para conferir", async () => {
    const db = (await getDb())!;
    await exportarReuniao(DONA, PRONTA, PEDIDO);
    const pendentes = await db.select({ id: meetingSummaryItems.id }).from(meetingSummaryItems)
      .where(and(eq(meetingSummaryItems.summaryId, RESUMO), eq(meetingSummaryItems.status, "pending")));
    expect(pendentes).toHaveLength(1);
    const [linha] = await db.select({ status: meetings.status, updatedAt: meetings.updatedAt }).from(meetings).where(eq(meetings.id, PRONTA));
    expect(linha).toEqual({ status: "ready", updatedAt: AGORA });
  });
});
