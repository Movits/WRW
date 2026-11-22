import { describe, expect, it, vi } from "vitest";
import { avisarDoVisual, instrucoesDoVisual, SCHEMA_DO_VISUAL, textoDoVisual, visualConferido } from "./resposta-visual";
import { LINHAS_DO_VISUAL_MAX, numeroDaCelula } from "@shared/resposta-visual";

/**
 * A resposta em forma visual do Pergunte (H6d), sem IA nem banco: o esquema
 * fixo, o número da célula, a limpeza do texto e a conferência do que a IA
 * devolve (a forma, os números e as vozes). Quem a usa de ponta a ponta está
 * em reuniao-com-ia.test.ts e perguntar-a-varias-reunioes.integracao.test.ts.
 */

// As vozes como a pergunta a uma reunião confere: só {F1} e {F2} existem.
const vozesDaReuniao = (texto: string) => (/\{F(?![12]\})\d+\}/.test(texto) ? null : texto);
const linhas = (...celulas: string[][]) => celulas.map(c => ({ celulas: c }));
const tabela = (extra: Record<string, unknown> = {}) => ({
  tipo: "tabela", titulo: "Prazos combinados", unidade: "",
  colunas: ["Item", "Responsável", "Prazo"],
  linhas: linhas(["Contrato", "{F1}", "sexta-feira"], ["Frete", "{F2}", "dia 12"]),
  ...extra,
});

describe("o número de uma célula de série", () => {
  it("só o número, com o ponto decimal; a vírgula decimal sozinha também vale", () => {
    expect(numeroDaCelula("1200")).toBe(1200);
    expect(numeroDaCelula(" -3.5 ")).toBe(-3.5);
    expect(numeroDaCelula("3,5")).toBe(3.5);
  });

  it("o que não é só o número fica null: o gráfico não adivinha", () => {
    for (const celula of ["1.200,50", "1,200.50", "R$ 10", "10%", "dez", "", "1e9", "Infinity", "NaN"]) expect(numeroDaCelula(celula)).toBeNull();
  });

  it("número grande demais para ser de conversa fica null", () => {
    expect(numeroDaCelula("9999999999999999")).toBeNull();
  });
});

describe("o texto do visual", () => {
  it("sai sem HTML, sem Markdown e sem controle; o texto de dentro fica", () => {
    expect(textoDoVisual("<b>Ana</b> e **Bia**", 80)).toBe("Ana e Bia");
    expect(textoDoVisual("<script>alert(1)</script>Prazo", 80)).toBe("alert(1)Prazo");
    expect(textoDoVisual("linha 1\nlinha\t2", 80)).toBe("linha 1 linha 2");
    expect(textoDoVisual("`código`", 80)).toBe("código");
  });

  it("o que não é texto vira vazio", () => {
    expect(textoDoVisual(42, 80)).toBe("");
    expect(textoDoVisual(null, 80)).toBe("");
  });

  it("cortado por caractere, sem meio rótulo de voz no fim nem emoji partido", () => {
    expect(textoDoVisual("abc {F12}", 6)).toBe("abc");
    expect(textoDoVisual("abc {R2:F1}", 8)).toBe("abc");
    expect(textoDoVisual("👍👍👍", 2)).toBe("👍👍");
  });
});

describe("o esquema e as instruções", () => {
  it("o esquema é fixo: tipo de uma lista, colunas e linhas de texto, com os limites", () => {
    expect(SCHEMA_DO_VISUAL.properties.tipo.enum).toEqual(["nenhum", "tabela", "barras", "linhas"]);
    expect(SCHEMA_DO_VISUAL.required).toEqual(["tipo", "titulo", "unidade", "colunas", "linhas"]);
    expect(SCHEMA_DO_VISUAL.properties.linhas.maxItems).toBe(LINHAS_DO_VISUAL_MAX);
    expect(SCHEMA_DO_VISUAL.additionalProperties).toBe(false);
  });

  it("as instruções pedem o visual só quando a pergunta pede, sem HTML nem código, e dizem como pôr a voz", () => {
    const comRotulo = instrucoesDoVisual("rotulo").join("\n");
    expect(comRotulo).toContain("só quando a pergunta pede");
    expect(comRotulo).toContain("não leva HTML, Markdown nem código");
    expect(comRotulo).toContain("({F2})");
    expect(instrucoesDoVisual("rotulo_com_reuniao").join("\n")).toContain("({R2:F1})");
    expect(instrucoesDoVisual("sem_vozes").join("\n")).toContain("Não use rótulos de voz");
  });
});

