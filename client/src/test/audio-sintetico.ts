/**
 * Arquivos de áudio e vídeo sintéticos para os testes da importação em partes
 * (H9b e H9c): WAV, AAC em ADTS, FLAC, Ogg (Opus e Vorbis), WebM/MKV e
 * MP4/M4A/MOV, com a estrutura de verdade de cada contêiner (cabeçalhos,
 * tabelas, CRCs) e o miolo dos quadros em bytes pseudoaleatórios: o corte não
 * decodifica o som, e nenhuma gravação de verdade entra nos testes. Os CRCs
 * daqui são contados bit a bit, de propósito diferente das tabelas do corte
 * (lib/corte-comum.ts), para um conferir o outro. Serve aos testes do client e
 * aos do servidor que medem as partes (server/duracao-do-audio.ts).
 */

/** Bytes pseudoaleatórios e repetíveis (xorshift). */
export function aleatorios(n: number, semente: number): Uint8Array {
  const saida = new Uint8Array(n);
  let x = (semente * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    saida[i] = x & 0xff;
  }
  return saida;
}

/** Junta uma lista grande de pedaços (sem espalhá-los como argumentos de uma chamada). */
export function juntarMuitos(partes: ArrayLike<number>[]): Uint8Array {
  let total = 0;
  for (const p of partes) total += p.length;
  const saida = new Uint8Array(total);
  let p = 0;
  for (const parte of partes) { saida.set(parte, p); p += parte.length; }
  return saida;
}

export function juntar(...partes: ArrayLike<number>[]): Uint8Array {
  return juntarMuitos(partes);
}

export const ascii = (texto: string) => Array.from(texto, c => c.charCodeAt(0));
export const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
export const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
export const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
export const u24be = (n: number) => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const u64be = (n: number) => [...u32be(Math.floor(n / 4294967296)), ...u32be(n >>> 0)];
/** Muitos números de 32 bits seguidos (a tabela de tamanhos de horas de áudio), sem espalhar centenas de milhares de argumentos. */
export function listaU32be(numeros: ArrayLike<number>): Uint8Array {
  const saida = new Uint8Array(numeros.length * 4);
  const v = new DataView(saida.buffer);
  for (let i = 0; i < numeros.length; i++) v.setUint32(i * 4, numeros[i]);
  return saida;
}

/** O leitor de um arquivo na memória, como o File.slice do navegador. */
export const leitorDe = (bytes: Uint8Array) => async (inicio: number, fim: number) => bytes.slice(inicio, fim);

// ─── CRCs bit a bit ──────────────────────────────────────────────────────────

/** CRC sem reflexão, começo 0, bit a bit (o do Ogg, o do quadro FLAC e o do cabeçalho FLAC). */
export function crcBitABit(bytes: ArrayLike<number>, polinomio: number, largura: number): number {
  const alto = 1 << (largura - 1);
  const mascara = largura === 32 ? 0xffffffff : (1 << largura) - 1;
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc ^ (bytes[i] << (largura - 8))) >>> 0;
    for (let k = 0; k < 8; k++) crc = crc & alto ? ((crc << 1) ^ polinomio) >>> 0 : (crc << 1) >>> 0;
    crc = (crc & mascara) >>> 0;
  }
  return crc;
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

export type OpcoesDoWav = {
  taxa?: number; canais?: number; bits?: number;
  /** 1 PCM, 3 ponto flutuante, 0xfffe extensível (com `subformato`), 2 ADPCM... */
  formato?: number; subformato?: number;
  segundos: number;
  /** Pedaços antes do fmt e entre o fmt e o data (LIST, bext), com tamanho ímpar para o enchimento. */
  etiquetas?: boolean;
  /** O tamanho do data em 0, como a gravação em fluxo deixa. */
  dataEmZero?: boolean;
  /** O WAV de 64 bits (RF64), com o ds64. */
  rf64?: boolean;
  semente?: number;
};

export function wav(o: OpcoesDoWav) {
  const taxa = o.taxa ?? 16000;
  const canais = o.canais ?? 1;
  const bits = o.bits ?? 16;
  const formato = o.formato ?? 1;
  const alinhamento = (canais * bits) / 8;
  const dados = aleatorios(Math.round(o.segundos * taxa) * alinhamento, o.semente ?? 3);
  const corpoDoFmt = formato === 0xfffe
    ? [...u16le(0xfffe), ...u16le(canais), ...u32le(taxa), ...u32le(taxa * alinhamento), ...u16le(alinhamento), ...u16le(bits),
      ...u16le(22), ...u16le(bits), ...u32le(canais === 2 ? 3 : 4), ...u16le(o.subformato ?? 1), 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]
    : [...u16le(formato), ...u16le(canais), ...u32le(taxa), ...u32le(taxa * alinhamento), ...u16le(alinhamento), ...u16le(bits), ...(formato !== 1 ? u16le(0) : [])];
  const pedaco = (id: string, corpo: ArrayLike<number>) => juntar(ascii(id), u32le(corpo.length), corpo, corpo.length % 2 ? [0] : []);
  const etiquetas = o.etiquetas ? [pedaco("LIST", juntar(ascii("INFOINAM"), u32le(9), ascii("Reuniao!\0"))), pedaco("bext", aleatorios(57, 9))] : [];
  const data = juntar(ascii("data"), u32le(o.dataEmZero ? 0 : o.rf64 ? 0xffffffff : dados.length), dados, dados.length % 2 ? [0] : []);
  const ds64 = o.rf64 ? [pedaco("ds64", [...u64le(0), ...u64le(dados.length), ...u64le(dados.length / alinhamento), ...u32le(0)])] : [];
  const miolo = juntar(ascii("WAVE"), ...ds64, ...(etiquetas.length ? [etiquetas[0]] : []), pedaco("fmt ", corpoDoFmt), ...etiquetas.slice(1), data);
  return { bytes: juntar(ascii(o.rf64 ? "RF64" : "RIFF"), u32le(o.rf64 ? 0xffffffff : miolo.length), miolo), dados, alinhamento, bytesPorSegundo: taxa * alinhamento };
}

