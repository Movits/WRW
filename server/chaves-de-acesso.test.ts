import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * As chaves de acesso (A6) sem banco: a configuração (WEBAUTHN_RP_ID e
 * WEBAUTHN_ORIGENS), a origem do pedido, o desafio lido da resposta, o apelido
 * e a porta da função. Sem as variáveis, ou com o pedido de uma origem fora da
 * lista, a função some: o estado diz `disponivel: false` e todo procedimento
 * recusa com CHAVE_INDISPONIVEL ANTES de tocar no banco (o dublê abaixo falha o
 * teste se alguém o chamar). O cadastro, a entrada e as regras com banco estão
 * em chaves-de-acesso.integracao.test.ts.
 */

const banco = vi.hoisted(() => ({
  exigirDb: vi.fn(async () => {
    throw new Error("a função desligada não pode tocar no banco");
  }),
}));
vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  exigirDb: banco.exigirDb,
  getDb: async () => null,
}));

import { ERRO_DA_CHAVE_DE_ACESSO } from "@shared/chaves-de-acesso";
import {
  configuracaoParaOPedido,
  desafioDaResposta,
  lerConfiguracaoDasChaves,
  limparApelido,
  origemDoPedido,
} from "./chaves-de-acesso";
import { chavesDeAcessoRouter } from "./routers/chavesDeAcesso";
import type { TrpcContext } from "./_core/context";

const PRODUCAO = { WEBAUTHN_RP_ID: "wrwglobal.org", WEBAUTHN_ORIGENS: "https://wrwglobal.org,https://www.wrwglobal.org" };
const ORIGINAIS = { rpId: process.env.WEBAUTHN_RP_ID, origens: process.env.WEBAUTHN_ORIGENS };

function definirAmbiente(valores: { WEBAUTHN_RP_ID?: string; WEBAUTHN_ORIGENS?: string }) {
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGENS;
  if (valores.WEBAUTHN_RP_ID !== undefined) process.env.WEBAUTHN_RP_ID = valores.WEBAUTHN_RP_ID;
  if (valores.WEBAUTHN_ORIGENS !== undefined) process.env.WEBAUTHN_ORIGENS = valores.WEBAUTHN_ORIGENS;
}

const pedido = (headers: Record<string, string>, protocol = "https") => ({ headers, protocol, ip: "203.0.113.5", socket: {} });
const CONTA = { id: 7, openId: "email_7", name: "Membra", email: "membra@exemplo.test", role: "silver", isActive: true, onboardingCompleted: true };
const contexto = (headers: Record<string, string>, logada = false) =>
  ({ user: logada ? CONTA : null, req: pedido(headers), res: { cookie: vi.fn(), clearCookie: vi.fn() } }) as unknown as TrpcContext;

/** O clientDataJSON em base64url, como o navegador o manda. */
const dadosDoCliente = (valor: unknown) => Buffer.from(typeof valor === "string" ? valor : JSON.stringify(valor)).toString("base64url");
const DESAFIO = "q8V0cZ3m5b2kR7wYp1sN4tLx9hJd6gFa0eUiOyTrWvQ";

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  definirAmbiente({});
  banco.exigirDb.mockClear();
  avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  avisos.mockRestore();
  definirAmbiente({ WEBAUTHN_RP_ID: ORIGINAIS.rpId, WEBAUTHN_ORIGENS: ORIGINAIS.origens });
});

