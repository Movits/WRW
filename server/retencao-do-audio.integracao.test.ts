import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { margemDoReprocesso } from "@shared/const";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A retenção do áudio de reunião (30 dias) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). O bucket é dublê:
 * o que se prova é o banco (quais linhas a varredura acha, quais saem, quais
 * ficam) e QUAL chave vai ao expurgo de todas as versões.
 *
 * - a varredura tira a gravação e as partes vencidas e deixa as do prazo;
 * - pula o áudio da reunião em 'processing' e, nas partes, em 'recording' e
 *   'uploading' (renovação pendente);
 * - o expurgo que falha deixa a linha, e a passada seguinte tenta de novo;
 * - pagina, para depois de recusas seguidas e roda de novo sem efeito;
 * - o áudio de reunião que já não existe (o ponteiro da exclusão) sai na hora;
 * - a leitura só diz "foi apagada" quando o áudio saiu;
 * - cada parte que chega renova o prazo de todas;
 * - o reprocesso da reunião em partes só é aceito com o áudio durando a margem
 *   do reprocesso, que cresce com as partes da gravação.
 *
 * Toda varredura daqui vai com `ownerId`: o Vitest roda os arquivos em paralelo
 * no mesmo banco, e uma varredura do sistema inteiro mexeria no que é deles.
 */
const storageApagarTodasAsVersoes = vi.hoisted(() => vi.fn());
const storagePut = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storagePut: (...a: unknown[]) => storagePut(...a),
  storageApagarTodasAsVersoes: (...a: unknown[]) => storageApagarTodasAsVersoes(...a),
  // O áudio de reunião nunca pode cair no DELETE simples: no B2 ele só esconde a voz.
  storageDelete: async () => { throw new Error("o áudio de reunião não sai por storageDelete"); },
}));

