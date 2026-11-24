import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// O bucket dublado: a exclusão da reunião tira o MP3 do resumo por aqui.
const storageApagarTodasAsVersoes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: (...a: unknown[]) => storageApagarTodasAsVersoes(...a),
  storageDelete: async () => { throw new Error("o MP3 do resumo não sai por storageDelete"); },
}));

/**
 * O grupo "voz" contra um banco real DE TESTE (sem DATABASE_URL_TESTES, se pula):
 * - "Baixar o áudio do resumo" (H19b): gera uma vez por texto e idioma e serve
 *   de novo, o teto de 24 h, a auditoria, a dona no WHERE, a lixeira, o idioma
 *   sem tradução e o MP3 que sai com a reunião;
 * - o complemento pela busca (H4i): pendente só para a dona, confirmado no
 *   link, descartado some, o teto, o item ignorado e a busca sem fonte.
 * A IA, o ffmpeg e o bucket são dublados; o banco é de verdade.
 */
const { getDb } = await import("./db");
const { auditLogs, buscasDoComplemento, meetings, meetingSummaries, meetingSummaryItems, resumoEmAudio, users } = await import("../drizzle/schema");
const audio = await import("./resumo-em-audio");
const complemento = await import("./complemento-pela-busca");
const resumo = await import("./resumo-guardado");
const { deletePrivateMeeting, limparGravacoesVencidas } = await import("./meeting-service");
const { AUDIOS_DO_RESUMO_POR_DIA, RECUSAS_DO_AUDIO_DO_RESUMO, ACAO_AUDIO_DO_RESUMO_BAIXADO } = await import("@shared/resumo-em-audio");
const { BUSCAS_DO_COMPLEMENTO_POR_DIA, RECUSAS_DO_COMPLEMENTO } = await import("@shared/complemento-pela-busca");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-voz-${crypto.randomUUID()}`;
const OUTRA = `teste-voz-outra-${crypto.randomUUID()}`;
const USUARIA = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const AGORA = () => Date.now();
async function db() { return (await getDb())!; }

const ITENS = [
  { section: "action", text: "{F2} manda a proposta", assignee: "{F2}", due: "sexta", status: "confirmed" },
  { section: "decision", text: "Seguir a lei catorze mil e cento e...", assignee: null, due: null, status: "pending" },
  { section: "question", text: "Item ignorado", assignee: null, due: null, status: "ignored" },
] as const;

async function reuniaoComResumo(opcoes: { shareToken?: string | null; ownerId?: string } = {}) {
  const banco = await db();
  const ownerId = opcoes.ownerId ?? DONA;
  const id = crypto.randomUUID();
  const resumoId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id, ownerId, title: "Reunião da voz", status: "ready", consentGranted: true, consentAt: AGORA(), language: "pt-BR",
    createdAt: AGORA(), updatedAt: AGORA(), shareToken: opcoes.shareToken ?? null, speakerNames: { F2: "Ana" },
  });
  await banco.insert(meetingSummaries).values({ id: resumoId, meetingId: id, ownerId, status: "ready", version: 1, language: "pt-BR", createdAt: AGORA(), updatedAt: AGORA() });
  const ids = ITENS.map(() => crypto.randomUUID());
  await banco.insert(meetingSummaryItems).values(ITENS.map((item, position) => ({
    ...item, id: ids[position], subject: null, summaryId: resumoId, meetingId: id, ownerId, position, excerpt: "trecho", startSeconds: null,
    confidence: "0.900", done: false, createdAt: AGORA(), updatedAt: AGORA(),
  })));
  return { id, resumoId, ids };
}

function dependencias() {
  const guardados = new Map<string, Buffer>();
  const deps = {
    falar: vi.fn(async (texto: string) => ({ pcm: Buffer.from(texto.slice(0, 10).padEnd(10, "x")), amostrasPorSegundo: 24_000 })),
    codificar: vi.fn(async (pcm: Buffer) => Buffer.concat([Buffer.from("MP3:"), pcm])),
    guardar: vi.fn(async (chave: string, mp3: Buffer) => { const final = `${chave}-${crypto.randomUUID().slice(0, 6)}`; guardados.set(final, mp3); return final; }),
    ler: vi.fn(async (chave: string) => { const mp3 = guardados.get(chave); if (!mp3) throw new Error("ausente"); return mp3; }),
    apagar: vi.fn(async (chave: string) => { guardados.delete(chave); }),
    ffmpegDisponivel: vi.fn(async () => true),
  };
  return { deps, guardados };
}
const PEDIDO = { userId: USUARIA, ipAddress: "127.0.0.1", userAgent: "teste" };
const linhasDeAudio = async (meetingId: string) => (await db()).select().from(resumoEmAudio).where(eq(resumoEmAudio.meetingId, meetingId));

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, resumoEmAudio, eq(resumoEmAudio.ownerId, dona));
    await apagarPelaChave(banco, buscasDoComplemento, eq(buscasDoComplemento.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
  await apagarPelaChave(banco, auditLogs, eq(auditLogs.userId, USUARIA));
}

describe.skipIf(!temBanco)("O grupo voz no banco (H19b e H4i, integração)", () => {
  beforeAll(async () => { await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]); });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });
  beforeEach(async () => {
    await limpar();
    audio.esquecerPedidosEmCurso();
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
  });

  describe("Baixar o áudio do resumo (H19b)", () => {
    it("lê o resumo à vista, sem os ignorados, com o nome da voz e o aviso dos pendentes", async () => {
      const { id } = await reuniaoComResumo();
      const { texto, idioma } = await audio.textoDoAudioDoResumo(DONA, id);
      expect(idioma).toBe("pt-BR");
      expect(texto).toContain("Ana manda a proposta");
      expect(texto).toContain("Para conferir");
      expect(texto).not.toContain("Item ignorado");
    });

    it("gera uma vez e serve de novo do bucket: a segunda vez não chama a IA nem gasta o teto; cada download audita", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      const primeiro = await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      const segundo = await audio.audioDoResumoDaDona(DONA, id, "pt-BR", PEDIDO, deps);
      expect(primeiro).toMatchObject({ estado: "pronto", reaproveitado: false });
      if (primeiro.estado !== "pronto") throw new Error("esperava o MP3");
      expect(segundo).toMatchObject({ reaproveitado: true, mp3Base64: primeiro.mp3Base64 });
      expect(Buffer.from(primeiro.mp3Base64, "base64").subarray(0, 4).toString()).toBe("MP3:");
      expect(deps.falar).toHaveBeenCalledTimes(1);
      expect(deps.falar.mock.calls[0][1]).toBe("gemini-3.8-flash-lite-tts");
      const linhas = await linhasDeAudio(id);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ situacao: "pronto", language: "pt-BR", ownerId: DONA });
      expect(linhas[0].storageKey).toMatch(new RegExp(`^meetings/${DONA}/resumo-em-audio/${id}-pt-BR`));
      const auditorias = await (await db()).select().from(auditLogs).where(and(eq(auditLogs.userId, USUARIA), eq(auditLogs.action, ACAO_AUDIO_DO_RESUMO_BAIXADO)));
      expect(auditorias).toHaveLength(2);
      expect(JSON.stringify(auditorias.map(linha => linha.details))).not.toContain("proposta");
    });

    it("o texto mudou (a dona confirmou um item): gera de novo e tira o MP3 antigo do bucket", async () => {
      const { id, ids } = await reuniaoComResumo();
      const { deps, guardados } = dependencias();
      await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      const [antiga] = await linhasDeAudio(id);
      await resumo.decidirItemDoResumo(DONA, ids[1], "confirmed");
      await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      expect(deps.falar).toHaveBeenCalledTimes(2);
      expect(deps.apagar).toHaveBeenCalledWith(antiga.storageKey);
      expect(guardados.size).toBe(1);
      const linhas = await linhasDeAudio(id);
      expect(linhas.filter(linha => linha.storageKey)).toHaveLength(1);
      // A antiga fica, sem a chave, para o teto.
      expect(linhas).toHaveLength(2);
    });

    it(`o teto: ${AUDIOS_DO_RESUMO_POR_DIA} gerações em 24 h, a que falhou também; o servido do bucket segue`, async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      await (await db()).insert(resumoEmAudio).values(Array.from({ length: AUDIOS_DO_RESUMO_POR_DIA - 1 }, () => ({
        id: crypto.randomUUID(), ownerId: DONA, meetingId: id, language: "en", textHash: "x", situacao: "falhou" as const, createdAt: AGORA(), updatedAt: AGORA(),
      })));
      // O mesmo texto: servido do bucket, sem teto.
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps)).resolves.toMatchObject({ reaproveitado: true });
      // Texto novo: recusado pelo teto, antes da IA.
      await (await db()).update(meetingSummaryItems).set({ text: "Texto novo" }).where(eq(meetingSummaryItems.meetingId, id));
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_AUDIO_DO_RESUMO.demais });
      expect(deps.falar).toHaveBeenCalledTimes(1);
    });

    it("o resumo longo não prende a resposta: passado o prazo, diz 'gerando', a geração segue, e o pedido seguinte recebe o MP3 sem gerar de novo", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      let soltar!: () => void;
      const voz = new Promise<void>(resolver => { soltar = resolver; });
      const falarDeVerdade = deps.falar.getMockImplementation()!;
      deps.falar.mockImplementation(async (...args: Parameters<typeof falarDeVerdade>) => { await voz; return falarDeVerdade(...args); });
      const comPrazo = { ...deps, esperaDaRespostaMs: 20 };
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, comPrazo)).resolves.toEqual({ estado: "gerando", idioma: "pt-BR", titulo: "Reunião da voz" });
      // Ainda gerando: o pedido igual espera a mesma geração, sem outra chamada à IA.
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, comPrazo)).resolves.toMatchObject({ estado: "gerando" });
      soltar();
      await vi.waitFor(async () => expect((await linhasDeAudio(id)).map(linha => linha.situacao)).toEqual(["pronto"]));
      const pronto = await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, comPrazo);
      expect(pronto).toMatchObject({ estado: "pronto", reaproveitado: false });
      expect(deps.falar).toHaveBeenCalledTimes(1);
      expect(await linhasDeAudio(id)).toHaveLength(1);
      const auditorias = await (await db()).select().from(auditLogs).where(and(eq(auditLogs.userId, USUARIA), eq(auditLogs.action, ACAO_AUDIO_DO_RESUMO_BAIXADO)));
      expect(auditorias).toHaveLength(1);
    });

    it("a geração que falha depois do prazo: o pedido seguinte recebe o erro, sem gerar de novo nem gastar outra vaga", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      let falhar!: () => void;
      const voz = new Promise<void>((_resolver, rejeitar) => { falhar = () => rejeitar(new Error("503")); });
      deps.falar.mockImplementation(async () => { await voz; throw new Error("inalcançável"); });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const comPrazo = { ...deps, esperaDaRespostaMs: 20 };
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, comPrazo)).resolves.toMatchObject({ estado: "gerando" });
      falhar();
      await vi.waitFor(async () => expect((await linhasDeAudio(id)).map(linha => linha.situacao)).toEqual(["falhou"]));
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, comPrazo)).rejects.toMatchObject({ message: RECUSAS_DO_AUDIO_DO_RESUMO.ia });
      expect(deps.falar).toHaveBeenCalledTimes(1);
      expect(await linhasDeAudio(id)).toHaveLength(1);
    });

    it("a IA que falha: a linha fica 'falhou', o erro sai como código e nada é guardado", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      deps.falar.mockRejectedValueOnce(new Error("503"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: RECUSAS_DO_AUDIO_DO_RESUMO.ia });
      expect(deps.guardar).not.toHaveBeenCalled();
      expect((await linhasDeAudio(id)).map(linha => [linha.situacao, linha.storageKey])).toEqual([["falhou", null]]);
    });

    it("outra dona, a reunião na lixeira e o idioma sem tradução pronta são recusados", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      await expect(audio.audioDoResumoDaDona(OUTRA, id, undefined, PEDIDO, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(audio.audioDoResumoDaDona(DONA, id, "en", PEDIDO, deps)).rejects.toMatchObject({ message: RECUSAS_DO_AUDIO_DO_RESUMO.traduzaAntes });
      await (await db()).update(meetings).set({ trashedAt: AGORA() }).where(eq(meetings.id, id));
      await expect(audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(deps.falar).not.toHaveBeenCalled();
    });

    it("excluir a reunião tira o MP3 do bucket com todas as versões, e a linha perde a chave", async () => {
      const { id } = await reuniaoComResumo();
      const { deps } = dependencias();
      await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      const [linha] = await linhasDeAudio(id);
      await deletePrivateMeeting(DONA, id);
      expect(storageApagarTodasAsVersoes).toHaveBeenCalledWith(linha.storageKey);
      expect((await linhasDeAudio(id)).map(l => l.storageKey)).toEqual([null]);
    });

    it("o MP3 que o bucket recusou na exclusão fica com a chave, e a varredura o tira depois; o da reunião no ar fica", async () => {
      const { id } = await reuniaoComResumo();
      const { id: noAr } = await reuniaoComResumo();
      const { deps } = dependencias();
      await audio.audioDoResumoDaDona(DONA, id, undefined, PEDIDO, deps);
      await audio.audioDoResumoDaDona(DONA, noAr, undefined, PEDIDO, deps);
      const [linha] = await linhasDeAudio(id);
      const [doNoAr] = await linhasDeAudio(noAr);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      storageApagarTodasAsVersoes.mockRejectedValue(new Error("bucket fora"));
      await deletePrivateMeeting(DONA, id);
      expect((await linhasDeAudio(id)).map(l => l.storageKey)).toEqual([linha.storageKey]);

      storageApagarTodasAsVersoes.mockReset();
      storageApagarTodasAsVersoes.mockResolvedValue(undefined);
      await limparGravacoesVencidas({ ownerId: DONA });
      const tiradas = storageApagarTodasAsVersoes.mock.calls.map(chamada => chamada[0]);
      expect(tiradas).toContain(linha.storageKey);
      expect(tiradas).not.toContain(doNoAr.storageKey);
      expect((await linhasDeAudio(id)).map(l => l.storageKey)).toEqual([null]);
      expect((await linhasDeAudio(noAr)).map(l => l.storageKey)).toEqual([doNoAr.storageKey]);
    });
  });

  describe("Complemento pela busca (H4i)", () => {
    const achou = { buscar: vi.fn(async () => ({ texto: "Lei nº 14.133/2021", consultas: ["lei 14.133"], fontes: [{ url: "https://fonte.example/lei", titulo: "fonte.example" }] })) };
    beforeEach(() => { achou.buscar.mockClear(); });

    it("o achado espera a dona: ela o vê pendente, o link e a Memória não; confirmado, o link o vê sem as consultas", async () => {
      const token = crypto.randomBytes(24).toString("base64url");
      const { id, ids } = await reuniaoComResumo({ shareToken: token });
      await complemento.pedirComplemento(DONA, ids[1], achou);
      const daDona = await resumo.resumoGuardadoDaDona(DONA, id);
      expect(daDona.itens.find(item => item.id === ids[1])?.complemento).toEqual({
        texto: "Lei nº 14.133/2021", fonte: "https://fonte.example/lei", titulo: "fonte.example", consultas: ["lei 14.133"], situacao: "pending",
      });
      expect((await resumo.resumoGuardadoPeloLink(token)).itens.every(item => item.complemento === null)).toBe(true);
      // O prompt leva o item e nunca o trecho da transcrição.
      expect(achou.buscar.mock.calls[0][0]).toContain("Seguir a lei catorze");
      expect(achou.buscar.mock.calls[0][0]).not.toContain("trecho");

      await complemento.decidirComplemento(DONA, ids[1], "confirmar");
      const pelaLink = (await resumo.resumoGuardadoPeloLink(token)).itens.find(item => item.text.startsWith("Seguir"));
      expect(pelaLink?.complemento).toEqual({ texto: "Lei nº 14.133/2021", fonte: "https://fonte.example/lei", titulo: "fonte.example", consultas: [], situacao: "confirmed" });
      // E o áudio do resumo o lê, anunciado como de fora da reunião.
      expect((await audio.textoDoAudioDoResumo(DONA, id)).texto).toContain("Complemento de fora da reunião, a conferir: Lei nº 14.133/2021");
    });

    it("descartar apaga o complemento; decidir sem complemento é recusado", async () => {
      const { id, ids } = await reuniaoComResumo();
      await complemento.pedirComplemento(DONA, ids[0], achou);
      await complemento.decidirComplemento(DONA, ids[0], "descartar");
      const [item] = await (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.id, ids[0]));
      expect(item).toMatchObject({ complementText: null, complementSourceUrl: null, complementStatus: null, complementAt: null });
      await expect(complemento.decidirComplemento(DONA, ids[0], "confirmar")).rejects.toMatchObject({ message: RECUSAS_DO_COMPLEMENTO.ausente });
      expect((await resumo.resumoGuardadoDaDona(DONA, id)).itens.every(i => i.complemento === null)).toBe(true);
    });

    it("sem fonte, não grava nada e diz 'não achei'; o item ignorado e o de outra dona são recusados antes da IA", async () => {
      const { ids } = await reuniaoComResumo();
      const semFonte = { buscar: vi.fn(async () => ({ texto: "Lei 14.133", consultas: [], fontes: [] })) };
      await expect(complemento.pedirComplemento(DONA, ids[1], semFonte)).rejects.toMatchObject({ message: RECUSAS_DO_COMPLEMENTO.naoAchou });
      const [item] = await (await db()).select().from(meetingSummaryItems).where(eq(meetingSummaryItems.id, ids[1]));
      expect(item.complementText).toBeNull();
      await expect(complemento.pedirComplemento(DONA, ids[2], achou)).rejects.toMatchObject({ message: RECUSAS_DO_COMPLEMENTO.itemForaDoResumo });
      await expect(complemento.pedirComplemento(OUTRA, ids[1], achou)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(achou.buscar).not.toHaveBeenCalled();
    });

    it(`o teto: ${BUSCAS_DO_COMPLEMENTO_POR_DIA} buscas em 24 h, a que não achou também`, async () => {
      const { ids } = await reuniaoComResumo();
      await (await db()).insert(buscasDoComplemento).values(Array.from({ length: BUSCAS_DO_COMPLEMENTO_POR_DIA }, () => ({
        id: crypto.randomUUID(), ownerId: DONA, situacao: "nao_achou" as const, createdAt: AGORA(), updatedAt: AGORA(),
      })));
      await expect(complemento.pedirComplemento(DONA, ids[1], achou)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_COMPLEMENTO.demais });
      expect(achou.buscar).not.toHaveBeenCalled();
    });

    it("a reunião na lixeira esconde o item: NOT_FOUND", async () => {
      const { id, ids } = await reuniaoComResumo();
      await (await db()).update(meetings).set({ trashedAt: AGORA() }).where(eq(meetings.id, id));
      await expect(complemento.pedirComplemento(DONA, ids[1], achou)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
