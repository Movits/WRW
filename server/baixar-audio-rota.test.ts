import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.baixarAudio (H8c) no router, com a preparação e a conferência do
 * ffmpeg dubladas e o balcão de verdade. Prova o que fica na rota: a dona é a
 * da sessão, a prova da auditoria vem da requisição, a resposta traz só o
 * endereço da ficha (nunca a chave do bucket), o teto de 10 áudios por hora por
 * dona conta só o que foi preparado, e nenhuma recusa (ffmpeg fora, instância
 * ocupada) chega a auditar. O que a preparação faz com o banco está em
 * baixar-audio-da-reuniao.test.ts e baixar-audio-da-reuniao.integracao.test.ts.
 */

const prepararAudioDaReuniao = vi.fn();
const ffmpegDisponivel = vi.fn();

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./baixar-audio-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./baixar-audio-da-reuniao")>(),
  prepararAudioDaReuniao: (...args: unknown[]) => prepararAudioDaReuniao(...args),
  ffmpegDisponivel: () => ffmpegDisponivel(),
}));

const { appRouter } = await import("./routers");
const { meetingsRouter, tetoDoAudio } = await import("./routers/meetings");
const { balcaoDoAudio } = await import("./baixar-audio-da-reuniao");
const { AUDIOS_POR_JANELA, CONVERSOES_DE_AUDIO_SIMULTANEAS, RECUSAS_DO_AUDIO, ROTA_DO_AUDIO_BAIXADO, VALIDADE_DO_ENDERECO_DO_AUDIO_MS } = await import("@shared/baixar-audio");
const { TRPCError } = await import("@trpc/server");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const CHAVE = "meetings/dona-1/8b1f6a2e/partes/0000-abcd1234.webm";
const PREPARADO = {
  partes: [{ seq: 0, storageKey: CHAVE, mimeType: "audio/webm", inicioMs: 0, duracaoMs: 3_600_000 }],
  duracaoSegundos: 3600,
};
const contexto = (openId: string, cabecalhos: Record<string, string> = {}) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: cabecalhos, ip: "203.0.113.9", socket: {} },
  res: { cookie: () => {} },
}) as never;
const baixar = (openId = "dona-1", entrada: Record<string, unknown> = {}, cabecalhos?: Record<string, string>) =>
  meetingsRouter.createCaller(contexto(openId, cabecalhos)).baixarAudio({ meetingId: ID, formato: "mp3", nome: "Reunião: importadora / Santos - 2026-11-18", ...entrada } as never);

beforeEach(() => {
  tetoDoAudio.esquecer();
  balcaoDoAudio.esquecer();
  prepararAudioDaReuniao.mockReset();
  prepararAudioDaReuniao.mockResolvedValue(PREPARADO);
  ffmpegDisponivel.mockReset();
  ffmpegDisponivel.mockResolvedValue(true);
});

