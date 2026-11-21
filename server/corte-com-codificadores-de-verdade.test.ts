import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FormatoDoArquivo, TipoDaParte } from "@/lib/corte-comum";
import { cortarArquivo } from "@/lib/corte-do-arquivo";
import { leitorDe } from "@/test/audio-sintetico";
import { montar } from "@/test/conferir-partes";
import { AMOSTRAS_POR_SEGUNDO_DO_AUDIO, argumentosDoDecodificador } from "./conversao-do-audio";
import { medirDuracaoDoAudio } from "./duracao-do-audio";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
const { DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, TIPOS_DAS_PARTES } = await import("./fatias-de-reuniao");

/**
 * O corte da importação em partes (H9a, H9b e H9c) com arquivos de CODIFICADOR
 * DE VERDADE (revisão do pacote 4b). Os testes do client cortam arquivos
 * sintéticos, de miolo pseudoaleatório, relidos por leitores escritos para o
 * teste: um defeito que o ffmpeg ou o Gemini notariam passava pela suíte (o MP4
 * fragmentado do ffmpeg com `omit_tfhd_offset`, em que o áudio vinha com os
 * bytes do vídeo, e o download saía em silêncio "com sucesso").
 *
 * Aqui o ffmpeg gera cada formato com um tom de 440 Hz (nenhuma gravação real),
 * o corte da tela o corta em partes de 4 s, e cada parte passa pelas três
 * contas que importam: a da tela (a duração que a fila usa), a da rota das
 * partes (server/duracao-do-audio.ts) e a do decodificador do "Baixar o áudio"
 * (os mesmos argumentos, com as listas de formatos e codecs), que tem de tocar a
 * parte inteira, com o tom.
 *
 * Sem o ffmpeg na máquina, o bloco se pula; no CI (CI=true) ele é obrigatório,
 * com os codificadores que o passo "ffmpeg" de .github/workflows/testes.yml confere.
 */

