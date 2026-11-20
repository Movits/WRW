import {
  ascii, corteCancelado, LeitorEmJanela, limitesDoCorte, recusa, u16le, u32le,
  type CodigoDaRecusaDoCorte, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte,
} from "./corte-comum";
import { lerConfigAac, PartesEmFmp4, type FaixaAac } from "./corte-do-mp4";
import { PartesEmOggOpus } from "./paginas-do-ogg";

/**
 * O corte do WebM e do Matroska (H9b do plano do gravador): o áudio que o
 * Chrome grava (Opus), o de programas de gravação de tela e o MKV do OBS
 * (AAC). O WebM é EBML: elementos com id e tamanho, e os pacotes de áudio
 * moram nos blocos dos clusters. Só a faixa de áudio é lida; os blocos do
 * vídeo são pulados pelo tamanho.
 *
 * As partes não saem em WebM: o WebM com Opus já voltou distorcido do Gemini
 * (PR #158). Os pacotes vão, sem recodificar, para o contêiner que o Gemini e
 * o servidor leem:
 * - o Opus, para o Ogg Opus (lib/paginas-do-ogg.ts), com o OpusHead do
 *   CodecPrivate (o pre-skip do arquivo) e o grânulo contado desde o 0 da
 *   parte, pela soma das amostras do TOC de cada pacote;
 * - o AAC, para o MP4 fragmentado (lib/corte-do-mp4.ts), com o
 *   AudioSpecificConfig do CodecPrivate.
 * O tempo de cada parte começa em 0 nos dois. O resto (Vorbis, MP3, FLAC,
 * AC-3, PCM) ganha a recusa SEM_SUPORTE com o nome; a faixa com
 * ContentEncoding (compressão do MKV ou criptografia), também.
 *
 * O cluster de tamanho desconhecido (o do MediaRecorder) termina no primeiro
 * elemento do nível 1. Um elemento ilegível no meio faz o corte procurar o
 * próximo cluster, como o demuxer; o arquivo cortado no fim fica com o que
 * chegou inteiro.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENTO = 0x18538067;
const ID_FAIXAS = 0x1654ae6b;
const ID_FAIXA = 0xae;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
const ID_BLOCK = 0xa1;
const BYTES_DO_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
/** Os elementos do nível 1: o cluster de tamanho desconhecido termina no primeiro deles. */
const NIVEL_1 = new Set([0x114d9b74, 0x1549a966, ID_FAIXAS, 0x1c53bb6b, ID_CLUSTER, 0x1254c367, 0x1043a770, 0x1941a469, ID_SEGMENTO, ID_EBML]);
const NOMES: Record<string, string> = {
  A_VORBIS: "Vorbis (WebM)", "A_MPEG/L3": "MP3 (WebM/MKV)", "A_MPEG/L2": "MP2 (WebM/MKV)", A_FLAC: "FLAC (WebM/MKV)", A_AC3: "AC-3", A_EAC3: "E-AC-3",
  A_DTS: "DTS", A_ALAC: "ALAC", A_TRUEHD: "TrueHD", "A_PCM/INT/LIT": "PCM", "A_PCM/INT/BIG": "PCM", "A_PCM/FLOAT/IEEE": "PCM", A_TTA1: "TTA", A_WAVPACK4: "WavPack",
};
const TAXAS_AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Quanto o corte procura o próximo cluster depois de um elemento ilegível. */
const BUSCA_DO_CLUSTER = 16 * 1024 * 1024;

type Vint = { valor: number; tamanho: number; desconhecido: boolean };
type Escolhida = { numero: number; opus: PartesEmOggOpus } | { numero: number; aac: PartesEmFmp4; quadro: number };
type Elemento = { id: number; inicio: number; dados: number; tamanho: Vint };

function lerId(j: LeitorEmJanela, p: number): { id: number; tamanho: number } | null {
  const primeiro = j.b(p);
  const tamanho = primeiro & 0x80 ? 1 : primeiro & 0x40 ? 2 : primeiro & 0x20 ? 3 : primeiro & 0x10 ? 4 : 0;
  if (primeiro <= 0 || !tamanho || j.b(p + tamanho - 1) < 0) return null;
  let id = 0;
  for (let i = 0; i < tamanho; i++) id = id * 256 + j.b(p + i);
  return { id, tamanho };
}

