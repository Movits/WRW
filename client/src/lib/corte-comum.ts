import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX, PARTES_POR_REUNIAO_MAX } from "@shared/const";

/**
 * O que os cortes da importação em partes têm em comum (H9a, H9b e H9c do
 * plano do gravador): a leitura do arquivo em blocos, a montagem de cada
 * parte, os tetos e os CRCs dos formatos que os pedem. O módulo não toca o
 * DOM: roda no Worker (workers/corte-do-arquivo.worker.ts), na página quando o
 * Worker não sobe e nos testes.
 *
 * Cada parte sai como uma receita, e não como os bytes: os trechos do próprio
 * arquivo (que a tela pega com File.slice, sem copiar o áudio para a memória)
 * e os bytes novos que o formato pede (o cabeçalho de cada parte, as páginas
 * do Ogg com o grânulo e o CRC refeitos, os quadros do FLAC renumerados). O
 * arquivo de horas nunca fica inteiro na memória.
 */

/** Lê os bytes de `inicio` até `fim` (sem incluir) do arquivo. */
export type LerBytes = (inicio: number, fim: number) => Promise<Uint8Array>;

/** O teto de cada parte do arquivo importado: o da parte da gravação (PARTE_SEGUNDOS). */
export const PARTE_SEGUNDOS_MAX = 600;
/**
 * 14 MB, e não os 15 do plano: cada parte vai ao Gemini inline, em base64 (um
 * terço a mais), e 14 MB viram 18,7 MB, abaixo dos 20 MB do pedido com áudio
 * inline. A rota das partes aceita até 16 MB (TAMANHO_MAXIMO_DA_PARTE).
 */
export const PARTE_BYTES_MAX = 14 * 1024 * 1024;

export type OpcoesDoCorte = {
  segundosPorParte?: number;
  bytesPorParte?: number;
  /** O teto da reunião: acima dele o corte recusa (LONGO_DEMAIS). */
  segundosNoTotal?: number;
  /** O teto de partes da reunião: acima dele o corte recusa (MUITAS_PARTES). */
  partesNoMaximo?: number;
  /** A leitura andou: quantos bytes do arquivo já foram lidos, de quantos. */
  aoLer?: (lidos: number, total: number) => void;
  sinal?: AbortSignal;
};

export function limitesDoCorte(opcoes: OpcoesDoCorte) {
  return {
    segundosPorParte: opcoes.segundosPorParte ?? PARTE_SEGUNDOS_MAX,
    bytesPorParte: opcoes.bytesPorParte ?? PARTE_BYTES_MAX,
    segundosNoTotal: opcoes.segundosNoTotal ?? GRAVACAO_EM_PARTES_SEGUNDOS_MAX,
    partesNoMaximo: opcoes.partesNoMaximo ?? PARTES_POR_REUNIAO_MAX,
  };
}

/** O erro do corte cancelado (AbortError, como o fetch). */
export function corteCancelado() {
  return new DOMException("Corte do arquivo cancelado.", "AbortError");
}

export function ehCorteCancelado(erro: unknown) {
  return erro instanceof DOMException && erro.name === "AbortError";
}

/** O leitor de um Blob (o File escolhido): o Worker e a página leem do mesmo jeito. */
export function lerBlob(blob: Blob): LerBytes {
  return async (inicio, fim) => new Uint8Array(await blob.slice(inicio, fim).arrayBuffer());
}

// ─── O resultado do corte ────────────────────────────────────────────────────

/**
 * Uma parte cortada: os bytes novos dela, um atrás do outro, e a ordem de
 * montagem, de três em três números ([origem, início, fim]): origem 0 é o
 * trecho de `novos`; origem 1, o trecho do arquivo. Os dois são arrays
 * tipados, que o Worker devolve à página sem custo.
 */
export type ParteCortada = { novos: Uint8Array<ArrayBuffer>; ordem: Float64Array; bytes: number; duracaoMs: number };

