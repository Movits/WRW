import { describe, expect, it, vi } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { atenderPedidoDeCorte, cortarArquivo, reconhecerFormato, transferiveisDo, type RespostaDoCorte } from "./corte-do-arquivo";
import { adts, aleatorios, ascii, flac, juntar, leitorDe, mp4, oggOpus, wav, webm } from "@/test/audio-sintetico";
import { id3v2, leitorDeQuadrosRepetidos, MPEG1_128K, MPEG25_8K, quadroDeEtiqueta, quadros } from "@/test/mp3-sintetico";
import { mesmosBytes, montar, partesDe } from "@/test/conferir-partes";

/**
 * O corte do arquivo importado (H9a, H9b e H9c): o formato reconhecido pelos
 * bytes do começo, o corte de cada um, as recusas antes de a reunião nascer
 * e o pedido ao Worker. Os arquivos são sintéticos (test/audio-sintetico.ts e
 * test/mp3-sintetico.ts).
 */

const reconhecer = (bytes: Uint8Array) => reconhecerFormato(leitorDe(bytes), bytes.length);
const cortar = (bytes: Uint8Array, opcoes: Parameters<typeof cortarArquivo>[2] = {}) => cortarArquivo(leitorDe(bytes), bytes.length, opcoes);

const MP3 = juntar(id3v2(400), quadroDeEtiqueta(MPEG1_128K, "Xing"), quadros(MPEG1_128K, 200));

describe("reconhecerFormato: pelos bytes do começo, e não pela extensão", () => {
  it.each<[string, Uint8Array, unknown]>([
    ["o MP3 com ID3", MP3, { formato: "mp3" }],
    ["o AAC em ADTS com ID3", juntar(id3v2(300), adts({ quadros: 20 }).bytes), { formato: "aac" }],
    ["o WAV", wav({ segundos: 1 }).bytes, { formato: "wav" }],
    ["o RF64", wav({ segundos: 1, rf64: true }).bytes, { formato: "wav" }],
    ["o FLAC", flac({ quadros: 5 }).bytes, { formato: "flac" }],
    ["o FLAC com ID3 antes", flac({ quadros: 5, id3: true }).bytes, { formato: "flac" }],
    ["o Ogg", oggOpus({ pacotes: 20 }).bytes, { formato: "ogg" }],
    ["o WebM", webm({ pacotes: 20 }).bytes, { formato: "webm" }],
    ["o M4A", mp4({ quadros: 20 }).bytes, { formato: "mp4" }],
    ["o MOV antigo, sem ftyp (começa no moov)", mp4({ quadros: 20, qt: true, semFtyp: true }).bytes, { formato: "mp4" }],
    ["o AVI", juntar(ascii("RIFF"), [0, 0, 0, 0], ascii("AVI LIST"), aleatorios(100, 1)), { semSuporte: "AVI" }],
    ["o AIFF", juntar(ascii("FORM"), [0, 0, 0, 0], ascii("AIFFCOMM"), aleatorios(100, 1)), { semSuporte: "AIFF" }],
    ["o AMR", juntar(ascii("#!AMR\n"), aleatorios(100, 1)), { semSuporte: "AMR" }],
    ["o WMA", juntar([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], aleatorios(100, 1)), { semSuporte: "WMA" }],
  ])("%s", async (_caso, bytes, esperado) => {
    expect(await reconhecer(bytes)).toEqual(esperado);
  });

  it("o ID3 maior que o primeiro pedaço lido: o formato vem do que está depois dele", async () => {
    const audio = adts({ quadros: 20 }).bytes;
    expect(await reconhecer(juntar(id3v2(100_000), audio))).toEqual({ formato: "aac" });
  });
});

