import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { registrarRotasDaGoogleAgenda } = await import("./rotas-da-google-agenda");
const oauth = await import("./google-oauth");
const { BancoIndisponivel } = await import("./banco-indisponivel");

/**
 * As duas rotas da conexão com a Google Agenda (H16b), pelo HTTP de verdade: um
 * Express de teste com as rotas montadas e as dependências trocadas por dublês
 * (a sessão, o fetch para a Google, a gravação no banco e o relógio). O teste
 * local vai só até o redirecionamento à Google: o consentimento de verdade
 * pede o login de uma pessoa numa conta de teste, e isso é o cartão do teste
 * manual. A gravação no banco de verdade está em google-agenda.integracao.test.ts.
 *
 * A Google revoga por conta Google e projeto, não por token: a volta nunca
 * revoga a autorização que não ficou quando outra conexão usa a mesma conta
 * Google (o sub do id_token), porque isso derrubaria aquela conexão.
 */

const AGORA = 1_800_000_000_000;
const CONTA = { id: 7, openId: "open-7", onboardingCompleted: true };
const TOKEN_DA_AGENDA = "https://www.googleapis.com/auth/calendar.events";
const SUB = "sub-da-dona";

let servidor: Server;
let base = "";
let host = "";
let configuracao: ReturnType<typeof oauth.configuracaoDaGoogleAgenda>;
const autenticar = vi.fn();
const gravar = vi.fn();
const contaGoogleEmUso = vi.fn<(sub: string) => Promise<boolean>>();
const buscar = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let agora: () => number = () => AGORA;
let logs: string[] = [];

beforeAll(async () => {
  const app = express();
  registrarRotasDaGoogleAgenda(app, {
    configuracao: () => configuracao,
    autenticar: (...args) => autenticar(...args),
    buscar: (url, init) => buscar(url, init),
    gravar: (...args) => gravar(...args),
    contaGoogleEmUso: sub => contaGoogleEmUso(sub),
    agora: () => agora(),
  });
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  host = `127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  base = `http://${host}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

function configDoTeste(extra: Partial<NodeJS.ProcessEnv> = {}) {
  // O FRONTEND_URL de verdade não aceita http fora do localhost: aqui o host do
  // servidor de teste entra no lugar, pela mesma função.
  const config = oauth.configuracaoDaGoogleAgenda({
    GOOGLE_OAUTH_CLIENT_ID: "id-do-cliente.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "segredo-do-cliente",
    FRONTEND_URL: "https://wrwglobal.org",
    VAULT_ENCRYPTION_KEY: "k".repeat(32),
    GOOGLE_AGENDA_LIBERADA_PARA: "todas",
    ...extra,
  });
  return config && { ...config, origem: base, host, redirectUri: `${base}/api/google-agenda/retorno` };
}

beforeEach(() => {
  configuracao = configDoTeste();
  autenticar.mockReset();
  autenticar.mockResolvedValue(CONTA);
  gravar.mockReset();
  gravar.mockResolvedValue({ anterior: null });
  contaGoogleEmUso.mockReset();
  contaGoogleEmUso.mockResolvedValue(false);
  buscar.mockReset();
  agora = () => AGORA;
  logs = [];
  for (const nivel of ["error", "warn", "log"] as const) {
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
});

const pedir = (caminho: string, cabecalhos: Record<string, string> = {}) =>
  fetch(`${base}${caminho}`, { redirect: "manual", headers: cabecalhos });

function cookieDaIda(extra: Partial<{ state: string; verificador: string; userId: number; expiraEm: number }> = {}) {
  const ida = { state: "o-state-da-ida", verificador: "o-verificador-da-ida", userId: CONTA.id, expiraEm: AGORA + 60_000, ...extra };
  return { ida, cabecalho: `${oauth.COOKIE_DA_IDA}=${encodeURIComponent(oauth.selarIda(ida))}` };
}

function idTokenDa(dados: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "id-do-cliente.apps.googleusercontent.com", ...dados })).toString("base64url"),
    "assinatura",
  ].join(".");
}

