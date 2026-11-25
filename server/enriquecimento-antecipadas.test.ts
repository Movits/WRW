import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O Chat de Enriquecimento diante de "Não sei o telefone. O que ela tem para oferecer: Exportação de café."
 * (conferência de tela do pacote do match, 20/11/2026, contato K1 da Minha Rede).
 *
 * O assistente repetia "Qual é o telefone dele/dela?" e o "possui" sumia: só o "não sei" SOZINHO pulava a pergunta
 * (`isSkipResponse`), e a IA só podia devolver o campo da pergunta da vez. O que se trava aqui:
 *
 * 1. Nada saiu da pergunta da vez e a resposta diz que não sabe: pula, como o "não sei" sozinho. Sem o "não sei",
 *    continua pedindo de novo (a resposta vaga não pula).
 * 2. O dado de uma pergunta SEGUINTE fica guardado na mensagem da usuária (metadata.antecipadas) e vira cartão quando
 *    o roteiro chega à pergunta dele — por confirmar, ignorar ou pular a anterior. Nada entra sozinho: é cartão.
 * 3. O de pergunta que já passou, ou de confiança baixa, não fica guardado.
 *
 * O router de verdade (createCaller), com a IA e o banco simulados, como em enriquecimento-conversa.test.ts.
 */

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

type Mensagem = { id: string; role: string; content: string; metadata: unknown; createdAt: number };
const estado = vi.hoisted(() => ({
  etapa: 0,
  /** As mensagens da sessão, da mais nova para a mais velha (a ordem de getEnrichmentMessages). */
  mensagens: [] as Mensagem[],
  pendentes: [] as unknown[],
  sugestao: null as unknown,
  contadorDeMensagens: 0,
}));

const saveEnrichmentMessage = vi.fn(async (dados: { role: string; content: string; metadata?: unknown }) => {
  estado.contadorDeMensagens += 1;
  const id = `msg-${estado.contadorDeMensagens}`;
  estado.mensagens.unshift({ id, role: dados.role, content: dados.content, metadata: dados.metadata ?? null, createdAt: estado.contadorDeMensagens });
  return id;
});
const saveEnrichmentSuggestions = vi.fn(async (itens: unknown[]) => itens.map((_, i) => `sug-${i}`));
const advanceEnrichmentSession = vi.fn(async (_sessao: string, _dona: string, etapaEsperada: number) => ({ questionsAnswered: etapaEsperada + 1 }));

vi.mock("./db", async () => ({
  getDb: vi.fn(async () => null),
  exigirDb: async () => { throw new (await import("./banco-indisponivel")).BancoIndisponivel(); },
  getEnrichmentSessionById: vi.fn(async () => ({ id: "sessao-1", contactId: 42, status: "active", questionsAnswered: estado.etapa, summary: null })),
  getEnrichmentMessages: vi.fn(async (_sessao: string, _dona: string, limite = 10) => estado.mensagens.slice(0, limite)),
  saveEnrichmentMessage: (...args: unknown[]) => saveEnrichmentMessage(...(args as [never])),
  saveEnrichmentSuggestions: (...args: unknown[]) => saveEnrichmentSuggestions(...(args as [unknown[]])),
  advanceEnrichmentSession: (...args: unknown[]) => advanceEnrichmentSession(...(args as [string, string, number])),
  // T45 (24/11): o contato sem nada preenchido; o roteiro não pula nenhuma pergunta.
  camposPreenchidosDoContato: vi.fn(async () => []),
  completeEnrichmentSession: vi.fn(async () => true),
  getActiveEnrichmentSession: vi.fn(async () => null),
  createEnrichmentSession: vi.fn(),
  getEnrichmentSuggestion: vi.fn(async () => estado.sugestao),
  applyEnrichmentSuggestion: vi.fn(async () => true),
  ignoreEnrichmentSuggestion: vi.fn(async () => true),
  getEnrichmentHistory: vi.fn(async () => []),
  getPendingEnrichmentSuggestions: vi.fn(async () => estado.pendentes),
  undoEnrichmentSuggestion: vi.fn(),
  criarContextoOferecido: vi.fn(),
}));
vi.mock("./routers/consent", () => ({ hasValidConsent: vi.fn(async () => false) }));

const { enrichmentRouter } = await import("./routers/enrichment");
const { ENRICHMENT_STEPS } = await import("./enrichment-flow");

