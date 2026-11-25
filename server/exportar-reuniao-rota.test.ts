import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.exportar (H8) no router, com o serviço dublado. Prova o que fica na
 * rota: a dona é a da sessão, a prova da auditoria (conta, IP e navegador) vem
 * da requisição, só o PDF é aceito, e o teto de 30 exportações a cada 10
 * minutos por dona conta só a exportação que saiu. O que o serviço faz com o
 * banco está em exportar-reuniao.test.ts e exportar-reuniao.integracao.test.ts.
 */

const exportarReuniao = vi.fn();

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./exportar-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./exportar-reuniao")>(),
  exportarReuniao: (...args: unknown[]) => exportarReuniao(...args),
}));

const { appRouter } = await import("./routers");
const { meetingsRouter, tetoDaExportacao } = await import("./routers/meetings");
const { EXPORTACOES_POR_JANELA, MENSAGEM_EXPORTACOES_DEMAIS, MENSAGEM_EXPORTAR_SO_PRONTA } = await import("@shared/exportar-reuniao");
const { TRPCError } = await import("@trpc/server");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EXPORTADA = { titulo: "Reunião", emoji: null, criadaEm: 1, idioma: "pt-BR", duracaoSegundos: null, nomes: {}, itens: [], transcricao: null, exportadaEm: 2 };
const contexto = (openId: string, cabecalhos: Record<string, string> = {}) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: cabecalhos, ip: "203.0.113.9", socket: {} },
  res: { cookie: () => {} },
}) as never;
const exportar = (openId = "dona-1", entrada: Record<string, unknown> = {}, cabecalhos?: Record<string, string>) =>
  meetingsRouter.createCaller(contexto(openId, cabecalhos)).exportar({ meetingId: ID, formato: "pdf", ...entrada } as never);

beforeEach(() => {
  tetoDaExportacao.esquecer();
  exportarReuniao.mockReset();
  exportarReuniao.mockResolvedValue(EXPORTADA);
});

describe("meetings.exportar — o que chega ao serviço", () => {
  it("a dona da sessão, a reunião, o formato e a prova da requisição (conta, IP e navegador)", async () => {
    await expect(exportar("dona-1", {}, { "user-agent": "Safari no iPhone" })).resolves.toEqual(EXPORTADA);
    expect(exportarReuniao).toHaveBeenCalledWith("dona-1", ID, { formato: "pdf", userId: 7, ipAddress: "203.0.113.9", userAgent: "Safari no iPhone" });
  });

  it.each([
    ["formato fora da lista (Word fica para depois)", { formato: "docx" }],
    ["TXT", { formato: "txt" }],
    ["sem formato", { formato: undefined }],
    ["reunião sem uuid", { meetingId: "reuniao-1" }],
  ])("%s: BAD_REQUEST, sem chamar o serviço e sem gastar vaga", async (_caso, entrada) => {
    for (let i = 0; i < EXPORTACOES_POR_JANELA + 1; i++) await expect(exportar("dona-1", entrada)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(exportarReuniao).not.toHaveBeenCalled();
    await expect(exportar()).resolves.toEqual(EXPORTADA);
  });

  it("a recusa do serviço sai como veio, com o código e a frase que a tela traduz", async () => {
    exportarReuniao.mockRejectedValueOnce(new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_EXPORTAR_SO_PRONTA }));
    await expect(exportar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EXPORTAR_SO_PRONTA });
    exportarReuniao.mockRejectedValueOnce(new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." }));
    await expect(exportar("outra-conta")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe(`meetings.exportar — o teto de ${EXPORTACOES_POR_JANELA} exportações a cada 10 minutos por dona`, () => {
  it("passado o teto, TOO_MANY_REQUESTS com a frase da exportação, sem chamar o serviço; outra dona passa", async () => {
    for (let i = 0; i < EXPORTACOES_POR_JANELA; i++) await expect(exportar()).resolves.toEqual(EXPORTADA);
    await expect(exportar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: MENSAGEM_EXPORTACOES_DEMAIS });
    expect(exportarReuniao).toHaveBeenCalledTimes(EXPORTACOES_POR_JANELA);
    await expect(exportar("outra-dona")).resolves.toEqual(EXPORTADA);
  });

  it("a exportação que não saiu (recusa, banco fora do ar, auditoria que falhou) devolve a vaga", async () => {
    exportarReuniao.mockRejectedValue(new Error("audit_logs recusou"));
    for (let i = 0; i < EXPORTACOES_POR_JANELA + 5; i++) await expect(exportar()).rejects.toThrow();
    exportarReuniao.mockResolvedValue(EXPORTADA);
    for (let i = 0; i < EXPORTACOES_POR_JANELA; i++) await expect(exportar()).resolves.toEqual(EXPORTADA);
    await expect(exportar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("a vaga é tomada antes do await: uma rajada simultânea (várias abas, um lote tRPC) não passa do teto", async () => {
    // O serviço segura todas as exportações até o teste soltar: quem conferisse
    // o teto e só marcasse a vaga depois deixaria a rajada inteira passar.
    const presas: Array<() => void> = [];
    exportarReuniao.mockImplementation(() => new Promise(resolve => presas.push(() => resolve(EXPORTADA))));
    const rajada = Array.from({ length: EXPORTACOES_POR_JANELA + 3 }, () => exportar().then(() => "ok", erro => erro.code));
    await vi.waitFor(() => expect(presas).toHaveLength(EXPORTACOES_POR_JANELA));
    presas.forEach(soltar => soltar());
    const resultados = await Promise.all(rajada);
    expect(resultados.filter(r => r === "ok")).toHaveLength(EXPORTACOES_POR_JANELA);
    expect(resultados.filter(r => r === "TOO_MANY_REQUESTS")).toHaveLength(3);
    expect(exportarReuniao).toHaveBeenCalledTimes(EXPORTACOES_POR_JANELA);
  });
});

describe("meetings.exportar — só a dona exporta", () => {
  it("o procedimento é da dona (meetings.*), e o link aberto não tem nenhum que exporte", () => {
    const procedimentos = Object.keys(appRouter._def.procedures);
    expect(procedimentos).toContain("meetings.exportar");
    // Os vizinhos estão no mesmo registro: a ausência é do procedimento, não da forma da chave.
    expect(procedimentos).toContain("reuniaoAberta.ver");
    expect(procedimentos.filter(nome => nome.startsWith("reuniaoAberta.") && /export|pdf|baixar|imprim/i.test(nome))).toEqual([]);
  });

  it("sem sessão, UNAUTHORIZED, sem chamar o serviço", async () => {
    const semSessao = meetingsRouter.createCaller({ user: null, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never);
    await expect(semSessao.exportar({ meetingId: ID, formato: "pdf" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(exportarReuniao).not.toHaveBeenCalled();
  });
});
