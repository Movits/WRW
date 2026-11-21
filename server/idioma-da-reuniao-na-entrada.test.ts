import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * O idioma que a tela manda ao criar a reunião (meetings.create,
 * iniciarGravacao, iniciarDocumento e o vídeo do YouTube), pela validação do
 * router: G16 aceita "Detectar sozinho" e todo idioma que a IA transcreve, e
 * recusa o resto, porque o código é gravado e decide o original da tradução.
 */
const { idiomaDaReuniaoNaEntrada } = await import("./routers/meetings");

describe("idiomaDaReuniaoNaEntrada", () => {
  it("sem idioma, o padrão; 'pt' da tela antiga vira pt-BR; a região cai na base", () => {
    expect(idiomaDaReuniaoNaEntrada.parse(undefined)).toBe("pt-BR");
    expect(idiomaDaReuniaoNaEntrada.parse("pt")).toBe("pt-BR");
    expect(idiomaDaReuniaoNaEntrada.parse("en-US")).toBe("en");
  });

  it("G16: \"Detectar sozinho\" e os idiomas fora dos 10 da tela passam", () => {
    expect(idiomaDaReuniaoNaEntrada.parse("auto")).toBe("auto");
    expect(idiomaDaReuniaoNaEntrada.parse("it")).toBe("it");
    expect(idiomaDaReuniaoNaEntrada.parse("ko-KR")).toBe("ko");
    expect(idiomaDaReuniaoNaEntrada.parse("iw")).toBe("he");
  });

  it("o que a IA não transcreve é recusado", () => {
    for (const valor of ["xx", "klingon", "", "automatico"]) expect(idiomaDaReuniaoNaEntrada.safeParse(valor).success, valor).toBe(false);
    expect(idiomaDaReuniaoNaEntrada.safeParse("x".repeat(13)).success).toBe(false);
  });
});
