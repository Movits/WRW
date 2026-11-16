import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLogs, googleAgendaConexoes } from "../drizzle/schema";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A conexão com a Google Agenda no banco (H16b), contra um banco falso que
 * guarda cada efeito na ordem (SELECT, INSERT, DELETE, UPDATE e o começo e o
 * fim da transação) e um fetch dublado no lugar da Google. Prova:
 * - o refresh token entra cifrado, e a prova do consentimento entra na MESMA
 *   transação (sem ela, a conexão não fica);
 * - desconectar revoga na Google ANTES de apagar, e apaga mesmo sem a
 *   confirmação dela;
 * - o token de acesso vem da memória enquanto vale, e o invalid_grant marca a
 *   conexão (a tela pede "Reconectar");
 * - a exclusão da conta revoga o token;
 * - revogar é decidido pela conta Google (o sub), porque a Google revoga a
 *   autorização inteira da conta no projeto: reconectar com a mesma conta não
 *   revoga nada, e nada se revoga enquanto outra conta da WRW usa a mesma conta
 *   Google;
 * - fora de GOOGLE_AGENDA_LIBERADA_PARA (modo Teste), a função some.
 * O banco de verdade está em google-agenda.integracao.test.ts.
 */

type Efeito = {
  tipo: "select" | "insert" | "delete" | "update" | "transacao" | "fim-da-transacao" | "google";
  tabela?: unknown;
  valores?: Record<string, unknown>;
  aoDuplicar?: Record<string, unknown>;
  condicao?: unknown;
};
let efeitos: Efeito[] = [];
let linhas: Array<Record<string, unknown>> = [];
let falharNaAuditoria = false;

function ler(tabela: unknown) {
  return {
    where: (condicao: unknown) => {
      efeitos.push({ tipo: "select", tabela, condicao });
      const resultado = Promise.resolve(linhas.map(linha => ({ ...linha })));
      return Object.assign(resultado, { limit: () => resultado });
    },
  };
}

const fakeDb = {
  select: () => ({ from: ler }),
  insert: (tabela: unknown) => ({
    values: (valores: Record<string, unknown>) => {
      const gravar = (aoDuplicar?: Record<string, unknown>) => {
        if (tabela === auditLogs && falharNaAuditoria) return Promise.reject(new Error("a auditoria não gravou"));
        efeitos.push({ tipo: "insert", tabela, valores, aoDuplicar });
        return Promise.resolve([{ affectedRows: 1 }]);
      };
      let gravacao: Promise<unknown> | null = null;
      return {
        onDuplicateKeyUpdate: (config: { set: Record<string, unknown> }) => gravar(config.set),
        then: (ok: (valor: unknown) => unknown, falha: (erro: unknown) => unknown) => (gravacao ??= gravar()).then(ok, falha),
      };
    },
  }),
  delete: (tabela: unknown) => ({
    where: async (condicao: unknown) => {
      efeitos.push({ tipo: "delete", tabela, condicao });
      return [{ affectedRows: 1 }];
    },
  }),
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao: unknown) => {
        efeitos.push({ tipo: "update", tabela, valores, condicao });
        return [{ affectedRows: 1 }];
      },
    }),
  }),
  transaction: async (trabalho: (tx: unknown) => Promise<unknown>) => {
    efeitos.push({ tipo: "transacao" });
    const resultado = await trabalho(fakeDb);
    efeitos.push({ tipo: "fim-da-transacao" });
    return resultado;
  },
};

vi.mock("./db", () => ({ exigirDb: async () => fakeDb, getDb: async () => fakeDb }));

const servico = await import("./google-agenda");
const { ConexaoGoogleRevogada, RecusaDaGoogle } = await import("./google-oauth");
const { decryptData, encryptData } = await import("./security");

const dialeto = new MySqlDialect();
const renderizar = (condicao: unknown) => dialeto.sqlToQuery(condicao as SQL);

