import { describe, expect, it, vi } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { cortarMp3, ehCorteCancelado, PARTE_DO_MP3_BYTES_MAX, PARTE_DO_MP3_SEGUNDOS_MAX, type CorteDoMp3 } from "./corte-do-mp3";
import {
  apev2, id3v1, id3v2, juntar, leitorDe, leitorDeQuadrosRepetidos, MPEG1_128K, MPEG1_128K_CRC, MPEG1_128K_ENCHIMENTO, MPEG1_128K_MONO,
  MPEG25_8K, MPEG2_64K, quadro, quadroDeEtiqueta, quadros, quadrosVariaveis, sequencia, type FormatoDoQuadro,
} from "@/test/mp3-sintetico";

/**
 * O corte do MP3 em partes (H9a), sobre MP3 sintéticos gerados aqui
 * (test/mp3-sintetico.ts): quadros MPEG de verdade, etiquetas e lixo. A
 * medida das partes pelo servidor está em server/corte-do-mp3-no-servidor.test.ts.
 */

const cortar = (bytes: Uint8Array, opcoes?: Parameters<typeof cortarMp3>[2]) => cortarMp3(leitorDe(bytes), bytes.length, opcoes);

function partesDe(corte: CorteDoMp3) {
  if (!corte.ok) throw new Error(`O corte recusou: ${corte.codigo}`);
  return corte.partes;
}

const ms = (formato: FormatoDoQuadro, n: number) => Math.round(n * formato.segundos * 1000);

describe("cortarMp3: as etiquetas ficam de fora", () => {
  it("tira o ID3v2 do começo (com uma capa cheia de falsos quadros), o quadro Xing e o ID3v1 do fim", async () => {
    const id3 = id3v2(5000);
    const xing = quadroDeEtiqueta(MPEG1_128K, "Xing");
    const audio = quadros(MPEG1_128K, 300);
    const corte = await cortar(juntar(id3, xing, audio, id3v1()));
    const inicio = id3.length + xing.length;
    expect(partesDe(corte)).toEqual([{ faixas: [{ inicio, fim: inicio + audio.length }], bytes: audio.length, duracaoMs: ms(MPEG1_128K, 300) }]);
    expect(corte).toMatchObject({ ok: true, duracaoMs: ms(MPEG1_128K, 300) });
  });

  it.each([
    ["Info (LAME)", MPEG1_128K, "Info"],
    ["VBRI (Fraunhofer)", MPEG1_128K, "VBRI"],
    ["Xing em mono (informação lateral de 17 bytes)", MPEG1_128K_MONO, "Xing"],
    ["Xing depois do CRC", MPEG1_128K_CRC, "Xing"],
    ["Xing no MPEG-2", MPEG2_64K, "Xing"],
  ] as const)("o quadro de etiqueta %s também sai", async (_caso, formato, etiqueta) => {
    const marca = quadroDeEtiqueta(formato, etiqueta);
    const audio = quadros(formato, 40);
    const [parte] = partesDe(await cortar(juntar(marca, audio)));
    expect(parte.faixas).toEqual([{ inicio: marca.length, fim: marca.length + audio.length }]);
    expect(parte.duracaoMs).toBe(ms(formato, 40));
  });

  it.each([
    ["só o APEv2", () => [apev2()]],
    ["o APEv2 e depois o ID3v1", () => [apev2(), id3v1()]],
    ["só o ID3v1", () => [id3v1()]],
  ])("no fim, %s sai", async (_caso, etiquetas) => {
    const audio = quadros(MPEG1_128K, 25);
    const [parte] = partesDe(await cortar(juntar(audio, ...etiquetas())));
    expect(parte.faixas).toEqual([{ inicio: 0, fim: audio.length }]);
  });

  it("dois MP3 emendados: o ID3v2 e o Xing do segundo, no meio, saem, e a parte ganha outra faixa", async () => {
    const primeiro = quadros(MPEG1_128K, 50, 1);
    const id3 = id3v2(2000);
    const xing = quadroDeEtiqueta(MPEG1_128K, "Xing");
    const segundo = quadros(MPEG1_128K, 60, 2);
    const [parte] = partesDe(await cortar(juntar(primeiro, id3, xing, segundo)));
    const depois = primeiro.length + id3.length + xing.length;
    expect(parte.faixas).toEqual([{ inicio: 0, fim: primeiro.length }, { inicio: depois, fim: depois + segundo.length }]);
    expect(parte.bytes).toBe(primeiro.length + segundo.length);
    expect(parte.duracaoMs).toBe(ms(MPEG1_128K, 110));
  });
});