describe("lerConfiguracaoDasChaves — WEBAUTHN_RP_ID e WEBAUTHN_ORIGENS", () => {
  it("sem as duas, a função fica desligada em silêncio", () => {
    expect(lerConfiguracaoDasChaves({})).toBeNull();
    expect(lerConfiguracaoDasChaves({ WEBAUTHN_RP_ID: " ", WEBAUTHN_ORIGENS: " , " })).toBeNull();
    expect(avisos).not.toHaveBeenCalled();
  });

  it("os valores de produção (15/11): o domínio e as duas origens, com e sem www", () => {
    expect(lerConfiguracaoDasChaves(PRODUCAO)).toEqual({
      rpId: "wrwglobal.org",
      origens: ["https://wrwglobal.org", "https://www.wrwglobal.org"],
    });
  });

  it("normaliza maiúsculas, espaços, barra final, porta padrão e repetição", () => {
    expect(lerConfiguracaoDasChaves({
      WEBAUTHN_RP_ID: " WRWGlobal.org ",
      WEBAUTHN_ORIGENS: " HTTPS://WWW.WRWGLOBAL.ORG/ , https://wrwglobal.org:443,https://www.wrwglobal.org",
    })).toEqual({ rpId: "wrwglobal.org", origens: ["https://www.wrwglobal.org", "https://wrwglobal.org"] });
  });

  it("aceita http só em localhost, para o desenvolvimento", () => {
    expect(lerConfiguracaoDasChaves({ WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGENS: "http://localhost:3000" }))
      .toEqual({ rpId: "localhost", origens: ["http://localhost:3000"] });
  });

  it.each([
    ["só o RP ID", { WEBAUTHN_RP_ID: "wrwglobal.org" }],
    ["só as origens", { WEBAUTHN_ORIGENS: "https://wrwglobal.org" }],
    ["RP ID com esquema", { WEBAUTHN_RP_ID: "https://wrwglobal.org", WEBAUTHN_ORIGENS: "https://wrwglobal.org" }],
    ["RP ID com porta", { WEBAUTHN_RP_ID: "wrwglobal.org:443", WEBAUTHN_ORIGENS: "https://wrwglobal.org" }],
    ["RP ID que é IP", { WEBAUTHN_RP_ID: "127.0.0.1", WEBAUTHN_ORIGENS: "https://127.0.0.1" }],
    ["origem sem https fora do localhost", { ...PRODUCAO, WEBAUTHN_ORIGENS: "http://wrwglobal.org" }],
    ["origem de outro domínio (o .onrender.com)", { ...PRODUCAO, WEBAUTHN_ORIGENS: "https://wrwglobal.org,https://mmm-gud5.onrender.com" }],
    ["origem que só termina com o nome do domínio", { ...PRODUCAO, WEBAUTHN_ORIGENS: "https://golpewrwglobal.org" }],
    ["origem com caminho", { ...PRODUCAO, WEBAUTHN_ORIGENS: "https://wrwglobal.org/login" }],
    ["origem que não é endereço", { ...PRODUCAO, WEBAUTHN_ORIGENS: "wrwglobal.org" }],
  ])("%s: desligada, com aviso no log", (_caso, ambiente) => {
    expect(lerConfiguracaoDasChaves(ambiente)).toBeNull();
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(String(avisos.mock.calls[0][0])).toMatch(/^\[Chaves de acesso\] .*A função fica desligada\.$/);
  });

  it("o aviso sai uma vez por valor, e não a cada pedido", () => {
    const errado = { ...PRODUCAO, WEBAUTHN_ORIGENS: "https://outro-valor-errado.example" };
    lerConfiguracaoDasChaves(errado);
    lerConfiguracaoDasChaves(errado);
    expect(avisos).toHaveBeenCalledTimes(1);
  });
});

describe("origemDoPedido", () => {
  it("o cabeçalho Origin vence (as mutações o levam), normalizado", () => {
    expect(origemDoPedido(pedido({ origin: "https://WWW.wrwglobal.org", host: "mmm-gud5.onrender.com" }))).toBe("https://www.wrwglobal.org");
  });

  it("sem Origin (consulta GET da mesma origem), o Host com o protocolo do Express", () => {
    expect(origemDoPedido(pedido({ host: "wrwglobal.org" }))).toBe("https://wrwglobal.org");
    expect(origemDoPedido(pedido({ host: "localhost:3000" }, "http"))).toBe("http://localhost:3000");
  });

  it("Origin \"null\", Origin malformado ou sem Host: nenhuma origem", () => {
    expect(origemDoPedido(pedido({ origin: "null", host: "wrwglobal.org" }))).toBeNull();
    expect(origemDoPedido(pedido({ origin: "https://wrwglobal.org/caminho", host: "wrwglobal.org" }))).toBeNull();
    expect(origemDoPedido(pedido({}))).toBeNull();
  });

  it("configuracaoParaOPedido: só vale para a origem da lista", () => {
    expect(configuracaoParaOPedido(pedido({ host: "wrwglobal.org" }), PRODUCAO)).not.toBeNull();
    expect(configuracaoParaOPedido(pedido({ origin: "https://www.wrwglobal.org" }), PRODUCAO)).not.toBeNull();
    expect(configuracaoParaOPedido(pedido({ host: "mmm-gud5.onrender.com" }), PRODUCAO)).toBeNull();
    expect(configuracaoParaOPedido(pedido({ host: "wrwglobal.org" }, "http"), PRODUCAO)).toBeNull();
    expect(configuracaoParaOPedido(pedido({ host: "wrwglobal.org" }), {})).toBeNull();
  });
});

describe("desafioDaResposta — o desafio que o aparelho assinou", () => {
  it("lê o challenge do clientDataJSON", () => {
    expect(desafioDaResposta(dadosDoCliente({ type: "webauthn.get", challenge: DESAFIO, origin: "https://wrwglobal.org" }))).toBe(DESAFIO);
  });

  it.each([
    ["não é texto", 42],
    ["vazio", ""],
    ["não é JSON", dadosDoCliente("{isto não é json")],
    ["JSON sem challenge", dadosDoCliente({ type: "webauthn.get" })],
    ["challenge que não é texto", dadosDoCliente({ challenge: 123 })],
    ["challenge curto demais", dadosDoCliente({ challenge: "abc" })],
    ["challenge com caractere fora do base64url", dadosDoCliente({ challenge: `${DESAFIO}'; drop` })],
    ["challenge longo demais", dadosDoCliente({ challenge: "a".repeat(129) })],
    ["clientDataJSON enorme", "a".repeat(8193)],
  ])("%s: nenhum desafio", (_caso, valor) => {
    expect(desafioDaResposta(valor)).toBeNull();
  });
});

