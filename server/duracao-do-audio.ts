/**
 * A duração REAL de um áudio, medida nos bytes que vão para a IA.
 *
 * A duração que a tela envia (`durationSeconds`) é declarada pelo navegador,
 * ou por quem chamar a API direto. Com ela, o limite de 10 minutos por reunião
 * e o contador de minutos (minutos-de-reuniao.ts) valiam o que o cliente
 * dissesse: 60 s declarados com 55 min de áudio a 24 kbps passavam, e o Gemini
 * transcrevia os 55 (revisão adversarial de 15/09). A tela honesta também
 * errava: arquivo cuja duração o navegador não lê caía em 60 s.
 *
 * Onde dá, a medida CONTA o que o decodificador entrega, em vez de ler o campo
 * "duração" do contêiner:
 * - WAV: bytes de dados ÷ (taxa × alinhamento do bloco);
 * - MP3/MP2 e AAC em ADTS: quadro a quadro;
 * - Opus em Ogg e em WebM (o que o MediaRecorder grava): pelo byte TOC de cada pacote;
 * - AAC em MP4/M4A, inclusive fragmentado (o que o Safari grava): nº de
 *   quadros da tabela × 1024 ÷ a taxa do AudioSpecificConfig;
 * - FLAC: quadro a quadro, pelo tamanho do bloco de cada cabeçalho (H9b, a
 *   importação em partes; o envio único não recebe FLAC).
 * Forjar esses campos não ajuda a passar do limite: taxa ou alinhamento falsos
 * fazem o decodificador tocar outro áudio (acelerado, ruído), e a contagem de
 * quadros é a própria lista que o decodificador lê.
 *
 * Codecs que nenhum navegador grava (Vorbis; o que não é AAC dentro de MP4; o
 * que não é Opus dentro de WebM) caem nos carimbos de tempo do contêiner.
 * Formato não reconhecido devolve null, e quem chama recusa: áudio que não se
 * mede não se limita. MP4 que estoura os tetos de faixas ou de caixas (forjado
 * para custar tempo, não para tocar) também devolve null.
 */

const ascii = (b: Buffer, pos: number, n: number) => (pos >= 0 && pos + n <= b.length ? b.toString("latin1", pos, pos + n) : "");
const u16 = (b: Buffer, pos: number) => (pos + 2 <= b.length ? b.readUInt16BE(pos) : 0);
const u32 = (b: Buffer, pos: number) => (pos + 4 <= b.length ? b.readUInt32BE(pos) : 0);

/** Segundos de áudio, ou null quando o formato não é reconhecido ou não tem áudio mensurável. */
export function medirDuracaoDoAudio(audio: Buffer): number | null {
  return analisarAudio(audio).segundos;
}

/**
 * A duração (como medirDuracaoDoAudio) e os codecs das faixas de áudio que a
 * medida achou, pelo nome que o contêiner dá: no MP4, o código da entrada
 * (`mp4a` é o AAC, `alac`, `ac-3`, `Opus`...); no Matroska e no WebM, o
 * CodecID (`A_OPUS`, `A_VORBIS`, `A_AC3`...); no Ogg, `opus` ou `vorbis`;
 * no WAV, `wav:` e o código do formato (1 é o PCM; 2, o ADPCM...); no FLAC,
 * `flac`; e o resto, `mpeg`. Serve à rota das partes (G14, parte 2), que
 * converte em MP3 a parte de um codec que o Gemini não lista
 * (precisaConverterParaOGemini, em server/fatias-de-reuniao.ts).
 */
export function analisarAudio(audio: Buffer): { segundos: number | null; codecs: string[] } {
  let segundos: number | null;
  const codecs: string[] = [];
  try {
    const b = audio.subarray(inicioDepoisDoId3(audio));
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") segundos = duracaoWav(b, codecs);
    else if (ascii(b, 0, 4) === "OggS") segundos = duracaoOgg(b, codecs);
    else if (ascii(b, 0, 4) === "fLaC") { codecs.push("flac"); segundos = duracaoFlac(b); }
    else if (u32(b, 0) === 0x1a45dfa3) segundos = duracaoMatroska(b, codecs);
    else if (CAIXAS_INICIAIS_MP4.has(ascii(b, 4, 4))) segundos = duracaoMp4(b, codecs);
    else { codecs.push("mpeg"); segundos = duracaoMpeg(b); }
  } catch {
    segundos = null;
  }
  return { segundos: segundos !== null && Number.isFinite(segundos) && segundos > 0 ? segundos : null, codecs };
}

