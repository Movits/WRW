import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emailDoParticipanteValido } from "@shared/agenda";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas da agenda (H16a e H16c), com o serviço dublado. Prova o que fica no
 * router: a dona é sempre a da sessão; a entrada é conferida e limpa antes de
 * chegar ao serviço (título, início, duração, fuso, local, participantes,
 * lembrete e o convite pela Google); e, com a Google Agenda conectada, primeiro
 * o banco, depois a Google.
 */
const FICHA = 1_700_000_000_000;
const servico = vi.hoisted(() => ({
  listarAgendaDaDona: vi.fn(async () => ({ proximas: [], anteriores: [] })),
  obterDaAgenda: vi.fn(async () => ({ id: "x" })),
  criarNaAgenda: vi.fn(async () => ({ id: "nova", updatedAt: 1_700_000_000_000 })),
  atualizarNaAgenda: vi.fn(async (_dona: string, id: string) => ({ id, updatedAt: 1_700_000_000_000 })),
  excluirDaAgenda: vi.fn(async () => ({ google: null as string | null, googleConvites: false })),
  ligarGravacaoNaAgenda: vi.fn(async () => undefined),
}));
const naGoogle = vi.hoisted(() => ({
  conectada: vi.fn(async () => false),
  enviarParaGoogle: vi.fn(async (): Promise<Record<string, unknown>> => ({ naGoogle: "ok" })),
  tirarEventoDaGoogle: vi.fn(async (): Promise<Record<string, unknown>> => ({ naGoogle: "ok" })),
  lerParaGoogle: vi.fn(async (_dona: string, id: string) => ({ id, google: "falhou", googleConvites: false, updatedAt: 5 })),
  existeNaAgenda: vi.fn(async () => false),
}));
vi.mock("./agenda-de-reunioes", () => servico);
vi.mock("./google-agenda", () => ({ googleAgendaConectada: naGoogle.conectada }));
vi.mock("./agenda-na-google", () => ({
  enviarParaGoogle: naGoogle.enviarParaGoogle,
  tirarEventoDaGoogle: naGoogle.tirarEventoDaGoogle,
  lerParaGoogle: naGoogle.lerParaGoogle,
  existeNaAgenda: naGoogle.existeNaAgenda,
  MENSAGEM_AINDA_NA_AGENDA: "ainda na agenda",
}));
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
  for (const f of Object.values(naGoogle)) f.mockClear();
  naGoogle.conectada.mockResolvedValue(false);
  naGoogle.enviarParaGoogle.mockResolvedValue({ naGoogle: "ok" });
  naGoogle.tirarEventoDaGoogle.mockResolvedValue({ naGoogle: "ok" });
  naGoogle.existeNaAgenda.mockResolvedValue(false);
  servico.excluirDaAgenda.mockResolvedValue({ google: null, googleConvites: false });
});

