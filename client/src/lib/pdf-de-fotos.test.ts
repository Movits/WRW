import { describe, expect, it, vi } from "vitest";
import {
  FotoIlegivel, fotoParaJpeg, fotosParaPdf, LADO_MAXIMO_DA_FOTO_DO_TEXTO, montarPdfDeJpegs, QUALIDADE_DA_FOTO_DO_TEXTO,
  type JpegDaPagina,
} from "./pdf-de-fotos";
import type { AmbienteDeImagem, ImagemAberta } from "./reduzir-imagem";

/**
 * As fotos de um texto viram um PDF no aparelho (H12b): uma página por foto, na
 * ordem, montado à mão (sem biblioteca), e é esse PDF que o servidor guarda e a
 * IA lê. O que se prova aqui:
 *
 * - a forma do arquivo: o cabeçalho "%PDF-" que o servidor confere, a árvore de
 *   páginas na ordem das fotos, o JPEG de cada página guardado byte a byte, e a
 *   tabela de posições (xref) que os leitores de PDF exigem, com cada posição
 *   caindo no começo do objeto certo;
 * - cada foto passa pelo canvas (que endireita pela orientação e tira o EXIF,
 *   a localização inclusive), reduzida a LADO_MAXIMO_DA_FOTO_DO_TEXTO e em JPEG;
 * - a foto que o navegador não abre, ou o canvas que não é confiável, vira
 *   FotoIlegivel com a posição, para a tela dizer qual foto.
 *
 * O jsdom não tem canvas: o ambiente de imagem é um dublê (como em
 * reduzir-imagem.test.ts). Que o arquivo abre de verdade num leitor de PDF foi
 * conferido com o pdf.js, fora da suíte (ver a PR).
 */

const latin1 = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join("");

/** Um "JPEG" de mentira: o PDF guarda os bytes como estão, e o teste os acha de volta. */
const jpeg = (marca: string, largura: number, altura: number): JpegDaPagina => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from(marca, letra => letra.charCodeAt(0)), 0xff, 0xd9]),
  largura,
  altura,
});

