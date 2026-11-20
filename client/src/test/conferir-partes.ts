import type { CorteDoArquivo, ParteCortada } from "@/lib/corte-comum";
import { crcBitABit } from "./audio-sintetico";

/**
 * Leitores simples, só para os testes, das partes que o corte monta: as
 * páginas do Ogg, as caixas do MP4 e os quadros do FLAC. Escritos à parte do
 * corte, para conferir o que ele escreveu sem usar o código dele.
 */

/** A parte montada como a tela monta: os bytes novos e os trechos do arquivo, na ordem. */
export function montar(arquivo: Uint8Array, parte: ParteCortada): Uint8Array {
  const pedacos: Uint8Array[] = [];
  for (let i = 0; i < parte.ordem.length; i += 3) {
    const [origem, inicio, fim] = [parte.ordem[i], parte.ordem[i + 1], parte.ordem[i + 2]];
    pedacos.push(origem === 0 ? parte.novos.subarray(inicio, fim) : arquivo.subarray(inicio, fim));
  }
  const total = pedacos.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let p = 0;
  for (const pedaco of pedacos) { saida.set(pedaco, p); p += pedaco.length; }
  return saida;
}

export function partesDe(corte: CorteDoArquivo) {
  if (!corte.ok) throw new Error(`o corte recusou: ${corte.codigo} ${corte.detalhe ?? ""}`);
  return corte.partes;
}

const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const texto = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...Array.from(b.subarray(i, i + n)));

export type PaginaLida = { tipo: number; granulo: number; serial: number; seq: number; lacos: number[]; corpo: Uint8Array; crcCerto: boolean };

/** As páginas de um Ogg, uma atrás da outra (sem lixo entre elas), com o CRC conferido bit a bit. */
export function paginasOgg(bytes: Uint8Array): PaginaLida[] {
  const paginas: PaginaLida[] = [];
  for (let p = 0; p < bytes.length;) {
    if (texto(bytes, p, 4) !== "OggS") throw new Error(`não é página em ${p}`);
    const n = bytes[p + 26];
    const lacos = Array.from(bytes.subarray(p + 27, p + 27 + n));
    const corpo = lacos.reduce((s, l) => s + l, 0);
    const pagina = bytes.slice(p, p + 27 + n + corpo);
    const crc = u32le(pagina, 22);
    pagina.fill(0, 22, 26);
    const baixo = u32le(bytes, p + 6);
    const alto = u32le(bytes, p + 10);
    paginas.push({
      tipo: bytes[p + 5], granulo: baixo === 0xffffffff && alto === 0xffffffff ? -1 : alto * 4294967296 + baixo,
      serial: u32le(bytes, p + 14), seq: u32le(bytes, p + 18), lacos, corpo: bytes.subarray(p + 27 + n, p + 27 + n + corpo),
      crcCerto: crcBitABit(pagina, 0x04c11db7, 32) === crc,
    });
    p += 27 + n + corpo;
  }
  return paginas;
}

/** Os pacotes de páginas de um fluxo (juntando os que atravessam páginas). */
export function pacotesOgg(paginas: PaginaLida[]): Uint8Array[] {
  const pacotes: Uint8Array[] = [];
  let aberto: number[] = [];
  for (const pagina of paginas) {
    let p = 0;
    for (const laco of pagina.lacos) {
      aberto.push(...Array.from(pagina.corpo.subarray(p, p + laco)));
      p += laco;
      if (laco < 255) { pacotes.push(Uint8Array.from(aberto)); aberto = []; }
    }
  }
  return pacotes;
}

export type CaixaLida = { tipo: string; inicio: number; fim: number; dados: number; filhas: CaixaLida[] };
const CONTEINERES = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "dinf"]);

/** As caixas de um MP4, com as filhas dos contêineres. */
export function caixasMp4(bytes: Uint8Array, inicio = 0, fim = bytes.length): CaixaLida[] {
  const caixas: CaixaLida[] = [];
  for (let p = inicio; p + 8 <= fim;) {
    const tamanho = u32be(bytes, p);
    const tipo = texto(bytes, p + 4, 4);
    if (tamanho < 8 || p + tamanho > fim) throw new Error(`caixa ${tipo} com tamanho errado em ${p}`);
    caixas.push({ tipo, inicio: p, fim: p + tamanho, dados: p + 8, filhas: CONTEINERES.has(tipo) ? caixasMp4(bytes, p + 8, p + tamanho) : [] });
    p += tamanho;
  }
  return caixas;
}

export function acharCaixa(caixas: CaixaLida[], caminho: string): CaixaLida | undefined {
  const [primeiro, ...resto] = caminho.split("/");
  const achada = caixas.find(c => c.tipo === primeiro);
  return achada && resto.length ? acharCaixa(achada.filhas, resto.join("/")) : achada;
}

