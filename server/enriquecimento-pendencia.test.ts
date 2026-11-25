import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Etapa 4 — a confirmação pendente é um estado do servidor, não só da tela.
 *
 * A auditoria de 04/09 achou que o cartão de sugestão só existia no estado do
 * componente: fechar o detalhe do contato o perdia (getMessages descartava as
 * sugestões), e nada impedia a usuária de responder de novo à mesma pergunta,
 * gerando outra sugestão — órfã, nunca mostrada, nunca decidida. E o valor
 * editado não tinha teto: 51 caracteres em phone varchar(50) morriam no UPDATE.
 *
 * Estes testes exercitam o router de verdade (createCaller) com IA e banco
 * simulados. Três contratos:
 *   1. sendMessage recusa (CONFLICT/SUGGESTION_PENDING) enquanto há cartão
 *      pendente e NÃO grava nada — nem "não sei" pula a etapa por cima dele.
 *   2. getMessages devolve, em cada mensagem, os cartões pendentes dela.
 *   3. confirmSuggestion respeita o teto da coluna de destino, por campo.
 */

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

const hasValidConsent = vi.fn(async () => false);
vi.mock("./routers/consent", () => ({
  hasValidConsent: (...args: unknown[]) => hasValidConsent(...(args as [])),
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));
const recalculatePrivateMatches = vi.fn(async () => ({ created: 0 }));
vi.mock("./match-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./match-service")>()),
  recalculatePrivateMatches: (...args: unknown[]) => recalculatePrivateMatches(...(args as [])),
}));

const db = {
  getEnrichmentSessionById: vi.fn(),
  getEnrichmentMessages: vi.fn(),
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
};

