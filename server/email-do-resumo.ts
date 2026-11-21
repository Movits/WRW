import { emailDoResumo as ar } from "../client/src/i18n/locales/ar.json";
import { emailDoResumo as de } from "../client/src/i18n/locales/de.json";
import { emailDoResumo as en } from "../client/src/i18n/locales/en.json";
import { emailDoResumo as es } from "../client/src/i18n/locales/es.json";
import { emailDoResumo as fr } from "../client/src/i18n/locales/fr.json";
import { emailDoResumo as hi } from "../client/src/i18n/locales/hi.json";
import { emailDoResumo as ja } from "../client/src/i18n/locales/ja.json";
import { emailDoResumo as ptBR } from "../client/src/i18n/locales/pt-BR.json";
import { emailDoResumo as ru } from "../client/src/i18n/locales/ru.json";
import { emailDoResumo as zh } from "../client/src/i18n/locales/zh.json";
import type { IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { linhaLimpa, NOME_DA_DONA_NO_EMAIL_MAX, semEnderecoWeb, TITULO_NO_EMAIL_MAX, valoresDoEmailDoResumo } from "@shared/resumo-por-email";
import { escapeHtml } from "./_core/email";

/**
 * O texto do e-mail do resumo (H22, server/resumo-por-email.ts): FIXO, no
 * idioma da reunião, das chaves `emailDoResumo.*` dos 10 idiomas da tela, que a
 * prévia do painel também usa. Não há campo livre: entram só o título da
 * reunião e o nome da conta da dona, aparados e escapados, e o endereço que o
 * servidor monta. O texto e a base legal estão com a Cris
 * (docs/termos/email-do-resumo-rascunho.md).
 *
 * A importação por nome traz só a chave `emailDoResumo` de cada arquivo: o
 * esbuild do build do servidor deixa o resto dos JSONs da tela fora do bundle.
 */
export type TextosDoEmailDoResumo = typeof ptBR;

export const TEXTOS_DO_EMAIL_DO_RESUMO: Record<IdiomaDaReuniao, TextosDoEmailDoResumo> = {
  "pt-BR": ptBR, en, es, fr, de, ar, zh, hi, ja, ru,
};

/**
 * Qual e-mail: o que vai às participantes e aos e-mails digitados, o que a dona
 * manda a si mesma (os dois com o link aberto) e o do envio automático, que vai
 * só a ela, com o link da reunião na conta dela (pede entrar).
 */
export type ModeloDoEmailDoResumo = "participante" | "dona" | "pronto";

// A limpeza do título e do nome mora em shared/: a prévia da tela usa a mesma.
export { linhaLimpa, NOME_DA_DONA_NO_EMAIL_MAX, semEnderecoWeb, TITULO_NO_EMAIL_MAX };

/** Troca cada {{chave}} pelo valor; a chave que não veio fica como está. */
export function preencher(texto: string, valores: Record<string, string>): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (marca, chave: string) => (Object.prototype.hasOwnProperty.call(valores, chave) ? valores[chave] : marca));
}

export type EmailDoResumo = { assunto: string; html: string; text: string };

/**
 * Monta o e-mail. `endereco` é o link inteiro (o aberto, /r/{token}, ou o da
 * reunião na conta), que só o servidor escreve. Em árabe, o corpo vai da
 * direita para a esquerda, e o endereço, sempre da esquerda para a direita.
 *
 * `link` diz como está o link aberto (H23) nos dois modelos que o levam: sem o
 * áudio, o texto não promete a gravação; com a senha, um parágrafo diz que ela
 * não vai no e-mail e a quem pedi-la, e o aviso de encaminhamento fala do link
 * e da senha (o de sem senha diria que basta o link). A senha nunca entra aqui.
 * Sem `link`, o link de antes da H23: sem senha e com o áudio.
 */
