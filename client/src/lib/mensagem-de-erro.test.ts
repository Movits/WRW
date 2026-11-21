import { afterEach, describe, expect, it } from "vitest";
import i18n, { CODIGOS } from "@/i18n";
import {
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO,
} from "@shared/resumo-por-email";
import { MENSAGEM_DO_LIMITE, MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO, MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA, type CodigoDaRecusaDaParte } from "@shared/const";
import { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO, MENSAGEM_EMAIL_SEM_RESUMO_PRONTO } from "@shared/email-de-retorno";
import { MENSAGEM_EXPORTACOES_DEMAIS, MENSAGEM_EXPORTAR_SO_PRONTA } from "@shared/exportar-reuniao";
import { TRPCClientError } from "@trpc/client";
import { MENSAGEM_ACAO_NAO_ENCONTRADA, MENSAGEM_CONTATO_FORA_DA_REDE } from "@shared/proximas-acoes";
import { MENSAGEM_SENHA_DO_LINK_PEDIDA } from "@shared/senha-do-link";
import { mensagemDaRecusaDaParte, mensagemDeErroParaTela, traduzirMensagemDoServidor } from "./mensagem-de-erro";

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

// As recusas das decisões do resumo guardado (H4c, server/resumo-guardado.ts)
// chegam no envelope, com a frase do servidor em português, e saem no idioma
// da tela pela mesma tabela.
describe("mensagemDeErroParaTela — as recusas do resumo guardado no idioma da tela", () => {
  const recusa = (codigo: string, mensagem: string) =>
    TRPCClientError.from({ error: { code: -32009, message: mensagem, data: { code: codigo, httpStatus: 409 } } });
  const CASOS: Array<[string, string, string, string]> = [
    ["CONFLICT", MENSAGEM_RESUMO_SENDO_GERADO, "meetings.summary.errorRegenerating", "This meeting's summary is being regenerated. Wait for it to finish before deciding."],
    ["NOT_FOUND", MENSAGEM_ITEM_NAO_ENCONTRADO, "meetings.summary.errorItemGone", "This summary item no longer exists. Refresh the page."],
    ["BAD_REQUEST", MENSAGEM_SO_ACAO_TEM_CAIXA, "meetings.summary.errorOnlyActions", "Only the summary's actions have a checkbox."],
    // O item que a dona acrescenta passaria do teto do resumo (H4f).
    ["PRECONDITION_FAILED", MENSAGEM_RESUMO_CHEIO, "meetings.summary.errorFull", "This summary has reached the maximum number of items."],
  ];

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it.each(CASOS)("%s: em português é a frase do servidor, caractere a caractere", (codigo, mensagem, chave) => {
    expect(i18n.t(chave)).toBe(mensagem);
    expect(mensagemDeErroParaTela(recusa(codigo, mensagem), c => i18n.t(c))).toBe(mensagem);
  });

  it.each(CASOS)("%s: em inglês sai traduzida", async (codigo, mensagem, _chave, emIngles) => {
    await i18n.changeLanguage("en");
    expect(mensagemDeErroParaTela(recusa(codigo, mensagem), c => i18n.t(c))).toBe(emIngles);
    expect(traduzirMensagemDoServidor(mensagem, c => i18n.t(c))).toBe(emIngles);
  });
});

// As recusas do rascunho de e-mail de retorno (H20, server/email-de-retorno.ts)
// seguem o mesmo caminho: a frase do servidor em português, traduzida pela tabela.
describe("mensagemDeErroParaTela — as recusas do e-mail de retorno no idioma da tela", () => {
  const recusa = (mensagem: string) =>
    TRPCClientError.from({ error: { code: -32012, message: mensagem, data: { code: "PRECONDITION_FAILED", httpStatus: 412 } } });
  const CASOS: Array<[string, string, string]> = [
    [MENSAGEM_EMAIL_SEM_RESUMO_PRONTO, "meetings.followUp.summaryNotReady", "This meeting's summary is not ready. Wait for it to finish to write the email."],
    [MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO, "meetings.followUp.needsConfirmed", "Confirm at least one summary item to write the email."],
  ];

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it.each(CASOS)("'%s': em português é a frase do servidor, caractere a caractere", (mensagem, chave) => {
    expect(i18n.t(chave)).toBe(mensagem);
    expect(mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c))).toBe(mensagem);
  });

  it.each(CASOS)("'%s': em inglês sai traduzida", async (mensagem, _chave, emIngles) => {
    await i18n.changeLanguage("en");
    expect(mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c))).toBe(emIngles);
  });
});

