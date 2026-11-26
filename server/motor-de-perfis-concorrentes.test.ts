// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` garante um valor mesmo no CI.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import { describe, expect, it } from "vitest";
import { slugDoTermo } from "@shared/direcao-do-termo";
import { scoreMatch } from "./match-service";
import type { UserProfile } from "../drizzle/schema";

const { calculateCompatibilityScore } = await import("./matching");

/**
 * N6 — uniformizar os motores (decisão do Roberto de 11/11). O motor de PERFIS
 * passa a aplicar as duas regras que o motor privado já aplicava:
 * - concorrentes zeram: duas pontas com direção explícita para o mesmo lado
 *   (`saoConcorrentes`) não são necessidade atendida;
 * - nada casa por palavra solta: "exportar" × "exportar" não casa, "exportar
 *   vinho" × "importar vinho" casa.
 *
 * Até o N6, `satisfaz` (server/matching.ts) devolvia `true` no texto igual e no
 * slug igual sem perguntar pelos concorrentes, e o par ainda subia a
 * complementaridade, a dimensão de maior peso (30).
 *
 * Perfis mínimos: com o resto nulo, a complementaridade decide. Uma via
 * atendida vale 60 (45 + 15 × 1); "tem dado, sem encaixe" vale 20.
 */
const perfil = (whatIHave: string[] | null, whatINeed: string[] | null) =>
  ({ whatIHave, whatINeed } as unknown as UserProfile);

/** A complementaridade de A (que tem `tenho`) diante de B (que precisa de `preciso`). */
const complementaridade = (tenho: string, preciso: string) =>
  calculateCompatibilityScore(perfil([tenho], []), perfil([], [preciso])).complementarity;

const ATENDIDA = 60;
const SEM_ENCAIXE = 20;

const nota = (tenho: string, preciso: string) =>
  scoreMatch({ label: tenho, slug: slugDoTermo(tenho), category: null }, { label: preciso, slug: slugDoTermo(preciso), category: null });

describe("N6 — o motor de perfis aplica a regra dos concorrentes", () => {
  it("os exemplos da regra: \"exportar vinho\" × \"importar vinho\" casa; \"exportar\" × \"exportar\" não", () => {
    expect(complementaridade("exportar vinho", "importar vinho")).toBe(ATENDIDA);
    expect(complementaridade("Exportar vinho", "Importar vinho")).toBe(ATENDIDA);
    // Antes do N6 os dois davam 60: texto igual passava direto em `satisfaz`.
    expect(complementaridade("exportar", "exportar")).toBe(SEM_ENCAIXE);
    expect(complementaridade("Exportar vinho", "Exportar vinho")).toBe(SEM_ENCAIXE);
  });

  it("concorrentes não se atendem pelo texto igual nem pelo slug igual, em pt, en e es", () => {
    for (const [tenho, preciso] of [
      ["exportar", "exportar"],
      ["Exportar", "exportar"],
      ["Exportar café", "Exportar café"],
      ["Exportar café", "exportar  café"],
      ["Importar vinho", "Importar vinho"],
      ["Vender soja", "Vender soja"],
      ["Comprar soja", "Comprar soja"],
      ["Exportação", "Exportação"],
      ["Export coffee", "Export coffee"],
      ["Buy coffee", "buy coffee"],
      ["Vender vino", "Vender vino"],
    ]) {
      expect(nota(tenho, preciso), `${tenho} × ${preciso}`).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
      expect(complementaridade(tenho, preciso), `${tenho} × ${preciso}`).toBe(SEM_ENCAIXE);
    }
  });

  it("o par mútuo de concorrentes deixa de valer o encaixe mais forte", () => {
    // As duas exportam vinho e as duas escreveram que precisam exportar vinho: antes do N6, mútuo (75).
    const r = calculateCompatibilityScore(perfil(["Exportar vinho"], ["Exportar vinho"]), perfil(["Exportar vinho"], ["Exportar vinho"]));
    expect(r.complementarity).toBe(SEM_ENCAIXE);
    // Com direções opostas, o mútuo continua.
    const negocio = calculateCompatibilityScore(perfil(["Exportar vinho"], ["Importar café"]), perfil(["Exportar café"], ["Importar vinho"]));
    expect(negocio.complementarity).toBeGreaterThanOrEqual(75);
  });

  it("o que não é concorrência segue atendido, como no motor privado", () => {
    for (const [tenho, preciso] of [
      // direções opostas, mesmo objeto
      ["Exportar vinho", "Importar vinho"],
      ["Vender soja", "Comprar soja"],
      ["Export coffee", "Import coffee"],
      // uma ponta neutra: quem tem o produto diante de quem quer exportá-lo
      ["Café", "Exportar café"],
      ["Terras raras", "Fornecimento de terras raras"],
      // tag igual sem direção
      ["Café", "Café"],
      ["investidores", "investidores"],
      // o serviço escrito igual dos dois lados (decisão do Nicolas, 04/09)
      ["Exportação de vinho", "Exportação de vinho"],
      ["Captação de recursos", "Captação de recursos"],
    ]) {
      expect(nota(tenho, preciso).score, `${tenho} × ${preciso}`).toBeGreaterThan(0);
      expect(complementaridade(tenho, preciso), `${tenho} × ${preciso}`).toBe(ATENDIDA);
    }
  });

  it("palavra solta não casa: o lugar ou a palavra em comum não é necessidade atendida", () => {
    for (const [tenho, preciso] of [
      ["Café do Brasil", "Soja do Brasil"],
      ["Brasil", "Café do Brasil"],
      ["Exportar", "Exportar vinho"],
      ["Exportação de vinho", "Exportação de uva"],
      ["Importação da China", "Exportação da China"],
    ]) {
      expect(nota(tenho, preciso).score, `${tenho} × ${preciso}`).toBe(0);
      expect(complementaridade(tenho, preciso), `${tenho} × ${preciso}`).toBe(SEM_ENCAIXE);
    }
  });

  it("paridade: todo par que o motor privado zera como concorrente não é atendido no motor de perfis", () => {
    const verbos = ["Exportar", "Importar", "Vender", "Comprar", "Export", "Import", "Sell", "Buy", "Vender", "Comprar"];
    const objetos = ["", " vinho", " café do Brasil", " soja"];
    let concorrentes = 0;
    for (const v1 of verbos) for (const v2 of verbos) for (const o1 of objetos) for (const o2 of objetos) {
      const tenho = `${v1}${o1}`, preciso = `${v2}${o2}`;
      if (nota(tenho, preciso).bloqueio !== "concorrentes") continue;
      concorrentes++;
      expect(complementaridade(tenho, preciso), `${tenho} × ${preciso}`).toBe(SEM_ENCAIXE);
    }
    expect(concorrentes).toBeGreaterThan(50);
  });
});
