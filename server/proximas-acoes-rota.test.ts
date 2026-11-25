import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXTO_DA_ACAO_MAX } from "@shared/proximas-acoes";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas das próximas ações (H5a), com o serviço dublado. Prova o que fica no
 * router: a dona é sempre a da sessão, sem sessão não entra, e a entrada é
 * validada antes de tudo (texto, tamanhos, prazo de verdade, vazio vira nulo).
 * Desde a H5c, anotar, editar, marcar e apagar passam pela Google Agenda
 * (server/acoes-na-google.ts), com o fuso e os rótulos que a tela manda; o que
 * o serviço faz está em proximas-acoes.test.ts e acoes-na-google.test.ts.
 */
const servico = vi.hoisted(() => ({
  listarProximasAcoes: vi.fn(async () => ({ acoes: [], abertas: 0, limite: 300 })),
  proximasAcoesDoPainel: vi.fn(async () => ({ acoes: [], abertas: 0 })),
  ligarContato: vi.fn(async () => undefined),
}));
vi.mock("./proximas-acoes", () => servico);
const naGoogle = vi.hoisted(() => ({
  criarAcaoComAGoogle: vi.fn(async (..._args: unknown[]) => ({ id: "nova", naGoogle: null })),
  editarAcaoComAGoogle: vi.fn(async (..._args: unknown[]) => ({ naGoogle: null })),
  marcarAcaoFeitaComAGoogle: vi.fn(async (..._args: unknown[]) => ({ naGoogle: "ok" })),
  apagarAcaoComAGoogle: vi.fn(async (..._args: unknown[]) => ({ naGoogle: "falhou", motivo: "google" })),
  mandarAcaoParaGoogle: vi.fn(async (..._args: unknown[]) => ({ naGoogle: "ok" })),
  tirarDaGoogleAAcaoQueSaiu: vi.fn(async (..._args: unknown[]) => ({ naGoogle: "ok" })),
}));
vi.mock("./acoes-na-google", () => naGoogle);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { proximasAcoesRouter } = await import("./routers/proximasAcoes");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const CONTA = { id: 7, openId: "dona-1" };
const ROTULOS = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
const requisicao = { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" };
const daDona = (openId = "dona-1") => proximasAcoesRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "bronze", onboardingCompleted: true },
  req: requisicao, res: { cookie: () => {} },
} as never);
const semSessao = () => proximasAcoesRouter.createCaller({ user: null, req: requisicao, res: { cookie: () => {} } } as never);

beforeEach(() => {
  for (const f of [...Object.values(servico), ...Object.values(naGoogle)]) f.mockClear();
});

