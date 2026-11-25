import { describe, expect, it } from "vitest";
import { FORMATO_DO_FALANTE, NOME_DO_FALANTE_MAX, nomesDosFalantes } from "@shared/const";

describe("nomesDosFalantes (H3)", () => {
  it("só os pares válidos da coluna JSON, aparados e no tamanho máximo", () => {
    expect(nomesDosFalantes({ F1: " Ana ", F2: "", F0: "Zero", X1: "Outro", F3: 7, F12: "x".repeat(80) }))
      .toEqual({ F1: "Ana", F12: "x".repeat(NOME_DO_FALANTE_MAX) });
  });

  it("qualquer outra coisa vira sem nomes", () => {
    for (const bruto of [null, undefined, "F1", 3, [], ["Ana"]]) expect(nomesDosFalantes(bruto)).toEqual({});
  });

  it("o formato do falante é o da transcrição por partes: F1 a F99", () => {
    expect(["F1", "F9", "F10", "F99"].every(f => FORMATO_DO_FALANTE.test(f))).toBe(true);
    expect(["F0", "F100", "f1", "F01", "F", "Falante 1"].some(f => FORMATO_DO_FALANTE.test(f))).toBe(false);
  });
});
