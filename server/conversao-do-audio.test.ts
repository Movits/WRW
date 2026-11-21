import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PRIORIDADE_DO_FFMPEG, ambienteDoFfmpeg, argumentosDoCodificador, argumentosDoDecodificador, converterPartes, usuarioDoFfmpeg,
  type DependenciasDaConversao, type ParteDoAudio,
} from "./conversao-do-audio";
import { ObjetoAusenteNoStorageError } from "./storage";

// Os tipos que a rota das partes aceita (server/fatias-de-reuniao.ts): o módulo
// pede o JWT_SECRET ao carregar, como em corte-dos-formatos-no-servidor.test.ts.
process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
const { TIPOS_DAS_PARTES } = await import("./fatias-de-reuniao");

/**
 * A conversão do áudio que a dona baixa (H8c), com o ffmpeg DE VERDADE: as
 * partes de teste são tons e silêncios gerados pelo próprio ffmpeg (nenhuma
 * gravação real), nos formatos de cada aparelho. O arquivo que sai é medido de
 * volta com o ffprobe e decodificado em janelas de 100 ms, e o volume de cada
 * janela diz o que tocou em cada instante: assim a ORDEM das partes e o
 * silêncio no lugar do trecho que falta são conferidos no som, e não no código.
 *
 * Sem o ffmpeg na máquina, o bloco se pula; no CI (CI=true) ele é obrigatório,
 * e o passo "ffmpeg" de .github/workflows/testes.yml o instala. Os testes que
 * medem o som rodam o ffmpeg na prioridade normal (prioridade: 0): com a suíte
 * inteira em paralelo, o nice da produção os deixaria na fila da CPU, e o que
 * eles provam é a conversão. A prioridade da produção tem o teste dela.
 */

function temFfmpeg(): boolean {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 && /libmp3lame/.test(r.stdout) && /libopus/.test(r.stdout) && /\saac\s/.test(r.stdout);
}
const comFfmpeg = temFfmpeg() || process.env.CI === "true";