const ESCOPO = "https://www.googleapis.com/auth/calendar.events";
const PROVA = { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" };

function dubleDaGoogle(...respostas: Array<Response | Error>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    efeitos.push({ tipo: "google", valores: { url, corpo: String(init?.body ?? "") } });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const corpoDe = (efeito: Efeito) => new URLSearchParams(String(efeito.valores?.corpo));
const tipos = () => efeitos.map(efeito => efeito.tipo);

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id-do-cliente.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "segredo-do-cliente");
  vi.stubEnv("FRONTEND_URL", "https://wrwglobal.org");
  vi.stubEnv("VAULT_ENCRYPTION_KEY", "chave-do-cofre-de-teste-com-mais-de-32");
  vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "todas");
  efeitos = [];
  linhas = [];
  falharNaAuditoria = false;
  servico.esquecerAcesso(7);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** A linha da conexão como o banco falso a devolve: o token cifrado, a conta Google e a conta da WRW. */
const linhaDa = (refreshToken: string, sub = "sub-da-dona", userId = 7) => ({ versao: encryptData(refreshToken), sub, userId, falha: null });
/** As consultas pela conta Google (o sub), não pela conta da WRW. */
const consultasPeloSub = () => efeitos.filter(e => e.tipo === "select" && renderizar(e.condicao).sql.includes("`google_sub` = ?"));

describe("o estado para o Perfil", () => {
  it("sem as variáveis, só 'indisponível', sem perguntar ao banco", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    expect(await servico.estadoDaGoogleAgenda(7)).toEqual({ disponivel: false });
    expect(efeitos).toEqual([]);
  });

  it("em modo Teste, a conta fora de GOOGLE_AGENDA_LIBERADA_PARA não vê a função, e o banco nem é lido", async () => {
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "3, 9");
    expect(await servico.estadoDaGoogleAgenda(7)).toEqual({ disponivel: false });
    expect(efeitos).toEqual([]);
    expect(await servico.estadoDaGoogleAgenda(9)).toEqual({ disponivel: true, origem: "https://wrwglobal.org", conectada: false });
    // Sem a variável, ninguém: esquecê-la não põe um botão quebrado diante de todas.
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "");
    expect(await servico.estadoDaGoogleAgenda(9)).toEqual({ disponivel: false });
  });

  it("sem conexão: disponível, com a origem do FRONTEND_URL; a consulta leva a conta", async () => {
    expect(await servico.estadoDaGoogleAgenda(7)).toEqual({ disponivel: true, origem: "https://wrwglobal.org", conectada: false });
    expect(renderizar(efeitos[0].condicao).params).toEqual([7]);
    expect(efeitos[0].tabela).toBe(googleAgendaConexoes);
  });

  it("com conexão: o e-mail e a falha, nunca o token", async () => {
    linhas = [{ email: "dona@exemplo.com", falha: null }];
    expect(await servico.estadoDaGoogleAgenda(7)).toEqual({ disponivel: true, origem: "https://wrwglobal.org", conectada: true, email: "dona@exemplo.com", falha: null });
    linhas = [{ email: null, falha: "revogada" }];
    expect(await servico.estadoDaGoogleAgenda(7)).toMatchObject({ conectada: true, email: null, falha: "revogada" });
  });
});

