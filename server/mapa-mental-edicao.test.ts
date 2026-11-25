import { describe, expect, it } from "vitest";
import { conferirMapaMental, type MapaMental } from "@shared/mapa-mental";
import {
  acrescentarNo, apagarNo, conferirMapaEditado, estiloDoMapa, mapaEmMarkdown, mesmoMapa, moverNo, nomeDoArquivoDoMapa,
  nosQueCabem, RECUSAS_DO_MAPA, renomearNo, rotuloNoCaminho,
} from "@shared/mapa-mental-edicao";

/**
 * O mapa editável (H10b): a conferência do que a dona escreve (sem podar em
 * silêncio), as operações da edição, o estilo, o Markdown e o nome do arquivo.
 */

const MAPA: MapaMental = {
  ramos: [
    { rotulo: "Exportação de café", folhas: [{ rotulo: "Contêiner sai de Santos", filhos: ["12 de março", "Navio X"] }, { rotulo: "Seguro", filhos: [] }] },
    { rotulo: "Transportadora", folhas: [{ rotulo: "Contrato não será renovado", filhos: [] }] },
    { rotulo: "Próximos passos", folhas: [] },
  ],
};

describe("conferirMapaEditado", () => {
  it("aceita o mapa válido inteiro, com os rótulos aparados, e o que passa também passa na conferência da IA sem perder nada", () => {
    const comEspacos = renomearNo(MAPA, [0], "  Exportação   de café ");
    const r = conferirMapaEditado(comEspacos);
    expect(r).toEqual({ ok: true, mapa: MAPA });
    expect(conferirMapaMental(MAPA)).toEqual(MAPA);
  });

  it("recusa com o código, sem podar: poucos ramos, ramos ou folhas ou filhos demais, nós demais", () => {
    expect(conferirMapaEditado({ ramos: [MAPA.ramos[0]] })).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.poucosRamos });
    const treze = Array.from({ length: 13 }, (_, i) => ({ rotulo: `Ramo ${i}`, folhas: [] }));
    expect(conferirMapaEditado({ ramos: treze })).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.grande });
    const noveFolhas = Array.from({ length: 9 }, (_, i) => ({ rotulo: `Folha ${i}`, filhos: [] }));
    expect(conferirMapaEditado({ ramos: [{ rotulo: "A", folhas: noveFolhas }, { rotulo: "B", folhas: [] }] })).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.grande });
    const cincoFilhos = [{ rotulo: "F", filhos: ["a", "b", "c", "d", "e"] }];
    expect(conferirMapaEditado({ ramos: [{ rotulo: "A", folhas: cincoFilhos }, { rotulo: "B", folhas: [] }] })).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.grande });
    // 12 ramos × 8 folhas × (1 + 1 filho) + 12 = 204 nós: cada nível dentro do teto, a árvore acima de 150.
    const cheio = Array.from({ length: 12 }, (_, r) => ({ rotulo: `Ramo ${r}`, folhas: Array.from({ length: 8 }, (_, f) => ({ rotulo: `Folha ${f}`, filhos: ["x"] })) }));
    expect(conferirMapaEditado({ ramos: cheio })).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.grande });
  });

  it("recusa o rótulo vazio, acima de 60 caracteres ou com rótulo de voz, sem cortar nem trocar", () => {
    for (const ruim of ["", "   ", "x".repeat(61), "{F2} envia a proposta", "fala do { f 3"]) {
      expect(conferirMapaEditado(renomearNo(MAPA, [1, 0], ruim))).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.rotulo });
    }
    expect(conferirMapaEditado(renomearNo(MAPA, [0, 0, 1], "a".repeat(60))).ok).toBe(true);
  });

  it("recusa irmãos repetidos (sem acento, caixa e pontuação), mas aceita o mesmo rótulo em pais diferentes", () => {
    expect(conferirMapaEditado(renomearNo(MAPA, [1], "exportacao de cafe!"))).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.repetido });
    expect(conferirMapaEditado(renomearNo(MAPA, [0, 1], "Contêiner sai de santos"))).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.repetido });
    expect(conferirMapaEditado(renomearNo(MAPA, [0, 0, 1], "12 DE MARÇO"))).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.repetido });
    expect(conferirMapaEditado(renomearNo(MAPA, [1, 0], "Seguro")).ok).toBe(true);
  });

  it("recusa o que não tem a forma de um mapa", () => {
    for (const ruim of [null, "mapa", [], { ramos: "x" }, { ramos: [{ rotulo: "A" }, { rotulo: "B", folhas: [] }] }, { ramos: [{ rotulo: "A", folhas: [{ rotulo: "f" }] }, { rotulo: "B", folhas: [] }] }]) {
      expect(conferirMapaEditado(ruim)).toEqual({ ok: false, codigo: RECUSAS_DO_MAPA.forma });
    }
  });
});

