import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A transcrição de uma parte da reunião (G6). Não fala com a internet: o
 * fetch é trocado, como em server/gemini.test.ts, e o módulo de ambiente
 * também (a chave nunca sai daqui).
 */
const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const { gerarComAudioNoGemini, GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError, raciocinioBaixo } = await import("./gemini");
const { contextoParaAProxima, montarTranscricao, normalizarSegmentos, promptDaFatia, transcreverFatia } = await import("./transcricao-de-fatia");

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

const respostaJson = (dado: unknown, finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { parts: [{ text: "pensando...", thought: true }, { text: JSON.stringify(dado) }] } }],
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

describe("raciocínio com orçamento fixo e baixo", () => {
  it("família 3 usa o nível baixo; a 2.x, 512 tokens", () => {
    expect(raciocinioBaixo("gemini-3.5-flash")).toEqual({ thinkingLevel: "low" });
    expect(raciocinioBaixo("gemini-2.5-flash")).toEqual({ thinkingBudget: 512 });
  });
});

describe("gerarComAudioNoGemini", () => {
  const entrada = { audio: Buffer.from("audio"), mimeType: "audio/mp4", prompt: "Transcreva.", esquemaJson: { type: "OBJECT" } };

  it("manda o raciocínio baixo, o teto de saída e o JSON; devolve só o texto que não é raciocínio", async () => {
    responder({ corpo: respostaJson({ segmentos: [] }) });
    const r = await gerarComAudioNoGemini(entrada);
    expect(r).toEqual({ texto: '{"segmentos":[]}', modelo: "gemini-3.5-flash" });
    expect(pedidos[0].corpo.generationConfig).toMatchObject({
      temperature: 0, maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json", responseSchema: { type: "OBJECT" },
    });
  });

  it("MAX_TOKENS (a lição do áudio de 38 min) é erro, nunca texto cortado", async () => {
    responder({ corpo: { ...respostaJson({ segmentos: [] }, "MAX_TOKENS"), usageMetadata: { thoughtsTokenCount: 62_900, candidatesTokenCount: 2_600 } } });
    const erro = await gerarComAudioNoGemini(entrada).catch(e => e);
    expect(erro).toBeInstanceOf(GeminiRespostaCortadaError);
    expect(erro.motivo).toBe("MAX_TOKENS");
  });

  it("a parte tem até 5 min por chamada (não os 40 s do envio único)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    responder({ corpo: respostaJson({ segmentos: [] }) });
    await gerarComAudioNoGemini(entrada);
    expect(timeout).toHaveBeenCalledWith(5 * 60_000);
  });

  it("STOP sem texto (só raciocínio) é erro com a frase de sempre", async () => {
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "pensei", thought: true }] } }] } });
    await expect(gerarComAudioNoGemini(entrada)).rejects.toThrow("O Gemini não retornou uma transcrição válida.");
  });

  it("recusa da chave (403) não vai à reserva: a mesma chave seria recusada de novo", async () => {
    responder({ status: 403, corpo: { error: "chave" } });
    await expect(gerarComAudioNoGemini(entrada)).rejects.toBeInstanceOf(GeminiRecusouChamadaError);
    expect(pedidos).toHaveLength(1);
  });

  it("reserva igual ao principal não é tentada, e reserva que falha devolve o erro do principal", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-3.5-flash");
    vi.useFakeTimers();
    try {
      responder({ status: 503, corpo: {} });
      const igual = gerarComAudioNoGemini(entrada).catch(e => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const erroIgual = await igual;
      expect(erroIgual).toBeInstanceOf(GeminiIndisponivelError);
      expect(pedidos.every(p => p.url.includes("gemini-3.5-flash"))).toBe(true);
      expect(pedidos).toHaveLength(3);

      vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-2.5-flash");
      pedidos = [];
      responder({ status: 503, corpo: {} }, { status: 503, corpo: {} }, { status: 503, corpo: {} }, { status: 500, corpo: {} });
      const diferente = gerarComAudioNoGemini(entrada).catch(e => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const erro = await diferente;
      expect(erro).toBeInstanceOf(GeminiIndisponivelError);
      expect(erro.status).toBe(503);
      expect(pedidos).toHaveLength(4);
      expect(pedidos[3].url).toContain("gemini-2.5-flash");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resposta sem finishReason também não passa como inteira", async () => {
    responder({ corpo: { candidates: [{ content: { parts: [{ text: "{}" }] } }] } });
    await expect(gerarComAudioNoGemini(entrada)).rejects.toBeInstanceOf(GeminiRespostaCortadaError);
  });

  it("modelo lotado: vai à reserva, com o raciocínio da família dela, e diz qual respondeu", async () => {
    responder({ status: 503, corpo: {} }, { status: 503, corpo: {} }, { status: 503, corpo: {} }, { corpo: respostaJson({ segmentos: [] }) });
    vi.useFakeTimers();
    try {
      const pedido = gerarComAudioNoGemini(entrada);
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await pedido;
      expect(r.modelo).toBe("gemini-2.5-flash");
      const ultimo = pedidos[pedidos.length - 1];
      expect(ultimo.url).toContain("models/gemini-2.5-flash:generateContent");
      expect(ultimo.corpo.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 512 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("normalizarSegmentos", () => {
  it("soma o início da parte, prende à duração, ordena e tira texto vazio", () => {
    const s = normalizarSegmentos({ segmentos: [
      { inicio: 30, fim: 41.27, falante: "F2", texto: " depois " },
      { inicio: 0, fim: 12, falante: "F1", texto: "antes" },
      { inicio: 50, fim: 55, falante: "F1", texto: "   " },
      { inicio: 590, fim: 9999, falante: "F1", texto: "no fim" },
    ] }, 600, 600);
    expect(s).toEqual([
      { inicio: 600, fim: 612, falante: "F1", texto: "antes" },
      { inicio: 630, fim: 641.3, falante: "F2", texto: "depois" },
      { inicio: 1190, fim: 1202, falante: "F1", texto: "no fim" },
    ]);
  });

  it("rótulo fora de F<n> (um nome inventado) vira o último falante válido, e fim antes do início vira o início", () => {
    const s = normalizarSegmentos({ segmentos: [
      { inicio: 0, fim: 5, falante: "F3", texto: "a" },
      { inicio: 6, fim: 2, falante: "Maria", texto: "b" },
      { inicio: "x", fim: null, falante: 7, texto: "c" },
    ] }, 0, 600);
    expect(s.map(x => x.falante)).toEqual(["F3", "F3", "F3"]);
    expect(s.find(x => x.texto === "b")).toMatchObject({ inicio: 6, fim: 6 });
  });

  it("só F1 a F99 valem como rótulo; F0, F100, F01, f1 e nomes ficam com o falante anterior, com aviso no log", () => {
    const rotulos = ["F2", "F0", "F100", "F01", "f1", "F99", "Ana"];
    const s = normalizarSegmentos({ segmentos: rotulos.map((falante, i) => ({ inicio: i, fim: i + 1, falante, texto: `t${i}` })) }, 0, 600);
    expect(s.map(x => x.falante)).toEqual(["F2", "F2", "F2", "F2", "F2", "F99", "F99"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("5 de 7 falas vieram sem rótulo"));
  });

  it("parte longa sem nenhuma fala passa (pode ser silêncio), mas avisa no log", () => {
    expect(normalizarSegmentos({ segmentos: [] }, 0, 600)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("parte de 600 s sem nenhuma fala"));
  });

  it("resposta sem a lista é erro, não transcrição vazia", () => {
    expect(() => normalizarSegmentos({ texto: "oi" }, 0, 600)).toThrow("A transcrição da parte veio sem a lista de falas.");
    expect(() => normalizarSegmentos(null, 0, 600)).toThrow();
  });
});

describe("contexto entre as partes", () => {
  it("o prompt da parte seguinte leva as vozes e as últimas falas, com o tempo absoluto", () => {
    const anterior = contextoParaAProxima([
      { inicio: 10, fim: 20, falante: "F1", texto: "Bom dia a todos." },
      { inicio: 595, fim: 600, falante: "F2", texto: "Vamos ao orçamento." },
    ]);
    expect(anterior.falantes).toEqual(["F1", "F2"]);
    const prompt = promptDaFatia({ idioma: "en", duracaoSegundos: 600, anterior });
    expect(prompt).toContain("O idioma predominante esperado é inglês");
    expect(prompt).toContain("Vozes já identificadas: F1, F2");
    // Sem o tempo absoluto: ele ensinaria o modelo a passar dos 600 s da parte.
    expect(prompt).toContain(String.raw`F2: Vamos ao orçamento.`);
    expect(prompt).not.toContain("] F2:");
    expect(prompt).not.toContain("09:55");
  });

  it("só as 4 últimas falas vão adiante, e a mais recente longa demais vai cortada, não some", () => {
    const falas = Array.from({ length: 6 }, (_, i) => ({ inicio: i, fim: i + 1, falante: "F1", texto: `fala ${i}` }));
    const ctx = contextoParaAProxima(falas);
    expect(ctx.ultimasFalas.map(f => f.texto)).toEqual(["fala 2", "fala 3", "fala 4", "fala 5"]);
    const longa = promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 600, anterior: { falantes: ["F1"], ultimasFalas: [{ inicio: 0, fim: 1, falante: "F1", texto: "x".repeat(5000) }] } });
    expect(longa).toContain("Últimas falas do trecho anterior");
    expect(longa).toMatch(/F1: x{1000,}…/);
    expect(longa.length).toBeLessThan(5000);
  });

  it("a primeira parte não fala de trecho anterior, e a voz nova soma às de antes, em ordem numérica", () => {
    expect(promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 600 })).not.toContain("continua o anterior");
    const ctx = contextoParaAProxima([{ inicio: 700, fim: 710, falante: "F10", texto: "oi" }], { falantes: ["F1", "F2"], ultimasFalas: [] });
    expect(ctx.falantes).toEqual(["F1", "F2", "F10"]);
  });

  it("parte sem fala nenhuma passa adiante as últimas falas de antes", () => {
    const antes = { falantes: ["F1"], ultimasFalas: [{ inicio: 1, fim: 2, falante: "F1", texto: "oi" }] };
    expect(contextoParaAProxima([], antes)).toEqual(antes);
  });
});

describe("montarTranscricao", () => {
  const parte = (seq: number, texto: string) => ({
    seq, inicioSegundos: seq * 600, duracaoSegundos: 600,
    segmentos: [{ inicio: seq * 600 + 1, fim: seq * 600 + 5, falante: "F1", texto }],
  });

  it("emenda as partes em ordem, e o texto corrido não leva o rótulo do falante", () => {
    const r = montarTranscricao([parte(1, "dois"), parte(0, "um")], 2);
    expect(r.texto).toBe("um\ndois");
    expect(r.segmentos.map(s => s.inicio)).toEqual([1, 601]);
  });

  it("partes que não chegaram viram UMA lacuna, do fim da anterior ao início da próxima, fora do texto", () => {
    const r = montarTranscricao([parte(0, "um"), parte(3, "quatro")], 4);
    expect(r.segmentos).toEqual([
      parte(0, "um").segmentos[0],
      { inicio: 600, fim: 1800, falante: "", texto: "", lacuna: true },
      parte(3, "quatro").segmentos[0],
    ]);
    expect(r.texto).toBe("um\nquatro");
  });

  it("as últimas partes faltando viram UMA lacuna com a duração padrão de cada uma", () => {
    expect(montarTranscricao([parte(0, "um")], 2).segmentos[1]).toEqual({ inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true });
    const r = montarTranscricao([parte(0, "um")], 4);
    expect(r.segmentos.slice(1)).toEqual([{ inicio: 600, fim: 2400, falante: "", texto: "", lacuna: true }]);
  });

  it("parte que chegou em silêncio fica entre duas lacunas, e o trecho dela não vira 'não recebido'", () => {
    const silencio = { seq: 1, inicioSegundos: 600, duracaoSegundos: 600, segmentos: [] };
    const r = montarTranscricao([silencio, parte(3, "quatro")], 4);
    expect(r.segmentos.filter(s => s.lacuna)).toEqual([
      { inicio: 0, fim: 600, falante: "", texto: "", lacuna: true },
      { inicio: 1200, fim: 1800, falante: "", texto: "", lacuna: true },
    ]);
  });

  it("parte repetida ou fora da contagem é erro, nunca descarte silencioso", () => {
    expect(() => montarTranscricao([parte(0, "um"), parte(0, "outro um")], 2)).toThrow("Parte 0 repetida.");
    expect(() => montarTranscricao([parte(0, "um"), parte(2, "três")], 2)).toThrow("Parte 2 fora das 2 esperadas.");
  });
});

describe("transcreverFatia", () => {
  it("chama a IA com o idioma pelo nome e devolve os segmentos absolutos", async () => {
    responder({ corpo: respostaJson({ segmentos: [{ inicio: 2, fim: 4, falante: "F1", texto: "Hello" }] }) });
    const r = await transcreverFatia({ audio: Buffer.from("a"), mimeType: "audio/mp4", idioma: "en-US", inicioSegundos: 1200, duracaoSegundos: 600 });
    expect(r).toEqual({ segmentos: [{ inicio: 1202, fim: 1204, falante: "F1", texto: "Hello" }], idioma: "en", modelo: "gemini-3.5-flash" });
    expect(JSON.stringify(pedidos[0].corpo)).toContain("inglês");
  });

  it("JSON inválido é erro, não transcrição vazia", async () => {
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "não é json" }] } }] } });
    await expect(transcreverFatia({ audio: Buffer.from("a"), mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 }))
      .rejects.toThrow("A transcrição da parte veio num formato inválido.");
  });
});