describe("gravar a conexão que voltou da Google", () => {
  const conexao = {
    refreshToken: "refresh-novo",
    sub: "sub-da-dona",
    email: "dona@exemplo.com",
    escopos: [ESCOPO, "openid", ESCOPO, "https://www.googleapis.com/auth/userinfo.email"],
    acesso: { token: "acesso-novo", expiraEm: Date.now() + 3_600_000 },
  };

  it("o token entra cifrado (e se lê de volta), com a conta Google, e a prova entra na mesma transação", async () => {
    expect(await servico.gravarConexaoGoogle(7, conexao, PROVA, 1_000)).toEqual({ anterior: null });
    expect(tipos()).toEqual(["transacao", "select", "insert", "insert", "fim-da-transacao"]);

    const conexaoGravada = efeitos[2];
    expect(conexaoGravada.tabela).toBe(googleAgendaConexoes);
    const valores = conexaoGravada.valores!;
    expect(valores).toMatchObject({
      userId: 7, googleSub: "sub-da-dona", emailGoogle: "dona@exemplo.com", falha: null, createdAt: 1_000, updatedAt: 1_000,
      escopos: `${ESCOPO} https://www.googleapis.com/auth/userinfo.email openid`,
    });
    expect(valores.refreshTokenCifrado).not.toContain("refresh-novo");
    expect(decryptData(String(valores.refreshTokenCifrado))).toBe("refresh-novo");
    // Reconectar troca a linha da conta, com a falha zerada e a conta Google nova.
    expect(conexaoGravada.aoDuplicar).toMatchObject({
      refreshTokenCifrado: valores.refreshTokenCifrado, googleSub: "sub-da-dona", falha: null, emailGoogle: "dona@exemplo.com", updatedAt: 1_000,
    });

    const prova = efeitos[3];
    expect(prova.tabela).toBe(auditLogs);
    expect(prova.valores).toMatchObject({
      userId: 7, action: servico.ACAO_GOOGLE_CONECTADA, resource: "google_agenda", status: "success",
      ipAddress: "203.0.113.9", userAgent: "Navegador de teste",
      details: { escopos: [ESCOPO, "https://www.googleapis.com/auth/userinfo.email", "openid"], reconexao: false, trocouDeContaGoogle: false },
    });
    // A prova não guarda token, e-mail nem o id da conta Google.
    expect(JSON.stringify(prova.valores)).not.toContain("refresh-novo");
    expect(JSON.stringify(prova.valores)).not.toContain("dona@exemplo.com");
    expect(JSON.stringify(prova.valores)).not.toContain("sub-da-dona");
  });

  it("reconectar com a MESMA conta Google não devolve nada para revogar: os dois tokens são da mesma autorização", async () => {
    // A Google revoga por conta e projeto: revogar o anterior derrubaria a conexão nova.
    linhas = [linhaDa("refresh-antigo", "sub-da-dona")];
    expect(await servico.gravarConexaoGoogle(7, conexao, PROVA)).toEqual({ anterior: null });
    expect(efeitos.find(e => e.tabela === auditLogs)?.valores?.details).toMatchObject({ reconexao: true, trocouDeContaGoogle: false });
    expect(consultasPeloSub()).toEqual([]);
  });

  it("reconectar com OUTRA conta Google devolve o anterior decifrado, para a rota revogá-lo", async () => {
    linhas = [linhaDa("refresh-antigo", "sub-de-outra-conta-google")];
    expect(await servico.gravarConexaoGoogle(7, conexao, PROVA)).toEqual({ anterior: "refresh-antigo" });
    expect(efeitos.find(e => e.tabela === auditLogs)?.valores?.details).toMatchObject({ reconexao: true, trocouDeContaGoogle: true });
    // A conta Google anterior é procurada pelo sub dela, dentro da transação.
    const [consulta] = consultasPeloSub();
    expect(renderizar(consulta.condicao).params).toEqual(["sub-de-outra-conta-google"]);
    expect(efeitos.indexOf(consulta)).toBeLessThan(tipos().indexOf("fim-da-transacao"));
  });

  it("a conta Google anterior que outra conta da WRW ainda usa não é revogada: derrubaria a conexão dela", async () => {
    linhas = [linhaDa("refresh-antigo", "sub-antigo", 7), linhaDa("refresh-da-outra", "sub-antigo", 8)];
    expect(await servico.gravarConexaoGoogle(7, conexao, PROVA)).toEqual({ anterior: null });
    expect(consultasPeloSub()).toHaveLength(1);
  });

  it("o anterior cifrado com outra chave não se revoga daqui: anterior nulo, sem erro, e o log avisa sem token", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    linhas = [{ versao: "lixo:que:nao-se-le", sub: "sub-de-outra-conta-google", userId: 7 }];
    expect(await servico.gravarConexaoGoogle(7, conexao, PROVA)).toEqual({ anterior: null });
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(String(avisos.mock.calls[0][0])).toContain("não se decifra");
    expect(String(avisos.mock.calls[0][0])).not.toContain("lixo");
  });

  it("sem a prova, a conexão não fica: o erro sobe e a transação não termina", async () => {
    falharNaAuditoria = true;
    await expect(servico.gravarConexaoGoogle(7, conexao, PROVA)).rejects.toThrow("a auditoria não gravou");
    expect(tipos()).not.toContain("fim-da-transacao");
  });

  it("IP e navegador longos entram cortados, como no createAuditLog", async () => {
    await servico.gravarConexaoGoogle(7, conexao, { ipAddress: "1".repeat(60), userAgent: "u".repeat(600) });
    const prova = efeitos.find(e => e.tabela === auditLogs)!.valores!;
    expect(String(prova.ipAddress)).toHaveLength(45);
    expect(String(prova.userAgent)).toHaveLength(500);
  });

  it("o token de acesso que veio na troca fica em memória: a primeira chamada da agenda não vai à Google", async () => {
    await servico.gravarConexaoGoogle(7, conexao, PROVA);
    linhas = [{ versao: efeitos[2].valores!.refreshTokenCifrado, falha: null }];
    const google = dubleDaGoogle();
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-novo");
    expect(google).not.toHaveBeenCalled();
  });
});

