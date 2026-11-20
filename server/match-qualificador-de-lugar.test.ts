// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import { describe, expect, it } from "vitest";
import { mesmoObjetoAMenosDoLugar, nomeiamAMesmaCoisa, saoConcorrentes } from "@shared/direcao-do-termo";
import { scoreMatch, slugifyMatchTag } from "./match-service";
import type { UserProfile } from "../drizzle/schema";

const { calculateCompatibilityScore } = await import("./matching");

/**
 * Qualificador de lugar nos motores (revisão de 17/11). No motor privado,
 * "Exportação de café" × "Importação de café do Brasil" dava 0, e
 * "Importação de café" dava 100: o "do Brasil" de um lado só zerava um par
 * legítimo. Lugar não é mercadoria. Sem ele, as duas pontas falam de café.
 *
 * O resto da regra continua valendo, e os negativos abaixo provam:
 * - nunca casar por palavra solta: o lugar em comum não basta ("Café do
 *   Brasil" × "Soja do Brasil");
 * - concorrentes zeram, com o lugar ou sem ele ("Exportar café" × "Exportar
 *   café do Brasil");
 * - a regra da direção: com direção declarada, lugar nunca é a mercadoria
 *   ("Importação da China" × "Exportação da China").
 *
 * As tags vêm sem categoria: com a mesma categoria, o par de produto que o
 * termo não casa vale os 60 da categoria, e o assunto aqui é o termo.
 */
const tag = (label: string) => ({ slug: slugifyMatchTag(label), label, category: null });
const nota = (ativo: string, necessidade: string) => scoreMatch(tag(ativo), tag(necessidade));