export type FormatoDoArquivo = "mp3" | "aac" | "wav" | "flac" | "ogg" | "webm" | "mp4";
/** O tipo de cada parte, como vai à rota das partes (server/fatias-de-reuniao.ts, TIPOS_DAS_PARTES). */
export type TipoDaParte = "audio/mpeg" | "audio/aac" | "audio/wav" | "audio/flac" | "audio/ogg" | "audio/webm" | "audio/mp4";

/**
 * Por que o corte recusou, antes de a reunião nascer:
 * - FORMATO_DESCONHECIDO: não é áudio nem vídeo que o corte reconheça;
 * - SEM_SUPORTE: o contêiner é conhecido, mas o áudio dentro dele não (ALAC,
 *   AC-3...), e `detalhe` diz qual;
 * - SEM_AUDIO: o vídeo não tem faixa de áudio;
 * - DANIFICADO: o formato é conhecido, mas a estrutura não se lê (o MP4 sem o
 *   índice, de uma gravação interrompida; o MP3 que é só lixo);
 * - LONGO_DEMAIS: passa de 12 h, o teto da reunião;
 * - MUITAS_PARTES: passaria de 200 partes de 14 MB (o WAV e o FLAC de horas).
 */
export type CodigoDaRecusaDoCorte = "FORMATO_DESCONHECIDO" | "SEM_SUPORTE" | "SEM_AUDIO" | "DANIFICADO" | "LONGO_DEMAIS" | "MUITAS_PARTES";
export type RecusaDoCorte = { ok: false; codigo: CodigoDaRecusaDoCorte; formato?: FormatoDoArquivo; detalhe?: string };
export type CorteDoArquivo =
  | { ok: true; formato: FormatoDoArquivo; mimeType: TipoDaParte; partes: ParteCortada[]; duracaoMs: number }
  | RecusaDoCorte;

export const recusa = (codigo: CodigoDaRecusaDoCorte, formato?: FormatoDoArquivo, detalhe?: string): RecusaDoCorte =>
  ({ ok: false, codigo, ...(formato ? { formato } : {}), ...(detalhe ? { detalhe } : {}) });

/**
 * A montagem de uma parte: bytes novos e trechos do arquivo, na ordem. Os
 * pedaços vizinhos da mesma origem se juntam: o MP3 cortado nos quadros vira
 * uma faixa só, e o cabeçalho novo seguido do CRC do quadro anterior, um
 * trecho só de `novos`.
 */
export class MontagemDaParte {
  private novos = new Uint8Array(4096);
  private usados = 0;
  private ordem: number[] = [];
  bytes = 0;

  private crescer(n: number) {
    if (this.usados + n <= this.novos.length) return;
    const maior = new Uint8Array(Math.max(this.novos.length * 2, this.usados + n));
    maior.set(this.novos.subarray(0, this.usados));
    this.novos = maior;
  }

  /** Reserva `n` bytes novos (zerados) no fim da parte e devolve onde ficam, para escrever depois (o tamanho que só se sabe no fim). */
  reservar(n: number): number {
    this.crescer(n);
    const em = this.usados;
    this.usados += n;
    this.bytes += n;
    const k = this.ordem.length;
    if (k && this.ordem[k - 3] === 0 && this.ordem[k - 1] === em) this.ordem[k - 1] = em + n;
    else this.ordem.push(0, em, em + n);
    return em;
  }

  /** Acrescenta bytes novos; devolve onde ficaram. */
  novo(dados: ArrayLike<number>): number {
    const em = this.reservar(dados.length);
    this.novos.set(dados, em);
    return em;
  }

  /** Reescreve bytes novos já reservados. */
  escrever(em: number, dados: ArrayLike<number>) {
    this.novos.set(dados, em);
  }