describe("meetings.baixarAudio — o que chega à preparação e o que volta", () => {
  it("a dona da sessão, a reunião, o formato e a prova da requisição; volta o endereço da ficha, o nome limpo, a validade e o tamanho", async () => {
    const resposta = await baixar("dona-1", {}, { "user-agent": "Safari no iPhone" });
    expect(prepararAudioDaReuniao).toHaveBeenCalledWith("dona-1", ID, { formato: "mp3", userId: 7, ipAddress: "203.0.113.9", userAgent: "Safari no iPhone" });
    expect(resposta).toEqual({
      endereco: expect.stringMatching(new RegExp(`^${ROTA_DO_AUDIO_BAIXADO}/[A-Za-z0-9_-]{32}$`)),
      nomeDoArquivo: "Reunião importadora Santos - 2026-11-18.mp3",
      validadeMs: VALIDADE_DO_ENDERECO_DO_AUDIO_MS,
      tamanhoEstimadoBytes: 28_800_000,
    });
  });

  it("a chave do bucket não sai na resposta: fica na ficha, no servidor, e a ficha só serve para a dona", async () => {
    const resposta = await baixar("dona-1", { formato: "m4a" });
    expect(JSON.stringify(resposta)).not.toContain("meetings/");
    const numero = resposta.endereco.split("/").pop()!;
    expect(balcaoDoAudio.tomar(numero, "outra-conta")).toBeNull();
    const tomada = balcaoDoAudio.tomar(numero, "dona-1");
    expect(tomada?.ficha).toMatchObject({ ownerId: "dona-1", meetingId: ID, formato: "m4a", nomeDoArquivo: expect.stringMatching(/\.m4a$/), partes: PREPARADO.partes });
    tomada?.terminar();
  });

  it.each([
    ["formato fora da lista", { formato: "wav" }],
    ["sem formato", { formato: undefined }],
    ["reunião sem uuid", { meetingId: "reuniao-1" }],
    ["nome grande demais", { nome: "x".repeat(301) }],
  ])("%s: BAD_REQUEST, sem chamar a preparação e sem gastar vaga", async (_caso, entrada) => {
    for (let i = 0; i < AUDIOS_POR_JANELA + 1; i++) await expect(baixar("dona-1", entrada)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prepararAudioDaReuniao).not.toHaveBeenCalled();
    await expect(baixar()).resolves.toHaveProperty("endereco");
  });

  it("a recusa da preparação sai como veio, com o código que a tela traduz", async () => {
    prepararAudioDaReuniao.mockRejectedValueOnce(new TRPCError({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.vencido }));
    await expect(baixar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "AUDIO_VENCIDO" });
    prepararAudioDaReuniao.mockRejectedValueOnce(new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada." }));
    await expect(baixar("outra-conta")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe(`meetings.baixarAudio — o teto de ${AUDIOS_POR_JANELA} áudios por hora por dona`, () => {
  it("passado o teto, TOO_MANY_REQUESTS com o código AUDIOS_DEMAIS, sem chamar a preparação; outra dona passa", async () => {
    for (let i = 0; i < AUDIOS_POR_JANELA; i++) {
      await expect(baixar()).resolves.toHaveProperty("endereco");
      // A ficha é usada (o download acontece e termina), e a vaga da instância volta.
      balcaoDoAudio.esquecer();
    }
    await expect(baixar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_AUDIO.demais });
    expect(prepararAudioDaReuniao).toHaveBeenCalledTimes(AUDIOS_POR_JANELA);
    await expect(baixar("outra-dona")).resolves.toHaveProperty("endereco");
  });

  it("o áudio que não foi preparado (recusa, banco fora, auditoria que falhou) devolve a vaga do teto e a da instância", async () => {
    prepararAudioDaReuniao.mockRejectedValue(new Error("audit_logs recusou"));
    for (let i = 0; i < AUDIOS_POR_JANELA + 3; i++) await expect(baixar()).rejects.toThrow("audit_logs recusou");
    expect(balcaoDoAudio.ocupadas()).toBe(0);
    prepararAudioDaReuniao.mockResolvedValue(PREPARADO);
    await expect(baixar()).resolves.toHaveProperty("endereco");
  });
});

describe("meetings.baixarAudio — recusas antes da transação (nenhuma audita)", () => {
  it("sem o ffmpeg no servidor: AUDIO_INDISPONIVEL, sem chamar a preparação, e a vaga volta", async () => {
    ffmpegDisponivel.mockResolvedValue(false);
    await expect(baixar()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: RECUSAS_DO_AUDIO.indisponivel });
    expect(prepararAudioDaReuniao).not.toHaveBeenCalled();
    expect(balcaoDoAudio.ocupadas()).toBe(0);
  });

  it(`a instância já com ${CONVERSOES_DE_AUDIO_SIMULTANEAS} áudios: AUDIO_OCUPADO, sem chamar a preparação; a vaga da dona volta`, async () => {
    for (let i = 0; i < CONVERSOES_DE_AUDIO_SIMULTANEAS; i++) await baixar(`outra-${i}`);
    await expect(baixar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_AUDIO.ocupado });
    expect(prepararAudioDaReuniao).toHaveBeenCalledTimes(CONVERSOES_DE_AUDIO_SIMULTANEAS);
    balcaoDoAudio.esquecer();
    for (let i = 0; i < AUDIOS_POR_JANELA; i++) { await expect(baixar()).resolves.toHaveProperty("endereco"); balcaoDoAudio.esquecer(); }
  });
});

describe("meetings.baixarAudio — só a dona baixa", () => {
  it("o procedimento é da dona (meetings.*), e o link aberto não tem nenhum que baixe áudio", () => {
    const procedimentos = Object.keys(appRouter._def.procedures);
    expect(procedimentos).toContain("meetings.baixarAudio");
    expect(procedimentos).toContain("reuniaoAberta.ver");
    expect(procedimentos.filter(nome => nome.startsWith("reuniaoAberta.") && /audio|baixar|download/i.test(nome))).toEqual([]);
  });

  it("sem sessão, UNAUTHORIZED, sem chamar a preparação", async () => {
    const semSessao = meetingsRouter.createCaller({ user: null, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never);
    await expect(semSessao.baixarAudio({ meetingId: ID, formato: "mp3" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(prepararAudioDaReuniao).not.toHaveBeenCalled();
  });
});
