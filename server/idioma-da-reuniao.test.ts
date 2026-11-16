import { describe, expect, it } from "vitest";
import { IDIOMAS_DA_REUNIAO, idiomaDaReuniao, nomeDoIdioma } from "@shared/idioma-da-reuniao";

describe("idioma da reunião — a função única do contrato", () => {
  it("todo português vira pt-BR, inclusive o 'pt' das reuniões antigas", () => {
    for (const codigo of ["pt", "pt-BR", "pt-br", "PT", "pt_BR", "pt-PT", " pt-BR "]) expect(idiomaDaReuniao(codigo)).toBe("pt-BR");
  });

  it("código regional do navegador cai no código base da lista", () => {
    expect(idiomaDaReuniao("en-US")).toBe("en");
    expect(idiomaDaReuniao("zh-CN")).toBe("zh");
    expect(idiomaDaReuniao("es-MX")).toBe("es");
    expect(idiomaDaReuniao("ar")).toBe("ar");
  });

  it("fora dos 10, vazio ou ausente é null, sem chutar idioma", () => {
    for (const codigo of ["it", "ko", "", "  ", "x", "english", null, undefined]) expect(idiomaDaReuniao(codigo)).toBeNull();
  });

  it("cada um dos 10 volta a si mesmo e tem nome em português para o prompt", () => {
    expect(IDIOMAS_DA_REUNIAO).toHaveLength(10);
    for (const codigo of IDIOMAS_DA_REUNIAO) {
      expect(idiomaDaReuniao(codigo)).toBe(codigo);
      expect(nomeDoIdioma(codigo)).toMatch(/^\p{L}[\p{L} ]{3,}$/u);
    }
    expect(nomeDoIdioma("pt-BR")).toBe("português do Brasil");
    expect(nomeDoIdioma("en")).toBe("inglês");
  });
});
