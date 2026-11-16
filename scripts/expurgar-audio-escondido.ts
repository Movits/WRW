// Expurgo único do áudio de reunião que o DELETE antigo só ESCONDEU no bucket.
//
// Até a retenção do áudio (novembro de 2026), o áudio de reunião saía do bucket
// por storageDelete: no B2, que guarda versões, esse DELETE sem VersionId só põe
// um marcador de exclusão por cima, e a versão com a voz das participantes
// continua guardada e cobrada. As linhas do banco que apontavam para esses
// objetos já saíram (exclusão da reunião ou da conta, leitura da gravação
// vencida), então a varredura das gravações (limparGravacoesVencidas) não os
// alcança: só listando o bucket.
//
// O script lista, SÓ sob meetings/ (áudio de reunião, e nada além), as chaves
// cuja versão mais recente é um marcador de exclusão
// (storageListarChavesEscondidas, em server/storage.ts) e, com --apagar, tira
// cada uma com todas as versões, pela mesma função do servidor
// (storageApagarTodasAsVersoes). Antes de apagar cada chave, confere de novo que
// ela continua escondida: a que voltou a ficar visível é pulada. Sem --apagar só
// lista: é o ensaio. Seguro repetir: sem nada escondido, não faz nada.
//
// A alternativa sem código é a regra de ciclo de vida do B2 no prefixo meetings/
// ("Keep only the last version", que apaga a versão escondida depois de 1 dia).
// Qualquer uma das duas basta; registre no cartão qual foi feita e quando.
// Pelo cartão F11 do Notion, o bucket inteiro passou a "Keep only the last
// version" em 15/09/2026 (o print do painel ainda falta). Se a regra vale, o
// ensaio só acha o que foi escondido nas últimas ~24 h, e o --apagar não é
// necessário.
//
// Requer Node 20.12 ou mais (process.loadEnvFile).
//
// PRODUÇÃO SÓ COM O ROBERTO (CLAUDE.md da raiz), inclusive o ensaio: o bucket de
// produção é o Backblaze B2 do Render. As variáveis STORAGE_* vêm do arquivo de
// --env, obrigatório (os valores nunca são impressos); a que já estiver no
// ambiente vale no lugar da do arquivo. A chave precisa de listFiles e
// deleteFiles. Quem roda é a pessoa, no terminal dela.
//
// Uso (da raiz do repositório):
//   npx tsx scripts/expurgar-audio-escondido.ts --env <arquivo>            ensaio: só lista
//   npx tsx scripts/expurgar-audio-escondido.ts --env <arquivo> --apagar   apaga as versões
//
// Saída: 0 deu certo (no ensaio, mesmo com chaves a apagar); 1 alguma chave não
// saiu; 2 argumento inválido, arquivo de --env ausente, storage sem
// configuração ou falha ao listar.

import { existsSync } from "node:fs";

const PREFIXO = "meetings/";
const USO = "Uso: npx tsx scripts/expurgar-audio-escondido.ts --env <arquivo> [--apagar]";

const args = process.argv.slice(2);
const posicaoDoEnv = args.indexOf("--env");
const arquivoDeAmbiente = posicaoDoEnv >= 0 ? args[posicaoDoEnv + 1] : undefined;
const apagar = args.includes("--apagar");
const conhecidos = new Set(["--env", "--apagar", ...(arquivoDeAmbiente ? [arquivoDeAmbiente] : [])]);
const desconhecidos = args.filter(arg => !conhecidos.has(arg));
if (!arquivoDeAmbiente || arquivoDeAmbiente.startsWith("--") || desconhecidos.length) {
  console.error(USO);
  if (desconhecidos.length) console.error(`Argumento desconhecido: ${desconhecidos.join(" ")}`);
  process.exit(2);
}
if (!existsSync(arquivoDeAmbiente)) {
  console.error(`Arquivo de --env não encontrado: ${arquivoDeAmbiente}`);
  process.exit(2);
}
process.loadEnvFile(arquivoDeAmbiente);

const { storageApagarTodasAsVersoes, storageListarChavesEscondidas } = await import("../server/storage");
const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));

let chaves: string[];
try {
  chaves = await storageListarChavesEscondidas(PREFIXO);
} catch (erro) {
  console.error(`Não foi possível listar as versões sob ${PREFIXO}:`, mensagem(erro));
  process.exit(2);
}

console.log(`${chaves.length} chave(s) escondida(s) sob ${PREFIXO} (a versão mais recente é um marcador de exclusão).`);
for (const chave of chaves) console.log(`  ${chave}`);
if (!apagar) {
  console.log(chaves.length ? "Ensaio: nada foi apagado. Para tirar as versões, rode de novo com --apagar." : "Nada a apagar.");
  process.exit(0);
}

let sairam = 0;
let puladas = 0;
let ficaram = 0;
for (const [posicao, chave] of chaves.entries()) {
  const ordem = `[${posicao + 1}/${chaves.length}]`;
  try {
    // A conferência de novo, na hora: listar pela chave exata (o prefixo também
    // traz quem só começa igual) e só seguir se ela ainda está escondida.
    if (!(await storageListarChavesEscondidas(chave)).includes(chave)) {
      puladas += 1;
      console.log(`  ${ordem} pulada (já não está escondida): ${chave}`);
      continue;
    }
    await storageApagarTodasAsVersoes(chave);
    sairam += 1;
    console.log(`  ${ordem} saiu: ${chave}`);
  } catch (erro) {
    ficaram += 1;
    console.error(`  ${ordem} FICOU: ${chave}`, mensagem(erro));
  }
}
console.log(`${sairam} saíram, ${puladas} puladas, ${ficaram} ficaram.`);
process.exit(ficaram ? 1 : 0);
