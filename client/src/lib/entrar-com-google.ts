// Entrar com a conta Google (A8) na tela: a frase de cada resultado que a volta
// da Google traz em `?conta-google=` e a de cada recusa do tRPC. As frases do
// servidor vêm em código (shared/entrar-com-google.ts), e a tela escolhe a do
// idioma de quem lê.

import { ERRO_DA_CONTA_GOOGLE, PARAMETRO_DA_CONTA_GOOGLE, type ResultadoDaContaGoogle } from "@shared/entrar-com-google";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type AvisoDaContaGoogle = { tipo: "success" | "info" | "error"; texto: string };

/** A frase de cada resultado da volta. */
export function avisoDaContaGoogle(t: TranslateFn, resultado: ResultadoDaContaGoogle): AvisoDaContaGoogle {
  switch (resultado) {
    case "negada": return { tipo: "info", texto: t("contaGoogle.result.denied") };
    case "expirou": return { tipo: "error", texto: t("contaGoogle.result.expired") };
    case "erro": return { tipo: "error", texto: t("contaGoogle.result.error") };
    case "email-nao-verificado": return { tipo: "error", texto: t("contaGoogle.result.emailNotVerified") };
    case "sem-conta": return { tipo: "info", texto: t("contaGoogle.result.noAccount") };
    case "conta-existe": return { tipo: "info", texto: t("contaGoogle.result.accountExists") };
    case "desativada": return { tipo: "error", texto: t("contaGoogle.result.deactivated") };
    case "muitas-tentativas": return { tipo: "error", texto: t("contaGoogle.result.tooManyAttempts") };
    case "ligada": return { tipo: "success", texto: t("contaGoogle.result.linked") };
    case "em-outra-conta": return { tipo: "error", texto: t("contaGoogle.result.inAnotherAccount") };
    case "outra-ligada": return { tipo: "error", texto: t("contaGoogle.result.anotherLinked") };
    case "entre-de-novo": return { tipo: "info", texto: t("contaGoogle.result.signInAgain") };
    case "endereco": return { tipo: "error", texto: t("contaGoogle.result.wrongAddress") };
  }
}

/** A frase de uma recusa do tRPC (desligar): o código decide; o resto segue a tradução de sempre. */
export function mensagemDoErroDaContaGoogle(t: TranslateFn, erro: unknown): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (mensagem === ERRO_DA_CONTA_GOOGLE.semSenha) return t("contaGoogle.errors.noPassword");
  if (mensagem === ERRO_DA_CONTA_GOOGLE.naoLigada) return t("contaGoogle.errors.notLinked");
  if (mensagem === ERRO_DA_CONTA_GOOGLE.indisponivel) return t("contaGoogle.errors.unavailable");
  return mensagemDeErroParaTela(erro, t);
}

/** A busca sem o `?conta-google=`, para o F5 não repetir o aviso. */
export function buscaSemOResultado(busca: string): string {
  const resto = new URLSearchParams(busca);
  resto.delete(PARAMETRO_DA_CONTA_GOOGLE);
  const consulta = resto.toString();
  return consulta ? `?${consulta}` : "";
}

/** O host da origem (o FRONTEND_URL do servidor), em minúsculas, ou null. */
export function hostDaOrigem(origem: string): string | null {
  try {
    return new URL(origem).host.toLowerCase();
  } catch {
    return null;
  }
}
