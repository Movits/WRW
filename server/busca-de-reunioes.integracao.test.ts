import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { tetoDaBusca } = await import("./routers/meetings");
const { buscarNasReunioes } = await import("./busca-de-reunioes");
const { BUSCAS_POR_JANELA, MENSAGEM_BUSCAS_DEMAIS, RESULTADOS_DA_BUSCA_MAX } = await import("@shared/busca-de-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * A busca entre as reuniões (H7b) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula): a dona nas duas tabelas, a reunião excluída e
 * o item ignorado fora, o termo escapado no LIKE, o trecho cortado no SQL, os
 * filtros, o teto de resultados e o de buscas.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-busca-${crypto.randomUUID()}`;
const OUTRA = `teste-busca-outra-${crypto.randomUUID()}`;
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;

function contexto(openId: string): TrpcContext {
  return {
    user: { id: 2_100_000_000 + Math.floor(Math.random() * 10_000_000), openId, role: "user", name: "Dona Teste" },
    req: { headers: {}, ip: "203.0.113.20", socket: { remoteAddress: "203.0.113.20" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

async function db() { return (await getDb())!; }

async function reuniao(ownerId: string, opcoes: {
  titulo?: string; transcricao?: string; status?: "ready" | "deleted"; origem?: "gravacao" | "pdf" | "youtube" | null;
  etiquetas?: string[] | null; criadaEm?: number; itens?: Array<{ texto: string; status?: "pending" | "confirmed" | "ignored"; assunto?: string }>;
  speakerNames?: Record<string, string> | null; contextId?: string | null;
}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const criadaEm = opcoes.criadaEm ?? AGORA;
  await banco.insert(meetings).values({
    id, ownerId, title: opcoes.titulo ?? "Reunião", status: opcoes.status ?? "ready", consentGranted: true, language: "pt-BR",
    origem: opcoes.origem === undefined ? "gravacao" : opcoes.origem, etiquetas: opcoes.etiquetas ?? null,
    speakerNames: opcoes.speakerNames ?? null, contextId: opcoes.contextId ?? null, createdAt: criadaEm, updatedAt: criadaEm,
  });
  if (opcoes.transcricao !== undefined) {
    await banco.insert(meetingTranscripts).values({ id: crypto.randomUUID(), meetingId: id, ownerId, transcript: opcoes.transcricao, language: "pt-BR", createdAt: criadaEm, updatedAt: criadaEm });
  }
  const ids: string[] = [];
  if (opcoes.itens?.length) {
    const resumo = crypto.randomUUID();
    await banco.insert(meetingSummaries).values({ id: resumo, meetingId: id, ownerId, status: "ready", createdAt: criadaEm, updatedAt: criadaEm });
    for (const [posicao, item] of opcoes.itens.entries()) {
      const itemId = crypto.randomUUID();
      ids.push(itemId);
      await banco.insert(meetingSummaryItems).values({
        id: itemId, summaryId: resumo, meetingId: id, ownerId, section: "action", position: posicao, subject: item.assunto ?? null,
        text: item.texto, excerpt: "trecho", startSeconds: 42, status: item.status ?? "pending", createdAt: criadaEm, updatedAt: criadaEm,
      } as typeof meetingSummaryItems.$inferInsert);
    }
  }
  return { id, itens: ids };
}

async function limpar() {
  const banco = await db();
  for (const tabela of [meetingSummaryItems, meetingSummaries, meetingTranscripts] as const) {
    await apagarPelaChave(banco, tabela, inArray(tabela.ownerId, [DONA, OUTRA]));
  }
  await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, [DONA, OUTRA]));
}

describe.skipIf(!temBanco)("Busca entre as reuniões (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  beforeEach(async () => { await limpar(); tetoDaBusca.esquecer(); });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await limpar();
    await banco.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("acha o termo na transcrição, com o trecho em volta cortado no SQL, e no item do resumo, com o id dele", async () => {
    const enchimento = "palavra ".repeat(200);
    const { id, itens: [itemId] } = await reuniao(DONA, {
      titulo: "Reunião de exportação", transcricao: `${enchimento}vamos fechar a PROPOSTA de exportação de café hoje ${enchimento}`,
      itens: [{ texto: "{F1} manda a proposta revisada", assunto: "Comercial" }], speakerNames: { F1: "Ana" },
    });
    const { resultados, maisResultados } = await buscarNasReunioes(DONA, "proposta");
    expect(maisResultados).toBe(false);
    expect(resultados.map(r => r.tipo)).toEqual(["transcricao", "item"]);
    const [trecho, item] = resultados;
    expect(trecho).toMatchObject({ meetingId: id, titulo: "Reunião de exportação" });
    expect(trecho.trecho).toContain("PROPOSTA de exportação");
    expect(trecho.trecho.length).toBeLessThanOrEqual(180);
    expect(trecho.trecho.length).toBeLessThan(enchimento.length);
    expect(item).toMatchObject({ tipo: "item", meetingId: id, itemId, trecho: "{F1} manda a proposta revisada", nomes: { F1: "Ana" }, inicioSegundos: 42, secao: "action" });
  });

  it("a dona nas duas tabelas: a reunião de outra conta não aparece, nem pela transcrição nem pelo item", async () => {
    await reuniao(OUTRA, { transcricao: "o segredo da outra conta", itens: [{ texto: "segredo no resumo da outra" }] });
    expect((await buscarNasReunioes(DONA, "segredo")).resultados).toEqual([]);
  });

  it("a reunião excluída e o item ignorado ficam de fora; o pendente e o confirmado entram", async () => {
    await reuniao(DONA, { transcricao: "assunto escondido", status: "deleted" });
    await reuniao(DONA, { itens: [{ texto: "assunto ignorado", status: "ignored" }, { texto: "assunto confirmado", status: "confirmed" }, { texto: "assunto pendente" }] });
    const { resultados } = await buscarNasReunioes(DONA, "assunto");
    expect(resultados.map(r => r.trecho)).toEqual(["assunto confirmado", "assunto pendente"]);
  });

  it("o % e o _ digitados valem como letra, não como curinga", async () => {
    await reuniao(DONA, { transcricao: "desconto de 50% no frete" });
    await reuniao(DONA, { transcricao: "desconto de 500 no frete" });
    await reuniao(DONA, { transcricao: "arquivo nome_final enviado" });
    await reuniao(DONA, { transcricao: "arquivo nomeXfinal enviado" });
    expect((await buscarNasReunioes(DONA, "50%")).resultados.map(r => r.trecho)).toEqual(["desconto de 50% no frete"]);
    expect((await buscarNasReunioes(DONA, "nome_final")).resultados.map(r => r.trecho)).toEqual(["arquivo nome_final enviado"]);
  });

  it("sem caixa e sem acento, pela colação da coluna", async () => {
    await reuniao(DONA, { transcricao: "A Reunião foi ótima" });
    expect((await buscarNasReunioes(DONA, "REUNIAO")).resultados).toHaveLength(1);
  });

  it("os filtros: etiqueta, origem, período e contexto", async () => {
    const contexto = crypto.randomUUID();
    const comEtiqueta = await reuniao(DONA, { transcricao: "contrato novo", etiquetas: ["Clientes"], contextId: contexto });
    const documento = await reuniao(DONA, { transcricao: "contrato do PDF", origem: "pdf" });
    const antiga = await reuniao(DONA, { transcricao: "contrato antigo", criadaEm: AGORA - 60 * DIA });
    const envioUnico = await reuniao(DONA, { transcricao: "contrato do envio único", origem: null });
    const ids = async (filtros: Parameters<typeof buscarNasReunioes>[2]) => (await buscarNasReunioes(DONA, "contrato", filtros)).resultados.map(r => r.meetingId).sort();
    expect(await ids({ etiqueta: "Clientes" })).toEqual([comEtiqueta.id]);
    expect(await ids({ origem: "documento" })).toEqual([documento.id]);
    expect(await ids({ origem: "audio" })).toEqual([comEtiqueta.id, antiga.id, envioUnico.id].sort());
    expect(await ids({ periodo: "30d" })).toEqual([comEtiqueta.id, documento.id, envioUnico.id].sort());
    expect(await ids({ contextId: contexto })).toEqual([comEtiqueta.id]);
  });

  it("até 30 resultados, das mais novas para as mais velhas, e diz quando havia mais", async () => {
    for (let i = 0; i < RESULTADOS_DA_BUSCA_MAX + 2; i++) await reuniao(DONA, { titulo: `R${i}`, transcricao: "termo repetido", criadaEm: AGORA - i * 1000 });
    const { resultados, maisResultados } = await buscarNasReunioes(DONA, "repetido");
    expect(resultados).toHaveLength(RESULTADOS_DA_BUSCA_MAX);
    expect(maisResultados).toBe(true);
    expect(resultados[0].titulo).toBe("R0");
  });

  it("pelo procedimento: o termo curto é recusado, e o teto de buscas sai como código", async () => {
    await reuniao(DONA, { transcricao: "fala qualquer" });
    const chamador = appRouter.createCaller(contexto(DONA));
    const curto = await chamador.meetings.buscar({ termo: "a" }).then(() => null, e => e);
    expect((curto as TRPCError).code).toBe("BAD_REQUEST");
    expect((await chamador.meetings.buscar({ termo: "qualquer" })).resultados).toHaveLength(1);
    for (let i = 1; i < BUSCAS_POR_JANELA; i++) tetoDaBusca.reservar(DONA);
    const erro = await chamador.meetings.buscar({ termo: "qualquer" }).then(() => null, e => e);
    expect(erro).toBeInstanceOf(TRPCError);
    expect([(erro as TRPCError).code, (erro as TRPCError).message]).toEqual(["TOO_MANY_REQUESTS", MENSAGEM_BUSCAS_DEMAIS]);
  });
});
