import { describe, expect, it } from "vitest";
import { desenharTracos, larguraDoPonto, ponteiroDesenha, tamanhoDaImagem, type Pincel, type Traco } from "./desenho";

/** A parte da tela de desenho (H4h) que não depende do canvas. */

describe("quem desenha (a palma da mão no iPad)", () => {
  it("caneta e mouse desenham sempre; o dedo desenha até a caneta tocar a folha", () => {
    expect(ponteiroDesenha("pen", false)).toBe(true);
    expect(ponteiroDesenha("mouse", true)).toBe(true);
    expect(ponteiroDesenha("touch", false)).toBe(true);
    expect(ponteiroDesenha("touch", true)).toBe(false);
    expect(ponteiroDesenha("", false)).toBe(false);
  });
});

describe("a largura do traço", () => {
  it("só a caneta varia pela pressão, entre 60% e 140% da espessura", () => {
    expect(larguraDoPonto(4, 0, "pen")).toBe(4);
    expect(larguraDoPonto(4, 1, "pen")).toBeCloseTo(5.6);
    expect(larguraDoPonto(4, 0.01, "pen")).toBeCloseTo(2.432);
    expect(larguraDoPonto(4, 2, "pen")).toBeCloseTo(5.6);
    // O mouse manda 0,5 e o dedo, 0 ou 0,5: a espessura escolhida, sem variar.
    expect(larguraDoPonto(4, 0.5, "mouse")).toBe(4);
    expect(larguraDoPonto(4, 0.5, "touch")).toBe(4);
    expect(larguraDoPonto(4, Number.NaN, "pen")).toBe(4);
  });
});

describe("o tamanho da imagem guardada", () => {
  it("a folha vezes a densidade do aparelho, sem passar do lado máximo", () => {
    expect(tamanhoDaImagem(400, 300, 2, 1600)).toEqual({ largura: 800, altura: 600, escala: 2 });
    const grande = tamanhoDaImagem(1000, 750, 3, 1600);
    expect(grande.largura).toBe(1600);
    expect(grande.altura).toBe(1200);
    expect(tamanhoDaImagem(0, 0, 0, 1600)).toEqual({ largura: 1, altura: 1, escala: 1 });
  });
});

describe("desenharTracos", () => {
  function pincelFalso() {
    const chamadas: string[] = [];
    const pincel = {
      strokeStyle: "", fillStyle: "", lineWidth: 0, lineCap: "butt", lineJoin: "miter",
      beginPath: () => chamadas.push("beginPath"),
      moveTo: (x: number, y: number) => chamadas.push(`moveTo ${x} ${y}`),
      lineTo: (x: number, y: number) => chamadas.push(`lineTo ${x} ${y}`),
      stroke: () => chamadas.push(`stroke ${pincel.lineWidth}`),
      arc: (x: number, y: number, r: number) => chamadas.push(`arc ${x} ${y} ${r}`),
      fill: () => chamadas.push("fill"),
      fillRect: (_x: number, _y: number, l: number, a: number) => chamadas.push(`fillRect ${pincel.fillStyle} ${l} ${a}`),
    };
    return { pincel: pincel as unknown as Pincel, chamadas };
  }

  it("pinta a folha de branco e cada traço na escala pedida; um toque só vira um ponto", () => {
    const { pincel, chamadas } = pincelFalso();
    const tracos: Traco[] = [
      { cor: "#000", espessura: 4, tipo: "mouse", pontos: [{ x: 1, y: 1, pressao: 0.5 }, { x: 3, y: 2, pressao: 0.5 }] },
      { cor: "#f00", espessura: 2, tipo: "touch", pontos: [{ x: 5, y: 5, pressao: 0 }] },
      { cor: "#00f", espessura: 2, tipo: "pen", pontos: [] },
    ];
    desenharTracos(pincel, tracos, 200, 100, 2);
    expect(chamadas[0]).toBe("fillRect #ffffff 200 100");
    expect(chamadas).toContain("moveTo 2 2");
    expect(chamadas).toContain("lineTo 6 4");
    expect(chamadas).toContain("stroke 8");
    expect(chamadas).toContain("arc 10 10 2");
  });
});