const u64le = (n: number) => [...u32le(n >>> 0), ...u32le(Math.floor(n / 4294967296))];

// ─── AAC em ADTS ─────────────────────────────────────────────────────────────

export const TAXAS_AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export type OpcoesDoAdts = { quadros: number; indiceDaTaxa?: number; canais?: number; tamanho?: (i: number) => number; crc?: boolean; blocos?: number; semente?: number };

/** Um quadro ADTS: o cabeçalho de 7 bytes (9 com CRC), que diz o tamanho e os blocos, e o miolo. */
export function quadroAdts(tamanho: number, o: { indiceDaTaxa?: number; canais?: number; crc?: boolean; blocos?: number; semente?: number } = {}) {
  const sfi = o.indiceDaTaxa ?? 4;
  const canais = o.canais ?? 2;
  const blocos = o.blocos ?? 1;
  const q = aleatorios(tamanho, o.semente ?? 5);
  q[0] = 0xff;
  q[1] = o.crc ? 0xf0 : 0xf1;
  q[2] = (1 << 6) | (sfi << 2) | (canais >> 2);
  q[3] = ((canais & 3) << 6) | ((tamanho >> 11) & 3);
  q[4] = (tamanho >> 3) & 0xff;
  q[5] = ((tamanho & 7) << 5) | 0x1f;
  q[6] = 0xfc | (blocos - 1);
  return q;
}

export function adts(o: OpcoesDoAdts) {
  const quadros = Array.from({ length: o.quadros }, (_v, i) => quadroAdts(o.tamanho?.(i) ?? 300 + (i % 7) * 11, { ...o, semente: (o.semente ?? 1) * 7919 + i }));
  const taxa = TAXAS_AAC[o.indiceDaTaxa ?? 4];
  return { bytes: juntarMuitos(quadros), segundosPorQuadro: (1024 * (o.blocos ?? 1)) / taxa, quadros };
}

// ─── FLAC ────────────────────────────────────────────────────────────────────

/** O número em UTF-8 "estendido" do cabeçalho do quadro FLAC (escrito aqui à parte, para conferir o do corte). */
export function numeroUtf8Flac(n: number): number[] {
  if (n < 0x80) return [n];
  const saida: number[] = [];
  let bytes = 2;
  while (n >= 2 ** (5 * bytes + 1) && bytes < 7) bytes++;
  let resto = n;
  for (let i = 0; i < bytes - 1; i++) {
    saida.unshift(0x80 | (resto % 64));
    resto = Math.floor(resto / 64);
  }
  const marca = bytes === 7 ? 0xfe : (0xff << (8 - bytes)) & 0xff;
  saida.unshift(marca | resto);
  return saida;
}

export type OpcoesDoFlac = {
  quadros: number; bloco?: number; taxa?: number; canais?: number; bits?: number;
  /** O fluxo de bloco variável (o número é o da amostra, e não o do quadro). */
  variavel?: boolean;
  tamanhoDoQuadro?: number;
  /** O ID3 antes do "fLaC" e o ID3v1 no fim. */
  id3?: boolean;
  /** O último quadro mais curto, como no fim de todo FLAC de bloco fixo. */
  ultimoCurto?: number;
  semente?: number;
};

const CODIGO_DA_TAXA_FLAC: Record<number, number> = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

/** Um quadro FLAC: o cabeçalho (com o CRC-8), um subquadro com o primeiro byte válido e o miolo aleatório, e o CRC-16. */
export function quadroFlac(numero: number, bloco: number, o: { taxa: number; canais: number; bits: number; variavel?: boolean; tamanho: number; semente: number; miolo?: Uint8Array }) {
  const codigoDoBloco = bloco === 4096 ? 12 : bloco === 1152 ? 3 : bloco === 192 ? 1 : 7;
  const extras = codigoDoBloco === 7 ? u16be(bloco - 1) : [];
  const codigoDaTaxa = CODIGO_DA_TAXA_FLAC[o.taxa] ?? 0;
  const codigoDosBits = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 }[o.bits] ?? 0;
  const cabecalho = [0xff, o.variavel ? 0xf9 : 0xf8, (codigoDoBloco << 4) | codigoDaTaxa, ((o.canais - 1) << 4) | (codigoDosBits << 1), ...numeroUtf8Flac(numero), ...extras];
  cabecalho.push(crcBitABit(cabecalho, 0x07, 8));
  const miolo = o.miolo ? o.miolo.slice() : aleatorios(o.tamanho, o.semente);
  // O subquadro VERBATIM (tipo 000001) com o bit de enchimento zerado.
  miolo[0] = 0x02;
  const semCrc = juntar(cabecalho, miolo);
  return juntar(semCrc, u16be(crcBitABit(semCrc, 0x8005, 16)));
}

