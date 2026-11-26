import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { cortarFlac, escreverNumeroFlac } from "./corte-do-flac";
import { aleatorios, flac, juntar, leitorDe, numeroUtf8Flac, quadroFlac, type OpcoesDoFlac } from "@/test/audio-sintetico";
import { mesmosPacotes, montar, partesDe, quadrosFlac } from "@/test/conferir-partes";

/**
 * O corte do FLAC (H9b): cada parte é "fLaC", um STREAMINFO novo (o total de
 * amostras da parte, o MD5 zerado) e os quadros do arquivo renumerados desde
 * 0, com o CRC-8 do cabeçalho e o CRC-16 do quadro refeitos (conferidos aqui
 * bit a bit, em test/conferir-partes.ts). Os arquivos são sintéticos
 * (test/audio-sintetico.ts).
 */

async function cortar(o: OpcoesDoFlac, opcoes: Parameters<typeof cortarFlac>[2] = {}) {
  const arquivo = flac(o);
  return { arquivo, corte: await cortarFlac(leitorDe(arquivo.bytes), arquivo.bytes.length, opcoes) };
}

/** O miolo de um quadro (sem o cabeçalho e sem o CRC-16), para conferir que nada dele mudou. */
function mioloDe(bytes: Uint8Array, quadro: { inicio: number; fim: number }) {
  const b = bytes[quadro.inicio + 4];
  const extras = b < 0x80 ? 0 : b >= 0xfe ? 6 : b >= 0xfc ? 5 : b >= 0xf8 ? 4 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
  const codigoDoBloco = bytes[quadro.inicio + 2] >> 4;
  const cabecalho = 5 + extras + (codigoDoBloco === 6 ? 1 : codigoDoBloco === 7 ? 2 : 0) + 1;
  return bytes.subarray(quadro.inicio + cabecalho, quadro.fim - 2);
}