describe("cortarMp3: lixo e arquivos que não são MP3", () => {
  it("lixo no meio (com 0xFF e cabeçalhos soltos) fica de fora, e os quadros dos dois lados seguem na mesma parte", async () => {
    const antes = quadros(MPEG1_128K, 100, 3);
    // A "capa" do ID3 sem o cabeçalho dela: só lixo, com um cabeçalho de quadro
    // a cada 97 bytes. Começa por bytes que não são quadro, como a etiqueta ou
    // o pedaço corrompido que aparece no meio de um arquivo.
    const lixo = juntar(new Uint8Array([0x00, 0x11]), id3v2(3000).subarray(10));
    const depois = quadros(MPEG1_128K, 100, 4);
    const [parte] = partesDe(await cortar(juntar(antes, lixo, depois)));
    const retomada = antes.length + lixo.length;
    expect(parte.faixas).toEqual([{ inicio: 0, fim: antes.length }, { inicio: retomada, fim: retomada + depois.length }]);
    expect(parte.duracaoMs).toBe(ms(MPEG1_128K, 200));
  });

  it("zeros antes do primeiro quadro (sem ID3) não atrapalham", async () => {
    const audio = quadros(MPEG2_64K, 30);
    const [parte] = partesDe(await cortar(juntar(new Uint8Array(700), audio)));
    expect(parte.faixas).toEqual([{ inicio: 700, fim: 700 + audio.length }]);
  });

  it("o último quadro, cortado no meio, fica de fora", async () => {
    const audio = quadros(MPEG1_128K, 10);
    const [parte] = partesDe(await cortar(juntar(audio, quadro(MPEG1_128K).subarray(0, 200))));
    expect(parte.faixas).toEqual([{ inicio: 0, fim: audio.length }]);
    expect(parte.duracaoMs).toBe(ms(MPEG1_128K, 10));
  });

  it.each([
    ["vazio", () => new Uint8Array(0)],
    ["texto", () => new TextEncoder().encode("isto não é áudio ".repeat(5000))],
    ["um MP4 (ftyp)", () => juntar(new Uint8Array([0, 0, 0, 0x20]), new TextEncoder().encode("ftypM4A "), id3v2(60_000).subarray(10))],
    ["só etiquetas, sem som", () => juntar(id3v2(1000), quadroDeEtiqueta(MPEG1_128K, "Xing"), id3v1())],
    ["3 MB de bytes ao acaso", () => id3v2(3 * 1024 * 1024).subarray(10)],
  ])("%s: NAO_E_MP3", async (_caso, arquivo) => {
    expect(await cortar(arquivo())).toEqual({ ok: false, codigo: "NAO_E_MP3" });
  });

  it("mais lixo que áudio não é MP3, mesmo com alguns quadros", async () => {
    expect(await cortar(juntar(quadros(MPEG1_128K, 5), id3v2(10_000).subarray(10)))).toEqual({ ok: false, codigo: "NAO_E_MP3" });
  });
});

