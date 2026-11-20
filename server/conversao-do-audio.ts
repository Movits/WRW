import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { BITS_POR_SEGUNDO_DO_AUDIO, type FormatoDoAudio } from "@shared/baixar-audio";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { ObjetoAusenteNoStorageError } from "./storage";

/**
 * A conversão do áudio que a dona baixa (H8c): as partes da reunião, em
 * qualquer mistura de formatos (WebM/Opus do Chrome e do Android, MP4/AAC do
 * Safari e do iPhone, MP3 da importação, o WAV ou o OGG do envio único), viram
 * UM arquivo MP3 ou M4A, transmitido enquanto é feito, sem guardar o resultado.
 *
 * Como: um ffmpeg CODIFICADOR fica aberto a download inteiro e recebe áudio
 * cru (PCM de 16 bits, mono, 24 kHz) pela entrada; para cada parte, na ordem,
 * um ffmpeg DECODIFICADOR lê a parte e entrega o PCM. Áudio cru se emenda sem
 * costura, então a mistura de formatos não muda nada. A saída do codificador
 * vai direto para a resposta HTTP.
 *
 * - A parte vem do bucket pelo servidor (lerParte) e espera numa pasta
 *   temporária, apagada no fim: o MP4 com o índice (moov) no fim, como o de
 *   alguns gravadores, só se lê com saltos, que um cano não dá. Só uma parte por
 *   vez fica no disco (até 16 MB), e a seguinte é lida do bucket enquanto a
 *   atual decodifica.
 * - O tempo da reunião é o do player (inicioMs, o mesmo de gravacaoParaOuvir):
 *   quando falta um trecho (parte que não chegou, que falhou ou que o bucket
 *   não tem), entra silêncio no lugar, e os tempos da transcrição continuam
 *   batendo com o arquivo. Diferença de até 1 s não ganha silêncio, e nada é
 *   cortado.
 * - O MP3 sai em taxa constante e sem o quadro Xing (que o ffmpeg não consegue
 *   preencher numa saída que não volta atrás): o player calcula a duração pelo
 *   tamanho. O M4A sai fragmentado (um fragmento a cada 10 s), que é como um
 *   MP4 se escreve sem voltar atrás.
 *
 * O ffmpeg lê arquivo enviado pelas usuárias, então ele roda contido:
 * - só com o PATH no ambiente: o banco, as chaves do bucket, a do Gemini e o
 *   JWT_SECRET não descem para ele;
 * - com o servidor rodando como root (a imagem do Dockerfile), como o usuário
 *   nobody, que não lê o ambiente do processo do Node (/proc/1/environ);
 * - só com os formatos, os decodificadores e o protocolo de que o áudio da
 *   reunião precisa (uma "parte" que fosse uma lista HLS apontando para
 *   arquivos do servidor é recusada na abertura);
 * - com prioridade baixa (nice 10, PRIORIDADE_DO_FFMPEG): a instância tem 1 CPU,
 *   e o site responde primeiro. Não 19: com o Node ocupado, o nice 19 fica com
 *   ~1,5% da CPU, e um decodificador parado 60 s viraria silêncio no arquivo
 *   (o prazo abaixo); o nice 10 cede ~90% ao site e ainda anda;
 * - e com um prazo sem saída: decodificador que passa 60 s sem entregar nada,
 *   com a saída livre, é encerrado, e a parte vira silêncio.
 */

/** A taxa do áudio cru entre os dois ffmpeg, e do arquivo. */
export const AMOSTRAS_POR_SEGUNDO_DO_AUDIO = 24_000;
/** PCM de 16 bits, mono: 2 bytes por amostra. */
const BYTES_POR_SEGUNDO = AMOSTRAS_POR_SEGUNDO_DO_AUDIO * 2;
/** Diferença entre o tempo do player e o que já saiu, abaixo da qual não entra silêncio. */
export const FOLGA_ANTES_DO_SILENCIO_MS = 1_000;
/**
 * O arquivo nunca passa do teto da gravação em partes, com a mesma folga de
 * 10 min do servidor (FOLGA_DA_SOMA_DAS_PARTES_SEGUNDOS, em fatias-de-reuniao.ts):
 * um início de parte errado no banco não vira horas de silêncio.
 */