describe("desconectar", () => {
  it("revoga na Google ANTES de apagar; apaga e grava a prova na mesma transação", async () => {
    linhas = [linhaDa("refresh-1")];
    const google = dubleDaGoogle(new Response(null, { status: 200 }));
    expect(await servico.desconectarGoogleAgenda(7, PROVA, google)).toEqual({ googleNaoConfirmou: false });
    // A conta da WRW, depois a conta Google (quem mais a usa), depois a Google.
    expect(tipos()).toEqual(["select", "select", "google", "transacao", "delete", "insert", "fim-da-transacao"]);
    expect(renderizar(efeitos[1].condicao).params).toEqual(["sub-da-dona"]);
    expect(corpoDe(efeitos[2]).get("token")).toBe("refresh-1");
    expect(efeitos[4].tabela).toBe(googleAgendaConexoes);
    expect(renderizar(efeitos[4].condicao).params).toEqual([7]);
    expect(efeitos[5].valores).toMatchObject({
      userId: 7, action: servico.ACAO_GOOGLE_DESCONECTADA, details: { revogadaNaGoogle: true, mantidaParaOutraConta: false },
    });
  });

  it("outra conta da WRW na mesma conta Google: nada vai à Google, a linha sai e a tela não manda tirar o acesso", async () => {
    // Revogar derrubaria em silêncio a conexão da outra conta (a Google revoga por conta e projeto).
    linhas = [linhaDa("refresh-1", "sub-da-dona", 7), linhaDa("refresh-da-outra", "sub-da-dona", 8)];
    const google = dubleDaGoogle();
    expect(await servico.desconectarGoogleAgenda(7, PROVA, google)).toEqual({ googleNaoConfirmou: false });
    expect(google).not.toHaveBeenCalled();
    expect(efeitos.find(e => e.tipo === "delete")?.tabela).toBe(googleAgendaConexoes);
    expect(efeitos.find(e => e.tabela === auditLogs)?.valores?.details).toEqual({ revogadaNaGoogle: false, mantidaParaOutraConta: true });
  });

  it("a Google fora do ar não segura a desconexão: a linha sai, e a tela é avisada", async () => {
    linhas = [linhaDa("refresh-1")];
    const google = dubleDaGoogle(new Response("", { status: 503 }));
    expect(await servico.desconectarGoogleAgenda(7, PROVA, google)).toEqual({ googleNaoConfirmou: true });
    expect(tipos()).toContain("delete");
    expect(efeitos.find(e => e.tabela === auditLogs)?.valores?.details).toEqual({ revogadaNaGoogle: false, mantidaParaOutraConta: false });
  });

  it("o token que não se decifra não vai à Google, e a linha sai do mesmo jeito", async () => {
    linhas = [{ versao: "lixo:que:nao-se-le", sub: "sub-da-dona", userId: 7 }];
    const google = dubleDaGoogle();
    expect(await servico.desconectarGoogleAgenda(7, PROVA, google)).toEqual({ googleNaoConfirmou: true });
    expect(google).not.toHaveBeenCalled();
    expect(tipos()).toContain("delete");
  });

  it("desconectar o que não está conectado não é erro, nem vai à Google", async () => {
    const google = dubleDaGoogle();
    expect(await servico.desconectarGoogleAgenda(7, PROVA, google)).toEqual({ googleNaoConfirmou: false });
    expect(tipos()).toEqual(["select"]);
  });

  it("depois de desconectar, o token de acesso guardado não serve mais", async () => {
    await servico.gravarConexaoGoogle(7, { refreshToken: "r", sub: "sub-da-dona", email: null, escopos: [ESCOPO], acesso: { token: "acesso-velho", expiraEm: Date.now() + 3_600_000 } }, PROVA);
    const versao = efeitos[2].valores!.refreshTokenCifrado;
    linhas = [{ versao, sub: "sub-da-dona", userId: 7 }];
    await servico.desconectarGoogleAgenda(7, PROVA, dubleDaGoogle(new Response(null, { status: 200 })));
    // Mesmo que a linha voltasse igual, a memória foi esquecida: renova.
    linhas = [{ versao, falha: null }];
    const google = dubleDaGoogle(json({ access_token: "acesso-renovado", expires_in: 3600 }));
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-renovado");
  });
});

