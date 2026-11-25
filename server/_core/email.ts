/**
 * Email service using Resend
 * Sends transactional emails for password reset and notifications
 */
import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Sem EMAIL_FROM não há remetente. O padrão antigo apontava para o domínio
// morto do Manus, e a Resend recusaria o envio com um erro obscuro.
const FROM_EMAIL = process.env.EMAIL_FROM;

/**
 * Nome de exibição de todo e-mail: a marca (Marquesa Global Match desde 24/11/2026; antes MarquesaMatch, WRW e MMM), qualquer
 * que seja o nome gravado em EMAIL_FROM. O endereço continua vindo do ambiente.
 * Só ASCII de propósito: um travessão ou acento no nome do
 * cabeçalho From exige codificação RFC 2047, e um remetente recusado derruba em
 * silêncio a redefinição de senha.
 */
export const NOME_DO_REMETENTE = "Marquesa Global Match";

/** "Nome antigo <no-reply@dominio>" ou "no-reply@dominio" → "Marquesa Global Match <no-reply@dominio>". Formato que não se reconhece passa como veio. */
export function remetenteComAMarca(emailFrom: string): string {
  const valor = emailFrom.trim();
  const endereco = (valor.match(/<([^<>\s]+@[^<>\s]+)>$/)?.[1] ?? valor).trim();
  if (!/^[^\s<>@"]+@[^\s<>@"]+$/.test(endereco)) return valor;
  return `${NOME_DO_REMETENTE} <${endereco}>`;
}

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(RESEND_API_KEY);
  return resendClient;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character] ?? character));
}

/**
 * Destinatário no TLD reservado `.invalid` (RFC 2606): nunca entrega. São as
 * contas QA do exame de produção (`qa-exame-...@exame.invalid`). Mandar para a
 * Resend só gera devolução (Bounced, vista em 14/11/2026), e devolução acumulada
 * pode suspender o domínio remetente, o mesmo do "Esqueci a senha" das usuárias.
 */
