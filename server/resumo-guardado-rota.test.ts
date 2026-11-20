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
  decidirItemDoResumo: vi.fn(async (..._args: unknown[]) => ({ acaoSaiu: true })),
  confirmarItensDoResumo: vi.fn(async () => 2),
  marcarAcaoFeita: vi.fn(async () => undefined),
  editarItemDoResumo: vi.fn(async (..._args: unknown[]) => ({ acaoQueMudou: null as string | null })),
  acrescentarItemDoResumo: vi.fn(async () => "item-novo"),
  resumoGuardadoPeloLink: vi.fn(async () => ({ estado: "sem_resumo", emoji: null, idioma: null, itens: [] })),
  pedirResumoPeloLink: vi.fn(),
}));
vi.mock("./resumo-guardado", () => servico);
// A Google Agenda da próxima ação do item (H5c) é dublê: o que ela faz está em acoes-na-google.test.ts.
const PREPARO = { acaoId: "acao-1", estavaNaGoogle: true, acesso: { token: "t" }, ligada: true };
const naGoogle = vi.hoisted(() => ({
  prepararAcaoDoItem: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  depoisDeMexerNoItem: vi.fn(async (..._args: unknown[]) => ({ acaoId: null as string | null, naGoogle: null })),
}));
vi.mock("./acoes-na-google", () => naGoogle);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { CAMPO_DO_ITEM_DO_RESUMO_MAX, TEXTO_DO_ITEM_DO_RESUMO_MAX } = await import("@shared/item-do-resumo");
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
  for (const f of [...Object.values(servico), ...Object.values(naGoogle)]) f.mockClear();
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

  it("desconfirmar e marcar a ação no resumo passam pela Google Agenda da ação do item (H5c); confirmar, não", async () => {
    const rota = daDona("dona-1");
    const CONTA = { id: 7, openId: "dona-1" };
    naGoogle.prepararAcaoDoItem.mockResolvedValueOnce(PREPARO);
    naGoogle.depoisDeMexerNoItem.mockResolvedValueOnce({ acaoId: "acao-1", naGoogle: "falhou", motivo: "google" } as never);
    // O token vem antes da decisão; o evento sai depois, e o id da ação volta para o "Tentar de novo".
    expect(await rota.decidirItemDoResumo({ itemId: ID, status: "pending" })).toEqual({ ok: true, acaoId: "acao-1", naGoogle: "falhou", motivo: "google" });
    expect(naGoogle.prepararAcaoDoItem).toHaveBeenCalledWith(CONTA, ID);
    expect(naGoogle.prepararAcaoDoItem.mock.invocationCallOrder[0]).toBeLessThan(servico.decidirItemDoResumo.mock.invocationCallOrder[0]);
    expect(naGoogle.depoisDeMexerNoItem).toHaveBeenCalledWith(CONTA, PREPARO, false);
    // Confirmar cria a ação sem prazo: nada vai à Google.
    naGoogle.prepararAcaoDoItem.mockClear();
    await rota.decidirItemDoResumo({ itemId: ID, status: "confirmed" });
    expect(naGoogle.prepararAcaoDoItem).not.toHaveBeenCalled();
    // Reabrir no resumo manda de novo, com o fuso e os rótulos da tela.
    const rotulos = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
    await rota.marcarAcaoFeita({ itemId: ID, feito: false, fuso: "America/Recife", rotulos });
    expect(naGoogle.depoisDeMexerNoItem).toHaveBeenLastCalledWith(CONTA, null, true, { fuso: "America/Recife", rotulos });
    await rota.marcarAcaoFeita({ itemId: ID, feito: true });
    expect(naGoogle.depoisDeMexerNoItem).toHaveBeenLastCalledWith(CONTA, null, false, { fuso: undefined, rotulos: undefined });
    await expect(rota.marcarAcaoFeita({ itemId: ID, feito: true, fuso: "z".repeat(65) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // Depois da junção com a H4f: o item que a dona escreveu, pedido de volta a
  // "para conferir", fica confirmado, e a ação dele, com o evento, fica. A rota
  // segue o que o serviço gravou, e não o pedido.
  it("o item que fica confirmado com o pedido de 'para conferir' não tira o evento da Google", async () => {
    const rota = daDona("dona-1");
    naGoogle.prepararAcaoDoItem.mockResolvedValueOnce(PREPARO);
    servico.decidirItemDoResumo.mockResolvedValueOnce({ acaoSaiu: false });
    expect(await rota.decidirItemDoResumo({ itemId: ID, status: "pending" })).toEqual({ ok: true, acaoId: null, naGoogle: null });
    expect(naGoogle.depoisDeMexerNoItem).not.toHaveBeenCalled();
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

describe("rotas da dona que editam e acrescentam itens (H4f)", () => {
  it("a dona é a da sessão; os campos chegam aparados, e o vazio ou ausente vira nulo", async () => {
    const rota = daDona("dona-1");
    expect(await rota.editarItemDoResumo({ itemId: ID, texto: "  {F2} envia a proposta  ", assunto: "   ", responsavel: " {F2} ", prazo: "" }))
      .toEqual({ ok: true, acaoId: null, naGoogle: null });
    expect(servico.editarItemDoResumo).toHaveBeenCalledWith("dona-1", ID, { texto: "{F2} envia a proposta", assunto: null, responsavel: "{F2}", prazo: null });
    expect(await rota.acrescentarItemDoResumo({ meetingId: ID, secao: "task", texto: "Revisar o contrato", assunto: " Contrato " }))
      .toEqual({ id: "item-novo" });
    expect(servico.acrescentarItemDoResumo).toHaveBeenCalledWith("dona-1", ID, "task", { texto: "Revisar o contrato", assunto: "Contrato", responsavel: null, prazo: null });
  });

  it("entrada inválida é recusada antes do serviço: texto vazio ou longo demais, campo longo demais, seção que não existe", async () => {
    const rota = daDona();
    const recusas = [
      rota.editarItemDoResumo({ itemId: ID, texto: "   " }),
      rota.editarItemDoResumo({ itemId: ID, texto: "a".repeat(TEXTO_DO_ITEM_DO_RESUMO_MAX + 1) }),
      rota.editarItemDoResumo({ itemId: ID, texto: "ok", prazo: "p".repeat(CAMPO_DO_ITEM_DO_RESUMO_MAX + 1) }),
      rota.editarItemDoResumo({ itemId: "nao-e-uuid", texto: "ok" }),
      rota.acrescentarItemDoResumo({ meetingId: ID, secao: "resumo" as never, texto: "ok" }),
      rota.acrescentarItemDoResumo({ meetingId: ID, secao: "action", texto: "ok", responsavel: "r".repeat(CAMPO_DO_ITEM_DO_RESUMO_MAX + 1) }),
    ];
    for (const recusa of recusas) await expect(recusa).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.editarItemDoResumo).not.toHaveBeenCalled();
    expect(servico.acrescentarItemDoResumo).not.toHaveBeenCalled();
    // No limite, passa.
    await rota.editarItemDoResumo({ itemId: ID, texto: "a".repeat(TEXTO_DO_ITEM_DO_RESUMO_MAX), assunto: "s".repeat(CAMPO_DO_ITEM_DO_RESUMO_MAX) });
    expect(servico.editarItemDoResumo).toHaveBeenCalledTimes(1);
  });

  // A próxima ação do item editado leva o texto novo (H5a), e o evento dela na
  // Google Agenda também (H5c): o token vem antes da escrita, e a versão nova
  // vai depois, com o fuso e os rótulos da tela.
  it("editar o item cuja ação mudou manda a versão nova à Google, com o fuso e os rótulos; sem mudança, nada vai", async () => {
    const rota = daDona("dona-1");
    const CONTA = { id: 7, openId: "dona-1" };
    const rotulos = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
    naGoogle.prepararAcaoDoItem.mockResolvedValueOnce(PREPARO);
    servico.editarItemDoResumo.mockResolvedValueOnce({ acaoQueMudou: "acao-1" });
    naGoogle.depoisDeMexerNoItem.mockResolvedValueOnce({ acaoId: "acao-1", naGoogle: "ok" } as never);
    expect(await rota.editarItemDoResumo({ itemId: ID, texto: "Enviar a proposta revisada", fuso: "America/Recife", rotulos }))
      .toEqual({ ok: true, acaoId: "acao-1", naGoogle: "ok" });
    expect(naGoogle.prepararAcaoDoItem.mock.invocationCallOrder[0]).toBeLessThan(servico.editarItemDoResumo.mock.invocationCallOrder[0]);
    expect(naGoogle.depoisDeMexerNoItem).toHaveBeenCalledWith(CONTA, PREPARO, true, { fuso: "America/Recife", rotulos });
    // O fuso e os rótulos não vão ao serviço do resumo.
    expect(servico.editarItemDoResumo).toHaveBeenLastCalledWith("dona-1", ID, { texto: "Enviar a proposta revisada", assunto: null, responsavel: null, prazo: null });
    naGoogle.depoisDeMexerNoItem.mockClear();
    await rota.editarItemDoResumo({ itemId: ID, texto: "Sem mudança" });
    expect(naGoogle.depoisDeMexerNoItem).not.toHaveBeenCalled();
  });

  it("acrescentar não gasta vaga do teto de pedidos à IA", async () => {
    const rota = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA + 1; i++) await rota.acrescentarItemDoResumo({ meetingId: ID, secao: "action", texto: `item ${i}` });
    await expect(rota.pedirResumo({ meetingId: ID })).resolves.toBeDefined();
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
