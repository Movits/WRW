import { fimSemEtiquetas } from "./corte-do-mp3";
import { ascii, corteCancelado, crc16Flac, crc8Flac, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa, u16be, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { cortarNasPausas, partesDoCorte, SEM_PAUSAS } from "./pausas-do-corte";

/**
 * O corte do FLAC (H9b do plano do gravador). O FLAC não recodifica: cada
 * parte é "fLaC", um STREAMINFO novo e os quadros do arquivo, cortados entre
 * um quadro e outro. Cada quadro diz no cabeçalho o próprio número (ou o da
 * primeira amostra, no fluxo de bloco variável), e por isso cada quadro da
 * parte é renumerado a partir de 0, para a parte começar no tempo 0: o
 * cabeçalho novo ganha o CRC-8 dele, e o quadro inteiro, o CRC-16 refeito. O
 * miolo de cada quadro (os subquadros) vai por File.slice, sem cópia.
 *
 * Os quadros não dizem o próprio tamanho: o fim de um é o começo do seguinte,
 * achado pelo sincronismo, pelo CRC-8 do cabeçalho e pelo número, que precisa
 * ser o próximo da sequência (o que barra os falsos começos no meio do áudio).
 *
 * O STREAMINFO de cada parte leva o total de amostras dela, o MD5 zerado (o do
 * arquivo inteiro não vale para a parte) e os tamanhos de quadro como
 * desconhecidos (o quadro renumerado pode encolher um byte). As etiquetas
 * (VORBIS_COMMENT, PICTURE), a SEEKTABLE e o resto dos metadados ficam de fora;
 * o ID3 que alguns programas põem antes do "fLaC" e depois do áudio, também.
 *
 * O servidor mede cada parte quadro a quadro (server/duracao-do-audio.ts) e a
 * manda ao Gemini como audio/flac. O FLAC de CD ocupa ~700 kbps: a parte de
 * 14 MB tem ~2,5 min, e o arquivo de mais de ~8 h passaria das 200 partes.
 */

const TAXAS = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
/** Folga à frente da posição para ler um cabeçalho de quadro inteiro (até 16 bytes) e o primeiro byte do subquadro. */
const FOLGA = 64;
/** O lixo tolerado entre os metadados e o primeiro quadro. */
const LIXO_TOLERADO = 1024 * 1024;
/** O maior quadro aceito: o maior possível (65.535 amostras, 8 canais de 32 bits) tem ~2 MB sem compressão. */
const QUADRO_MAXIMO = 16 * 1024 * 1024;
/** O salto de número aceito na volta ao quadro depois de um trecho estragado. */
const SALTO_MAXIMO = 1_000_000;

type Cabecalho = {
  inicio: number;
  tamanho: number;
  bloco: number;
  taxa: number;
  variavel: boolean;
  numero: number;
  /** Os 4 primeiros bytes, que a renumeração não muda. */
  fixo: number[];
  /** O tamanho do bloco e a taxa escritos depois do número, quando o código pede. */
  extras: number[];
  codigoDaTaxa: number;
  bits: number;
  canais: number;
};

function lerNumero(j: LeitorEmJanela, p: number): { valor: number; tamanho: number } | null {
  const b = j.b(p);
  let extras: number;
  let valor: number;
  if (b < 0) return null;
  if (b < 0x80) { extras = 0; valor = b; }
  else if ((b & 0xe0) === 0xc0) { extras = 1; valor = b & 0x1f; }
  else if ((b & 0xf0) === 0xe0) { extras = 2; valor = b & 0x0f; }
  else if ((b & 0xf8) === 0xf0) { extras = 3; valor = b & 0x07; }
  else if ((b & 0xfc) === 0xf8) { extras = 4; valor = b & 0x03; }
  else if ((b & 0xfe) === 0xfc) { extras = 5; valor = b & 0x01; }
  else if (b === 0xfe) { extras = 6; valor = 0; }
  else return null;
  for (let k = 1; k <= extras; k++) {
    const c = j.b(p + k);
    if (c < 0 || (c & 0xc0) !== 0x80) return null;
    valor = valor * 64 + (c & 0x3f);
  }
  return { valor, tamanho: 1 + extras };
}

/** O número em UTF-8 "estendido" (até 36 bits, 7 bytes), como o cabeçalho do quadro o escreve. */
export function escreverNumeroFlac(valor: number): number[] {
  if (valor < 0x80) return [valor];
  const tetos = [0x7f, 0x7ff, 0xffff, 0x1fffff, 0x3ffffff, 0x7fffffff, 0xfffffffff];
  let continuacoes = 1;
  while (valor > tetos[continuacoes]) continuacoes++;
  const bytes: number[] = new Array(continuacoes + 1);
  let resto = valor;
  for (let k = continuacoes; k >= 1; k--) {
    bytes[k] = 0x80 | (resto % 64);
    resto = Math.floor(resto / 64);
  }
  bytes[0] = (continuacoes === 6 ? 0xfe : (0xff << (7 - continuacoes)) & 0xff) | resto;
  return bytes;
}

function cabecalhoEm(j: LeitorEmJanela, p: number, taxaDoStreaminfo: number): Cabecalho | null {
  const b1 = j.b(p + 1);
  const b2 = j.b(p + 2);
  const b3 = j.b(p + 3);
  if (j.b(p) !== 0xff || b3 < 0 || (b1 & 0xfe) !== 0xf8) return null;
  const codigoDoBloco = b2 >> 4;
  const codigoDaTaxa = b2 & 0x0f;
  const canais = b3 >> 4;
  const bits = (b3 >> 1) & 7;
  if (codigoDoBloco === 0 || codigoDaTaxa === 15 || canais > 10 || bits === 3 || b3 & 1) return null;
  const variavel = (b1 & 1) === 1;
  const numero = lerNumero(j, p + 4);
  // O número do quadro tem até 31 bits (6 bytes); o da amostra, até 36 (7 bytes).
  if (!numero || (!variavel && numero.tamanho > 6)) return null;
  let i = p + 4 + numero.tamanho;
  const inicioDosExtras = i;
  let bloco: number;
  if (codigoDoBloco === 1) bloco = 192;
  else if (codigoDoBloco <= 5) bloco = 576 << (codigoDoBloco - 2);
  else if (codigoDoBloco === 6) { bloco = j.b(i) + 1; i += 1; }
  else if (codigoDoBloco === 7) { bloco = j.b(i + 1) < 0 ? 0 : j.u16be(i) + 1; i += 2; }
  else bloco = 256 << (codigoDoBloco - 8);
  let taxa: number;
  if (codigoDaTaxa === 0) taxa = taxaDoStreaminfo;
  else if (codigoDaTaxa <= 11) taxa = TAXAS[codigoDaTaxa];
  else if (codigoDaTaxa === 12) { taxa = j.b(i) * 1000; i += 1; }
  else if (codigoDaTaxa === 13) { taxa = j.b(i + 1) < 0 ? 0 : j.u16be(i); i += 2; }
  else { taxa = j.b(i + 1) < 0 ? 0 : j.u16be(i) * 10; i += 2; }
  const crc = j.b(i);
  if (crc < 0 || !(bloco > 0) || !(taxa > 0)) return null;
  let calculado = 0;
  for (let k = p; k < i; k++) calculado = crc8Flac([j.b(k)], 0, 1, calculado);
  if (calculado !== crc) return null;
  const extras: number[] = [];
  for (let k = inicioDosExtras; k < i; k++) extras.push(j.b(k));
  return { inicio: p, tamanho: i + 1 - p, bloco, taxa, variavel, numero: numero.valor, fixo: [0xff, b1, b2, b3], extras, codigoDaTaxa, bits, canais: canais <= 7 ? canais + 1 : 2 };
}

/** O primeiro byte do subquadro: o bit de enchimento zero e um tipo que existe. */
function subquadroValido(j: LeitorEmJanela, p: number) {
  const s = j.b(p);
  const tipo = (s >> 1) & 0x3f;
  return s >= 0 && !(s & 0x80) && (tipo <= 1 || (tipo >= 8 && tipo <= 12) || tipo >= 32);
}

/**
 * Corta o FLAC em partes de até 600 s e 14 MB (ver o comentário do módulo),
 * cada uma fechando numa pausa da fala quando há uma perto do teto
 * (lib/pausas-do-corte.ts). O FLAC não perde nada: os bits por amostra de
 * cada quadro crescem com o logaritmo do volume (a fala a −20 dBFS gasta uns
 * 12 por amostra, o ruído da sala a −60, uns 6), e 2 elevado a eles vira a
 * escala de amplitude em que a pausa se mede, como no WAV.
 */
export async function cortarFlac(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  return cortarNasPausas(o => cortarFlacUmaVez(ler, tamanho, o), tamanho, opcoes, partesDoCorte);
}

async function cortarFlacUmaVez(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte): Promise<CorteDoArquivo> {
  const pausas = opcoes.pausas ?? SEM_PAUSAS;
  const limites = limitesDoCorte(opcoes);
  if (opcoes.sinal?.aborted) throw corteCancelado();
  const janela = new LeitorEmJanela(ler, tamanho, opcoes);

  // O ID3v2 que alguns programas põem antes do "fLaC".
  let pos = 0;
  for (;;) {
    await janela.garantir(pos, pos + 10);
    if (!janela.igual(pos, "ID3")) break;
    const s = [janela.b(pos + 6), janela.b(pos + 7), janela.b(pos + 8), janela.b(pos + 9)];
    if (s.some(x => x < 0 || x & 0x80)) return recusa("DANIFICADO", "flac");
    pos += 10 + ((s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]) + (janela.b(pos + 5) & 0x10 ? 10 : 0);
  }
  await janela.garantir(pos, pos + 4);
  if (!janela.igual(pos, "fLaC")) return recusa("DANIFICADO", "flac");
  pos += 4;

  let streaminfo: number[] | null = null;
  for (let ultimo = false; !ultimo;) {
    await janela.garantir(pos, pos + 4 + 34);
    if (janela.b(pos + 3) < 0) return recusa("DANIFICADO", "flac");
    ultimo = (janela.b(pos) & 0x80) !== 0;
    const tipo = janela.b(pos) & 0x7f;
    const tamanhoDoBloco = janela.u24be(pos + 1);
    if (tipo === 127) return recusa("DANIFICADO", "flac");
    if (tipo === 0) {
      if (tamanhoDoBloco < 34 || janela.b(pos + 4 + 33) < 0) return recusa("DANIFICADO", "flac");
      streaminfo = Array.from(janela.trecho(pos + 4, pos + 4 + 34));
    }
    pos += 4 + tamanhoDoBloco;
  }
  if (!streaminfo) return recusa("DANIFICADO", "flac");
  const taxaDoStreaminfo = (streaminfo[10] << 12) | (streaminfo[11] << 4) | (streaminfo[12] >> 4);
  const fimDoAudio = await fimSemEtiquetas(ler, tamanho);

  /**
   * O primeiro cabeçalho de quadro a partir de `busca` que `serve`, ou null
   * no fim do áudio. A janela segue desde `desde` (o começo do quadro atual,
   * cujo miolo ainda vai ser lido), e a busca para em `teto`.
   */
  const acharCabecalho = async (busca: number, desde: number, teto: number, serve: (c: Cabecalho) => boolean): Promise<Cabecalho | null> => {
    for (;;) {
      // Lê ao menos 1 MB além da busca: só a folga não deixaria a busca andar.
      if (busca + FOLGA >= janela.fim && janela.fim < tamanho) await janela.garantir(desde, busca + FOLGA + 1024 * 1024);
      const limite = Math.min(fimDoAudio, janela.fim >= tamanho ? janela.fim : janela.fim - FOLGA, teto);
      while (busca < limite) {
        const candidato = janela.procurar(0xff, busca);
        if (candidato < 0 || candidato >= limite) {
          busca = limite;
          break;
        }
        if ((janela.b(candidato + 1) & 0xfe) === 0xf8) {
          const c = cabecalhoEm(janela, candidato, taxaDoStreaminfo);
          if (c && subquadroValido(janela, candidato + c.tamanho) && serve(c)) return c;
        }
        busca = candidato + 1;
      }
      if (busca >= fimDoAudio || busca >= teto || janela.fim >= tamanho) return null;
    }
  };

  // O primeiro quadro: logo depois dos metadados (ou depois de um pouco de lixo).
  let atual = await acharCabecalho(pos, pos, pos + LIXO_TOLERADO, () => true);
  if (!atual) return recusa("DANIFICADO", "flac");

  const partes: ParteCortada[] = [];
  type EmMontagem = { montagem: MontagemDaParte; streaminfo: number; quadros: number; amostras: number; segundos: number };
  let parte: EmMontagem | null = null;
  let segundosNoTotal = 0;

  const fecharParte = (p: EmMontagem) => {
    const info = streaminfo!.slice();
    // Tamanhos de quadro desconhecidos (0), o total de amostras da parte (36 bits) e o MD5 zerado.
    for (let k = 4; k < 10; k++) info[k] = 0;
    info[13] = (info[13] & 0xf0) | Math.floor(p.amostras / 2 ** 32) & 0x0f;
    info[14] = (p.amostras >>> 24) & 0xff;
    info[15] = (p.amostras >>> 16) & 0xff;
    info[16] = (p.amostras >>> 8) & 0xff;
    info[17] = p.amostras & 0xff;
    for (let k = 18; k < 34; k++) info[k] = 0;
    p.montagem.escrever(p.streaminfo, [...ascii("fLaC"), 0x80, 0x00, 0x00, 34, ...info]);
    partes.push(p.montagem.fechar(Math.round(p.segundos * 1000)));
  };

  while (atual) {
    // O fim deste quadro é o começo do seguinte: o mesmo tipo de numeração,
    // a mesma taxa, os mesmos bits e canais, e o número que vem depois.
    const esperado = atual.variavel ? atual.numero + atual.bloco : atual.numero + 1;
    const anterior: Cabecalho = atual;
    const seguinte = await acharCabecalho(atual.inicio + atual.tamanho + 2, atual.inicio, atual.inicio + QUADRO_MAXIMO, c =>
      c.variavel === anterior.variavel && c.codigoDaTaxa === anterior.codigoDaTaxa && c.bits === anterior.bits && c.canais === anterior.canais
      && c.numero >= esperado && c.numero - esperado < SALTO_MAXIMO);
    const fim = seguinte ? seguinte.inicio : fimDoAudio;
    // Sem o seguinte antes do teto, e com áudio depois dele: um trecho estragado grande demais para atravessar.
    if (!seguinte && fimDoAudio - atual.inicio > QUADRO_MAXIMO) return recusa("DANIFICADO", "flac");
    await janela.garantir(atual.inicio, fim);

    const inicioDoMiolo = atual.inicio + atual.tamanho;
    const fimDoMiolo = fim - 2;
    if (fimDoMiolo > inicioDoMiolo) {
      const segundos = atual.bloco / atual.taxa;
      if (segundosNoTotal + segundos > limites.segundosNoTotal) return recusa("LONGO_DEMAIS", "flac");
      const numero = (p: EmMontagem) => escreverNumeroFlac(atual!.variavel ? p.amostras : p.quadros);
      const tamanhoNovo = (p: EmMontagem | null) => 4 + (p ? numero(p).length : 1) + atual!.extras.length + 1 + (fimDoMiolo - inicioDoMiolo) + 2;
      if (parte && (parte.segundos + segundos > limites.segundosPorParte || parte.montagem.bytes + tamanhoNovo(parte) > limites.bytesPorParte
        || pausas.antes(parte.segundos * 1000, parte.montagem.bytes))) {
        fecharParte(parte);
        if (partes.length >= limites.partesNoMaximo) return recusa("MUITAS_PARTES", "flac");
        parte = null;
      }
      if (!parte) {
        const montagem = new MontagemDaParte();
        parte = { montagem, streaminfo: montagem.reservar(4 + 4 + 34), quadros: 0, amostras: 0, segundos: 0 };
      }
      const cabecalho = [...atual.fixo, ...numero(parte), ...atual.extras];
      cabecalho.push(crc8Flac(cabecalho));
      const crc = crc16Flac(janela.trecho(inicioDoMiolo, fimDoMiolo), 0, fimDoMiolo - inicioDoMiolo, crc16Flac(cabecalho));
      parte.montagem.novo(cabecalho);
      parte.montagem.doArquivo(inicioDoMiolo, fimDoMiolo);
      parte.montagem.novo(u16be(crc));
      parte.quadros += 1;
      parte.amostras += atual.bloco;
      parte.segundos += segundos;
      segundosNoTotal += segundos;
      // Os bytes, com o número do quadro no maior tamanho (7): a renumeração pode crescê-lo.
      const miolo = fimDoMiolo - inicioDoMiolo;
      pausas.depois(segundos * 1000, 4 + 7 + atual.extras.length + 1 + miolo + 2, pausas.ouvindo ? 2 ** ((8 * miolo) / (atual.bloco * atual.canais)) : 0);
    }
    atual = seguinte;
  }
  if (parte) fecharParte(parte);
  if (!partes.length) return recusa("DANIFICADO", "flac");
  if (partes.length > limites.partesNoMaximo) return recusa("MUITAS_PARTES", "flac");
  return { ok: true, formato: "flac", mimeType: "audio/flac", partes, duracaoMs: Math.round(segundosNoTotal * 1000) };
}
