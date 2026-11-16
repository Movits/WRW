import { describe, expect, it } from "vitest";
import { nomesDosFalantes } from "@shared/const";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * A troca dos rótulos de voz do resumo guardado (H4): a IA escreve "{F2}", o
 * banco guarda o rótulo, e a tela mostra o nome que a dona deu à voz ou, sem
 * nome (e sempre no link aberto), o "Falante n" traduzido, que vem de quem
 * chama. O teste não depende do i18n: o rótulo é uma função qualquer.
 */
const falante = (n: number) => `Falante ${n}`;

describe("vozesNoTexto", () => {
  it("o rótulo vira o nome que a dona deu, e a voz sem nome vira 'Falante n'", () => {
    expect(vozesNoTexto("{F2} ficou de enviar a proposta para {F1}", { F2: "Carla" }, falante)).toBe("Carla ficou de enviar a proposta para Falante 1");
  });

  it("sem nomes (o link aberto), todas as vozes saem como 'Falante n', e o número vai inteiro", () => {
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
