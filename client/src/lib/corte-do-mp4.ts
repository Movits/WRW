import { createFile, MP4BoxBuffer, type ISOFile } from "mp4box";
import {
  ascii, corteCancelado, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa,
  type CodigoDaRecusaDoCorte, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada,
} from "./corte-comum";

/**
 * O corte do MP4, do M4A e do MOV (H9c do plano do gravador): o M4A do
 * Gravador do iPhone, o MP4 do Zoom e o MOV da câmera do iPhone. Só o áudio
 * sai do aparelho: do vídeo, nenhum byte é lido além dos índices.
 *
 * - O `moov` (o índice do arquivo) é achado pelas caixas do nível de cima, só
 *   pelos cabeçalhos, com File.slice: o `mdat` de horas de vídeo é pulado pelo
 *   tamanho. O mp4box lê o `moov` (e, no MP4 fragmentado, cada `moof`), e daí
 *   saem a faixa de áudio AAC, a configuração dela (o AudioSpecificConfig) e a
 *   tabela de amostras: onde cada quadro AAC está no arquivo e quanto dura.
 * - Cada parte é um MP4 fragmentado de um fragmento só, montado aqui, sem
 *   recodificar: o `ftyp`, um `moov` novo só com a faixa de áudio (a entrada
 *   `mp4a` refeita no formato ISO, com o `esds` e o AudioSpecificConfig do
 *   arquivo), um `moof` com o `tfdt` em 0 (a parte começa no tempo 0) e o
 *   `trun` com o tamanho de cada quadro, e o `mdat` com os quadros do próprio
 *   arquivo, por File.slice. É o formato que o Safari grava, que o servidor
 *   mede (server/duracao-do-audio.ts, quadros do `trun` × 1024 ÷ a taxa do
 *   AudioSpecificConfig, a mesma conta daqui) e que o Gemini transcreve.
 * - Só o AAC tem suporte (LC, HE-AAC, HE-AAC v2, Main, LTP e LD, os que o
 *   servidor mede): ALAC, AC-3, Opus, PCM e os outros ganham a recusa
 *   SEM_SUPORTE com o nome do formato. O vídeo sem faixa de áudio recusa com
 *   SEM_AUDIO; o arquivo sem o `moov` (a gravação interrompida), DANIFICADO.
 * - A lista de edição (`elst`) não vale para as partes: o atraso do
 *   codificador (~46 ms de silêncio) fica no começo da primeira.
 */

type Moov = ISOFile["moov"];
type Trak = Moov["traks"][number];
type Moof = ISOFile["moofs"][number];
type Entrada = Trak["mdia"]["minf"]["stbl"]["stsd"]["entries"][number];

const TAXAS_AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/**
 * Os tipos de objeto de áudio MPEG-4 com suporte: o AAC Main (1), LC (2), LTP
 * (4), ER LC (17) e LD (23), sozinhos ou dentro do SBR (5, o HE-AAC) e do PS
 * (29, o HE-AAC v2). Todos estão entre os que o servidor mede
 * (AAC_COM_QUADRO_FIXO em server/duracao-do-audio.ts) e o decodificador lê.
 */
const OBJETOS_AAC = new Set([1, 2, 4, 17, 23]);
/** Os tipos de objeto (`oti`) do esds que levam AAC: o MPEG-4 e os três perfis do MPEG-2. */
const OTI_AAC = new Set([0x40, 0x66, 0x67, 0x68]);
const NOMES_DOS_CODECS: Record<string, string> = {
  alac: "ALAC", "ac-3": "AC-3", "ec-3": "E-AC-3", "ac-4": "AC-4", Opus: "Opus", fLaC: "FLAC", ".mp3": "MP3", samr: "AMR", sawb: "AMR-WB",
  lpcm: "PCM", ipcm: "PCM", fpcm: "PCM", sowt: "PCM", twos: "PCM", in24: "PCM", in32: "PCM", fl32: "PCM", fl64: "PCM", "raw ": "PCM", NONE: "PCM",
  ulaw: "µ-law", alaw: "A-law", ima4: "IMA ADPCM", enca: "DRM", dtsc: "DTS", dtsh: "DTS", dtsl: "DTS", mha1: "MPEG-H", mhm1: "MPEG-H",
};
const NOMES_DOS_OBJETOS: Record<number, string> = { 3: "AAC SSR", 39: "AAC-ELD", 42: "xHE-AAC" };

