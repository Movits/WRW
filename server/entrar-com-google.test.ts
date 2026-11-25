import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const google = await import("./entrar-com-google");
const rotas = await import("./rotas-de-entrar-com-google");
const shared = await import("@shared/entrar-com-google");
const { BancoIndisponivel } = await import("./banco-indisponivel");

/**
 * Entrar com a conta Google (A8), sem banco: a configuração, o cookie da ida, a
 * leitura do id_token e as recusas das duas rotas antes de qualquer consulta.
 * O caminho com o banco (entrar, criar, ligar, desligar) está em
 * entrar-com-google.integracao.test.ts.
 */

const CLIENTE = "id-do-cliente.apps.googleusercontent.com";
const AGORA = 1_800_000_000_000;

const AMBIENTE = {
  ENTRAR_COM_GOOGLE: "ligado",
  GOOGLE_OAUTH_CLIENT_ID: CLIENTE,
  GOOGLE_OAUTH_CLIENT_SECRET: "segredo-do-cliente",
  FRONTEND_URL: "https://wrwglobal.org",
};

describe("configuracaoDaEntradaComGoogle", () => {
  it("liga só com ENTRAR_COM_GOOGLE=ligado, o cliente OAuth e o FRONTEND_URL", () => {
    expect(google.configuracaoDaEntradaComGoogle(AMBIENTE)).toEqual({
      clientId: CLIENTE,
      clientSecret: "segredo-do-cliente",
      origem: "https://wrwglobal.org",
      host: "wrwglobal.org",
      redirectUri: "https://wrwglobal.org/api/entrar-com-google/retorno",
    });
    // O cliente da Google Agenda já está em produção: sem a chave própria, o botão não aparece.
    expect(google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, ENTRAR_COM_GOOGLE: undefined })).toBeNull();
    expect(google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, ENTRAR_COM_GOOGLE: "sim" })).toBeNull();
    expect(google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, GOOGLE_OAUTH_CLIENT_SECRET: "" })).toBeNull();
    expect(google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, FRONTEND_URL: "http://wrwglobal.org" })).toBeNull();
    expect(google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, FRONTEND_URL: "http://localhost:3000" })?.redirectUri)
      .toBe("http://localhost:3000/api/entrar-com-google/retorno");
  });

  it("a tela da Google pede só openid e email, sem acesso offline, com nonce e PKCE", () => {
    const config = google.configuracaoDaEntradaComGoogle(AMBIENTE)!;
    const url = new URL(google.urlDeAutorizacaoDaEntrada(config, { state: "s", desafio: "d", nonce: "n" }));
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(url.searchParams.get("nonce")).toBe("n");
    expect(url.searchParams.get("code_challenge")).toBe("d");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://wrwglobal.org/api/entrar-com-google/retorno");
  });
});

describe("o cookie da ida", () => {
  const ida = {
    state: "st", verificador: "ver", nonce: "no", modo: "entrar" as const, userId: null, voltar: "/agenda", expiraEm: AGORA + 1000,
  };

  it("abre o que selou, e recusa o vencido, o adulterado e o ligar sem conta", () => {
    expect(google.abrirIdaDaEntrada(google.selarIdaDaEntrada(ida), AGORA)).toEqual({ ok: true, ida });
    expect(google.abrirIdaDaEntrada(google.selarIdaDaEntrada(ida), AGORA + 1000)).toEqual({ ok: false, motivo: "vencida" });
    expect(google.abrirIdaDaEntrada(google.selarIdaDaEntrada(ida).replace(/.$/, c => (c === "a" ? "b" : "a")), AGORA))
      .toEqual({ ok: false, motivo: "adulterada" });
    expect(google.abrirIdaDaEntrada(google.selarIdaDaEntrada({ ...ida, modo: "ligar" }), AGORA)).toEqual({ ok: false, motivo: "adulterada" });
    expect(google.abrirIdaDaEntrada(undefined, AGORA)).toEqual({ ok: false, motivo: "ausente" });
  });

  it("o voltar só aceita caminho do próprio site", () => {
    expect(google.voltarAceitavel("/agenda?x=1")).toBe("/agenda?x=1");
    for (const ruim of ["//exemplo.com", "https://exemplo.com", "/\\exemplo.com", "/a b", "agenda", 5, "/" + "a".repeat(600)]) {
      expect(google.voltarAceitavel(ruim)).toBeNull();
    }
  });
});

function idToken(dados: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      iss: "https://accounts.google.com", aud: CLIENTE, sub: "1234567890", email: "Dona@Exemplo.com",
      email_verified: true, nonce: "o-nonce", exp: Math.floor(AGORA / 1000) + 3600, ...dados,
    })).toString("base64url"),
    "assinatura",
  ].join(".");
}