  /** Acrescenta o trecho [inicio, fim) do arquivo. */
  doArquivo(inicio: number, fim: number) {
    if (fim <= inicio) return;
    const k = this.ordem.length;
    if (k && this.ordem[k - 3] === 1 && this.ordem[k - 1] === inicio) this.ordem[k - 1] = fim;
    else this.ordem.push(1, inicio, fim);
    this.bytes += fim - inicio;
  }

  fechar(duracaoMs: number): ParteCortada {
    return { novos: this.novos.slice(0, this.usados), ordem: Float64Array.from(this.ordem), bytes: this.bytes, duracaoMs };
  }
}

/** A parte como Blob: os bytes novos e os File.slice do arquivo, sem ler o áudio. */
export function montarParte(arquivo: Blob, parte: ParteCortada, tipo: string): Blob {
  const pedacos: BlobPart[] = [];
  for (let i = 0; i < parte.ordem.length; i += 3) {
    const inicio = parte.ordem[i + 1];
    const fim = parte.ordem[i + 2];
    pedacos.push(parte.ordem[i] === 0 ? parte.novos.subarray(inicio, fim) : arquivo.slice(inicio, fim));
  }
  return new Blob(pedacos, { type: tipo });
}

// ─── A leitura em janela ─────────────────────────────────────────────────────

const BLOCO = 4 * 1024 * 1024;

/**
 * A janela do arquivo que está na memória: um bloco lido a partir de onde o
 * corte ainda precisa. Fora dela, os bytes valem -1.
 */
export class LeitorEmJanela {
  private bytes: Uint8Array = new Uint8Array(0);
  private origem = 0;
  private avisado = 0;

  constructor(
    private readonly ler: LerBytes,
    readonly tamanho: number,
    private readonly opcoes: Pick<OpcoesDoCorte, "aoLer" | "sinal"> = {},
    private readonly bloco = BLOCO,
  ) {}

  get fim() {
    return this.origem + this.bytes.length;
  }

  /**
   * Garante na memória de `inicio` até `fim` (ou até o fim do arquivo),
   * lendo a partir de `inicio` ao menos um bloco se faltar. Devolve se o
   * arquivo tem mesmo esses bytes todos.
   */
  async garantir(inicio: number, fim: number): Promise<boolean> {
    if (this.opcoes.sinal?.aborted) throw corteCancelado();
    const ate = Math.min(fim, this.tamanho);
    if (inicio < this.origem || ate > this.fim) {
      const leitura = Math.min(this.tamanho, Math.max(ate, inicio + this.bloco));
      const lidos = leitura > inicio ? await this.ler(inicio, leitura) : new Uint8Array(0);
      if (lidos.length !== Math.max(0, leitura - inicio)) throw new Error("Leitura incompleta do arquivo.");
      this.bytes = lidos;
      this.origem = inicio;
      if (leitura > this.avisado) {
        this.avisado = leitura;
        this.opcoes.aoLer?.(leitura, this.tamanho);
      }
    }
    return fim <= this.tamanho;
  }

  /** A janela já tem de `inicio` até `fim` (ou até o fim do arquivo)? Sem esperar: o caminho rápido de quem lê elemento a elemento. */
  coberto(inicio: number, fim: number): boolean {
    return inicio >= this.origem && Math.min(fim, this.tamanho) <= this.fim;
  }

  /** O byte na posição `p` do arquivo, ou -1 fora da janela. */
  b(p: number): number {
    const i = p - this.origem;
    return i >= 0 && i < this.bytes.length ? this.bytes[i] : -1;
  }

  u16be(p: number) { return (this.b(p) << 8) | this.b(p + 1); }
  u16le(p: number) { return this.b(p) | (this.b(p + 1) << 8); }
  u24be(p: number) { return (this.b(p) << 16) | (this.b(p + 1) << 8) | this.b(p + 2); }
  u32be(p: number) { return ((this.b(p) << 24) | (this.b(p + 1) << 16) | (this.b(p + 2) << 8) | this.b(p + 3)) >>> 0; }
  u32le(p: number) { return (this.b(p) | (this.b(p + 1) << 8) | (this.b(p + 2) << 16) | (this.b(p + 3) << 24)) >>> 0; }
  u64be(p: number) { return this.u32be(p) * 4294967296 + this.u32be(p + 4); }

