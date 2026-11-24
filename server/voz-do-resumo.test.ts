import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O grupo "voz" do pacote "Resumo e mapa a mais" do gravador, nas partes puras:
 * - o texto que as duas vozes leem (shared/falas-do-resumo.ts), com o
 *   complemento pela busca só confirmado;
 * - o `t` do servidor (os mesmos JSONs da tela), os pedaços do texto e o hash
 *   do cache do áudio (server/resumo-em-audio.ts);
 * - a voz do Gemini e a busca com o Gemini (server/gemini.ts), com o fetch dublado;
 * - o PCM que vira MP3 pelo ffmpeg de verdade (pula sem ffmpeg na máquina);
 * - o que a busca devolve, conferido (server/complemento-pela-busca.ts);
 * - o resumo confirmado na Memória (documentosDosResumosConfirmados).
 */

const { falasDoResumo } = await import("@shared/falas-do-resumo");
const { fonteDoComplemento, consultasDoComplemento, enderecoDaConsulta } = await import("@shared/complemento-pela-busca");
const audio = await import("./resumo-em-audio");
const gemini = await import("./gemini");
// A chave é lida do ENV carregado no começo: o teste põe uma de mentira (o fetch é dublado).
const { ENV } = await import("./_core/env");
(ENV as { llmApiKey: string }).llmApiKey ||= "chave-de-teste-que-nunca-sai-daqui";
const busca = await import("./complemento-pela-busca");
const memoria = await import("./memory-service");
const { codificarVozEmMp3, argumentosDoMp3DaVoz } = await import("./conversao-do-audio");

const tPt = audio.traducaoDoServidor("pt-BR");

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("falasDoResumo (as duas vozes leem o mesmo texto)", () => {
  const item = (extra: Record<string, unknown>) => ({ section: "action" as const, status: "confirmed", subject: null, text: "{F2} liga", assignee: "{F2}", due: "amanhã", ...extra });

  it("lê o título da seção, o texto com o nome da voz, o responsável e o prazo", () => {
    expect(falasDoResumo(tPt, [item({})], { F2: "Ana" })).toEqual(["Ações", "Ana liga", "Responsável: Ana", "Prazo: amanhã"]);
  });

  it("o complemento confirmado entra anunciado como de fora da reunião; sem ele, nada", () => {
    const falas = falasDoResumo(tPt, [item({ complemento: { texto: "Lei 14.133/2021" } })], {});
    expect(falas.at(-1)).toBe("Complemento de fora da reunião, confirmado: Lei 14.133/2021");
    expect(falasDoResumo(tPt, [item({ complemento: null })], {})).not.toContain(expect.stringContaining("fora da reunião"));
  });

  it("com todos os itens para conferir, avisa no começo", () => {
    const [primeira] = falasDoResumo(tPt, [item({ status: "pending" })], {});
    expect(primeira).toMatch(/nenhum item foi conferido/);
  });
});

describe("traducaoDoServidor (o t do servidor, pelos JSONs da tela)", () => {
  it("lê a chave no idioma, troca {{nome}} e cai no pt-BR quando falta", () => {
    expect(audio.traducaoDoServidor("en")("meetings.summary.actionsHeading")).not.toBe("Ações");
    expect(audio.traducaoDoServidor("en")("meetings.speakerLabel", { n: 3 })).toMatch(/3/);
    expect(tPt("meetings.chave.que.nao.existe")).toBe("meetings.chave.que.nao.existe");
  });

  it("não sobe pelo protótipo do objeto", () => {
    expect(tPt("meetings.constructor")).toBe("meetings.constructor");
    expect(tPt("meetings.__proto__.toString")).toBe("meetings.__proto__.toString");
  });
});

describe("pedacosDoTexto e hashDoAudio", () => {
  it("junta as linhas até o limite e corta a linha maior que ele", () => {
    expect(audio.pedacosDoTexto("a\nb\nc", 3)).toEqual(["a\nb", "c"]);
    expect(audio.pedacosDoTexto("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(audio.pedacosDoTexto("\n\nx\n", 10)).toEqual(["x"]);
  });

  it("o hash muda com o texto, o idioma, o modelo e a voz", () => {
    const base = audio.hashDoAudio("m", "v", "pt-BR", "texto");
    expect(audio.hashDoAudio("m", "v", "pt-BR", "texto")).toBe(base);
    for (const outro of [audio.hashDoAudio("m", "v", "pt-BR", "texto2"), audio.hashDoAudio("m", "v", "en", "texto"), audio.hashDoAudio("m2", "v", "pt-BR", "texto"), audio.hashDoAudio("m", "v2", "pt-BR", "texto")]) {
      expect(outro).not.toBe(base);
    }
  });
});

const respostaHttp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

describe("falarComGemini (a voz do Gemini)", () => {
  it("pede só áudio com a voz pronta e devolve o PCM na taxa do tipo", async () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3]);
    const fetch = vi.fn(async () => respostaHttp({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] }));
    vi.stubGlobal("fetch", fetch);
    const fala = await gemini.falarComGemini("Olá", "gemini-3.8-flash-lite-tts", "Kore");
    const [url, pedido] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/models/gemini-3.8-flash-lite-tts:generateContent");
    const corpo = JSON.parse(String(pedido.body));
    expect(corpo.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(corpo.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(fala.amostrasPorSegundo).toBe(24_000);
    // O byte solto do fim sai: amostra de 16 bits.
    expect(fala.pcm.length).toBe(4);
  });

  it("sem áudio na resposta, lança", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaHttp({ candidates: [{ content: { parts: [{ text: "oi" }] } }] })));
    await expect(gemini.falarComGemini("Olá", "gemini-3.8-flash-lite-tts", "Kore")).rejects.toBeInstanceOf(gemini.GeminiSemAudioError);
  });

  it("a taxa vem do tipo; fora de 8 a 48 kHz, 24 kHz", () => {
    expect(gemini.taxaDoPcm("audio/L16;rate=16000")).toBe(16_000);
    expect(gemini.taxaDoPcm("audio/L16;rate=999999")).toBe(24_000);
    expect(gemini.taxaDoPcm(undefined)).toBe(24_000);
  });
});