describe("o token de acesso (para a H16c)", () => {
  let versao = "";
  beforeEach(() => {
    versao = encryptData("refresh-1");
    linhas = [{ versao, falha: null }];
  });

  it("sem as variáveis, sem conexão ou com a conexão marcada: cada um com o seu erro, sem ir à Google", async () => {
    const google = dubleDaGoogle();
    linhas = [{ versao, falha: "revogada" }];
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(ConexaoGoogleRevogada);
    linhas = [];
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(servico.GoogleAgendaNaoConectada);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(servico.GoogleAgendaIndisponivel);
    expect(google).not.toHaveBeenCalled();
  });

  it("a conta fora de GOOGLE_AGENDA_LIBERADA_PARA também não tem a função, sem ler o banco", async () => {
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "8");
    const google = dubleDaGoogle();
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(servico.GoogleAgendaIndisponivel);
    expect(efeitos).toEqual([]);
    expect(google).not.toHaveBeenCalled();
  });

  it("renova uma vez e serve da memória até 1 minuto antes de vencer", async () => {
    let agora = 1_000_000;
    const google = dubleDaGoogle(
      json({ access_token: "acesso-1", expires_in: 3600 }),
      json({ access_token: "acesso-2", expires_in: 3600 }),
    );
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google, () => agora)).toBe("acesso-1");
    expect(corpoDe(efeitos.find(e => e.tipo === "google")!).get("refresh_token")).toBe("refresh-1");
    agora += 3_600_000 - servico.MARGEM_DO_ACESSO_MS - 1;
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google, () => agora)).toBe("acesso-1");
    expect(google).toHaveBeenCalledTimes(1);
    agora += 2;
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google, () => agora)).toBe("acesso-2");
    expect(google).toHaveBeenCalledTimes(2);
  });

  it("duas chamadas ao mesmo tempo esperam a mesma renovação", async () => {
    const google = dubleDaGoogle(json({ access_token: "acesso-1", expires_in: 3600 }));
    const [a, b] = await Promise.all([servico.tokenDeAcessoDaGoogleAgenda(7, google), servico.tokenDeAcessoDaGoogleAgenda(7, google)]);
    expect([a, b]).toEqual(["acesso-1", "acesso-1"]);
    expect(google).toHaveBeenCalledTimes(1);
  });

  it("reconectar troca a versão da linha: o token da conexão anterior não é servido", async () => {
    const google = dubleDaGoogle(json({ access_token: "acesso-1", expires_in: 3600 }), json({ access_token: "acesso-da-nova", expires_in: 3600 }));
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-1");
    linhas = [{ versao: encryptData("refresh-da-nova"), falha: null }];
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-da-nova");
    expect(corpoDe(efeitos.filter(e => e.tipo === "google")[1]).get("refresh_token")).toBe("refresh-da-nova");
  });

  it("invalid_grant marca SÓ esta conexão como revogada e avisa quem chamou", async () => {
    const google = dubleDaGoogle(json({ error: "invalid_grant" }, 400));
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(ConexaoGoogleRevogada);
    const marcacao = efeitos.find(e => e.tipo === "update")!;
    expect(marcacao.tabela).toBe(googleAgendaConexoes);
    expect(marcacao.valores).toMatchObject({ falha: "revogada" });
    const { sql, params } = renderizar(marcacao.condicao);
    expect(sql).toContain("`userId` = ?");
    expect(sql).toContain("`refresh_token_cifrado` = ?");
    expect(params).toEqual([7, versao]);
  });

  it("o token que não se decifra mais (a chave do cofre mudou) também marca, sem ir à Google", async () => {
    linhas = [{ versao: "lixo:que:nao-se-le", falha: null }];
    const google = dubleDaGoogle();
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(ConexaoGoogleRevogada);
    expect(google).not.toHaveBeenCalled();
    expect(efeitos.find(e => e.tipo === "update")?.valores).toMatchObject({ falha: "revogada" });
  });

  it("a Google fora do ar NÃO marca a conexão: o erro sobe para tentar de novo depois", async () => {
    const google = dubleDaGoogle(json({ error: "internal_failure" }, 500));
    await expect(servico.tokenDeAcessoDaGoogleAgenda(7, google)).rejects.toBeInstanceOf(RecusaDaGoogle);
    expect(tipos()).not.toContain("update");
  });

  it("o refresh token novo que a Google mandar na renovação toma o lugar do antigo, cifrado", async () => {
    const google = dubleDaGoogle(json({ access_token: "acesso-1", expires_in: 3600, refresh_token: "refresh-2" }));
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-1");
    const troca = efeitos.find(e => e.tipo === "update")!;
    expect(decryptData(String(troca.valores!.refreshTokenCifrado))).toBe("refresh-2");
    expect(renderizar(troca.condicao).params).toEqual([7, versao]);
  });
});

