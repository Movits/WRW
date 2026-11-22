import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.perguntar e meetings.pedirResumo no router: o que chega ao serviço
 * e o teto de pedidos à IA por dona, pedidos de resumo e perguntas somados. Os
 * serviços são dublados; o que a pergunta faz com a transcrição e a IA está em
 * reuniao-com-ia.test.ts, e o resumo guardado em resumo-guardado-rota.test.ts.
 */

const perguntarAReuniao = vi.fn();
const pedirResumoDaDona = vi.fn();

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./reuniao-com-ia", async importOriginal => ({
  ...await importOriginal<typeof import("./reuniao-com-ia")>(),
  perguntarAReuniao: (...args: unknown[]) => perguntarAReuniao(...(args as [])),
}));
vi.mock("./resumo-guardado", async importOriginal => ({
  ...await importOriginal<typeof import("./resumo-guardado")>(),
  pedirResumoDaDona: (...args: unknown[]) => pedirResumoDaDona(...(args as [])),
}));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { RecusaDaReuniaoComIA } = await import("./reuniao-com-ia");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PENDENTE = { estado: "pendente", emoji: null, idioma: null, erro: null, itens: [] };
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
const pedirResumo = (openId?: string) => rota(openId).pedirResumo({ meetingId: ID });
const perguntar = (openId?: string) => rota(openId).perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Qual prazo ficou combinado?" });

beforeEach(() => {
  tetoDaIADaReuniao.esquecer();
  perguntarAReuniao.mockReset();
  perguntarAReuniao.mockResolvedValue({ respondida: false });
  // Como o serviço real: o resumo que ainda não existe gasta a vaga antes de criar o trabalho.
  pedirResumoDaDona.mockReset();
  pedirResumoDaDona.mockImplementation(async (_dona: string, _id: string, antesDeCriar: () => void) => { antesDeCriar(); return PENDENTE; });
});
afterEach(() => { vi.useRealTimers(); });

describe("meetings.perguntar — o que chega ao serviço", () => {
  it("o openId da dona, a reunião, o idioma e a pergunta aparada", async () => {
    await expect(rota().perguntar({ meetingId: ID, idioma: "ja", pergunta: "  Quem participou?  " })).resolves.toEqual({ respondida: false });
    // O último argumento toma a segunda vaga da reunião longa (o teto, com o serviço de verdade, em reuniao-com-ia.test.ts).
    expect(perguntarAReuniao).toHaveBeenCalledWith("dona-1", ID, "Quem participou?", "ja", expect.any(Function));
  });

  it("a recusa do serviço sai com o código que a tela traduz", async () => {
    perguntarAReuniao.mockRejectedValueOnce(new RecusaDaReuniaoComIA("PRECONDITION_FAILED", "sem transcrição"));
    perguntarAReuniao.mockRejectedValueOnce(new RecusaDaReuniaoComIA("SERVICE_UNAVAILABLE", "IA fora do ar"));
    await expect(perguntar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(perguntar()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("o resumo a pedido de antes saiu: o resumo é o guardado (pedirResumo)", () => {
    expect("resumir" in meetingsRouter._def.procedures).toBe(false);
    expect("pedirResumo" in meetingsRouter._def.procedures).toBe(true);
  });
});

describe(`meetings.pedirResumo e meetings.perguntar — teto de ${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA} pedidos à IA a cada 10 minutos por dona`, () => {
  it("pedidos de resumo e perguntas somam no mesmo teto; passado ele, TOO_MANY_REQUESTS sem chamar a IA; outra dona passa", async () => {
    const resumos = Math.floor(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2);
    for (let i = 0; i < resumos; i++) await pedirResumo();
    for (let i = resumos; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await perguntar();

    await expect(pedirResumo()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - resumos);

    await expect(pedirResumo("outra-dona")).resolves.toEqual(PENDENTE);
    await expect(perguntar("outra-dona")).resolves.toEqual({ respondida: false });
  });

  it("pedir o resumo que já está na fila não gasta vaga: só o trabalho novo conta", async () => {
    pedirResumoDaDona.mockImplementation(async () => PENDENTE);
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA + 5; i++) await pedirResumo();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await perguntar();
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("pergunta recusada também conta: sondar reuniões alheias esbarra no mesmo teto", async () => {
    perguntarAReuniao.mockRejectedValue(new RecusaDaReuniaoComIA("NOT_FOUND", "não encontrada"));
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await expect(perguntar()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("pergunta inválida não chega ao teto: a validação recusa antes", async () => {
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA + 5; i++) {
      await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(perguntar()).resolves.toEqual({ respondida: false });
  });

  it("passados 10 minutos, a janela libera", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await perguntar();
    await expect(pedirResumo()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    vi.setSystemTime(new Date("2026-11-10T12:10:01Z"));
    await expect(pedirResumo()).resolves.toEqual(PENDENTE);
  });
});
