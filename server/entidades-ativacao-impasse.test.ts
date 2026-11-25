import { describe, expect, it } from "vitest";
import { ehImpasseDoBanco, TENTATIVAS_NO_IMPASSE } from "./entidades-ativacao";

// Dois envios do mesmo link de ativação ao mesmo tempo podem cair num impasse
// do InnoDB; a ativação reconhece o erro (na causa do erro do Drizzle) e roda de novo.
describe("ehImpasseDoBanco", () => {
  it("reconhece o impasse pelo código ou pelo errno, também na causa", () => {
    expect(ehImpasseDoBanco({ code: "ER_LOCK_DEADLOCK" })).toBe(true);
    expect(ehImpasseDoBanco({ errno: 1213 })).toBe(true);
    const doDrizzle = new Error("Failed query: select ... for update", {
      cause: Object.assign(new Error("Deadlock found when trying to get lock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }),
    });
    expect(ehImpasseDoBanco(doDrizzle)).toBe(true);
  });

  it("não confunde com outro erro do banco", () => {
    expect(ehImpasseDoBanco({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(false);
    expect(ehImpasseDoBanco(new Error("Banco de dados indisponível"))).toBe(false);
    expect(ehImpasseDoBanco(undefined)).toBe(false);
  });

  it("tenta de novo um número limitado de vezes", () => {
    expect(TENTATIVAS_NO_IMPASSE).toBeGreaterThan(1);
    expect(TENTATIVAS_NO_IMPASSE).toBeLessThanOrEqual(5);
  });
});
