import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const oauth = await import("./google-oauth");
const { encryptData } = await import("./security");

/**
 * A conversa com a Google da H16b, sem rede: o fetch é um dublê que guarda o
 * que saiu e devolve o que a Google devolveria. Prova a configuração (sem uma
 * variável a função some), o PKCE pelo vetor da própria RFC 7636, os
 * parâmetros da ida, o cookie da ida (adulterado, vencido e ausente são
 * recusados), as três chamadas ao servidor de tokens e que nenhum token vai
 * parar em mensagem de erro.
 */

const AMBIENTE = {
  GOOGLE_OAUTH_CLIENT_ID: "id-do-cliente.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "segredo-do-cliente",
  FRONTEND_URL: "https://wrwglobal.org",
  VAULT_ENCRYPTION_KEY: "k".repeat(32),
  GOOGLE_AGENDA_LIBERADA_PARA: "todas",
} as NodeJS.ProcessEnv;

const CONFIG = oauth.configuracaoDaGoogleAgenda(AMBIENTE)!;

type Chamada = { url: string; init?: RequestInit };
function dubleDoFetch(...respostas: Array<Response | Error>) {
  const chamadas: Chamada[] = [];
  const buscar = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
  return { buscar, chamadas, corpo: (i = 0) => new URLSearchParams(String(chamadas[i].init?.body)) };
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

function idToken(dados: Record<string, unknown>) {
  const parte = (valor: unknown) => Buffer.from(JSON.stringify(valor)).toString("base64url");
  return `${parte({ alg: "RS256", typ: "JWT" })}.${parte(dados)}.assinatura`;
}

describe("a configuração: sem qualquer uma das cinco variáveis, a função some", () => {
  it("com as cinco, o retorno sai do FRONTEND_URL, sem caminho e sem barra a mais", () => {
    expect(CONFIG).toEqual({
      clientId: "id-do-cliente.apps.googleusercontent.com",
      clientSecret: "segredo-do-cliente",
      origem: "https://wrwglobal.org",
      host: "wrwglobal.org",
      redirectUri: "https://wrwglobal.org/api/google-agenda/retorno",
      liberadaPara: "todas",
    });
    const comBarra = oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, FRONTEND_URL: "https://WRWglobal.org/painel/ " });
    expect(comBarra?.redirectUri).toBe("https://wrwglobal.org/api/google-agenda/retorno");
    expect(comBarra?.host).toBe("wrwglobal.org");
  });

  it.each(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "FRONTEND_URL", "VAULT_ENCRYPTION_KEY", "GOOGLE_AGENDA_LIBERADA_PARA"])("sem %s: null", nome => {
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, [nome]: undefined })).toBeNull();
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, [nome]: "" })).toBeNull();
  });

  it("em modo Teste, só as contas da lista: fora dela a função some, como sem variável", () => {
    const lista = oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, GOOGLE_AGENDA_LIBERADA_PARA: " 7, 12;30  abc 0 -4 " })!;
    expect(lista.liberadaPara).toEqual(new Set([7, 12, 30]));
    expect(oauth.googleAgendaLiberadaPara(lista, 7)).toBe(true);
    expect(oauth.googleAgendaLiberadaPara(lista, 30)).toBe(true);
    expect(oauth.googleAgendaLiberadaPara(lista, 8)).toBe(false);
    expect(oauth.configuracaoDaGoogleAgendaPara(12, { ...AMBIENTE, GOOGLE_AGENDA_LIBERADA_PARA: "7,12" })).not.toBeNull();
    expect(oauth.configuracaoDaGoogleAgendaPara(8, { ...AMBIENTE, GOOGLE_AGENDA_LIBERADA_PARA: "7,12" })).toBeNull();
    // Depois da verificação da Google, "todas" (sem diferença de maiúsculas).
    expect(oauth.configuracaoDaGoogleAgendaPara(8, { ...AMBIENTE, GOOGLE_AGENDA_LIBERADA_PARA: " Todas " })).not.toBeNull();
  });

  it("a lista sem nenhum id válido não libera ninguém: esquecer ou errar a variável esconde a função", () => {
    for (const valor of ["abc", "0", "-3", "1.5", ",", "todos"]) {
      expect(oauth.lerContasLiberadas(valor), valor).toBeNull();
      expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, GOOGLE_AGENDA_LIBERADA_PARA: valor }), valor).toBeNull();
    }
  });

  it("a chave do cofre precisa de 32 caracteres: com 31, encryptData usaria a derivada do JWT_SECRET", () => {
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, VAULT_ENCRYPTION_KEY: "k".repeat(31) })).toBeNull();
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, VAULT_ENCRYPTION_KEY: "k".repeat(32) })).not.toBeNull();
  });

  it("http só na máquina de quem desenvolve; endereço inválido é null", () => {
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, FRONTEND_URL: "http://wrwglobal.org" })).toBeNull();
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, FRONTEND_URL: "isto não é endereço" })).toBeNull();
    expect(oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, FRONTEND_URL: "ftp://wrwglobal.org" })).toBeNull();
    const local = oauth.configuracaoDaGoogleAgenda({ ...AMBIENTE, FRONTEND_URL: "http://localhost:3000" });
    expect(local).toMatchObject({ host: "localhost:3000", redirectUri: "http://localhost:3000/api/google-agenda/retorno" });
  });
});

