import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.resumir e meetings.perguntar no router: o que chega ao serviço e o
 * teto de pedidos à IA por dona, resumo e perguntas somados. O serviço é
 * dublado; o que ele faz com a transcrição e a IA está em reuniao-com-ia.test.ts.
 */

const resumirReuniao = vi.fn();
const perguntarAReuniao = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./reuniao-com-ia", async importOriginal => ({
  ...await importOriginal<typeof import("./reuniao-com-ia")>(),
  resumirReuniao: (...args: unknown[]) => resumirReuniao(...(args as [])),
  perguntarAReuniao: (...args: unknown[]) => perguntarAReuniao(...(args as [])),
}));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { RecusaDaReuniaoComIA } = await import("./reuniao-com-ia");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const RESUMO_VAZIO = { topicos: [], decisoes: [], tarefas: [] };
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
const resumir = (openId?: string) => rota(openId).resumir({ meetingId: ID, idioma: "pt-BR" });
const perguntar = (openId?: string) => rota(openId).perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Qual prazo ficou combinado?" });

beforeEach(() => {
  tetoDaIADaReuniao.esquecer();
  resumirReuniao.mockReset();
  resumirReuniao.mockResolvedValue(RESUMO_VAZIO);
  perguntarAReuniao.mockReset();
  perguntarAReuniao.mockResolvedValue({ respondida: false });
});
afterEach(() => { vi.useRealTimers(); });

describe("meetings.resumir e meetings.perguntar — o que chega ao serviço", () => {
  it("o openId da dona, a reunião, o idioma e a pergunta aparada", async () => {
    await expect(rota().resumir({ meetingId: ID, idioma: "en" })).resolves.toEqual(RESUMO_VAZIO);
    await expect(rota().perguntar({ meetingId: ID, idioma: "ja", pergunta: "  Quem participou?  " })).resolves.toEqual({ respondida: false });
    expect(resumirReuniao).toHaveBeenCalledWith("dona-1", ID, "en");
    expect(perguntarAReuniao).toHaveBeenCalledWith("dona-1", ID, "Quem participou?", "ja");
  });

  it("a recusa do serviço sai com o código que a tela traduz", async () => {
    resumirReuniao.mockRejectedValue(new RecusaDaReuniaoComIA("PRECONDITION_FAILED", "sem transcrição"));
    perguntarAReuniao.mockRejectedValue(new RecusaDaReuniaoComIA("SERVICE_UNAVAILABLE", "IA fora do ar"));
    await expect(resumir()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(perguntar()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

describe(`meetings.resumir e meetings.perguntar — teto de ${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA} pedidos à IA a cada 10 minutos por dona`, () => {
  it("resumo e perguntas somam no mesmo teto; passado ele, TOO_MANY_REQUESTS sem chamar a IA; outra dona passa", async () => {
    const resumos = Math.floor(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2);
    for (let i = 0; i < resumos; i++) await resumir();
    for (let i = resumos; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA; i++) await perguntar();

    await expect(resumir()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(resumirReuniao).toHaveBeenCalledTimes(resumos);
    expect(perguntarAReuniao).toHaveBeenCalledTimes(PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - resumos);

    await expect(resumir("outra-dona")).resolves.toEqual(RESUMO_VAZIO);
  });

  it("pedido recusado também conta: sondar reuniões alheias esbarra no mesmo teto", async () => {
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
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    vi.setSystemTime(new Date("2026-11-10T12:10:01Z"));
    await expect(perguntar()).resolves.toEqual({ respondida: false });
  });
});