function lerVint(j: LeitorEmJanela, p: number): Vint | null {
  const primeiro = j.b(p);
  if (primeiro <= 0) return null;
  let tamanho = 1;
  let mascara = 0x80;
  while (!(primeiro & mascara)) { mascara >>= 1; tamanho++; }
  if (j.b(p + tamanho - 1) < 0) return null;
  let valor = primeiro & (mascara - 1);
  let desconhecido = valor === mascara - 1;
  for (let i = 1; i < tamanho; i++) {
    valor = valor * 256 + j.b(p + i);
    if (j.b(p + i) !== 0xff) desconhecido = false;
  }
  return { valor, tamanho, desconhecido };
}

const lerUint = (j: LeitorEmJanela, inicio: number, fim: number) => {
  let valor = 0;
  for (let p = inicio; p < fim && p < inicio + 8; p++) valor = valor * 256 + j.b(p);
  return valor;
};

/** O número de ponto flutuante de 4 ou 8 bytes do EBML (a taxa do Audio). */
const lerFloat = (j: LeitorEmJanela, inicio: number, fim: number) => {
  const n = fim - inicio;
  if (n !== 4 && n !== 8) return 0;
  const v = new DataView(new ArrayBuffer(n));
  for (let i = 0; i < n; i++) v.setUint8(i, j.b(inicio + i));
  return n === 4 ? v.getFloat32(0) : v.getFloat64(0);
};

type Faixa = {
  numero: number; tipo: number; codec: string; privado: Uint8Array | null; atraso: number;
  taxa: number; canais: number; codificada: boolean;
};

/** O OpusHead do CodecPrivate; sem ele, um montado com os canais (até 2), a taxa e o atraso da faixa. */
function opusHeadDe(faixa: Faixa): Uint8Array | null {
  const p = faixa.privado;
  if (p && p.length >= 19 && String.fromCharCode(...Array.from(p.subarray(0, 8))) === "OpusHead") return p;
  if (p || faixa.canais > 2) return null;
  const preSkip = Math.round((faixa.atraso * 48000) / 1e9);
  return Uint8Array.from([...ascii("OpusHead"), 1, faixa.canais || 2, ...u16le(preSkip), ...u32le(Math.round(faixa.taxa) || 48000), 0, 0, 0]);
}

/** O AudioSpecificConfig do CodecPrivate; sem ele, o montado pelo CodecID antigo (A_AAC/MPEG4/LC...), a taxa e os canais. */
function ascDe(faixa: Faixa): Uint8Array | null {
  if (faixa.privado && faixa.privado.length >= 2) return faixa.privado;
  const perfil = /\/(MAIN|LC|SSR|LTP)$/.exec(faixa.codec)?.[1];
  const objeto = perfil ? { MAIN: 1, LC: 2, SSR: 3, LTP: 4 }[perfil] : 0;
  const taxa = Math.round(faixa.taxa);
  if (!objeto || !(taxa > 0) || !(faixa.canais > 0 && faixa.canais <= 7)) return null;
  const indice = TAXAS_AAC.indexOf(taxa);
  // 5 bits do objeto, 4 do índice da taxa (ou 15 e a taxa em 24), 4 dos canais e os 3 do GASpecificConfig em 0.
  const bits: number[] = [];
  const escrever = (valor: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >> i) & 1); };
  escrever(objeto, 5);
  if (indice >= 0) escrever(indice, 4);
  else { escrever(15, 4); escrever(taxa, 24); }
  escrever(faixa.canais, 4);
  escrever(0, 3);
  while (bits.length % 8) bits.push(0);
  const bytes = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { bytes[i >> 3] |= b << (7 - (i & 7)); });
  return bytes;
}

/**
 * Os quadros de um bloco (o pacote sozinho ou os do laçamento Xiph, fixo ou
 * EBML), como trechos do arquivo. `p` aponta para o byte depois do número da
 * faixa (o tempo relativo).
 */