export function flac(o: OpcoesDoFlac) {
  const bloco = o.bloco ?? 4096;
  const taxa = o.taxa ?? 44100;
  const canais = o.canais ?? 2;
  const bits = o.bits ?? 16;
  const total = (o.quadros - (o.ultimoCurto ? 1 : 0)) * bloco + (o.ultimoCurto ?? 0);
  const streaminfo = [
    ...u16be(bloco), ...u16be(bloco), ...u24be(0), ...u24be(0),
    (taxa >> 12) & 0xff, (taxa >> 4) & 0xff, ((taxa & 0xf) << 4) | ((canais - 1) << 1) | ((bits - 1) >> 4),
    (((bits - 1) & 0xf) << 4) | Math.floor(total / 2 ** 32), ...u32be(total >>> 0), ...Array.from(aleatorios(16, 11)),
  ];
  // VORBIS_COMMENT e PICTURE (com falsos começos de quadro na capa), e a SEEKTABLE vazia: o corte tira todos.
  const capa = aleatorios(3000, 17);
  for (let i = 0; i < capa.length - 1; i += 97) { capa[i] = 0xff; capa[i + 1] = 0xf8; }
  const metadados = [
    [0, streaminfo], [3, []], [4, juntar(u32le(3), ascii("WRW"), u32le(0))], [6, capa],
  ] as const;
  const blocos = metadados.map(([tipo, corpo], i) => juntar([(i === metadados.length - 1 ? 0x80 : 0) | tipo, ...u24be(corpo.length)], corpo));
  const quadros: Uint8Array[] = [];
  let amostra = 0;
  for (let i = 0; i < o.quadros; i++) {
    const tamanhoDoBloco = o.ultimoCurto && i === o.quadros - 1 ? o.ultimoCurto : bloco;
    quadros.push(quadroFlac(o.variavel ? amostra : i, tamanhoDoBloco, { taxa, canais, bits, variavel: o.variavel, tamanho: o.tamanhoDoQuadro ?? 2000 + (i % 5) * 37, semente: (o.semente ?? 1) * 104729 + i }));
    amostra += tamanhoDoBloco;
  }
  const id3 = o.id3 ? juntar(ascii("ID3"), [4, 0, 0, 0, 0, 0, 20], aleatorios(20, 23)) : new Uint8Array(0);
  const id3v1 = o.id3 ? juntar(ascii("TAG"), aleatorios(125, 29)) : new Uint8Array(0);
  return { bytes: juntarMuitos([id3, ascii("fLaC"), ...blocos, ...quadros, id3v1]), quadros, amostras: amostra, taxa };
}

// ─── Ogg ─────────────────────────────────────────────────────────────────────

/** Uma página Ogg: o cabeçalho de 27 bytes, os laços, o corpo e o CRC-32 (contado bit a bit). */
export function paginaOgg(o: { tipo: number; granulo: number; serial: number; seq: number; lacos: number[]; corpo: Uint8Array }) {
  const h = [
    ...ascii("OggS"), 0, o.tipo,
    ...(o.granulo < 0 ? new Array(8).fill(0xff) : [...u32le(o.granulo >>> 0), ...u32le(Math.floor(o.granulo / 4294967296))]),
    ...u32le(o.serial), ...u32le(o.seq), 0, 0, 0, 0, o.lacos.length, ...o.lacos,
  ];
  const pagina = juntar(h, o.corpo);
  pagina.set(u32le(crcBitABit(pagina, 0x04c11db7, 32)), 22);
  return pagina;
}

/** Os pacotes em páginas: `porPagina` pacotes em cada, o grânulo dado pela função (a soma das amostras até o fim da página). */
export function paginar(pacotes: Uint8Array[], o: { serial: number; seqInicial: number; porPagina: number; granuloDe: (ultimo: number) => number; bos?: boolean; eos?: boolean }) {
  const paginas: Uint8Array[] = [];
  for (let i = 0, seq = o.seqInicial; i < pacotes.length; i += o.porPagina, seq++) {
    const daPagina = pacotes.slice(i, i + o.porPagina);
    const lacos: number[] = [];
    for (const p of daPagina) {
      for (let resto = p.length; ; resto -= 255) {
        lacos.push(Math.min(255, resto));
        if (resto < 255) break;
      }
    }
    if (lacos.length > 255) throw new Error("página com laços demais no teste");
    const ultima = i + o.porPagina >= pacotes.length;
    paginas.push(paginaOgg({
      tipo: (o.bos && i === 0 ? 2 : 0) | (o.eos && ultima ? 4 : 0), granulo: o.granuloDe(Math.min(i + o.porPagina, pacotes.length) - 1),
      serial: o.serial, seq, lacos, corpo: juntar(...daPagina),
    }));
  }
  return paginas;
}

/** Um pacote que não cabe numa página (as etiquetas com capa): os laços em páginas de 255 segmentos, sem grânulo nas que não fecham pacote. */
export function paginarGrande(pacote: Uint8Array, serial: number, seqInicial: number) {
  const lacos: number[] = [];
  for (let resto = pacote.length; ; resto -= 255) {
    lacos.push(Math.min(255, resto));
    if (resto < 255) break;
  }
  const paginas: Uint8Array[] = [];
  let p = 0;
  for (let i = 0, seq = seqInicial; i < lacos.length; i += 255, seq++) {
    const deste = lacos.slice(i, i + 255);
    const corpo = pacote.subarray(p, p + deste.reduce((s, l) => s + l, 0));
    p += corpo.length;
    const fecha = deste[deste.length - 1] < 255;
    paginas.push(paginaOgg({ tipo: i > 0 ? 1 : 0, granulo: fecha ? 0 : -1, serial, seq, lacos: deste, corpo }));
  }
  return paginas;
}

