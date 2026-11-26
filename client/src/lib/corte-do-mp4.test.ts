import { describe, expect, it, vi } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { PARTE_BYTES_MAX } from "./corte-comum";
import { cortarMp4, lerConfigAac } from "./corte-do-mp4";
import { SEM_PAUSAS } from "./pausas-do-corte";
import { ascAacLc, juntar, leitorDe, mp4, type OpcoesDoMp4 } from "@/test/audio-sintetico";
import { acharCaixa, caixasMp4, fragmentoMp4, mesmosPacotes, montar, partesDe } from "@/test/conferir-partes";

/**
 * O corte do MP4, do M4A e do MOV (H9c): o moov achado pelas caixas do nível
 * de cima, a faixa AAC lida pelo mp4box, e cada parte um MP4 fragmentado de
 * um fragmento só, começando no tempo 0, com os quadros do próprio arquivo.
 * Os arquivos são sintéticos (test/audio-sintetico.ts); a medida das partes
 * pelo servidor está em server/corte-dos-formatos-no-servidor.test.ts.
 */

const SEGUNDOS_POR_QUADRO = 1024 / 44100;

async function cortar(o: OpcoesDoMp4, opcoes: Parameters<typeof cortarMp4>[2] = {}) {
  const arquivo = mp4(o);
  const corte = await cortarMp4(leitorDe(arquivo.bytes), arquivo.bytes.length, opcoes);
  return { arquivo, corte };
}

/** Confere cada parte: um fMP4 de um fragmento, com o tfdt em 0 e os quadros do arquivo, na ordem. */
function conferirPartes(arquivo: ReturnType<typeof mp4>, corte: Awaited<ReturnType<typeof cortarMp4>>, quadrosEsperados = arquivo.quadros) {
  const partes = partesDe(corte);
  const quadrosNasPartes: Uint8Array[] = [];
  for (const parte of partes) {
    const bytes = montar(arquivo.bytes, parte);
    expect(bytes.length).toBe(parte.bytes);
    expect(bytes.length).toBeLessThanOrEqual(PARTE_BYTES_MAX);
    const caixas = caixasMp4(bytes);
    expect(caixas.map(c => c.tipo)).toEqual(["ftyp", "moov", "moof", "mdat"]);
    // Só a faixa de áudio, com a entrada mp4a no formato ISO e o esds.
    expect(caixas[1].filhas.filter(c => c.tipo === "trak")).toHaveLength(1);
    const stsd = acharCaixa(caixas, "moov/trak/mdia/minf/stbl/stsd")!;
    expect(String.fromCharCode(...bytes.subarray(stsd.dados + 12, stsd.dados + 16))).toBe("mp4a");
    const fragmento = fragmentoMp4(bytes);
    expect(fragmento.decodeTime).toBe(0);
    expect(fragmento.dadosComecamEm).toBe(caixas[3].dados);
    expect(parte.duracaoMs).toBe(Math.round(fragmento.quantas * SEGUNDOS_POR_QUADRO * 1000));
    let p = 0;
    for (const tamanho of fragmento.tamanhos) {
      quadrosNasPartes.push(fragmento.mdat.subarray(p, p + tamanho));
      p += tamanho;
    }
    expect(p).toBe(fragmento.mdat.length);
  }
  expect(mesmosPacotes(quadrosNasPartes, quadrosEsperados)).toBe("iguais");
  return partes;
}

