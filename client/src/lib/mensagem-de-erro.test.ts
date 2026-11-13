import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_DO_LIMITE } from "@shared/const";
import { TRPCClientError } from "@trpc/client";
import { mensagemDeErroParaTela } from "./mensagem-de-erro";

/**
 * O que a tela mostra quando a consulta falha (revisão da PR-A): só a
 * mensagem que veio do servidor (envelope tRPC, com `data.code`) é para a
 * usuária ler. O resto — 502/503 em HTML do Render, JSON fora do envelope,
 * rede fora — chega como texto técnico em inglês e vira o genérico.
 *
 * Os erros aqui são TRPCClientError de verdade, montados como o cliente
 * monta: `from()` com o envelope do servidor e o construtor com a causa da
 * rede.
 */
const t = (chave: string) => `[${chave}]`;
const GENERICO = "[errorBoundary.serverUnavailable]";

describe("mensagemDeErroParaTela — mensagem do servidor ou o genérico traduzido", () => {
  it("erro devolvido pelo servidor (envelope tRPC com data.code): a mensagem dele, já em português", () => {
    const erro = TRPCClientError.from({
      error: { code: -32603, message: "Banco de dados indisponível. Tente de novo em instantes.", data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "network.list" } },
    });
    expect(erro.data?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(mensagemDeErroParaTela(erro, t)).toBe("Banco de dados indisponível. Tente de novo em instantes.");
  });

  it("FORBIDDEN lançado de propósito por um router passa intacto", () => {
    const erro = TRPCClientError.from({ error: { code: -32003, message: "Só contas Ouro acessam o acervo.", data: { code: "FORBIDDEN", httpStatus: 403 } } });
    expect(mensagemDeErroParaTela(erro, t)).toBe("Só contas Ouro acessam o acervo.");
  });

  it("rede fora ('Failed to fetch', sem envelope): o genérico, não o texto técnico", () => {
    const erro = new TRPCClientError("Failed to fetch", { cause: new TypeError("Failed to fetch") });
    expect(erro.data).toBeUndefined();
    expect(mensagemDeErroParaTela(erro, t)).toBe(GENERICO);
  });

  it("502/503 em HTML: o SyntaxError do res.json() vira o genérico", () => {
    const erro = TRPCClientError.from(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"));
    expect(erro.data).toBeUndefined();
    expect(mensagemDeErroParaTela(erro, t)).toBe(GENERICO);
  });

  it("JSON fora do envelope (como o 403 do bloqueio de scanners): 'Unable to transform response from server' vira o genérico", () => {
    const erro = TRPCClientError.from(new Error("Unable to transform response from server"));
    expect(erro.message).toBe("Unable to transform response from server");
    expect(mensagemDeErroParaTela(erro, t)).toBe(GENERICO);
  });

  it("`data` presente mas sem `code` não conta como envelope do servidor", () => {
    expect(mensagemDeErroParaTela({ message: "Failed to fetch", data: {} }, t)).toBe(GENERICO);
    expect(mensagemDeErroParaTela({ message: "Failed to fetch", data: { httpStatus: 502 } }, t)).toBe(GENERICO);
  });

  it("envelope com mensagem vazia não deixa a tela em branco", () => {
    expect(mensagemDeErroParaTela({ message: "   ", data: { code: "INTERNAL_SERVER_ERROR" } }, t)).toBe(GENERICO);
  });

  it("nada, null ou string solta: o genérico", () => {
    expect(mensagemDeErroParaTela(undefined, t)).toBe(GENERICO);
    expect(mensagemDeErroParaTela(null, t)).toBe(GENERICO);
    expect(mensagemDeErroParaTela("Failed to fetch", t)).toBe(GENERICO);
  });
});

// O 429 do limite geral da API (responderLimite) chega no envelope, com a frase
// do servidor em português. Antes ela saía em português nos dez idiomas.
describe("mensagemDeErroParaTela — a frase do limite da API no idioma da tela", () => {
  const limite = () =>
    TRPCClientError.from({ error: { code: -32029, message: MENSAGEM_DO_LIMITE, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } } });

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it("em português é a frase do servidor, caractere a caractere", () => {
    expect(i18n.t("errors.tooManyRequests")).toBe(MENSAGEM_DO_LIMITE);
    expect(mensagemDeErroParaTela(limite(), chave => i18n.t(chave))).toBe(MENSAGEM_DO_LIMITE);
  });

  it("em inglês sai traduzida", async () => {
    await i18n.changeLanguage("en");
    expect(mensagemDeErroParaTela(limite(), chave => i18n.t(chave))).toBe("Too many requests in a short time. Wait a few seconds and try again.");
  });
});
