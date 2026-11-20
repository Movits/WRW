import { corteCancelado, lerBlob, limitesDoCorte, recusa, type CorteDoArquivo, type FormatoDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { cortarAdts } from "./corte-do-adts";
import { cortarFlac } from "./corte-do-flac";
import { cortarMp3 } from "./corte-do-mp3";
import { cortarMp4 } from "./corte-do-mp4";
import { cortarOgg } from "./corte-do-ogg";
import { cortarWav } from "./corte-do-wav";
import { cortarWebm } from "./corte-do-webm";

/**
 * O corte do arquivo importado em partes (H9a, H9b e H9c do plano do
 * gravador): reconhece o formato pelos bytes do começo (a extensão e o tipo
 * que o navegador diz não contam) e chama o corte dele. Cada corte devolve as
 * partes como receitas (lib/corte-comum.ts), que a tela monta com File.slice.
 *
 * | formato                 | corte                    | cada parte      |
 * | ----------------------- | ------------------------ | --------------- |
 * | MP3                     | lib/corte-do-mp3.ts      | MP3 (audio/mpeg) |
 * | AAC em ADTS (.aac)      | lib/corte-do-adts.ts     | ADTS (audio/aac) |
 * | WAV (PCM)               | lib/corte-do-wav.ts      | WAV (audio/wav) |
 * | FLAC                    | lib/corte-do-flac.ts     | FLAC (audio/flac) |
 * | Ogg Opus e Vorbis       | lib/corte-do-ogg.ts      | Ogg (audio/ogg) |
 * | WebM e MKV (Opus, AAC)  | lib/corte-do-webm.ts     | Ogg Opus ou MP4 |
 * | MP4, M4A e MOV (AAC)    | lib/corte-do-mp4.ts      | MP4 fragmentado (audio/mp4) |
 *
 * O módulo não toca o DOM: roda no Worker (workers/corte-do-arquivo.worker.ts),
 * na página quando o Worker não sobe (lib/corte-do-arquivo-no-worker.ts) e nos
 * testes.
 */

/** Os contêineres que se reconhecem pelos bytes, mas que nenhum corte lê. */
const SEM_SUPORTE: Array<{ nome: string; casa: (b: Uint8Array) => boolean }> = [
  { nome: "AVI", casa: b => texto(b, 0, 4) === "RIFF" && texto(b, 8, 4) === "AVI " },
  { nome: "AIFF", casa: b => texto(b, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(texto(b, 8, 4)) },
  { nome: "AMR", casa: b => texto(b, 0, 5) === "#!AMR" },
  { nome: "WMA", casa: b => [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11].every((x, i) => b[i] === x) },
  { nome: "CAF", casa: b => texto(b, 0, 4) === "caff" },
  { nome: "APE", casa: b => texto(b, 0, 4) === "MAC " },
  { nome: "WavPack", casa: b => texto(b, 0, 4) === "wvpk" },
  { nome: "MPEG-TS", casa: b => b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47 },
];
const CAIXAS_INICIAIS_MP4 = new Set(["ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

const texto = (b: Uint8Array, inicio: number, n: number) => (inicio + n <= b.length ? String.fromCharCode(...Array.from(b.subarray(inicio, inicio + n))) : "");

/** Onde o áudio começa depois das etiquetas ID3v2 (antes do MP3, do AAC e do FLAC), ou o fim do que foi lido. */
function depoisDoId3(b: Uint8Array): number {
  let p = 0;
  while (p + 10 <= b.length && texto(b, p, 3) === "ID3" && [6, 7, 8, 9].every(i => !(b[p + i] & 0x80))) {
    p += 10 + ((b[p + 6] << 21) | (b[p + 7] << 14) | (b[p + 8] << 7) | b[p + 9]) + (b[p + 5] & 0x10 ? 10 : 0);
  }
  return p;
}

export type Reconhecimento = { formato: FormatoDoArquivo } | { semSuporte: string } | null;

/**
 * O formato pelos bytes do começo: as assinaturas dos contêineres e, sem
 * nenhuma, o primeiro sincronismo de quadro MPEG (o MP3 ou o AAC em ADTS,
 * que se distinguem pela camada: a do ADTS é 00).
 */
export async function reconhecerFormato(ler: LerBytes, tamanho: number): Promise<Reconhecimento> {
  const inicio = await ler(0, Math.min(tamanho, 64 * 1024));
  const semEtiqueta = SEM_SUPORTE.find(s => s.casa(inicio));
  if (semEtiqueta) return { semSuporte: semEtiqueta.nome };
  if (["RIFF", "RF64", "BW64"].includes(texto(inicio, 0, 4)) && texto(inicio, 8, 4) === "WAVE") return { formato: "wav" };
  if (texto(inicio, 0, 4) === "OggS") return { formato: "ogg" };
  if (inicio[0] === 0x1a && inicio[1] === 0x45 && inicio[2] === 0xdf && inicio[3] === 0xa3) return { formato: "webm" };
  if (CAIXAS_INICIAIS_MP4.has(texto(inicio, 4, 4))) return { formato: "mp4" };
  // O ID3 pode estar antes do MP3, do AAC e do FLAC; e ser maior que o pedaço lido.
  let audio = depoisDoId3(inicio);
  let pedaco = inicio;
  if (audio > inicio.length - 16 && audio < tamanho) {
    pedaco = await ler(audio, Math.min(tamanho, audio + 64 * 1024));
    audio = 0;
  }
  if (texto(pedaco, audio, 4) === "fLaC") return { formato: "flac" };
  for (let p = audio; p + 1 < pedaco.length; p++) {
    if (pedaco[p] !== 0xff || (pedaco[p + 1] & 0xe0) !== 0xe0) continue;
    if ((pedaco[p + 1] & 0xf6) === 0xf0) return { formato: "aac" };
    if ((pedaco[p + 1] & 0x06) !== 0) return { formato: "mp3" };
  }
  // Sem sincronismo no começo: o MP3 com muito lixo antes ainda pode ser lido pelo corte dele.
  return { formato: "mp3" };
}

/** O corte do MP3 (H9a), com as faixas dele como receita. */
async function cortarMp3ComoArquivo(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte): Promise<CorteDoArquivo> {
  const corte = await cortarMp3(ler, tamanho, opcoes);
  if (!corte.ok) return recusa(corte.codigo === "LONGO_DEMAIS" ? "LONGO_DEMAIS" : "DANIFICADO", "mp3");
  if (corte.partes.length > limitesDoCorte(opcoes).partesNoMaximo) return recusa("MUITAS_PARTES", "mp3");
  const partes: ParteCortada[] = corte.partes.map(parte => ({
    novos: new Uint8Array(0),
    ordem: Float64Array.from(parte.faixas.flatMap(faixa => [1, faixa.inicio, faixa.fim])),
    bytes: parte.bytes,
    duracaoMs: parte.duracaoMs,
  }));
  return { ok: true, formato: "mp3", mimeType: "audio/mpeg", partes, duracaoMs: corte.duracaoMs };
}

const CORTES: Record<FormatoDoArquivo, (ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte) => Promise<CorteDoArquivo>> = {
  mp3: cortarMp3ComoArquivo, aac: cortarAdts, wav: cortarWav, flac: cortarFlac, ogg: cortarOgg, webm: cortarWebm, mp4: cortarMp4,
};

/**
 * Corta o arquivo no formato que os bytes dizem. O que não se reconhece
 * recusa com FORMATO_DESCONHECIDO; o contêiner sem corte (AVI, AIFF, WMA...),
 * com SEM_SUPORTE e o nome. O MP3 e o AAC em ADTS se confundem quando há
 * lixo antes do primeiro quadro: o que o primeiro corte não lê, o outro tenta.
 */
export async function cortarArquivo(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  if (opcoes.sinal?.aborted) throw corteCancelado();
  if (tamanho <= 0) return recusa("FORMATO_DESCONHECIDO");
  const reconhecido = await reconhecerFormato(ler, tamanho);
  if (!reconhecido) return recusa("FORMATO_DESCONHECIDO");
  if ("semSuporte" in reconhecido) return recusa("SEM_SUPORTE", undefined, reconhecido.semSuporte);
  const { formato } = reconhecido;
  const corte = await CORTES[formato](ler, tamanho, opcoes);
  if (corte.ok || corte.codigo !== "DANIFICADO" || (formato !== "mp3" && formato !== "aac")) return corte;
  const outro = formato === "mp3" ? "aac" : "mp3";
  const segundo = await CORTES[outro](ler, tamanho, opcoes);
  if (segundo.ok || segundo.codigo !== "DANIFICADO") return segundo;
  // Nem MP3 nem AAC: sem assinatura nenhuma, o arquivo não é áudio que o corte conheça.
  return recusa("FORMATO_DESCONHECIDO");
}

// ─── O pedido ao Worker ──────────────────────────────────────────────────────

export type PedidoDeCorte = { arquivo: Blob; opcoes?: Pick<OpcoesDoCorte, "segundosPorParte" | "bytesPorParte" | "segundosNoTotal" | "partesNoMaximo"> };
export type RespostaDoCorte =
  | { tipo: "lendo"; lidos: number; total: number }
  | { tipo: "pronto"; corte: CorteDoArquivo }
  | { tipo: "erro" };

/** Os buffers das partes, que o Worker passa à página sem copiar. */
export function transferiveisDo(corte: CorteDoArquivo): ArrayBuffer[] {
  if (!corte.ok) return [];
  return corte.partes.flatMap(parte => [parte.novos.buffer, parte.ordem.buffer as ArrayBuffer]);
}

/** O que o Worker faz com cada pedido: corta e responde, com o andamento da leitura no caminho. */
export async function atenderPedidoDeCorte(pedido: PedidoDeCorte, responder: (resposta: RespostaDoCorte, transferir?: ArrayBuffer[]) => void): Promise<void> {
  try {
    const corte = await cortarArquivo(lerBlob(pedido.arquivo), pedido.arquivo.size, {
      ...pedido.opcoes,
      aoLer: (lidos, total) => responder({ tipo: "lendo", lidos, total }),
    });
    responder({ tipo: "pronto", corte }, transferiveisDo(corte));
  } catch (erro) {
    // A resposta à página não leva o detalhe; o console do Worker (que aparece
    // no DevTools da página) leva, para distinguir um arquivo estragado de um
    // defeito no corte.
    console.error("[Importação] o corte do arquivo falhou no Worker:", erro);
    responder({ tipo: "erro" });
  }
}