describe("buscarComGemini (a busca da Google no Gemini)", () => {
  it("manda a ferramenta google_search e devolve as fontes que sustentam o texto primeiro", async () => {
    const fetch = vi.fn(async () => respostaHttp({ candidates: [{
      content: { parts: [{ text: "pensando", thought: true }, { text: "Lei nº 14.133/2021" }] },
      groundingMetadata: {
        webSearchQueries: ["lei 14.133", 7],
        groundingChunks: [{ web: { uri: "https://a.example/1", title: "a.example" } }, { web: { uri: "https://b.example/2", title: "b.example" } }],
        groundingSupports: [{ groundingChunkIndices: [1] }],
      },
    }] }));
    vi.stubGlobal("fetch", fetch);
    const resposta = await gemini.buscarComGemini("prompt", "gemini-3.5-flash");
    const corpo = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(corpo.tools).toEqual([{ google_search: {} }]);
    expect(resposta).toEqual({
      texto: "Lei nº 14.133/2021", consultas: ["lei 14.133"],
      fontes: [{ url: "https://b.example/2", titulo: "b.example" }, { url: "https://a.example/1", titulo: "a.example" }],
    });
  });
});

describe("complementoDaResposta e o prompt (H4i)", () => {
  const resposta = (extra: Partial<{ texto: string; consultas: string[]; fontes: Array<{ url: string; titulo: string | null }> }>) =>
    ({ texto: "Lei nº 14.133/2021", consultas: ["lei licitações"], fontes: [{ url: "https://fonte.example/lei", titulo: "fonte.example" }], ...extra });

  it("vale com texto e uma fonte https", () => {
    expect(busca.complementoDaResposta(resposta({}))).toEqual({ texto: "Lei nº 14.133/2021", fonte: "https://fonte.example/lei", titulo: "fonte.example", consultas: ["lei licitações"] });
  });

  it("sem fonte, só com fonte que não é https, ou com o 'não achei', não vale", () => {
    expect(busca.complementoDaResposta(resposta({ fontes: [] }))).toBeNull();
    expect(busca.complementoDaResposta(resposta({ fontes: [{ url: "http://inseguro.example", titulo: null }, { url: "javascript:alert(1)", titulo: null }] }))).toBeNull();
    expect(busca.complementoDaResposta(resposta({ texto: busca.NAO_ACHEI }))).toBeNull();
    expect(busca.complementoDaResposta(resposta({ texto: "  " }))).toBeNull();
  });

  it("corta o texto longo e as consultas a mais", () => {
    const achado = busca.complementoDaResposta(resposta({ texto: "x".repeat(1000), consultas: ["a", "b", "c", "d", "e", "f", "g"] }))!;
    expect(achado.texto.length).toBeLessThanOrEqual(400);
    expect(achado.consultas).toHaveLength(5);
  });

  it("o prompt leva só o item e o idioma, nunca um trecho da transcrição", () => {
    const prompt = busca.promptDoComplemento({ subject: null, text: "{F2} cita a lei catorze mil e cento e..." }, "en");
    expect(prompt).toContain("{F2} cita a lei catorze mil");
    expect(prompt).toContain("inglês");
    expect(prompt).toContain(busca.NAO_ACHEI);
  });

  it("fonteDoComplemento, consultasDoComplemento e enderecoDaConsulta", () => {
    expect(fonteDoComplemento("https://ok.example/a b")).toBe("https://ok.example/a%20b");
    expect(fonteDoComplemento("ftp://x")).toBeNull();
    expect(fonteDoComplemento(`https://x.example/${"a".repeat(2100)}`)).toBeNull();
    expect(consultasDoComplemento(["  a ", 1, "", "b"])).toEqual(["a", "b"]);
    expect(consultasDoComplemento("nada")).toEqual([]);
    expect(enderecoDaConsulta("lei 14.133 & cia")).toBe("https://www.google.com/search?q=lei%2014.133%20%26%20cia");
  });
});

