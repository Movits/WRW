import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// O bucket é um dublê: o que se prova aqui é o banco (a linha antes do upload,
// o UNIQUE da posição, os estados) e a chave exata que vai ao bucket.
const storagePut = vi.hoisted(() => vi.fn());
vi.mock("./storage", async (original) => ({ ...(await original<typeof import("./storage")>()), storagePut: (...args: unknown[]) => storagePut(...args) }));

const { getDb } = await import("./db");
const { meetingAudioSlices, meetings, users } = await import("../drizzle/schema");
const { encerrarGravacaoEmPartes, iniciarReuniaoEmPartes, RecusaDaParte, receberParte, FalhaPassageiraDaParte } = await import("./fatias-de-reuniao");

/**
 * A reunião gravada em partes (G5) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Donas com id
 * aleatório: a limpeza só alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-partes-${crypto.randomUUID()}`;
const OUTRA = `teste-partes-${crypto.randomUUID()}`;

/** Um WAV válido de `segundos` (8 kHz, mono, 16 bits): a duração é medida nos bytes. */
function wav(segundos: number, semente = 0): Buffer {
  const amostras = 8000 * segundos;
  const dados = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) dados.writeInt16LE(((i * 37 + semente) % 2000) - 1000, i * 2);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(1, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(8000, 24); cabecalho.writeUInt32LE(16000, 28); cabecalho.writeUInt16LE(2, 32); cabecalho.writeUInt16LE(16, 34);
  cabecalho.write("data", 36); cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

async function recusa(promessa: Promise<unknown>) {
  try { await promessa; } catch (erro) { if (erro instanceof RecusaDaParte) return erro.codigo; throw erro; }
  throw new Error("era para recusar");
}

const iniciar = (dona = DONA) => iniciarReuniaoEmPartes(dona, { title: "Reunião em partes", language: "pt-BR", consentNoticeVersion: "2026-11-14", origem: "gravacao" });
const partes = async (meetingId: string) => (await getDb())!.select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId));

