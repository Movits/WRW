import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * T45 (24/11): o Chat de Enriquecimento perguntava de novo o que a ficha do
 * contato já tinha (o telefone, a empresa, o possui...). Agora o roteiro pula
 * as perguntas já respondidas, no começo e a cada avanço, e diz quais pulou;
 * a pergunta com resposta dita antes da vez (antecipada) não se pula, porque
 * precisa virar cartão lá. O router de verdade (createCaller), com a IA e o
 * banco simulados, como em enriquecimento-antecipadas.test.ts.
 */

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

type Mensagem = { id: string; role: string; content: string; metadata: unknown; createdAt: number };
const estado = vi.hoisted(() => ({
  etapa: 0,
  mensagens: [] as Mensagem[],
  preenchidos: [] as string[],
  contador: 0,
}));

const saveEnrichmentMessage = vi.fn(async (dados: { role: string; content: string; metadata?: unknown }) => {
  estado.contador += 1;
  const id = `msg-${estado.contador}`;
  estado.mensagens.unshift({ id, role: dados.role, content: dados.content, metadata: dados.metadata ?? null, createdAt: estado.contador });
  return id;
});
const advanceEnrichmentSession = vi.fn(async (_s: string, _d: string, etapaEsperada: number, _pulada = false, destino = etapaEsperada + 1) => ({ questionsAnswered: Math.max(destino, etapaEsperada + 1) }));
const createEnrichmentSession = vi.fn(async (..._args: unknown[]) => "sessao-1");
const camposPreenchidosDoContato = vi.fn(async (_dona: string, _contato: number) => estado.preenchidos);

vi.mock("./db", async () => ({
  getDb: vi.fn(async () => null),
  exigirDb: async () => { throw new (await import("./banco-indisponivel")).BancoIndisponivel(); },
  getEnrichmentSessionById: vi.fn(async () => ({ id: "sessao-1", contactId: 42, status: "active", questionsAnswered: estado.etapa, summary: null })),
  getEnrichmentMessages: vi.fn(async (_s: string, _d: string, limite = 10) => estado.mensagens.slice(0, limite)),
  saveEnrichmentMessage: (...args: unknown[]) => saveEnrichmentMessage(...(args as [never])),
  saveEnrichmentSuggestions: vi.fn(async (itens: unknown[]) => itens.map((_, i) => `sug-${i}`)),
  advanceEnrichmentSession: (...args: unknown[]) => advanceEnrichmentSession(...(args as [string, string, number])),
  camposPreenchidosDoContato: (...args: unknown[]) => camposPreenchidosDoContato(...(args as [string, number])),
  completeEnrichmentSession: vi.fn(async () => true),
  getActiveEnrichmentSession: vi.fn(async () => null),
  createEnrichmentSession: (...args: unknown[]) => createEnrichmentSession(...args),
  getEnrichmentSuggestion: vi.fn(async () => null),
  applyEnrichmentSuggestion: vi.fn(async () => true),
  ignoreEnrichmentSuggestion: vi.fn(async () => true),
  getEnrichmentHistory: vi.fn(async () => []),
  getPendingEnrichmentSuggestions: vi.fn(async () => []),
  undoEnrichmentSuggestion: vi.fn(),
  criarContextoOferecido: vi.fn(),
}));
vi.mock("./routers/consent", () => ({ hasValidConsent: vi.fn(async () => false) }));

const { enrichmentRouter } = await import("./routers/enrichment");
const { ENRICHMENT_STEPS, avisoDasJaPreenchidas, proximaEtapaAPerguntar, explicarOQueFalta } = await import("./enrichment-flow");

