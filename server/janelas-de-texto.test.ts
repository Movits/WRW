import { describe, expect, it } from "vitest";
import { dividirEmJanelas } from "./janelas-de-texto";

describe("dividirEmJanelas — a reunião longa lida inteira (G8)", () => {
  it("texto que cabe é uma janela só; vazio não é janela", () => {
    expect(dividirEmJanelas("curto", 100)).toEqual(["curto"]);
    expect(dividirEmJanelas("", 100)).toEqual([]);
  });

  it("juntar as janelas devolve o texto original, e nenhuma passa do tamanho", () => {
    const linhas = Array.from({ length: 400 }, (_, i) => `Fala ${i}: combinamos a entrega número ${i} na sexta.`);
    const texto = linhas.join("\n");
    const janelas = dividirEmJanelas(texto, 1_000);
    expect(janelas.length).toBeGreaterThan(10);
    expect(janelas.join("")).toBe(texto);
    for (const janela of janelas) expect(janela.length).toBeLessThanOrEqual(1_000);
  });

  it("corta na quebra de linha; sem ela, no fim de frase; sem ele, no espaço", () => {
    const comLinha = `${"a".repeat(600)}\n${"b".repeat(600)}`;
    expect(dividirEmJanelas(comLinha, 1_000)[0]).toBe(`${"a".repeat(600)}\n`);
    const comFrase = `${"a ".repeat(300)}fim. ${"b ".repeat(300)}`;
    expect(dividirEmJanelas(comFrase, 1_000)[0].endsWith("fim. ")).toBe(true);
    const soEspacos = "palavra ".repeat(200);
    const janelas = dividirEmJanelas(soEspacos, 1_000);
    expect(janelas[0].endsWith(" ")).toBe(true);
    expect(janelas.join("")).toBe(soEspacos);
  });

  it("uma quebra de linha logo no começo não gera janela minúscula", () => {
    const texto = `oi\n${"x ".repeat(1_000)}`;
    const janelas = dividirEmJanelas(texto, 1_000);
    expect(janelas[0].length).toBeGreaterThan(500);
  });

  it("uma palavra só, maior que a janela, é cortada no tamanho exato", () => {
    const janelas = dividirEmJanelas("x".repeat(2_500), 1_000);
    expect(janelas.map(j => j.length)).toEqual([1_000, 1_000, 500]);
  });

  it("recusa janela pequena demais (laço sem fim ou janela inútil)", () => {
    expect(() => dividirEmJanelas("texto", 10)).toThrow("Janela pequena demais.");
  });
});
