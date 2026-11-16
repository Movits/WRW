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
  // Outro pedido guardou a mesma tradução primeiro: o UNIQUE recusa o insert.
  insertDuplicado: false,
  // Qualquer outra recusa do banco ao guardar a tradução.
  insertFalha: null as Error | null,
}));
vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      banco.consultas.push({ sql: config.sql, params });
      const sql = config.sql;
      if (sql.startsWith("insert") && banco.insertFalha) throw banco.insertFalha;
      if (sql.startsWith("insert") && banco.insertDuplicado) {
        throw Object.assign(new Error("Duplicate entry for key 'meeting_transcript_translations_owner_meeting_language_idx'"), { code: "ER_DUP_ENTRY", errno: 1062 });
      }
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
  duracaoConferidaDoAudio,
  extractMeetingData,
  JANELA_DA_EXTRACAO,
  JANELA_DA_TRADUCAO,
  juntarExtracoes,
  MAX_MEETING_AUDIO_BYTES,
  MAX_MEETING_DURATION_SECONDS,
  MENSAGEM_REUNIAO_LONGA_DEMAIS,
  MEETING_TRANSCRIPT_LANGUAGES,
  translatePrivateMeetingTranscript,
} = await import("./meeting-service");
const { ENVIO_UNICO_BYTES_MAX, ENVIO_UNICO_SEGUNDOS_MAX, GRAVACAO_EM_PARTES_SEGUNDOS_MAX } = await import("@shared/const");

