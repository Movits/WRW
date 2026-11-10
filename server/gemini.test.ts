import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Este arquivo NÃO fala com a internet.
 *
 * O teste do embedding chamava a API do Google de verdade a cada `pnpm test`:
 * gastava cota, dependia de rede, mandava texto para fora, e só passava na
 * máquina de quem tivesse chave configurada. Quem não tinha via a suíte
 * vermelha por um motivo que não era o código — foi assim que a primeira
 * execução do CI ficou vermelha.
 *
 * Apagar a variável de ambiente no teste não bastava, por dois motivos que
 * valem registrar: `ENV` lê `process.env` no import, então mexer depois não tem
 * efeito; e a chave tem duas fontes de fallback (`LLM_API_KEY`,
 * `GOOGLE_API_KEY`), então apagar uma deixa a outra valendo. Por isso o
 * módulo de ambiente é trocado por inteiro.
 *
 * A conferência contra a API real continua existindo, em
 * `server/gemini.integracao.test.ts`, fora do caminho de todo mundo.
 */

const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const { embedWithGemini, transcribeWithGemini } = await import("./gemini");

let fetchOriginal: typeof globalThis.fetch;
let urlPedida = "";
let corpoPedido: Record<string, unknown> | null = null;

function responderCom(payload: unknown) {
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    urlPedida = String(entrada);
    corpoPedido = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  fetchOriginal = globalThis.fetch;
  ambiente.ENV.llmApiKey = "chave-de-teste-que-nunca-sai-daqui";
  // O modelo de áudio sai do ambiente (LLM_AUDIO_MODEL): o .env de quem roda a
  // suíte não pode trocar o modelo que o teste espera.
  vi.stubEnv("LLM_AUDIO_MODEL", undefined);
  urlPedida = "";
  corpoPedido = null;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
});

describe("Gemini — o pedido que montamos e a resposta que lemos", () => {
  it("pede o embedding ao modelo certo e devolve o vetor", async () => {
    responderCom({ embedding: { values: Array.from({ length: 768 }, (_, i) => i / 768) } });

    const vetor = await embedWithGemini("Rede privada de contatos.", "RETRIEVAL_DOCUMENT");

    expect(vetor).toHaveLength(768);
    expect(vetor.every(Number.isFinite)).toBe(true);
    expect(urlPedida).toContain(":embedContent");
    expect(corpoPedido).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT" });
  });

  it("interpreta a resposta de transcrição", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: "Transcrição de teste" }] } }] });

    const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "pt-BR" });

    expect(resultado.text).toBe("Transcrição de teste");
    expect(urlPedida).toContain("models/gemini-3.5-flash:generateContent");
  });

  it("recusa antes de sair de casa quando não há chave", async () => {
    // Falhar cedo e com mensagem clara evita a chamada sair pela metade e voltar
    // como erro genérico do provedor, que é muito mais difícil de diagnosticar.
    ambiente.ENV.llmApiKey = "";
    let saiu = false;
    globalThis.fetch = (async () => { saiu = true; return new Response("{}"); }) as typeof globalThis.fetch;

    await expect(embedWithGemini("qualquer coisa", "RETRIEVAL_DOCUMENT")).rejects.toThrow(/Chave do LLM/);
    expect(saiu).toBe(false);
  });
});