describe("a exclusão da conta revoga o token", () => {
  it("sem conexão: nada vai à Google", async () => {
    const google = dubleDaGoogle();
    expect(await servico.revogarGoogleDaConta(fakeDb as never, 7, google)).toBe("sem-conexao");
    expect(google).not.toHaveBeenCalled();
    expect(renderizar(efeitos[0].condicao).params).toEqual([7]);
  });

  it("com conexão: revoga o refresh token decifrado", async () => {
    linhas = [linhaDa("refresh-1")];
    const google = dubleDaGoogle(new Response(null, { status: 200 }));
    expect(await servico.revogarGoogleDaConta(fakeDb as never, 7, google)).toBe("revogada");
    expect(corpoDe(efeitos.find(e => e.tipo === "google")!).get("token")).toBe("refresh-1");
  });

  it("outra conta da WRW na mesma conta Google: não revoga (derrubaria a dela), e diz isso", async () => {
    linhas = [linhaDa("refresh-1", "sub-da-dona", 7), linhaDa("refresh-da-outra", "sub-da-dona", 8)];
    const google = dubleDaGoogle();
    expect(await servico.revogarGoogleDaConta(fakeDb as never, 7, google)).toBe("mantida-para-outra-conta");
    expect(google).not.toHaveBeenCalled();
    expect(renderizar(consultasPeloSub()[0].condicao).params).toEqual(["sub-da-dona"]);
  });

  it("a Google não confirmou, ou o token não se decifra: lança, e quem exclui anota e segue", async () => {
    linhas = [linhaDa("refresh-1")];
    await expect(servico.revogarGoogleDaConta(fakeDb as never, 7, dubleDaGoogle(new Response("", { status: 503 })))).rejects.toThrow();
    linhas = [{ versao: "lixo:que:nao-se-le", sub: "sub-da-dona", userId: 7 }];
    await expect(servico.revogarGoogleDaConta(fakeDb as never, 7, dubleDaGoogle())).rejects.toThrow();
  });
});

