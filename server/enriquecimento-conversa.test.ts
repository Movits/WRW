import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O fluxo da conversa de enriquecimento — os dois modos de morrer em silêncio.
 *
 * A conferência das etapas achou que a conversa travava de dois jeitos, ambos
 * sem sinal nenhum para a usuária:
 *
 *   1. IA extraía com confiança < 0.7 → o cartão era descartado mas a resposta
 *      dizia "aguardando confirmação" → a tela escondia o campo de digitar e
 *      pedia para confirmar um cartão inexistente. Só recarregar destravava.
 *   2. IA fora do ar → o erro era engolido (`.catch(() => null)`) e o fluxo
 *      repetia a MESMA pergunta para sempre, como se a usuária não tivesse
 *      sido clara.
 *
 * Estes testes exercitam o router de verdade (createCaller), com a IA e o
 * banco simulados. O contrato central: a conversa NUNCA responde
 * `awaitingConfirmation: true` sem pelo menos um cartão junto.
 */

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

const saveEnrichmentMessage = vi.fn(async () => "msg-1");
const saveEnrichmentSuggestions = vi.fn(async (itens: unknown[]) => itens.map((_, i) => `sug-${i}`));

vi.mock("./db", async () => ({
  getDb: vi.fn(async () => null),
  // Derivado do getDb acima, como no db.ts real: sem banco, lança.
  exigirDb: async () => { throw new (await import("./banco-indisponivel")).BancoIndisponivel(); },
  getEnrichmentSessionById: vi.fn(async () => ({
    id: "sessao-1", contactId: 42, status: "active", questionsAnswered: 2, summary: null,
  })),
  getEnrichmentMessages: vi.fn(async () => []),
  saveEnrichmentMessage: (...args: unknown[]) => saveEnrichmentMessage(...(args as [])),
  saveEnrichmentSuggestions: (...args: unknown[]) => saveEnrichmentSuggestions(...(args as [unknown[]])),
  advanceEnrichmentSession: vi.fn(async () => ({ questionsAnswered: 3 })),
  // T45 (24/11): o contato sem nada preenchido; o roteiro não pula nenhuma pergunta.
  camposPreenchidosDoContato: vi.fn(async () => []),
  completeEnrichmentSession: vi.fn(),
  getActiveEnrichmentSession: vi.fn(async () => null),
  createEnrichmentSession: vi.fn(),
  getEnrichmentSuggestion: vi.fn(async () => null),
  applyEnrichmentSuggestion: vi.fn(async () => true),
  ignoreEnrichmentSuggestion: vi.fn(async () => true),
  getEnrichmentHistory: vi.fn(async () => []),
  // Sem cartão pendente: o roteiro segue; a pendência tem teste próprio (enriquecimento-pendencia.test.ts).
  getPendingEnrichmentSuggestions: vi.fn(async () => []),
  undoEnrichmentSuggestion: vi.fn(),
}));

const { enrichmentRouter } = await import("./routers/enrichment");
const dbFalso = await import("./db");

const ctx = {
  user: { id: 1, openId: "email_teste", email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;

// questionsAnswered: 2 → a pergunta da vez é a de "assets" (3ª do roteiro).
const pergunta = { sessionId: "sessao-1", contactId: 42, content: "Ela tem uma fábrica de calçados" };

const respostaDaIA = (confidence: number) => ({
  choices: [{ message: { content: JSON.stringify({
    next_question: null,
    extracted_entities: [{ field_type: "assets", value: "fábrica de calçados", confidence, is_complete: true }],
    pending_fields: [],
    session_status: "active",
    notes_for_user: "Confirma: fábrica de calçados?",
  }) } }],
});

describe("Enriquecimento — a conversa nunca trava em silêncio", () => {
  beforeEach(() => {
    invokeLLM.mockReset();
    saveEnrichmentMessage.mockClear();
    saveEnrichmentSuggestions.mockClear();
  });

  it("caminho feliz: confiança alta vira cartão e aí sim espera confirmação", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA(0.9));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].suggestedValue).toBe("fábrica de calçados");
    expect(r.awaitingConfirmation).toBe(true);
    expect("aiUnavailable" in r).toBe(false);
  });

  it("confiança baixa NÃO congela: sem cartão, o campo de digitar continua aberto", async () => {
    // Antes: awaitingConfirmation true com zero cartões → tela travada.
    invokeLLM.mockResolvedValue(respostaDaIA(0.3));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    expect(r.suggestions).toHaveLength(0);
    expect(r.awaitingConfirmation).toBe(false);
    expect(r.aiResponse).toMatch(/de outro jeito/i);
    expect(saveEnrichmentSuggestions).not.toHaveBeenCalled();
  });

  it("IA fora do ar: diz a verdade em vez de repetir a pergunta para sempre", async () => {
    invokeLLM.mockRejectedValue(new Error("LLM_API_URL não definida."));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    expect(r.awaitingConfirmation).toBe(false);
    expect(r.aiResponse).toMatch(/indisponível/i);
    // e NÃO é a pergunta do roteiro repetida como se a usuária não tivesse sido clara
    expect(r.aiResponse).not.toMatch(/pode oferecer/i);
    // A tela precisa saber que a resposta dela NÃO foi gravada, para devolvê-la
    // ao campo em vez de reidratar a conversa sem ela.
    expect("aiUnavailable" in r && r.aiUnavailable).toBe(true);
  });

  it("o contrato: awaitingConfirmation true implica pelo menos um cartão", async () => {
    // A invariante que impede a tela de travar, seja qual for o caminho.
    for (const confidence of [0.9, 0.69, 0.0]) {
      invokeLLM.mockResolvedValue(respostaDaIA(confidence));
      const caller = enrichmentRouter.createCaller(ctx);
      const r = await caller.sendMessage(pergunta);
      if (r.awaitingConfirmation) expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });
});

