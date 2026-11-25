import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODIGOS_DE_ERRO_DO_YOUTUBE, ehCodigoDeErroDoYoutube, erroDoYoutubeSeRepete, idDoVideoDaReuniao, idDoVideoDoYoutube, linkDoYoutubeNoSegundo,
  SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX, TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE, urlCanonicaDoYoutube,
} from "@shared/youtube";

/**
 * O vídeo do YouTube (H13): a regra pura que tira o id do link (a mesma da
 * tela, em shared/youtube.ts) e o pedido ao Gemini, com o fetch dublado. Este
 * arquivo NÃO fala com a internet: o ambiente é trocado por inteiro (a chave
 * é falsa), como em server/gemini.test.ts. O banco, o teto e a ficha estão em
 * server/youtube.integracao.test.ts.
 */
const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const youtube = await import("./youtube");
const { GeminiRecusouChamadaError, GeminiRespostaCortadaError, GeminiIndisponivelError, GeminiCotaEsgotadaError } = await import("./gemini");

const ID = "dQw4w9WgXcQ";
const CANONICA = `https://www.youtube.com/watch?v=${ID}`;

describe("idDoVideoDoYoutube: o id em cada forma de link", () => {
  it.each([
    ["watch", `https://www.youtube.com/watch?v=${ID}`],
    ["watch sem www", `https://youtube.com/watch?v=${ID}`],
    ["watch com o tempo", `https://www.youtube.com/watch?v=${ID}&t=42s`],
    ["watch com o v depois de outro parâmetro", `https://www.youtube.com/watch?feature=share&v=${ID}`],
    ["watch com playlist", `https://www.youtube.com/watch?v=${ID}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=2`],
    ["watch com barra no fim", `https://www.youtube.com/watch/?v=${ID}`],
    ["watch no celular", `https://m.youtube.com/watch?v=${ID}`],
    ["watch no YouTube Music", `https://music.youtube.com/watch?v=${ID}&si=abc`],
    ["watch em http", `http://www.youtube.com/watch?v=${ID}`],
    ["watch sem o esquema", `www.youtube.com/watch?v=${ID}`],
    ["watch sem esquema e sem www", `youtube.com/watch?v=${ID}`],
    ["watch com // no começo", `//www.youtube.com/watch?v=${ID}`],
    ["host em maiúsculas", `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`],
    ["com espaços em volta", `   https://www.youtube.com/watch?v=${ID}  `],
    ["com âncora", `https://www.youtube.com/watch?v=${ID}#comentarios`],
    ["youtu.be", `https://youtu.be/${ID}`],
    ["youtu.be com si e tempo", `https://youtu.be/${ID}?si=Ab12_cd&t=10`],
    ["youtu.be sem esquema", `youtu.be/${ID}`],
    ["youtu.be com barra no fim", `https://youtu.be/${ID}/`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["shorts com parâmetro", `https://youtube.com/shorts/${ID}?feature=share`],
    ["shorts no celular", `https://m.youtube.com/shorts/${ID}`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
    ["embed com parâmetros", `https://www.youtube.com/embed/${ID}?start=30&autoplay=1`],
    ["embed sem cookie", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["live", `https://www.youtube.com/live/${ID}?si=xyz`],
    ["v antigo", `https://www.youtube.com/v/${ID}`],
  ])("%s", (_forma, link) => {
    expect(idDoVideoDoYoutube(link)).toBe(ID);
  });

  it("guarda a caixa do id: o id do YouTube distingue maiúsculas", () => {
    expect(idDoVideoDoYoutube("https://youtu.be/AbC-_12xYz9")).toBe("AbC-_12xYz9");
  });

  it.each([
    ["vazio", ""],
    ["só espaços", "   "],
    ["o id solto, sem link", ID],
    ["outro site", "https://vimeo.com/123456789"],
    ["domínio que só começa com youtube.com", `https://www.youtube.com.exemplo.com/watch?v=${ID}`],
    ["youtube.com no caminho de outro site", `https://exemplo.com/youtube.com/watch?v=${ID}`],
    ["usuário antes do host (o host é outro)", `https://youtube.com@exemplo.com/watch?v=${ID}`],
    ["usuário e senha no link do YouTube", `https://fulana:senha@www.youtube.com/watch?v=${ID}`],
    ["javascript:", "javascript:alert(1)"],
    ["ftp", `ftp://www.youtube.com/watch?v=${ID}`],
    ["data:", "data:text/html,oi"],
    ["host com ponto no fim", `https://youtube.com./watch?v=${ID}`],
    ["id curto", "https://www.youtube.com/watch?v=abc123"],
    ["id longo", `https://www.youtube.com/watch?v=${ID}X`],
    ["id com caractere fora do formato", "https://www.youtube.com/watch?v=dQw4w9WgX%3C"],
    ["watch sem v", "https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"],
    ["playlist", "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"],
    ["canal", "https://www.youtube.com/channel/UC38IQsAvIsxxjztdMZQtwHA"],
    ["perfil @", "https://www.youtube.com/@canaldeexemplo"],
    ["a página inicial", "https://www.youtube.com/"],
    ["youtu.be sem id", "https://youtu.be/"],
    ["youtu.be com caminho a mais", `https://youtu.be/${ID}/outra`],
    ["shorts com caminho a mais", `https://www.youtube.com/shorts/${ID}/outra`],
    ["watch com o id no caminho", `https://www.youtube.com/watch/${ID}`],
    ["shorts sem id", "https://www.youtube.com/shorts/"],
    ["link com espaço no meio", `https://www.youtube.com/watch?v=${ID} outra coisa`],
    ["link longo demais", `https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(TAMANHO_MAXIMO_DO_LINK_DO_YOUTUBE)}`],
  ])("recusa %s", (_caso, link) => {
    expect(idDoVideoDoYoutube(link)).toBeNull();
  });

  it("recusa o que não é texto", () => {
    for (const valor of [null, undefined, 42, {}, ["https://youtu.be/" + ID]]) expect(idDoVideoDoYoutube(valor)).toBeNull();
  });
});

describe("a URL canônica e o link do ▶", () => {
  it("a URL canônica é sempre a mesma para o mesmo vídeo, sem os parâmetros do link colado", () => {
    expect(urlCanonicaDoYoutube(idDoVideoDoYoutube(`https://youtu.be/${ID}?si=rastreio&t=99`)!)).toBe(CANONICA);
    expect(urlCanonicaDoYoutube(idDoVideoDoYoutube(`https://www.youtube.com/shorts/${ID}`)!)).toBe(CANONICA);
  });

  it("a URL canônica recusa id fora do formato (não monta endereço com o que veio de fora)", () => {
    expect(() => urlCanonicaDoYoutube("../../x")).toThrow();
  });

  it("o ▶ abre o vídeo no segundo da fala, inteiro e nunca negativo", () => {
    expect(linkDoYoutubeNoSegundo(ID, 725.6)).toBe(`${CANONICA}&t=725s`);
    expect(linkDoYoutubeNoSegundo(ID, 0)).toBe(`${CANONICA}&t=0s`);
    expect(linkDoYoutubeNoSegundo(ID, -3)).toBe(`${CANONICA}&t=0s`);
    expect(linkDoYoutubeNoSegundo(ID, Number.NaN)).toBe(`${CANONICA}&t=0s`);
  });

  it("o id do vídeo de uma reunião: só da origem youtube e com a URL de um vídeo", () => {
    expect(idDoVideoDaReuniao({ origem: "youtube", sourceUrl: CANONICA })).toBe(ID);
    expect(idDoVideoDaReuniao({ origem: "gravacao", sourceUrl: CANONICA })).toBeNull();
    expect(idDoVideoDaReuniao({ origem: "youtube", sourceUrl: "https://exemplo.com/x" })).toBeNull();
    expect(idDoVideoDaReuniao({ origem: null, sourceUrl: null })).toBeNull();
  });

  it("os códigos de erro são reconhecidos, e só eles", () => {
    for (const codigo of CODIGOS_DE_ERRO_DO_YOUTUBE) expect(ehCodigoDeErroDoYoutube(codigo)).toBe(true);
    expect(ehCodigoDeErroDoYoutube("ERRO_INTERROMPIDO")).toBe(false);
    expect(ehCodigoDeErroDoYoutube("Não foi possível transcrever o áudio.")).toBe(false);
    expect(ehCodigoDeErroDoYoutube(null)).toBe(false);
  });
});

// ─── O pedido ao Gemini, com o fetch dublado ──────────────────────────────────

type Pedido = { url: string; corpo: any };
let pedidos: Pedido[] = [];
let respostas: Array<{ status: number; corpo: unknown }> = [];
let fetchOriginal: typeof globalThis.fetch;

function responder(...lista: Array<{ status?: number; corpo: unknown }>) {
  respostas = lista.map(r => ({ status: r.status ?? 200, corpo: r.corpo }));
}

/** A resposta de sucesso do Gemini com o JSON dos segmentos. */
const comSegmentos = (segmentos: unknown[], motivo = "STOP") => ({
  corpo: { candidates: [{ finishReason: motivo, content: { parts: [{ text: JSON.stringify({ segmentos }) }] } }], usageMetadata: { promptTokenCount: 150_000 } },
});
const recusa = (status: number, mensagem: string) => ({ status, corpo: { error: { code: status, message: mensagem, status: "INVALID_ARGUMENT" } } });

beforeEach(() => {
  fetchOriginal = globalThis.fetch;
  ambiente.ENV.llmApiKey = "chave-de-teste-que-nunca-sai-daqui";
  // Os modelos saem do ambiente: o .env de quem roda a suíte não troca o que o teste espera.
  vi.stubEnv("LLM_AUDIO_MODEL", undefined);
  vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", undefined);
  pedidos = [];
  respostas = [];
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push({ url: String(entrada), corpo: init?.body ? JSON.parse(String(init.body)) : null });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não combinou esta resposta");
    const corpo = typeof proxima.corpo === "string" ? proxima.corpo : JSON.stringify(proxima.corpo);
    return new Response(corpo, { status: proxima.status, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function codigoDe(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof youtube.ErroDoVideoDoYoutube) return erro.codigo;
    throw erro;
  }
  throw new Error("era para falhar");
}

describe("o pedido ao Gemini: o vídeo por fileUri, só a primeira hora", () => {
  it("manda a URL canônica (nunca o link colado), cortada em 1 h, com poucos quadros e a resposta no contrato", async () => {
    responder(comSegmentos([{ inicio: "00:03", fim: "00:09", falante: "F1", texto: "Bom dia a todas." }]));

    await youtube.transcreverVideoDoYoutube({ url: `https://youtu.be/${ID}?si=rastreio-da-dona&t=99`, idioma: "es" });

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
    const { contents, generationConfig } = pedidos[0].corpo;
    const [video, texto] = contents[0].parts;
    // O vídeo antes do texto, e pela URL: nenhum byte do vídeo passa pelo servidor.
    expect(video.file_data).toEqual({ file_uri: CANONICA });
    expect(video.inline_data).toBeUndefined();
    expect(JSON.stringify(pedidos[0].corpo)).not.toContain("rastreio-da-dona");
    expect(video.video_metadata).toEqual({ start_offset: "0s", end_offset: `${SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX}s`, fps: youtube.QUADROS_POR_SEGUNDO_DO_VIDEO });
    expect(video.video_metadata.end_offset).toBe("3600s");
    expect(youtube.QUADROS_POR_SEGUNDO_DO_VIDEO).toBeGreaterThan(0);
    expect(youtube.QUADROS_POR_SEGUNDO_DO_VIDEO).toBeLessThan(1);
    // O prompt no idioma da reunião e com os tempos em texto.
    expect(texto.text).toContain("espanhol");
    expect(texto.text).toContain('"MM:SS"');
    expect(texto.text).toContain("Nunca escreva o tempo como número");
    expect(generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: youtube.SAIDA_MAXIMA_DO_VIDEO,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" },
    });
    // Os tempos são texto com o padrão "MM:SS", como na fatia (#219), nunca número.
    const item = generationConfig.responseSchema.properties.segmentos.items;
    expect(item.properties.inicio).toMatchObject({ type: "STRING" });
    expect(item.properties.fim).toMatchObject({ type: "STRING" });
    expect(new RegExp(item.properties.inicio.pattern).test("12:05")).toBe(true);
    expect(new RegExp(item.properties.inicio.pattern).test("725")).toBe(false);
    expect(item.propertyOrdering).toEqual(["inicio", "fim", "falante", "texto"]);
  });

  it("sem idioma conhecido, o prompt pede o padrão (português)", async () => {
    responder(comSegmentos([{ inicio: "00:01", fim: "00:02", falante: "F1", texto: "Oi." }]));
    await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "xx" });
    expect(pedidos[0].corpo.contents[0].parts[1].text).toContain("português");
  });

  it("o modelo é o concreto da guarda: um alias -latest no ambiente cai no padrão", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL", "gemini-flash-latest");
    responder(comSegmentos([{ inicio: "00:01", fim: "00:02", falante: "F1", texto: "Oi." }]));
    const resultado = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" });
    expect(pedidos[0].url).toContain("/models/gemini-3.5-flash:generateContent");
    expect(resultado.modelo).toBe("gemini-3.5-flash");
  });

  it("link que não é de vídeo não chega a sair: YOUTUBE_LINK_INVALIDO, sem fetch", async () => {
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: "https://vimeo.com/123", idioma: "pt-BR" }))).toBe("YOUTUBE_LINK_INVALIDO");
    expect(pedidos).toHaveLength(0);
  });
});