const caller = () => enrichmentRouter.createCaller({
  user: { id: 1, openId: "email_teste", email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never);

const PERGUNTA = Object.fromEntries(ENRICHMENT_STEPS.map(step => [step.fieldType, step.question])) as Record<string, string>;
const RESPOSTA_DO_K1 = "Não sei o telefone. O que ela tem para oferecer: Exportação de café.";

const respostaDaIA = (conteudo: Record<string, unknown>) => ({
  choices: [{ message: { content: JSON.stringify({ next_question: null, extracted_entities: [], pending_fields: [], session_status: "active", notes_for_user: "Confirma?", ...conteudo }) } }],
});
const enviar = (content: string) => caller().sendMessage({ sessionId: "sessao-1", contactId: 42, content });
const gravadas = () => saveEnrichmentMessage.mock.calls.map(([dados]) => dados as { role: string; content: string; metadata?: Record<string, unknown> });

beforeEach(() => {
  estado.etapa = 0;
  estado.mensagens = [];
  estado.pendentes = [];
  estado.sugestao = null;
  estado.contadorDeMensagens = 0;
  invokeLLM.mockReset();
  saveEnrichmentMessage.mockClear();
  saveEnrichmentSuggestions.mockClear();
  advanceEnrichmentSession.mockClear();
});

describe("'Não sei o telefone. O que ela tem para oferecer: Exportação de café.'", () => {
  it("pula o telefone (em vez de repetir a pergunta) e guarda o 'possui' na resposta, sem cartão agora", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({
      outros_campos: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }],
    }));

    const r = await enviar(RESPOSTA_DO_K1);

    // Antes: a mesma pergunta do telefone, de novo, e o "possui" perdido.
    expect(r.aiResponse).not.toBe(PERGUNTA.phone);
    expect(r.aiResponse).toBe(PERGUNTA.company);
    expect(advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", "email_teste", 0, true);
    expect(r.awaitingConfirmation).toBe(false);
    expect(r.suggestions).toEqual([]);
    expect(saveEnrichmentSuggestions).not.toHaveBeenCalled();
    const [daUsuaria, daPergunta] = gravadas();
    expect(daUsuaria).toMatchObject({ role: "user", content: RESPOSTA_DO_K1, metadata: { antecipadas: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }] } });
    expect(daPergunta).toMatchObject({ role: "assistant", content: PERGUNTA.company, metadata: { questionIndex: 1, fieldType: "company", skippedPrevious: true } });
  });

  it("o pedido à IA traz o campo das outras perguntas, um item por entrada: 'exportação de café e um armazém em Santos' são dois cartões, e não um", async () => {
    // Na tela (21/11), sem o "um item por entrada", a IA devolveu "exportação de café e armazém em Santos" numa
    // entrada só, que virou UMA palavra-chave no "possui" e não casaria com quem procura café nem armazém.
    invokeLLM.mockResolvedValue(respostaDaIA({}));

    await enviar("o telefone eu não sei, mas ela oferece exportação de café e tem um armazém em Santos");

    const sistema = (invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> }).messages[0].content;
    expect(sistema).toContain("\"outros_campos\"");
    expect(sistema).toMatch(/UM ITEM POR ENTRADA/);
  });

  it("a IA devolve o telefone 'Não informado' (confiança 1): não vira cartão, a pergunta é pulada e o 'possui' fica guardado", async () => {
    // Na tela (21/11): confirmado, o cartão gravaria "Não informado" no telefone do contato.
    invokeLLM.mockResolvedValue(respostaDaIA({
      extracted_entities: [{ field_type: "phone", value: "Não informado", confidence: 1 }],
      outros_campos: [
        { field_type: "assets", value: "Exportação de café", confidence: 0.9 },
        { field_type: "assets", value: "Armazém em Santos", confidence: 0.9 },
        { field_type: "company", value: "Desconhecida", confidence: 0.9 },
      ],
      notes_for_user: "Registrado que você não sabe o telefone.",
    }));

    const r = await enviar("o telefone eu não sei, mas ela oferece exportação de café e tem um armazém em Santos");

    expect(saveEnrichmentSuggestions).not.toHaveBeenCalled();
    expect(r.suggestions).toEqual([]);
    expect(r.aiResponse).toBe(PERGUNTA.company);
    expect(advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", "email_teste", 0, true);
    // A empresa "Desconhecida" também não fica guardada para depois.
    expect(gravadas()[0].metadata).toEqual({ antecipadas: [
      { field_type: "assets", value: "Exportação de café", confidence: 0.9 },
      { field_type: "assets", value: "Armazém em Santos", confidence: 0.9 },
    ] });
  });

  it("chegando à pergunta do que ela oferece (pela confirmação da empresa), o 'possui' dito antes vem como cartão, na mesma mensagem", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ outros_campos: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }] }));
    await enviar(RESPOSTA_DO_K1);
    // A empresa foi respondida e virou cartão; a usuária o confirma.
    estado.etapa = 1;
    estado.sugestao = { id: "sug-empresa", sessionId: "sessao-1", fieldType: "company", suggestedValue: "Café Brasil", status: "applied" };
    saveEnrichmentSuggestions.mockClear();

    const r = await caller().confirmSuggestion({ suggestionId: "sug-empresa" });

    expect(advanceEnrichmentSession).toHaveBeenLastCalledWith("sessao-1", "email_teste", 1, false);
    expect(r.nextQuestion).toContain(PERGUNTA.assets);
    expect(saveEnrichmentSuggestions).toHaveBeenCalledTimes(1);
    expect(saveEnrichmentSuggestions.mock.calls[0][0]).toEqual([expect.objectContaining({
      sessionId: "sessao-1", ownerId: "email_teste", contactId: 42, fieldType: "assets", suggestedValue: "Exportação de café", confidence: 0.9,
      messageId: r.nextMessageId,
    })]);
    expect(r.nextSuggestions).toEqual([{ id: "sug-0", fieldType: "assets", suggestedValue: "Exportação de café", confidence: 0.9, status: "pending" }]);
    expect(gravadas().at(-1)).toMatchObject({ role: "assistant", metadata: { questionIndex: 2, fieldType: "assets", awaitingConfirmation: true } });
  });

  it("chegando lá por um 'não sei' (a empresa), os cartões vêm na resposta e a tela espera a decisão", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ outros_campos: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }] }));
    await enviar(RESPOSTA_DO_K1);
    estado.etapa = 1;

    const r = await enviar("não sei");

    expect(r.aiResponse).toContain(PERGUNTA.assets);
    expect(r.suggestions).toEqual([{ id: "sug-0", fieldType: "assets", suggestedValue: "Exportação de café", confidence: 0.9, status: "pending" }]);
    expect(r.awaitingConfirmation).toBe(true);
  });

  it("a pergunta seguinte sem nada dito antes para ela continua só a pergunta", async () => {
    estado.etapa = 1;
    estado.sugestao = { id: "sug-empresa", sessionId: "sessao-1", fieldType: "company", suggestedValue: "Café Brasil", status: "applied" };

    const r = await caller().confirmSuggestion({ suggestionId: "sug-empresa" });

    expect(r.nextQuestion).toBe(PERGUNTA.assets);
    expect(r.nextSuggestions).toEqual([]);
    expect(saveEnrichmentSuggestions).not.toHaveBeenCalled();
  });
});

