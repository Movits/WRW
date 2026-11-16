import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXTO_DA_ACAO_MAX } from "@shared/proximas-acoes";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas das próximas ações (H5a), com o serviço dublado. Prova o que fica no
 * router: a dona é sempre a da sessão, sem sessão não entra, e a entrada é
 * validada antes de tudo (texto, tamanhos, prazo de verdade, vazio vira nulo).
 * O que o serviço faz está em proximas-acoes.test.ts.
 */
const servico = vi.hoisted(() => ({
  listarProximasAcoes: vi.fn(async () => ({ acoes: [], abertas: 0, limite: 300 })),
  proximasAcoesDoPainel: vi.fn(async () => ({ acoes: [], abertas: 0 })),
  criarProximaAcao: vi.fn(async () => ({ id: "nova" })),
  editarProximaAcao: vi.fn(async () => undefined),
  marcarProximaAcaoFeita: vi.fn(async () => undefined),
  ligarContato: vi.fn(async () => undefined),
  apagarProximaAcao: vi.fn(async () => undefined),
}));
vi.mock("./proximas-acoes", () => servico);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { proximasAcoesRouter } = await import("./routers/proximasAcoes");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const requisicao = { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" };
const daDona = (openId = "dona-1") => proximasAcoesRouter.createCaller({
  user: { id: 7, openId, email: `${openId}@local`, role: "bronze", onboardingCompleted: true },
  req: requisicao, res: { cookie: () => {} },
} as never);
const semSessao = () => proximasAcoesRouter.createCaller({ user: null, req: requisicao, res: { cookie: () => {} } } as never);

beforeEach(() => {
  for (const f of Object.values(servico)) f.mockClear();
});

describe("rotas das próximas ações", () => {
  it("a dona é a da sessão em todas", async () => {
    const rota = daDona("dona-1");
    await rota.listar({ filtro: "todas" });
    await rota.doPainel();
    await rota.criar({ texto: "Mandar o contrato" });
    await rota.editar({ id: ID, texto: "Outro" });
    await rota.marcarFeita({ id: ID, feita: true });
    await rota.ligarContato({ id: ID, contactId: 42 });
    await rota.apagar({ id: ID });
    expect(servico.listarProximasAcoes).toHaveBeenCalledWith("dona-1", "todas");
    expect(servico.proximasAcoesDoPainel).toHaveBeenCalledWith("dona-1");
    expect(servico.criarProximaAcao).toHaveBeenCalledWith("dona-1", expect.objectContaining({ texto: "Mandar o contrato" }));
    expect(servico.editarProximaAcao).toHaveBeenCalledWith("dona-1", ID, { texto: "Outro" });
    expect(servico.marcarProximaAcaoFeita).toHaveBeenCalledWith("dona-1", ID, true);
    expect(servico.ligarContato).toHaveBeenCalledWith("dona-1", ID, 42);
    expect(servico.apagarProximaAcao).toHaveBeenCalledWith("dona-1", ID);
  });

  it("sem sessão, nada", async () => {
    await expect(semSessao().doPainel()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semSessao().criar({ texto: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(servico.proximasAcoesDoPainel).not.toHaveBeenCalled();
    expect(servico.criarProximaAcao).not.toHaveBeenCalled();
  });

  it("a lista abre nas abertas", async () => {
    await daDona().listar({});
    expect(servico.listarProximasAcoes).toHaveBeenCalledWith("dona-1", "abertas");
  });

  it("anotar: o texto é aparado e obrigatório; vazio nos opcionais vira nulo", async () => {
    await daDona().criar({ texto: "  Ligar para a Bia  ", detalhe: "", responsavel: " ", prazo: "", contactId: null });
    expect(servico.criarProximaAcao).toHaveBeenCalledWith("dona-1", {
      texto: "Ligar para a Bia", detalhe: null, responsavel: null, prazo: null, contactId: null,
    });
    await expect(daDona().criar({ texto: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x".repeat(TEXTO_DA_ACAO_MAX + 1) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x", responsavel: "r".repeat(121) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().criar({ texto: "x", contactId: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.criarProximaAcao).toHaveBeenCalledTimes(1);
  });

  it("o prazo é um dia que existe no calendário", async () => {
    await daDona().criar({ texto: "x", prazo: "2026-11-20" });
    expect(servico.criarProximaAcao).toHaveBeenLastCalledWith("dona-1", expect.objectContaining({ prazo: "2026-11-20" }));
    for (const prazo of ["2026-02-30", "20/11/2026", "2026-11-20T10:00", "1999-12-31", "amanhã"]) {
      await expect(daDona().criar({ texto: "x", prazo })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(servico.criarProximaAcao).toHaveBeenCalledTimes(1);
  });

  it("editar manda só o que veio: o campo ausente não vira nulo", async () => {
    await daDona().editar({ id: ID, prazo: "" });
    expect(servico.editarProximaAcao).toHaveBeenCalledWith("dona-1", ID, { prazo: null });
    await expect(daDona().editar({ id: "nao-e-uuid", texto: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("editar a ação que veio de uma tarefa longa do resumo (700 letras, mais os nomes das vozes) passa; acima do teto, não", async () => {
    const daTarefa = `${"A".repeat(60)} fecha o contrato com ${"B".repeat(60)} ${"x".repeat(670)}`;
    await daDona().editar({ id: ID, texto: daTarefa });
    expect(servico.editarProximaAcao).toHaveBeenCalledWith("dona-1", ID, { texto: daTarefa });
    await expect(daDona().editar({ id: ID, texto: "x".repeat(TEXTO_DA_ACAO_MAX + 1) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.editarProximaAcao).toHaveBeenCalledTimes(1);
  });

  it("o fuso do aparelho vai ao serviço com o prazo, para o lembrete no sino (H15); ausente, não vai; comprido demais, recusa", async () => {
    await daDona().criar({ texto: "x", prazo: "2026-11-20", fuso: " America/Recife " });
    expect(servico.criarProximaAcao).toHaveBeenLastCalledWith("dona-1", expect.objectContaining({ prazo: "2026-11-20", fuso: "America/Recife" }));
    await daDona().editar({ id: ID, prazo: "2026-11-21", fuso: "Asia/Tokyo" });
    expect(servico.editarProximaAcao).toHaveBeenLastCalledWith("dona-1", ID, { prazo: "2026-11-21", fuso: "Asia/Tokyo" });
    await daDona().editar({ id: ID, prazo: "2026-11-22" });
    expect(servico.editarProximaAcao).toHaveBeenLastCalledWith("dona-1", ID, { prazo: "2026-11-22" });
    await expect(daDona().criar({ texto: "x", fuso: "z".repeat(65) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tirar o contato é contactId null; id que não é número positivo é recusado", async () => {
    await daDona().ligarContato({ id: ID, contactId: null });
    expect(servico.ligarContato).toHaveBeenCalledWith("dona-1", ID, null);
    await expect(daDona().ligarContato({ id: ID, contactId: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