describe("rotas da agenda", () => {
  it("a dona é a da sessão em todas", async () => {
    const rota = daDona("dona-1");
    await rota.listar();
    await rota.obter({ id: ID });
    await rota.criar(valida);
    await rota.atualizar({ ...valida, id: ID });
    expect(await rota.excluir({ id: ID })).toEqual({ ok: true, avisarConvidados: false, naGoogle: null });
    expect(await rota.ligarGravacao({ id: ID, meetingId: REUNIAO })).toEqual({ ok: true });
    expect(servico.listarAgendaDaDona).toHaveBeenCalledWith("dona-1");
    expect(servico.obterDaAgenda).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.any(Object), { naGoogle: false });
    expect(servico.atualizarNaAgenda).toHaveBeenCalledWith("dona-1", ID, expect.not.objectContaining({ id: ID }), { naGoogle: false });
    expect(servico.excluirDaAgenda).toHaveBeenCalledWith("dona-1", ID);
    // A conexão Google é a da conta da sessão (o id), não do openId.
    expect(naGoogle.conectada).toHaveBeenCalledWith(7);
    expect(servico.ligarGravacaoNaAgenda).toHaveBeenCalledWith("dona-1", ID, REUNIAO);
  });

  it("a entrada chega limpa: título sem espaço, fuso canônico, local vazio vira nulo, e-mail em minúsculas, participante sem e-mail fica com o nome, convite desmarcado", async () => {
    await daDona().criar(valida);
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", {
      titulo: "Reunião com a Bia",
      inicioEm: valida.inicioEm,
      duracaoMinutos: 90,
      fuso: "America/Sao_Paulo",
      local: null,
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
      lembreteMinutos: 15,
      googleConvites: false,
    }, { naGoogle: false });
  });

  it("sem participantes e sem lembrete também vale", async () => {
    const { participantes: _p, lembreteMinutos: _l, ...semOpcionais } = valida;
    await daDona().criar(semOpcionais as never);
    // Sem o campo do convite (a aba aberta antes do deploy), ele fica desmarcado.
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.objectContaining({ participantes: [], lembreteMinutos: null, googleConvites: false }), { naGoogle: false });
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
    // Os três que a regra frouxa da tela deixava passar (ver o teste da regra única, abaixo).
    ["e-mail com o ponto que o iPhone põe depois de dois espaços", { participantes: [{ nome: "Ana", email: "ana@exemplo.com." }] }],
    ["e-mail com acento", { participantes: [{ nome: "João", email: "joão@exemplo.com.br" }] }],
    ["e-mail com dois pontos seguidos", { participantes: [{ nome: "Ana", email: "ana@exemplo..com" }] }],
    ["participantes demais", { participantes: Array.from({ length: 51 }, (_, i) => ({ nome: `P${i}`, email: null })) }],
    ["lembrete fora das opções", { lembreteMinutos: 7 }],
    ["convite pela Google que não é sim nem não", { googleConvites: "sim" }],
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

  // A tela (pages/Agenda.tsx) e a rota usam emailDoParticipanteValido: o que
  // a tela deixa passar, a rota aceita, e o que a rota recusa a tela aponta,
  // com o número do participante. A regra é a do z.string().email() do zod,
  // copiada para a tela não carregar o zod; aqui as duas são comparadas.
  it("a regra do e-mail do participante é uma só, e é a do zod", async () => {
    const validos = ["ana@exemplo.com", "Ana.Souza+wrw@empresa.com.br", "o'neil@exemplo.ie", "a_b-c@sub-dominio.exemplo.org"];
    const invalidos = [
      "ana@exemplo.com.", "joão@exemplo.com.br", "ana@exemplo..com", ".ana@exemplo.com", "ana.@exemplo.com",
      "ana@exemplo", "ana@-exemplo.com", "ana@exemplo.c", "ana exemplo@x.com", "ana-arroba-exemplo", "",
    ];
    for (const email of [...validos, ...invalidos]) {
      expect(emailDoParticipanteValido(email), email).toBe(z.string().email().safeParse(email).success);
    }
    expect(validos.every(emailDoParticipanteValido)).toBe(true);
    expect(invalidos.some(emailDoParticipanteValido)).toBe(false);
    await daDona().criar({ ...valida, participantes: [{ nome: null, email: "Ana.Souza+wrw@empresa.com.br" }] });
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.objectContaining({ participantes: [{ nome: null, email: "ana.souza+wrw@empresa.com.br" }] }), { naGoogle: false });
  });

  it("sem sessão, nada", async () => {
    const semConta = agendaRouter.createCaller({ user: null, req: { headers: {} }, res: { cookie: () => {} } } as never);
    await expect(semConta.listar()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(servico.listarAgendaDaDona).not.toHaveBeenCalled();
  });
});