/** O TOC do Opus de 20 ms (CELT, banda cheia, um quadro): 960 amostras a 48 kHz. */
export const TOC_OPUS_20MS = 0xf8;
/** O TOC do Opus de 60 ms (SILK, banda estreita): 2.880 amostras. */
export const TOC_OPUS_60MS = 0x18;

export const opusHead = (o: { canais?: number; preSkip?: number; taxa?: number } = {}) =>
  Uint8Array.from([...ascii("OpusHead"), 1, o.canais ?? 1, ...u16le(o.preSkip ?? 312), ...u32le(o.taxa ?? 48000), 0, 0, 0]);

export type OpcoesDoOggOpus = {
  pacotes: number; porPagina?: number; toc?: number; tamanho?: (i: number) => number;
  /** O segundo byte de cada pacote (no código 3 do TOC, o número de quadros). */
  segundoByte?: number;
  /** O grânulo que o fluxo traz antes do primeiro pacote (o trecho de uma transmissão). */
  granuloInicial?: number;
  /** Etiquetas grandes (uma capa), em várias páginas. */
  capa?: number;
  /** Outro fluxo multiplexado (o vídeo do .ogv). */
  comVideo?: boolean;
  semente?: number;
};

export function amostrasDoToc(toc: number) {
  const config = toc >> 3;
  return config < 12 ? [480, 960, 1920, 2880][config % 4] : config < 16 ? [480, 960][(config - 12) % 2] : [120, 240, 480, 960][(config - 16) % 4];
}

export function oggOpus(o: OpcoesDoOggOpus) {
  const serial = 0x1234;
  const toc = o.toc ?? TOC_OPUS_20MS;
  const porPacote = amostrasDoToc(toc) * ((toc & 3) === 3 ? (o.segundoByte ?? 0) & 0x3f : (toc & 3) === 0 ? 1 : 2);
  const pacotes = Array.from({ length: o.pacotes }, (_v, i) => {
    const p = aleatorios(o.tamanho?.(i) ?? 60 + (i % 9) * 7, (o.semente ?? 1) * 31337 + i);
    p[0] = toc;
    if (o.segundoByte !== undefined) p[1] = o.segundoByte;
    return p;
  });
  const tags = juntar(ascii("OpusTags"), u32le(8), ascii("Gravador"), u32le(1), u32le(o.capa ? o.capa + 20 : 9), ascii(o.capa ? "METADATA_BLOCK_PICTURE=" : "TITLE=Oi!"), o.capa ? aleatorios(o.capa - 3, 41) : []);
  const inicial = o.granuloInicial ?? 0;
  const paginas = [
    paginaOgg({ tipo: 2, granulo: 0, serial, seq: 0, lacos: [19], corpo: opusHead() }),
    ...(o.comVideo ? [paginaOgg({ tipo: 2, granulo: 0, serial: 0x99, seq: 0, lacos: [42], corpo: juntar([0x80], ascii("theora"), aleatorios(35, 3)) })] : []),
    ...paginarGrande(tags, serial, 1),
  ];
  const seqDoAudio = paginas.filter(p => p[14] === (serial & 0xff)).length;
  const audio = paginar(pacotes, { serial, seqInicial: seqDoAudio, porPagina: o.porPagina ?? 50, granuloDe: ultimo => inicial + (ultimo + 1) * porPacote, eos: true });
  if (o.comVideo) {
    // Uma página do vídeo entre as de áudio: o corte a deixa de fora.
    audio.splice(1, 0, paginaOgg({ tipo: 0, granulo: 100, serial: 0x99, seq: 1, lacos: [200], corpo: aleatorios(200, 5) }));
  }
  return { bytes: juntarMuitos([...paginas, ...audio]), pacotes, amostras: o.pacotes * porPacote };
}

export type OpcoesDoOggVorbis = {
  pacotes: number; porPagina?: number; taxa?: number; semente?: number;
  /** O grânulo que o fluxo traz antes do primeiro pacote (o trecho de uma transmissão, gravado de um Icecast). */
  granuloInicial?: number;
};

/** Ogg Vorbis: os três cabeçalhos (o setup com bytes de mentira) e os pacotes de áudio, com o grânulo andando 1.024 amostras por pacote (o bloco longo de 2.048). */
export function oggVorbis(o: OpcoesDoOggVorbis) {
  const serial = 0x777;
  const taxa = o.taxa ?? 44100;
  const identificacao = Uint8Array.from([1, ...ascii("vorbis"), ...u32le(0), 2, ...u32le(taxa), ...u32le(0), ...u32le(128000), ...u32le(0), 0xb8, 1]);
  const comentario = Uint8Array.from([3, ...ascii("vorbis"), ...u32le(3), ...ascii("WRW"), ...u32le(0), 1]);
  const setup = juntar([5], ascii("vorbis"), aleatorios(600, 7));
  const pacotes = Array.from({ length: o.pacotes }, (_v, i) => {
    const p = aleatorios(150 + (i % 5) * 13, (o.semente ?? 1) * 7 + i);
    p[0] &= 0xfe;
    return p;
  });
  const paginas = [
    paginaOgg({ tipo: 2, granulo: 0, serial, seq: 0, lacos: [identificacao.length], corpo: identificacao }),
    ...paginar([comentario, setup], { serial, seqInicial: 1, porPagina: 2, granuloDe: () => 0 }),
    ...paginar(pacotes, { serial, seqInicial: 2, porPagina: o.porPagina ?? 40, granuloDe: ultimo => (o.granuloInicial ?? 0) + (ultimo + 1) * 1024, eos: true }),
  ];
  return { bytes: juntar(...paginas), pacotes, taxa, amostras: o.pacotes * 1024 };
}

