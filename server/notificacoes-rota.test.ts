import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas do sino (server/routers/notifications.ts), com o banco dublado. O
 * marcar lido aviso por aviso (H15) só muda o aviso da conta da sessão: a
 * posse fica no WHERE de markNotificationRead (server/security.ts, a correção
 * de IDOR V-02), e aqui se prova que a rota passa a conta da sessão, e não uma
 * que viesse da tela.
 */
const banco = vi.hoisted(() => ({
  getNotifications: vi.fn(async () => []),
  markNotificationsRead: vi.fn(async () => undefined),
}));
const seguranca = vi.hoisted(() => ({ markNotificationRead: vi.fn(async () => undefined) }));
vi.mock("./db", () => ({ ...banco, getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));
vi.mock("./security", () => seguranca);

const { notificationsRouter } = await import("./routers/notifications");

const requisicao = { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" };
const daConta = (id = 7) => notificationsRouter.createCaller({
  user: { id, openId: `conta-${id}`, email: `conta-${id}@local`, role: "bronze", onboardingCompleted: true },
  req: requisicao, res: { cookie: () => {} },
} as never);
const semSessao = () => notificationsRouter.createCaller({ user: null, req: requisicao, res: { cookie: () => {} } } as never);

beforeEach(() => {
  banco.getNotifications.mockClear();
  banco.markNotificationsRead.mockClear();
  seguranca.markNotificationRead.mockClear();
});

describe("o sino", () => {
  it("marcar um aviso lido passa o id dele e a conta da sessão", async () => {
    expect(await daConta(7).markRead({ id: 42 })).toEqual({ success: true });
    expect(seguranca.markNotificationRead).toHaveBeenCalledWith(42, 7);
    // Um aviso só: o "marcar todas" não é chamado.
    expect(banco.markNotificationsRead).not.toHaveBeenCalled();
  });

  it("id que não é inteiro positivo é recusado antes do banco", async () => {
    for (const id of [0, -1, 1.5]) {
      await expect(daConta().markRead({ id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(daConta().markRead({ id: "42" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(seguranca.markNotificationRead).not.toHaveBeenCalled();
  });

  it("sem sessão, nada", async () => {
    await expect(semSessao().markRead({ id: 42 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(seguranca.markNotificationRead).not.toHaveBeenCalled();
    expect(banco.getNotifications).not.toHaveBeenCalled();
  });

  it("a lista e o marcar todas seguem como eram: a conta da sessão", async () => {
    await daConta(9).list();
    await daConta(9).markAllRead();
    expect(banco.getNotifications).toHaveBeenCalledWith(9, 30);
    expect(banco.markNotificationsRead).toHaveBeenCalledWith(9);
  });
});
