import { describe, expect, it } from "vitest";
import { cortarMp3, PARTE_DO_MP3_BYTES_MAX, PARTE_DO_MP3_SEGUNDOS_MAX, type ParteDoMp3 } from "@/lib/corte-do-mp3";
import { id3v1, id3v2, juntar, leitorDe, MPEG1_128K, MPEG2_64K, quadroDeEtiqueta, quadros, quadrosVariaveis, sequencia } from "@/test/mp3-sintetico";
import { medirDuracaoDoAudio } from "./duracao-do-audio";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
const { DURACAO_MAXIMA_DA_PARTE_SEGUNDOS, PARTES_NO_MAXIMO, TAMANHO_MAXIMO_DA_PARTE } = await import("./fatias-de-reuniao");
const { PARTES_POR_DONA_EM_10_MIN } = await import("./_core/rota-das-partes");

/**
 * As partes do MP3 importado em partes (H9a), cortadas na tela
 * (client/src/lib/corte-do-mp3.ts), chegam à rota das partes, que mede cada
 * uma de novo nos bytes (server/duracao-do-audio.ts) e recusa a que passa dos
 * tetos dela. Aqui as duas contas se encontram: o servidor mede cada parte com
 * a duração que a tela calculou, e os tetos da tela cabem nos do servidor.
 */

const montar = (arquivo: Uint8Array, parte: ParteDoMp3) => Buffer.concat(parte.faixas.map(f => Buffer.from(arquivo.subarray(f.inicio, f.fim))));

describe("o MP3 cortado na tela e a rota das partes (H9a)", () => {
  it("os tetos de cada parte da tela cabem nos da rota das partes", () => {
    expect(PARTE_DO_MP3_BYTES_MAX).toBeLessThan(TAMANHO_MAXIMO_DA_PARTE);
    expect(PARTE_DO_MP3_SEGUNDOS_MAX).toBeLessThanOrEqual(DURACAO_MAXIMA_DA_PARTE_SEGUNDOS);
  });

  it("a parte maior, em base64 (como vai ao Gemini, inline), cabe nos 20 MB do pedido, com folga para o prompt", () => {
    expect(Math.ceil(PARTE_DO_MP3_BYTES_MAX / 3) * 4).toBeLessThan(20_000_000 - 256 * 1024);
  });

  it("o MP3 de 12 h no bitrate mais alto (320 kbps) cabe no teto de partes da reunião e no da rota a cada 10 min", () => {
    const partes = Math.ceil((12 * 3600 * 320_000) / 8 / PARTE_DO_MP3_BYTES_MAX);
    expect(partes).toBeLessThanOrEqual(PARTES_POR_DONA_EM_10_MIN);
    expect(partes).toBeLessThanOrEqual(PARTES_NO_MAXIMO);
  });

  it("cada parte, montada pelas faixas, o servidor mede com a duração que a tela calculou", async () => {
    // Dois MP3 emendados, de taxas diferentes, com o ID3 e o Xing do segundo no meio.
    const arquivo = juntar(
      id3v2(4000), quadroDeEtiqueta(MPEG1_128K, "Xing"), quadros(MPEG1_128K, 2000, 1),
      id3v2(1500), quadroDeEtiqueta(MPEG2_64K, "Info"), quadros(MPEG2_64K, 3000, 2), id3v1(),
    );
    const corte = await cortarMp3(leitorDe(arquivo), arquivo.length, { segundosPorParte: 20 });
    if (!corte.ok) throw new Error(corte.codigo);
    expect(corte.partes.length).toBeGreaterThan(5);
    for (const parte of corte.partes) {
      const bytes = montar(arquivo, parte);
      expect(bytes.length).toBe(parte.bytes);
      const medida = medirDuracaoDoAudio(bytes);
      expect(medida).not.toBeNull();
      expect(Math.abs(medida! * 1000 - parte.duracaoMs)).toBeLessThanOrEqual(1);
      expect(medida!).toBeLessThanOrEqual(20);
    }
    const esperado = 2000 * MPEG1_128K.segundos + 3000 * MPEG2_64K.segundos;
    expect(Math.abs(corte.duracaoMs - esperado * 1000)).toBeLessThanOrEqual(1);
  });

  it("o MP3 de verdade, com o enchimento alternando 417 e 418 bytes e o bitrate variável: o servidor mede cada parte com a duração que a tela calculou", async () => {
    const { bytes } = sequencia(quadrosVariaveis(3000));
    const arquivo = juntar(id3v2(1200), quadroDeEtiqueta(MPEG1_128K, "Xing"), bytes, id3v1());
    const corte = await cortarMp3(leitorDe(arquivo), arquivo.length, { segundosPorParte: 20 });
    if (!corte.ok) throw new Error(corte.codigo);
    expect(corte.partes.length).toBe(4);
    expect(corte.partes.reduce((soma, parte) => soma + parte.bytes, 0)).toBe(bytes.length);
    for (const parte of corte.partes) {
      const montada = montar(arquivo, parte);
      expect(montada.length).toBe(parte.bytes);
      const medida = medirDuracaoDoAudio(montada);
      expect(medida).not.toBeNull();
      expect(Math.abs(medida! * 1000 - parte.duracaoMs)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(corte.duracaoMs - 3000 * MPEG1_128K.segundos * 1000)).toBeLessThanOrEqual(1);
  });

  it("o arquivo inteiro, que ainda tem o quadro Xing, o servidor mede com um quadro a mais que a soma das partes", async () => {
    const arquivo = juntar(id3v2(800), quadroDeEtiqueta(MPEG1_128K, "Xing"), quadros(MPEG1_128K, 500), id3v1());
    const corte = await cortarMp3(leitorDe(arquivo), arquivo.length);
    if (!corte.ok) throw new Error(corte.codigo);
    expect(corte.partes).toHaveLength(1);
    const inteiro = medirDuracaoDoAudio(Buffer.from(arquivo))!;
    expect(Math.abs(inteiro - (corte.duracaoMs / 1000 + MPEG1_128K.segundos))).toBeLessThan(0.002);
    expect(medirDuracaoDoAudio(montar(arquivo, corte.partes[0]))! * 1000).toBeCloseTo(corte.duracaoMs, 0);
  });
});
