import { describe, expect, it } from "vitest";
import tabela from "./cnae/cnae-2-3.json";
import {
  FONTE_DA_CNAE, cnaeExiste, descricaoDoCnae, ofertaDoCnae, ofertasDasCnaes, segmentoDoCnae,
} from "./cnae";
import { scoreMatch, slugifyMatchTag } from "./match-service";
import { encontrosEntre } from "./network-rede-global";
import { ITEM_MAX } from "../shared/entidades";

/**
 * A CNAE como "o que tem" (N4). A tabela é a do IBGE; o rótulo da oferta sai
 * dela sem a cláusula "exceto" e sem as subclasses residuais; e o match só
 * nasce de uma necessidade DECLARADA, pelas regras de sempre do motor.
 */
const subclasses = Object.keys((tabela as { subclasses: Record<string, string> }).subclasses);
const razao = (label: string) => ({ slug: slugifyMatchTag(label), label, category: null });
const nota = (oferta: string, necessidade: string) => scoreMatch(razao(oferta), razao(necessidade)).score;

describe("a tabela da CNAE 2.3", () => {
  it("traz a fonte, a versão e a data da consulta, e as 1332 subclasses de 7 dígitos", () => {
    expect(FONTE_DA_CNAE.fonte).toContain("IBGE");
    expect(FONTE_DA_CNAE.versao).toBe("CNAE 2.3");
    expect(FONTE_DA_CNAE.consultadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(subclasses).toHaveLength(1332);
    for (const codigo of subclasses) expect(codigo).toMatch(/^\d{7}$/);
  });

  it("confere códigos reais e recusa o inventado", () => {
    expect(cnaeExiste("6201501")).toBe(true);
    expect(descricaoDoCnae("6201501")).toBe("Desenvolvimento de programas de computador sob encomenda");
    expect(descricaoDoCnae("6911701")).toBe("Serviços advocatícios");
    expect(cnaeExiste("9999999")).toBe(false);
    expect(cnaeExiste("toString")).toBe(false);
    expect(descricaoDoCnae("0000000")).toBeNull();
  });

  it("guarda as siglas oficiais no texto em frase comum", () => {
    expect(descricaoDoCnae("4682600")).toBe("Comércio atacadista de gás liqüefeito de petróleo (GLP)");
    expect(descricaoDoCnae("4649407")).toContain("CDs, DVDs");
  });

  it("tira o segmento (seção e divisão) do código, para todas as subclasses", () => {
    expect(segmentoDoCnae("6201501")).toEqual({ secao: "J", divisao: "62" });
    expect(segmentoDoCnae("0111301")).toEqual({ secao: "A", divisao: "01" });
    expect(segmentoDoCnae("9900800")).toEqual({ secao: "U", divisao: "99" });
    expect(segmentoDoCnae("9999999")).toBeNull();
    for (const codigo of subclasses) expect(segmentoDoCnae(codigo)).not.toBeNull();
  });
});

describe("o rótulo da oferta", () => {
  it("tira a cláusula \"exceto\" e nunca passa do tamanho do item", () => {
    expect(ofertaDoCnae("4930202")).toBe("Transporte rodoviário de carga");
    for (const codigo of subclasses) {
      const oferta = ofertaDoCnae(codigo);
      if (oferta === null) continue;
      expect(oferta.length).toBeLessThanOrEqual(ITEM_MAX);
      expect(oferta).not.toMatch(/\bexceto\b/i);
      expect(oferta).not.toMatch(/[\s,;-]$/);
    }
  });

  it("a subclasse residual (\"não especificados anteriormente\") não vira oferta", () => {
    const residuais = subclasses.filter(c => /n[ãa]o especificad/i.test(descricaoDoCnae(c)!));
    expect(residuais.length).toBeGreaterThan(50);
    for (const codigo of residuais) expect(ofertaDoCnae(codigo)).toBeNull();
    expect(ofertaDoCnae("9999999")).toBeNull();
  });

  it("junta a principal e as secundárias sem repetir o que a entidade escreveu e sem passar do teto", () => {
    expect(ofertasDasCnaes({ principal: "6911701", secundarias: ["6201501", "6911701"] }, [], 20))
      .toEqual(["Serviços advocatícios", "Desenvolvimento de programas de computador sob encomenda"]);
    // A mesma oferta escrita pela entidade (sem acento ou caixa) não entra de novo.
    expect(ofertasDasCnaes({ principal: "6911701", secundarias: [] }, ["servicos ADVOCATICIOS"], 20)).toEqual([]);
    // Duas subclasses que dão o mesmo rótulo (municipal e intermunicipal) viram um item só.
    expect(ofertasDasCnaes({ principal: "4930201", secundarias: ["4930202"] }, [], 20)).toEqual(["Transporte rodoviário de carga"]);
    // O teto conta o que a entidade escreveu, que vem antes e não é cortado.
    expect(ofertasDasCnaes({ principal: "6911701", secundarias: ["6201501"] }, ["a", "b"], 3)).toEqual(["Serviços advocatícios"]);
    expect(ofertasDasCnaes({ principal: null, secundarias: ["9999999"] }, [], 20)).toEqual([]);
  });
});

describe("o match só nasce de uma necessidade declarada", () => {
  it("a oferta da CNAE casa com quem declarou precisar daquilo", () => {
    expect(nota(ofertaDoCnae("6911701")!, "Serviços advocatícios")).toBeGreaterThanOrEqual(50);
    expect(nota(ofertaDoCnae("0111301")!, "Cultivo de arroz")).toBeGreaterThanOrEqual(50);
  });

  it("a cláusula \"exceto\" não casa com o que a subclasse exclui (o defeito que o corte evita)", () => {
    const oficial = descricaoDoCnae("4930202")!;
    expect(oficial).toContain("exceto produtos perigosos e mudanças");
    expect(nota(oficial, "transporte de mudança")).toBeGreaterThanOrEqual(50);
    expect(nota(ofertaDoCnae("4930202")!, "transporte de mudança")).toBeLessThan(50);
  });

  it("nenhuma oferta da tabela casa com palavra solta de ramo (setor não é necessidade)", () => {
    const ofertas = subclasses.map(ofertaDoCnae).filter((o): o is string => o !== null);
    for (const solta of ["Produtos", "Comércio", "Serviços", "Fabricação", "Indústria", "Atividades"]) {
      expect(ofertas.filter(o => nota(o, solta) >= 50), solta).toEqual([]);
    }
  });

  it("sem necessidade declarada não há encontro, por mais ofertas que a empresa tenha", () => {
    const tenho = subclasses.map(ofertaDoCnae).filter((o): o is string => o !== null).slice(0, 20)
      .map(label => ({ label, category: null }));
    expect(encontrosEntre({ tenho, preciso: [] }, { tenho, preciso: [] }).encontros).toEqual([]);
    const comPedido = encontrosEntre(
      { tenho: [{ label: ofertaDoCnae("6911701")!, category: null }], preciso: [] },
      { tenho: [], preciso: [{ label: "Serviços advocatícios", category: null }] },
    );
    expect(comPedido.encontros).toHaveLength(1);
    expect(comPedido.encontros[0]).toMatchObject({ de: "a", tem: "Serviços advocatícios" });
  });
});
