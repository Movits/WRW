import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { PARTE_BYTES_MAX } from "./corte-comum";
import { cortarWav, volumeDoPcm } from "./corte-do-wav";
import { SEM_PAUSAS } from "./pausas-do-corte";
import { ascii, juntar, leitorDe, u16le, u32le, wav, type OpcoesDoWav } from "@/test/audio-sintetico";
import { mesmosBytes, montar, partesDe } from "@/test/conferir-partes";
import { MPEG1_128K, quadros, type FormatoDoQuadro } from "@/test/mp3-sintetico";

/** O quadro MPEG-1 camada II a 128 kbps e 44,1 kHz (o MP2): 417 bytes, 1.152 amostras. */
const MPEG1_CAMADA_2: FormatoDoQuadro = { cabecalho: [0xff, 0xfd, 0x80, 0x00], tamanho: 417, segundos: 1152 / 44100 };

/**
 * O corte do WAV (H9b): cada parte é um WAV sozinho, com o "fmt " do arquivo,
 * o "fact" quando o formato não é o PCM inteiro e um trecho dos dados cortado
 * no alinhamento do bloco. Os arquivos são sintéticos (test/audio-sintetico.ts).
 */

const texto = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

/** Os pedaços de um WAV (id, onde começa o corpo e o tamanho). */
function pedacos(b: Uint8Array) {
  const lista: Array<{ id: string; corpo: number; tamanho: number }> = [];
  for (let p = 12; p + 8 <= b.length;) {
    const tamanho = u32(b, p + 4);
    lista.push({ id: texto(b, p, 4), corpo: p + 8, tamanho });
    p += 8 + tamanho + (tamanho % 2);
  }
  return lista;
}

async function cortar(o: OpcoesDoWav, opcoes: Parameters<typeof cortarWav>[2] = {}) {
  const arquivo = wav(o);
  return { arquivo, corte: await cortarWav(leitorDe(arquivo.bytes), arquivo.bytes.length, opcoes) };
}

