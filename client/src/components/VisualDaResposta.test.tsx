import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { VisualDaResposta } from "./VisualDaResposta";
import type { GraficoDaResposta, TabelaDaResposta } from "@shared/resposta-visual";

/**
 * A resposta em forma visual do Pergunte (H6d) na tela: a tabela, as barras e
 * as linhas, desenhadas com os números que o servidor conferiu (a conferência
 * está em server/resposta-visual.test.ts). As vozes trocam pelo nome por
 * `comVozes`, e nada do visual vira HTML.
 */
const comVozes = (texto: string) => texto.replace("{F1}", "Ana").replace("{F2}", "Falante 2");

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

const TABELA: TabelaDaResposta = {
  tipo: "tabela", titulo: "Prazos de {F1}", colunas: ["Item", "Responsável", "Prazo"],
  linhas: [["Contrato", "{F1}", "sexta-feira"], ["Frete", "{F2}", ""], ["<b>Seguro</b>", "{F1}", "dia 12"]],
};
const BARRAS: GraficoDaResposta = {
  tipo: "barras", titulo: "Contêineres por porto", eixo: "Porto", unidade: "contêineres", rotulos: ["Santos", "Itajaí"],
  series: [{ nome: "Contêineres", valores: [12, 3] }],
};

describe("a tabela", () => {
  it("mostra o título, os cabeçalhos e as células, com as vozes trocadas pelo nome e um traço na célula vazia", () => {
    render(<VisualDaResposta visual={TABELA} comVozes={comVozes} />);
    const figura = screen.getByRole("figure", { name: "Prazos de Ana" });
    const tabela = within(figura).getByRole("table");
    expect(within(tabela).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Item", "Responsável", "Prazo"]);
    expect(within(tabela).getByRole("rowheader", { name: "Contrato" })).toBeInTheDocument();
    expect(within(tabela).getAllByText("Ana")).toHaveLength(2);
    expect(within(tabela).getByText("Falante 2")).toBeInTheDocument();
    expect(within(tabela).getByText("—")).toBeInTheDocument();
    // Sem "Ver como tabela": já é tabela.
    expect(screen.queryByRole("button", { name: "Ver como tabela" })).not.toBeInTheDocument();
  });

  it("o texto da IA é texto: uma marca de HTML aparece como letra, nunca vira elemento", () => {
    const { container } = render(<VisualDaResposta visual={TABELA} comVozes={comVozes} />);
    expect(screen.getByText("<b>Seguro</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("as barras", () => {
  it("cada item com a barra e o valor na ponta, no idioma da tela, com a unidade; uma série só, sem legenda", () => {
    render(<VisualDaResposta visual={BARRAS} comVozes={comVozes} />);
    const lista = screen.getByRole("list", { name: "Gráfico: Contêineres por porto" });
    expect(within(lista).getAllByRole("listitem")).toHaveLength(2);
    expect(within(lista).getByRole("img", { name: "Santos: 12 contêineres" })).toBeInTheDocument();
    expect(within(lista).getByText("3 contêineres")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Legenda" })).not.toBeInTheDocument();
  });

  it("a barra maior ocupa mais da faixa que a menor, a partir da mesma linha de base", () => {
    render(<VisualDaResposta visual={BARRAS} comVozes={comVozes} />);
    const largura = (nome: string) => parseFloat((screen.getByRole("img", { name: nome }) as HTMLElement).style.width);
    // 12 e 3 num eixo redondo de 0 a 15: 80% e 20% da faixa.
    expect(largura("Santos: 12 contêineres")).toBeCloseTo(80);
    expect(largura("Itajaí: 3 contêineres")).toBeCloseTo(20);
  });

  it("o foco (ou o mouse) numa barra mostra o valor; sair esconde", () => {
    render(<VisualDaResposta visual={BARRAS} comVozes={comVozes} />);
    const barra = screen.getByRole("img", { name: "Itajaí: 3 contêineres" });
    fireEvent.focus(barra);
    expect(screen.getByRole("tooltip")).toHaveTextContent("3 contêineres");
    fireEvent.blur(barra);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("com duas séries, a legenda aparece, e o valor não vai na ponta de cada barra (fica no foco e na tabela)", () => {
    const duas: GraficoDaResposta = { ...BARRAS, unidade: "", series: [{ nome: "2025", valores: [12, 3] }, { nome: "2026", valores: [15, 7] }] };
    render(<VisualDaResposta visual={duas} comVozes={comVozes} />);
    expect(within(screen.getByRole("list", { name: "Legenda" })).getAllByRole("listitem").map(i => i.textContent)).toEqual(["2025", "2026"]);
    expect(screen.getByRole("img", { name: "Santos · 2026: 15" })).toBeInTheDocument();
    expect(screen.queryByText("15")).not.toBeInTheDocument();
  });

  it("\"Ver como tabela\" mostra os mesmos números, na tabela; \"Ver como gráfico\" volta", () => {
    render(<VisualDaResposta visual={BARRAS} comVozes={comVozes} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver como tabela" }));
    const tabela = screen.getByRole("table");
    expect(within(tabela).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Porto", "Contêineres"]);
    expect(within(tabela).getByText("12 contêineres")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver como gráfico" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("em inglês, os números e os botões no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    render(<VisualDaResposta visual={{ ...BARRAS, unidade: "R$", series: [{ nome: "Valor", valores: [1200.5, 30] }] }} comVozes={comVozes} />);
    expect(screen.getByRole("img", { name: "Santos: R$ 1,200.5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show as table" })).toBeInTheDocument();
  });
});

describe("as linhas", () => {
  const LINHAS: GraficoDaResposta = {
    tipo: "linhas", titulo: "Pedidos por mês", eixo: "Mês", unidade: "", rotulos: ["março", "abril", "maio"],
    series: [{ nome: "Pedidos", valores: [10, 14, 9] }, { nome: "Entregas", valores: [8, 12, 11] }],
  };

  it("o gráfico é uma imagem com nome, com a legenda das duas séries e uma linha por série", () => {
    const { container } = render(<VisualDaResposta visual={LINHAS} comVozes={comVozes} />);
    expect(screen.getByRole("img", { name: "Gráfico: Pedidos por mês" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Legenda" })).getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(6);
  });

  it("o foco num ponto mostra o valor de todas as séries naquele ponto", () => {
    const { container } = render(<VisualDaResposta visual={LINHAS} comVozes={comVozes} />);
    const faixas = container.querySelectorAll("rect");
    expect(faixas[1].getAttribute("aria-label")).toBe("abril: Pedidos 14, Entregas 12");
    fireEvent.focus(faixas[1]);
    const dica = screen.getByRole("tooltip");
    expect(dica).toHaveTextContent("abril");
    expect(dica).toHaveTextContent("14");
    expect(dica).toHaveTextContent("12");
  });
});
