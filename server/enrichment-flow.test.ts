import { describe, expect, it } from "vitest";
import { dizQueNaoSabe, ENRICHMENT_STEPS, getEnrichmentStep, indiceDaEtapaDoCampo, isExpectedField, isSkipResponse, valorQueNaoInforma } from "./enrichment-flow";

describe("roteiro de enriquecimento", () => {
  it("mantém as seis perguntas na ordem obrigatória", () => {
    expect(ENRICHMENT_STEPS).toHaveLength(6);
    expect(getEnrichmentStep(0)?.fieldType).toBe("phone");
    expect(getEnrichmentStep(5)?.fieldType).toBe("relationship_type");
    expect(getEnrichmentStep(6)).toBeNull();
  });

  it("aceita somente a entidade esperada no turno atual", () => {
    expect(isExpectedField("company", "company")).toBe(true);
    expect(isExpectedField("asset_tag", "assets")).toBe(true);
    expect(isExpectedField("needs", "company")).toBe(false);
  });

  it("reconhece respostas que devem pular uma pergunta", () => {
    expect(isSkipResponse("não sei")).toBe(true);
    expect(isSkipResponse("Nao tenho")).toBe(true);
    expect(isSkipResponse("Farmacore")).toBe(false);
  });

  // Conferência de tela do pacote do match (20/11/2026): "Não sei o telefone. O que ela tem para oferecer: Exportação
  // de café." repetia a pergunta do telefone. O router só pula com isto quando a IA não tirou nada da pergunta da vez.
  it.each([
    "Não sei o telefone. O que ela tem para oferecer: Exportação de café.",
    "o telefone eu não sei",
    "NÃO SEI",
    "nao tenho o numero dela",
    "Ela não tem empresa",
    "não lembro o nome da empresa",
    "Não faço ideia",
    "desconheço",
    "sei lá",
    "I don't know her phone",
    "no idea",
    "No sé el teléfono",
  ])("'%s' diz que não sabe", resposta => {
    expect(dizQueNaoSabe(resposta)).toBe(true);
  });

  it.each([
    "11 99999-8888",
    "Ela trabalha na Café Brasil",
    "Conheci numa feira",
    "Ela é ótima, conheci numa feira",
    // Como palavra inteira: "nãosei" colado, "seila", "sabão" e "knowledge" não são a expressão.
    "Exportação de knowledge e sabão",
  ])("'%s' não diz que não sabe", resposta => {
    expect(dizQueNaoSabe(resposta)).toBe(false);
  });

  it("o campo leva ao índice da pergunta dele no roteiro, com os apelidos", () => {
    expect(indiceDaEtapaDoCampo("phone")).toBe(0);
    expect(indiceDaEtapaDoCampo("whatsapp")).toBe(0);
    expect(indiceDaEtapaDoCampo("asset_tag")).toBe(2);
    expect(indiceDaEtapaDoCampo("context")).toBe(4);
    expect(indiceDaEtapaDoCampo("relationship_type")).toBe(5);
    expect(indiceDaEtapaDoCampo("email")).toBe(-1);
  });

  // Na tela (21/11), a IA devolveu o telefone "Não informado", confiança 1, para "o telefone eu não sei, mas...".
  it.each(["Não informado", "não informado.", "Desconhecido", "desconhecida", "N/A", "n/a", "não sabe", "sem telefone", "—", "-", "?", "Unknown", "não sei", "Nenhum"])(
    "o valor '%s' é a falta do dado, e não vira cartão",
    valor => {
      expect(valorQueNaoInforma(valor)).toBe(true);
    },
  );

  it.each(["11 99999-8888", "Café Brasil Ltda", "Sem Limites Ltda", "Sem Fronteiras", "Nenhuma Ltda", "Exportação de café", "Não-Me-Toque Agro"])(
    "o valor '%s' é dado de verdade",
    valor => {
      expect(valorQueNaoInforma(valor)).toBe(false);
    },
  );
});