describe("documentosDosResumosConfirmados (o resumo confirmado na Memória)", () => {
  const resumo = { id: "r1", meetingId: "m1", status: "ready", version: 1, language: "pt-BR" };
  const item = (extra: Record<string, unknown>) => ({
    summaryId: "r1", meetingId: "m1", section: "decision", position: 0, subject: null, text: "Fechar com {F2}", assignee: null, due: null,
    complementText: null, complementSourceUrl: null, complementStatus: null, ...extra,
  });
  const titulos = new Map([["m1", "Vinícola"]]);

  it("um documento por reunião, com os itens confirmados, o nome da voz e o título", () => {
    const [doc] = memoria.documentosDosResumosConfirmados([resumo], [item({})], titulos, new Map([["m1", { F2: "Ana" }]]));
    expect(doc).toMatchObject({ sourceType: "meeting_summary", sourceId: "m1", title: "Vinícola", metadata: { meetingId: "m1", kind: "Resumo da reunião" } });
    expect(doc.content).toBe("Resumo confirmado da reunião: Vinícola\nDecisões:\n- Fechar com Ana");
  });

  it("sem item confirmado, sem reunião viva ou sem versão gravada, nenhum documento", () => {
    expect(memoria.documentosDosResumosConfirmados([resumo], [], titulos, new Map())).toEqual([]);
    expect(memoria.documentosDosResumosConfirmados([resumo], [item({})], new Map(), new Map())).toEqual([]);
    expect(memoria.documentosDosResumosConfirmados([{ ...resumo, status: "pending", version: 0 }], [item({})], titulos, new Map())).toEqual([]);
    // O refazer em curso (versão gravada) segue com a anterior.
    expect(memoria.documentosDosResumosConfirmados([{ ...resumo, status: "pending", version: 2 }], [item({})], titulos, new Map())).toHaveLength(1);
  });

  it("o complemento só entra confirmado, marcado de fora da reunião e com a fonte", () => {
    const comPendente = memoria.documentosDosResumosConfirmados([resumo], [item({ complementText: "Lei 1", complementStatus: "pending" })], titulos, new Map());
    expect(comPendente[0].content).not.toContain("Lei 1");
    const [doc] = memoria.documentosDosResumosConfirmados([resumo], [item({ complementText: "Lei 1", complementStatus: "confirmed", complementSourceUrl: "https://f.example" })], titulos, new Map());
    expect(doc.content).toContain("Complemento de fora da reunião (busca na web, fonte: https://f.example): Lei 1");
  });

  it("mudar o resumo muda o texto, e o hash do documento", () => {
    const [antes] = memoria.documentosDosResumosConfirmados([resumo], [item({})], titulos, new Map());
    const [depois] = memoria.documentosDosResumosConfirmados([resumo], [item({ text: "Fechar com outra pessoa" })], titulos, new Map());
    expect(memoria.buildMemoryHash(depois.content)).not.toBe(memoria.buildMemoryHash(antes.content));
  });

  it("a resposta cita o resumo como fonte, pelo número dele", async () => {
    const { answerFromMemory } = memoria;
    const llm = await import("./_core/llm");
    const espiao = vi.spyOn(llm, "invokeLLM").mockResolvedValue({ choices: [{ message: { content: "Fechou com a Ana [1]." } }] } as never);
    await answerFromMemory("Com quem fechamos?", [{ id: "d", sourceType: "meeting_summary", sourceId: "m1", title: "Vinícola", content: "Resumo confirmado da reunião: Vinícola", metadata: {}, score: 1 }]);
    const mensagens = (espiao.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages;
    expect(mensagens[1].content).toContain("[1] Resumo confirmado da reunião Vinícola");
    expect(mensagens[0].content).toContain("Resumo confirmado");
  });
});

const temFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libmp3lame") ?? false;

describe.skipIf(!temFfmpeg)("codificarVozEmMp3 (o ffmpeg de verdade)", () => {
  it("1 s de PCM a 24 kHz vira um MP3", async () => {
    const amostras = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 24_000; i++) amostras.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
    const mp3 = await codificarVozEmMp3(amostras, 24_000, { prioridade: 0 });
    expect(mp3.length).toBeGreaterThan(1000);
    // Quadro MP3 (sincronia 0xFFE) ou ID3 no começo.
    expect(mp3[0] === 0xff || mp3.subarray(0, 3).toString() === "ID3").toBe(true);
  }, 20_000);

  it("sem PCM, lança antes de subir o ffmpeg", async () => {
    await expect(codificarVozEmMp3(Buffer.alloc(0), 24_000)).rejects.toThrow();
  });
});

describe("argumentosDoMp3DaVoz", () => {
  it("lê a taxa do Gemini e escreve na do áudio da reunião, em MP3, sem ler arquivo", () => {
    const args = argumentosDoMp3DaVoz(16_000);
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual(["-f", "s16le"]);
    expect(args).toContain("16000");
    expect(args).toContain("libmp3lame");
    expect(args).toContain("pipe:0");
    expect(args.some(arg => arg.startsWith("/") || arg.includes("file:"))).toBe(false);
  });
});
