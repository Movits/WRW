import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas dos modelos de resumo da dona e das preferências (H4e), com o
 * serviço dublado: a dona é a da sessão, a entrada é validada antes do
 * serviço (o modelo como texto, o ícone da lista, os tamanhos) e as mudanças
 * gastam o teto próprio. O que o serviço faz no banco está em
 * server/modelos-proprios.integracao.test.ts.
 */
const servico = vi.hoisted(() => ({
  modelosEPreferenciasDaDona: vi.fn(async () => ({ proprios: [], padrao: "general", estilo: "balanced", ajusteDoTamanho: 0 })),
  refazeresQueRestam: vi.fn(async () => 20),
  criarModeloProprio: vi.fn(async () => ({ id: "m1" })),
  editarModeloProprio: vi.fn(async () => ({ id: "m1" })),
  apagarModeloProprio: vi.fn(async () => ({ id: "m1" })),
  definirPreferencias: vi.fn(async () => ({})),
  definirPedidoDoResumo: vi.fn(async () => ({ pedido: null })),
  responderTamanhoDoResumo: vi.fn(async () => ({ resposta: "short", ajusteDoTamanho: 1 })),
}));
vi.mock("./modelos-proprios", () => servico);
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { meetingsRouter } = await import("./routers/meetings");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const MODELO = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
}) as never;
const daDona = (openId = `dona-${Math.random()}`) => meetingsRouter.createCaller(contexto(openId));

beforeEach(() => {
  for (const f of Object.values(servico)) f.mockClear();
});

describe("rotas dos modelos de resumo (H4e)", () => {
  it("a dona é a da sessão em todas, e a lista leva quantos refazeres restam", async () => {
    const rota = daDona("dona-1");
    expect(await rota.modelosDeResumo()).toMatchObject({ padrao: "general", refazeresQueRestam: 20 });
    await rota.criarModeloDeResumo({ nome: "Entrevista", icone: "🎤", instrucoes: "Destaque as perguntas." });
    await rota.editarModeloDeResumo({ id: MODELO, nome: "Entrevista", icone: "🎤", instrucoes: "Só as perguntas." });
    await rota.apagarModeloDeResumo({ id: MODELO });
    await rota.definirPreferenciasDoResumo({ padrao: `proprio:${MODELO}`, estilo: "concise" });
    await rota.definirPedidoDoResumo({ meetingId: ID, pedido: { modelo: "ia", estilo: "detailed", instrucoes: "Cite os prazos." } });
    await rota.definirPedidoDoResumo({ meetingId: ID, pedido: null });
    await rota.responderTamanhoDoResumo({ meetingId: ID, resposta: "short" });
    expect(servico.modelosEPreferenciasDaDona).toHaveBeenCalledWith("dona-1");
    expect(servico.refazeresQueRestam).toHaveBeenCalledWith("dona-1");
    expect(servico.criarModeloProprio).toHaveBeenCalledWith("dona-1", { nome: "Entrevista", icone: "🎤", instrucoes: "Destaque as perguntas." });
    expect(servico.editarModeloProprio).toHaveBeenCalledWith("dona-1", MODELO, expect.objectContaining({ instrucoes: "Só as perguntas." }));
    expect(servico.apagarModeloProprio).toHaveBeenCalledWith("dona-1", MODELO);
    expect(servico.definirPreferencias).toHaveBeenCalledWith("dona-1", { padrao: `proprio:${MODELO}`, estilo: "concise" });
    expect(servico.definirPedidoDoResumo).toHaveBeenNthCalledWith(1, "dona-1", ID, { modelo: "ia", estilo: "detailed", instrucoes: "Cite os prazos." });
    expect(servico.definirPedidoDoResumo).toHaveBeenNthCalledWith(2, "dona-1", ID, null);
    expect(servico.responderTamanhoDoResumo).toHaveBeenCalledWith("dona-1", ID, "short");
  });

  it("a entrada é recusada antes do serviço: modelo que não é escolha, ícone fora da lista, texto longo demais, resposta desconhecida", async () => {
    const rota = daDona();
    const recusas = [
      rota.definirPreferenciasDoResumo({ padrao: "vendas", estilo: "concise" }),
      rota.definirPreferenciasDoResumo({ padrao: "proprio:123", estilo: "concise" }),
      rota.definirPreferenciasDoResumo({ padrao: "general", estilo: "longo" as never }),
      rota.criarModeloDeResumo({ nome: "X", icone: "<b>" as never, instrucoes: "Y" }),
      rota.criarModeloDeResumo({ nome: "X", icone: "🎤", instrucoes: "y".repeat(3001) }),
      rota.criarModeloDeResumo({ nome: "   ", icone: "🎤", instrucoes: "Y" }),
      rota.definirPedidoDoResumo({ meetingId: ID, pedido: { modelo: "general", estilo: "balanced", instrucoes: "z".repeat(1001) } }),
      rota.responderTamanhoDoResumo({ meetingId: ID, resposta: "medio" as never }),
      rota.refazerResumo({ meetingId: ID, modelo: "proprio:nao-e-id" }),
    ];
    for (const recusa of recusas) await expect(recusa).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const f of Object.values(servico)) expect(f).not.toHaveBeenCalled();
  });

  it("as mudanças gastam o teto próprio, por dona; a lista não gasta", async () => {
    const rota = daDona("dona-teto");
    for (let i = 0; i < 60; i++) await rota.responderTamanhoDoResumo({ meetingId: ID, resposta: "right" });
    await expect(rota.criarModeloDeResumo({ nome: "X", icone: "🎤", instrucoes: "Y" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(rota.modelosDeResumo()).resolves.toBeDefined();
    await expect(daDona("outra").criarModeloDeResumo({ nome: "X", icone: "🎤", instrucoes: "Y" })).resolves.toEqual({ id: "m1" });
  });
});
