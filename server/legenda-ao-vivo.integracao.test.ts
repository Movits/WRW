import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, meetings, users } from "../drizzle/schema";
import { appRouter } from "./routers";
import { iniciarReuniaoEmPartes } from "./fatias-de-reuniao";
import { ACAO_LEGENDA_LIGADA } from "./legenda-ao-vivo";
import { tetoDaLegenda } from "./routers/meetings";
import { LEGENDAS_POR_JANELA, RECUSAS_DA_LEGENDA, TEXTO_DO_AVISO_DA_LEGENDA_MAX, VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";

/**
 * A legenda ao vivo (G15b) contra um banco real DE TESTE: o ligar grava a
 * confirmação da dona na auditoria, só na reunião dela que está gravando, com
 * o teto por dona. Sem DATABASE_URL_TESTES o teste se pula
 * (server/test/setup-banco.ts). Donas com id aleatório: a limpeza só alcança
 * o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-legenda-${crypto.randomUUID()}`;
const OUTRA = `teste-legenda-${crypto.randomUUID()}`;
const ID_DA_DONA = 917_001;

const contexto = (openId: string) => ({
  user: { id: ID_DA_DONA, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: { "user-agent": "Navegador de teste/1.0" }, socket: { remoteAddress: "203.0.113.7" } },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = DONA) => appRouter.createCaller(contexto(openId));

const TEXTO = "Ligar a legenda ao vivo?\nNo Chrome, ele costuma mandar o áudio a um servidor do Google para virar texto.\nAs pessoas desta reunião sabem e concordam.";
const pedido = (meetingId: string, extra: Record<string, unknown> = {}) => ({
  meetingId, concordanciaDasPessoas: true as const, versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA, idioma: "pt-BR" as const, textoExibido: TEXTO, ...extra,
});
const iniciar = (dona = DONA) => iniciarReuniaoEmPartes(dona, { title: "Reunião gravando", language: "pt-BR", consentNoticeVersion: "2026-11-14", origem: "gravacao" });
const criadas: string[] = [];

async function provas(meetingId: string) {
  return (await getDb())!.select().from(auditLogs)
    .where(and(eq(auditLogs.action, ACAO_LEGENDA_LIGADA), eq(auditLogs.resourceId, meetingId)));
}

describe.skipIf(!temBanco)("A legenda ao vivo, no banco (integração)", () => {
  beforeAll(async () => {
    await (await getDb())!.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    if (criadas.length) await apagarPelaChave(db, auditLogs, and(eq(auditLogs.action, ACAO_LEGENDA_LIGADA), inArray(auditLogs.resourceId, criadas)));
    for (const dona of [DONA, OUTRA]) {
      await apagarPelaChave(db, meetings, eq(meetings.ownerId, dona));
      await db.delete(users).where(eq(users.openId, dona));
    }
  });
  beforeEach(() => {
    tetoDaLegenda.esquecer();
  });

  it("a reunião da dona que está gravando: a confirmação vai à auditoria, com o aviso que ela viu, o hash, o IP e o navegador", async () => {
    const { id } = await iniciar();
    criadas.push(id);
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).resolves.toEqual({ success: true });
    const linhas = await provas(id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      userId: ID_DA_DONA, resource: "meetings", resourceId: id, ipAddress: "203.0.113.7", userAgent: "Navegador de teste/1.0",
      status: "success", riskLevel: "low",
    });
    expect(linhas[0].details).toEqual({
      concordanciaDasPessoas: true, versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA, idioma: "pt-BR", textoExibido: TEXTO,
      textoHash: crypto.createHash("sha256").update(TEXTO).digest("hex"),
    });
    // Ligar de novo (outra aba, recarregar a página) grava outra prova: cada uma diz o que a dona viu naquela hora.
    await rota().meetings.ligarLegendaAoVivo(pedido(id, { idioma: "en", textoExibido: "Turn on live captions?" }));
    expect(await provas(id)).toHaveLength(2);
  });

  it("a reunião de outra dona e a que não existe são NOT_FOUND, sem nada gravado", async () => {
    const { id } = await iniciar(OUTRA);
    criadas.push(id);
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inexistente = crypto.randomUUID();
    criadas.push(inexistente);
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(inexistente))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await provas(id)).toEqual([]);
    expect(await provas(inexistente)).toEqual([]);
  });

  it("a excluída é NOT_FOUND, como a que não existe", async () => {
    const { id } = await iniciar();
    criadas.push(id);
    await (await getDb())!.update(meetings).set({ status: "deleted" }).where(eq(meetings.id, id));
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await provas(id)).toEqual([]);
  });

  it.each(["uploading", "processing", "ready", "failed"] as const)("a reunião em %s já não grava: a recusa com o código, que a tela traduz, sem nada gravado", async status => {
    const { id } = await iniciar();
    criadas.push(id);
    await (await getDb())!.update(meetings).set({ status }).where(eq(meetings.id, id));
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_LEGENDA.foraDaGravacao });
    expect(await provas(id)).toEqual([]);
  });

  it.each([
    ["sem a concordância das pessoas", { concordanciaDasPessoas: false }],
    ["com uma versão do aviso que não existe", { versaoDoAviso: "legenda-1999-01-01" }],
    ["com o idioma da tela fora dos 10", { idioma: "it" }],
    ["sem o texto do aviso", { textoExibido: "   " }],
    ["com o texto do aviso grande demais", { textoExibido: "a".repeat(TEXTO_DO_AVISO_DA_LEGENDA_MAX + 1) }],
  ])("o pedido %s é recusado antes do serviço", async (_caso, extra) => {
    const { id } = await iniciar();
    criadas.push(id);
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id, extra))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await provas(id)).toEqual([]);
  });

  it(`o teto: ${LEGENDAS_POR_JANELA} ligar por dona a cada hora; a recusa devolve a vaga`, async () => {
    const { id } = await iniciar();
    criadas.push(id);
    for (let i = 0; i < LEGENDAS_POR_JANELA - 1; i++) tetoDaLegenda.reservar(DONA);
    // A recusa (a reunião que não existe) não gasta a última vaga.
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(crypto.randomUUID()))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).resolves.toEqual({ success: true });
    await expect(rota().meetings.ligarLegendaAoVivo(pedido(id))).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DA_LEGENDA.demais });
    expect(await provas(id)).toHaveLength(1);
    // O teto é por dona: a outra conta segue livre.
    const { id: daOutra } = await iniciar(OUTRA);
    criadas.push(daOutra);
    await expect(rota(OUTRA).meetings.ligarLegendaAoVivo(pedido(daOutra))).resolves.toEqual({ success: true });
  });
});