/** O cabeçalho de cada caixa do nível de cima, lido em blocos pequenos: pular o `mdat` não lê o vídeo. */
const BLOCO_DO_TOPO = 64 * 1024;
/** Um `moov` maior que isto não é de gravação (o de 12 h de vídeo a 60 quadros por segundo tem ~25 MB). */
const MOOV_MAXIMO = 64 * 1024 * 1024;
/** Um `moof` maior que isto também não. */
const MOOF_MAXIMO = 16 * 1024 * 1024;
/** Caixas no nível de cima: o MP4 fragmentado de 12 h em fragmentos de 250 ms tem ~350 mil. */
const CAIXAS_DO_TOPO_MAXIMAS = 1_000_000;
/** Um quadro AAC tem no máximo 768 bytes por canal; acima disto a tabela não é de AAC. */
const AMOSTRA_MAXIMA = 64 * 1024;
const TIPO_DE_CAIXA = /^[\x20-\x7e]{4}$/;

type CaixaDoTopo = { tipo: string; inicio: number; cabecalho: number; fim: number; truncada: boolean };

/** A configuração do AAC, lida do AudioSpecificConfig. `taxa` é a do núcleo AAC, a dos quadros (no HE-AAC, metade da que toca). */
export type ConfigAac = { objeto: number; taxa: number; quadro: number; canais: number };

/** Lê o AudioSpecificConfig (ISO 14496-3, §1.6.2.1): o tipo de objeto, a taxa dos quadros, os canais e o tamanho do quadro. */
export function lerConfigAac(asc: Uint8Array): ConfigAac | null {
  let bit = 0;
  const bits = (n: number) => {
    let valor = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >> 3 >= asc.length) throw new Error("fim do AudioSpecificConfig");
      valor = valor * 2 + ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return valor;
  };
  const tipo = () => { const t = bits(5); return t === 31 ? 32 + bits(6) : t; };
  try {
    let objeto = tipo();
    const indice = bits(4);
    const taxa = indice === 15 ? bits(24) : TAXAS_AAC[indice] ?? 0;
    const canais = bits(4);
    // SBR e PS explícitos: a taxa lida acima é a do núcleo AAC; vem depois a do SBR e o tipo do núcleo.
    if (objeto === 5 || objeto === 29) {
      if (bits(4) === 15) bits(24);
      objeto = tipo();
    }
    if (!(taxa > 0)) return null;
    if (!OBJETOS_AAC.has(objeto)) return { objeto, taxa, quadro: 0, canais };
    const curto = bits(1) === 1;
    return { objeto, taxa, quadro: objeto === 23 ? (curto ? 480 : 512) : curto ? 960 : 1024, canais };
  } catch {
    return null;
  }
}

// ─── A escrita das caixas ────────────────────────────────────────────────────

/** Bytes que crescem, com as caixas do MP4 (tamanho de 32 bits escrito no fim de cada uma). */
class Escrita {
  private b = new Uint8Array(1024);
  n = 0;

  private crescer(k: number) {
    if (this.n + k <= this.b.length) return;
    const maior = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    maior.set(this.b.subarray(0, this.n));
    this.b = maior;
  }

  u8(v: number) { this.crescer(1); this.b[this.n++] = v & 0xff; return this; }
  u16(v: number) { return this.u8(v >>> 8).u8(v); }
  u24(v: number) { return this.u8(v >>> 16).u8(v >>> 8).u8(v); }
  u32(v: number) { return this.u16(v >>> 16).u16(v & 0xffff); }
  u64(v: number) { return this.u32(Math.floor(v / 4294967296)).u32(v >>> 0); }
  bytes(dados: ArrayLike<number>) { this.crescer(dados.length); this.b.set(dados, this.n); this.n += dados.length; return this; }
  texto(texto: string) { return this.bytes(ascii(texto)); }
  zeros(k: number) { this.crescer(k); this.b.fill(0, this.n, this.n + k); this.n += k; return this; }

  /** Uma caixa: o tamanho (escrito no fim), o tipo, a versão e as flags (se for FullBox) e o corpo. */
  caixa(tipo: string, corpo: () => void, cheia?: { versao: number; flags: number }) {
    const inicio = this.n;
    this.u32(0).texto(tipo);
    if (cheia) this.u8(cheia.versao).u24(cheia.flags);
    corpo();
    const tamanho = this.n - inicio;
    this.b[inicio] = tamanho >>> 24;
    this.b[inicio + 1] = (tamanho >>> 16) & 0xff;
    this.b[inicio + 2] = (tamanho >>> 8) & 0xff;
    this.b[inicio + 3] = tamanho & 0xff;
    return this;
  }

