import { ascii, corteCancelado, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa, u32le, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { cortarMp3, partesCortadasDoMp3 } from "./corte-do-mp3";
import { BLOCO_MS, TRECHO_CALMO_MS } from "./detector-de-pausa";
import { DetectorDePausas, JANELA_DA_PAUSA_MS } from "./pausas-do-corte";

/**
 * O corte do WAV (H9b do plano do gravador): o áudio de gravadores de mão e do
 * gravador do computador. O PCM não tem quadros: cada parte é um trecho dos
 * dados, cortado num múltiplo do alinhamento do bloco (uma amostra de cada
 * canal), com um cabeçalho novo só com o "fmt " do arquivo, o "fact" quando o
 * formato não é o PCM inteiro, e o "data" do tamanho da parte. As etiquetas
 * (LIST/INFO, bext, id3) ficam de fora. O tempo começa em 0 sozinho: o WAV não
 * tem relógio, e o servidor mede bytes ÷ (taxa × alinhamento)
 * (server/duracao-do-audio.ts), a mesma conta daqui.
 *
 * Vale o que o servidor mede pelo alinhamento: PCM, ponto flutuante, A-law e
 * µ-law (também dentro do WAVE_FORMAT_EXTENSIBLE). O MP3 e o MP2 dentro do WAV
 * (o "MP3 em WAV" de gravadores e programas de ligação, formatos 0x55 e 0x50)
 * saem como MP3: o "data" é a própria sequência de quadros MPEG, que o corte do
 * MP3 corta como corta o .mp3 (era o que o arquivo já fazia na H9a). O resto
 * (ADPCM, GSM) não tem suporte. O WAV de 64 bits (RF64/BW64) usa o ds64.
 *
 * O PCM ocupa muito: o de CD (44,1 kHz, 16 bits, estéreo) enche os 14 MB da
 * parte em 83 s, e o arquivo de mais de ~4,6 h passaria das 200 partes da
 * reunião. Esse é recusado antes de a reunião nascer (MUITAS_PARTES).
 *
 * Cada parte fecha numa pausa da fala (lib/pausas-do-corte.ts): o PCM tem as
 * amostras, e o corte lê só a janela antes de cada teto (até 20 s), mede o
 * volume de cada bloco de 20 ms e corta no meio da última pausa. Sem pausa na
 * janela, corta no teto, como antes. Antes, o corte caía a cada 14 MB onde
 * estivesse (a cada 2:46 no WAV mono de 44,1 kHz), e a frase que atravessava a
 * emenda sumia da transcrição.
 */

/** Os formatos que o servidor mede pelo alinhamento (FORMATOS_PCM em server/duracao-do-audio.ts). */
const FORMATOS_ACEITOS = new Set([1, 3, 6, 7]);
/** O MPEG (camadas I e II) e o MP3 dentro do WAV: o "data" são quadros MPEG. */
const FORMATOS_MPEG = new Set([0x50, 0x55]);

/**
 * O WAV com MP3 (ou MP2) dentro: o trecho do "data" vai ao corte do MP3, que
 * pula o que não for quadro, e cada parte sai como audio/mpeg, só com os
 * quadros (o servidor mede o MP3 quadro a quadro). O andamento da leitura
 * conta sobre o arquivo inteiro.
 */
async function cortarMpegDoWav(ler: LerBytes, tamanho: number, dados: { inicio: number; fim: number }, opcoes: OpcoesDoCorte): Promise<CorteDoArquivo> {
  const limites = limitesDoCorte(opcoes);
  const aoLer = opcoes.aoLer;
  const corte = await cortarMp3((inicio, fim) => ler(dados.inicio + inicio, dados.inicio + fim), dados.fim - dados.inicio, {
    ...opcoes,
    aoLer: aoLer ? lidos => aoLer(dados.inicio + lidos, tamanho) : undefined,
  });
  if (!corte.ok) return recusa(corte.codigo === "LONGO_DEMAIS" ? "LONGO_DEMAIS" : "DANIFICADO", "wav");
  if (corte.partes.length > limites.partesNoMaximo) return recusa("MUITAS_PARTES", "wav");
  return { ok: true, formato: "wav", mimeType: "audio/mpeg", partes: partesCortadasDoMp3(corte.partes, dados.inicio), duracaoMs: corte.duracaoMs };
}

/** O quadrado do valor de cada byte do A-law e do µ-law decodificado (G.711), que o volume soma: o sinal não importa. */
const QUADRADOS_DO_G711 = (() => {
  const quadrados = (decodificar: (byte: number) => number) => Float64Array.from({ length: 256 }, (_, byte) => (decodificar(byte) / 32768) ** 2);
  const alaw = (byte: number) => {
    const a = byte ^ 0x55;
    const expoente = (a >> 4) & 7;
    const mantissa = a & 0x0f;
    return expoente === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (expoente - 1);
  };
  const mulaw = (byte: number) => {
    const u = ~byte & 0xff;
    return (((u & 0x0f) << 3) + 0x84 << ((u >> 4) & 7)) - 0x84;
  };
  return { 6: quadrados(alaw), 7: quadrados(mulaw) } as Record<number, Float64Array>;
})();

/** O volume (RMS, de 0 a 1) das amostras de `bytes` (todos os canais), no formato do "fmt ". */
export function volumeDoPcm(bytes: Uint8Array, formato: number, bytesPorAmostra: number): number {
  const n = Math.floor(bytes.length / bytesPorAmostra);
  if (!n) return 0;
  const dados = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const g711 = QUADRADOS_DO_G711[formato];
  let soma = 0;
  for (let k = 0, i = 0; k < n; k++, i += bytesPorAmostra) {
    let valor: number;
    if (g711) { soma += g711[bytes[i]]; continue; }
    if (formato === 3) valor = bytesPorAmostra === 8 ? dados.getFloat64(i, true) : dados.getFloat32(i, true);
    else if (bytesPorAmostra === 1) valor = (bytes[i] - 128) / 128;
    else if (bytesPorAmostra === 2) valor = dados.getInt16(i, true) / 32768;
    else if (bytesPorAmostra === 3) valor = (((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) << 8) >> 8) / 8388608;
    else valor = dados.getInt32(i, true) / 2147483648;
    soma += Number.isFinite(valor) ? valor * valor : 0;
  }
  return Math.sqrt(soma / n);
}

/**
 * Onde a parte que vai de `inicio` até o teto (`teto`, nos bytes do "data")
 * fecha numa pausa: o começo do bloco de 20 ms no meio da última pausa da
 * janela antes do teto, ou null sem pausa. A janela é de até 20 s, e nunca
 * mais que um quarto da parte; lê também uns 300 ms depois do teto, para
 * saber se a pausa continua (o corte nunca passa do teto).
 */
async function fimNaPausa(
  ler: LerBytes, dados: { inicio: number; fim: number }, formato: { formato: number; canais: number; alinhamento: number; bytesPorSegundo: number },
  inicio: number, teto: number, bytesDeDados: number,
): Promise<number | null> {
  const bytesPorAmostra = formato.alinhamento / formato.canais;
  if (!Number.isInteger(bytesPorAmostra) || bytesPorAmostra < 1 || bytesPorAmostra > 8) return null;
  const amostrasPorBloco = Math.max(1, Math.round((formato.bytesPorSegundo / formato.alinhamento) * (BLOCO_MS / 1000)));
  const bytesPorBloco = amostrasPorBloco * formato.alinhamento;
  const msPorBloco = (bytesPorBloco / formato.bytesPorSegundo) * 1000;
  const parteMs = ((teto - inicio) / formato.bytesPorSegundo) * 1000;
  const blocosAntes = Math.floor(Math.min(JANELA_DA_PAUSA_MS, parteMs / 4) / msPorBloco);
  const blocosDepois = Math.ceil(TRECHO_CALMO_MS / msPorBloco);
  if (blocosAntes < 2) return null;
  const desde = teto - blocosAntes * bytesPorBloco;
  const ate = Math.min(bytesDeDados, teto + blocosDepois * bytesPorBloco);
  const bytes = await ler(dados.inicio + desde, dados.inicio + ate);
  if (bytes.length !== ate - desde) throw new Error("Leitura incompleta do arquivo.");
  const detector = new DetectorDePausas();
  for (let k = 0; k * bytesPorBloco < bytes.length; k++) {
    const bloco = bytes.subarray(k * bytesPorBloco, Math.min(bytes.length, (k + 1) * bytesPorBloco));
    detector.acrescentar({
      duracaoMs: (bloco.length / formato.bytesPorSegundo) * 1000,
      nivel: volumeDoPcm(bloco, formato.formato, bytesPorAmostra),
      // Só as fronteiras até o teto: a parte nunca passa dele.
      fronteira: { indice: k, bytes: 0, permitida: k <= blocosAntes },
    });
  }
  const pontos = detector.terminar();
  const ultimo = pontos[pontos.length - 1];
  return ultimo ? desde + ultimo.indice * bytesPorBloco : null;
}

const NOMES: Record<number, string> = { 2: "MS ADPCM", 0x11: "IMA ADPCM", 0x31: "GSM 6.10", 0x50: "MPEG", 0x55: "MP3", 0x160: "WMA", 0x161: "WMA", 0x1610: "AAC", 0x2000: "AC-3" };

export async function cortarWav(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  const limites = limitesDoCorte(opcoes);
  if (opcoes.sinal?.aborted) throw corteCancelado();
  // Só os cabeçalhos dos pedaços são lidos; os dados vão por File.slice.
  // O andamento sobe sempre: o dos cabeçalhos (a janela) e, depois, o da janela
  // de cada pausa, ou o do corte do MP3 de dentro (que lê o "data" duas vezes).
  let avisado = 0;
  const aoLer = opcoes.aoLer && ((lidos: number, total: number) => {
    if (lidos <= avisado) return;
    avisado = lidos;
    opcoes.aoLer?.(lidos, total);
  });
  const janela = new LeitorEmJanela(ler, tamanho, { ...opcoes, aoLer }, 64 * 1024);
  await janela.garantir(0, 12);
  const rf64 = janela.igual(0, "RF64") || janela.igual(0, "BW64");
  if (!(janela.igual(0, "RIFF") || rf64) || !janela.igual(8, "WAVE")) return recusa("DANIFICADO", "wav");

  let fmt: { corpo: number[]; formato: number; taxa: number; alinhamento: number; canais: number } | null = null;
  let dados: { inicio: number; fim: number } | null = null;
  let tamanhoDs64: number | null = null;
  let pos = 12;
  for (let pedacos = 0; pos + 8 <= tamanho && pedacos < 10_000; pedacos++) {
    await janela.garantir(pos, pos + 8 + 64);
    const id = janela.ascii(pos, 4);
    const tamanhoDoPedaco = janela.u32le(pos + 4);
    if (id === "ds64" && rf64 && tamanhoDoPedaco >= 16) tamanhoDs64 = janela.u32le(pos + 16) + janela.u32le(pos + 20) * 4294967296;
    else if (id === "fmt " && tamanhoDoPedaco >= 16) {
      await janela.garantir(pos, pos + 8 + tamanhoDoPedaco);
      const corpo = Array.from(janela.trecho(pos + 8, Math.min(pos + 8 + tamanhoDoPedaco, tamanho)));
      if (corpo.length < 16) return recusa("DANIFICADO", "wav");
      const u16 = (i: number) => corpo[i] | (corpo[i + 1] << 8);
      const formato = u16(0);
      const subformato = formato === 0xfffe && corpo.length >= 26 ? u16(24) : formato;
      const taxa = (corpo[4] | (corpo[5] << 8) | (corpo[6] << 16) | (corpo[7] << 24)) >>> 0;
      fmt = { corpo, formato: subformato, taxa, alinhamento: u16(12), canais: u16(2) };
    } else if (id === "data") {
      // A gravação em fluxo deixa o tamanho em 0 (ou 0xFFFFFFFF, ou maior que o arquivo): vale o que chegou.
      let fim: number;
      if (rf64 && tamanhoDoPedaco === 0xffffffff && tamanhoDs64 !== null) fim = pos + 8 + tamanhoDs64;
      else if (tamanhoDoPedaco === 0 || tamanhoDoPedaco === 0xffffffff) fim = tamanho;
      else fim = pos + 8 + tamanhoDoPedaco;
      dados = { inicio: pos + 8, fim: Math.min(fim, tamanho) };
      break;
    }
    pos += 8 + tamanhoDoPedaco + (tamanhoDoPedaco % 2);
  }
  if (!fmt || !dados) return recusa("DANIFICADO", "wav");
  if (FORMATOS_MPEG.has(fmt.formato)) return cortarMpegDoWav(ler, tamanho, dados, { ...opcoes, aoLer });
  if (!FORMATOS_ACEITOS.has(fmt.formato)) return recusa("SEM_SUPORTE", "wav", NOMES[fmt.formato] ?? `WAV 0x${fmt.formato.toString(16).padStart(4, "0")}`);
  if (!(fmt.taxa > 0 && fmt.alinhamento > 0)) return recusa("DANIFICADO", "wav");

  const bytesPorSegundo = fmt.taxa * fmt.alinhamento;
  const bytesDeDados = Math.floor((dados.fim - dados.inicio) / fmt.alinhamento) * fmt.alinhamento;
  if (bytesDeDados <= 0) return recusa("DANIFICADO", "wav");
  if (bytesDeDados / bytesPorSegundo > limites.segundosNoTotal) return recusa("LONGO_DEMAIS", "wav");

  // O cabeçalho de cada parte: RIFF/WAVE, o "fmt " do arquivo, o "fact" quando
  // o formato não é o PCM inteiro (o WAV o pede; os leitores o ignoram) e o "data".
  const comFact = fmt.formato !== 1;
  const corpoDoFmt = fmt.corpo.length % 2 ? [...fmt.corpo, 0] : fmt.corpo;
  const cabecalho = 12 + 8 + corpoDoFmt.length + (comFact ? 12 : 0) + 8;
  const porSegundos = Math.floor((limites.segundosPorParte * bytesPorSegundo) / fmt.alinhamento) * fmt.alinhamento;
  // Um byte a mais para o enchimento do "data" de tamanho ímpar (o RIFF o pede).
  const porBytes = Math.floor((limites.bytesPorParte - cabecalho - 1) / fmt.alinhamento) * fmt.alinhamento;
  const porParte = Math.min(porSegundos, porBytes);
  if (porParte <= 0) return recusa("DANIFICADO", "wav");
  if (Math.ceil(bytesDeDados / porParte) > limites.partesNoMaximo) return recusa("MUITAS_PARTES", "wav");

  // Onde cada parte termina: na pausa da fala antes do teto, ou no teto.
  const doFormato = { formato: fmt.formato, canais: fmt.canais, alinhamento: fmt.alinhamento, bytesPorSegundo };
  const fins: number[] = [];
  for (let inicio = 0; inicio < bytesDeDados;) {
    if (opcoes.sinal?.aborted) throw corteCancelado();
    const teto = Math.min(inicio + porParte, bytesDeDados);
    // Com `pausas` dado (o corte de sempre, que os testes comparam), sem procurar a pausa.
    const fim = teto < bytesDeDados && fmt.canais > 0 && !opcoes.pausas ? (await fimNaPausa(ler, dados, doFormato, inicio, teto, bytesDeDados)) ?? teto : teto;
    fins.push(fim);
    aoLer?.(dados.inicio + fim, tamanho);
    inicio = fim;
  }
  // As pausas encurtam as partes: se passarem do teto de partes da reunião, o corte fica no teto, como antes.
  if (fins.length > limites.partesNoMaximo) {
    fins.length = 0;
    for (let fim = porParte; ; fim += porParte) {
      fins.push(Math.min(fim, bytesDeDados));
      if (fim >= bytesDeDados) break;
    }
  }

  const partes: ParteCortada[] = [];
  for (let k = 0, inicio = 0; k < fins.length; inicio = fins[k], k++) {
    const n = fins[k] - inicio;
    const enchimento = n % 2;
    const montagem = new MontagemDaParte();
    montagem.novo([
      ...ascii("RIFF"), ...u32le(cabecalho - 8 + n + enchimento), ...ascii("WAVE"),
      ...ascii("fmt "), ...u32le(fmt.corpo.length), ...corpoDoFmt,
      ...(comFact ? [...ascii("fact"), ...u32le(4), ...u32le(n / fmt.alinhamento)] : []),
      ...ascii("data"), ...u32le(n),
    ]);
    montagem.doArquivo(dados.inicio + inicio, dados.inicio + inicio + n);
    if (enchimento) montagem.novo([0]);
    partes.push(montagem.fechar(Math.round((n / bytesPorSegundo) * 1000)));
  }
  return { ok: true, formato: "wav", mimeType: "audio/wav", partes, duracaoMs: Math.round((bytesDeDados / bytesPorSegundo) * 1000) };
}