describe("cortarArquivo", () => {
  it.each<[string, Uint8Array, string, string]>([
    ["o MP3", MP3, "mp3", "audio/mpeg"],
    ["o AAC em ADTS", adts({ quadros: 200 }).bytes, "aac", "audio/aac"],
    ["o WAV", wav({ segundos: 5 }).bytes, "wav", "audio/wav"],
    ["o FLAC", flac({ quadros: 20 }).bytes, "flac", "audio/flac"],
    ["o Ogg (o áudio do WhatsApp)", oggOpus({ pacotes: 200 }).bytes, "ogg", "audio/ogg"],
    ["o WebM do Chrome, que sai em Ogg Opus", webm({ pacotes: 200, desconhecido: true }).bytes, "webm", "audio/ogg"],
    ["o MKV com AAC, que sai em MP4", webm({ codec: "A_AAC", pacotes: 200, docType: "matroska" }).bytes, "webm", "audio/mp4"],
    ["o M4A", mp4({ quadros: 200 }).bytes, "mp4", "audio/mp4"],
    ["o MOV com vídeo", mp4({ quadros: 200, qt: true, video: true }).bytes, "mp4", "audio/mp4"],
  ])("%s: o corte do formato, com o tipo das partes", async (_caso, bytes, formato, mimeType) => {
    const corte = await cortar(bytes);
    expect(corte).toMatchObject({ ok: true, formato, mimeType });
    for (const parte of partesDe(corte)) expect(montar(bytes, parte).length).toBe(parte.bytes);
  });

  it("o MP3 vira receita só de trechos do arquivo (sem bytes novos), como na H9a", async () => {
    const corte = await cortar(MP3, { segundosPorParte: 2 });
    const partes = partesDe(corte);
    expect(partes.length).toBe(3);
    expect(partes.every(p => p.novos.length === 0)).toBe(true);
    expect(mesmosBytes(juntar(...partes.map(p => montar(MP3, p))), quadros(MPEG1_128K, 200))).toBe(true);
  });

  it("o AAC com lixo antes do primeiro quadro, que parece MP3: o corte do MP3 não lê, e o do AAC lê", async () => {
    const falsoMp3 = juntar([0xff, 0xfb, 0x90, 0x00], aleatorios(200, 3));
    const audio = adts({ quadros: 100 }).bytes;
    const corte = await cortar(juntar(falsoMp3, audio));
    expect(corte).toMatchObject({ ok: true, formato: "aac" });
  });

  it.each<[string, Uint8Array, unknown]>([
    ["o arquivo vazio", new Uint8Array(0), { ok: false, codigo: "FORMATO_DESCONHECIDO" }],
    ["o que não é áudio (um PDF)", juntar(ascii("%PDF-1.7\n"), aleatorios(50_000, 7).map(b => (b === 0xff ? 0 : b))), { ok: false, codigo: "FORMATO_DESCONHECIDO" }],
    ["o AVI", juntar(ascii("RIFF"), [0, 0, 0, 0], ascii("AVI LIST"), aleatorios(100, 1)), { ok: false, codigo: "SEM_SUPORTE", detalhe: "AVI" }],
    ["o M4A em ALAC", mp4({ quadros: 20, codec: "alac" }).bytes, { ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" }],
    ["o vídeo sem áudio", mp4({ quadros: 20, video: true, semAudio: true }).bytes, { ok: false, codigo: "SEM_AUDIO", formato: "mp4" }],
  ])("%s: a recusa", async (_caso, bytes, esperado) => {
    expect(await cortar(bytes)).toEqual(esperado);
  });

  it("o MP3 acima de 12 h: LONGO_DEMAIS (o corte da H9a, pelo corte do arquivo)", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, Math.floor(GRAVACAO_EM_PARTES_SEGUNDOS_MAX / (576 / 8000)) + 1);
    expect(await cortarArquivo(ler, tamanho)).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "mp3" });
  }, 60_000);

  it("cancelado antes de começar: AbortError", async () => {
    const controle = new AbortController();
    controle.abort();
    await expect(cortar(MP3, { sinal: controle.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("atenderPedidoDeCorte (o que o Worker faz)", () => {
  it("responde o andamento e, no fim, o corte, com os buffers das partes para transferir sem cópia", async () => {
    const bytes = oggOpus({ pacotes: 300 }).bytes;
    const respostas: Array<[RespostaDoCorte, ArrayBuffer[] | undefined]> = [];
    await atenderPedidoDeCorte({ arquivo: new Blob([bytes], { type: "audio/ogg" }) }, (r, t) => respostas.push([r, t]));
    expect(respostas[0][0]).toEqual({ tipo: "lendo", lidos: bytes.length, total: bytes.length });
    const [final, transferir] = respostas.at(-1)!;
    expect(final.tipo).toBe("pronto");
    if (final.tipo !== "pronto" || !final.corte.ok) throw new Error("sem corte");
    expect(final.corte).toEqual(await cortar(bytes));
    expect(transferir).toEqual(transferiveisDo(final.corte));
    expect(transferir).toHaveLength(final.corte.partes.length * 2);
  });

  it("a recusa também é resposta pronta (sem nada a transferir)", async () => {
    const respostas: RespostaDoCorte[] = [];
    await atenderPedidoDeCorte({ arquivo: new Blob([aleatorios(1000, 2).map(b => (b === 0xff ? 0 : b))]) }, r => respostas.push(r));
    expect(respostas.at(-1)).toEqual({ tipo: "pronto", corte: { ok: false, codigo: "FORMATO_DESCONHECIDO" } });
  });

  it("a leitura que falha vira erro, sem detalhe na resposta; o detalhe vai ao console do Worker", async () => {
    const arquivo = new Blob([MP3]);
    const falha = new Error("o arquivo sumiu");
    vi.spyOn(arquivo, "slice").mockImplementation(() => { throw falha; });
    const consoleDeErro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const respostas: RespostaDoCorte[] = [];
      await atenderPedidoDeCorte({ arquivo }, r => respostas.push(r));
      expect(respostas).toEqual([{ tipo: "erro" }]);
      expect(consoleDeErro).toHaveBeenCalledWith(expect.stringContaining("corte do arquivo"), falha);
    } finally {
      consoleDeErro.mockRestore();
    }
  });
});
