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

  it("o prompt leva o NOME do idioma, e a resposta devolve o código normalizado", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: "Talk" }] } }] });
    const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "en-US" });
    expect(JSON.stringify(corpoPedido)).toContain("O idioma predominante esperado é inglês.");
    expect(JSON.stringify(corpoPedido)).not.toContain("en-US");
    expect(resultado.language).toBe("en");
  });

  it("sem idioma, ou com um que a IA não transcreve, o prompt não pede idioma e o código é o padrão pt-BR", async () => {
    for (const language of [undefined, "xx"]) {
      responderCom({ candidates: [{ content: { parts: [{ text: "Fala" }] } }] });
      const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language });
      expect(JSON.stringify(corpoPedido)).not.toContain("idioma predominante");
      expect(resultado.language).toBe("pt-BR");
    }
  });

  it("G16: um idioma fora dos 10 da tela (italiano) vai pelo nome em português e volta com o código dele", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: "Buongiorno" }] } }] });
    const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "it" });
    expect(JSON.stringify(corpoPedido)).toContain("O idioma predominante esperado é italiano.");
    expect(resultado.language).toBe("it");
  });

  it("G16: \"Detectar sozinho\" não diz o idioma, pede o JSON com o idioma e grava o código que a IA reconheceu", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcricao: "Hello everyone. Bom dia a todos.", idioma: "en-GB" }) }] } }] });
    const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "auto" });
    expect(resultado).toEqual({ text: "Hello everyone. Bom dia a todos.", language: "en", segments: [] });
    const pedido = corpoPedido as { contents: Array<{ parts: Array<{ text?: string }> }>; generationConfig: Record<string, any> };
    expect(pedido.contents[0].parts[0].text).toContain("O idioma não foi informado");
    expect(pedido.contents[0].parts[0].text).not.toContain("predominante esperado");
    expect(pedido.generationConfig.responseMimeType).toBe("application/json");
    expect(pedido.generationConfig.responseSchema.required).toEqual(["transcricao", "idioma"]);
  });

  it("G16: em \"Detectar sozinho\", o idioma que não veio (ou não é da lista) vira o padrão, e a resposta sem JSON é erro", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcricao: "Fala.", idioma: "klingon" }) }] } }] });
    expect((await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "auto" })).language).toBe("pt-BR");
    responderCom({ candidates: [{ content: { parts: [{ text: "não é json" }] } }] });
    await expect(transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "auto" })).rejects.toThrow("O Gemini não retornou uma transcrição válida.");
    responderCom({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcricao: "   ", idioma: "pt" }) }] } }] });
    await expect(transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "auto" })).rejects.toThrow("O Gemini não retornou uma transcrição válida.");
  });

  it("a reunião antiga, gravada como 'pt', pede português do Brasil", async () => {
    responderCom({ candidates: [{ content: { parts: [{ text: "Fala" }] } }] });
    const resultado = await transcribeWithGemini({ audio: Buffer.from("audio"), mimeType: "audio/mpeg", language: "pt" });
    expect(JSON.stringify(corpoPedido)).toContain("O idioma predominante esperado é português do Brasil.");
    expect(resultado.language).toBe("pt-BR");
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