export function destinatarioNuncaEntrega(to: string): boolean {
  return /\.invalid\.?$/i.test(to.trim().replace(/>$/, ""));
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (destinatarioNuncaEntrega(options.to)) {
    // Sem o endereço no log: só o domínio reservado, que não identifica ninguém.
    console.warn("[Email] Destinatário no domínio reservado .invalid — e-mail não enviado.");
    return false;
  }
  const client = getResendClient();
  if (!client) {
    console.warn("[Email] RESEND_API_KEY não configurada — e-mail não enviado.");
    return false;
  }
  if (!FROM_EMAIL) {
    console.error(
      '[Email] EMAIL_FROM não configurada — e-mail não enviado. Defina o remetente no formato "endereco@dominio" (o nome de exibição, Marquesa Global Match, sai do código).'
    );
    return false;
  }
  try {
    const { error } = await client.emails.send({
      from: remetenteComAMarca(FROM_EMAIL),
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    if (error) {
      console.error("[Email] Erro ao enviar:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Email] Exceção ao enviar:", err);
    return false;
  }
}

/** Quantos e-mails a API de lote da Resend aceita numa chamada. */
const LOTE_DA_RESEND_MAX = 100;

/**
 * Manda vários e-mails pela API de lote da Resend, numa chamada a cada 100: o
 * resumo por e-mail (H22, server/resumo-por-email.ts) vai a várias pessoas de
 * uma vez, e a Resend limita as chamadas por segundo. Cada item é um e-mail à
 * parte, com um destinatário só: ninguém vê o endereço de outra pessoa.
 *
 * Devolve, na ordem da lista, se cada e-mail foi aceito. A Resend valida a
 * chamada inteira: um item recusado recusa os outros da mesma chamada. Nunca
 * lança. O log da falha leva só o nome do erro, sem a mensagem, que pode
 * trazer o endereço de quem recebe.
 */
export async function sendEmailBatch(lista: SendEmailOptions[]): Promise<boolean[]> {
  const aceitos = lista.map(() => false);
  const quemPodeReceber = lista.map((_, posicao) => posicao).filter(posicao => !destinatarioNuncaEntrega(lista[posicao].to));
  if (quemPodeReceber.length < lista.length) {
    console.warn("[Email] Destinatário no domínio reservado .invalid — e-mail não enviado.");
  }
  if (!quemPodeReceber.length) return aceitos;
  const client = getResendClient();
  if (!client) {
    console.warn("[Email] RESEND_API_KEY não configurada — e-mails não enviados.");
    return aceitos;
  }
  if (!FROM_EMAIL) {
    console.error('[Email] EMAIL_FROM não configurada — e-mails não enviados. Defina o remetente no formato "endereco@dominio".');
    return aceitos;
  }
  const remetente = remetenteComAMarca(FROM_EMAIL);
  for (let inicio = 0; inicio < quemPodeReceber.length; inicio += LOTE_DA_RESEND_MAX) {
    const parte = quemPodeReceber.slice(inicio, inicio + LOTE_DA_RESEND_MAX);
    try {
      const { error } = await client.batch.send(parte.map(posicao => ({
        from: remetente,
        to: lista[posicao].to,
        subject: lista[posicao].subject,
        html: lista[posicao].html,
        text: lista[posicao].text,
      })));
      if (error) {
        console.error(`[Email] A Resend recusou o lote de ${parte.length} e-mail(s): ${error.name}`);
        continue;
      }
      for (const posicao of parte) aceitos[posicao] = true;
    } catch (err) {
      console.error(`[Email] Exceção ao enviar o lote de ${parte.length} e-mail(s): ${err instanceof Error ? err.name : "erro desconhecido"}`);
    }
  }
  return aceitos;
}

export function buildPasswordResetEmail(name: string, resetUrl: string): { html: string; text: string } {
  const safeName = escapeHtml(name);
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Recuperação de Senha — Marquesa Global Match</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#111111;border-radius:12px;border:1px solid #222222;overflow:hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px;border-bottom:1px solid #222222;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#ffffff;">Marquesa Global Match</span>
                  </td>
                  <td align="right">
                    <span style="font-size:12px;color:#666666;background:#1a1a1a;padding:4px 10px;border-radius:20px;border:1px solid #333333;">
                      Ecossistema Global
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <!-- Icon -->
              <div style="width:56px;height:56px;background:#1a1a0a;border:1px solid #f59e0b33;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px;">
                <span style="font-size:24px;">🔐</span>
              </div>

              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">
                Redefinição de senha
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#999999;line-height:1.6;">
                Olá, <strong style="color:#e5e5e5;">${safeName}</strong>. Recebemos uma solicitação para redefinir a senha da sua conta na Marquesa Global Match.
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:#888888;line-height:1.6;">
                Clique no botão abaixo para criar uma nova senha. Este link é <strong style="color:#D4A017;">válido por 1 hora</strong> e pode ser usado apenas uma vez.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                <tr>
                  <td style="border-radius:8px;background:#D4A017;">
                    <a href="${resetUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#000000;text-decoration:none;border-radius:8px;letter-spacing:0.3px;">
                      Redefinir minha senha →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Link fallback -->
              <p style="margin:0 0 8px;font-size:12px;color:#666666;">
                Se o botão não funcionar, copie e cole este link no seu navegador:
              </p>
              <p style="margin:0 0 32px;font-size:12px;color:#D4A017;word-break:break-all;">
                <a href="${resetUrl}" style="color:#D4A017;text-decoration:none;">${resetUrl}</a>
              </p>

              <!-- Warning -->
              <div style="background:#1a0a0a;border:1px solid #7f1d1d44;border-radius:8px;padding:16px 20px;">
                <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.5;">
                  ⚠️ <strong>Não solicitou esta redefinição?</strong> Ignore este e-mail. Sua senha permanece a mesma e nenhuma alteração foi feita.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #1a1a1a;">
              <p style="margin:0;font-size:12px;color:#444444;text-align:center;line-height:1.6;">
                Marquesa Global Match<br/>
                Este é um e-mail automático, por favor não responda.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `
Olá, ${name}.

Recebemos uma solicitação para redefinir a senha da sua conta na Marquesa Global Match.

Clique no link abaixo para criar uma nova senha (válido por 1 hora, uso único):

${resetUrl}

Se você não solicitou esta redefinição, ignore este e-mail. Sua senha permanece a mesma.

Marquesa Global Match
  `.trim();

  return { html, text };
}
