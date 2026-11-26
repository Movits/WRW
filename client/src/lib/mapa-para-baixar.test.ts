import { describe, expect, it } from "vitest";
import { desenhoDoMapa, MEDIDAS_DO_DESENHO, pdfComJpeg, quebrarTexto } from "./mapa-para-baixar";

/**
 * O desenho do mapa para o JPEG e o PDF (H10b): a quebra do texto, a posição
 * das caixas (colunas por nível, o pai no meio dos filhos, nada sobreposto), o
 * espelho da direita para a esquerda e o PDF mínimo com a xref certa.
 */

// Cada letra mede 7 px: o bastante para conferir a quebra sem canvas.
const medir = (texto: string) => Array.from(texto).length * 7;
const MAPA = {
  ramos: [
    { rotulo: "Exportação de café", folhas: [{ rotulo: "Contêiner sai de Santos", filhos: ["12 de março", "Navio X"] }, { rotulo: "Seguro", filhos: [] }] },
    { rotulo: "Transportadora", folhas: [] },
  ],
};

describe("quebrarTexto", () => {
  it("quebra por palavra; a palavra longa e a escrita sem espaço, por letra; o vazio é uma linha vazia", () => {
    expect(quebrarTexto("um dois três quatro", 70, medir)).toEqual(["um dois", "três", "quatro"]);
    expect(quebrarTexto("abcdefghijklmn", 35, medir)).toEqual(["abcde", "fghij", "klmn"]);
    expect(quebrarTexto("出口咖啡的集装箱", 28, medir)).toEqual(["出口咖啡", "的集装箱"]);
    expect(quebrarTexto("", 70, medir)).toEqual([""]);
  });
});

describe("desenhoDoMapa", () => {
  it("uma caixa por nó, cada nível na sua coluna, o pai no meio dos filhos e as ligações do pai a cada filho", () => {
    const d = desenhoDoMapa("Reunião", MAPA, medir);
    expect(d.caixas).toHaveLength(1 + 2 + 2 + 2);
    const raiz = d.caixas.find(c => c.nivel === 0)!;
    const ramos = d.caixas.filter(c => c.nivel === 1);
    const filhos = d.caixas.filter(c => c.nivel === 3);
    expect(new Set(ramos.map(c => c.x)).size).toBe(1);
    expect(ramos[0].x).toBeGreaterThan(raiz.x + raiz.largura);
    expect(filhos[0].x).toBeGreaterThan(d.caixas.find(c => c.nivel === 2)!.x);
    const folha = d.caixas.find(c => c.linhas.join(" ") === "Contêiner sai de Santos")!;
    const meioDosFilhos = (filhos[0].y + filhos[0].altura / 2 + filhos[1].y + filhos[1].altura / 2) / 2;
    expect(folha.y + folha.altura / 2).toBeCloseTo(meioDosFilhos);
    expect(d.ligacoes).toHaveLength(2 + 2 + 2);
    // Ninguém fica fora do desenho nem sobreposto na mesma coluna.
    for (const c of d.caixas) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(MEDIDAS_DO_DESENHO.margem - 0.001);
      expect(c.x + c.largura).toBeLessThanOrEqual(d.largura);
      expect(c.y + c.altura).toBeLessThanOrEqual(d.altura);
    }
    for (const nivel of [1, 2, 3]) {
      const coluna = d.caixas.filter(c => c.nivel === nivel).sort((a, b) => a.y - b.y);
      for (let i = 1; i < coluna.length; i++) expect(coluna[i].y).toBeGreaterThanOrEqual(coluna[i - 1].y + coluna[i - 1].altura);
    }
  });

  it("da direita para a esquerda, o desenho é o espelho: a raiz à direita", () => {
    const ltr = desenhoDoMapa("اجتماع", MAPA, medir);
    const rtl = desenhoDoMapa("اجتماع", MAPA, medir, true);
    const raizL = ltr.caixas.find(c => c.nivel === 0)!;
    const raizR = rtl.caixas.find(c => c.nivel === 0)!;
    expect(raizR.x).toBe(rtl.largura - raizL.x - raizL.largura);
    expect(raizR.x).toBeGreaterThan(rtl.caixas.find(c => c.nivel === 1)!.x);
  });

  it("os rótulos traduzidos (H11) entram no desenho; o título não passa pela tradução", () => {
    const d = desenhoDoMapa("Reunião", MAPA, medir, false, r => `EN ${r}`);
    expect(d.caixas.find(c => c.nivel === 0)!.linhas).toEqual(["Reunião"]);
    expect(d.caixas.filter(c => c.nivel === 1).map(c => c.linhas.join(" "))).toEqual(["EN Exportação de café", "EN Transportadora"]);
  });
});

describe("pdfComJpeg", () => {
  it("um PDF de uma página do tamanho da imagem, com o JPEG inteiro e a xref apontando para cada objeto", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const pdf = pdfComJpeg(jpeg, 800, 400);
    const texto = new TextDecoder("latin1").decode(pdf);
    expect(texto.startsWith("%PDF-1.4")).toBe(true);
    expect(texto.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(texto).toContain("/MediaBox [0 0 600 300]");
    expect(texto).toContain("/Width 800 /Height 400");
    expect(texto).toContain(`/Filter /DCTDecode /Length ${jpeg.length}`);
    // O JPEG vai byte a byte.
    const inicio = pdf.findIndex((b, i) => b === 0xff && pdf[i + 1] === 0xd8);
    expect(Array.from(pdf.slice(inicio, inicio + jpeg.length))).toEqual(Array.from(jpeg));
    // Cada entrada da xref aponta para o "N 0 obj" certo, e o startxref para a xref.
    const xref = texto.slice(texto.indexOf("xref\n"));
    const entradas = xref.split("\n").slice(3, 8).map(l => Number(l.slice(0, 10)));
    entradas.forEach((deslocamento, i) => expect(texto.slice(deslocamento, deslocamento + 7)).toBe(`${i + 1} 0 obj`));
    expect(Number(texto.match(/startxref\n(\d+)/)![1])).toBe(texto.indexOf("xref\n"));
  });
});
