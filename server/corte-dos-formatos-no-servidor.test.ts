import { describe, expect, it } from "vitest";
import { PARTE_BYTES_MAX, PARTE_SEGUNDOS_MAX, type CorteDoArquivo } from "@/lib/corte-comum";
import { cortarArquivo } from "@/lib/corte-do-arquivo";
import { adts, flac, leitorDe, mp4, oggOpus, oggVorbis, wav, webm } from "@/test/audio-sintetico";
import { montar } from "@/test/conferir-partes";
import { medirDuracaoDoAudio } from "./duracao-do-audio";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
const { DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, TAMANHO_MAXIMO_DA_PARTE, TIPOS_DAS_PARTES } = await import("./fatias-de-reuniao");
const { ALLOWED_MEETING_AUDIO_TYPES } = await import("./meeting-service");

/**
 * As partes dos outros formatos importados em partes (H9b e H9c), cortadas na
 * tela (client/src/lib/corte-do-arquivo.ts), chegam à rota das partes, que
 * confere o tipo e mede cada uma de novo nos bytes (server/duracao-do-audio.ts).
 * Aqui as duas contas se encontram, formato a formato: o tipo de cada parte é
 * um que a rota aceita, e o servidor mede cada parte com a duração que a tela
 * calculou (a que a fila usa para pôr os tempos da transcrição no lugar).
 */

const CASOS: Array<[string, Uint8Array, string]> = [
  ["o WAV", wav({ segundos: 40, taxa: 8000 }).bytes, "audio/wav"],
  ["o AAC em ADTS", adts({ quadros: 2000 }).bytes, "audio/aac"],
  ["o FLAC", flac({ quadros: 500, ultimoCurto: 700 }).bytes, "audio/flac"],
  ["o FLAC de bloco variável", flac({ quadros: 500, variavel: true, bloco: 1152 }).bytes, "audio/flac"],
  ["o Ogg Opus (o áudio do WhatsApp)", oggOpus({ pacotes: 2500 }).bytes, "audio/ogg"],
  ["o Ogg Vorbis", oggVorbis({ pacotes: 1500 }).bytes, "audio/ogg"],
  // O grânulo do começo não vai para a primeira parte (o servidor lê o maior grânulo dela).
  ["o Ogg Vorbis que não começa no 0 (o trecho de uma transmissão)", oggVorbis({ pacotes: 1500, granuloInicial: 3600 * 44100 }).bytes, "audio/ogg"],
  ["o WebM do Chrome (em Ogg Opus)", webm({ pacotes: 2500, desconhecido: true }).bytes, "audio/ogg"],
  ["o MKV com AAC (em MP4)", webm({ codec: "A_AAC", pacotes: 2500, video: true }).bytes, "audio/mp4"],
  ["o M4A", mp4({ quadros: 2500, moovNoFim: true }).bytes, "audio/mp4"],
  ["o MOV com vídeo", mp4({ quadros: 2500, qt: true, video: true }).bytes, "audio/mp4"],
  ["o MP4 fragmentado", mp4({ quadros: 2500, fragmentado: true }).bytes, "audio/mp4"],
  ["o MP4 fragmentado com vídeo e a base implícita (o omit_tfhd_offset do ffmpeg)", mp4({ quadros: 2500, fragmentado: true, video: true, baseDoFragmento: "implicita" }).bytes, "audio/mp4"],
];

function partesDe(corte: CorteDoArquivo) {
  if (!corte.ok) throw new Error(`o corte recusou: ${corte.codigo}`);
  return corte;
}

describe("as partes dos outros formatos e a rota das partes (H9b e H9c)", () => {
  it("os tetos de cada parte da tela cabem nos da rota, e a maior, em base64, nos 20 MB do pedido ao Gemini", () => {
    expect(PARTE_BYTES_MAX).toBeLessThan(TAMANHO_MAXIMO_DA_PARTE);
    expect(PARTE_SEGUNDOS_MAX).toBeLessThanOrEqual(DURACAO_MAXIMA_DA_PARTE_SEGUNDOS);
    expect(Math.ceil(PARTE_BYTES_MAX / 3) * 4).toBeLessThan(20_000_000 - 256 * 1024);
  });

  it("a rota aceita os tipos do envio único e, só nas partes, o FLAC e o AAC em ADTS; o resto continua de fora", () => {
    expect(TIPOS_DAS_PARTES).toEqual([...ALLOWED_MEETING_AUDIO_TYPES, "audio/flac", "audio/aac"]);
    expect(TIPOS_DAS_PARTES).not.toContain("audio/x-matroska");
    expect(TIPOS_DAS_PARTES).not.toContain("video/mp4");
  });

  it.each(CASOS)("%s: cada parte tem um tipo que a rota aceita, e o servidor a mede com a duração que a tela calculou", async (_caso, arquivo, tipo) => {
    const corte = partesDe(await cortarArquivo(leitorDe(arquivo), arquivo.length, { segundosPorParte: 4 }));
    expect(corte.mimeType).toBe(tipo);
    expect(TIPOS_DAS_PARTES).toContain(corte.mimeType);
    expect(corte.partes.length).toBeGreaterThan(2);
    let soma = 0;
    for (const parte of corte.partes) {
      const bytes = Buffer.from(montar(arquivo, parte));
      expect(bytes.length).toBe(parte.bytes);
      expect(bytes.length).toBeLessThanOrEqual(TAMANHO_MAXIMO_DA_PARTE);
      const medida = medirDuracaoDoAudio(bytes);
      expect(medida).not.toBeNull();
      expect(Math.abs(medida! * 1000 - parte.duracaoMs)).toBeLessThanOrEqual(1);
      expect(medida!).toBeLessThanOrEqual(4.001);
      soma += parte.duracaoMs;
    }
    expect(Math.abs(soma - corte.duracaoMs)).toBeLessThanOrEqual(corte.partes.length);
  });
});

describe("medirDuracaoDoAudio — o FLAC (H9b)", () => {
  it("soma o bloco de cada quadro, à taxa do quadro, e ignora o total do STREAMINFO", () => {
    const { bytes, amostras } = flac({ quadros: 100, ultimoCurto: 300 });
    expect(medirDuracaoDoAudio(Buffer.from(bytes))).toBeCloseTo(amostras / 44100, 6);
    // O STREAMINFO forjado (o total de amostras em 1) não muda a medida.
    const forjado = Buffer.from(bytes);
    forjado.writeUInt32BE(1, 8 + 14);
    expect(medirDuracaoDoAudio(forjado)).toBeCloseTo(amostras / 44100, 6);
  });

  it("com o ID3 antes do fLaC: mede do mesmo jeito", () => {
    const { bytes, amostras } = flac({ quadros: 50, id3: true });
    expect(medirDuracaoDoAudio(Buffer.from(bytes))).toBeCloseTo(amostras / 44100, 6);
  });

  it("o FLAC sem nenhum quadro: null (quem chama recusa)", () => {
    expect(medirDuracaoDoAudio(Buffer.from(flac({ quadros: 0 }).bytes))).toBeNull();
  });
});
