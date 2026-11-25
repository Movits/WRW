import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAuthnError } from "@simplewebauthn/browser";
import { ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";

/**
 * A biblioteca das chaves de acesso na tela (A7): o que decide se a função
 * aparece, como cada erro vira frase, o que é cancelamento (e não aparece), o
 * apelido da chave nova e a marca do convite no aparelho. A conversa com o
 * aparelho (@simplewebauthn/browser) é dublada; a classe do erro é a de verdade.
 */

const navegador = vi.hoisted(() => ({
  suporta: vi.fn(() => true),
  sugereNoCampo: vi.fn(async () => true),
  autenticadorProprio: vi.fn(async () => true),
  entrar: vi.fn(),
  cadastrar: vi.fn(),
  sinal: vi.fn(async () => undefined),
  cancelar: vi.fn(),
}));

vi.mock("@simplewebauthn/browser", async importOriginal => {
  const original = await importOriginal<typeof import("@simplewebauthn/browser")>();
  return {
    ...original,
    browserSupportsWebAuthn: navegador.suporta,
    browserSupportsWebAuthnAutofill: navegador.sugereNoCampo,
    platformAuthenticatorIsAvailable: navegador.autenticadorProprio,
    startAuthentication: navegador.entrar,
    startRegistration: navegador.cadastrar,
    sendSignal: navegador.sinal,
    WebAuthnAbortService: { cancelCeremony: navegador.cancelar, createNewAbortSignal: vi.fn() },
  };
});

import {
  apelidoSugerido,
  appComChaves,
  avisarChaveDesconhecida,
  avisarChavesQueValem,
  CHAVE_DO_CONVITE,
  codigoDoErroDaChave,
  conviteRespondidoNoAparelho,
  ehCancelamento,
  ehChaveJaCadastrada,
  entrarComAChave,
  marcarConviteNoAparelho,
  mensagemDoErroDaChave,
  podeAtivarNesteAparelho,
  podeUsarChavesAqui,
  sugestaoNoCampoDisponivel,
} from "./chaves-de-acesso";

const t = (chave: string) => `[${chave}]`;
const UA_DO_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_DA_CASCA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WRWApp/1.0";
const erroDoServidor = (codigo: string) => ({ message: codigo, data: { code: "BAD_REQUEST" } });
const erroDoAparelho = (code: ConstructorParameters<typeof WebAuthnError>[0]["code"], nome = "Error") =>
  new WebAuthnError({ message: "x", code, cause: Object.assign(new Error("x"), { name: nome }) });

beforeEach(() => {
  navegador.suporta.mockReturnValue(true);
  navegador.sugereNoCampo.mockResolvedValue(true);
  navegador.autenticadorProprio.mockResolvedValue(true);
  navegador.sinal.mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onde a função aparece", () => {
  it("aparece no navegador que fala com chaves de acesso", () => {
    expect(podeUsarChavesAqui(UA_DO_CHROME)).toBe(true);
  });

  it("não aparece na casca das lojas que não liga as chaves, mesmo com suporte", () => {
    expect(podeUsarChavesAqui(UA_DA_CASCA)).toBe(false);
    expect(podeUsarChavesAqui(UA_DA_CASCA.replace("WRWApp/1.0", "WRWApp/1.1"))).toBe(false);
    expect(appComChaves(UA_DA_CASCA)).toBe(false);
  });

  it("aparece no app que se anuncia com WRWChaves/1 (M1, Android), se a WebView fala WebAuthn", () => {
    const UA_DO_APP_COM_CHAVES = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 WRWApp/1.1 WRWChaves/1";
    expect(appComChaves(UA_DO_APP_COM_CHAVES)).toBe(true);
    expect(podeUsarChavesAqui(UA_DO_APP_COM_CHAVES)).toBe(true);
    navegador.suporta.mockReturnValue(false);
    expect(podeUsarChavesAqui(UA_DO_APP_COM_CHAVES)).toBe(false);
  });

  it("dentro do app com o sinal, o login é sempre pelo link, mesmo se a WebView disser que sugere no campo", async () => {
    const UA_DO_APP_COM_CHAVES = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 WRWApp/1.1 WRWChaves/1";
    navegador.sugereNoCampo.mockResolvedValue(true);
    expect(await sugestaoNoCampoDisponivel(UA_DO_APP_COM_CHAVES)).toBe(false);
    expect(await sugestaoNoCampoDisponivel(UA_DO_CHROME)).toBe(true);
  });

  it("o sinal só vale dentro do app: um navegador comum com WRWChaves/1 no user agent segue a regra de sempre", () => {
    expect(appComChaves("Mozilla/5.0 Chrome/131.0 WRWChaves/1")).toBe(false);
  });

  it("não aparece no navegador sem WebAuthn, nem quando a checagem falha", () => {
    navegador.suporta.mockReturnValue(false);
    expect(podeUsarChavesAqui(UA_DO_CHROME)).toBe(false);
    navegador.suporta.mockImplementation(() => { throw new Error("sem window"); });
    expect(podeUsarChavesAqui(UA_DO_CHROME)).toBe(false);
  });

  it("a sugestão no campo e o autenticador próprio respondem falso quando a checagem falha", async () => {
    navegador.sugereNoCampo.mockRejectedValue(new Error("x"));
    navegador.autenticadorProprio.mockRejectedValue(new Error("x"));
    expect(await sugestaoNoCampoDisponivel()).toBe(false);
    expect(await podeAtivarNesteAparelho()).toBe(false);
  });
});

describe("o pedido ao aparelho", () => {
  it("entra com a espera no campo e devolve as extensões como objeto comum", async () => {
    const extensoes = { credProps: { rk: true } };
    navegador.entrar.mockResolvedValue({ id: "c1", rawId: "c1", type: "public-key", response: {}, clientExtensionResults: extensoes });
    const opcoes = { challenge: "d1" } as never;
    const resposta = await entrarComAChave(opcoes, { autofill: true });
    expect(navegador.entrar).toHaveBeenCalledWith({ optionsJSON: opcoes, useBrowserAutofill: true });
    expect(resposta.clientExtensionResults).toEqual(extensoes);
    expect(resposta.clientExtensionResults).not.toBe(extensoes);
  });

  it("sem pedir, não espera no campo", async () => {
    navegador.entrar.mockResolvedValue({ id: "c1", clientExtensionResults: {} });
    await entrarComAChave({ challenge: "d1" } as never);
    expect(navegador.entrar).toHaveBeenCalledWith(expect.objectContaining({ useBrowserAutofill: false }));
  });
});

describe("o que é cancelamento", () => {
  it("fechar o pedido do aparelho (NotAllowedError) e a tela desistir (AbortError) são cancelamento", () => {
    expect(ehCancelamento(Object.assign(new Error("x"), { name: "NotAllowedError" }))).toBe(true);
    expect(ehCancelamento(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(ehCancelamento(erroDoAparelho("ERROR_CEREMONY_ABORTED"))).toBe(true);
    expect(ehCancelamento(erroDoAparelho("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "NotAllowedError"))).toBe(true);
  });

  it("erro do servidor ou do aparelho não é cancelamento", () => {
    expect(ehCancelamento(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.recusada))).toBe(false);
    expect(ehCancelamento(erroDoAparelho("ERROR_AUTHENTICATOR_GENERAL_ERROR"))).toBe(false);
    expect(ehCancelamento(null)).toBe(false);
  });
});

describe("o erro na tela", () => {
  it("lê o código da A6 só quando ele é um código conhecido", () => {
    expect(codigoDoErroDaChave(erroDoServidor("CHAVE_RECUSADA"))).toBe("CHAVE_RECUSADA");
    expect(codigoDoErroDaChave(erroDoServidor("Banco de dados indisponível"))).toBeNull();
    expect(codigoDoErroDaChave(undefined)).toBeNull();
  });

  it.each([
    [ERRO_DA_CHAVE_DE_ACESSO.indisponivel, "chavesDeAcesso.errors.unavailable"],
    [ERRO_DA_CHAVE_DE_ACESSO.desafioInvalido, "chavesDeAcesso.errors.expired"],
    [ERRO_DA_CHAVE_DE_ACESSO.respostaInvalida, "chavesDeAcesso.errors.refused"],
    [ERRO_DA_CHAVE_DE_ACESSO.recusada, "chavesDeAcesso.errors.refused"],
    [ERRO_DA_CHAVE_DE_ACESSO.desconhecida, "chavesDeAcesso.errors.unknownKey"],
    [ERRO_DA_CHAVE_DE_ACESSO.contaDesativada, "chavesDeAcesso.errors.accountDisabled"],
    [ERRO_DA_CHAVE_DE_ACESSO.muitasTentativas, "chavesDeAcesso.errors.tooManyAttempts"],
    [ERRO_DA_CHAVE_DE_ACESSO.jaCadastrada, "chavesDeAcesso.errors.alreadyRegistered"],
    [ERRO_DA_CHAVE_DE_ACESSO.limiteDaConta, "chavesDeAcesso.errors.limitReached"],
    [ERRO_DA_CHAVE_DE_ACESSO.naoEncontrada, "chavesDeAcesso.errors.notFound"],
    [ERRO_DA_CHAVE_DE_ACESSO.reautenticar, "chavesDeAcesso.errors.reauthenticate"],
    [ERRO_DA_CHAVE_DE_ACESSO.erroInterno, "chavesDeAcesso.errors.generic"],
  ])("o código %s vira a frase %s, nunca o código cru", (codigo, chave) => {
    expect(mensagemDoErroDaChave(erroDoServidor(codigo), t)).toBe(`[${chave}]`);
  });

  it("o aparelho que já tem a chave desta conta diz que ela já está ativada", () => {
    const erro = erroDoAparelho("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "InvalidStateError");
    expect(mensagemDoErroDaChave(erro, t)).toBe("[chavesDeAcesso.errors.alreadyRegistered]");
    expect(ehChaveJaCadastrada(erro)).toBe(true);
    expect(ehChaveJaCadastrada(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.jaCadastrada))).toBe(true);
    expect(ehChaveJaCadastrada(erroDoServidor(ERRO_DA_CHAVE_DE_ACESSO.recusada))).toBe(false);
  });

  it("outro erro do aparelho ou do navegador vira a frase do aparelho", () => {
    expect(mensagemDoErroDaChave(erroDoAparelho("ERROR_AUTHENTICATOR_GENERAL_ERROR"), t)).toBe("[chavesDeAcesso.errors.device]");
    expect(mensagemDoErroDaChave(new Error("SecurityError"), t)).toBe("[chavesDeAcesso.errors.device]");
  });

  it("o pedido que nem chegou ao servidor diz que o servidor está indisponível, não culpa o aparelho", () => {
    const semRede = Object.assign(new Error("Failed to fetch"), { name: "TRPCClientError" });
    expect(mensagemDoErroDaChave(semRede, t)).toBe("[errorBoundary.serverUnavailable]");
  });

  it("erro do tRPC que não é da A6 segue a tradução de sempre", () => {
    const erro = { message: "Muitas requisições. Tente novamente em alguns minutos.", data: { code: "TOO_MANY_REQUESTS" } };
    expect(mensagemDoErroDaChave(erro, t)).not.toContain("chavesDeAcesso");
  });
});

describe("o apelido da chave nova", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)", "Chromebook"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Mac"],
    [UA_DO_CHROME, "Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Linux"],
  ])("%s vira %s", (ua, apelido) => {
    expect(apelidoSugerido(ua)).toBe(apelido);
  });

  it("aparelho desconhecido fica sem apelido", () => {
    expect(apelidoSugerido("curl/8.0")).toBeNull();
  });
});