/** Um WAV mínimo de `segundos` (mono, 8 bits, 1 kHz): a duração é medida nos bytes. */
function wavDe(segundos: number): Buffer {
  const dados = Buffer.alloc(segundos * 1000, 128);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(1, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(1000, 24); cabecalho.writeUInt32LE(1000, 28); cabecalho.writeUInt16LE(1, 32); cabecalho.writeUInt16LE(8, 34);
  cabecalho.write("data", 36); cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

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
    // Os nomes de sempre são os tetos do envio único que a tela também lê
    // (shared/const.ts); as 12 h da gravação em partes (G13a) não chegam aqui.
    expect(MAX_MEETING_AUDIO_BYTES).toBe(ENVIO_UNICO_BYTES_MAX);
    expect(MAX_MEETING_DURATION_SECONDS).toBe(ENVIO_UNICO_SEGUNDOS_MAX);
    expect(MAX_MEETING_DURATION_SECONDS).toBeLessThan(GRAVACAO_EM_PARTES_SEGUNDOS_MAX);
  });

  it("o envio único continua recusando o áudio acima de 10 MB (G13a não o muda)", () => {
    const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
    expect(decodeMeetingAudio(base64(10 * 1024 * 1024), "audio/webm")).toHaveLength(10 * 1024 * 1024);
    expect(() => decodeMeetingAudio(base64(10 * 1024 * 1024 + 1), "audio/webm")).toThrow("O áudio deve ter no máximo 10 MB.");
  });

  it("o envio único continua recusando a duração medida acima de 600 s, com a folga de 5 s (G13a não o muda)", () => {
    expect(duracaoConferidaDoAudio(wavDe(600))).toBe(600);
    expect(duracaoConferidaDoAudio(wavDe(605))).toBe(605);
    expect(() => duracaoConferidaDoAudio(wavDe(606))).toThrow(MENSAGEM_REUNIAO_LONGA_DEMAIS);
    expect(() => duracaoConferidaDoAudio(wavDe(3600))).toThrow(MENSAGEM_REUNIAO_LONGA_DEMAIS);
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

  it("a extração pede o modelo da função dela (LLM_MODEL_EXTRACAO; sem ela, o LLM_MODEL); a tradução fica no modelo geral", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });
    await extractMeetingData("Reunião com a Ana sobre a mina de lítio.");
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(invokeLLM.mock.calls[0][0]).toMatchObject({ funcao: "extracao" });

    invokeLLM.mockReset();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk from the meeting." } }] });
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en");
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect((invokeLLM.mock.calls[0][0] as { funcao?: unknown }).funcao).toBeUndefined();
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
    banco.insertDuplicado = false;
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", "Fala longa da reunião.", null, "pt-BR", 120, 1000, 1000];
  });

  it("dois pedidos da mesma tradução ao mesmo tempo: uma chamada à IA, uma vaga do teto, os dois recebem o texto", async () => {
    let entregar!: (valor: unknown) => void;
    invokeLLM.mockReturnValue(new Promise(pronto => { entregar = pronto; }));
    const antes1 = vi.fn();
    const antes2 = vi.fn();
    const primeiro = translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes1);
    const segundo = translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes2);
    // Os dois passam pelo cache vazio antes de a IA responder.
    await vi.waitFor(() => expect(invokeLLM).toHaveBeenCalledTimes(1));
    await new Promise(pronto => setTimeout(pronto, 20));
    entregar({ choices: [{ message: { content: "Long talk." } }] });
    await expect(primeiro).resolves.toEqual({ language: "en", text: "Long talk.", cached: false });
    await expect(segundo).resolves.toEqual({ language: "en", text: "Long talk.", cached: false });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(antes1.mock.calls.length + antes2.mock.calls.length).toBe(1);
    expect(banco.consultas.filter(c => c.sql.startsWith("insert"))).toHaveLength(1);
  });

  it("terminada a primeira, um pedido novo vai à IA de novo (a espera não vira cache em memória)", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk." } }] });
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en");
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en");
    expect(invokeLLM).toHaveBeenCalledTimes(2);
  });

  it("idiomas diferentes não esperam um pelo outro", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Traduzido." } }] });
    await Promise.all([
      translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en"),
      translatePrivateMeetingTranscript("dona-1", "reuniao-1", "es"),
    ]);
    expect(invokeLLM).toHaveBeenCalledTimes(2);
  });

  it("chave duplicada no cache (outro pedido guardou antes): quem pediu recebe a tradução, sem erro", async () => {
    banco.insertDuplicado = true;
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk." } }] });
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en")).resolves.toEqual({ language: "en", text: "Long talk.", cached: false });
  });

  it("outra falha ao guardar continua sendo erro: só a chave duplicada é tolerada", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Long talk." } }] });
    banco.insertFalha = Object.assign(new Error("Data too long for column 'translated_text'"), { code: "ER_DATA_TOO_LONG", errno: 1406 });
    try {
      await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en"))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "ER_DATA_TOO_LONG" }) });
    } finally {
      banco.insertFalha = null;
    }
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

  it("reunião em inglês: pedir pt-BR TRADUZ (não devolve o inglês), e pedir inglês devolve o original", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", "Long talk from the meeting.", null, "en", 120, 1000, 1000];
    invokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: "Fala longa da reunião." } }] });
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "pt-BR"))
      .resolves.toEqual({ language: "pt-BR", text: "Fala longa da reunião.", cached: false });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(invokeLLM.mock.calls[0][0].messages[0].content).toContain("para português do Brasil");
    invokeLLM.mockClear();
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en"))
      .resolves.toEqual({ language: "en", text: "Long talk from the meeting.", cached: true });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("reunião antiga gravada como 'pt': pedir pt-BR devolve o original, sem IA", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", "Fala antiga.", null, "pt", 120, 1000, 1000];
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "pt-BR"))
      .resolves.toEqual({ language: "pt-BR", text: "Fala antiga.", cached: true });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("idioma fora dos 10 é recusado antes de ler o banco", async () => {
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "it")).rejects.toThrow("Idioma de tradução não suportado.");
    expect(banco.consultas).toHaveLength(0);
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