describe("cortarFlac", () => {
  it.each<[string, Partial<OpcoesDoFlac>]>([
    ["o bloco fixo de 4.096 amostras a 44,1 kHz, com os metadados (capa, etiquetas, tabela) de fora", {}],
    ["o bloco variável (o número é o da amostra)", { variavel: true, bloco: 1152 }],
    ["com o ID3 antes do fLaC e o ID3v1 no fim", { id3: true }],
    ["com o último quadro mais curto", { ultimoCurto: 1000 }],
  ])("%s: cada parte é um FLAC sozinho, renumerado desde 0, com os CRCs certos", async (_caso, o) => {
    const { arquivo, corte } = await cortar({ quadros: 300, ...o }, { segundosPorParte: 5 });
    expect(corte).toMatchObject({ ok: true, formato: "flac", mimeType: "audio/flac" });
    const partes = partesDe(corte);
    const original = quadrosFlac(arquivo.bytes.subarray(o.id3 ? 30 : 0, arquivo.bytes.length - (o.id3 ? 128 : 0)));
    const miolos: Uint8Array[] = [];
    let amostrasNoTotal = 0;
    for (const parte of partes) {
      const b = montar(arquivo.bytes, parte);
      expect(b.length).toBe(parte.bytes);
      const lido = quadrosFlac(b);
      // Só o STREAMINFO, com o total de amostras da parte e o MD5 zerado.
      expect(lido.tipos).toEqual([0]);
      expect(Array.from(lido.streaminfo.subarray(18, 34))).toEqual(new Array(16).fill(0));
      let amostra = 0;
      lido.quadros.forEach((q, i) => {
        expect(q.crc8Certo).toBe(true);
        // Desde 0: o número do quadro, ou o da amostra no bloco variável.
        expect(q.numero).toBe(o.variavel ? amostra : i);
        amostra += o.ultimoCurto && miolos.length === 299 ? 1000 : (o.bloco ?? 4096);
        miolos.push(mioloDe(b, q));
      });
      expect(lido.total).toBe(amostra);
      expect(parte.duracaoMs).toBe(Math.round((amostra / 44100) * 1000));
      amostrasNoTotal += amostra;
    }
    // Nenhum miolo mudou, e nenhum quadro sumiu.
    expect(mesmosPacotes(miolos, original.quadros.map(q => mioloDe(arquivo.bytes.subarray(o.id3 ? 30 : 0), q)))).toBe("iguais");
    expect(amostrasNoTotal).toBe(arquivo.amostras);
    if (corte.ok) expect(corte.duracaoMs).toBe(Math.round((arquivo.amostras / 44100) * 1000));
  });

  it("o número de 1 a 7 bytes do cabeçalho: o do corte é o UTF-8 estendido do FLAC", () => {
    for (const n of [0, 127, 128, 2047, 2048, 65_535, 65_536, 2 ** 21 - 1, 2 ** 21, 2 ** 31 - 1, 2 ** 31, 2 ** 36 - 1]) {
      expect(escreverNumeroFlac(n)).toEqual(numeroUtf8Flac(n));
    }
  });

  it("a parte fecha antes dos bytes do teto, contando o cabeçalho novo de cada quadro", async () => {
    const { arquivo, corte } = await cortar({ quadros: 100, tamanhoDoQuadro: 3000 }, { bytesPorParte: 40_000 });
    const partes = partesDe(corte);
    for (const parte of partes) expect(montar(arquivo.bytes, parte).length).toBeLessThanOrEqual(40_000);
    expect(partes.length).toBeGreaterThan(5);
  });

  it("o falso começo de quadro no miolo (o CRC-8 errado, ou o número fora da sequência) não corta o quadro", async () => {
    const formato = { taxa: 44100, canais: 2, bits: 16 };
    const cabecalhoDoQuadro1 = quadroFlac(1, 4096, { ...formato, tamanho: 10, semente: 1 }).subarray(0, 7);
    const miolo = juntar(aleatorios(500, 2), cabecalhoDoQuadro1, [0x02], aleatorios(300, 3), [0xff, 0xf8, 0xc9, 0x18, 0x05, 0x00, 0x02], aleatorios(500, 4));
    const quadros = Array.from({ length: 8 }, (_v, i) => quadroFlac(i, 4096, { ...formato, tamanho: 1200, semente: i + 10, ...(i === 4 ? { miolo } : {}) }));
    const arquivo = juntar(flac({ quadros: 0 }).bytes, ...quadros);
    const corte = await cortarFlac(leitorDe(arquivo), arquivo.length);
    const lidos = quadrosFlac(montar(arquivo, partesDe(corte)[0])).quadros;
    expect(lidos.map(q => q.numero)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(lidos[4].fim - lidos[4].inicio).toBe(quadros[4].length);
  });

  it("acima de 12 h: LONGO_DEMAIS; mais partes que o teto: MUITAS_PARTES", async () => {
    // Blocos de 65.535 amostras a 8 kHz e quadros de ~30 bytes: 12 h e um bloco em ~160 kB.
    const quadros = Math.floor((GRAVACAO_EM_PARTES_SEGUNDOS_MAX * 8000) / 65_535) + 1;
    const longo = juntar(
      flac({ quadros: 0, taxa: 8000, bloco: 65_535 }).bytes,
      ...Array.from({ length: quadros }, (_v, i) => quadroFlac(i, 65_535, { taxa: 8000, canais: 2, bits: 16, tamanho: 20, semente: i + 1 })),
    );
    expect(await cortarFlac(leitorDe(longo), longo.length)).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "flac" });
    const { corte } = await cortar({ quadros: 300 }, { segundosPorParte: 1, partesNoMaximo: 5 });
    expect(corte).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "flac" });
  }, 60_000);

  it("o que não é FLAC, ou o FLAC sem quadros: DANIFICADO", async () => {
    const lixo = aleatorios(10_000, 3);
    expect(await cortarFlac(leitorDe(lixo), lixo.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "flac" });
    const vazio = flac({ quadros: 0 }).bytes;
    expect(await cortarFlac(leitorDe(vazio), vazio.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "flac" });
  });
});
