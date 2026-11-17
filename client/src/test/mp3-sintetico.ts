/**
 * MP3 sintético para os testes do corte em partes (H9a): quadros MPEG com
 * cabeçalho válido e o tamanho que o cabeçalho diz, o miolo em bytes
 * pseudoaleatórios (com 0xFF, como no áudio de verdade), e as etiquetas que o
 * corte tira (ID3v2 com uma "capa" cheia de falsos começos de quadro, o quadro
 * Xing/Info/VBRI, o ID3v1 e o APEv2). Serve aos testes do client e ao do
 * servidor que mede as partes com server/duracao-do-audio.ts.
 */

export type FormatoDoQuadro = { cabecalho: readonly [number, number, number, number]; tamanho: number; segundos: number };

/** MPEG-1 Layer III, 128 kbps, 44,1 kHz, estéreo, sem CRC: 417 bytes e 1152 amostras. */
export const MPEG1_128K: FormatoDoQuadro = { cabecalho: [0xff, 0xfb, 0x90, 0x00], tamanho: 417, segundos: 1152 / 44100 };
/** O mesmo, mono: a informação lateral tem 17 bytes, e não 32. */
export const MPEG1_128K_MONO: FormatoDoQuadro = { cabecalho: [0xff, 0xfb, 0x90, 0xc0], tamanho: 417, segundos: 1152 / 44100 };
/** O mesmo, com CRC (bit de proteção zerado): 2 bytes de CRC depois do cabeçalho. */
export const MPEG1_128K_CRC: FormatoDoQuadro = { cabecalho: [0xff, 0xfa, 0x90, 0x00], tamanho: 417, segundos: 1152 / 44100 };
/** MPEG-2 Layer III, 64 kbps, 22,05 kHz, estéreo: 208 bytes e 576 amostras. */
export const MPEG2_64K: FormatoDoQuadro = { cabecalho: [0xff, 0xf3, 0x80, 0x00], tamanho: 208, segundos: 576 / 22050 };
/** MPEG-2.5 Layer III, 8 kbps, 8 kHz, mono: 72 bytes e 72 ms, o menor quadro (12 h cabem em 43 MB). */
export const MPEG25_8K: FormatoDoQuadro = { cabecalho: [0xff, 0xe3, 0x18, 0xc0], tamanho: 72, segundos: 576 / 8000 };

/** Bytes pseudoaleatórios e repetíveis (xorshift). */
function aleatorios(n: number, semente: number): Uint8Array {
  const saida = new Uint8Array(n);
  let x = semente || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    saida[i] = x & 0xff;
  }
  return saida;
}

/** Um quadro de áudio: o cabeçalho e o miolo pseudoaleatório. */
export function quadro(formato: FormatoDoQuadro, semente = 7): Uint8Array {
  const q = aleatorios(formato.tamanho, semente);
  q.set(formato.cabecalho, 0);
  return q;
}

/** `n` quadros seguidos, cada um com um miolo diferente. */
export function quadros(formato: FormatoDoQuadro, n: number, semente = 1): Uint8Array {
  const saida = new Uint8Array(formato.tamanho * n);
  for (let i = 0; i < n; i++) saida.set(quadro(formato, semente * 100_003 + i), i * formato.tamanho);
  return saida;
}

/** O quadro sem som que leva a etiqueta Xing, Info ou VBRI, no lugar em que cada uma fica. */
export function quadroDeEtiqueta(formato: FormatoDoQuadro, etiqueta: "Xing" | "Info" | "VBRI"): Uint8Array {
  const q = new Uint8Array(formato.tamanho);
  q.set(formato.cabecalho, 0);
  const mpeg1 = ((formato.cabecalho[1] >> 3) & 3) === 3;
  const mono = formato.cabecalho[3] >> 6 === 3;
  const crc = (formato.cabecalho[1] & 1) === 0 ? 2 : 0;
  const lateral = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const onde = etiqueta === "VBRI" ? 36 : 4 + crc + lateral;
  q.set(Array.from(etiqueta, c => c.charCodeAt(0)), onde);
  // Os campos da etiqueta: "frames presentes" e um número de quadros qualquer.
  q.set([0, 0, 0, 0x0f, 0x00, 0x01, 0x86, 0xa0], onde + 4);
  return q;
}

/**
 * Um ID3v2.3 com `corpo` bytes: uma "capa" cheia de 0xFF e de cabeçalhos de
 * quadro soltos, que o corte só não confunde com áudio porque pula a etiqueta
 * inteira pelo tamanho dela.
 */
export function id3v2(corpo: number): Uint8Array {
  const tag = new Uint8Array(10 + corpo);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0, (corpo >> 21) & 0x7f, (corpo >> 14) & 0x7f, (corpo >> 7) & 0x7f, corpo & 0x7f], 0);
  const capa = aleatorios(corpo, 99);
  for (let i = 0; i + 4 <= corpo; i += 97) capa.set(MPEG1_128K.cabecalho, i);
  tag.set(capa, 10);
  return tag;
}

/** O ID3v1 do fim: "TAG" e 125 bytes. */
export function id3v1(): Uint8Array {
  const tag = new Uint8Array(128);
  tag.set(Array.from("TAGTitulo", c => c.charCodeAt(0)), 0);
  return tag;
}

/** Um APEv2 com cabeçalho e rodapé (32 bytes cada) e `itens` bytes no meio. */
export function apev2(itens = 40): Uint8Array {
  const tag = new Uint8Array(32 + itens + 32);
  const parte = (inicio: number, ehCabecalho: boolean) => {
    const v = new DataView(tag.buffer, inicio, 32);
    Array.from("APETAGEX", (c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(8, 2000, true);
    v.setUint32(12, itens + 32, true);
    v.setUint32(16, 1, true);
    v.setUint32(20, 0x80000000 | (ehCabecalho ? 0x20000000 : 0), true);
  };
  parte(0, true);
  tag.set(aleatorios(itens, 5), 32);
  parte(32 + itens, false);
  return tag;
}

/** Junta os pedaços num arquivo só. */
export function juntar(...pedacos: Uint8Array[]): Uint8Array {
  const saida = new Uint8Array(pedacos.reduce((soma, p) => soma + p.length, 0));
  let pos = 0;
  for (const p of pedacos) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

/** O leitor de um arquivo na memória, como o lerBlob lê o File. */
export function leitorDe(bytes: Uint8Array) {
  return async (inicio: number, fim: number) => bytes.slice(inicio, fim);
}

/**
 * Um arquivo de `n` quadros iguais que só existe enquanto é lido: o de 12 h
 * (43 MB) não precisa caber de uma vez na memória do teste.
 */
export function leitorDeQuadrosRepetidos(formato: FormatoDoQuadro, n: number) {
  const um = quadro(formato);
  const tamanho = formato.tamanho * n;
  const ler = async (inicio: number, fim: number) => {
    const saida = new Uint8Array(fim - inicio);
    let i = 0;
    while (i < saida.length) {
      const desvio = (inicio + i) % formato.tamanho;
      const pedaco = um.subarray(desvio, Math.min(formato.tamanho, desvio + saida.length - i));
      saida.set(pedaco, i);
      i += pedaco.length;
    }
    return saida;
  };
  return { ler, tamanho };
}