// G8: a reunião longa é lida INTEIRA, em janelas, em vez de cortada em silêncio.
describe("Reunião longa em janelas (G8)", () => {
  const TRANSCRICAO_PADRAO = ["tr-1", "reuniao-1", "dona-1", "Fala longa da reunião.", null, "pt-BR", 120, 1000, 1000];
  const longa = (tamanho: number) => Array.from({ length: Math.ceil(tamanho / 30) }, (_, i) => `Fala ${String(i).padStart(5, "0")} da reunião longa, sem corte.`).join("\n").slice(0, tamanho);
  const extracao = (entities: unknown[], contacts: unknown[] = []) => ({ choices: [{ message: { content: JSON.stringify({ entities, contacts }) } }] });
  const pessoa = (fullName: string, extra: Record<string, unknown> = {}) => ({
    fullName, jobTitle: null, company: null, phone: null, email: null, confidence: 0.8, tipoPessoa: "nao_informado", oQueTenho: [], oQuePreciso: [], ...extra,
  });

  beforeEach(() => {
    invokeLLM.mockReset();
    banco.consultas = [];
    banco.leiturasDaTranscricao = 0;
    banco.transcricaoTrocada = false;
    banco.traducaoGuardada = null;
    banco.insertDuplicado = false;
    banco.insertFalha = null;
    banco.transcricao = [...TRANSCRICAO_PADRAO];
  });

  it("a extração lê todas as janelas, na ordem, e o fim da reunião chega à IA", async () => {
    const texto = longa(JANELA_DA_EXTRACAO * 2 + 500);
    invokeLLM.mockResolvedValue(extracao([]));
    await extractMeetingData(texto);
    expect(invokeLLM).toHaveBeenCalledTimes(3);
    const enviados = invokeLLM.mock.calls.map(c => (c[0] as { messages: Array<{ content: string }> }).messages[1].content);
    for (const enviado of enviados) expect(enviado.length).toBeLessThan(JANELA_DA_EXTRACAO + 200);
    expect(enviados[2]).toContain(texto.slice(-40));
    // Toda janela é extração: nenhuma volta ao modelo geral.
    for (const [pedido] of invokeLLM.mock.calls) expect(pedido).toMatchObject({ funcao: "extracao" });
  });

  it("uma janela que falha derruba a extração inteira (meia reunião não passa por inteira)", async () => {
    invokeLLM.mockResolvedValueOnce(extracao([])).mockRejectedValueOnce(new Error("IA fora"));
    await expect(extractMeetingData(longa(JANELA_DA_EXTRACAO * 2))).rejects.toThrow("IA fora");
  });

  it("a junção tira as repetidas: entidade com a maior confiança, pessoa por e-mail, telefone ou nome", () => {
    const r = juntarExtracoes([
      { entities: [{ type: "company", value: "ACME", normalizedValue: "acme", confidence: 0.6 }], contacts: [
        pessoa("Ana Lima", { email: "ana@exemplo.invalid", oQueTenho: [{ texto: "vinho", trecho: "tenho vinho", confianca: 0.9 }] }),
        pessoa("Bia", { phone: "(11) 9000-0000" }),
      ] },
      { entities: [{ type: "company", value: "Acme ", normalizedValue: null, confidence: 0.9 }, { type: "person", value: "ACME", normalizedValue: null, confidence: 0.5 }], contacts: [
        pessoa("Ana", { email: "ANA@exemplo.invalid", company: "Vinícola", oQuePreciso: [{ texto: "frete", trecho: "preciso de frete", confianca: 0.8 }] }),
        pessoa("Beatriz", { phone: "11 90000000" }),
        pessoa("ana lima"),
      ] },
    ]);
    expect(r.entities).toEqual([
      { type: "company", value: "Acme ", normalizedValue: null, confidence: 0.9 },
      { type: "person", value: "ACME", normalizedValue: null, confidence: 0.5 },
    ]);
    expect(r.contacts).toHaveLength(2);
    expect(r.contacts[0]).toMatchObject({ fullName: "Ana Lima", company: "Vinícola", oQueTenho: [{ texto: "vinho" }], oQuePreciso: [{ texto: "frete" }] });
    expect(r.contacts[1]).toMatchObject({ fullName: "Bia", phone: "(11) 9000-0000" });
  });

  it("homônimos com e-mail ou telefone diferentes ficam separados; o mesmo item dito duas vezes vira uma pendência", () => {
    const r = juntarExtracoes([
      { entities: [], contacts: [pessoa("João Lima", { email: "joao1@exemplo.invalid", oQueTenho: [{ texto: "Frete", trecho: "faço frete", confianca: 0.9 }] })] },
      { entities: [], contacts: [
        pessoa("João Lima", { email: "joao2@exemplo.invalid" }),
        pessoa("joão lima", { phone: null, email: "JOAO1@exemplo.invalid", oQueTenho: [{ texto: "frete ", trecho: "faço frete", confianca: 0.8 }] }),
      ] },
    ]);
    expect(r.contacts.map(c => c.email)).toEqual(["joao1@exemplo.invalid", "joao2@exemplo.invalid"]);
    expect(r.contacts[0].oQueTenho).toHaveLength(1);
  });

  it("acima do teto, ficam as de maior confiança, não as do começo da reunião", () => {
    const comeco = Array.from({ length: 200 }, (_, i) => ({ type: "need" as const, value: `comeco-${i}`, normalizedValue: null, confidence: 0.5 }));
    const fim = [{ type: "need" as const, value: "fim-importante", normalizedValue: null, confidence: 0.95 }];
    const r = juntarExtracoes([{ entities: comeco, contacts: [] }, { entities: fim, contacts: [] }]);
    expect(r.entities).toHaveLength(200);
    expect(r.entities[0].value).toBe("fim-importante");
  });

  it("a junção respeita os tetos da reunião inteira (200 entidades, 40 pessoas)", () => {
    const partes = Array.from({ length: 4 }, (_, p) => ({
      entities: Array.from({ length: 80 }, (_, i) => ({ type: "need" as const, value: `n${p}-${i}`, normalizedValue: null, confidence: 0.7 })),
      contacts: Array.from({ length: 20 }, (_, i) => pessoa(`Pessoa ${p}-${i}`)),
    }));
    const r = juntarExtracoes(partes as never);
    expect(r.entities).toHaveLength(200);
    expect(r.contacts).toHaveLength(40);
  });

  it("tradução longa: responde 'em andamento' na hora, traduz janela por janela em segundo plano e guarda a junção", async () => {
    const texto = longa(JANELA_DA_TRADUCAO * 2 + 100);
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", texto, null, "pt-BR", 3600, 1000, 1000];
    let soltar!: () => void;
    const portao = new Promise<void>(resolve => { soltar = resolve; });
    let n = 0;
    invokeLLM.mockImplementation(async () => { await portao; n += 1; return { choices: [{ message: { content: `janela ${n}` } }] }; });
    const antes = vi.fn();

    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes))
      .resolves.toEqual({ language: "en", text: null, cached: false, emAndamento: true });
    // Pedir de novo enquanto traduz: "em andamento", sem nova vaga do teto nem nova chamada.
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "en", antes)).resolves.toMatchObject({ emAndamento: true });
    expect(antes).toHaveBeenCalledTimes(1);

    soltar();
    await vi.waitFor(() => expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(true));
    expect(invokeLLM).toHaveBeenCalledTimes(3);
    const insert = banco.consultas.find(c => c.sql.startsWith("insert"))!;
    expect(insert.params).toContain("janela 1\njanela 2\njanela 3");
    const ultimaJanela = (invokeLLM.mock.calls[2][0] as { messages: Array<{ content: string }> }).messages[1].content;
    expect(ultimaJanela).toContain(texto.slice(-40));
  });

  it("tradução longa que falha: o próximo pedido recebe o erro uma vez, e o seguinte recomeça", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", longa(JANELA_DA_TRADUCAO * 2), null, "pt-BR", 3600, 1000, 1000];
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeLLM.mockRejectedValue(new Error("cota"));
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "es")).resolves.toMatchObject({ emAndamento: true });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("[Reuniões] a tradução longa falhou:", expect.stringContaining("cota")));
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "es")).rejects.toThrow("cota");
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "es")).resolves.toMatchObject({ emAndamento: true });
    // Espera o segundo plano terminar: o insert dele não pode cair no teste seguinte.
    await vi.waitFor(() => expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(true));
  });

  it("a falha da tradução longa vale só por 2 min: quem volta depois recomeça, sem erro velho", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", longa(JANELA_DA_TRADUCAO * 2), null, "pt-BR", 3600, 1000, 1000];
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeLLM.mockRejectedValue(new Error("cota"));
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "de");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 3 * 60_000);
    try {
      invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
      await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "de")).resolves.toMatchObject({ emAndamento: true });
    } finally {
      relogio.mockRestore();
    }
    await vi.waitFor(() => expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(true));
  });

  it("o log da falha não leva a mensagem crua do driver (o SQL traria o texto da reunião)", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", longa(JANELA_DA_TRADUCAO * 2), null, "pt-BR", 3600, 1000, 1000];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const erroDoDriver = Object.assign(new Error("Failed query: insert ... TEXTO SIGILOSO DA REUNIÃO"), { query: "insert into `meeting_transcript_translations` values (?)" });
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    banco.insertFalha = erroDoDriver;
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "ja");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(JSON.stringify(log.mock.calls)).not.toContain("TEXTO SIGILOSO");
  });

  it("janela que volta vazia derruba a tradução inteira, em vez de guardar um buraco", async () => {
    banco.transcricao = ["tr-1", "reuniao-1", "dona-1", longa(JANELA_DA_TRADUCAO * 2), null, "pt-BR", 3600, 1000, 1000];
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: "primeira" } }] }).mockResolvedValueOnce({ choices: [{ message: { content: "  " } }] });
    await translatePrivateMeetingTranscript("dona-1", "reuniao-1", "fr");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(banco.consultas.some(c => c.sql.startsWith("insert"))).toBe(false);
    await expect(translatePrivateMeetingTranscript("dona-1", "reuniao-1", "fr")).rejects.toThrow("Não foi possível traduzir a transcrição.");
  });
});
