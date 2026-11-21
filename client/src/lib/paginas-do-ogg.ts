import {
  ascii, crc32Ogg, limitesDoCorte, MontagemDaParte, u32le,
  type CodigoDaRecusaDoCorte, type OpcoesDoCorte, type ParteCortada,
} from "./corte-comum";
import { nivelDoOpus } from "./nivel-dos-quadros";
import { SEM_PAUSAS, type PausasDoCorte } from "./pausas-do-corte";

/**
 * As páginas do Ogg que os cortes escrevem (H9b do plano do gravador): as de
 * cabeçalho de cada parte (o corte do Ogg, lib/corte-do-ogg.ts) e as de áudio
 * do Opus que vem de outro contêiner (o WebM do Chrome, lib/corte-do-webm.ts),
 * remontado em Ogg Opus sem recodificar: o Ogg é o contêiner do Opus que o
 * Gemini lê (o WebM já voltou distorcido dele, ver a PR #158), o mesmo do
 * áudio do WhatsApp, e o servidor o mede pacote a pacote
 * (server/duracao-do-audio.ts).
 */

/** Amostras (a 48 kHz) de um pacote Opus, pelo byte TOC e o seguinte (RFC 6716, §3.1): a conta do servidor. */
export function amostrasOpus(toc: number, segundo: number, tamanho: number): number {
  if (tamanho < 1) return 0;
  const config = toc >> 3;
  const porQuadro = config < 12 ? [480, 960, 1920, 2880][config % 4]
    : config < 16 ? [480, 960][(config - 12) % 2]
    : [120, 240, 480, 960][(config - 16) % 4];
  const codigo = toc & 3;
  const quadros = codigo === 0 ? 1 : codigo !== 3 ? 2 : tamanho < 2 ? 0 : segundo & 0x3f;
  const amostras = quadros * porQuadro;
  // Acima de 120 ms o pacote é inválido, e o decodificador o descarta.
  return amostras > 5760 ? 0 : amostras;
}

/** O grânulo de 64 bits no cabeçalho da página (-1: nenhum pacote termina nela). */
export function escreverGranulo(cabecalho: Uint8Array, granulo: number) {
  if (granulo < 0) cabecalho.fill(0xff, 6, 14);
  else {
    cabecalho.set(u32le(granulo >>> 0), 6);
    cabecalho.set(u32le(Math.floor(granulo / 4294967296)), 10);
  }
}

/** Os pacotes de cabeçalho em páginas novas, com o CRC (o grânulo 0 de toda página de cabeçalho). */
export function paginar(pacotes: Uint8Array[], serial: number, seqInicial: number, bos: boolean): { bytes: Uint8Array<ArrayBuffer>; quantas: number } {
  const segmentos: Array<{ pacote: number; inicio: number; tamanho: number; fecha: boolean }> = [];
  pacotes.forEach((pacote, i) => {
    let inicio = 0;
    for (;;) {
      const tamanho = Math.min(255, pacote.length - inicio);
      segmentos.push({ pacote: i, inicio, tamanho, fecha: tamanho < 255 });
      inicio += tamanho;
      if (tamanho < 255) break;
    }
  });
  const paginas: number[][] = [];
  let continua = false;
  for (let s = 0; s < segmentos.length; s += 255) {
    const deste = segmentos.slice(s, s + 255);
    const h = new Uint8Array(27 + deste.length);
    h.set(ascii("OggS"), 0);
    h[5] = (continua ? 1 : 0) | (bos && !paginas.length ? 2 : 0);
    escreverGranulo(h, deste.some(x => x.fecha) ? 0 : -1);
    h.set(u32le(serial), 14);
    h.set(u32le(seqInicial + paginas.length), 18);
    h[26] = deste.length;
    deste.forEach((x, i) => { h[27 + i] = x.tamanho; });
    const corpo = deste.flatMap(x => Array.from(pacotes[x.pacote].subarray(x.inicio, x.inicio + x.tamanho)));
    const crc = crc32Ogg(corpo, 0, corpo.length, crc32Ogg(h));
    h.set(u32le(crc), 22);
    paginas.push([...Array.from(h), ...corpo]);
    continua = !deste[deste.length - 1].fecha;
  }
  return { bytes: Uint8Array.from(paginas.flat()), quantas: paginas.length };
}

