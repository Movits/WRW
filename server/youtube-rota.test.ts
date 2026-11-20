import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os procedimentos do vídeo do YouTube (H13) no router das reuniões, sem banco:
 * o serviço (server/youtube.ts) é dublê. O que se prova é a porta: o
 * consentimento e a versão do aviso do YouTube são obrigatórios (a versão do
 * aviso de GRAVAÇÃO não serve), a conta da sessão vira a dona do pedido, e as
 * recusas do serviço saem com o código tRPC e o código do erro, que a tela
 * traduz. O banco, o teto e o trabalho estão em server/youtube.integracao.test.ts.
 */
const servico = vi.hoisted(() => ({ pedirResumoDoVideo: vi.fn(), refazerResumoDoVideo: vi.fn() }));
vi.mock("./youtube", async original => ({
  ...(await original<typeof import("./youtube")>()),
  pedirResumoDoVideo: (...a: unknown[]) => servico.pedirResumoDoVideo(...a),
  refazerResumoDoVideo: (...a: unknown[]) => servico.refazerResumoDoVideo(...a),
}));

const { appRouter } = await import("./routers");
const { RecusaDoVideo } = await import("./youtube");
const { VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE } = await import("@shared/youtube");
const { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } = await import("@shared/aviso-de-gravacao");

const caller = () => appRouter.createCaller({
  user: { id: 42, openId: "dona-do-video", role: "bronze", isActive: true, onboardingCompleted: true },
  req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "198.51.100.4" } },
  res: { cookie: () => {}, clearCookie: () => {} },
} as never);

const ENTRADA = {
  title: "Palestra sobre exportação",
  url: "https://youtu.be/dQw4w9WgXcQ",
  language: "es",
  consentGranted: true as const,
  consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE,
};

async function erroDe(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  throw new Error("era para recusar");
}

beforeEach(() => {
  servico.pedirResumoDoVideo.mockReset();
  servico.refazerResumoDoVideo.mockReset();
  servico.pedirResumoDoVideo.mockResolvedValue({ id: "c0ffee00-0000-4000-8000-000000000001", trabalho: Promise.resolve() });
  servico.refazerResumoDoVideo.mockResolvedValue({ trabalho: Promise.resolve() });
});

describe("meetings.resumirVideoDoYoutube", () => {
  it("passa a conta da sessão, o IP, o user-agent e o pedido ao serviço, e devolve o id", async () => {
    expect(await caller().meetings.resumirVideoDoYoutube(ENTRADA)).toEqual({ id: "c0ffee00-0000-4000-8000-000000000001" });
    expect(servico.pedirResumoDoVideo).toHaveBeenCalledWith(
      { userId: 42, openId: "dona-do-video", ipAddress: "198.51.100.4", userAgent: "Vitest/1.0" },
      { titulo: "Palestra sobre exportação", url: "https://youtu.be/dQw4w9WgXcQ", idioma: "es", versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE },
    );
  });

  it.each([
    ["sem o consentimento", { consentGranted: false }],
    ["sem a versão do aviso", { consentNoticeVersion: undefined }],
    ["com a versão do aviso de gravação, que fala de outra coisa", { consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO }],
    ["sem título", { title: " " }],
    ["com link vazio", { url: "   " }],
    ["com link longo demais", { url: `https://youtu.be/dQw4w9WgXcQ?x=${"a".repeat(2100)}` }],
    ["com idioma fora dos dez", { language: "xx" }],
  ])("recusa o pedido %s, antes do serviço", async (_caso, troca) => {
    const erro = await erroDe(caller().meetings.resumirVideoDoYoutube({ ...ENTRADA, ...troca } as never));
    expect(erro).toBeInstanceOf(TRPCError);
    expect((erro as TRPCError).code).toBe("BAD_REQUEST");
    expect(servico.pedirResumoDoVideo).not.toHaveBeenCalled();
  });

  it.each([
    ["BAD_REQUEST", "YOUTUBE_LINK_INVALIDO"],
    ["TOO_MANY_REQUESTS", "YOUTUBE_TETO_DIARIO"],
  ] as const)("a recusa %s do serviço sai com o código %s, que a tela traduz", async (codigo, mensagem) => {
    servico.pedirResumoDoVideo.mockRejectedValueOnce(new RecusaDoVideo(codigo, mensagem));
    const erro = await erroDe(caller().meetings.resumirVideoDoYoutube(ENTRADA));
    expect(erro).toMatchObject({ code: codigo, message: mensagem });
  });
});

describe("meetings.refazerVideoDoYoutube", () => {
  it("passa a conta da sessão e a reunião ao serviço", async () => {
    const meetingId = "c0ffee00-0000-4000-8000-000000000002";
    expect(await caller().meetings.refazerVideoDoYoutube({ meetingId })).toEqual({ status: "processing" });
    expect(servico.refazerResumoDoVideo).toHaveBeenCalledWith({ userId: 42, openId: "dona-do-video", ipAddress: "198.51.100.4", userAgent: "Vitest/1.0" }, meetingId);
  });

  it.each(["NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED", "TOO_MANY_REQUESTS"] as const)("a recusa %s do serviço sai com o mesmo código", async codigo => {
    servico.refazerResumoDoVideo.mockRejectedValueOnce(new RecusaDoVideo(codigo, "motivo"));
    expect(await erroDe(caller().meetings.refazerVideoDoYoutube({ meetingId: "c0ffee00-0000-4000-8000-000000000003" }))).toMatchObject({ code: codigo });
  });

  it("id que não é uuid é recusado antes do serviço", async () => {
    expect(await erroDe(caller().meetings.refazerVideoDoYoutube({ meetingId: "1" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(servico.refazerResumoDoVideo).not.toHaveBeenCalled();
  });
});