describe("o ffmpeg roda contido", () => {
  it("o ambiente dele leva só o PATH: nenhum segredo do servidor desce", () => {
    const ambiente = ambienteDoFfmpeg({
      PATH: "/usr/bin:/bin", DATABASE_URL: "mysql://x", STORAGE_SECRET_ACCESS_KEY: "segredo", STORAGE_ACCESS_KEY_ID: "id",
      JWT_SECRET: "jwt", LLM_API_KEY: "chave", VAULT_ENCRYPTION_KEY: "cofre",
    }, "linux");
    expect(ambiente).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("no Windows de desenvolvimento, só o mínimo para um programa subir", () => {
    const ambiente = ambienteDoFfmpeg({ Path: "C:\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\t", JWT_SECRET: "jwt" }, "win32");
    expect(ambiente).toEqual({ PATH: "C:\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\t" });
  });

  it("com o servidor como root, o ffmpeg desce para o nobody; fora disso, não troca de usuário", () => {
    expect(usuarioDoFfmpeg(() => 0, "linux")).toEqual({ uid: 65534, gid: 65534 });
    expect(usuarioDoFfmpeg(() => 1000, "linux")).toBeNull();
    expect(usuarioDoFfmpeg(undefined, "win32")).toBeNull();
  });

  it("o decodificador só abre arquivo local, só os formatos e os decodificadores do áudio da reunião", () => {
    const args = argumentosDoDecodificador("/tmp/x/parte-0001.webm");
    const valor = (opcao: string) => args[args.indexOf(opcao) + 1];
    expect(valor("-protocol_whitelist")).toBe("file");
    expect(valor("-format_whitelist").split(",")).toEqual(["matroska", "mov", "mp3", "ogg", "wav", "aac", "flac"]);
    expect(valor("-codec_whitelist").split(",")).toEqual(expect.arrayContaining(["opus", "aac", "mp3float", "vorbis", "flac", "pcm_s16le"]));
    expect(valor("-codec_whitelist")).not.toMatch(/h264|hevc|png|mjpeg|subrip/);
    // As opções valem para a entrada: vêm antes do -i.
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-nostdin");
  });

  it("o MP3 sai em taxa constante, sem Xing e sem ID3; o M4A, fragmentado", () => {
    const mp3 = argumentosDoCodificador("mp3");
    expect(mp3.join(" ")).toContain("-c:a libmp3lame -b:a 64k -write_xing 0 -id3v2_version 0 -f mp3 pipe:1");
    const m4a = argumentosDoCodificador("m4a");
    expect(m4a.join(" ")).toContain("-movflags +empty_moov+default_base_moof");
    expect(m4a.join(" ")).toContain("-f ipod pipe:1");
  });
});

/**
 * As proteções da conversão com um ffmpeg DE MENTIRA (revisão do pacote 4b): o
 * spawn é trocado por um que sobe o próprio Node com um roteiro curto no papel
 * de cada ffmpeg (o codificador, que recebe o PCM pela entrada; o decodificador
 * de cada parte). Assim se provam, em qualquer máquina e sem esperar 60 s, o
 * decodificador parado, o teto do arquivo, o codificador que sai antes da
 * hora, a troca de usuário recusada, o cancelamento na hora de subir um ffmpeg,
 * a saída que fecha no meio e o arquivo que sairia só com silêncio.
 */
describe("converterPartes: as proteções, com um ffmpeg de mentira", () => {
  /** O codificador de mentira devolve o PCM como recebeu (um cat), e assim o arquivo é o próprio PCM. */
  const CAT = "process.stdin.pipe(process.stdout)";
  /** O decodificador que entrega `bytes` de áudio e termina. */
  const entrega = (bytes: number) => `process.stdout.write(Buffer.alloc(${bytes}, 7), () => process.exit(0))`;
  /** O decodificador que entrega `bytes` de áudio e para, sem sair (o ffmpeg travado). */
  const entregaEPara = (bytes: number) => `process.stdout.write(Buffer.alloc(${bytes}, 7)); setInterval(() => {}, 1 << 30)`;
  /** O decodificador que não entrega nada e sai com erro (a parte estragada, o codec fora da lista). */
  const NADA = "process.exit(1)";

  type Chamada = { args: string[]; opcoes: SpawnOptions };

  /** O spawn de mentira: o codificador é o que lê da entrada (pipe:0); o resto é decodificador. */
  function ffmpegDeMentira(papeis: { codificador?: string; decodificador: string | ((n: number) => string) }) {
    const chamadas: Chamada[] = [];
    let decodificadores = 0;
    const dublado = (_executavel: string, args: readonly string[], opcoes: SpawnOptions) => {
      chamadas.push({ args: [...args], opcoes });
      const roteiro = args.includes("pipe:0")
        ? papeis.codificador ?? CAT
        : typeof papeis.decodificador === "function" ? papeis.decodificador(decodificadores++) : papeis.decodificador;
      return spawn(process.execPath, ["-e", roteiro], opcoes);
    };
    return { spawn: dublado as unknown as typeof spawn, chamadas };
  }

  const parte = (seq: number, inicioMs: number, duracaoMs = 1000): ParteDoAudio => ({ seq, storageKey: `parte-${seq}`, mimeType: "audio/webm", inicioMs, duracaoMs });

  async function converterComMentira(
    partes: ParteDoAudio[], dublado: ReturnType<typeof ffmpegDeMentira>,
    extra: Partial<DependenciasDaConversao> & { saida?: Writable; sinal?: AbortSignal } = {},
  ) {
    const pedacos: Buffer[] = [];
    const avisos: string[] = [];
    const pids: number[] = [];
    const saida = extra.saida ?? new Writable({ write(pedaco, _c, pronto) { pedacos.push(pedaco); pronto(); } });
    const promessa = converterPartes(partes, "mp3", saida, {
      lerParte: async () => Buffer.from("parte"), avisar: m => avisos.push(m), aoIniciar: pid => pids.push(pid),
      prioridade: 0, usuario: null, spawn: dublado.spawn, ...extra,
    }, extra.sinal ?? new AbortController().signal);
    return { promessa, pedacos, avisos, pids, bytes: () => Buffer.concat(pedacos) };
  }

  /** Os erros que escapam sem dono (o 'error' de um filho sem ouvinte derrubaria o servidor). */
  async function semErroSolto(fazer: () => Promise<void>) {
    const soltos: unknown[] = [];
    const registrar = (erro: unknown) => soltos.push(erro);
    process.on("uncaughtException", registrar);
    try {
      await fazer();
      // O AbortError do spawn cancelado chega num tique seguinte: dá tempo a ele.
      await new Promise(pronto => setTimeout(pronto, 300));
    } finally {
      process.off("uncaughtException", registrar);
    }
    expect(soltos).toEqual([]);
  }

  const todosSairam = (pids: number[]) =>
    vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 15_000, interval: 50 });

  it("o decodificador que para de entregar áudio é encerrado no prazo, com o aviso, e o arquivo segue com a parte seguinte", async () => {
    // A parte 0 entrega 0,1 s e para; a 1 entrega 0,1 s e termina.
    const dublado = ffmpegDeMentira({ decodificador: n => (n === 0 ? entregaEPara(4800) : entrega(4800)) });
    // 5 s, e não menos: o prazo conta desde a subida do processo, e o Node de
    // mentira demora a subir com a suíte inteira rodando em paralelo (com 300 ms,
    // ele era encerrado antes de entregar o primeiro pedaço).
    const r = await converterComMentira([parte(0, 0), parte(1, 1000)], dublado, { prazoSemSaidaMs: 5000 });
    await r.promessa;
    // 0,1 s de cada parte, sem silêncio entre elas (o vão é menor que a folga de 1 s).
    expect(r.bytes().length).toBe(9600);
    expect(r.bytes().every(b => b === 7)).toBe(true);
    expect(r.avisos).toEqual(["[Áudio] a parte 0 passou 5 s sem decodificar; o resto dela sai em silêncio."]);
    await todosSairam(r.pids);
  }, 30_000);

  it("o arquivo para no teto: nem o áudio de uma parte nem o silêncio antes da seguinte passam dele", async () => {
    // A parte entrega mais que o teto (1 s = 48.000 bytes de PCM): o arquivo para no teto.
    const longa = await converterComMentira([parte(0, 0), parte(1, 5000)], ffmpegDeMentira({ decodificador: entrega(60_000) }), { tetoDoArquivoSegundos: 1 });
    await longa.promessa;
    expect(longa.bytes().length).toBe(48_000);
    // Um início de parte além do teto (um início errado no banco) não vira horas de silêncio.
    const longe = await converterComMentira([parte(0, 0), parte(1, 3_600_000)], ffmpegDeMentira({ decodificador: entrega(4800) }), { tetoDoArquivoSegundos: 1 });
    await longe.promessa;
    expect(longe.bytes().length).toBe(48_000);
    expect(longe.bytes().subarray(4800).every(b => b === 0)).toBe(true);
  }, 30_000);

  it("o codificador que sai antes da hora para a conversão, sem ela ficar esperando para sempre", async () => {
    const dublado = ffmpegDeMentira({ codificador: "process.exit(3)", decodificador: entrega(4 * 1024 * 1024) });
    const r = await converterComMentira([parte(0, 0)], dublado);
    await expect(r.promessa).rejects.toThrow();
    await todosSairam(r.pids);
  }, 30_000);

  it.each(["EPERM", "EINVAL"])("como root, a troca para o nobody recusada (%s) não sobe o ffmpeg sem ela: a conversão para, e o log diz por quê", async codigo => {
    const chamadas: SpawnOptions[] = [];
    const recusada = ((_executavel: string, _args: readonly string[], opcoes: SpawnOptions) => {
      chamadas.push(opcoes);
      // O spawn do Node lança na hora quando o sistema recusa o setuid/setgid.
      throw Object.assign(new Error(`spawn ${codigo}`), { code: codigo, errno: -1, syscall: "spawn" });
    }) as unknown as typeof spawn;
    const avisos: string[] = [];
    const conversao = converterPartes([parte(0, 0)], "mp3", new Writable({ write(_p, _c, pronto) { pronto(); } }), {
      lerParte: async () => Buffer.from("parte"), avisar: m => avisos.push(m), prioridade: 0,
      usuario: { uid: 65534, gid: 65534 }, spawn: recusada,
    }, new AbortController().signal);
    await expect(conversao).rejects.toMatchObject({ code: codigo });
    // Uma tentativa só, como nobody: nenhuma como root.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ uid: 65534, gid: 65534 });
    expect(avisos.join("\n")).toMatch(/não deixou o ffmpeg rodar como nobody/);
  });

  it("cancelado enquanto a parte seguinte vai para a pasta temporária: o ffmpeg dela nem sobe, sem erro solto, e nada fica para trás", async () => {
    const temporaria = mkdtempSync(path.join(os.tmpdir(), "wrw-audio-cancelar-ao-subir-"));
    try {
      await semErroSolto(async () => {
        const controle = new AbortController();
        const dublado = ffmpegDeMentira({ decodificador: entrega(4800) });
        const r = await converterComMentira([parte(0, 0), parte(1, 1000)], dublado, {
          pastaTemporaria: temporaria, sinal: controle.signal,
          // A parte 0 não está no bucket; a 1 chega depois de um tempo e, ao chegar,
          // agenda o cancelamento para o meio da gravação dela na pasta temporária.
          lerParte: async chave => {
            if (chave === "parte-0") throw new ObjetoAusenteNoStorageError(chave);
            await new Promise(pronto => setTimeout(pronto, 100));
            setImmediate(() => controle.abort());
            return Buffer.alloc(256 * 1024, 1);
          },
        });
        await expect(r.promessa).rejects.toMatchObject({ name: "AbortError" });
        // Só o codificador subiu: o decodificador da parte 1 não.
        expect(dublado.chamadas.filter(c => !c.args.includes("pipe:0"))).toHaveLength(0);
        await todosSairam(r.pids);
      });
      expect(readdirSync(temporaria)).toEqual([]);
    } finally {
      rmSync(temporaria, { recursive: true, force: true });
    }
  }, 30_000);

  it("cancelado logo depois de começar: nenhum ffmpeg sobe, e nenhum erro fica solto", async () => {
    await semErroSolto(async () => {
      const controle = new AbortController();
      const dublado = ffmpegDeMentira({ decodificador: entrega(4800) });
      const r = await converterComMentira([parte(0, 0)], dublado, { sinal: controle.signal });
      controle.abort();
      await expect(r.promessa).rejects.toMatchObject({ name: "AbortError" });
      expect(dublado.chamadas).toHaveLength(0);
    });
  }, 30_000);

  it("a saída que fecha no meio (a conexão caiu) para a conversão: nada fica esperando o cano andar, e os ffmpeg saem", async () => {
    let chegou = false;
    const parada = new Writable({ highWaterMark: 1, write() { chegou = true; } });
    const dublado = ffmpegDeMentira({ decodificador: entrega(2 * 1024 * 1024) });
    const r = await converterComMentira([parte(0, 0)], dublado, { saida: parada });
    await vi.waitFor(() => expect(chegou).toBe(true), { timeout: 15_000, interval: 20 });
    parada.destroy();
    await expect(r.promessa).rejects.toMatchObject({ name: "AbortError" });
    await todosSairam(r.pids);
  }, 30_000);

  it("a saída já fechada: nem começa, e nenhum ffmpeg sobe", async () => {
    const fechada = new Writable({ write(_p, _c, pronto) { pronto(); } });
    fechada.destroy();
    const dublado = ffmpegDeMentira({ decodificador: entrega(4800) });
    const r = await converterComMentira([parte(0, 0)], dublado, { saida: fechada });
    await expect(r.promessa).rejects.toMatchObject({ name: "AbortError" });
    expect(dublado.chamadas).toHaveLength(0);
  });

  it("nenhuma parte entrega áudio (todas estragadas, ou fora do bucket): a conversão lança, em vez de um arquivo só de silêncio", async () => {
    const estragadas = await converterComMentira([parte(0, 0), parte(1, 5000)], ffmpegDeMentira({ decodificador: NADA }));
    await expect(estragadas.promessa).rejects.toThrow("Nenhuma das 2 partes do áudio decodificou");
    const forDoBucket = await converterComMentira([parte(0, 0), parte(1, 5000)], ffmpegDeMentira({ decodificador: entrega(4800) }), {
      lerParte: async chave => { throw new ObjetoAusenteNoStorageError(chave); },
    });
    await expect(forDoBucket.promessa).rejects.toThrow("Nenhuma das 2 partes do áudio decodificou");
    // Basta uma que entregue: a outra vira silêncio, e o arquivo sai.
    const umaBoa = await converterComMentira([parte(0, 0), parte(1, 2000)], ffmpegDeMentira({ decodificador: n => (n === 0 ? NADA : entrega(4800)) }));
    await umaBoa.promessa;
    expect(umaBoa.bytes().length).toBe(96_000 + 4800);
  }, 30_000);
});