// A reverificação de 04/09 achou `if (extracted.length > 1) extracted = [extracted[0]]`:
// "uma mina, uma fábrica e a patente" virava um cartão só, e os outros dois
// nunca chegavam a contact_assets — que é de onde a etapa 7 lê.
const respostaComAtivos = (valores: string[], fieldType = "assets") => ({
  choices: [{ message: { content: JSON.stringify({
    next_question: null,
    extracted_entities: valores.map(value => ({ field_type: fieldType, value, confidence: 0.9, is_complete: true })),
    pending_fields: [], session_status: "active", notes_for_user: "Confirma?",
  }) } }],
});

describe("Etapa de lista — cada item da resposta vira um cartão", () => {
  beforeEach(() => {
    invokeLLM.mockReset();
    saveEnrichmentMessage.mockClear();
    saveEnrichmentSuggestions.mockClear();
  });

  it("três ativos numa resposta → três cartões salvos e devolvidos, na ordem da IA", async () => {
    invokeLLM.mockResolvedValue(respostaComAtivos(["mina de lítio", "fábrica de baterias", "patente de eletrólito"]));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    // Mutante "só a primeira": saveEnrichmentSuggestions receberia 1 e a resposta teria 1.
    expect(saveEnrichmentSuggestions).toHaveBeenCalledTimes(1);
    expect(saveEnrichmentSuggestions.mock.calls[0][0]).toHaveLength(3);
    expect(r.suggestions.map(s => s.suggestedValue)).toEqual(["mina de lítio", "fábrica de baterias", "patente de eletrólito"]);
    expect(r.suggestions.map(s => s.id)).toEqual(["sug-0", "sug-1", "sug-2"]);
    expect(r.awaitingConfirmation).toBe(true);
  });

  it("o mesmo item escrito de dois jeitos é um cartão só (dedupe pelo slug), e há um teto de 10", async () => {
    const doze = Array.from({ length: 12 }, (_, i) => `ativo ${i + 1}`);
    invokeLLM.mockResolvedValue(respostaComAtivos(["Mina de lítio", "mina de litio", ...doze]));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    expect(r.suggestions).toHaveLength(10);
    expect(r.suggestions.filter(s => /mina/i.test(s.suggestedValue))).toHaveLength(1);
  });

  it("etapa de valor único (empresa) com duas entidades → um cartão só", async () => {
    // questionsAnswered: 1 → a pergunta da vez é a da empresa.
    vi.mocked(dbFalso.getEnrichmentSessionById).mockResolvedValueOnce({
      id: "sessao-1", contactId: 42, status: "active", questionsAnswered: 1, summary: null,
    } as never);
    invokeLLM.mockResolvedValue(respostaComAtivos(["ACME", "Beta Ltda"], "company"));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage({ ...pergunta, content: "na ACME, antes na Beta" });

    expect(r.suggestions.map(s => s.suggestedValue)).toEqual(["ACME"]);
  });
});

describe("A resposta da usuária só entra no histórico depois de a IA responder", () => {
  beforeEach(() => {
    invokeLLM.mockReset();
    saveEnrichmentMessage.mockClear();
    saveEnrichmentSuggestions.mockClear();
  });
  const gravadas = () => saveEnrichmentMessage.mock.calls.map(c => (c as unknown as [{ role: string }])[0].role);

  it("IA estourou o tempo: nada da usuária é gravado — reenviar não duplica a mensagem", async () => {
    invokeLLM.mockRejectedValue(new Error("LLM sem resposta em 15s"));
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(pergunta);

    expect(r.aiResponse).toMatch(/indisponível/i);
    // Mutante "gravar antes de chamar a IA": a lista teria "user".
    expect(gravadas()).not.toContain("user");
  });

  it("IA respondeu: a resposta da usuária foi no prompt em memória, e é gravada antes da resposta da IA", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA(0.9));
    const caller = enrichmentRouter.createCaller(ctx);

    await caller.sendMessage(pergunta);

    const chamada = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }>; timeoutMs: number; orcamentoMs: number };
    expect(chamada.messages.at(-1)).toEqual({ role: "user", content: pergunta.content });
    // O teto da spec da etapa 4 (segundos, não minutos) vai na própria chamada.
    expect(chamada.timeoutMs).toBe(15_000);
    expect(chamada.orcamentoMs).toBe(35_000);
    expect(gravadas()).toEqual(["user", "assistant"]);
  });

  it("'não sei' continua gravando a resposta e avança sem chamar a IA", async () => {
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage({ ...pergunta, content: "não sei" });

    expect(invokeLLM).not.toHaveBeenCalled();
    expect(gravadas()).toEqual(["user", "assistant"]);
    expect(r.awaitingConfirmation).toBe(false);
    // O avanço leva a etapa lida da sessão (2): o UPDATE condicional exige-a.
    expect(dbFalso.advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", "email_teste", 2, true);
  });
});
