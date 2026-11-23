import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as jose from "jose";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * Os dublês daqui são transparentes por padrão: o e-mail nunca sai (a Resend de
 * verdade não é chamada) e responde "enviado"; `recordLoginAttempt` e
 * `abrirSessao` são os de verdade, até um teste pedir a falha deles em `falhas`.
 */
const dubles = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_opcoes: { to: string; subject: string; text?: string; html: string }) => true),
}));
const falhas = vi.hoisted(() => ({
  /** O erro que `recordLoginAttempt` lança para este resultado (sucesso ou não); null segue para a de verdade. */
  tentativa: null as null | ((sucesso: boolean) => Error | null),
  /** O erro que a próxima `abrirSessao` lança, uma vez. */
  abrirSessao: null as null | Error,
}));
vi.mock("./_core/email", async importOriginal => ({
  ...(await importOriginal<typeof import("./_core/email")>()),
  sendEmail: dubles.sendEmail,
}));
vi.mock("./security", async importOriginal => {
  const original = await importOriginal<typeof import("./security")>();
  return {
    ...original,
    recordLoginAttempt: async (identificador: string, rede: string, sucesso: boolean) => {
      const erro = falhas.tentativa?.(sucesso);
      if (erro) throw erro;
      return original.recordLoginAttempt(identificador, rede, sucesso);
    },
  };
});
vi.mock("./sessao", async importOriginal => {
  const original = await importOriginal<typeof import("./sessao")>();
  return {
    ...original,
    abrirSessao: async (parametros: Parameters<typeof original.abrirSessao>[0]) => {
      const erro = falhas.abrirSessao;
      falhas.abrirSessao = null;
      if (erro) throw erro;
      return original.abrirSessao(parametros);
    },
  };
});

import bcrypt from "bcryptjs";
import { getDb } from "./db";
import {
  auditLogs,
  chavesDeAcesso,
  desafiosDeChaveDeAcesso,
  loginAttempts,
  passwordResetTokens,
  sessions,
  users,
} from "../drizzle/schema";
import {
  chavesDeAcessoRouter,
  tetoDeCadastroDeChave,
  tetoDeEntradaComChave,
  tetoDeEntradaPorChave,
  tetoDeOpcoesDeEntrada,
} from "./routers/chavesDeAcesso";
import { authRouter } from "./routers/auth";
import { abrirSessao } from "./sessao";
import { excluirConta } from "./exclusao-de-conta";
import { hashPasswordResetToken } from "./password-reset-security";
import { BancoIndisponivel } from "./banco-indisponivel";
import { identificadorFixoDaConta } from "./chaves-de-acesso";
import { criarAutenticador, type AutenticadorDeSoftware, type Desvios } from "./test/autenticador-de-software";
import { CHAVES_POR_CONTA_MAX, ERRO_DA_CHAVE_DE_ACESSO as ERRO, MINUTOS_PARA_CADASTRAR_CHAVE } from "@shared/chaves-de-acesso";
import { COOKIE_NAME, MENSAGEM_BANCO_INDISPONIVEL, UNAUTHED_ERR_MSG } from "@shared/const";
import type { TrpcContext } from "./_core/context";

/**
 * As chaves de acesso (A6) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). O aparelho é o autenticador de software de
 * server/test/autenticador-de-software.ts: um par de chaves ES256 gerado aqui,
 * que responde ao cadastro e à entrada; a conferência da @simplewebauthn/server
 * roda de verdade. O que se prova é o caminho inteiro: o desafio gasto uma vez,
 * a origem e o contador conferidos, a sessão aberta só com a transação
 * confirmada, a dona no WHERE, a auditoria na transação e as chaves apagadas
 * pela redefinição de senha e pela exclusão da conta.
 */

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const RP_ID = "wrwglobal.org";
const ORIGEM = "https://wrwglobal.org";
const IP = "203.0.113.9";
const AMBIENTE_ORIGINAL = { rpId: process.env.WEBAUTHN_RP_ID, origens: process.env.WEBAUTHN_ORIGENS };

type Conta = typeof users.$inferSelect;
const contas: Conta[] = [];
/** Os desafios de entrada (sem conta) que este arquivo criou, para a limpeza. */
const desafiosDeEntrada: string[] = [];

async function db() {
  return (await getDb())!;
}

async function criarConta(nome: string, senha?: string): Promise<Conta> {
  // openId tem até 64 caracteres.
  const openId = `tc-${nome.slice(0, 16)}-${crypto.randomUUID()}`;
  await (await db()).insert(users).values({
    openId,
    email: `${openId}@exemplo.test`,
    name: `Teste ${nome}`,
    onboardingCompleted: true,
    isActive: true,
    // Custo 4: só para o teste; o de verdade é 12.
    passwordHash: senha ? bcrypt.hashSync(senha, 4) : null,
  });
  const [conta] = await (await db()).select().from(users).where(eq(users.openId, openId)).limit(1);
  contas.push(conta);
  return conta;
}

function pedido(extra: { origem?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { "user-agent": "vitest", host: "wrwglobal.org", origin: extra.origem ?? ORIGEM };
  if (extra.cookie) headers.cookie = extra.cookie;
  return { headers, protocol: "https", ip: IP, socket: { remoteAddress: IP } };
}
const respostaHttp = () => ({ cookie: vi.fn(), clearCookie: vi.fn() });

function contextoPublico(extra: { origem?: string } = {}): TrpcContext {
  return { user: null, req: pedido(extra), res: respostaHttp() } as unknown as TrpcContext;
}

async function contextoLogado(conta: Conta, extra: { origem?: string } = {}) {
  const sessao = await abrirSessao({ usuaria: conta, ip: IP, userAgent: "vitest" });
  const ctx = { user: conta, req: pedido({ ...extra, cookie: `${COOKIE_NAME}=${sessao.token}` }), res: respostaHttp() } as unknown as TrpcContext;
  return { ctx, sessao, chamar: chavesDeAcessoRouter.createCaller(ctx) };
}

async function cadastrar(conta: Conta, autenticador: AutenticadorDeSoftware, desvios: Desvios = {}, apelido = "iPhone") {
  const { chamar } = await contextoLogado(conta);
  const opcoes = await chamar.opcoesDeCadastro();
  return chamar.cadastrar({ resposta: autenticador.criar(opcoes, desvios), apelido });
}

async function opcoesDeEntrada(ctx = contextoPublico()) {
  const opcoes = await chavesDeAcessoRouter.createCaller(ctx).opcoesDeEntrada();
  desafiosDeEntrada.push(opcoes.challenge);
  return opcoes;
}

/** Pede as opções, deixa o aparelho responder e entra; `resultado` é a promessa da entrada. */
async function entrar(autenticador: AutenticadorDeSoftware, desvios: Desvios = {}) {
  const ctx = contextoPublico();
  const resposta = autenticador.obter(await opcoesDeEntrada(), desvios);
  return { ctx, resposta, resultado: chavesDeAcessoRouter.createCaller(ctx).entrar({ resposta }) };
}

const chavesDe = async (userId: number) => (await db()).select().from(chavesDeAcesso).where(eq(chavesDeAcesso.userId, userId));
const desafiosDe = async (userId: number) =>
  (await db()).select().from(desafiosDeChaveDeAcesso).where(eq(desafiosDeChaveDeAcesso.userId, userId));
const auditoriaDe = async (userId: number, acao: string) =>
  (await db()).select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, acao)));
