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

import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { ERRO_DA_CHAVE_DE_ACESSO, MINUTOS_PARA_CADASTRAR_CHAVE } from "@shared/chaves-de-acesso";
import {
  COLUNAS_DA_SESSAO_QUE_CADASTRA,
  configuracaoParaOPedido,
  desafioDaResposta,
  esquecerAvisosDasChaves,
  identificadorFixoDaConta,
  lerConfiguracaoDasChaves,
  limparApelido,
  montarAvisoDeChaveCadastrada,
  origemDoPedido,
} from "./chaves-de-acesso";
import {
  CADASTROS_DE_CHAVE_POR_CONTA,
  chavesDeAcessoRouter,
  tetoDeCadastroDeChave,
  tetoDeEntradaComChave,
  tetoDeEntradaPorChave,
  tetoDeOpcoesDeEntrada,
} from "./routers/chavesDeAcesso";
import { LOGINS_POR_REDE, LOGINS_POR_REDE_E_EMAIL } from "./routers/auth";
import type { TrpcContext } from "./_core/context";

const PRODUCAO = { WEBAUTHN_RP_ID: "wrwglobal.org", WEBAUTHN_ORIGENS: "https://wrwglobal.org,https://www.wrwglobal.org" };
const ORIGINAIS = { rpId: process.env.WEBAUTHN_RP_ID, origens: process.env.WEBAUTHN_ORIGENS };

function definirAmbiente(valores: { WEBAUTHN_RP_ID?: string; WEBAUTHN_ORIGENS?: string }) {
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGENS;
  if (valores.WEBAUTHN_RP_ID !== undefined) process.env.WEBAUTHN_RP_ID = valores.WEBAUTHN_RP_ID;
  if (valores.WEBAUTHN_ORIGENS !== undefined) process.env.WEBAUTHN_ORIGENS = valores.WEBAUTHN_ORIGENS;
}

const pedido = (headers: Record<string, string>, protocol = "https", ip = "203.0.113.5") => ({ headers, protocol, ip, socket: {} });
const CONTA = { id: 7, openId: "email_7", name: "Membra", email: "membra@exemplo.test", role: "silver", isActive: true, onboardingCompleted: true };
const contexto = (headers: Record<string, string>, logada = false, extra: { ip?: string; id?: number } = {}) =>
  ({
    user: logada ? { ...CONTA, id: extra.id ?? CONTA.id } : null,
    req: pedido(headers, "https", extra.ip),
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
  }) as unknown as TrpcContext;

/** O clientDataJSON em base64url, como o navegador o manda. */
const dadosDoCliente = (valor: unknown) => Buffer.from(typeof valor === "string" ? valor : JSON.stringify(valor)).toString("base64url");
const DESAFIO = "q8V0cZ3m5b2kR7wYp1sN4tLx9hJd6gFa0eUiOyTrWvQ";

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  definirAmbiente({});
  banco.exigirDb.mockClear();
  // O aviso de configuração sai uma vez por valor (estado do módulo): sem
  // esquecer, o teste dependia da ordem (o mesmo valor errado em dois casos).
  esquecerAvisosDasChaves();
  for (const teto of [tetoDeOpcoesDeEntrada, tetoDeEntradaComChave, tetoDeEntradaPorChave, tetoDeCadastroDeChave]) teto.esquecer();
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
    // Disponível, leva o RP ID: a tela (A7) o usa na Signal API do WebAuthn.
    expect(await estado({ host: "wrwglobal.org" })).toEqual({ disponivel: true, rpId: "wrwglobal.org" });
    expect(await estado({ host: "www.wrwglobal.org" })).toEqual({ disponivel: true, rpId: "wrwglobal.org" });
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

