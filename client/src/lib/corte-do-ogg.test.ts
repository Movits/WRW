import { describe, expect, it } from "vitest";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { cortarOgg } from "./corte-do-ogg";
import { aleatorios, amostrasDoToc, juntar, leitorDe, oggOpus, oggVorbis, paginaOgg, TOC_OPUS_20MS, TOC_OPUS_60MS, type OpcoesDoOggOpus } from "@/test/audio-sintetico";
import { mesmosPacotes, montar, pacotesOgg, paginasOgg, partesDe } from "@/test/conferir-partes";

/**
 * O corte do Ogg (H9b), o áudio do WhatsApp: cada parte é um Ogg sozinho, com
 * as páginas de cabeçalho refeitas (as etiquetas trocadas por vazias), as de
 * áudio com o grânulo contado desde o 0 da parte, a sequência renumerada, o
 * fim do fluxo na última e o CRC refeito (conferido bit a bit). Os arquivos
 * são sintéticos (test/audio-sintetico.ts).
 */

async function cortar(bytes: Uint8Array, opcoes: Parameters<typeof cortarOgg>[2] = {}) {
  return cortarOgg(leitorDe(bytes), bytes.length, opcoes);
}

/** Confere cada parte Opus: cabeçalhos, grânulos desde 0, EOS na última página, CRCs e os pacotes do arquivo, na ordem. */
function conferirOpus(bytes: Uint8Array, corte: Awaited<ReturnType<typeof cortarOgg>>, pacotes: Uint8Array[], toc = TOC_OPUS_20MS) {
  const partes = partesDe(corte);
  const nasPartes: Uint8Array[] = [];
  for (const parte of partes) {
    const paginas = paginasOgg(montar(bytes, parte));
    expect(paginas.every(p => p.crcCerto)).toBe(true);
    expect(paginas.map(p => p.seq)).toEqual(paginas.map((_p, i) => i));
    expect(paginas[0].tipo & 2).toBe(2);
    expect(paginas[paginas.length - 1].tipo & 4).toBe(4);
    expect(paginas.slice(0, -1).every(p => !(p.tipo & 4))).toBe(true);
    // Só um fluxo: o vídeo e as outras páginas ficam de fora.
    expect(new Set(paginas.map(p => p.serial)).size).toBe(1);
    const [head, tags, ...audio] = pacotesOgg(paginas);
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe("OpusHead");
    // As etiquetas vazias, com o nome do programa (a capa sai).
    expect(String.fromCharCode(...tags.subarray(0, 8))).toBe("OpusTags");
    expect(tags.length).toBeLessThan(40);
    // O grânulo de cada página de áudio é a soma das amostras até ela, desde o 0 da parte.
    let amostras = 0;
    // As duas primeiras páginas são as de cabeçalho (o OpusHead e as etiquetas vazias).
    for (const pagina of paginas.slice(2)) {
      amostras += pacotesOgg([pagina]).length * amostrasDoToc(toc);
      expect(pagina.granulo).toBe(amostras);
    }
    expect(parte.duracaoMs).toBe(Math.round(amostras / 48));
    nasPartes.push(...audio);
  }
  expect(mesmosPacotes(nasPartes, pacotes)).toBe("iguais");
  return partes;
}

