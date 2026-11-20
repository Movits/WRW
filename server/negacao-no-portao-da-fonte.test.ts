import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * A negação no portão da fonte (revisão de 17/11). Três buracos deixavam a
 * necessidade NEGADA passar como declarada, e com ela chegar às conexões:
 *
 * 1. A negação contraída do inglês ("don't", "doesn't", "won't",
 *    "wouldn't") virava as unidades "don" e "t", que nenhuma lista conhecia.
 *    Agora ela chega aberta ("do not") e o "dont" sem apóstrofo está na lista.
 * 2. O "no" do espanhol não negava: em português ele é "em + o" ("no Chile").
 *    Agora ele nega diante de verbo ("no necesitamos", "no hay"), e o do
 *    inglês diante de "need" e "longer"; diante de outra palavra, segue o do
 *    português.
 * 3. O verbo de necessidade negado contava como menção neutra: com a negação
 *    a mais de três palavras do item ("não precisamos MESMO DE UM
 *    distribuidor"), o trecho não era desmentido e o item passava.
 */

const { filtrarPelaFonte, necessidadeHipotetica, necessidadeNaoDeclarada, textoSustentadoPeloTrecho, trechoEstaNaFonte } = await import("./network-extracao");

const item = (texto: string, trecho: string) => ({ texto, trecho, confianca: 0.9 });
const proposta = (oQuePreciso: ReturnType<typeof item>[], oQueTenho: ReturnType<typeof item>[] = []) => ({
  quemSou: { tipoPessoa: "nao_informado" as const, nome: null, telefone: null, email: null }, oQueTenho, oQuePreciso,
});
const precisoQueFica = (texto: string, trecho: string, fonte: string) =>
  filtrarPelaFonte(proposta([item(texto, trecho)]), fonte).oQuePreciso.map(ficou => ficou.texto);
const tenhoQueFica = (texto: string, trecho: string, fonte: string) =>
  filtrarPelaFonte(proposta([], [item(texto, trecho)]), fonte).oQueTenho.map(ficou => ficou.texto);

describe("a necessidade negada não passa como declarada", () => {
  it.each([
    // en, contraída
    ["Distributor in Chile", "need a distributor in Chile", "We don't need a distributor in Chile."],
    ["Distributor in Chile", "distributor in Chile", "We don't need a distributor in Chile."],
    ["Distributor in Chile", "don't need a distributor in Chile", "We don't need a distributor in Chile."],
    ["Accountant", "need an accountant", "She doesn't need an accountant."],
    ["Accountant", "need an accountant", "We wouldn't need an accountant."],
    ["Accountant", "need an accountant", "We won't need an accountant."],
    ["Accountant", "need an accountant", "We didn't need an accountant."],
    ["Accountant", "need an accountant", "We don’t need an accountant."],
    ["Accountant", "need an accountant", "We dont need an accountant."],
    // en, por extenso e com "no"
    ["Accountant", "need an accountant", "We do not need an accountant."],
    ["Accountant", "need for an accountant", "We have no need for an accountant."],
    ["Distributor in Chile", "need a distributor in Chile", "We no longer need a distributor in Chile."],
    // pt
    ["Contador", "precisamos de um contador", "Não precisamos de um contador."],
    ["Contador", "precisamos de contador", "Nós nunca precisamos de contador."],
    // es
    ["Contador", "necesitamos un contador", "No necesitamos un contador."],
    ["Distribuidor en Chile", "buscamos un distribuidor en Chile", "No buscamos un distribuidor en Chile."],
    ["Contador", "hace falta un contador", "No nos hace falta un contador."],
    ["Contador", "es necesario un contador", "No es necesario un contador."],
    ["Contador", "necesitamos ningún contador", "No necesitamos ningún contador."],
  ])("'%s' de '%s' cai: %s", (texto, trecho, fonte) => {
    expect(precisoQueFica(texto, trecho, fonte)).toEqual([]);
  });

  it.each([
    ["Distributor in Chile", "distributor in Chile", "We don't really need a distributor in Chile."],
    ["Distributor in Chile", "distributor in Chile", "We do not actually need a distributor in Chile."],
    ["Distribuidor no Chile", "distribuidor no Chile", "Não precisamos mesmo de um distribuidor no Chile."],
    ["Distribuidor en Chile", "distribuidor en Chile", "No necesitamos todavía un distribuidor en Chile."],
  ])("o verbo negado longe do item também derruba '%s' (trecho '%s'): %s", (texto, trecho, fonte) => {
    // A negação está a mais de três palavras do item: a ocorrência não é desmentida, e é o verbo que liga as duas.
    expect(trechoEstaNaFonte(trecho, fonte)).toBe(true);
    expect(necessidadeNaoDeclarada(texto, trecho, fonte)).toBe(true);
    // Negada não é hipotética: a resposta de necessidadeHipotetica não muda.
    expect(necessidadeHipotetica(texto, trecho, fonte)).toBe(false);
    expect(precisoQueFica(texto, trecho, fonte)).toEqual([]);
  });

  it("a ocorrência declarada sustenta o item, e a negada sozinha não", () => {
    const fonte = "Não precisamos mesmo de um distribuidor no Chile. Brincadeira: precisamos de um distribuidor no Chile já.";
    expect(precisoQueFica("Distribuidor no Chile", "distribuidor no Chile", fonte)).toEqual(["Distribuidor no Chile"]);
    // a menção neutra não salva a negada
    const negadaENeutra = "Não precisamos mesmo de um distribuidor no Chile. Conheci um distribuidor no Chile ano passado.";
    expect(precisoQueFica("Distribuidor no Chile", "distribuidor no Chile", negadaENeutra)).toEqual([]);
  });
});

describe("o que não é negação continua passando", () => {
  it.each([
    ["Distributor in Chile", "need a distributor in Chile", "We need a distributor in Chile."],
    ["Distribuidor no Chile", "precisamos de um distribuidor no Chile", "Precisamos de um distribuidor no Chile."],
    ["Distribuidor en Chile", "necesitamos un distribuidor en Chile", "Necesitamos un distribuidor en Chile."],
    // o "t" sem apóstrofo não é negação
    ["T-shirts for the event", "need T-shirts for the event", "We need T-shirts for the event."],
    // o "no" do português é "em + o", mesmo antes do verbo da frase
    ["Contador", "precisamos de um contador", "No Brasil precisamos de um contador."],
    ["Contador", "precisamos de um contador", "No ES precisamos de um contador."],
    ["Distribuidor", "precisamos de um distribuidor", "No nosso caso, precisamos de um distribuidor."],
    // "não só", "not just" e "no solo" não negam
    ["Distribuidor", "precisamos de um distribuidor", "Não só precisamos de um distribuidor, como de um sócio."],
    ["Distributor", "need a distributor", "We don't just need a distributor, we need a partner."],
    ["Socio", "necesitamos un socio", "No solo necesitamos un socio."],
    // a negação de outra oração, ou de outro verbo distante, não alcança
    ["Accountant", "we need an accountant", "We don't need a distributor. We need an accountant."],
    ["Contador", "necesitamos un contador", "No necesitamos un distribuidor, pero necesitamos un contador."],
    ["Distribuidor no Chile", "precisamos de um distribuidor no Chile", "Não precisamos de contador e precisamos de um distribuidor no Chile."],
  ])("'%s' de '%s' fica: %s", (texto, trecho, fonte) => {
    expect(precisoQueFica(texto, trecho, fonte)).toEqual([texto]);
  });

  it("a restrição com a negação contraída segue restrição, sem trocar de lado", () => {
    const fonte = "We need a supplier that doesn't use plastic.";
    expect(textoSustentadoPeloTrecho("Supplier that doesn't use plastic", "a supplier that doesn't use plastic", fonte)).toBe(true);
    expect(textoSustentadoPeloTrecho("Supplier that does not use plastic", "a supplier that doesn't use plastic", fonte)).toBe(true);
    expect(textoSustentadoPeloTrecho("Plastic supplier", "a supplier that doesn't use plastic", fonte)).toBe(false);
  });
});

describe("o 'tenho' negado também cai", () => {
  it.each([
    ["Distributor in Chile", "distributor in Chile", "We don't have a distributor in Chile."],
    ["Distribuidor en Chile", "distribuidor en Chile", "No tenemos distribuidor en Chile."],
    ["Distribuidor en Chile", "distribuidor en Chile", "Todavía no hay distribuidor en Chile."],
  ])("'%s' de '%s' cai: %s", (texto, trecho, fonte) => {
    expect(tenhoQueFica(texto, trecho, fonte)).toEqual([]);
  });

  it("o afirmado fica", () => {
    expect(tenhoQueFica("T-shirts", "we sell T-shirts", "We sell T-shirts.")).toEqual(["T-shirts"]);
    expect(tenhoQueFica("Distribuidor en Chile", "tenemos distribuidor en Chile", "Tenemos distribuidor en Chile.")).toEqual(["Distribuidor en Chile"]);
  });
});
