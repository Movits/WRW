import { ascii, corteCancelado, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa, u32le, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { cortarMp3, partesCortadasDoMp3 } from "./corte-do-mp3";

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
const NOMES: Record<number, string> = { 2: "MS ADPCM", 0x11: "IMA ADPCM", 0x31: "GSM 6.10", 0x50: "MPEG", 0x55: "MP3", 0x160: "WMA", 0x161: "WMA", 0x1610: "AAC", 0x2000: "AC-3" };

export async function cortarWav(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  const limites = limitesDoCorte(opcoes);
  if (opcoes.sinal?.aborted) throw corteCancelado();
  // Só os cabeçalhos dos pedaços são lidos; os dados vão por File.slice.
  const janela = new LeitorEmJanela(ler, tamanho, opcoes, 64 * 1024);
  await janela.garantir(0, 12);
  const rf64 = janela.igual(0, "RF64") || janela.igual(0, "BW64");
  if (!(janela.igual(0, "RIFF") || rf64) || !janela.igual(8, "WAVE")) return recusa("DANIFICADO", "wav");

  let fmt: { corpo: number[]; formato: number; taxa: number; alinhamento: number } | null = null;
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
      fmt = { corpo, formato: subformato, taxa, alinhamento: u16(12) };
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
  if (FORMATOS_MPEG.has(fmt.formato)) return cortarMpegDoWav(ler, tamanho, dados, opcoes);
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

  const partes: ParteCortada[] = [];
  for (let inicio = 0; inicio < bytesDeDados; inicio += porParte) {
    const n = Math.min(porParte, bytesDeDados - inicio);
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