describe("cortarOgg: o Opus", () => {
  it.each<[string, Partial<OpcoesDoOggOpus>]>([
    ["o áudio do WhatsApp (Opus de 20 ms)", {}],
    ["com uma capa nas etiquetas, em várias páginas", { capa: 70_000 }],
    ["com o vídeo de um .ogv no mesmo arquivo", { comVideo: true }],
    ["o trecho de uma transmissão (o grânulo não começa em 0)", { granuloInicial: 4_800_000 }],
  ])("%s: as partes começam em 0 e levam os pacotes do arquivo, na ordem", async (_caso, o) => {
    const { bytes, pacotes } = oggOpus({ pacotes: 1000, ...o });
    const corte = await cortar(bytes, { segundosPorParte: 6 });
    expect(corte).toMatchObject({ ok: true, formato: "ogg", mimeType: "audio/ogg", duracaoMs: 20_000 });
    const partes = conferirOpus(bytes, corte, pacotes);
    // Páginas de 50 pacotes (1 s): a parte fecha numa página que abre pacote novo, a cada 6 s.
    expect(partes.map(p => p.duracaoMs)).toEqual([6000, 6000, 6000, 2000]);
  });

  it("os pacotes de 60 ms (o SILK do WhatsApp antigo) contam pelo TOC", async () => {
    const { bytes, pacotes } = oggOpus({ pacotes: 200, toc: TOC_OPUS_60MS, porPagina: 20 });
    const corte = await cortar(bytes, { segundosPorParte: 5 });
    conferirOpus(bytes, corte, pacotes, TOC_OPUS_60MS);
    expect(corte.ok && corte.duracaoMs).toBe(12_000);
  });

  it("o pacote que atravessa páginas não se parte entre duas partes", async () => {
    // O pacote 1 começa na página 2 (os laços 255, 255) e termina na 3 (90 bytes), que continua (tipo 1).
    const pacote = (i: number, n: number) => { const p = aleatorios(n, 50 + i); p[0] = TOC_OPUS_20MS; return p; };
    const [p0, p1, p2, p3] = [pacote(0, 80), pacote(1, 600), pacote(2, 80), pacote(3, 80)];
    const { bytes: cabecalhos } = oggOpus({ pacotes: 0 });
    const bytes = juntar(
      cabecalhos,
      paginaOgg({ tipo: 0, granulo: 960, serial: 0x1234, seq: 2, lacos: [80, 255, 255], corpo: juntar(p0, p1.subarray(0, 510)) }),
      paginaOgg({ tipo: 1, granulo: 2880, serial: 0x1234, seq: 3, lacos: [90, 80], corpo: juntar(p1.subarray(510), p2) }),
      paginaOgg({ tipo: 4, granulo: 3840, serial: 0x1234, seq: 4, lacos: [80], corpo: p3 }),
    );
    // Partes de 20 ms: cada pacote numa parte, menos o 1, que vai com o 0 (a página dele começou com o 0).
    const corte = await cortar(bytes, { segundosPorParte: 0.02 });
    const partes = partesDe(corte);
    expect(partes.map(p => p.duracaoMs)).toEqual([60, 20]);
    const pacotes = partes.flatMap(p => pacotesOgg(paginasOgg(montar(bytes, p))).slice(2));
    expect(pacotes).toEqual([p0, p1, p2, p3]);
  });

  it("a página com o CRC errado fica de fora, como no decodificador", async () => {
    const { bytes } = oggOpus({ pacotes: 300 });
    const estragado = bytes.slice();
    // Um byte do miolo de uma página do meio: o CRC dela não confere mais.
    estragado[Math.floor(bytes.length / 2)] ^= 0x55;
    const corte = await cortar(estragado);
    const partes = partesDe(corte);
    const paginas = paginasOgg(montar(estragado, partes[0]));
    expect(paginas.every(p => p.crcCerto)).toBe(true);
    expect(corte.ok && corte.duracaoMs).toBe(5_000);
  });

  it("acima de 12 h: LONGO_DEMAIS; mais partes que o teto: MUITAS_PARTES", async () => {
    // Pacotes de 120 ms (o máximo do TOC: o código 3 com 3 quadros de 40 ms) e de 3 bytes: 12 h e um pacote em ~1,2 MB.
    const pacotes = Math.floor((GRAVACAO_EM_PARTES_SEGUNDOS_MAX * 1000) / 120) + 1;
    const { bytes } = oggOpus({ pacotes, toc: 0x13, segundoByte: 3, tamanho: () => 3, porPagina: 255 });
    expect(await cortar(bytes)).toEqual({ ok: false, codigo: "LONGO_DEMAIS", formato: "ogg" });
    const { bytes: curto } = oggOpus({ pacotes: 500 });
    expect(await cortar(curto, { segundosPorParte: 1, partesNoMaximo: 3 })).toEqual({ ok: false, codigo: "MUITAS_PARTES", formato: "ogg" });
  }, 60_000);
});

