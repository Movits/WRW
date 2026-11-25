import { describe, expect, it } from "vitest";
import { direcoesDoMotivo, slugsPorContato } from "./motivo-da-conexao-privada";

/**
 * Quem possui o quê numa sugestão do motor privado, para a tela escrever a frase do motivo no idioma dela (a
 * reason_text é gravada em português; em árabe ela saía assim, crua, na conferência de tela de 20/11/2026).
 */
const item = (label: string, slug = "") => ({ slug, label, category: null });
const possui = (pares: Array<[number, string]>) => slugsPorContato(pares.map(([contactId, label]) => ({ contactId, slug: null, label })));

describe("direcoesDoMotivo", () => {
  it("um sentido só: tudo é de quem possui (contactAId), para quem procura (contactBId)", () => {
    const sugestao = { contactAId: 3, contactBId: 2, matchType: "exact", matchedAssets: [item("Exportar café", "exportar-cafe")] };
    expect(direcoesDoMotivo(sugestao, possui([[3, "Exportar café"]]))).toEqual([{ deId: 3, paraId: 2, possui: ["Exportar café"] }]);
  });

  it("mútuo: cada item vai para quem o tem em 'o que possui', nos dois sentidos", () => {
    const sugestao = {
      contactAId: 1, contactBId: 2, matchType: "mutual",
      matchedAssets: [item("Exportar café", "exportar-cafe"), item("Armazém em Santos", "armazem-em-santos"), item("Torrefação", "torrefacao")],
    };
    const donos = possui([[1, "Exportar café"], [1, "Torrefação"], [2, "Armazém em Santos"], [2, "Vinho"]]);
    expect(direcoesDoMotivo(sugestao, donos)).toEqual([
      { deId: 1, paraId: 2, possui: ["Exportar café", "Torrefação"] },
      { deId: 2, paraId: 1, possui: ["Armazém em Santos"] },
    ]);
  });

  it("mútuo com item que nenhum dos dois tem mais: fica com o contactAId (o lado da maior nota), e nada some", () => {
    const sugestao = { contactAId: 1, contactBId: 2, matchType: "mutual", matchedAssets: [item("Exportar café"), item("Armazém em Santos")] };
    expect(direcoesDoMotivo(sugestao, possui([[2, "Armazém em Santos"]]))).toEqual([
      { deId: 1, paraId: 2, possui: ["Exportar café"] },
      { deId: 2, paraId: 1, possui: ["Armazém em Santos"] },
    ]);
  });

  it("linha gravada sem slug (escrita fora do alfabeto latino antes do conserto): o slug sai do rótulo, dos dois lados", () => {
    const sugestao = { contactAId: 1, contactBId: 2, matchType: "mutual", matchedAssets: [item("تصدير القهوة"), item("咖啡出口")] };
    expect(direcoesDoMotivo(sugestao, possui([[1, "تصدير القهوة"], [2, "咖啡出口"]]))).toEqual([
      { deId: 1, paraId: 2, possui: ["تصدير القهوة"] },
      { deId: 2, paraId: 1, possui: ["咖啡出口"] },
    ]);
  });

  it("JSON fora da forma (nulo, item sem rótulo) não derruba a lista", () => {
    expect(direcoesDoMotivo({ contactAId: 1, contactBId: 2, matchType: "exact", matchedAssets: null }, new Map())).toEqual([{ deId: 1, paraId: 2, possui: [] }]);
    expect(direcoesDoMotivo({ contactAId: 1, contactBId: 2, matchType: "exact", matchedAssets: [null, { slug: "x" }, item("Vinho")] }, new Map()))
      .toEqual([{ deId: 1, paraId: 2, possui: ["Vinho"] }]);
  });
});
