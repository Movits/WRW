#!/usr/bin/env node
/**
 * N7 — gera a fixture dos vetores do gabarito da rede com armadilhas, para o teste do critério semântico estreito
 * rodar SEM rede (server/rede-com-armadilhas.test.ts).
 *
 * Só manda à API do Gemini os RÓTULOS FICTÍCIOS de scripts/rede-de-teste/rede-com-armadilhas.json (nenhum dado real).
 * Mesmo modelo, tarefa e dimensão do motor (server/gemini.ts: gemini-embedding-001, SEMANTIC_SIMILARITY, 768), numa
 * chamada só de batchEmbedContents (1 requisição da cota, perto de 90 textos curtos).
 *
 * Não lê o .env: a chave vem do ambiente do processo (LLM_API_KEY ou GOOGLE_API_KEY). No Git Bash:
 *   node --env-file=.env scripts/rede-de-teste/gerar-embeddings-da-rede.mjs
 * Grava scripts/rede-de-teste/embeddings-da-rede.json: cada vetor normalizado e quantizado em int8 (base64), com a
 * escala dele. Depois, rode o teste e leia a "Calibração" que ele imprime:
 *   corepack pnpm vitest run server/rede-com-armadilhas.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const MODELO = "gemini-embedding-001";
const TAREFA = "SEMANTIC_SIMILARITY";
const DIMENSOES = 768;

const chave = process.env.LLM_API_KEY || process.env.GOOGLE_API_KEY;
if (!chave) {
  console.error("Sem LLM_API_KEY (ou GOOGLE_API_KEY) no ambiente. Rode com: node --env-file=.env scripts/rede-de-teste/gerar-embeddings-da-rede.mjs");
  process.exit(1);
}

const rede = JSON.parse(fs.readFileSync(path.join(aqui, "rede-com-armadilhas.json"), "utf8"));
const textos = Array.from(new Set(rede.pares.flatMap(par => [par.oferta.rotulo, par.procura.rotulo]))).sort();

const resposta = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:batchEmbedContents`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
  body: JSON.stringify({
    requests: textos.map(text => ({ model: `models/${MODELO}`, taskType: TAREFA, outputDimensionality: DIMENSOES, content: { parts: [{ text }] } })),
  }),
});
if (!resposta.ok) {
  console.error(`O Gemini respondeu HTTP ${resposta.status}. Nada foi gravado.`);
  process.exit(1);
}
const { embeddings } = await resposta.json();
if (!Array.isArray(embeddings) || embeddings.length !== textos.length || embeddings.some(e => e?.values?.length !== DIMENSOES)) {
  console.error("O Gemini não devolveu um vetor de 768 dimensões por texto. Nada foi gravado.");
  process.exit(1);
}

const vetores = {};
textos.forEach((texto, i) => {
  const v = embeddings[i].values;
  const norma = Math.hypot(...v) || 1;
  const normal = v.map(x => x / norma);
  const escala = Math.max(...normal.map(Math.abs)) / 127 || 1;
  const int8 = Int8Array.from(normal.map(x => Math.round(x / escala)));
  vetores[texto] = { escala, int8: Buffer.from(int8.buffer).toString("base64") };
});

const destino = path.join(aqui, "embeddings-da-rede.json");
fs.writeFileSync(destino, `${JSON.stringify({ modelo: MODELO, tarefa: TAREFA, dimensoes: DIMENSOES, geradoEm: new Date().toISOString().slice(0, 10), vetores }, null, 1)}\n`);
console.log(`${textos.length} vetores gravados em ${path.relative(process.cwd(), destino)}.`);
