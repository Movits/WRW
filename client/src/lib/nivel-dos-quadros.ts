import { bitsPorMs } from "./pausas-do-corte";

/**
 * O nível de cada quadro comprimido para achar a pausa da fala
 * (lib/pausas-do-corte.ts), lido dos primeiros bytes do quadro, sem
 * decodificar o áudio. O tamanho do quadro sozinho não serve: o codificador de
 * taxa constante (e o de taxa variável, no ruído de sala) gasta quase os mesmos
 * bits na pausa e na fala. O que muda com o volume é o passo do quantizador:
 * - no MP3 (camada III) e no AAC, o `global_gain`, de quarto em quarto de
 *   oitava (2^(ganho/4) acompanha a amplitude); o quadro sem nada quantizado é
 *   silêncio, qualquer que seja o ganho;
 * - no Opus em modo SILK ou híbrido (o da voz), a marca de atividade de voz
 *   (VAD) que o codificador grava no começo de cada quadro; no modo CELT, que
 *   não tem a marca, a marca de silêncio (só o silêncio digital) e, sem ela, o
 *   tamanho do pacote.
 * O quadro que não se lê vale Infinity: nunca é pausa.
 */

/** Lê bits, do mais alto ao mais baixo, de um acessor de bytes (o -1 fora dos dados vira bits 1, e o quadro fica sem leitura). */
class LeitorDeBits {
  private bit: number;
  constructor(private readonly b: (i: number) => number, inicio: number, private readonly fim: number) {
    this.bit = inicio * 8;
  }

  get esgotado() {
    return this.bit > this.fim * 8;
  }

  ler(n: number): number {
    let valor = 0;
    for (let k = 0; k < n; k++, this.bit++) valor = valor * 2 + ((this.b(this.bit >> 3) >> (7 - (this.bit & 7))) & 1);
    return valor;
  }

  pular(n: number) {
    this.bit += n;
  }
}

/**
 * O nível do quadro MP3 da camada III que começa em `p`: a média, nos grânulos,
 * do maior 2^(global_gain/4) entre os canais, com 0 no grânulo sem valores
 * grandes e quase sem bits (o silêncio). A informação lateral vem depois do
 * cabeçalho (e do CRC de 2 bytes, com o bit de proteção em 0): ISO 11172-3
 * §2.4.1.7 e, no MPEG-2 e no 2.5, ISO 13818-3 (um grânulo, scalefac_compress de 9 bits).
 */
export function nivelDoMp3(b: (i: number) => number, p: number, quadro: { versao: number; mono: boolean; tamanho: number }): number {
  const canais = quadro.mono ? 1 : 2;
  const mpeg1 = quadro.versao === 3;
  const inicio = p + 4 + ((b(p + 1) & 1) === 0 ? 2 : 0);
  const bits = new LeitorDeBits(b, inicio, p + quadro.tamanho);
  // main_data_begin, os bits privados e, no MPEG-1, o scfsi de cada canal.
  bits.pular(mpeg1 ? 9 + (quadro.mono ? 5 : 3) + 4 * canais : 8 + (quadro.mono ? 1 : 2));
  const granulos = mpeg1 ? 2 : 1;
  let soma = 0;
  for (let granulo = 0; granulo < granulos; granulo++) {
    let maior = 0;
    for (let canal = 0; canal < canais; canal++) {
      const part23 = bits.ler(12);
      const bigValues = bits.ler(9);
      const ganho = bits.ler(8);
      // O resto do grânulo do canal: 30 bits no MPEG-1, 34 no MPEG-2.
      bits.pular(mpeg1 ? 30 : 34);
      const nivel = bigValues === 0 && part23 < 64 ? 0 : 2 ** (ganho / 4);
      if (nivel > maior) maior = nivel;
    }
    soma += maior;
  }
  return bits.esgotado ? Infinity : soma / granulos;
}

/** O ics_info do AAC: o max_sfb e, na janela curta, os grupos (ISO 14496-3 §4.4.2.1). Null com dados de predição (fora do AAC-LC). */
function icsInfo(bits: LeitorDeBits): { maxSfb: number; grupos: number } | null {
  bits.pular(1);
  const sequencia = bits.ler(2);
  bits.pular(1);
  if (sequencia === 2) {
    const maxSfb = bits.ler(4);
    const agrupamento = bits.ler(7);
    let grupos = 1;
    for (let k = 6; k >= 0; k--) if (!((agrupamento >> k) & 1)) grupos++;
    return { maxSfb, grupos };
  }
  const maxSfb = bits.ler(6);
  if (bits.ler(1)) return null;
  return { maxSfb, grupos: 1 };
}

