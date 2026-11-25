import { describe, expect, it } from "vitest";
import {
  INTERVALO_QUE_JUNTA_SEGUNDOS, MARGEM_ANTES_DA_FALA_SEGUNDOS, MARGEM_DEPOIS_DA_FALA_SEGUNDOS,
  dentroDosTrechos, destinoDoPuloNosTrechos, pontoParaTocar, trechosParaTocar,
} from "./trechos-para-tocar";

/**
 * Os trechos de "ouvir só esta voz" e de "pular os silêncios" (D2). As falas
 * vêm com os tempos em segundos inteiros, como o modelo os escreve.
 */
const FALAS = [
  { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia a todos." },
  { inicio: 5, fim: 9, falante: "F2", texto: "Bom dia." },
  { inicio: 9, fim: 12, falante: "F1", texto: "Vamos começar." },
  { inicio: 30, fim: 33, falante: "F1", texto: "Voltei, desculpem." },
  { inicio: 33, fim: 40, falante: "", texto: "", lacuna: true },
  { inicio: 40, fim: 42, falante: "F3", texto: "[música]" },
  { inicio: 60, fim: 64, falante: "F2", texto: "Fechado então." },
];

describe("trechosParaTocar", () => {
  it("sem voz e sem pular os silêncios, não restringe nada (nulo: o player toca tudo)", () => {
    expect(trechosParaTocar(FALAS, {})).toBeNull();
    expect(trechosParaTocar(FALAS, { voz: null, pularSilencios: false })).toBeNull();
  });

  it("só uma voz: as falas dela, com a margem, e as vizinhas juntas", () => {
    const trechos = trechosParaTocar(FALAS, { voz: "F1" })!;
    // 0–4 e 9–12 ficam separadas: o intervalo entre as margens (4,75 a 8,75) passa de 1 s.
    expect(trechos).toEqual([
      { inicio: 0, fim: 4 + MARGEM_DEPOIS_DA_FALA_SEGUNDOS },
      { inicio: 9 - MARGEM_ANTES_DA_FALA_SEGUNDOS, fim: 12 + MARGEM_DEPOIS_DA_FALA_SEGUNDOS },
      { inicio: 30 - MARGEM_ANTES_DA_FALA_SEGUNDOS, fim: 33 + MARGEM_DEPOIS_DA_FALA_SEGUNDOS },
    ]);
  });

  it("a marca sem fala ([música]) não é voz de ninguém: escolher a voz dela não toca nada", () => {
    expect(trechosParaTocar(FALAS, { voz: "F3" })).toBeNull();
  });

  it("pular os silêncios: todas as falas, inclusive as marcas, e sai só o intervalo em que ninguém fala", () => {
    const trechos = trechosParaTocar(FALAS, { pularSilencios: true })!;
    expect(trechos).toEqual([
      // 0–4, 5–9 e 9–12 são uma conversa só: os intervalos entre as margens ficam abaixo de 1 s.
      { inicio: 0, fim: 12.75 },
      { inicio: 29.75, fim: 33.75 },
      { inicio: 39.75, fim: 42.75 },
      { inicio: 59.75, fim: 64.75 },
    ]);
  });

  it("a lacuna (o trecho que não chegou) nunca vira trecho a tocar", () => {
    const trechos = trechosParaTocar(FALAS, { pularSilencios: true })!;
    expect(trechos.some(trecho => trecho.inicio < 36 && trecho.fim > 34)).toBe(false);
  });

  it("falas fora de ordem e sobrepostas viram trechos em ordem, sem sobreposição", () => {
    const trechos = trechosParaTocar([
      { inicio: 20, fim: 25, falante: "F1", texto: "depois" },
      { inicio: 2, fim: 6, falante: "F1", texto: "antes" },
      { inicio: 5, fim: 8, falante: "F1", texto: "por cima" },
    ], { voz: "F1" })!;
    expect(trechos).toEqual([{ inicio: 1.75, fim: 8.75 }, { inicio: 19.75, fim: 25.75 }]);
  });

  it("duas falas com exatamente 1 s entre as margens ficam separadas; com menos, juntas", () => {
    const separadas = trechosParaTocar([
      { inicio: 0, fim: 1, falante: "F1", texto: "a" },
      { inicio: 3, fim: 4, falante: "F1", texto: "b" },
    ], { voz: "F1" })!;
    expect(separadas).toHaveLength(2);
    expect(separadas[1].inicio - separadas[0].fim).toBe(INTERVALO_QUE_JUNTA_SEGUNDOS);
    const juntas = trechosParaTocar([
      { inicio: 0, fim: 1, falante: "F1", texto: "a" },
      { inicio: 2.9, fim: 4, falante: "F1", texto: "b" },
    ], { voz: "F1" })!;
    expect(juntas).toHaveLength(1);
  });

  it("sem falas com tempo (a transcrição antiga), não restringe: o player toca tudo", () => {
    expect(trechosParaTocar([], { pularSilencios: true })).toBeNull();
  });
});

describe("pontoParaTocar e dentroDosTrechos", () => {
  const TRECHOS = [{ inicio: 10, fim: 20 }, { inicio: 40, fim: 50 }];

  it("dentro de um trecho, toca dali; antes ou entre trechos, vai ao começo do seguinte; depois do último, nulo", () => {
    expect(pontoParaTocar(TRECHOS, 15)).toBe(15);
    expect(pontoParaTocar(TRECHOS, 0)).toBe(10);
    expect(pontoParaTocar(TRECHOS, 25)).toBe(40);
    expect(pontoParaTocar(TRECHOS, 50)).toBeNull();
    expect(pontoParaTocar(TRECHOS, 99)).toBeNull();
  });

  it("o pulo que para um pouco antes do começo pedido conta como dentro: sem isso, o player pularia de novo para o mesmo ponto, sem fim", () => {
    expect(pontoParaTocar(TRECHOS, 9.9)).toBe(9.9);
    expect(dentroDosTrechos(TRECHOS, 9.9)).toBe(true);
    expect(dentroDosTrechos(TRECHOS, 9)).toBe(false);
    expect(dentroDosTrechos(TRECHOS, 20)).toBe(false);
  });
});

describe("destinoDoPuloNosTrechos", () => {
  const TRECHOS = [{ inicio: 10, fim: 20 }, { inicio: 40, fim: 50 }];

  it("os 15 s contam só o que toca: voltar do começo de um trecho cai no anterior, e não fora deles", () => {
    // 8 s dentro do segundo trecho: voltar 15 s anda 8 nele e 7 no primeiro.
    expect(destinoDoPuloNosTrechos(TRECHOS, 48, -15)).toBe(13);
    expect(destinoDoPuloNosTrechos(TRECHOS, 15, 15)).toBe(50);
    expect(destinoDoPuloNosTrechos(TRECHOS, 12, -15)).toBe(10);
  });

  it("de fora dos trechos, conta a partir do começo do seguinte", () => {
    expect(destinoDoPuloNosTrechos(TRECHOS, 30, 5)).toBe(45);
    expect(destinoDoPuloNosTrechos(TRECHOS, 60, -5)).toBe(45);
  });
});
