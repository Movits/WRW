import { describe, expect, it } from "vitest";
import { CORES_DAS_SERIES, dominioComZero, marcasDoEixo, numeroComUnidade, posicaoNoDominio } from "./grafico";
import { SERIES_DO_GRAFICO_MAX } from "@shared/resposta-visual";

/** As contas do gráfico da resposta visual (H6d), sem tela. */

describe("o domínio e as marcas do eixo", () => {
  it("o domínio sempre tem o zero: a barra cresce de uma linha de base só", () => {
    expect(dominioComZero([3, 7, 12])).toEqual([0, 12]);
    expect(dominioComZero([-4, 6])).toEqual([-4, 6]);
    expect(dominioComZero([-5, -2])).toEqual([-5, 0]);
  });

  it("sem variação (tudo zero, ou nenhum valor), o domínio não vira divisão por zero", () => {
    expect(dominioComZero([0, 0])).toEqual([0, 1]);
    expect(dominioComZero([])).toEqual([0, 1]);
    expect(posicaoNoDominio(5, [3, 3])).toBe(0);
  });

  it("as marcas são números redondos que cobrem o domínio, com o zero", () => {
    expect(marcasDoEixo([0, 12])).toEqual({ marcas: [0, 5, 10, 15], dominio: [0, 15] });
    expect(marcasDoEixo([0, 1200])).toEqual({ marcas: [0, 500, 1000, 1500], dominio: [0, 1500] });
    expect(marcasDoEixo([-4, 6]).marcas).toContain(0);
  });

  it("passo decimal sem lixo de ponto flutuante no eixo", () => {
    const { marcas } = marcasDoEixo([0, 0.9]);
    expect(marcas).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("a posição vai de 0 a 1 dentro do domínio", () => {
    expect(posicaoNoDominio(0, [0, 10])).toBe(0);
    expect(posicaoNoDominio(5, [0, 10])).toBe(0.5);
    expect(posicaoNoDominio(10, [0, 10])).toBe(1);
  });
});

describe("o número no idioma da tela, com a unidade", () => {
  it("moeda antes, % colado e o resto depois, com espaço", () => {
    expect(numeroComUnidade(1200, "pt-BR", "R$")).toBe("R$ 1.200");
    expect(numeroComUnidade(30, "pt-BR", "%")).toBe("30%");
    expect(numeroComUnidade(12, "pt-BR", "contêineres")).toBe("12 contêineres");
    expect(numeroComUnidade(3.5, "en")).toBe("3.5");
  });

  it("no eixo, o número grande fica curto", () => {
    expect(numeroComUnidade(12_000, "en", "", true)).toBe("12K");
    expect(numeroComUnidade(950, "en", "", true)).toBe("950");
  });

  it("há uma cor conferida para cada série que o servidor aceita", () => {
    expect(CORES_DAS_SERIES.length).toBe(SERIES_DO_GRAFICO_MAX);
  });
});
