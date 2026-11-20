import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas do mapa mental (H10), com o serviço dublado. Prova o que fica no
 * router: a dona é sempre a da sessão, pedir o mapa gasta uma vaga do mesmo
 * teto de pedidos à IA do resumo e das perguntas e, pelo link aberto, das duas
 * vagas da reunião; o link desligado sai como NOT_FOUND; a entrada é validada
 * antes de tudo.
 */
const servico = vi.hoisted(() => ({
  mapaMentalDaDona: vi.fn(async () => ({ estado: "sem_mapa", idioma: null, erro: null, mapa: null })),
  pedirMapaDaDona: vi.fn(),
  mapaMentalPeloLink: vi.fn(async () => ({ estado: "sem_mapa", idioma: null, erro: null, mapa: null })),
  pedirMapaPeloLink: vi.fn(),
}));
vi.mock("./mapa-mental-guardado", () => servico);
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("as rotas não leem o banco neste teste"); } }));

const { meetingsRouter, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { reuniaoAbertaRouter, PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA } = await import("./routers/reuniaoAberta");
const { LinkAbertoRecusado } = await import("./link-aberto-da-reuniao");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "m".repeat(32);
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
}) as never;
const daDona = (openId = `dona-${Math.random()}`) => meetingsRouter.createCaller(contexto(openId));
const doLink = (ip = "203.0.113.77") => reuniaoAbertaRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: ip }, ip }, res: { cookie: () => {} } } as never);

beforeEach(() => {
  for (const f of Object.values(servico)) f.mockClear();
  // O serviço real chama o "antes de criar" só quando há trabalho novo.
  servico.pedirMapaDaDona.mockImplementation(async (_dona: string, _id: string, antesDeCriar: () => void) => { antesDeCriar(); return { estado: "pendente" }; });
  servico.pedirMapaPeloLink.mockImplementation(async (_token: string, antesDeCriar: (reuniaoId: string) => void) => { antesDeCriar("reuniao-do-mapa"); return { estado: "pendente" }; });
});

describe("rotas do mapa mental da dona", () => {
  it("a dona é a da sessão, ao ler e ao pedir", async () => {
    const rota = daDona("dona-1");
    await rota.mapaMental({ meetingId: ID });
    await rota.pedirMapa({ meetingId: ID });
    expect(servico.mapaMentalDaDona).toHaveBeenCalledWith("dona-1", ID);
    expect(servico.pedirMapaDaDona).toHaveBeenCalledWith("dona-1", ID, expect.any(Function));
  });

  it("pedir o mapa gasta uma vaga do teto de pedidos à IA da dona, o mesmo do resumo e das perguntas", async () => {
    const rota = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await rota.pedirMapa({ meetingId: ID });
    await expect(rota.pedirMapa({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // O teto é um só: a pergunta da mesma dona também é recusada, antes da IA.
    await expect(rota.perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Qual foi o prazo?" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // A vaga devolvida (o pedido que perdeu a corrida) volta a valer.
    const outra = daDona();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - 1; i++) await outra.pedirMapa({ meetingId: ID });
    servico.pedirMapaDaDona.mockImplementationOnce(async (_d: string, _i: string, antesDeCriar: () => (() => void) | void) => { const soltar = antesDeCriar(); soltar?.(); return { estado: "pendente" }; });
    await outra.pedirMapa({ meetingId: ID });
    await outra.pedirMapa({ meetingId: ID });
    await expect(outra.pedirMapa({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("entrada inválida é recusada antes do serviço", async () => {
    const rota = daDona();
    await expect(rota.mapaMental({ meetingId: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota.pedirMapa({ meetingId: "nao-e-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.mapaMentalDaDona).not.toHaveBeenCalled();
    expect(servico.pedirMapaDaDona).not.toHaveBeenCalled();
  });
});

describe("rotas do mapa mental pelo link aberto", () => {
  it("ler não gasta vaga; pedir gasta a do visitante e a da reunião", async () => {
    const rota = doLink();
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA + 3; i++) await rota.mapaMental({ token: TOKEN });
    expect(servico.mapaMentalPeloLink).toHaveBeenCalledWith(TOKEN);
    for (let i = 0; i < PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA; i++) await rota.pedirMapa({ token: TOKEN });
    await expect(rota.pedirMapa({ token: TOKEN })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("o link desligado (ou que não existe) sai como NOT_FOUND, com o código que a tela traduz", async () => {
    servico.mapaMentalPeloLink.mockRejectedValueOnce(new LinkAbertoRecusado("NOT_FOUND", "Link não encontrado."));
    await expect(doLink("198.51.100.4").mapaMental({ token: TOKEN })).rejects.toMatchObject({ code: "NOT_FOUND" });
    servico.pedirMapaPeloLink.mockRejectedValueOnce(new LinkAbertoRecusado("NOT_FOUND", "Link não encontrado."));
    await expect(doLink("198.51.100.4").pedirMapa({ token: TOKEN })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("token longo demais é recusado antes do serviço", async () => {
    await expect(doLink().mapaMental({ token: "t".repeat(129) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.mapaMentalPeloLink).not.toHaveBeenCalled();
  });
});
