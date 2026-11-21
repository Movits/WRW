import { limitesDoCorte, type OpcoesDoCorte } from "./corte-comum";
import { TRECHO_CALMO_MS } from "./detector-de-pausa";

/**
 * A emenda das partes do arquivo importado cai numa pausa da fala
 * (conferência de tela do pacote 4b). Cada parte vai sozinha ao Gemini, e a
 * fala que atravessa a emenda se perde nas duas: no WAV cortado a cada 14 MB,
 * "A local photographer offered to help at a discount." virou "A local", e a
 * parte seguinte começou na frase depois. A gravação ao vivo já espera a pausa
 * para trocar de parte (lib/detector-de-pausa.ts); o arquivo importado não
 * esperava: o corte caía no teto de tempo ou de bytes, onde estivesse.
 *
 * Agora a parte fecha na última pausa antes do teto, até JANELA_DA_PAUSA_MS
 * antes dele (e nunca depois: o teto da rota das partes continua valendo).
 * Sem pausa nessa janela (fala corrida, música, ruído constante), corta no teto,
 * como antes. A pausa é um trecho de pelo menos TRECHO_CALMO_MS (300 ms, o
 * mesmo da gravação ao vivo) com o nível abaixo do limiar, e o corte cai no
 * meio dele, com pelo menos MARGEM_DA_PAUSA_MS de calma de cada lado.
 *
 * O nível vem do que cada formato já lê, sem decodificar o áudio, numa escala
 * que acompanha a amplitude:
 * - o WAV (PCM) mede o volume das próprias amostras (o RMS em blocos de 20 ms),
 *   lendo só a janela antes de cada teto (lib/corte-do-wav.ts);
 * - o FLAC, que não perde nada, gasta bits por amostra no logaritmo do volume:
 *   2 elevado a eles (lib/corte-do-flac.ts);
 * - o MP3 e o AAC, o passo do quantizador (o global_gain) de cada quadro, e o
 *   Opus em modo de voz (SILK, o do WhatsApp), a marca de atividade de voz
 *   (lib/nivel-dos-quadros.ts). O tamanho do quadro não serve: o codificador
 *   gasta quase os mesmos bits no ruído de sala da pausa e na fala.
 * Limite conhecido: o Vorbis (pacote a pacote, pelo tamanho) e o Opus em modo
 * CELT (o da música e o das taxas altas; pela marca de silêncio) só acham a
 * pausa em silêncio digital, a da voz sintetizada, e o CELT nem essa nos
 * primeiros ~400 ms depois da fala. Sem pausa achada, o corte cai no teto,
 * como antes.
 *
 * Nos comprimidos o corte lê o arquivo duas vezes (cortarNasPausas): a
 * primeira leitura acha as pausas (MapaDasPausas), e a segunda corta de novo
 * fechando cada parte na última pausa que cabe nela (PlanoDasPausas). Cada
 * corte chama `antes` no ponto em que confere o teto e `depois` quando a
 * unidade (o quadro, o pacote ou a página) entra na parte.
 */

/** A calma mínima de cada lado do corte, dentro da pausa. */
export const MARGEM_DA_PAUSA_MS = 100;
/** Até quanto antes do teto a parte pode fechar numa pausa (e nunca mais que um quarto da parte). */
export const JANELA_DA_PAUSA_MS = 20_000;
/** O trecho em que o nível da fala é medido (o percentil 90 dele, com os dois anteriores). */
const BLOCO_DA_REFERENCIA_MS = 10_000;
const PERCENTIL_DA_FALA = 0.9;
const BLOCOS_NA_REFERENCIA = 3;
/** A folga da conta de tempo do plano contra a do corte (as duas somam as mesmas durações). */
const FOLGA_DO_TEMPO_MS = 5;

/**
 * Calmo é o nível até um décimo do da fala (o percentil 90 do trecho: −20 dB,
 * como o ruído de sala a −40 dBFS diante da fala a −20), ou até o piso de
 * −60 dBFS (a referência perto de zero, num trecho todo em silêncio).
 */
const FATOR_DA_PAUSA = 0.1;
const PISO_DA_PAUSA = 0.001;

/** Onde uma parte pode começar numa pausa: a unidade `indice`, com o tempo e os bytes do arquivo até ela. */
export type PontoDePausa = { indice: number; tempoMs: number; bytes: number };
export type PausasDoArquivo = { pontos: PontoDePausa[]; tempoMs: number; bytes: number };

