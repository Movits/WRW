import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.iniciarDocumento (H12 e H12b) no router, com o serviço dublado. Prova
 * o que fica na rota: a dona é a da sessão, a autorização é obrigatória, a
 * versão gravada é a do aviso do DOCUMENTO (a do aviso de gravação não serve,
 * e o consentimento grava a consentNoticeVersion, como a G4) e a origem é só
 * 'pdf' ou 'foto'. O que o serviço faz no banco está em
 * documento-da-reuniao.integracao.test.ts.
 */
const iniciarDocumento = vi.fn();
vi.mock("./db", async importOriginal => ({
  ...await importOriginal<typeof import("./db")>(),
  getDb: async () => null,
  exigirDb: async () => { throw new Error("este teste não usa banco"); },
}));
vi.mock("./documento-da-reuniao", async importOriginal => ({
  ...await importOriginal<typeof import("./documento-da-reuniao")>(),
  iniciarDocumento: (...args: unknown[]) => iniciarDocumento(...args),
}));

const { meetingsRouter } = await import("./routers/meetings");
const { tetoDosDocumentos } = await import("./documento-da-reuniao");
const { DOCUMENTOS_POR_HORA } = await import("@shared/documento-da-reuniao");
const { VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO } = await import("@shared/aviso-do-documento");
const { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } = await import("@shared/aviso-de-gravacao");

const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const ENTRADA = { title: "Proposta da feira", language: "pt-BR", consentGranted: true, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf" } as const;
const iniciar = (entrada: Record<string, unknown> = {}, openId = "dona-1") =>
  meetingsRouter.createCaller(contexto(openId)).iniciarDocumento({ ...ENTRADA, ...entrada } as never);

beforeEach(() => {
  iniciarDocumento.mockReset();
  iniciarDocumento.mockResolvedValue({ id: "0b6f2c1e-1111-4222-8333-944445555666" });
});

describe("meetings.iniciarDocumento", () => {
  it("a reunião nasce para a dona da sessão, com a versão do aviso do documento e a origem", async () => {
    await expect(iniciar({ origem: "foto" })).resolves.toEqual({ id: "0b6f2c1e-1111-4222-8333-944445555666" });
    expect(iniciarDocumento).toHaveBeenCalledWith("dona-1", {
      title: "Proposta da feira", language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO,
      origem: "foto", contactId: undefined, contextId: undefined,
    });
  });

  it("sem a autorização marcada, nada nasce", async () => {
    await expect(iniciar({ consentGranted: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(iniciarDocumento).not.toHaveBeenCalled();
  });

  it("a versão do aviso é obrigatória e tem de ser a do documento: a do aviso de gravação é recusada", async () => {
    await expect(iniciar({ consentNoticeVersion: undefined })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(iniciar({ consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(iniciarDocumento).not.toHaveBeenCalled();
  });

  it("a origem é só pdf ou foto: áudio, aba ou YouTube não nascem por aqui", async () => {
    for (const origem of ["gravacao", "arquivo", "aba", "youtube", undefined]) {
      await expect(iniciar({ origem })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(iniciarDocumento).not.toHaveBeenCalled();
  });

  it("o título segue as regras de sempre", async () => {
    await expect(iniciar({ title: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(iniciarDocumento).not.toHaveBeenCalled();
  });

  // Conferência de tela de 20/11/2026: com o teto da hora cheio, a reunião nascia,
  // a rota recusava o arquivo (429), e ela ficava "recebendo o documento" na
  // lista quando a dona saía da tela.
  it("com o teto da hora cheio, a reunião não nasce: TOO_MANY_REQUESTS antes dela, e a conferência não gasta vaga", async () => {
    tetoDosDocumentos.esquecer();
    const vagas = Array.from({ length: DOCUMENTOS_POR_HORA }, () => tetoDosDocumentos.reservar("dona-cheia"));
    await expect(iniciar({}, "dona-cheia")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(iniciarDocumento).not.toHaveBeenCalled();
    // O teto é por dona.
    await expect(iniciar({}, "outra-dona")).resolves.toEqual({ id: "0b6f2c1e-1111-4222-8333-944445555666" });
    // Uma vaga devolvida (o envio recusado, por exemplo): a reunião volta a nascer,
    // e a vaga continua livre para a rota do arquivo.
    vagas[0]();
    await expect(iniciar({}, "dona-cheia")).resolves.toEqual({ id: "0b6f2c1e-1111-4222-8333-944445555666" });
    expect(() => tetoDosDocumentos.reservar("dona-cheia")).not.toThrow();
    tetoDosDocumentos.esquecer();
  });
});
