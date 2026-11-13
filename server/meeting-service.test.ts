import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

// A IA é um dublê: o que se prova é COM QUE TETOS cada chamada sai.
const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

// A tradução lê a transcrição e o cache de traduções: drizzle de verdade
// sobre um cliente mysql2 falso (molde de enriquecimento-desfazer.test.ts),
// que também captura o SQL.
const banco = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  // id, meeting_id, owner_id, transcript, segments, language, duration_seconds, created_at, updated_at
  transcricao: ["tr-1", "reuniao-1", "dona-1", "Fala longa da reunião.", null, "pt-BR", 120, 1000, 1000] as unknown[],
  leiturasDaTranscricao: 0,
  // Um reprocessamento trocou a transcrição enquanto o LLM traduzia: a releitura devolve outro id.
  transcricaoTrocada: false,
  // id, meeting_id, owner_id, language, translated_text, created_at, updated_at
  traducaoGuardada: null as unknown[] | null,
}));
vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      banco.consultas.push({ sql: config.sql, params });
      const sql = config.sql;
      if (sql.startsWith("insert")) return [{ affectedRows: 1 }, []];
      if (sql.includes("from `meeting_transcripts`")) {
        banco.leiturasDaTranscricao += 1;
        if (banco.transcricaoTrocada && banco.leiturasDaTranscricao > 1) return [[["tr-2"]], []];
        return [[banco.transcricao], []];
      }
      if (sql.includes("from `meeting_transcript_translations`")) return [banco.traducaoGuardada ? [banco.traducaoGuardada] : [], []];
      return [[], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const {
  decodeMeetingAudio,
  extractMeetingData,
  MAX_MEETING_AUDIO_BYTES,
  MAX_MEETING_DURATION_SECONDS,
  MEETING_TRANSCRIPT_LANGUAGES,
  translatePrivateMeetingTranscript,
} = await import("./meeting-service");

describe("Assistente de Reuniões — validação de áudio", () => {
  it("aceita áudio WebM em base64 dentro do limite", () => {
    const audio = decodeMeetingAudio(Buffer.from("audio de teste").toString("base64"), "audio/webm");
    expect(audio.toString()).toBe("audio de teste");
  });

  it("aceita o cabeçalho com codecs produzido pelo MediaRecorder", () => {
    const encoded = Buffer.from("audio gravado").toString("base64");
    const audio = decodeMeetingAudio(`data:audio/webm;codecs=opus;base64,${encoded}`, "audio/webm");
    expect(audio.toString()).toBe("audio gravado");
  });

  it("aceita MP3 enviado como alternativa à gravação do microfone", () => {
    const audio = decodeMeetingAudio(Buffer.from("audio mp3 de teste").toString("base64"), "audio/mpeg");
    expect(audio.toString()).toBe("audio mp3 de teste");
  });

  it("rejeita formatos não suportados", () => {
    expect(() => decodeMeetingAudio("dGVzdGU=", "video/mp4")).toThrow("Formato de áudio");
  });

  it("mantém os limites de segurança do modo por solicitação", () => {
    expect(MAX_MEETING_AUDIO_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_MEETING_DURATION_SECONDS).toBe(10 * 60);
  });

  it("disponibiliza os dez idiomas do MMM para a tradução", () => {
    expect(MEETING_TRANSCRIPT_LANGUAGES).toEqual(["pt-BR", "en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"]);
  });
});

// Cada chamada de IA tem um teto por tentativa e um orçamento total (ver
// server/_core/llm.ts). O padrão (60 s / 120 s) serve ao chat; a reunião tem
// dois usos com tamanhos próprios, e sem os parâmetros na chamada o padrão
// volta em silêncio — um deles estoura sem 2ª tentativa.
describe("Assistente de Reuniões — tetos das chamadas de IA", () => {
  beforeEach(() => {
    invokeLLM.mockReset();
    banco.consultas = [];
    banco.leiturasDaTranscricao = 0;
    banco.transcricaoTrocada = false;
    banco.traducaoGuardada = null;
  });

  it("a extração roda dentro do submit síncrono: 45 s por tentativa e 60 s de orçamento", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });

    const r = await extractMeetingData("Reunião com a Ana sobre a mina de lítio.");

    expect(r).toEqual({ entities: [], contacts: [] });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    // Mutantes "sem os parâmetros" (padrão 60/120) e "teto de 300 s".
    expect(invokeLLM).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000, orcamentoMs: 60_000 }));
    // Categoria que a dona não vê não é pedida ao modelo (a confirmação grava category null de todo jeito).
    const { response_format } = invokeLLM.mock.calls[0][0] as { response_format: unknown };
    expect(JSON.stringify(response_format)).toContain("\"trecho\"");
    expect(JSON.stringify(response_format)).not.toContain("\"categoria\"");
  });

  it("a tradução da transcrição inteira (até 48 000 caracteres de saída) vai com 180 s por tentativa e 200 s de orçamento", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk from the meeting." } }] });

    const r = await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en");

    expect(r).toEqual({ language: "en", text: "Long talk from the meeting.", cached: false });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    // Mutante "padrão 60 s / 120 s": 12 000 tokens de saída a 150–250 tok/s
    // são 48–80 s de geração; a 1ª tentativa morre no meio e a 2ª não cabe.
    expect(invokeLLM).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 180_000, orcamentoMs: 200_000 }));
    const chamada = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(chamada.messages.at(-1)).toEqual({ role: "user", content: "Fala longa da reunião." });

    // A transcrição e o cache foram lidos pela dona, e a tradução gravada com ela.
    for (const c of banco.consultas) expect(c.sql, c.sql).toMatch(/`owner_id`/);
    const gravacao = banco.consultas.find(c => c.sql.startsWith("insert into `meeting_transcript_translations`"))!;
    expect(gravacao).toBeDefined();
    expect(gravacao.params).toEqual(expect.arrayContaining(["dona-1", "reuniao-1", "en", "Long talk from the meeting."]));
  });

  it("a transcrição foi trocada por um reprocessamento enquanto o LLM traduzia: a tradução volta para quem pediu, mas NÃO vai para o cache", async () => {
    banco.transcricaoTrocada = true;
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Old talk from the meeting." } }] });

    const r = await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en");

    expect(r).toEqual({ language: "en", text: "Old talk from the meeting.", cached: false });
    expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(false);
    // a releitura é da transcrição DA dona, desta reunião
    const releitura = banco.consultas.filter(c => c.sql.includes("from `meeting_transcripts`")).at(-1)!;
    expect(releitura.sql).toMatch(/`owner_id` = \?/);
    expect(releitura.params).toEqual(expect.arrayContaining(["dona-1", "reuniao-1"]));
  });
});