export const TETO_DO_ARQUIVO_SEGUNDOS = GRAVACAO_EM_PARTES_SEGUNDOS_MAX + 10 * 60;
/** A prioridade (nice) dos ffmpeg: abaixo do servidor, sem parar quando ele está ocupado. */
export const PRIORIDADE_DO_FFMPEG = 10;
/** O decodificador que passa este tempo sem entregar áudio, com a saída livre, travou. */
export const PRAZO_DO_DECODIFICADOR_SEM_SAIDA_MS = 60_000;

/** Uma parte do áudio, na ordem da reunião. A chave fica no servidor. */
export type ParteDoAudio = { seq: number; storageKey: string; mimeType: string; inicioMs: number; duracaoMs: number };

export type DependenciasDaConversao = {
  /** Os bytes de uma parte, lidos do bucket pelo servidor (nunca por URL entregue ao navegador). */
  lerParte: (storageKey: string) => Promise<Buffer>;
  /** O executável do ffmpeg; padrão, o do PATH. */
  ffmpeg?: string;
  /** Onde a parte espera o decodificador; padrão, a pasta temporária do sistema. */
  pastaTemporaria?: string;
  /** O log; padrão, console.error. */
  avisar?: (mensagem: string) => void;
  /** O prazo do decodificador sem saída; só os testes mudam. */
  prazoSemSaidaMs?: number;
  /** Cada ffmpeg que sobe (o pid), para os testes conferirem que nenhum fica para trás. */
  aoIniciar?: (pid: number) => void;
  /**
   * O nice dos ffmpeg; padrão, PRIORIDADE_DO_FFMPEG. Os testes que medem o som
   * passam 0: com a suíte inteira rodando em paralelo, o que eles provam é a
   * conversão, e não a fila da CPU.
   */
  prioridade?: number;
};

const EXTENSAO: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3",
};

/** Os demuxers que o áudio da reunião usa: WebM (matroska), MP4/M4A (mov), MP3, OGG, WAV e AAC cru. */
const FORMATOS_LIDOS = "matroska,mov,mp3,ogg,wav,aac";
/** Os decodificadores de áudio desses formatos. Vídeo de um MP4 do envio único fica de fora (só o áudio é lido). */
const DECODIFICADORES = [
  "opus", "libopus", "aac", "aac_fixed", "mp3float", "mp3", "vorbis", "libvorbis", "flac", "alac",
  "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le", "pcm_u8", "pcm_alaw", "pcm_mulaw",
].join(",");

/** O ffmpeg que lê uma parte e entrega PCM cru na saída. */
export function argumentosDoDecodificador(arquivo: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-protocol_whitelist", "file", "-format_whitelist", FORMATOS_LIDOS, "-codec_whitelist", DECODIFICADORES,
    "-i", arquivo,
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(AMOSTRAS_POR_SEGUNDO_DO_AUDIO), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ];
}

/** O ffmpeg que recebe o PCM de todas as partes e escreve o arquivo na saída. */
export function argumentosDoCodificador(formato: FormatoDoAudio): string[] {
  const entrada = [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", String(AMOSTRAS_POR_SEGUNDO_DO_AUDIO), "-ac", "1", "-i", "pipe:0",
  ];
  const taxa = `${BITS_POR_SEGUNDO_DO_AUDIO / 1000}k`;
  if (formato === "mp3") {
    return [...entrada, "-c:a", "libmp3lame", "-b:a", taxa, "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1"];
  }
  // O codificador AAC "fast": ~4x mais rápido que o padrão, e a fala soa igual a 64 kbps.
  return [
    ...entrada, "-c:a", "aac", "-aac_coder", "fast", "-b:a", taxa,
    "-movflags", "+empty_moov+default_base_moof", "-frag_duration", "10000000", "-f", "ipod", "pipe:1",
  ];
}

/**
 * O ambiente do ffmpeg: só o PATH (e, no Windows de desenvolvimento, o mínimo
 * para um programa subir). Nenhum segredo do servidor desce para o processo que
 * lê o áudio enviado pelas usuárias.
 */
