import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TipoDaParte } from "@/lib/corte-comum";
import { cortarArquivo } from "@/lib/corte-do-arquivo";
import { SEM_PAUSAS } from "@/lib/pausas-do-corte";
import { leitorDe } from "@/test/audio-sintetico";
import { montar } from "@/test/conferir-partes";
import { AMOSTRAS_POR_SEGUNDO_DO_AUDIO, argumentosDoDecodificador } from "./conversao-do-audio";

/**
 * A emenda das partes da importação cai na pausa da fala (conferência de tela
 * do pacote 4b), com arquivos de CODIFICADOR DE VERDADE. No WAV importado, o
 * corte de 14 MB caía a cada 2:46 onde estivesse, e a frase que atravessava a
 * emenda sumia da transcrição ("A local photographer offered to help at a
 * discount." virou "A local").
 *
 * O ffmpeg gera, em cada formato, uma "fala" sintética (nenhuma gravação real):
 * trechos de 1,3 s de uma voz de harmônicos de 150 Hz com vibrato e um pouco de
 * ruído (o sopro), separados por pausas de 0,5 s com ruído de sala a −60 dBFS
 * (ou em silêncio digital, como a voz sintetizada, no Vorbis, que só acha essa
 * pausa). Com partes de 4 s, o teto cai sempre no
 * meio de um trecho de fala (4 s, 7,35 s e 10,95 s), e a pausa anterior está
 * dentro da janela (um quarto da parte). Cada emenda tem de cair numa pausa: a
 * tela diz onde pelas durações, e o decodificador do "Baixar o áudio" confirma
 * que o fim de cada parte e o começo da seguinte são a pausa, e não a fala. O
 * mesmo arquivo cortado sem procurar a pausa (o corte de antes) emenda no meio
 * da fala.
 *
 * Sem o ffmpeg na máquina, o bloco se pula; no CI (CI=true) ele é obrigatório.
 */

const SEGUNDOS = 14;
const POR_PARTE = 4;
const FALA_MS = 1300;
const PERIODO_MS = 1800;
/** A voz: os harmônicos de 150 Hz (até 1.200 Hz) com vibrato de 4 Hz, e o sopro (ruído a −34 dBFS). */
const VOZ = [[1, 1], [2, 0.6], [3, 0.4], [4, 0.3], [6, 0.2], [8, 0.15]]
  .map(([k, a]) => `${a}*sin(2*PI*${150 * k}*t+${3 * k}*sin(2*PI*4*t))`).join("+");
/** A "fala": a voz por 1,3 s a cada 1,8 s; no resto, o ruído de sala a −60 dBFS ou o silêncio digital. */
const FALA = (taxa: number, pausa: "ruido" | "silencio") => ["-f", "lavfi", "-i",
  `aevalsrc=exprs='if(lt(mod(t,${PERIODO_MS / 1000}),${FALA_MS / 1000}),0.1*(${VOZ})+0.02*(2*random(0)-1),${pausa === "ruido" ? "0.001*(2*random(0)-1)" : "0"})':s=${taxa}:d=${SEGUNDOS}`];
const RUIDO = (taxa = 44100) => FALA(taxa, "ruido");

type Caso = { nome: string; arquivo: string; args: string[]; codificador: string; tipo: TipoDaParte };

const CASOS: Caso[] = [
  { nome: "o WAV", arquivo: "fala.wav", args: [...RUIDO(), "-c:a", "pcm_s16le"], codificador: "pcm_s16le", tipo: "audio/wav" },
  { nome: "o MP3 de taxa constante", arquivo: "fala.mp3", args: [...RUIDO(), "-c:a", "libmp3lame", "-b:a", "64k"], codificador: "libmp3lame", tipo: "audio/mpeg" },
  { nome: "o FLAC", arquivo: "fala.flac", args: [...RUIDO(), "-c:a", "flac"], codificador: "flac", tipo: "audio/flac" },
  { nome: "o AAC em ADTS", arquivo: "fala.aac", args: [...RUIDO(), "-c:a", "aac", "-b:a", "96k", "-f", "adts"], codificador: "aac", tipo: "audio/aac" },
  { nome: "o M4A", arquivo: "fala.m4a", args: [...RUIDO(), "-c:a", "aac", "-b:a", "96k"], codificador: "aac", tipo: "audio/mp4" },
  { nome: "o MKV com AAC", arquivo: "fala.mkv", args: [...RUIDO(), "-c:a", "aac", "-b:a", "96k"], codificador: "aac", tipo: "audio/mp4" },
  // O Opus de voz (o do WhatsApp): modo SILK, com a marca de atividade de voz.
  // O Ogg só corta entre páginas: páginas de 200 ms (o padrão do ffmpeg é 1 s).
  { nome: "o Ogg Opus de voz (SILK)", arquivo: "fala.ogg", args: [...RUIDO(16000), "-c:a", "libopus", "-b:a", "16k", "-application", "voip", "-page_duration", "200000"], codificador: "libopus", tipo: "audio/ogg" },
  { nome: "o WebM com Opus de voz (SILK)", arquivo: "fala.webm", args: [...RUIDO(16000), "-c:a", "libopus", "-b:a", "16k", "-application", "voip"], codificador: "libopus", tipo: "audio/ogg" },
  // O Vorbis não traz o passo do quantizador à mão: só a pausa em silêncio digital (a da voz sintetizada).
  // O Opus em modo CELT (o da música) também não, e o codificador ainda gasta uns 400 ms depois da fala
  // antes de marcar o silêncio: a pausa de 0,5 s não chega a virar pausa nele (lib/pausas-do-corte.ts).
  { nome: "o Ogg Vorbis, pausa em silêncio digital", arquivo: "fala-vorbis.ogg", args: [...FALA(44100, "silencio"), "-c:a", "libvorbis", "-page_duration", "200000"], codificador: "libvorbis", tipo: "audio/ogg" },
];

