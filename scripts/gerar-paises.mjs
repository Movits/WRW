// Gera shared/paises-gerados.ts, a lista de países dos seletores de país do
// cadastro e do perfil (a nova oportunidade ainda tem a lista própria).
//
// POR QUE UM GERADOR: as três telas traziam a MESMA lista escrita à mão, cada
// uma com um recorte diferente (17, 18 e 18 países, duas sem África do Sul e
// Nigéria, uma com "Outro" e as outras não). Quem morava em Angola, no Paraguai
// ou no Catar não achava o próprio país. A lista agora sai da mesma fonte das
// cidades — o GeoNames — e o nome de cada país é TRADUZIDO pelo navegador
// (`Intl.DisplayNames`), então não há 250 países × 10 idiomas de texto para
// alguém manter à mão. Ver shared/paises.ts e docs/arquitetura/cidades.md.
//
// AS REGRAS NÃO ESTÃO AQUI: estão em scripts/paises/montagem.mjs, um módulo puro
// que o teste carrega sem precisar do dump (mesmo desenho de
// scripts/cidades/montagem.mjs). Este arquivo é só a parte que toca disco.
//
// LICENÇA: GeoNames é CC BY 4.0 — uso comercial liberado, CRÉDITO VISÍVEL
// OBRIGATÓRIO. O crédito viaja dentro do módulo gerado (FONTE_DOS_PAISES e
// FONTE_DOS_PAISES_URL) e a tela o mostra embaixo do seletor.
//
// USO:
//   node scripts/gerar-paises.mjs --entrada ~/geonames
//   node scripts/gerar-paises.mjs --entrada ~/geonames --simular
//
// Baixe antes (é um .txt de 31 KB, sem zip):
//   https://download.geonames.org/export/dump/countryInfo.txt
//
// Rode a partir da raiz do repositório. Não precisa de banco nem de .env.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { montarListaDePaises, montarModuloDePaises } from "./paises/montagem.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESTINO = path.join(RAIZ, "shared", "paises-gerados.ts");

/**
 * Menos países que isto só acontece com dump truncado ou com o formato do
 * countryInfo.txt mudando de coluna. Sem esta trava, um download pela metade
 * viraria um seletor de país com dez opções e ninguém perceberia até uma
 * usuária reclamar.
 */
const MINIMO_ACEITAVEL = 200;

function argumento(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const entrada = argumento("--entrada");
const simular = process.argv.includes("--simular");

if (!entrada) {
  console.error("Falta --entrada <pasta com countryInfo.txt>. Veja o cabeçalho deste arquivo.");
  process.exit(1);
}

const arquivo = path.join(entrada, "countryInfo.txt");
if (!existsSync(arquivo)) {
  console.error(`Não achei ${arquivo}.`);
  console.error("Baixe de https://download.geonames.org/export/dump/countryInfo.txt");
  process.exit(1);
}

const { paises, extintos, semNome } = montarListaDePaises(
  readFileSync(arquivo, "utf8").split(/\r?\n/)
);

if (paises.length < MINIMO_ACEITAVEL) {
  console.error(
    `Só ${paises.length} países saíram de ${path.basename(arquivo)}; o dump parece truncado. Nada foi escrito.`
  );
  process.exit(1);
}

console.log(`${paises.length} países.`);
if (extintos.length) console.log(`Fora, por não existirem mais: ${extintos.join(", ")}.`);
if (semNome.length) console.log(`Fora, por virem sem nome na fonte: ${semNome.join(", ")}.`);

const texto = montarModuloDePaises(paises);

if (simular) {
  console.log(`\n--simular: ${path.relative(RAIZ, DESTINO)} não foi escrito (${texto.length} caracteres).`);
} else {
  writeFileSync(DESTINO, texto, "utf8");
  console.log(`\nEscrito ${path.relative(RAIZ, DESTINO)} (${Math.round(texto.length / 1024)} KB).`);
}
