/**
 * O resumo por e-mail (H22 do plano do gravador; HN-54 do HiNoter e R-33 da
 * reunião de 11/11/2026): a dona manda o link aberto da reunião, com o resumo,
 * para ela mesma, para participantes escolhidas da agenda ou para todas, e para
 * e-mails que ela digita. Quem recebe não precisa de conta. O servidor está em
 * server/resumo-por-email.ts; a tela, em client/src/components/ResumoPorEmail.tsx.
 *
 * O texto do e-mail é fixo, no idioma da reunião (chaves `emailDoResumo.*` dos
 * 10 idiomas da tela): não há campo livre que a conta use para mandar outra
 * coisa. O rascunho jurídico (texto e base legal, para a Cris) está em
 * docs/termos/email-do-resumo-rascunho.md.
 */

/** Quem recebe: a dona, uma participante da agenda da reunião, ou um e-mail que ela digitou. */
export const ORIGENS_DO_RESUMO_POR_EMAIL = ["dona", "participante", "digitado"] as const;
export type OrigemDoResumoPorEmail = (typeof ORIGENS_DO_RESUMO_POR_EMAIL)[number];

export const ESTADOS_DO_RESUMO_POR_EMAIL = ["pendente", "enviado", "falhou"] as const;
export type EstadoDoResumoPorEmail = (typeof ESTADOS_DO_RESUMO_POR_EMAIL)[number];

/**
 * Os tetos (decisão vetável do Roberto). Contam e-mails, não pedidos, nas
 * últimas 24 horas, pelas linhas de resumo_por_email; o mandar de novo do que
 * não saiu não conta outra vez. Baixos de propósito: a Resend no plano grátis
 * manda 100 e-mails por dia para a plataforma inteira, e o "Esqueci a senha"
 * sai pela mesma conta.
 */
export const DESTINATARIAS_POR_ENVIO_MAX = 20;
export const EMAILS_DIGITADOS_POR_ENVIO_MAX = 10;
export const EMAILS_POR_REUNIAO_EM_24H = 30;
export const EMAILS_POR_DONA_EM_24H = 50;
export const JANELA_DOS_TETOS_MS = 24 * 60 * 60_000;
/** Quantas vezes um e-mail que não saiu pode ser mandado de novo. */
export const TENTATIVAS_POR_EMAIL_MAX = 3;
/**
 * A linha 'pendente' mais velha que isto é de um envio que não terminou (o
 * processo caiu entre gravar e mandar): o "Tentar de novo" a manda também.
 */
export const PENDENTE_PRESO_MS = 5 * 60_000;

/**
 * As recusas, nas palavras que chegam ao navegador. Como as do resumo guardado
 * (shared/const.ts): o servidor escreve sem saber o idioma da dona, e a tela as
 * traduz reconhecendo o texto exato (client/src/lib/mensagem-de-erro.ts, chaves
 * resumoPorEmail.erros.*, cujo pt-BR é igual a estas frases).
 */
export const MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO = "O resumo desta reunião ainda não está pronto para mandar.";
export const MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA = "Escolha ao menos uma pessoa para receber o resumo.";
export const MENSAGEM_RESUMO_POR_EMAIL_DEMAIS = "São pessoas demais para um envio só. Mande em partes.";
export const MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA = "Um dos participantes escolhidos não está mais na agenda desta reunião. Atualize a tela e escolha de novo.";
export const MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO = "Confira os e-mails digitados: um deles não é válido.";
export const MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA = "Sua conta não tem e-mail para receber o resumo.";
export const MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO = "O link aberto desta reunião está desligado. Confirme a autorização das pessoas para ligá-lo e mandar.";
export const MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO = "Esta reunião chegou ao limite de e-mails do resumo em 24 horas. Tente de novo mais tarde.";
export const MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA = "Você chegou ao limite de e-mails do resumo em 24 horas. Tente de novo mais tarde.";
export const MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU = "O e-mail não saiu agora. O pedido ficou guardado: tente de novo em instantes.";
export const MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR = "Não há e-mail desta reunião para mandar de novo.";