describe("rotas das próximas ações", () => {
  it("a dona é a da sessão em todas, e a resposta traz o que houve na Google", async () => {
    const rota = daDona("dona-1");
    await rota.listar({ filtro: "todas" });
    await rota.doPainel();
    expect(await rota.criar({ texto: "Mandar o contrato" })).toEqual({ id: "nova", naGoogle: null });
    expect(await rota.editar({ id: ID, texto: "Outro" })).toEqual({ ok: true, naGoogle: null });
    expect(await rota.marcarFeita({ id: ID, feita: true })).toEqual({ ok: true, naGoogle: "ok" });
    await rota.ligarContato({ id: ID, contactId: 42 });
    expect(await rota.apagar({ id: ID })).toEqual({ ok: true, naGoogle: "falhou", motivo: "google" });
    expect(await rota.mandarParaGoogle({ id: ID })).toEqual({ naGoogle: "ok" });
    expect(await rota.tirarDaGoogle({ id: ID })).toEqual({ naGoogle: "ok" });
    expect(servico.listarProximasAcoes).toHaveBeenCalledWith("dona-1", "todas");
    expect(servico.proximasAcoesDoPainel).toHaveBeenCalledWith("dona-1");
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, expect.objectContaining({ texto: "Mandar o contrato" }), expect.anything());
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, ID, { texto: "Outro" }, expect.anything());
    expect(naGoogle.marcarAcaoFeitaComAGoogle).toHaveBeenCalledWith(CONTA, ID, true, expect.anything());
    expect(servico.ligarContato).toHaveBeenCalledWith("dona-1", ID, 42);
    expect(naGoogle.apagarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, ID);
    expect(naGoogle.mandarAcaoParaGoogle).toHaveBeenCalledWith(CONTA, ID, expect.anything());
    expect(naGoogle.tirarDaGoogleAAcaoQueSaiu).toHaveBeenCalledWith(CONTA, ID);
  });

  it("sem sessão, nada", async () => {
    await expect(semSessao().doPainel()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().criar({ texto: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().mandarParaGoogle({ id: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().tirarDaGoogle({ id: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(servico.proximasAcoesDoPainel).not.toHaveBeenCalled();
    expect(naGoogle.criarAcaoComAGoogle).not.toHaveBeenCalled();
    expect(naGoogle.mandarAcaoParaGoogle).not.toHaveBeenCalled();
    expect(naGoogle.tirarDaGoogleAAcaoQueSaiu).not.toHaveBeenCalled();
  });

  it("a lista abre nas abertas", async () => {
    await daDona().listar({});
    expect(servico.listarProximasAcoes).toHaveBeenCalledWith("dona-1", "abertas");
  });

  it("anotar: o texto é aparado e obrigatório; vazio nos opcionais vira nulo", async () => {
    await daDona().criar({ texto: "  Ligar para a Bia  ", detalhe: "", responsavel: " ", prazo: "", contactId: null });
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, {
      texto: "Ligar para a Bia", detalhe: null, responsavel: null, prazo: null, contactId: null,
    }, { fuso: undefined, rotulos: undefined });
    await expect(daDona().criar({ texto: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x".repeat(TEXTO_DA_ACAO_MAX + 1) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x", responsavel: "r".repeat(121) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x", contactId: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenCalledTimes(1);
  });

  it("o prazo é um dia que existe no calendário", async () => {
    await daDona().criar({ texto: "x", prazo: "2026-11-20" });
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenLastCalledWith(CONTA, expect.objectContaining({ prazo: "2026-11-20" }), expect.anything());
    for (const prazo of ["2026-02-30", "20/11/2026", "2026-11-20T10:00", "1999-12-31", "amanhã"]) {
      await expect(daDona().criar({ texto: "x", prazo })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenCalledTimes(1);
  });

  it("editar manda só o que veio: o campo ausente não vira nulo", async () => {
    await daDona().editar({ id: ID, prazo: "" });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, ID, { prazo: null }, { fuso: undefined, rotulos: undefined });
    await expect(daDona().editar({ id: "nao-e-uuid", texto: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("editar a ação que veio de uma tarefa longa do resumo (700 letras, mais os nomes das vozes) passa; acima do teto, não", async () => {
    const daTarefa = `${"A".repeat(60)} fecha o contrato com ${"B".repeat(60)} ${"x".repeat(670)}`;
    await daDona().editar({ id: ID, texto: daTarefa });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenCalledWith(CONTA, ID, { texto: daTarefa }, expect.anything());
    await expect(daDona().editar({ id: ID, texto: "x".repeat(TEXTO_DA_ACAO_MAX + 1) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenCalledTimes(1);
  });

  it("o fuso do aparelho vai ao serviço com o prazo, para o lembrete no sino (H15) e a hora do evento (H5c); ausente, não vai; comprido demais, recusa", async () => {
    await daDona().criar({ texto: "x", prazo: "2026-11-20", fuso: " America/Recife " });
    expect(naGoogle.criarAcaoComAGoogle).toHaveBeenLastCalledWith(CONTA, expect.objectContaining({ prazo: "2026-11-20", fuso: "America/Recife" }),
      { fuso: "America/Recife", rotulos: undefined });
    await daDona().editar({ id: ID, prazo: "2026-11-21", fuso: "Asia/Tokyo" });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenLastCalledWith(CONTA, ID, { prazo: "2026-11-21", fuso: "Asia/Tokyo" }, { fuso: "Asia/Tokyo", rotulos: undefined });
    await daDona().editar({ id: ID, prazo: "2026-11-22" });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenLastCalledWith(CONTA, ID, { prazo: "2026-11-22" }, { fuso: undefined, rotulos: undefined });
    await expect(daDona().criar({ texto: "x", fuso: "z".repeat(65) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("os rótulos da tela (H5c) vão ao serviço à parte dos dados da ação; compridos demais, recusa", async () => {
    await daDona().criar({ texto: "x", prazo: "2026-11-20", fuso: "America/Recife", rotulos: ROTULOS });
    const [, dados, pedido] = naGoogle.criarAcaoComAGoogle.mock.calls[0];
    expect(dados).not.toHaveProperty("rotulos");
    expect(pedido).toEqual({ fuso: "America/Recife", rotulos: ROTULOS });
    await daDona().editar({ id: ID, texto: "y", rotulos: ROTULOS });
    expect(naGoogle.editarAcaoComAGoogle).toHaveBeenLastCalledWith(CONTA, ID, { texto: "y" }, { fuso: undefined, rotulos: ROTULOS });
    await daDona().marcarFeita({ id: ID, feita: false, fuso: "Europe/Lisbon", rotulos: ROTULOS });
    expect(naGoogle.marcarAcaoFeitaComAGoogle).toHaveBeenLastCalledWith(CONTA, ID, false, { fuso: "Europe/Lisbon", rotulos: ROTULOS });
    await daDona().mandarParaGoogle({ id: ID, fuso: "Europe/Lisbon", rotulos: ROTULOS });
    expect(naGoogle.mandarAcaoParaGoogle).toHaveBeenLastCalledWith(CONTA, ID, { fuso: "Europe/Lisbon", rotulos: ROTULOS });
    await expect(daDona().criar({ texto: "x", rotulos: { voz: "v".repeat(81), responsavel: "{nome}" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().mandarParaGoogle({ id: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().tirarDaGoogle({ id: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tirar o contato é contactId null; id que não é número positivo é recusado", async () => {
    await daDona().ligarContato({ id: ID, contactId: null });
    expect(servico.ligarContato).toHaveBeenCalledWith("dona-1", ID, null);
    await expect(daDona().ligarContato({ id: ID, contactId: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