describe("lerIdentidadeDaEntrada", () => {
  const esperado = { clientId: CLIENTE, nonce: "o-nonce" };

  it("devolve o sub e o e-mail em minúsculas", () => {
    expect(google.lerIdentidadeDaEntrada(idToken({}), esperado, AGORA)).toEqual({ ok: true, identidade: { sub: "1234567890", email: "dona@exemplo.com" } });
  });

  it("recusa outro destinatário, outro emissor, vencido, outro nonce e sub inválido", () => {
    for (const desvio of [
      { aud: "outro-cliente" },
      { iss: "https://outro.exemplo" },
      { exp: Math.floor(AGORA / 1000) - 600 },
      { nonce: "outro-nonce" },
      { nonce: undefined },
      { sub: "" },
      { sub: "com espaço" },
    ]) {
      expect(google.lerIdentidadeDaEntrada(idToken(desvio), esperado, AGORA), JSON.stringify(desvio)).toEqual({ ok: false, motivo: "invalido" });
    }
    expect(google.lerIdentidadeDaEntrada(null, esperado, AGORA)).toEqual({ ok: false, motivo: "invalido" });
    expect(google.lerIdentidadeDaEntrada("nao.e.jwt-valido", esperado, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa o e-mail que a Google não garante, inclusive \"true\" como texto", () => {
    for (const desvio of [{ email_verified: false }, { email_verified: "true" }, { email_verified: undefined }, { email: undefined }]) {
      expect(google.lerIdentidadeDaEntrada(idToken(desvio), esperado, AGORA), JSON.stringify(desvio))
        .toEqual({ ok: false, motivo: "email-nao-verificado" });
    }
  });
});

describe("nomeDaContaNova", () => {
  it("usa o começo do e-mail, sem passar de 100 caracteres", () => {
    expect(google.nomeDaContaNova("maria.silva@exemplo.com")).toBe("maria.silva");
    expect(google.nomeDaContaNova("a@exemplo.com")).toBe("a@exemplo.com");
    expect(google.nomeDaContaNova(`${"x".repeat(150)}@exemplo.com`)).toHaveLength(100);
  });
});

describe("o endereço do botão e os resultados", () => {
  it("começa na origem do FRONTEND_URL, com o modo e o voltar", () => {
    expect(shared.enderecoDoBotaoDoGoogle("https://wrwglobal.org", "entrar", "/agenda"))
      .toBe("https://wrwglobal.org/api/entrar-com-google/ir?modo=entrar&voltar=%2Fagenda");
    expect(shared.lerResultadoDaContaGoogle("?conta-google=conta-existe")).toBe("conta-existe");
    expect(shared.lerResultadoDaContaGoogle("?conta-google=inventado")).toBeNull();
  });
});

// ── as rotas, antes do banco ────────────────────────────────────────────────

let servidor: Server;
let base = "";
let host = "";
let configuracao: ReturnType<typeof google.configuracaoDaEntradaComGoogle>;
const autenticar = vi.fn();
const buscar = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeAll(async () => {
  const app = express();
  rotas.registrarRotasDeEntrarComGoogle(app, {
    configuracao: () => configuracao,
    autenticar: (...args) => autenticar(...args),
    buscar: (url, init) => buscar(url, init),
    agora: () => AGORA,
  });
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  host = `127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  base = `http://${host}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

beforeEach(() => {
  configuracao = google.configuracaoDaEntradaComGoogle({ ...AMBIENTE, FRONTEND_URL: base });
  autenticar.mockReset();
  autenticar.mockRejectedValue(new Error("sem sessão"));
  buscar.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const pedir = (caminho: string, cabecalhos: Record<string, string> = {}) => fetch(`${base}${caminho}`, { redirect: "manual", headers: cabecalhos });
const destino = (resposta: Response) => resposta.headers.get("location");

describe("as rotas sem a configuração", () => {
  it("dão 404, sem cache, sem olhar a sessão nem chamar a Google", async () => {
    configuracao = null;
    for (const caminho of ["/api/entrar-com-google/ir?modo=entrar", "/api/entrar-com-google/retorno?code=x&state=y"]) {
      const resposta = await pedir(caminho);
      expect(resposta.status).toBe(404);
      expect(resposta.headers.get("cache-control")).toBe("no-store");
    }
    expect(autenticar).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });
});

describe("GET /api/entrar-com-google/ir", () => {
  it("manda à Google com o cookie da ida, HttpOnly e só no caminho das rotas", async () => {
    const resposta = await pedir("/api/entrar-com-google/ir?modo=entrar&voltar=%2Fagenda");
    expect(resposta.status).toBe(302);
    const url = new URL(destino(resposta)!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const cookie = resposta.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith(`${google.COOKIE_DA_IDA_DA_ENTRADA}=`)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/entrar-com-google");
    const valor = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
    const aberta = google.abrirIdaDaEntrada(valor, AGORA);
    expect(aberta.ok && aberta.ida).toMatchObject({ modo: "entrar", voltar: "/agenda", userId: null, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce") });
  });

  it("modo desconhecido dá 404", async () => {
    expect((await pedir("/api/entrar-com-google/ir?modo=admin")).status).toBe(404);
    expect((await pedir("/api/entrar-com-google/ir")).status).toBe(404);
  });

  it("no ligar, sem sessão, vai ao login sem cookie da ida", async () => {
    const resposta = await pedir("/api/entrar-com-google/ir?modo=ligar");
    expect(destino(resposta)).toBe("/login");
    expect(resposta.headers.get("set-cookie")).toBeNull();
  });

  it("no ligar, o banco fora do ar é erro, não \"sem sessão\": não manda ao login", async () => {
    autenticar.mockRejectedValue(new BancoIndisponivel());
    const resposta = await pedir("/api/entrar-com-google/ir?modo=ligar");
    expect(destino(resposta)).toBe("/login?conta-google=erro");
    expect(resposta.headers.get("set-cookie")).toBeNull();
  });

  it("noutro host, o login recomeça no FRONTEND_URL e o ligar avisa no Perfil", async () => {
    configuracao = { ...configuracao!, host: "wrwglobal.org", origem: "https://wrwglobal.org" };
    expect(destino(await pedir("/api/entrar-com-google/ir?modo=cadastrar"))).toBe("https://wrwglobal.org/api/entrar-com-google/ir?modo=cadastrar");
    expect(destino(await pedir("/api/entrar-com-google/ir?modo=ligar"))).toBe("/profile?conta-google=endereco");
  });
});

describe("GET /api/entrar-com-google/retorno, antes de trocar o código", () => {
  function cookieDaIda(extra: Partial<import("./entrar-com-google").IdaDaEntrada> = {}) {
    const ida = { state: "o-state", verificador: "v", nonce: "n", modo: "entrar" as const, userId: null, voltar: null, expiraEm: AGORA + 60_000, ...extra };
    return `${google.COOKIE_DA_IDA_DA_ENTRADA}=${encodeURIComponent(google.selarIdaDaEntrada(ida))}`;
  }

  it("sem o cookie da ida: expirou, sem chamar a Google", async () => {
    const resposta = await pedir("/api/entrar-com-google/retorno?code=c&state=o-state");
    expect(destino(resposta)).toBe("/login?conta-google=expirou");
    expect(buscar).not.toHaveBeenCalled();
  });

  it("o state de outra ida é recusado, e o cookie sai", async () => {
    const resposta = await pedir("/api/entrar-com-google/retorno?code=c&state=outro", { cookie: cookieDaIda() });
    expect(destino(resposta)).toBe("/login?conta-google=erro");
    expect(resposta.headers.get("set-cookie")).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("a recusa na tela da Google volta como negada, na tela do modo", async () => {
    const resposta = await pedir("/api/entrar-com-google/retorno?error=access_denied&state=o-state", { cookie: cookieDaIda({ modo: "cadastrar" }) });
    expect(destino(resposta)).toBe("/register?conta-google=negada");
  });

  it("no ligar, a sessão de outra conta é recusada antes de gastar o código", async () => {
    autenticar.mockResolvedValue({ id: 99 });
    const resposta = await pedir("/api/entrar-com-google/retorno?code=c&state=o-state", { cookie: cookieDaIda({ modo: "ligar", userId: 7 }) });
    expect(destino(resposta)).toBe("/profile?conta-google=erro");
    expect(buscar).not.toHaveBeenCalled();
  });

  it("a Google que recusa a troca volta como erro, sem o código no log", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    buscar.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const resposta = await pedir("/api/entrar-com-google/retorno?code=codigo-secreto&state=o-state", { cookie: cookieDaIda() });
    expect(destino(resposta)).toBe("/login?conta-google=erro");
    expect(erros.mock.calls.flat().join(" ")).not.toContain("codigo-secreto");
  });

  it("o id_token com o e-mail não verificado volta como email-nao-verificado", async () => {
    buscar.mockResolvedValue(new Response(JSON.stringify({
      access_token: "a", expires_in: 3600, scope: "openid email",
      id_token: idToken({ nonce: "n", email_verified: false }),
    }), { status: 200 }));
    const resposta = await pedir("/api/entrar-com-google/retorno?code=c&state=o-state", { cookie: cookieDaIda() });
    expect(destino(resposta)).toBe("/login?conta-google=email-nao-verificado");
  });

  it("o teto da rede recusa com muitas-tentativas", async () => {
    // Gasta o que sobrou da janela (as idas dos outros testes também contam).
    for (let i = 0; i < rotas.PEDIDOS_DE_ENTRAR_COM_GOOGLE_POR_REDE; i += 1) {
      const resposta = await pedir("/api/entrar-com-google/ir?modo=entrar");
      if (destino(resposta) === "/login?conta-google=muitas-tentativas") break;
    }
    expect(destino(await pedir("/api/entrar-com-google/ir?modo=entrar"))).toBe("/login?conta-google=muitas-tentativas");
  });
});
