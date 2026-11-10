import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O JSON do Google nunca chega à tela — provado com o gemini.ts REAL.
 *
 * Revisão adversarial da PR de Reuniões: um erro NÃO passageiro do Gemini
 * (400 chave inválida, 401/403, 404 modelo inexistente) saía de geminiPost
 * como `Error("Gemini indisponível (400): {...json do Google...}")`, e
 * processMeetingRecording gravava essa mensagem em processing_error — a caixa
 * vermelha mostrava "API key not valid", o endpoint e o nome do modelo. O
 * mesmo para a chave ausente, cuja mensagem cita LLM_API_KEY e GOOGLE_API_KEY.
 *
 * Aqui só `fetch` e o ambiente são dublados; gemini.ts e meeting-service.ts
 * são os de verdade, para o contrato valer nas duas camadas (a fonte e a
 * defesa em profundidade). O banco é um fake que captura os UPDATEs.
 */

const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-somente-para-testes" } }));
vi.mock("./_core/env", () => ambiente);

const atualizacoes: Array<Record<string, unknown>> = [];
const reuniao = { id: "reuniao-1", ownerId: "dona-1", consentGranted: true, status: "recording", updatedAt: 1_000 };
const schema = await import("../drizzle/schema");
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => ({
    select: () => ({ from: (tabela: unknown) => ({ where: () => {
      const linhas = tabela === schema.meetings ? [reuniao] : [];
      return { limit: async () => linhas, then: (resolver: (valor: unknown) => unknown) => resolver(linhas) };
    } }) }),
    update: () => ({ set: (valores: Record<string, unknown>) => ({ where: async () => { atualizacoes.push(valores); return [{ affectedRows: 1 }]; } }) }),
    insert: () => ({ values: async () => {} }),
    delete: () => ({ where: async () => {} }),
  }),
}));
vi.mock("./storage", async importOriginal => ({
  ...await importOriginal<typeof import("./storage")>(),
  storagePut: async () => ({ key: "k", url: "/manus-storage/k" }),
  storageDelete: async () => {},
  storageGetSignedUrl: async () => "https://assinada",
}));
vi.mock("./_core/llm", () => ({ invokeLLM: async () => ({ choices: [{ message: { content: '{"entities":[],"contacts":[]}' } }] }) }));
// Os bytes daqui são texto, não áudio: a medição da duração é dublada.
vi.mock("./duracao-do-audio", () => ({ medirDuracaoDoAudio: () => 30 }));

const { processMeetingRecording } = await import("./meeting-service");

const entrada = {
  meetingId: "reuniao-1", ownerId: "dona-1", mimeType: "audio/webm",
  audioBase64: Buffer.from("reuniao").toString("base64"), durationSeconds: 30, language: "pt",
} as const;

// Respostas reais da API do Google para cada recusa (texto abreviado).
const RECUSAS: Array<[number, string]> = [
  [400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}}]}}'],
  [401, '{"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.","status":"UNAUTHENTICATED"}}'],
  [403, '{"error":{"code":403,"message":"Method doesn\'t allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.","status":"PERMISSION_DENIED"}}'],
  [404, '{"error":{"code":404,"message":"models/gemini-3.5-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.","status":"NOT_FOUND"}}'],
];

let fetchFalso: ReturnType<typeof vi.fn>;
const falhaGravada = () => atualizacoes.find(a => a.status === "failed");
const registros = () => JSON.stringify(vi.mocked(console.error).mock.calls);

beforeEach(() => {
  atualizacoes.length = 0;
  ambiente.ENV.llmApiKey = "chave-somente-para-testes";
  // Principal e reserva saem do ambiente: o .env de quem roda a suíte não pode
  // decidir se a reserva dispara (o gemini.ts lê os dois a cada chamada).
  vi.stubEnv("LLM_AUDIO_MODEL", undefined);
  vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", undefined);
  fetchFalso = vi.fn();
  vi.stubGlobal("fetch", fetchFalso);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Recusa do Gemini (não passageira) — o que a dona lê é uma frase, o JSON do Google fica no log", () => {
  it.each(RECUSAS)("HTTP %i: processing_error sem 'googleapis', sem 'API key', sem chave nem JSON; uma chamada só", async (status, json) => {
    fetchFalso.mockResolvedValue({ ok: false, status, text: async () => json });

    await expect(processMeetingRecording(entrada)).rejects.toThrow(`O serviço de IA recusou a chamada (HTTP ${status}). Avise o suporte.`);

    const falha = falhaGravada();
    expect(falha?.processingError).toBe(`O serviço de IA recusou a chamada (HTTP ${status}). Avise o suporte.`);
    const texto = String(falha?.processingError);
    expect(texto).not.toContain("googleapis");
    expect(texto).not.toContain("API key");
    expect(texto).not.toContain("{");
    expect(texto).not.toContain("models/");
    // sem retentativa e sem o upload inútil na reserva
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    // o detalhe do Google está no log do servidor, para quem for diagnosticar
    expect(registros()).toContain(JSON.parse(json).error.status);
  });

  it("chave não configurada: 'Não foi possível transcrever o áudio.' — LLM_API_KEY e GOOGLE_API_KEY só no log, e nada sai para a rede", async () => {
    ambiente.ENV.llmApiKey = "";

    await expect(processMeetingRecording(entrada)).rejects.toThrow("Não foi possível transcrever o áudio.");

    const falha = falhaGravada();
    expect(falha?.processingError).toBe("Não foi possível transcrever o áudio.");
    expect(String(falha?.processingError)).not.toContain("LLM_API_KEY");
    expect(String(falha?.processingError)).not.toContain("GOOGLE_API_KEY");
    expect(registros()).toContain("LLM_API_KEY");
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sobrecarga (503 em tudo) continua passando inteira: a frase de 'alta demanda' é para a dona e não é mascarada pela defesa em profundidade", async () => {
    vi.useFakeTimers();
    try {
      fetchFalso.mockResolvedValue({ ok: false, status: 503, text: async () => '{"error":{"code":503,"status":"UNAVAILABLE"}}' });

      const promessa = processMeetingRecording(entrada);
      const expectativa = expect(promessa).rejects.toThrow(/alta demanda.*tente de novo/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await expectativa;

      expect(String(falhaGravada()?.processingError)).toMatch(/alta demanda/);
      expect(String(falhaGravada()?.processingError)).not.toContain("UNAVAILABLE");
      // 3 no modelo de áudio + 1 na reserva: a recusa é que não vai à reserva, a sobrecarga vai
      expect(fetchFalso).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