describe("o aviso ao aparelho (Signal API)", () => {
  it("avisa a chave que não vale mais e a lista das que valem", async () => {
    await avisarChaveDesconhecida("wrwglobal.org", "c1");
    expect(navegador.sinal).toHaveBeenCalledWith({ signalName: "unknownCredential", rpID: "wrwglobal.org", credentialID: "c1" });
    await avisarChavesQueValem("wrwglobal.org", "u1", ["c2"]);
    expect(navegador.sinal).toHaveBeenCalledWith({ signalName: "allAcceptedCredentials", rpID: "wrwglobal.org", userID: "u1", allAcceptedCredentialIDs: ["c2"] });
  });

  it("navegador sem a Signal API não quebra a tela", async () => {
    navegador.sinal.mockRejectedValue(new Error("sem Signal API"));
    await expect(avisarChaveDesconhecida("wrwglobal.org", "c1")).resolves.toBeUndefined();
    await expect(avisarChavesQueValem("wrwglobal.org", "u1", [])).resolves.toBeUndefined();
  });
});

describe("a marca do convite no aparelho", () => {
  it("começa sem resposta e guarda a resposta", () => {
    expect(conviteRespondidoNoAparelho()).toBe(false);
    marcarConviteNoAparelho("recusado");
    expect(localStorage.getItem(CHAVE_DO_CONVITE)).toBe("recusado");
    expect(conviteRespondidoNoAparelho()).toBe(true);
  });

  it("armazenamento bloqueado: o convite aparece e marcar não quebra", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("bloqueado"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("bloqueado"); });
    expect(conviteRespondidoNoAparelho()).toBe(false);
    expect(() => marcarConviteNoAparelho("ativada")).not.toThrow();
  });
});