/** O e-mail digitado como a tela e o servidor o comparam: sem espaços nas pontas e em minúsculas. */
export function emailComparavel(email: string): string {
  return email.trim().toLowerCase();
}

/** Quanto do título da reunião e do nome da conta da dona entra no e-mail. */
export const TITULO_NO_EMAIL_MAX = 200;
export const NOME_DA_DONA_NO_EMAIL_MAX = 80;

/** Uma linha só, sem caractere de controle (nada de quebra no assunto), aparada e cortada sem partir emoji. */
export function linhaLimpa(valor: string | null | undefined, maximo: number): string {
  const limpo = Array.from((valor ?? "").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim());
  return limpo.slice(0, maximo).join("").trim();
}

// O endereço com esquema (http://, ftp://...) ou com www., até colado a uma
// palavra ("Ganhehttps://..."): sem \b, que não casa entre duas letras.
const ESQUEMA_OU_WWW = new RegExp("(?:[a-z][a-z0-9+.-]*://|www[.\\u3002\\uFF0E\\uFF61])\\S*", "giu");
// O endereço de e-mail, também com a arroba de largura cheia.
const ENDERECO_DE_EMAIL = new RegExp("\\S+[@\\uFF20]\\S+", "gu");
// O domínio sem esquema, com ou sem porta e caminho: rótulos separados por
// ponto e um fim de duas letras ou mais ("bit.ly/x", "golpe.com.br/pix", e o
// domínio em outra escrita, "пример.рф"). O fim de uma letra só não é domínio:
// "e.g." e "1.500" ficam.
const DOMINIO = new RegExp("(?:[\\p{L}\\p{M}\\p{N}-]+\\.)+\\p{L}[\\p{L}\\p{M}]+(?:[/:?#]\\S*)?", "gu");
// O mesmo com o ponto japonês ou o de largura cheia ("golpe。com"), que alguns
// clientes também aceitam, só com o fim em letras latinas: o ponto japonês
// fecha frase em japonês e chinês, e "会議。次回" não é domínio.
const DOMINIO_COM_OUTRO_PONTO = new RegExp("(?:[\\p{L}\\p{M}\\p{N}-]+[.\\u3002\\uFF0E\\uFF61])+[a-z]{2,}(?:[/:?#]\\S*)?", "giu");

/**
 * O título e o nome não levam endereço web ao e-mail: o único link dele é o da
 * WRW. Sem isto, um título "Confirme seus dados em banco-seguro.com.br/acesso"
 * chegaria a quem a dona digitou, num e-mail que sai do remetente da WRW (o
 * mesmo do "Esqueci a senha"), e o app de e-mail (Gmail, Outlook, Apple Mail)
 * transformaria o endereço em link. Viram "…": o endereço com esquema ou com
 * www., o endereço de e-mail e o domínio sem esquema. O custo é o falso
 * positivo: "Node.js" também vira "…".
 */
export function semEnderecoWeb(texto: string): string {
  return texto
    .replace(ESQUEMA_OU_WWW, "…")
    .replace(ENDERECO_DE_EMAIL, "…")
    .replace(DOMINIO, "…")
    .replace(DOMINIO_COM_OUTRO_PONTO, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * O título e o nome como entram no texto fixo do e-mail: os únicos dados por
 * dentro dele. O servidor (server/email-do-resumo.ts) e a prévia da tela
 * passam por aqui, para a prévia mostrar o que de fato vai.
 */
export function valoresDoEmailDoResumo(titulo: string, dona: string | null): { titulo: string; dona: string } {
  return {
    titulo: semEnderecoWeb(linhaLimpa(titulo, TITULO_NO_EMAIL_MAX)),
    dona: semEnderecoWeb(linhaLimpa(dona, NOME_DA_DONA_NO_EMAIL_MAX)),
  };
}