/**
 * O nível do bloco AAC (o raw_data_block, sem o cabeçalho ADTS) de
 * `inicio` a `fim`: 2^(global_gain/4) do primeiro elemento de canal (SCE, LFE
 * ou CPE), ou 0 sem bandas codificadas (max_sfb 0, o silêncio). Outro
 * elemento primeiro, ou a predição do AAC Main, deixam o quadro sem leitura.
 */
export function nivelDoAac(b: (i: number) => number, inicio: number, fim: number): number {
  if (fim - inicio < 3) return 0;
  const bits = new LeitorDeBits(b, inicio, fim);
  const elemento = bits.ler(3);
  bits.pular(4);
  let ganho: number;
  let info: { maxSfb: number; grupos: number } | null;
  if (elemento === 0 || elemento === 3) {
    // SCE e LFE: o individual_channel_stream começa no global_gain, e o ics_info vem depois.
    ganho = bits.ler(8);
    info = icsInfo(bits);
  } else if (elemento === 1) {
    if (bits.ler(1)) {
      // A janela comum: o ics_info e a máscara M/S antes do primeiro canal.
      info = icsInfo(bits);
      if (!info) return Infinity;
      const mascara = bits.ler(2);
      if (mascara === 1) bits.pular(info.grupos * info.maxSfb);
      ganho = bits.ler(8);
    } else {
      ganho = bits.ler(8);
      info = icsInfo(bits);
    }
  } else return Infinity;
  if (!info || bits.esgotado) return Infinity;
  return info.maxSfb === 0 ? 0 : 2 ** (ganho / 4);
}

/**
 * O primeiro símbolo do decodificador de intervalo do quadro Opus, de
 * probabilidade 1/2^logp (ec_dec_bit_logp), depois da inicialização (RFC 6716
 * §4.1.1) e da normalização (§4.1.2.1). Precisa dos 5 primeiros bytes do
 * pacote (o TOC e os 4 do começo do quadro; os que faltam valem 0, como no
 * decodificador). No SILK e no híbrido (logp 1),
 * é a marca de atividade de voz do primeiro quadro (§4.2.3); no CELT (logp
 * 15), a marca de silêncio (§4.3).
 */
export function primeiraMarcaDoOpus(bytes: ArrayLike<number>, logp: number): boolean {
  const byte = (i: number) => (i < bytes.length ? bytes[i] : 0);
  let rng = 128;
  let resto = byte(1);
  let val = 127 - (resto >> 1);
  let i = 2;
  while (rng <= 1 << 23) {
    rng *= 256;
    const anterior = resto;
    resto = byte(i++);
    const simbolo = ((anterior << 8) | resto) >> 1;
    val = (val * 256 + (255 & ~simbolo)) % 2 ** 31;
  }
  return val < Math.floor(rng / 2 ** logp);
}

/**
 * O nível do pacote Opus de `tamanho` bytes e `duracaoMs` (os primeiros bytes
 * em `inicio`): no SILK e no híbrido (configurações 0 a 15) de um quadro ou de
 * dois iguais, 0 sem voz e os bits por ms com voz; no CELT, 0 com a marca de
 * silêncio e, sem ela (e no pacote de outro empacotamento), os bits por ms. O
 * pacote de até 2 bytes (o DTX) é pausa.
 */
export function nivelDoOpus(inicio: ArrayLike<number>, tamanho: number, duracaoMs: number): number {
  if (tamanho <= 2) return 0;
  const toc = inicio[0] ?? 0;
  const silkOuHibrido = toc >> 3 < 16;
  const empacotamento = toc & 3;
  // Os bytes que faltam no pacote curto valem 0, como no decodificador (ec_read_byte).
  if (empacotamento <= 1 && inicio.length >= 2) {
    if (silkOuHibrido) return primeiraMarcaDoOpus(inicio, 1) ? bitsPorMs(tamanho, duracaoMs) : 0;
    if (primeiraMarcaDoOpus(inicio, 15)) return 0;
  }
  return bitsPorMs(tamanho, duracaoMs);
}
