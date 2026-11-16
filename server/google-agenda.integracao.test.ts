import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { auditLogs, googleAgendaConexoes, users } = await import("../drizzle/schema");
const servico = await import("./google-agenda");
const { ConexaoGoogleRevogada, URL_DE_REVOGACAO } = await import("./google-oauth");
const { decryptData } = await import("./security");
const { excluirConta } = await import("./exclusao-de-conta");

/**
 * A conexão com a Google Agenda (H16b) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Precisa da
 * migração da tabela google_agenda_conexoes, que a integração do pacote gera.
 * A Google é sempre um fetch dublado: nada sai da máquina.
 *
 * Prova o que o banco falso não prova: o token fica cifrado de verdade na
 * coluna TEXT e se lê de volta; o índice único deixa uma conexão por conta
 * (reconectar troca a linha); a prova entra em audit_logs junto; a marcação de
 * "revogada" acha a linha pelo texto cifrado; desconectar e excluir a conta
 * apagam a linha, com a revogação na Google.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-google-${crypto.randomUUID()}`;
const EXCLUIDA = `teste-google-${crypto.randomUUID()}`;
const PROVA = { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" };
const ESCOPOS = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/calendar.events"];
let idDaDona = 0;
let idDaExcluida = 0;

const conexao = (refreshToken: string) => ({
  refreshToken, email: "dona@exemplo.com", escopos: ESCOPOS, acesso: { token: `acesso-de-${refreshToken}`, expiraEm: Date.now() + 3_600_000 },
});
const lerJson = (valor: unknown) => (typeof valor === "string" ? JSON.parse(valor) : valor) as Record<string, unknown>;

async function linhasDa(userId: number) {
  return (await getDb())!.select().from(googleAgendaConexoes).where(eq(googleAgendaConexoes.userId, userId));
}
async function provasDa(userId: number, acao: string) {
  return (await getDb())!.select({ details: auditLogs.details, ipAddress: auditLogs.ipAddress })
    .from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, acao))).orderBy(desc(auditLogs.id));
}
function google(...respostas: Response[]) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    return proxima;
  });
}

describe.skipIf(!temBanco)("Google Agenda (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: EXCLUIDA }]);
    const contas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [DONA, EXCLUIDA]));
    idDaDona = contas.find(conta => conta.openId === DONA)!.id;
    idDaExcluida = contas.find(conta => conta.openId === EXCLUIDA)!.id;
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const ids = [idDaDona, idDaExcluida].filter(Boolean);
    if (ids.length) {
      await db.delete(googleAgendaConexoes).where(inArray(googleAgendaConexoes.userId, ids));
      await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
    }
    await db.delete(users).where(inArray(users.openId, [DONA, EXCLUIDA]));
  });
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id-do-cliente.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "segredo-do-cliente");
    vi.stubEnv("FRONTEND_URL", "https://wrwglobal.org");
    vi.stubEnv("VAULT_ENCRYPTION_KEY", "chave-do-cofre-de-teste-com-mais-de-32");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("grava o refresh token cifrado (diferente do texto e legível de volta) e a prova junto", async () => {
    expect(await servico.gravarConexaoGoogle(idDaDona, conexao("refresh-1"), PROVA)).toEqual({ anterior: null });
    const [linha, ...outras] = await linhasDa(idDaDona);
    expect(outras).toEqual([]);
    expect(linha.refreshTokenCifrado).not.toContain("refresh-1");
    expect(decryptData(linha.refreshTokenCifrado)).toBe("refresh-1");
    expect(linha).toMatchObject({ emailGoogle: "dona@exemplo.com", falha: null });
    expect(linha.escopos.split(" ").sort()).toEqual([...ESCOPOS].sort());
    const [prova] = await provasDa(idDaDona, servico.ACAO_GOOGLE_CONECTADA);
    expect(lerJson(prova.details)).toMatchObject({ reconexao: false });
    expect(prova.ipAddress).toBe("203.0.113.9");
  });

  it("reconectar troca a linha (uma por conta) e devolve o token anterior para revogar", async () => {
    expect(await servico.gravarConexaoGoogle(idDaDona, conexao("refresh-2"), PROVA)).toEqual({ anterior: "refresh-1" });
    const linhas = await linhasDa(idDaDona);
    expect(linhas).toHaveLength(1);
    expect(decryptData(linhas[0].refreshTokenCifrado)).toBe("refresh-2");
    const provas = await provasDa(idDaDona, servico.ACAO_GOOGLE_CONECTADA);
    expect(provas).toHaveLength(2);
    expect(lerJson(provas[0].details)).toMatchObject({ reconexao: true });
  });

  it("o estado lê a conexão, sem o token", async () => {
    const estado = await servico.estadoDaGoogleAgenda(idDaDona);
    expect(estado).toEqual({ disponivel: true, origem: "https://wrwglobal.org", conectada: true, email: "dona@exemplo.com", falha: null });
  });

  it("invalid_grant marca a linha de verdade, achada pelo texto cifrado; reconectar limpa a marca", async () => {
    servico.esquecerAcesso(idDaDona);
    const recusa = google(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(servico.tokenDeAcessoDaGoogleAgenda(idDaDona, recusa)).rejects.toBeInstanceOf(ConexaoGoogleRevogada);
    expect((await linhasDa(idDaDona))[0].falha).toBe("revogada");
    expect(await servico.estadoDaGoogleAgenda(idDaDona)).toMatchObject({ conectada: true, falha: "revogada" });
    await servico.gravarConexaoGoogle(idDaDona, conexao("refresh-3"), PROVA);
    expect((await linhasDa(idDaDona))[0].falha).toBeNull();
  });

  it("desconectar revoga na Google, apaga a linha e grava a prova", async () => {
    const revogacao = google(new Response(null, { status: 200 }));
    expect(await servico.desconectarGoogleAgenda(idDaDona, PROVA, revogacao)).toEqual({ googleNaoConfirmou: false });
    expect(new URLSearchParams(String(revogacao.mock.calls[0][1]?.body)).get("token")).toBe("refresh-3");
    expect(await linhasDa(idDaDona)).toEqual([]);
    const [prova] = await provasDa(idDaDona, servico.ACAO_GOOGLE_DESCONECTADA);
    expect(lerJson(prova.details)).toEqual({ revogadaNaGoogle: true });
    expect(await servico.estadoDaGoogleAgenda(idDaDona)).toEqual({ disponivel: true, origem: "https://wrwglobal.org", conectada: false });
  });

  it("excluir a conta revoga o token na Google e leva a conexão junto", async () => {
    await servico.gravarConexaoGoogle(idDaExcluida, conexao("refresh-da-excluida"), PROVA);
    const revogacao = google(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revogacao);
    const relatorio = await excluirConta((await getDb())!, { id: idDaExcluida, openId: EXCLUIDA, email: null }, { apagarArquivo: async () => undefined });
    expect(relatorio.googleAgenda).toBe("revogada");
    expect(revogacao).toHaveBeenCalledTimes(1);
    expect(revogacao.mock.calls[0][0]).toBe(URL_DE_REVOGACAO);
    expect(new URLSearchParams(String(revogacao.mock.calls[0][1]?.body)).get("token")).toBe("refresh-da-excluida");
    expect(await linhasDa(idDaExcluida)).toEqual([]);
    expect(relatorio.passos.map(passo => passo.nome)).toContain("google_agenda_conexoes.userId");
  });
});
