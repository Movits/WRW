import { describe, expect, it } from "vitest";
import type { ArquivoDeCidades } from "@shared/cidade";
import brasil from "@/data/cidades/BR.json";
import monaco from "@/data/cidades/MC.json";
import {
  deduzirEstado,
  estadosDoPais,
  paisPedeEstado,
  sugerirCidades,
  sugerirPaises,
} from "./cascata-de-local";

const BR = brasil as unknown as ArquivoDeCidades;
const MC = monaco as unknown as ArquivoDeCidades;

describe("cascata-de-local", () => {
  it("o Brasil pede o estado; Mônaco vai direto à cidade", () => {
    expect(paisPedeEstado(BR)).toBe(true);
    expect(paisPedeEstado(MC)).toBe(false);
    expect(paisPedeEstado(null)).toBe(false);
  });

  it("lista as 27 UFs pelo nome, em ordem alfabética do idioma", () => {
    const ufs = estadosDoPais(BR, "pt-BR");
    expect(ufs).toHaveLength(27);
    expect(ufs[0]).toEqual({ valor: "AC", rotulo: "Acre" });
    expect(ufs.map(u => u.rotulo)).toContain("São Paulo");
  });

  it("dentro do estado só aparecem cidades dele, e o campo vazio já mostra as primeiras", () => {
    const daBahia = sugerirCidades(BR, "BA", "");
    expect(daBahia.length).toBeGreaterThan(0);
    expect(
      sugerirCidades(BR, "BA", "bom jesus").map(c => c.valor)
    ).not.toContain("Bom Jesus");
    expect(sugerirCidades(BR, "PI", "bom jesus").map(c => c.rotulo)).toContain(
      "Bom Jesus"
    );
  });

  it("sem estado, num país que pede estado, a divisão entra no rótulo", () => {
    const rotulos = sugerirCidades(BR, "", "bom jesus").map(c => c.rotulo);
    expect(rotulos).toContain("Bom Jesus (PI)");
    expect(rotulos).toContain("Bom Jesus (RS)");
  });

  it("deduz o estado só quando a cidade gravada é única", () => {
    expect(deduzirEstado(BR, "Xique-Xique")).toBe("BA");
    expect(deduzirEstado(BR, "xique xique")).toBe("BA");
    // "Bom Jesus" existe em mais de uma UF: chutar mostraria o estado errado.
    expect(deduzirEstado(BR, "Bom Jesus")).toBe("");
    expect(deduzirEstado(BR, "Cidade Inventada")).toBe("");
  });

  it("o país se acha no idioma da tela, em inglês e pelo código, e o Outro fica por último", () => {
    expect(sugerirPaises("pt-BR", "Outro", "alema")[0]).toEqual({
      valor: "DE",
      rotulo: "Alemanha",
    });
    expect(sugerirPaises("pt-BR", "Outro", "germany")[0].valor).toBe("DE");
    expect(sugerirPaises("ja", "その他", "ドイツ")[0].valor).toBe("DE");
    const todos = sugerirPaises("pt-BR", "Outro", "");
    expect(todos.at(-1)).toEqual({ valor: "XX", rotulo: "Outro" });
  });
});
