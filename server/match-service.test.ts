import { describe, expect, it, vi } from "vitest";
import { scoreMatch, slugifyMatchTag } from "./match-service";

describe("Match Inteligente — scoring privado", () => {
  it("normaliza tags para um slug estável", () => {
    expect(slugifyMatchTag("Mineração de Terras Raras")).toBe("mineracao-de-terras-raras");
  });

  it("prioriza tags exatas com score 100", () => {
    expect(scoreMatch({ slug: "investimento", label: "Investimento", category: "capital" }, { slug: "investimento", label: "Investimento", category: "capital" })).toEqual({ score: 100, type: "exact" });
  });

  it("usa score 60 para a mesma categoria quando a tag difere", () => {
    expect(scoreMatch({ slug: "capital-semente", label: "Capital semente", category: "investimento" }, { slug: "venture-capital", label: "Venture capital", category: "investimento" })).toEqual({ score: 60, type: "category" });
  });

  it("casa categorias que diferem só em acento ou caixa", () => {
    expect(scoreMatch({ slug: "lavra", label: "Lavra", category: "Mineração" }, { slug: "britagem", label: "Britagem", category: "mineracao" })).toEqual({ score: 60, type: "category" });
    expect(scoreMatch({ slug: "lavra", label: "Lavra", category: "Mineraçao" }, { slug: "britagem", label: "Britagem", category: "MINERAÇÃO" })).toEqual({ score: 60, type: "category" });
  });

  it("não casa categorias realmente diferentes", () => {
    expect(scoreMatch({ slug: "lavra", label: "Lavra", category: "Mineração" }, { slug: "frete", label: "Frete", category: "Logística" }).score).toBe(0);
  });

  it("não casa categoria vazia ou ausente", () => {
    expect(scoreMatch({ slug: "lavra", label: "Lavra", category: "" }, { slug: "britagem", label: "Britagem", category: "" }).score).toBe(0);
    expect(scoreMatch({ slug: "lavra", label: "Lavra" }, { slug: "britagem", label: "Britagem" }).score).toBe(0);
    expect(scoreMatch({ slug: "lavra", label: "Lavra", category: null }, { slug: "britagem", label: "Britagem", category: "Mineração" }).score).toBe(0);
  });

  it("a similaridade só conta com o critério estreito ligado e acima do limiar (N7)", () => {
    // Até o N7 valia 45 acima de 0,70, abaixo do corte de 50: desligado por construção. Agora vale 55, só com
    // MATCH_SEMANTICO_ESTREITO=1, só a partir de LIMIAR_SEMANTICO_ESTREITO e só com as guardas (match-n7-*.test.ts).
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "");
    expect(scoreMatch({ slug: "vinho", label: "Vinho" }, { slug: "bebidas", label: "Bebidas" }, 1).score).toBe(0);
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "1");
    expect(scoreMatch({ slug: "vinho", label: "Vinho" }, { slug: "bebidas", label: "Bebidas" }, 0.71).score).toBe(0);
    expect(scoreMatch({ slug: "vinho", label: "Vinho" }, { slug: "bebidas", label: "Bebidas" }, 0.95)).toEqual({ score: 55, type: "semantic" });
    vi.unstubAllEnvs();
  });
});
