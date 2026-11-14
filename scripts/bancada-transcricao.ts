// Bancada A do gravador (G6, docs/arquitetura/gravador-de-reunioes.md, "As duas
// bancadas de teste"): transcreve as partes de um áudio de DESENVOLVIMENTO pelo
// mesmo caminho do servidor (server/transcricao-de-fatia.ts) e mede, parte a
// parte, o modelo que respondeu, o tempo, quantas falas e quais vozes saíram, e
// se a resposta veio cortada (MAX_TOKENS). É ela que escolhe o modelo de áudio.
//
// O áudio e a saída ficam FORA do repositório, que é público: o script recusa
// caminho de saída dentro dele. Não toca banco nem bucket; só fala com o Gemini,
// com a chave do arquivo de ambiente indicado (o valor nunca é impresso).
//
// As partes já vêm cortadas, uma por arquivo, na ordem (ex.: com o ffmpeg,
// `ffmpeg -i reuniao.m4a -f segment -segment_time 600 -c copy parte-%02d.m4a`).
//
// Uso:
//   npx tsx scripts/bancada-transcricao.ts --env <arquivo .env> --saida <arquivo .json fora do repo> [--idioma pt-BR] <parte1> <parte2> ...
//
// Os modelos vêm de LLM_AUDIO_MODEL e LLM_AUDIO_MODEL_RESERVA, com a mesma guarda
// do servidor; para comparar modelos, rode uma vez com cada valor.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opcao(nome: string): string | undefined {
  const i = args.indexOf(nome);
  if (i < 0) return undefined;
  const valor = args[i + 1];
  args.splice(i, 2);
  return valor;
}
const arquivoDeAmbiente = opcao("--env");
const saida = opcao("--saida");
const idioma = opcao("--idioma") ?? "pt-BR";
const partes = args;
if (!arquivoDeAmbiente || !saida || !partes.length) {
  console.error("Uso: npx tsx scripts/bancada-transcricao.ts --env <arquivo> --saida <arquivo .json fora do repo> [--idioma pt-BR] <parte1> <parte2> ...");
  process.exit(2);
}
const raizDoRepo = path.resolve(import.meta.dirname, "..");
const saidaAbsoluta = path.resolve(saida);
if (!path.relative(raizDoRepo, saidaAbsoluta).startsWith("..")) {
  console.error("A saída tem de ficar FORA do repositório (ele é público): a transcrição tem a fala de pessoas reais.");
  process.exit(2);
}
process.loadEnvFile(arquivoDeAmbiente);

const { transcreverFatia, contextoParaAProxima, montarTranscricao } = await import("../server/transcricao-de-fatia");
const { medirDuracaoDoAudio } = await import("../server/duracao-do-audio");
type Segmento = Awaited<ReturnType<typeof transcreverFatia>>["segmentos"][number];

const TIPOS: Record<string, string> = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".webm": "audio/webm" };

const resultado: Array<Record<string, unknown>> = [];
const fatias: Array<{ seq: number; inicioSegundos: number; duracaoSegundos: number; segmentos: Segmento[] }> = [];
let inicio = 0;
let anterior: ReturnType<typeof contextoParaAProxima> | undefined;
for (const [seq, arquivo] of partes.entries()) {
  const mimeType = TIPOS[path.extname(arquivo).toLowerCase()];
  if (!mimeType) throw new Error(`Formato não reconhecido: ${arquivo}`);
  const audio = fs.readFileSync(arquivo);
  const duracao = medirDuracaoDoAudio(audio) ?? 600;
  const comeco = Date.now();
  try {
    const { segmentos, modelo } = await transcreverFatia({ audio, mimeType, idioma, inicioSegundos: inicio, duracaoSegundos: duracao, anterior });
    const vozes = [...new Set(segmentos.map(s => s.falante))];
    console.log(`parte ${seq + 1}: ${modelo} · ${Math.round((Date.now() - comeco) / 1000)} s · ${segmentos.length} falas · vozes ${vozes.join(", ") || "nenhuma"}`);
    resultado.push({ parte: seq + 1, modelo, segundos: (Date.now() - comeco) / 1000, falas: segmentos.length, vozes });
    fatias.push({ seq, inicioSegundos: inicio, duracaoSegundos: duracao, segmentos });
    anterior = contextoParaAProxima(segmentos, anterior);
  } catch (erro) {
    const motivo = (erro as { motivo?: string }).motivo;
    console.log(`parte ${seq + 1}: FALHOU · ${motivo ?? (erro instanceof Error ? erro.message : String(erro))}`);
    resultado.push({ parte: seq + 1, falhou: motivo ?? (erro instanceof Error ? erro.message : String(erro)) });
  }
  inicio += duracao;
}
const transcricao = montarTranscricao(fatias, partes.length);
fs.writeFileSync(saidaAbsoluta, JSON.stringify({ medidas: resultado, ...transcricao }, null, 2));
console.log(`pronto: ${saidaAbsoluta} (${transcricao.segmentos.filter(s => s.lacuna).length} lacuna(s))`);
