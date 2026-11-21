import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { PARTE_BYTES_MAX } from "./corte-comum";
import { cortarWav } from "./corte-do-wav";
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
