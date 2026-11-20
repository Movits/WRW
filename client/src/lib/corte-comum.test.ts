import { describe, expect, it, vi } from "vitest";
import { crc16Flac, crc32Ogg, crc8Flac, LeitorEmJanela, MontagemDaParte, montarParte, recusa } from "./corte-comum";
import { aleatorios, crcBitABit, leitorDe } from "@/test/audio-sintetico";
import { montar } from "@/test/conferir-partes";

/**
 * O que os cortes da importação em partes têm em comum (H9a, H9b e H9c): os
 * CRCs (conferidos com a conta bit a bit, e com os valores de referência), a
 * montagem de cada parte e a leitura em janela.
 */

describe("os CRCs dos formatos", () => {
  const amostra = aleatorios(5000, 42);

  it("o CRC-32 do Ogg, o CRC-16 e o CRC-8 do FLAC conferem com a conta bit a bit", () => {
    expect(crc32Ogg(amostra)).toBe(crcBitABit(amostra, 0x04c11db7, 32));
    expect(crc16Flac(amostra)).toBe(crcBitABit(amostra, 0x8005, 16));
    expect(crc8Flac(amostra)).toBe(crcBitABit(amostra, 0x07, 8));
  });

  it("os valores de referência de \"123456789\" (CRC-32/MPEG-2 sem o começo invertido, CRC-16/UMTS e CRC-8/SMBUS)", () => {
    const texto = Array.from("123456789", c => c.charCodeAt(0));
    expect(crc16Flac(texto)).toBe(0xfee8);
    expect(crc8Flac(texto)).toBe(0xf4);
    expect(crc32Ogg(texto)).toBe(0x89a1897f);
  });

  it("a conta em pedaços (o começo de um e o resto) dá o mesmo que a conta inteira", () => {
    expect(crc32Ogg(amostra, 1000, 5000, crc32Ogg(amostra, 0, 1000))).toBe(crc32Ogg(amostra));
    expect(crc16Flac(amostra, 17, 5000, crc16Flac(amostra, 0, 17))).toBe(crc16Flac(amostra));
  });
});

describe("MontagemDaParte e montarParte", () => {
  it("junta os vizinhos da mesma origem e monta a parte com os bytes novos e os trechos do arquivo", async () => {
    const arquivo = Uint8Array.from({ length: 100 }, (_v, i) => i);
    const m = new MontagemDaParte();
    const reservado = m.reservar(2);
    m.novo([200, 201]);
    m.doArquivo(10, 20);
    m.doArquivo(20, 25);
    m.novo([202]);
    m.doArquivo(50, 50);
    m.doArquivo(60, 62);
    m.escrever(reservado, [198, 199]);
    const parte = m.fechar(1234);
    // Os dois trechos vizinhos do arquivo viraram um só, e os bytes novos vizinhos também.
    expect(Array.from(parte.ordem)).toEqual([0, 0, 4, 1, 10, 25, 0, 4, 5, 1, 60, 62]);
    expect(parte.bytes).toBe(4 + 15 + 1 + 2);
    expect(parte.duracaoMs).toBe(1234);
    const esperado = [198, 199, 200, 201, ...Array.from({ length: 15 }, (_v, i) => 10 + i), 202, 60, 61];
    expect(Array.from(montar(arquivo, parte))).toEqual(esperado);
    const blob = montarParte(new Blob([arquivo]), parte, "audio/ogg");
    expect(blob.type).toBe("audio/ogg");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(esperado);
  });

  it("a parte grande cresce o espaço dos bytes novos sem perder o que já estava", () => {
    const m = new MontagemDaParte();
    const grande = aleatorios(10_000, 1);
    m.novo([1, 2, 3]);
    m.novo(grande);
    const parte = m.fechar(0);
    expect(parte.novos.length).toBe(10_003);
    expect(Array.from(parte.novos.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(parte.novos.subarray(3)).toEqual(grande);
  });
});

describe("LeitorEmJanela", () => {
  it("lê em blocos, só quando falta, avisa o andamento e não passa do fim do arquivo", async () => {
    const bytes = aleatorios(10_000, 3);
    const ler = vi.fn(leitorDe(bytes));
    const aoLer = vi.fn();
    const janela = new LeitorEmJanela(ler, bytes.length, { aoLer }, 4096);
    expect(await janela.garantir(0, 10)).toBe(true);
    expect(ler).toHaveBeenCalledWith(0, 4096);
    expect(janela.b(4095)).toBe(bytes[4095]);
    expect(janela.b(4096)).toBe(-1);
    await janela.garantir(100, 200);
    expect(ler).toHaveBeenCalledTimes(1);
    expect(await janela.garantir(9000, 10_100)).toBe(false);
    expect(ler).toHaveBeenLastCalledWith(9000, 10_000);
    expect(aoLer).toHaveBeenLastCalledWith(10_000, 10_000);
    expect(janela.u32le(9000)).toBe((bytes[9000] | (bytes[9001] << 8) | (bytes[9002] << 16) | (bytes[9003] << 24)) >>> 0);
    expect(() => janela.trecho(100, 200)).toThrow();
  });

  it("a leitura que volta menor que o pedido é erro (o arquivo mudou ou sumiu)", async () => {
    const janela = new LeitorEmJanela(async () => new Uint8Array(3), 100);
    await expect(janela.garantir(0, 10)).rejects.toThrow();
  });

  it("o sinal cancelado interrompe a leitura com AbortError", async () => {
    const controle = new AbortController();
    controle.abort();
    const janela = new LeitorEmJanela(leitorDe(new Uint8Array(10)), 10, { sinal: controle.signal });
    await expect(janela.garantir(0, 5)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("recusa", () => {
  it("leva o formato e o detalhe só quando há", () => {
    expect(recusa("FORMATO_DESCONHECIDO")).toEqual({ ok: false, codigo: "FORMATO_DESCONHECIDO" });
    expect(recusa("SEM_SUPORTE", "mp4", "ALAC")).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" });
  });
});
