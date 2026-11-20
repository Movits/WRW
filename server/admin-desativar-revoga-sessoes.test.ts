import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Revisão da PR #179 (sessão de 90 dias desde o último uso): desativar a conta
 * pelo painel gravava só `users.isActive = false`. As linhas em `sessions`
 * seguiam ativas e, ao reativar a conta, qualquer sessão usada nos últimos 90
 * dias voltava a valer e a se renovar — inclusive a de quem motivou a
 * desativação. Antes, com 8 h fixas, a sessão já tinha morrido. Agora desativar
 * derruba as sessões; reativar não ressuscita nenhuma.
 */

const dubles = vi.hoisted(() => ({
  revokeAllUserSessions: vi.fn(async (_userId: number) => undefined),
  createAuditLog: vi.fn(async (_dados: unknown) => undefined),
  atualizacoes: [] as Record<string, unknown>[],
}));

vi.mock("./security", async importOriginal => ({
  ...(await importOriginal<typeof import("./security")>()),
  revokeAllUserSessions: dubles.revokeAllUserSessions,
  createAuditLog: dubles.createAuditLog,
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  exigirDb: async () => ({
    update: () => ({
      set: (valores: Record<string, unknown>) => ({
        where: async () => {
          dubles.atualizacoes.push(valores);
        },
      }),
    }),
  }),
}));

import { adminRouter } from "./routers/admin";

const ADMIN = { id: 1, role: "admin", isActive: true, onboardingCompleted: true, openId: "email_admin", name: "Admin" };

function painel() {
  return adminRouter.createCaller({
    user: ADMIN,
    req: { headers: {}, protocol: "https" },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  } as never);
}

beforeEach(() => {
  dubles.revokeAllUserSessions.mockClear();
  dubles.createAuditLog.mockClear();
  dubles.atualizacoes = [];
});

describe("admin.toggleUserStatus: desativar a conta derruba as sessões", () => {
  it("desativar: grava isActive=false e revoga todas as sessões da conta", async () => {
    await expect(painel().toggleUserStatus({ userId: 9, isActive: false })).resolves.toEqual({ success: true });
    expect(dubles.atualizacoes).toEqual([{ isActive: false }]);
    expect(dubles.revokeAllUserSessions).toHaveBeenCalledWith(9);
    expect(dubles.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_DEACTIVATE_USER" }));
  });

  it("reativar: só reativa a conta, sem mexer em sessão (as antigas já caíram)", async () => {
    await expect(painel().toggleUserStatus({ userId: 9, isActive: true })).resolves.toEqual({ success: true });
    expect(dubles.atualizacoes).toEqual([{ isActive: true }]);
    expect(dubles.revokeAllUserSessions).not.toHaveBeenCalled();
  });
});