describe("cortarWav", () => {
  it.each<[string, OpcoesDoWav]>([
    ["o PCM de 16 bits, mono, com as etiquetas (LIST, bext) de fora", { segundos: 25, etiquetas: true }],
    ["o PCM de 24 bits, estéreo", { segundos: 25, bits: 24, canais: 2, taxa: 44100 }],
    ["o ponto flutuante de 32 bits, que pede o fact", { segundos: 25, formato: 3, bits: 32 }],
    ["o WAVE_FORMAT_EXTENSIBLE com PCM", { segundos: 25, formato: 0xfffe, subformato: 1, canais: 2 }],
    ["o tamanho do data em 0 (a gravação em fluxo): vale o que chegou", { segundos: 25, dataEmZero: true }],
    ["o RF64 (o WAV de 64 bits), com o ds64", { segundos: 25, rf64: true }],
  ])("%s: partes de até 10 s, cada uma um WAV sozinho, e os dados juntos são os do arquivo", async (_caso, o) => {
    const { arquivo, corte } = await cortar(o, { segundosPorParte: 10 });
    expect(corte).toMatchObject({ ok: true, formato: "wav", mimeType: "audio/wav", duracaoMs: 25_000 });
    const partes = partesDe(corte);
    expect(partes.map(p => p.duracaoMs)).toEqual([10_000, 10_000, 5_000]);
    const dados: Uint8Array[] = [];
    for (const parte of partes) {
      const b = montar(arquivo.bytes, parte);
      expect(b.length).toBe(parte.bytes);
      expect(texto(b, 0, 4)).toBe("RIFF");
      expect(texto(b, 8, 4)).toBe("WAVE");
      expect(u32(b, 4)).toBe(b.length - 8);
      const lista = pedacos(b);
      // Só o fmt, o fact (fora do PCM inteiro) e o data: as etiquetas ficam de fora.
      expect(lista.map(p => p.id)).toEqual(o.formato === 3 ? ["fmt ", "fact", "data"] : ["fmt ", "data"]);
      const fmt = lista[0];
      expect(u16(b, fmt.corpo + 12)).toBe(arquivo.alinhamento);
      const data = lista[lista.length - 1];
      expect(data.tamanho % arquivo.alinhamento).toBe(0);
      if (lista[1].id === "fact") expect(u32(b, lista[1].corpo)).toBe(data.tamanho / arquivo.alinhamento);
      dados.push(b.subarray(data.corpo, data.corpo + data.tamanho));
    }
    const juntos = new Uint8Array(dados.reduce((s, d) => s + d.length, 0));
    dados.reduce((p, d) => { juntos.set(d, p); return p + d.length; }, 0);
    expect(mesmosBytes(juntos, arquivo.dados)).toBe(true);
  });

  it("o PCM de CD (44,1 kHz, 16 bits, estéreo) enche os 14 MB antes dos 600 s: a parte fecha nos bytes", async () => {
    const { arquivo, corte } = await cortar({ segundos: 200, taxa: 44100, canais: 2, bits: 16 });
    const partes = partesDe(corte);
    expect(partes.length).toBe(3);
    for (const parte of partes) expect(parte.bytes).toBeLessThanOrEqual(PARTE_BYTES_MAX);
    expect(partes[0].bytes).toBeGreaterThan(PARTE_BYTES_MAX - 1024);
    expect(partes.reduce((s, p) => s + p.duracaoMs, 0)).toBe(200_000);
    expect(arquivo.bytesPorSegundo).toBe(176_400);
  });

  it("o tamanho ímpar do data ganha o byte de enchimento, que fica fora do data", async () => {
    const { arquivo, corte } = await cortar({ segundos: 0.5, taxa: 8001, bits: 8 });
    const [parte] = partesDe(corte);
    const b = montar(arquivo.bytes, parte);
    const data = pedacos(b).find(p => p.id === "data")!;
    expect(data.tamanho).toBe(4001);
    expect(b.length % 2).toBe(0);
  });

  it.each<[string, number, string]>([
    ["o ADPCM da Microsoft", 2, "MS ADPCM"],
    ["o GSM 6.10", 0x31, "GSM 6.10"],
    ["um formato sem nome", 0x1234, "WAV 0x1234"],
  ])("%s: SEM_SUPORTE, com o nome", async (_caso, formato, detalhe) => {
    const { corte } = await cortar({ segundos: 1, formato });
    expect(corte).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "wav", detalhe });
  });

  // O "MP3 em WAV" de gravadores e programas de ligação: a H9a o cortava como
  // MP3 (pulando o RIFF), e a H9b passou a recusá-lo dizendo "usa MP3".
  it.each<[string, number, FormatoDoQuadro]>([
    ["o MP3 dentro do WAV (0x55)", 0x55, MPEG1_128K],
    ["o MP2 dentro do WAV (0x50)", 0x50, MPEG1_CAMADA_2],
  ])("%s: sai como MP3, cada parte só com os quadros do data, e as etiquetas depois dele ficam de fora", async (_caso, formato, quadroMpeg) => {
    const mpeg = quadros(quadroMpeg, 120);
    const fmt = [...u16le(formato), ...u16le(2), ...u32le(44100), ...u32le(16000), ...u16le(1), ...u16le(0), ...u16le(12), ...new Array(12).fill(0)];
    const pedaco = (id: string, corpo: ArrayLike<number>) => juntar(ascii(id), u32le(corpo.length), corpo, corpo.length % 2 ? [0] : []);
    const miolo = juntar(ascii("WAVE"), pedaco("fmt ", fmt), pedaco("fact", u32le(120 * 1152)), pedaco("data", mpeg), pedaco("LIST", juntar(ascii("INFOINAM"), u32le(9), ascii("Reuniao!\0"))));
    const arquivo = juntar(ascii("RIFF"), u32le(miolo.length), miolo);
    const lidos: number[] = [];
    const corte = await cortarWav(leitorDe(arquivo), arquivo.length, { segundosPorParte: 1, aoLer: lidosAgora => lidos.push(lidosAgora) });
    expect(corte).toMatchObject({ ok: true, formato: "wav", mimeType: "audio/mpeg" });
    const partes = partesDe(corte);
    // 120 quadros de 26 ms em partes de 1 s: 38, 38, 38 e 6 quadros.
    expect(partes.map(p => p.bytes / quadroMpeg.tamanho)).toEqual([38, 38, 38, 6]);
    const juntas = juntar(...partes.map(parte => montar(arquivo, parte)));
    expect(mesmosBytes(juntas, mpeg)).toBe(true);
    if (corte.ok) expect(corte.duracaoMs).toBe(Math.round(120 * quadroMpeg.segundos * 1000));
    // O andamento conta sobre o arquivo inteiro, e não sobre o data.
    expect(Math.max(...lidos)).toBeLessThanOrEqual(arquivo.length);
    expect(Math.max(...lidos)).toBeGreaterThan(mpeg.length);
    // E nunca volta: o corte do MP3 lê o "data" duas vezes (lib/pausas-do-corte.ts),
    // a primeira contando até a metade, depois de os cabeçalhos já terem sido lidos.
    expect(lidos).toEqual([...lidos].sort((a, b) => a - b));
  });

  it("o MP3 dentro do WAV que não tem quadros: DANIFICADO, e não 'usa MP3'", async () => {
    const { corte } = await cortar({ segundos: 1, formato: 0x55 });
    expect(corte).toEqual({ ok: false, codigo: "DANIFICADO", formato: "wav" });
  });

  it("acima de 12 h: LONGO_DEMAIS; e o que passaria de 200 partes: MUITAS_PARTES", async () => {
    // 12 h e 1 s a 100 Hz, 8 bits, mono: 4,3 MB, que o corte mede pelo tamanho dos dados.
    const { corte: longo } = await cortar({ segundos: GRAVACAO_EM_PARTES_SEGUNDOS_MAX + 1, taxa: 100, bits: 8 });
    expect(longo).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "wav" });
    const { corte: muitas } = await cortar({ segundos: 30 }, { segundosPorParte: 1, partesNoMaximo: 20 });
    expect(muitas).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "wav" });
  }, 30_000);

  it("o que não é WAV, ou não tem fmt e data: DANIFICADO", async () => {
    const semData = wav({ segundos: 1 }).bytes.slice(0, 44 - 8);
    expect(await cortarWav(leitorDe(semData), semData.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "wav" });
    const outro = Uint8Array.from("RIFF\0\0\0\0AVI LIST", c => c.charCodeAt(0));
    expect(await cortarWav(leitorDe(outro), outro.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "wav" });
  });
});

