import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
const cofre = await import("./entidades-cofre");

/**
 * As chaves da base das associações (N1): as duas obrigatórias, com 32
 * caracteres ou mais, sem derivar do JWT_SECRET; o HMAC depende da chave (um
 * hash sem chave seria desfeito com a base aberta da Receita).
 */
const ORIGINAL = { hmac: process.env.ENTIDADES_HMAC_KEY, cofre: process.env.VAULT_ENCRYPTION_KEY };
afterEach(() => {
  process.env.ENTIDADES_HMAC_KEY = ORIGINAL.hmac;
  process.env.VAULT_ENCRYPTION_KEY = ORIGINAL.cofre;
  if (ORIGINAL.hmac === undefined) delete process.env.ENTIDADES_HMAC_KEY;
  if (ORIGINAL.cofre === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
});

const chaves = (hmac?: string, vault?: string) => {
  if (hmac === undefined) delete process.env.ENTIDADES_HMAC_KEY; else process.env.ENTIDADES_HMAC_KEY = hmac;
  if (vault === undefined) delete process.env.VAULT_ENCRYPTION_KEY; else process.env.VAULT_ENCRYPTION_KEY = vault;
};
const LONGA = "x".repeat(32);

describe("cofre das entidades", () => {
  it("sem uma das chaves (ou curta), recusa com o código, sem cair no JWT_SECRET", () => {
    for (const [h, v] of [[undefined, LONGA], [LONGA, undefined], ["curta", LONGA], [LONGA, "curta"]] as const) {
      chaves(h, v);
      expect(cofre.chavesDaEntidadePresentes()).toBe(false);
      expect(() => cofre.hmacDoDocumento("BR", "cnpj", "11222333000181")).toThrow("ENTIDADES_CHAVES_AUSENTES");
      expect(() => cofre.cifrar("x")).toThrow("ENTIDADES_CHAVES_AUSENTES");
    }
  });

  it("o HMAC é estável, separa país e tipo, e muda com a chave", () => {
    chaves(LONGA, "y".repeat(40));
    const a = cofre.hmacDoDocumento("BR", "cnpj", "11222333000181");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(cofre.hmacDoDocumento("BR", "cnpj", "11222333000181")).toBe(a);
    expect(cofre.hmacDoDocumento("MZ", "nuit", "11222333000181")).not.toBe(a);
    process.env.ENTIDADES_HMAC_KEY = "z".repeat(32);
    expect(cofre.hmacDoDocumento("BR", "cnpj", "11222333000181")).not.toBe(a);
  });

  it("cifra e decifra; o cifrado não contém o texto", () => {
    chaves(LONGA, "y".repeat(40));
    const cifrado = cofre.cifrar("11222333000181");
    expect(cifrado).not.toContain("11222333000181");
    expect(cofre.decifrar(cifrado)).toBe("11222333000181");
  });

  it("o token do convite é aleatório e o hash não o revela", () => {
    const t = cofre.gerarTokenDeConvite();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(cofre.gerarTokenDeConvite()).not.toBe(t);
    expect(cofre.hashDoConvite(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(cofre.hashDoConvite(t)).not.toContain(t);
  });
});
