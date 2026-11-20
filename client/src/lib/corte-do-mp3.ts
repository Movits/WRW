import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";

/**
 * O corte de um MP3 em partes para a importação em partes (H9a do plano do
 * gravador), sem biblioteca e sem recodificar: o arquivo é lido em blocos,
 * quadro a quadro, e cada parte sai como uma lista de faixas de bytes do
 * próprio arquivo. Quem monta a parte (useImportacaoEmPartes) faz o
 * File.slice das faixas, sem copiar o áudio inteiro para a memória.
 *
 * - As etiquetas ficam de fora: o ID3v2 (no começo ou entre os quadros), o
 *   ID3v1 e o APEv2 do fim, e o quadro Xing/Info/VBRI, que não tem som e diria
 *   a cada parte a duração e o número de quadros do arquivo inteiro.
 * - Cada parte vai até 600 s ou 14 MB, o que vier antes: cabe com folga nos
 *   tetos da rota das partes (720 s e 16 MB, server/fatias-de-reuniao.ts), que
 *   mede de novo cada parte nos bytes, com a mesma conta, e no pedido ao Gemini
 *   (ver PARTE_DO_MP3_BYTES_MAX).
 * - Lixo no meio (bytes que não são quadro) também fica de fora: a parte ganha
 *   outra faixa depois dele. Para voltar a um quadro depois do lixo, ele e os
 *   dois seguintes precisam se confirmar, do mesmo fluxo (uma capa JPEG está
 *   cheia de 0xFF que parecem começo de quadro).
 * - A duração é a soma dos quadros, a conta do servidor
 *   (server/duracao-do-audio.ts). Acima de 12 h, o teto da gravação em partes,
 *   o corte para e recusa, antes de a reunião nascer.
 *
 * O corte nos quadros não mexe no reservatório de bits do Layer III: o
 * primeiro quadro de cada parte pode apontar para bytes do quadro anterior,
 * que ficou na outra parte, e o decodificador cala uns milissegundos ali. Para
 * a transcrição, não muda nada.
 *
 * O módulo não toca o DOM: roda no Worker (workers/corte-do-mp3.worker.ts), na
 * página quando o Worker não sobe (lib/corte-do-mp3-no-worker.ts) e nos testes.
 */

/** O teto de cada parte do arquivo importado: o da parte da gravação (PARTE_SEGUNDOS). */
export const PARTE_DO_MP3_SEGUNDOS_MAX = 600;
/**
 * 14 MB, e não os 15 do plano: cada parte vai ao Gemini inline, em base64 (um
 * terço a mais), e 14 MB viram 18,7 MB, abaixo dos 20 MB do pedido com áudio
 * inline; 15 MB virariam 20,97 MB. A rota das partes aceita até 16 MB
 * (TAMANHO_MAXIMO_DA_PARTE), e o MP3 de 12 h a 320 kbps fica em 118 partes,
 * dentro do teto de 120 a cada 10 min da rota (PARTES_POR_DONA_EM_10_MIN).
 * Só o MP3 de mais de ~196 kbps chega a este teto antes dos 600 s.
 */
export const PARTE_DO_MP3_BYTES_MAX = 14 * 1024 * 1024;

/** De quanto em quanto o arquivo é lido. */
const BLOCO = 4 * 1024 * 1024;
/**
 * Quanto a janela de leitura precisa ter à frente da posição: três quadros (o
 * maior, Layer II a 384 kbps e 32 kHz, tem 1.729 bytes) para a confirmação,
 * os 10 bytes do cabeçalho do ID3 e os ~40 do quadro Xing.
 */
const FOLGA = 16 * 1024;
/** O lixo que um arquivo pode ter antes de o primeiro quadro aparecer. Mais que isto (e mais que o áudio) não é MP3. */
const LIXO_TOLERADO = 2 * 1024 * 1024;
/**
 * As durações contam em tiques inteiros: 14.112.000 por segundo, o mínimo
 * múltiplo comum das nove taxas do MPEG, e assim cada quadro dura um número
 * inteiro deles. Somar 600 mil quadros de 0,072 s em ponto flutuante passava
 * das 12 h exatas por milionésimos; em tiques, 12 h ficam abaixo de 2^53 e a
 * conta é exata.
 */