vi.mock("./db", async () => ({
  getDb: vi.fn(async () => null),
  // Derivado do getDb acima, como no db.ts real: sem banco, lança.
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

// questionsAnswered: 0 → a pergunta da vez é a de telefone (1ª do roteiro).
const sessao = { id: "sessao-1", contactId: 42, status: "active", questionsAnswered: 0, questionsSkipped: 0, summary: null };
const cartaoPendente = {
  id: "sug-1", sessionId: "sessao-1", messageId: "msg-ia", ownerId: DONA, contactId: 42,
  fieldType: "phone", suggestedValue: "11 99999-8888", confidence: "0.900", status: "pending",
};
const respostaDaIA = {
  choices: [{ message: { content: JSON.stringify({
    next_question: null,
    extracted_entities: [{ field_type: "phone", value: "11 99999-8888", confidence: 0.9, is_complete: true }],
    pending_fields: [],
    session_status: "active",
    notes_for_user: "Confirma: 11 99999-8888?",
  }) } }],
};

beforeEach(() => {
  vi.resetAllMocks();
  db.getEnrichmentSessionById.mockResolvedValue(sessao);
  db.getEnrichmentMessages.mockResolvedValue([]);
  db.saveEnrichmentMessage.mockResolvedValue("msg-2");
  db.saveEnrichmentSuggestions.mockImplementation(async (itens: unknown[]) => itens.map((_, i) => `sug-${i}`));
  db.advanceEnrichmentSession.mockResolvedValue({ ...sessao, questionsAnswered: 1 });
  db.getPendingEnrichmentSuggestions.mockResolvedValue([]);
  db.getEnrichmentSuggestion.mockResolvedValue(cartaoPendente);
  db.applyEnrichmentSuggestion.mockResolvedValue(true);
  db.ignoreEnrichmentSuggestion.mockResolvedValue(true);
  invokeLLM.mockResolvedValue(respostaDaIA);
});

describe("pendência é POR ETAPA — órfã de etapa anterior não bloqueia nem avança", () => {
  // Sessão já na 2ª pergunta (empresa); a pendente é de telefone (1ª pergunta):
  // é órfã do defeito antigo (ou de uma corrida entre abas).
  const sessaoNaEmpresa = { ...sessao, questionsAnswered: 1 };
  const orfaDeTelefone = { ...cartaoPendente, id: "sug-orfa", fieldType: "phone" };
  const respostaEmpresa = { sessionId: "sessao-1", contactId: 42, content: "trabalha na ACME" };

  it("sendMessage ignora a órfã (sem avançar) e segue com a resposta da pergunta atual", async () => {
    db.getEnrichmentSessionById.mockResolvedValue(sessaoNaEmpresa);
    db.getPendingEnrichmentSuggestions.mockResolvedValue([orfaDeTelefone]);
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      next_question: null, extracted_entities: [{ field_type: "company", value: "ACME", confidence: 0.9, is_complete: true }],
      pending_fields: [], session_status: "active", notes_for_user: "Confirma: ACME?",
    }) } }] });
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(respostaEmpresa);

    // Mutante "limit(1) e CONFLICT em qualquer pendente": aqui recusaria e travaria a conversa.
    expect(r.awaitingConfirmation).toBe(true);
    expect(db.ignoreEnrichmentSuggestion).toHaveBeenCalledWith("sug-orfa", DONA);
    expect(db.advanceEnrichmentSession).not.toHaveBeenCalled();
    expect(db.saveEnrichmentMessage).toHaveBeenCalled();
  });

  it("pendente da etapa atual continua bloqueando, mesmo com órfã junto", async () => {
    db.getEnrichmentSessionById.mockResolvedValue(sessaoNaEmpresa);
    const daEmpresa = { ...cartaoPendente, id: "sug-empresa", fieldType: "company", suggestedValue: "ACME" };
    db.getPendingEnrichmentSuggestions.mockResolvedValue([daEmpresa, orfaDeTelefone]);
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.sendMessage(respostaEmpresa)).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.ignoreEnrichmentSuggestion).toHaveBeenCalledWith("sug-orfa", DONA);
    expect(db.ignoreEnrichmentSuggestion).not.toHaveBeenCalledWith("sug-empresa", DONA);
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
  });

  it("getMessages só vira cartão a pendente da etapa atual — a órfã fica invisível", async () => {
    db.getEnrichmentSessionById.mockResolvedValue(sessaoNaEmpresa);
    const base = { sessionId: "sessao-1", ownerId: DONA, metadata: null, tokenCount: null, updatedAt: 0 };
    db.getEnrichmentMessages.mockResolvedValue([
      { ...base, id: "msg-ia-2", role: "assistant", content: "Confirma: ACME?", createdAt: 5 },
      { ...base, id: "msg-ia", role: "assistant", content: "Confirma: 11 99999-8888?", createdAt: 3 },
    ]);
    const daEmpresa = { ...cartaoPendente, id: "sug-empresa", messageId: "msg-ia-2", fieldType: "company", suggestedValue: "ACME" };
    db.getPendingEnrichmentSuggestions.mockResolvedValue([daEmpresa, orfaDeTelefone]);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.getMessages({ sessionId: "sessao-1", limit: 30 });

    expect(r.find(m => m.id === "msg-ia")?.suggestions).toEqual([]);
    expect(r.find(m => m.id === "msg-ia-2")?.suggestions).toEqual([
      { id: "sug-empresa", fieldType: "company", suggestedValue: "ACME", confidence: 0.9, status: "pending" },
    ]);
  });

  it("confirmar/ignorar uma órfã grava a decisão mas NÃO avança o roteiro", async () => {
    db.getEnrichmentSessionById.mockResolvedValue(sessaoNaEmpresa);
    db.getEnrichmentSuggestion.mockResolvedValue(orfaDeTelefone);
    const caller = enrichmentRouter.createCaller(ctx);

    const confirmada = await caller.confirmSuggestion({ suggestionId: "sug-orfa" });
    expect(confirmada).toMatchObject({ status: "applied", nextQuestion: null, sessionComplete: false });
    expect(db.applyEnrichmentSuggestion).toHaveBeenCalledWith("sug-orfa", DONA, undefined);

    const ignorada = await caller.ignoreSuggestion({ suggestionId: "sug-orfa" });
    expect(ignorada).toMatchObject({ status: "ignored", nextQuestion: null, sessionComplete: false });

    // Mutante "avança sempre": a pergunta da empresa contaria como respondida sem resposta.
    expect(db.advanceEnrichmentSession).not.toHaveBeenCalled();
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
  });
});