/** O que importa do fragmento da parte: o tfdt, o trun e o mdat. */
export function fragmentoMp4(bytes: Uint8Array) {
  const caixas = caixasMp4(bytes);
  const tfdt = acharCaixa(caixas, "moof/traf/tfdt")!;
  const trun = acharCaixa(caixas, "moof/traf/trun")!;
  const tfhd = acharCaixa(caixas, "moof/traf/tfhd")!;
  const moof = acharCaixa(caixas, "moof")!;
  const mdat = acharCaixa(caixas, "mdat")!;
  const versaoDoTfdt = bytes[tfdt.dados];
  const decodeTime = versaoDoTfdt === 1 ? u32be(bytes, tfdt.dados + 4) * 4294967296 + u32be(bytes, tfdt.dados + 8) : u32be(bytes, tfdt.dados + 4);
  const flags = u32be(bytes, trun.dados) & 0xffffff;
  const quantas = u32be(bytes, trun.dados + 4);
  const dataOffset = u32be(bytes, trun.dados + 8);
  const tamanhos: number[] = [];
  const duracoes: number[] = [];
  const passo = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0);
  for (let i = 0, p = trun.dados + 12; i < quantas; i++, p += passo) {
    if (flags & 0x100) duracoes.push(u32be(bytes, p));
    tamanhos.push(u32be(bytes, p + (flags & 0x100 ? 4 : 0)));
  }
  const flagsDoTfhd = u32be(bytes, tfhd.dados) & 0xffffff;
  const duracaoPadrao = flagsDoTfhd & 0x08 ? u32be(bytes, tfhd.dados + 8) : null;
  return { caixas, decodeTime, quantas, tamanhos, duracoes, duracaoPadrao, dadosComecamEm: moof.inicio + dataOffset, mdat: bytes.subarray(mdat.dados, mdat.fim) };
}

/**
 * Os quadros de um FLAC: o STREAMINFO e, depois dos metadados, cada quadro
 * achado pelo sincronismo e confirmado pelo CRC-16 até o seguinte (contado
 * bit a bit), com o número e o tamanho do bloco do cabeçalho.
 */
export function quadrosFlac(bytes: Uint8Array) {
  if (texto(bytes, 0, 4) !== "fLaC") throw new Error("sem fLaC");
  let p = 4;
  let streaminfo: Uint8Array | null = null;
  const tipos: number[] = [];
  for (let ultimo = false; !ultimo;) {
    ultimo = (bytes[p] & 0x80) !== 0;
    const tipo = bytes[p] & 0x7f;
    const tamanho = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    tipos.push(tipo);
    if (tipo === 0) streaminfo = bytes.slice(p + 4, p + 4 + tamanho);
    p += 4 + tamanho;
  }
  const quadros: Array<{ inicio: number; fim: number; numero: number; crc8Certo: boolean }> = [];
  while (p < bytes.length) {
    const inicio = p;
    // O número em UTF-8 depois dos 4 bytes fixos.
    const b = bytes[p + 4];
    const extras = b < 0x80 ? 0 : b >= 0xfe ? 6 : b >= 0xfc ? 5 : b >= 0xf8 ? 4 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
    let numero = extras ? b & (0x3f >> extras) : b;
    for (let k = 1; k <= extras; k++) numero = numero * 64 + (bytes[p + 4 + k] & 0x3f);
    const codigoDoBloco = bytes[p + 2] >> 4;
    const fimDoCabecalho = p + 5 + extras + (codigoDoBloco === 6 ? 1 : codigoDoBloco === 7 ? 2 : 0);
    const crc8Certo = crcBitABit(bytes.subarray(p, fimDoCabecalho), 0x07, 8) === bytes[fimDoCabecalho];
    // O fim é o próximo ponto em que o CRC-16 confere (ou o fim do arquivo).
    let fim = -1;
    for (let q = fimDoCabecalho + 2; q <= bytes.length; q++) {
      if (q < bytes.length && !(bytes[q] === 0xff && (bytes[q + 1] & 0xfe) === 0xf8)) continue;
      const crc = (bytes[q - 2] << 8) | bytes[q - 1];
      if (crcBitABit(bytes.subarray(inicio, q - 2), 0x8005, 16) === crc) { fim = q; break; }
    }
    if (fim < 0) throw new Error(`quadro sem CRC-16 certo em ${inicio}`);
    quadros.push({ inicio, fim, numero, crc8Certo });
    p = fim;
  }
  const s = streaminfo!;
  const total = (s[13] & 0x0f) * 4294967296 + u32be(s, 14);
  return { streaminfo: s, tipos, total, quadros };
}

/** Os mesmos bytes? A comparação rápida (o toEqual do vitest anda elemento a elemento e leva segundos em megabytes). */
export function mesmosBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** As mesmas listas de pacotes (ou quadros), na mesma ordem. Na diferença, diz onde. */
export function mesmosPacotes(a: ArrayLike<number>[], b: ArrayLike<number>[]): string {
  if (a.length !== b.length) return `${a.length} pacotes, e não ${b.length}`;
  for (let i = 0; i < a.length; i++) if (!mesmosBytes(a[i], b[i])) return `o pacote ${i} difere`;
  return "iguais";
}
