import { describe, expect, it, vi } from "vitest";
import { auditLogs, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts } from "../drizzle/schema";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Exportar a reunião (H8) sem o banco: uma transação dublada mostra que a
 * leitura e o insert da auditoria estão DENTRO dela, que a falha da auditoria
 * desfaz tudo e nada sai, e o que a auditoria e a resposta levam. As condições
 * do WHERE (a dona, os confirmados, a reunião excluída) só o banco de verdade
 * prova: estão em exportar-reuniao.integracao.test.ts, contra o MariaDB.
 */

const banco = vi.hoisted(() => ({ atual: null as unknown }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    if (banco.atual) return banco.atual;
    throw new Error("banco dublado: o teste não montou a transação");
  },
}));

const { exportarReuniao } = await import("./exportar-reuniao");
const { ACAO_REUNIAO_EXPORTADA, MENSAGEM_EXPORTAR_SO_PRONTA } = await import("@shared/exportar-reuniao");

const AGORA = 1_763_300_000_000;
const PEDIDO = { formato: "pdf" as const, userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest" };

type Linhas = {
  reuniao?: Record<string, unknown>;
  transcricao?: Record<string, unknown>;
  resumo?: Record<string, unknown>;
  itens?: Array<Record<string, unknown>>;
};

const REUNIAO = { title: "Reunião com a importadora", status: "ready", language: "pt", createdAt: AGORA, speakerNames: { F1: "  Ana  ", X9: "Fora" } };
const TRANSCRICAO = {
  transcript: "texto corrido que não vai quando há falas",
  segments: [
    { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia.", confianca: 0.9 },
    { inicio: 4, fim: 30, falante: "", texto: "", lacuna: true },
    { inicio: 30, fim: 41, falante: "F2", texto: "Fechamos na sexta." },
  ],
  language: "pt-BR",
  durationSeconds: 41,
};
const ITEM = { secao: "action", assunto: null, texto: "{F2} manda a proposta", responsavel: "{F2}", prazo: "sexta", feita: 1 };

/** A transação dublada: cada consulta responde pela tabela, e os passos ficam registrados. */
function transacaoDublada(linhas: Linhas, insert: () => Promise<unknown> = async () => undefined) {
  const passos: string[] = [];
  const inserido: { tabela?: unknown; valores?: Record<string, unknown> } = {};
  const resposta = (tabela: unknown) => {
    if (tabela === meetings) { passos.push("select meetings"); return linhas.reuniao ? [linhas.reuniao] : []; }
    if (tabela === meetingTranscripts) { passos.push("select meeting_transcripts"); return linhas.transcricao ? [linhas.transcricao] : []; }
    if (tabela === meetingSummaries) { passos.push("select meeting_summaries"); return linhas.resumo ? [linhas.resumo] : []; }
    if (tabela === meetingSummaryItems) { passos.push("select meeting_summary_items"); return linhas.itens ?? []; }
    throw new Error("tabela que a exportação não lê");
  };
  const tx = {
    select: () => ({
      from: (tabela: unknown) => ({
        where: () => ({
          limit: async () => resposta(tabela),
          orderBy: async () => resposta(tabela),
        }),
      }),
    }),
    insert: (tabela: unknown) => ({
      values: async (valores: Record<string, unknown>) => {
        passos.push("insert");
        inserido.tabela = tabela;
        inserido.valores = valores;
        return insert();
      },
    }),
  };
  const db = {
    // Fora da transação, nada: ler ou gravar pelo banco solto falha o teste.
    select: () => { throw new Error("leitura fora da transação"); },
    insert: () => { throw new Error("gravação fora da transação"); },
    transaction: async (trabalho: (t: typeof tx) => Promise<unknown>) => {
      passos.push("begin");
      try {
        const resultado = await trabalho(tx);
        passos.push("commit");
        return resultado;
      } catch (erro) {
        passos.push("rollback");
        throw erro;
      }
    },
  };
  return { db, passos, inserido };
}

async function exportarCom(linhas: Linhas, insert?: () => Promise<unknown>, pedido = PEDIDO) {
  const dublada = transacaoDublada(linhas, insert);
  banco.atual = dublada.db;
  try {
    const resultado = await exportarReuniao("dona-1", "reuniao-1", pedido).then(dados => ({ dados }), erro => ({ erro }));
    return { ...dublada, ...resultado };
  } finally {
    banco.atual = null;
  }
}

describe("exportar: a leitura e a auditoria na mesma transação", () => {
  it("a auditoria não entra: a transação volta atrás e nada é exportado", async () => {
    const r = await exportarCom({ reuniao: REUNIAO, transcricao: TRANSCRICAO, resumo: { id: "resumo-1", emoji: "🤝" }, itens: [ITEM] },
      async () => { throw new Error("audit_logs recusou"); });
    expect(r).not.toHaveProperty("dados");
    expect((r as { erro: Error }).erro.message).toBe("audit_logs recusou");
    expect(r.passos).toEqual([
      "begin", "select meetings", "select meeting_transcripts", "select meeting_summaries", "select meeting_summary_items", "insert", "rollback",
    ]);
  });

  it("a auditoria entra depois de tudo lido, em audit_logs, e só então a reunião sai", async () => {
    const r = await exportarCom({ reuniao: REUNIAO, transcricao: TRANSCRICAO, resumo: { id: "resumo-1", emoji: "🤝" }, itens: [ITEM] });
    expect(r.passos).toEqual([
      "begin", "select meetings", "select meeting_transcripts", "select meeting_summaries", "select meeting_summary_items", "insert", "commit",
    ]);
    expect(r.inserido.tabela).toBe(auditLogs);
    expect(r).toHaveProperty("dados");
  });

  it("a linha da auditoria leva o formato, o idioma e as contagens, com IP e navegador cortados, e nada do conteúdo", async () => {
    const r = await exportarCom({ reuniao: REUNIAO, transcricao: TRANSCRICAO, resumo: { id: "resumo-1", emoji: "🤝" }, itens: [ITEM, { ...ITEM, feita: 0 }] },
      undefined, { ...PEDIDO, ipAddress: `198.51.100.23, 10.0.0.1${"9".repeat(60)}`, userAgent: "u".repeat(800) });
    expect(r.inserido.valores).toEqual({
      userId: 7,
      action: ACAO_REUNIAO_EXPORTADA,
      resource: "meetings",
      resourceId: "reuniao-1",
      details: { formato: "pdf", idioma: "pt-BR", itensConfirmados: 2, falas: 3, comTranscricao: true },
      ipAddress: "198.51.100.23",
      userAgent: "u".repeat(500),
      status: "success",
      riskLevel: "medium",
    });
    expect(ACAO_REUNIAO_EXPORTADA).toBe("MEETING_EXPORTED");
    const linha = JSON.stringify(r.inserido.valores);
    for (const conteudo of ["importadora", "proposta", "Bom dia", "Ana", "sexta"]) expect(linha).not.toContain(conteudo);
  });
});

describe("exportar: as recusas não gravam nada", () => {
  it("reunião que não é da dona (ou excluída, ou que não existe): NOT_FOUND, sem ler o resto e sem auditoria", async () => {
    const r = await exportarCom({});
    expect((r as { erro: { code?: string } }).erro).toMatchObject({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    expect(r.passos).toEqual(["begin", "select meetings", "rollback"]);
    expect(r.inserido.valores).toBeUndefined();
  });

  it.each(["recording", "uploading", "processing", "failed", "draft"])("reunião '%s': PRECONDITION_FAILED, sem auditoria", async status => {
    const r = await exportarCom({ reuniao: { ...REUNIAO, status }, transcricao: TRANSCRICAO });
    expect((r as { erro: { code?: string } }).erro).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EXPORTAR_SO_PRONTA });
    expect(r.passos).toEqual(["begin", "select meetings", "rollback"]);
  });
});

describe("exportar: o que sai", () => {
  it("o título, o emoji, a data, o idioma da reunião, a duração, os nomes válidos, os itens e as falas no contrato; sem o texto corrido", async () => {
    const r = await exportarCom({ reuniao: REUNIAO, transcricao: TRANSCRICAO, resumo: { id: "resumo-1", emoji: "🤝" }, itens: [ITEM] });
    const { dados } = r as { dados: Awaited<ReturnType<typeof exportarReuniao>> };
    expect(dados).toEqual({
      titulo: "Reunião com a importadora",
      emoji: "🤝",
      criadaEm: AGORA,
      idioma: "pt-BR",
      duracaoSegundos: 41,
      nomes: { F1: "Ana" },
      itens: [{ secao: "action", assunto: null, texto: "{F2} manda a proposta", responsavel: "{F2}", prazo: "sexta", feita: true }],
      transcricao: {
        texto: null,
        // O campo fora do contrato (a confiança) não sai.
        falas: [
          { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia." },
          { inicio: 4, fim: 30, falante: "", texto: "", lacuna: true },
          { inicio: 30, fim: 41, falante: "F2", texto: "Fechamos na sexta." },
        ],
      },
      exportadaEm: expect.any(Number),
    });
  });

  it("transcrição de antes, sem falas: vai o texto corrido", async () => {
    const r = await exportarCom({ reuniao: REUNIAO, transcricao: { ...TRANSCRICAO, segments: null } });
    const { dados } = r as { dados: Awaited<ReturnType<typeof exportarReuniao>> };
    expect(dados.transcricao).toEqual({ texto: "texto corrido que não vai quando há falas", falas: [] });
    // Sem resumo, nenhum item e nenhum emoji; a consulta dos itens nem roda.
    expect(dados.itens).toEqual([]);
    expect(dados.emoji).toBeNull();
    expect(r.passos).not.toContain("select meeting_summary_items");
  });

  it("o idioma: o da transcrição normalizado; sem ele, o da reunião; sem os dois, o padrão", async () => {
    const idiomaCom = async (transcricao: string | null, reuniao: string) => {
      const r = await exportarCom({ reuniao: { ...REUNIAO, language: reuniao }, transcricao: { ...TRANSCRICAO, language: transcricao } });
      return (r as { dados: { idioma: string } }).dados.idioma;
    };
    expect(await idiomaCom("ar", "pt")).toBe("ar");
    expect(await idiomaCom("en-US", "pt")).toBe("en");
    expect(await idiomaCom(null, "ja")).toBe("ja");
    expect(await idiomaCom("it", "xx")).toBe("pt-BR");
  });

  it("sem transcrição: transcricao null e comTranscricao false na auditoria", async () => {
    const r = await exportarCom({ reuniao: REUNIAO });
    expect((r as { dados: { transcricao: unknown } }).dados.transcricao).toBeNull();
    expect(r.inserido.valores?.details).toMatchObject({ comTranscricao: false, falas: 0, itensConfirmados: 0 });
  });
});