  get resultado(): Uint8Array<ArrayBuffer> {
    return this.b.slice(0, this.n);
  }
}

/** Um descritor MPEG-4 (do esds): a etiqueta, o tamanho em 7 bits por byte e o corpo. */
function descritor(etiqueta: number, corpo: number[]): number[] {
  const tamanho: number[] = [corpo.length & 0x7f];
  for (let resto = corpo.length >>> 7; resto > 0; resto >>>= 7) tamanho.unshift(0x80 | (resto & 0x7f));
  return [etiqueta, ...tamanho, ...corpo];
}

const MATRIZ = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

export type FaixaAac = {
  asc: Uint8Array;
  config: ConfigAac;
  /** A escala de tempo da faixa (o `mdhd`), em que as durações das amostras estão. */
  escala: number;
  canais: number;
  taxaDaEntrada: number;
  bitrateMedio: number;
  bitrateMaximo: number;
};

/** O começo de toda parte: o `ftyp` e o `moov` só com a faixa de áudio, sem amostras (estão no fragmento). */
export function inicioDoFmp4(faixa: FaixaAac, duracaoNaEscala: number): Uint8Array<ArrayBuffer> {
  const e = new Escrita();
  e.caixa("ftyp", () => { e.texto("iso6").u32(0).texto("iso6").texto("iso5").texto("mp41"); });
  e.caixa("moov", () => {
    e.caixa("mvhd", () => {
      e.u32(0).u32(0).u32(faixa.escala).u32(0).u32(0x00010000).u16(0x0100).zeros(10);
      for (const m of MATRIZ) e.u32(m);
      e.zeros(24).u32(2);
    }, { versao: 0, flags: 0 });
    e.caixa("trak", () => {
      e.caixa("tkhd", () => {
        e.u32(0).u32(0).u32(1).u32(0).u32(0).zeros(8).u16(0).u16(0).u16(0x0100).u16(0);
        for (const m of MATRIZ) e.u32(m);
        e.u32(0).u32(0);
      }, { versao: 0, flags: 3 });
      e.caixa("mdia", () => {
        e.caixa("mdhd", () => { e.u32(0).u32(0).u32(faixa.escala).u32(0).u16(0x55c4).u16(0); }, { versao: 0, flags: 0 });
        e.caixa("hdlr", () => { e.u32(0).texto("soun").zeros(12).texto("SoundHandler").u8(0); }, { versao: 0, flags: 0 });
        e.caixa("minf", () => {
          e.caixa("smhd", () => { e.u16(0).u16(0); }, { versao: 0, flags: 0 });
          e.caixa("dinf", () => {
            e.caixa("dref", () => { e.u32(1).caixa("url ", () => {}, { versao: 0, flags: 1 }); }, { versao: 0, flags: 0 });
          });
          e.caixa("stbl", () => {
            e.caixa("stsd", () => {
              e.u32(1).caixa("mp4a", () => {
                e.zeros(6).u16(1).zeros(8).u16(faixa.canais).u16(16).u16(0).u16(0).u32(faixa.taxaDaEntrada <= 0xffff ? faixa.taxaDaEntrada * 65536 : 0);
                e.caixa("esds", () => {
                  const configDoDecodificador = descritor(4, [
                    0x40, 0x15, 0, 0, 0,
                    ...[24, 16, 8, 0].map(d => (faixa.bitrateMaximo >>> d) & 0xff),
                    ...[24, 16, 8, 0].map(d => (faixa.bitrateMedio >>> d) & 0xff),
                    ...descritor(5, Array.from(faixa.asc)),
                  ]);
                  e.bytes(descritor(3, [0, 1, 0, ...configDoDecodificador, ...descritor(6, [2])]));
                }, { versao: 0, flags: 0 });
              });
            }, { versao: 0, flags: 0 });
            e.caixa("stts", () => { e.u32(0); }, { versao: 0, flags: 0 });
            e.caixa("stsc", () => { e.u32(0); }, { versao: 0, flags: 0 });
            e.caixa("stsz", () => { e.u32(0).u32(0); }, { versao: 0, flags: 0 });
            e.caixa("stco", () => { e.u32(0); }, { versao: 0, flags: 0 });
          });
        });
      });
    });
    e.caixa("mvex", () => {
      e.caixa("mehd", () => { e.u32(duracaoNaEscala); }, { versao: 0, flags: 0 });
      e.caixa("trex", () => { e.u32(1).u32(1).u32(0).u32(0).u32(0); }, { versao: 0, flags: 0 });
    });
  });
  return e.resultado;
}