describe("G16: \"Detectar sozinho\" e os outros idiomas no vídeo", () => {
  it("em \"Detectar sozinho\", o prompt não diz o idioma, o esquema pede o código de cada fala depois do texto, e cada fala volta com ele", async () => {
    responder(comSegmentos([
      { inicio: "00:01", fim: "00:30", falante: "F1", texto: "Welcome to the channel.", idioma: "en" },
      { inicio: "00:31", fim: "00:40", falante: "F1", texto: "Hoje falamos de exportação.", idioma: "pt" },
    ]));
    const resultado = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "auto" });
    const texto = pedidos[0].corpo.contents[0].parts[1].text as string;
    expect(texto).toContain("O idioma não foi informado");
    expect(texto).not.toContain("predominante esperado");
    expect(texto).toContain('8) "idioma" é o código do idioma');
    const item = pedidos[0].corpo.generationConfig.responseSchema.properties.segmentos.items;
    expect(item.propertyOrdering).toEqual(["inicio", "fim", "falante", "texto", "idioma"]);
    expect(resultado.segmentos.map(segmento => segmento.idioma)).toEqual(["en", "pt-BR"]);
  });

  it("com o idioma escolhido, o esquema não pede o idioma de cada fala; um idioma fora dos 10 vai pelo nome em português", async () => {
    responder(comSegmentos([{ inicio: "00:01", fim: "00:02", falante: "F1", texto: "Ciao." }]));
    await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "it" });
    expect(pedidos[0].corpo.contents[0].parts[1].text).toContain("O idioma predominante esperado é italiano;");
    expect(pedidos[0].corpo.generationConfig.responseSchema.properties.segmentos.items.properties).not.toHaveProperty("idioma");
  });
});