// O teto do link aberto entra por `antesDeChamarAIA`: ele tem de rodar só no
// caminho que vai à IA, e antes dela, para que a recusa não gaste o pedido.
describe("Tradução da transcrição — antesDeChamarAIA (teto do link aberto)", () => {
  beforeEach(() => {
    invokeLLM.mockReset();
    banco.consultas = [];
    banco.leiturasDaTranscricao = 0;
    banco.transcricaoTrocada = false;
    banco.traducaoGuardada = null;
  });

  it("tradução nova: roda uma vez, ANTES do pedido à IA", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk." } }] });
    const antes = vi.fn();
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes);
    expect(antes).toHaveBeenCalledTimes(1);
    expect(antes.mock.invocationCallOrder[0]).toBeLessThan(invokeLLM.mock.invocationCallOrder[0]);
  });

  it("a recusa dele para tudo: a IA não é chamada e nada é gravado", async () => {
    const recusa = new Error("teto do link");
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", () => { throw recusa; })).rejects.toBe(recusa);
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(false);
  });

  it("tradução guardada, idioma da transcrição e pt-BR não vão à IA, e ele não roda", async () => {
    const antes = vi.fn();
    banco.traducaoGuardada = ["tt-1", "reuniao-1", "dona-1", "en", "Saved talk.", 1000, 1000];
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes)).resolves.toEqual({ language: "en", text: "Saved talk.", cached: true });
    banco.traducaoGuardada = null;
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "pt-BR", antes);
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "pt", antes);
    expect(antes).not.toHaveBeenCalled();
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});
