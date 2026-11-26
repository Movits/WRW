import { afterEach, describe, expect, it, vi } from "vitest";
import { analisarTermo, mesmoTermoEmOutraGrafia, nomeiamAMesmaCoisa, palavrasDeConteudo, saoConcorrentes } from "@shared/direcao-do-termo";
import { necessidadeEhOferta } from "@shared/tipo-da-oferta";
import { LIMIAR_SEMANTICO_ESTREITO, scoreMatch, semanticoEstreitoPodeValer, slugifyMatchTag } from "./match-service";

/**
 * N7 — o verbo conjugado lido como direção (C06 da rede com armadilhas), o mesmo termo escrito com outra grafia
 * (P11, P12, P13), a necessidade que na verdade oferece o serviço (validação da #154) e as guardas do critério
 * semântico estreito. A medida no gabarito está em server/rede-com-armadilhas.test.ts.
 */

const item = (label: string, category: string | null = null) => ({ slug: slugifyMatchTag(label), label, category });

describe("N7 — verbo conjugado é direção", () => {
  it("negativo: duas exportadoras que se descrevem com o verbo conjugado são concorrentes", () => {
    expect(saoConcorrentes("Exportamos frutas", "Exportar frutas")).toBe(true);
    expect(scoreMatch(item("Exportamos frutas", "Frutas"), item("Exportar frutas", "Frutas"))).toHaveProperty("bloqueio", "concorrentes");
    expect(saoConcorrentes("Vendemos soja", "Vender soja")).toBe(true);
    expect(saoConcorrentes("Nós exportamos café", "Exporta café")).toBe(true);
    expect(saoConcorrentes("Compramos gado", "Comprar gado")).toBe(true);
  });

  it("positivo: o verbo conjugado diante da direção oposta é o negócio", () => {
    expect(analisarTermo("Exportamos frutas")).toEqual({ direcao: "oferta", objeto: "frutas", verbo: "exportamos" });
    expect(scoreMatch(item("Exportamos frutas"), item("Importar frutas"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Vendo vinhos"), item("Compramos vinhos"))).toEqual({ score: 100, type: "exact" });
    expect(analisarTermo("Vende-se terreno")).toEqual({ direcao: "oferta", objeto: "terreno", verbo: "vende" });
  });

  it("o que tem outra leitura fica neutro: 'Compra de gado' segue substantivo e 'Contrato' não é verbo", () => {
    expect(analisarTermo("Contrato de fornecimento").direcao).toBe("neutro");
    expect(analisarTermo("Nos Estados Unidos").direcao).toBe("neutro");
  });
});

describe("N7 — o mesmo termo em outra grafia (sem acento, plural, um erro de digitação)", () => {
  it("positivo: P11, P12 e P13 da rede", () => {
    expect(nomeiamAMesmaCoisa("Soja em grão", "soja em graos")).toBe(true);
    expect(nomeiamAMesmaCoisa("Embalagens sustentáveis", "embalagem sustentavel")).toBe(true);
    expect(nomeiamAMesmaCoisa("Transporte de cargas", "Trasporte de carga pra Manaus")).toBe(true);
    expect(nomeiamAMesmaCoisa("Fornecedores de óleos vegetais", "fornecedor de oleo vegetal")).toBe(true);
  });

  it("negativo: palavra solta, palavra curta, termo de uma palavra só e duas trocas não casam", () => {
    expect(nomeiamAMesmaCoisa("Banco de sementes crioulas", "Banco de investimento")).toBe(false);
    expect(mesmoTermoEmOutraGrafia("conserto", "concerto")).toBe(false);
    expect(mesmoTermoEmOutraGrafia("mesa-de-som", "mesa-de-sol")).toBe(false);
    expect(mesmoTermoEmOutraGrafia("trasporte-de-cargo", "transporte-de-carga")).toBe(false);
    expect(mesmoTermoEmOutraGrafia("material-escolar", "maternal-escolar")).toBe(true); // o limite aceito: uma troca em palavra longa
    expect(mesmoTermoEmOutraGrafia("soja-em-grao", "soja-em-grao-organico")).toBe(false);
    expect(mesmoTermoEmOutraGrafia("exportacao-de-cafe", "importacao-de-cafe")).toBe(false);
  });

  it("negativo: a outra grafia não junta concorrentes", () => {
    expect(scoreMatch(item("Exportar vinhos"), item("Exportar vinho")).score).toBe(0);
  });
});

describe("N7 — a necessidade que na verdade OFERECE (validação da #154)", () => {
  it("negativo: a oferta escrita no campo de necessidade não casa com o serviço", () => {
    for (const [oferta, necessidade] of [
      ["Contabilidade", "Ofereço contabilidade para MEI"],
      ["Contabilidade", "Contadora oferece serviços para MEI"],
      ["Contabilidade", "Oferecemos contabilidade"],
      ["Advocacia", "Advogado disponível para empresas"],
      ["Advocacia", "We offer legal services"],
    ]) {
      expect(necessidadeEhOferta(necessidade), necessidade).toBe(true);
      expect(scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços")), `${oferta} × ${necessidade}`)
        .toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    }
  });

  it("positivo: gostaria, desejo, quisiera e 'we'd like' são pedido, e o 'disponível' depois deles não vira oferta", () => {
    for (const [oferta, necessidade] of [
      ["Contabilidade", "Gostaria de um contador disponível aos sábados"],
      ["Contabilidade", "Gostaríamos de contador disponível"],
      ["Contabilidade", "Desejo um contador disponível"],
      ["Contabilidad", "Quisiera un contador disponible"],
      ["Contabilidad", "Quisiéramos un contador disponible"],
      ["Accounting", "We'd like an accountant available on weekends"],
      ["Accounting", "We want an available accountant"],
    ]) {
      expect(necessidadeEhOferta(necessidade), necessidade).toBe(false);
      expect(scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços")).score, `${oferta} × ${necessidade}`).toBeGreaterThanOrEqual(50);
    }
  });

  it("negativo: 'like' fora da locução não é pedido, e a oferta segue oferta", () => {
    expect(necessidadeEhOferta("We offer accounting like the big firms")).toBe(true);
    expect(scoreMatch(item("Accounting", "Serviços"), item("We offer accounting like the big firms", "Serviços")).score).toBe(0);
  });

  it("positivo: o pedido continua pedindo, mesmo com 'disponível' no meio", () => {
    expect(necessidadeEhOferta("Procuro contador disponível aos sábados")).toBe(false);
    expect(necessidadeEhOferta("Contador para MEI")).toBe(false);
    expect(scoreMatch(item("Contabilidade", "Serviços"), item("Procuro contador disponível aos sábados", "Serviços")).score).toBeGreaterThanOrEqual(50);
    expect(scoreMatch(item("Contabilidade", "Serviços"), item("Contador para MEI", "Serviços"))).toEqual({ score: 100, type: "exact" });
  });
});

describe("N7 — as guardas do critério semântico estreito", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("palavras de conteúdo: sem verbo, marcador nem preposição, no singular", () => {
    expect(palavrasDeConteudo("Procuro fornecedor de bebidas")).toEqual(["fornecedor", "bebida"]);
    expect(palavrasDeConteudo("Vendo vinhos")).toEqual(["vinho"]);
  });

  it("recusa concorrente, direção trocada, serviço e palavra em comum", () => {
    expect(semanticoEstreitoPodeValer(item("Exportar café"), item("Exportar grãos de café"))).toBe(false);
    expect(semanticoEstreitoPodeValer(item("Vinhos"), item("Procuro exportar bebidas"))).toBe(false);
    expect(semanticoEstreitoPodeValer(item("Consultoria jurídica", "Serviços"), item("Apoio legal", "Serviços"))).toBe(false);
    expect(semanticoEstreitoPodeValer(item("Banco de sementes"), item("Banco de investimento"))).toBe(false);
    expect(semanticoEstreitoPodeValer(item("Vendo vinhos", "Bebidas"), item("Procuro fornecedor de bebidas"))).toBe(true);
  });

  it("só conta ligado, acima do limiar e com as guardas", () => {
    const par = [item("Vendo vinhos", "Bebidas"), item("Procuro fornecedor de bebidas", "Fornecedores")] as const;
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "");
    expect(scoreMatch(...par, 1).score).toBe(0);
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "1");
    expect(scoreMatch(...par, LIMIAR_SEMANTICO_ESTREITO - 0.01).score).toBe(0);
    expect(scoreMatch(...par, LIMIAR_SEMANTICO_ESTREITO)).toEqual({ score: 55, type: "semantic" });
    expect(scoreMatch(item("Banco de sementes"), item("Banco de investimento"), 1).score).toBe(0);
  });
});
