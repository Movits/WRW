import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { cortarWebm } from "./corte-do-webm";
import { aleatorios, leitorDe, opusHead, TOC_OPUS_20MS, webm, type OpcoesDoWebm } from "@/test/audio-sintetico";
import { fragmentoMp4, mesmosPacotes, montar, pacotesOgg, paginasOgg, partesDe } from "@/test/conferir-partes";

/**
 * O corte do WebM e do Matroska (H9b): os pacotes da faixa de áudio saem do
 * contêiner, sem recodificar, para o Ogg Opus (o Opus) ou para o MP4
 * fragmentado (o AAC do MKV do OBS), começando em 0. O vídeo fica de fora. Os
 * arquivos são sintéticos (test/audio-sintetico.ts).
 */

async function cortar(o: OpcoesDoWebm, opcoes: Parameters<typeof cortarWebm>[2] = {}) {
  const arquivo = webm(o);
  return { arquivo, corte: await cortarWebm(leitorDe(arquivo.bytes), arquivo.bytes.length, opcoes) };
}

/** Os pacotes Opus das partes em Ogg, conferindo os cabeçalhos, os grânulos desde 0, o EOS e os CRCs. */
function pacotesDasPartes(bytes: Uint8Array, corte: Awaited<ReturnType<typeof cortarWebm>>) {
  const pacotes: Uint8Array[] = [];
  for (const parte of partesDe(corte)) {
    const paginas = paginasOgg(montar(bytes, parte));
    expect(paginas.every(p => p.crcCerto)).toBe(true);
    expect(paginas[0].tipo & 2).toBe(2);
    expect(paginas[paginas.length - 1].tipo & 4).toBe(4);
    expect(paginas.map(p => p.seq)).toEqual(paginas.map((_p, i) => i));
    const [head, tags, ...audio] = pacotesOgg(paginas);
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe("OpusHead");
    expect(String.fromCharCode(...tags.subarray(0, 8))).toBe("OpusTags");
    // Os pacotes de 20 ms: o grânulo de cada página é a soma desde o 0 da parte.
    let amostras = 0;
    for (const pagina of paginas.slice(2)) {
      amostras += pacotesOgg([pagina]).length * 960;
      expect(pagina.granulo).toBe(amostras);
    }
    expect(parte.duracaoMs).toBe(Math.round(amostras / 48));
    pacotes.push(...audio);
  }
  return pacotes;
}

describe("cortarWebm: o Opus vira Ogg Opus", () => {
  it.each<[string, Partial<OpcoesDoWebm>]>([
    ["o WebM do Chrome (o Segment e os clusters de tamanho desconhecido)", { desconhecido: true }],
    ["o WebM com o tamanho de tudo", {}],
    ["a gravação de tela, com vídeo: só os pacotes do áudio saem", { video: true }],
    ["os blocos com o laçamento Xiph (três pacotes por bloco)", { lacamento: true }],
    ["os blocos em BlockGroup", { blockGroup: true }],
    ["o MKV (DocType matroska)", { docType: "matroska" }],
  ])("%s: partes de até 3 s, com os pacotes do arquivo, na ordem", async (_caso, o) => {
    const { arquivo, corte } = await cortar({ pacotes: 500, ...o }, { segundosPorParte: 3 });
    expect(corte).toMatchObject({ ok: true, formato: "webm", mimeType: "audio/ogg", duracaoMs: 10_000 });
    expect(mesmosPacotes(pacotesDasPartes(arquivo.bytes, corte), arquivo.pacotes)).toBe("iguais");
    expect(partesDe(corte).map(p => p.duracaoMs)).toEqual([3000, 3000, 3000, 1000]);
  });

  it("o OpusHead do CodecPrivate vai inteiro a cada parte (o pre-skip e os canais do arquivo)", async () => {
    const head = opusHead({ canais: 2, preSkip: 3840 });
    const { arquivo, corte } = await cortar({ pacotes: 100, privado: head });
    const [parte] = partesDe(corte);
    const [primeiro] = pacotesOgg(paginasOgg(montar(arquivo.bytes, parte)));
    expect(primeiro).toEqual(head);
  });

  it("sem o CodecPrivate, o OpusHead é montado com os canais da faixa", async () => {
    const { arquivo, corte } = await cortar({ pacotes: 100, privado: null });
    const [primeiro] = pacotesOgg(paginasOgg(montar(arquivo.bytes, partesDe(corte)[0])));
    expect(String.fromCharCode(...primeiro.subarray(0, 8))).toBe("OpusHead");
    expect(primeiro[9]).toBe(2);
  });

  it("um trecho ilegível no meio: o corte procura o cluster seguinte, como o demuxer", async () => {
    const { arquivo, corte } = await cortar({ pacotes: 200, lixoNoMeio: true, desconhecido: true });
    expect(pacotesDasPartes(arquivo.bytes, corte)).toEqual(arquivo.pacotes);
  });

  it("o arquivo cortado no fim fica com os blocos inteiros que chegaram", async () => {
    const arquivo = webm({ pacotes: 200, desconhecido: true });
    const cortado = arquivo.bytes.subarray(0, arquivo.bytes.length - 300);
    const corte = await cortarWebm(leitorDe(cortado), cortado.length);
    const pacotes = pacotesDasPartes(cortado, corte);
    expect(pacotes.length).toBeGreaterThan(190);
    expect(pacotes).toEqual(arquivo.pacotes.slice(0, pacotes.length));
  });
});