function quadrosDoBloco(j: LeitorEmJanela, p: number, fim: number): Array<[number, number]> | null {
  const lacamento = (j.b(p + 2) >> 1) & 3;
  p += 3;
  if (p > fim) return null;
  if (lacamento === 0) return [[p, fim]];
  if (p >= fim) return null;
  const quantos = j.b(p) + 1;
  p += 1;
  const tamanhos: number[] = [];
  if (lacamento === 1) {
    for (let i = 0; i < quantos - 1; i++) {
      let soma = 0;
      for (let byte = 255; byte === 255;) {
        if (p >= fim) return null;
        byte = j.b(p++);
        soma += byte;
      }
      tamanhos.push(soma);
    }
  } else if (lacamento === 3) {
    const primeiro = lerVint(j, p);
    if (!primeiro) return null;
    p += primeiro.tamanho;
    let atual = primeiro.valor;
    tamanhos.push(atual);
    for (let i = 1; i < quantos - 1; i++) {
      const delta = lerVint(j, p);
      if (!delta) return null;
      p += delta.tamanho;
      atual += delta.valor - (2 ** (7 * delta.tamanho - 1) - 1);
      tamanhos.push(atual);
    }
  } else {
    if ((fim - p) % quantos !== 0) return null;
    for (let i = 0; i < quantos - 1; i++) tamanhos.push((fim - p) / quantos);
  }
  const usados = tamanhos.reduce((s, t) => s + t, 0);
  tamanhos.push(fim - p - usados);
  const quadros: Array<[number, number]> = [];
  for (const tamanho of tamanhos) {
    if (tamanho < 0 || p + tamanho > fim) return null;
    quadros.push([p, p + tamanho]);
    p += tamanho;
  }
  return quadros;
}

