import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * "Criar o contexto X?" do lado do router de enriquecimento.
 *
 * confirmSuggestion NUNCA cria contexto: quando "como se conheceram" não casou
 * com nenhum, só devolve o nome para o chat perguntar. Quem cria é
 * createSuggestedContext, chamado apenas pelo "Criar" da dona. Se ela disser
 * "Agora não", nenhum procedimento é chamado — e sem essa chamada nada existe.
 *
 * Mesmo padrão de enriquecimento-pendencia.test.ts: router de verdade
 * (createCaller) com o banco simulado.
 */

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./routers/consent", () => ({
  hasValidConsent: vi.fn(async () => false),
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));

const db = {
  getEnrichmentSessionById: vi.fn(),
  getEnrichmentMessages: vi.fn(async () => []),
  saveEnrichmentMessage: vi.fn(),
  saveEnrichmentSuggestions: vi.fn(),
  advanceEnrichmentSession: vi.fn(),
  // T45 (24/11): o contato sem nada preenchido; o roteiro não pula nenhuma pergunta.
  camposPreenchidosDoContato: vi.fn(async () => []),
  completeEnrichmentSession: vi.fn(),
  getActiveEnrichmentSession: vi.fn(),
  createEnrichmentSession: vi.fn(),
  getEnrichmentSuggestion: vi.fn(),
  applyEnrichmentSuggestion: vi.fn(),
  ignoreEnrichmentSuggestion: vi.fn(),
  getEnrichmentHistory: vi.fn(),
  getPendingEnrichmentSuggestions: vi.fn(),
  undoEnrichmentSuggestion: vi.fn(),
  criarContextoOferecido: vi.fn(),
};

vi.mock("./db", async () => ({
  getDb: vi.fn(async () => null),
  exigirDb: async () => { throw new (await import("./banco-indisponivel")).BancoIndisponivel(); },
  ...db,
}));

const { enrichmentRouter } = await import("./routers/enrichment");

const DONA = "email_teste";
const ctx = {
  user: { id: 1, openId: DONA, email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;
const caller = enrichmentRouter.createCaller(ctx);

const sessao = { id: "sessao-1", contactId: 42, status: "active", questionsAnswered: 0, questionsSkipped: 0, summary: null };
const cartaoHowMet = {
  id: "sug-1", sessionId: "sessao-1", messageId: "msg-ia", ownerId: DONA, contactId: 42,
  fieldType: "how_met", suggestedValue: "Feira de Milão", appliedValue: null, confidence: "0.900", status: "pending", undoSnapshot: null,
};
const retrato = (contextoId: string | null) => ({ kind: "how_met", linhaDeNota: "Como se conheceram: Feira de Milão", contextoId, contextoCriado: false, vinculoId: contextoId ? "vinc-1" : null });
const aplicada = (contextoId: string | null) => ({ ...cartaoHowMet, status: "applied", appliedValue: "Feira de Milão", undoSnapshot: retrato(contextoId) });

beforeEach(() => {
  vi.resetAllMocks();
  db.getEnrichmentSessionById.mockResolvedValue(sessao);
  db.getPendingEnrichmentSuggestions.mockResolvedValue([]);
  db.applyEnrichmentSuggestion.mockResolvedValue(true);
  // T45 (24/11): o avanço lê o que o contato já tem e as respostas ditas antes da vez.
  db.getEnrichmentMessages.mockResolvedValue([]);
  db.camposPreenchidosDoContato.mockResolvedValue([]);
});

describe("confirmSuggestion — oferece, nunca cria", () => {
  it("'como se conheceram' sem contexto correspondente: devolve o nome para a pergunta e não cria nada", async () => {
    db.getEnrichmentSuggestion
      .mockResolvedValueOnce(cartaoHowMet)     // leitura antes de aplicar
      .mockResolvedValueOnce(aplicada(null));  // releitura: o retrato diz que não casou

    const r = await caller.confirmSuggestion({ suggestionId: "sug-1" });

    expect(r).toMatchObject({ contextoParaCriar: "Feira de Milão" });
    expect(db.criarContextoOferecido).not.toHaveBeenCalled();
  });

  it("'como se conheceram' que casou com contexto existente: sem oferta", async () => {
    db.getEnrichmentSuggestion
      .mockResolvedValueOnce(cartaoHowMet)
      .mockResolvedValueOnce(aplicada("ctx-1"));

    const r = await caller.confirmSuggestion({ suggestionId: "sug-1" });

    expect(r).not.toHaveProperty("contextoParaCriar");
    expect(db.criarContextoOferecido).not.toHaveBeenCalled();
  });

  it("outro campo (telefone): sem oferta e sem releitura da sugestão", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue({ ...cartaoHowMet, fieldType: "phone", suggestedValue: "11 99999-8888" });

    const r = await caller.confirmSuggestion({ suggestionId: "sug-1" });

    expect(r).not.toHaveProperty("contextoParaCriar");
    expect(db.getEnrichmentSuggestion).toHaveBeenCalledTimes(1);
  });
});

describe("createSuggestedContext — o 'Criar' da dona", () => {
  it("confirmação: cria pela sugestão da própria dona e devolve o resultado", async () => {
    db.criarContextoOferecido.mockResolvedValue({ resultado: "criado", contextoId: "ctx-novo", nome: "Feira de Milão" });

    const r = await caller.createSuggestedContext({ suggestionId: "sug-1" });

    expect(db.criarContextoOferecido).toHaveBeenCalledWith("sug-1", DONA);
    expect(r).toEqual({ resultado: "criado", contextoId: "ctx-novo", nome: "Feira de Milão" });
  });

  it("oferta que não vale mais (já aceita, desfeita, de outra dona): NOT_FOUND", async () => {
    db.criarContextoOferecido.mockResolvedValue({ resultado: "indisponivel" });

    await expect(caller.createSuggestedContext({ suggestionId: "sug-1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("o nome não vem do cliente: a entrada só aceita o id da sugestão", async () => {
    db.criarContextoOferecido.mockResolvedValue({ resultado: "criado", contextoId: "ctx-novo", nome: "Feira de Milão" });

    await caller.createSuggestedContext({ suggestionId: "sug-1", nome: "Outro nome qualquer" } as never);

    expect(db.criarContextoOferecido).toHaveBeenCalledWith("sug-1", DONA);
  });
});
