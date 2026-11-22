import { describe, expect, it } from "vitest";
import {
  chaveDoNomeDaPasta, corDaPasta, CORES_DA_PASTA, iconeDaPasta, ICONES_DA_PASTA, NOME_DA_PASTA_MAX, normalizarNomeDaPasta, reuniaoNaVista, vistaDaOrigem,
} from "@shared/pastas-de-reunioes";
import { dentroDoPrazoDaLixeira, diasRestantesNaLixeira, fimDoPrazoDaLixeira, podeIrParaALixeira, PRAZO_DA_LIXEIRA_MS } from "@shared/lixeira-de-reunioes";

/**
 * As regras puras das pastas e da lixeira (H7d), que a tela e o servidor
 * dividem: shared/pastas-de-reunioes.ts e shared/lixeira-de-reunioes.ts.
 */

const DIA = 24 * 60 * 60 * 1000;

describe("o nome da pasta", () => {
  it("apara, junta os espaços e corta pela letra (o emoji não sai pela metade); vazio vira null", () => {
    expect(normalizarNomeDaPasta("  Clientes   de \n São Paulo  ")).toBe("Clientes de São Paulo");
    expect(normalizarNomeDaPasta("   ")).toBeNull();
    expect(normalizarNomeDaPasta("")).toBeNull();
    const longo = "🌍".repeat(NOME_DA_PASTA_MAX + 5);
    const cortado = normalizarNomeDaPasta(longo)!;
    expect(Array.from(cortado)).toHaveLength(NOME_DA_PASTA_MAX);
    expect(cortado).toBe("🌍".repeat(NOME_DA_PASTA_MAX));
    // O corte não deixa espaço sobrando no fim.
    expect(normalizarNomeDaPasta(`${"a".repeat(NOME_DA_PASTA_MAX - 1)} b`)).toBe("a".repeat(NOME_DA_PASTA_MAX - 1));
  });

  it("a chave da repetida ignora a caixa, o acento e os espaços: 'Reuniões de Março' e 'reunioes  de marco' são a mesma pasta", () => {
    expect(chaveDoNomeDaPasta("Reuniões de Março")).toBe(chaveDoNomeDaPasta("  reunioes  de marco "));
    expect(chaveDoNomeDaPasta("Clientes")).not.toBe(chaveDoNomeDaPasta("Cliente"));
    // Outras escritas ficam como estão (sem acento a tirar).
    expect(chaveDoNomeDaPasta("会议")).toBe("会议");
  });

  it("o ícone e a cor lidos do banco: o que não está na lista cai no padrão, em vez de quebrar a tela", () => {
    expect(iconeDaPasta("maleta")).toBe("maleta");
    expect(iconeDaPasta("foguete")).toBe("pasta");
    expect(iconeDaPasta(null)).toBe("pasta");
    expect(corDaPasta("azul")).toBe("azul");
    expect(corDaPasta("dourado")).toBe("ambar");
    expect(new Set(ICONES_DA_PASTA).size).toBe(ICONES_DA_PASTA.length);
    expect(new Set(CORES_DA_PASTA).size).toBe(CORES_DA_PASTA.length);
  });
});

describe("os filtros da lista por origem", () => {
  it("gravadas (microfone e aba), importadas (arquivo, PDF e fotos) e YouTube; a origem nula do envio único antigo só em 'Todas'", () => {
    expect(vistaDaOrigem("gravacao")).toBe("gravadas");
    expect(vistaDaOrigem("aba")).toBe("gravadas");
    expect(vistaDaOrigem("arquivo")).toBe("importadas");
    expect(vistaDaOrigem("pdf")).toBe("importadas");
    expect(vistaDaOrigem("foto")).toBe("importadas");
    expect(vistaDaOrigem("youtube")).toBe("youtube");
    expect(vistaDaOrigem(null)).toBeNull();
    expect(vistaDaOrigem(undefined)).toBeNull();
    expect(vistaDaOrigem("outra-coisa")).toBeNull();
  });

  it("'Todas' mostra tudo; 'Pastas' as que estão em alguma pasta, e com uma escolhida só as dela; as outras pela origem", () => {
    const antiga = { origem: null, folderId: null };
    const naPasta = { origem: "youtube", folderId: "p1" };
    expect(reuniaoNaVista(antiga, "todas")).toBe(true);
    expect(reuniaoNaVista(antiga, "gravadas")).toBe(false);
    expect(reuniaoNaVista(naPasta, "youtube")).toBe(true);
    expect(reuniaoNaVista(naPasta, "importadas")).toBe(false);
    expect(reuniaoNaVista(naPasta, "pastas")).toBe(true);
    expect(reuniaoNaVista(antiga, "pastas")).toBe(false);
    expect(reuniaoNaVista(naPasta, "pastas", "p1")).toBe(true);
    expect(reuniaoNaVista(naPasta, "pastas", "p2")).toBe(false);
    expect(reuniaoNaVista(antiga, "pastas", "p1")).toBe(false);
  });
});

describe("a lixeira", () => {
  it("só a gravação em partes ainda no ar não vai para a lixeira; a excluída também não", () => {
    expect(podeIrParaALixeira({ status: "recording", audioPipeline: "slices" })).toBe(false);
    expect(podeIrParaALixeira({ status: "deleted", audioPipeline: "single" })).toBe(false);
    for (const status of ["ready", "failed", "processing", "uploading", "draft"]) {
      expect(podeIrParaALixeira({ status, audioPipeline: "slices" })).toBe(true);
    }
    // O envio único em 'recording' não tem parte nenhuma no servidor: pode.
    expect(podeIrParaALixeira({ status: "recording", audioPipeline: "single" })).toBe(true);
    expect(podeIrParaALixeira({ status: "recording" })).toBe(true);
  });

  it("o prazo: 30 dias contados da ida para a lixeira; restaurar vale até o último milissegundo antes do fim", () => {
    const foi = 1_000_000;
    expect(PRAZO_DA_LIXEIRA_MS).toBe(30 * DIA);
    expect(fimDoPrazoDaLixeira(foi)).toBe(foi + 30 * DIA);
    expect(dentroDoPrazoDaLixeira(foi, foi + 30 * DIA - 1)).toBe(true);
    expect(dentroDoPrazoDaLixeira(foi, foi + 30 * DIA)).toBe(false);
  });

  it("os dias que faltam, arredondados para cima: 30 na hora, 1 no último dia, 0 vencida", () => {
    const foi = 5_000_000;
    expect(diasRestantesNaLixeira(foi, foi)).toBe(30);
    expect(diasRestantesNaLixeira(foi, foi + 1)).toBe(30);
    expect(diasRestantesNaLixeira(foi, foi + DIA)).toBe(29);
    expect(diasRestantesNaLixeira(foi, foi + 29 * DIA + 1)).toBe(1);
    expect(diasRestantesNaLixeira(foi, foi + 30 * DIA)).toBe(0);
    expect(diasRestantesNaLixeira(foi, foi + 40 * DIA)).toBe(0);
    // Relógio do aparelho atrasado (a hora gravada no futuro): nunca mais de 30.
    expect(diasRestantesNaLixeira(foi, foi - 5 * DIA)).toBe(30);
  });
});