describe("os tetos da rota: por chamada, reservados antes do primeiro await (um lote do tRPC leva quantas chamadas quiser)", () => {
  const DO_SITE = { origin: "https://wrwglobal.org", host: "wrwglobal.org" };
  const NO_BANCO = "a função desligada não pode tocar no banco";
  const respostaDeEntrada = (id: string) => ({
    id,
    rawId: id,
    type: "public-key" as const,
    response: {
      clientDataJSON: dadosDoCliente({ type: "webauthn.get", challenge: DESAFIO, origin: "https://wrwglobal.org" }),
      authenticatorData: "AAAA",
      signature: "AAAA",
    },
    clientExtensionResults: {},
  });
  const respostaDeCadastro = () => ({
    id: "AAAA",
    rawId: "AAAA",
    type: "public-key" as const,
    response: {
      clientDataJSON: dadosDoCliente({ type: "webauthn.create", challenge: DESAFIO, origin: "https://wrwglobal.org" }),
      attestationObject: "AAAA",
    },
    clientExtensionResults: {},
  });
  /** A recusa do teto: TOO_MANY_REQUESTS com o código, que a tela traduz. */
  const ehOTeto = (resultado: PromiseSettledResult<unknown>) =>
    resultado.status === "rejected"
    && (resultado.reason as { code?: string }).code === "TOO_MANY_REQUESTS"
    && (resultado.reason as { message?: string }).message === ERRO_DA_CHAVE_DE_ACESSO.muitasTentativas;
  /** As outras chamadas chegam ao banco (o dublê lança): passaram pelo teto. */
  const chegouAoBanco = (resultado: PromiseSettledResult<unknown>) =>
    resultado.status === "rejected" && (resultado.reason as { message?: string }).message === NO_BANCO;

  beforeEach(() => definirAmbiente(PRODUCAO));

  it(`entrar: ${LOGINS_POR_REDE_E_EMAIL} com a MESMA chave por rede; a seguinte recusa sem tocar no banco, e outra chave ainda passa`, async () => {
    const entrar = (id: string) => chavesDeAcessoRouter.createCaller(contexto(DO_SITE)).entrar({ resposta: respostaDeEntrada(id) });
    const resultados = await Promise.allSettled(Array.from({ length: LOGINS_POR_REDE_E_EMAIL + 1 }, () => entrar("credencial-da-vitima")));

    expect(resultados.filter(ehOTeto)).toHaveLength(1);
    expect(resultados.filter(chegouAoBanco)).toHaveLength(LOGINS_POR_REDE_E_EMAIL);
    expect(banco.exigirDb).toHaveBeenCalledTimes(LOGINS_POR_REDE_E_EMAIL);
    await expect(entrar("outra-credencial")).rejects.toThrow(NO_BANCO);
  });

  it(`entrar: ${LOGINS_POR_REDE} por rede, com chaves diferentes; a seguinte recusa sem tocar no banco, e outra rede ainda passa`, async () => {
    const resultados = await Promise.allSettled(Array.from({ length: LOGINS_POR_REDE + 1 }, (_vazio, i) =>
      chavesDeAcessoRouter.createCaller(contexto(DO_SITE)).entrar({ resposta: respostaDeEntrada(`credencial-${i}`) })));

    expect(resultados.filter(ehOTeto)).toHaveLength(1);
    expect(banco.exigirDb).toHaveBeenCalledTimes(LOGINS_POR_REDE);
    const deOutraRede = contexto(DO_SITE, false, { ip: "198.51.100.77" });
    await expect(chavesDeAcessoRouter.createCaller(deOutraRede).entrar({ resposta: respostaDeEntrada("credencial-0") })).rejects.toThrow(NO_BANCO);
  });

  it(`opcoesDeEntrada: ${LOGINS_POR_REDE} por rede; a seguinte recusa sem tocar no banco, e outra rede ainda passa`, async () => {
    const resultados = await Promise.allSettled(Array.from({ length: LOGINS_POR_REDE + 1 }, () =>
      chavesDeAcessoRouter.createCaller(contexto(DO_SITE)).opcoesDeEntrada()));

    expect(resultados.filter(ehOTeto)).toHaveLength(1);
    expect(banco.exigirDb).toHaveBeenCalledTimes(LOGINS_POR_REDE);
    const deOutraRede = contexto(DO_SITE, false, { ip: "198.51.100.77" });
    await expect(chavesDeAcessoRouter.createCaller(deOutraRede).opcoesDeEntrada()).rejects.toThrow(NO_BANCO);
  });

  it(`opcoesDeCadastro e cadastrar: ${CADASTROS_DE_CHAVE_POR_CONTA} por conta, somados; a seguinte recusa sem tocar no banco, e outra conta ainda passa`, async () => {
    const resultados = await Promise.allSettled(Array.from({ length: CADASTROS_DE_CHAVE_POR_CONTA + 1 }, (_vazio, i) => {
      const chamar = chavesDeAcessoRouter.createCaller(contexto(DO_SITE, true));
      return i % 2 === 0 ? chamar.opcoesDeCadastro() : chamar.cadastrar({ resposta: respostaDeCadastro() });
    }));

    expect(resultados.filter(ehOTeto)).toHaveLength(1);
    expect(banco.exigirDb).toHaveBeenCalledTimes(CADASTROS_DE_CHAVE_POR_CONTA);
    const outraConta = chavesDeAcessoRouter.createCaller(contexto(DO_SITE, true, { id: 8 }));
    await expect(outraConta.opcoesDeCadastro()).rejects.toThrow(NO_BANCO);
  });
});

