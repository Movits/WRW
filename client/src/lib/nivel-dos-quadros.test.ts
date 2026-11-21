import { describe, expect, it } from "vitest";
import { nivelDoAac, nivelDoMp3, nivelDoOpus, primeiraMarcaDoOpus } from "./nivel-dos-quadros";

/**
 * O nível de cada quadro comprimido para achar a pausa da fala (conferência de
 * tela do pacote 4b): o global_gain do MP3 e do AAC, montados aqui bit a bit, e
 * as marcas do Opus, em pacotes de verdade do libopus (tirados com o ffprobe de
 * uma voz sintética: nenhuma gravação real).
 */

/** Monta bytes a partir de [valor, bits] em sequência (o resto do último byte em zero). */
function bitsEmBytes(campos: Array<[number, number]>): number[] {
  const bits: number[] = [];
  for (const [valor, n] of campos) for (let k = n - 1; k >= 0; k--) bits.push(Math.floor(valor / 2 ** k) % 2);
  return Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((byte, bit, k) => byte | (bit << (7 - k)), 0));
}
const acessor = (bytes: number[]) => (i: number) => (i >= 0 && i < bytes.length ? bytes[i] : -1);

/** Um grânulo de um canal: part2_3_length, big_values, global_gain e o resto (30 bits no MPEG-1, 34 no MPEG-2; 59 e 63 ao todo). */
const granulo = (part23: number, bigValues: number, ganho: number, resto: number): Array<[number, number]> => [[part23, 12], [bigValues, 9], [ganho, 8], [0, resto]];

describe("nivelDoMp3 — o global_gain da informação lateral", () => {
  const mpeg1Estereo = { versao: 3, mono: false, tamanho: 417 };

  it("MPEG-1 estéreo: a média, nos dois grânulos, do maior ganho entre os canais (2^(ganho/4))", () => {
    const quadro = [0xff, 0xfb, 0x90, 0x00, ...bitsEmBytes([
      [0, 9], [0, 3], [0, 8],
      ...granulo(1500, 100, 160, 30), ...granulo(1500, 100, 150, 30),
      ...granulo(1500, 100, 164, 30), ...granulo(1500, 100, 140, 30),
    ])];
    expect(nivelDoMp3(acessor(quadro), 0, mpeg1Estereo)).toBe((2 ** 40 + 2 ** 41) / 2);
  });

  it("o grânulo sem valores grandes e quase sem bits é silêncio, qualquer que seja o ganho", () => {
    const quadro = [0xff, 0xfb, 0x90, 0x00, ...bitsEmBytes([
      [0, 9], [0, 3], [0, 8],
      ...granulo(10, 0, 210, 30), ...granulo(12, 0, 210, 30),
      ...granulo(1500, 100, 160, 30), ...granulo(1500, 100, 100, 30),
    ])];
    expect(nivelDoMp3(acessor(quadro), 0, mpeg1Estereo)).toBe(2 ** 40 / 2);
  });

  it("MPEG-1 mono com CRC: a informação lateral vem depois dos 2 bytes do CRC", () => {
    const quadro = [0xff, 0xfa, 0x90, 0xc0, 0x12, 0x34, ...bitsEmBytes([[0, 9], [0, 5], [0, 4], ...granulo(900, 50, 120, 30), ...granulo(900, 50, 128, 30)])];
    expect(nivelDoMp3(acessor(quadro), 0, { versao: 3, mono: true, tamanho: 417 })).toBe((2 ** 30 + 2 ** 32) / 2);
  });

  it("MPEG-2 estéreo: um grânulo, com o scalefac_compress de 9 bits (34 bits depois do ganho)", () => {
    const quadro = [0xff, 0xf3, 0x80, 0x00, ...bitsEmBytes([[0, 8], [0, 2], ...granulo(700, 40, 100, 34), ...granulo(700, 40, 108, 34)])];
    expect(nivelDoMp3(acessor(quadro), 0, { versao: 2, mono: false, tamanho: 208 })).toBe(2 ** 27);
  });

  it("o quadro que acaba antes da informação lateral não se lê (Infinity)", () => {
    expect(nivelDoMp3(acessor([0xff, 0xfb, 0x90, 0x00, 0x00]), 0, { versao: 3, mono: false, tamanho: 8 })).toBe(Infinity);
  });
});

