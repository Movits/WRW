import { describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs sem tipos (mesmo caso de server/cidades-montagem.test.ts)
import * as montagem from "../scripts/paises/montagem.mjs";

/**
 * As REGRAS da lista de países, provadas sem o dump do GeoNames.
 *
 * scripts/paises/montagem.mjs é puro de propósito: o teste lhe entrega linhas
 * escritas aqui, no formato do countryInfo.txt, e confere o que sai. Assim as
 * decisões que ninguém lembraria de conferir — descartar código extinto, não
 * repetir país, ordenar pelo código — ficam escritas em forma de exemplo.
 */

/** Uma linha do countryInfo.txt: 19 colunas separadas por tabulação. */
function linha(codigo: string, nome: string): string {
  const colunas = new Array(19).fill("");
  colunas[0] = codigo;
  colunas[4] = nome;
  return colunas.join("\t");
}

describe("lerLinhaDePais", () => {
  it("lê o código e o nome de uma linha de país", () => {
    expect(montagem.lerLinhaDePais(linha("BR", "Brazil"))).toEqual({
      codigo: "BR",
      nome: "Brazil",
    });
  });

  it("descarta comentário, linha vazia e cabeçalho", () => {
    expect(montagem.lerLinhaDePais("# comentário")).toBeNull();
    expect(montagem.lerLinhaDePais("")).toBeNull();
    expect(montagem.lerLinhaDePais("#ISO\tISO3\tISO-Numeric")).toBeNull();
  });

  it("descarta linha cuja primeira coluna não é código de duas letras", () => {
    expect(montagem.lerLinhaDePais(linha("BRA", "Brazil"))).toBeNull();
    expect(montagem.lerLinhaDePais(linha("b", "Brazil"))).toBeNull();
    expect(montagem.lerLinhaDePais(linha("12", "Brazil"))).toBeNull();
  });

  it("descarta país sem nome: sem nome não há como oferecer nem creditar", () => {
    expect(montagem.lerLinhaDePais(linha("ZZ", ""))).toBeNull();
  });
});

describe("montarListaDePaises", () => {
  it("devolve os países ordenados pelo código, para o diff ser estável", () => {
    const { paises } = montagem.montarListaDePaises([
      linha("PT", "Portugal"),
      linha("AO", "Angola"),
      linha("BR", "Brazil"),
    ]);
    expect(paises.map((p: { codigo: string }) => p.codigo)).toEqual([
      "AO",
      "BR",
      "PT",
    ]);
  });

  it("tira os códigos extintos, que o navegador resolveria pelo sucessor", () => {
    // O countryInfo.txt ainda lista CS (Sérvia e Montenegro) e AN (Antilhas
    // Holandesas). Intl.DisplayNames devolve "Sérvia" para CS e para RS: o
    // seletor mostraria o mesmo país duas vezes, e quem escolhesse o errado
    // gravaria um país que deixou de existir em 2006.
    const { paises, extintos } = montagem.montarListaDePaises([
      linha("CS", "Serbia and Montenegro"),
      linha("RS", "Serbia"),
      linha("AN", "Netherlands Antilles"),
      linha("CW", "Curaçao"),
    ]);
    expect(paises.map((p: { codigo: string }) => p.codigo)).toEqual([
      "CW",
      "RS",
    ]);
    expect(extintos).toEqual(["CS", "AN"]);
  });

  it("não repete país quando a fonte traz o código duas vezes", () => {
    const { paises } = montagem.montarListaDePaises([
      linha("BR", "Brazil"),
      linha("BR", "Brasil"),
    ]);
    expect(paises).toHaveLength(1);
    expect(paises[0].nome).toBe("Brazil");
  });

  it("relata o país que veio sem nome, em vez de sumir com ele", () => {
    const { paises, semNome } = montagem.montarListaDePaises([
      linha("BR", "Brazil"),
      linha("ZZ", ""),
    ]);
    expect(paises).toHaveLength(1);
    expect(semNome).toEqual(["ZZ"]);
  });
});

describe("montarModuloDePaises", () => {
  it("escreve o crédito da fonte como dado exportado, não como comentário", () => {
    const texto = montagem.montarModuloDePaises([
      { codigo: "BR", nome: "Brazil" },
    ]);
    expect(texto).toContain(
      `export const FONTE_DOS_PAISES = ${JSON.stringify(montagem.FONTE)};`
    );
    expect(texto).toContain(
      `export const FONTE_DOS_PAISES_URL = ${JSON.stringify(montagem.FONTE_URL)};`
    );
    expect(texto).toContain(`  ["BR", "Brazil"],`);
  });

  it("termina com quebra de linha, como o prettier exige", () => {
    const texto = montagem.montarModuloDePaises([
      { codigo: "BR", nome: "Brazil" },
    ]);
    expect(texto.endsWith("\n")).toBe(true);
  });
});