// 10 s em partes de 4 s: a última tem ~2 s (com a sobra do codificador), e não uns milissegundos.
const SEGUNDOS = 10;
const POR_PARTE = 4;
const TOM = (taxa = 44100, canais = 1) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${taxa}:duration=${SEGUNDOS}`, "-ac", String(canais)];
const VIDEO = ["-f", "lavfi", "-i", `testsrc=size=160x120:rate=10:duration=${SEGUNDOS}`];

type Caso = { nome: string; arquivo: string; args: string[]; codificadores: string[]; formato: FormatoDoArquivo; tipo: TipoDaParte; folgaDoTotalMs?: number };

const CASOS: Caso[] = [
  { nome: "o M4A com o moov no fim (o do Gravador do iPhone)", arquivo: "fim.m4a", args: [...TOM(), "-c:a", "aac", "-b:a", "96k"], codificadores: ["aac"], formato: "mp4", tipo: "audio/mp4" },
  { nome: "o M4A com o moov no começo", arquivo: "comeco.m4a", args: [...TOM(), "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"], codificadores: ["aac"], formato: "mp4", tipo: "audio/mp4" },
  { nome: "o MP4 com vídeo (o do Zoom)", arquivo: "video.mp4", args: [...VIDEO, ...TOM(), "-c:v", "mpeg4", "-c:a", "aac", "-shortest"], codificadores: ["mpeg4", "aac"], formato: "mp4", tipo: "audio/mp4" },
  { nome: "o MOV com vídeo (o da câmera do iPhone)", arquivo: "video.mov", args: [...VIDEO, ...TOM(48000, 2), "-c:v", "mpeg4", "-c:a", "aac", "-shortest"], codificadores: ["mpeg4", "aac"], formato: "mp4", tipo: "audio/mp4" },
  { nome: "o MP4 fragmentado (o do Safari)", arquivo: "frag.mp4", args: [...TOM(), "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"], codificadores: ["aac"], formato: "mp4", tipo: "audio/mp4" },
  // O traf do vídeo antes do do áudio, e o tfhd sem base: o áudio conta do fim dos dados do vídeo.
  { nome: "o MP4 fragmentado com vídeo e omit_tfhd_offset", arquivo: "frag-video.mp4", args: [...VIDEO, ...TOM(), "-c:v", "mpeg4", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+omit_tfhd_offset", "-shortest"], codificadores: ["mpeg4", "aac"], formato: "mp4", tipo: "audio/mp4" },
  { nome: "o WebM com Opus (o do Chrome)", arquivo: "opus.webm", args: [...TOM(48000), "-c:a", "libopus", "-b:a", "32k"], codificadores: ["libopus"], formato: "webm", tipo: "audio/ogg" },
  { nome: "o MKV com Opus", arquivo: "opus.mkv", args: [...TOM(48000, 2), "-c:a", "libopus", "-b:a", "48k"], codificadores: ["libopus"], formato: "webm", tipo: "audio/ogg" },
  { nome: "o MKV com AAC", arquivo: "aac.mkv", args: [...TOM(), "-c:a", "aac"], codificadores: ["aac"], formato: "webm", tipo: "audio/mp4" },
  { nome: "o MKV com vídeo e AAC", arquivo: "video.mkv", args: [...VIDEO, ...TOM(), "-c:v", "mpeg4", "-c:a", "aac", "-shortest"], codificadores: ["mpeg4", "aac"], formato: "webm", tipo: "audio/mp4" },
  { nome: "o Ogg Opus (o do WhatsApp)", arquivo: "whatsapp.ogg", args: [...TOM(48000), "-c:a", "libopus", "-b:a", "24k"], codificadores: ["libopus"], formato: "ogg", tipo: "audio/ogg" },
  { nome: "o Ogg Vorbis", arquivo: "vorbis.ogg", args: [...TOM(), "-c:a", "libvorbis"], codificadores: ["libvorbis"], formato: "ogg", tipo: "audio/ogg" },
  { nome: "o Ogg com vídeo Theora e áudio Vorbis", arquivo: "theora.ogg", args: [...VIDEO, ...TOM(), "-c:v", "libtheora", "-c:a", "libvorbis", "-shortest", "-f", "ogg"], codificadores: ["libtheora", "libvorbis"], formato: "ogg", tipo: "audio/ogg" },
  // O trecho de uma transmissão: o grânulo começa em 1 h, e a primeira parte não leva essa hora.
  { nome: "o Ogg Vorbis que não começa no 0 (1 h de grânulo)", arquivo: "transmissao.ogg", args: [...TOM(), "-c:a", "libvorbis", "-output_ts_offset", "3600"], codificadores: ["libvorbis"], formato: "ogg", tipo: "audio/ogg" },
  { nome: "o FLAC", arquivo: "tom.flac", args: [...TOM(), "-c:a", "flac"], codificadores: ["flac"], formato: "flac", tipo: "audio/flac" },
  { nome: "o WAV de 8 bits", arquivo: "u8.wav", args: [...TOM(16000), "-c:a", "pcm_u8"], codificadores: ["pcm_u8"], formato: "wav", tipo: "audio/wav" },
  { nome: "o WAV de 16 bits, estéreo", arquivo: "s16.wav", args: [...TOM(22050, 2), "-c:a", "pcm_s16le"], codificadores: ["pcm_s16le"], formato: "wav", tipo: "audio/wav" },
  { nome: "o WAV de 24 bits (o extensível)", arquivo: "s24.wav", args: [...TOM(16000), "-c:a", "pcm_s24le"], codificadores: ["pcm_s24le"], formato: "wav", tipo: "audio/wav" },
  { nome: "o WAV em ponto flutuante", arquivo: "f32.wav", args: [...TOM(16000), "-c:a", "pcm_f32le"], codificadores: ["pcm_f32le"], formato: "wav", tipo: "audio/wav" },
  { nome: "o RF64", arquivo: "rf64.wav", args: [...TOM(16000), "-c:a", "pcm_s16le", "-rf64", "always"], codificadores: ["pcm_s16le"], formato: "wav", tipo: "audio/wav" },
  { nome: "o WAV em A-law", arquivo: "alaw.wav", args: [...TOM(8000), "-c:a", "pcm_alaw"], codificadores: ["pcm_alaw"], formato: "wav", tipo: "audio/wav" },
  { nome: "o WAV em µ-law", arquivo: "mulaw.wav", args: [...TOM(8000), "-c:a", "pcm_mulaw"], codificadores: ["pcm_mulaw"], formato: "wav", tipo: "audio/wav" },
  // O "MP3 em WAV" de gravadores: sai como MP3.
  { nome: "o WAV com MP3 dentro", arquivo: "mp3-em.wav", args: [...TOM(), "-c:a", "libmp3lame", "-b:a", "64k"], codificadores: ["libmp3lame"], formato: "wav", tipo: "audio/mpeg" },
  { nome: "o AAC em ADTS", arquivo: "tom.aac", args: [...TOM(), "-c:a", "aac", "-f", "adts"], codificadores: ["aac"], formato: "aac", tipo: "audio/aac" },
  { nome: "o MP3", arquivo: "tom.mp3", args: [...TOM(), "-c:a", "libmp3lame", "-b:a", "64k"], codificadores: ["libmp3lame"], formato: "mp3", tipo: "audio/mpeg" },
  // A camada II no mesmo audio/mpeg: o download precisa do decodificador dela.
  { nome: "o MP2 (MPEG camada II) num .mp3", arquivo: "camada2.mp3", args: [...TOM(), "-c:a", "mp2", "-b:a", "128k", "-f", "mp2"], codificadores: ["mp2"], formato: "mp3", tipo: "audio/mpeg" },
];

/** A extensão com que a parte vai ao decodificador, como na conversão do download. */
const EXTENSAO: Record<TipoDaParte, string> = {
  "audio/mpeg": "mp3", "audio/aac": "aac", "audio/wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a",
};

const codificadores = (() => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
})();
const temCodificador = (nome: string) => new RegExp(`\\s${nome}\\s`).test(codificadores);
const comFfmpeg = codificadores !== "" || process.env.CI === "true";

describe.skipIf(!comFfmpeg)("o corte com arquivos de codificador de verdade: a tela, a rota das partes e o decodificador do download batem", () => {
  let pasta = "";
  beforeAll(() => { pasta = mkdtempSync(path.join(os.tmpdir(), "wrw-corte-de-verdade-")); });
  afterAll(() => { if (pasta) rmSync(pasta, { recursive: true, force: true }); });

  it("todo tipo que o corte entrega é um que a rota das partes aceita", () => {
    for (const caso of CASOS) expect(TIPOS_DAS_PARTES).toContain(caso.tipo);
  });

  it.each(CASOS)("$nome", async caso => {
    const faltam = caso.codificadores.filter(c => !temCodificador(c));
    // No CI todos existem (o passo "ffmpeg" confere); fora dele, o caso sem o codificador se pula.
    if (faltam.length && process.env.CI !== "true") return;
    expect(faltam).toEqual([]);

    const origem = path.join(pasta, caso.arquivo);
    const gerado = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...caso.args, origem], { encoding: "utf8" });
    if (gerado.status !== 0) throw new Error(`o ffmpeg não gerou ${caso.arquivo}: ${gerado.stderr}`);
    const bytes = new Uint8Array(readFileSync(origem));

    const corte = await cortarArquivo(leitorDe(bytes), bytes.length, { segundosPorParte: POR_PARTE });
    if (!corte.ok) throw new Error(`o corte recusou ${caso.arquivo}: ${corte.codigo} ${corte.detalhe ?? ""}`);
    expect({ formato: corte.formato, tipo: corte.mimeType }).toEqual({ formato: caso.formato, tipo: caso.tipo });
    expect(corte.partes.length).toBeGreaterThanOrEqual(3);

    let soma = 0;
    for (const [i, parte] of corte.partes.entries()) {
      const dados = Buffer.from(montar(bytes, parte));
      // A rota das partes mede a parte de novo, com a duração que a tela calculou.
      const medida = medirDuracaoDoAudio(dados);
      expect(medida, `a rota mede a parte ${i}`).not.toBeNull();
      expect(Math.abs(medida! * 1000 - parte.duracaoMs), `a medida da parte ${i}`).toBeLessThanOrEqual(2);
      expect(medida!).toBeLessThanOrEqual(DURACAO_MAXIMA_DA_PARTE_SEGUNDOS);
      // O decodificador do "Baixar o áudio" toca a parte inteira, e o que toca é o tom.
      const arquivoDaParte = path.join(pasta, `${caso.arquivo}.parte-${i}.${EXTENSAO[caso.tipo]}`);
      writeFileSync(arquivoDaParte, dados);
      const decodificado = spawnSync("ffmpeg", argumentosDoDecodificador(arquivoDaParte), { maxBuffer: 64 * 1024 * 1024 });
      expect(String(decodificado.stderr), `o decodificador da parte ${i}`).not.toMatch(/not on whitelist/);
      expect(decodificado.status, `o decodificador da parte ${i}: ${String(decodificado.stderr).slice(0, 300)}`).toBe(0);
      const pcm = decodificado.stdout as Buffer;
      const tocouMs = (pcm.length / 2 / AMOSTRAS_POR_SEGUNDO_DO_AUDIO) * 1000;
      expect(Math.abs(tocouMs - parte.duracaoMs), `o que a parte ${i} toca`).toBeLessThanOrEqual(150);
      expect(volume(pcm, 0.1, tocouMs / 1000 - 0.1), `o tom da parte ${i}`).toBeGreaterThan(1000);
      soma += parte.duracaoMs;
    }
    expect(Math.abs(soma - corte.duracaoMs)).toBeLessThanOrEqual(corte.partes.length);
    expect(Math.abs(corte.duracaoMs - SEGUNDOS * 1000)).toBeLessThanOrEqual(caso.folgaDoTotalMs ?? 300);
  }, 60_000);
});

/** O volume (RMS) do PCM de 16 bits, mono, a 24 kHz, entre dois instantes (s). */
function volume(pcm: Buffer, de: number, ate: number): number {
  const inicio = Math.max(0, Math.round(de * AMOSTRAS_POR_SEGUNDO_DO_AUDIO));
  const fim = Math.min(pcm.length / 2, Math.round(ate * AMOSTRAS_POR_SEGUNDO_DO_AUDIO));
  if (fim <= inicio) return 0;
  let soma = 0;
  for (let i = inicio; i < fim; i++) { const v = pcm.readInt16LE(i * 2); soma += v * v; }
  return Math.sqrt(soma / (fim - inicio));
}
