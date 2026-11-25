import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas da tradução do resumo guardado (H11), com o serviço dublado: a dona é
 * a da sessão e gasta a vaga do teto próprio da tradução só quando o serviço
 * chama a IA de fato (nunca a do teto de pedidos à IA, o do Pergunte); pelo
 * link aberto, a vaga dos dois tetos sai do mesmo jeito, e o erro que não é do
 * teto, da IA ou do banco não vai cru a quem não tem conta. O serviço está em
 * traducao-do-resumo.test.ts.
 */
const servico = vi.hoisted(() => ({
  traduzirResumoDaDona: vi.fn(),
  traduzirResumoPeloLink: vi.fn(),
}));
const link = vi.hoisted(() => ({ exigirReuniaoDoLink: vi.fn() }));
vi.mock("./traducao-do-resumo", async importOriginal => ({
  ...await importOriginal<typeof import("./traducao-do-resumo")>(),
  traduzirResumoDaDona: (...args: unknown[]) => servico.traduzirResumoDaDona(...args),
  traduzirResumoPeloLink: (...args: unknown[]) => servico.traduzirResumoPeloLink(...args),
}));
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./link-aberto-da-reuniao")>(),
  exigirReuniaoDoLink: (...args: unknown[]) => link.exigirReuniaoDoLink(...args),
}));
// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { meetingsRouter, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA, TRADUCOES_DO_RESUMO_POR_JANELA, tetoDaIADaReuniao } = await import("./routers/meetings");
const { reuniaoAbertaRouter, MENSAGEM_TRADUCAO_INDISPONIVEL, PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA } = await import("./routers/reuniaoAberta");
const { LinkAbertoRecusado, MENSAGEM_LINK_NAO_ENCONTRADO } = await import("./link-aberto-da-reuniao");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { MENSAGEM_BANCO_INDISPONIVEL } = await import("@shared/const");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PRONTA = { estado: "pronta", idioma: "en", itens: [], mapa: {} };
const daDona = (openId: string) => meetingsRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
} as never);
const doLink = (ip = "203.0.113.10") => reuniaoAbertaRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: ip }, ip }, res: { cookie: () => {} } } as never);

beforeEach(() => {
  servico.traduzirResumoDaDona.mockReset().mockResolvedValue(PRONTA);
  servico.traduzirResumoPeloLink.mockReset().mockResolvedValue(PRONTA);
  link.exigirReuniaoDoLink.mockReset().mockImplementation(async () => ({ id: `reuniao-${Math.random()}`, ownerId: "dona-1", title: "T", createdAt: 1, emPartes: false }));
});