// ─── WebM / Matroska ─────────────────────────────────────────────────────────

const idEbml = (id: number) => { const s: number[] = []; for (let r = id; r > 0; r = Math.floor(r / 256)) s.unshift(r % 256); return s; };
function tamanhoEbml(n: number): number[] {
  for (let bytes = 1; bytes <= 8; bytes++) {
    if (n < 2 ** (7 * bytes) - 1) {
      const s: number[] = [];
      let r = n;
      for (let i = 0; i < bytes; i++) { s.unshift(r % 256); r = Math.floor(r / 256); }
      s[0] |= 0x80 >> (bytes - 1);
      return s;
    }
  }
  throw new Error("grande demais");
}
export const elementoEbml = (id: number, ...corpo: ArrayLike<number>[]) => { const c = juntar(...corpo); return juntar(idEbml(id), tamanhoEbml(c.length), c); };
const DESCONHECIDO = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const uintEbml = (n: number) => { const s: number[] = []; let r = n; do { s.unshift(r % 256); r = Math.floor(r / 256); } while (r > 0); return s; };
const float64 = (x: number) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return Array.from(new Uint8Array(v.buffer)); };

export type OpcoesDoWebm = {
  codec?: string; pacotes: number; porCluster?: number; toc?: number; tamanho?: (i: number) => number;
  /** O segundo byte de cada pacote Opus (no código 3 do TOC, o número de quadros). */
  segundoByte?: number;
  /** Só a faixa de vídeo. */
  semAudio?: boolean;
  /** O Segment e os clusters de tamanho desconhecido, como o MediaRecorder grava. */
  desconhecido?: boolean;
  /** Uma faixa de vídeo antes da de áudio, com blocos entre os de áudio. */
  video?: boolean;
  /** O CodecPrivate (null: sem ele). Por padrão, o OpusHead ou o AudioSpecificConfig do AAC-LC a 48 kHz. */
  privado?: Uint8Array | null;
  /** Os pacotes de três em três num bloco só, com o laçamento Xiph. */
  lacamento?: boolean;
  /** Os blocos dentro de BlockGroup, e não SimpleBlock. */
  blockGroup?: boolean;
  docType?: string;
  /** Lixo no lugar de um cluster do meio: o corte procura o seguinte. */
  lixoNoMeio?: boolean;
  semente?: number;
};

export function webm(o: OpcoesDoWebm) {
  const codec = o.codec ?? "A_OPUS";
  const toc = o.toc ?? TOC_OPUS_20MS;
  const audio = codec === "A_OPUS";
  const pacotes = Array.from({ length: o.pacotes }, (_v, i) => {
    const p = aleatorios(o.tamanho?.(i) ?? 70 + (i % 9) * 5, (o.semente ?? 1) * 1009 + i);
    if (audio) p[0] = toc;
    if (audio && o.segundoByte !== undefined) p[1] = o.segundoByte;
    return p;
  });
  const numeroDoAudio = o.video ? 2 : 1;
  const privado = o.privado === undefined ? (audio ? opusHead({ canais: 2 }) : Uint8Array.from([0x11, 0x90])) : o.privado;
  const faixaDeAudio = elementoEbml(0xae,
    elementoEbml(0xd7, uintEbml(numeroDoAudio)), elementoEbml(0x83, [2]), elementoEbml(0x86, ascii(codec)),
    ...(privado ? [elementoEbml(0x63a2, privado)] : []),
    elementoEbml(0xe1, elementoEbml(0xb5, float64(48000)), elementoEbml(0x9f, [2])),
  );
  const faixaDeVideo = elementoEbml(0xae, elementoEbml(0xd7, [1]), elementoEbml(0x83, [1]), elementoEbml(0x86, ascii("V_VP8")));
  const cabecalho = elementoEbml(0x1a45dfa3, elementoEbml(0x4286, [1]), elementoEbml(0x42f7, [1]), elementoEbml(0x4282, ascii(o.docType ?? "webm")));
  const info = elementoEbml(0x1549a966, elementoEbml(0x2ad7b1, uintEbml(1_000_000)), elementoEbml(0x4489, float64(o.pacotes * 20)));
  const faixas = elementoEbml(0x1654ae6b, ...(o.video || o.semAudio ? [faixaDeVideo] : []), ...(o.semAudio ? [] : [faixaDeAudio]));
  const bloco = (faixa: number, relativo: number, corpo: Uint8Array, lacado = false) => {
    const conteudo = juntar([0x80 | faixa], u16be(relativo & 0xffff), [lacado ? 0x82 : 0x80], corpo);
    return o.blockGroup ? elementoEbml(0xa0, elementoEbml(0xa1, conteudo)) : elementoEbml(0xa3, conteudo);
  };
  const porCluster = o.porCluster ?? 50;
  const clusters: Uint8Array[] = [];
  for (let c = 0; c * porCluster < pacotes.length; c++) {
    const doCluster = pacotes.slice(c * porCluster, (c + 1) * porCluster);
    const blocos: Uint8Array[] = [];
    if (o.lacamento) {
      for (let i = 0; i < doCluster.length; i += 3) {
        const grupo = doCluster.slice(i, i + 3);
        // Xiph: o número de quadros menos 1, e o tamanho de cada um menos o último, em pedaços de 255.
        const tamanhos: number[] = [];
        for (const p of grupo.slice(0, -1)) { let r = p.length; while (r >= 255) { tamanhos.push(255); r -= 255; } tamanhos.push(r); }
        blocos.push(bloco(numeroDoAudio, i * 20, juntar([grupo.length - 1], tamanhos, ...grupo), true));
      }
    } else {
      doCluster.forEach((p, i) => {
        blocos.push(bloco(o.semAudio ? 1 : numeroDoAudio, i * 20, p));
        if (o.video && i % 10 === 0) blocos.push(bloco(1, i * 20, aleatorios(5000, i + 77)));
      });
    }
    const corpo = juntarMuitos([elementoEbml(0xe7, uintEbml(c * porCluster * 20)), ...blocos]);
    clusters.push(o.desconhecido ? juntar(idEbml(0x1f43b675), DESCONHECIDO, corpo) : elementoEbml(0x1f43b675, corpo));
    // Zeros não são id de elemento: o corte procura o cluster seguinte, como o demuxer.
    if (o.lixoNoMeio && c === 0) clusters.push(new Uint8Array(3000));
  }
  const corpoDoSegmento = juntarMuitos([info, faixas, ...clusters, elementoEbml(0x1c53bb6b, aleatorios(40, 3))]);
  const segmento = o.desconhecido ? juntar(idEbml(0x18538067), DESCONHECIDO, corpoDoSegmento) : elementoEbml(0x18538067, corpoDoSegmento);
  return { bytes: juntar(cabecalho, segmento), pacotes };
}