const caller = () => enrichmentRouter.createCaller({
  user: { id: 1, openId: "dona-1", email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never);
const PERGUNTA = Object.fromEntries(ENRICHMENT_STEPS.map(step => [step.fieldType, step.question])) as Record<string, string>;
const respostaDaIA = (conteudo: Record<string, unknown>) => ({
  choices: [{ message: { content: JSON.stringify({ next_question: null, extracted_entities: [], pending_fields: [], session_status: "active", notes_for_user: "", ...conteudo }) } }],
});

beforeEach(() => {
  estado.etapa = 0;
  estado.mensagens = [];
  estado.preenchidos = [];
  estado.contador = 0;
  invokeLLM.mockReset();
  saveEnrichmentMessage.mockClear();
  advanceEnrichmentSession.mockClear();
  createEnrichmentSession.mockClear();
  camposPreenchidosDoContato.mockClear();
});

describe("proximaEtapaAPerguntar", () => {
  it("pula as preenchidas a partir da etapa pedida e para na primeira que falta", () => {
    expect(proximaEtapaAPerguntar(0, new Set(["phone", "company"]))).toEqual({ indice: 2, puladas: ["phone", "company"] });
    expect(proximaEtapaAPerguntar(1, new Set(["phone"]))).toEqual({ indice: 1, puladas: [] });
  });

  it("não pula a pergunta com resposta dita antes da vez (precisa virar cartão)", () => {
    expect(proximaEtapaAPerguntar(2, new Set(["assets", "needs"]), new Set(["needs"]))).toEqual({ indice: 3, puladas: ["assets"] });
  });

  it("tudo preenchido: devolve o fim do roteiro", () => {
    const todas = new Set(ENRICHMENT_STEPS.map(step => step.fieldType));
    expect(proximaEtapaAPerguntar(0, todas).indice).toBe(ENRICHMENT_STEPS.length);
  });
});

describe("os textos do roteiro", () => {
  it("o aviso das puladas diz o que a ficha já tem e onde mudar", () => {
    expect(avisoDasJaPreenchidas([])).toBe("");
    expect(avisoDasJaPreenchidas(["phone"])).toBe("Este contato já tem o telefone na ficha, então pulei essa pergunta (para mudar, edite a ficha do contato).");
    expect(avisoDasJaPreenchidas(["phone", "company", "assets"])).toContain("o telefone, a empresa e o que essa pessoa oferece");
  });

  it("a explicação do que falta não repete o próprio campo entre as anotadas", () => {
    expect(explicarOQueFalta("phone", "P?", ["phone"])).toBe('Não encontrei um número de telefone na sua resposta. P? Se não souber, responda "não sei" e eu passo para a próxima pergunta.');
  });
});

describe("startSession começa na primeira pergunta que falta", () => {
  it("com o telefone e a empresa na ficha: começa no possui e diz que pulou os dois", async () => {
    estado.preenchidos = ["phone", "company"];
    const r = await caller().startSession({ contactId: 42 });
    expect(camposPreenchidosDoContato).toHaveBeenCalledWith("dona-1", 42);
    expect(createEnrichmentSession).toHaveBeenCalledWith("dona-1", 42, 2);
    expect(r.firstQuestion).toBe(`${avisoDasJaPreenchidas(["phone", "company"])} ${PERGUNTA.assets}`);
    expect(saveEnrichmentMessage.mock.calls[0][0]).toMatchObject({ metadata: { questionIndex: 2, fieldType: "assets", jaPreenchidas: ["phone", "company"] } });
  });

  it("sem nada na ficha: começa no telefone, como antes, sem aviso", async () => {
    const r = await caller().startSession({ contactId: 42 });
    expect(createEnrichmentSession).toHaveBeenCalledWith("dona-1", 42);
    expect(r.firstQuestion).toBe(PERGUNTA.phone);
  });

  it("com tudo na ficha: começa do início (a dona abriu o chat para acrescentar)", async () => {
    estado.preenchidos = ENRICHMENT_STEPS.map(step => step.fieldType);
    const r = await caller().startSession({ contactId: 42 });
    expect(createEnrichmentSession).toHaveBeenCalledWith("dona-1", 42);
    expect(r.firstQuestion).toBe(PERGUNTA.phone);
  });
});

describe("o avanço pula as perguntas que a ficha já responde", () => {
  it("'não sei' na empresa, com o possui e o procura na ficha: vai direto a 'como se conheceram' e diz por quê", async () => {
    estado.etapa = 1;
    estado.preenchidos = ["assets", "needs"];
    invokeLLM.mockResolvedValue(respostaDaIA({}));
    const r = await caller().sendMessage({ sessionId: "sessao-1", contactId: 42, content: "não sei" });
    expect(advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", "dona-1", 1, true, 4);
    expect(r.aiResponse).toBe(`${avisoDasJaPreenchidas(["assets", "needs"])} ${PERGUNTA.how_met}`);
  });

  it("sem nada na ficha, o avanço é o de sempre (sem destino)", async () => {
    estado.etapa = 1;
    invokeLLM.mockResolvedValue(respostaDaIA({}));
    const r = await caller().sendMessage({ sessionId: "sessao-1", contactId: 42, content: "não sei" });
    expect(advanceEnrichmentSession).toHaveBeenCalledWith("sessao-1", "dona-1", 1, true);
    expect(r.aiResponse).toBe(PERGUNTA.assets);
  });
});
