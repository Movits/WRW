// As chaves de acesso (passkeys) na tela: entrar com Face ID, digital ou o
// bloqueio de tela do aparelho, e cadastrar a chave deste aparelho (A7 do
// desenho do gravador, docs/arquitetura/gravador-de-reunioes.md). O servidor é
// a A6 (server/routers/chavesDeAcesso.ts); o que os dois lados leem fica em
// shared/chaves-de-acesso.ts.
//
// A biometria nunca sai do aparelho: quem confere a pessoa é o próprio aparelho,
// e a WRW recebe só uma assinatura, que o servidor confere.
//
// Na casca das lojas (a WebView da #180) nada disso aparece até a M1 ligar as
// chaves lá dentro: a WebView ainda não fala com o autenticador do aparelho.

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  sendSignal,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { ERRO_DA_CHAVE_DE_ACESSO, type CodigoDeErroDaChaveDeAcesso } from "@shared/chaves-de-acesso";
import { abertoNaCascaDasLojas } from "@/lib/instalacao-do-app";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";

type Traduzir = (chave: string) => string;

/** O navegador fala com chaves de acesso, e não é a casca das lojas. */
export function podeUsarChavesAqui(userAgent: string): boolean {
  if (abertoNaCascaDasLojas(userAgent)) return false;
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/**
 * O navegador oferece a chave no próprio campo de e-mail ou de senha (o
 * preenchimento automático, "conditional UI"). É o jeito principal de entrar
 * com a chave: o navegador só sugere quando já existe uma chave da WRW neste
 * aparelho, ou seja, depois do primeiro login com o convite aceito.
 */
export async function sugestaoNoCampoDisponivel(): Promise<boolean> {
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/** O aparelho tem autenticador próprio (Face ID, Touch ID, digital, Windows Hello). */
export async function podeAtivarNesteAparelho(): Promise<boolean> {
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

/**
 * A resposta do aparelho no formato que o servidor recebe: as extensões viram
 * um objeto comum (o zod da A6 as lê como `Record<string, unknown>`, e o tipo
 * da biblioteca é uma interface fechada, que o TypeScript não aceita ali).
 */
type ParaOServidor<T extends { clientExtensionResults: object }> = Omit<T, "clientExtensionResults"> & {
  clientExtensionResults: Record<string, unknown>;
};

function paraOServidor<T extends { clientExtensionResults: object }>(resposta: T): ParaOServidor<T> {
  return { ...resposta, clientExtensionResults: { ...resposta.clientExtensionResults } as Record<string, unknown> };
}

/** Pede ao aparelho a assinatura de entrada. Com `autofill`, espera a escolha no campo. */
export async function entrarComAChave(
  opcoes: PublicKeyCredentialRequestOptionsJSON,
  { autofill = false }: { autofill?: boolean } = {},
): Promise<ParaOServidor<AuthenticationResponseJSON>> {
  return paraOServidor(await startAuthentication({ optionsJSON: opcoes, useBrowserAutofill: autofill }));
}

/** Pede ao aparelho uma chave nova para esta conta. */
export async function cadastrarAChave(opcoes: PublicKeyCredentialCreationOptionsJSON): Promise<ParaOServidor<RegistrationResponseJSON>> {
  return paraOServidor(await startRegistration({ optionsJSON: opcoes }));
}

/** Desiste do pedido em andamento (a espera no campo, por exemplo). */
export function cancelarPedidoDaChave() {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nada em andamento.
  }
}

/**
 * A pessoa fechou o pedido do aparelho, ou a tela desistiu dele. Não é erro:
 * nada aparece. O navegador também responde NotAllowedError quando o tempo
 * acaba, e aí também não há o que avisar.
 */
export function ehCancelamento(erro: unknown): boolean {
  if (erro instanceof WebAuthnError && erro.code === "ERROR_CEREMONY_ABORTED") return true;
  const nome = (erro as { name?: unknown } | null)?.name;
  const causa = (erro as { cause?: { name?: unknown } } | null)?.cause?.name;
  return [nome, causa].some(n => n === "NotAllowedError" || n === "AbortError");
}

const CODIGOS = new Set<string>(Object.values(ERRO_DA_CHAVE_DE_ACESSO));

/** O código da A6 que veio na mensagem do erro do tRPC, ou null. */
export function codigoDoErroDaChave(erro: unknown): CodigoDeErroDaChaveDeAcesso | null {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  return typeof mensagem === "string" && CODIGOS.has(mensagem) ? (mensagem as CodigoDeErroDaChaveDeAcesso) : null;
}

/**
 * Cada código da A6 vira a frase no idioma da tela. O Record é pelo tipo do
 * servidor: código novo lá não compila aqui sem a frase dele. Cada valor chama
 * t() com a chave literal, para o teste de chaves usadas
 * (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
 */
const FRASE_POR_CODIGO: Record<CodigoDeErroDaChaveDeAcesso, (t: Traduzir) => string> = {
  CHAVE_INDISPONIVEL: t => t("chavesDeAcesso.errors.unavailable"),
  CHAVE_DESAFIO_INVALIDO: t => t("chavesDeAcesso.errors.expired"),
  CHAVE_RESPOSTA_INVALIDA: t => t("chavesDeAcesso.errors.refused"),
  CHAVE_RECUSADA: t => t("chavesDeAcesso.errors.refused"),
  CHAVE_DESCONHECIDA: t => t("chavesDeAcesso.errors.unknownKey"),
  CHAVE_CONTA_DESATIVADA: t => t("chavesDeAcesso.errors.accountDisabled"),
  CHAVE_MUITAS_TENTATIVAS: t => t("chavesDeAcesso.errors.tooManyAttempts"),
  CHAVE_JA_CADASTRADA: t => t("chavesDeAcesso.errors.alreadyRegistered"),
  CHAVE_LIMITE_DA_CONTA: t => t("chavesDeAcesso.errors.limitReached"),
  CHAVE_NAO_ENCONTRADA: t => t("chavesDeAcesso.errors.notFound"),
  CHAVE_REAUTENTICAR: t => t("chavesDeAcesso.errors.reauthenticate"),
  CHAVE_ERRO_INTERNO: t => t("chavesDeAcesso.errors.generic"),
};

/**
 * A chave deste aparelho já está na conta: o servidor diz CHAVE_JA_CADASTRADA,
 * ou o próprio aparelho recusa criar outra (a chave dele está em
 * excludeCredentials). Para quem ativa, é "já está ativada".
 */
export function ehChaveJaCadastrada(erro: unknown): boolean {
  if (codigoDoErroDaChave(erro) === ERRO_DA_CHAVE_DE_ACESSO.jaCadastrada) return true;
  return erro instanceof WebAuthnError && erro.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED";
}

/** A frase do erro, no idioma da tela. Quem chama trata o cancelamento antes. */
export function mensagemDoErroDaChave(erro: unknown, t: Traduzir): string {
  const codigo = codigoDoErroDaChave(erro);
  if (codigo) return FRASE_POR_CODIGO[codigo](t);
  if (erro instanceof WebAuthnError) {
    // O aparelho já guarda uma chave desta conta (excludeCredentials).
    if (ehChaveJaCadastrada(erro)) return t("chavesDeAcesso.errors.alreadyRegistered");
    return t("chavesDeAcesso.errors.device");
  }
  // Erro do tRPC que não é da A6 (banco fora do ar, sessão vencida...), e
  // também o pedido que nem chegou ao servidor (sem rede, servidor fora do ar:
  // TRPCClientError sem `data`), que vira "servidor indisponível", nunca culpa do aparelho.
  const comoTrpc = erro as { data?: unknown; name?: unknown } | null;
  if (comoTrpc?.data || comoTrpc?.name === "TRPCClientError") return mensagemDeErroParaTela(erro, t);
  // Erro do próprio navegador ao falar com o aparelho.
  return t("chavesDeAcesso.errors.device");
}

/**
 * Um apelido para a chave nova, que a dona reconhece na lista do Perfil. É só
 * a família do aparelho, nunca o modelo: o userAgent não diz qual iPhone é, e a
 * lista não precisa de mais do que isso. Pode ser trocado no Perfil.
 */
export function apelidoSugerido(userAgent: string): string | null {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "Chromebook";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

/**
 * Avisa o aparelho de que a chave que ele ofereceu não vale mais (foi removida,
 * a senha foi redefinida, a conta foi excluída), para ele parar de sugeri-la.
 * Melhor esforço: navegador sem a Signal API, ou que recusa, não muda nada.
 */
export async function avisarChaveDesconhecida(rpId: string, credencialId: string) {
  try {
    await sendSignal({ signalName: "unknownCredential", rpID: rpId, credentialID: credencialId });
  } catch {
    // Sem a Signal API.
  }
}

/** Avisa o aparelho de quais chaves da conta ainda valem, depois de remover uma no Perfil. */
export async function avisarChavesQueValem(rpId: string, identificadorDaConta: string, credenciais: string[]) {
  try {
    await sendSignal({ signalName: "allAcceptedCredentials", rpID: rpId, userID: identificadorDaConta, allAcceptedCredentialIDs: credenciais });
  } catch {
    // Sem a Signal API.
  }
}

/**
 * A resposta ao convite "Ativar neste aparelho", depois do login por senha. Fica
 * no aparelho, não na conta: em outro aparelho o convite aparece de novo, que é
 * o que se quer. Não sai no "Sair", como a marca da dica de instalação.
 */
export const CHAVE_DO_CONVITE = "mmm:convite-da-chave-de-acesso";

export function conviteRespondidoNoAparelho(): boolean {
  try {
    return localStorage.getItem(CHAVE_DO_CONVITE) !== null;
  } catch {
    // Armazenamento bloqueado (modo privado): o convite aparece.
    return false;
  }
}

export function marcarConviteNoAparelho(resposta: "ativada" | "recusado") {
  try {
    localStorage.setItem(CHAVE_DO_CONVITE, resposta);
  } catch {
    // Sem armazenamento: o convite volta no próximo login, e só.
  }
}
