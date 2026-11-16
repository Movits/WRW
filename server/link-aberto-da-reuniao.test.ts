import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O que o módulo do link aberto decide sem o banco: o formato do token e o
 * endereço do áudio. As consultas estão em link-aberto-da-reuniao.integracao.test.ts,
 * contra um MariaDB de verdade.
 */

const consultasAoBanco = vi.hoisted(() => ({ total: 0, banco: null as unknown }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    consultasAoBanco.total += 1;
    if (consultasAoBanco.banco) return consultasAoBanco.banco;
    throw new Error("banco dublado: o teste conta quem chegou aqui");
  },
}));

const {
  chaveDoAudioDoLink,
  enderecoDoAudioDoLink,
  exigirReuniaoDoLink,
  gerarTokenDoLink,
  ligarLinkAberto,
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

/**
 * A prova da autorização é o que deixa a voz das pessoas aberta: o link só
 * liga se a linha de auditoria entra. Aqui, uma transação dublada mostra que o
 * insert da auditoria está DENTRO dela e que a falha dele desfaz tudo; que o
 * banco de verdade desfaz o UPDATE no rollback é garantia do MySQL, e o caminho
 * feliz roda contra o MariaDB em link-aberto-da-reuniao.integracao.test.ts.
 */
describe("ligar: sem a linha de auditoria, o link não liga", () => {
  const PROVA = { userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest", idioma: "pt-BR", textoExibido: "Confirmo." };

  function transacaoDublada(insert: () => Promise<unknown>) {
    const passos: string[] = [];
    const inserido: { valores?: { details?: unknown } } = {};
    const tx = {
      update: () => ({ set: () => ({ where: async () => { passos.push("update"); } }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => { passos.push("select"); return [{ status: "ready", shareToken: "A".repeat(32) }]; } }) }) }),
      insert: () => ({ values: async (valores: { details?: unknown }) => { passos.push("insert"); inserido.valores = valores; return insert(); } }),
    };
    const banco = {
      transaction: async (trabalho: (t: typeof tx) => Promise<unknown>) => {
        passos.push("begin");
        try {
          const resultado = await trabalho(tx);
          passos.push("commit");
          return resultado;
        } catch (erro) {
          passos.push("rollback");
          throw erro;
        }
      },
    };
    return { banco, passos, inserido };
  }

  it("o insert da auditoria falha: a transação volta atrás e ligar lança, sem devolver token", async () => {
    const { banco, passos } = transacaoDublada(async () => { throw new Error("audit_logs recusou"); });
    consultasAoBanco.banco = banco;
    try {
      await expect(ligarLinkAberto("dona", "reuniao", PROVA)).rejects.toThrow("audit_logs recusou");
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(passos).toEqual(["begin", "update", "select", "insert", "rollback"]);
  });

  it("a auditoria entra: ligar devolve o token, e a linha leva a frase, o idioma e o hash da frase", async () => {
    const { banco, passos, inserido } = transacaoDublada(async () => undefined);
    consultasAoBanco.banco = banco;
    try {
      await expect(ligarLinkAberto("dona", "reuniao", PROVA)).resolves.toBe("A".repeat(32));
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(passos).toEqual(["begin", "update", "select", "insert", "commit"]);
    const { createHash } = await import("node:crypto");
    expect(inserido.valores?.details).toEqual({
      autorizacaoDasPessoas: true, idioma: "pt-BR", textoExibido: "Confirmo.",
      textoHash: createHash("sha256").update("Confirmo.").digest("hex"),
    });
  });
});