/** Etiquetas ID3v2 antes do áudio (MP3 e, às vezes, outros formatos). */
function inicioDepoisDoId3(b: Buffer): number {
  let pos = 0;
  while (pos + 10 <= b.length && ascii(b, pos, 3) === "ID3") {
    const tamanho = ((b[pos + 6] & 0x7f) << 21) | ((b[pos + 7] & 0x7f) << 14) | ((b[pos + 8] & 0x7f) << 7) | (b[pos + 9] & 0x7f);
    pos += 10 + tamanho + (b[pos + 5] & 0x10 ? 10 : 0);
  }
  return Math.min(pos, b.length);
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

/** PCM, ponto flutuante, A-law e µ-law: o decodificador lê taxa × alinhamento. */
const FORMATOS_PCM = new Set([1, 3, 6, 7]);

function duracaoWav(b: Buffer, codecs: string[] = []): number | null {
  let bytesPorSegundo = 0;
  let bytesDeDados = 0;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = ascii(b, pos, 4);
    const tamanho = b.readUInt32LE(pos + 4);
    const dados = pos + 8;
    if (id === "fmt " && tamanho >= 16 && dados + 16 <= b.length) {
      const formato = b.readUInt16LE(dados);
      const taxa = b.readUInt32LE(dados + 4);
      const declarado = b.readUInt32LE(dados + 8);
      const alinhamento = b.readUInt16LE(dados + 12);
      const subformato = formato === 0xfffe && tamanho >= 26 && dados + 26 <= b.length ? b.readUInt16LE(dados + 24) : formato;
      bytesPorSegundo = FORMATOS_PCM.has(subformato) && alinhamento > 0 ? taxa * alinhamento : declarado;
      codecs.push(`wav:${subformato}`);
    } else if (id === "data") {
      // Gravação em fluxo deixa o tamanho em 0 ou maior que o arquivo: vale o que chegou.
      const disponiveis = b.length - dados;
      if (tamanho === 0 || tamanho >= disponiveis) {
        bytesDeDados += disponiveis;
        break;
      }
      bytesDeDados += tamanho;
    }
    pos = dados + tamanho + (tamanho % 2);
  }
  return bytesPorSegundo > 0 ? bytesDeDados / bytesPorSegundo : null;
}

// ─── Opus ────────────────────────────────────────────────────────────────────

/** Amostras (a 48 kHz) de um pacote Opus, pelo byte TOC (RFC 6716, §3.1). */
function amostrasOpus(b: Buffer, pos: number, tamanho: number): number {
  if (tamanho < 1) return 0;
  const toc = b[pos];
  const config = toc >> 3;
  const porQuadro = config < 12 ? [480, 960, 1920, 2880][config % 4]
    : config < 16 ? [480, 960][(config - 12) % 2]
    : [120, 240, 480, 960][(config - 16) % 4];
  const codigo = toc & 3;
  const quadros = codigo === 0 ? 1 : codigo !== 3 ? 2 : tamanho < 2 ? 0 : b[pos + 1] & 0x3f;
  const amostras = quadros * porQuadro;
  // Acima de 120 ms o pacote é inválido e o decodificador o descarta.
  return amostras > 5760 ? 0 : amostras;
}

// ─── Ogg ─────────────────────────────────────────────────────────────────────

type FluxoOgg = {
  codec: "opus" | "vorbis" | "ignorado" | "desconhecido" | null;
  pacotes: number;
  amostrasOpus: number;
  pacotesVorbis: number;
  taxaVorbis: number;
  blocoCurtoVorbis: number;
  granulo: number;
  inicio: Buffer | null;
  tamanhoPendente: number;
};

