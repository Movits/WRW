import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// O bucket é um dublê: o que se prova aqui é o banco (a linha antes do upload,
// o UNIQUE da posição, os estados) e a chave exata que vai ao bucket.
const storagePut = vi.hoisted(() => vi.fn());
// O áudio da parte sai do bucket com todas as versões (no B2, que guarda
// versões, o DELETE simples só esconderia a voz).
const storageApagarTodasAsVersoes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async (original) => ({
  ...(await original<typeof import("./storage")>()),
  storagePut: (...args: unknown[]) => storagePut(...args),
  storageApagarTodasAsVersoes: (...args: unknown[]) => storageApagarTodasAsVersoes(...args),
  storageDelete: async () => { throw new Error("o áudio de reunião não sai por storageDelete"); },
}));

const { getDb } = await import("./db");
const { meetingAudioSlices, meetings, users } = await import("../drizzle/schema");
const {
  encerrarGravacaoEmPartes, iniciarReuniaoEmPartes, RecusaDaParte, receberParte, FalhaPassageiraDaParte,
  DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS, PARTES_NO_MAXIMO,
} = await import("./fatias-de-reuniao");
const { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } = await import("@shared/const");
const { deletePrivateMeeting, getPrivateMeeting, limparGravacoesVencidas, MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA } = await import("./meeting-service");
const { appRouter } = await import("./routers");
const { TRPCError } = await import("@trpc/server");

/**
 * A reunião gravada em partes (G5) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Donas com id
 * aleatório: a limpeza só alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-partes-${crypto.randomUUID()}`;
const OUTRA = `teste-partes-${crypto.randomUUID()}`;

/**
 * Um WAV válido de `segundos` (mono, 16 bits; 8 kHz salvo a `taxa` pedida): a
 * duração é medida nos bytes. A parte longa (12 min) vai com taxa baixa, para o
 * teste não montar 11 MB de áudio.
 */
