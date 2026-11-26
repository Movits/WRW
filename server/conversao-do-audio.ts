import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished, type Writable } from "node:stream";
import { BITS_POR_SEGUNDO_DO_AUDIO, type FormatoDoAudio } from "@shared/baixar-audio";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { ObjetoAusenteNoStorageError } from "./storage";

/**
 * A conversão do áudio que a dona baixa (H8c): as partes da reunião, em
 * qualquer mistura de formatos (WebM/Opus do Chrome e do Android, MP4/AAC do
 * Safari e do iPhone, MP3 da importação, o WAV ou o OGG do envio único, e o
 * FLAC e o AAC cru, em ADTS, que a importação em partes da H9b manda como
 * chegaram: todo tipo de TIPOS_DAS_PARTES, em fatias-de-reuniao.ts), viram
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
 *   nobody, que não lê o ambiente do processo do Node (/proc/1/environ). Se o
 *   sistema não deixar trocar de usuário, o ffmpeg NÃO sobe: como root, ele
 *   leria /proc/1/environ, e tirar as variáveis do ambiente dele não bastaria.
 *   A conferência (ffmpegDisponivel, em baixar-audio-da-reuniao.ts) sobe com o
 *   mesmo usuário, e a preparação recusa com AUDIO_INDISPONIVEL antes de auditar;
 * - só com os formatos, os decodificadores e o protocolo de que o áudio da
 *   reunião precisa (uma "parte" que fosse uma lista HLS apontando para
 *   arquivos do servidor é recusada na abertura);
 * - com prioridade baixa (nice 10, PRIORIDADE_DO_FFMPEG): a instância tem 1 CPU,
 *   e o site responde primeiro. Não 19: com o Node ocupado, o nice 19 fica com
 *   ~1,5% da CPU, e um decodificador parado 60 s viraria silêncio no arquivo
 *   (o prazo abaixo); o nice 10 cede ~90% ao site e ainda anda;
 * - e com um prazo sem saída: decodificador que passa 60 s sem entregar nada,
 *   com a saída livre, é encerrado, e a parte vira silêncio.
 *
 * O arquivo que sairia só com silêncio (nenhuma parte decodificou: todas fora
 * da lista de decodificadores, estragadas ou fora do bucket) não sai: a
 * conversão lança, e a rota corta a conexão, para o navegador marcar o
 * download como falho em vez de guardar um arquivo mudo como se fosse a reunião.
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
  /** O usuário dos ffmpeg; padrão, usuarioDoFfmpeg() (o nobody, com o servidor como root). Só os testes mudam. */
  usuario?: { uid: number; gid: number } | null;
  /** O spawn do node:child_process; só os testes trocam (o ffmpeg de mentira, a troca de usuário recusada). */
  spawn?: typeof spawn;
  /** O teto do arquivo, em segundos; padrão, TETO_DO_ARQUIVO_SEGUNDOS. Só os testes mudam. */
  tetoDoArquivoSegundos?: number;
};

const EXTENSAO: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/mpeg": "mp3",
};

/** Os demuxers que o áudio da reunião usa: WebM (matroska), MP4/M4A (mov), MP3, OGG, WAV, AAC cru e FLAC. */
const FORMATOS_LIDOS = "matroska,mov,mp3,ogg,wav,aac,flac";
/**
 * Os decodificadores de todo áudio que entra numa reunião, por codec e não por
 * tipo: dentro do mesmo audio/mpeg vem o MP3 e também o MP2 e o MP1 (o corte
 * do MP3 e a medida do servidor aceitam as três camadas); no WAV do envio único,
 * o ADPCM e o GSM (o servidor mede pelo cabeçalho); no MP4 e no WebM do envio
 * único, o que o contêiner trouxer (o AC-3, o PCM do QuickTime). Codec que a
 * reunião aceita e que falta aqui sai em silêncio no arquivo baixado.
 * Vídeo de um MP4 do envio único fica de fora (só o áudio é lido).
 */
