import { describe, expect, it } from "vitest";
import { nomeDoTipoDeContexto } from "./nome-do-tipo-de-contexto";

/**
 * O tipo "Evento do MMM" foi semeado no banco (migração 0003) antes de a marca
 * virar WRW (15/09/2026) e depois MarquesaMatch (23/11/2026). A leitura troca o nome da semente; o slug, que é
 * chave, fica como está.
 */
describe("nomeDoTipoDeContexto", () => {
  it("o tipo semeado com a marca antiga chega à tela como Evento da MarquesaMatch", () => {
    expect(nomeDoTipoDeContexto("evento-mmm", "Evento do MMM")).toBe("Evento da MarquesaMatch");
  });

  it("nome renomeado no banco prevalece, mesmo com o slug antigo", () => {
    expect(nomeDoTipoDeContexto("evento-mmm", "Encontro anual")).toBe("Encontro anual");
  });

  it("os outros tipos e os valores ausentes passam como vieram", () => {
    expect(nomeDoTipoDeContexto("feira", "Feira")).toBe("Feira");
    expect(nomeDoTipoDeContexto(undefined, "Evento do MMM")).toBe("Evento do MMM");
    expect(nomeDoTipoDeContexto("evento-mmm", null)).toBeNull();
    expect(nomeDoTipoDeContexto(null, undefined)).toBeUndefined();
  });
});