// As recusas do resumo por e-mail (H22, server/resumo-por-email.ts): a frase do
// servidor em português, traduzida pela mesma tabela, nos 10 idiomas.
describe("mensagemDeErroParaTela — as recusas do resumo por e-mail no idioma da tela", () => {
  const recusa = (mensagem: string) =>
    TRPCClientError.from({ error: { code: -32012, message: mensagem, data: { code: "PRECONDITION_FAILED", httpStatus: 412 } } });
  const CASOS: Array<[string, string]> = [
    [MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO, "resumoPorEmail.erros.semResumo"],
    [MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA, "resumoPorEmail.erros.semDestinataria"],
    [MENSAGEM_RESUMO_POR_EMAIL_DEMAIS, "resumoPorEmail.erros.demais"],
    [MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA, "resumoPorEmail.erros.foraDaAgenda"],
    [MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO, "resumoPorEmail.erros.emailInvalido"],
    [MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA, "resumoPorEmail.erros.semEmailDaDona"],
    [MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO, "resumoPorEmail.erros.linkDesligado"],
    [MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO, "resumoPorEmail.erros.tetoDaReuniao"],
    [MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA, "resumoPorEmail.erros.tetoDaDona"],
    [MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU, "resumoPorEmail.erros.naoSaiu"],
    [MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR, "resumoPorEmail.erros.nadaAReenviar"],
  ];

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it.each(CASOS)("'%s': em português é a frase do servidor, caractere a caractere", (mensagem, chave) => {
    expect(i18n.t(chave)).toBe(mensagem);
    expect(mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c))).toBe(mensagem);
  });

  it.each(CASOS)("'%s': nos outros 9 idiomas sai traduzida, nunca a frase em português", async (mensagem, chave) => {
    for (const idioma of CODIGOS.filter(codigo => codigo !== "pt-BR")) {
      await i18n.changeLanguage(idioma);
      const traduzida = mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c));
      expect(traduzida, `${idioma}: ${chave}`).toBe(i18n.t(chave));
      expect(traduzida, `${idioma}: ${chave}`).not.toBe(mensagem);
    }
  });
});

/**
 * A parte da gravação em partes que o servidor recusou de vez (G13b): a rota
 * das partes responde só o código, e a tela avisa a dona no idioma dela. Todo
 * código do servidor tem aviso traduzido, e nenhum sai cru.
 */
describe("mensagemDaRecusaDaParte — o código da recusa vira aviso no idioma da tela", () => {
  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  const AVISO: Array<[CodigoDaRecusaDaParte, string]> = [
    ["SEM_REUNIAO", "Um trecho da gravação não foi guardado: a reunião foi excluída ou já não recebe áudio."],
    ["FORA_DO_ESTADO", "Um trecho da gravação não foi guardado: a reunião foi excluída ou já não recebe áudio."],
    ["GRANDE_DEMAIS", "Um trecho da gravação passou do tamanho ou do tempo que o servidor aceita e ficou de fora da transcrição."],
    ["LONGA_DEMAIS", "Um trecho da gravação passou do tamanho ou do tempo que o servidor aceita e ficou de fora da transcrição."],
    ["FORMATO", "O servidor não conseguiu ler um trecho da gravação, que ficou de fora da transcrição."],
    ["SEM_DURACAO", "O servidor não conseguiu ler um trecho da gravação, que ficou de fora da transcrição."],
    ["CONTEUDO_DIFERENTE", "O servidor recusou um trecho da gravação, que ficou de fora da transcrição."],
    ["POSICAO", "O servidor recusou um trecho da gravação, que ficou de fora da transcrição."],
  ];

  it.each(AVISO)("%s: o aviso em português, nunca o código", (codigo, aviso) => {
    expect(mensagemDaRecusaDaParte(codigo, c => i18n.t(c))).toBe(aviso);
  });

  it.each(AVISO)("%s: em inglês sai traduzido", async (codigo, aviso) => {
    await i18n.changeLanguage("en");
    const emIngles = mensagemDaRecusaDaParte(codigo, c => i18n.t(c));
    expect(emIngles).not.toBe(aviso);
    expect(emIngles).not.toContain(codigo);
    expect(emIngles).toMatch(/recording/);
  });

  it("código desconhecido ou ausente: o aviso genérico, sem o código cru", () => {
    expect(mensagemDaRecusaDaParte("OUTRA_COISA", t)).toBe("[meetings.partRejected]");
    expect(mensagemDaRecusaDaParte(undefined, t)).toBe("[meetings.partRejected]");
    // O que vem do protótipo do objeto não é código da tabela.
    expect(mensagemDaRecusaDaParte("toString", t)).toBe("[meetings.partRejected]");
  });
});