describe("nivelDoAac — o global_gain do primeiro elemento de canal", () => {
  /** O ics_info da janela longa: reservado, sequência, forma, max_sfb (6) e a predição. */
  const icsLongo = (maxSfb: number, predicao = 0): Array<[number, number]> => [[0, 1], [0, 2], [0, 1], [maxSfb, 6], [predicao, 1]];

  it("SCE (o mono): o global_gain vem logo depois do tag, antes do ics_info", () => {
    const bloco = bitsEmBytes([[0, 3], [0, 4], [120, 8], ...icsLongo(40), [0, 16]]);
    expect(nivelDoAac(acessor(bloco), 0, bloco.length)).toBe(2 ** 30);
  });

  it("sem bandas codificadas (max_sfb 0), o quadro é silêncio", () => {
    const bloco = bitsEmBytes([[0, 3], [0, 4], [200, 8], ...icsLongo(0), [0, 16]]);
    expect(nivelDoAac(acessor(bloco), 0, bloco.length)).toBe(0);
  });

  it("CPE com a janela comum e a máscara M/S por banda: o ganho do primeiro canal vem depois dela", () => {
    const bloco = bitsEmBytes([[1, 3], [0, 4], [1, 1], ...icsLongo(10), [1, 2], [0b1010110011, 10], [128, 8], [0, 16]]);
    expect(nivelDoAac(acessor(bloco), 0, bloco.length)).toBe(2 ** 32);
  });

  it("CPE com a janela curta comum: a máscara tem os grupos × max_sfb bits", () => {
    // O agrupamento 0110110 tem três zeros: quatro grupos de janelas, e a máscara, 4 × 12 bits.
    const bloco = bitsEmBytes([[1, 3], [0, 4], [1, 1], [0, 1], [2, 2], [0, 1], [12, 4], [0b0110110, 7], [1, 2], [0, 48], [140, 8], [0, 16]]);
    expect(nivelDoAac(acessor(bloco), 0, bloco.length)).toBe(2 ** 35);
  });

  it("CPE sem a janela comum: o primeiro canal começa no ganho", () => {
    const bloco = bitsEmBytes([[1, 3], [0, 4], [0, 1], [100, 8], ...icsLongo(20), [0, 16]]);
    expect(nivelDoAac(acessor(bloco), 0, bloco.length)).toBe(2 ** 25);
  });

  it("outro elemento primeiro (o FIL) ou a predição do AAC Main: o quadro não se lê (Infinity)", () => {
    const fil = bitsEmBytes([[6, 3], [0, 4], [0, 16]]);
    expect(nivelDoAac(acessor(fil), 0, fil.length)).toBe(Infinity);
    const comPredicao = bitsEmBytes([[0, 3], [0, 4], [120, 8], ...icsLongo(40, 1), [0, 16]]);
    expect(nivelDoAac(acessor(comPredicao), 0, comPredicao.length)).toBe(Infinity);
  });

  it("o bloco de menos de 3 bytes (o silêncio de alguns codificadores) é silêncio", () => {
    expect(nivelDoAac(acessor([0x01, 0x18]), 0, 2)).toBe(0);
  });
});

describe("nivelDoOpus — as marcas do começo do quadro", () => {
  // SILK de banda larga, 20 ms (TOC 0x48), da voz sintética com pausas em ruído de sala (16 kHz, 16 kbps, voip).
  const SILK_FALA = [0x48, 0xb7, 0xd6, 0xf6, 0xf8];
  const SILK_PAUSA = [0x48, 0x33, 0x1e, 0xa9, 0x45];
  // CELT de banda cheia, 20 ms (TOC 0xf8): o pacote do silêncio digital (3 bytes) e um com som.
  const CELT_SILENCIO = [0xf8, 0xff, 0xfe];
  const CELT_SOM = [0xf8, 0xc2, 0xa8, 0xdd, 0xe4];

  it("a marca de voz do SILK: com voz, os bits por ms; sem voz, 0", () => {
    expect(primeiraMarcaDoOpus(SILK_FALA, 1)).toBe(true);
    expect(primeiraMarcaDoOpus(SILK_PAUSA, 1)).toBe(false);
    expect(nivelDoOpus(SILK_FALA, 40, 20)).toBe(16);
    expect(nivelDoOpus(SILK_PAUSA, 31, 20)).toBe(0);
  });

  it("a marca de silêncio do CELT: o pacote do silêncio digital vale 0; o com som, os bits por ms", () => {
    expect(primeiraMarcaDoOpus(CELT_SILENCIO, 15)).toBe(true);
    expect(primeiraMarcaDoOpus(CELT_SOM, 15)).toBe(false);
    expect(nivelDoOpus(CELT_SILENCIO, 3, 20)).toBe(0);
    expect(nivelDoOpus(CELT_SOM, 185, 20)).toBe(74);
  });

  it("o pacote de até 2 bytes (o DTX) é pausa; o de vários quadros com tamanhos (código 3) fica com os bits por ms", () => {
    expect(nivelDoOpus([0x48, 0x00], 2, 20)).toBe(0);
    expect(nivelDoOpus([0x4b, 0x83, 0x33, 0x1e, 0xa9], 60, 60)).toBe(8);
  });
});