describe("meetings.traduzirResumo, da dona", () => {
  it("a dona é a da sessão, e a resposta do serviço sai como está", async () => {
    await expect(daDona("dona-1").traduzirResumo({ meetingId: ID, idioma: "en" })).resolves.toEqual(PRONTA);
    expect(servico.traduzirResumoDaDona).toHaveBeenCalledWith("dona-1", ID, "en", expect.any(Function));
  });

  it("a tradução guardada não gasta vaga; a que chama a IA gasta a do teto próprio da tradução, e não a do Pergunte", async () => {
    const dona = `dona-${Math.random()}`;
    const rota = daDona(dona);
    // Guardada: o serviço não chama o "antes", e nada conta.
    for (let i = 0; i < TRADUCOES_DO_RESUMO_POR_JANELA + 5; i++) await rota.traduzirResumo({ meetingId: ID, idioma: "es" });
    // Na IA: cada pedido gasta uma vaga, até o teto (editar e traduzir em laço não chama a IA sem limite).
    servico.traduzirResumoDaDona.mockImplementation(async (_dona: string, _id: string, idioma: string, antes: () => void) => { antes(); return { estado: "traduzindo", idioma }; });
    for (let i = 0; i < TRADUCOES_DO_RESUMO_POR_JANELA; i++) await rota.traduzirResumo({ meetingId: ID, idioma: "es" });
    await expect(rota.traduzirResumo({ meetingId: ID, idioma: "es" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // O teto dos pedidos à IA (o Pergunte, o resumo, o e-mail) segue inteiro.
    expect(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA).toBeGreaterThan(0);
    expect(() => tetoDaIADaReuniao.conferir(dona)).not.toThrow();
  });

  it("entrada inválida é recusada antes do serviço: id que não é uuid e idioma fora dos 10", async () => {
    const rota = daDona("dona-1");
    await expect(rota.traduzirResumo({ meetingId: "nao-e-uuid", idioma: "en" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota.traduzirResumo({ meetingId: ID, idioma: "it" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.traduzirResumoDaDona).not.toHaveBeenCalled();
  });
});

describe("reuniaoAberta.traduzirResumo, pelo link", () => {
  it("confere o link e passa ao serviço a reunião dele e o idioma", async () => {
    const reuniao = { id: "reuniao-do-link", ownerId: "dona-1", title: "T", createdAt: 1, emPartes: false };
    link.exigirReuniaoDoLink.mockResolvedValueOnce(reuniao);
    await expect(doLink().traduzirResumo({ token: TOKEN, idioma: "de" })).resolves.toEqual(PRONTA);
    expect(link.exigirReuniaoDoLink).toHaveBeenCalledWith(TOKEN);
    expect(servico.traduzirResumoPeloLink).toHaveBeenCalledWith(reuniao, "de", expect.any(Function));
  });

  it("a vaga dos tetos sai só quando o serviço chama a IA: a tradução guardada não conta", async () => {
    const reuniao = { id: "reuniao-guardada", ownerId: "dona-1", title: "T", createdAt: 1, emPartes: false };
    link.exigirReuniaoDoLink.mockResolvedValue(reuniao);
    // Guardada: o serviço não chama o "antes".
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA + 5; i++) await doLink("198.51.100.1").traduzirResumo({ token: TOKEN, idioma: "en" });
    // Não guardada: cada chamada à IA gasta a vaga do visitante.
    servico.traduzirResumoPeloLink.mockImplementation(async (_r: unknown, _i: string, antes: () => void) => { antes(); return { estado: "traduzindo", idioma: "en" }; });
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await doLink("198.51.100.1").traduzirResumo({ token: TOKEN, idioma: "en" });
    await expect(doLink("198.51.100.1").traduzirResumo({ token: TOKEN, idioma: "en" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("link desligado é NOT_FOUND, sem chamar o serviço", async () => {
    link.exigirReuniaoDoLink.mockRejectedValueOnce(new LinkAbertoRecusado("NOT_FOUND", MENSAGEM_LINK_NAO_ENCONTRADO));
    await expect(doLink().traduzirResumo({ token: TOKEN, idioma: "en" })).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_LINK_NAO_ENCONTRADO });
    expect(servico.traduzirResumoPeloLink).not.toHaveBeenCalled();
  });

  it("erro que não é do teto, da IA nem do banco vira SERVICE_UNAVAILABLE com frase neutra, e o log não leva o token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    servico.traduzirResumoPeloLink.mockRejectedValueOnce(new Error("LLM invoke failed: 401 chave-secreta-do-provedor"));
    const erro = await doLink().traduzirResumo({ token: TOKEN, idioma: "en" }).catch(e => e);
    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_INDISPONIVEL });
    expect(String(erro.message)).not.toContain("chave-secreta");
    const registrado = vi.mocked(console.error).mock.calls.map(c => c.join(" ")).join("\n");
    expect(registrado).not.toContain(TOKEN);
  });

  it("a recusa do serviço (IA fora) e o banco fora do ar saem como são", async () => {
    servico.traduzirResumoPeloLink.mockRejectedValueOnce(new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "A tradução do resumo não respondeu agora." }));
    await expect(doLink().traduzirResumo({ token: TOKEN, idioma: "en" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "A tradução do resumo não respondeu agora." });
    servico.traduzirResumoPeloLink.mockRejectedValueOnce(new BancoIndisponivel());
    await expect(doLink().traduzirResumo({ token: TOKEN, idioma: "en" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
  });

  it("entrada inválida é recusada antes de tudo", async () => {
    await expect(doLink().traduzirResumo({ token: "x".repeat(129), idioma: "en" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(doLink().traduzirResumo({ token: TOKEN, idioma: "pt" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(link.exigirReuniaoDoLink).not.toHaveBeenCalled();
  });
});