describe("cortarMp3: o tamanho das partes", () => {
  it("os tetos de cada parte cabem nos da rota das partes", () => {
    expect(PARTE_DO_MP3_SEGUNDOS_MAX).toBe(600);
    expect(PARTE_DO_MP3_BYTES_MAX).toBe(14 * 1024 * 1024);
  });

  it("até 600 s por parte, contíguas e sem buraco: 20.000 quadros de 72 ms viram 8.333 + 8.333 + 3.334", async () => {
    const audio = quadros(MPEG25_8K, 20_000);
    const partes = partesDe(await cortar(audio));
    expect(partes.map(p => p.bytes / MPEG25_8K.tamanho)).toEqual([8333, 8333, 3334]);
    expect(partes.map(p => p.duracaoMs)).toEqual([599_976, 599_976, 240_048]);
    expect(partes.flatMap(p => p.faixas)).toEqual([
      { inicio: 0, fim: 8333 * 72 }, { inicio: 8333 * 72, fim: 16666 * 72 }, { inicio: 16666 * 72, fim: audio.length },
    ]);
    for (const p of partes) expect(p.duracaoMs).toBeLessThanOrEqual(600_000);
  });

  it("até 14 MB por parte: a 320 kbps, a parte fecha nos bytes, bem antes dos 600 s", async () => {
    // MPEG-1 Layer III, 320 kbps, 44,1 kHz: 1.044 bytes por quadro; 600 s seriam 24 MB.
    const formato: FormatoDoQuadro = { cabecalho: [0xff, 0xfb, 0xe0, 0x00], tamanho: 1044, segundos: 1152 / 44100 };
    const { ler, tamanho } = leitorDeQuadrosRepetidos(formato, 40_000);
    const partes = partesDe(await cortarMp3(ler, tamanho));
    const porParte = Math.floor(PARTE_DO_MP3_BYTES_MAX / 1044);
    expect(partes.map(p => p.bytes / 1044)).toEqual([porParte, porParte, 40_000 - 2 * porParte]);
    for (const p of partes) {
      expect(p.bytes).toBeLessThanOrEqual(PARTE_DO_MP3_BYTES_MAX);
      expect(p.duracaoMs).toBeLessThan(600_000);
    }
  });

  it("os tetos da parte podem vir nas opções: cada parte fecha antes de passar deles, num quadro inteiro", async () => {
    const audio = quadros(MPEG1_128K, 100);
    const partes = partesDe(await cortar(audio, { bytesPorParte: 10_000 }));
    expect(partes.every(p => p.bytes <= 10_000 && p.bytes % 417 === 0)).toBe(true);
    expect(partes.reduce((soma, p) => soma + p.bytes, 0)).toBe(audio.length);
    const porTempo = partesDe(await cortar(audio, { segundosPorParte: 1 }));
    // 1 s a 44,1 kHz são 38,28 quadros de 1152 amostras: 38 por parte.
    expect(porTempo.slice(0, -1).every(p => p.bytes === 38 * 417)).toBe(true);
  });
});

describe("cortarMp3: o enchimento e o bitrate variável do MP3 de verdade", () => {
  // O cabeçalho de 418 bytes é o de 417 com o bit de enchimento ligado (0x90 → 0x92).
  it("o quadro com enchimento tem um byte a mais, e o corte anda por ele inteiro", async () => {
    expect(MPEG1_128K_ENCHIMENTO.tamanho).toBe(MPEG1_128K.tamanho + 1);
    const { bytes } = sequencia(Array.from({ length: 60 }, () => MPEG1_128K_ENCHIMENTO));
    const [parte] = partesDe(await cortar(bytes));
    expect(parte.faixas).toEqual([{ inicio: 0, fim: 60 * 418 }]);
    expect(parte.duracaoMs).toBe(ms(MPEG1_128K, 60));
  });

  it("quadros de 417 e 418 bytes alternados e de 128, 160 e 192 kbps no mesmo fluxo: cada parte cai nas divisas dos quadros, sem lixo, com a duração dos quadros dela", async () => {
    const formatos = quadrosVariaveis(500);
    expect(new Set(formatos.map(f => f.tamanho))).toEqual(new Set([417, 418, 522, 627]));
    const { bytes, divisas } = sequencia(formatos);
    const corte = await cortar(bytes, { segundosPorParte: 1 });
    // 1 s a 44,1 kHz são 38 quadros de 1152 amostras, qualquer que seja o bitrate.
    const esperadas = [];
    for (let i = 0; i < formatos.length; i += 38) {
      const fim = Math.min(i + 38, formatos.length);
      esperadas.push({ faixas: [{ inicio: divisas[i], fim: divisas[fim] }], bytes: divisas[fim] - divisas[i], duracaoMs: ms(MPEG1_128K, fim - i) });
    }
    expect(partesDe(corte)).toEqual(esperadas);
    expect(corte).toMatchObject({ ok: true, duracaoMs: ms(MPEG1_128K, 500) });
  });

  it("o teto de bytes com quadros de tamanhos diferentes: cada parte fecha no último quadro inteiro que cabe", async () => {
    const formatos = quadrosVariaveis(200);
    const { bytes, divisas } = sequencia(formatos);
    const partes = partesDe(await cortar(bytes, { bytesPorParte: 5_000 }));
    expect(partes.flatMap(p => p.faixas.map(f => f.inicio))).toEqual(partes.map((_p, i) => partes.slice(0, i).reduce((soma, q) => soma + q.bytes, 0)));
    for (const [i, parte] of partes.entries()) {
      const [faixa] = parte.faixas;
      expect(divisas).toContain(faixa.inicio);
      expect(divisas).toContain(faixa.fim);
      expect(parte.bytes).toBeLessThanOrEqual(5_000);
      // O quadro seguinte não cabia: senão a parte o teria levado.
      if (i < partes.length - 1) expect(parte.bytes + formatos[divisas.indexOf(faixa.fim)].tamanho).toBeGreaterThan(5_000);
    }
    expect(partes.at(-1)!.faixas[0].fim).toBe(bytes.length);
  });
});

