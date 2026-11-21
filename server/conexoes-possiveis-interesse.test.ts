import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * U3: a Bronze não vê os cartões das conexões sugeridas (matches.list sai vazio
 * para ela), e demonstrar interesse por um deles também espera o cadastro
 * completo. Sem esta trava, um `matchId` adivinhado furava a U3 pela API: o
 * interesse seguia ao distribuidor e o aceite revelava os dois nomes.
 *
 *  1. Bronze: FORBIDDEN com a mensagem do cadastro, antes de qualquer leitura
 *     ou escrita no banco (nem a alça do cartão é resolvida, nem a auditoria
 *     de alça inválida é gravada).
 *  2. Prata, Ouro, presidente e admin: o interesse segue como antes.
 *  3. Responder a um pedido RECEBIDO continua aberto à Bronze.
 */

const estado = vi.hoisted(() => ({ chamadas: [] as string[] }));

vi.mock("./db", () => new Proxy({}, {
  has: () => true,
  get: (_alvo, prop) => {
    if (typeof prop === "symbol" || prop === "then" || prop === "default") return undefined;
    return async (...args: unknown[]) => {
      estado.chamadas.push(String(prop));
      if (prop === "resolverAlvoDoMatch") return 2;
      if (prop === "idsDeContasAtivas") return new Set(args[0] as number[]);
      if (prop === "sendConnectionRequest") return { revelou: false, connectionId: 7, emAnalise: true };
      if (prop === "lerPedidoDeMatch") return { id: 7, requesterId: 2, recipientId: 1, status: "pending" };
      if (prop === "respondToConnection") return { revelou: false, contraparte: 2 };
      if (prop === "idsDosDistribuidoresAtivos" || prop === "idsDaPresidenciaAtiva") return [];
      return undefined;
    };
  },
}));
vi.mock("./routers/consent", () => ({
  usersComConsentimento: async (ids: number[]) => new Set(ids),
  getCurrentDocument: async () => null,
  hasValidConsent: async () => true,
}));
vi.mock("./security", () => ({
  createAuditLog: async () => { estado.chamadas.push("createAuditLog"); },
}));

const { connectionsRouter, MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO } = await import("./routers/connections");

const ctx = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: 1, openId: "u-1", email: "t@local", role, ...extra },
  req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
  res: { cookie: () => {} },
}) as never;

beforeEach(() => { estado.chamadas = []; });

describe("U3 — demonstrar interesse espera o cadastro completo", () => {
  it("a Bronze leva FORBIDDEN com a mensagem do cadastro, sem tocar no banco", async () => {
    await expect(connectionsRouter.createCaller(ctx("bronze")).send({ matchId: 55 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO });
    expect(estado.chamadas).toEqual([]);
  });

  it("a Bronze distribuidora também: o poder não é nível", async () => {
    await expect(connectionsRouter.createCaller(ctx("bronze", { isDistributor: true })).send({ matchId: 55 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(estado.chamadas).toEqual([]);
  });

  it.each(["silver", "gold", "president", "admin"])("%s demonstra interesse como antes", async (role) => {
    await expect(connectionsRouter.createCaller(ctx(role)).send({ matchId: 55 })).resolves.toEqual({ success: true, revelou: false });
    expect(estado.chamadas).toContain("resolverAlvoDoMatch");
    expect(estado.chamadas).toContain("sendConnectionRequest");
  });

  it("a Bronze continua aceitando o pedido que recebeu", async () => {
    await expect(connectionsRouter.createCaller(ctx("bronze")).respond({ connectionId: 7, accept: true })).resolves.toEqual({ success: true });
    expect(estado.chamadas).toContain("respondToConnection");
  });
});