describe.skipIf(!comFfmpeg)("converterPartes, com o ffmpeg de verdade", () => {
  let pasta = "";
  const audio: Record<string, Buffer> = {};

  /** Gera um arquivo de teste com o ffmpeg (tom ou silêncio sintético). */
  function gerar(nome: string, args: string[]): Buffer {
    const destino = path.join(pasta, nome);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, destino], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg não gerou ${nome}: ${r.stderr}`);
    return readFileSync(destino);
  }

  beforeAll(() => {
    pasta = mkdtempSync(path.join(os.tmpdir(), "wrw-audio-teste-"));
    // Chrome e Android: WebM com Opus.
    audio.webm = gerar("tom440.webm", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k"]);
    // Safari e iPhone: MP4 fragmentado com AAC (2 s de silêncio).
    audio.m4aFragmentado = gerar("silencio.m4a", ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", "-c:a", "aac", "-b:a", "64k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"]);
    // A importação de MP3 (H9a): 3 s de tom.
    audio.mp3 = gerar("tom880.mp3", ["-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "64k"]);
    // Um M4A de gravador comum, com o índice (moov) no FIM: só se lê com saltos.
    audio.m4aIndiceNoFim = gerar("tom660.m4a", ["-f", "lavfi", "-i", "sine=frequency=660:duration=1", "-ac", "1", "-c:a", "aac", "-b:a", "64k"]);
    // O envio único também aceita WAV e OGG.
    audio.wav = gerar("tom550.wav", ["-f", "lavfi", "-i", "sine=frequency=550:duration=1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]);
    audio.ogg = gerar("tom330.ogg", ["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-ac", "1", "-c:a", "libopus", "-b:a", "24k"]);
    // A importação em partes (H9b) manda o FLAC e o AAC cru (ADTS) como chegaram, sem recodificar.
    audio.flac = gerar("tom770.flac", ["-f", "lavfi", "-i", "sine=frequency=770:duration=1", "-ac", "1", "-ar", "44100", "-c:a", "flac"]);
    audio.adts = gerar("tom990.aac", ["-f", "lavfi", "-i", "sine=frequency=990:duration=1", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-f", "adts"]);
  }, 60_000);
  afterAll(() => { if (pasta) rmSync(pasta, { recursive: true, force: true }); });

  type Resultado = { bytes: Buffer; avisos: string[]; pids: number[] };

  async function converter(
    partes: ParteDoAudio[], formato: "mp3" | "m4a" = "mp3",
    extra: { lerParte?: DependenciasDaConversao["lerParte"]; saida?: Writable; sinal?: AbortSignal; pastaTemporaria?: string } = {},
  ): Promise<Resultado> {
    const pedacos: Buffer[] = [];
    const saida = extra.saida ?? new Writable({ write(pedaco, _codificacao, pronto) { pedacos.push(pedaco); pronto(); } });
    const avisos: string[] = [];
    const pids: number[] = [];
    const lerParte = extra.lerParte ?? (async (chave: string) => {
      const bytes = audio[chave] ?? (chave.startsWith("bytes:") ? Buffer.from(chave.slice(6)) : undefined);
      if (!bytes) throw new ObjetoAusenteNoStorageError(chave);
      return bytes;
    });
    await converterPartes(partes, formato, saida, {
      lerParte, avisar: mensagem => avisos.push(mensagem), aoIniciar: pid => pids.push(pid),
      pastaTemporaria: extra.pastaTemporaria, prioridade: 0,
    }, extra.sinal ?? new AbortController().signal);
    return { bytes: Buffer.concat(pedacos), avisos, pids };
  }

  const parte = (seq: number, storageKey: string, mimeType: string, inicioMs: number, duracaoMs: number): ParteDoAudio =>
    ({ seq, storageKey, mimeType, inicioMs, duracaoMs });

  /** O que o ffprobe diz do arquivo, e o volume (RMS) de cada janela de 100 ms. */
  function medir(bytes: Buffer, extensao: string) {
    const arquivo = path.join(pasta, `saida-${Date.now()}-${Math.random().toString(36).slice(2)}.${extensao}`);
    writeFileSync(arquivo, bytes);
    const sonda = spawnSync("ffprobe", ["-hide_banner", "-loglevel", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels", "-of", "json", arquivo], { encoding: "utf8" });
    const info = JSON.parse(sonda.stdout) as { format: { duration: string }; streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
    const pcm = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", arquivo, "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 }).stdout as Buffer;
    rmSync(arquivo, { force: true });
    const janela = 800; // 100 ms a 8 kHz
    const volumes: number[] = [];
    for (let inicio = 0; inicio + janela * 2 <= pcm.length; inicio += janela * 2) {
      let soma = 0;
      for (let i = 0; i < janela; i++) { const v = pcm.readInt16LE(inicio + i * 2); soma += v * v; }
      volumes.push(Math.sqrt(soma / janela));
    }
    /** O volume médio entre dois instantes (s). */
    const volume = (de: number, ate: number) => {
      const trecho = volumes.slice(Math.round(de * 10), Math.round(ate * 10));
      return trecho.reduce((a, b) => a + b, 0) / Math.max(1, trecho.length);
    };
    return { duracao: Number(info.format.duration), stream: info.streams[0], volume };
  }
  const ALTO = 1000;
  const BAIXO = 150;

  it("as partes saem na ordem da reunião (seq), mesmo chegando fora de ordem: 1 s de tom, 2 s de silêncio, 3 s de tom", async () => {
    const r = await converter([
      parte(2, "mp3", "audio/mpeg", 3000, 3000),
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "m4aFragmentado", "audio/mp4", 1000, 2000),
    ]);
    const m = medir(r.bytes, "mp3");
    expect(m.duracao).toBeGreaterThan(5.7);
    expect(m.duracao).toBeLessThan(6.4);
    expect(m.volume(0.2, 0.8)).toBeGreaterThan(ALTO);
    expect(m.volume(1.3, 2.7)).toBeLessThan(BAIXO);
    expect(m.volume(3.3, 5.7)).toBeGreaterThan(ALTO);
    expect(r.avisos).toEqual([]);
  }, 60_000);

  it("formatos misturados (WebM/Opus, MP4/AAC fragmentado, MP3, M4A com o índice no fim, WAV e OGG) viram um MP3 só, mono, 24 kHz, sem Xing nem ID3", async () => {
    const partes = [
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "m4aFragmentado", "audio/mp4", 1000, 2000),
      parte(2, "mp3", "audio/mpeg", 3000, 3000),
      parte(3, "m4aIndiceNoFim", "audio/m4a", 6000, 1000),
      parte(4, "wav", "audio/wav", 7000, 1000),
      parte(5, "ogg", "audio/ogg", 8000, 1000),
    ];
    // O M4A de teste tem mesmo o índice depois do áudio.
    expect(audio.m4aIndiceNoFim.indexOf("moov")).toBeGreaterThan(audio.m4aIndiceNoFim.indexOf("mdat"));
    const r = await converter(partes);
    const m = medir(r.bytes, "mp3");
    expect(m.stream).toMatchObject({ codec_name: "mp3", sample_rate: "24000", channels: 1 });
    expect(m.duracao).toBeGreaterThan(8.7);
    expect(m.duracao).toBeLessThan(9.5);
    // Cada parte tocou no seu lugar: tom, silêncio, tom, tom, tom, tom.
    expect(m.volume(0.2, 0.8)).toBeGreaterThan(ALTO);
    expect(m.volume(1.3, 2.7)).toBeLessThan(BAIXO);
    for (const [de, ate] of [[3.3, 5.7], [6.2, 6.8], [7.2, 7.8], [8.2, 8.8]]) expect(m.volume(de, ate)).toBeGreaterThan(ALTO);
    expect(r.bytes.subarray(0, 3).toString("latin1")).not.toBe("ID3");
    expect(r.bytes.subarray(0, 400).toString("latin1")).not.toMatch(/Xing|Info/);
    expect(r.avisos).toEqual([]);
  }, 60_000);

  it("todo tipo que a rota das partes aceita toca no áudio baixado, também o FLAC e o AAC cru da importação em partes", async () => {
    // Uma amostra com tom para cada tipo: um tipo novo na rota sem amostra aqui faz este teste falhar.
    const amostras: Record<string, string> = {
      "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mp4": "m4aIndiceNoFim", "audio/m4a": "m4aIndiceNoFim",
      "audio/mpeg": "mp3", "audio/flac": "flac", "audio/aac": "adts",
    };
    expect(Object.keys(amostras).sort()).toEqual([...TIPOS_DAS_PARTES].sort());
    // Uma parte a cada 5 s: o vão de mais de 1 s ganha silêncio, então cada parte começa no tempo dela,
    // e a que não decodifica deixa o lugar dela em silêncio, sem a seguinte tomar o lugar.
    const partes = TIPOS_DAS_PARTES.map((tipo, seq) => parte(seq, amostras[tipo], tipo, seq * 5000, tipo === "audio/mpeg" ? 3000 : 1000));
    const r = await converter(partes);
    expect(r.avisos).toEqual([]);
    const m = medir(r.bytes, "mp3");
    const tocou = partes.map(p => ({ tipo: p.mimeType, tocou: m.volume(p.inicioMs / 1000 + 0.2, p.inicioMs / 1000 + 0.8) > ALTO }));
    expect(tocou).toEqual(partes.map(p => ({ tipo: p.mimeType, tocou: true })));
  }, 60_000);

  it("todo codec que entra numa reunião toca no áudio baixado, e não só um por tipo: o MP2 no audio/mpeg, o ADPCM e o GSM no WAV, o AC-3 e o PCM do QuickTime no MP4", async () => {
    const codificadores = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout;
    const tom = (frequencia: number) => ["-f", "lavfi", "-i", `sine=frequency=${frequencia}:duration=1`, "-ac", "1"];
    // [nome do arquivo de teste, tipo da parte, argumentos do ffmpeg, codificador que ele pede]
    const amostras: Array<[string, string, string[], string]> = [
      // O corte do MP3 e a medida do servidor aceitam as camadas I e II no mesmo audio/mpeg.
      ["mp2.mp2", "audio/mpeg", [...tom(500), "-ar", "44100", "-c:a", "mp2", "-b:a", "64k", "-f", "mp2"], "mp2"],
      // O WAV do envio único: o servidor mede o ADPCM e o GSM pelo cabeçalho.
      ["adpcm-ms.wav", "audio/wav", [...tom(600), "-ar", "16000", "-c:a", "adpcm_ms"], "adpcm_ms"],
      ["adpcm-ima.wav", "audio/wav", [...tom(700), "-ar", "16000", "-c:a", "adpcm_ima_wav"], "adpcm_ima_wav"],
      ["gsm.wav", "audio/wav", [...tom(800), "-ar", "8000", "-c:a", "libgsm_ms"], "libgsm_ms"],
      // O MP4 do envio único traz o que o contêiner trouxer.
      ["ac3.mp4", "audio/mp4", [...tom(900), "-c:a", "ac3", "-b:a", "96k"], "ac3"],
      ["eac3.mp4", "audio/mp4", [...tom(1000), "-c:a", "eac3", "-b:a", "96k"], "eac3"],
      ["pcm-s24be.mov", "audio/mp4", [...tom(1100), "-c:a", "pcm_s24be"], "pcm_s24be"],
      ["pcm-f32be.mov", "audio/mp4", [...tom(1200), "-c:a", "pcm_f32be"], "pcm_f32be"],
      // E o WebM do envio único, com o AC-3 dentro.
      ["ac3.mkv", "audio/webm", [...tom(1300), "-c:a", "ac3", "-b:a", "96k", "-f", "matroska"], "ac3"],
    ];
    const disponiveis = amostras.filter(([, , , codificador]) => new RegExp(`\\s${codificador}\\s`).test(codificadores));
    // O GSM pede a libgsm, que nem todo ffmpeg traz; os outros são do próprio ffmpeg e precisam estar aqui.
    expect(amostras.filter(a => !disponiveis.includes(a)).map(a => a[3]).filter(c => c !== "libgsm_ms")).toEqual([]);
    for (const [nome, , args] of disponiveis) audio[`codec:${nome}`] = gerar(nome, args);
    const partes = disponiveis.map(([nome, tipo], seq) => parte(seq, `codec:${nome}`, tipo, seq * 5000, 1000));
    const r = await converter(partes);
    expect(r.avisos).toEqual([]);
    const m = medir(r.bytes, "mp3");
    const tocou = partes.map(p => ({ amostra: p.storageKey, tocou: m.volume(p.inicioMs / 1000 + 0.2, p.inicioMs / 1000 + 0.8) > ALTO }));
    expect(tocou).toEqual(partes.map(p => ({ amostra: p.storageKey, tocou: true })));
  }, 60_000);

  it("nenhuma parte decodifica (todas estragadas): a conversão lança, em vez de entregar um arquivo só de silêncio", async () => {
    await expect(converter([
      parte(0, "bytes:isto não é áudio", "audio/webm", 0, 1000),
      parte(1, "bytes:nem isto", "audio/mpeg", 1000, 1000),
    ])).rejects.toThrow("Nenhuma das 2 partes do áudio decodificou");
  }, 60_000);

  it("em M4A: AAC fragmentado, mono, 24 kHz, com a duração da reunião", async () => {
    const r = await converter([
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "m4aIndiceNoFim", "audio/mp4", 1000, 1000),
      parte(2, "mp3", "audio/mpeg", 2000, 3000),
    ], "m4a");
    expect(r.bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(r.bytes.subarray(8, 12).toString("latin1")).toBe("M4A ");
    expect(r.bytes.includes(Buffer.from("moof"))).toBe(true);
    const m = medir(r.bytes, "m4a");
    expect(m.stream).toMatchObject({ codec_name: "aac", sample_rate: "24000", channels: 1 });
    expect(m.duracao).toBeGreaterThan(4.7);
    expect(m.duracao).toBeLessThan(5.4);
    expect(m.volume(2.3, 4.7)).toBeGreaterThan(ALTO);
  }, 60_000);

  it("o trecho que falta (uma parte que não chegou) vira silêncio, e os tempos seguintes batem com o player", async () => {
    const r = await converter([
      parte(0, "webm", "audio/webm", 0, 1000),
      // A parte 1 (de 1 s a 4 s) não chegou ao bucket: a lista nem a traz.
      parte(2, "mp3", "audio/mpeg", 4000, 3000),
    ]);
    const m = medir(r.bytes, "mp3");
    expect(m.duracao).toBeGreaterThan(6.7);
    expect(m.duracao).toBeLessThan(7.4);
    expect(m.volume(1.3, 3.7)).toBeLessThan(BAIXO);
    expect(m.volume(4.3, 6.7)).toBeGreaterThan(ALTO);
  }, 60_000);

  it("diferença de até 1 s entre o tempo do player e o que já saiu não ganha silêncio", async () => {
    const r = await converter([
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "mp3", "audio/mpeg", 1600, 3000),
    ]);
    const m = medir(r.bytes, "mp3");
    expect(m.duracao).toBeGreaterThan(3.7);
    expect(m.duracao).toBeLessThan(4.4);
  }, 60_000);

  it("a parte que não decodifica vira silêncio no lugar dela, e o resto do arquivo sai", async () => {
    const r = await converter([
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "bytes:isto não é áudio de verdade", "audio/webm", 1000, 2000),
      parte(2, "mp3", "audio/mpeg", 3000, 3000),
    ]);
    const m = medir(r.bytes, "mp3");
    expect(m.duracao).toBeGreaterThan(5.7);
    expect(m.duracao).toBeLessThan(6.4);
    expect(m.volume(1.3, 2.7)).toBeLessThan(BAIXO);
    expect(m.volume(3.3, 5.7)).toBeGreaterThan(ALTO);
    expect(r.avisos.join("\n")).toMatch(/a parte 1 não decodificou inteira/);
  }, 60_000);

  it("o decodificador recusa formato fora da lista: um roteiro do ffmpeg (ffconcat) que puxaria outro arquivo da pasta não toca", () => {
    // Na mesma pasta, um tom de verdade e uma "parte" que é um roteiro apontando para ele.
    const roteiro = path.join(pasta, "roteiro.mp3");
    writeFileSync(roteiro, "ffconcat version 1.0\nfile tom440.webm\n");
    const decodificar = (args: string[]) => spawnSync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
    // Sem a lista, o ffmpeg seguiria o roteiro e entregaria o tom: é isso que a lista barra.
    const semLista = decodificar(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", roteiro, "-map", "0:a:0", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"]);
    expect((semLista.stdout as Buffer).length).toBeGreaterThan(40_000);
    const comLista = decodificar(argumentosDoDecodificador(roteiro));
    expect(comLista.status).not.toBe(0);
    expect((comLista.stdout as Buffer).length).toBe(0);
    expect(String(comLista.stderr)).toMatch(/not on whitelist/);
  });

  it("o objeto que o bucket não tem vira silêncio; outra falha do bucket para o download, sem deixar ffmpeg nem pasta para trás", async () => {
    const ausente = await converter([
      parte(0, "webm", "audio/webm", 0, 1000),
      parte(1, "sumiu-do-bucket", "audio/webm", 1000, 2000),
      parte(2, "mp3", "audio/mpeg", 3000, 3000),
    ]);
    const m = medir(ausente.bytes, "mp3");
    expect(m.duracao).toBeGreaterThan(5.7);
    expect(m.volume(1.3, 2.7)).toBeLessThan(BAIXO);
    expect(ausente.avisos.join("\n")).toMatch(/a parte 1 não está no bucket/);

    const temporaria = mkdtempSync(path.join(os.tmpdir(), "wrw-audio-falha-"));
    const pids: number[] = [];
    const falha = converterPartes([parte(0, "webm", "audio/webm", 0, 1000), parte(1, "mp3", "audio/mpeg", 1000, 3000)], "mp3",
      new Writable({ write(_p, _c, pronto) { pronto(); } }), {
        lerParte: async chave => { if (chave === "mp3") throw new Error("bucket fora do ar"); return audio[chave]; },
        avisar: () => undefined, aoIniciar: pid => pids.push(pid), pastaTemporaria: temporaria, prioridade: 0,
      }, new AbortController().signal);
    await expect(falha).rejects.toThrow("bucket fora do ar");
    expect(readdirSync(temporaria)).toEqual([]);
    expect(pids.length).toBeGreaterThan(0);
    // Morto, o processo some quando o Node o recolhe: espera isso, sem prazo fixo.
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 15_000, interval: 50 });
    rmSync(temporaria, { recursive: true, force: true });
  }, 60_000);

  it("a dona fecha o download no meio: os ffmpeg são encerrados e a pasta temporária sai", async () => {
    const temporaria = mkdtempSync(path.join(os.tmpdir(), "wrw-audio-cancelar-"));
    const controle = new AbortController();
    // Uma resposta que nunca anda (a rede parada): o primeiro pedaço chega e nada mais é aceito.
    let chegou = false;
    const parada = new Writable({ highWaterMark: 1, write(_p, _c) { chegou = true; } });
    const pids: number[] = [];
    const longa = Array.from({ length: 40 }, (_, i) => parte(i, "mp3", "audio/mpeg", i * 3000, 3000));
    const conversao = converterPartes(longa, "mp3", parada, {
      lerParte: async chave => audio[chave], avisar: () => undefined, aoIniciar: pid => pids.push(pid), pastaTemporaria: temporaria, prioridade: 0,
    }, controle.signal);
    // O primeiro pedaço chega à resposta parada; sem prazo fixo, porque a máquina pode estar ocupada.
    await vi.waitFor(() => expect(chegou).toBe(true), { timeout: 30_000, interval: 50 });
    controle.abort();
    await expect(conversao).rejects.toMatchObject({ name: "AbortError" });
    expect(readdirSync(temporaria)).toEqual([]);
    // Morto, o processo some quando o Node o recolhe: espera isso, sem prazo fixo.
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 15_000, interval: 50 });
    rmSync(temporaria, { recursive: true, force: true });
  }, 60_000);

  it(`na produção, cada ffmpeg roda com nice ${PRIORIDADE_DO_FFMPEG}: abaixo do servidor, sem parar quando ele está ocupado`, async () => {
    expect(PRIORIDADE_DO_FFMPEG).toBe(10);
    // Só registra: baixar a prioridade de verdade deixaria o teste na fila da CPU numa máquina ocupada.
    const prioridades = vi.spyOn(os, "setPriority").mockImplementation(() => undefined);
    try {
      const pids: number[] = [];
      await converterPartes([parte(0, "webm", "audio/webm", 0, 1000)], "mp3", new Writable({ write(_p, _c, pronto) { pronto(); } }), {
        lerParte: async chave => audio[chave], avisar: () => undefined, aoIniciar: pid => pids.push(pid),
      }, new AbortController().signal);
      // O codificador e o decodificador da parte.
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(prioridades).toHaveBeenCalledWith(pid, PRIORIDADE_DO_FFMPEG);
      prioridades.mockClear();
      await converter([parte(0, "webm", "audio/webm", 0, 1000)]);
      // Com prioridade 0 (os testes do som), ninguém mexe na prioridade.
      expect(prioridades).not.toHaveBeenCalled();
    } finally {
      prioridades.mockRestore();
    }
  }, 60_000);

  it("sem nenhuma parte, nem começa", async () => {
    await expect(converter([])).rejects.toThrow("Nenhuma parte");
  });
});