function duracaoOgg(b: Buffer, codecs: string[] = []): number | null {
  const fluxos: Record<number, FluxoOgg> = {};
  const seriais: number[] = [];

  const fecharPacote = (fluxo: FluxoOgg) => {
    const inicio = fluxo.inicio ?? Buffer.alloc(0);
    const tamanho = fluxo.tamanhoPendente;
    if (fluxo.pacotes === 0) {
      if (ascii(inicio, 0, 8) === "OpusHead") fluxo.codec = "opus";
      else if (ascii(inicio, 0, 7) === "\x01vorbis" && inicio.length >= 29) {
        fluxo.codec = "vorbis";
        fluxo.taxaVorbis = inicio.readUInt32LE(12);
        fluxo.blocoCurtoVorbis = 1 << (inicio[28] & 0x0f);
      } else if (ascii(inicio, 0, 8) === "fishead\0" || ascii(inicio, 0, 7) === "\x80theora") fluxo.codec = "ignorado";
      else fluxo.codec = "desconhecido";
    } else if (fluxo.codec === "opus" && fluxo.pacotes >= 2) {
      fluxo.amostrasOpus += amostrasOpus(inicio, 0, Math.min(tamanho, inicio.length));
    } else if (fluxo.codec === "vorbis" && fluxo.pacotes >= 3 && tamanho > 0) {
      fluxo.pacotesVorbis++;
    }
    fluxo.pacotes++;
    fluxo.inicio = null;
    fluxo.tamanhoPendente = 0;
  };

  let pos = 0;
  while (pos + 27 <= b.length) {
    if (ascii(b, pos, 4) !== "OggS") {
      const proxima = b.indexOf("OggS", pos + 1, "latin1");
      if (proxima < 0) break;
      pos = proxima;
      continue;
    }
    const continua = (b[pos + 5] & 1) === 1;
    const granuloBaixo = b.readUInt32LE(pos + 6);
    const granuloAlto = b.readInt32LE(pos + 10);
    const serial = b.readUInt32LE(pos + 14);
    const segmentos = b[pos + 26];
    if (pos + 27 + segmentos > b.length) break;
    let fluxo = fluxos[serial];
    if (!fluxo) {
      fluxo = { codec: null, pacotes: 0, amostrasOpus: 0, pacotesVorbis: 0, taxaVorbis: 0, blocoCurtoVorbis: 0, granulo: 0, inicio: null, tamanhoPendente: 0 };
      fluxos[serial] = fluxo;
      seriais.push(serial);
    }
    // Página que não continua o pacote anterior descarta o pedaço que sobrou.
    if (!continua) { fluxo.inicio = null; fluxo.tamanhoPendente = 0; }
    let dado = pos + 27 + segmentos;
    for (let i = 0; i < segmentos; i++) {
      const laco = b[pos + 27 + i];
      const fim = Math.min(b.length, dado + laco);
      // Só o começo do pacote interessa (cabeçalho do codec, TOC do Opus).
      const falta = 64 - (fluxo.inicio?.length ?? 0);
      if (falta > 0 && fim > dado) {
        const pedaco = b.subarray(dado, Math.min(fim, dado + falta));
        fluxo.inicio = fluxo.inicio ? Buffer.concat([fluxo.inicio, pedaco]) : Buffer.from(pedaco);
      }
      fluxo.tamanhoPendente += fim - dado;
      dado += laco;
      if (laco < 255 && dado <= b.length) fecharPacote(fluxo);
    }
    // Grânulo -1 (página em que nenhum pacote termina) fica de fora.
    if (granuloAlto >= 0) {
      fluxo.granulo = Math.max(fluxo.granulo, granuloAlto * 4294967296 + granuloBaixo);
    }
    pos = dado;
  }

  let maior = 0;
  for (const serial of seriais) {
    const fluxo = fluxos[serial];
    if (fluxo.codec === "ignorado") continue;
    codecs.push(fluxo.codec ?? "desconhecido");
    if (fluxo.codec === "opus") maior = Math.max(maior, fluxo.amostrasOpus / 48000);
    else if (fluxo.codec === "vorbis" && fluxo.taxaVorbis > 0) {
      // Todo pacote de áudio Vorbis rende ao menos meio bloco curto: o piso
      // impede que um grânulo forjado encolha o arquivo sem limite.
      const piso = fluxo.pacotesVorbis * (fluxo.blocoCurtoVorbis / 2);
      maior = Math.max(maior, Math.max(fluxo.granulo, piso) / fluxo.taxaVorbis);
    } else return null;
  }
  return maior || null;
}

// ─── Matroska / WebM ─────────────────────────────────────────────────────────

const ID_CLUSTER = 0x1f43b675;
const BYTES_DO_CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
/** Elementos em que se entra (os filhos são lidos na sequência): Segment, Info, Tracks, TrackEntry, Cluster, BlockGroup. */
const CONTEINERES_MATROSKA = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, ID_CLUSTER, 0xa0]);

function lerVint(b: Buffer, pos: number): { valor: number; tamanho: number; desconhecido: boolean } | null {
  if (pos >= b.length || b[pos] === 0) return null;
  const primeiro = b[pos];
  let tamanho = 1;
  let mascara = 0x80;
  while (!(primeiro & mascara)) { mascara >>= 1; tamanho++; }
  if (pos + tamanho > b.length) return null;
  let valor = primeiro & (mascara - 1);
  let desconhecido = valor === mascara - 1;
  for (let i = 1; i < tamanho; i++) {
    valor = valor * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) desconhecido = false;
  }
  return { valor, tamanho, desconhecido };
}

function lerIdMatroska(b: Buffer, pos: number): { id: number; tamanho: number } | null {
  if (pos >= b.length) return null;
  const primeiro = b[pos];
  const tamanho = primeiro & 0x80 ? 1 : primeiro & 0x40 ? 2 : primeiro & 0x20 ? 3 : primeiro & 0x10 ? 4 : 0;
  if (!tamanho || pos + tamanho > b.length) return null;
  let id = 0;
  for (let i = 0; i < tamanho; i++) id = id * 256 + b[pos + i];
  return { id, tamanho };
}

const lerInteiro = (b: Buffer, inicio: number, fim: number) => {
  let valor = 0;
  for (let p = inicio; p < fim && p < inicio + 8; p++) valor = valor * 256 + b[p];
  return valor;
};