const TIQUES_POR_SEGUNDO = 14_112_000;
const TIQUES_POR_MS = TIQUES_POR_SEGUNDO / 1000;

export type FaixaDeBytes = { inicio: number; fim: number };
export type ParteDoMp3 = { faixas: FaixaDeBytes[]; bytes: number; duracaoMs: number };
export type CodigoDaRecusaDoMp3 = "NAO_E_MP3" | "LONGO_DEMAIS";
export type CorteDoMp3 =
  | { ok: true; partes: ParteDoMp3[]; duracaoMs: number }
  | { ok: false; codigo: CodigoDaRecusaDoMp3 };

/** Lê os bytes de `inicio` até `fim` (sem incluir) do arquivo. */
export type LerBytes = (inicio: number, fim: number) => Promise<Uint8Array>;

export type OpcoesDoCorte = {
  segundosPorParte?: number;
  bytesPorParte?: number;
  /** O teto da reunião: acima dele o corte recusa (LONGO_DEMAIS). */
  segundosNoTotal?: number;
  /** A leitura andou: quantos bytes do arquivo já foram lidos, de quantos. */
  aoLer?: (lidos: number, total: number) => void;
  sinal?: AbortSignal;
};

/** O erro do corte cancelado (AbortError, como o fetch). */
export function corteCancelado() {
  return new DOMException("Corte do MP3 cancelado.", "AbortError");
}

export function ehCorteCancelado(erro: unknown) {
  return erro instanceof DOMException && erro.name === "AbortError";
}

/** O leitor de um Blob (o File escolhido): o Worker e a página leem do mesmo jeito. */
export function lerBlob(blob: Blob): LerBytes {
  return async (inicio, fim) => new Uint8Array(await blob.slice(inicio, fim).arrayBuffer());
}

// ─── Quadros MPEG (as tabelas de server/duracao-do-audio.ts, sem o ADTS) ─────

const BITRATES_MPEG1 = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const BITRATES_MPEG2 = [
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
// Pelo campo da versão: 0 = MPEG 2.5, 1 = reservado, 2 = MPEG 2, 3 = MPEG 1.
const TAXAS = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];

type Quadro = { tamanho: number; tiques: number; versao: number; camada: number; indiceTaxa: number; mono: boolean };

/** A janela do arquivo que está na memória: um bloco lido, a partir de `origem`. */
class Janela {
  private bytes: Uint8Array = new Uint8Array(0);
  private origem = 0;

  constructor(private readonly ler: LerBytes, readonly tamanho: number) {}

  get fim() {
    return this.origem + this.bytes.length;
  }

  /** O byte na posição `p` do arquivo, ou -1 fora da janela. */
  b(p: number): number {
    const i = p - this.origem;
    return i >= 0 && i < this.bytes.length ? this.bytes[i] : -1;
  }

  /** Os bytes em `p` são este texto ASCII? Sem montar string: roda a cada quadro. */
  igual(p: number, texto: string): boolean {
    for (let i = 0; i < texto.length; i++) if (this.b(p + i) !== texto.charCodeAt(i)) return false;
    return true;
  }

  // A última busca de cada byte, nesta janela: no lixo longo, cada passo não
  // relê a janela inteira atrás do mesmo byte.
  private achados = new Map<number, { desde: number; em: number }>();

  /** O próximo `byte` a partir de `desde`, dentro da janela, ou -1. */
  procurar(byte: number, desde: number): number {
    const ultima = this.achados.get(byte);
    // A busca anterior começou antes de `desde` e achou depois dele (ou não
    // achou nada): entre as duas não há o byte, e a resposta é a mesma.
    if (ultima && ultima.desde <= desde && (ultima.em < 0 || ultima.em >= desde)) return ultima.em;
    const i = this.bytes.indexOf(byte, Math.max(0, desde - this.origem));
    const em = i < 0 ? -1 : i + this.origem;
    this.achados.set(byte, { desde, em });
    return em;
  }

