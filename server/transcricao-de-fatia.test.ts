import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A transcrição de uma parte da reunião (G6). Não fala com a internet: o
 * fetch é trocado, como em server/gemini.test.ts, e o módulo de ambiente
 * também (a chave nunca sai daqui).
 */
const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const { gerarComAudioNoGemini, GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError, raciocinioBaixo } = await import("./gemini");
const { contextoParaAProxima, lerTempo, montarTranscricao, normalizarSegmentos, promptDaFatia, tempoEmTexto, transcreverFatia } = await import("./transcricao-de-fatia");

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

/**
 * O defeito de 17/11/2026 (bancada da tela do pacote 4a, MP3 sintético de 25 min
 * com "Minute N" no começo de cada minuto): pedido como número de segundos, o
 * modelo escrevia os minutos e os segundos juntos (1:00 virava 100). O servidor
 * lia 100 como segundos, e o que passava do fim da parte ficava preso nele:
 * "Minute two" saía em 01:40, "Minute seven" em 10:00, e os minutos 8 a 10 da
 * primeira parte nem vieram. Agora o tempo vem como texto "MM:SS".
 */
describe("tempo da fala em 'MM:SS'", () => {
  // Um "Minute N" no começo de cada minuto de uma parte de 10 min.
  const minutos = (tempo: (minuto: number) => string | number) => ({
    segmentos: Array.from({ length: 10 }, (_, i) => ({
      inicio: tempo(i), fim: tempo(i), falante: i % 2 ? "F2" : "F1", texto: `Minute ${i + 1}.`,
    })),
  });

  it("a conversão: 'MM:SS' e 'H:MM:SS' viram segundos; número volta marcado como número; o resto é null", () => {
    expect(lerTempo("00:07")).toEqual({ segundos: 7, numero: false });
    expect(lerTempo("01:05")).toEqual({ segundos: 65, numero: false });
    expect(lerTempo(" 9:58 ")).toEqual({ segundos: 598, numero: false });
    expect(lerTempo("10:00")).toEqual({ segundos: 600, numero: false });
    expect(lerTempo("00:07.5")).toEqual({ segundos: 7.5, numero: false });
    expect(lerTempo("1:02:03")).toEqual({ segundos: 3723, numero: false });
    expect(lerTempo("0:09:00")).toEqual({ segundos: 540, numero: false });
    // Número (ou texto só com número) não se decide sozinho: 105 pode ser 1:45 ou 1:05.
    expect(lerTempo(105)).toEqual({ segundos: 105, numero: true });
    expect(lerTempo("105")).toEqual({ segundos: 105, numero: true });
    expect(lerTempo("41,5")).toEqual({ segundos: 41.5, numero: true });
    for (const invalido of ["01:75", "1:60:00", "abc", "", "1h05", "-00:05", -3, Number.NaN, null, undefined, {}]) {
      expect(lerTempo(invalido)).toBeNull();
    }
  });

  it("tempoEmTexto escreve como o modelo deve escrever", () => {
    expect(tempoEmTexto(0)).toBe("00:00");
    expect(tempoEmTexto(65)).toBe("01:05");
    expect(tempoEmTexto(599.98)).toBe("10:00");
    expect(tempoEmTexto(3723)).toBe("1:02:03");
    expect(tempoEmTexto(7, true)).toBe("0:00:07");
  });

  it("a fala aos 9 min de uma parte que começa aos 10 min sai em 19:00, inteira, com todas as outras", () => {
    const s = normalizarSegmentos(minutos(i => tempoEmTexto(i * 60)), 600, 599.98);
    expect(s).toHaveLength(10);
    expect(s.map(x => x.inicio)).toEqual([600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1140]);
    expect(s[9]).toEqual({ inicio: 1140, fim: 1140, falante: "F2", texto: "Minute 10." });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a resposta MMSS antiga (1:00 escrito 100): a fala aos 9 min sai em 9:00, e não presa no fim; nada se perde", () => {
    // Como nas partes do defeito, em que o banco guardou 0, 100, 200... 600 e o resto preso em 602.
    const s = normalizarSegmentos(minutos(i => i * 100), 599.98, 599.98);
    expect(s.map(x => x.texto)).toEqual(Array.from({ length: 10 }, (_, i) => `Minute ${i + 1}.`));
    expect(s.map(x => Math.round(x.inicio - 599.98))).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("lidos como minutos e segundos juntos"));
    // Com décimos e no texto: 101.6 é 1:01,6; "905" é 9:05.
    const decimos = normalizarSegmentos({ segmentos: [
      { inicio: 101.6, fim: 106.2, falante: "F2", texto: "um" },
      { inicio: "905", fim: "911", falante: "F1", texto: "dois" },
    ] }, 0, 600);
    expect(decimos.map(x => [x.inicio, x.fim])).toEqual([[61.6, 66.2], [545, 551]]);
  });

  it("número que cabe na parte em segundos fica em segundos (na dúvida, a leitura literal)", () => {
    const s = normalizarSegmentos({ segmentos: [
      { inicio: 0, fim: 12, falante: "F1", texto: "a" },
      { inicio: 75, fim: 130, falante: "F2", texto: "b" },
      { inicio: 590, fim: 605, falante: "F1", texto: "c" },
    ] }, 0, 600);
    expect(s.map(x => [x.inicio, x.fim])).toEqual([[0, 12], [75, 130], [590, 602]]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("lidos como segundos"));
  });

  it("a fala no fim da parte, e a que começa depois dele, ficam presas no fim, com o texto e na ordem", () => {
    const s = normalizarSegmentos({ segmentos: [
      { inicio: "09:50", fim: "09:57", falante: "F1", texto: "quase no fim" },
      { inicio: "09:58", fim: "10:04", falante: "F2", texto: "atravessa o fim" },
      { inicio: "10:30", fim: "10:40", falante: "F1", texto: "depois do fim" },
      { inicio: "15:00", fim: "15:05", falante: "F2", texto: "bem depois do fim" },
    ] }, 1200, 600);
    expect(s).toEqual([
      { inicio: 1790, fim: 1797, falante: "F1", texto: "quase no fim" },
      { inicio: 1798, fim: 1802, falante: "F2", texto: "atravessa o fim" },
      { inicio: 1802, fim: 1802, falante: "F1", texto: "depois do fim" },
      { inicio: 1802, fim: 1802, falante: "F2", texto: "bem depois do fim" },
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("2 de 4 falas começavam depois do fim da parte (600 s) e ficaram presas nele"));
  });

  it("a ordem: pelo início; a fala sem tempo legível fica logo depois da anterior, e as de mesmo início na ordem em que vieram", () => {
    const s = normalizarSegmentos({ segmentos: [
      { inicio: "00:00", fim: "00:10", falante: "F1", texto: "primeira" },
      { inicio: "00:30", fim: "00:40", falante: "F2", texto: "segunda" },
      { inicio: "?", fim: "", falante: "F1", texto: "sem tempo, depois da segunda" },
      { inicio: "02:00", fim: "02:05", falante: "F2", texto: "quarta" },
      { inicio: "01:00", fim: "01:05", falante: "F1", texto: "terceira, veio fora de ordem" },
      { inicio: "02:00", fim: "02:01", falante: "F1", texto: "quinta, mesmo início da quarta" },
    ] }, 0, 600);
    expect(s.map(x => x.texto)).toEqual(["primeira", "segunda", "sem tempo, depois da segunda", "terceira, veio fora de ordem", "quarta", "quinta, mesmo início da quarta"]);
    expect(s[2]).toMatchObject({ inicio: 30, fim: 30 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("1 de 6 falas vieram sem tempo legível"));
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

  it("o prompt pede o tempo como texto 'MM:SS', de 00:00 ao fim da parte, nunca como número de segundos", () => {
    const prompt = promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 599.98 });
    expect(prompt).toContain('escrito como texto "MM:SS"');
    expect(prompt).toContain('de "00:00" a "10:00"');
    expect(prompt).toContain("Nunca escreva o tempo como número.");
    expect(prompt).toContain("O trecho tem 10:00 de áudio: transcreva até o fim dele.");
    // O pedido de antes, que o modelo respondia com 1:00 escrito 100.
    expect(prompt).not.toContain("segundos dentro");
    expect(prompt).not.toMatch(/de 0 a \d+/);
    expect(promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 300.069 })).toContain('de "00:00" a "05:00"');
    // A bancada aceita parte de qualquer tamanho: a partir de uma hora, "H:MM:SS".
    const longa = promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 3725 });
    expect(longa).toContain('escrito como texto "H:MM:SS"');
    expect(longa).toContain('de "0:00:00" a "1:02:05"');
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
    responder({ corpo: respostaJson({ segmentos: [{ inicio: "00:02", fim: "00:04", falante: "F1", texto: "Hello" }] }) });
    const r = await transcreverFatia({ audio: Buffer.from("a"), mimeType: "audio/mp4", idioma: "en-US", inicioSegundos: 1200, duracaoSegundos: 600 });
    expect(r).toEqual({ segmentos: [{ inicio: 1202, fim: 1204, falante: "F1", texto: "Hello" }], idioma: "en", modelo: "gemini-3.5-flash" });
    expect(JSON.stringify(pedidos[0].corpo)).toContain("inglês");
  });

  it("pede o tempo como TEXTO com o padrão 'MM:SS', na ordem do contrato, e a fala aos 9 min sai certa", async () => {
    responder({ corpo: respostaJson({ segmentos: [
      { inicio: "00:00", fim: "00:01", falante: "F1", texto: "Minute one." },
      { inicio: "09:00", fim: "09:02", falante: "F1", texto: "Minute ten." },
    ] }) });
    const r = await transcreverFatia({ audio: Buffer.from("a"), mimeType: "audio/mpeg", idioma: "pt-BR", inicioSegundos: 599.98, duracaoSegundos: 599.98 });
    expect(r.segmentos.map(s => [s.inicio, s.texto])).toEqual([[600, "Minute one."], [1140, "Minute ten."]]);
    const item = pedidos[0].corpo.generationConfig.responseSchema.properties.segmentos.items;
    expect(item.propertyOrdering).toEqual(["inicio", "fim", "falante", "texto"]);
    expect(item.required).toEqual(["inicio", "fim", "falante", "texto"]);
    for (const campo of ["inicio", "fim"]) {
      expect(item.properties[campo]).toMatchObject({ type: "STRING", description: expect.stringContaining('"MM:SS"') });
      const padrao = new RegExp(item.properties[campo].pattern);
      for (const ok of ["00:00", "09:58", "7:05", "10:00", "1:02:05"]) expect(padrao.test(ok), ok).toBe(true);
      for (const nao of ["100", "600", "9:60", "00:7", "1:2:3", "09:58.5"]) expect(padrao.test(nao), nao).toBe(false);
    }
    expect(pedidos[0].corpo.contents[0].parts[0].text).toContain('de "00:00" a "10:00"');
  });

  it("JSON inválido é erro, não transcrição vazia", async () => {
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "não é json" }] } }] } });
    await expect(transcreverFatia({ audio: Buffer.from("a"), mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 }))
      .rejects.toThrow("A transcrição da parte veio num formato inválido.");
  });
});