describe("os tempos da resposta", () => {
  it("lê os tempos em texto \"MM:SS\" como segundos desde o começo do vídeo, em ordem", async () => {
    responder(comSegmentos([
      { inicio: "00:07", fim: "00:12", falante: "F1", texto: "Bem-vindas ao painel." },
      { inicio: "12:05", fim: "12:31", falante: "F2", texto: "Obrigada pelo convite." },
      { inicio: "59:58", fim: "1:00:00", falante: "F1", texto: "Até a próxima." },
      { inicio: "06:40", fim: "06:52", falante: "F2", texto: "Fala do meio." },
    ]));
    const { segmentos, texto, duracaoSegundos } = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" });
    expect(segmentos.map(s => [s.inicio, s.fim, s.falante])).toEqual([[7, 12, "F1"], [400, 412, "F2"], [725, 751, "F2"], [3598, 3600, "F1"]]);
    // Depois dos 6 min a fala continua no lugar certo (o defeito da #219 a achatava).
    expect(segmentos[1].inicio).toBe(400);
    // O texto corrido não leva o rótulo da voz, como a montagem das partes.
    expect(texto).toBe("Bem-vindas ao painel.\nFala do meio.\nObrigada pelo convite.\nAté a próxima.");
    expect(duracaoSegundos).toBe(3600);
  });

  it("a fala marcada depois da hora que foi à IA fica presa no fim dela, sem se perder", async () => {
    responder(comSegmentos([
      { inicio: "00:10", fim: "00:20", falante: "F1", texto: "Começo." },
      { inicio: "1:05:00", fim: "1:05:30", falante: "F1", texto: "Depois da hora." },
    ]));
    const { segmentos, duracaoSegundos } = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" });
    expect(segmentos).toHaveLength(2);
    expect(segmentos[1].inicio).toBeLessThanOrEqual(SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX + 2);
    expect(duracaoSegundos).toBe(SEGUNDOS_DO_VIDEO_DO_YOUTUBE_MAX);
  });

  it("a duração de um vídeo curto é o fim da última fala", async () => {
    responder(comSegmentos([{ inicio: "00:00", fim: "02:14", falante: "F1", texto: "Um minuto de apresentação." }]));
    expect((await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" })).duracaoSegundos).toBe(134);
  });

  it("rótulo de voz com nome vira o falante anterior (o nome não vai ao banco)", async () => {
    responder(comSegmentos([
      { inicio: "00:01", fim: "00:03", falante: "F1", texto: "Oi." },
      { inicio: "00:04", fim: "00:06", falante: "Maria", texto: "Olá." },
    ]));
    const { segmentos } = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" });
    expect(segmentos.map(s => s.falante)).toEqual(["F1", "F1"]);
  });
});

describe("as falhas viram códigos que a tela traduz", () => {
  it("vídeo sem fala nenhuma: YOUTUBE_SEM_FALA", async () => {
    responder(comSegmentos([]));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_SEM_FALA");
  });

  it("vídeo só com música e ruído (as marcas entre colchetes): YOUTUBE_SEM_FALA", async () => {
    responder(comSegmentos([
      { inicio: "00:00", fim: "03:00", falante: "F1", texto: "[música]" },
      { inicio: "03:00", fim: "03:10", falante: "F1", texto: "[ruído] ♪" },
    ]));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_SEM_FALA");
  });

  it("uma fala de verdade no meio da música basta", async () => {
    responder(comSegmentos([
      { inicio: "00:00", fim: "03:00", falante: "F1", texto: "[música]" },
      { inicio: "03:00", fim: "03:10", falante: "F2", texto: "Obrigada!" },
    ]));
    expect((await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" })).segmentos).toHaveLength(2);
  });

  it("o 400 do vídeo privado ou não listado: YOUTUBE_VIDEO_PRIVADO, sem tentar a reserva", async () => {
    responder(recusa(400, "Request contains an invalid argument."));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_VIDEO_PRIVADO");
    expect(pedidos).toHaveLength(1);
  });

  it("a recusa pela chave (configuração do servidor) não é culpa do vídeo: YOUTUBE_IA_RECUSOU", async () => {
    responder(recusa(400, "API key not valid. Please pass a valid API key."));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_IA_RECUSOU");
  });

  it("o prazo esgotado do lado do Gemini (504 DEADLINE_EXCEEDED) é a IA que não deu conta a tempo, nunca 'vídeo privado'", async () => {
    responder({ status: 504, corpo: { error: { code: 504, message: "Deadline expired before operation could complete.", status: "DEADLINE_EXCEEDED" } } });
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_IA_INDISPONIVEL");
    expect(pedidos).toHaveLength(1);
  });

  it("o vídeo que passa do que a IA lê de uma vez: YOUTUBE_LONGO_DEMAIS", async () => {
    responder(recusa(400, "The input token count (1210000) exceeds the maximum number of tokens allowed (1048576)."));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_LONGO_DEMAIS");
  });

  it("a resposta cortada em MAX_TOKENS é fala demais para uma resposta: YOUTUBE_LONGO_DEMAIS, nunca transcrição pela metade", async () => {
    responder(comSegmentos([{ inicio: "00:01", fim: "00:02", falante: "F1", texto: "Oi." }], "MAX_TOKENS"));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_LONGO_DEMAIS");
  });

  it("a resposta barrada pela IA (RECITATION, SAFETY ou o vídeo bloqueado): YOUTUBE_IA_RECUSOU", async () => {
    responder(comSegmentos([], "RECITATION"));
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_IA_RECUSOU");
    responder({ corpo: { promptFeedback: { blockReason: "SAFETY" } } });
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_IA_RECUSOU");
  });

  it("a resposta que não é JSON do contrato: YOUTUBE_FALHOU", async () => {
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "não sou JSON" }] } }] } });
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_FALHOU");
    responder({ corpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ outra: [] }) }] } }] } });
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_FALHOU");
  });

  it("o principal sem cota passa à reserva, que responde", async () => {
    responder(
      { status: 429, corpo: { error: { message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" } } },
      comSegmentos([{ inicio: "00:01", fim: "00:02", falante: "F1", texto: "Oi." }]),
    );
    const resultado = await youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" });
    expect(pedidos.map(p => p.url.match(/models\/([^:]+)/)?.[1])).toEqual(["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
    expect(resultado.modelo).toBe("gemini-3.5-flash-lite");
    // A reserva recebe o mesmo vídeo cortado, com o raciocínio no formato dela.
    expect(pedidos[1].corpo.contents[0].parts[0].file_data.file_uri).toBe(CANONICA);
  });

  it("principal e reserva sem cota: YOUTUBE_IA_INDISPONIVEL", async () => {
    const semCota = { status: 429, corpo: { error: { message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" } } };
    responder(semCota, semCota);
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_IA_INDISPONIVEL");
  });

  it("a reserva que recusa o vídeo diz o motivo dela (o principal só estava lotado)", async () => {
    responder(
      { status: 429, corpo: { error: { message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" } } },
      recusa(400, "Request contains an invalid argument."),
    );
    expect(await codigoDe(youtube.transcreverVideoDoYoutube({ url: CANONICA, idioma: "pt-BR" }))).toBe("YOUTUBE_VIDEO_PRIVADO");
  });
});

describe("erroDoYoutubeSeRepete", () => {
  it("só fala demais e nenhuma fala se repetem com o mesmo vídeo; o resto pode dar certo numa leitura nova", () => {
    expect(erroDoYoutubeSeRepete("YOUTUBE_LONGO_DEMAIS")).toBe(true);
    expect(erroDoYoutubeSeRepete("YOUTUBE_SEM_FALA")).toBe(true);
    const outros = CODIGOS_DE_ERRO_DO_YOUTUBE.filter(codigo => codigo !== "YOUTUBE_LONGO_DEMAIS" && codigo !== "YOUTUBE_SEM_FALA");
    for (const codigo of [...outros, "ERRO_INTERROMPIDO", null, undefined]) expect(erroDoYoutubeSeRepete(codigo)).toBe(false);
  });
});

describe("codigoDaFalhaDoVideo", () => {
  it("dá o código de cada erro, e YOUTUBE_FALHOU para o que não conhece", () => {
    expect(youtube.codigoDaFalhaDoVideo(new youtube.ErroDoVideoDoYoutube("YOUTUBE_SEM_FALA"))).toBe("YOUTUBE_SEM_FALA");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRespostaCortadaError("MAX_TOKENS"))).toBe("YOUTUBE_LONGO_DEMAIS");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRespostaCortadaError("SAFETY"))).toBe("YOUTUBE_IA_RECUSOU");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(403, "The caller does not have permission"))).toBe("YOUTUBE_VIDEO_PRIVADO");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(401, ""))).toBe("YOUTUBE_IA_RECUSOU");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(404, "models/gemini-9 is not found for API version v1beta"))).toBe("YOUTUBE_IA_RECUSOU");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(413, ""))).toBe("YOUTUBE_LONGO_DEMAIS");
    // O 504 do Gemini chega como recusa (não é 429, 500 nem 503), mas é prazo esgotado: vem antes do ramo da recusa.
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(504, '{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}'))).toBe("YOUTUBE_IA_INDISPONIVEL");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiRecusouChamadaError(400, '{"error":{"status":"DEADLINE_EXCEEDED"}}'))).toBe("YOUTUBE_IA_INDISPONIVEL");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiCotaEsgotadaError())).toBe("YOUTUBE_IA_INDISPONIVEL");
    expect(youtube.codigoDaFalhaDoVideo(new GeminiIndisponivelError(504))).toBe("YOUTUBE_IA_INDISPONIVEL");
    expect(youtube.codigoDaFalhaDoVideo(new Error("O serviço de IA não conseguiu extrair os dados da transcrição."))).toBe("YOUTUBE_FALHOU");
  });
});