describe("limparApelido", () => {
  it("tira controles e espaços repetidos, corta em 60 e devolve null quando sobra nada", () => {
    expect(limparApelido("  iPhone \n da\tGlenda  ")).toBe("iPhone da Glenda");
    expect(limparApelido("a\u0000b\u0007c")).toBe("a b c");
    expect(limparApelido("x".repeat(80))).toBe("x".repeat(60));
    expect(limparApelido("   ")).toBeNull();
    expect(limparApelido(null)).toBeNull();
    expect(limparApelido(undefined)).toBeNull();
  });
});

describe("chavesDeAcesso — a função some sem a configuração ou fora das origens da lista", () => {
  const procedimentos = Object.keys(chavesDeAcessoRouter._def.procedures);
  const publicos = new Set(["estado", "opcoesDeEntrada", "entrar"]);
  const chamar = (ctx: TrpcContext, nome: string) =>
    (chavesDeAcessoRouter.createCaller(ctx) as unknown as Record<string, (entrada?: unknown) => Promise<unknown>>)[nome](undefined);

  it("o router tem os oito procedimentos (a varredura abaixo não passa vazia)", () => {
    expect(procedimentos.sort()).toEqual(
      ["cadastrar", "entrar", "estado", "listar", "opcoesDeCadastro", "opcoesDeEntrada", "remover", "renomear"],
    );
  });

  it("o estado diz se a função existe para a origem deste pedido, sem tocar no banco", async () => {
    const estado = (headers: Record<string, string>) => chavesDeAcessoRouter.createCaller(contexto(headers)).estado();
    expect(await estado({ host: "wrwglobal.org" })).toEqual({ disponivel: false });
    definirAmbiente(PRODUCAO);
    expect(await estado({ host: "wrwglobal.org" })).toEqual({ disponivel: true });
    expect(await estado({ host: "www.wrwglobal.org" })).toEqual({ disponivel: true });
    expect(await estado({ host: "mmm-gud5.onrender.com" })).toEqual({ disponivel: false });
    expect(await estado({ origin: "https://mmm-gud5.onrender.com", host: "wrwglobal.org" })).toEqual({ disponivel: false });
    expect(banco.exigirDb).not.toHaveBeenCalled();
  });

  it.each([
    ["sem as variáveis", {}, { origin: "https://wrwglobal.org", host: "wrwglobal.org" }],
    ["com as variáveis, no .onrender.com", PRODUCAO, { origin: "https://mmm-gud5.onrender.com", host: "mmm-gud5.onrender.com" }],
    ["com as variáveis erradas", { ...PRODUCAO, WEBAUTHN_ORIGENS: "http://wrwglobal.org" }, { origin: "https://wrwglobal.org", host: "wrwglobal.org" }],
  ])("%s: todo procedimento recusa com CHAVE_INDISPONIVEL antes da entrada e do banco", async (_caso, ambiente, headers) => {
    definirAmbiente(ambiente);
    for (const nome of procedimentos.filter(p => p !== "estado")) {
      const ctx = contexto(headers, !publicos.has(nome));
      await expect(chamar(ctx, nome), nome).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: ERRO_DA_CHAVE_DE_ACESSO.indisponivel,
      });
      expect(ctx.res.cookie).not.toHaveBeenCalled();
    }
    expect(banco.exigirDb).not.toHaveBeenCalled();
  });

  it("com a função ligada, a resposta sem desafio legível é CHAVE_RESPOSTA_INVALIDA, também antes do banco", async () => {
    definirAmbiente(PRODUCAO);
    const resposta = {
      id: "AAAA",
      rawId: "AAAA",
      type: "public-key" as const,
      response: { clientDataJSON: dadosDoCliente("lixo"), authenticatorData: "AAAA", signature: "AAAA" },
      clientExtensionResults: {},
    };
    const ctx = contexto({ origin: "https://wrwglobal.org" });
    await expect(chavesDeAcessoRouter.createCaller(ctx).entrar({ resposta })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO_DA_CHAVE_DE_ACESSO.respostaInvalida,
    });
    expect(banco.exigirDb).not.toHaveBeenCalled();
    expect(ctx.res.cookie).not.toHaveBeenCalled();
  });

  it("os códigos de erro são códigos, não frases: a tela (A7) traduz nos 10 idiomas", () => {
    for (const codigo of Object.values(ERRO_DA_CHAVE_DE_ACESSO)) expect(codigo).toMatch(/^CHAVE_[A-Z_]+$/);
    expect(new Set(Object.values(ERRO_DA_CHAVE_DE_ACESSO)).size).toBe(Object.values(ERRO_DA_CHAVE_DE_ACESSO).length);
  });
});