const DECODIFICADORES = [
  "opus", "libopus", "aac", "aac_fixed", "mp3float", "mp3", "mp2float", "mp2", "mp1float", "mp1",
  "vorbis", "libvorbis", "flac", "alac", "ac3", "ac3_fixed", "eac3",
  "adpcm_ms", "adpcm_ima_wav", "gsm_ms",
  "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_s32le", "pcm_s32be", "pcm_f32le", "pcm_f32be", "pcm_f64le", "pcm_f64be",
  "pcm_u8", "pcm_s8", "pcm_alaw", "pcm_mulaw",
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

type Processo = { filho: ChildProcess; fim: Promise<{ codigo: number | null; sinal: NodeJS.Signals | null }>; erros: () => string };

type ComoSubir = { spawn: typeof spawn; usuario: { uid: number; gid: number } | null; prioridade: number };

async function subir(executavel: string, args: string[], sinal: AbortSignal, como: ComoSubir): Promise<Processo> {
  // Já cancelado, nem sobe: o spawn com o sinal cancelado emite o 'spawn' e, logo
  // atrás, o AbortError, que chegaria depois de o once() abaixo soltar o ouvinte dele.
  sinal.throwIfAborted();
  const filho = como.spawn(executavel, args, {
    stdio: ["pipe", "pipe", "pipe"], env: ambienteDoFfmpeg(), windowsHide: true, signal: sinal, killSignal: "SIGKILL",
    ...(como.usuario ?? {}),
  });
  // O filho e os fluxos dele nunca podem emitir 'error' sem ouvinte: derrubariam
  // o servidor inteiro (o AbortError do cancelamento logo depois de subir, o
  // EPIPE de escrever num ffmpeg que já saiu). O ouvinte entra já, antes de
  // qualquer espera; o once() abaixo liga o dele e ainda rejeita a subida que falha.
  filho.on("error", () => undefined);
  filho.stdin?.on("error", () => undefined);
  filho.stdout?.on("error", () => undefined);
  filho.stderr?.on("error", () => undefined);
  const fim = new Promise<{ codigo: number | null; sinal: NodeJS.Signals | null }>(resolver => {
    filho.once("close", (codigo, sinalDoFim) => resolver({ codigo, sinal: sinalDoFim }));
  });
  let textoDoErro = "";
  filho.stderr?.setEncoding("utf8");
  filho.stderr?.on("data", (pedaco: string) => { textoDoErro = (textoDoErro + pedaco).slice(-2000); });
  // Não subiu (sem o executável, sem permissão de trocar de usuário): lança aqui.
  await once(filho, "spawn");
  try {
    // Sem o pid, nada: setPriority(0) mudaria a prioridade do próprio servidor.
    if (como.prioridade && filho.pid) os.setPriority(filho.pid, como.prioridade);
  } catch {
    // Sem permissão de baixar a prioridade, segue na normal.
  }
  return { filho, fim, erros: () => textoDoErro.trim() };
}

/** O sistema recusou a troca de usuário (EPERM sem a capacidade; EINVAL no namespace sem o 65534). */
export function ehTrocaDeUsuarioRecusada(erro: unknown): boolean {
  const codigo = (erro as NodeJS.ErrnoException | null)?.code;
  return codigo === "EPERM" || codigo === "EINVAL";
}

async function iniciarFfmpeg(
  executavel: string, args: string[], sinal: AbortSignal,
  deps: Pick<DependenciasDaConversao, "aoIniciar" | "prioridade" | "usuario" | "spawn"> & { avisar: (mensagem: string) => void },
): Promise<Processo> {
  const usuario = deps.usuario === undefined ? usuarioDoFfmpeg() : deps.usuario;
  let processo: Processo;
  try {
    processo = await subir(executavel, args, sinal, { spawn: deps.spawn ?? spawn, usuario, prioridade: deps.prioridade ?? PRIORIDADE_DO_FFMPEG });
  } catch (erro) {
    // Sem a troca, não há recuo: como root, o ffmpeg leria o ambiente do servidor em /proc/1/environ.
    if (usuario && ehTrocaDeUsuarioRecusada(erro)) {
      deps.avisar("[Áudio] o sistema não deixou o ffmpeg rodar como nobody: ele não sobe como root, e o áudio não é convertido.");
    }
    throw erro;
  }
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

/** O prazo como a pessoa lê no log: em segundos, ou em milissegundos abaixo de 1 s (os testes). */
const prazoNoLog = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/**
 * Converte as partes, na ordem de `seq`, num arquivo `formato`, escrito em
 * `saida`. Resolve quando o arquivo inteiro foi escrito (quem chama termina a
 * resposta); lança se o codificador falhar, se o bucket falhar (fora o objeto
 * ausente, que vira silêncio), se nenhuma parte decodificar (o arquivo seria só
 * silêncio), se `sinal` cancelar (a dona fechou o download) ou se `saida`
 * fechar antes do fim (escrever num destino morto pararia o cano para sempre).
 * Em qualquer saída, os ffmpeg são encerrados e a pasta temporária sai. `saida`
 * nunca é terminada aqui: no erro, quem chama a destrói, para o navegador
 * marcar o download como falho, e não como um arquivo completo.
 */
export async function converterPartes(
  partes: ParteDoAudio[], formato: FormatoDoAudio, saida: Writable, deps: DependenciasDaConversao, sinalDeFora: AbortSignal,
): Promise<void> {
  if (!partes.length) throw new Error("Nenhuma parte para converter.");
  const avisar = deps.avisar ?? (mensagem => console.error(mensagem));
  const executavel = deps.ffmpeg ?? "ffmpeg";
  const prazoSemSaida = deps.prazoSemSaidaMs ?? PRAZO_DO_DECODIFICADOR_SEM_SAIDA_MS;
  const ordenadas = [...partes].sort((a, b) => a.seq - b.seq);
  const comoSubir = { avisar, aoIniciar: deps.aoIniciar, prioridade: deps.prioridade, usuario: deps.usuario, spawn: deps.spawn };
  sinalDeFora.throwIfAborted();
  if (saida.destroyed) throw new DOMException("A saída do áudio já estava fechada.", "AbortError");

  // O cancelamento de quem chama e o fim antes da hora da saída param a conversão do mesmo jeito.
  const controle = new AbortController();
  const sinal = controle.signal;
  const cancelarPorFora = () => controle.abort(sinalDeFora.reason);
  sinalDeFora.addEventListener("abort", cancelarPorFora, { once: true });
  const pararDeVigiarASaida = finished(saida, () => {
    if (!sinal.aborted) controle.abort(new DOMException("A saída do áudio fechou antes do fim.", "AbortError"));
  });

  // Os ffmpeg vivos e a promessa do fim de cada um.
  const vivos = new Map<ChildProcess, Promise<unknown>>();
  const encerrarTodos = () => {
    for (const filho of Array.from(vivos.keys())) if (filho.exitCode === null && filho.signalCode === null) filho.kill("SIGKILL");
  };
  sinal.addEventListener("abort", encerrarTodos, { once: true });
  let pasta: string | null = null;
  try {
    pasta = await mkdtemp(path.join(deps.pastaTemporaria ?? os.tmpdir(), "wrw-audio-"));
    // O nobody precisa atravessar a pasta para ler a parte pelo nome; listar, não.
    await chmod(pasta, 0o711).catch(() => undefined);

    const codificador = await iniciarFfmpeg(executavel, argumentosDoCodificador(formato), sinal, comoSubir);
    vivos.set(codificador.filho, codificador.fim);
    const saidaDoCodificador = codificador.filho.stdout!;
    const saidaTerminou = new Promise<void>((resolver, rejeitar) => {
      saidaDoCodificador.once("end", resolver);
      saidaDoCodificador.once("error", rejeitar);
    });
    saidaTerminou.catch(() => undefined);
    saidaDoCodificador.pipe(saida, { end: false });

    const entrada = codificador.filho.stdin!;
    const teto = bytesDoInstante((deps.tetoDoArquivoSegundos ?? TETO_DO_ARQUIVO_SEGUNDOS) * 1000);
    let escrito = 0;
    // As partes que entregaram áudio: sem nenhuma, o arquivo seria só silêncio.
    let decodificadas = 0;
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
      const decodificador = await iniciarFfmpeg(executavel, argumentosDoDecodificador(arquivo), sinal, comoSubir);
      vivos.set(decodificador.filho, decodificador.fim);
      let travou = false;
      let entregou = 0;
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
          entregou += pedaco.length;
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
      if (entregou > 0) decodificadas++;
      // A parte cortada no meio de uma amostra desalinharia todo o resto: um byte de silêncio realinha.
      if (escrito % 2) await escrever(SILENCIO.subarray(0, 1));
      if (travou) avisar(`[Áudio] a parte ${parte.seq} passou ${prazoNoLog(prazoSemSaida)} sem decodificar; o resto dela sai em silêncio.`);
      else if (codigo !== 0 && escrito < teto) {
        avisar(`[Áudio] a parte ${parte.seq} não decodificou inteira (saída ${codigo ?? sinalDoFim}): ${decodificador.erros().slice(0, 300)}`);
      }
      if (escrito >= teto) break;
    }

    // Nenhuma parte entregou áudio: o arquivo seria só silêncio, ou vazio. Lançar
    // antes de fechar a entrada do codificador faz a rota cortar a conexão, e o
    // navegador marca o download como falho, em vez de guardá-lo como a reunião.
    if (!decodificadas) throw new Error(`Nenhuma das ${ordenadas.length} partes do áudio decodificou; o arquivo sairia só com silêncio.`);
    entrada.end();
    const { codigo, sinal: sinalDoFim } = await codificador.fim;
    vivos.delete(codificador.filho);
    sinal.throwIfAborted();
    if (codigo !== 0) throw new Error(`O codificador do áudio saiu com ${codigo ?? sinalDoFim}: ${codificador.erros().slice(0, 300)}`);
    await saidaTerminou;
  } finally {
    sinalDeFora.removeEventListener("abort", cancelarPorFora);
    pararDeVigiarASaida();
    sinal.removeEventListener("abort", encerrarTodos);
    encerrarTodos();
    // A pasta sai depois que os ffmpeg encerrados saem (no Windows de
    // desenvolvimento, o arquivo aberto por um deles segura a pasta), com um
    // prazo. O que sobrou na saída deles é descartado: um cano parado (a
    // resposta que não anda) seguraria o fim do processo.
    for (const filho of Array.from(vivos.keys())) {
      filho.stdout?.unpipe();
      filho.stdout?.resume();
    }
    await esperarNoMaximo(Promise.all(Array.from(vivos.values())), PRAZO_PARA_OS_FFMPEG_SAIREM_MS);
    if (pasta) await rm(pasta, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

/** Quanto a limpeza espera os ffmpeg encerrados saírem antes de apagar a pasta. */
const PRAZO_PARA_OS_FFMPEG_SAIREM_MS = 5_000;

/** Espera a promessa, mas não mais que `ms` (sem segurar o processo com o relógio). */
async function esperarNoMaximo(promessa: Promise<unknown>, ms: number): Promise<void> {
  let relogio: NodeJS.Timeout | undefined;
  const prazo = new Promise<void>(resolver => { relogio = setTimeout(resolver, ms); relogio.unref?.(); });
  try {
    await Promise.race([promessa.then(() => undefined, () => undefined), prazo]);
  } finally {
    clearTimeout(relogio);
  }
}

/** O tamanho máximo do MP3 do resumo (H19b): 20 min a 64 kbps é ~9,6 MB. */
export const MP3_DO_RESUMO_MAX_BYTES = 16 * 1024 * 1024;
/** O prazo do ffmpeg que codifica o áudio do resumo. */
export const PRAZO_DO_MP3_DO_RESUMO_MS = 120_000;

/** O ffmpeg que recebe o PCM da voz do Gemini, na taxa dele, e escreve o MP3 (a taxa do arquivo é a do áudio da reunião). */
export function argumentosDoMp3DaVoz(amostrasPorSegundo: number): string[] {
  const taxa = `${BITS_POR_SEGUNDO_DO_AUDIO / 1000}k`;
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", String(amostrasPorSegundo), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libmp3lame", "-b:a", taxa, "-ar", String(AMOSTRAS_POR_SEGUNDO_DO_AUDIO), "-id3v2_version", "0", "-f", "mp3", "pipe:1",
  ];
}

/**
 * O áudio do resumo com a voz do Gemini (H19b, server/resumo-em-audio.ts): o
 * PCM cru que o modelo de voz devolve (o mesmo PCM de 16 bits mono que este
 * módulo emenda) vira MP3 pelo mesmo ffmpeg contido (só o PATH no ambiente,
 * como nobody com o servidor como root, prioridade baixa). O texto é nosso, e
 * não arquivo de usuária, mas o caminho é o mesmo. Devolve o MP3 inteiro: o
 * arquivo é pequeno e vai ao bucket. Lança se o ffmpeg falhar, passar do prazo
 * ou do tamanho.
 */
export async function codificarVozEmMp3(
  pcm: Buffer, amostrasPorSegundo: number,
  deps: Pick<DependenciasDaConversao, "ffmpeg" | "avisar" | "aoIniciar" | "prioridade" | "usuario" | "spawn"> & { prazoMs?: number } = {},
): Promise<Buffer> {
  if (!pcm.length) throw new Error("Sem áudio para codificar.");
  const avisar = deps.avisar ?? (mensagem => console.error(mensagem));
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(new Error("O ffmpeg passou do prazo do áudio do resumo.")), deps.prazoMs ?? PRAZO_DO_MP3_DO_RESUMO_MS);
  try {
    const processo = await iniciarFfmpeg(deps.ffmpeg ?? "ffmpeg", argumentosDoMp3DaVoz(amostrasPorSegundo), controle.signal, {
      avisar, aoIniciar: deps.aoIniciar, prioridade: deps.prioridade, usuario: deps.usuario, spawn: deps.spawn,
    });
    const pedacos: Buffer[] = [];
    let total = 0;
    processo.filho.stdout?.on("data", (pedaco: Buffer) => {
      total += pedaco.length;
      if (total > MP3_DO_RESUMO_MAX_BYTES) controle.abort(new Error("O MP3 do resumo passou do tamanho máximo."));
      else pedacos.push(pedaco);
    });
    processo.filho.stdin?.end(pcm);
    const { codigo, sinal } = await processo.fim;
    if (controle.signal.aborted) throw controle.signal.reason instanceof Error ? controle.signal.reason : new Error("O ffmpeg foi interrompido.");
    if (codigo !== 0) throw new Error(`O ffmpeg saiu com ${codigo ?? sinal}: ${processo.erros().slice(0, 300)}`);
    const mp3 = Buffer.concat(pedacos);
    if (!mp3.length) throw new Error("O ffmpeg não escreveu o MP3.");
    return mp3;
  } finally {
    clearTimeout(prazo);
  }
}

/** O prazo do ffmpeg que converte a parte de um codec que o Gemini não lista (12 min de áudio). */
export const PRAZO_DA_PARTE_CONVERTIDA_MS = 120_000;
/** O MP3 da parte convertida nunca passa disto: 12 min a 64 kbps são ~5,8 MB. */
export const PARTE_CONVERTIDA_MAX_BYTES = 16 * 1024 * 1024;

/** O ffmpeg que lê a parte do arquivo e escreve o MP3 (mono, 24 kHz, a taxa do áudio baixado), no máximo `segundos`. */
export function argumentosDaParteEmMp3(arquivo: string, segundos: number): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-protocol_whitelist", "file", "-format_whitelist", FORMATOS_LIDOS, "-codec_whitelist", DECODIFICADORES,
    "-i", arquivo,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(segundos),
    "-ac", "1", "-ar", String(AMOSTRAS_POR_SEGUNDO_DO_AUDIO),
    "-c:a", "libmp3lame", "-b:a", `${BITS_POR_SEGUNDO_DO_AUDIO / 1000}k`, "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1",
  ];
}