function duracaoMatroska(b: Buffer, codecs: string[] = []): number | null {
  type Faixa = { numero: number; tipo: number; codec: string };
  const faixas: Faixa[] = [];
  const amostrasOpusPorFaixa: Record<number, number> = {};
  const ultimoInicioNsPorFaixa: Record<number, number> = {};
  let faixa: Faixa | null = null;
  let escalaNs = 1_000_000;
  let tempoDoCluster = 0;

  const lerBloco = (inicio: number, fim: number) => {
    const numero = lerVint(b, inicio);
    if (!numero || numero.desconhecido) return;
    let p = inicio + numero.tamanho;
    if (p + 3 > fim) return;
    const relativo = b.readInt16BE(p);
    const lacamento = (b[p + 2] >> 1) & 3;
    p += 3;
    const faixaDoBloco = numero.valor;
    ultimoInicioNsPorFaixa[faixaDoBloco] = Math.max(ultimoInicioNsPorFaixa[faixaDoBloco] ?? 0, (tempoDoCluster + relativo) * escalaNs);

    const tamanhos: number[] = [];
    if (lacamento !== 0) {
      if (p >= fim) return;
      const quadros = b[p] + 1;
      p += 1;
      if (lacamento === 1) {
        for (let i = 0; i < quadros - 1; i++) {
          let soma = 0;
          let byte = 255;
          while (byte === 255) {
            if (p >= fim) return;
            byte = b[p++];
            soma += byte;
          }
          tamanhos.push(soma);
        }
      } else if (lacamento === 3 && quadros > 1) {
        const primeiro = lerVint(b, p);
        if (!primeiro) return;
        p += primeiro.tamanho;
        let atual = primeiro.valor;
        tamanhos.push(atual);
        for (let i = 1; i < quadros - 1; i++) {
          const delta = lerVint(b, p);
          if (!delta) return;
          p += delta.tamanho;
          atual += delta.valor - (Math.pow(2, 7 * delta.tamanho - 1) - 1);
          tamanhos.push(atual);
        }
      } else if (lacamento === 2) {
        if ((fim - p) % quadros !== 0) return;
        for (let i = 0; i < quadros - 1; i++) tamanhos.push((fim - p) / quadros);
      }
    }
    const usados = tamanhos.reduce((soma, t) => soma + t, 0);
    tamanhos.push(fim - p - usados);
    for (const tamanho of tamanhos) {
      if (tamanho < 0 || p + tamanho > fim) return;
      amostrasOpusPorFaixa[faixaDoBloco] = (amostrasOpusPorFaixa[faixaDoBloco] ?? 0) + amostrasOpus(b, p, tamanho);
      p += tamanho;
    }
  };

  let pos = 0;
  while (pos < b.length) {
    const id = lerIdMatroska(b, pos);
    const tamanho = id ? lerVint(b, pos + id.tamanho) : null;
    // Elemento ilegível: procura o próximo Cluster, como faz o demuxer.
    const ressincronizar = () => b.indexOf(BYTES_DO_CLUSTER, pos + 1);
    if (!id || !tamanho) {
      pos = ressincronizar();
      if (pos < 0) break;
      continue;
    }
    const dados = pos + id.tamanho + tamanho.tamanho;
    if (CONTEINERES_MATROSKA.has(id.id)) {
      if (id.id === 0xae) { faixa = { numero: 0, tipo: 0, codec: "" }; faixas.push(faixa); }
      if (id.id === ID_CLUSTER) tempoDoCluster = 0;
      pos = dados;
      continue;
    }
    if (tamanho.desconhecido) {
      pos = ressincronizar();
      if (pos < 0) break;
      continue;
    }
    const fim = Math.min(b.length, dados + tamanho.valor);
    if (id.id === 0x2ad7b1) escalaNs = lerInteiro(b, dados, fim) || 1_000_000;
    else if (id.id === 0xd7 && faixa) faixa.numero = lerInteiro(b, dados, fim);
    else if (id.id === 0x83 && faixa) faixa.tipo = lerInteiro(b, dados, fim);
    else if (id.id === 0x86 && faixa) faixa.codec = ascii(b, dados, fim - dados);
    else if (id.id === 0xe7) tempoDoCluster = lerInteiro(b, dados, fim);
    else if (id.id === 0xa3 || id.id === 0xa1) lerBloco(dados, fim);
    if (dados + tamanho.valor > b.length) break;
    pos = dados + tamanho.valor;
  }

  const audios = faixas.filter(f => f.tipo === 2 || (f.tipo === 0 && f.codec.startsWith("A_")));
  let maior = 0;
  for (const f of audios) {
    codecs.push(f.codec);
    const segundos = f.codec === "A_OPUS"
      ? (amostrasOpusPorFaixa[f.numero] ?? 0) / 48000
      : (ultimoInicioNsPorFaixa[f.numero] ?? 0) / 1e9;
    maior = Math.max(maior, segundos);
  }
  return maior || null;
}

// ─── MP4 / M4A ───────────────────────────────────────────────────────────────