/**
 * Conferência de tela do pacote 4b: o corte de 14 MB caía onde estivesse (a
 * cada 2:46 no WAV mono de 44,1 kHz), e a frase que atravessava a emenda sumia
 * da transcrição. Agora a parte fecha no meio da última pausa da fala antes do
 * teto, até um quarto da parte antes dele. A "fala" aqui é sintética: um tom de
 * 300 Hz com sopro, por 1,3 s a cada 1,8 s; a pausa, ruído de sala a −60 dBFS.
 */
describe("cortarWav: a emenda na pausa da fala", () => {
  const TAXA = 16000;
  /** O ruído pseudoaleatório e repetível, de −1 a 1. */
  const ruido = (() => { let x = 7; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296) * 2 - 1; }; })();
  /** A amostra em `t` segundos: a voz nos primeiros 1,3 s de cada 1,8 s; a pausa no resto. */
  const fala = (t: number) => (t % 1.8 < 1.3 ? 0.3 * Math.sin(2 * Math.PI * 300 * t) + 0.02 * ruido() : 0.001 * ruido());
  /** O WAV de PCM de 16 bits, mono, com `segundos` da função `sinal`. */
  function wavDe(segundos: number, sinal: (t: number) => number) {
    const n = Math.round(segundos * TAXA);
    const dados = new Uint8Array(n * 2);
    const vista = new DataView(dados.buffer);
    for (let i = 0; i < n; i++) vista.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sinal(i / TAXA) * 32767))), true);
    const fmt = [...u16le(1), ...u16le(1), ...u32le(TAXA), ...u32le(TAXA * 2), ...u16le(2), ...u16le(16)];
    const miolo = juntar(ascii("WAVE"), ascii("fmt "), u32le(fmt.length), fmt, ascii("data"), u32le(dados.length), dados);
    return { bytes: juntar(ascii("RIFF"), u32le(miolo.length), miolo), dados };
  }
  /** Onde cada emenda cai, em ms do arquivo. */
  const emendas = (corte: Awaited<ReturnType<typeof cortarWav>>) => {
    const duracoes = partesDe(corte).map(p => p.duracaoMs);
    return duracoes.slice(0, -1).map((_, i) => duracoes.slice(0, i + 1).reduce((s, d) => s + d, 0));
  };

  it("a parte fecha no meio da última pausa antes do teto, e não no meio da fala", async () => {
    const { bytes, dados } = wavDe(14, fala);
    const corte = await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4 });
    // O teto (4 s, 7,34 s e 10,94 s) cai na fala; as pausas de 3,1 a 3,6 s, 6,7 a 7,2 s e 10,3 a 10,8 s estão na janela.
    expect(emendas(corte)).toEqual([3340, 6940, 10540]);
    // Nada some nem se repete: os dados das partes juntos são os do arquivo.
    const juntas = juntar(...partesDe(corte).map(parte => montar(bytes, parte).subarray(44)));
    expect(mesmosBytes(juntas, dados)).toBe(true);
    // O corte de sempre (sem procurar a pausa) emendava no meio da fala: era o defeito.
    const deAntes = await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4, pausas: SEM_PAUSAS });
    expect(emendas(deAntes)).toEqual([4000, 8000, 12000]);
  });

  it("sem pausa na janela (a fala corrida, um tom contínuo), corta no teto, como antes", async () => {
    const { bytes } = wavDe(10, t => 0.3 * Math.sin(2 * Math.PI * 300 * t));
    expect(emendas(await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4 }))).toEqual([4000, 8000]);
  });

  it("a pausa longe do teto (antes da janela de um quarto da parte) não encurta a parte", async () => {
    // Uma pausa só, de 1,8 a 2,3 s: com partes de 4 s, a janela é de 3 a 4 s.
    const { bytes } = wavDe(10, t => (t >= 1.8 && t < 2.3 ? 0.001 * ruido() : 0.3 * Math.sin(2 * Math.PI * 300 * t)));
    expect(emendas(await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4 }))).toEqual([4000, 8000]);
  });

  it("se as pausas passarem do teto de partes da reunião, o corte fica no teto, como antes", async () => {
    // 12 s em partes de 4 s: três no teto, quatro nas pausas.
    const { bytes } = wavDe(12, fala);
    expect(emendas(await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4 }))).toEqual([3340, 6940, 10540]);
    const corte = await cortarWav(leitorDe(bytes), bytes.length, { segundosPorParte: 4, partesNoMaximo: 3 });
    expect(emendas(corte)).toEqual([4000, 8000]);
  });
});