/**
 * A parte de um codec que o Gemini não lista, em MP3 (G14, parte 2): o recuo do
 * corte manda inteiro, como uma parte só, o arquivo curto que o corte do
 * navegador reconhece mas não lê (o ALAC do Gravador do iPhone, o AC-3, o
 * Vorbis no WebM), e a rota das partes o converte antes de guardar
 * (server/fatias-de-reuniao.ts, precisaConverterParaOGemini). Assim a fila
 * manda ao Gemini um tipo da lista dele, e o player da tela, o "Baixar o
 * áudio" e o reprocesso leem um MP3.
 *
 * O mesmo ffmpeg contido do "Baixar o áudio" (só o PATH no ambiente, como
 * nobody com o servidor como root, prioridade baixa, só os formatos e os
 * decodificadores do áudio da reunião), com o arquivo numa pasta temporária
 * (o MP4 com o índice no fim só se lê com saltos), apagada no fim. Lança se o
 * ffmpeg não subir, falhar, passar do prazo ou do tamanho, ou não escrever nada.
 */
export async function converterParteEmMp3(
  bytes: Buffer, mimeType: string, segundosNoMaximo: number,
  deps: Pick<DependenciasDaConversao, "ffmpeg" | "pastaTemporaria" | "avisar" | "aoIniciar" | "prioridade" | "usuario" | "spawn"> & { prazoMs?: number } = {},
): Promise<Buffer> {
  if (!bytes.length) throw new Error("Sem áudio para converter.");
  const avisar = deps.avisar ?? (mensagem => console.error(mensagem));
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(new Error("O ffmpeg passou do prazo da parte convertida.")), deps.prazoMs ?? PRAZO_DA_PARTE_CONVERTIDA_MS);
  let pasta: string | null = null;
  let processo: Processo | null = null;
  try {
    pasta = await mkdtemp(path.join(deps.pastaTemporaria ?? os.tmpdir(), "wrw-parte-"));
    await chmod(pasta, 0o711).catch(() => undefined);
    const arquivo = path.join(pasta, `parte.${EXTENSAO[mimeType] ?? "bin"}`);
    await writeFile(arquivo, bytes, { mode: 0o644 });
    processo = await iniciarFfmpeg(deps.ffmpeg ?? "ffmpeg", argumentosDaParteEmMp3(arquivo, Math.ceil(segundosNoMaximo)), controle.signal, {
      avisar, aoIniciar: deps.aoIniciar, prioridade: deps.prioridade, usuario: deps.usuario, spawn: deps.spawn,
    });
    const pedacos: Buffer[] = [];
    let total = 0;
    processo.filho.stdout?.on("data", (pedaco: Buffer) => {
      total += pedaco.length;
      if (total > PARTE_CONVERTIDA_MAX_BYTES) controle.abort(new Error("O MP3 da parte passou do tamanho máximo."));
      else pedacos.push(pedaco);
    });
    const { codigo, sinal } = await processo.fim;
    if (controle.signal.aborted) throw controle.signal.reason instanceof Error ? controle.signal.reason : new Error("O ffmpeg foi interrompido.");
    if (codigo !== 0) throw new Error(`O ffmpeg saiu com ${codigo ?? sinal}: ${processo.erros().slice(0, 300)}`);
    const mp3 = Buffer.concat(pedacos);
    if (!mp3.length) throw new Error("O ffmpeg não escreveu o MP3 da parte.");
    return mp3;
  } finally {
    clearTimeout(prazo);
    if (processo && processo.filho.exitCode === null && processo.filho.signalCode === null) {
      processo.filho.kill("SIGKILL");
      await esperarNoMaximo(processo.fim, PRAZO_PARA_OS_FFMPEG_SAIREM_MS);
    }
    if (pasta) await rm(pasta, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}