/**
 * O fragmento da parte: o `moof` (com o `tfdt` em 0 e o `trun` com o tamanho
 * de cada quadro e, se variam, as durações) e o cabeçalho do `mdat`, cujos
 * bytes vêm do arquivo. `duracoes` de um número só é a duração de todas.
 */
export function fragmentoDoFmp4(tamanhos: ArrayLike<number>, duracoes: ArrayLike<number> | number, bytesDoMdat: number): Uint8Array<ArrayBuffer> {
  const n = tamanhos.length;
  const constante = typeof duracoes === "number";
  const e = new Escrita();
  let deslocamentoEm = 0;
  e.caixa("moof", () => {
    e.caixa("mfhd", () => { e.u32(1); }, { versao: 0, flags: 0 });
    e.caixa("traf", () => {
      // default-base-is-moof (0x020000) e, com a duração constante, a padrão (0x08).
      e.caixa("tfhd", () => { e.u32(1); if (constante) e.u32(duracoes); }, { versao: 0, flags: 0x020000 | (constante ? 0x08 : 0) });
      e.caixa("tfdt", () => { e.u64(0); }, { versao: 1, flags: 0 });
      // data-offset (0x01), tamanho por amostra (0x200) e, sem a constante, a duração por amostra (0x100).
      e.caixa("trun", () => {
        e.u32(n);
        deslocamentoEm = e.n;
        e.u32(0);
        for (let i = 0; i < n; i++) {
          if (!constante) e.u32((duracoes as ArrayLike<number>)[i]);
          e.u32(tamanhos[i]);
        }
      }, { versao: 0, flags: 0x01 | 0x200 | (constante ? 0 : 0x100) });
    });
  });
  // O data_offset conta do começo do moof até o primeiro byte do áudio, depois do cabeçalho do mdat.
  const moof = e.n;
  e.u32(8 + bytesDoMdat).texto("mdat");
  const bytes = e.resultado;
  new DataView(bytes.buffer).setUint32(deslocamentoEm, moof + 8);
  return bytes;
}

/** O tamanho do `moof` de `n` quadros (o que fragmentoDoFmp4 escreve, sem o cabeçalho do mdat). */
const tamanhoDoMoof = (n: number, constante: boolean) => 88 + (constante ? 4 : 0) + n * (constante ? 4 : 8);

/**
 * As partes em MP4 fragmentado de uma faixa AAC, quadro a quadro: cada quadro
 * (onde está no arquivo, o tamanho e a duração na escala da faixa) entra na
 * parte da vez, e a parte fecha antes de passar dos 600 s ou dos 14 MB. Serve
 * ao MP4 e ao AAC de dentro do Matroska.
 */
export class PartesEmFmp4 {
  readonly partes: ParteCortada[] = [];
  private readonly limites: ReturnType<typeof limitesDoCorte>;
  /** O tamanho do começo de cada parte (ftyp e moov), que não muda de uma parte para outra. */
  private readonly bytesDoInicio: number;
  private posicoes: number[] = [];
  private tamanhos: number[] = [];
  private duracoes: number[] = [];
  private bytesDoMdat = 0;
  private constante = true;
  private quadrosNoTotal = 0;

  constructor(private readonly faixa: FaixaAac, opcoes: OpcoesDoCorte) {
    this.limites = limitesDoCorte(opcoes);
    this.bytesDoInicio = inicioDoFmp4(faixa, 0).length;
  }

  /**
   * Os tetos de tempo em amostras do áudio (quadros × amostras por quadro
   * contra segundos × taxa), em inteiros: em ponto flutuante, 28.125 quadros
   * de 1.024 amostras a 48 kHz passavam dos 600 s por um bilionésimo.
   */
  private passa(quadros: number, segundos: number) {
    return quadros * this.faixa.config.quadro > segundos * this.faixa.config.taxa;
  }