describe("rotas da agenda com a Google Agenda (H16c)", () => {
  const ordem = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0];

  it("marcar com a Google Agenda conectada: primeiro o banco ('pendente'), depois a Google, com a versão gravada e a ficha", async () => {
    naGoogle.conectada.mockResolvedValue(true);
    naGoogle.enviarParaGoogle.mockResolvedValue({ naGoogle: "falhou", motivo: "google" });
    const resultado = await daDona().criar({ ...valida, googleConvites: true });
    expect(resultado).toEqual({ id: "nova", naGoogle: "falhou", motivo: "google" });
    expect(servico.criarNaAgenda).toHaveBeenCalledWith("dona-1", expect.objectContaining({ googleConvites: true }), { naGoogle: true });
    expect(naGoogle.enviarParaGoogle).toHaveBeenCalledWith({ id: 7, openId: "dona-1" }, expect.objectContaining({
      id: "nova", titulo: "Reunião com a Bia", fuso: "America/Sao_Paulo", googleConvites: true, google: "pendente", updatedAt: FICHA,
    }));
    expect(ordem(servico.criarNaAgenda)).toBeLessThan(ordem(naGoogle.enviarParaGoogle));
  });

  it("marcar sem a Google Agenda: nada vai à Google", async () => {
    expect(await daDona().criar(valida)).toEqual({ id: "nova", naGoogle: null });
    expect(naGoogle.enviarParaGoogle).not.toHaveBeenCalled();
  });

  it("mudar com a Google Agenda conectada: o banco e depois a Google; sem ela, só o banco", async () => {
    naGoogle.conectada.mockResolvedValue(true);
    expect(await daDona().atualizar({ ...valida, id: ID })).toEqual({ id: ID, naGoogle: "ok" });
    expect(servico.atualizarNaAgenda).toHaveBeenCalledWith("dona-1", ID, expect.any(Object), { naGoogle: true });
    expect(naGoogle.enviarParaGoogle).toHaveBeenCalledWith({ id: 7, openId: "dona-1" }, expect.objectContaining({ id: ID, google: "pendente", updatedAt: FICHA }));
    expect(ordem(servico.atualizarNaAgenda)).toBeLessThan(ordem(naGoogle.enviarParaGoogle));
    naGoogle.conectada.mockResolvedValue(false);
    naGoogle.enviarParaGoogle.mockClear();
    expect(await daDona().atualizar({ ...valida, id: ID })).toEqual({ id: ID, naGoogle: null });
    expect(naGoogle.enviarParaGoogle).not.toHaveBeenCalled();
  });

  it("a recusa do banco ao gravar não deixa nada ir à Google", async () => {
    naGoogle.conectada.mockResolvedValue(true);
    servico.atualizarNaAgenda.mockRejectedValueOnce(Object.assign(new Error("Reunião agendada não encontrada."), { code: "NOT_FOUND" }));
    await expect(daDona().atualizar({ ...valida, id: ID })).rejects.toThrow();
    expect(naGoogle.enviarParaGoogle).not.toHaveBeenCalled();
  });

  it("excluir: a reunião que nunca foi para a Google não chama a Google", async () => {
    expect(await daDona().excluir({ id: ID })).toEqual({ ok: true, avisarConvidados: false, naGoogle: null });
    expect(naGoogle.tirarEventoDaGoogle).not.toHaveBeenCalled();
  });

  it("excluir: a que foi sai da Google depois do banco, com o convite que ela tinha", async () => {
    servico.excluirDaAgenda.mockResolvedValue({ google: "ok", googleConvites: true });
    expect(await daDona().excluir({ id: ID })).toEqual({ ok: true, avisarConvidados: true, naGoogle: "ok" });
    expect(naGoogle.tirarEventoDaGoogle).toHaveBeenCalledWith({ id: 7, openId: "dona-1" }, ID, true);
    expect(ordem(servico.excluirDaAgenda)).toBeLessThan(ordem(naGoogle.tirarEventoDaGoogle));
  });

  it("excluir: a Google que falhou volta com o motivo; sem a Google Agenda conectada agora, nada foi tentado", async () => {
    servico.excluirDaAgenda.mockResolvedValue({ google: "falhou", googleConvites: false });
    naGoogle.tirarEventoDaGoogle.mockResolvedValueOnce({ naGoogle: "falhou", motivo: "revogada" });
    expect(await daDona().excluir({ id: ID })).toEqual({ ok: true, avisarConvidados: false, naGoogle: "falhou", motivo: "revogada" });
    naGoogle.tirarEventoDaGoogle.mockResolvedValueOnce({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(await daDona().excluir({ id: ID })).toEqual({ ok: true, avisarConvidados: false, naGoogle: null });
  });

  it("Tentar de novo: lê a reunião da dona e manda a versão do banco", async () => {
    expect(await daDona().mandarParaGoogle({ id: ID })).toEqual({ naGoogle: "ok" });
    expect(naGoogle.lerParaGoogle).toHaveBeenCalledWith("dona-1", ID);
    expect(naGoogle.enviarParaGoogle).toHaveBeenCalledWith({ id: 7, openId: "dona-1" }, expect.objectContaining({ id: ID, google: "falhou", updatedAt: 5 }));
  });

  it("tirar da Google: só a reunião que já saiu da agenda (CONFLICT se ela ainda está lá), com o convite que a tela manda", async () => {
    expect(await daDona().tirarDaGoogle({ id: ID, avisarConvidados: true })).toEqual({ naGoogle: "ok" });
    expect(naGoogle.existeNaAgenda).toHaveBeenCalledWith("dona-1", ID);
    expect(naGoogle.tirarEventoDaGoogle).toHaveBeenCalledWith({ id: 7, openId: "dona-1" }, ID, true);
    naGoogle.existeNaAgenda.mockResolvedValue(true);
    naGoogle.tirarEventoDaGoogle.mockClear();
    await expect(daDona().tirarDaGoogle({ id: ID, avisarConvidados: false })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(naGoogle.tirarEventoDaGoogle).not.toHaveBeenCalled();
  });

  it("ids fora do formato e o convite que não é booleano são recusados antes da Google", async () => {
    await expect(daDona().mandarParaGoogle({ id: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().tirarDaGoogle({ id: "nao-e-uuid", avisarConvidados: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().tirarDaGoogle({ id: ID } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(naGoogle.lerParaGoogle).not.toHaveBeenCalled();
    expect(naGoogle.tirarEventoDaGoogle).not.toHaveBeenCalled();
  });

  it("sem sessão, nada vai à Google", async () => {
    const semConta = agendaRouter.createCaller({ user: null, req: { headers: {} }, res: { cookie: () => {} } } as never);
    await expect(semConta.mandarParaGoogle({ id: ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(semConta.tirarDaGoogle({ id: ID, avisarConvidados: false })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(naGoogle.enviarParaGoogle).not.toHaveBeenCalled();
    expect(naGoogle.tirarEventoDaGoogle).not.toHaveBeenCalled();
  });
});