describe("cortarMp4: os formatos do MP4", () => {
  it.each<[string, OpcoesDoMp4]>([
    ["o M4A com o moov no começo", {}],
    ["o M4A com o moov no fim (o do Gravador do iPhone)", { moovNoFim: true }],
    ["o MP4 com vídeo (o do Zoom): só o áudio sai, e os blocos do vídeo ficam de fora", { video: true, moovNoFim: true }],
    ["o MOV do QuickTime, com a entrada de som de versão 1 e o esds no wave", { qt: true, video: true }],
    ["o MOV antigo, sem o ftyp", { qt: true, semFtyp: true }],
    ["o MP4 com o co64 (os deslocamentos de 64 bits)", { co64: true }],
    ["o MP4 fragmentado (o do Safari)", { fragmentado: true }],
    // Com mais de um traf por moof, a base de cada traf (ISO 14496-12, §8.8.7.1).
    ["o MP4 fragmentado com vídeo, a base no moof (default-base-is-moof)", { fragmentado: true, video: true }],
    ["o MP4 fragmentado com vídeo, a base escrita no tfhd (base_data_offset)", { fragmentado: true, video: true, baseDoFragmento: "explicita" }],
    // O omit_tfhd_offset do ffmpeg: o traf do áudio, o segundo, conta do fim dos dados do vídeo.
    ["o MP4 fragmentado com vídeo e a base implícita: o áudio começa onde os dados do vídeo terminam", { fragmentado: true, video: true, baseDoFragmento: "implicita" }],
  ])("%s", async (_caso, o) => {
    const { arquivo, corte } = await cortar({ quadros: 300, ...o }, { segundosPorParte: 2 });
    expect(corte).toMatchObject({ ok: true, formato: "mp4", mimeType: "audio/mp4" });
    const partes = conferirPartes(arquivo, corte);
    // 2 s são 86 quadros de 1.024 amostras a 44,1 kHz: 300 quadros em 4 partes.
    expect(partes.map(p => p.duracaoMs)).toEqual([1997, 1997, 1997, 975]);
    if (corte.ok) expect(corte.duracaoMs).toBe(Math.round(300 * SEGUNDOS_POR_QUADRO * 1000));
  });

  it("o MP4 com vídeo não lê o vídeo: só os cabeçalhos das caixas (em blocos de 64 kB), o ftyp e o moov", async () => {
    const arquivo = mp4({ quadros: 2000, video: true, moovNoFim: true });
    const ler = vi.fn(leitorDe(arquivo.bytes));
    // O corte de sempre (sem procurar a pausa): o começo, o ftyp, o cabeçalho do moov e o moov; o mdat de ~800 kB é pulado.
    const corte = await cortarMp4(ler, arquivo.bytes.length, { pausas: SEM_PAUSAS });
    expect(corte.ok).toBe(true);
    expect(ler.mock.calls.length).toBeLessThanOrEqual(4);
    const lidos = ler.mock.calls.reduce((soma, [inicio, fim]) => soma + (fim - inicio), 0);
    expect(lidos).toBeLessThan(arquivo.bytes.length / 4);
  });

  // Conferência de tela do pacote 4b: para fechar a parte na pausa da fala, a
  // leitura que acha as pausas lê os quadros de áudio (o global_gain de cada
  // um, lib/nivel-dos-quadros.ts), bloco a bloco. O vídeo entre eles, nunca.
  it("procurando a pausa, lê os quadros de áudio, bloco a bloco, e nunca o vídeo entre eles", async () => {
    const arquivo = mp4({ quadros: 2000, video: true, moovNoFim: true });
    const ler = vi.fn(leitorDe(arquivo.bytes));
    const corte = await cortarMp4(ler, arquivo.bytes.length);
    expect(corte.ok).toBe(true);
    // Cada bloco de vídeo (3.000 bytes) vem logo antes do bloco de áudio.
    const videos = arquivo.offsetsDoAudio.map(inicio => [inicio - 3000, inicio] as const);
    const leuVideo = ler.mock.calls.filter(([inicio, fim]) => videos.some(([de, ate]) => inicio < ate && fim > de));
    // Só o começo do arquivo, lido em blocos de 64 kB, encosta no primeiro bloco de vídeo.
    expect(leuVideo.every(([inicio]) => inicio === 0)).toBe(true);
    const doAudio = arquivo.quadros.reduce((soma, q) => soma + q.length, 0);
    const lidos = ler.mock.calls.filter(([inicio]) => inicio > 0).reduce((soma, [inicio, fim]) => soma + (fim - inicio), 0);
    // Fora o áudio, só os cabeçalhos das caixas e o moov, nas duas leituras.
    expect(lidos).toBeLessThanOrEqual(doAudio + 4 * 64 * 1024);
  });

  it("a parte fecha antes dos 14 MB, contando o começo, o moof e o cabeçalho do mdat", async () => {
    const { arquivo, corte } = await cortar({ quadros: 400, tamanho: () => 1000 }, { bytesPorParte: 100_000 });
    const partes = conferirPartes(arquivo, corte);
    expect(partes.length).toBeGreaterThan(3);
    for (const parte of partes) expect(parte.bytes).toBeLessThanOrEqual(100_000);
    // Cheias até o último quadro que cabe.
    expect(partes[0].bytes + 1000 + 4).toBeGreaterThan(100_000);
  });

  it("os quadros de duração variável vão com a duração de cada um no trun; os de duração constante, com a padrão no tfhd", async () => {
    const { arquivo, corte } = await cortar({ quadros: 50 });
    const [parte] = partesDe(corte);
    const fragmento = fragmentoMp4(montar(arquivo.bytes, parte));
    expect(fragmento.duracaoPadrao).toBe(1024);
    expect(fragmento.duracoes).toEqual([]);
  });

  it("a gravação cortada no meio do mdat (a tabela diz mais do que o arquivo tem): ficam os quadros inteiros que chegaram", async () => {
    const { arquivo, corte } = await cortar({ quadros: 100, cortado: true });
    conferirPartes(arquivo, corte, arquivo.quadros.slice(0, 50));
  });
});

