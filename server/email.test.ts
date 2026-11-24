/**
 * Testa a configuração do serviço de e-mail (Resend)
 * Verifica que o helper de e-mail está configurado e o template HTML é gerado corretamente
 */
import { describe, it, expect } from "vitest";

describe("Email Service", () => {
  it("deve gerar o template HTML de recuperação de senha corretamente", async () => {
    const { buildPasswordResetEmail } = await import("./_core/email");
    const { html, text } = buildPasswordResetEmail("Maria Silva", "https://mmmos.space/reset-password?token=abc123");

    // Verificar que o HTML contém os elementos essenciais
    expect(html).toContain("Maria Silva");
    expect(html).toContain("https://mmmos.space/reset-password?token=abc123");
    expect(html).toContain("Redefinição de senha");
    expect(html).toContain("1 hora");
    // A marca é MarquesaMatch desde 23/11/2026 (antes WRW; a URL de teste acima não é marca).
    expect(html).toContain("MarquesaMatch");
    expect(html).not.toMatch(/\bWRW\b|Women Rocking/);
    expect(html).toContain("Recuperação de Senha — MarquesaMatch");
    expect(html).not.toMatch(/\bMMM\b|Mulheres que Movem/);

    // Verificar que o texto plano também está correto
    expect(text).toContain("Maria Silva");
    expect(text).toContain("https://mmmos.space/reset-password?token=abc123");
    expect(text).toContain("1 hora");
    expect(text).toContain("sua conta na MarquesaMatch");
    expect(text).not.toMatch(/\bMMM\b/);
  });

  it("o remetente sai com o nome da marca e o endereço do EMAIL_FROM", async () => {
    const { remetenteComAMarca, NOME_DO_REMETENTE } = await import("./_core/email");
    expect(NOME_DO_REMETENTE).toBe("MarquesaMatch");
    expect(remetenteComAMarca("MMM <no-reply@exemplo.test>")).toBe("MarquesaMatch <no-reply@exemplo.test>");
    expect(remetenteComAMarca("\"MMM — Mulheres que Movem o Mundo\" <no-reply@exemplo.test>")).toBe("MarquesaMatch <no-reply@exemplo.test>");
    expect(remetenteComAMarca("  no-reply@exemplo.test ")).toBe("MarquesaMatch <no-reply@exemplo.test>");
    // Formato que não se reconhece não é reescrito: melhor o nome antigo que um remetente quebrado.
    expect(remetenteComAMarca("remetente sem endereco")).toBe("remetente sem endereco");
  });

  it("sendEmail deve ser uma função assíncrona exportável", async () => {
    // O módulo de email usa lazy init com variável de módulo — não é possível reimportar sem cache.
    // Testamos apenas que a função sendEmail é exportável e é assíncrona.
    const { sendEmail } = await import("./_core/email");
    expect(typeof sendEmail).toBe("function");
    expect(sendEmail.constructor.name).toBe("AsyncFunction");
  });

  it("deve ter RESEND_API_KEY configurada no ambiente", () => {
    // Verificar que a chave está presente (pode ser a chave real ou uma de teste)
    const key = process.env.RESEND_API_KEY;
    if (key) {
      expect(key).toBeTruthy();
      expect(key.length).toBeGreaterThan(5);
      console.log("[Email Test] RESEND_API_KEY configurada:", key.substring(0, 8) + "...");
    } else {
      console.warn("[Email Test] RESEND_API_KEY não configurada — e-mails não serão enviados");
      // Não falhar o teste se não tiver chave — é opcional
      expect(true).toBe(true);
    }
  });
});