describe("sendMessage — uma decisão por vez", () => {
  const novaResposta = { sessionId: "sessao-1", contactId: 42, content: "na verdade é 11 98888-7777" };

  it("recusa nova resposta enquanto há cartão pendente e não grava nada", async () => {
    db.getPendingEnrichmentSuggestions.mockResolvedValue([cartaoPendente]);
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.sendMessage(novaResposta)).rejects.toMatchObject({ code: "CONFLICT", message: "SUGGESTION_PENDING" });

    // Mutante "sem guarda": gravaria a mensagem, chamaria a IA e criaria a 2ª sugestão (órfã).
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(db.saveEnrichmentSuggestions).not.toHaveBeenCalled();
    // Privacidade por consulta: a pendência é procurada pela dona.
    expect(db.getPendingEnrichmentSuggestions).toHaveBeenCalledWith("sessao-1", DONA);
  });

  it("'não sei' com pendência também é recusado: não pula a etapa por cima do cartão", async () => {
    db.getPendingEnrichmentSuggestions.mockResolvedValue([cartaoPendente]);
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.sendMessage({ ...novaResposta, content: "não sei" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.advanceEnrichmentSession).not.toHaveBeenCalled();
    expect(db.completeEnrichmentSession).not.toHaveBeenCalled();
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
  });

  it("sem pendência, a resposta vira cartão e aí sim espera confirmação", async () => {
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.sendMessage(novaResposta);

    expect(r.awaitingConfirmation).toBe(true);
    expect(r.suggestions).toHaveLength(1);
    expect(db.saveEnrichmentSuggestions).toHaveBeenCalledTimes(1);
  });
});

describe("getMessages — o cartão pendente volta junto da mensagem dele", () => {
  it("anexa a sugestão pendente à mensagem certa, com confiança numérica, e [] nas demais", async () => {
    const base = { sessionId: "sessao-1", ownerId: DONA, metadata: null, tokenCount: null, updatedAt: 0 };
    // getEnrichmentMessages devolve em ordem decrescente; getMessages inverte.
    db.getEnrichmentMessages.mockResolvedValue([
      { ...base, id: "msg-ia", role: "assistant", content: "Confirma: 11 99999-8888?", createdAt: 3 },
      { ...base, id: "msg-usuaria", role: "user", content: "11 99999-8888", createdAt: 2 },
      { ...base, id: "msg-pergunta", role: "assistant", content: "Qual é o telefone dele/dela?", createdAt: 1 },
    ]);
    db.getPendingEnrichmentSuggestions.mockResolvedValue([cartaoPendente]);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.getMessages({ sessionId: "sessao-1", limit: 30 });

    expect(r.map(m => m.id)).toEqual(["msg-pergunta", "msg-usuaria", "msg-ia"]);
    expect(r[0].suggestions).toEqual([]);
    expect(r[1].suggestions).toEqual([]);
    expect(r[2].suggestions).toEqual([
      { id: "sug-1", fieldType: "phone", suggestedValue: "11 99999-8888", confidence: 0.9, status: "pending" },
    ]);
    expect(db.getPendingEnrichmentSuggestions).toHaveBeenCalledWith("sessao-1", DONA);
  });
});

describe("confirmSuggestion — o valor editado respeita a coluna de destino", () => {
  it("telefone com 51 caracteres é recusado com BAD_REQUEST antes de tocar no contato", async () => {
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.confirmSuggestion({ suggestionId: "sug-1", editedValue: "9".repeat(51) }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("50") });

    // Mutante "sem teto": applyEnrichmentSuggestion rodaria e o UPDATE em phone varchar(50) falharia.
    expect(db.applyEnrichmentSuggestion).not.toHaveBeenCalled();
    expect(db.advanceEnrichmentSession).not.toHaveBeenCalled();
  });

  it("telefone com 50 caracteres passa e a conversa avança para a próxima pergunta", async () => {
    const caller = enrichmentRouter.createCaller(ctx);
    const valor = "9".repeat(50);

    const r = await caller.confirmSuggestion({ suggestionId: "sug-1", editedValue: valor });

    expect(db.applyEnrichmentSuggestion).toHaveBeenCalledWith("sug-1", DONA, valor);
    expect(r).toMatchObject({ status: "applied", nextQuestion: "Em qual empresa trabalha?", nextMessageId: "msg-2", sessionComplete: false });
  });

  it("o teto é por campo: 'como se conheceram' aceita um texto de 300 caracteres", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue({ ...cartaoPendente, fieldType: "how_met", suggestedValue: "numa feira" });
    const caller = enrichmentRouter.createCaller(ctx);

    await caller.confirmSuggestion({ suggestionId: "sug-1", editedValue: "Conhecemos na feira ".repeat(15) });

    expect(db.applyEnrichmentSuggestion).toHaveBeenCalledTimes(1);
  });

  it("valor só de espaços é recusado (não marca a sugestão como aplicada com nada)", async () => {
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.confirmSuggestion({ suggestionId: "sug-1", editedValue: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.applyEnrichmentSuggestion).not.toHaveBeenCalled();
  });

  it("acima de 2000 caracteres nem entra: o zod barra qualquer campo", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue({ ...cartaoPendente, fieldType: "how_met" });
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.confirmSuggestion({ suggestionId: "sug-1", editedValue: "x".repeat(2001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.applyEnrichmentSuggestion).not.toHaveBeenCalled();
  });

  it("sugestão de outra dona (ou inexistente) é NOT_FOUND sem aplicar nada", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue(null);
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.confirmSuggestion({ suggestionId: "sug-alheia" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.getEnrichmentSuggestion).toHaveBeenCalledWith("sug-alheia", DONA);
    expect(db.applyEnrichmentSuggestion).not.toHaveBeenCalled();
  });
});