  /** Um quadro AAC: começo e tamanho no arquivo e a duração na escala da faixa. */
  adicionar(posicao: number, tamanho: number, duracao: number): CodigoDaRecusaDoCorte | null {
    if (this.passa(this.quadrosNoTotal + 1, this.limites.segundosNoTotal)) return "LONGO_DEMAIS";
    const n = this.tamanhos.length;
    if (n) {
      const constante = this.constante && duracao === this.duracoes[0];
      const bytes = this.bytesDoInicio + tamanhoDoMoof(n + 1, constante) + 8 + this.bytesDoMdat + tamanho;
      if (this.passa(n + 1, this.limites.segundosPorParte) || bytes > this.limites.bytesPorParte) {
        this.fechar();
        if (this.partes.length >= this.limites.partesNoMaximo) return "MUITAS_PARTES";
      }
    }
    this.constante = this.tamanhos.length === 0 || (this.constante && duracao === this.duracoes[0]);
    this.posicoes.push(posicao);
    this.tamanhos.push(tamanho);
    this.duracoes.push(duracao);
    this.bytesDoMdat += tamanho;
    this.quadrosNoTotal++;
    return null;
  }

  private ms(quadros: number) {
    return Math.round((quadros * this.faixa.config.quadro * 1000) / this.faixa.config.taxa);
  }

  /** Fecha a parte da vez (se tiver quadros). */
  fechar() {
    const n = this.tamanhos.length;
    if (!n) return;
    const montagem = new MontagemDaParte();
    // O mehd diz a duração da parte, na escala da faixa: o leitor a sabe sem percorrer o fragmento.
    montagem.novo(inicioDoFmp4(this.faixa, this.duracoes.reduce((soma, d) => soma + d, 0)));
    montagem.novo(fragmentoDoFmp4(this.tamanhos, this.constante ? this.duracoes[0] : this.duracoes, this.bytesDoMdat));
    for (let i = 0; i < n; i++) montagem.doArquivo(this.posicoes[i], this.posicoes[i] + this.tamanhos[i]);
    this.partes.push(montagem.fechar(this.ms(n)));
    this.posicoes = [];
    this.tamanhos = [];
    this.duracoes = [];
    this.bytesDoMdat = 0;
  }

  get duracaoMs() {
    return this.ms(this.quadrosNoTotal);
  }
}

// ─── A leitura ───────────────────────────────────────────────────────────────

/** As caixas de `bytes` lidas pelo mp4box (sem montar as listas de amostras, que ele faria para cada faixa, inclusive a do vídeo). */
function lerComMp4box(bytes: Uint8Array): ISOFile {
  const iso = createFile(false);
  // Os erros do mp4box viram a falta da caixa, que o corte recusa; o console fica limpo.
  iso.onError = () => {};
  const copia = new Uint8Array(bytes.length);
  copia.set(bytes);
  iso.checkBuffer(MP4BoxBuffer.fromArrayBuffer(copia.buffer, 0));
  iso.parse();
  return iso;
}

/** A primeira entrada de amostra da faixa, ou null. */
const entradaDe = (trak: Trak): Entrada | null => trak.mdia?.minf?.stbl?.stsd?.entries?.[0] ?? null;

type Escolhida = { trak: Trak; faixa: FaixaAac };

/** A faixa de áudio AAC (a primeira ligada, se houver mais de uma); ou o porquê de não haver. */
function escolherFaixa(moov: Moov): Escolhida | { codigo: "SEM_AUDIO" | "SEM_SUPORTE" | "DANIFICADO"; detalhe?: string } {
  const audios = (moov.traks ?? []).filter(t => t.mdia?.hdlr?.handler === "soun");
  if (!audios.length) return { codigo: "SEM_AUDIO" };
  // As ligadas primeiro (bit 1 das flags do tkhd), na ordem do arquivo.
  const ligada = (t: Trak) => ((t.tkhd?.flags ?? 0) & 1) === 1;
  const ordem = [...audios.filter(ligada), ...audios.filter(t => !ligada(t))];
  let semSuporte: string | null = null;
  for (const trak of ordem) {
    const entrada = entradaDe(trak);
    const escala = trak.mdia?.mdhd?.timescale ?? 0;
    if (!entrada || !(escala > 0)) continue;
    if (entrada.type !== "mp4a") {
      semSuporte ??= NOMES_DOS_CODECS[entrada.type] ?? (entrada.type.trim() || "?");
      continue;
    }
    const audio = entrada as unknown as EntradaMp4a;
    const esd = audio.esds?.esd ?? audio.wave?.esds?.esd;
    const decodificador = esd?.findDescriptor(4) as DescritorDoDecodificador | undefined;
    if (!decodificador || !OTI_AAC.has(decodificador.oti ?? 0)) {
      semSuporte ??= decodificador?.oti === 0x69 || decodificador?.oti === 0x6b ? "MP3" : "MPEG-4";
      continue;
    }
    const asc = decodificador.findDescriptor(5)?.data;
    const config = asc ? lerConfigAac(asc) : null;
    if (!asc || !config) continue;
    if (!config.quadro) {
      semSuporte ??= NOMES_DOS_OBJETOS[config.objeto] ?? `AAC (${config.objeto})`;
      continue;
    }
    const porConfig = config.canais === 7 ? 8 : config.canais;
    return {
      trak,
      faixa: {
        asc: Uint8Array.from(asc),
        config,
        escala,
        canais: porConfig || audio.channel_count || 2,
        taxaDaEntrada: Math.round(audio.samplerate ?? 0) || config.taxa,
        bitrateMedio: decodificador.avgBitrate ?? 0,
        bitrateMaximo: decodificador.maxBitrate ?? 0,
      },
    };
  }
  return semSuporte ? { codigo: "SEM_SUPORTE", detalhe: semSuporte } : { codigo: "DANIFICADO" };
}