// As recusas do PDF da reunião (H8): a reunião que não está pronta
// (server/exportar-reuniao.ts) e o teto de exportações (routers/meetings.ts).
describe("mensagemDeErroParaTela — as recusas do PDF da reunião no idioma da tela", () => {
  const recusa = (codigo: string, mensagem: string) =>
    TRPCClientError.from({ error: { code: -32012, message: mensagem, data: { code: codigo, httpStatus: 412 } } });
  const CASOS: Array<[string, string, string, string]> = [
    ["PRECONDITION_FAILED", MENSAGEM_EXPORTAR_SO_PRONTA, "meetings.export.onlyReady", "You can only download the PDF of a meeting that is ready."],
    ["TOO_MANY_REQUESTS", MENSAGEM_EXPORTACOES_DEMAIS, "meetings.export.tooMany", "Too many PDFs downloaded in a row. Wait a few minutes and try again."],
  ];

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it.each(CASOS)("%s: em português é a frase do servidor, caractere a caractere", (codigo, mensagem, chave) => {
    expect(i18n.t(chave)).toBe(mensagem);
    expect(mensagemDeErroParaTela(recusa(codigo, mensagem), c => i18n.t(c))).toBe(mensagem);
  });

  it.each(CASOS)("%s: em inglês sai traduzida", async (codigo, mensagem, _chave, emIngles) => {
    await i18n.changeLanguage("en");
    expect(mensagemDeErroParaTela(recusa(codigo, mensagem), c => i18n.t(c))).toBe(emIngles);
  });
});

// As recusas das próximas ações (H5a, server/proximas-acoes.ts), pela mesma tabela.
describe("mensagemDeErroParaTela — as recusas das próximas ações no idioma da tela", () => {
  const recusa = (mensagem: string) =>
    TRPCClientError.from({ error: { code: -32004, message: mensagem, data: { code: "NOT_FOUND", httpStatus: 404 } } });
  const CASOS: Array<[string, string, string]> = [
    [MENSAGEM_ACAO_NAO_ENCONTRADA, "proximasAcoes.errorGone", "This next action no longer exists. Refresh the page."],
    [MENSAGEM_CONTATO_FORA_DA_REDE, "proximasAcoes.errorContactOutside", "This contact isn't in your network."],
  ];

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it.each(CASOS)("%s: em português é a frase do servidor, caractere a caractere", (mensagem, chave) => {
    expect(i18n.t(chave)).toBe(mensagem);
    expect(mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c))).toBe(mensagem);
  });

  it.each(CASOS)("%s: em inglês sai traduzida", async (mensagem, _chave, emIngles) => {
    await i18n.changeLanguage("en");
    expect(mensagemDeErroParaTela(recusa(mensagem), c => i18n.t(c))).toBe(emIngles);
  });
});

describe("mensagemDeErroParaTela — o link com senha no idioma da tela (H23)", () => {
  const recusa = TRPCClientError.from({ error: { code: -32001, message: MENSAGEM_SENHA_DO_LINK_PEDIDA, data: { code: "UNAUTHORIZED", httpStatus: 401 } } });

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it("em português é a frase do servidor; nos outros 9 idiomas sai traduzida, nunca a frase em português", async () => {
    expect(i18n.t("meetings.openLink.password.required")).toBe(MENSAGEM_SENHA_DO_LINK_PEDIDA);
    expect(mensagemDeErroParaTela(recusa, c => i18n.t(c))).toBe(MENSAGEM_SENHA_DO_LINK_PEDIDA);
    for (const idioma of CODIGOS.filter(codigo => codigo !== "pt-BR")) {
      await i18n.changeLanguage(idioma);
      const traduzida = mensagemDeErroParaTela(recusa, c => i18n.t(c));
      expect(traduzida, idioma).toBe(i18n.t("meetings.openLink.password.required"));
      expect(traduzida, idioma).not.toBe(MENSAGEM_SENHA_DO_LINK_PEDIDA);
    }
  });
});

// O interesse da conta que caiu para Bronze com o cartão ainda aberto (U3,
// server/routers/connections.ts): a frase do servidor, traduzida pela tabela.
describe("mensagemDeErroParaTela — a recusa do interesse da Bronze (U3) no idioma da tela", () => {
  const recusa = () =>
    TRPCClientError.from({ error: { code: -32003, message: MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO, data: { code: "FORBIDDEN", httpStatus: 403 } } });

  afterEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  it("em português é a frase do servidor, caractere a caractere", () => {
    expect(i18n.t("dashboard.interestNeedsSilver")).toBe(MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO);
    expect(mensagemDeErroParaTela(recusa(), c => i18n.t(c))).toBe(MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO);
  });

  it("em inglês sai traduzida", async () => {
    await i18n.changeLanguage("en");
    expect(traduzirMensagemDoServidor(MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO, c => i18n.t(c)))
      .toBe("Complete your profile to see the suggested connections and express interest in them.");
  });
});