describe("etapa de lista — vários cartões da mesma pergunta; o roteiro só anda quando o último é decidido", () => {
  // questionsAnswered: 2 → a pergunta da vez é a de "o que oferece" (lista).
  const sessaoNosAtivos = { ...sessao, questionsAnswered: 2 };
  const mina = { ...cartaoPendente, id: "sug-mina", fieldType: "assets", suggestedValue: "mina de lítio", messageId: "msg-ia" };
  const fabrica = { ...cartaoPendente, id: "sug-fabrica", fieldType: "assets", suggestedValue: "fábrica de baterias", messageId: "msg-ia" };

  beforeEach(() => {
    db.getEnrichmentSessionById.mockResolvedValue(sessaoNosAtivos);
    db.advanceEnrichmentSession.mockResolvedValue({ ...sessaoNosAtivos, questionsAnswered: 3 });
  });

  it("getMessages anexa TODAS as pendentes da etapa à mensagem delas, da mais velha para a mais nova", async () => {
    const base = { sessionId: "sessao-1", ownerId: DONA, metadata: null, tokenCount: null, updatedAt: 0 };
    db.getEnrichmentMessages.mockResolvedValue([
      { ...base, id: "msg-ia", role: "assistant", content: "Confirma os dois?", createdAt: 3 },
      { ...base, id: "msg-usuaria", role: "user", content: "mina e fábrica", createdAt: 2 },
    ]);
    // O banco devolve da mais nova para a mais velha.
    db.getPendingEnrichmentSuggestions.mockResolvedValue([{ ...fabrica, createdAt: 2 }, { ...mina, createdAt: 1 }]);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.getMessages({ sessionId: "sessao-1", limit: 30 });

    // Mutante "daEtapaAtual[0]": só um cartão voltaria ao reabrir o contato.
    expect(r.find(m => m.id === "msg-ia")?.suggestions.map(s => s.id)).toEqual(["sug-mina", "sug-fabrica"]);
    expect(r.find(m => m.id === "msg-usuaria")?.suggestions).toEqual([]);
  });

  it("confirmar um cartão com outro ainda pendente: grava, NÃO avança e diz quantos faltam", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue(mina);
    db.getPendingEnrichmentSuggestions.mockResolvedValue([fabrica]); // depois de aplicar a mina
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.confirmSuggestion({ suggestionId: "sug-mina" });

    expect(db.applyEnrichmentSuggestion).toHaveBeenCalledWith("sug-mina", DONA, undefined);
    expect(r).toMatchObject({ status: "applied", nextQuestion: null, sessionComplete: false, pendentesRestantes: 1 });
    // Mutante "avança a cada confirmação": a pergunta de "procura" chegaria com a fábrica ainda pendente.
    expect(db.advanceEnrichmentSession).not.toHaveBeenCalled();
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
  });

  it("decidir o último cartão (ignorar): aí sim avança e manda a próxima pergunta", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue(fabrica);
    db.getPendingEnrichmentSuggestions.mockResolvedValue([]);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.ignoreSuggestion({ suggestionId: "sug-fabrica" });

    // A etapa LIDA (2) vai junto: é o que o UPDATE condicional exige no WHERE.
    expect(db.advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", DONA, 2, true);
    expect(r).toMatchObject({ status: "ignored", nextQuestion: expect.stringMatching(/procurando/), nextMessageId: "msg-2", pendentesRestantes: 0 });
  });

  it("sendMessage continua recusando enquanto QUALQUER cartão da etapa estiver pendente", async () => {
    db.getPendingEnrichmentSuggestions.mockResolvedValue([fabrica]);
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.sendMessage({ sessionId: "sessao-1", contactId: 42, content: "e uma patente" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("outra aba avançou primeiro (o avanço condicional devolve null): não conclui nem grava pergunta em dobro", async () => {
    db.getEnrichmentSuggestion.mockResolvedValue(fabrica);
    db.getPendingEnrichmentSuggestions.mockResolvedValue([]);
    db.advanceEnrichmentSession.mockResolvedValue(null);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.confirmSuggestion({ suggestionId: "sug-fabrica" });

    // Mutante "null → fim do roteiro": a sessão seria concluída no meio.
    expect(r).toMatchObject({ status: "applied", nextQuestion: null, sessionComplete: false });
    expect(db.completeEnrichmentSession).not.toHaveBeenCalled();
    expect(db.saveEnrichmentMessage).not.toHaveBeenCalled();
  });
});

describe("undoSuggestion — o Histórico IA desfaz de verdade", () => {
  it("'indisponivel' (ignorada, já desfeita ou sem retrato) → BAD_REQUEST UNDO_UNAVAILABLE", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "indisponivel" });
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.undoSuggestion({ suggestionId: "sug-1" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "UNDO_UNAVAILABLE" });
    expect(db.undoEnrichmentSuggestion).toHaveBeenCalledWith("sug-1", DONA);
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("'nao_encontrada' (outra dona) → NOT_FOUND SUGGESTION_NOT_FOUND", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "nao_encontrada" });
    const caller = enrichmentRouter.createCaller(ctx);

    await expect(caller.undoSuggestion({ suggestionId: "sug-alheia" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "SUGGESTION_NOT_FOUND" });
  });

  it("'ja_desfeita' (antes, ou por outra aba agora) → NOT_FOUND SUGGESTION_ALREADY_UNDONE, que a tela distingue do erro comum", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "ja_desfeita" });
    const caller = enrichmentRouter.createCaller(ctx);

    // Mutante "ja_desfeita cai no BAD_REQUEST genérico": a tela mostraria
    // "Erro ao desfazer." com o botão ainda ligado.
    await expect(caller.undoSuggestion({ suggestionId: "sug-1" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "SUGGESTION_ALREADY_UNDONE" });
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("tag desfeita com o termo vigente: recalcula os matches SEM e-mail; devolve reverted", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "desfeita", kind: "tag", fieldType: "assets", reverted: true, motivo: null });
    hasValidConsent.mockResolvedValue(true);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.undoSuggestion({ suggestionId: "sug-1" });

    expect(r).toEqual({ success: true, status: "undone", reverted: true, motivo: null });
    // Mutante "com e-mail": remover uma tag não é oportunidade nova para avisar.
    expect(recalculatePrivateMatches).toHaveBeenCalledWith(DONA);
  });

  it("tag desfeita sem o termo: nada de recálculo (cruzamento exige o termo)", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "desfeita", kind: "tag", fieldType: "needs", reverted: true, motivo: null });
    hasValidConsent.mockResolvedValue(false);
    const caller = enrichmentRouter.createCaller(ctx);

    await caller.undoSuggestion({ suggestionId: "sug-1" });

    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("campo desfeito: sem recálculo, e o motivo de não ter revertido chega à tela", async () => {
    db.undoEnrichmentSuggestion.mockResolvedValue({ resultado: "desfeita", kind: "campo", fieldType: "phone", reverted: false, motivo: "valor_alterado_depois" });
    hasValidConsent.mockResolvedValue(true);
    const caller = enrichmentRouter.createCaller(ctx);

    const r = await caller.undoSuggestion({ suggestionId: "sug-1" });

    expect(r).toMatchObject({ status: "undone", reverted: false, motivo: "valor_alterado_depois" });
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });
});