describe("motor privado: o lugar de um lado só não zera o par", () => {
  // [ativo, necessidade, ativo sem o lugar, necessidade sem o lugar]
  const pares: Array<[string, string, string, string]> = [
    // pt: origem, destino, onde, composto e coordenação
    ["Exportação de café", "Importação de café do Brasil", "Exportação de café", "Importação de café"],
    ["Exportação de café", "Importação de café para a Europa", "Exportação de café", "Importação de café"],
    ["Exportação de café", "Importação de café no Chile", "Exportação de café", "Importação de café"],
    ["Exportação de café do Brasil", "Importação de café", "Exportação de café", "Importação de café"],
    ["Exportação de café", "Importação de café à Europa", "Exportação de café", "Importação de café"],
    ["Exportação de café", "Importação de café da África do Sul", "Exportação de café", "Importação de café"],
    ["Exportação de café", "Importação de café em São Paulo", "Exportação de café", "Importação de café"],
    ["Exportar café", "Importar café do Brasil", "Exportar café", "Importar café"],
    ["Venda de vinho", "Compra de vinho no Chile", "Venda de vinho", "Compra de vinho"],
    ["Café do Brasil", "Café", "Café", "Café"],
    // o lado mais específico refina o outro
    ["Exportação de café do Brasil e da Colômbia", "Importação de café da Colômbia", "Exportação de café", "Importação de café"],
    ["Exportação de café do Brasil para a Europa", "Importação de café para a Europa", "Exportação de café", "Importação de café"],
    // en
    ["Export coffee", "Import coffee from Brazil", "Export coffee", "Import coffee"],
    ["Export coffee", "Import coffee to Europe", "Export coffee", "Import coffee"],
    ["Export coffee", "Import coffee in Chile", "Export coffee", "Import coffee"],
    ["Exports of coffee", "Imports of coffee to Europe", "Exports of coffee", "Imports of coffee"],
    ["Sell wine", "Buy wine in Chile", "Sell wine", "Buy wine"],
    ["Coffee from Brazil", "Coffee", "Coffee", "Coffee"],
    // es
    ["Exportación de café", "Importación de café de Brasil", "Exportación de café", "Importación de café"],
    ["Exportar café", "Importar café del Brasil", "Exportar café", "Importar café"],
    ["Exportación de café hacia Europa", "Importación de café", "Exportación de café", "Importación de café"],
    ["Exportación de café", "Importación de café a Europa", "Exportación de café", "Importación de café"],
    ["Vender vino", "Comprar vino en Chile", "Vender vino", "Comprar vino"],
    ["Venta de vino", "Compra de vino en Chile", "Venta de vino", "Compra de vino"],
  ];

  it.each(pares)("%s × %s vale 100, como %s × %s", (ativo, necessidade, ativoSemLugar, necessidadeSemLugar) => {
    expect(nota(ativoSemLugar, necessidadeSemLugar)).toEqual({ score: 100, type: "exact" });
    expect(nota(ativo, necessidade)).toEqual({ score: 100, type: "exact" });
    expect(nomeiamAMesmaCoisa(ativo, necessidade)).toBe(true);
  });

  it("a rota (a origem de um lado, o destino do outro) não se contradiz: 100", () => {
    for (const [ativo, necessidade] of [
      ["Exportação de café do Brasil", "Importação de café para a Europa"],
      ["Exportação de soja do Brasil", "Importação de soja para a China"],
      ["Export soy from Brazil", "Import soy to China"],
      ["Exportación de soja de Brasil", "Importación de soja hacia China"],
      ["Exportação de café do Brasil e da Colômbia", "Importação de café da Colômbia para a Europa"],
    ]) {
      expect(nota(ativo, necessidade), `${ativo} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
  });

  it("o mesmo serviço com o lugar de um lado só não é concorrência, como o par sem o lugar", () => {
    // "Exportação de café" × "Exportação de café" é o serviço pedido (100): com a origem dita, também.
    expect(nota("Exportação de café", "Exportação de café")).toEqual({ score: 100, type: "exact" });
    expect(saoConcorrentes("Exportação de café", "Exportação de café do Brasil")).toBe(false);
    expect(nota("Exportação de café", "Exportação de café do Brasil")).toEqual({ score: 100, type: "exact" });
    expect(mesmoObjetoAMenosDoLugar("cafe", "cafe-do-brasil")).toBe(true);
  });
});

describe("motor privado: o que o lugar não pode fazer casar continua em 0", () => {
  const zero = (ativo: string, necessidade: string) => expect(nota(ativo, necessidade).score, `${ativo} × ${necessidade}`).toBe(0);

  it("palavra solta não casa, nem o lugar em comum é a mercadoria", () => {
    for (const [ativo, necessidade] of [
      ["Café do Brasil", "Soja do Brasil"],
      ["Coffee from Brazil", "Soy from Brazil"],
      ["Café de Brasil", "Soja de Brasil"],
      ["Exportação de café do Brasil", "Importação de soja do Brasil"],
      ["Fornecedor da China", "Eletrônicos da China"],
      ["Brasil", "Café do Brasil"],
    ]) zero(ativo, necessidade);
    expect(nota("exportar", "exportar")).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
  });

  it("concorrentes zeram, com o lugar de um lado, dos dois, ou em pt, en e es", () => {
    for (const [ativo, necessidade] of [
      ["Exportar café", "Exportar café"],
      ["Exportar café", "Exportar café do Brasil"],
      ["Exportar café do Brasil", "Exportar café"],
      ["Exportar café do Brasil", "Exportar café para a Europa"],
      ["Exportação de café do Brasil", "Exportação de café da Colômbia"],
      ["Exportação para a Europa", "Exportação"],
      ["Export coffee", "Export coffee from Brazil"],
      ["Sell wine", "Sell wine in Chile"],
      ["Exportar café", "Exportar café a Europa"],
      ["Vender vino", "Vender vino en Chile"],
    ]) {
      expect(nota(ativo, necessidade), `${ativo} × ${necessidade}`).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
    }
  });

  it("com direção declarada, lugar não é a mercadoria: a regra da direção segue", () => {
    for (const [ativo, necessidade] of [
      ["Importação da China", "Exportação da China"],
      ["Exportação para a Europa", "Importação da Europa"],
      ["Exportação para a Europa", "Importação para a Europa"],
      ["Venda para a Europa", "Compra na Europa"],
      ["Export to Europe", "Import from Europe"],
      ["Exportar a Europa", "Importar de Europa"],
    ]) zero(ativo, necessidade);
    expect(nota("Exportação da China para a Europa", "Exportação da China")).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
  });

  it("lugares que se contradizem no mesmo papel, e o fluxo oposto, não casam", () => {
    for (const [ativo, necessidade] of [
      // a mesma mercadoria de origens diferentes
      ["Exportação de café do Brasil", "Importação de café da Colômbia"],
      ["Sell coffee from Brazil", "Buy coffee from Colombia"],
      ["Vender café de Brasil", "Comprar café de Colombia"],
      ["Exportação de café do Brasil para a China", "Importação de café da Colômbia para a China"],
      // o mesmo lugar como origem de um lado e destino do outro
      ["Exportação de café do Brasil", "Importação de café para o Brasil"],
      ["Exportação de peças para a China", "Importação de peças da China"],
      ["Export soy from Brazil", "Import soy into Brazil"],
      ["Exportación de soja de Brasil", "Importación de soja para Brasil"],
    ]) zero(ativo, necessidade);
  });

  it("'em', 'no', 'in' e 'en' dizem onde: só combinam com o mesmo papel, como antes", () => {
    zero("Exportação de café para a Europa", "Importação de café na Europa");
    zero("Exportação de café do Brasil", "Importação de café na Europa");
    // o mesmo "onde" dos dois lados casa
    expect(nota("Distribuidor no Chile", "Distribuidor no Chile")).toEqual({ score: 100, type: "exact" });
  });

  it("o idioma depois da preposição não é lugar: 'Tradução de alemão' segue como antes", () => {
    expect(nota("Tradução de alemão", "Tradutor de japonês")).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    expect(nota("Tradução de alemão", "Tradução")).toEqual({ score: 60, type: "category" });
  });
});

describe("motor de perfis: o mesmo qualificador conta como necessidade atendida", () => {
  // Só o perfil estratégico, como em complementaridade.test.ts: as outras cinco dimensões ficam nos padrões.
  const perfil = (whatIHave: string[], whatINeed: string[]) => ({ whatIHave, whatINeed } as unknown as UserProfile);

  it("'Exportação de café' atende 'Importação de café do Brasil' como atende 'Importação de café'", () => {
    const semLugar = calculateCompatibilityScore(perfil(["Exportação de café"], []), perfil([], ["Importação de café"]));
    const comLugar = calculateCompatibilityScore(perfil(["Exportação de café"], []), perfil([], ["Importação de café do Brasil"]));
    // uma via: 45 + 15 × 1
    expect(semLugar.complementarity).toBe(60);
    expect(comLugar).toEqual(semLugar);
  });

  it("o lugar em comum não é necessidade atendida", () => {
    const r = calculateCompatibilityScore(perfil(["Café do Brasil"], []), perfil([], ["Soja do Brasil"]));
    // tem dado, sem encaixe
    expect(r.complementarity).toBe(20);
  });

  it("tirar o lugar não junta concorrentes: o motor de perfis não ganha encaixe novo entre duas pontas do mesmo lado", () => {
    // O motor de perfis não aplica a regra dos concorrentes (server/CLAUDE.md, decisão de produto em aberto), e o
    // qualificador não pode aumentar o que ele já deixa passar: estes pares davam 20 antes do qualificador e seguem em
    // 20, enquanto o motor privado os zera como concorrentes.
    for (const [tenho, preciso] of [
      ["Exportar café", "Exportar café do Brasil"],
      ["Exportar café do Brasil", "Exportar café para a Europa"],
      ["Export wine", "Export wine in Chile"],
      ["Buy coffee", "Buy coffee from Angola"],
      ["Import wine from Angola", "Import wine into Brazil"],
      ["Vender vino", "Vender vino en Chile"],
      ["Exportar soja del Brasil", "Exportar soja hacia Europa"],
    ]) {
      expect(nota(tenho, preciso), `${tenho} × ${preciso}`).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
      expect(nomeiamAMesmaCoisa(tenho, preciso), `${tenho} × ${preciso}`).toBe(false);
      expect(calculateCompatibilityScore(perfil([tenho], []), perfil([], [preciso])).complementarity, `${tenho} × ${preciso}`).toBe(20);
    }
    // O serviço escrito igual dos dois lados não é concorrência, com o lugar ou sem ele: segue atendido.
    expect(nomeiamAMesmaCoisa("Exportação de café", "Exportação de café do Brasil")).toBe(true);
    expect(calculateCompatibilityScore(perfil(["Exportação de café"], []), perfil([], ["Exportação de café do Brasil"])).complementarity).toBe(60);
  });
});
