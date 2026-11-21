import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chamada genérica com arquivo inline (H12): o PDF do documento e o áudio da
 * parte passam por ela. Não fala com a internet: o fetch é trocado, como em
 * server/transcricao-de-fatia.test.ts (que segue conferindo o áudio, sem
 * regressão), e o módulo de ambiente também (a chave nunca sai daqui).
 */
const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const {
  ArquivoForaDoTetoDoGeminiError, gerarComArquivoNoGemini, gerarComAudioNoGemini, GeminiRespostaCortadaError, GeminiSemTextoError,
  TETO_INLINE_DO_AUDIO_BYTES, TETO_INLINE_DO_GEMINI_BYTES,
} = await import("./gemini");
const { TAMANHO_MAXIMO_DA_PARTE } = await import("./fatias-de-reuniao");

let fetchOriginal: typeof globalThis.fetch;
let pedidos: Array<{ url: string; corpo: Record<string, any> }> = [];

function responder(...respostas: Array<{ status?: number; corpo: unknown }>) {
  let i = 0;
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push({ url: String(entrada), corpo: JSON.parse(String(init?.body)) });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}
const resposta = (texto: string, finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { parts: [{ text: "pensando...", thought: true }, { text: texto }] } }],
});

beforeEach(() => {
  fetchOriginal = globalThis.fetch;
  pedidos = [];
  vi.stubEnv("LLM_AUDIO_MODEL", "gemini-3.5-flash");
  vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-2.5-flash");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PDF = Buffer.from("%PDF-1.4\n% teste\n%%EOF\n");

describe("gerarComArquivoNoGemini", () => {
  it("manda o arquivo inline com o tipo dado, o esquema, o teto de saída e o prazo de quem chama", async () => {
    responder({ corpo: resposta('{"paginas":[]}') });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const r = await gerarComArquivoNoGemini({
      bytes: PDF, mimeType: "application/pdf", prompt: "Leia.", esquemaJson: { type: "OBJECT" },
      tetoInlineBytes: 15_000_000, saidaMaxima: 65_536, timeoutMs: 6 * 60_000, orcamentoMs: 7 * 60_000,
    });
    expect(r).toEqual({ texto: '{"paginas":[]}', modelo: "gemini-3.5-flash" });
    const [parteDoTexto, parteDoArquivo] = pedidos[0].corpo.contents[0].parts;
    expect(parteDoTexto).toEqual({ text: "Leia." });
    expect(parteDoArquivo).toEqual({ inline_data: { mime_type: "application/pdf", data: PDF.toString("base64") } });
    expect(pedidos[0].corpo.generationConfig).toMatchObject({
      temperature: 0, maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json", responseSchema: { type: "OBJECT" },
    });
    expect(timeout).toHaveBeenCalledWith(6 * 60_000);
  });

  it("sem os opcionais, vale o padrão da parte do áudio (32 mil tokens, 5 min) e não pede JSON", async () => {
    responder({ corpo: resposta("texto") });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await gerarComArquivoNoGemini({ bytes: PDF, mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: 1000 });
    expect(pedidos[0].corpo.generationConfig.maxOutputTokens).toBe(32_768);
    expect(pedidos[0].corpo.generationConfig.responseMimeType).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(5 * 60_000);
  });

  it("o arquivo acima do teto de quem chama, ou vazio, é recusado ANTES de qualquer chamada", async () => {
    responder({ corpo: resposta("nunca") });
    const grande = await gerarComArquivoNoGemini({ bytes: Buffer.alloc(11), mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: 10 }).catch(e => e);
    expect(grande).toBeInstanceOf(ArquivoForaDoTetoDoGeminiError);
    expect(grande).toMatchObject({ bytes: 11, teto: 10 });
    const vazio = await gerarComArquivoNoGemini({ bytes: Buffer.alloc(0), mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: 10 }).catch(e => e);
    expect(vazio).toBeInstanceOf(ArquivoForaDoTetoDoGeminiError);
    expect(pedidos).toHaveLength(0);
  });

  it("o teto de quem chama nunca passa dos 50 MB do Gemini", async () => {
    responder({ corpo: resposta("nunca") });
    const erro = await gerarComArquivoNoGemini({
      bytes: Buffer.alloc(TETO_INLINE_DO_GEMINI_BYTES + 1), mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: Number.MAX_SAFE_INTEGER,
    }).catch(e => e);
    expect(erro).toBeInstanceOf(ArquivoForaDoTetoDoGeminiError);
    expect(erro.teto).toBe(50_000_000);
    expect(pedidos).toHaveLength(0);
  });

  it("STOP sem texto é GeminiSemTextoError (com a frase de sempre); outro fim é resposta cortada, com o motivo", async () => {
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "pensei", thought: true }] } }] } });
    const vazio = await gerarComArquivoNoGemini({ bytes: PDF, mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: 1000 }).catch(e => e);
    expect(vazio).toBeInstanceOf(GeminiSemTextoError);
    expect(vazio.message).toBe("O Gemini não retornou uma transcrição válida.");

    responder({ corpo: resposta('{"paginas":[', "MAX_TOKENS") });
    const cortada = await gerarComArquivoNoGemini({ bytes: PDF, mimeType: "application/pdf", prompt: "Leia.", tetoInlineBytes: 1000 }).catch(e => e);
    expect(cortada).toBeInstanceOf(GeminiRespostaCortadaError);
    expect(cortada.motivo).toBe("MAX_TOKENS");
  });
});

describe("gerarComAudioNoGemini passa pela chamada genérica, sem regressão", () => {
  it("o teto do áudio é o da parte da gravação em partes (os dois números não podem divergir)", () => {
    expect(TETO_INLINE_DO_AUDIO_BYTES).toBe(TAMANHO_MAXIMO_DA_PARTE);
  });

  it("a parte no teto vai; um byte acima é recusada antes da chamada", async () => {
    responder({ corpo: resposta('{"segmentos":[]}') });
    await gerarComAudioNoGemini({ audio: Buffer.alloc(TETO_INLINE_DO_AUDIO_BYTES), mimeType: "audio/mp4", prompt: "Transcreva." });
    expect(pedidos).toHaveLength(1);
    const erro = await gerarComAudioNoGemini({ audio: Buffer.alloc(TETO_INLINE_DO_AUDIO_BYTES + 1), mimeType: "audio/mp4", prompt: "Transcreva." }).catch(e => e);
    expect(erro).toBeInstanceOf(ArquivoForaDoTetoDoGeminiError);
    expect(pedidos).toHaveLength(1);
  });

  it("o tipo do áudio segue traduzido para o nome que o Gemini espera (mpeg → mp3, m4a → mp4)", async () => {
    responder({ corpo: resposta("{}") }, { corpo: resposta("{}") });
    await gerarComAudioNoGemini({ audio: Buffer.from("a"), mimeType: "audio/mpeg", prompt: "T." });
    await gerarComAudioNoGemini({ audio: Buffer.from("a"), mimeType: "audio/m4a", prompt: "T." });
    expect(pedidos.map(p => p.corpo.contents[0].parts[1].inline_data.mime_type)).toEqual(["audio/mp3", "audio/mp4"]);
  });
});