export function ambienteDoFfmpeg(ambiente: NodeJS.ProcessEnv = process.env, plataforma: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const proprio: NodeJS.ProcessEnv = { PATH: ambiente.PATH ?? ambiente.Path ?? "/usr/local/bin:/usr/bin:/bin" };
  if (plataforma === "win32") {
    for (const nome of ["SystemRoot", "windir", "TEMP", "TMP"]) {
      const valor = ambiente[nome] ?? ambiente[nome.toUpperCase()];
      if (valor) proprio[nome] = valor;
    }
  }
  return proprio;
}

/** O usuário nobody da Debian (65534:65534), para quando o servidor roda como root. */
export function usuarioDoFfmpeg(
  getuid: (() => number) | undefined = process.getuid?.bind(process),
  plataforma: NodeJS.Platform = process.platform,
): { uid: number; gid: number } | null {
  if (plataforma === "win32" || !getuid) return null;
  return getuid() === 0 ? { uid: 65534, gid: 65534 } : null;
}

// O sistema que não deixa trocar de usuário (EPERM) responde igual a toda
// conversão: a primeira recusa basta, e as seguintes sobem sem a troca.
let trocaDeUsuarioRecusada = false;

type Processo = { filho: ChildProcess; fim: Promise<{ codigo: number | null; sinal: NodeJS.Signals | null }>; erros: () => string };

async function subir(executavel: string, args: string[], sinal: AbortSignal, usuario: { uid: number; gid: number } | null, prioridade: number): Promise<Processo> {
  const filho = spawn(executavel, args, {
    stdio: ["pipe", "pipe", "pipe"], env: ambienteDoFfmpeg(), windowsHide: true, signal: sinal, killSignal: "SIGKILL",
    ...(usuario ?? {}),
  });
  // Os fluxos do filho nunca podem emitir 'error' sem ouvinte: derrubariam o
  // servidor inteiro (o EPIPE de escrever num ffmpeg que já saiu, por exemplo).
  filho.stdin?.on("error", () => undefined);
  filho.stdout?.on("error", () => undefined);
  filho.stderr?.on("error", () => undefined);
  const fim = new Promise<{ codigo: number | null; sinal: NodeJS.Signals | null }>(resolver => {
    filho.once("close", (codigo, sinalDoFim) => resolver({ codigo, sinal: sinalDoFim }));
  });
  let textoDoErro = "";
  filho.stderr?.setEncoding("utf8");
  filho.stderr?.on("data", (pedaco: string) => { textoDoErro = (textoDoErro + pedaco).slice(-2000); });
  // Não subiu (sem o executável, sem permissão de trocar de usuário, já cancelado): lança aqui.
  await once(filho, "spawn");
  filho.on("error", () => undefined);
  try {
    if (prioridade) os.setPriority(filho.pid ?? 0, prioridade);
  } catch {
    // Sem permissão de baixar a prioridade, segue na normal.
  }
  return { filho, fim, erros: () => textoDoErro.trim() };
}

async function iniciarFfmpeg(executavel: string, args: string[], sinal: AbortSignal, deps: Pick<DependenciasDaConversao, "aoIniciar" | "prioridade"> & { avisar: (mensagem: string) => void }): Promise<Processo> {
  const prioridade = deps.prioridade ?? PRIORIDADE_DO_FFMPEG;
  const usuario = trocaDeUsuarioRecusada ? null : usuarioDoFfmpeg();
  let processo: Processo | null = null;
  if (usuario) {
    try {
      processo = await subir(executavel, args, sinal, usuario, prioridade);
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException | null)?.code !== "EPERM") throw erro;
      trocaDeUsuarioRecusada = true;
      deps.avisar("[Áudio] o sistema não deixou o ffmpeg rodar como nobody; ele segue sem trocar de usuário, ainda sem as variáveis do servidor.");
    }
  }
  processo ??= await subir(executavel, args, sinal, null, prioridade);
  if (processo.filho.pid) deps.aoIniciar?.(processo.filho.pid);
  return processo;
}