describe("as operações da edição", () => {
  it("renomear, ler e apagar por caminho, sem mexer no mapa de entrada", () => {
    const antes = JSON.stringify(MAPA);
    expect(rotuloNoCaminho(renomearNo(MAPA, [0, 0, 0], "13 de março"), [0, 0, 0])).toBe("13 de março");
    expect(rotuloNoCaminho(MAPA, [5])).toBeNull();
    expect(apagarNo(MAPA, [0]).ramos.map(r => r.rotulo)).toEqual(["Transportadora", "Próximos passos"]);
    expect(apagarNo(MAPA, [0, 0]).ramos[0].folhas.map(f => f.rotulo)).toEqual(["Seguro"]);
    expect(apagarNo(MAPA, [0, 0, 0]).ramos[0].folhas[0].filhos).toEqual(["Navio X"]);
    expect(JSON.stringify(MAPA)).toBe(antes);
  });

  it("acrescentar no fim de cada nível devolve o caminho do novo; no teto, nada muda", () => {
    expect(acrescentarNo(MAPA, []).caminho).toEqual([3]);
    expect(acrescentarNo(MAPA, [2])).toMatchObject({ caminho: [2, 0] });
    expect(acrescentarNo(MAPA, [0, 1]).mapa.ramos[0].folhas[1].filhos).toEqual([""]);
    const cheio = { ramos: [{ rotulo: "A", folhas: [{ rotulo: "F", filhos: ["a", "b", "c", "d"] }] }, { rotulo: "B", folhas: [] }] };
    expect(acrescentarNo(cheio, [0, 0])).toEqual({ mapa: cheio, caminho: null });
  });

  it("mover entre irmãos (para cima e para baixo) e para outro pai do mesmo nível; nível diferente não move", () => {
    expect(moverNo(MAPA, [2], [0]).ramos.map(r => r.rotulo)).toEqual(["Próximos passos", "Exportação de café", "Transportadora"]);
    expect(moverNo(MAPA, [0], [2]).ramos.map(r => r.rotulo)).toEqual(["Transportadora", "Próximos passos", "Exportação de café"]);
    const outroRamo = moverNo(MAPA, [0, 1], [2, 0]);
    expect(outroRamo.ramos[0].folhas.map(f => f.rotulo)).toEqual(["Contêiner sai de Santos"]);
    expect(outroRamo.ramos[2].folhas.map(f => f.rotulo)).toEqual(["Seguro"]);
    expect(moverNo(MAPA, [0, 0, 1], [1, 0, 0]).ramos[1].folhas[0].filhos).toEqual(["Navio X"]);
    expect(moverNo(MAPA, [0, 0], [1])).toBe(MAPA);
    expect(moverNo(MAPA, [9], [0])).toBe(MAPA);
  });

  it("os nós que ainda cabem no teto de 150", () => {
    expect(nosQueCabem(MAPA)).toBe(150 - 8);
  });

  it("mesmoMapa compara rótulo a rótulo e a ordem", () => {
    expect(mesmoMapa(MAPA, JSON.parse(JSON.stringify(MAPA)))).toBe(true);
    expect(mesmoMapa(MAPA, moverNo(MAPA, [1], [0]))).toBe(false);
  });
});

describe("estilo, Markdown e nome do arquivo", () => {
  it("o estilo guardado, com a visão geral para o nulo e o desconhecido", () => {
    expect(estiloDoMapa("timeline")).toBe("timeline");
    expect(estiloDoMapa(null)).toBe("overview");
    expect(estiloDoMapa("radial")).toBe("overview");
  });

  it("o Markdown: título, ramos em negrito e a lista aninhada, com a formatação escapada e a tradução", () => {
    const md = mapaEmMarkdown("Reunião *semanal*", renomearNo(MAPA, [1, 0], "Custo [alto] # 2"));
    expect(md).toBe([
      "# Reunião \\*semanal\\*", "",
      "- **Exportação de café**", "  - Contêiner sai de Santos", "    - 12 de março", "    - Navio X", "  - Seguro",
      "- **Transportadora**", "  - Custo \\[alto\\] \\# 2",
      "- **Próximos passos**", "",
    ].join("\n"));
    expect(mapaEmMarkdown("T", MAPA, r => `[${r.length}]`)).toContain("- **\\[18\\]**");
  });

  it("o nome do arquivo sem os caracteres que os sistemas recusam", () => {
    expect(nomeDoArquivoDoMapa("Reunião: 12/03 \"final\"", "pdf")).toBe("Reunião 12 03 final.pdf");
    expect(nomeDoArquivoDoMapa("  ", "md")).toBe("mapa-mental.md");
    expect(nomeDoArquivoDoMapa("اجتماع", "jpg")).toBe("اجتماع.jpg");
  });
});