describe("state e PKCE", () => {
  it("o desafio é base64url(sha256(verificador)): o vetor do apêndice B da RFC 7636", () => {
    expect(oauth.desafioDoPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("o par gerado: verificador de 43 caracteres no alfabeto da norma, e o desafio dele", () => {
    const { verificador, desafio } = oauth.gerarPkce();
    expect(verificador).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const esperado = createHash("sha256").update(verificador).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(desafio).toBe(esperado);
    expect(oauth.gerarPkce().verificador).not.toBe(verificador);
  });

  it("o state tem 32 bytes aleatórios e muda a cada ida; a comparação exige igualdade exata", () => {
    const state = oauth.gerarState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(oauth.gerarState()).not.toBe(state);
    expect(oauth.mesmoState(state, state)).toBe(true);
    expect(oauth.mesmoState(`${state}x`, state)).toBe(false);
    expect(oauth.mesmoState(state.toLowerCase() === state ? state.toUpperCase() : state.toLowerCase(), state)).toBe(false);
    expect(oauth.mesmoState("", "")).toBe(false);
  });
});

describe("a ida à Google", () => {
  it("leva o cliente, o retorno, os três escopos, offline com consentimento, o state e o desafio S256; nunca o segredo", () => {
    const url = new URL(oauth.urlDeAutorizacao(CONFIG, { state: "o-state", desafio: "o-desafio" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "id-do-cliente.apps.googleusercontent.com",
      redirect_uri: "https://wrwglobal.org/api/google-agenda/retorno",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      state: "o-state",
      code_challenge: "o-desafio",
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain("segredo-do-cliente");
  });
});

describe("o cookie da ida", () => {
  const ida = { state: "s".repeat(43), verificador: "v".repeat(43), userId: 7, expiraEm: 2_000_000 };

  it("volta igual, e não se lê sem a chave", () => {
    const selado = oauth.selarIda(ida);
    expect(selado).not.toContain("s".repeat(43));
    expect(selado).not.toContain("v".repeat(43));
    expect(oauth.abrirIda(selado, 1_000_000)).toEqual({ ok: true, ida });
  });

  it("vencido, ausente e adulterado são recusados, cada um com o seu motivo", () => {
    const selado = oauth.selarIda(ida);
    expect(oauth.abrirIda(selado, 2_000_000)).toEqual({ ok: false, motivo: "vencida" });
    expect(oauth.abrirIda(undefined)).toEqual({ ok: false, motivo: "ausente" });
    expect(oauth.abrirIda("")).toEqual({ ok: false, motivo: "ausente" });
    // Um caractere trocado no fim do texto cifrado: o GCM recusa.
    const ultimo = selado.at(-1) === "0" ? "1" : "0";
    expect(oauth.abrirIda(`${selado.slice(0, -1)}${ultimo}`, 1_000_000)).toEqual({ ok: false, motivo: "adulterada" });
    expect(oauth.abrirIda("lixo", 1_000_000)).toEqual({ ok: false, motivo: "adulterada" });
  });

  it("cifrado de verdade, mas sem os campos da ida (ou com a conta como texto), é adulterado", () => {
    expect(oauth.abrirIda(encryptData(JSON.stringify({ s: "x", v: "y" })), 0)).toEqual({ ok: false, motivo: "adulterada" });
    expect(oauth.abrirIda(encryptData(JSON.stringify({ s: "x", v: "y", u: "7", e: 9e15 })), 0)).toEqual({ ok: false, motivo: "adulterada" });
    expect(oauth.abrirIda(encryptData("null"), 0)).toEqual({ ok: false, motivo: "adulterada" });
  });
});

describe("a troca do código", () => {
  it("manda o código e o verificador no corpo do POST, com o segredo, e lê os tokens", async () => {
    const duble = dubleDoFetch(json({
      access_token: "acesso-1", expires_in: 3599, refresh_token: "refresh-1", token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/calendar.events openid https://www.googleapis.com/auth/userinfo.email",
      id_token: "a.b.c",
    }));
    const tokens = await oauth.trocarCodigo(CONFIG, { codigo: "o-codigo", verificador: "o-verificador" }, duble.buscar, 1_000);
    expect(duble.chamadas[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(duble.chamadas[0].init?.method).toBe("POST");
    expect((duble.chamadas[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(duble.corpo())).toEqual({
      grant_type: "authorization_code",
      code: "o-codigo",
      client_id: "id-do-cliente.apps.googleusercontent.com",
      client_secret: "segredo-do-cliente",
      redirect_uri: "https://wrwglobal.org/api/google-agenda/retorno",
      code_verifier: "o-verificador",
    });
    expect(tokens).toEqual({
      accessToken: "acesso-1",
      expiraEm: 1_000 + 3_599_000,
      refreshToken: "refresh-1",
      escopos: ["https://www.googleapis.com/auth/calendar.events", "openid", "https://www.googleapis.com/auth/userinfo.email"],
      idToken: "a.b.c",
    });
  });

  it("a recusa da Google vira RecusaDaGoogle com o código dela, sem o que ela ecoou", async () => {
    const duble = dubleDoFetch(json({ error: "invalid_grant", error_description: "Bad Request o-codigo-secreto" }, 400));
    const erro = await oauth.trocarCodigo(CONFIG, { codigo: "o-codigo-secreto", verificador: "v" }, duble.buscar).catch(e => e);
    expect(erro).toBeInstanceOf(oauth.RecusaDaGoogle);
    expect(erro).toMatchObject({ codigo: "invalid_grant", status: 400 });
    expect(String(erro.message)).not.toContain("o-codigo-secreto");
  });

  it("rede fora, resposta sem token e erro com texto estranho têm códigos próprios", async () => {
    await expect(oauth.trocarCodigo(CONFIG, { codigo: "c", verificador: "v" }, dubleDoFetch(new TypeError("fetch failed: c")).buscar))
      .rejects.toMatchObject({ codigo: "rede", status: null });
    await expect(oauth.trocarCodigo(CONFIG, { codigo: "c", verificador: "v" }, dubleDoFetch(json({ token_type: "Bearer" })).buscar))
      .rejects.toMatchObject({ codigo: "resposta" });
    await expect(oauth.trocarCodigo(CONFIG, { codigo: "c", verificador: "v" }, dubleDoFetch(json({ error: "<script>" }, 400)).buscar))
      .rejects.toMatchObject({ codigo: "http_400" });
    await expect(oauth.trocarCodigo(CONFIG, { codigo: "c", verificador: "v" }, dubleDoFetch(new Response("<html>", { status: 502 })).buscar))
      .rejects.toMatchObject({ codigo: "http_502", status: 502 });
  });
});

describe("a renovação", () => {
  it("manda o refresh token no corpo; sem expires_in, vale 1 hora", async () => {
    const duble = dubleDoFetch(json({ access_token: "acesso-2", scope: "x" }));
    const tokens = await oauth.renovarAcesso(CONFIG, "refresh-1", duble.buscar, 5_000);
    expect(Object.fromEntries(duble.corpo())).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "id-do-cliente.apps.googleusercontent.com",
      client_secret: "segredo-do-cliente",
    });
    expect(duble.chamadas[0].url).not.toContain("refresh-1");
    expect(tokens).toMatchObject({ accessToken: "acesso-2", expiraEm: 5_000 + 3_600_000, refreshToken: null });
  });

  it("invalid_grant é a conexão revogada; o resto é RecusaDaGoogle", async () => {
    await expect(oauth.renovarAcesso(CONFIG, "r", dubleDoFetch(json({ error: "invalid_grant" }, 400)).buscar))
      .rejects.toBeInstanceOf(oauth.ConexaoGoogleRevogada);
    const outra = await oauth.renovarAcesso(CONFIG, "r", dubleDoFetch(json({ error: "internal_failure" }, 500)).buscar).catch(e => e);
    expect(outra).toBeInstanceOf(oauth.RecusaDaGoogle);
    expect(outra).not.toBeInstanceOf(oauth.ConexaoGoogleRevogada);
  });
});

describe("a revogação", () => {
  it("manda o token no corpo do POST, nunca na URL; 200 é true", async () => {
    const duble = dubleDoFetch(new Response(null, { status: 200 }));
    expect(await oauth.revogarToken("refresh-1", duble.buscar)).toBe(true);
    expect(duble.chamadas[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(duble.corpo().get("token")).toBe("refresh-1");
  });

  it("token que já não valia (400 invalid_token) também é true: não abre mais nada", async () => {
    expect(await oauth.revogarToken("t", dubleDoFetch(json({ error: "invalid_token" }, 400)).buscar)).toBe(true);
  });

  it("outra recusa, servidor fora e rede fora são false, sem lançar", async () => {
    expect(await oauth.revogarToken("t", dubleDoFetch(json({ error: "invalid_request" }, 400)).buscar)).toBe(false);
    expect(await oauth.revogarToken("t", dubleDoFetch(new Response("", { status: 503 })).buscar)).toBe(false);
    expect(await oauth.revogarToken("t", dubleDoFetch(new TypeError("fetch failed")).buscar)).toBe(false);
  });
});

describe("o escopo da agenda e o e-mail do id_token", () => {
  it("sem a agenda (desmarcada no consentimento granular), a conexão não serve", () => {
    expect(oauth.temEscopoDaAgenda(["openid", "https://www.googleapis.com/auth/calendar.events"])).toBe(true);
    expect(oauth.temEscopoDaAgenda(["openid", "https://www.googleapis.com/auth/userinfo.email"])).toBe(false);
    expect(oauth.temEscopoDaAgenda(["https://www.googleapis.com/auth/calendar.events.readonly"])).toBe(false);
  });

  it("lê a conta Google (o sub) e o e-mail quando o token é para este cliente e vem da Google", () => {
    const base = { iss: "https://accounts.google.com", aud: CONFIG.clientId, sub: "110169484474386276334", email: "Dona@Exemplo.com" };
    expect(oauth.identidadeDoIdToken(idToken(base), CONFIG.clientId)).toEqual({ sub: "110169484474386276334", email: "dona@exemplo.com" });
    expect(oauth.identidadeDoIdToken(idToken({ ...base, iss: "accounts.google.com", aud: ["outro", CONFIG.clientId] }), CONFIG.clientId))
      .toEqual({ sub: "110169484474386276334", email: "dona@exemplo.com" });
    // O e-mail é só para a tela: sem ele (ou estranho), a conta vale assim mesmo.
    expect(oauth.identidadeDoIdToken(idToken({ ...base, email: undefined }), CONFIG.clientId)).toEqual({ sub: "110169484474386276334", email: null });
    expect(oauth.identidadeDoIdToken(idToken({ ...base, email: "sem-arroba" }), CONFIG.clientId)).toEqual({ sub: "110169484474386276334", email: null });
  });

  it("sem o sub (ou com um sub fora do formato), outro destinatário, outro emissor ou token quebrado: null", () => {
    const base = { iss: "https://accounts.google.com", aud: CONFIG.clientId, sub: "123", email: "dona@exemplo.com" };
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: undefined }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: "" }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: 123 }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: "com espaço" }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: "1".repeat(256) }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, sub: "1".repeat(255) }), CONFIG.clientId)).toMatchObject({ sub: "1".repeat(255) });
    expect(oauth.identidadeDoIdToken(idToken({ ...base, aud: "outro-cliente" }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(idToken({ ...base, iss: "https://evil.example" }), CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken("a.b", CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken("a.%%%.c", CONFIG.clientId)).toBeNull();
    expect(oauth.identidadeDoIdToken(null, CONFIG.clientId)).toBeNull();
  });
});