// 1 s de silêncio, reaproveitado em pedaços.
const SILENCIO = Buffer.alloc(BYTES_POR_SEGUNDO);

/** O ponto em bytes de PCM de um instante da reunião, sempre numa amostra inteira. */
function bytesDoInstante(ms: number): number {
  const bytes = Math.round((Math.max(0, ms) * BYTES_POR_SEGUNDO) / 1000);
  return bytes - (bytes % 2);
}

/**
 * Converte as partes, na ordem de `seq`, num arquivo `formato`, escrito em
 * `saida`. Resolve quando o arquivo inteiro foi escrito (quem chama termina a
 * resposta); lança se o codificador falhar, se o bucket falhar (fora o objeto
 * ausente, que vira silêncio) ou se `sinal` cancelar (a dona fechou o
 * download). Em qualquer saída, os ffmpeg são encerrados e a pasta temporária
 * sai. `saida` nunca é terminada aqui: no erro, quem chama a destrói, para o
 * navegador marcar o download como falho, e não como um arquivo completo.
 */
export async function converterPartes(
  partes: ParteDoAudio[], formato: FormatoDoAudio, saida: Writable, deps: DependenciasDaConversao, sinal: AbortSignal,
): Promise<void> {
  if (!partes.length) throw new Error("Nenhuma parte para converter.");
  const avisar = deps.avisar ?? (mensagem => console.error(mensagem));
  const executavel = deps.ffmpeg ?? "ffmpeg";
  const prazoSemSaida = deps.prazoSemSaidaMs ?? PRAZO_DO_DECODIFICADOR_SEM_SAIDA_MS;
  const ordenadas = [...partes].sort((a, b) => a.seq - b.seq);
  sinal.throwIfAborted();

  const vivos = new Set<ChildProcess>();
  const encerrarTodos = () => {
    for (const filho of Array.from(vivos)) if (filho.exitCode === null && filho.signalCode === null) filho.kill("SIGKILL");
  };
  sinal.addEventListener("abort", encerrarTodos, { once: true });
  const pasta = await mkdtemp(path.join(deps.pastaTemporaria ?? os.tmpdir(), "wrw-audio-"));
  try {
    // O nobody precisa atravessar a pasta para ler a parte pelo nome; listar, não.
    await chmod(pasta, 0o711).catch(() => undefined);

    const codificador = await iniciarFfmpeg(executavel, argumentosDoCodificador(formato), sinal, { avisar, aoIniciar: deps.aoIniciar, prioridade: deps.prioridade });
    vivos.add(codificador.filho);
    const saidaDoCodificador = codificador.filho.stdout!;
    const saidaTerminou = new Promise<void>((resolver, rejeitar) => {
      saidaDoCodificador.once("end", resolver);
      saidaDoCodificador.once("error", rejeitar);
    });
    saidaTerminou.catch(() => undefined);
    saidaDoCodificador.pipe(saida, { end: false });

    const entrada = codificador.filho.stdin!;
    const teto = bytesDoInstante(TETO_DO_ARQUIVO_SEGUNDOS * 1000);
    let escrito = 0;
    // O codificador que sai antes da hora não drena mais nada: a espera acaba com ele.
    const codificadorSaiu = codificador.fim.then(({ codigo, sinal: sinalDoFim }) => {
      throw new Error(`O codificador do áudio saiu antes da hora (${codigo ?? sinalDoFim}): ${codificador.erros().slice(0, 300)}`);
    });
    codificadorSaiu.catch(() => undefined);
    const escrever = async (pedaco: Buffer) => {
      escrito += pedaco.length;
      if (entrada.write(pedaco)) return;
      const dreno = once(entrada, "drain", { signal: sinal });
      dreno.catch(() => undefined);
      await Promise.race([dreno, codificadorSaiu]);
    };
    const preencherAte = async (alvo: number) => {
      let falta = Math.min(alvo, teto) - escrito;
      falta -= falta % 2;
      while (falta > 0) {
        const pedaco = Math.min(falta, SILENCIO.length);
        await escrever(SILENCIO.subarray(0, pedaco));
        falta -= pedaco;
      }
    };

    // A parte seguinte vem do bucket enquanto a atual decodifica. Objeto
    // ausente vira silêncio (o tempo do player cobre o trecho); qualquer outra
    // falha do bucket para o download, que a dona tenta de novo.
    const ler = (posicao: number): Promise<Buffer | null> => {
      const parte = ordenadas[posicao];
      const leitura = deps.lerParte(parte.storageKey).then(
        bytes => bytes,
        erro => {
          if (erro instanceof ObjetoAusenteNoStorageError) {
            avisar(`[Áudio] a parte ${parte.seq} não está no bucket; o trecho sai em silêncio.`);
            return null;
          }
          throw erro;
        },
      );
      // Ela pode esperar a vez enquanto o download é cancelado: sem rejeição solta.
      leitura.catch(() => undefined);
      return leitura;
    };
    let proxima: Promise<Buffer | null> | null = ler(0);

    for (let posicao = 0; posicao < ordenadas.length; posicao++) {
      sinal.throwIfAborted();
      const parte = ordenadas[posicao];
      const atual = proxima!;
      proxima = posicao + 1 < ordenadas.length ? ler(posicao + 1) : null;

      const alvo = bytesDoInstante(parte.inicioMs);
      if (alvo - escrito > bytesDoInstante(FOLGA_ANTES_DO_SILENCIO_MS)) await preencherAte(alvo);
      if (escrito >= teto) break;

      const bytes = await atual;
      sinal.throwIfAborted();
      if (!bytes) continue;

      const arquivo = path.join(pasta, `parte-${String(parte.seq).padStart(4, "0")}.${EXTENSAO[parte.mimeType] ?? "bin"}`);
      await writeFile(arquivo, bytes, { mode: 0o644 });
      const decodificador = await iniciarFfmpeg(executavel, argumentosDoDecodificador(arquivo), sinal, { avisar, aoIniciar: deps.aoIniciar, prioridade: deps.prioridade });
      vivos.add(decodificador.filho);
      let travou = false;
      let vigia: NodeJS.Timeout | undefined;
      const armar = () => {
        clearTimeout(vigia);
        vigia = setTimeout(() => { travou = true; decodificador.filho.kill("SIGKILL"); }, prazoSemSaida);
      };
      try {
        armar();
        for await (const pedaco of decodificador.filho.stdout! as AsyncIterable<Buffer>) {
          // Esperar a resposta andar (a rede da dona) não é travar: o prazo para.
          clearTimeout(vigia);
          const cabe = Math.min(pedaco.length, teto - escrito);
          if (cabe > 0) await escrever(cabe < pedaco.length ? pedaco.subarray(0, cabe) : pedaco);
          if (escrito >= teto) { decodificador.filho.kill("SIGKILL"); break; }
          armar();
        }
      } finally {
        clearTimeout(vigia);
      }
      const { codigo, sinal: sinalDoFim } = await decodificador.fim;
      vivos.delete(decodificador.filho);
      await rm(arquivo, { force: true }).catch(() => undefined);
      sinal.throwIfAborted();
      // A parte cortada no meio de uma amostra desalinharia todo o resto: um byte de silêncio realinha.
      if (escrito % 2) await escrever(SILENCIO.subarray(0, 1));
      if (travou) avisar(`[Áudio] a parte ${parte.seq} passou ${Math.round(prazoSemSaida / 1000)} s sem decodificar; o resto dela sai em silêncio.`);
      else if (codigo !== 0 && escrito < teto) {
        avisar(`[Áudio] a parte ${parte.seq} não decodificou inteira (saída ${codigo ?? sinalDoFim}): ${decodificador.erros().slice(0, 300)}`);
      }
      if (escrito >= teto) break;
    }

    entrada.end();
    const { codigo, sinal: sinalDoFim } = await codificador.fim;
    vivos.delete(codificador.filho);
    sinal.throwIfAborted();
    if (codigo !== 0) throw new Error(`O codificador do áudio saiu com ${codigo ?? sinalDoFim}: ${codificador.erros().slice(0, 300)}`);
    await saidaTerminou;
  } finally {
    sinal.removeEventListener("abort", encerrarTodos);
    encerrarTodos();
    await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
  }
}