// ─── MP4 / M4A / MOV ─────────────────────────────────────────────────────────

export const caixa = (tipo: string, ...corpo: ArrayLike<number>[]) => { const c = juntar(...corpo); return juntar(u32be(8 + c.length), ascii(tipo), c); };
export const caixaCheia = (tipo: string, versao: number, flags: number, ...corpo: ArrayLike<number>[]) => caixa(tipo, [versao, ...u24be(flags)], ...corpo);
const descritor = (tag: number, corpo: ArrayLike<number>) => juntar([tag, 0x80, 0x80, 0x80, corpo.length], corpo);

/** O AudioSpecificConfig do AAC-LC (objeto 2), com o índice da taxa e os canais. */
export const ascAacLc = (indiceDaTaxa = 4, canais = 2) => Uint8Array.from([(2 << 3) | (indiceDaTaxa >> 1), ((indiceDaTaxa & 1) << 7) | (canais << 3)]);

export type OpcoesDoMp4 = {
  quadros: number;
  /** A taxa dos quadros (a escala da faixa) e o AudioSpecificConfig. */
  taxa?: number; asc?: Uint8Array;
  /** O tipo da entrada de som: mp4a (o padrão), alac, ac-3... */
  codec?: string;
  /** O moov depois do mdat (o MP4 que não é "faststart"). */
  moovNoFim?: boolean;
  /** Quadros por bloco (chunk) da tabela. */
  porBloco?: number;
  /** Uma faixa de vídeo antes da de áudio, com blocos de vídeo entre os de áudio. */
  video?: boolean;
  /** Sem faixa de áudio nenhuma. */
  semAudio?: boolean;
  /**
   * O MP4 fragmentado (o do Safari): o moov sem amostras e um moof com mdat a
   * cada `porFragmento` quadros. Com `video`, cada moof traz o traf do vídeo
   * ANTES do traf do áudio, e o mdat, os dados do vídeo antes dos do áudio.
   */
  fragmentado?: boolean; porFragmento?: number;
  /**
   * De onde o tfhd conta a base dos dados no fragmento: do começo do moof
   * (default-base-is-moof, o padrão), do base_data_offset escrito ("explicita")
   * ou de nenhum dos dois ("implicita": o primeiro traf conta do moof, e os
   * seguintes do fim dos dados do traf anterior, como no omit_tfhd_offset do ffmpeg).
   */
  baseDoFragmento?: "moof" | "explicita" | "implicita";
  /** O MOV do QuickTime: ftyp "qt  ", a entrada de som de versão 1 e o esds dentro do wave. Com `semFtyp`, o QuickTime antigo. */
  qt?: boolean; semFtyp?: boolean;
  /** O co64 no lugar do stco. */
  co64?: boolean;
  tamanho?: (i: number) => number;
  /** A tabela diz mais quadros do que o arquivo tem (a gravação cortada no meio do mdat). */
  cortado?: boolean;
  semente?: number;
};