/** O que cada corte chama, nas duas leituras. */
export interface PausasDoCorte {
  /** A primeira leitura quer o nível de cada unidade; a segunda, não (o corte nem o calcula). */
  readonly ouvindo: boolean;
  /** Antes de a unidade entrar numa parte já aberta: fechar a parte aqui, numa pausa? */
  antes(tempoDaParteMs: number, bytesDaParte: number): boolean;
  /** A unidade entrou: a duração, os bytes que ela soma à parte e o nível dela. */
  depois(duracaoMs: number, bytes: number, nivel: number): void;
  /** A unidade de vários pedaços (a página Ogg com os pacotes): [duração, nível] de cada um. */
  depoisEmPedacos(bytes: number, pedacos: ReadonlyArray<readonly [number, number]>): void;
}

/** Sem procurar pausa: o corte de sempre. */
export const SEM_PAUSAS: PausasDoCorte = {
  ouvindo: false,
  antes: () => false,
  depois: () => undefined,
  depoisEmPedacos: () => undefined,
};

/** O nível de um trecho comprimido: bits por milissegundo (0 sem duração). */
export const bitsPorMs = (bytes: number, duracaoMs: number) => (duracaoMs > 0 ? (bytes * 8) / duracaoMs : 0);

type Item = { duracaoMs: number; nivel: number; fronteira: { indice: number; bytes: number; permitida: boolean } | null };

/**
 * Acha as pausas num fluxo de níveis: o nível da fala de cada bloco de 10 s,
 * os trechos calmos de pelo menos 300 ms e, em cada um, a fronteira de unidade
 * mais perto do meio (com a margem de cada lado). Só as fronteiras
 * `permitidas` contam (no WAV, as que não passam do teto).
 */
export class DetectorDePausas {
  readonly pontos: PontoDePausa[] = [];
  private bloco: Item[] = [];
  private duracaoDoBloco = 0;
  private referencias: number[] = [];
  private tempoMs = 0;
  private trecho: { inicioMs: number; fronteiras: PontoDePausa[] } | null = null;

  acrescentar(item: Item) {
    this.bloco.push(item);
    this.duracaoDoBloco += item.duracaoMs;
    if (this.duracaoDoBloco >= BLOCO_DA_REFERENCIA_MS) this.classificar();
  }

  terminar(): PontoDePausa[] {
    if (this.bloco.length) this.classificar();
    this.fecharTrecho();
    return this.pontos;
  }

  private classificar() {
    // O quadro que não se leu (Infinity) não entra na referência e nunca é pausa.
    const niveis = this.bloco.filter(item => item.duracaoMs > 0 && Number.isFinite(item.nivel)).map(item => item.nivel).sort((a, b) => a - b);
    if (niveis.length) {
      this.referencias.push(niveis[Math.min(niveis.length - 1, Math.floor(niveis.length * PERCENTIL_DA_FALA))]);
      if (this.referencias.length > BLOCOS_NA_REFERENCIA) this.referencias.shift();
    }
    const limiar = Math.max(PISO_DA_PAUSA, FATOR_DA_PAUSA * Math.max(0, ...this.referencias));
    for (const item of this.bloco) {
      const ponto = item.fronteira?.permitida ? { indice: item.fronteira.indice, tempoMs: this.tempoMs, bytes: item.fronteira.bytes } : null;
      if (item.duracaoMs <= 0) {
        // Sem duração, o item não muda o trecho; a fronteira dele fica dentro se o trecho está aberto.
        if (this.trecho && ponto) this.trecho.fronteiras.push(ponto);
        continue;
      }
      if (item.nivel <= limiar) {
        // A fronteira do item que abre o trecho fica na borda dele, e não dentro.
        if (!this.trecho) this.trecho = { inicioMs: this.tempoMs, fronteiras: [] };
        else if (ponto) this.trecho.fronteiras.push(ponto);
      } else {
        this.fecharTrecho();
      }
      this.tempoMs += item.duracaoMs;
    }
    this.bloco = [];
    this.duracaoDoBloco = 0;
  }

  private fecharTrecho() {
    const trecho = this.trecho;
    this.trecho = null;
    if (!trecho || this.tempoMs - trecho.inicioMs < TRECHO_CALMO_MS) return;
    let melhor: PontoDePausa | null = null;
    let folga = -1;
    for (const fronteira of trecho.fronteiras) {
      const daqui = Math.min(fronteira.tempoMs - trecho.inicioMs, this.tempoMs - fronteira.tempoMs);
      if (daqui > folga) {
        melhor = fronteira;
        folga = daqui;
      }
    }
    if (melhor && folga >= MARGEM_DA_PAUSA_MS) this.pontos.push(melhor);
  }
}

/** A primeira leitura: ouve cada unidade e guarda onde estão as pausas. */
export class MapaDasPausas implements PausasDoCorte {
  readonly ouvindo = true;
  private indice = 0;
  private tempoMs = 0;
  private bytes = 0;
  private readonly detector = new DetectorDePausas();

