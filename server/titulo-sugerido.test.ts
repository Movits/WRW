import { describe, expect, it } from "vitest";
import { mesmoTitulo, sugestaoDoResumoNovo, TITULO_SUGERIDO_MAX, tituloSugeridoValido } from "@shared/titulo-sugerido";

/**
 * O título que a IA sugere para a reunião (shared/titulo-sugerido.ts): o que
 * fica guardado da resposta, quando a sugestão igual ao título não aparece, e
 * quando o resumo refeito volta a pedir a decisão da dona.
 */
describe("tituloSugeridoValido", () => {
  it("guarda o título como a IA o escreveu, com o espaço repetido limpo", () => {
    expect(tituloSugeridoValido("  Preparação   e validação do aplicativo ")).toBe("Preparação e validação do aplicativo");
  });

  it("tira o emoji do começo (o do título é o do resumo), as aspas em volta e o ponto final", () => {
    expect(tituloSugeridoValido("📱 Lançamento do app")).toBe("Lançamento do app");
    expect(tituloSugeridoValido("👩🏽‍💻 Revisão do código")).toBe("Revisão do código");
    expect(tituloSugeridoValido("🇧🇷 Feira em São Paulo")).toBe("Feira em São Paulo");
    expect(tituloSugeridoValido("\"Plano de exportação\"")).toBe("Plano de exportação");
    expect(tituloSugeridoValido("“Plano de exportação.”")).toBe("Plano de exportação");
    expect(tituloSugeridoValido("「輸出計画」")).toBe("輸出計画");
    expect(tituloSugeridoValido("Plano de exportação.")).toBe("Plano de exportação");
  });

  it("o título com rótulo de voz não serve: a lista e o link não trocam o rótulo por nome", () => {
    expect(tituloSugeridoValido("Combinados de {F2}")).toBeNull();
    expect(tituloSugeridoValido("Combinados de { f12 }")).toBeNull();
  });

  it("vazio, curto demais ou fora do tipo: null", () => {
    for (const valor of [null, undefined, 12, "", "   ", "📱", "\"\"", "x"]) expect(tituloSugeridoValido(valor)).toBeNull();
  });

  it("o longo é cortado no teto, sem partir um emoji ao meio", () => {
    const longo = tituloSugeridoValido(`Reunião ${"muito ".repeat(30)}longa`);
    expect(longo).not.toBeNull();
    expect(Array.from(longo!).length).toBeLessThanOrEqual(TITULO_SUGERIDO_MAX);
    const comEmoji = tituloSugeridoValido(`${"a".repeat(TITULO_SUGERIDO_MAX - 1)}😀😀`);
    expect(Array.from(comEmoji!)).toHaveLength(TITULO_SUGERIDO_MAX);
    expect(comEmoji!.endsWith("😀")).toBe(true);
  });
});

describe("mesmoTitulo", () => {
  it("sem caixa, acento nem espaço repetido", () => {
    expect(mesmoTitulo("Reunião  de Alinhamento", "reuniao de alinhamento")).toBe(true);
    expect(mesmoTitulo("Reunião", "Reuniões")).toBe(false);
    expect(mesmoTitulo(null, "Reunião")).toBe(false);
    expect(mesmoTitulo("", "")).toBe(false);
  });
});

describe("sugestaoDoResumoNovo", () => {
  it("a sugestão nova espera a dona", () => {
    expect(sugestaoDoResumoNovo(null, "Plano de exportação")).toEqual({ suggestedTitle: "Plano de exportação", suggestedTitleStatus: "pending" });
  });

  it("o resumo refeito com o mesmo título não pede de novo o que a dona já decidiu", () => {
    for (const decidida of ["confirmed", "ignored"] as const) {
      expect(sugestaoDoResumoNovo({ suggestedTitle: "Plano de Exportação", suggestedTitleStatus: decidida }, "plano de exportação"))
        .toEqual({ suggestedTitle: "plano de exportação", suggestedTitleStatus: decidida });
    }
  });

  it("outro título volta a esperar a dona, e sem sugestão nova não fica nenhuma", () => {
    expect(sugestaoDoResumoNovo({ suggestedTitle: "Plano de exportação", suggestedTitleStatus: "ignored" }, "Feira de Colônia"))
      .toEqual({ suggestedTitle: "Feira de Colônia", suggestedTitleStatus: "pending" });
    expect(sugestaoDoResumoNovo({ suggestedTitle: "Plano de exportação", suggestedTitleStatus: "confirmed" }, null))
      .toEqual({ suggestedTitle: null, suggestedTitleStatus: null });
  });
});