  /** Garante na memória de `p` até `p + n` (ou até o fim), lendo um bloco a partir de `p` se faltar. */
  async cobrir(p: number, n: number) {
    const ate = Math.min(p + n, this.tamanho);
    if (p >= this.origem && ate <= this.fim) return;
    const fim = Math.min(this.tamanho, Math.max(ate, p + BLOCO));
    const lidos = await this.ler(p, fim);
    if (lidos.length !== fim - p) throw new Error("Leitura incompleta do arquivo.");
    this.bytes = lidos;
    this.origem = p;
    this.achados.clear();
  }
}

function quadroEm(j: Janela, p: number): Quadro | null {
  const b1 = j.b(p + 1);
  const b2 = j.b(p + 2);
  const b3 = j.b(p + 3);
  if (j.b(p) !== 0xff || b1 < 0 || b2 < 0 || b3 < 0 || (b1 & 0xe0) !== 0xe0) return null;
  const versao = (b1 >> 3) & 3;
  const camadaBits = (b1 >> 1) & 3;
  // Versão reservada; camada 00 é reservada no MPEG (e é o ADTS, que não é MP3).
  if (versao === 1 || camadaBits === 0) return null;
  const camada = 4 - camadaBits;
  const indiceBitrate = b2 >> 4;
  const indiceTaxa = (b2 >> 2) & 3;
  // Bitrate livre (0), proibido (15) e taxa reservada: o servidor também não mede.
  if (indiceBitrate === 0 || indiceBitrate === 15 || indiceTaxa === 3) return null;
  const mpeg1 = versao === 3;
  const bitrate = (mpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[camada - 1][indiceBitrate] * 1000;
  const taxa = TAXAS[versao][indiceTaxa];
  const enchimento = (b2 >> 1) & 1;
  const amostras = camada === 1 ? 384 : camada === 2 || mpeg1 ? 1152 : 576;
  const tamanho = camada === 1
    ? (Math.floor((12 * bitrate) / taxa) + enchimento) * 4
    : Math.floor(((amostras / 8) * bitrate) / taxa) + enchimento;
  return { tamanho, tiques: amostras * (TIQUES_POR_SEGUNDO / taxa), versao, camada, indiceTaxa, mono: b3 >> 6 === 3 };
}

/** O mesmo fluxo: versão, camada e taxa iguais (a máscara que o ffmpeg usa para seguir um MP3). */
function mesmoFluxo(a: Quadro, b: Quadro) {
  return a.versao === b.versao && a.camada === b.camada && a.indiceTaxa === b.indiceTaxa;
}

/** O tamanho do ID3v2 que começa em `p` (cabeçalho, corpo e rodapé), ou null se não há um ali. */
function tamanhoDoId3(j: Janela, p: number): number | null {
  if (!j.igual(p, "ID3")) return null;
  const versao = j.b(p + 3);
  const revisao = j.b(p + 4);
  const flags = j.b(p + 5);
  const s = [j.b(p + 6), j.b(p + 7), j.b(p + 8), j.b(p + 9)];
  // A versão e a revisão nunca são 0xFF, e o tamanho é "syncsafe" (7 bits por byte).
  if (versao < 0 || versao === 0xff || revisao < 0 || revisao === 0xff || flags < 0 || s.some(x => x < 0 || x & 0x80)) return null;
  const corpo = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3];
  return 10 + corpo + (flags & 0x10 ? 10 : 0);
}

/**
 * O quadro que leva a etiqueta Xing, Info (LAME) ou VBRI (Fraunhofer): tem
 * cabeçalho de quadro, mas nenhum som. A Xing fica logo depois da informação
 * lateral (com ou sem os 2 bytes do CRC, que nem todo leitor conta); a VBRI,
 * sempre 32 bytes depois do cabeçalho. Vale em qualquer ponto do arquivo: dois
 * MP3 emendados trazem a do segundo no meio.
 */
function ehQuadroDeEtiqueta(j: Janela, p: number, q: Quadro) {
  if (q.camada !== 3) return false;
  const lateral = q.versao === 3 ? (q.mono ? 17 : 32) : q.mono ? 9 : 17;
  for (const desvio of [4 + lateral, 6 + lateral]) {
    if (j.igual(p + desvio, "Xing") || j.igual(p + desvio, "Info")) return true;
  }
  return j.igual(p + 36, "VBRI");
}