function entradaDeSom(o: OpcoesDoMp4): Uint8Array {
  const codec = o.codec ?? "mp4a";
  const asc = o.asc ?? ascAacLc();
  const esds = caixaCheia("esds", 0, 0, descritor(3, juntar([0, 1, 0], descritor(4, juntar([0x40, 0x15, 0, 0, 0], u32be(128000), u32be(128000), descritor(5, asc))), descritor(6, [2]))));
  const taxa = o.taxa ?? 44100;
  const comum = [...new Array(6).fill(0), ...u16be(1)];
  if (o.qt) {
    // QuickTime, versão 1: 16 bytes a mais (amostras por pacote, bytes por pacote, por quadro e por amostra) e o esds dentro do wave.
    const corpo = juntar(comum, u16be(1), u16be(0), u32be(0), u16be(2), u16be(16), u16be(0xfffe), u16be(0), u32be(taxa * 65536), u32be(1024), u32be(0), u32be(0), u32be(2),
      codec === "mp4a" ? caixa("wave", caixa("frma", ascii("mp4a")), esds, u32be(8), u32be(0)) : []);
    return caixa(codec, corpo);
  }
  const corpo = juntar(comum, new Array(8).fill(0), u16be(2), u16be(16), u16be(0), u16be(0), u32be(taxa * 65536), codec === "mp4a" ? esds : codec === "alac" ? caixaCheia("alac", 0, 0, aleatorios(24, 1)) : []);
  return caixa(codec, corpo);
}

