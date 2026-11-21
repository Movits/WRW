import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A entrada no link com senha (H23) com o banco fora do ar: o erro sobe como
 * erro, nunca como "senha errada" nem "espera", e a falha cobrada da rede
 * volta, para a queda não deixar ninguém na espera quando o banco voltar. O
 * resto (a senha certa, os dois freios, a linha travada) está em
 * link-com-senha.integracao.test.ts, contra um MariaDB de verdade.
 */

const banco = vi.hoisted(() => ({ foraDoAr: true, chamadas: 0 }));
vi.mock("./db", async () => {
  const { BancoIndisponivel } = await import("./banco-indisponivel");
  return {
    getDb: async () => null,
    exigirDb: async () => {
      banco.chamadas += 1;
      if (banco.foraDoAr) throw new BancoIndisponivel();
      // De volta: o token não acha link nenhum (a primeira leitura, sem trava).
      return { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    },
  };
});

const { entrarNoLink, freioDaEntradaPorRede } = await import("./entrada-no-link-aberto");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { TENTATIVAS_LIVRES } = await import("./senha-do-link-aberto");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

describe("entrarNoLink com o banco fora do ar", () => {
  it("cada tentativa sobe o erro do banco, nunca a espera; com o banco de volta, a seguinte é conferida", async () => {
    freioDaEntradaPorRede.esquecer();
    const agora = Date.now();
    for (let i = 0; i < TENTATIVAS_LIVRES + 1; i++) {
      await expect(entrarNoLink(TOKEN, "482913", "203.0.113.7", agora)).rejects.toBeInstanceOf(BancoIndisponivel);
    }
    expect(banco.chamadas).toBe(TENTATIVAS_LIVRES + 1);
    banco.foraDoAr = false;
    // A rede não ficou com as falhas da queda: a senha é conferida (e não confere, porque o link não existe).
    await expect(entrarNoLink(TOKEN, "482913", "203.0.113.7", agora)).resolves.toEqual({ entrou: false, motivo: "senha" });
  });
});
