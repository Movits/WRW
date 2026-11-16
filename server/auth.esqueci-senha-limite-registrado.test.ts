import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";

// server/auth.ts exige JWT_SECRET já na carga do módulo — vi.hoisted roda antes dos imports.
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  process.env.FRONTEND_URL ??= "https://exemplo-de-teste.invalid";
});

const { sendEmailMock, pedidosNaJanela } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  pedidosNaJanela: { valor: 0 },
}));

vi.mock("./_core/email", () => ({
  sendEmail: sendEmailMock,
  buildPasswordResetEmail: () => ({ html: "<p>oi</p>", text: "oi" }),
}));

const E_MAIL_CADASTRADO = "existe@exemplo.test";

vi.mock("./db", () => ({
  exigirDb: async () => ({
    select: () => ({
      from: (tabela: Table) => ({
        where: () => ({
          // A busca da usuária termina em `.limit(1)`; as contagens são
          // aguardadas direto. Este teste controla a do IP
          // (password_reset_requests); a da conta (password_reset_tokens) fica
          // em zero, senão o limite por conta dispararia antes e o caso
          // "dentro do limite" deixaria de enviar.
          limit: async () => [{ id: 7, name: "Membra", email: E_MAIL_CADASTRADO }],
          then: (resolver: (linhas: unknown[]) => unknown) =>
            resolver([{ count: getTableName(tabela) === "password_reset_requests" ? pedidosNaJanela.valor : 0 }]),
        }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));

import { appRouter } from "./routers";
import { TRPCError } from "@trpc/server";
import { MENSAGEM_DO_LIMITE_POR_REDE, tetoDeRecuperacaoPorEmail, tetoDeRecuperacaoPorRede } from "./routers/auth";
import { PASSWORD_RESET_GENERIC_MESSAGE, PASSWORD_RESET_RATE_LIMIT } from "./password-reset-security";
import type { TrpcContext } from "./_core/context";

function contexto(): TrpcContext {
  return {
    user: null,
    req: { headers: {}, socket: {} },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

const pedirRecuperacao = () =>
  appRouter.createCaller(contexto()).auth.forgotPassword({ email: E_MAIL_CADASTRADO });

/**
 * O LIMITE POR IP NÃO PODE SER INVISÍVEL.
 *
 * Quem pede a recuperação nunca descobre se o e-mail existe: a recusa por rede
 * vem antes de buscar a conta. Mas ela não pode ser muda. Do nosso lado, o
 * pedido recusado sumia sem rastro (nenhum e-mail sai, e o log do Render não
 * registrava nada); do lado de quem pede, a tela dizia "Pedido recebido". Quem
 * testa tenta de novo, que é o que qualquer pessoa faz ao não receber o e-mail.
 * Foi o relato "o esqueci a senha não chega" do reteste de 15/09. Esta é a
 * contagem do banco, que vale quando a memória perdeu a conta (deploy, reinício).
 */
describe("esqueci a senha — o limite por IP deixa registro no log", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(true);
    pedidosNaJanela.valor = 0;
    // Os tetos em memória (mesmo e-mail em todos os casos) são outro assunto.
    tetoDeRecuperacaoPorRede.esquecer();
    tetoDeRecuperacaoPorEmail.esquecer();
  });

  it("dentro do limite, envia o e-mail e não avisa nada", async () => {
    pedidosNaJanela.valor = PASSWORD_RESET_RATE_LIMIT - 1;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resposta = await pedirRecuperacao();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(aviso).not.toHaveBeenCalled();
    expect(resposta.message).toBe(PASSWORD_RESET_GENERIC_MESSAGE);
    aviso.mockRestore();
  });

  it("no limite do banco (a memória zerou num deploy), recusa com a frase do teto por rede e registra para quem mantém", async () => {
    pedidosNaJanela.valor = PASSWORD_RESET_RATE_LIMIT;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    const erro = await pedirRecuperacao().catch((e: unknown) => e);

    // A mesma recusa do teto em memória, que a tela mostra, e nada sai.
    expect(erro).toBeInstanceOf(TRPCError);
    expect((erro as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    expect((erro as TRPCError).message).toBe(MENSAGEM_DO_LIMITE_POR_REDE);
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Mas agora existe rastro, e ele diz por que o e-mail não saiu.
    expect(aviso).toHaveBeenCalledTimes(1);
    const registrado = String(aviso.mock.calls[0]?.[0] ?? "");
    expect(registrado).toContain("[PasswordReset]");
    expect(registrado).toContain(String(PASSWORD_RESET_RATE_LIMIT));
    expect(registrado).toMatch(/15 min/);
    aviso.mockRestore();
  });

  it("o registro não leva e-mail nem IP", async () => {
    pedidosNaJanela.valor = PASSWORD_RESET_RATE_LIMIT + 5;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pedirRecuperacao().catch(() => undefined);

    const registrado = String(aviso.mock.calls[0]?.[0] ?? "");
    expect(registrado).not.toContain(E_MAIL_CADASTRADO);
    expect(registrado).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    aviso.mockRestore();
  });
});