const EXTENSAO: Record<TipoDaParte, string> = {
  "audio/mpeg": "mp3", "audio/aac": "aac", "audio/wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a",
};

const codificadores = (() => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
})();
const temCodificador = (nome: string) => new RegExp(`\\s${nome}\\s`).test(codificadores);
const comFfmpeg = codificadores !== "" || process.env.CI === "true";

/** O volume (RMS) do PCM de 16 bits, mono, a 24 kHz, entre dois instantes (s). */
function volume(pcm: Buffer, de: number, ate: number): number {
  const inicio = Math.max(0, Math.round(de * AMOSTRAS_POR_SEGUNDO_DO_AUDIO));
  const fim = Math.min(pcm.length / 2, Math.round(ate * AMOSTRAS_POR_SEGUNDO_DO_AUDIO));
  if (fim <= inicio) return 0;
  let soma = 0;
  for (let i = inicio; i < fim; i++) { const v = pcm.readInt16LE(i * 2); soma += v * v; }
  return Math.sqrt(soma / (fim - inicio));
}

/** Onde cada emenda cai, em ms do arquivo (a soma das partes antes dela). */
const emendas = (duracoes: number[]) => duracoes.slice(0, -1).map((_, i) => duracoes.slice(0, i + 1).reduce((s, d) => s + d, 0));
/** A emenda cai na pausa (com 50 ms de folga para o atraso do codificador), e não na fala. */
const naPausa = (ms: number) => { const fase = ms % PERIODO_MS; return fase >= FALA_MS + 50 && fase <= PERIODO_MS - 50; };

describe.skipIf(!comFfmpeg)("o corte da importação emenda as partes na pausa da fala (codificador de verdade)", () => {
  let pasta = "";
  beforeAll(() => { pasta = mkdtempSync(path.join(os.tmpdir(), "wrw-corte-na-pausa-")); });
  afterAll(() => { if (pasta) rmSync(pasta, { recursive: true, force: true }); });

  it.each(CASOS)("$nome", async caso => {
    if (!temCodificador(caso.codificador) && process.env.CI !== "true") return;
    expect(temCodificador(caso.codificador)).toBe(true);
    const origem = path.join(pasta, caso.arquivo);
    const gerado = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...caso.args, origem], { encoding: "utf8" });
    if (gerado.status !== 0) throw new Error(`o ffmpeg não gerou ${caso.arquivo}: ${gerado.stderr}`);
    const bytes = new Uint8Array(readFileSync(origem));

    // O corte de antes (sem procurar a pausa) emenda no meio da fala: é o defeito.
    const deAntes = await cortarArquivo(leitorDe(bytes), bytes.length, { segundosPorParte: POR_PARTE, pausas: SEM_PAUSAS });
    if (!deAntes.ok) throw new Error(`o corte recusou ${caso.arquivo}: ${deAntes.codigo}`);
    expect(emendas(deAntes.partes.map(p => p.duracaoMs)).some(naPausa), "o corte de antes já caía na pausa: o arquivo do teste não prova nada").toBe(false);

    const corte = await cortarArquivo(leitorDe(bytes), bytes.length, { segundosPorParte: POR_PARTE });
    if (!corte.ok) throw new Error(`o corte recusou ${caso.arquivo}: ${corte.codigo}`);
    expect(corte.mimeType).toBe(caso.tipo);
    const duracoes = corte.partes.map(p => p.duracaoMs);
    expect(duracoes.every(d => d <= POR_PARTE * 1000)).toBe(true);
    // Nada some nem se repete: as partes somam o arquivo inteiro.
    expect(Math.abs(duracoes.reduce((s, d) => s + d, 0) - corte.duracaoMs)).toBeLessThanOrEqual(corte.partes.length);
    const ondeEmenda = emendas(duracoes);
    expect(ondeEmenda.length).toBeGreaterThanOrEqual(3);
    expect(ondeEmenda.filter(ms => !naPausa(ms)), `emendas fora da pausa (ms): ${ondeEmenda.join(", ")}`).toEqual([]);

    // O decodificador do download confirma: cada parte termina na pausa, e a seguinte começa nela.
    const pcms = corte.partes.map((parte, i) => {
      const arquivoDaParte = path.join(pasta, `${caso.arquivo}.parte-${i}.${EXTENSAO[caso.tipo]}`);
      writeFileSync(arquivoDaParte, Buffer.from(montar(bytes, parte)));
      const decodificado = spawnSync("ffmpeg", argumentosDoDecodificador(arquivoDaParte), { maxBuffer: 64 * 1024 * 1024 });
      expect(decodificado.status, `o decodificador da parte ${i}: ${String(decodificado.stderr).slice(0, 300)}`).toBe(0);
      return decodificado.stdout as Buffer;
    });
    const fala = volume(pcms[0], 0.2, 1.1);
    expect(fala).toBeGreaterThan(2000);
    for (let i = 0; i + 1 < pcms.length; i++) {
      const fimDaParte = pcms[i].length / 2 / AMOSTRAS_POR_SEGUNDO_DO_AUDIO;
      expect(volume(pcms[i], fimDaParte - 0.08, fimDaParte), `o fim da parte ${i}`).toBeLessThan(fala / 10);
      expect(volume(pcms[i + 1], 0.03, 0.1), `o começo da parte ${i + 1}`).toBeLessThan(fala / 10);
    }
  }, 60_000);
});