const sessoesAtivas = async (userId: number) =>
  (await db()).select().from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.isActive, true)));
const cookieDe = (ctx: TrpcContext) => (ctx.res as unknown as { cookie: Mock }).cookie;

/**
 * Faz o INSERT em audit_logs falhar dentro de toda transação do banco, como se
 * a auditoria caísse no meio. As outras escritas da transação são as de
 * verdade, e o MySQL as desfaz quando a transação lança.
 */
async function quebrarAAuditoria() {
  const banco = await db();
  const original = banco.transaction.bind(banco);
  return vi.spyOn(banco, "transaction").mockImplementation(((tarefa: (tx: object) => Promise<unknown>, config?: unknown) =>
    original(async tx => tarefa(new Proxy(tx, {
      get(alvo, propriedade) {
        if (propriedade === "insert") {
          return (tabela: unknown) => tabela === auditLogs
            ? { values: async () => { throw new Error("auditoria fora do ar"); } }
            : alvo.insert(tabela as typeof auditLogs);
        }
        const valor = Reflect.get(alvo, propriedade, alvo);
        return typeof valor === "function" ? valor.bind(alvo) : valor;
      },
    })), config as never)) as typeof banco.transaction);
}

/** A sessão passa a ter sido aberta há `minutos`, pelo relógio do banco (o mesmo que o cadastro lê). */
async function envelhecerSessao(sessionToken: string, minutos: number) {
  await (await db()).update(sessions).set({ createdAt: sql`NOW() - INTERVAL ${minutos} MINUTE` }).where(eq(sessions.sessionToken, sessionToken));
}

/**
 * Roda `antes` logo antes da PRÓXIMA transação do banco, e só dela: o que
 * acontece no meio de uma entrada, entre a conferência e a transação (outra
 * entrada com a mesma chave, a chave removida, a conta desativada ou excluída).
 */
async function noMeioDaProximaTransacao(antes: () => Promise<unknown>) {
  const banco = await db();
  const original = banco.transaction.bind(banco);
  return vi.spyOn(banco, "transaction").mockImplementationOnce(((tarefa: never, config?: never) =>
    antes().then(() => original(tarefa, config))) as unknown as typeof banco.transaction);
}

/**
 * Espera, com prazo, o cadastro parar na trava da linha da sessão (o SELECT ...
 * FOR UPDATE de cadastrarChave). A leitura de uma linha pela chave única leva
 * menos de um milissegundo: o comando parado há um segundo ou mais está
 * esperando a trava. A espera se vê em information_schema.PROCESSLIST, e não em
 * INNODB_TRX: no MariaDB ela acontece na otimização (estado "Statistics"),
 * antes de a transação aparecer lá.
 */
async function esperarOCadastroNaTravaDaSessao() {
  const banco = await db();
  const prazo = Date.now() + 10_000;
  while (Date.now() < prazo) {
    const [linhas] = (await banco.execute(sql`
      SELECT COUNT(*) AS esperando FROM information_schema.PROCESSLIST
      WHERE ID <> CONNECTION_ID() AND COMMAND IN ('Query', 'Execute') AND TIME >= 1
        AND INFO LIKE ${"%from `sessions`%for update%"}`)) as unknown as [Array<{ esperando: number | string }>, unknown];
    if (Number(linhas[0]?.esperando ?? 0) > 0) return;
    await new Promise(resolver => setTimeout(resolver, 50));
  }
  throw new Error("o cadastro não parou na trava da linha da sessão: o SELECT dela perdeu o FOR UPDATE?");
}