describe.skipIf(!temBanco)("Reunião gravada em partes no banco (integração)", () => {
  beforeAll(async () => {
    await (await getDb())!.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    for (const dona of [DONA, OUTRA]) {
      await db.delete(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, dona));
      await db.delete(meetings).where(eq(meetings.ownerId, dona));
      await db.delete(users).where(eq(users.openId, dona));
    }
  });
  beforeEach(() => {
    storagePut.mockReset();
    storagePut.mockImplementation(async (chave: string) => ({ key: chave, url: `/manus-storage/${chave}` }));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a reunião nasce no início da gravação, em partes, com o aviso e o idioma", async () => {
    const { id } = await iniciar();
    const [linha] = await (await getDb())!.select().from(meetings).where(eq(meetings.id, id));
    expect(linha).toMatchObject({ ownerId: DONA, status: "recording", audioPipeline: "slices", origem: "gravacao", consentGranted: true, consentNoticeVersion: "2026-11-14", language: "pt-BR" });
  });

  it("a parte vira linha 'uploading' ANTES do upload, sobe com a chave EXATA da linha e fica 'received'", async () => {
    const { id } = await iniciar();
    let linhaNoUpload: unknown;
    storagePut.mockImplementation(async (chave: string, _bytes: Buffer, tipo: string, opcoes: unknown) => {
      linhaNoUpload = (await partes(id))[0];
      expect(tipo).toBe("audio/wav");
      expect(opcoes).toEqual({ chaveExata: true });
      return { key: chave, url: `/manus-storage/${chave}` };
    });
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(3) })).toEqual({ seq: 0, repetida: false });
    expect(linhaNoUpload).toMatchObject({ status: "uploading", seq: 0 });
    const [linha] = await partes(id);
    expect(linha).toMatchObject({ status: "received", durationMs: 3000, mimeType: "audio/wav", ownerId: DONA });
    expect(linha.storageKey).toMatch(new RegExp(`^meetings/${DONA}/${id}/partes/0000-[0-9a-f]{8}\\.wav$`));
    expect(storagePut.mock.calls[0][0]).toBe(linha.storageKey);
    expect(linha.storageUrl).toBe(`/manus-storage/${linha.storageKey}`);
  });

  it("a mesma parte reenviada é aceita sem duplicar nem subir de novo; outro conteúdo na posição é recusado", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(2) });
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(2) })).toEqual({ seq: 0, repetida: true });
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(2, 7) }))).toBe("CONTEUDO_DIFERENTE");
    expect(await partes(id)).toHaveLength(1);
  });

  it("dois envios da mesma parte ao mesmo tempo: uma linha só", async () => {
    const { id } = await iniciar();
    const audio = wav(2);
    const resultados = await Promise.all([0, 1, 2].map(() => receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: audio })));
    expect(resultados.every(r => r.seq === 1)).toBe(true);
    expect(await partes(id)).toHaveLength(1);
  });

  it("bucket fora: falha passageira, a linha fica 'uploading', e o reenvio sobe para a MESMA chave", async () => {
    const { id } = await iniciar();
    storagePut.mockRejectedValueOnce(new Error("B2 fora"));
    const erro = await receberParte({ ownerId: DONA, meetingId: id, seq: 2, mimeType: "audio/wav", bytes: wav(2) }).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaPassageiraDaParte);
    const [antes] = await partes(id);
    expect(antes.status).toBe("uploading");
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 2, mimeType: "audio/wav", bytes: wav(2) })).toEqual({ seq: 2, repetida: false });
    const [depois] = await partes(id);
    expect(depois.status).toBe("received");
    expect(storagePut.mock.calls.map(c => c[0])).toEqual([antes.storageKey, antes.storageKey]);
  });

  it("reunião de outra dona ou que não existe: SEM_REUNIAO, sem linha nem upload", async () => {
    const { id } = await iniciar(OUTRA);
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("SEM_REUNIAO");
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: crypto.randomUUID(), seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("SEM_REUNIAO");
    expect(await partes(id)).toHaveLength(0);
    expect(storagePut).not.toHaveBeenCalled();
  });

  it("formato, tamanho, duração ilegível e posição: recusas antes do banco", async () => {
    const { id } = await iniciar();
    const base = { ownerId: DONA, meetingId: id, seq: 0 };
    expect(await recusa(receberParte({ ...base, mimeType: "video/mp4", bytes: wav(1) }))).toBe("FORMATO");
    expect(await recusa(receberParte({ ...base, mimeType: "audio/wav", bytes: Buffer.alloc(0) }))).toBe("GRANDE_DEMAIS");
    expect(await recusa(receberParte({ ...base, mimeType: "audio/wav", bytes: Buffer.from("isto não é áudio") }))).toBe("SEM_DURACAO");
    expect(await recusa(receberParte({ ...base, seq: -1, mimeType: "audio/wav", bytes: wav(1) }))).toBe("POSICAO");
    expect(await partes(id)).toHaveLength(0);
  });

  it("até a G13, a soma das partes segue o teto de 10 min da reunião", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(400) });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(300) }))).toBe("LONGA_DEMAIS");
  });

  it("encerrar guarda o total e fecha a reunião para partes novas; repetir o mesmo fim é aceito", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });
    expect(await encerrarGravacaoEmPartes(DONA, id, 2)).toEqual({ partes: 2 });
    expect(await encerrarGravacaoEmPartes(DONA, id, 2)).toEqual({ partes: 2 });
    const [linha] = await (await getDb())!.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
    expect(linha).toMatchObject({ status: "uploading", expectedSlices: 2 });
    // A parte que faltava ainda chega depois do fim ('uploading' aceita).
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(1) })).toEqual({ seq: 1, repetida: false });
    expect(await recusa(encerrarGravacaoEmPartes(DONA, id, 3))).toBe("FORA_DO_ESTADO");
  });

  it("encerrar com menos partes do que já chegaram é recusado, e encerrar a de outra dona também", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 2, mimeType: "audio/wav", bytes: wav(1) });
    expect(await recusa(encerrarGravacaoEmPartes(DONA, id, 2))).toBe("POSICAO");
    expect(await recusa(encerrarGravacaoEmPartes(OUTRA, id, 3))).toBe("SEM_REUNIAO");
  });

  it("reunião do envio único não recebe partes", async () => {
    const id = crypto.randomUUID();
    const agora = Date.now();
    await (await getDb())!.insert(meetings).values({ id, ownerId: DONA, title: "Envio único", status: "recording", consentGranted: true, consentAt: agora, createdAt: agora, updatedAt: agora });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("FORA_DO_ESTADO");
  });
});
