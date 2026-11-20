import { describe, expect, it } from "vitest";
import { MARCA_DO_DESTINATARIO, preencherRascunho, vozDoDestinatario, vozesSemNome } from "@shared/email-de-retorno";

/**
 * As funções puras do rascunho de e-mail de retorno (H20,
 * shared/email-de-retorno.ts), que a tela usa: o nome digitado no lugar da
 * marca, os nomes das vozes no lugar dos rótulos, a voz de quem recebe e as
 * vozes que ficaram sem nome.
 */

const rotulo = (n: number) => `Falante ${n}`;

describe("preencherRascunho", () => {
  it("a marca vira o nome digitado (aparado), e os rótulos, os nomes que a dona deu", () => {
    expect(preencherRascunho(`Olá, ${MARCA_DO_DESTINATARIO}! {F1} manda a minuta; {F2} confirma.`, "  Carla ", { F1: "Ana" }, rotulo))
      .toBe("Olá, Carla! Ana manda a minuta; Falante 2 confirma.");
  });

  it("a marca aparece mais de uma vez: todas viram o nome", () => {
    expect(preencherRascunho(`${MARCA_DO_DESTINATARIO}, ${MARCA_DO_DESTINATARIO}`, "Bia", {}, rotulo)).toBe("Bia, Bia");
  });

  it("uma passada só: o nome digitado com um rótulo ou com a marca não é trocado de novo", () => {
    expect(preencherRascunho(`Olá, ${MARCA_DO_DESTINATARIO}. {F1}`, "{F1}", { F1: "Ana" }, rotulo)).toBe("Olá, {F1}. Ana");
    expect(preencherRascunho("{F1} e {F2}", "x", { F1: MARCA_DO_DESTINATARIO, F2: "$& e $1" }, rotulo)).toBe(`${MARCA_DO_DESTINATARIO} e $& e $1`);
  });

  it("sem marca e sem rótulo, o texto fica igual", () => {
    expect(preencherRascunho("Obrigada pela conversa.\n\nAbraços,", "Carla", { F1: "Ana" }, rotulo)).toBe("Obrigada pela conversa.\n\nAbraços,");
  });
});

describe("vozesSemNome", () => {
  it("as vozes citadas sem nome, sem repetir e em ordem; nome só de espaços não vale", () => {
    expect(vozesSemNome("{F3} e {F1} e {F12}; de novo {F3}; {F2}", { F1: "Ana", F2: "   " })).toEqual([2, 3, 12]);
  });

  it("todas com nome, ou nenhuma citada: nada a avisar", () => {
    expect(vozesSemNome("{F1} manda a minuta", { F1: "Ana" })).toEqual([]);
    expect(vozesSemNome("Obrigada pela conversa.", {})).toEqual([]);
  });

  it("só o rótulo exato conta: F1 solto, {F0} e {f1} não", () => {
    expect(vozesSemNome("F1, {F0} e {f1}", {})).toEqual([]);
  });
});

describe("vozDoDestinatario", () => {
  const NOMES = { F1: "Ana Souza", F2: "Bruno", F3: "bruno", F4: "Carla" };

  it("o nome de uma voz, sem diferença de caixa nem de espaços, identifica a voz", () => {
    expect(vozDoDestinatario("ana  souza", NOMES)).toBe("F1");
    expect(vozDoDestinatario("  CARLA ", NOMES)).toBe("F4");
  });

  it("nome de duas vozes, nome de nenhuma ou vazio: ninguém", () => {
    expect(vozDoDestinatario("Bruno", NOMES)).toBeUndefined();
    expect(vozDoDestinatario("Ana", NOMES)).toBeUndefined();
    expect(vozDoDestinatario("   ", NOMES)).toBeUndefined();
    expect(vozDoDestinatario("Ana Souza", {})).toBeUndefined();
  });
});
