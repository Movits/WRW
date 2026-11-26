import { describe, expect, it } from "vitest";
import { pontosDaBolha, raioDaBolha, raioMaximoDaBolha } from "./forma-da-bolha";

const ANGULOS = Array.from({ length: 360 }, (_, i) => (i / 360) * Math.PI * 2);
const TEMPOS = [0, 0.7, 3.1, 12.5, 600];

describe("raioDaBolha", () => {
  it("em silêncio a bolha é quase redonda: só o respiro de 2,5%", () => {
    for (const tempo of TEMPOS) {
      for (const angulo of ANGULOS) {
        const raio = raioDaBolha(50, 0, angulo, tempo);
        expect(raio).toBeGreaterThanOrEqual(50 * 0.975 - 1e-9);
        expect(raio).toBeLessThanOrEqual(50 * 1.025 + 1e-9);
      }
    }
  });

  it("nunca passa do raio máximo nem encolhe demais, em qualquer nível", () => {
    for (const nivel of [0, 0.25, 0.5, 0.75, 1, 3]) {
      const maximo = raioMaximoDaBolha(50, nivel);
      for (const tempo of TEMPOS) {
        for (const angulo of ANGULOS) {
          const raio = raioDaBolha(50, nivel, angulo, tempo);
          expect(raio).toBeLessThanOrEqual(maximo + 1e-9);
          expect(raio).toBeGreaterThan(50 * 0.9);
        }
      }
    }
  });

  it("mais voz, bolha maior e mais deformada", () => {
    const tamanho = (nivel: number) => ANGULOS.reduce((soma, angulo) => soma + raioDaBolha(50, nivel, angulo, 2), 0) / ANGULOS.length;
    const deformacao = (nivel: number) => {
      const raios = ANGULOS.map(angulo => raioDaBolha(50, nivel, angulo, 2));
      return Math.max(...raios) - Math.min(...raios);
    };
    expect(tamanho(0.8)).toBeGreaterThan(tamanho(0.3));
    expect(tamanho(0.3)).toBeGreaterThan(tamanho(0));
    expect(deformacao(0.8)).toBeGreaterThan(deformacao(0.3));
    expect(deformacao(0.3)).toBeGreaterThan(deformacao(0));
  });
});

describe("pontosDaBolha", () => {
  it("dá a volta inteira em volta do centro", () => {
    const pontos = pontosDaBolha(76, 76, 50, 0.5, 1, 72);
    expect(pontos).toHaveLength(72);
    const [x0, y0] = pontos[0];
    expect(y0).toBeCloseTo(76, 5);
    expect(x0).toBeGreaterThan(76);
    const [x18] = pontos[36];
    expect(x18).toBeLessThan(76);
  });
});