describe("cortarOgg: o Vorbis e as recusas", () => {
  it.each([
    ["o Ogg Vorbis", 0],
    // O grânulo do começo não vira duração da primeira parte: antes ela levava
    // a hora inteira, e a rota a recusava (mais de 720 s).
    ["o Ogg Vorbis que não começa no 0 (1 h de grânulo, o trecho de uma transmissão)", 3600 * 44100],
  ])("%s: o grânulo desde o 0 da parte, e os três cabeçalhos (o comentário vazio)", async (_caso, granuloInicial) => {
    const { bytes, pacotes, amostras } = oggVorbis({ pacotes: 600, granuloInicial });
    const corte = await cortar(bytes, { segundosPorParte: 3 });
    expect(corte).toMatchObject({ ok: true, duracaoMs: Math.round((amostras / 44100) * 1000) });
    const partes = partesDe(corte);
    const nasPartes: Uint8Array[] = [];
    let total = 0;
    for (const parte of partes) {
      const paginas = paginasOgg(montar(bytes, parte));
      expect(paginas.every(p => p.crcCerto)).toBe(true);
      const [identificacao, comentario, setup, ...audio] = pacotesOgg(paginas);
      expect(identificacao[0]).toBe(1);
      expect(comentario[0]).toBe(3);
      expect(setup[0]).toBe(5);
      const ultimo = paginas[paginas.length - 1];
      expect(ultimo.tipo & 4).toBe(4);
      // O maior grânulo é a duração da parte: começa em 0.
      expect(ultimo.granulo).toBe(audio.length * 1024);
      expect(parte.duracaoMs).toBe(Math.round((ultimo.granulo / 44100) * 1000));
      total += ultimo.granulo;
      nasPartes.push(...audio);
    }
    expect(mesmosPacotes(nasPartes, pacotes)).toBe("iguais");
    expect(total).toBe(amostras);
  });

  it.each<[string, Uint8Array, unknown]>([
    ["o Ogg FLAC", paginaOgg({ tipo: 2, granulo: 0, serial: 1, seq: 0, lacos: [51], corpo: juntar([0x7f], Array.from("FLAC", c => c.charCodeAt(0)), aleatorios(46, 1)) }), { ok: false, codigo: "SEM_SUPORTE", formato: "ogg", detalhe: "FLAC (Ogg)" }],
    ["o Speex", paginaOgg({ tipo: 2, granulo: 0, serial: 1, seq: 0, lacos: [80], corpo: juntar(Array.from("Speex   ", c => c.charCodeAt(0)), aleatorios(72, 1)) }), { ok: false, codigo: "SEM_SUPORTE", formato: "ogg", detalhe: "Speex" }],
    ["o vídeo Theora sozinho", paginaOgg({ tipo: 2, granulo: 0, serial: 1, seq: 0, lacos: [42], corpo: juntar([0x80], Array.from("theora", c => c.charCodeAt(0)), aleatorios(35, 1)) }), { ok: false, codigo: "SEM_AUDIO", formato: "ogg" }],
  ])("%s", async (_caso, bytes, esperado) => {
    expect(await cortar(bytes)).toEqual(esperado);
  });

  // Sem o `detalhe`: o nome do formato iria para o aviso em português nos 10
  // idiomas; a tela usa um aviso próprio para a recusa sem nome (Meetings.tsx).
  it("o Ogg encadeado (outra gravação emendada depois do fim do fluxo) não some em silêncio: SEM_SUPORTE, sem nome de formato", async () => {
    const primeiro = oggOpus({ pacotes: 100 }).bytes;
    const segundo = oggOpus({ pacotes: 100, semente: 2 }).bytes;
    expect(await cortar(juntar(primeiro, segundo))).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "ogg" });
  });

  it("outro fluxo de áudio que começa no meio do primeiro (o encadeado sem o fim do fluxo): a mesma recusa", async () => {
    const primeiro = oggOpus({ pacotes: 300 }).bytes;
    const inicioDoSegundo = oggOpus({ pacotes: 10, semente: 2 }).bytes.subarray(0, 47);
    expect(String.fromCharCode(...inicioDoSegundo.subarray(28, 36))).toBe("OpusHead");
    // Depois da quarta página de áudio do primeiro.
    const paginas = paginasOgg(primeiro);
    const corte = paginas.slice(0, 6).reduce((s, p) => s + 27 + p.lacos.length + p.corpo.length, 0);
    const emendado = juntar(primeiro.subarray(0, corte), inicioDoSegundo, primeiro.subarray(corte));
    expect(await cortar(emendado)).toEqual({ ok: false, codigo: "SEM_SUPORTE", formato: "ogg" });
  });

  it("o que não é Ogg: DANIFICADO", async () => {
    const lixo = aleatorios(20_000, 4);
    expect(await cortar(lixo)).toEqual({ ok: false, codigo: "DANIFICADO", formato: "ogg" });
  });
});