/**
 * Um quadro achado fora de sequência (o primeiro, ou depois de lixo) só vale
 * com os dois seguintes do mesmo fluxo, cada um onde o anterior termina. A
 * corrente que chega exatamente ao fim do áudio, ou a um ID3, também confirma.
 */
function confirmado(j: Janela, p: number, q: Quadro, fimDoAudio: number) {
  let proximo = p + q.tamanho;
  for (let seguidos = 0; seguidos < 2; seguidos++) {
    if (proximo === fimDoAudio || tamanhoDoId3(j, proximo) !== null) return true;
    const r = quadroEm(j, proximo);
    if (!r || !mesmoFluxo(r, q) || proximo + r.tamanho > fimDoAudio) return false;
    proximo += r.tamanho;
  }
  return true;
}

const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const asciiDe = (b: Uint8Array, i: number, n: number) => Array.from(b.subarray(i, i + n), c => String.fromCharCode(c)).join("");

/** Onde o áudio termina: antes do ID3v1 ("TAG", 128 bytes) e do APEv2 do fim, nas duas ordens. */
async function fimSemEtiquetas(ler: LerBytes, tamanho: number): Promise<number> {
  let fim = tamanho;
  for (let volta = 0; volta < 4; volta++) {
    if (fim >= 128 && asciiDe(await ler(fim - 128, fim - 125), 0, 3) === "TAG") {
      fim -= 128;
      continue;
    }
    if (fim >= 32) {
      const rodape = await ler(fim - 32, fim);
      if (asciiDe(rodape, 0, 8) === "APETAGEX") {
        // O tamanho conta os itens e o rodapé; o cabeçalho, quando há, vem antes (bit 31 das flags).
        const etiqueta = u32le(rodape, 12) + (u32le(rodape, 20) & 0x80000000 ? 32 : 0);
        if (etiqueta >= 32 && etiqueta <= fim) {
          fim -= etiqueta;
          continue;
        }
      }
    }
    break;
  }
  return fim;
}

type ParteEmMontagem = { faixas: FaixaDeBytes[]; bytes: number; tiques: number };

const fechada = (parte: ParteEmMontagem): ParteDoMp3 => ({ faixas: parte.faixas, bytes: parte.bytes, duracaoMs: Math.round(parte.tiques / TIQUES_POR_MS) });

/**
 * Corta o MP3 em partes (ver o comentário do módulo). Recusa com NAO_E_MP3
 * quando não acha quadros, ou quando o lixo passa do áudio, e com
 * LONGO_DEMAIS assim que a soma passa do teto, sem ler o resto. O cancelamento
 * (`sinal`) rejeita com AbortError.
 */