/** As etiquetas vazias (OpusTags ou o comentário do Vorbis), com o nome do programa do arquivo, ou "WRW". */
export function etiquetasVazias(codec: "opus" | "vorbis", original?: Uint8Array): Uint8Array {
  const prefixo = codec === "opus" ? 8 : 7;
  const tamanhoDoNome = original && original.length >= prefixo + 4
    ? (original[prefixo] | (original[prefixo + 1] << 8) | (original[prefixo + 2] << 16) | (original[prefixo + 3] << 24)) >>> 0 : -1;
  const nome = original && tamanhoDoNome >= 0 && tamanhoDoNome <= 1024 && prefixo + 4 + tamanhoDoNome <= original.length
    ? Array.from(original.subarray(prefixo + 4, prefixo + 4 + tamanhoDoNome)) : ascii("WRW");
  const corpo = [...u32le(nome.length), ...nome, ...u32le(0)];
  return Uint8Array.from(codec === "opus" ? [...ascii("OpusTags"), ...corpo] : [0x03, ...ascii("vorbis"), ...corpo, 0x01]);
}

/** O número de série das páginas do Opus remontado: cada parte é um arquivo sozinho, e um número fixo basta. */
const SERIAL = 0x57525721;
/** Um pacote que não cabe numa página de 255 segmentos (~64 kB) não é Opus. */
export const PACOTE_OPUS_MAXIMO = 255 * 255 - 1;

type PacoteNaPagina = { posicao: number; tamanho: number };

/**
 * As partes em Ogg Opus de pacotes Opus que vêm de outro contêiner, pacote a
 * pacote: cada parte é o OpusHead do arquivo (com o pre-skip dele), etiquetas
 * vazias e as páginas de áudio, montadas aqui com o grânulo contado desde o 0
 * da parte (a soma das amostras pelo TOC), o fim do fluxo na última e o CRC.
 * O miolo de cada pacote vai do arquivo, por File.slice; os bytes do pacote
 * passam por aqui só para o CRC da página.
 */
export class PartesEmOggOpus {
  readonly partes: ParteCortada[] = [];
  private readonly limites: ReturnType<typeof limitesDoCorte>;
  /** A pausa da fala (lib/pausas-do-corte.ts): a parte fecha nela quando há uma perto do teto. */
  private readonly pausas: PausasDoCorte;
  private readonly cabecalho: Uint8Array<ArrayBuffer>;
  private readonly paginasDoCabecalho: number;
  private montagem: MontagemDaParte | null = null;
  private seq = 0;
  private amostrasDaParte = 0;
  private pacotesDaParte = 0;
  private bytesDaParte = 0;
  private amostrasNoTotal = 0;
  // A página aberta: os pacotes (onde estão no arquivo), a cópia dos bytes para o CRC e os laços.
  private pacotes: PacoteNaPagina[] = [];
  private corpo = new Uint8Array(64 * 1024);
  private usados = 0;
  private lacos: number[] = [];

  constructor(opusHead: Uint8Array, opcoes: OpcoesDoCorte) {
    this.limites = limitesDoCorte(opcoes);
    this.pausas = opcoes.pausas ?? SEM_PAUSAS;
    const primeira = paginar([opusHead], SERIAL, 0, true);
    const etiquetas = paginar([etiquetasVazias("opus")], SERIAL, primeira.quantas, false);
    this.cabecalho = Uint8Array.from([...Array.from(primeira.bytes), ...Array.from(etiquetas.bytes)]);
    this.paginasDoCabecalho = primeira.quantas + etiquetas.quantas;
  }

  /** O que a página aberta ocupa: o cabeçalho de 27 bytes, os laços e os pacotes. */
  private get bytesDaPaginaAberta() {
    return this.pacotes.length ? 27 + this.lacos.length + this.usados : 0;
  }