describe("a conferência do visual", () => {
  it("sem visual (nenhum, ausente ou tipo desconhecido): null, sem motivo", () => {
    expect(visualConferido({ tipo: "nenhum", titulo: "", unidade: "", colunas: [], linhas: [] }, vozesDaReuniao)).toEqual({ visual: null, motivo: null, tipoPedido: null });
    expect(visualConferido(undefined, vozesDaReuniao).visual).toBeNull();
    expect(visualConferido({ tipo: "pizza", colunas: ["a", "b"], linhas: linhas(["x", "1"]) }, vozesDaReuniao)).toMatchObject({ visual: null, motivo: null });
  });

  it("a tabela passa como veio, com o texto limpo e as vozes como rótulo", () => {
    const { visual, motivo } = visualConferido(tabela({ titulo: "<i>Prazos</i> combinados" }), vozesDaReuniao);
    expect(motivo).toBeNull();
    expect(visual).toEqual({
      tipo: "tabela", titulo: "Prazos combinados", colunas: ["Item", "Responsável", "Prazo"],
      linhas: [["Contrato", "{F1}", "sexta-feira"], ["Frete", "{F2}", "dia 12"]],
    });
  });

  it("a linha toda vazia sai; a célula vazia fica (a tela mostra um traço)", () => {
    const { visual } = visualConferido(tabela({ linhas: linhas(["Contrato", "", "sexta"], ["", " ", ""]) }), vozesDaReuniao);
    expect(visual).toMatchObject({ linhas: [["Contrato", "", "sexta"]] });
  });

  it("forma errada derruba o visual: uma coluna só, colunas demais, cabeçalho vazio, linha com outro tamanho, linhas demais, nenhuma linha", () => {
    const casos = [
      tabela({ colunas: ["Item"], linhas: linhas(["Contrato"]) }),
      tabela({ colunas: ["a", "b", "c", "d", "e", "f"], linhas: linhas(["1", "2", "3", "4", "5", "6"]) }),
      tabela({ colunas: ["Item", " ", "Prazo"] }),
      tabela({ linhas: linhas(["Contrato", "{F1}"]) }),
      tabela({ linhas: Array.from({ length: LINHAS_DO_VISUAL_MAX + 1 }, (_, i) => ({ celulas: [`i${i}`, "x", "y"] })) }),
      tabela({ linhas: [] }),
      tabela({ linhas: [{ outra: ["a", "b", "c"] }] }),
    ];
    for (const caso of casos) expect(visualConferido(caso, vozesDaReuniao)).toMatchObject({ visual: null, motivo: "forma", tipoPedido: "tabela" });
  });

  it("a voz que a entrada não tem derruba o visual (no título, no cabeçalho ou na célula)", () => {
    expect(visualConferido(tabela({ linhas: linhas(["Contrato", "{F7}", "sexta"]) }), vozesDaReuniao)).toMatchObject({ visual: null, motivo: "voz" });
    expect(visualConferido(tabela({ titulo: "O que {F9} pediu" }), vozesDaReuniao)).toMatchObject({ visual: null, motivo: "voz" });
    expect(visualConferido(tabela({ colunas: ["Item", "{F3}", "Prazo"] }), vozesDaReuniao)).toMatchObject({ visual: null, motivo: "voz" });
  });

  it("as barras: a primeira coluna é o nome de cada item, as outras viram séries de números", () => {
    const { visual, motivo } = visualConferido({
      tipo: "barras", titulo: "Contêineres por porto", unidade: "contêineres",
      colunas: ["Porto", "2025", "2026"], linhas: linhas(["Santos", "12", "15"], ["Paranaguá", "4.5", "7"]),
    }, vozesDaReuniao);
    expect(motivo).toBeNull();
    expect(visual).toEqual({
      tipo: "barras", titulo: "Contêineres por porto", eixo: "Porto", unidade: "contêineres", rotulos: ["Santos", "Paranaguá"],
      series: [{ nome: "2025", valores: [12, 4.5] }, { nome: "2026", valores: [15, 7] }],
    });
  });

  it("número fora do formato: o gráfico vira tabela, com o texto como a IA escreveu", () => {
    const conferido = visualConferido({
      tipo: "barras", titulo: "Valores", unidade: "R$", colunas: ["Item", "Valor"], linhas: linhas(["Frete", "1.200,50"], ["Seguro", "300"]),
    }, vozesDaReuniao);
    expect(conferido).toMatchObject({ motivo: "numero", tipoPedido: "barras", visual: { tipo: "tabela", linhas: [["Frete", "1.200,50"], ["Seguro", "300"]] } });
  });

  it("a linha do tempo com um ponto só vira tabela; com dois, é linha", () => {
    const umPonto = { tipo: "linhas", titulo: "Pedidos", unidade: "", colunas: ["Mês", "Pedidos"], linhas: linhas(["março", "10"]) };
    expect(visualConferido(umPonto, vozesDaReuniao)).toMatchObject({ motivo: "pontos", visual: { tipo: "tabela" } });
    const doisPontos = { ...umPonto, linhas: linhas(["março", "10"], ["abril", "14"]) };
    expect(visualConferido(doisPontos, vozesDaReuniao)).toMatchObject({ motivo: null, visual: { tipo: "linhas", rotulos: ["março", "abril"], series: [{ nome: "Pedidos", valores: [10, 14] }] } });
  });

  it("o item sem nome não entra no gráfico: vira tabela", () => {
    const conferido = visualConferido({ tipo: "barras", titulo: "", unidade: "", colunas: ["Item", "Qtd"], linhas: linhas(["", "3"], ["Café", "5"]) }, vozesDaReuniao);
    expect(conferido).toMatchObject({ motivo: "numero", visual: { tipo: "tabela" } });
  });

  it("o log do visual que não foi como veio diz o motivo e o tipo, nunca o conteúdo", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    avisarDoVisual("Pergunte", visualConferido(tabela({ linhas: linhas(["Contrato", "{F7}", "sexta-feira secreta"]) }), vozesDaReuniao));
    avisarDoVisual("Pergunte", visualConferido(tabela(), vozesDaReuniao));
    expect(aviso.mock.calls.map(chamada => chamada.join(" "))).toEqual(["[Pergunte] visual fora da tela (voz): a IA pediu tabela"]);
    aviso.mockRestore();
  });
});
