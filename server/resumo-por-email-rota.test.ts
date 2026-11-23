import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas do resumo por e-mail (H22) em routers/meetings.ts, com o serviço
 * dublado: a dona é a da sessão, a prova vem da requisição, o zod barra o que
 * a tela nunca manda (autorização sem o "sim", versão da caixa que não existe,
 * e-mail comprido demais, lista enorme) e a recusa do link aberto sai com o
 * código que a tela traduz. O serviço contra o banco está em
 * resumo-por-email.integracao.test.ts.
 */

const servico = vi.hoisted(() => ({
  mandar: vi.fn(),
  deNovo: vi.fn(),
  painel: vi.fn(),
  automatico: vi.fn(),
}));

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./resumo-por-email", async importOriginal => ({
  ...await importOriginal<typeof import("./resumo-por-email")>(),
  mandarResumoPorEmail: (...args: unknown[]) => servico.mandar(...args),
  mandarResumoPorEmailDeNovo: (...args: unknown[]) => servico.deNovo(...args),
  painelDoResumoPorEmail: (...args: unknown[]) => servico.painel(...args),
  definirEnvioAutomaticoDoResumo: (...args: unknown[]) => servico.automatico(...args),
}));

const { meetingsRouter } = await import("./routers/meetings");
const { LinkAbertoRecusado } = await import("./link-aberto-da-reuniao");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const contexto = (openId: string, cabecalhos: Record<string, string> = {}) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: cabecalhos, ip: "203.0.113.9", socket: {} },
  res: { cookie: () => {} },
}) as never;
const chamador = (openId = "dona-1", cabecalhos?: Record<string, string>) => meetingsRouter.createCaller(contexto(openId, cabecalhos));
const AUTORIZACAO = { autorizacaoDasPessoas: true, idioma: "pt-BR", textoExibido: "Confirmo que todas as pessoas autorizaram.", versaoDaAutorizacao: 2 };
const mandar = (entrada: Record<string, unknown> = {}, openId?: string, cabecalhos?: Record<string, string>) =>
  chamador(openId, cabecalhos).mandarResumoPorEmail({ meetingId: ID, paraMim: true, participantes: [], outros: [], ...entrada } as never);

beforeEach(() => {
  for (const funcao of Object.values(servico)) funcao.mockReset();
  servico.mandar.mockResolvedValue({ enviados: 1, falharam: 0, linkLigadoAgora: false });
  servico.deNovo.mockResolvedValue({ enviados: 1, falharam: 0 });
  servico.painel.mockResolvedValue({ envios: [] });
  servico.automatico.mockImplementation(async (_dona: unknown, ligado: boolean) => ({ automatico: ligado }));
});

describe("meetings.mandarResumoPorEmail", () => {
  it("chega ao serviço a dona da sessão, o pedido e a prova da requisição", async () => {
    await expect(mandar({ participantes: ["ana@exemplo.invalid"], outros: [" zeca@exemplo.invalid "], autorizacao: AUTORIZACAO }, "dona-1", { "user-agent": "Safari no iPhone" }))
      .resolves.toEqual({ enviados: 1, falharam: 0, linkLigadoAgora: false });
    expect(servico.mandar).toHaveBeenCalledWith(
      { id: 7, openId: "dona-1" },
      ID,
      {
        paraMim: true, participantes: ["ana@exemplo.invalid"], outros: ["zeca@exemplo.invalid"],
        autorizacao: { idioma: "pt-BR", textoExibido: "Confirmo que todas as pessoas autorizaram.", versaoDaAutorizacao: 2 },
      },
      { ipAddress: "203.0.113.9", userAgent: "Safari no iPhone" },
    );
  });

  it("sem a autorização (link já ligado), o serviço recebe undefined e decide", async () => {
    await mandar();
    expect(servico.mandar.mock.calls[0][2]).toMatchObject({ autorizacao: undefined });
  });

  it.each([
    ["autorização sem o sim das pessoas", { autorizacao: { ...AUTORIZACAO, autorizacaoDasPessoas: false } }],
    ["autorização com o texto vazio", { autorizacao: { ...AUTORIZACAO, textoExibido: "   " } }],
    ["versão da caixa que não existe", { autorizacao: { ...AUTORIZACAO, versaoDaAutorizacao: 3 } }],
    ["idioma fora dos 10", { autorizacao: { ...AUTORIZACAO, idioma: "xx" } }],
    ["e-mail maior que o da agenda", { outros: [`${"a".repeat(320)}@exemplo.invalid`] }],
    ["lista enorme", { outros: Array.from({ length: 51 }, (_, i) => `d${i}@exemplo.invalid`) }],
    ["reunião sem uuid", { meetingId: "reuniao-1" }],
    ["sem dizer se vai para a dona", { paraMim: undefined }],
  ])("%s: BAD_REQUEST, sem chamar o serviço", async (_caso, entrada) => {
    await expect(mandar(entrada)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.mandar).not.toHaveBeenCalled();
  });

  it("a recusa do link aberto sai com o código que a tela traduz", async () => {
    servico.mandar.mockRejectedValueOnce(new LinkAbertoRecusado("NOT_FOUND", "Reunião não encontrada."));
    await expect(mandar()).rejects.toMatchObject({ code: "NOT_FOUND", message: "Reunião não encontrada." });
  });
});

describe("as outras rotas do resumo por e-mail", () => {
  it("o painel é da dona da sessão", async () => {
    await chamador("dona-2").resumoPorEmail({ meetingId: ID });
    expect(servico.painel).toHaveBeenCalledWith("dona-2", ID);
  });

  it("mandar de novo leva a dona e a prova", async () => {
    await chamador("dona-3", { "user-agent": "Chrome" }).mandarResumoPorEmailDeNovo({ meetingId: ID });
    expect(servico.deNovo).toHaveBeenCalledWith({ id: 7, openId: "dona-3" }, ID, { ipAddress: "203.0.113.9", userAgent: "Chrome" });
  });

  it("o envio automático vale para a conta da sessão", async () => {
    await expect(chamador("dona-4").envioAutomaticoDoResumo({ ligado: true })).resolves.toEqual({ automatico: true });
    expect(servico.automatico).toHaveBeenCalledWith({ id: 7, openId: "dona-4" }, true, { ipAddress: "203.0.113.9", userAgent: undefined });
    await expect(chamador("dona-4").envioAutomaticoDoResumo({ ligado: "sim" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
