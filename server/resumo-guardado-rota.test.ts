import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas do resumo guardado (H4), com o serviço dublado. Prova o que fica no
 * router: a dona é sempre a da sessão, o pedido novo gasta uma vaga do teto de
 * pedidos à IA (o mesmo do Pergunte à reunião) e, pelo link aberto, das duas
 * vagas da reunião — e a entrada é validada antes de tudo.
 */
const servico = vi.hoisted(() => ({
  resumoGuardadoDaDona: vi.fn(async () => ({ estado: "sem_resumo", emoji: null, idioma: null, erro: null, itens: [] })),
  pedirResumoDaDona: vi.fn(),
  refazerResumoDaDona: vi.fn(),
  decidirItemDoResumo: vi.fn(async () => undefined),
  confirmarItensDoResumo: vi.fn(async () => 2),
  marcarAcaoFeita: vi.fn(async () => undefined),
  resumoGuardadoPeloLink: vi.fn(async () => ({ estado: "sem_resumo", emoji: null, idioma: null, itens: [] })),
  pedirResumoPeloLink: vi.fn(),
}));
vi.mock("./resumo-guardado", () => servico);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { reuniaoAbertaRouter, PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA, PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA } = await import("./routers/reuniaoAberta");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
}) as never;
const daDona = (openId = `dona-${Math.random()}`) => meetingsRouter.createCaller(contexto(openId));
const doLink = () => reuniaoAbertaRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" }, res: { cookie: () => {} } } as never);

beforeEach(() => {
  for (const f of Object.values(servico)) f.mockClear();
  // O serviço real chama o "antes de criar" só quando há trabalho novo.
  servico.pedirResumoDaDona.mockImplementation(async (_dona: string, _id: string, antesDeCriar: () => void) => { antesDeCriar(); return { estado: "pendente" }; });
  servico.refazerResumoDaDona.mockImplementation(async (_dona: string, _id: string, _modelo: string, antesDeCriar: () => void) => { antesDeCriar(); return { estado: "pendente" }; });
  servico.pedirResumoPeloLink.mockImplementation(async (_token: string, antesDeCriar: (reuniaoId: string) => void) => { antesDeCriar("reuniao-do-link"); return { estado: "pendente" }; });
});

describe("rotas do resumo guardado da dona", () => {
  it("a dona é a da sessão em todas", async () => {
    const rota = daDona("dona-1");
    await rota.resumoGuardado({ meetingId: ID });
    await rota.decidirItemDoResumo({ itemId: ID, status: "ignored" });
    expect(await rota.confirmarItensDoResumo({ meetingId: ID })).toEqual({ confirmados: 2 });
    await rota.marcarAcaoFeita({ itemId: ID, feito: true });
    expect(servico.resumoGuardadoDaDona).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.decidirItemDoResumo).toHaveBeenCalledWith("dona-1", ID, "ignored");
    expect(servico.confirmarItensDoResumo).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.marcarAcaoFeita).toHaveBeenCalledWith("dona-1", ID, true);
  });

  it("pedir o resumo novo gasta uma vaga do teto de pedidos à IA da dona", async () => {
    const rota = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await rota.pedirResumo({ meetingId: ID });
    await expect(rota.pedirResumo({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // A vaga devolvida (pedido que perdeu a corrida) volta a valer.
    servico.pedirResumoDaDona.mockImplementationOnce(async (_d: string, _i: string, antesDeCriar: () => (() => void) | void) => { antesDeCriar(); return { estado: "pendente" }; });
    const outra = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - 1; i++) await outra.pedirResumo({ meetingId: ID });
    servico.pedirResumoDaDona.mockImplementationOnce(async (_d: string, _i: string, antesDeCriar: () => (() => void) | void) => { const soltar = antesDeCriar(); soltar?.(); return { estado: "pendente" }; });
    await outra.pedirResumo({ meetingId: ID });
    await outra.pedirResumo({ meetingId: ID });
    await expect(outra.pedirResumo({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(tetoDaIADaReuniao).toBeDefined();
  });

  it("entrada inválida é recusada antes do serviço", async () => {
    const rota = daDona();
    await expect(rota.resumoGuardado({ meetingId: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota.decidirItemDoResumo({ itemId: ID, status: "aprovado" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.resumoGuardadoDaDona).not.toHaveBeenCalled();
    expect(servico.decidirItemDoResumo).not.toHaveBeenCalled();
  });
});

describe("os modelos do resumo (H4d)", () => {
  it("pedir com modelo e refazer: a dona é a da sessão e o modelo chega ao serviço", async () => {
    const rota = daDona("dona-modelos");
    await rota.pedirResumo({ meetingId: ID, modelo: "sales" });
    await rota.pedirResumo({ meetingId: ID });
    await rota.refazerResumo({ meetingId: ID, modelo: "one_on_one" });
    expect(servico.pedirResumoDaDona).toHaveBeenNthCalledWith(1, "dona-modelos", ID, expect.any(Function), "sales");
    expect(servico.pedirResumoDaDona).toHaveBeenNthCalledWith(2, "dona-modelos", ID, expect.any(Function), undefined);
    expect(servico.refazerResumoDaDona).toHaveBeenCalledWith("dona-modelos", ID, "one_on_one", expect.any(Function));
  });

  it("refazer gasta vaga do mesmo teto de pedidos à IA que pedir o resumo e perguntar", async () => {
    const rota = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - 1; i++) await rota.refazerResumo({ meetingId: ID, modelo: "networking" });
    await rota.pedirResumo({ meetingId: ID });
    await expect(rota.refazerResumo({ meetingId: ID, modelo: "mentoring" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(rota.pedirResumo({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("modelo que não existe, ou refazer sem modelo, é recusado antes do serviço", async () => {
    const rota = daDona();
    await expect(rota.refazerResumo({ meetingId: ID, modelo: "vendas" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota.refazerResumo({ meetingId: ID } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota.pedirResumo({ meetingId: ID, modelo: "geral" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.refazerResumoDaDona).not.toHaveBeenCalled();
    expect(servico.pedirResumoDaDona).not.toHaveBeenCalled();
  });
});

describe("rotas do resumo guardado pelo link aberto", () => {
  it("ler não gasta vaga; pedir o resumo novo gasta a do visitante e a da reunião", async () => {
    const rota = doLink();
    await rota.resumoGuardado({ token: "t".repeat(32) });
    expect(servico.resumoGuardadoPeloLink).toHaveBeenCalledWith("t".repeat(32));
    // A mesma reunião e a mesma rede: o teto do visitante acaba antes do da reunião.
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await rota.pedirResumo({ token: "t".repeat(32) });
    await expect(rota.pedirResumo({ token: "t".repeat(32) })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("o teto da reunião soma as redes: passado o total, até uma rede nova é recusada", async () => {
    servico.pedirResumoPeloLink.mockImplementation(async (_token: string, antesDeCriar: (reuniaoId: string) => void) => { antesDeCriar("reuniao-de-muitas-redes"); return { estado: "pendente" }; });
    const daRede = (n: number) => reuniaoAbertaRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: `198.51.${n}.7` }, ip: `198.51.${n}.7` }, res: { cookie: () => {} } } as never);
    let feitos = 0;
    for (let rede = 0; feitos < PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA; rede++) {
      for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA && feitos < PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA; i++, feitos++) await daRede(rede).pedirResumo({ token: "r".repeat(32) });
    }
    await expect(daRede(250).pedirResumo({ token: "r".repeat(32) })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