  /** Os bytes em `p` são este texto ASCII? */
  igual(p: number, texto: string): boolean {
    for (let i = 0; i < texto.length; i++) if (this.b(p + i) !== texto.charCodeAt(i)) return false;
    return true;
  }

  ascii(p: number, n: number): string {
    let texto = "";
    for (let i = 0; i < n; i++) {
      const c = this.b(p + i);
      if (c < 0) break;
      texto += String.fromCharCode(c);
    }
    return texto;
  }

  /** Os bytes de `inicio` a `fim`, sem cópia (precisam estar na janela). */
  trecho(inicio: number, fim: number): Uint8Array {
    if (inicio < this.origem || fim > this.fim) throw new Error("Trecho fora da janela de leitura.");
    return this.bytes.subarray(inicio - this.origem, fim - this.origem);
  }

  /** O próximo `byte` a partir de `desde`, dentro da janela, ou -1. */
  procurar(byte: number, desde: number): number {
    const i = this.bytes.indexOf(byte, Math.max(0, desde - this.origem));
    return i < 0 ? -1 : i + this.origem;
  }
}

// ─── Números em bytes ────────────────────────────────────────────────────────

export const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
export const u24be = (n: number) => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const u64be = (n: number) => [...u32be(Math.floor(n / 4294967296)), ...u32be(n >>> 0)];
export const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
export const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
export const ascii = (texto: string) => Array.from(texto, c => c.charCodeAt(0) & 0xff);

// ─── CRCs ────────────────────────────────────────────────────────────────────

/** A tabela de um CRC sem reflexão, de `largura` bits (8, 16 ou 32). */
function tabelaDoCrc(polinomio: number, largura: number): Uint32Array {
  const tabela = new Uint32Array(256);
  const alto = 2 ** (largura - 1);
  const mascara = 2 ** largura - 1;
  for (let i = 0; i < 256; i++) {
    let c = i * 2 ** (largura - 8);
    // O XOR do JavaScript devolve inteiro com sinal: o >>> 0 mantém o valor sem sinal no CRC-32.
    for (let k = 0; k < 8; k++) c = c >= alto ? (((c - alto) * 2) ^ polinomio) >>> 0 : c * 2;
    tabela[i] = (c & mascara) >>> 0;
  }
  return tabela;
}

const CRC8 = tabelaDoCrc(0x07, 8);
const CRC16 = tabelaDoCrc(0x8005, 16);
const CRC32 = tabelaDoCrc(0x04c11db7, 32);

/** O CRC-8 do cabeçalho do quadro FLAC (polinômio 0x07, começo 0). */
export function crc8Flac(bytes: ArrayLike<number>, inicio = 0, fim = bytes.length, crc = 0): number {
  for (let i = inicio; i < fim; i++) crc = CRC8[crc ^ bytes[i]];
  return crc;
}

/** O CRC-16 do quadro FLAC inteiro (polinômio 0x8005, começo 0). */
export function crc16Flac(bytes: ArrayLike<number>, inicio = 0, fim = bytes.length, crc = 0): number {
  for (let i = inicio; i < fim; i++) crc = ((crc << 8) ^ CRC16[(crc >>> 8) ^ bytes[i]]) & 0xffff;
  return crc;
}

/** O CRC-32 da página Ogg (polinômio 0x04C11DB7, começo 0, sem reflexão). */
export function crc32Ogg(bytes: ArrayLike<number>, inicio = 0, fim = bytes.length, crc = 0): number {
  for (let i = inicio; i < fim; i++) crc = ((crc << 8) ^ CRC32[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}
