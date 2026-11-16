import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas da agenda (H16a), com o serviço dublado. Prova o que fica no router:
 * a dona é sempre a da sessão, e a entrada é conferida e limpa antes de chegar
 * ao serviço (título, início, duração, fuso, local, participantes e lembrete).
 */
const servico = vi.hoisted(() => ({
  listarAgendaDaDona: vi.fn(async () => ({ proximas: [], anteriores: [] })),
  obterDaAgenda: vi.fn(async () => ({ id: "x" })),
  criarNaAgenda: vi.fn(async () => ({ id: "nova" })),
  atualizarNaAgenda: vi.fn(async (_dona: string, id: string) => ({ id })),
  excluirDaAgenda: vi.fn(async () => undefined),
  ligarGravacaoNaAgenda: vi.fn(async () => undefined),
}));
vi.mock("./agenda-de-reunioes", () => servico);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { agendaRouter } = await import("./routers/agenda");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const REUNIAO = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "bronze", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
}) as never;
const daDona = (openId = "dona-1") => agendaRouter.createCaller(contexto(openId));

const valida = {
  titulo: "  Reunião com a Bia  ",
  inicioEm: Date.UTC(2026, 10, 20, 17, 0),
  duracaoMinutos: 90,
  fuso: "america/sao_paulo",
  local: "  ",
  participantes: [{ nome: " Ana ", email: " Ana@Exemplo.com " }, { nome: "Bia", email: "" }, { nome: null, email: "cris@exemplo.com" }],
  lembreteMinutos: 15,
};

beforeEach(() => {
  for (const f of Object.values(servico)) f.mockClear();
});

describe("rotas da agenda", () => {
  it("a dona é a da sessão em todas", async () => {
    const rota = daDona("dona-1");
    await rota.listar();
    await rota.obter({ id: ID });
    await rota.criar(valida);
    await rota.atualizar({ ...valida, id: ID });
    expect(await rota.excluir({ id: ID })).toEqual({ ok: true });
    expect(await rota.ligarGravacao({ id: ID, meetingId: REUNIAO })).toEqual({ ok: true });
    expect(servico.listarAgendaDaDona).toHaveBeenCalledWith("dona-1");
    expect(servico.obterDaAgenda).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.any(Object));
    expect(servico.atualizarNaAgenda).toHaveBeenCalledWith("dona-1", ID, expect.not.objectContaining({ id: ID }));
    expect(servico.excluirDaAgenda).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.ligarGravacaoNaAgenda).toHaveBeenCalledWith("dona-1", ID, REUNIAO);
  });

  it("a entrada chega limpa: título sem espaço, fuso canônico, local vazio vira nulo, e-mail em minúsculas, participante sem e-mail fica com o nome", async () => {
    await daDona().criar(valida);
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", {
      titulo: "Reunião com a Bia",
      inicioEm: valida.inicioEm,
      duracaoMinutos: 90,
      fuso: "America/Sao_Paulo",
      local: null,
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
      lembreteMinutos: 15,
    });
  });

  it("sem participantes e sem lembrete também vale", async () => {
    const { participantes: _p, lembreteMinutos: _l, ...semOpcionais } = valida;
    await daDona().criar(semOpcionais as never);
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.objectContaining({ participantes: [], lembreteMinutos: null }));
  });

  it.each([
    ["título curto demais", { titulo: " a " }],
    ["título longo demais", { titulo: "x".repeat(201) }],
    ["início antes de 2020", { inicioEm: Date.UTC(2019, 11, 31) }],
    ["início com fração", { inicioEm: 1.5 }],
    ["duração abaixo de 5 min", { duracaoMinutos: 4 }],
    ["duração acima de 12 h", { duracaoMinutos: 721 }],
    ["fuso desconhecido", { fuso: "Marte/Base_Alfa" }],
    ["local longo demais", { local: "x".repeat(501) }],
    ["participante sem nome e sem e-mail", { participantes: [{ nome: "  ", email: "" }] }],
    ["e-mail inválido", { participantes: [{ nome: "Ana", email: "ana-arroba-exemplo" }] }],
    ["participantes demais", { participantes: Array.from({ length: 51 }, (_, i) => ({ nome: `P${i}`, email: null })) }],
    ["lembrete fora das opções", { lembreteMinutos: 7 }],
  ])("%s é recusado antes do serviço (BAD_REQUEST)", async (_caso, troca) => {
    await expect(daDona().criar({ ...valida, ...troca } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().atualizar({ ...valida, ...troca, id: ID } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.criarNaAgenda).not.toHaveBeenCalled();
    expect(servico.atualizarNaAgenda).not.toHaveBeenCalled();
  });

  it("ids fora do formato são recusados antes do serviço", async () => {
    await expect(daDona().obter({ id: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().excluir({ id: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().ligarGravacao({ id: ID, meetingId: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.obterDaAgenda).not.toHaveBeenCalled();
    expect(servico.excluirDaAgenda).not.toHaveBeenCalled();
    expect(servico.ligarGravacaoNaAgenda).not.toHaveBeenCalled();
  });

  it("sem sessão, nada", async () => {
    const semConta = agendaRouter.createCaller({ user: null, req: { headers: {} }, res: { cookie: () => {} } } as never);
    await expect(semConta.listar()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(servico.listarAgendaDaDona).not.toHaveBeenCalled();
  });
});
