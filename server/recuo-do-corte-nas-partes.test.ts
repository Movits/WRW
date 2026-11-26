import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analisarAudio, medirDuracaoDoAudio } from "./duracao-do-audio";
import { converterParteEmMp3 } from "./conversao-do-audio";

// O módulo das partes pede o JWT_SECRET ao carregar (como em conversao-do-audio.test.ts).
vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
// O banco não pode ser tocado na recusa por formato: ela vem antes dele.
const exigirDb = vi.hoisted(() => vi.fn(async () => { throw new Error("o banco não devia ser lido"); }));
vi.mock("./db", async original => ({ ...(await original<typeof import("./db")>()), exigirDb }));
const { precisaConverterParaOGemini, receberParte, RecusaDaParte } = await import("./fatias-de-reuniao");

/**
 * O recuo do corte nas partes (G14, parte 2): o arquivo curto que o corte do
 * navegador reconhece mas não lê chega inteiro pela rota das partes, e o
 * servidor converte em MP3 a parte de um codec que o Gemini não lista (o ALAC,
 * o AC-3, o Vorbis no WebM, o ADPCM no WAV), antes da linha e do bucket. Os
 * codecs que o app sempre mandou (o Opus no WebM, o AAC no MP4, o Vorbis no
 * Ogg, o PCM no WAV) vão como chegaram. Os arquivos são tons gerados pelo
 * próprio ffmpeg (nenhuma gravação real); sem o ffmpeg na máquina, o bloco se
 * pula, e no CI (CI=true) ele é obrigatório.
 */

function temFfmpeg(): boolean {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 && /libmp3lame/.test(r.stdout) && /libopus/.test(r.stdout) && /libvorbis/.test(r.stdout) && /\salac\s/.test(r.stdout) && /\sac3\s/.test(r.stdout);
}
const comFfmpeg = temFfmpeg() || process.env.CI === "true";

/** Um WAV em ADPCM (formato 2) de 1 s: a medida lê o cabeçalho, e o codec está fora da lista. */
function wavAdpcm(): Buffer {
  const dados = Buffer.alloc(4000);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write("RIFF", 0); cabecalho.writeUInt32LE(36 + dados.length, 4); cabecalho.write("WAVE", 8);
  cabecalho.write("fmt ", 12); cabecalho.writeUInt32LE(16, 16); cabecalho.writeUInt16LE(2, 20); cabecalho.writeUInt16LE(1, 22);
  cabecalho.writeUInt32LE(8000, 24); cabecalho.writeUInt32LE(4000, 28); cabecalho.writeUInt16LE(256, 32); cabecalho.writeUInt16LE(4, 34);
  cabecalho.write("data", 36); cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

describe("precisaConverterParaOGemini", () => {
  it("os codecs que o app sempre mandou vão como chegaram", () => {
    for (const codecs of [["A_OPUS"], ["mp4a"], ["Opus"], ["opus"], ["vorbis"], ["mpeg"], ["flac"], ["wav:1"], ["wav:3"]]) {
      expect(precisaConverterParaOGemini(codecs)).toBe(false);
    }
  });

  it("o que só chega pelo recuo do corte vai em MP3: o ALAC, o AC-3 e o Vorbis no WebM, o ADPCM no WAV", () => {
    for (const codecs of [["alac"], ["ac-3"], ["A_AC3"], ["A_VORBIS"], ["wav:2"], ["wav:17"], ["mp4a", "alac"]]) {
      expect(precisaConverterParaOGemini(codecs)).toBe(true);
    }
  });
});

describe("receberParte: a parte que não converte é recusada antes do banco", () => {
  it("o ffmpeg falha: FORMATO, que a tela traduz, sem ler o banco", async () => {
    const bytes = wavAdpcm();
    expect(analisarAudio(bytes)).toEqual({ segundos: 1, codecs: ["wav:2"] });

    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const converter = vi.fn(async () => { throw new Error("ffmpeg ausente"); });
      const recusa = await receberParte({ ownerId: "dona-1", meetingId: "reuniao-1", seq: 0, mimeType: "audio/wav", bytes }, { converter })
        .then(() => null, (e: unknown) => e);
      expect(recusa).toBeInstanceOf(RecusaDaParte);
      expect((recusa as InstanceType<typeof RecusaDaParte>).codigo).toBe("FORMATO");
      expect(converter).toHaveBeenCalledWith(bytes, "audio/wav", 720);
      expect(exigirDb).not.toHaveBeenCalled();
      // O log leva a posição, o tipo e o codec, e nada da dona nem da reunião.
      expect(String(erro.mock.calls[0]?.[0])).toContain("a parte 0 (audio/wav, wav:2)");
      expect(String(erro.mock.calls[0]?.[0])).not.toContain("dona-1");
      expect(String(erro.mock.calls[0]?.[0])).not.toContain("reuniao-1");
    } finally {
      erro.mockRestore();
    }
  });

  it("o MP3 que o ffmpeg devolve e que a medida não lê também é FORMATO, sem ler o banco", async () => {
    const converter = vi.fn(async () => Buffer.from("não é MP3"));
    const recusa = await receberParte({ ownerId: "dona-1", meetingId: "reuniao-1", seq: 0, mimeType: "audio/wav", bytes: wavAdpcm() }, { converter })
      .then(() => null, (e: unknown) => e);
    expect((recusa as InstanceType<typeof RecusaDaParte>).codigo).toBe("FORMATO");
    expect(exigirDb).not.toHaveBeenCalled();
  });
});

