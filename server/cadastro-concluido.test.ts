import { TRPCError } from "@trpc/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";

/**
 * Cadastro não concluído (logo, sem o Termo Geral de Uso aceito) não usa a
 * plataforma. Antes, a única trava era `profile.completeOnboarding` exigir o
 * termo; como nada lia `onboardingCompleted`, bastava não chamar o fim do
 * cadastro e usar reuniões, rede, oportunidades e conexões pela barra de
 * endereço ou pela API, e um `profile.update` ainda promovia a conta a Prata.
 *
 * O arquivo cobre a regra (server/cadastro-concluido.ts), o middleware real do
 * `protectedProcedure` e uma varredura do appRouter inteiro: todo procedimento
 * protegido fora da lista do cadastro recusa quem não concluiu.
 */

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

// Banco dublado como em critical.test.ts: a trava roda antes do handler e não
// consulta nada; o dublê só impede que algum módulo fale com banco de verdade.
const dbFalso: any = new Proxy(function () {}, {
  get: (_alvo, prop) => {
    if (prop === "then") return undefined;
    return () => dbFalso;
  },
  apply: () => dbFalso,
});
vi.mock("./db", async () => {
  const { BancoIndisponivel } = await import("./banco-indisponivel");
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_alvo, prop) => {
        if (prop === "getDb" || prop === "exigirDb") return async () => dbFalso;
        if (prop === "then" || prop === Symbol.toStringTag) return undefined;
        if (prop === "BancoIndisponivel") return BancoIndisponivel;
        return async () => undefined;
      },
    },
  );
});
vi.mock("./security", () => ({
  createAuditLog: async () => {},
  createSecurityEvent: async () => {},
  checkLoginRateLimit: async () => ({ allowed: true }),
  recordLoginAttempt: async () => {},
}));

const {
  AREAS_LIBERADAS,
  exigirCadastroConcluido,
  liberadoSemCadastroConcluido,
  MENSAGEM_CADASTRO_INCOMPLETO,
  PROCEDIMENTOS_LIBERADOS,
} = await import("./cadastro-concluido");
const { protectedProcedure, publicProcedure, router } = await import("./_core/trpc");
const { appRouter } = await import("./routers");
const { MENSAGEM_TERMO_GERAL_NAO_REVOGAVEL } = await import("./routers/consent");

type Conta = Pick<User, "id" | "openId" | "role" | "isActive" | "onboardingCompleted">;

function conta(onboardingCompleted: boolean, role: User["role"] = "bronze"): Conta {
  return { id: 7, openId: "email_teste", role, isActive: true, onboardingCompleted };
}

function contexto(user: Partial<User> | null) {
  return {
    user,
    req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as never;
}

async function erroDe(promessa: Promise<unknown>) {
  try {
    await promessa;
    return null;
  } catch (erro) {
    return erro;
  }
}

describe("a regra", () => {
  it("cadastro não concluído é barrado fora da lista, com PRECONDITION_FAILED e a mensagem em português", () => {
    expect(() => exigirCadastroConcluido(conta(false), "meetings.list")).toThrow(TRPCError);
    try {
      exigirCadastroConcluido(conta(false), "profile.update");
    } catch (erro) {
      expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_CADASTRO_INCOMPLETO });
    }
    expect.assertions(2);
  });

  it("libera o que o cadastro precisa: ler o perfil, concluir, aceitar o termo, revisar texto, excluir a conta", () => {
    for (const caminho of ["profile.get", "profile.completeOnboarding", "consent.status", "consent.accept", "assistenteTexto.revisar", "conta.excluirMinhaConta"]) {
      expect(() => exigirCadastroConcluido(conta(false), caminho)).not.toThrow();
    }
  });

  it("a liberação é por procedimento, não por área: o resto de profile continua barrado", () => {
    expect(liberadoSemCadastroConcluido("profile.get")).toBe(true);
    expect(liberadoSemCadastroConcluido("profile.update")).toBe(false);
    // Prefixo parecido não é a área.
    expect(liberadoSemCadastroConcluido("consentimentos.x")).toBe(false);
  });

  it("cadastro concluído passa em qualquer caminho; o usuário sintético das tarefas agendadas, sem a coluna, também", () => {
    expect(() => exigirCadastroConcluido(conta(true), "meetings.list")).not.toThrow();
    expect(() => exigirCadastroConcluido({}, "meetings.list")).not.toThrow();
  });
});