describe("pular só quando a resposta diz que não sabe", () => {
  it("nada da pergunta da vez e nenhum 'não sei': pede de novo, dizendo o que faltou e como pular (T45: antes, só repetia a pergunta)", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({}));

    const r = await enviar("Ela é ótima, conheci numa feira");

    expect(r.aiResponse).toBe(`Não encontrei um número de telefone na sua resposta. ${PERGUNTA.phone} Se não souber, responda "não sei" e eu passo para a próxima pergunta.`);
    expect(advanceEnrichmentSession).not.toHaveBeenCalled();
  });

  it("a resposta era de outra pergunta (o que ela oferece, na vez do telefone): diz que anotou para depois e o que ainda falta (T45)", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ outros_campos: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }] }));

    const r = await enviar("Ela oferece exportação de café");

    expect(r.aiResponse).toBe(`Anotei o que você contou sobre o que essa pessoa oferece para quando chegarmos lá. Para esta pergunta, ainda preciso de um número de telefone. ${PERGUNTA.phone} Se não souber, responda "não sei" e eu passo para a próxima pergunta.`);
    expect(advanceEnrichmentSession).not.toHaveBeenCalled();
    expect(gravadas()[0]).toMatchObject({ role: "user", metadata: { antecipadas: [{ field_type: "assets", value: "Exportação de café" }] } });
  });

  it("a empresa vaga ('tem uma empresa'): pede o nome, dizendo o que faltou (T45)", async () => {
    estado.etapa = 1;
    invokeLLM.mockResolvedValue(respostaDaIA({}));

    const r = await enviar("tem uma empresa");

    expect(r.aiResponse).toBe('Não encontrei o nome da empresa na sua resposta. Qual é o nome da empresa em que trabalha? Se não souber, responda "não sei" e eu passo para a próxima pergunta.');
  });

  it("o dado com confiança baixa: pede de outro jeito, dizendo o que precisa e como pular (T45)", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ extracted_entities: [{ field_type: "phone", value: "talvez 9999", confidence: 0.4 }] }));

    const r = await enviar("acho que é 9999, sei lá");

    expect(r.aiResponse).toBe('Não tenho certeza se entendi. Preciso de um número de telefone: pode dizer de outro jeito? Se não souber, responda "não sei" e eu passo para a próxima pergunta.');
  });

  it("'não sei o celular, o fixo é 3333-4444': a IA tirou o fixo, e o fixo vira cartão (não pula)", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ extracted_entities: [{ field_type: "phone", value: "3333-4444", confidence: 0.9 }] }));

    const r = await enviar("não sei o celular, o fixo é 3333-4444");

    expect(r.suggestions.map(s => s.suggestedValue)).toEqual(["3333-4444"]);
    expect(r.awaitingConfirmation).toBe(true);
    expect(advanceEnrichmentSession).not.toHaveBeenCalled();
  });
});