const CAIXAS_INICIAIS_MP4 = new Set(["ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "pnot"]);
const CAIXAS_DE_PASSAGEM_MP4 = new Set(["moov", "mdia", "minf", "stbl", "mvex", "moof"]);
/**
 * Tetos contra MP4 forjado (item 9 da revisão da PR #135): cada `trak` de 8
 * bytes virava uma faixa, e cada `tfhd` percorria a lista inteira — 1,28 MB de
 * caixas mínimas levou 34 s síncronos, e o envio aceita 10 MB (1,3 milhão de
 * caixas). Uma gravação real tem uma ou duas faixas; 10 min do Safari fatiados
 * a cada 250 ms têm uns 2.400 fragmentos de ~7 caixas (17 mil). Ao estourar, a
 * medição desiste (null) e quem chama recusa, como faz com formato desconhecido.
 */
const TETO_DE_FAIXAS_MP4 = 64;
const TETO_DE_CAIXAS_MP4 = 200_000;
const TAXAS_AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Tipos de objeto de áudio MPEG-4 com GASpecificConfig (quadro de 1024 ou 960; 512 ou 480 no LD). */
const AAC_COM_QUADRO_FIXO = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);

type FaixaMp4 = {
  id: number; manipulador: string; escala: number; codec: string;
  taxaAac: number; quadroAac: number;
  amostrasTabela: number; amostrasFragmentos: number; unidades: number;
};

function duracaoMp4(b: Buffer, codecs: string[] = []): number | null {
  const faixas: FaixaMp4[] = [];
  const duracaoPadraoPorFaixa: Record<number, number> = {};
  let faixa: FaixaMp4 | null = null;
  let fragmento: { faixa: FaixaMp4 | undefined; duracaoPadrao: number } | null = null;
  let caixasVisitadas = 0;
  let desistiu = false;

  /** Faixa pelo id, para o `tfhd` achar a sua sem varrer a lista. Havendo duas com o mesmo id, vale a primeira. */
  const faixaPorId = new Map<number, FaixaMp4>();
  const indexarFaixa = (f: FaixaMp4, id: number) => {
    if (faixaPorId.get(f.id) === f) faixaPorId.delete(f.id);
    f.id = id;
    if (!faixaPorId.has(id)) faixaPorId.set(id, f);
  };

  const lerAudioSpecificConfig = (f: FaixaMp4, inicio: number, fim: number) => {
    let bit = inicio * 8;
    const bits = (n: number) => {
      let valor = 0;
      for (let i = 0; i < n; i++, bit++) {
        if (bit >> 3 >= fim) throw new Error("fim do AudioSpecificConfig");
        valor = valor * 2 + ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      return valor;
    };
    const tipoDeObjeto = () => { const t = bits(5); return t === 31 ? 32 + bits(6) : t; };
    let tipo = tipoDeObjeto();
    const indice = bits(4);
    const taxa = indice === 15 ? bits(24) : TAXAS_AAC[indice] ?? 0;
    bits(4);
    if (tipo === 5 || tipo === 29) {
      // SBR/PS explícito: a taxa lida acima é a do núcleo AAC, que é a dos quadros.
      if (bits(4) === 15) bits(24);
      tipo = tipoDeObjeto();
    }
    if (!taxa) return;
    if (AAC_COM_QUADRO_FIXO.has(tipo)) {
      const quadroCurto = bits(1) === 1;
      f.quadroAac = tipo === 23 ? (quadroCurto ? 480 : 512) : quadroCurto ? 960 : 1024;
      f.taxaAac = taxa;
    }
  };

  const lerEsds = (f: FaixaMp4, inicio: number, fim: number) => {
    let p = inicio + 4;
    const descritor = () => {
      if (p >= fim) return null;
      const tag = b[p++];
      let tamanho = 0;
      for (let i = 0; i < 4 && p < fim; i++) {
        const byte = b[p++];
        tamanho = tamanho * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      return { tag, tamanho };
    };
    if (descritor()?.tag !== 3) return;
    p += 2;
    const opcoes = b[p++];
    if (opcoes & 0x80) p += 2;
    if (opcoes & 0x40) p += 1 + b[p];
    if (opcoes & 0x20) p += 2;
    if (descritor()?.tag !== 4) return;
    const objeto = b[p];
    p += 13;
    if (![0x40, 0x66, 0x67, 0x68].includes(objeto)) return;
    const especifico = descritor();
    if (especifico?.tag !== 5) return;
    // AudioSpecificConfig truncado não derruba a medida: a faixa cai nos carimbos de tempo.
    try {
      lerAudioSpecificConfig(f, p, Math.min(fim, p + especifico.tamanho));
    } catch {
      f.taxaAac = 0;
    }
  };

  const procurarEsds = (f: FaixaMp4, inicio: number, fim: number, profundidade: number) => {
    let pos = inicio;
    while (pos + 8 <= fim && profundidade < 4) {
      const tamanho = u32(b, pos);
      if (tamanho < 8) return;
      const tipo = ascii(b, pos + 4, 4);
      const final = Math.min(fim, pos + tamanho);
      if (tipo === "esds") lerEsds(f, pos + 8, final);
      else if (tipo === "wave") procurarEsds(f, pos + 8, final, profundidade + 1);
      pos += tamanho;
    }
  };

  const lerStsd = (f: FaixaMp4, inicio: number, fim: number) => {
    // Primeira entrada. AudioSampleEntry: 8 do cabeçalho, 8 reservados, 20 de campos de áudio.
    const entrada = inicio + 8;
    if (entrada + 36 > fim) return;
    const final = Math.min(fim, entrada + u32(b, entrada));
    f.codec = ascii(b, entrada + 4, 4);
    if (f.codec !== "mp4a") return;
    const versaoQuickTime = u16(b, entrada + 16);
    procurarEsds(f, entrada + 36 + (versaoQuickTime === 1 ? 16 : versaoQuickTime === 2 ? 36 : 0), final, 0);
  };

  const percorrer = (inicio: number, fim: number, profundidade: number) => {
    let pos = inicio;
    while (!desistiu && pos + 8 <= fim && profundidade < 12) {
      if (++caixasVisitadas > TETO_DE_CAIXAS_MP4) { desistiu = true; return; }
      let tamanho = u32(b, pos);
      let cabecalho = 8;
      if (tamanho === 1) { tamanho = u32(b, pos + 8) * 4294967296 + u32(b, pos + 12); cabecalho = 16; }
      else if (tamanho === 0) tamanho = fim - pos;
      if (tamanho < cabecalho) return;
      const tipo = ascii(b, pos + 4, 4);
      const dados = pos + cabecalho;
      const final = Math.min(fim, pos + tamanho);
      const versao = b[dados];
      const flags = u32(b, dados) & 0xffffff;
      if (tipo === "trak") {
        if (faixas.length >= TETO_DE_FAIXAS_MP4) { desistiu = true; return; }
        faixa = { id: 0, manipulador: "", escala: 0, codec: "", taxaAac: 0, quadroAac: 0, amostrasTabela: 0, amostrasFragmentos: 0, unidades: 0 };
        faixas.push(faixa);
        indexarFaixa(faixa, 0);
        percorrer(dados, final, profundidade + 1);
        faixa = null;
      } else if (tipo === "traf") {
        fragmento = { faixa: undefined, duracaoPadrao: 0 };
        percorrer(dados, final, profundidade + 1);
        fragmento = null;
      } else if (CAIXAS_DE_PASSAGEM_MP4.has(tipo)) {
        percorrer(dados, final, profundidade + 1);
      } else if (faixa && tipo === "tkhd") {
        indexarFaixa(faixa, u32(b, dados + (versao === 1 ? 20 : 12)));
      } else if (faixa && tipo === "mdhd") {
        faixa.escala = u32(b, dados + (versao === 1 ? 20 : 12));
      } else if (faixa && tipo === "hdlr" && ascii(b, dados + 4, 4) !== "dhlr") {
        // No QuickTime, minf tem um segundo hdlr (o de dados, "dhlr") que não diz o tipo da faixa.
        faixa.manipulador = ascii(b, dados + 8, 4);
      } else if (faixa && tipo === "stsd") {
        lerStsd(faixa, dados, final);
      } else if (faixa && tipo === "stts") {
        let contadas = 0;
        const entradas = u32(b, dados + 4);
        for (let i = 0, p = dados + 8; i < entradas && p + 8 <= final; i++, p += 8) {
          contadas += u32(b, p);
          faixa.unidades += u32(b, p) * u32(b, p + 4);
        }
        faixa.amostrasTabela = Math.max(faixa.amostrasTabela, contadas);
      } else if (faixa && (tipo === "stsz" || tipo === "stz2")) {
        faixa.amostrasTabela = Math.max(faixa.amostrasTabela, u32(b, dados + 8));
      } else if (tipo === "trex") {
        duracaoPadraoPorFaixa[u32(b, dados + 4)] = u32(b, dados + 12);
      } else if (fragmento && tipo === "tfhd") {
        const id = u32(b, dados + 4);
        let p = dados + 8;
        if (flags & 0x1) p += 8;
        if (flags & 0x2) p += 4;
        fragmento.faixa = faixaPorId.get(id);
        fragmento.duracaoPadrao = flags & 0x8 ? u32(b, p) : duracaoPadraoPorFaixa[id] ?? 0;
      } else if (fragmento?.faixa && tipo === "trun") {
        const alvo = fragmento.faixa;
        const amostras = u32(b, dados + 4);
        alvo.amostrasFragmentos += amostras;
        let p = dados + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
        if (flags & 0x100) {
          const passo = 4 * [0x100, 0x200, 0x400, 0x800].filter(bit => flags & bit).length;
          for (let i = 0; i < amostras && p + 4 <= final; i++, p += passo) alvo.unidades += u32(b, p);
        } else {
          alvo.unidades += amostras * fragmento.duracaoPadrao;
        }
      }
      pos += tamanho;
    }
  };

  percorrer(0, b.length, 0);
  if (desistiu) return null;

  let maior = 0;
  for (const f of faixas) {
    if (f.manipulador !== "soun") continue;
    codecs.push(f.codec);
    const amostras = f.amostrasTabela + f.amostrasFragmentos;
    const segundos = f.taxaAac > 0 ? (amostras * f.quadroAac) / f.taxaAac : f.escala > 0 ? f.unidades / f.escala : 0;
    maior = Math.max(maior, segundos);
  }
  return maior || null;
}

// ─── FLAC ────────────────────────────────────────────────────────────────────

/** As taxas dos códigos 1 a 11 do cabeçalho do quadro FLAC (RFC 9639, §9.1.2). */
const TAXAS_FLAC = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
/**
 * O piso da taxa de cada quadro na conta. O quadro com a taxa escrita no
 * próprio cabeçalho pode dizer 1 Hz, e um falso começo de quadro no meio do
 * áudio com 1 Hz faria a medida explodir (4.096 amostras viram 68 min). Áudio
 * de verdade não tem menos de 8 kHz, e o quadro forjado abaixo disso toca
 * desacelerado, um ruído que não se transcreve.
 */
const TAXA_FLAC_MINIMA = 8000;
const CRC8_FLAC = (() => {
  const tabela = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    tabela[i] = c;
  }
  return tabela;
})();

/**
 * O quadro FLAC que começa em `p`, ou null: o sincronismo, os campos sem os
 * valores reservados, o número (do quadro ou da amostra) em UTF-8, o CRC-8 do
 * cabeçalho e um cabeçalho de subquadro válido logo depois, como o
 * decodificador exige para tocar o quadro.
 */
function quadroFlacEm(b: Buffer, p: number, taxaDoStreaminfo: number): { amostras: number; taxa: number; cabecalho: number } | null {
  if (p + 6 > b.length || b[p] !== 0xff || (b[p + 1] & 0xfe) !== 0xf8) return null;
  const codigoDoBloco = b[p + 2] >> 4;
  const codigoDaTaxa = b[p + 2] & 0x0f;
  const canais = b[p + 3] >> 4;
  const bitsPorAmostra = (b[p + 3] >> 1) & 7;
  if (codigoDoBloco === 0 || codigoDaTaxa === 15 || canais > 10 || bitsPorAmostra === 3 || (b[p + 3] & 1)) return null;
  let i = p + 4;
  const primeiro = b[i++];
  const extras = primeiro < 0x80 ? 0 : (primeiro & 0xe0) === 0xc0 ? 1 : (primeiro & 0xf0) === 0xe0 ? 2 : (primeiro & 0xf8) === 0xf0 ? 3
    : (primeiro & 0xfc) === 0xf8 ? 4 : (primeiro & 0xfe) === 0xfc ? 5 : primeiro === 0xfe ? 6 : -1;
  if (extras < 0) return null;
  for (let k = 0; k < extras; k++, i++) if (i >= b.length || (b[i] & 0xc0) !== 0x80) return null;
  let amostras: number;
  if (codigoDoBloco === 1) amostras = 192;
  else if (codigoDoBloco <= 5) amostras = 576 << (codigoDoBloco - 2);
  else if (codigoDoBloco === 6) amostras = b[i++] + 1;
  else if (codigoDoBloco === 7) { amostras = ((b[i] << 8) | b[i + 1]) + 1; i += 2; }
  else amostras = 256 << (codigoDoBloco - 8);
  let taxa: number;
  if (codigoDaTaxa === 0) taxa = taxaDoStreaminfo;
  else if (codigoDaTaxa <= 11) taxa = TAXAS_FLAC[codigoDaTaxa];
  else if (codigoDaTaxa === 12) taxa = b[i++] * 1000;
  else if (codigoDaTaxa === 13) { taxa = (b[i] << 8) | b[i + 1]; i += 2; }
  else { taxa = ((b[i] << 8) | b[i + 1]) * 10; i += 2; }
  // O CRC-8 e o primeiro byte do subquadro precisam estar no buffer.
  if (i + 1 >= b.length || !(taxa > 0) || !(amostras > 0)) return null;
  let crc = 0;
  for (let k = p; k < i; k++) crc = CRC8_FLAC[crc ^ b[k]];
  if (crc !== b[i]) return null;
  // Subquadro: o bit de enchimento é zero, e o tipo não é reservado
  // (000000 constante, 000001 literal, 001000 a 001100 fixo, 1xxxxx LPC).
  const subquadro = b[i + 1];
  const tipo = (subquadro >> 1) & 0x3f;
  if (subquadro & 0x80 || !(tipo <= 1 || (tipo >= 8 && tipo <= 12) || tipo >= 32)) return null;
  return { amostras, taxa: Math.max(taxa, TAXA_FLAC_MINIMA), cabecalho: i + 1 - p };
}

/**
 * FLAC: soma o bloco de cada quadro, à taxa que o quadro usa (a do STREAMINFO
 * quando ele não escreve a dele). O total de amostras do STREAMINFO não conta:
 * é um campo, e forjá-lo não muda o que o decodificador entrega. Os quadros não
 * dizem o próprio tamanho; a busca acha cada cabeçalho que confere (o mesmo que
 * o decodificador exige para tocar o quadro, inclusive com o CRC-16 do fim
 * estragado, que ele não confere por padrão). Um falso começo de quadro no meio
 * do áudio, que passa por tudo isso, é raro e só aumenta a medida.
 */
function duracaoFlac(b: Buffer): number | null {
  let pos = 4;
  let taxaDoStreaminfo = 0;
  for (let ultimo = false; !ultimo;) {
    if (pos + 4 > b.length) return null;
    ultimo = (b[pos] & 0x80) !== 0;
    const tipo = b[pos] & 0x7f;
    const tamanho = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    if (tipo === 127) return null;
    if (tipo === 0 && tamanho >= 34 && pos + 4 + 34 <= b.length) taxaDoStreaminfo = (b[pos + 14] << 12) | (b[pos + 15] << 4) | (b[pos + 16] >> 4);
    pos += 4 + tamanho;
  }
  let segundos = 0;
  let quadros = 0;
  while (pos < b.length) {
    const candidato = b.indexOf(0xff, pos);
    if (candidato < 0) break;
    const quadro = quadroFlacEm(b, candidato, taxaDoStreaminfo);
    if (!quadro) {
      pos = candidato + 1;
      continue;
    }
    segundos += quadro.amostras / quadro.taxa;
    quadros++;
    pos = candidato + quadro.cabecalho;
  }
  return quadros ? segundos : null;
}

// ─── MP3 / MP2 / AAC em ADTS ─────────────────────────────────────────────────

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
const TAXAS_MPEG = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];

type Quadro = { tamanho: number; amostras: number; taxa: number };

function quadroEm(b: Buffer, p: number): Quadro | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const versao = (b[p + 1] >> 3) & 3;
  const camadaBits = (b[p + 1] >> 1) & 3;
  if (camadaBits === 0) {
    // ADTS: sincronismo de 12 bits e camada 00.
    if (p + 7 > b.length || (b[p + 1] & 0xf6) !== 0xf0) return null;
    const taxa = TAXAS_AAC[(b[p + 2] >> 2) & 0xf];
    const tamanho = ((b[p + 3] & 3) << 11) | (b[p + 4] << 3) | (b[p + 5] >> 5);
    if (!taxa || tamanho < 7) return null;
    return { tamanho, amostras: 1024 * ((b[p + 6] & 3) + 1), taxa };
  }
  if (versao === 1) return null;
  const camada = 4 - camadaBits;
  const indiceBitrate = b[p + 2] >> 4;
  const indiceTaxa = (b[p + 2] >> 2) & 3;
  if (indiceBitrate === 0 || indiceBitrate === 15 || indiceTaxa === 3) return null;
  const mpeg1 = versao === 3;
  const bitrate = (mpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[camada - 1][indiceBitrate] * 1000;
  const taxa = TAXAS_MPEG[versao][indiceTaxa];
  const enchimento = (b[p + 2] >> 1) & 1;
  if (camada === 1) return { tamanho: (Math.floor((12 * bitrate) / taxa) + enchimento) * 4, amostras: 384, taxa };
  const amostras = camada === 2 || mpeg1 ? 1152 : 576;
  return { tamanho: Math.floor(((amostras / 8) * bitrate) / taxa) + enchimento, amostras, taxa };
}

function duracaoMpeg(b: Buffer): number | null {
  // O áudio precisa COMEÇAR por um quadro (zeros de enchimento à parte): assim
  // um contêiner que não reconhecemos não vira "MP3" por causa de meia dúzia
  // de bytes que parecem quadro no meio dele.
  let pos = 0;
  while (pos < b.length && pos < 65536 && b[pos] === 0) pos++;
  const confirma = (p: number) => p === b.length || quadroEm(b, p) !== null;
  const primeiro = quadroEm(b, pos);
  if (!primeiro || pos + primeiro.tamanho > b.length || !confirma(pos + primeiro.tamanho)) return null;

  let segundos = 0;
  let emSequencia = false;
  while (pos + 4 <= b.length) {
    const quadro = quadroEm(b, pos);
    if (quadro && pos + quadro.tamanho <= b.length && (emSequencia || confirma(pos + quadro.tamanho))) {
      segundos += quadro.amostras / quadro.taxa;
      pos += quadro.tamanho;
      emSequencia = true;
      continue;
    }
    // Lixo no meio (etiqueta, bytes corrompidos): procura o próximo quadro que se confirma.
    emSequencia = false;
    const proximo = b.indexOf(0xff, pos + 1);
    if (proximo < 0) break;
    pos = proximo;
  }
  return segundos;
}