describe("cortarWebm: o AAC vira MP4 fragmentado", () => {
  it("o MKV do OBS com AAC: cada parte é um MP4 fragmentado, com o tfdt em 0 e os quadros do arquivo", async () => {
    // AudioSpecificConfig do AAC-LC a 48 kHz, estéreo: quadros de 1.024 amostras (21,3 ms).
    const { arquivo, corte } = await cortar({ codec: "A_AAC", pacotes: 300, video: true }, { segundosPorParte: 2 });
    expect(corte).toMatchObject({ ok: true, formato: "webm", mimeType: "audio/mp4" });
    const quadros: Uint8Array[] = [];
    for (const parte of partesDe(corte)) {
      const fragmento = fragmentoMp4(montar(arquivo.bytes, parte));
      expect(fragmento.decodeTime).toBe(0);
      let p = 0;
      for (const tamanho of fragmento.tamanhos) { quadros.push(fragmento.mdat.subarray(p, p + tamanho)); p += tamanho; }
    }
    expect(mesmosPacotes(quadros, arquivo.pacotes)).toBe("iguais");
    expect(partesDe(corte).map(p => p.duracaoMs)).toEqual([1984, 1984, 1984, 448]);
  });

  it("o AAC sem CodecPrivate (o CodecID antigo, A_AAC/MPEG4/LC): o AudioSpecificConfig é montado com a taxa e os canais", async () => {
    const { corte } = await cortar({ codec: "A_AAC/MPEG4/LC", privado: null, pacotes: 100 });
    expect(corte).toMatchObject({ ok: true, mimeType: "audio/mp4" });
    expect(corte.ok && corte.duracaoMs).toBe(Math.round(100 * (1024 / 48000) * 1000));
  });
});

describe("cortarWebm: as recusas", () => {
  it.each<[string, string, string]>([
    ["o Vorbis no WebM (o Firefox antigo)", "A_VORBIS", "Vorbis (WebM)"],
    ["o MP3 no MKV", "A_MPEG/L3", "MP3 (WebM/MKV)"],
    ["o AC-3 no MKV", "A_AC3", "AC-3"],
    ["o PCM no MKV", "A_PCM/INT/LIT", "PCM"],
  ])("%s: SEM_SUPORTE, com o nome", async (_caso, codec, detalhe) => {
    const { corte } = await cortar({ codec, pacotes: 10, privado: aleatorios(30, 1) });
    expect(corte).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "webm", detalhe });
  });

  it("o WebM só com vídeo: SEM_AUDIO", async () => {
    const { corte } = await cortar({ semAudio: true, pacotes: 10 });
    expect(corte).toEqual({ ok: false, codigo: "SEM_AUDIO", formato: "webm" });
  });

  it("o que não é WebM: DANIFICADO", async () => {
    const lixo = aleatorios(5000, 2);
    expect(await cortarWebm(leitorDe(lixo), lixo.length)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "webm" });
  });

  it("acima de 12 h: LONGO_DEMAIS; mais partes que o teto: MUITAS_PARTES", async () => {
    // Pacotes de 120 ms (o TOC de código 3 com 3 quadros de 40 ms) de 3 bytes: 12 h e um pacote.
    const pacotes = Math.floor((GRAVACAO_EM_PARTES_SEGUNDOS_MAX * 1000) / 120) + 1;
    const { corte } = await cortar({ pacotes, toc: 0x13, segundoByte: 3, tamanho: () => 3, porCluster: 5000 });
    expect(corte).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "webm" });
    const curto = await cortar({ pacotes: 500 }, { segundosPorParte: 1, partesNoMaximo: 3 });
    expect(curto.corte).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "webm" });
  }, 120_000);

  it("o TOC conta as amostras: 500 pacotes de 20 ms são 10 s", async () => {
    const { corte } = await cortar({ pacotes: 500, toc: TOC_OPUS_20MS });
    expect(corte.ok && corte.duracaoMs).toBe(10_000);
  });
});