describe("o que fica guardado para depois", () => {
  it("telefone e 'possui' na mesma resposta: o telefone vira cartão agora e o 'possui' fica guardado", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({
      extracted_entities: [{ field_type: "phone", value: "11 99999-8888", confidence: 0.9 }],
      outros_campos: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }],
    }));

    const r = await enviar("11 99999-8888; ela exporta café");

    expect(r.suggestions.map(s => s.fieldType)).toEqual(["phone"]);
    expect(gravadas()[0].metadata).toEqual({ antecipadas: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }] });
  });

  it("o dado de outra pergunta que a IA pôs em extracted_entities também fica, com o nome da pergunta (apelido vale)", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({
      extracted_entities: [
        { field_type: "asset_tag", value: "Torrefação", confidence: 0.8 },
        { field_type: "context", value: "Feira de Milão", confidence: 0.9 },
      ],
    }));

    await enviar("não sei; ela tem torrefação, nos conhecemos na Feira de Milão");

    expect(gravadas()[0].metadata).toEqual({ antecipadas: [
      { field_type: "assets", value: "Torrefação", confidence: 0.8 },
      { field_type: "how_met", value: "Feira de Milão", confidence: 0.9 },
    ] });
  });

  it("o de pergunta que já passou e o de confiança baixa não ficam guardados", async () => {
    estado.etapa = 2; // a pergunta da vez é a do que ela oferece
    invokeLLM.mockResolvedValue(respostaDaIA({
      extracted_entities: [{ field_type: "assets", value: "Exportação de café", confidence: 0.9 }],
      outros_campos: [
        { field_type: "phone", value: "11 99999-8888", confidence: 0.95 },
        { field_type: "needs", value: "Compradores na Ásia", confidence: 0.5 },
      ],
    }));

    const r = await enviar("Exporta café; o telefone é 11 99999-8888 e talvez procure compradores");

    expect(r.suggestions.map(s => s.fieldType)).toEqual(["assets"]);
    expect(gravadas()[0].metadata ?? null).toBeNull();
  });

  it("na etapa de lista chegam todos os itens ditos antes, sem repetir o mesmo item; na de valor único, o último dito", async () => {
    invokeLLM
      .mockResolvedValueOnce(respostaDaIA({ outros_campos: [
        { field_type: "assets", value: "Exportação de café", confidence: 0.9 },
        { field_type: "relationship_type", value: "pessoal", confidence: 0.9 },
      ] }))
      .mockResolvedValueOnce(respostaDaIA({ outros_campos: [
        { field_type: "assets", value: "exportação de café", confidence: 0.9 },
        { field_type: "assets", value: "Armazém em Santos", confidence: 0.9 },
        { field_type: "relationship_type", value: "profissional", confidence: 0.9 },
      ] }));
    await enviar(RESPOSTA_DO_K1); // pula o telefone
    estado.etapa = 1;
    await enviar("Empresa não sei; ela tem armazém em Santos e a relação é profissional"); // pula a empresa e chega aos ativos

    const cartoes = saveEnrichmentSuggestions.mock.calls.at(-1)![0] as Array<{ fieldType: string; suggestedValue: string }>;
    expect(cartoes.map(c => [c.fieldType, c.suggestedValue])).toEqual([["assets", "Exportação de café"], ["assets", "Armazém em Santos"]]);

    // Na pergunta do relacionamento (valor único), o último dito: "não sei" em "como se conheceram" chega lá.
    estado.etapa = 4;
    const r = await enviar("não sei");
    expect(r.suggestions.map(s => s.suggestedValue)).toEqual(["profissional"]);
  });
});