describe("cortarMp3: o teto de 12 h", () => {
  it("o teto padrão é o da gravação em partes", () => {
    expect(GRAVACAO_EM_PARTES_SEGUNDOS_MAX).toBe(12 * 3600);
  });

  it("12 h exatas passam (600.000 quadros de 72 ms), em 73 partes", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, 600_000);
    const corte = await cortarMp3(ler, tamanho);
    expect(corte).toMatchObject({ ok: true, duracaoMs: 12 * 3600 * 1000 });
    expect(partesDe(corte)).toHaveLength(73);
  }, 30_000);

  it("um quadro além das 12 h é recusado (LONGO_DEMAIS)", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, 600_001);
    expect(await cortarMp3(ler, tamanho)).toEqual({ ok: false, codigo: "LONGO_DEMAIS" });
  }, 30_000);

  it("um arquivo de 20 h é recusado sem ler o resto depois das 12 h", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, 1_000_000);
    const lidas: number[] = [];
    // Só os blocos: as duas leituras curtas do fim são as das etiquetas (ID3v1, APEv2).
    const corte = await cortarMp3(async (inicio, fim) => { if (fim - inicio > 128) lidas.push(fim); return ler(inicio, fim); }, tamanho);
    expect(corte).toEqual({ ok: false, codigo: "LONGO_DEMAIS" });
    // 12 h de quadros são 43,2 MB; a leitura para no bloco de 4 MB que passou delas.
    expect(Math.max(...lidas)).toBeLessThan(600_000 * 72 + 4 * 1024 * 1024 + 64 * 1024);
    expect(Math.max(...lidas)).toBeLessThan(tamanho);
  }, 30_000);
});

describe("cortarMp3: andamento e cancelamento", () => {
  it("avisa quanto já leu, em ordem, até o fim do arquivo", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG1_128K, 30_000);
    const aoLer = vi.fn();
    await cortarMp3(ler, tamanho, { aoLer });
    const lidos = aoLer.mock.calls.map(c => c[0] as number);
    expect(lidos.length).toBeGreaterThan(2);
    expect(lidos).toEqual([...lidos].sort((a, b) => a - b));
    expect(lidos.at(-1)).toBe(tamanho);
    expect(aoLer.mock.calls.every(c => c[1] === tamanho)).toBe(true);
  });

  it("cancelar no meio rejeita com AbortError e para de ler", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG1_128K, 30_000);
    const controle = new AbortController();
    const leitor = vi.fn(ler);
    const corte = cortarMp3(leitor, tamanho, { sinal: controle.signal, aoLer: () => controle.abort() });
    const erro = await corte.catch(e => e);
    expect(ehCorteCancelado(erro)).toBe(true);
    // As duas leituras das etiquetas do fim e o primeiro bloco; nada depois do cancelamento.
    expect(leitor.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