describe("volumeDoPcm", () => {
  const seno = (n: number) => Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / 32));
  it("o RMS do seno de amplitude cheia é ~0,707 nos formatos do WAV", () => {
    const amostras = seno(3200);
    const pcm16 = new Uint8Array(amostras.length * 2);
    const pcm24 = new Uint8Array(amostras.length * 3);
    const f32 = new Uint8Array(amostras.length * 4);
    const pcm8 = new Uint8Array(amostras.length);
    amostras.forEach((v, i) => {
      new DataView(pcm16.buffer).setInt16(i * 2, Math.round(v * 32767), true);
      const v24 = Math.round(v * 8388607);
      pcm24.set([v24 & 0xff, (v24 >> 8) & 0xff, (v24 >> 16) & 0xff], i * 3);
      new DataView(f32.buffer).setFloat32(i * 4, v, true);
      pcm8[i] = Math.round(v * 127) + 128;
    });
    for (const [bytes, formato, tamanho] of [[pcm16, 1, 2], [pcm24, 1, 3], [f32, 3, 4], [pcm8, 1, 1]] as const) {
      expect(volumeDoPcm(bytes, formato, tamanho)).toBeCloseTo(Math.SQRT1_2, 2);
    }
  });

  it("o silêncio do A-law (0xd5) e do µ-law (0xff) é ~0, e o pico, ~1", () => {
    expect(volumeDoPcm(new Uint8Array(100).fill(0xd5), 6, 1)).toBeLessThan(0.001);
    expect(volumeDoPcm(new Uint8Array(100).fill(0xff), 7, 1)).toBeLessThan(0.001);
    expect(volumeDoPcm(new Uint8Array(100).fill(0x2a), 6, 1)).toBeGreaterThan(0.95);
    expect(volumeDoPcm(new Uint8Array(100).fill(0x80), 7, 1)).toBeGreaterThan(0.95);
  });
});