  antes() {
    return false;
  }

  depois(duracaoMs: number, bytes: number, nivel: number) {
    this.depoisEmPedacos(bytes, [[duracaoMs, nivel]]);
  }

  depoisEmPedacos(bytes: number, pedacos: ReadonlyArray<readonly [number, number]>) {
    pedacos.forEach(([duracaoMs, nivel], k) => {
      this.detector.acrescentar({ duracaoMs, nivel, fronteira: k === 0 ? { indice: this.indice, bytes: this.bytes, permitida: true } : null });
      this.tempoMs += duracaoMs;
    });
    this.indice++;
    this.bytes += bytes;
  }

  terminar(): PausasDoArquivo {
    return { pontos: this.detector.terminar(), tempoMs: this.tempoMs, bytes: this.bytes };
  }
}

/**
 * A segunda leitura: fecha a parte na pausa da vez quando a próxima pausa (ou
 * o fim do arquivo) já não cabe nela, e só se a parte já está perto do teto
 * (a janela da pausa): a fala corrida depois de uma pausa no começo da parte
 * não a faz fechar cedo.
 */
export class PlanoDasPausas implements PausasDoCorte {
  readonly ouvindo = false;
  private indice = 0;
  private k = 0;

  constructor(private readonly pausas: PausasDoArquivo, private readonly limiteMs: number, private readonly limiteBytes: number) {}

  antes(tempoDaParteMs: number, bytesDaParte: number): boolean {
    const { pontos } = this.pausas;
    while (this.k < pontos.length && pontos[this.k].indice < this.indice) this.k++;
    const aqui = pontos[this.k];
    if (!aqui || aqui.indice !== this.indice || !(tempoDaParteMs > 0)) return false;
    const proxima = pontos[this.k + 1] ?? { tempoMs: this.pausas.tempoMs, bytes: this.pausas.bytes };
    const cabe = tempoDaParteMs + (proxima.tempoMs - aqui.tempoMs) <= this.limiteMs - FOLGA_DO_TEMPO_MS
      && bytesDaParte + (proxima.bytes - aqui.bytes) <= this.limiteBytes;
    if (cabe) return false;
    // O teto em tempo: o do relógio ou, pelo ritmo dos bytes até aqui, o dos bytes.
    const teto = Math.min(this.limiteMs, bytesDaParte > 0 ? tempoDaParteMs * (this.limiteBytes / bytesDaParte) : Infinity);
    return tempoDaParteMs >= teto - Math.min(JANELA_DA_PAUSA_MS, teto / 4);
  }

  depois() {
    this.indice++;
  }

  depoisEmPedacos() {
    this.indice++;
  }
}

/**
 * Corta duas vezes (ver o comentário do módulo): a primeira acha as pausas e
 * já é o corte de sempre; a segunda, só se há pausa e mais de uma parte, fecha
 * as partes nas pausas. Se a segunda recusar (mais partes que o teto da
 * reunião), vale a primeira. O andamento da leitura vai de 0 a 50% na primeira
 * e de 50 a 100% na segunda. Com `opcoes.pausas` já dado (uma leitura só, como
 * nos testes que comparam com o corte de sempre), corta uma vez com ele.
 */
export async function cortarNasPausas<R>(
  cortar: (opcoes: OpcoesDoCorte) => Promise<R>,
  tamanho: number,
  opcoes: OpcoesDoCorte,
  partesDe: (resultado: R) => number | null,
): Promise<R> {
  if (opcoes.pausas) return cortar(opcoes);
  const aoLer = opcoes.aoLer;
  const mapa = new MapaDasPausas();
  const primeira = await cortar({ ...opcoes, pausas: mapa, aoLer: aoLer && ((lidos, total) => aoLer(Math.floor(lidos / 2), total)) });
  const partes = partesDe(primeira);
  const pausas = mapa.terminar();
  if (partes === null || partes < 2 || !pausas.pontos.length) {
    if (partes !== null) aoLer?.(tamanho, tamanho);
    return primeira;
  }
  const limites = limitesDoCorte(opcoes);
  const segunda = await cortar({
    ...opcoes,
    pausas: new PlanoDasPausas(pausas, limites.segundosPorParte * 1000, limites.bytesPorParte),
    aoLer: aoLer && ((lidos, total) => aoLer(Math.floor((total + lidos) / 2), total)),
  });
  return partesDe(segunda) === null ? primeira : segunda;
}

/** As partes de um corte do arquivo, ou null na recusa (o `partesDe` de cortarNasPausas). */
export const partesDoCorte = (corte: { ok: true; partes: unknown[] } | { ok: false }) => (corte.ok ? corte.partes.length : null);
