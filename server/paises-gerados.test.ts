import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAISES_GERADOS, FONTE_DOS_PAISES, FONTE_DOS_PAISES_URL } from "@shared/paises-gerados";
// @ts-expect-error módulo .mjs sem tipos (mesmo caso de server/cidades-montagem.test.ts)
import * as montagem from "../scripts/paises/montagem.mjs";

/**
 * Confere o arquivo VERSIONADO shared/paises-gerados.ts, que alimenta os três
 * seletores de país.
 *
 * Por que isto existe: o arquivo é escrito por um comando que ninguém roda no
 * CI (`node scripts/gerar-paises.mjs`, que precisa do countryInfo.txt baixado à
 * parte), e arquivo gerado que alguém edita à mão "só para acrescentar um país"
 * deixa de ser gerado — na próxima regeração a edição some sem aviso.
 *
 * O dump NÃO está no repositório, então o teste não pode baixá-lo de novo. O que
 * ele faz é o RETORNO: monta o texto do módulo a partir da lista que o próprio
 * módulo exporta e compara com os bytes do arquivo. Se alguém acrescentar uma
 * linha à mão fora do formato do gerador, ou mexer no cabeçalho, ou deixar a
 * lista fora de ordem, a comparação acusa.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARQUIVO = path.join(RAIZ, "shared", "paises-gerados.ts");

/**
 * Quebra de linha normalizada antes de comparar: no Windows o git entrega o
 * arquivo com CRLF (`core.autocrlf`), enquanto o gerador escreve LF. Sem isto o
 * teste reprovaria na máquina de quem desenvolve e passaria no CI, que é o pior
 * dos dois mundos — e o que se quer provar aqui é o CONTEÚDO, não o final de
 * linha, que o git converte de propósito.
 */
const semCRLF = (texto: string) => texto.replace(/\r\n/g, "\n");

const texto = semCRLF(readFileSync(ARQUIVO, "utf8"));
const paises = PAISES_GERADOS.map(([codigo, nome]) => ({ codigo, nome }));

describe("shared/paises-gerados.ts", () => {
  it("é exatamente o que o gerador escreveria a partir desta lista", () => {
    expect(texto).toBe(semCRLF(montagem.montarModuloDePaises(paises)));
  });

  it("traz o mundo inteiro, e não um recorte", () => {
    // 250 = os 252 territórios do countryInfo.txt menos CS e AN, extintos.
    expect(PAISES_GERADOS.length).toBe(250);
  });

  it("tem só código ISO 3166-1 alfa-2, sem repetição e em ordem", () => {
    const codigos = PAISES_GERADOS.map(([codigo]) => codigo);
    expect(codigos.filter(c => !/^[A-Z]{2}$/.test(c))).toEqual([]);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect([...codigos].sort()).toEqual(codigos);
  });

  it("não traz código extinto, que apareceria duas vezes no seletor", () => {
    const codigos = new Set(PAISES_GERADOS.map(([codigo]) => codigo));
    for (const extinto of montagem.CODIGOS_EXTINTOS) {
      expect(codigos.has(extinto)).toBe(false);
    }
  });

  it("dá nome de reserva a todo país, para o seletor nunca ficar mudo", () => {
    expect(PAISES_GERADOS.filter(([, nome]) => !nome.trim())).toEqual([]);
  });

  it("carrega o crédito da fonte, que a CC BY 4.0 exige em tela", () => {
    expect(FONTE_DOS_PAISES).toContain("GeoNames");
    expect(FONTE_DOS_PAISES).toContain("CC BY 4.0");
    expect(FONTE_DOS_PAISES_URL).toMatch(/^https:\/\//);
  });

  it("tem os países que as listas escritas à mão não tinham", () => {
    // O defeito que originou este trabalho: as três telas ofereciam 17 ou 18
    // países. Quem morava em Angola, no Paraguai ou no Catar não se achava.
    const codigos = new Set(PAISES_GERADOS.map(([codigo]) => codigo));
    for (const codigo of ["AO", "PY", "QA", "MZ", "CV", "TL", "UY", "PE"]) {
      expect(codigos.has(codigo)).toBe(true);
    }
  });
});