/** Corta o WebM ou o Matroska (Opus ou AAC) em partes de até 600 s e 14 MB (ver o comentário do módulo). */
export async function cortarWebm(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  if (opcoes.sinal?.aborted) throw corteCancelado();
  const janela = new LeitorEmJanela(ler, tamanho, opcoes);

  const elementoEm = async (p: number): Promise<Elemento | null> => {
    await janela.garantir(p, p + 16);
    const id = lerId(janela, p);
    const tam = id ? lerVint(janela, p + id.tamanho) : null;
    return id && tam ? { id: id.id, inicio: p, dados: p + id.tamanho + tam.tamanho, tamanho: tam } : null;
  };

  /** O próximo cluster a partir de `p`, para continuar depois de um elemento ilegível; -1 se não houver. */
  const proximoCluster = async (p: number, fimDoSegmento: number): Promise<number> => {
    for (let busca = p; busca < Math.min(fimDoSegmento, p + BUSCA_DO_CLUSTER);) {
      await janela.garantir(busca, busca + 1024 * 1024);
      const limite = Math.min(janela.fim, fimDoSegmento);
      for (let q = janela.procurar(BYTES_DO_CLUSTER[0], busca); q >= 0 && q + 4 <= limite; q = janela.procurar(BYTES_DO_CLUSTER[0], q + 1)) {
        if (BYTES_DO_CLUSTER.every((b, i) => janela.b(q + i) === b)) return q;
      }
      if (janela.fim >= tamanho) return -1;
      busca = Math.max(busca + 1, limite - 3);
    }
    return -1;
  };

  const ebml = await elementoEm(0);
  if (!ebml || ebml.id !== ID_EBML || ebml.tamanho.desconhecido) return recusa("DANIFICADO", "webm");
  let pos = ebml.dados + ebml.tamanho.valor;
  // Pode haver Void antes do Segment.
  let segmento = await elementoEm(pos);
  while (segmento && segmento.id !== ID_SEGMENTO && !segmento.tamanho.desconhecido && segmento.dados + segmento.tamanho.valor < tamanho) {
    pos = segmento.dados + segmento.tamanho.valor;
    segmento = await elementoEm(pos);
  }
  if (!segmento || segmento.id !== ID_SEGMENTO) return recusa("DANIFICADO", "webm");
  const fimDoSegmento = segmento.tamanho.desconhecido ? tamanho : Math.min(tamanho, segmento.dados + segmento.tamanho.valor);

  let faixas: Faixa[] | null = null;
  // A faixa escolhida mora num objeto: o TypeScript não acompanha a troca de uma variável dentro das funções abaixo.
  const estado: { escolhida: Escolhida | null } = { escolhida: null };

  /** Um quadro (pacote) da faixa escolhida, em [inicio, fim) do arquivo, já na janela. */
  const porQuadro = (inicio: number, fim: number): CodigoDaRecusaDoCorte | null => {
    const escolhida = estado.escolhida;
    if (!escolhida) return null;
    if ("opus" in escolhida) return escolhida.opus.adicionar(inicio, janela.trecho(inicio, fim));
    return fim > inicio ? escolhida.aac.adicionar(inicio, fim - inicio, escolhida.quadro) : null;
  };

  const lerFaixas = async (elem: Elemento): Promise<Faixa[] | CorteDoArquivo> => {
    const fimDoElemento = elem.dados + elem.tamanho.valor;
    const lidas: Faixa[] = [];
    for (let p = elem.dados; p < fimDoElemento;) {
      const entrada = await elementoEm(p);
      if (!entrada || entrada.tamanho.desconhecido) return recusa("DANIFICADO", "webm");
      const fimDaEntrada = entrada.dados + entrada.tamanho.valor;
      if (entrada.id === ID_FAIXA) {
        await janela.garantir(entrada.inicio, fimDaEntrada);
        const faixa: Faixa = { numero: 0, tipo: 0, codec: "", privado: null, atraso: 0, taxa: 0, canais: 0, codificada: false };
        for (let q = entrada.dados; q < fimDaEntrada;) {
          const campo = await elementoEm(q);
          if (!campo || campo.tamanho.desconhecido) break;
          const fimDoCampo = campo.dados + campo.tamanho.valor;
          if (campo.id === 0xd7) faixa.numero = lerUint(janela, campo.dados, fimDoCampo);
          else if (campo.id === 0x83) faixa.tipo = lerUint(janela, campo.dados, fimDoCampo);
          else if (campo.id === 0x86) faixa.codec = janela.ascii(campo.dados, campo.tamanho.valor).replace(/\0+$/, "");
          else if (campo.id === 0x63a2) faixa.privado = janela.trecho(campo.dados, Math.min(fimDoCampo, fimDaEntrada)).slice();
          else if (campo.id === 0x56aa) faixa.atraso = lerUint(janela, campo.dados, fimDoCampo);
          else if (campo.id === 0x6d80) faixa.codificada = true;
          else if (campo.id === 0xe1) {
            for (let r = campo.dados; r < fimDoCampo;) {
              const sub = await elementoEm(r);
              if (!sub || sub.tamanho.desconhecido) break;
              const fimDoSub = sub.dados + sub.tamanho.valor;
              if (sub.id === 0xb5) faixa.taxa = lerFloat(janela, sub.dados, fimDoSub);
              else if (sub.id === 0x9f) faixa.canais = lerUint(janela, sub.dados, fimDoSub);
              r = fimDoSub;
            }
          }
          q = fimDoCampo;
        }
        lidas.push(faixa);
      }
      p = fimDaEntrada;
    }
    return lidas;
  };

  /** A faixa de áudio escolhida (a primeira Opus ou AAC), ou a recusa. */
  const escolher = (lidas: Faixa[]): CorteDoArquivo | null => {
    const audios = lidas.filter(f => f.tipo === 2 || (f.tipo === 0 && f.codec.startsWith("A_")));
    if (!audios.length) return recusa("SEM_AUDIO", "webm");
    for (const faixa of audios) {
      if (faixa.codificada) continue;
      if (faixa.codec === "A_OPUS") {
        const head = opusHeadDe(faixa);
        if (head) {
          estado.escolhida = { numero: faixa.numero, opus: new PartesEmOggOpus(head, opcoes) };
          return null;
        }
      } else if (faixa.codec.startsWith("A_AAC")) {
        const asc = ascDe(faixa);
        const config = asc ? lerConfigAac(asc) : null;
        if (asc && config?.quadro) {
          const dados: FaixaAac = {
            asc, config, escala: config.taxa, canais: (config.canais === 7 ? 8 : config.canais) || faixa.canais || 2,
            taxaDaEntrada: Math.round(faixa.taxa) || config.taxa, bitrateMedio: 0, bitrateMaximo: 0,
          };
          estado.escolhida = { numero: faixa.numero, aac: new PartesEmFmp4(dados, opcoes), quadro: config.quadro };
          return null;
        }
      }
    }
    const primeira = audios[0];
    const nome = primeira.codificada ? "MKV (ContentEncoding)" : primeira.codec.startsWith("A_AAC") ? "AAC (WebM/MKV)"
      : NOMES[primeira.codec] ?? (primeira.codec.replace(/^A_/, "") || "WebM");
    return recusa("SEM_SUPORTE", "webm", nome);
  };

  pos = segmento.dados;
  while (pos < fimDoSegmento) {
    if (opcoes.sinal?.aborted) throw corteCancelado();
    const elem = await elementoEm(pos);
    if (!elem) {
      // Ilegível: o demuxer procura o próximo cluster; sem ele, o arquivo acabou aqui.
      if (!estado.escolhida) return recusa("DANIFICADO", "webm");
      const proximo = await proximoCluster(pos + 1, fimDoSegmento);
      if (proximo < 0) break;
      pos = proximo;
      continue;
    }
    if (elem.id === ID_CLUSTER) {
      if (!faixas) return recusa("DANIFICADO", "webm");
      const fimDoCluster = elem.tamanho.desconhecido ? fimDoSegmento : Math.min(fimDoSegmento, elem.dados + elem.tamanho.valor);
      let p = elem.dados;
      let truncado = false;
      while (p < fimDoCluster) {
        const filho = await elementoEm(p);
        if (!filho) {
          const proximo = await proximoCluster(p + 1, fimDoSegmento);
          p = proximo < 0 ? fimDoSegmento : proximo;
          truncado = true;
          break;
        }
        // O cluster de tamanho desconhecido termina no primeiro elemento do nível 1.
        if (elem.tamanho.desconhecido && NIVEL_1.has(filho.id)) break;
        if (filho.tamanho.desconhecido) return recusa("DANIFICADO", "webm");
        const fimDoFilho = filho.dados + filho.tamanho.valor;
        if (fimDoFilho > tamanho) {
          // O bloco cortado no fim do arquivo fica de fora.
          p = fimDoSegmento;
          truncado = true;
          break;
        }
        if (filho.id === ID_SIMPLEBLOCK || filho.id === ID_BLOCKGROUP) {
          // O Block dentro do BlockGroup (o primeiro filho, quase sempre).
          let bloco = filho.dados;
          let fimDoBloco = fimDoFilho;
          if (filho.id === ID_BLOCKGROUP) {
            bloco = -1;
            for (let q = filho.dados; q < fimDoFilho;) {
              const neto = await elementoEm(q);
              if (!neto || neto.tamanho.desconhecido) break;
              if (neto.id === ID_BLOCK) { bloco = neto.dados; fimDoBloco = Math.min(fimDoFilho, neto.dados + neto.tamanho.valor); break; }
              q = neto.dados + neto.tamanho.valor;
            }
          }
          if (bloco >= 0) {
            await janela.garantir(bloco, bloco + 16);
            const faixa = lerVint(janela, bloco);
            if (faixa && estado.escolhida && faixa.valor === estado.escolhida.numero) {
              await janela.garantir(filho.inicio, fimDoFilho);
              const quadros = quadrosDoBloco(janela, bloco + faixa.tamanho, fimDoBloco);
              for (const [inicio, fim] of quadros ?? []) {
                const motivo = porQuadro(inicio, fim);
                if (motivo) return recusa(motivo, "webm");
              }
            }
          }
        }
        p = fimDoFilho;
      }
      pos = elem.tamanho.desconhecido || truncado ? p : fimDoCluster;
      continue;
    }
    if (elem.tamanho.desconhecido) return recusa("DANIFICADO", "webm");
    if (elem.id === ID_FAIXAS && !faixas) {
      const lidas = await lerFaixas(elem);
      if (!Array.isArray(lidas)) return lidas;
      faixas = lidas;
      const recusada = escolher(lidas);
      if (recusada) return recusada;
    }
    pos = elem.dados + elem.tamanho.valor;
  }
  if (!faixas) return recusa("DANIFICADO", "webm");
  const final = estado.escolhida;
  if (!final) return recusa("SEM_AUDIO", "webm");
  const escritor = "opus" in final ? final.opus : final.aac;
  escritor.fechar();
  if (!escritor.partes.length) return recusa("DANIFICADO", "webm");
  if (escritor.partes.length > limitesDoCorte(opcoes).partesNoMaximo) return recusa("MUITAS_PARTES", "webm");
  return {
    ok: true, formato: "webm", mimeType: "opus" in final ? "audio/ogg" : "audio/mp4", partes: escritor.partes, duracaoMs: escritor.duracaoMs,
  };
}