describe.skipIf(!comFfmpeg)("o recuo do corte com o ffmpeg de verdade", () => {
  let pasta = "";
  beforeAll(() => { pasta = mkdtempSync(path.join(os.tmpdir(), "wrw-recuo-")); });
  afterAll(() => rmSync(pasta, { recursive: true, force: true }));

  function gerar(nome: string, args: string[]): Buffer {
    const destino = path.join(pasta, nome);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", ...args, destino], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg não gerou ${nome}: ${r.stderr}`);
    return readFileSync(destino);
  }

  // [nome, tipo da parte, argumentos, codecs que a medida acha, vai em MP3?]
  const amostras: Array<[string, string, string[], string[], boolean]> = [
    ["alac.m4a", "audio/mp4", ["-c:a", "alac"], ["alac"], true],
    ["ac3.mkv", "audio/webm", ["-c:a", "ac3", "-b:a", "96k", "-f", "matroska"], ["A_AC3"], true],
    ["vorbis.webm", "audio/webm", ["-c:a", "libvorbis", "-f", "webm"], ["A_VORBIS"], true],
    ["ac3.m4a", "audio/mp4", ["-c:a", "ac3", "-b:a", "96k"], ["ac-3"], true],
    ["opus.webm", "audio/webm", ["-c:a", "libopus", "-f", "webm"], ["A_OPUS"], false],
    ["aac.m4a", "audio/mp4", ["-c:a", "aac"], ["mp4a"], false],
    ["vorbis.ogg", "audio/ogg", ["-c:a", "libvorbis"], ["vorbis"], false],
    ["pcm.wav", "audio/wav", ["-c:a", "pcm_s16le"], ["wav:1"], false],
  ];

  it.each(amostras)("%s: a medida acha o codec e decide se vai em MP3", (nome, _tipo, args, codecs, converte) => {
    const analise = analisarAudio(gerar(nome, args));
    expect(analise.codecs).toEqual(codecs);
    expect(analise.segundos).toBeGreaterThan(2.5);
    expect(precisaConverterParaOGemini(analise.codecs)).toBe(converte);
  });

  it.each(amostras.filter(a => a[4]))("%s vira um MP3 que a medida lê com a mesma duração", async (nome, tipo, args) => {
    const mp3 = await converterParteEmMp3(gerar(nome, args), tipo, 720, { prioridade: 0 });
    expect(analisarAudio(mp3).codecs).toEqual(["mpeg"]);
    expect(medirDuracaoDoAudio(mp3)).toBeCloseTo(3, 0);
  }, 30_000);

  it("o teto de segundos corta o MP3: nada passa dos 12 min da parte", async () => {
    const mp3 = await converterParteEmMp3(gerar("alac-corte.m4a", ["-c:a", "alac"]), "audio/mp4", 1, { prioridade: 0 });
    expect(medirDuracaoDoAudio(mp3)).toBeLessThan(1.2);
  }, 30_000);

  it("o arquivo que não é áudio não converte: lança, e a pasta temporária sai", async () => {
    const temporaria = mkdtempSync(path.join(os.tmpdir(), "wrw-recuo-tmp-"));
    try {
      await expect(converterParteEmMp3(Buffer.from("isto não é áudio nenhum, só texto"), "audio/mp4", 720, { prioridade: 0, pastaTemporaria: temporaria }))
        .rejects.toThrow();
      expect(readdirSync(temporaria)).toEqual([]);
    } finally {
      rmSync(temporaria, { recursive: true, force: true });
    }
  }, 30_000);
});
