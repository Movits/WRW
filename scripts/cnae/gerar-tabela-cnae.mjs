#!/usr/bin/env node
/**
 * Gera server/cnae/cnae-2-3.json, a tabela enxuta da CNAE 2.3 que a base das
 * associações usa para transformar o código da empresa em "o que tem" (N4,
 * docs/arquitetura/entidades.md, seção 2). Não lê banco nem .env.
 *
 * Fonte: a API de Serviços de Dados do IBGE (CONCLA), as três listas abaixo,
 * baixadas antes à mão (o script não acessa a rede):
 *   https://servicodados.ibge.gov.br/api/v2/cnae/subclasses
 *   https://servicodados.ibge.gov.br/api/v2/cnae/divisoes
 *   https://servicodados.ibge.gov.br/api/v2/cnae/secoes
 *
 * Uso (da raiz do repositório):
 *   node scripts/cnae/gerar-tabela-cnae.mjs <pasta com subclasses.json, divisoes.json e secoes.json> <AAAA-MM-DD da consulta>
 *
 * O texto oficial vem em maiúsculas; aqui ele passa a frase comum (só a
 * primeira letra maiúscula), com as siglas oficiais preservadas. Nenhuma
 * palavra é trocada: a tabela "revisada" com termos simples (a IA rascunha,
 * uma pessoa revisa) é outra camada, ainda por fazer (docs/arquitetura/entidades.md, seção 4).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [pasta, consultadoEm] = process.argv.slice(2);
if (!pasta || !/^\d{4}-\d{2}-\d{2}$/.test(consultadoEm ?? "")) {
  console.error("Uso: node scripts/cnae/gerar-tabela-cnae.mjs <pasta> <AAAA-MM-DD>");
  process.exit(1);
}

const ler = nome => JSON.parse(readFileSync(join(pasta, nome), "utf8"));
const subclasses = ler("subclasses.json");
const divisoes = ler("divisoes.json");
const secoes = ler("secoes.json");

/** Siglas que o texto oficial usa e que a frase comum não pode baixar. */
const SIGLAS = { cds: "CDs", dvds: "DVDs", glp: "GLP", scm: "SCM", stfc: "STFC", srtt: "SRTT", voip: "VoIP", "t.r.r.": "T.R.R." };

function fraseComum(oficial) {
  let texto = oficial.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  texto = texto.replace(/t\.r\.r\./g, SIGLAS["t.r.r."]);
  texto = texto.replace(/\p{L}+/gu, palavra => SIGLAS[palavra] ?? palavra);
  return texto.charAt(0).toLocaleUpperCase("pt-BR") + texto.slice(1);
}

const ordenar = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
const tabela = {
  fonte: "IBGE, Comissão Nacional de Classificação (CONCLA): CNAE 2.3, API de Serviços de Dados v2 (servicodados.ibge.gov.br/api/v2/cnae)",
  versao: "CNAE 2.3",
  consultadoEm,
  secoes: ordenar(Object.fromEntries(secoes.map(s => [s.id, fraseComum(s.descricao)]))),
  divisoes: ordenar(Object.fromEntries(divisoes.map(d => [d.id, fraseComum(d.descricao)]))),
  subclasses: ordenar(Object.fromEntries(subclasses.map(s => [s.id, fraseComum(s.descricao)]))),
};
if (Object.keys(tabela.subclasses).length !== subclasses.length) {
  console.error("Código de subclasse repetido na fonte.");
  process.exit(1);
}
const destino = join("server", "cnae", "cnae-2-3.json");
writeFileSync(destino, JSON.stringify(tabela, null, 0).replace(/,"/g, ',\n"') + "\n");
console.log(`${destino}: ${Object.keys(tabela.secoes).length} seções, ${Object.keys(tabela.divisoes).length} divisões, ${subclasses.length} subclasses.`);