describe("montarPdfDeJpegs: a forma do PDF", () => {
  const paginas = [jpeg("PAGINA-UM", 1800, 1350), jpeg("PAGINA-DOIS", 1200, 1800)];
  const pdf = montarPdfDeJpegs(paginas);
  const texto = latin1(pdf);

  it("começa por %PDF- (o que o servidor confere) e diz logo que é binário", () => {
    expect(texto.startsWith("%PDF-1.4\n%")).toBe(true);
    expect(Array.from(pdf.subarray(10, 14)).every(byte => byte > 127)).toBe(true);
    expect(texto.endsWith("%%EOF\n")).toBe(true);
  });

  it("uma página por foto, na ordem das fotos, com o JPEG de cada uma guardado como está", () => {
    expect(texto).toContain("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>");
    const um = texto.indexOf("PAGINA-UM");
    const dois = texto.indexOf("PAGINA-DOIS");
    expect(um).toBeGreaterThan(0);
    expect(dois).toBeGreaterThan(um);
    // A imagem de cada página: as dimensões e o tamanho dos bytes do JPEG, em DCTDecode.
    expect(texto).toContain(`/Width 1800 /Height 1350 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${paginas[0].bytes.length}`);
    expect(texto).toContain(`/Width 1200 /Height 1800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${paginas[1].bytes.length}`);
    for (const pagina of paginas) {
      const inicio = texto.indexOf(latin1(pagina.bytes));
      expect(inicio).toBeGreaterThan(0);
      expect(texto.slice(inicio - "stream\n".length, inicio)).toBe("stream\n");
      expect(texto.slice(inicio + pagina.bytes.length, inicio + pagina.bytes.length + "\nendstream".length)).toBe("\nendstream");
    }
  });

  it("a página tem o lado maior de uma A4 (842 pt) e o outro na proporção da foto", () => {
    expect(texto).toContain("/MediaBox [0 0 842 631.5]");
    expect(texto).toContain("/MediaBox [0 0 561.33 842]");
    // E o desenho estica a imagem à página inteira, com o tamanho certo no /Length.
    const desenho = "q 842 0 0 631.5 0 0 cm /Im0 Do Q";
    expect(texto).toContain(`<< /Length ${desenho.length} >>\nstream\n${desenho}\nendstream`);
  });

  it("a tabela de posições aponta para o começo de cada objeto, e o startxref para a tabela", () => {
    const inicioDaTabela = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(texto)![1]);
    expect(texto.slice(inicioDaTabela, inicioDaTabela + 5)).toBe("xref\n");
    const [, total] = /^xref\n0 (\d+)\n/.exec(texto.slice(inicioDaTabela))!;
    // 2 objetos fixos (catálogo e páginas) e 3 por página, mais a entrada 0.
    expect(Number(total)).toBe(2 + 3 * paginas.length + 1);
    const linhas = texto.slice(inicioDaTabela).split("\n").slice(2, 2 + Number(total));
    expect(linhas[0]).toBe("0000000000 65535 f ");
    linhas.slice(1).forEach((linha, i) => {
      // Cada linha tem exatamente 20 bytes com o "\n" (a regra da especificação).
      expect(`${linha}\n`).toHaveLength(20);
      const posicao = Number(linha.slice(0, 10));
      expect(texto.slice(posicao, posicao + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(texto).toContain(`trailer\n<< /Size ${Number(total)} /Root 1 0 R >>`);
  });

  it("sem página, ou com página vazia, não monta", () => {
    expect(() => montarPdfDeJpegs([])).toThrow();
    expect(() => montarPdfDeJpegs([{ bytes: new Uint8Array(0), largura: 10, altura: 10 }])).toThrow();
    expect(() => montarPdfDeJpegs([{ bytes: new Uint8Array([1]), largura: 0, altura: 10 }])).toThrow();
  });
});

/** O navegador de mentira: abre a foto com as dimensões dadas e "desenha" em JPEG. */
function ambiente(opcoes: {
  dimensoes?: Array<{ largura: number; altura: number } | null | "lanca">;
  confiavel?: boolean;
  saida?: (largura: number, altura: number) => string | null;
} = {}) {
  const desenhos: Array<{ largura: number; altura: number; tipo: string; qualidade: number }> = [];
  const fechadas: number[] = [];
  let aberturas = 0;
  const falso: AmbienteDeImagem = {
    async abrir() {
      const posicao = aberturas++;
      const dimensao = opcoes.dimensoes && posicao < opcoes.dimensoes.length ? opcoes.dimensoes[posicao] : { largura: 4000, altura: 3000 };
      if (dimensao === "lanca") throw new Error("não decodifica");
      if (!dimensao) return null;
      const aberta: ImagemAberta = {
        ...dimensao,
        async paraDataUrl(largura, altura, tipo, qualidade) {
          desenhos.push({ largura, altura, tipo, qualidade });
          return opcoes.saida ? opcoes.saida(largura, altura) : `data:image/jpeg;base64,${btoa(`JPEG-${posicao}`)}`;
        },
        fechar() { fechadas.push(posicao); },
      };
      return aberta;
    },
    lerDataUrl: async () => "",
    suportaWebp: () => true,
    leituraConfiavel: () => opcoes.confiavel ?? true,
  };
  return { falso, desenhos, fechadas };
}

const foto = (nome = "pagina.jpg") => new File([new Uint8Array([1, 2, 3])], nome, { type: "image/jpeg" });

describe("fotoParaJpeg: cada foto passa pelo canvas, reduzida e em JPEG", () => {
  it("a foto grande desce ao lado máximo, mantendo a proporção, em JPEG de qualidade 0,8, e o bitmap é fechado", async () => {
    const { falso, desenhos, fechadas } = ambiente();
    const pagina = await fotoParaJpeg(foto(), 0, falso);
    expect(LADO_MAXIMO_DA_FOTO_DO_TEXTO).toBe(1800);
    expect(desenhos).toEqual([{ largura: 1800, altura: 1350, tipo: "image/jpeg", qualidade: QUALIDADE_DA_FOTO_DO_TEXTO }]);
    expect(pagina).toMatchObject({ largura: 1800, altura: 1350 });
    expect(latin1(pagina.bytes)).toBe("JPEG-0");
    expect(fechadas).toEqual([0]);
  });

  it("a foto pequena não é ampliada", async () => {
    const { falso, desenhos } = ambiente({ dimensoes: [{ largura: 900, altura: 1200 }] });
    await fotoParaJpeg(foto(), 0, falso);
    expect(desenhos[0]).toMatchObject({ largura: 900, altura: 1200 });
  });

  it.each([
    ["o navegador não abre a foto (HEIC no computador, arquivo corrompido)", { dimensoes: ["lanca" as const] }],
    ["o navegador diz não sem erro", { dimensoes: [null] }],
    ["o canvas devolve outra imagem (navegador contra fingerprinting)", { confiavel: false }],
    ["o navegador não codifica JPEG e devolve PNG", { saida: () => "data:image/png;base64,AAAA" }],
    ["o canvas não devolve nada", { saida: () => null }],
  ])("%s: FotoIlegivel com a posição da foto", async (_caso, opcoes) => {
    const { falso, fechadas } = ambiente(opcoes);
    const erro = await fotoParaJpeg(foto(), 4, falso).catch(e => e);
    expect(erro).toBeInstanceOf(FotoIlegivel);
    expect(erro.posicao).toBe(4);
    // O bitmap aberto é sempre fechado (a memória do celular).
    if (!("dimensoes" in opcoes)) expect(fechadas).toEqual([0]);
  });
});

describe("fotosParaPdf: as fotos, uma de cada vez, num PDF só", () => {
  it("na ordem em que a dona as tirou, avisando o andamento, e o resultado é um PDF", async () => {
    const { falso } = ambiente({ dimensoes: [{ largura: 1000, altura: 1400 }, { largura: 1400, altura: 1000 }, { largura: 800, altura: 800 }] });
    const aoAvancar = vi.fn();
    const pdf = await fotosParaPdf([foto("1.jpg"), foto("2.jpg"), foto("3.jpg")], { aoAvancar, ambiente: falso });
    expect(aoAvancar.mock.calls.map(([prontas]) => prontas)).toEqual([1, 2, 3]);
    expect(pdf.type).toBe("application/pdf");
    const texto = latin1(new Uint8Array(await pdf.arrayBuffer()));
    expect(texto.startsWith("%PDF-")).toBe(true);
    expect(texto).toContain("/Count 3");
    const posicoes = ["JPEG-0", "JPEG-1", "JPEG-2"].map(marca => texto.indexOf(marca));
    expect(posicoes.every((posicao, i) => posicao > 0 && (i === 0 || posicao > posicoes[i - 1]))).toBe(true);
  });

  it("a foto ilegível no meio para tudo e diz qual foi", async () => {
    const { falso } = ambiente({ dimensoes: [{ largura: 1000, altura: 1400 }, "lanca"] });
    const aoAvancar = vi.fn();
    const erro = await fotosParaPdf([foto(), foto(), foto()], { aoAvancar, ambiente: falso }).catch(e => e);
    expect(erro).toBeInstanceOf(FotoIlegivel);
    expect(erro.posicao).toBe(1);
    expect(aoAvancar).toHaveBeenCalledTimes(1);
  });
});
