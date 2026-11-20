import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import compression from "compression";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A rota do download do áudio (H8c), pelo HTTP de verdade, atrás do gzip global
 * do servidor (server/_core/index.ts monta o compression() antes dela). A sessão
 * e a conversão são dublês injetados (a conversão de verdade, com o ffmpeg, está
 * em conversao-do-audio.test.ts); o balcão das fichas é o de verdade. Prova: só a
 * dona da ficha baixa, uma vez só; o navegador recebe o arquivo com o nome e o
 * tipo certos e nenhuma chave nem URL do bucket; a falha no meio corta a
 * conexão (o download fica marcado como falho); e a vaga volta em qualquer saída.
 * No fim, de ponta a ponta: a mesma rota com a conversão de verdade (o ffmpeg da
 * máquina, obrigatório no CI) e o bucket dublado com tons sintéticos.
 */

const { cabecalhoDoAnexo, registrarRotaDoAudioBaixado } = await import("./_core/rota-do-audio-baixado");
const { criarBalcaoDoAudio } = await import("./baixar-audio-da-reuniao");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { ROTA_DO_AUDIO_BAIXADO } = await import("@shared/baixar-audio");
const { converterPartes } = await import("./conversao-do-audio");
const { ObjetoAusenteNoStorageError } = await import("./storage");

const autenticar = vi.fn();
const converter = vi.fn();
const balcao = criarBalcaoDoAudio({ limite: 5 });
let servidor: Server;
let base = "";

const CHAVE = "meetings/dona-1/0b6f2c1e/partes/0000-abcd1234.webm";
const PARTES = [{ seq: 0, storageKey: CHAVE, mimeType: "audio/webm", inicioMs: 0, duracaoMs: 1000 }];
const emitir = (extra: Record<string, unknown> = {}) => balcao.reservar().emitir({
  ownerId: "dona-1", meetingId: "0b6f2c1e-1111-4222-8333-944445555666", formato: "mp3", nomeDoArquivo: "Reunião com a importadora - 2026-11-18.mp3",
  partes: PARTES, ...extra,
} as never);
const baixar = (numero: string) => fetch(`${base}${ROTA_DO_AUDIO_BAIXADO}/${numero}`, { redirect: "manual" });