function wav(segundos: number, semente = 0, taxa = 8000): Buffer {
  const amostras = taxa * segundos;
  const dados = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) dados.writeInt16LE(((i * 37 + semente) % 2000) - 1000, i * 2);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(1, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(taxa, 24); cabecalho.writeUInt32LE(taxa * 2, 28); cabecalho.writeUInt16LE(2, 32); cabecalho.writeUInt16LE(16, 34);
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
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
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

  it("G13a: a soma das partes vai até 12 h + 10 min; no limite entra, um segundo além é recusado", async () => {
    const { id } = await iniciar();
    const teto = GRAVACAO_EM_PARTES_SEGUNDOS_MAX + FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS;
    expect(teto).toBe(12 * 3600 + 10 * 60);
    // As horas já recebidas entram direto no banco: 72 partes de áudio de
    // verdade seriam centenas de MB só para chegar perto do teto. A soma lê a
    // duração gravada em cada linha, que é o que importa aqui.
    const agora = Date.now();
    await (await getDb())!.insert(meetingAudioSlices).values({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, seq: 0, status: "received",
      storageKey: `meetings/${DONA}/${id}/partes/0000-horas.wav`, storageUrl: `/manus-storage/meetings/${DONA}/${id}/partes/0000-horas.wav`,
      mimeType: "audio/wav", sizeBytes: 1, sha256: "0".repeat(64), durationMs: (teto - 3) * 1000,
      expiresAt: agora + 60_000, createdAt: agora, updatedAt: agora,
    });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(4) }))).toBe("LONGA_DEMAIS");
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(3) })).toEqual({ seq: 1, repetida: false });
  });

  it("G13a: a parte de 12 min (720 s) entra inteira; a de 721 s é recusada", async () => {
    expect(DURACAO_MAXIMA_DA_PARTE_SEGUNDOS).toBe(720);
    const { id } = await iniciar();
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(720, 0, 1000) })).toEqual({ seq: 0, repetida: false });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(721, 0, 1000) }))).toBe("LONGA_DEMAIS");
    expect((await partes(id)).map(p => [p.seq, p.durationMs])).toEqual([[0, 720_000]]);
  });

  it("G13a: até 200 partes — a posição 199 entra e a 200 é recusada; encerrar com 200 vale, com 201 não", async () => {
    expect(PARTES_NO_MAXIMO).toBe(200);
    const { id } = await iniciar();
    expect(await receberParte({ ownerId: DONA, meetingId: id, seq: 199, mimeType: "audio/wav", bytes: wav(1) })).toEqual({ seq: 199, repetida: false });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 200, mimeType: "audio/wav", bytes: wav(1) }))).toBe("POSICAO");
    expect(await recusa(encerrarGravacaoEmPartes(DONA, id, 201))).toBe("POSICAO");
    expect(await encerrarGravacaoEmPartes(DONA, id, 200)).toEqual({ partes: 200 });
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

  it("depois de encerrar, parte além do total é recusada (e a que faltava ainda entra)", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });
    await encerrarGravacaoEmPartes(DONA, id, 2);
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 2, mimeType: "audio/wav", bytes: wav(1) }))).toBe("POSICAO");
    expect((await partes(id)).map(p => p.seq)).toEqual([0]);
  });

  it("excluir a reunião leva as partes: o objeto de cada uma sai do bucket e as linhas saem do banco", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });
    await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(1) });
    const chaves = (await partes(id)).map(p => p.storageKey).sort();
    expect(await deletePrivateMeeting(DONA, id)).toBe(true);
    expect(await partes(id)).toHaveLength(0);
    expect(storageApagarTodasAsVersoes.mock.calls.map(c => c[0]).sort()).toEqual(chaves);
  });

  it("reunião excluída durante o upload: o objeto que acabou de subir sai também (com todas as versões), e a parte é recusada", async () => {
    const { id } = await iniciar();
    storagePut.mockImplementation(async (chave: string) => {
      await deletePrivateMeeting(DONA, id);
      storageApagarTodasAsVersoes.mockClear();
      return { key: chave, url: `/manus-storage/${chave}` };
    });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("SEM_REUNIAO");
    expect(storageApagarTodasAsVersoes).toHaveBeenCalledTimes(1);
    expect(storageApagarTodasAsVersoes.mock.calls[0][0]).toBe(storagePut.mock.calls[0][0]);
    expect(await partes(id)).toHaveLength(0);
  });

  it("a parte que termina de subir NO MEIO do expurgo da exclusão (depois de o expurgo dela não achar nada) sai do bucket do mesmo jeito: nenhum objeto fica sem linha", async () => {
    // O bucket de mentira: o que subiu e ainda não saiu.
    const noBucket = new Set<string>();
    storagePut.mockImplementation(async (chave: string) => { noBucket.add(chave); return { key: chave, url: `/manus-storage/${chave}` }; });
    storageApagarTodasAsVersoes.mockImplementation(async (chave: string) => { noBucket.delete(chave); });
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });

    // A parte 1 começa a subir e fica presa no upload até o teste soltar.
    let soltarUpload: () => void = () => {};
    const uploadSolto = new Promise<void>(resolver => { soltarUpload = resolver; });
    let avisarQueComecou: () => void = () => {};
    const comecou = new Promise<void>(resolver => { avisarQueComecou = resolver; });
    storagePut.mockImplementationOnce(async (chave: string) => {
      avisarQueComecou();
      await uploadSolto;
      noBucket.add(chave);
      return { key: chave, url: `/manus-storage/${chave}` };
    });
    const envio = receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(1, 5) }).catch(erro => erro);
    await comecou;
    const [subindo] = (await partes(id)).filter(parte => parte.seq === 1);
    expect(subindo.status).toBe("uploading");

    // A exclusão expurga a parte 1 ANTES de o objeto existir (não acha nada);
    // logo depois o upload termina, e a linha vira 'received' antes de a
    // exclusão seguir. Antes, receberParte respondia OK sem reler a reunião, a
    // exclusão apagava a linha, e o objeto ficava no bucket sem ponteiro.
    let soltou = false;
    storageApagarTodasAsVersoes.mockImplementation(async (chave: string) => {
      noBucket.delete(chave);
      if (chave !== subindo.storageKey || soltou) return;
      soltou = true;
      soltarUpload();
      for (let tentativa = 0; tentativa < 300; tentativa++) {
        const [agora] = await (await getDb())!.select({ status: meetingAudioSlices.status }).from(meetingAudioSlices).where(eq(meetingAudioSlices.id, subindo.id));
        if (!agora || agora.status !== "uploading") return;
        await new Promise(resolver => setTimeout(resolver, 10));
      }
    });

    expect(await deletePrivateMeeting(DONA, id)).toBe(true);
    const resposta = await envio;

    expect(soltou).toBe(true);
    expect(resposta).toBeInstanceOf(RecusaDaParte);
    expect((resposta as InstanceType<typeof RecusaDaParte>).codigo).toBe("SEM_REUNIAO");
    expect([...noBucket]).toEqual([]);
    expect(await partes(id)).toHaveLength(0);
  });

  it("o bucket recusa tirar a parte que subiu para a reunião excluída: a linha volta como ponteiro vencido, o log de erro tem a chave, e a varredura a tira depois", async () => {
    const { id } = await iniciar();
    storagePut.mockImplementation(async (chave: string) => {
      // A exclusão inteira acontece durante o upload: o expurgo da linha
      // 'uploading' não acha nada, e a linha e a reunião saem.
      await deletePrivateMeeting(DONA, id);
      storageApagarTodasAsVersoes.mockReset();
      storageApagarTodasAsVersoes.mockRejectedValue(new Error("B2 fora do ar"));
      return { key: chave, url: `/manus-storage/${chave}` };
    });

    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("SEM_REUNIAO");

    const chave = storagePut.mock.calls[0][0] as string;
    const [ponteiro] = await partes(id);
    expect(ponteiro).toMatchObject({
      ownerId: DONA, seq: 0, storageKey: chave, status: "failed", lastError: MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA,
      result: null, lockToken: null, lockedUntil: null,
    });
    expect(ponteiro.expiresAt).toBeLessThanOrEqual(Date.now());
    const pedido = vi.mocked(console.error).mock.calls.map(chamada => chamada.map(String).join(" ")).find(linha => linha.includes(chave));
    expect(pedido).toContain("a parte de uma reunião excluída ficou no bucket");

    // Sem a reunião, a varredura acha o ponteiro e, com o bucket de volta, tira o objeto e a linha.
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(storageApagarTodasAsVersoes.mock.calls.map(c => c[0])).toContain(chave);
    expect(await partes(id)).toHaveLength(0);
  });

  it("a limpeza dos vencidos apaga a parte vencida (objeto e linha) e deixa a que vale, quando a reunião já saiu da fila", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });
    await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(1) });
    // As partes de hoje vencem juntas (receberParte iguala o prazo); aqui a 0
    // vence antes, como as de antes do prazo comum.
    const [vencida] = (await partes(id)).filter(p => p.seq === 0);
    await (await getDb())!.update(meetingAudioSlices).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingAudioSlices.id, vencida.id));
    // Gravando, a reunião ainda recebe partes (e cada uma renova o prazo): a varredura não mexe.
    await limparGravacoesVencidas({ ownerId: DONA });
    expect((await partes(id)).map(p => p.seq)).toEqual([0, 1]);
    await (await getDb())!.update(meetings).set({ status: "ready" }).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
    await limparGravacoesVencidas({ ownerId: DONA });
    expect((await partes(id)).map(p => p.seq)).toEqual([1]);
    expect(storageApagarTodasAsVersoes.mock.calls.map(c => c[0])).toEqual([vencida.storageKey]);
  });

  it("os procedimentos: iniciarGravacao cria em partes; encerrarGravacao traduz as recusas em códigos do tRPC", async () => {
    const caller = appRouter.createCaller({
      user: { id: 2_000_000_001, openId: DONA, role: "user", onboardingCompleted: true },
      req: { headers: {}, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
      res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
    } as never);
    const { id } = await caller.meetings.iniciarGravacao({ title: "Pelo tRPC", consentGranted: true, language: "en-US", consentNoticeVersion: "2026-11-14" });
    const [linha] = await (await getDb())!.select().from(meetings).where(eq(meetings.id, id));
    expect(linha).toMatchObject({ audioPipeline: "slices", status: "recording", origem: "gravacao", language: "en" });
    const codigo = (e: unknown) => (e instanceof TRPCError ? e.code : String(e));
    expect(codigo(await caller.meetings.encerrarGravacao({ meetingId: crypto.randomUUID(), partes: 1 }).catch(e => e))).toBe("NOT_FOUND");
    // O procedimento tem o mesmo teto de partes do serviço (G13a: 200).
    expect(codigo(await caller.meetings.encerrarGravacao({ meetingId: id, partes: PARTES_NO_MAXIMO + 1 }).catch(e => e))).toBe("BAD_REQUEST");
    await receberParte({ ownerId: DONA, meetingId: id, seq: 3, mimeType: "audio/wav", bytes: wav(1) });
    expect(codigo(await caller.meetings.encerrarGravacao({ meetingId: id, partes: 2 }).catch(e => e))).toBe("BAD_REQUEST");
    expect(await caller.meetings.encerrarGravacao({ meetingId: id, partes: 4 })).toEqual({ partes: 4 });
    expect(codigo(await caller.meetings.encerrarGravacao({ meetingId: id, partes: 5 }).catch(e => e))).toBe("CONFLICT");
    expect(codigo(await caller.meetings.iniciarGravacao({ title: "Sem aviso", consentGranted: false as never }).catch(e => e))).toBe("BAD_REQUEST");
  });

  it("o detalhe (D1) traz as partes para ouvir, na ordem e com o início de cada uma, e o andamento", async () => {
    const { id } = await iniciar();
    await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(3) });
    await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(2) });
    await encerrarGravacaoEmPartes(DONA, id, 3);
    const detalhe = await getPrivateMeeting(DONA, id);
    expect(detalhe?.meeting).toMatchObject({ audioPipeline: "slices", expectedSlices: 3, status: "uploading" });
    expect(detalhe?.andamento).toEqual({ recebidas: 2, transcritas: 0, esperadas: 3 });
    expect(detalhe?.recording?.partes.map(p => [p.seq, p.inicioSegundos, p.duracaoSegundos])).toEqual([[0, 0, 3], [1, 3, 2]]);
    expect(detalhe?.recording?.durationSeconds).toBe(5);
    expect(detalhe?.recording?.partes[0].url).toMatch(new RegExp(`^/manus-storage/meetings/${DONA}/${id}/partes/0000-`));
    // De outra dona: nada.
    expect(await getPrivateMeeting(OUTRA, id)).toBeNull();
  });

  it("reunião do envio único não recebe partes", async () => {
    const id = crypto.randomUUID();
    const agora = Date.now();
    await (await getDb())!.insert(meetings).values({ id, ownerId: DONA, title: "Envio único", status: "recording", consentGranted: true, consentAt: agora, createdAt: agora, updatedAt: agora });
    expect(await recusa(receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) }))).toBe("FORA_DO_ESTADO");
  });
});
