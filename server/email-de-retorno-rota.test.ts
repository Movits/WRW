import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.rascunharEmailDeRetorno (H20) no router, com os serviços dublados.
 * Prova o que fica na rota: a dona é a da sessão, a entrada é validada antes de
 * tudo (e não gasta vaga), o nome de quem recebe não chega ao serviço, e o
 * rascunho soma no mesmo teto de pedidos à IA que a pergunta e o pedido de
 * resumo. O que o serviço faz com o banco e a IA está em email-de-retorno.test.ts.
 */

const rascunharEmailDeRetorno = vi.fn();
const perguntarAReuniao = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./email-de-retorno", async importOriginal => ({
  ...await importOriginal<typeof import("./email-de-retorno")>(),
  rascunharEmailDeRetorno: (...args: unknown[]) => rascunharEmailDeRetorno(...args),
}));
vi.mock("./reuniao-com-ia", async importOriginal => ({
  ...await importOriginal<typeof import("./reuniao-com-ia")>(),
  perguntarAReuniao: (...args: unknown[]) => perguntarAReuniao(...args),
}));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { TRPCError } = await import("@trpc/server");
const { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO } = await import("@shared/email-de-retorno");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const RASCUNHO = { assunto: "Retorno da reunião", corpo: "Olá, {DESTINATARIO}." };
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
const ENTRADA = { meetingId: ID, relacao: "external", tom: "professional", idioma: "pt-BR" } as const;
const rascunhar = (openId?: string, entrada: Record<string, unknown> = {}) => rota(openId).rascunharEmailDeRetorno({ ...ENTRADA, ...entrada } as never);
const perguntar = (openId?: string) => rota(openId).perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Qual prazo ficou combinado?" });

beforeEach(() => {
  tetoDaIADaReuniao.esquecer();
  rascunharEmailDeRetorno.mockReset();
  rascunharEmailDeRetorno.mockResolvedValue(RASCUNHO);
  perguntarAReuniao.mockReset();
  perguntarAReuniao.mockResolvedValue({ respondida: false });
});

describe("meetings.rascunharEmailDeRetorno — o que chega ao serviço", () => {
  it("o openId da dona, a reunião e as escolhas; o rascunho volta como o serviço escreveu", async () => {
    await expect(rascunhar("dona-1", { relacao: "leadership", tom: "urgent", idioma: "ja" })).resolves.toEqual(RASCUNHO);
    expect(rascunharEmailDeRetorno).toHaveBeenCalledWith("dona-1", ID, { relacao: "leadership", tom: "urgent", idioma: "ja", vozDoDestinatario: undefined });
  });

  it("o nome de quem recebe não chega ao serviço, nem mandado por engano", async () => {
    await rascunhar("dona-1", { destinatario: "Carla Souza", vozDoDestinatario: "F2" });
    const [, , pedido] = rascunharEmailDeRetorno.mock.calls[0];
    expect(pedido).toEqual({ relacao: "external", tom: "professional", idioma: "pt-BR", vozDoDestinatario: "F2" });
    expect(JSON.stringify(rascunharEmailDeRetorno.mock.calls)).not.toContain("Carla");
  });

  it.each([
    ["relação fora da lista", { relacao: "amiga" }],
    ["tom fora da lista", { tom: "ríspido" }],
    ["idioma fora da lista", { idioma: "it" }],
    ["voz que não é rótulo", { vozDoDestinatario: "Ana" }],
    ["voz F0", { vozDoDestinatario: "F0" }],
    ["reunião sem uuid", { meetingId: "reuniao-1" }],
  ])("%s: BAD_REQUEST, sem chamar o serviço", async (_caso, entrada) => {
    await expect(rascunhar("dona-1", entrada)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rascunharEmailDeRetorno).not.toHaveBeenCalled();
  });

  it("a recusa do serviço sai como veio, com o código e a frase que a tela traduz", async () => {
    rascunharEmailDeRetorno.mockRejectedValueOnce(new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO }));
    await expect(rascunhar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO });
  });
});

describe(`meetings.rascunharEmailDeRetorno — o teto de ${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA} pedidos à IA a cada 10 minutos por dona`, () => {
  it("rascunhos e perguntas somam no mesmo teto; passado ele, TOO_MANY_REQUESTS sem chamar a IA; outra dona passa", async () => {
    const rascunhos = Math.floor(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2);
    for (let i = 0; i < rascunhos; i++) await rascunhar();
    for (let i = rascunhos; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await perguntar();

    await expect(rascunhar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(rascunharEmailDeRetorno).toHaveBeenCalledTimes(rascunhos);

    await expect(rascunhar("outra-dona")).resolves.toEqual(RASCUNHO);
  });

  it("o rascunho recusado pelo serviço também gasta a vaga: insistir sem item confirmado esbarra no teto", async () => {
    rascunharEmailDeRetorno.mockRejectedValue(new TRPCError({ code: "PRECONDITION_FAILED", message: MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO }));
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await expect(rascunhar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(rascunhar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("entrada inválida não chega ao teto", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA + 5; i++) {
      await expect(rascunhar("dona-1", { tom: "ríspido" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(rascunhar()).resolves.toEqual(RASCUNHO);
  });
});