function respostaDeTokens(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    access_token: "acesso-novo", expires_in: 3599, refresh_token: "refresh-novo", token_type: "Bearer",
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${TOKEN_DA_AGENDA}`,
    id_token: idTokenDa({ sub: SUB, email: "dona@exemplo.com" }),
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const revogacoes = () => buscar.mock.calls.filter(([url]) => url === "https://oauth2.googleapis.com/revoke");
const destino = (resposta: Response) => resposta.headers.get("location");
const cookieApagado = (resposta: Response) => {
  const valor = resposta.headers.get("set-cookie") ?? "";
  return valor.startsWith(`${oauth.COOKIE_DA_IDA}=;`) && /Expires=Thu, 01 Jan 1970/.test(valor) && valor.includes("Path=/api/google-agenda");
};

describe("sem as variáveis, a função some", () => {
  it("as duas rotas dão 404, sem cache e sem olhar a sessão", async () => {
    configuracao = null;
    for (const caminho of ["/api/google-agenda/conectar", "/api/google-agenda/retorno?code=x&state=y"]) {
      const resposta = await pedir(caminho);
      expect(resposta.status).toBe(404);
      expect(resposta.headers.get("cache-control")).toBe("no-store");
    }
    expect(autenticar).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });
});

describe("GET /api/google-agenda/conectar", () => {
  it("manda à Google com o state e o desafio do verificador que ficou no cookie da ida", async () => {
    const resposta = await pedir("/api/google-agenda/conectar");
    expect(resposta.status).toBe(302);
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    const url = new URL(destino(resposta)!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(`${base}/api/google-agenda/retorno`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");

    const cookie = resposta.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${oauth.COOKIE_DA_IDA}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/google-agenda");
    expect(cookie).toContain("Max-Age=600");
    // Em http não há Secure; atrás do proxy em https, há (o teste abaixo).
    expect(cookie).not.toContain("Secure");

    const valor = decodeURIComponent(cookie.split(";")[0].slice(oauth.COOKIE_DA_IDA.length + 1));
    const aberta = oauth.abrirIda(valor, AGORA);
    expect(aberta.ok).toBe(true);
    if (!aberta.ok) return;
    expect(aberta.ida).toMatchObject({ state: url.searchParams.get("state"), userId: 7, expiraEm: AGORA + 10 * 60_000 });
    expect(url.searchParams.get("code_challenge")).toBe(oauth.desafioDoPkce(aberta.ida.verificador));
    // O verificador nunca sai do servidor na ida.
    expect(url.toString()).not.toContain(aberta.ida.verificador);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("atrás do proxy em https, o cookie da ida sai Secure", async () => {
    const resposta = await pedir("/api/google-agenda/conectar", { "X-Forwarded-Proto": "https" });
    expect(resposta.headers.get("set-cookie")).toContain("Secure");
  });

  it("começar por outro endereço volta ao Perfil com ?google=endereco, sem cookie nem sessão", async () => {
    configuracao = { ...configDoTeste()!, host: "wrwglobal.org" };
    const resposta = await pedir("/api/google-agenda/conectar");
    expect(resposta.status).toBe(302);
    expect(destino(resposta)).toBe("/profile?google=endereco");
    expect(resposta.headers.get("set-cookie")).toBeNull();
    expect(autenticar).not.toHaveBeenCalled();
  });

  it("sem sessão vai ao login; cadastro incompleto, ao cadastro; cron é recusado", async () => {
    autenticar.mockRejectedValueOnce(new Error("Invalid session cookie"));
    expect(destino(await pedir("/api/google-agenda/conectar"))).toBe("/login");
    autenticar.mockResolvedValueOnce({ ...CONTA, onboardingCompleted: false });
    expect(destino(await pedir("/api/google-agenda/conectar"))).toBe("/onboarding");
    autenticar.mockResolvedValueOnce({ id: -1, openId: "cron_x", isCron: true, onboardingCompleted: true });
    const cron = await pedir("/api/google-agenda/conectar");
    expect(cron.status).toBe(403);
    expect(cron.headers.get("set-cookie")).toBeNull();
  });

  it("banco fora do ar na sessão não é 'sem sessão': volta ao Perfil com o erro", async () => {
    autenticar.mockRejectedValueOnce(new BancoIndisponivel());
    const resposta = await pedir("/api/google-agenda/conectar");
    expect(destino(resposta)).toBe("/profile?google=erro");
    expect(resposta.headers.get("set-cookie")).toBeNull();
  });

  it("em modo Teste, a conta fora de GOOGLE_AGENDA_LIBERADA_PARA recebe 404 nas duas rotas, sem cookie e sem a Google", async () => {
    // Na Google, ela pararia numa página de erro (403 access_denied), sem voltar à WRW.
    configuracao = { ...configDoTeste()!, liberadaPara: new Set([99]) };
    const ida = await pedir("/api/google-agenda/conectar");
    expect(ida.status).toBe(404);
    expect(ida.headers.get("set-cookie")).toBeNull();
    const volta = await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    expect(volta.status).toBe(404);
    expect(cookieApagado(volta)).toBe(true);
    expect(buscar).not.toHaveBeenCalled();
    expect(gravar).not.toHaveBeenCalled();
    // A conta da lista passa.
    configuracao = { ...configDoTeste()!, liberadaPara: new Set([CONTA.id]) };
    expect((await pedir("/api/google-agenda/conectar")).status).toBe(302);
  });

  it("falha inesperada volta ao Perfil com o erro, e o servidor segue de pé", async () => {
    agora = () => { throw new Error("relógio quebrado"); };
    expect(destino(await pedir("/api/google-agenda/conectar"))).toBe("/profile?google=erro");
    agora = () => AGORA;
    expect((await pedir("/api/google-agenda/conectar")).status).toBe(302);
  });
});

describe("GET /api/google-agenda/retorno: o que é recusado antes de falar com a Google", () => {
  it("sem o cookie da ida, ou vencido: ?google=expirou, e nada vai à Google", async () => {
    let resposta = await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida");
    expect(destino(resposta)).toBe("/profile?google=expirou");
    expect(cookieApagado(resposta)).toBe(true);
    const vencido = cookieDaIda({ expiraEm: AGORA });
    resposta = await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: vencido.cabecalho });
    expect(destino(resposta)).toBe("/profile?google=expirou");
    expect(buscar).not.toHaveBeenCalled();
  });

  it("cookie adulterado, state trocado ou outra conta na sessão: ?google=erro, e o cookie sai", async () => {
    const { cabecalho } = cookieDaIda();
    const adulterado = `${cabecalho.slice(0, -1)}${cabecalho.endsWith("0") ? "1" : "0"}`;
    for (const [caminho, cookie] of [
      ["/api/google-agenda/retorno?code=c&state=o-state-da-ida", adulterado],
      ["/api/google-agenda/retorno?code=c&state=outro-state", cabecalho],
      ["/api/google-agenda/retorno?code=c", cabecalho],
    ]) {
      const resposta = await pedir(caminho, { Cookie: cookie });
      expect(destino(resposta), caminho).toBe("/profile?google=erro");
      expect(cookieApagado(resposta)).toBe(true);
    }
    autenticar.mockResolvedValueOnce({ ...CONTA, id: 8 });
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cabecalho }))).toBe("/profile?google=erro");
    expect(buscar).not.toHaveBeenCalled();
    expect(gravar).not.toHaveBeenCalled();
  });

  it("a dona não autorizou: ?google=negada; outro erro da Google: ?google=erro", async () => {
    const { cabecalho } = cookieDaIda();
    expect(destino(await pedir("/api/google-agenda/retorno?error=access_denied&state=o-state-da-ida", { Cookie: cabecalho })))
      .toBe("/profile?google=negada");
    expect(destino(await pedir("/api/google-agenda/retorno?error=server_error&state=o-state-da-ida", { Cookie: cabecalho })))
      .toBe("/profile?google=erro");
    expect(destino(await pedir("/api/google-agenda/retorno?state=o-state-da-ida", { Cookie: cabecalho }))).toBe("/profile?google=erro");
    expect(buscar).not.toHaveBeenCalled();
  });

  it("sem sessão na volta vai ao login, e o cookie da ida sai assim mesmo", async () => {
    autenticar.mockRejectedValueOnce(new Error("Invalid session cookie"));
    const resposta = await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    expect(destino(resposta)).toBe("/login");
    expect(cookieApagado(resposta)).toBe(true);
  });
});

describe("GET /api/google-agenda/retorno: a troca e a gravação", () => {
  it("troca o código com o verificador do cookie, grava a conexão com a prova e volta conectada", async () => {
    buscar.mockResolvedValueOnce(respostaDeTokens());
    const { cabecalho } = cookieDaIda();
    const resposta = await pedir("/api/google-agenda/retorno?code=o-codigo&state=o-state-da-ida&scope=x", {
      Cookie: cabecalho, "User-Agent": "Navegador de teste",
    });
    expect(destino(resposta)).toBe("/profile?google=conectada");
    expect(cookieApagado(resposta)).toBe(true);

    expect(buscar).toHaveBeenCalledTimes(1);
    const [url, init] = buscar.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const corpo = new URLSearchParams(String(init?.body));
    expect(corpo.get("code")).toBe("o-codigo");
    expect(corpo.get("code_verifier")).toBe("o-verificador-da-ida");
    expect(corpo.get("redirect_uri")).toBe(`${base}/api/google-agenda/retorno`);

    expect(gravar).toHaveBeenCalledTimes(1);
    expect(gravar).toHaveBeenCalledWith(7, {
      refreshToken: "refresh-novo",
      sub: SUB,
      email: "dona@exemplo.com",
      escopos: ["openid", "https://www.googleapis.com/auth/userinfo.email", TOKEN_DA_AGENDA],
      acesso: { token: "acesso-novo", expiraEm: AGORA + 3_599_000 },
    }, { ipAddress: expect.any(String), userAgent: "Navegador de teste" }, AGORA);
    expect(revogacoes()).toEqual([]);
  });

  it("reconectar com a mesma conta Google não revoga nada: a gravação não devolve anterior, e nada vai ao /revoke", async () => {
    // Revogar o anterior da mesma conta derrubaria a conexão nova (a Google revoga por conta e projeto).
    gravar.mockResolvedValueOnce({ anterior: null });
    buscar.mockResolvedValueOnce(respostaDeTokens());
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=conectada");
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(revogacoes()).toEqual([]);
  });

  it("reconectar com outra conta Google revoga o anterior que a gravação devolve, depois de gravar; o mesmo token nunca", async () => {
    gravar.mockResolvedValueOnce({ anterior: "refresh-antigo" });
    buscar.mockResolvedValueOnce(respostaDeTokens()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=conectada");
    expect(buscar).toHaveBeenCalledTimes(2);
    expect(buscar.mock.calls[1][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(String(buscar.mock.calls[1][1]?.body)).get("token")).toBe("refresh-antigo");

    buscar.mockReset();
    gravar.mockResolvedValueOnce({ anterior: "refresh-novo" });
    buscar.mockResolvedValueOnce(respostaDeTokens());
    await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it("sem a conta Google no id_token: não grava, revoga o que veio e volta com erro", async () => {
    buscar
      .mockResolvedValueOnce(respostaDeTokens({ id_token: idTokenDa({ email: "dona@exemplo.com" }) }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(gravar).not.toHaveBeenCalled();
    // Sem o sub não há o que conferir: revoga.
    expect(contaGoogleEmUso).not.toHaveBeenCalled();
    expect(new URLSearchParams(String(revogacoes()[0]?.[1]?.body)).get("token")).toBe("refresh-novo");
    // O log diz a causa de verdade, e não uma gravação que nem foi tentada.
    expect(logs.some(linha => linha.includes("o id_token não trouxe a conta Google"))).toBe(true);
    expect(logs.some(linha => linha.includes("a conexão não foi gravada"))).toBe(false);
  });

  it("a revogação do anterior que falha não desfaz a conexão nova: só um aviso no log", async () => {
    gravar.mockResolvedValueOnce({ anterior: "refresh-antigo" });
    buscar.mockResolvedValueOnce(respostaDeTokens()).mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=conectada");
    expect(logs.some(linha => linha.includes("conexão anterior"))).toBe(true);
  });

  it("a agenda desmarcada no consentimento: revoga o que veio, não grava e volta ?google=sem-permissao", async () => {
    buscar
      .mockResolvedValueOnce(respostaDeTokens({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=sem-permissao");
    expect(gravar).not.toHaveBeenCalled();
    expect(contaGoogleEmUso).toHaveBeenCalledWith(SUB);
    expect(buscar.mock.calls[1][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(String(buscar.mock.calls[1][1]?.body)).get("token")).toBe("refresh-novo");
  });

  it("a agenda desmarcada com a mesma conta Google já conectada (aqui ou noutra conta da WRW): não revoga, e a conexão que existe fica de pé", async () => {
    contaGoogleEmUso.mockResolvedValue(true);
    buscar.mockResolvedValueOnce(respostaDeTokens({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=sem-permissao");
    expect(revogacoes()).toEqual([]);
    expect(logs.some(linha => linha.includes("outra conexão usa a mesma conta Google"))).toBe(true);
  });

  it("sem refresh token: revoga o token de acesso, não grava e volta com erro", async () => {
    buscar
      .mockResolvedValueOnce(respostaDeTokens({ refresh_token: undefined }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(gravar).not.toHaveBeenCalled();
    expect(new URLSearchParams(String(buscar.mock.calls[1][1]?.body)).get("token")).toBe("acesso-novo");
  });

  it("sem refresh token e a Google não confirma a revogação: a tela manda tirar o acesso pela conta Google", async () => {
    buscar
      .mockResolvedValueOnce(respostaDeTokens({ refresh_token: undefined }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro-acesso-ficou");
    expect(logs.some(linha => linha.includes("não confirmou a revogação da autorização que não ficou"))).toBe(true);
  });

  it("a Google recusa a troca: erro, sem gravar, e o log diz o código dela e nada mais", async () => {
    buscar.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant", error_description: "o-codigo-usado" }), { status: 400 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=o-codigo-usado&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(gravar).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("invalid_grant");
    expect(logs.join("\n")).not.toContain("o-codigo-usado");
  });

  it("a gravação falha e nenhuma conexão usa a conta Google: o token novo sai revogado e a volta é erro", async () => {
    gravar.mockRejectedValueOnce(new Error("a auditoria não gravou"));
    buscar.mockResolvedValueOnce(respostaDeTokens()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(contaGoogleEmUso).toHaveBeenCalledWith(SUB);
    expect(buscar.mock.calls[1][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(String(buscar.mock.calls[1][1]?.body)).get("token")).toBe("refresh-novo");
  });

  it("a gravação falha com a mesma conta Google já conectada: o token novo NÃO é revogado, senão derrubaria a conexão que existe", async () => {
    contaGoogleEmUso.mockResolvedValue(true);
    gravar.mockRejectedValueOnce(new Error("a auditoria não gravou"));
    buscar.mockResolvedValueOnce(respostaDeTokens());
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(revogacoes()).toEqual([]);
  });

  it("a gravação falha com o banco fora: sem como conferir a conta Google, não revoga, e o log diz por quê", async () => {
    gravar.mockRejectedValueOnce(new BancoIndisponivel());
    contaGoogleEmUso.mockRejectedValue(new BancoIndisponivel());
    buscar.mockResolvedValueOnce(respostaDeTokens());
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro");
    expect(revogacoes()).toEqual([]);
    expect(logs.some(linha => linha.includes("sem o banco, não deu para saber"))).toBe(true);
  });

  it("a gravação falha e a Google não confirma a revogação: ?google=erro-acesso-ficou, com o aviso no log", async () => {
    gravar.mockRejectedValueOnce(new Error("a auditoria não gravou"));
    buscar.mockResolvedValueOnce(respostaDeTokens()).mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(destino(await pedir("/api/google-agenda/retorno?code=c&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho })))
      .toBe("/profile?google=erro-acesso-ficou");
    expect(logs.some(linha => linha.includes("não confirmou a revogação da autorização que não ficou"))).toBe(true);
  });

  it("nenhum log, em nenhum caminho, leva token, código, verificador ou segredo", async () => {
    gravar.mockRejectedValueOnce(Object.assign(new Error("Failed query: insert into google_agenda_conexoes ... params: refresh-novo"), {
      query: "insert into `google_agenda_conexoes` ...", params: ["refresh-novo"],
    }));
    buscar.mockResolvedValueOnce(respostaDeTokens()).mockResolvedValueOnce(new Response("", { status: 503 }));
    await pedir("/api/google-agenda/retorno?code=o-codigo&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    buscar.mockResolvedValueOnce(respostaDeTokens({ refresh_token: undefined })).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await pedir("/api/google-agenda/retorno?code=o-codigo&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    // A consulta pela conta Google que cai: o log leva o SQL, sem o sub.
    gravar.mockRejectedValueOnce(new BancoIndisponivel());
    contaGoogleEmUso.mockRejectedValueOnce(Object.assign(new Error(`Failed query: select ... params: ${SUB}`), {
      query: "select `userId` from `google_agenda_conexoes` where `google_sub` = ?", params: [SUB],
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }));
    buscar.mockResolvedValueOnce(respostaDeTokens());
    await pedir("/api/google-agenda/retorno?code=o-codigo&state=o-state-da-ida", { Cookie: cookieDaIda().cabecalho });
    const tudo = logs.join("\n");
    expect(tudo.length).toBeGreaterThan(0);
    for (const segredo of ["refresh-novo", "acesso-novo", "o-codigo", "o-verificador-da-ida", "segredo-do-cliente", SUB]) {
      expect(tudo).not.toContain(segredo);
    }
  });
});
