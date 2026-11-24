/**
 * Destinatário no TLD reservado .invalid (RFC 2606) não chega à Resend: as contas
 * QA do exame de produção (qa-exame-...@exame.invalid) geravam devolução (Bounced)
 * a cada execução, e devolução acumulada arrisca o domínio remetente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { enviar } = vi.hoisted(() => ({
  enviar: vi.fn(async (_dados: unknown) => ({ data: { id: "x" }, error: null })),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: enviar };
  },
}));

async function carregar() {
  vi.resetModules();
  return import("./_core/email");
}

describe("sendEmail para o domínio reservado .invalid", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_teste_falsa");
    vi.stubEnv("EMAIL_FROM", "no-reply@exemplo.test");
    enviar.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("não chama a Resend, devolve false e não põe o endereço no log", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmail } = await carregar();
    const enviado = await sendEmail({ to: "qa-exame-presidente@exame.invalid", subject: "s", html: "<p>h</p>" });
    expect(enviado).toBe(false);
    expect(enviar).not.toHaveBeenCalled();
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(String(aviso.mock.calls[0]?.[0])).not.toContain("qa-exame-presidente");
  });

  it("reconhece maiúsculas, espaço e o ponto final do FQDN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmail, destinatarioNuncaEntrega } = await carregar();
    expect(destinatarioNuncaEntrega(" Alguem@Exame.INVALID ")).toBe(true);
    expect(destinatarioNuncaEntrega("alguem@exame.invalid.")).toBe(true);
    expect(await sendEmail({ to: "QA@EXAME.INVALID", subject: "s", html: "h" })).toBe(false);
    expect(enviar).not.toHaveBeenCalled();
  });

  it("endereço comum, inclusive com 'invalid' no meio, segue para a Resend", async () => {
    const { sendEmail, destinatarioNuncaEntrega } = await carregar();
    expect(destinatarioNuncaEntrega("invalid@exemplo.com")).toBe(false);
    expect(destinatarioNuncaEntrega("maria@invalid.com.br")).toBe(false);
    expect(destinatarioNuncaEntrega("maria@exemplo.invalido")).toBe(false);
    expect(await sendEmail({ to: "maria@exemplo.com", subject: "s", html: "h" })).toBe(true);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]?.[0]).toMatchObject({ to: "maria@exemplo.com", from: "MarquesaMatch <no-reply@exemplo.test>" });
  });
});
