import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os dois procedimentos da Google Agenda no Perfil (H16b), com o serviço
 * dublado: a conta é sempre a da sessão; sem as variáveis, desconectar dá
 * NOT_FOUND (a função some) e nem chega ao serviço; sem sessão, nada.
 */
const servico = vi.hoisted(() => ({
  estadoDaGoogleAgenda: vi.fn(async () => ({ disponivel: false })),
  desconectarGoogleAgenda: vi.fn(async () => ({ googleNaoConfirmou: false })),
}));
vi.mock("./google-agenda", () => servico);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { googleAgendaRouter, MENSAGEM_GOOGLE_AGENDA_INDISPONIVEL } = await import("./routers/googleAgenda");

const contexto = (user: Record<string, unknown> | null) => ({
  user,
  req: { headers: { "user-agent": "Navegador de teste" }, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
  res: { cookie: () => {} },
}) as never;
const daConta = (id = 7) => googleAgendaRouter.createCaller(contexto({ id, openId: `open-${id}`, role: "silver", onboardingCompleted: true }));

beforeEach(() => {
  servico.estadoDaGoogleAgenda.mockClear();
  servico.desconectarGoogleAgenda.mockClear();
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id-do-cliente.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "segredo-do-cliente");
  vi.stubEnv("FRONTEND_URL", "https://wrwglobal.org");
  vi.stubEnv("VAULT_ENCRYPTION_KEY", "chave-do-cofre-de-teste-com-mais-de-32");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("googleAgenda", () => {
  it("o estado é o da conta da sessão", async () => {
    await daConta(7).estado();
    expect(servico.estadoDaGoogleAgenda).toHaveBeenCalledWith(7);
  });

  it("desconectar leva a conta da sessão e a prova (IP e navegador)", async () => {
    expect(await daConta(9).desconectar()).toEqual({ googleNaoConfirmou: false });
    expect(servico.desconectarGoogleAgenda).toHaveBeenCalledWith(9, { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" });
  });

  it("sem as variáveis, desconectar é NOT_FOUND e não chega ao serviço", async () => {
    vi.stubEnv("VAULT_ENCRYPTION_KEY", "curta");
    const erro = await daConta().desconectar().catch(e => e);
    expect(erro).toBeInstanceOf(TRPCError);
    expect(erro).toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_GOOGLE_AGENDA_INDISPONIVEL });
    expect(servico.desconectarGoogleAgenda).not.toHaveBeenCalled();
  });

  it("sem sessão, UNAUTHORIZED nos dois", async () => {
    const semSessao = googleAgendaRouter.createCaller(contexto(null));
    await expect(semSessao.estado()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao.desconectar()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(servico.estadoDaGoogleAgenda).not.toHaveBeenCalled();
  });
});