export async function cortarMp3(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoMp3> {
  const tiquesPorParte = (opcoes.segundosPorParte ?? PARTE_DO_MP3_SEGUNDOS_MAX) * TIQUES_POR_SEGUNDO;
  const bytesPorParte = opcoes.bytesPorParte ?? PARTE_DO_MP3_BYTES_MAX;
  const tiquesNoTotal = (opcoes.segundosNoTotal ?? GRAVACAO_EM_PARTES_SEGUNDOS_MAX) * TIQUES_POR_SEGUNDO;
  if (opcoes.sinal?.aborted) throw corteCancelado();

  const fimDoAudio = await fimSemEtiquetas(ler, tamanho);
  const janela = new Janela(ler, fimDoAudio);
  const partes: ParteDoMp3[] = [];
  let atual: ParteEmMontagem | null = null;
  let tiques = 0;
  let bytesDeAudio = 0;
  let lixo = 0;
  // O quadro anterior, quando o que vem agora é a continuação dele: o seguinte
  // do mesmo fluxo, onde ele termina, não precisa de confirmação.
  let anterior: Quadro | null = null;
  let pos = 0;
  let avisado = 0;

  while (pos < fimDoAudio) {
    if (opcoes.sinal?.aborted) throw corteCancelado();
    // Duas folgas à frente: o laço abaixo anda até a janela ter só uma, e assim sempre anda.
    await janela.cobrir(pos, 2 * FOLGA);
    if (janela.fim > avisado) {
      avisado = janela.fim;
      opcoes.aoLer?.(Math.min(avisado, tamanho), tamanho);
    }
    const limite = janela.fim >= fimDoAudio ? fimDoAudio : janela.fim - FOLGA;
    while (pos < limite) {
      const id3 = tamanhoDoId3(janela, pos);
      if (id3 !== null) {
        pos += id3;
        anterior = null;
        continue;
      }
      const q = quadroEm(janela, pos);
      if (q && pos + q.tamanho <= fimDoAudio && ((anterior && mesmoFluxo(q, anterior)) || confirmado(janela, pos, q, fimDoAudio))) {
        anterior = q;
        if (!ehQuadroDeEtiqueta(janela, pos, q)) {
          if (tiques + q.tiques > tiquesNoTotal) return { ok: false, codigo: "LONGO_DEMAIS" };
          if (atual && (atual.tiques + q.tiques > tiquesPorParte || atual.bytes + q.tamanho > bytesPorParte)) {
            partes.push(fechada(atual));
            atual = null;
          }
          atual ??= { faixas: [], bytes: 0, tiques: 0 };
          const ultima = atual.faixas[atual.faixas.length - 1];
          if (ultima && ultima.fim === pos) ultima.fim += q.tamanho;
          else atual.faixas.push({ inicio: pos, fim: pos + q.tamanho });
          atual.bytes += q.tamanho;
          atual.tiques += q.tiques;
          tiques += q.tiques;
          bytesDeAudio += q.tamanho;
        }
        pos += q.tamanho;
        continue;
      }
      // Não é quadro (nem etiqueta): lixo até o próximo candidato que a janela
      // tiver, o 0xFF de um quadro ou o "I" de um ID3 (a etiqueta depois do
      // lixo sai inteira, sem a capa dela virar lixo).
      anterior = null;
      const candidatos = [janela.procurar(0xff, pos + 1), janela.procurar(0x49, pos + 1)].filter(p => p >= 0);
      const proximo = candidatos.length ? Math.min(...candidatos) : -1;
      const ate = proximo < 0 || proximo > limite ? limite : proximo;
      lixo += ate - pos;
      pos = ate;
      if (lixo > Math.max(LIXO_TOLERADO, bytesDeAudio)) return { ok: false, codigo: "NAO_E_MP3" };
    }
  }
  if (atual) partes.push(fechada(atual));
  if (!partes.length || lixo > bytesDeAudio) return { ok: false, codigo: "NAO_E_MP3" };
  return { ok: true, partes, duracaoMs: Math.round(tiques / TIQUES_POR_MS) };
}

// ─── O pedido ao Worker ──────────────────────────────────────────────────────

export type PedidoDeCorte = { arquivo: Blob; opcoes?: Pick<OpcoesDoCorte, "segundosPorParte" | "bytesPorParte" | "segundosNoTotal"> };
export type RespostaDoCorte =
  | { tipo: "lendo"; lidos: number; total: number }
  | { tipo: "pronto"; corte: CorteDoMp3 }
  | { tipo: "erro" };

/** O que o Worker faz com cada pedido: corta e responde, com o andamento da leitura no caminho. */
export async function atenderPedidoDeCorte(pedido: PedidoDeCorte, responder: (resposta: RespostaDoCorte) => void): Promise<void> {
  try {
    const corte = await cortarMp3(lerBlob(pedido.arquivo), pedido.arquivo.size, {
      ...pedido.opcoes,
      aoLer: (lidos, total) => responder({ tipo: "lendo", lidos, total }),
    });
    responder({ tipo: "pronto", corte });
  } catch (erro) {
    // A resposta à página não leva o detalhe; o console do Worker (que aparece
    // no DevTools da página) leva, para distinguir um arquivo estragado de um
    // defeito no corte.
    console.error("[Importação] o corte do MP3 falhou no Worker:", erro);
    responder({ tipo: "erro" });
  }
}
