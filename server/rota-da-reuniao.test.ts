import { describe, expect, it } from "vitest";
import { rotaDaReuniao } from "@shared/rotas";

/**
 * rotaDaReuniao(id, { t, q, item }) (H4c): o endereço do detalhe com o ponto
 * em que a tela abre. Sem opções, é o de sempre: a lista, o gravador e a
 * Memória continuam montando o mesmo link.
 */
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const ITEM = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const parametros = (url: string) => new URLSearchParams(url.split("?")[1] ?? "");

describe("rotaDaReuniao", () => {
  it("sem opções, o endereço de sempre, com o id codificado", () => {
    expect(rotaDaReuniao(ID)).toBe(`/meetings/${ID}`);
    expect(rotaDaReuniao("a/b c")).toBe("/meetings/a%2Fb%20c");
    expect(rotaDaReuniao(ID, {})).toBe(`/meetings/${ID}`);
  });

  it("t, q e item vão na busca, e a tela os lê de volta iguais (o termo com espaço e acento)", () => {
    const url = rotaDaReuniao(ID, { t: 754.5, q: "  contrato de frete à vista ", item: ITEM });
    expect(url.startsWith(`/meetings/${ID}?`)).toBe(true);
    const lidos = parametros(url);
    expect(Number(lidos.get("t"))).toBe(754.5);
    expect(lidos.get("q")).toBe("contrato de frete à vista");
    expect(lidos.get("item")).toBe(ITEM);
  });

  it("cada opção vale sozinha", () => {
    expect(rotaDaReuniao(ID, { item: ITEM })).toBe(`/meetings/${ID}?item=${ITEM}`);
    expect(rotaDaReuniao(ID, { t: 90 })).toBe(`/meetings/${ID}?t=90`);
    expect(parametros(rotaDaReuniao(ID, { q: "a&b=c" })).get("q")).toBe("a&b=c");
  });

  it("t que a tela não usaria (0, negativo, não finito) e termo vazio ficam de fora", () => {
    expect(rotaDaReuniao(ID, { t: 0 })).toBe(`/meetings/${ID}`);
    expect(rotaDaReuniao(ID, { t: -5 })).toBe(`/meetings/${ID}`);
    expect(rotaDaReuniao(ID, { t: Number.NaN })).toBe(`/meetings/${ID}`);
    expect(rotaDaReuniao(ID, { t: Number.POSITIVE_INFINITY })).toBe(`/meetings/${ID}`);
    expect(rotaDaReuniao(ID, { q: "   ", item: "" })).toBe(`/meetings/${ID}`);
  });
});