describe("identificadorFixoDaConta — o identificador da conta que vai para o aparelho", () => {
  const SEGREDO_ORIGINAL = process.env.JWT_SECRET;
  afterEach(() => {
    process.env.JWT_SECRET = SEGREDO_ORIGINAL;
  });

  it("o mesmo para a mesma conta (o aparelho troca a chave antiga), outro para outra conta, 32 bytes em base64url", () => {
    const sete = identificadorFixoDaConta(7);
    expect(identificadorFixoDaConta(7)).toBe(sete);
    expect(identificadorFixoDaConta(8)).not.toBe(sete);
    expect(sete).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("depende do segredo do servidor: sem ele, ninguém deriva o identificador de uma conta pelo id", () => {
    const comOSegredo = identificadorFixoDaConta(7);
    process.env.JWT_SECRET = "outro-segredo-so-para-este-teste";
    expect(identificadorFixoDaConta(7)).not.toBe(comOSegredo);
  });
});

describe("montarAvisoDeChaveCadastrada — o e-mail à dona a cada chave cadastrada", () => {
  // 13:05 em UTC é 10:05 em Brasília (sem horário de verão desde 2019).
  const QUANDO = new Date("2026-11-16T13:05:00Z");

  it("diz quando (no horário de Brasília), o apelido e o que fazer, com o link do \"Esqueci minha senha\"", () => {
    const { assunto, text, html } = montarAvisoDeChaveCadastrada({ nome: "Beatriz", apelido: "iPhone", quando: QUANDO, site: "https://wrwglobal.org/" });

    expect(assunto).toBe("Nova chave de acesso na sua conta MarquesaMatch");
    expect(text).toContain("Olá, Beatriz.");
    expect(text).toContain("16/11/2026");
    expect(text).toContain("10:05");
    expect(text).toContain('com o nome "iPhone"');
    expect(text).toContain("Se não foi você, redefina a sua senha agora");
    expect(text).toContain("https://wrwglobal.org/forgot-password");
    expect(html).toContain('href="https://wrwglobal.org/forgot-password"');
  });

  it("escapa o nome e o apelido no HTML; sem nome, \"Membro\"; sem apelido, nada de nome; sem site, sem link", () => {
    const { text, html } = montarAvisoDeChaveCadastrada({ nome: "<b>Ana</b>", apelido: "Mac <da Ana>", quando: QUANDO, site: null });
    expect(html).not.toContain("<b>Ana</b>");
    expect(html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(html).toContain("Mac &lt;da Ana&gt;");
    expect(html).not.toContain("href=");
    expect(text).toContain('Use o "Esqueci minha senha" na tela de entrada.');

    expect(montarAvisoDeChaveCadastrada({ nome: "  ", apelido: null, quando: QUANDO, site: null }).text).toContain("Olá, Membro.");
    expect(montarAvisoDeChaveCadastrada({ nome: null, apelido: null, quando: QUANDO, site: null }).text).not.toContain("com o nome");
  });
});

describe("a janela do cadastro é contada pelo relógio do banco", () => {
  it(`recente é createdAt >= NOW() - INTERVAL ${MINUTOS_PARA_CADASTRAR_CHAVE} MINUTE, sem data do Node como parâmetro`, () => {
    // O MariaDB do CI roda em UTC, e lá uma comparação com uma data do Node
    // também acertaria; num banco fora de UTC, ela erraria por horas.
    const { sql, params } = new MySqlDialect().sqlToQuery(COLUNAS_DA_SESSAO_QUE_CADASTRA.recente as unknown as SQL);
    expect(sql).toMatch(/`createdAt` >= NOW\(\) - INTERVAL \? MINUTE/);
    expect(params).toEqual([MINUTOS_PARA_CADASTRAR_CHAVE]);
  });
});