/** O que o corte lê da entrada `mp4a` e do esds dela (o mp4box tipa os descritores como `any`). */
type EsDescriptor = { findDescriptor(tag: number): unknown };
type EntradaMp4a = { esds?: { esd?: EsDescriptor }; wave?: { esds?: { esd?: EsDescriptor } }; channel_count?: number; samplerate?: number };
type DescritorDoDecodificador = { oti?: number; avgBitrate?: number; maxBitrate?: number; findDescriptor(tag: number): { data?: Uint8Array } | undefined };

/**
 * Os quadros da tabela do `moov` (stsc, stco/co64, stsz/stz2 e stts), na
 * ordem, sem montar um objeto por quadro. Para no primeiro que passa do fim do
 * arquivo (a gravação cortada no meio).
 */
function quadrosDaTabela(trak: Trak, tamanhoDoArquivo: number, aoQuadro: (posicao: number, tamanho: number, duracao: number) => CodigoDaRecusaDoCorte | null): CodigoDaRecusaDoCorte | null {
  const stbl = trak.mdia.minf.stbl;
  const stsz = stbl.stsz;
  const fixo = stsz?.sample_size ?? 0;
  const tamanhos = stsz ? stsz.sample_sizes : stbl.stz2?.sample_sizes ?? [];
  const total = stsz ? stsz.sample_count : tamanhos.length;
  const blocos = (stbl.stco ?? stbl.co64)?.chunk_offsets ?? [];
  const stsc = stbl.stsc;
  const stts = stbl.stts;
  if (!total) return null;
  if (!stsc?.first_chunk?.length || !blocos.length || !stts?.sample_counts?.length) return "DANIFICADO";
  // Tamanho fixo de 1 a 8 bytes é o áudio "descomprimido" do QuickTime antigo, que não é quadro AAC.
  if (fixo > 0 && fixo <= 8) return "DANIFICADO";
  let amostra = 0;
  let entradaDoStts = 0;
  let restantesNoStts = stts.sample_counts[0];
  for (let e = 0; e < stsc.first_chunk.length && amostra < total; e++) {
    const primeiro = stsc.first_chunk[e] - 1;
    const ate = e + 1 < stsc.first_chunk.length ? stsc.first_chunk[e + 1] - 1 : blocos.length;
    const porBloco = stsc.samples_per_chunk[e];
    if (primeiro < 0 || ate > blocos.length || !(porBloco > 0)) return "DANIFICADO";
    for (let bloco = primeiro; bloco < ate && amostra < total; bloco++) {
      let posicao = blocos[bloco];
      for (let k = 0; k < porBloco && amostra < total; k++, amostra++) {
        const tamanho = fixo || tamanhos[amostra];
        while (restantesNoStts === 0 && entradaDoStts + 1 < stts.sample_counts.length) restantesNoStts = stts.sample_counts[++entradaDoStts];
        const duracao = stts.sample_deltas[entradaDoStts] ?? 0;
        restantesNoStts--;
        if (!(tamanho >= 0) || tamanho > AMOSTRA_MAXIMA) return "DANIFICADO";
        if (posicao + tamanho > tamanhoDoArquivo) return null;
        if (tamanho > 0) {
          const motivo = aoQuadro(posicao, tamanho, duracao);
          if (motivo) return motivo;
        }
        posicao += tamanho;
      }
    }
  }
  return null;
}

