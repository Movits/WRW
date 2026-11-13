import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O que o módulo do link aberto decide sem o banco: o formato do token e o
 * endereço do áudio. As consultas estão em link-aberto-da-reuniao.integracao.test.ts,
 * contra um MariaDB de verdade.
 */

const consultasAoBanco = vi.hoisted(() => ({ total: 0 }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    consultasAoBanco.total += 1;
    throw new Error("banco dublado: o teste conta quem chegou aqui");
  },
}));

const {
  chaveDoAudioDoLink,
  enderecoDoAudioDoLink,
  exigirReuniaoDoLink,
  gerarTokenDoLink,
  LinkAbertoRecusado,
  verReuniaoPeloLink,
} = await import("./link-aberto-da-reuniao");

describe("o token do link", () => {
  it("tem 32 caracteres de base64url (192 bits) e não se repete", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => gerarTokenDoLink()));
    expect(tokens.size).toBe(2000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("o áudio sai pela rota do link, com o token, sem chave do bucket", () => {
    expect(enderecoDoAudioDoLink("A".repeat(32))).toBe(`/reuniao-aberta/${"A".repeat(32)}/audio`);
  });
});

describe("token fora do formato não chega ao banco", () => {
  it.each([
    ["vazio", ""],
    ["curto (link cortado)", "A".repeat(31)],
    ["longo", "A".repeat(33)],
    ["com caractere fora do base64url", `${"A".repeat(31)}=`],
    ["com barra", `${"A".repeat(16)}/${"A".repeat(15)}`],
  ])("%s: NOT_FOUND sem consultar", async (_caso, token) => {
    consultasAoBanco.total = 0;
    await expect(verReuniaoPeloLink(token)).rejects.toBeInstanceOf(LinkAbertoRecusado);
    await expect(exigirReuniaoDoLink(token)).rejects.toMatchObject({ codigo: "NOT_FOUND" });
    await expect(chaveDoAudioDoLink(token)).resolves.toBeNull();
    expect(consultasAoBanco.total).toBe(0);
  });

  it("no formato, consulta: e a falha do banco sobe como erro, não vira 'link não encontrado'", async () => {
    consultasAoBanco.total = 0;
    await expect(verReuniaoPeloLink("A".repeat(32))).rejects.toThrow("banco dublado");
    await expect(chaveDoAudioDoLink("A".repeat(32))).rejects.toThrow("banco dublado");
    expect(consultasAoBanco.total).toBe(2);
  });
});