beforeAll(async () => {
  const app = express();
  app.use(compression());
  registrarRotaDoAudioBaixado(app, { autenticar, balcao, converter });
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

beforeEach(() => {
  balcao.esquecer();
  autenticar.mockReset();
  autenticar.mockResolvedValue({ openId: "dona-1" });
  converter.mockReset();
  converter.mockImplementation(async (_partes: unknown, _formato: unknown, saida: NodeJS.WritableStream) => {
    saida.write(Buffer.from("ÁUDIO-1"));
    saida.write(Buffer.from("ÁUDIO-2"));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe(`GET ${ROTA_DO_AUDIO_BAIXADO}/{ficha}`, () => {
  it("a dona baixa: 200, o arquivo como anexo com o nome em UTF-8, o tipo, sem cache e sem redirecionar", async () => {
    const resposta = await baixar(emitir());
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("audio/mpeg");
    expect(resposta.headers.get("content-disposition")).toBe(
      `attachment; filename="Reuniao com a importadora - 2026-11-18.mp3"; filename*=UTF-8''${encodeURIComponent("Reunião com a importadora - 2026-11-18.mp3")}`,
    );
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(resposta.headers.get("location")).toBeNull();
    expect(Buffer.from(await resposta.arrayBuffer()).toString()).toBe("ÁUDIO-1ÁUDIO-2");
    expect(converter).toHaveBeenCalledWith(PARTES, "mp3", expect.anything(), expect.any(AbortSignal));
    expect(balcao.ocupadas()).toBe(0);
  });

  it("o gzip do servidor não toca o áudio: o arquivo sai como foi convertido, sem Content-Encoding", async () => {
    const resposta = await fetch(`${base}${ROTA_DO_AUDIO_BAIXADO}/${emitir()}`, { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-encoding")).toBeNull();
    expect(Buffer.from(await resposta.arrayBuffer()).toString()).toBe("ÁUDIO-1ÁUDIO-2");
  });

  it("HEAD não gasta a ficha nem converte: 405, e o GET da dona baixa depois", async () => {
    const numero = emitir();
    const cabeca = await fetch(`${base}${ROTA_DO_AUDIO_BAIXADO}/${numero}`, { method: "HEAD" });
    expect(cabeca.status).toBe(405);
    expect(cabeca.headers.get("allow")).toBe("GET");
    expect(autenticar).not.toHaveBeenCalled();
    expect(converter).not.toHaveBeenCalled();
    const daDona = await baixar(numero);
    expect(daDona.status).toBe(200);
    await daDona.arrayBuffer();
  });

  it("nem a chave nem a URL do bucket aparecem em cabeçalho ou corpo", async () => {
    const resposta = await baixar(emitir());
    const tudo = JSON.stringify(Array.from(resposta.headers.entries())) + Buffer.from(await resposta.arrayBuffer()).toString();
    expect(tudo).not.toMatch(/meetings\/|partes\/|abcd1234|X-Amz|backblaze|manus-storage/i);
  });

  it("M4A sai como audio/mp4", async () => {
    const resposta = await baixar(emitir({ formato: "m4a", nomeDoArquivo: "Reunião.m4a" }));
    expect(resposta.headers.get("content-type")).toBe("audio/mp4");
    await resposta.arrayBuffer();
  });

  it("a ficha serve uma vez só: o segundo pedido leva 404 ENDERECO_VENCIDO, sem converter", async () => {
    const numero = emitir();
    await (await baixar(numero)).arrayBuffer();
    const segunda = await baixar(numero);
    expect(segunda.status).toBe(404);
    expect(await segunda.json()).toEqual({ codigo: "ENDERECO_VENCIDO" });
    expect(converter).toHaveBeenCalledTimes(1);
  });

  it("ficha de outra conta: 404, sem converter, e ela continua valendo para a dona", async () => {
    const numero = emitir();
    autenticar.mockResolvedValueOnce({ openId: "outra-conta" });
    const alheia = await baixar(numero);
    expect(alheia.status).toBe(404);
    expect(converter).not.toHaveBeenCalled();
    const daDona = await baixar(numero);
    expect(daDona.status).toBe(200);
    await daDona.arrayBuffer();
  });

  it("ficha inventada ou fora do formato: 404, sem converter", async () => {
    for (const numero of ["A".repeat(32), "curta", "..%2F..%2Fetc%2Fpasswd"]) {
      const resposta = await baixar(numero);
      expect(resposta.status).toBe(404);
    }
    expect(converter).not.toHaveBeenCalled();
  });

  it("sem sessão: 401 SEM_SESSAO; banco fora do ar: 503 BANCO_INDISPONIVEL; sessão de cron: 403; nenhum consome a ficha", async () => {
    const numero = emitir();
    autenticar.mockRejectedValueOnce(new Error("Invalid session cookie"));
    const semSessao = await baixar(numero);
    expect(semSessao.status).toBe(401);
    expect(await semSessao.json()).toEqual({ codigo: "SEM_SESSAO" });
    autenticar.mockRejectedValueOnce(new BancoIndisponivel());
    const bancoFora = await baixar(numero);
    expect(bancoFora.status).toBe(503);
    expect(await bancoFora.json()).toEqual({ codigo: "BANCO_INDISPONIVEL" });
    autenticar.mockResolvedValueOnce({ openId: "cron_tarefa", isCron: true });
    expect((await baixar(numero)).status).toBe(403);
    expect(converter).not.toHaveBeenCalled();
    const daDona = await baixar(numero);
    expect(daDona.status).toBe(200);
    await daDona.arrayBuffer();
  });

  it("a conversão falha no meio: a conexão é cortada (o corpo não chega inteiro), o erro vai ao log e a vaga volta", async () => {
    converter.mockImplementationOnce(async (_p: unknown, _f: unknown, saida: NodeJS.WritableStream) => {
      saida.write(Buffer.alloc(64 * 1024, 1));
      await new Promise(pronto => setTimeout(pronto, 50));
      throw new Error("o codificador saiu com 1");
    });
    const resposta = await baixar(emitir());
    expect(resposta.status).toBe(200);
    await expect(resposta.arrayBuffer()).rejects.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("parou no meio: o codificador saiu com 1"));
    await vi.waitFor(() => expect(balcao.ocupadas()).toBe(0));
  });

  it("a dona fecha o download: o sinal cancela a conversão, nada vai ao log como erro, e a vaga volta", async () => {
    let sinalDaConversao: AbortSignal | null = null;
    converter.mockImplementationOnce((_p: unknown, _f: unknown, saida: NodeJS.WritableStream, sinal: AbortSignal) => {
      sinalDaConversao = sinal;
      saida.write(Buffer.alloc(1024, 1));
      return new Promise((_ok, falhar) => sinal.addEventListener("abort", () => falhar(Object.assign(new Error("cancelado"), { name: "AbortError" }))));
    });
    const controle = new AbortController();
    const resposta = await fetch(`${base}${ROTA_DO_AUDIO_BAIXADO}/${emitir()}`, { signal: controle.signal });
    expect(resposta.status).toBe(200);
    controle.abort();
    await vi.waitFor(() => expect(sinalDaConversao?.aborted).toBe(true));
    await vi.waitFor(() => expect(balcao.ocupadas()).toBe(0));
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("cabecalhoDoAnexo", () => {
  const partes = (cabecalho: string) => /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/.exec(cabecalho);

  it.each([
    "اجتماع مع المستوردة - 2026-11-18.mp3",
    "会议 记录 - 2026-11-18.m4a",
    "Встреча - 2026-11-18.mp3",
    "D'Ávila (rev*) & cia - 2026-11-18.mp3",
  ])("%s: o filename* em UTF-8 devolve o nome exato, com só os caracteres que o RFC 5987 deixa; o filename, só ASCII", nome => {
    const achado = partes(cabecalhoDoAnexo(nome));
    expect(achado).not.toBeNull();
    const [, ascii, codificado] = achado!;
    expect(ascii).toMatch(/^[\x20-\x7e]+$/);
    expect(ascii).not.toMatch(/["\\]/);
    expect(codificado).toMatch(/^[A-Za-z0-9%!#$&+\-.^_`|~]+$/);
    expect(decodeURIComponent(codificado)).toBe(nome);
  });

  it("o acento sai no filename sem ele, e o resto fica igual", () => {
    expect(partes(cabecalhoDoAnexo("Reunião de Ação - 2026-11-18.mp3"))![1]).toBe("Reuniao de Acao - 2026-11-18.mp3");
  });
});

// De ponta a ponta, com o ffmpeg de verdade. Sem ele na máquina, o bloco se pula;
// no CI (CI=true) ele é obrigatório, como em conversao-do-audio.test.ts.
const comFfmpeg = (() => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return (r.status === 0 && /libmp3lame/.test(r.stdout) && /libopus/.test(r.stdout)) || process.env.CI === "true";
})();

describe.skipIf(!comFfmpeg)("de ponta a ponta: a rota de verdade, com o ffmpeg de verdade", () => {
  const ID = "0b6f2c1e-1111-4222-8333-944445555666";
  const WEBM = `meetings/dona-1/${ID}/partes/0000-aaaa1111.webm`;
  const M4A = `meetings/dona-1/${ID}/partes/0001-bbbb2222.m4a`;
  const bucket: Record<string, Buffer> = {};
  const balcaoReal = criarBalcaoDoAudio({ limite: 5 });
  let pasta = "";
  let servidorReal: Server;
  let baseReal = "";

  /** Um arquivo de teste gerado pelo ffmpeg: tom sintético, nenhuma gravação real. */
  function gerar(nome: string, args: string[]): Buffer {
    const destino = path.join(pasta, nome);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, destino], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg não gerou ${nome}: ${r.stderr}`);
    return readFileSync(destino);
  }

  beforeAll(async () => {
    pasta = mkdtempSync(path.join(os.tmpdir(), "wrw-rota-audio-"));
    // A parte 0 do Chrome (WebM/Opus, 1 s) e a parte 1 do iPhone (MP4/AAC fragmentado, 2 s).
    bucket[WEBM] = gerar("tom440.webm", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-c:a", "libopus", "-b:a", "32k"]);
    bucket[M4A] = gerar("tom880.m4a", ["-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"]);
    const app = express();
    app.use(compression());
    registrarRotaDoAudioBaixado(app, {
      autenticar: async () => ({ openId: "dona-1" }),
      balcao: balcaoReal,
      converter: (partes, formato, saida, sinal) => converterPartes(partes, formato, saida, {
        lerParte: async chave => {
          const bytes = bucket[chave];
          if (!bytes) throw new ObjetoAusenteNoStorageError(chave);
          return bytes;
        },
        avisar: () => undefined,
        // O que se prova aqui é o caminho do arquivo, e não a fila da CPU (ver conversao-do-audio.test.ts).
        prioridade: 0,
      }, sinal),
    });
    await new Promise<void>(pronto => { servidorReal = app.listen(0, "127.0.0.1", () => pronto()); });
    baseReal = `http://127.0.0.1:${(servidorReal.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise(fim => servidorReal.close(fim));
    if (pasta) rmSync(pasta, { recursive: true, force: true });
  });

  it.each([["mp3", "audio/mpeg", "mp3"], ["m4a", "audio/mp4", "aac"]] as const)(
    "%s: o navegador recebe o áudio inteiro, as partes emendadas na ordem, sem gzip e sem nada do bucket",
    async (formato, tipo, codec) => {
      const numero = balcaoReal.reservar().emitir({
        ownerId: "dona-1", meetingId: ID, formato, nomeDoArquivo: `Reunião - 2026-11-18.${formato}`,
        // Fora de ordem de propósito: a conversão segue o seq.
        partes: [
          { seq: 1, storageKey: M4A, mimeType: "audio/mp4", inicioMs: 1000, duracaoMs: 2000 },
          { seq: 0, storageKey: WEBM, mimeType: "audio/webm", inicioMs: 0, duracaoMs: 1000 },
        ],
      });
      const resposta = await fetch(`${baseReal}${ROTA_DO_AUDIO_BAIXADO}/${numero}`, { headers: { "accept-encoding": "gzip, br" } });
      expect(resposta.status).toBe(200);
      expect(resposta.headers.get("content-type")).toBe(tipo);
      expect(resposta.headers.get("content-encoding")).toBeNull();
      const bytes = Buffer.from(await resposta.arrayBuffer());
      expect(bytes.toString("latin1")).not.toMatch(/meetings\/dona-1|aaaa1111|bbbb2222/);
      const baixado = path.join(pasta, `baixado.${formato}`);
      writeFileSync(baixado, bytes);
      const sonda = spawnSync("ffprobe", ["-hide_banner", "-loglevel", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels", "-of", "json", baixado], { encoding: "utf8" });
      const info = JSON.parse(sonda.stdout) as { format: { duration: string }; streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
      expect(info.streams[0]).toMatchObject({ codec_name: codec, sample_rate: "24000", channels: 1 });
      expect(Number(info.format.duration)).toBeGreaterThan(2.7);
      expect(Number(info.format.duration)).toBeLessThan(3.5);
      await vi.waitFor(() => expect(balcaoReal.ocupadas()).toBe(0));
    },
    60_000,
  );
});
