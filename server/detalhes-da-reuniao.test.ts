import { describe, expect, it } from "vitest";
import {
  chaveDaEtiqueta, ETIQUETA_MAX, ETIQUETAS_POR_REUNIAO_MAX, ehRecusaDosDetalhes, etiquetasDaDona, etiquetasDaReuniao,
  normalizarEtiquetas, normalizarOndeFoi, ONDE_FOI_MAX, RECUSAS_DOS_DETALHES,
} from "@shared/detalhes-da-reuniao";

/**
 * Os detalhes da reunião (H7c): a mesma normalização na tela e no servidor.
 * Funções puras de shared/detalhes-da-reuniao.ts.
 */
describe("normalizarEtiquetas", () => {
  it("tira espaços sobrando, vazias e repetidas sem caixa, e guarda a primeira grafia na ordem em que vieram", () => {
    expect(normalizarEtiquetas(["  Clientes ", "mentoria", "CLIENTES", "", "   ", "Exportação\n de  café"]))
      .toEqual(["Clientes", "mentoria", "Exportação de café"]);
  });

  it("corta cada etiqueta em ETIQUETA_MAX letras, sem partir emoji ao meio", () => {
    const longa = "a".repeat(ETIQUETA_MAX + 5);
    expect(normalizarEtiquetas([longa])).toEqual(["a".repeat(ETIQUETA_MAX)]);
    const comEmoji = "🚀".repeat(ETIQUETA_MAX + 2);
    const [cortada] = normalizarEtiquetas([comEmoji])!;
    expect(Array.from(cortada)).toHaveLength(ETIQUETA_MAX);
    expect(cortada).toBe("🚀".repeat(ETIQUETA_MAX));
  });

  it("fica com no máximo ETIQUETAS_POR_REUNIAO_MAX", () => {
    const muitas = Array.from({ length: ETIQUETAS_POR_REUNIAO_MAX + 4 }, (_, i) => `e${i}`);
    expect(normalizarEtiquetas(muitas)).toHaveLength(ETIQUETAS_POR_REUNIAO_MAX);
  });

  it("lista vazia, nula ou só com lixo vira null (a coluna nula é 'sem etiqueta')", () => {
    expect(normalizarEtiquetas([])).toBeNull();
    expect(normalizarEtiquetas(null)).toBeNull();
    expect(normalizarEtiquetas(undefined)).toBeNull();
    expect(normalizarEtiquetas([" ", 3, null, {}])).toBeNull();
  });
});

describe("etiquetasDaReuniao (a leitura do banco)", () => {
  it("o que não é lista de textos vira lista vazia, nunca erro", () => {
    expect(etiquetasDaReuniao(null)).toEqual([]);
    expect(etiquetasDaReuniao("Clientes")).toEqual([]);
    expect(etiquetasDaReuniao({ a: 1 })).toEqual([]);
    expect(etiquetasDaReuniao(["Clientes", 2, "clientes"])).toEqual(["Clientes"]);
  });
});

describe("normalizarOndeFoi", () => {
  it("tira espaços sobrando e corta em ONDE_FOI_MAX; vazio vira null", () => {
    expect(normalizarOndeFoi("  Escritório \n da Ana ")).toBe("Escritório da Ana");
    expect(normalizarOndeFoi("x".repeat(ONDE_FOI_MAX + 10))).toHaveLength(ONDE_FOI_MAX);
    expect(normalizarOndeFoi("   ")).toBeNull();
    expect(normalizarOndeFoi(null)).toBeNull();
  });
});

describe("etiquetasDaDona", () => {
  it("junta as etiquetas de todas as reuniões, sem repetidas, em ordem alfabética", () => {
    expect(etiquetasDaDona([
      { etiquetas: ["Vendas", "clientes"] },
      { etiquetas: ["Clientes", "Árabe"] },
      { etiquetas: null },
      {},
    ])).toEqual(["Árabe", "clientes", "Vendas"]);
  });

  it("a chave de comparação ignora caixa e espaços", () => {
    expect(chaveDaEtiqueta("  CLIENTES  ")).toBe(chaveDaEtiqueta("clientes"));
  });
});

describe("ehRecusaDosDetalhes", () => {
  it("reconhece só os dois códigos", () => {
    expect(ehRecusaDosDetalhes(RECUSAS_DOS_DETALHES.contato)).toBe(true);
    expect(ehRecusaDosDetalhes(RECUSAS_DOS_DETALHES.contexto)).toBe(true);
    expect(ehRecusaDosDetalhes("Reunião não encontrada.")).toBe(false);
  });
});
