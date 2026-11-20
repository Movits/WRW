import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { cortarAdts } from "./corte-do-adts";
import { adts, aleatorios, juntar, leitorDe, quadroAdts, type OpcoesDoAdts } from "@/test/audio-sintetico";
import { mesmosBytes, montar, partesDe } from "@/test/conferir-partes";

/**
 * O corte do AAC em ADTS (H9b): cada parte é uma sequência de quadros do
 * próprio arquivo (o ADTS não tem relógio: a parte já começa em 0), e as
 * etiquetas e o lixo ficam de fora. Os arquivos são sintéticos
 * (test/audio-sintetico.ts).
 */

const id3v2 = (n: number) => juntar(Array.from("ID3", c => c.charCodeAt(0)), [4, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f], aleatorios(n, 7));
const id3v1 = () => juntar(Array.from("TAG", c => c.charCodeAt(0)), aleatorios(125, 3));

async function cortar(bytes: Uint8Array, opcoes: Parameters<typeof cortarAdts>[2] = {}) {
  return cortarAdts(leitorDe(bytes), bytes.length, opcoes);
}

describe("cortarAdts", () => {
  it.each<[string, Partial<OpcoesDoAdts>]>([
    ["o AAC-LC a 44,1 kHz, estéreo", {}],
    ["com o CRC (cabeçalho de 9 bytes)", { crc: true }],
    ["a 16 kHz, mono", { indiceDaTaxa: 8, canais: 1 }],
  ])("%s: as partes são os quadros do arquivo, na ordem, sem o ID3 do começo e o do fim", async (_caso, o) => {
    const { bytes: audio, segundosPorQuadro } = adts({ quadros: 500, ...o });
    const arquivo = juntar(id3v2(2000), audio, id3v1());
    const corte = await cortar(arquivo, { segundosPorParte: 3 });
    expect(corte).toMatchObject({ ok: true, formato: "aac", mimeType: "audio/aac" });
    const partes = partesDe(corte);
    const porParte = Math.floor(3 / segundosPorQuadro);
    expect(partes.map(p => p.duracaoMs)).toEqual(
      Array.from({ length: Math.ceil(500 / porParte) }, (_v, i) => Math.round(Math.min(porParte, 500 - i * porParte) * segundosPorQuadro * 1000)),
    );
    // Sem bytes novos: cada parte é só trecho do arquivo, e as partes juntas são o áudio.
    expect(partes.every(p => p.novos.length === 0)).toBe(true);
    expect(mesmosBytes(juntar(...partes.map(p => montar(arquivo, p))), audio)).toBe(true);
  });

  it("os quadros de 2 blocos (2.048 amostras) contam em dobro", async () => {
    const { bytes, segundosPorQuadro } = adts({ quadros: 100, blocos: 2 });
    const corte = await cortar(bytes);
    expect(corte.ok && corte.duracaoMs).toBe(Math.round(100 * segundosPorQuadro * 1000));
    expect(segundosPorQuadro).toBeCloseTo(2048 / 44100);
  });

  it("o lixo no meio fica de fora, e a volta aos quadros pede os seguintes do mesmo fluxo", async () => {
    const a = adts({ quadros: 100, semente: 1 }).bytes;
    const b = adts({ quadros: 100, semente: 2 }).bytes;
    // Lixo com um falso começo de quadro (0xFFF1) que não se confirma.
    const lixo = juntar(aleatorios(500, 9), [0xff, 0xf1, 0x50, 0x80], aleatorios(300, 10));
    const arquivo = juntar(a, lixo, b);
    const corte = await cortar(arquivo);
    expect(mesmosBytes(juntar(...partesDe(corte).map(p => montar(arquivo, p))), juntar(a, b))).toBe(true);
  });

  it("o que não é ADTS (só lixo, ou um MP3): DANIFICADO", async () => {
    expect(await cortar(aleatorios(50_000, 5))).toEqual({ ok: false, codigo: "DANIFICADO", formato: "aac" });
    const mp3 = new Uint8Array(4180);
    for (let i = 0; i < 10; i++) mp3.set([0xff, 0xfb, 0x90, 0x00], i * 418);
    expect(await cortar(mp3)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "aac" });
  });

  it("acima de 12 h: LONGO_DEMAIS", async () => {
    // 7.350 Hz e quadros de 16 bytes: 12 h e um quadro em ~5 MB.
    const quadros = Math.floor((GRAVACAO_EM_PARTES_SEGUNDOS_MAX * 7350) / 1024) + 1;
    const um = quadroAdts(16, { indiceDaTaxa: 12, canais: 1 });
    const bytes = new Uint8Array(quadros * 16);
    for (let i = 0; i < quadros; i++) bytes.set(um, i * 16);
    expect(await cortar(bytes)).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "aac" });
  }, 60_000);

  it("mais partes que o teto da reunião: MUITAS_PARTES", async () => {
    const { bytes } = adts({ quadros: 300 });
    expect(await cortar(bytes, { segundosPorParte: 1, partesNoMaximo: 3 })).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "aac" });
  });
});