describe("cortarMp4: as recusas", () => {
  it.each<[string, OpcoesDoMp4, string]>([
    ["o ALAC (o Gravador do iPhone sem perdas)", { quadros: 10, codec: "alac" }, "ALAC"],
    ["o AC-3", { quadros: 10, codec: "ac-3" }, "AC-3"],
    ["o AAC-ELD", { quadros: 10, asc: Uint8Array.from([0xf8, 0xe6, 0x20, 0x00]) }, "AAC-ELD"],
  ])("%s: SEM_SUPORTE, com o nome", async (_caso, o, detalhe) => {
    const { corte } = await cortar(o);
    expect(corte).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe });
  });

  it("o vídeo sem faixa de áudio: SEM_AUDIO", async () => {
    const { corte } = await cortar({ quadros: 10, video: true, semAudio: true });
    expect(corte).toEqual({ ok: false, codigo: "SEM_AUDIO", formato: "mp4" });
  });

  it("o arquivo sem o moov (a gravação interrompida) e o que só começa como MP4: DANIFICADO", async () => {
    const semMoov = juntar([0, 0, 0, 16], Array.from("ftypM4A ", c => c.charCodeAt(0)), [0, 0, 0, 0], [0, 0, 0, 100], Array.from("mdat", c => c.charCodeAt(0)), new Uint8Array(92));
    expect(await cortarMp4(leitorDe(semMoov), semMoov.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "mp4" });
    const lixo = juntar([0, 0, 0, 16], Array.from("ftypM4A ", c => c.charCodeAt(0)), [0, 0, 0, 0], [0, 0, 0, 2], [1, 2, 3, 4]);
    expect(await cortarMp4(leitorDe(lixo), lixo.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "mp4" });
  });

  it("acima de 12 h: LONGO_DEMAIS (um quadro além das 12 h)", async () => {
    const quadros = Math.floor((GRAVACAO_EM_PARTES_SEGUNDOS_MAX * 8000) / 1024) + 1;
    const { corte } = await cortar({ quadros, taxa: 8000, asc: ascAacLc(11, 1), tamanho: () => 8 }, {});
    expect(corte).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "mp4" });
  }, 60_000);

  it("mais partes que o teto da reunião: MUITAS_PARTES", async () => {
    const { corte } = await cortar({ quadros: 300 }, { segundosPorParte: 1, partesNoMaximo: 3 });
    expect(corte).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "mp4" });
  });

  it("cancelar no meio rejeita com AbortError", async () => {
    const arquivo = mp4({ quadros: 50 });
    const controle = new AbortController();
    controle.abort();
    await expect(cortarMp4(leitorDe(arquivo.bytes), arquivo.bytes.length, { sinal: controle.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("lerConfigAac", () => {
  it("o AAC-LC, o HE-AAC (SBR explícito: a taxa dos quadros é a do núcleo), o quadro de 960 e o AAC-LD", () => {
    expect(lerConfigAac(ascAacLc(4, 2))).toEqual({ objeto: 2, taxa: 44100, quadro: 1024, canais: 2 });
    // Objeto 5 (SBR), núcleo a 22,05 kHz, SBR a 44,1 kHz, núcleo AAC-LC.
    expect(lerConfigAac(Uint8Array.from([0x2b, 0x8a, 0x08, 0x00]))).toEqual({ objeto: 2, taxa: 22050, quadro: 1024, canais: 1 });
    expect(lerConfigAac(Uint8Array.from([0x12, 0x14]))).toEqual({ objeto: 2, taxa: 44100, quadro: 960, canais: 2 });
    expect(lerConfigAac(Uint8Array.from([0xb9, 0x88, 0x00]))).toMatchObject({ objeto: 23, taxa: 48000, quadro: 512 });
    expect(lerConfigAac(Uint8Array.from([0x12]))).toBeNull();
  });
});