const { getDb } = await import("./db");
const {
  agendaReunioes, meetingAudioSlices, meetingRecordings, meetingTranscripts, meetings, platformNotifications, users,
} = await import("../drizzle/schema");
const {
  deletePrivateMeeting, getPrivateMeeting, iniciarReprocessamento, limparGravacoesVencidas,
  ARQUIVO_SEM_PRAZO, MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA, PRAZO_DOS_ARQUIVOS_ATE_26_11_MS, ReprocessamentoRecusado, tirarOPrazoDosArquivosDeAntes,
} = await import("./meeting-service");
const { iniciarReuniaoEmPartes, receberParte } = await import("./fatias-de-reuniao");
const { CONCORRENCIA_DO_EXPURGO_DO_AUDIO } = await import("./storage");
const { avisarReuniaoPronta } = await import("./lembretes");
const { criarNaAgenda, ligarGravacaoNaAgenda } = await import("./agenda-de-reunioes");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-retencao-${crypto.randomUUID()}`;
const DIA = 24 * 60 * 60_000;
const agora = () => Date.now();

async function db() { return (await getDb())!; }

type Status = "recording" | "uploading" | "processing" | "ready" | "failed" | "deleted";

async function reuniao(status: Status, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId: DONA, title: "Reunião da retenção", status, consentGranted: true, consentAt: agora(), language: "pt-BR",
    createdAt: agora() - 40 * DIA, updatedAt: agora(), ...extra,
  });
  return id;
}

/** `id` escolhido pelo teste quando a ORDEM da varredura importa (ela pagina pelo id). */
async function gravacao(meetingId: string, expiresAt: number, id: string = crypto.randomUUID()) {
  const chave = `meetings/${DONA}/${meetingId}/recording_${id.slice(-8)}.m4a`;
  await (await db()).insert(meetingRecordings).values({
    id, meetingId, ownerId: DONA, storageKey: chave, storageUrl: `/manus-storage/${chave}`,
    mimeType: "audio/mp4", sizeBytes: 10, durationSeconds: 60, expiresAt, createdAt: agora(),
  });
  return { id, chave };
}

async function parte(meetingId: string, seq: number, expiresAt: number, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const chave = `meetings/${DONA}/${meetingId}/partes/${String(seq).padStart(4, "0")}-${id.slice(0, 8)}.m4a`;
  await (await db()).insert(meetingAudioSlices).values({
    id, meetingId, ownerId: DONA, seq, status: "transcribed", storageKey: chave, storageUrl: `/manus-storage/${chave}`,
    mimeType: "audio/mp4", sizeBytes: 10, sha256: "0".repeat(64), durationMs: 600_000, offsetMs: seq * 600_000,
    result: { segmentos: [{ inicio: seq * 600, fim: seq * 600 + 2, falante: "F1", texto: "Fala de quem participou." }] },
    expiresAt, createdAt: agora(), updatedAt: agora(), ...extra,
  });
  return { id, chave };
}

async function transcricao(meetingId: string) {
  await (await db()).insert(meetingTranscripts).values({
    id: crypto.randomUUID(), meetingId, ownerId: DONA, transcript: "Combinamos a entrega na sexta.", language: "pt-BR",
    createdAt: agora(), updatedAt: agora(),
  });
}

/** Um WAV válido de `segundos` (8 kHz, mono, 16 bits): receberParte mede a duração nos bytes. */
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

const gravacoesDe = async (meetingId: string) => (await db()).select().from(meetingRecordings).where(eq(meetingRecordings.meetingId, meetingId));
const partesDe = async (meetingId: string) => (await db()).select().from(meetingAudioSlices).where(eq(meetingAudioSlices.meetingId, meetingId)).orderBy(meetingAudioSlices.seq);
const varrer = (opcoes: { lote?: number; maximoDeLotes?: number } = {}) => limparGravacoesVencidas({ ownerId: DONA, ...opcoes });
const chavesExpurgadas = () => storageApagarTodasAsVersoes.mock.calls.map(chamada => chamada[0] as string);

/** Os avisos no sino (H15) da conta da dona que levam à reunião. */
async function avisosDaReuniao(meetingId: string) {
  const banco = await db();
  const [conta] = await banco.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
  return banco.select().from(platformNotifications)
    .where(and(eq(platformNotifications.userId, conta.id), eq(platformNotifications.actionUrl, `/meetings/${meetingId}`)));
}

async function limparDaDona() {
  const banco = await db();
  // O teste da exclusão cortada no meio do expurgo marca uma reunião na agenda
  // (H16a) e dá o aviso de pronta no sino (H15).
  await apagarPelaChave(banco, agendaReunioes, eq(agendaReunioes.ownerId, DONA));
  const contas = await banco.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
  for (const conta of contas) await apagarPelaChave(banco, platformNotifications, eq(platformNotifications.userId, conta.id));
  await apagarPelaChave(banco, meetingAudioSlices, eq(meetingAudioSlices.ownerId, DONA));
  await apagarPelaChave(banco, meetingRecordings, eq(meetingRecordings.ownerId, DONA));
  await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
  await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA));
}

describe.skipIf(!temBanco)("Retenção do áudio de reunião no banco (integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values({ openId: DONA }); });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await limparDaDona();
    await banco.delete(users).where(eq(users.openId, DONA));
  });
  beforeEach(async () => {
    await limparDaDona();
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
    storagePut.mockReset();
    storagePut.mockImplementation(async (chave: string) => ({ key: chave, url: `/manus-storage/${chave}` }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("a varredura", () => {
    it("tira do bucket (todas as versões) e do banco a gravação vencida, deixa a do prazo, e a transcrição fica", async () => {
      const vencida = await reuniao("ready");
      const velha = await gravacao(vencida, agora() - 1);
      await transcricao(vencida);
      const noPrazo = await reuniao("ready");
      await gravacao(noPrazo, agora() + DIA);

      expect(await varrer()).toEqual({ encontradas: 1, apagadas: 1 });

      expect(chavesExpurgadas()).toEqual([velha.chave]);
      expect(await gravacoesDe(vencida)).toEqual([]);
      expect(await gravacoesDe(noPrazo)).toHaveLength(1);
      expect(await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, vencida))).toHaveLength(1);
    });

    it("tira TODAS as partes da reunião em partes vencida, inclusive a que falhou, e deixa as da reunião no prazo", async () => {
      const vencida = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 3 });
      const partesVencidas = [
        await parte(vencida, 0, agora() - 1),
        await parte(vencida, 1, agora() - 1),
        await parte(vencida, 2, agora() - 1, { status: "failed", lastError: "IA_INDISPONIVEL" }),
      ];
      const noPrazo = await reuniao("failed", { audioPipeline: "slices", expectedSlices: 1 });
      await parte(noPrazo, 0, agora() + DIA);

      expect(await varrer()).toEqual({ encontradas: 3, apagadas: 3 });

      expect(chavesExpurgadas().sort()).toEqual(partesVencidas.map(p => p.chave).sort());
      expect(await partesDe(vencida)).toEqual([]);
      expect(await partesDe(noPrazo)).toHaveLength(1);
    });

    it("pula o áudio vencido da reunião em 'processing' e, nas partes, em 'recording' e 'uploading'; sai quando ela deixa esses estados", async () => {
      const unicaProcessando = await reuniao("processing");
      await gravacao(unicaProcessando, agora() - 1);
      const emPartes: string[] = [];
      for (const status of ["recording", "uploading", "processing"] as const) {
        const id = await reuniao(status, { audioPipeline: "slices" });
        await parte(id, 0, agora() - 1);
        emPartes.push(id);
      }

      expect(await varrer()).toEqual({ encontradas: 0, apagadas: 0 });
      expect(storageApagarTodasAsVersoes).not.toHaveBeenCalled();
      expect(await gravacoesDe(unicaProcessando)).toHaveLength(1);
      for (const id of emPartes) expect(await partesDe(id)).toHaveLength(1);

      // A execução terminou (com falha): o áudio vencido sai na passada seguinte.
      for (const id of [unicaProcessando, ...emPartes]) {
        await (await db()).update(meetings).set({ status: "failed" }).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
      }
      expect(await varrer()).toEqual({ encontradas: 4, apagadas: 4 });
      expect(await gravacoesDe(unicaProcessando)).toEqual([]);
      for (const id of emPartes) expect(await partesDe(id)).toEqual([]);
    });

    it("expurgo que falha: a LINHA fica (é o único ponteiro para a voz), e a passada seguinte tenta de novo", async () => {
      const id = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 2 });
      const chaves = [(await parte(id, 0, agora() - 1)).chave, (await parte(id, 1, agora() - 1)).chave];
      storageApagarTodasAsVersoes.mockImplementationOnce(async () => { throw new Error("B2 recusou a listagem"); });

      expect(await varrer()).toEqual({ encontradas: 2, apagadas: 1 });
      // A varredura pagina pelo id: a recusada é a primeira que ela tentou.
      const [recusada, aceita] = chavesExpurgadas();
      expect([recusada, aceita].sort()).toEqual([...chaves].sort());
      expect((await partesDe(id)).map(p => p.storageKey)).toEqual([recusada]);

      expect(await varrer()).toEqual({ encontradas: 1, apagadas: 1 });
      expect(chavesExpurgadas()).toEqual([recusada, aceita, recusada]);
      expect(await partesDe(id)).toEqual([]);
    });

    it("rodar de novo sem nada vencido não faz nada: nenhuma chamada ao bucket, nenhuma linha a menos", async () => {
      const vencida = await reuniao("ready");
      await gravacao(vencida, agora() - 1);
      const noPrazo = await reuniao("ready", { audioPipeline: "slices" });
      await parte(noPrazo, 0, agora() + DIA);
      await varrer();
      storageApagarTodasAsVersoes.mockClear();

      expect(await varrer()).toEqual({ encontradas: 0, apagadas: 0 });
      expect(await varrer()).toEqual({ encontradas: 0, apagadas: 0 });
      expect(storageApagarTodasAsVersoes).not.toHaveBeenCalled();
      expect(await partesDe(noPrazo)).toHaveLength(1);
    });

    it("pagina: com lotes de 2, cinco gravações vencidas saem numa passada só; com teto de 1 lote, só as 2 primeiras, e o resto na seguinte", async () => {
      for (let i = 0; i < 5; i++) await gravacao(await reuniao("ready"), agora() - 1);
      expect(await varrer({ lote: 2 })).toEqual({ encontradas: 5, apagadas: 5 });

      for (let i = 0; i < 5; i++) await gravacao(await reuniao("ready"), agora() - 1);
      expect(await varrer({ lote: 2, maximoDeLotes: 1 })).toEqual({ encontradas: 2, apagadas: 2 });
      expect(await varrer({ lote: 2 })).toEqual({ encontradas: 3, apagadas: 3 });
    });

    it("bucket fora: a passada para depois de 5 recusas seguidas, sem apagar linha nenhuma, em vez de insistir em cada áudio", async () => {
      for (let i = 0; i < 8; i++) await gravacao(await reuniao("ready"), agora() - 1);
      storageApagarTodasAsVersoes.mockRejectedValue(new Error("B2 fora do ar"));

      expect(await varrer()).toEqual({ encontradas: 5, apagadas: 0 });
      expect(storageApagarTodasAsVersoes).toHaveBeenCalledTimes(5);
      const restantes = await (await db()).select().from(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA));
      expect(restantes).toHaveLength(8);
    });

    it("o áudio de reunião que já não existe, ou que está sendo excluída, sai na hora, mesmo dentro do prazo", async () => {
      const semReuniao = await gravacao(crypto.randomUUID(), agora() + 10 * DIA);
      const excluida = await reuniao("deleted", { audioPipeline: "slices" });
      const parteDaExcluida = await parte(excluida, 0, agora() + 10 * DIA);
      const viva = await reuniao("ready");
      await gravacao(viva, agora() + 10 * DIA);

      expect(await varrer()).toEqual({ encontradas: 2, apagadas: 2 });
      expect(chavesExpurgadas().sort()).toEqual([semReuniao.chave, parteDaExcluida.chave].sort());
      expect(await gravacoesDe(viva)).toHaveLength(1);
    });

    it("cinco áudios que o bucket recusa SEMPRE não travam os outros: as partes são visitadas na mesma passada, e a gravação depois deles sai na seguinte", async () => {
      // Antes, as cinco recusas encerravam a passada inteira, e toda passada
      // recomeçava do primeiro id: as mesmas cinco ficavam na frente para sempre,
      // e nem as partes eram visitadas. Ids com o mesmo começo, para a ordem ser a
      // do teste: as cinco recusadas, depois a boa.
      const prefixo = crypto.randomUUID().slice(0, 8);
      const recusadas: string[] = [];
      for (let i = 0; i < 5; i++) recusadas.push((await gravacao(await reuniao("ready"), agora() - 1, `${prefixo}-a${i}`)).chave);
      const daBoa = await reuniao("ready");
      const boa = await gravacao(daBoa, agora() - 1, `${prefixo}-b`);
      const emPartes = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 1 });
      const parteBoa = await parte(emPartes, 0, agora() - 1);
      storageApagarTodasAsVersoes.mockImplementation(async (chave: string) => {
        if (recusadas.includes(chave)) throw new Error("o bucket recusa sempre esta chave");
      });

      // 1ª passada: as gravações param nas cinco recusas; as partes são visitadas assim mesmo.
      expect(await varrer()).toEqual({ encontradas: 6, apagadas: 1 });
      expect(chavesExpurgadas()).toEqual([...recusadas, parteBoa.chave]);
      expect(await partesDe(emPartes)).toEqual([]);
      expect(await gravacoesDe(daBoa)).toHaveLength(1);

      // 2ª: retoma DEPOIS da última recusada; a boa sai, e as recusadas ficam por último.
      storageApagarTodasAsVersoes.mockClear();
      expect(await varrer()).toEqual({ encontradas: 6, apagadas: 1 });
      expect(chavesExpurgadas()).toEqual([boa.chave, ...recusadas]);
      expect(await gravacoesDe(daBoa)).toEqual([]);
      expect(await (await db()).select().from(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA))).toHaveLength(5);
    });

    it("para entre um áudio e outro quando deveParar diz (o desligamento): nenhum áudio novo começa, e a passada seguinte retoma de onde parou", async () => {
      for (let i = 0; i < 3; i++) await gravacao(await reuniao("ready"), agora() - 1);

      const parcial = await limparGravacoesVencidas({ ownerId: DONA, deveParar: () => storageApagarTodasAsVersoes.mock.calls.length >= 1 });

      expect(parcial).toEqual({ encontradas: 1, apagadas: 1 });
      expect(storageApagarTodasAsVersoes).toHaveBeenCalledTimes(1);
      expect(await (await db()).select().from(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA))).toHaveLength(2);

      expect(await varrer()).toEqual({ encontradas: 2, apagadas: 2 });
      expect(await (await db()).select().from(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA))).toEqual([]);
    });

    it("com deveParar já valendo, nada é tentado, nem nas gravações nem nas partes", async () => {
      await gravacao(await reuniao("ready"), agora() - 1);
      await parte(await reuniao("ready", { audioPipeline: "slices" }), 0, agora() - 1);

      expect(await limparGravacoesVencidas({ ownerId: DONA, deveParar: () => true })).toEqual({ encontradas: 0, apagadas: 0 });
      expect(storageApagarTodasAsVersoes).not.toHaveBeenCalled();
    });
  });

  describe("a exclusão da reunião com o bucket recusando", () => {
    it("a reunião sai; o áudio que o bucket recusou, e o que nem chegou a ser tentado, fica como ponteiro (vencido e, na parte, sem a transcrição e fora da fila), e a varredura o tira depois", async () => {
      const id = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 8 });
      await parte(id, 0, agora() + 10 * DIA, { lockToken: "reserva-da-fila".padEnd(36, "x"), lockedUntil: agora() + 60_000 });
      for (let seq = 1; seq < 8; seq++) await parte(id, seq, agora() + 10 * DIA);
      storageApagarTodasAsVersoes.mockRejectedValueOnce(new Error("B2 fora do ar"));
      const antes = agora();

      expect(await deletePrivateMeeting(DONA, id)).toBe(true);

      // Até CONCORRENCIA_DO_EXPURGO_DO_AUDIO por vez, e nenhum começa depois da
      // recusa: os que estavam em curso terminaram (e saíram), e os últimos nem
      // foram tentados.
      expect(storageApagarTodasAsVersoes).toHaveBeenCalledTimes(CONCORRENCIA_DO_EXPURGO_DO_AUDIO);
      expect(await (await db()).select().from(meetings).where(eq(meetings.id, id))).toEqual([]);
      const ponteiros = await partesDe(id);
      expect(ponteiros).toHaveLength(8 - (CONCORRENCIA_DO_EXPURGO_DO_AUDIO - 1));
      const [recusada, ...aceitas] = chavesExpurgadas();
      expect(ponteiros.map(ponteiro => ponteiro.storageKey)).toContain(recusada);
      for (const aceita of aceitas) expect(ponteiros.map(ponteiro => ponteiro.storageKey)).not.toContain(aceita);
      for (const ponteiro of ponteiros) {
        expect(ponteiro).toMatchObject({ status: "failed", lastError: MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA, result: null, lockToken: null, lockedUntil: null });
        expect(ponteiro.expiresAt).toBeGreaterThanOrEqual(antes);
        expect(ponteiro.expiresAt).toBeLessThanOrEqual(agora());
      }

      expect(await varrer()).toEqual({ encontradas: ponteiros.length, apagadas: ponteiros.length });
      expect(await partesDe(id)).toEqual([]);
    });

    it("com o bucket respondendo, o áudio e as linhas saem junto com a reunião", async () => {
      const id = await reuniao("failed");
      const audio = await gravacao(id, agora() + 10 * DIA);
      expect(await deletePrivateMeeting(DONA, id)).toBe(true);
      expect(chavesExpurgadas()).toEqual([audio.chave]);
      expect(await gravacoesDe(id)).toEqual([]);
    });

    it("cortada no meio do expurgo (o SIGTERM do deploy), a exclusão já tirou o aviso de pronta do sino (H15) e soltou a agenda (H16a)", async () => {
      const banco = await db();
      const id = await reuniao("ready");
      await gravacao(id, agora() + 10 * DIA);
      await transcricao(id);
      expect(await avisarReuniaoPronta(banco, DONA, id, "pronto")).toBe(true);
      const { id: naAgenda } = await criarNaAgenda(DONA, {
        titulo: "Conversa com a Bia", inicioEm: agora() + DIA, duracaoMinutos: 60, fuso: "America/Sao_Paulo",
        local: null, participantes: [], lembreteMinutos: null, googleConvites: false,
      });
      await ligarGravacaoNaAgenda(DONA, naAgenda, id);
      expect(await avisosDaReuniao(id)).toHaveLength(1);

      // O bucket segura o expurgo, a parte longa da exclusão: é ali que o
      // deploy a corta (o processo sai em até 10 s), e o que vale é o que já
      // está no banco nesse momento.
      let soltarOBucket: () => void = () => {};
      storageApagarTodasAsVersoes.mockImplementationOnce(() => new Promise<void>(resolver => { soltarOBucket = () => resolver(); }));
      const exclusao = deletePrivateMeeting(DONA, id);
      exclusao.catch(() => {});
      try {
        await vi.waitFor(() => expect(storageApagarTodasAsVersoes).toHaveBeenCalledTimes(1), { timeout: 10_000 });
        // A reunião já é 'deleted' (some da lista, e a dona não a exclui de
        // novo) e a transcrição já saiu. Nada retomaria o aviso, que levaria a
        // "Reunião não encontrada": ele já saiu, e o ponteiro da agenda também.
        expect(await banco.select({ status: meetings.status }).from(meetings).where(eq(meetings.id, id))).toEqual([{ status: "deleted" }]);
        expect(await banco.select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id))).toEqual([]);
        expect(await avisosDaReuniao(id)).toEqual([]);
        const [marcada] = await banco.select({ meetingId: agendaReunioes.meetingId }).from(agendaReunioes).where(eq(agendaReunioes.id, naAgenda));
        expect(marcada.meetingId).toBeNull();
      } finally {
        soltarOBucket();
      }
      expect(await exclusao).toBe(true);
      expect(await gravacoesDe(id)).toEqual([]);
    });
  });

  describe("a leitura da reunião vencida", () => {
    it("envio único: com o bucket recusando, a tela NÃO diz 'foi apagada', diz que está saindo, e a linha fica; com o bucket de volta, sai e aí sim", async () => {
      const id = await reuniao("ready");
      await gravacao(id, agora() - 1);
      await transcricao(id);
      storageApagarTodasAsVersoes.mockRejectedValueOnce(new Error("B2 fora do ar"));

      const durante = await getPrivateMeeting(DONA, id);
      expect(durante).toMatchObject({ recording: null, recordingExpired: false, recordingDeletionPending: true });
      expect(await gravacoesDe(id)).toHaveLength(1);

      const depois = await getPrivateMeeting(DONA, id);
      expect(depois).toMatchObject({ recording: null, recordingExpired: true, recordingDeletionPending: false });
      expect(await gravacoesDe(id)).toEqual([]);
      // E continua dizendo isso depois, sem linha nenhuma.
      expect(await getPrivateMeeting(DONA, id)).toMatchObject({ recordingExpired: true, recordingDeletionPending: false });
    });

    it("em partes: antes, a parte vencida sumia da tela com 'foi apagada' e ficava no bucket; agora ela sai na leitura, e só então a tela o diz", async () => {
      const id = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 2 });
      const partes = [await parte(id, 0, agora() - 1), await parte(id, 1, agora() - 1)];
      await transcricao(id);

      const detalhe = await getPrivateMeeting(DONA, id);
      expect(detalhe).toMatchObject({ recording: null, recordingExpired: true, recordingDeletionPending: false });
      expect(chavesExpurgadas()).toEqual(partes.map(p => p.chave));
      expect(await partesDe(id)).toEqual([]);
    });

    it("em partes, na reunião que ainda recebe partes: o áudio vencido não toca nem sai, e a tela diz que está saindo", async () => {
      const id = await reuniao("uploading", { audioPipeline: "slices", expectedSlices: 2 });
      await parte(id, 0, agora() - 1);

      expect(await getPrivateMeeting(DONA, id)).toMatchObject({ recording: null, recordingExpired: false, recordingDeletionPending: true });
      expect(storageApagarTodasAsVersoes).not.toHaveBeenCalled();
      expect(await partesDe(id)).toHaveLength(1);
    });

    it("no prazo, o áudio toca, com o prazo comum das partes", async () => {
      const id = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 2 });
      const prazo = agora() + 5 * DIA;
      await parte(id, 0, prazo);
      await parte(id, 1, prazo);
      const detalhe = await getPrivateMeeting(DONA, id);
      expect(detalhe?.recording?.partes.map(p => p.seq)).toEqual([0, 1]);
      expect(detalhe?.recording?.expiresAt).toBe(prazo);
      expect(detalhe).toMatchObject({ recordingExpired: false, recordingDeletionPending: false });
    });
  });

  describe("o áudio fica até a dona excluir (26/11/2026)", () => {
    it("cada parte nasce sem prazo (ARQUIVO_SEM_PRAZO), e a varredura não a tira, nem depois de 30 dias", async () => {
      const { id } = await iniciarReuniaoEmPartes(DONA, { title: "Sem prazo", language: "pt-BR", consentNoticeVersion: "2026-11-26", origem: "gravacao" });
      await receberParte({ ownerId: DONA, meetingId: id, seq: 0, mimeType: "audio/wav", bytes: wav(1) });
      await receberParte({ ownerId: DONA, meetingId: id, seq: 1, mimeType: "audio/wav", bytes: wav(1, 3) });
      await (await db()).update(meetings).set({ status: "ready" }).where(eq(meetings.id, id));

      expect((await partesDe(id)).map(p => p.expiresAt)).toEqual([ARQUIVO_SEM_PRAZO, ARQUIVO_SEM_PRAZO]);
      // 31 dias depois, a varredura não acha nada para tirar.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(agora() + 31 * DIA);
      try {
        expect(await varrer()).toEqual({ encontradas: 0, apagadas: 0 });
      } finally {
        vi.useRealTimers();
      }
      expect(await partesDe(id)).toHaveLength(2);
      expect(storageApagarTodasAsVersoes).not.toHaveBeenCalled();
    });

    it("o boot tira o prazo dos 30 dias das linhas de antes, e a marca de saída (no passado) continua saindo", async () => {
      const antiga = await reuniao("ready");
      const ainda = await gravacao(antiga, agora() + 10 * DIA);
      const marcada = await reuniao("ready");
      const saindo = await gravacao(marcada, agora() - 1_000);
      const emPartes = await reuniao("ready", { audioPipeline: "slices", expectedSlices: 1 });
      await parte(emPartes, 0, agora() + PRAZO_DOS_ARQUIVOS_ATE_26_11_MS - DIA);

      expect(await tirarOPrazoDosArquivosDeAntes({ ownerId: DONA })).toBe(2);

      expect((await gravacoesDe(antiga))[0].expiresAt).toBe(ARQUIVO_SEM_PRAZO);
      expect((await partesDe(emPartes))[0].expiresAt).toBe(ARQUIVO_SEM_PRAZO);
      expect((await gravacoesDe(marcada))[0].expiresAt).toBeLessThan(agora());
      // Rodar de novo não muda nada.
      expect(await tirarOPrazoDosArquivosDeAntes({ ownerId: DONA })).toBe(0);

      await varrer();
      expect(chavesExpurgadas()).toEqual([saindo.chave]);
      expect(await gravacoesDe(marcada)).toHaveLength(0);
      expect(await gravacoesDe(antiga)).toHaveLength(1);
      expect(ainda.chave).not.toBe(saindo.chave);
    });

    it("reprocessar a reunião em partes com o áudio a minutos de vencer é recusado, como no envio único", async () => {
      const id = await reuniao("failed", { audioPipeline: "slices", expectedSlices: 1, processingError: "x" });
      await parte(id, 0, agora() + 5 * 60_000, { status: "failed", lastError: "IA_INDISPONIVEL" });

      const recusa = await iniciarReprocessamento(DONA, id).catch(erro => erro);

      expect(recusa).toBeInstanceOf(ReprocessamentoRecusado);
      expect(recusa.codigo).toBe("PRECONDITION_FAILED");
      expect((await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0]).toMatchObject({ status: "failed" });
    });

    /** A reunião em partes que falhou com as partes esgotadas (a IA ficou fora), todas vencendo em `prazo`. */
    async function reuniaoEmPartesQueFalhou(partes: number, prazo: number) {
      const id = await reuniao("failed", { audioPipeline: "slices", expectedSlices: partes, processingError: "x" });
      for (let seq = 0; seq < partes; seq++) await parte(id, seq, prazo, { status: "failed", lastError: "TENTATIVAS_ESGOTADAS", attempts: 3, result: null });
      return id;
    }
    const statusDe = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0]?.status;

    it("a margem cresce com as partes: a gravação de 12 h (72 partes) a 20 min do prazo é recusada, e a de uma parte, não", async () => {
      // Antes, 15 min bastavam para qualquer tamanho. A fila transcreve uma parte
      // por vez, e as 72 passavam do prazo no meio do reprocesso, com o áudio
      // vencido segurado no bucket (a reunião em 'uploading' não o deixa sair).
      const vinteMinutos = agora() + 20 * 60_000;
      const longa = await reuniaoEmPartesQueFalhou(72, vinteMinutos);
      const curta = await reuniaoEmPartesQueFalhou(1, vinteMinutos);

      const recusa = await iniciarReprocessamento(DONA, longa).catch(erro => erro);

      expect(recusa).toBeInstanceOf(ReprocessamentoRecusado);
      expect(recusa.codigo).toBe("PRECONDITION_FAILED");
      expect(await statusDe(longa)).toBe("failed");
      expect(new Set((await partesDe(longa)).map(p => p.status))).toEqual(new Set(["failed"]));

      await iniciarReprocessamento(DONA, curta);
      expect(await statusDe(curta)).toBe("uploading");
      expect((await partesDe(curta)).map(p => p.status)).toEqual(["received"]);
    });

    it("com o áudio durando a margem das 72 partes, a gravação de 12 h é aceita e volta inteira à fila", async () => {
      const longa = await reuniaoEmPartesQueFalhou(72, agora() + margemDoReprocesso(72) + 5 * 60_000);

      await iniciarReprocessamento(DONA, longa);

      expect(await statusDe(longa)).toBe("uploading");
      const partes = await partesDe(longa);
      expect(partes).toHaveLength(72);
      expect(new Set(partes.map(p => p.status))).toEqual(new Set(["received"]));
    });
  });
});