/** Os padrões do `trex` de cada faixa (a duração e o tamanho das amostras que o fragmento não escreve). */
type PadroesDasFaixas = Map<number, { duracao: number; tamanho: number }>;

/**
 * Os quadros da faixa num `moof` (o MP4 fragmentado), com os padrões do `trex`.
 * Todos os `traf` são percorridos, na ordem, também os das outras faixas: a
 * base dos dados de cada um (ISO 14496-12, §8.8.7.1) é o base_data_offset,
 * quando escrito (0x01); o começo do moof, com o default-base-is-moof
 * (0x020000); e, sem nenhum dos dois, o começo do moof no primeiro `traf` e o
 * FIM DOS DADOS do `traf` anterior nos seguintes (o implicit_offset do ffmpeg).
 * O MP4 do ffmpeg com `omit_tfhd_offset` põe o vídeo no primeiro `traf` e o
 * áudio no segundo assim: contar a base do áudio do começo do moof montava
 * partes com bytes do vídeo no lugar do AAC.
 */
function quadrosDoFragmento(
  moof: Moof, inicioDoMoof: number, idDaFaixa: number, padroes: PadroesDasFaixas, tamanhoDoArquivo: number,
  aoQuadro: (posicao: number, tamanho: number, duracao: number) => CodigoDaRecusaDoCorte | null,
): CodigoDaRecusaDoCorte | null {
  let fimDoAnterior = inicioDoMoof;
  for (const traf of moof.trafs ?? []) {
    const tfhd = traf.tfhd;
    if (!tfhd) return "DANIFICADO";
    const daFaixa = tfhd.track_id === idDaFaixa;
    const padrao = padroes.get(tfhd.track_id) ?? { duracao: 0, tamanho: 0 };
    const base = tfhd.flags & 0x01 ? tfhd.base_data_offset : tfhd.flags & 0x020000 ? inicioDoMoof : fimDoAnterior;
    const duracaoPadrao = tfhd.flags & 0x08 ? tfhd.default_sample_duration : padrao.duracao;
    const tamanhoPadrao = tfhd.flags & 0x10 ? tfhd.default_sample_size : padrao.tamanho;
    let posicao = base;
    for (const trun of traf.truns ?? []) {
      // Sem o data_offset, o trun começa onde o anterior do mesmo traf terminou.
      if (trun.flags & 0x01) posicao = base + trun.data_offset;
      if (!daFaixa) {
        // A outra faixa (o vídeo) só conta onde os dados dela terminam.
        for (let i = 0; i < trun.sample_count; i++) {
          const tamanho = trun.flags & 0x200 ? trun.sample_size[i] : tamanhoPadrao;
          if (!(tamanho >= 0)) return "DANIFICADO";
          posicao += tamanho;
        }
        continue;
      }
      for (let i = 0; i < trun.sample_count; i++) {
        const tamanho = trun.flags & 0x200 ? trun.sample_size[i] : tamanhoPadrao;
        const duracao = trun.flags & 0x100 ? trun.sample_duration[i] : duracaoPadrao;
        if (!(tamanho >= 0) || tamanho > AMOSTRA_MAXIMA || posicao < 0) return "DANIFICADO";
        if (posicao + tamanho > tamanhoDoArquivo) return null;
        if (tamanho > 0) {
          const motivo = aoQuadro(posicao, tamanho, duracao);
          if (motivo) return motivo;
        }
        posicao += tamanho;
      }
    }
    fimDoAnterior = posicao;
  }
  return null;
}

