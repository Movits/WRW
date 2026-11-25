import { describe, expect, it } from "vitest";
import {
  FORMATO_DO_TOKEN_DE_ATIVACAO, VALIDADE_DA_ATIVACAO_MS, itensConfirmados, planilhaDeLinks,
} from "../shared/entidades";

/**
 * As funções puras da ativação do cadastro importado (N3): o que a pessoa
 * confirma (só o que veio da entidade) e a planilha dos links que a entidade
 * baixa (aspas, ponto e vírgula e fórmula neutralizada).
 */
describe("itensConfirmados", () => {
  it("fica só com o que estava na importação, sem repetir, na ordem da importação", () => {
    expect(itensConfirmados(["Café torrado", "Frete", "Mel"], ["Mel", "Inventado", "Café torrado", "Mel"])).toEqual(["Café torrado", "Mel"]);
  });
  it("nada escolhido, nada entra; espaço nas pontas não muda o item", () => {
    expect(itensConfirmados(["Café"], [])).toEqual([]);
    expect(itensConfirmados([" Café "], ["Café"])).toEqual(["Café"]);
  });
});

describe("planilhaDeLinks", () => {
  const cabecalho: [string, string, string, string, string] = ["codigo", "nome", "referencia", "link", "valido_ate"];
  it("aspas em toda célula, aspas dobradas, quebra de linha vira espaço e fórmula vira texto", () => {
    const csv = planilhaDeLinks([
      { codigo: "NW-AB12CD", nome: 'Empresa "Um"\nfilial', referencia: "=HYPERLINK(1)", link: "https://x/ativar/t", validoAte: "25/12/2026" },
      { codigo: null, nome: "+55 11", referencia: null, link: "https://x/ativar/u", validoAte: "25/12/2026" },
    ], cabecalho);
    const linhas = csv.split("\r\n");
    expect(linhas[0]).toBe('"codigo";"nome";"referencia";"link";"valido_ate"');
    expect(linhas[1]).toBe('"NW-AB12CD";"Empresa ""Um"" filial";"\'=HYPERLINK(1)";"https://x/ativar/t";"25/12/2026"');
    expect(linhas[2]).toBe('"";"\'+55 11";"";"https://x/ativar/u";"25/12/2026"');
    expect(linhas[3]).toBe("");
  });
});

describe("constantes", () => {
  it("o link vale 30 dias e o token tem o formato do convite (24 bytes em base64url)", () => {
    expect(VALIDADE_DA_ATIVACAO_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(FORMATO_DO_TOKEN_DE_ATIVACAO.test("a".repeat(32))).toBe(true);
    expect(FORMATO_DO_TOKEN_DE_ATIVACAO.test("a/b".repeat(10))).toBe(false);
  });
});