export function montarEmailDoResumo(dados: {
  modelo: ModeloDoEmailDoResumo;
  idioma: IdiomaDaReuniao;
  titulo: string;
  dona: string | null;
  endereco: string;
  link?: { comSenha: boolean; comAudio: boolean } | null;
}): EmailDoResumo {
  const textos = TEXTOS_DO_EMAIL_DO_RESUMO[dados.idioma] ?? TEXTOS_DO_EMAIL_DO_RESUMO["pt-BR"];
  const valores = valoresDoEmailDoResumo(dados.titulo, dados.dona);
  const { dona } = valores;
  const t = (texto: string) => preencher(texto, valores);
  // Sem `link`, o texto de antes da H23: com o áudio e sem senha. Com ele, os
  // dois valores vêm da leitura do banco (linkDaReuniao, em resumo-por-email.ts),
  // que já falha fechada: só o `true` do banco leva o áudio, e hash que não é
  // nulo pede a senha.
  const oQueAbre = t(dados.link?.comAudio === false ? textos.oQueAbreSemAudio : textos.oQueAbre);
  const comSenha = dados.link?.comSenha === true;
  // Com a senha, o aviso não pode dizer que basta o link: o parágrafo logo
  // acima diz que ele pede a senha, num e-mail que vai a terceiros.
  const avisoDoLink = t(comSenha ? textos.avisoComSenha : textos.aviso);

  let assunto: string;
  let paragrafos: string[];
  let botao: string;
  let aviso: string | null;
  let porQue: string;
  if (dados.modelo === "pronto") {
    assunto = t(textos.assuntoPronto);
    paragrafos = [t(textos.aberturaPronto), t(textos.oQueAbrePronto)];
    botao = t(textos.botaoPronto);
    aviso = null;
    porQue = t(textos.porQuePronto);
  } else if (dados.modelo === "dona") {
    assunto = t(textos.assuntoDona);
    paragrafos = [t(textos.aberturaDona), oQueAbre, ...(comSenha ? [t(textos.senhaDona)] : [])];
    botao = t(textos.botao);
    aviso = avisoDoLink;
    porQue = t(textos.porQueDona);
  } else {
    assunto = t(dona ? textos.assunto : textos.assuntoSemNome);
    paragrafos = [t(dona ? textos.abertura : textos.aberturaSemNome), oQueAbre, ...(comSenha ? [t(dona ? textos.senha : textos.senhaSemNome)] : [])];
    botao = t(textos.botao);
    aviso = avisoDoLink;
    porQue = t(dona ? textos.porQue : textos.porQueSemNome);
  }
  assunto = linhaLimpa(assunto, 250);

  const direcao = dados.idioma === "ar" ? "rtl" : "ltr";
  const alinhamento = direcao === "rtl" ? "right" : "left";
  const endereco = escapeHtml(dados.endereco);
  const p = (texto: string, estilo = "margin:0 0 16px;font-size:15px;line-height:1.6;color:#333333;") =>
    `<p style="${estilo}">${escapeHtml(texto)}</p>`;
  const html = `<!DOCTYPE html>
<html lang="${dados.idioma}" dir="${direcao}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(textos.titulo)}</title>
</head>
<body dir="${direcao}" style="margin:0;padding:0;background-color:#f5f1ee;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;text-align:${alinhamento};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f1ee;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;border:1px solid #e6ddd6;">
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #eee6e0;text-align:${alinhamento};">
              <span style="font-size:22px;font-weight:900;letter-spacing:-0.5px;color:#1a120c;">WRW</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;text-align:${alinhamento};">
              <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#1a120c;">${escapeHtml(textos.titulo)}</h1>
              ${paragrafos.map(texto => p(texto)).join("\n              ")}
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
                <tr>
                  <td style="border-radius:8px;background:#c98f70;">
                    <a href="${endereco}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#1a120c;text-decoration:none;border-radius:8px;">${escapeHtml(botao)}</a>
                  </td>
                </tr>
              </table>
              ${p(textos.linkAlternativo, "margin:0 0 8px;font-size:12px;line-height:1.5;color:#777777;")}
              <p dir="ltr" style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;text-align:left;"><a href="${endereco}" style="color:#8a5a3c;">${endereco}</a></p>
              ${aviso ? p(aviso, "margin:0 0 16px;font-size:13px;line-height:1.5;color:#7a4b2e;background:#fbf3ec;border-radius:8px;padding:12px 16px;") : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #eee6e0;text-align:${alinhamento};">
              ${p(porQue, "margin:0 0 8px;font-size:12px;line-height:1.5;color:#777777;")}
              ${p(textos.naoResponda, "margin:0 0 8px;font-size:12px;line-height:1.5;color:#777777;")}
              ${p(textos.marca, "margin:0;font-size:12px;line-height:1.5;color:#999999;")}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    textos.titulo,
    ...paragrafos,
    `${botao}: ${dados.endereco}`,
    ...(aviso ? [aviso] : []),
    porQue,
    textos.naoResponda,
    textos.marca,
  ].join("\n\n");

  return { assunto, html, text };
}