/** Corta o MP4, o M4A ou o MOV em partes de até 600 s e 14 MB (ver o comentário do módulo). */
export async function cortarMp4(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  if (opcoes.sinal?.aborted) throw corteCancelado();
  const janela = new LeitorEmJanela(ler, tamanho, opcoes, BLOCO_DO_TOPO);
  let ftyp: Uint8Array | null = null;
  let escolhida: Escolhida | null = null;
  let partes: PartesEmFmp4 | null = null;
  const padroes: PadroesDasFaixas = new Map();
  let caixas = 0;
  let quadros = 0;
  const contar = (posicao: number, tamanhoDoQuadro: number, duracao: number) => {
    quadros++;
    return partes!.adicionar(posicao, tamanhoDoQuadro, duracao);
  };

  for (let pos = 0; pos + 8 <= tamanho;) {
    if (opcoes.sinal?.aborted) throw corteCancelado();
    if (++caixas > CAIXAS_DO_TOPO_MAXIMAS) return recusa("DANIFICADO", "mp4");
    await janela.garantir(pos, pos + 16);
    let tamanhoDaCaixa = janela.u32be(pos);
    const tipo = janela.ascii(pos + 4, 4);
    let cabecalho = 8;
    if (tamanhoDaCaixa === 1) {
      if (pos + 16 > tamanho) break;
      tamanhoDaCaixa = janela.u64be(pos + 8);
      cabecalho = 16;
    } else if (tamanhoDaCaixa === 0) tamanhoDaCaixa = tamanho - pos;
    // Lixo depois das caixas (bytes zerados de uma cópia interrompida): vale o que veio antes.
    if (!TIPO_DE_CAIXA.test(tipo) || tamanhoDaCaixa < cabecalho) {
      if (escolhida) break;
      return recusa("DANIFICADO", "mp4");
    }
    const caixa: CaixaDoTopo = { tipo, inicio: pos, cabecalho, fim: Math.min(tamanho, pos + tamanhoDaCaixa), truncada: pos + tamanhoDaCaixa > tamanho };
    pos += tamanhoDaCaixa;

    if (caixa.tipo === "ftyp" && !ftyp && !caixa.truncada && caixa.fim - caixa.inicio <= 4096) {
      ftyp = await ler(caixa.inicio, caixa.fim);
    } else if (caixa.tipo === "moov" && !escolhida) {
      if (caixa.truncada || caixa.fim - caixa.inicio > MOOV_MAXIMO) return recusa("DANIFICADO", "mp4");
      const moovBytes = await ler(caixa.inicio, caixa.fim);
      // Sem o ftyp, é o QuickTime antigo: o mp4box precisa saber, para ler a entrada de som de versão 1 ou 2.
      const tipoDoArquivo = ftyp ?? Uint8Array.from([0, 0, 0, 20, ...ascii("ftyp"), ...ascii("qt  "), 0, 0, 0, 0, ...ascii("qt  ")]);
      const juntos = new Uint8Array(tipoDoArquivo.length + moovBytes.length);
      juntos.set(tipoDoArquivo);
      juntos.set(moovBytes, tipoDoArquivo.length);
      let iso: ISOFile;
      try {
        iso = lerComMp4box(juntos);
      } catch {
        return recusa("DANIFICADO", "mp4");
      }
      if (!iso.moov) return recusa("DANIFICADO", "mp4");
      const escolha = escolherFaixa(iso.moov);
      if (!("trak" in escolha)) return recusa(escolha.codigo, "mp4", escolha.detalhe);
      escolhida = escolha;
      partes = new PartesEmFmp4(escolha.faixa, opcoes);
      // Os padrões de TODAS as faixas: o fim dos dados do traf do vídeo é a base do traf do áudio que vem depois dele.
      for (const trex of iso.moov.mvex?.trexs ?? []) {
        if (!padroes.has(trex.track_id)) padroes.set(trex.track_id, { duracao: trex.default_sample_duration ?? 0, tamanho: trex.default_sample_size ?? 0 });
      }
      const motivo = quadrosDaTabela(escolha.trak, tamanho, contar);
      if (motivo) return recusa(motivo, "mp4");
    } else if (caixa.tipo === "moof" && escolhida) {
      if (caixa.truncada || caixa.fim - caixa.inicio > MOOF_MAXIMO) break;
      await janela.garantir(caixa.inicio, caixa.fim);
      let iso: ISOFile;
      try {
        iso = lerComMp4box(janela.trecho(caixa.inicio, caixa.fim));
      } catch {
        return recusa("DANIFICADO", "mp4");
      }
      const moof = iso.moofs?.[0];
      if (!moof) return recusa("DANIFICADO", "mp4");
      const motivo = quadrosDoFragmento(moof, caixa.inicio, escolhida.trak.tkhd?.track_id ?? 0, padroes, tamanho, contar);
      if (motivo) return recusa(motivo, "mp4");
    }
  }
  if (!escolhida || !partes) return recusa("DANIFICADO", "mp4");
  partes.fechar();
  if (!quadros || !partes.partes.length) return recusa("DANIFICADO", "mp4");
  if (partes.partes.length > limitesDoCorte(opcoes).partesNoMaximo) return recusa("MUITAS_PARTES", "mp4");
  return { ok: true, formato: "mp4", mimeType: "audio/mp4", partes: partes.partes, duracaoMs: partes.duracaoMs };
}