  /**
   * Um pacote Opus: onde está no arquivo e os bytes dele (só para o TOC e o
   * CRC). A parte fecha antes de passar dos 600 s ou dos 14 MB.
   */
  adicionar(posicao: number, bytes: Uint8Array): CodigoDaRecusaDoCorte | null {
    const tamanho = bytes.length;
    if (tamanho > PACOTE_OPUS_MAXIMO) return "DANIFICADO";
    const amostras = amostrasOpus(bytes[0] ?? 0, bytes[1] ?? 0, tamanho);
    if (this.amostrasNoTotal + amostras > this.limites.segundosNoTotal * 48000) return "LONGO_DEMAIS";
    const lacos = Math.floor(tamanho / 255) + 1;
    const abreOutra = this.lacos.length + lacos > 255 || this.usados + tamanho > this.corpo.length;
    const acrescimo = (abreOutra || !this.pacotes.length ? 27 : 0) + lacos + tamanho;
    if (this.montagem && this.pacotesDaParte > 0
      && (this.amostrasDaParte + amostras > this.limites.segundosPorParte * 48000 || this.bytesDaParte + this.bytesDaPaginaAberta + acrescimo > this.limites.bytesPorParte
        || this.pausas.antes(this.amostrasDaParte / 48, this.bytesDaParte + this.bytesDaPaginaAberta))) {
      this.fechar();
      if (this.partes.length >= this.limites.partesNoMaximo) return "MUITAS_PARTES";
    }
    if (!this.montagem) {
      this.montagem = new MontagemDaParte();
      this.montagem.novo(this.cabecalho);
      this.seq = this.paginasDoCabecalho;
      this.amostrasDaParte = 0;
      this.pacotesDaParte = 0;
      this.bytesDaParte = this.cabecalho.length;
    } else if (this.lacos.length + lacos > 255 || this.usados + tamanho > this.corpo.length) {
      this.fecharPagina(false);
    }
    for (let resto = tamanho; ; resto -= 255) {
      this.lacos.push(Math.min(255, resto));
      if (resto < 255) break;
    }
    if (this.usados + tamanho > this.corpo.length) {
      const maior = new Uint8Array(Math.max(this.corpo.length * 2, this.usados + tamanho));
      maior.set(this.corpo.subarray(0, this.usados));
      this.corpo = maior;
    }
    this.corpo.set(bytes, this.usados);
    this.usados += tamanho;
    this.pacotes.push({ posicao, tamanho });
    this.pacotesDaParte++;
    this.amostrasDaParte += amostras;
    this.amostrasNoTotal += amostras;
    // Os bytes como se o pacote abrisse uma página (o teto do que ele pode somar à parte).
    // O nível: a marca de voz do SILK, ou o tamanho no CELT (lib/nivel-dos-quadros.ts).
    this.pausas.depois(amostras / 48, 27 + lacos + tamanho, this.pausas.ouvindo ? nivelDoOpus(bytes, tamanho, amostras / 48) : 0);
    return null;
  }

  private fecharPagina(fimDoFluxo: boolean) {
    if (!this.pacotes.length || !this.montagem) return;
    const h = new Uint8Array(27 + this.lacos.length);
    h.set(ascii("OggS"), 0);
    h[5] = fimDoFluxo ? 4 : 0;
    escreverGranulo(h, this.amostrasDaParte);
    h.set(u32le(SERIAL), 14);
    h.set(u32le(this.seq++), 18);
    h[26] = this.lacos.length;
    h.set(this.lacos, 27);
    h.set(u32le(crc32Ogg(this.corpo, 0, this.usados, crc32Ogg(h))), 22);
    this.montagem.novo(h);
    for (const pacote of this.pacotes) this.montagem.doArquivo(pacote.posicao, pacote.posicao + pacote.tamanho);
    this.bytesDaParte += h.length + this.usados;
    this.pacotes = [];
    this.lacos = [];
    this.usados = 0;
  }

  /** Fecha a parte da vez: a última página leva o fim do fluxo. */
  fechar() {
    if (!this.montagem) return;
    this.fecharPagina(true);
    this.partes.push(this.montagem.fechar(Math.round(this.amostrasDaParte / 48)));
    this.montagem = null;
  }

  get duracaoMs() {
    return Math.round(this.amostrasNoTotal / 48);
  }
}