describe("a conta Google em uso (para a volta decidir se pode revogar)", () => {
  it("procura pelo sub, em qualquer conta da WRW, inclusive a de quem está conectando", async () => {
    expect(await servico.contaGoogleEmUso("sub-da-dona")).toBe(false);
    expect(renderizar(efeitos[0].condicao).params).toEqual(["sub-da-dona"]);
    linhas = [linhaDa("refresh-1", "sub-da-dona", 7)];
    expect(await servico.contaGoogleEmUso("sub-da-dona")).toBe(true);
  });
});

describe("para a H16c: a conexão em uso e a renovação depois do 401", () => {
  it("conectada é a função disponível para a conta E a linha gravada, mesmo marcada como revogada", async () => {
    expect(await servico.googleAgendaConectada(7)).toBe(false);
    expect(renderizar(efeitos[0].condicao).params).toEqual([7]);
    linhas = [{ id: "conexao-1" }];
    expect(await servico.googleAgendaConectada(7)).toBe(true);
  });

  it("sem as variáveis, ou com a conta fora da lista, não está conectada, e o banco nem é lido", async () => {
    linhas = [{ id: "conexao-1" }];
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "8");
    expect(await servico.googleAgendaConectada(7)).toBe(false);
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "todas");
    vi.stubEnv("VAULT_ENCRYPTION_KEY", "curta");
    expect(await servico.googleAgendaConectada(7)).toBe(false);
    expect(efeitos).toEqual([]);
  });

  it("renovar esquece o token guardado, que ainda valia, e pede outro à Google", async () => {
    const versao = encryptData("refresh-1");
    linhas = [{ versao, falha: null }];
    const google = dubleDaGoogle(json({ access_token: "acesso-1", expires_in: 3600 }), json({ access_token: "acesso-2", expires_in: 3600 }));
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-1");
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-1");
    expect(await servico.renovarTokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-2");
    expect(google).toHaveBeenCalledTimes(2);
    // O novo fica guardado para as próximas chamadas.
    expect(await servico.tokenDeAcessoDaGoogleAgenda(7, google)).toBe("acesso-2");
  });

  it("a renovação que a Google recusa com invalid_grant marca a conexão, como a renovação de sempre", async () => {
    linhas = [{ versao: encryptData("refresh-1"), falha: null }];
    await expect(servico.renovarTokenDeAcessoDaGoogleAgenda(7, dubleDaGoogle(json({ error: "invalid_grant" }, 400)))).rejects.toBeInstanceOf(ConexaoGoogleRevogada);
    expect(efeitos.find(e => e.tipo === "update")?.valores).toMatchObject({ falha: "revogada" });
  });
});