export function mp4(o: OpcoesDoMp4) {
  const taxa = o.taxa ?? 44100;
  const porBloco = o.porBloco ?? 20;
  const quadros = Array.from({ length: o.quadros }, (_v, i) => aleatorios(o.tamanho?.(i) ?? 200 + (i % 11) * 9, (o.semente ?? 1) * 6007 + i));
  const ftyp = o.semFtyp ? new Uint8Array(0) : o.qt ? caixa("ftyp", ascii("qt  "), u32be(0), ascii("qt  ")) : caixa("ftyp", ascii("M4A "), u32be(0), ascii("M4A "), ascii("isom"), ascii("mp42"));
  const idDoAudio = o.video ? 2 : 1;
  const mvhd = caixaCheia("mvhd", 0, 0, u32be(0), u32be(0), u32be(1000), u32be(0), u32be(0x10000), u16be(0x100), new Array(10).fill(0), u32be(0x10000), new Array(12).fill(0), u32be(0x10000), new Array(12).fill(0), u32be(0x40000000), new Array(24).fill(0), u32be(3));
  const trak = (id: number, manipulador: string, stbl: Uint8Array, escala: number) => caixa("trak",
    caixaCheia("tkhd", 0, 3, u32be(0), u32be(0), u32be(id), u32be(0), u32be(0), new Array(52).fill(0), u32be(0), u32be(0)),
    caixa("mdia",
      caixaCheia("mdhd", 0, 0, u32be(0), u32be(0), u32be(escala), u32be(0), u16be(0x55c4), u16be(0)),
      caixaCheia("hdlr", 0, 0, u32be(0), ascii(manipulador), new Array(12).fill(0), ascii("WRW\0")),
      caixa("minf", manipulador === "soun" ? caixaCheia("smhd", 0, 0, u32be(0)) : caixaCheia("vmhd", 0, 1, new Array(8).fill(0)), caixa("dinf", caixaCheia("dref", 0, 0, u32be(1), caixaCheia("url ", 0, 1))), stbl),
    ),
  );
  if (o.cortado && (o.video || o.moovNoFim || o.fragmentado)) throw new Error("o arquivo cortado do teste tem o moov no começo e só áudio");
  const quadrosNoArquivo = o.cortado ? quadros.slice(0, Math.floor(quadros.length / 2)) : quadros;

  if (o.fragmentado) {
    const stblVazia = (entrada: Uint8Array) => caixa("stbl", caixaCheia("stsd", 0, 0, u32be(1), entrada), caixaCheia("stts", 0, 0, u32be(0)), caixaCheia("stsc", 0, 0, u32be(0)), caixaCheia("stsz", 0, 0, u32be(0), u32be(0)), caixaCheia("stco", 0, 0, u32be(0)));
    const avc1 = caixa("avc1", new Array(6).fill(0), u16be(1), new Array(70).fill(0));
    // O vídeo usa os padrões do trex (512 de duração), e o tamanho vem em cada trun.
    const trexs = [
      ...(o.video ? [caixaCheia("trex", 0, 0, u32be(1), u32be(1), u32be(512), u32be(0), u32be(0))] : []),
      caixaCheia("trex", 0, 0, u32be(idDoAudio), u32be(1), u32be(1024), u32be(0), u32be(0)),
    ];
    const moov = caixa("moov", mvhd, ...(o.video ? [trak(1, "vide", stblVazia(avc1), 15360)] : []), trak(idDoAudio, "soun", stblVazia(entradaDeSom(o)), taxa), caixa("mvex", ...trexs));
    const base = o.baseDoFragmento ?? "moof";
    const flagsDoTfhd = base === "moof" ? 0x020000 : base === "explicita" ? 0x01 : 0;
    const fragmentos: Uint8Array[] = [];
    const porFragmento = o.porFragmento ?? 25;
    let posicao = ftyp.length + moov.length;
    for (let i = 0, seq = 1; i < quadros.length; i += porFragmento, seq++) {
      const deste = quadros.slice(i, i + porFragmento);
      const doVideo = o.video ? [aleatorios(3000, 900 + seq), aleatorios(2000, 1900 + seq)] : [];
      const bytesDoVideo = doVideo.reduce((s, q) => s + q.length, 0);
      const tfhd = (id: number) => caixaCheia("tfhd", 0, flagsDoTfhd, u32be(id), flagsDoTfhd & 0x01 ? u64be(posicao) : []);
      const moofCom = (tamanhoDoMoof: number) => {
        // O data_offset conta da base: o moof (ou o base_data_offset, que aponta para ele) até os dados, depois do cabeçalho do mdat.
        const dadosDoMoof = tamanhoDoMoof + 8;
        const trafDoVideo = o.video
          ? [caixa("traf", tfhd(1), caixaCheia("tfdt", 1, 0, u64be((seq - 1) * 1024)), caixaCheia("trun", 0, 0x201, u32be(doVideo.length), u32be(dadosDoMoof), listaU32be(doVideo.map(q => q.length))))]
          : [];
        // Com a base implícita, o áudio conta do fim dos dados do vídeo: data_offset 0, como o ffmpeg escreve.
        const offsetDoAudio = base === "implicita" && o.video ? 0 : dadosDoMoof + bytesDoVideo;
        const trafDoAudio = caixa("traf", tfhd(idDoAudio), caixaCheia("tfdt", 1, 0, u64be(i * 1024)), caixaCheia("trun", 0, 0x201, u32be(deste.length), u32be(offsetDoAudio), listaU32be(deste.map(q => q.length))));
        return caixa("moof", caixaCheia("mfhd", 0, 0, u32be(seq)), ...trafDoVideo, trafDoAudio);
      };
      const moof = moofCom(moofCom(0).length);
      const mdat = caixa("mdat", juntar(...doVideo, ...deste));
      fragmentos.push(moof, mdat);
      posicao += moof.length + mdat.length;
    }
    return { bytes: juntarMuitos([ftyp, moov, ...fragmentos]), quadros, taxa };
  }

  // Os blocos: o de áudio e, com vídeo, um bloco de vídeo antes de cada um.
  const blocosDeAudio: Uint8Array[][] = [];
  for (let i = 0; i < quadros.length; i += porBloco) blocosDeAudio.push(quadros.slice(i, i + porBloco));
  const video = (i: number) => aleatorios(3000, 500 + i);
  const montarMdat = () => {
    const pedacos: Uint8Array[] = [];
    blocosDeAudio.forEach((bloco, i) => {
      if (o.video) pedacos.push(video(i));
      pedacos.push(...bloco);
    });
    return juntarMuitos(pedacos);
  };
  const moovCom = (offsetsDoAudio: number[], offsetsDoVideo: number[]) => {
    const ultimo = quadros.length % porBloco;
    const stsc = ultimo ? [...u32be(1), ...u32be(porBloco), ...u32be(1), ...u32be(blocosDeAudio.length), ...u32be(ultimo), ...u32be(1)] : [...u32be(1), ...u32be(porBloco), ...u32be(1)];
    const tabelaDeBlocos = o.co64
      ? caixaCheia("co64", 0, 0, u32be(offsetsDoAudio.length), listaU32be(offsetsDoAudio.flatMap(n => [Math.floor(n / 4294967296), n >>> 0])))
      : caixaCheia("stco", 0, 0, u32be(offsetsDoAudio.length), listaU32be(offsetsDoAudio));
    const stblDoAudio = caixa("stbl",
      caixaCheia("stsd", 0, 0, u32be(1), entradaDeSom(o)),
      caixaCheia("stts", 0, 0, u32be(1), u32be(quadros.length), u32be(1024)),
      caixaCheia("stsc", 0, 0, u32be(ultimo ? 2 : 1), stsc),
      caixaCheia("stsz", 0, 0, u32be(0), u32be(quadros.length), listaU32be(quadros.map(q => q.length))),
      tabelaDeBlocos,
    );
    const stblDoVideo = caixa("stbl",
      caixaCheia("stsd", 0, 0, u32be(1), caixa("avc1", new Array(6).fill(0), u16be(1), new Array(70).fill(0))),
      caixaCheia("stts", 0, 0, u32be(1), u32be(blocosDeAudio.length), u32be(512)),
      caixaCheia("stsc", 0, 0, u32be(1), u32be(1), u32be(1), u32be(1)),
      caixaCheia("stsz", 0, 0, u32be(3000), u32be(blocosDeAudio.length)),
      caixaCheia("stco", 0, 0, u32be(offsetsDoVideo.length), listaU32be(offsetsDoVideo)),
    );
    return caixa("moov", mvhd, ...(o.video ? [trak(1, "vide", stblDoVideo, 15360)] : []), ...(o.semAudio ? [] : [trak(idDoAudio, "soun", stblDoAudio, taxa)]));
  };
  const mdat = montarMdat();
  const zeros = blocosDeAudio.map(() => 0);
  const tamanhoDoMoov = moovCom(zeros, zeros).length;
  const inicioDoMdat = ftyp.length + (o.moovNoFim ? 0 : tamanhoDoMoov) + 8;
  const offsetsDoAudio: number[] = [];
  const offsetsDoVideo: number[] = [];
  let p = inicioDoMdat;
  blocosDeAudio.forEach((bloco, i) => {
    if (o.video) { offsetsDoVideo.push(p); p += video(i).length; }
    offsetsDoAudio.push(p);
    p += bloco.reduce((s, q) => s + q.length, 0);
  });
  const moov = moovCom(offsetsDoAudio, offsetsDoVideo);
  const caixaMdat = juntar(u32be(8 + mdat.length), ascii("mdat"), mdat);
  const mdatNoArquivo = o.cortado ? caixaMdat.subarray(0, 8 + quadrosNoArquivo.reduce((s, q) => s + q.length, 0)) : caixaMdat;
  const bytes = o.moovNoFim ? juntar(ftyp, mdatNoArquivo, moov) : juntar(ftyp, moov, mdatNoArquivo);
  return { bytes, quadros, taxa, offsetsDoAudio };
}
