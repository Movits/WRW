import { describe, expect, it } from "vitest";
import { nomesDosFalantes } from "@shared/const";
import { partesComVozes, vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * A troca dos rótulos de voz do resumo guardado (H4): a IA escreve "{F2}", o
 * banco guarda o rótulo, e a tela mostra o nome que a dona deu à voz (também
 * no link aberto ligado com a confirmação que fala dos nomes, H3b) ou, sem
 * nome, o "Falante n" traduzido, que vem de quem chama. O teste não depende do
 * i18n: o rótulo é uma função qualquer.
 */
const falante = (n: number) => `Falante ${n}`;

describe("vozesNoTexto", () => {
  it("o rótulo vira o nome que a dona deu, e a voz sem nome vira 'Falante n'", () => {
    expect(vozesNoTexto("{F2} ficou de enviar a proposta para {F1}", { F2: "Carla" }, falante)).toBe("Carla ficou de enviar a proposta para Falante 1");
  });

  it("sem nomes (o link ligado antes da confirmação que fala deles), todas as vozes saem como 'Falante n', e o número vai inteiro", () => {
    expect(vozesNoTexto("{F1}, {F12} e {F99} combinaram", {}, falante)).toBe("Falante 1, Falante 12 e Falante 99 combinaram");
  });

  it("os nomes vêm de nomesDosFalantes: o par inválido do JSON da coluna não vale, e o nome sai aparado", () => {
    const nomes = nomesDosFalantes({ F1: "  Ana  ", F2: "   ", "Falante 3": "Bia", F3: 7 });
    expect(vozesNoTexto("{F1}, {F2} e {F3}", nomes, falante)).toBe("Ana, Falante 2 e Falante 3");
  });

  it("nome vazio passado direto também cai no rótulo traduzido", () => {
    expect(vozesNoTexto("{F1} abriu", { F1: "  " }, falante)).toBe("Falante 1 abriu");
  });

  it("só o rótulo exato troca: sem chaves, {F0}, {F100} e {f1} ficam como estão", () => {
    const texto = "F1 disse, {F0}, {F100}, {f1} e { F1 } ficam";
    expect(vozesNoTexto(texto, { F1: "Ana" }, falante)).toBe(texto);
  });

  it("um nome com padrões de substituição ($&, $1) entra como está", () => {
    expect(vozesNoTexto("{F1} pagou", { F1: "Ana $& $1 $$" }, falante)).toBe("Ana $& $1 $$ pagou");
  });

  it("texto sem rótulo fica igual, e o rótulo traduzido recebe o número da voz", () => {
    expect(vozesNoTexto("Fechar o contrato até sexta", { F1: "Ana" }, falante)).toBe("Fechar o contrato até sexta");
    const pedidos: number[] = [];
    vozesNoTexto("{F7} e {F3}", {}, n => { pedidos.push(n); return "?"; });
    expect(pedidos).toEqual([7, 3]);
  });
});

/**
 * A mesma troca em pedaços, para a tela isolar a direção de cada voz (<bdi>):
 * o rótulo em árabe no começo de um item em inglês não vira a direção dele.
 */
describe("partesComVozes", () => {
  const rotuloArabe = (n: number) => `المتحدث ${n}`;

  it("cada voz vem separada do texto, com o nome dado ou o rótulo traduzido", () => {
    expect(partesComVozes("{F2} evaluated two locations with {F1}.", { F1: "Ana" }, rotuloArabe)).toEqual([
      { texto: "المتحدث 2", voz: true },
      { texto: " evaluated two locations with ", voz: false },
      { texto: "Ana", voz: true },
      { texto: ".", voz: false },
    ]);
  });

  it("juntos, os pedaços dão o mesmo texto de vozesNoTexto, também com vozes coladas e rótulos que não trocam", () => {
    const casos = ["{F1}{F2} combinaram", "Fechar o contrato até sexta", "F1 disse, {F0}, {F100}, {f1} e {F12}", "", "{F3}"];
    for (const texto of casos) {
      const nomes = { F1: "  Ana  ", F2: "   " };
      expect(partesComVozes(texto, nomes, falante).map(parte => parte.texto).join("")).toBe(vozesNoTexto(texto, nomes, falante));
    }
    expect(partesComVozes("{F1}{F2} combinaram", {}, falante).filter(parte => parte.voz)).toHaveLength(2);
    expect(partesComVozes("", {}, falante)).toEqual([]);
  });

  it("um nome com padrões de substituição ($&, $1) entra como está, e o rótulo recebe o número da voz", () => {
    expect(partesComVozes("{F1} pagou", { F1: "Ana $& $1" }, falante)).toEqual([{ texto: "Ana $& $1", voz: true }, { texto: " pagou", voz: false }]);
    const pedidos: number[] = [];
    partesComVozes("{F7} e {F3}", {}, n => { pedidos.push(n); return "?"; });
    expect(pedidos).toEqual([7, 3]);
  });
});