describe("o middleware do protectedProcedure", () => {
  const mini = router({
    profile: router({
      get: protectedProcedure.query(() => "perfil"),
      update: protectedProcedure.mutation(() => "gravou"),
    }),
    meetings: router({ list: protectedProcedure.query(() => "reuniões") }),
    stats: router({ platform: publicProcedure.query(() => "números públicos") }),
  });

  it("barra o procedimento de negócio para quem não concluiu e deixa o do cadastro", async () => {
    const caller = mini.createCaller(contexto(conta(false)));
    await expect(caller.meetings.list()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.profile.update()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.profile.get()).resolves.toBe("perfil");
    await expect(caller.stats.platform()).resolves.toBe("números públicos");
  });

  it("quem concluiu usa tudo", async () => {
    const caller = mini.createCaller(contexto(conta(true)));
    await expect(caller.meetings.list()).resolves.toBe("reuniões");
    await expect(caller.profile.update()).resolves.toBe("gravou");
  });

  it("sem sessão continua UNAUTHORIZED, não a mensagem do cadastro", async () => {
    const caller = mini.createCaller(contexto(null));
    await expect(caller.meetings.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("o appRouter inteiro", () => {
  // Os únicos procedimentos públicos fora das áreas liberadas. Procedimento
  // público novo precisa entrar aqui (e não passar pela trava é decisão sua).
  const PUBLICOS = new Set([
    "faq.ask", "stats.platform", "stats.presencaPorPais",
    // O link aberto da reunião (12/11/2026): quem abre o link não tem conta.
    "reuniaoAberta.ver", "reuniaoAberta.traduzir", "reuniaoAberta.resumir", "reuniaoAberta.perguntar",
  ]);
  let caminhos: string[] = [];

  beforeAll(() => {
    caminhos = Object.keys(appRouter._def.procedures);
  });

  it("a lista do cadastro nomeia procedimentos e áreas que existem", () => {
    for (const caminho of PROCEDIMENTOS_LIBERADOS) expect(caminhos).toContain(caminho);
    for (const area of AREAS_LIBERADAS) {
      expect(caminhos.some(caminho => caminho.startsWith(`${area}.`)), `área ${area}`).toBe(true);
    }
    for (const caminho of PUBLICOS) expect(caminhos).toContain(caminho);
  });

  it("todo procedimento protegido fora da lista recusa o cadastro não concluído, inclusive os de Ouro, admin e distribuidor", async () => {
    const barrados = caminhos.filter(caminho => !liberadoSemCadastroConcluido(caminho) && !PUBLICOS.has(caminho));
    // Uma varredura que não varre nada passaria calada.
    expect(barrados.length).toBeGreaterThan(50);
    for (const caminho of ["profile.update", "meetings.list", "opportunities.create", "connections.sendRequest", "admin.grantGold", "distribuicao.decidir"]) {
      if (caminhos.includes(caminho)) expect(barrados).toContain(caminho);
    }

    const caller = appRouter.createCaller(contexto({ ...conta(false, "gold"), isDistributor: true }));
    const chamar = (caminho: string) => {
      const alvo = caminho.split(".").reduce<any>((no, parte) => no[parte], caller);
      return alvo();
    };
    const escaparam: string[] = [];
    for (const caminho of barrados) {
      const erro = await erroDe(chamar(caminho));
      if (!(erro instanceof TRPCError) || erro.code !== "PRECONDITION_FAILED" || erro.message !== MENSAGEM_CADASTRO_INCOMPLETO) {
        escaparam.push(caminho);
      }
    }
    expect(escaparam).toEqual([]);
  });
});

describe("consent.revoke", () => {
  it("recusa revogar o Termo Geral de Uso à parte, sem tocar no banco", async () => {
    const caller = appRouter.createCaller(contexto(conta(true)));
    await expect(caller.consent.revoke({ type: "termo_geral_de_uso" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: MENSAGEM_TERMO_GERAL_NAO_REVOGAVEL,
    });
  });

  it("os outros termos continuam revogáveis: a recusa é só do Termo Geral", async () => {
    const caller = appRouter.createCaller(contexto(conta(true)));
    const erro = await erroDe(caller.consent.revoke({ type: "termo_smart_match" }));
    expect((erro as TRPCError | null)?.message).not.toBe(MENSAGEM_TERMO_GERAL_NAO_REVOGAVEL);
  });
});
