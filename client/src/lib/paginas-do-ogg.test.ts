import { describe, expect, it } from "vitest";
import { amostrasOpus, etiquetasVazias, paginar, PartesEmOggOpus } from "./paginas-do-ogg";
import { aleatorios, opusHead, TOC_OPUS_20MS } from "@/test/audio-sintetico";
import { montar, pacotesOgg, paginasOgg } from "@/test/conferir-partes";

/**
 * As páginas do Ogg que os cortes escrevem (H9b): a conta das amostras pelo
 * TOC (a mesma do servidor), as páginas de cabeçalho, as etiquetas vazias e as
 * partes em Ogg Opus de pacotes que vêm de outro contêiner.
 */

describe("amostrasOpus", () => {
  it("pelo TOC: o SILK, o híbrido e o CELT, um, dois ou N quadros, e o pacote acima de 120 ms é descartado", () => {
    expect(amostrasOpus(0x08, 0, 50)).toBe(960); // SILK 20 ms
    expect(amostrasOpus(0x18, 0, 50)).toBe(2880); // SILK 60 ms
    expect(amostrasOpus(0x60, 0, 50)).toBe(480); // híbrido 10 ms
    expect(amostrasOpus(0x68, 0, 50)).toBe(960); // híbrido 20 ms
    expect(amostrasOpus(0xf8, 0, 50)).toBe(960); // CELT 20 ms
    expect(amostrasOpus(0xf9, 0, 50)).toBe(1920); // dois quadros iguais
    expect(amostrasOpus(0x13, 3, 50)).toBe(5760); // código 3: 3 quadros de 40 ms
    expect(amostrasOpus(0x1b, 3, 50)).toBe(0); // 3 quadros de 60 ms passam de 120 ms
    expect(amostrasOpus(0xf8, 0, 0)).toBe(0);
  });
});

describe("paginar e etiquetasVazias", () => {
  it("o pacote de cabeçalho maior que uma página atravessa páginas, com o grânulo -1 nas que não fecham pacote", () => {
    const grande = aleatorios(70_000, 1);
    const { bytes, quantas } = paginar([grande], 7, 1, false);
    const paginas = paginasOgg(bytes);
    expect(quantas).toBe(2);
    expect(paginas.every(p => p.crcCerto)).toBe(true);
    expect(paginas.map(p => [p.seq, p.granulo, p.tipo & 1])).toEqual([[1, -1, 0], [2, 0, 1]]);
    expect(pacotesOgg(paginas)).toEqual([grande]);
  });

  it("o pacote de tamanho múltiplo de 255 termina num laço 0", () => {
    const { bytes } = paginar([aleatorios(510, 2)], 7, 0, true);
    const [pagina] = paginasOgg(bytes);
    expect(pagina.lacos).toEqual([255, 255, 0]);
    expect(pagina.tipo & 2).toBe(2);
  });

  it("as etiquetas vazias levam o nome do programa do arquivo, ou WRW, e nenhum comentário", () => {
    const original = Uint8Array.from([...Array.from("OpusTags", c => c.charCodeAt(0)), 3, 0, 0, 0, 65, 66, 67, 1, 0, 0, 0, 9, 0, 0, 0, ...aleatorios(9, 1)]);
    expect(Array.from(etiquetasVazias("opus", original))).toEqual([...Array.from("OpusTags", c => c.charCodeAt(0)), 3, 0, 0, 0, 65, 66, 67, 0, 0, 0, 0]);
    expect(String.fromCharCode(...etiquetasVazias("opus").subarray(12, 15))).toBe("WRW");
    const vorbis = etiquetasVazias("vorbis");
    expect(vorbis[0]).toBe(3);
    expect(vorbis[vorbis.length - 1]).toBe(1);
  });
});

describe("PartesEmOggOpus", () => {
  const pacotes = Array.from({ length: 300 }, (_v, i) => { const p = aleatorios(100, i + 1); p[0] = TOC_OPUS_20MS; return p; });
  /** O "arquivo": os pacotes um atrás do outro, com 3 bytes de outro contêiner entre eles. */
  const arquivo = new Uint8Array(pacotes.length * 103);
  pacotes.forEach((p, i) => arquivo.set(p, i * 103 + 3));

  it("as partes fecham antes dos bytes do teto, e cada uma começa no grânulo 0 com os pacotes do arquivo", () => {
    const escritor = new PartesEmOggOpus(opusHead(), { bytesPorParte: 8000 });
    for (let i = 0; i < pacotes.length; i++) expect(escritor.adicionar(i * 103 + 3, pacotes[i])).toBeNull();
    escritor.fechar();
    expect(escritor.partes.length).toBeGreaterThan(3);
    const lidos: Uint8Array[] = [];
    for (const parte of escritor.partes) {
      const bytes = montar(arquivo, parte);
      expect(bytes.length).toBe(parte.bytes);
      expect(bytes.length).toBeLessThanOrEqual(8000);
      const paginas = paginasOgg(bytes);
      expect(paginas.every(p => p.crcCerto)).toBe(true);
      const audio = pacotesOgg(paginas).slice(2);
      expect(paginas[paginas.length - 1].granulo).toBe(audio.length * 960);
      expect(parte.duracaoMs).toBe(audio.length * 20);
      lidos.push(...audio);
    }
    expect(lidos).toEqual(pacotes);
    expect(escritor.duracaoMs).toBe(6000);
  });

  it("recusa acima de 12 h (LONGO_DEMAIS) e o pacote que não cabe numa página (DANIFICADO)", () => {
    const escritor = new PartesEmOggOpus(opusHead(), { segundosNoTotal: 1 });
    for (let i = 0; i < 50; i++) expect(escritor.adicionar(0, pacotes[i])).toBeNull();
    expect(escritor.adicionar(0, pacotes[50])).toBe("LONGO_DEMAIS");
    expect(new PartesEmOggOpus(opusHead(), {}).adicionar(0, new Uint8Array(70_000))).toBe("DANIFICADO");
  });
});