describe.skipIf(!temBanco)("Chaves de acesso no banco (integração)", () => {
  beforeAll(() => {
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGENS = "https://wrwglobal.org,https://www.wrwglobal.org";
  });

  afterAll(async () => {
    if (AMBIENTE_ORIGINAL.rpId === undefined) delete process.env.WEBAUTHN_RP_ID;
    else process.env.WEBAUTHN_RP_ID = AMBIENTE_ORIGINAL.rpId;
    if (AMBIENTE_ORIGINAL.origens === undefined) delete process.env.WEBAUTHN_ORIGENS;
    else process.env.WEBAUTHN_ORIGENS = AMBIENTE_ORIGINAL.origens;
    if (!(await getDb())) return;
    const banco = await db();
    const ids = contas.map(conta => conta.id);
    const emails = contas.map(conta => conta.email!.toLowerCase());
    if (ids.length) {
      await apagarPelaChave(banco, chavesDeAcesso, inArray(chavesDeAcesso.userId, ids));
      await apagarPelaChave(banco, desafiosDeChaveDeAcesso, inArray(desafiosDeChaveDeAcesso.userId, ids));
      await apagarPelaChave(banco, sessions, inArray(sessions.userId, ids));
      await apagarPelaChave(banco, auditLogs, inArray(auditLogs.userId, ids));
      await apagarPelaChave(banco, passwordResetTokens, inArray(passwordResetTokens.userId, ids));
      await apagarPelaChave(banco, loginAttempts, inArray(loginAttempts.identifier, emails));
      await banco.delete(users).where(inArray(users.id, ids));
    }
    if (desafiosDeEntrada.length) {
      await apagarPelaChave(banco, desafiosDeChaveDeAcesso, inArray(desafiosDeChaveDeAcesso.desafio, desafiosDeEntrada));
    }
  });

  beforeEach(() => {
    for (const teto of [tetoDeOpcoesDeEntrada, tetoDeEntradaComChave, tetoDeEntradaPorChave, tetoDeCadastroDeChave]) teto.esquecer();
    falhas.tentativa = null;
    falhas.abrirSessao = null;
    dubles.sendEmail.mockClear();
    // As recusas e a abertura da sessão escrevem no log; aqui elas são esperadas.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cadastro e entrada: a chave fica gravada com a auditoria; a entrada abre a sessão, anda o contador e audita", async () => {
    const conta = await criarConta("feliz");
    const autenticador = criarAutenticador({ origem: ORIGEM, contadorInicial: 0, sincronizada: true });

    const chave = await cadastrar(conta, autenticador);
    expect(chave).toMatchObject({
      apelido: "iPhone",
      tipoDoAparelho: "multiDevice",
      sincronizada: true,
      transportes: ["internal", "hybrid"],
      aaguid: "00000000-0000-0000-0000-000000000000",
      ultimoUsoEm: null,
    });
    const [gravada] = await chavesDe(conta.id);
    expect(gravada).toMatchObject({
      id: chave.id,
      credencialId: autenticador.credencialId,
      contador: 0,
      identificadorDaUsuaria: autenticador.identificadorDaConta,
    });
    expect(gravada.chavePublica.length).toBeGreaterThan(50);
    // O identificador da conta no aparelho não é o id nem o e-mail: é o HMAC do id
    // (32 bytes em base64url). Um dígito do id pode aparecer nele por acaso (com o
    // id 8, o banco do zero do CI dá "…cm8g…"), então a prova é o formato e a
    // igualdade, e não a substring.
    expect(gravada.identificadorDaUsuaria).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gravada.identificadorDaUsuaria).not.toBe(String(conta.id));
    expect(gravada.identificadorDaUsuaria).not.toContain(conta.email!);
    expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toMatchObject([{
      resource: "auth",
      resourceId: chave.id,
      details: { tipoDoAparelho: "multiDevice", sincronizada: true },
      ipAddress: IP,
      userAgent: "vitest",
      status: "success",
      riskLevel: "medium",
    }]);

    const ativasAntes = (await sessoesAtivas(conta.id)).length;
    const { ctx, resultado } = await entrar(autenticador);
    await expect(resultado).resolves.toEqual({
      success: true,
      user: { id: conta.id, name: conta.name, email: conta.email, role: conta.role, onboardingCompleted: true },
    });

    // O cookie leva o token da sessão nova, viva no banco.
    expect(cookieDe(ctx)).toHaveBeenCalledTimes(1);
    const [nome, token] = cookieDe(ctx).mock.calls[0] as [string, string];
    expect(nome).toBe(COOKIE_NAME);
    const { sessionToken, openId } = jose.decodeJwt(token) as { sessionToken: string; openId: string };
    expect(openId).toBe(conta.openId);
    const [sessao] = await (await db()).select().from(sessions).where(eq(sessions.sessionToken, sessionToken));
    expect(sessao).toMatchObject({ userId: conta.id, isActive: true, ipAddress: IP });
    expect(await sessoesAtivas(conta.id)).toHaveLength(ativasAntes + 1);

    const [usada] = await chavesDe(conta.id);
    expect(usada.contador).toBe(1);
    expect(usada.ultimoUsoEm).toBeGreaterThan(0);
    expect(await auditoriaDe(conta.id, "LOGIN")).toMatchObject([{
      resourceId: chave.id,
      details: { metodo: "chave_de_acesso" },
      ipAddress: IP,
      riskLevel: "low",
    }]);

    // A lista da dona não leva a chave pública. Leva o id da credencial e o
    // identificador da conta, que as opções de cadastro já mandam à dona: com
    // eles a tela avisa o aparelho da chave removida (a Signal API).
    const { chamar } = await contextoLogado(conta);
    const lista = await chamar.listar();
    expect(lista).toEqual([{ ...chave, ultimoUsoEm: usada.ultimoUsoEm }]);
    expect(lista[0]).toMatchObject({ credencialId: autenticador.credencialId, identificadorDaConta: autenticador.identificadorDaConta });
    expect(JSON.stringify(lista)).not.toContain(gravada.chavePublica);
  });

  it("as opções do cadastro trazem as chaves que a conta já tem e o mesmo identificador; a mesma chave não entra duas vezes", async () => {
    const conta = await criarConta("repetida");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);

    const { chamar } = await contextoLogado(conta);
    const opcoes = await chamar.opcoesDeCadastro();
    expect(opcoes.excludeCredentials?.map(c => c.id)).toEqual([autenticador.credencialId]);
    expect(opcoes.user.id).toBe(autenticador.identificadorDaConta);
    expect(opcoes.rp).toEqual({ name: "WRW", id: RP_ID });
    expect(opcoes.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });

    await expect(chamar.cadastrar({ resposta: autenticador.criar(opcoes) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: ERRO.jaCadastrada,
    });
    expect(await chavesDe(conta.id)).toHaveLength(1);
    expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toHaveLength(1);
  });

  it("o desafio é de uso único: a mesma resposta duas vezes, em sequência ou ao mesmo tempo, entra uma vez só", async () => {
    const conta = await criarConta("reuso");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);

    const { resposta, resultado } = await entrar(autenticador);
    await expect(resultado).resolves.toMatchObject({ success: true });
    const ativas = (await sessoesAtivas(conta.id)).length;
    await expect(chavesDeAcessoRouter.createCaller(contextoPublico()).entrar({ resposta })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });
    expect(await sessoesAtivas(conta.id)).toHaveLength(ativas);

    const outra = autenticador.obter(await opcoesDeEntrada());
    const juntas = await Promise.allSettled([1, 2].map(() => chavesDeAcessoRouter.createCaller(contextoPublico()).entrar({ resposta: outra })));
    expect(juntas.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(juntas.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason)).toMatchObject([
      { code: "BAD_REQUEST", message: ERRO.desafioInvalido },
    ]);
    expect(await sessoesAtivas(conta.id)).toHaveLength(ativas + 1);
  });

  it("o desafio vencido é recusado, na entrada e no cadastro", async () => {
    const conta = await criarConta("vencido");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);
    const vencer = async (desafio: string) =>
      (await db()).update(desafiosDeChaveDeAcesso).set({ expiraEm: Date.now() - 1 }).where(eq(desafiosDeChaveDeAcesso.desafio, desafio));

    const opcoes = await opcoesDeEntrada();
    await vencer(opcoes.challenge);
    await expect(chavesDeAcessoRouter.createCaller(contextoPublico()).entrar({ resposta: autenticador.obter(opcoes) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });

    const { chamar } = await contextoLogado(conta);
    const opcoesDoCadastro = await chamar.opcoesDeCadastro();
    await vencer(opcoesDoCadastro.challenge);
    await expect(chamar.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoesDoCadastro) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });
    expect(await chavesDe(conta.id)).toHaveLength(1);
  });

  it("o desafio de outra finalidade, ou de outra conta, é recusado", async () => {
    const ana = await criarConta("finalidade-ana");
    const bia = await criarConta("finalidade-bia");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(ana, autenticador);
    const { chamar: comoAna } = await contextoLogado(ana);
    const { chamar: comoBia } = await contextoLogado(bia);

    // O desafio de cadastro assinado numa entrada.
    const doCadastro = await comoAna.opcoesDeCadastro();
    const entrada = autenticador.obter(await opcoesDeEntrada(), { desafio: doCadastro.challenge });
    await expect(chavesDeAcessoRouter.createCaller(contextoPublico()).entrar({ resposta: entrada })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });

    // O desafio de entrada assinado num cadastro.
    const daEntrada = await opcoesDeEntrada();
    const novo = criarAutenticador({ origem: ORIGEM });
    await expect(comoAna.cadastrar({ resposta: novo.criar(await comoAna.opcoesDeCadastro(), { desafio: daEntrada.challenge }) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });

    // O desafio de cadastro da Ana, usado pela Bia.
    const daAna = await comoAna.opcoesDeCadastro();
    await expect(comoBia.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(daAna) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: ERRO.desafioInvalido,
    });
    expect(await chavesDe(bia.id)).toEqual([]);
    expect(await chavesDe(ana.id)).toHaveLength(1);
  });

  it("a origem fora da lista é recusada: na resposta assinada, no domínio da chave e no pedido", async () => {
    const conta = await criarConta("origem");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);
    const ativas = (await sessoesAtivas(conta.id)).length;

    for (const desvio of [{ origem: "https://wrwglobal.org.golpe.example" }, { origem: "https://mmm-gud5.onrender.com" }, { rpId: "golpe.example" }]) {
      const { ctx, resultado } = await entrar(autenticador, desvio);
      await expect(resultado).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.recusada });
      expect(cookieDe(ctx)).not.toHaveBeenCalled();
    }
    expect(await sessoesAtivas(conta.id)).toHaveLength(ativas);
    // Cada recusa conta como tentativa errada no mesmo balde do login por senha.
    const [tentativas] = await (await db()).select().from(loginAttempts).where(eq(loginAttempts.identifier, conta.email!.toLowerCase()));
    expect(tentativas).toMatchObject({ ipAddress: IP, attemptCount: 3 });

    // No cadastro, a origem assinada de fora também é recusada.
    await expect(cadastrar(conta, criarAutenticador({ origem: ORIGEM }), { origem: "https://golpe.example" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: ERRO.recusada,
    });
    expect(await chavesDe(conta.id)).toHaveLength(1);

    // O pedido vindo do .onrender.com nem chega: a função não existe lá.
    const onrender = contextoPublico({ origem: "https://mmm-gud5.onrender.com" });
    await expect(chavesDeAcessoRouter.createCaller(onrender).opcoesDeEntrada()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: ERRO.indisponivel,
    });
    expect(await chavesDeAcessoRouter.createCaller(onrender).estado()).toEqual({ disponivel: false });
  });

  it("o contador que volta, ou que não anda, é recusado, e o gravado não muda", async () => {
    const conta = await criarConta("contador");
    const autenticador = criarAutenticador({ origem: ORIGEM, contadorInicial: 4 });
    await cadastrar(conta, autenticador);
    expect((await chavesDe(conta.id))[0].contador).toBe(4);

    await expect((await entrar(autenticador)).resultado).resolves.toMatchObject({ success: true });
    expect((await chavesDe(conta.id))[0].contador).toBe(5);
    const ativas = (await sessoesAtivas(conta.id)).length;

    for (const contador of [5, 3, 0]) {
      const { ctx, resultado } = await entrar(autenticador, { contador });
      await expect(resultado, `contador ${contador}`).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.recusada });
      expect(cookieDe(ctx)).not.toHaveBeenCalled();
    }
    expect((await chavesDe(conta.id))[0].contador).toBe(5);
    expect(await sessoesAtivas(conta.id)).toHaveLength(ativas);
    expect(await auditoriaDe(conta.id, "LOGIN")).toHaveLength(1);

    // O seguinte de verdade entra.
    await expect((await entrar(autenticador)).resultado).resolves.toMatchObject({ success: true });
    expect((await chavesDe(conta.id))[0].contador).toBe(6);
  });

  it("a pessoa não verificada pelo aparelho, ou o identificador de outra conta, é recusado", async () => {
    const conta = await criarConta("verificacao");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);

    for (const desvio of [{ semVerificarAPessoa: true }, { identificadorDaConta: "b3V0cmEtY29udGEtcXVhbHF1ZXI" }]) {
      const { resultado } = await entrar(autenticador, desvio);
      await expect(resultado).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.recusada });
    }
    // Sem o identificador (o aparelho não é obrigado a mandar), entra.
    await expect((await entrar(autenticador, { identificadorDaConta: null })).resultado).resolves.toMatchObject({ success: true });
    // No cadastro, a pessoa também tem de ser verificada.
    await expect(cadastrar(conta, criarAutenticador({ origem: ORIGEM }), { semVerificarAPessoa: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: ERRO.recusada,
    });
  });

  it("a chave que nenhuma conta tem é CHAVE_DESCONHECIDA", async () => {
    const { ctx, resultado } = await entrar(criarAutenticador({ origem: ORIGEM }));
    await expect(resultado).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.desconhecida });
    expect(cookieDe(ctx)).not.toHaveBeenCalled();
  });

  it("as checagens do login por senha: conta desativada e conta bloqueada por tentativas não entram", async () => {
    const desativada = await criarConta("desativada");
    const daDesativada = criarAutenticador({ origem: ORIGEM });
    await cadastrar(desativada, daDesativada);
    await (await db()).update(users).set({ isActive: false }).where(eq(users.id, desativada.id));
    const ativasDaDesativada = (await sessoesAtivas(desativada.id)).length;
    const recusada = await entrar(daDesativada);
    await expect(recusada.resultado).rejects.toMatchObject({ code: "FORBIDDEN", message: ERRO.contaDesativada });
    expect(cookieDe(recusada.ctx)).not.toHaveBeenCalled();
    expect(await sessoesAtivas(desativada.id)).toHaveLength(ativasDaDesativada);

    const bloqueada = await criarConta("bloqueada");
    const daBloqueada = criarAutenticador({ origem: ORIGEM });
    await cadastrar(bloqueada, daBloqueada);
    await (await db()).insert(loginAttempts).values({
      identifier: bloqueada.email!.toLowerCase(),
      ipAddress: IP,
      success: false,
      attemptCount: 5,
      blockedUntil: new Date(Date.now() + 30 * 60_000),
    });
    await expect((await entrar(daBloqueada)).resultado).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: ERRO.muitasTentativas });
  });

  it("a entrada certa zera as tentativas erradas da conta nesta rede, como o login por senha", async () => {
    const conta = await criarConta("zera");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);
    const tentativas = async () =>
      (await db()).select().from(loginAttempts).where(eq(loginAttempts.identifier, conta.email!.toLowerCase()));

    await expect((await entrar(autenticador, { origem: "https://golpe.example" })).resultado).rejects.toMatchObject({ message: ERRO.recusada });
    expect(await tentativas()).toMatchObject([{ attemptCount: 1 }]);
    await expect((await entrar(autenticador)).resultado).resolves.toMatchObject({ success: true });
    expect(await tentativas()).toEqual([]);
  });

  it("a chave de outra usuária não se lista, não se renomeia nem se remove; a dona renomeia e remove, com auditoria", async () => {
    const dona = await criarConta("dona");
    const outra = await criarConta("outra");
    const chave = await cadastrar(dona, criarAutenticador({ origem: ORIGEM }));

    const { chamar: comoOutra } = await contextoLogado(outra);
    await expect(comoOutra.renomear({ id: chave.id, apelido: "Meu agora" })).rejects.toMatchObject({ code: "NOT_FOUND", message: ERRO.naoEncontrada });
    await expect(comoOutra.remover({ id: chave.id })).rejects.toMatchObject({ code: "NOT_FOUND", message: ERRO.naoEncontrada });
    expect(await comoOutra.listar()).toEqual([]);
    expect(await chavesDe(dona.id)).toMatchObject([{ id: chave.id, apelido: "iPhone" }]);
    expect(await auditoriaDe(outra.id, "PASSKEY_REMOVED")).toEqual([]);
    expect(await auditoriaDe(dona.id, "PASSKEY_REMOVED")).toEqual([]);

    const { chamar: comoDona } = await contextoLogado(dona);
    await expect(comoDona.renomear({ id: chave.id, apelido: "  Mac \n da\tdona  " })).resolves.toEqual({ success: true });
    expect((await chavesDe(dona.id))[0].apelido).toBe("Mac da dona");
    await expect(comoDona.renomear({ id: chave.id, apelido: "   " })).resolves.toEqual({ success: true });
    expect((await chavesDe(dona.id))[0].apelido).toBeNull();
    await expect(comoDona.remover({ id: chave.id })).resolves.toEqual({ success: true });
    expect(await chavesDe(dona.id)).toEqual([]);
    expect(await auditoriaDe(dona.id, "PASSKEY_REMOVED")).toMatchObject([{ resourceId: chave.id, details: { motivo: "dona" }, riskLevel: "medium" }]);
    await expect(comoDona.remover({ id: chave.id })).rejects.toMatchObject({ code: "NOT_FOUND", message: ERRO.naoEncontrada });
  });

  it("a conta tem no máximo CHAVES_POR_CONTA_MAX chaves", async () => {
    const conta = await criarConta("limite");
    const { chamar } = await contextoLogado(conta);
    for (let i = 0; i < CHAVES_POR_CONTA_MAX; i++) {
      const opcoes = await chamar.opcoesDeCadastro();
      await chamar.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoes) });
    }
    expect(await chavesDe(conta.id)).toHaveLength(CHAVES_POR_CONTA_MAX);
    await expect(chamar.opcoesDeCadastro()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: ERRO.limiteDaConta });
  });

  it("o cadastro com a sessão derrubada no meio é recusado e não grava a chave", async () => {
    const conta = await criarConta("sessao-caiu");
    const { chamar, sessao } = await contextoLogado(conta);
    const opcoes = await chamar.opcoesDeCadastro();
    await (await db()).update(sessions).set({ isActive: false }).where(eq(sessions.sessionToken, sessao.sessionToken));

    await expect(chamar.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoes) })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: UNAUTHED_ERR_MSG,
    });
    expect(await chavesDe(conta.id)).toEqual([]);
    expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toEqual([]);
  });

  it("redefinir a senha apaga as chaves e os desafios da conta (e só dela), com auditoria, e a chave apagada não entra mais", async () => {
    const conta = await criarConta("reset");
    const outra = await criarConta("reset-outra");
    const autenticador = criarAutenticador({ origem: ORIGEM });
    await cadastrar(conta, autenticador);
    await cadastrar(conta, criarAutenticador({ origem: ORIGEM }), {}, "Notebook");
    await cadastrar(outra, criarAutenticador({ origem: ORIGEM }));
    const { chamar } = await contextoLogado(conta);
    await chamar.opcoesDeCadastro(); // um cadastro pela metade
    expect(await desafiosDe(conta.id)).not.toEqual([]);

    const bruto = crypto.randomBytes(48).toString("hex");
    await (await db()).insert(passwordResetTokens).values({
      userId: conta.id,
      token: hashPasswordResetToken(bruto),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(authRouter.createCaller(contextoPublico()).resetPassword({ token: bruto, newPassword: "senha-nova-123" })).resolves.toEqual({ success: true });

    expect(await chavesDe(conta.id)).toEqual([]);
    expect(await desafiosDe(conta.id)).toEqual([]);
    expect(await chavesDe(outra.id)).toHaveLength(1);
    expect(await sessoesAtivas(conta.id)).toEqual([]);
    expect(await auditoriaDe(conta.id, "PASSKEY_REMOVED")).toMatchObject([{
      resourceId: null,
      details: { motivo: "redefinicao_de_senha", quantidade: 2 },
      ipAddress: IP,
      riskLevel: "medium",
    }]);

    const { ctx, resultado } = await entrar(autenticador);
    await expect(resultado).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.desconhecida });
    expect(cookieDe(ctx)).not.toHaveBeenCalled();
  });

  it("a exclusão da conta apaga as chaves e os desafios dela", async () => {
    const conta = await criarConta("exclusao");
    await cadastrar(conta, criarAutenticador({ origem: ORIGEM }));
    const { chamar } = await contextoLogado(conta);
    await chamar.opcoesDeCadastro();
    expect(await desafiosDe(conta.id)).not.toEqual([]);

    const relatorio = await excluirConta(await db(), { id: conta.id, openId: conta.openId, email: conta.email }, { apagarArquivo: async () => {} });

    expect(relatorio.passos.map(passo => passo.nome)).toEqual(expect.arrayContaining([
      "chaves_de_acesso.userId",
      "desafios_de_chave_de_acesso.userId",
      "users.id + users.openId",
    ]));
    expect(await chavesDe(conta.id)).toEqual([]);
    expect(await desafiosDe(conta.id)).toEqual([]);
    expect(await (await db()).select().from(users).where(eq(users.id, conta.id))).toEqual([]);
  });

  describe("a auditoria vai na transação: se ela falha, nada é gravado", () => {
    it("cadastrar: a chave não fica", async () => {
      const conta = await criarConta("auditoria-cadastro");
      const { chamar } = await contextoLogado(conta);
      const opcoes = await chamar.opcoesDeCadastro();
      const autenticador = criarAutenticador({ origem: ORIGEM });
      const espiao = await quebrarAAuditoria();
      await expect(chamar.cadastrar({ resposta: autenticador.criar(opcoes) })).rejects.toThrow();
      expect(espiao).toHaveBeenCalled();
      espiao.mockRestore();
      expect(await chavesDe(conta.id)).toEqual([]);
      expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toEqual([]);
    });

    it("remover: a chave continua lá", async () => {
      const conta = await criarConta("auditoria-remocao");
      const chave = await cadastrar(conta, criarAutenticador({ origem: ORIGEM }));
      const { chamar } = await contextoLogado(conta);
      const espiao = await quebrarAAuditoria();
      await expect(chamar.remover({ id: chave.id })).rejects.toThrow();
      espiao.mockRestore();
      expect(await chavesDe(conta.id)).toMatchObject([{ id: chave.id }]);
      expect(await auditoriaDe(conta.id, "PASSKEY_REMOVED")).toEqual([]);
    });

    it("entrar: a sessão aberta é derrubada, o cookie não sai e o contador não anda", async () => {
      const conta = await criarConta("auditoria-entrada");
      const autenticador = criarAutenticador({ origem: ORIGEM, contadorInicial: 0 });
      await cadastrar(conta, autenticador);
      const todasAsSessoes = async () => (await db()).select().from(sessions).where(eq(sessions.userId, conta.id));
      const totalAntes = (await todasAsSessoes()).length;
      const ativasAntes = (await sessoesAtivas(conta.id)).length;
      const ctx = contextoPublico();
      const resposta = autenticador.obter(await opcoesDeEntrada());

      const espiao = await quebrarAAuditoria();
      await expect(chavesDeAcessoRouter.createCaller(ctx).entrar({ resposta })).rejects.toThrow();
      expect(espiao).toHaveBeenCalled();
      espiao.mockRestore();

      expect(cookieDe(ctx)).not.toHaveBeenCalled();
      expect((await chavesDe(conta.id))[0].contador).toBe(0);
      // A sessão chegou a ser gravada (abrirSessao vem antes da transação) e caiu.
      expect(await todasAsSessoes()).toHaveLength(totalAntes + 1);
      expect(await sessoesAtivas(conta.id)).toHaveLength(ativasAntes);
      expect(await auditoriaDe(conta.id, "LOGIN")).toEqual([]);
    });
  });

  describe("cadastrar pede entrada recente: uma sessão alheia não vira credencial", () => {
    it(`a sessão aberta há mais de ${MINUTOS_PARA_CADASTRAR_CHAVE} minutos não pede as opções: CHAVE_REAUTENTICAR antes do Face ID`, async () => {
      const conta = await criarConta("antiga-opcoes");
      const { chamar, sessao } = await contextoLogado(conta);
      await envelhecerSessao(sessao.sessionToken, MINUTOS_PARA_CADASTRAR_CHAVE + 1);

      await expect(chamar.opcoesDeCadastro()).rejects.toMatchObject({ code: "UNAUTHORIZED", message: ERRO.reautenticar });
      // Nenhum desafio gravado: sem ele, nada a assinar.
      expect(await desafiosDe(conta.id)).toEqual([]);
      // A sessão continua valendo para o resto (a recusa não é "saia da conta").
      expect(await sessoesAtivas(conta.id)).toHaveLength(1);
    });

    it("a sessão que passou da janela entre as opções e o cadastro: o cadastro recusa, sem chave, sem auditoria e sem e-mail", async () => {
      const conta = await criarConta("antiga-cadastro");
      const { chamar, sessao } = await contextoLogado(conta);
      const opcoes = await chamar.opcoesDeCadastro();
      await envelhecerSessao(sessao.sessionToken, MINUTOS_PARA_CADASTRAR_CHAVE + 1);

      await expect(chamar.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoes) })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: ERRO.reautenticar,
      });
      expect(await chavesDe(conta.id)).toEqual([]);
      expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toEqual([]);
      expect(dubles.sendEmail).not.toHaveBeenCalled();
    });

    it(`a sessão aberta há ${MINUTOS_PARA_CADASTRAR_CHAVE - 1} minutos ainda cadastra (o convite depois do login cabe na janela)`, async () => {
      const conta = await criarConta("quase-antiga");
      const { chamar, sessao } = await contextoLogado(conta);
      await envelhecerSessao(sessao.sessionToken, MINUTOS_PARA_CADASTRAR_CHAVE - 1);

      const opcoes = await chamar.opcoesDeCadastro();
      await expect(chamar.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoes) })).resolves.toMatchObject({ apelido: null });
      expect(await chavesDe(conta.id)).toHaveLength(1);
    });

    it("entrar de novo com a senha (auth.login) abre uma sessão nova, e ela cadastra", async () => {
      const senha = "senha-da-dona-123";
      const conta = await criarConta("reentrar", senha);
      const { chamar: comAntiga, sessao } = await contextoLogado(conta);
      await envelhecerSessao(sessao.sessionToken, 60);
      await expect(comAntiga.opcoesDeCadastro()).rejects.toMatchObject({ message: ERRO.reautenticar });

      // A tela pede a senha e entra de novo; o cookie novo leva a sessão nova.
      const doLogin = contextoPublico();
      await authRouter.createCaller(doLogin).login({ email: conta.email!, password: senha });
      const [, token] = cookieDe(doLogin).mock.calls[0] as [string, string];
      const ctx = { user: conta, req: pedido({ cookie: `${COOKIE_NAME}=${token}` }), res: respostaHttp() } as unknown as TrpcContext;
      const comNova = chavesDeAcessoRouter.createCaller(ctx);

      const opcoes = await comNova.opcoesDeCadastro();
      await expect(comNova.cadastrar({ resposta: criarAutenticador({ origem: ORIGEM }).criar(opcoes), apelido: "Celular" })).resolves.toMatchObject({ apelido: "Celular" });
      expect(await chavesDe(conta.id)).toHaveLength(1);
      // A sessão antiga continua antiga: com ela, ainda não.
      await expect(comAntiga.opcoesDeCadastro()).rejects.toMatchObject({ message: ERRO.reautenticar });
    });

    it("cada chave cadastrada manda um e-mail à dona; a Resend que falha não desfaz o cadastro e o log não leva o e-mail", async () => {
      const conta = await criarConta("aviso");
      await cadastrar(conta, criarAutenticador({ origem: ORIGEM }), {}, "iPhone da dona");

      expect(dubles.sendEmail).toHaveBeenCalledTimes(1);
      const [aviso] = dubles.sendEmail.mock.calls[0];
      expect(aviso).toMatchObject({ to: conta.email, subject: "Nova chave de acesso na sua conta WRW" });
      expect(aviso.text).toContain(`Olá, ${conta.name}.`);
      expect(aviso.text).toContain('com o nome "iPhone da dona"');
      expect(aviso.text).toContain("redefina a sua senha");

      const erros = vi.spyOn(console, "error").mockImplementation(() => {});
      dubles.sendEmail.mockRejectedValueOnce(new Error("Resend fora do ar"));
      await expect(cadastrar(conta, criarAutenticador({ origem: ORIGEM }), {}, "Notebook")).resolves.toMatchObject({ apelido: "Notebook" });
      expect(await chavesDe(conta.id)).toHaveLength(2);
      await vi.waitFor(() => expect(erros).toHaveBeenCalledWith(expect.stringContaining(`(userId ${conta.id})`), "Resend fora do ar"));
      expect(JSON.stringify(erros.mock.calls)).not.toContain(conta.email!);
    });
  });

  describe("a assinatura que não confere (a única falha que a biblioteca devolve sem lançar)", () => {
    it.each([
      ["a assinatura de outra chave, com o id da credencial da vítima", "intruso"],
      ["os dados do autenticador trocados depois de assinar", "adulterada"],
    ] as const)("%s: recusada, sem sessão, sem LOGIN, o contador parado e a tentativa contada", async (_caso, tipo) => {
      const conta = await criarConta(`assinatura-${tipo}`);
      const vitima = criarAutenticador({ origem: ORIGEM, contadorInicial: 0 });
      await cadastrar(conta, vitima);
      const ativas = (await sessoesAtivas(conta.id)).length;
      const ctx = contextoPublico();
      const opcoes = await opcoesDeEntrada();

      let resposta;
      if (tipo === "intruso") {
        const intruso = criarAutenticador({ origem: ORIGEM, contadorInicial: 0 });
        resposta = { ...intruso.obter(opcoes), id: vitima.credencialId, rawId: vitima.credencialId };
        // Quem nunca cadastrou não manda o identificador da conta: passa por
        // essa conferência e chega à da assinatura, com o contador subindo.
        expect(resposta.response.userHandle).toBeUndefined();
      } else {
        resposta = vitima.obter(opcoes, { adulterarDepoisDeAssinar: true });
      }

      await expect(chavesDeAcessoRouter.createCaller(ctx).entrar({ resposta })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: ERRO.recusada,
      });
      // A recusa veio da conferência da assinatura, e não de uma exceção da biblioteca.
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a assinatura não confere"));
      expect(cookieDe(ctx)).not.toHaveBeenCalled();
      expect(await sessoesAtivas(conta.id)).toHaveLength(ativas);
      expect((await chavesDe(conta.id))[0]).toMatchObject({ contador: 0, ultimoUsoEm: null });
      expect(await auditoriaDe(conta.id, "LOGIN")).toEqual([]);
      const [tentativas] = await (await db()).select().from(loginAttempts).where(eq(loginAttempts.identifier, conta.email!.toLowerCase()));
      expect(tentativas).toMatchObject({ attemptCount: 1 });
    });
  });

  describe("as recusas de dentro da transação da entrada (o que muda entre a conferência e a gravação)", () => {
    it.each([
      ["outra entrada com a mesma chave chegou antes (o contador já andou)", "concorrente", "UNAUTHORIZED", ERRO.recusada],
      ["a chave foi removida", "removida", "UNAUTHORIZED", ERRO.recusada],
      ["a conta foi desativada", "desativada", "FORBIDDEN", ERRO.contaDesativada],
      ["a conta foi excluída", "excluida", "UNAUTHORIZED", ERRO.desconhecida],
    ] as const)("%s: recusada; a sessão aberta cai, sem cookie e sem LOGIN", async (_caso, tipo, codigo, mensagem) => {
      const conta = await criarConta(`no-meio-${tipo}`);
      const autenticador = criarAutenticador({ origem: ORIGEM, contadorInicial: 4 });
      const chave = await cadastrar(conta, autenticador);
      const todasAsSessoes = async () => (await db()).select().from(sessions).where(eq(sessions.userId, conta.id));
      const totalAntes = (await todasAsSessoes()).length;
      const ativasAntes = (await sessoesAtivas(conta.id)).length;
      const ctx = contextoPublico();
      // O aparelho assina o contador 5.
      const resposta = autenticador.obter(await opcoesDeEntrada());

      const banco = await db();
      const espiao = await noMeioDaProximaTransacao(async () => {
        if (tipo === "concorrente") await banco.update(chavesDeAcesso).set({ contador: 5 }).where(eq(chavesDeAcesso.id, chave.id));
        if (tipo === "removida") await banco.delete(chavesDeAcesso).where(eq(chavesDeAcesso.id, chave.id));
        if (tipo === "desativada") await banco.update(users).set({ isActive: false }).where(eq(users.id, conta.id));
        if (tipo === "excluida") await banco.delete(users).where(eq(users.id, conta.id));
      });
      await expect(chavesDeAcessoRouter.createCaller(ctx).entrar({ resposta })).rejects.toMatchObject({ code: codigo, message: mensagem });
      expect(espiao).toHaveBeenCalledTimes(1);

      expect(cookieDe(ctx)).not.toHaveBeenCalled();
      // A sessão chegou a ser gravada (abrirSessao vem antes da transação) e caiu.
      expect(await todasAsSessoes()).toHaveLength(totalAntes + 1);
      expect(await sessoesAtivas(conta.id)).toHaveLength(ativasAntes);
      expect(await auditoriaDe(conta.id, "LOGIN")).toEqual([]);
      if (tipo === "concorrente") expect((await chavesDe(conta.id))[0]).toMatchObject({ contador: 5, ultimoUsoEm: null });
    });
  });

  it("o cadastro espera a transação que derruba as sessões (a trava da linha da sessão) e, depois dela, é recusado", async () => {
    const conta = await criarConta("trava");
    const { chamar } = await contextoLogado(conta);
    const resposta = criarAutenticador({ origem: ORIGEM }).criar(await chamar.opcoesDeCadastro());

    let cadastro: Promise<unknown> | undefined;
    await (await db()).transaction(async tx => {
      // A redefinição da senha, parada no meio: as sessões caíram, sem confirmar.
      await tx.update(sessions).set({ isActive: false }).where(eq(sessions.userId, conta.id));
      cadastro = chamar.cadastrar({ resposta });
      cadastro.catch(() => {});
      // Sem o FOR UPDATE, o cadastro leria a sessão ainda ativa (a versão
      // confirmada), gravaria a chave sem esperar, e o prazo acabaria aqui.
      await esperarOCadastroNaTravaDaSessao();
    });

    await expect(cadastro).rejects.toMatchObject({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    expect(await chavesDe(conta.id)).toEqual([]);
    expect(await auditoriaDe(conta.id, "PASSKEY_REGISTERED")).toEqual([]);
  }, 20_000);

  it("o identificador da conta no aparelho é fixo: a conta que ficou sem chaves recebe o mesmo (o aparelho troca a chave antiga)", async () => {
    const conta = await criarConta("identificador");
    const primeiro = criarAutenticador({ origem: ORIGEM });
    const chave = await cadastrar(conta, primeiro);
    expect(primeiro.identificadorDaConta).toBe(identificadorFixoDaConta(conta.id));

    const { chamar } = await contextoLogado(conta);
    await chamar.remover({ id: chave.id });
    expect(await chavesDe(conta.id)).toEqual([]);
    const opcoes = await chamar.opcoesDeCadastro();
    expect(opcoes.user.id).toBe(primeiro.identificadorDaConta);
    expect(opcoes.excludeCredentials).toEqual([]);

    const outra = await criarConta("identificador-outra");
    const { chamar: comoOutra } = await contextoLogado(outra);
    expect((await comoOutra.opcoesDeCadastro()).user.id).not.toBe(primeiro.identificadorDaConta);
  });

  it("a chave RS256 (Windows Hello em TPM antigo) cadastra e entra; a chave pública RSA, maior, fica inteira", async () => {
    const conta = await criarConta("rs256");
    const autenticador = criarAutenticador({ origem: ORIGEM, algoritmo: "RS256", contadorInicial: 0 });
    await cadastrar(conta, autenticador);
    const [gravada] = await chavesDe(conta.id);
    // COSE RSA de 2048 bits: uns 272 bytes, uns 363 caracteres em base64url.
    expect(gravada.chavePublica.length).toBeGreaterThan(350);

    await expect((await entrar(autenticador)).resultado).resolves.toMatchObject({ success: true });
    expect((await chavesDe(conta.id))[0].contador).toBe(1);
    // E a assinatura RS256 adulterada também é recusada.
    await expect((await entrar(autenticador, { adulterarDepoisDeAssinar: true })).resultado).rejects.toMatchObject({ message: ERRO.recusada });
    expect((await chavesDe(conta.id))[0].contador).toBe(1);
  });

  describe("o que falha fora da conferência", () => {
    it("na recusa, o banco fora do ar ao contar a tentativa é 'banco indisponível', e não CHAVE_RECUSADA", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const conta = await criarConta("tentativa-sem-banco");
      const autenticador = criarAutenticador({ origem: ORIGEM });
      await cadastrar(conta, autenticador);
      falhas.tentativa = sucesso => (sucesso ? null : new BancoIndisponivel());

      const { ctx, resultado } = await entrar(autenticador, { origem: "https://golpe.example" });
      await expect(resultado).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
      expect(cookieDe(ctx)).not.toHaveBeenCalled();
    });

    it("na recusa, outro erro ao contar a tentativa vai para o log, e a recusa sai como sempre", async () => {
      const conta = await criarConta("tentativa-erro");
      const autenticador = criarAutenticador({ origem: ORIGEM });
      await cadastrar(conta, autenticador);
      falhas.tentativa = sucesso => (sucesso ? null : new Error("falha qualquer da gravação"));

      await expect((await entrar(autenticador, { origem: "https://golpe.example" })).resultado).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: ERRO.recusada,
      });
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/a tentativa errada não foi registrada \(userId \d+\): .*falha qualquer da gravação/));
    });

    it("na entrada certa, a falha ao zerar as tentativas vai para o log, e a entrada vale", async () => {
      const erros = vi.spyOn(console, "error").mockImplementation(() => {});
      const conta = await criarConta("zerar-falha");
      const autenticador = criarAutenticador({ origem: ORIGEM });
      await cadastrar(conta, autenticador);
      falhas.tentativa = sucesso => (sucesso ? new BancoIndisponivel() : null);

      const { ctx, resultado } = await entrar(autenticador);
      await expect(resultado).resolves.toMatchObject({ success: true });
      expect(cookieDe(ctx)).toHaveBeenCalledTimes(1);
      expect(erros).toHaveBeenCalledWith(expect.stringContaining(`as tentativas erradas não foram zeradas (userId ${conta.id})`));
    });

    it("a sessão que não abre: banco fora do ar é 'banco indisponível'; outra falha é CHAVE_ERRO_INTERNO; nos dois, sem cookie e sem LOGIN", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const conta = await criarConta("sessao-nao-abre");
      const autenticador = criarAutenticador({ origem: ORIGEM });
      await cadastrar(conta, autenticador);

      falhas.abrirSessao = new BancoIndisponivel();
      const semBanco = await entrar(autenticador);
      await expect(semBanco.resultado).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
      expect(cookieDe(semBanco.ctx)).not.toHaveBeenCalled();

      falhas.abrirSessao = new Error("Erro interno ao criar sessão. Tente novamente.");
      const comErro = await entrar(autenticador);
      await expect(comErro.resultado).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: ERRO.erroInterno });
      expect(cookieDe(comErro.ctx)).not.toHaveBeenCalled();
      expect(await auditoriaDe(conta.id, "LOGIN")).toEqual([]);
    });
  });
});
