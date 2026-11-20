import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { agendaReunioes, auditLogs, googleAgendaConexoes, meetings, users } = await import("../drizzle/schema");
const agenda = await import("./agenda-de-reunioes");
const conexaoGoogle = await import("./google-agenda");
const { URL_DOS_EVENTOS } = await import("./google-agenda-eventos");
const { appRouter } = await import("./routers");

/**
 * A agenda na Google Agenda (H16c) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Precisa da
 * migração das colunas agenda_reunioes.google e google_convites, que a
 * integração do pacote gera. A Google é sempre um fetch dublado: nada sai da
 * máquina.
 *
 * Prova o que o banco falso não prova: as colunas novas nascem nula e falsa; o
 * estado na Google é gravado de verdade pela rota (pendente, ok, falhou); o
 * CASE da mudança sem a Google Agenda deixa "falhou" só a reunião que já foi
 * para lá; a ficha (updated_at) segura o "ok" quando a gravação é ligada no
 * meio do envio; e a exclusão tira o evento depois de apagar a linha. E mais:
 * o estado é da conta Google conectada (desconectar e conectar outra conta o
 * zeram, pela subconsulta do openId; reconectar a mesma conta não); a
 * reunião que já acabou não é criada na Google, a mudança dela não avisa
 * ninguém, e a exclusão dela não chama a Google; sem a Google Agenda, a
 * exclusão da que foi para lá volta "falhou".
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-agenda-google-${crypto.randomUUID()}`;
const PROVA = { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" };
const HORA = 60 * 60_000;
let idDaDona = 0;

const entrada = (extra: Record<string, unknown> = {}) => ({
  titulo: "Conversa com a Bia",
  inicioEm: Date.now() + 24 * HORA,
  duracaoMinutos: 60,
  fuso: "America/Sao_Paulo",
  local: "https://meet.google.com/abc-defg-hij",
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }],
  lembreteMinutos: 15,
  ...extra,
});

const rota = () => appRouter.createCaller({
  user: { id: idDaDona, openId: DONA, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
} as never);

type Chamada = { url: string; metodo: string; corpo: Record<string, unknown> | null };
let chamadas: Chamada[] = [];

/** A Google de mentira, no fetch global: cada chamada tira a próxima resposta; uma função roda antes de responder. */
function google(...respostas: Array<Response | (() => Promise<Response>)>) {
  const dublê = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, metodo: String(init?.method), corpo: init?.body ? JSON.parse(String(init.body)) : null });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    return typeof proxima === "function" ? proxima() : proxima;
  });
  vi.stubGlobal("fetch", dublê);
  return dublê;
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const erroDaGoogle = (status: number, reason: string) => json({ error: { code: status, errors: [{ reason }] } }, status);
const hex = (id: string) => id.replace(/-/g, "");

async function linhaDaAgenda(id: string) {
  const [linha] = await (await getDb())!.select().from(agendaReunioes).where(eq(agendaReunioes.id, id));
  return linha;
}

async function conectar(sub = "sub-da-dona", refreshToken = "refresh-da-dona") {
  // Grava a conexão de verdade; o token de acesso dela fica em memória, e a Google só é chamada para os eventos.
  await conexaoGoogle.gravarConexaoGoogle(idDaDona, {
    refreshToken, sub, email: "dona@exemplo.com",
    escopos: ["openid", "https://www.googleapis.com/auth/calendar.events"],
    acesso: { token: "acesso-da-dona", expiraEm: Date.now() + HORA },
  }, PROVA);
}

/** A reunião passa a ser de ontem, com o evento ainda na Google (o tempo passou). */
async function jaAcabou(id: string) {
  await (await getDb())!.update(agendaReunioes).set({ inicioEm: Date.now() - 24 * HORA }).where(eq(agendaReunioes.id, id));
}

async function desconectarNoBanco() {
  conexaoGoogle.esquecerAcesso(idDaDona);
  await apagarPelaChave((await getDb())!, googleAgendaConexoes, eq(googleAgendaConexoes.userId, idDaDona));
}

describe.skipIf(!temBanco)("Agenda na Google Agenda (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId: DONA, onboardingCompleted: true });
    const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
    idDaDona = conta.id;
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await apagarPelaChave(db, agendaReunioes, eq(agendaReunioes.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    if (idDaDona) {
      await apagarPelaChave(db, googleAgendaConexoes, eq(googleAgendaConexoes.userId, idDaDona));
      await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, [idDaDona]));
    }
    await db.delete(users).where(eq(users.openId, DONA));
  });
  beforeEach(async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id-do-cliente.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "segredo-do-cliente");
    vi.stubEnv("FRONTEND_URL", "https://wrwglobal.org");
    vi.stubEnv("VAULT_ENCRYPTION_KEY", "chave-do-cofre-de-teste-com-mais-de-32");
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "todas");
    chamadas = [];
    await conectar();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await desconectarNoBanco();
  });

  it("sem a Google Agenda, a reunião nasce fora dela: google nulo e o convite desmarcado", async () => {
    await desconectarNoBanco();
    google();
    const { id, naGoogle } = await rota().agenda.criar(entrada());
    expect(naGoogle).toBeNull();
    expect(await linhaDaAgenda(id)).toMatchObject({ google: null, googleConvites: false });
    expect(chamadas).toEqual([]);
  });

  it("com a Google Agenda: o banco grava, a Google cria o evento com o id da reunião e sem convite, e a linha fica 'ok'", async () => {
    google(json({ id: "evento" }));
    const resultado = await rota().agenda.criar(entrada());
    expect(resultado).toMatchObject({ naGoogle: "ok" });
    expect(await linhaDaAgenda(resultado.id)).toMatchObject({ google: "ok", googleConvites: false });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ metodo: "POST", url: `${URL_DOS_EVENTOS}?sendUpdates=none` });
    // Sem o convite marcado, os participantes não entram no evento: a Google daria a cada um uma cópia dele.
    expect(chamadas[0].corpo).toMatchObject({ id: hex(resultado.id), summary: "Conversa com a Bia", attendees: [] });
    // A tela lê o estado e o convite pela lista.
    const { proximas } = await rota().agenda.listar();
    expect(proximas.find(r => r.id === resultado.id)).toMatchObject({ google: "ok", googleConvites: false });
  });

  it("mudar com o convite marcado: 409 vira PATCH com sendUpdates=all e os convidados, e a linha volta a 'ok'", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada());
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().agenda.atualizar({ ...entrada({ titulo: "Conversa com a Bia e a Cris" }), googleConvites: true, id })).toMatchObject({ naGoogle: "ok" });
    expect(chamadas.at(-1)?.corpo).toMatchObject({ attendees: [{ email: "ana@exemplo.com", displayName: "Ana" }] });
    expect(chamadas.slice(1).map(c => [c.metodo, c.url])).toEqual([
      ["POST", `${URL_DOS_EVENTOS}?sendUpdates=all`],
      ["PATCH", `${URL_DOS_EVENTOS}/${hex(id)}?sendUpdates=all`],
    ]);
    expect(await linhaDaAgenda(id)).toMatchObject({ google: "ok", googleConvites: true, titulo: "Conversa com a Bia e a Cris" });
  });

  it("a Google fora do ar: a reunião fica salva, 'falhou'; o Tentar de novo a deixa 'ok'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google(erroDaGoogle(503, "backendError"));
    const resultado = await rota().agenda.criar(entrada());
    expect(resultado).toMatchObject({ naGoogle: "falhou", motivo: "google" });
    expect(await linhaDaAgenda(resultado.id)).toMatchObject({ google: "falhou", titulo: "Conversa com a Bia" });
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().agenda.mandarParaGoogle({ id: resultado.id })).toEqual({ naGoogle: "ok" });
    expect((await linhaDaAgenda(resultado.id)).google).toBe("ok");
  });

  it("mudar sem a Google Agenda: a reunião que já foi para lá fica 'falhou'; a que nunca foi continua nula", async () => {
    google(json({ id: "evento" }));
    const { id: foi } = await rota().agenda.criar(entrada());
    await desconectarNoBanco();
    const { id: nuncaFoi } = await rota().agenda.criar(entrada({ titulo: "Nunca foi" }));
    expect(await rota().agenda.atualizar({ ...entrada({ titulo: "Mudou" }), id: foi })).toEqual({ id: foi, naGoogle: null });
    expect(await rota().agenda.atualizar({ ...entrada({ titulo: "Mudou também" }), id: nuncaFoi })).toEqual({ id: nuncaFoi, naGoogle: null });
    expect((await linhaDaAgenda(foi)).google).toBe("falhou");
    expect((await linhaDaAgenda(nuncaFoi)).google).toBeNull();
  });

  it("a ficha: a gravação ligada pelo Gravar agora no meio do envio não impede o 'ok'", async () => {
    const id = crypto.randomUUID();
    const agora = Date.now();
    await (await getDb())!.insert(meetings).values({ id, ownerId: DONA, title: "Gravação", status: "ready", consentGranted: true, createdAt: agora, updatedAt: agora });
    google(async () => {
      // Enquanto a Google responde, a gravação é ligada: a linha muda (updated_at), o evento não.
      const marcada = (await (await getDb())!.select({ id: agendaReunioes.id }).from(agendaReunioes).where(eq(agendaReunioes.ownerId, DONA)))
        .find(r => hex(r.id) === chamadas.at(-1)!.corpo!.id)!;
      await new Promise(resolver => setTimeout(resolver, 5));
      await agenda.ligarGravacaoNaAgenda(DONA, marcada.id, id);
      return json({ id: "evento" });
    });
    const resultado = await rota().agenda.criar(entrada());
    expect(resultado).toMatchObject({ naGoogle: "ok" });
    expect(await linhaDaAgenda(resultado.id)).toMatchObject({ google: "ok", meetingId: id });
  });

  it("excluir apaga a linha e depois tira o evento; o Tentar de novo da exclusão só vale para a reunião que saiu", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada());
    google(new Response(null, { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await rota().agenda.excluir({ id })).toEqual({ ok: true, avisarConvidados: false, naGoogle: "falhou", motivo: "google" });
    expect(await linhaDaAgenda(id)).toBeUndefined();
    expect(chamadas.at(-1)).toMatchObject({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${hex(id)}?sendUpdates=none` });
    google(erroDaGoogle(410, "deleted"));
    expect(await rota().agenda.tirarDaGoogle({ id, avisarConvidados: false })).toEqual({ naGoogle: "ok" });
    // A reunião que está na agenda não sai da Google por aqui.
    google(json({ id: "evento" }));
    const { id: naAgenda } = await rota().agenda.criar(entrada());
    await expect(rota().agenda.tirarDaGoogle({ id: naAgenda, avisarConvidados: false })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("excluir a reunião que nunca foi para a Google: com a Google conectada, o DELETE é tentado (404 conta como tirado), e a resposta é nula", async () => {
    await desconectarNoBanco();
    const { id } = await rota().agenda.criar(entrada());
    await conectar();
    google(erroDaGoogle(404, "notFound"));
    expect(await rota().agenda.excluir({ id })).toEqual({ ok: true, avisarConvidados: false, naGoogle: null });
    expect(chamadas).toEqual([expect.objectContaining({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${hex(id)}?sendUpdates=none` })]);
  });

  it("a conta Google é outra: desconectar zera o estado, e com a conta B a lista mostra a reunião fora da Google ('Pôr na Google Agenda' de volta)", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada({ googleConvites: true }));
    expect((await linhaDaAgenda(id)).google).toBe("ok");
    await conexaoGoogle.desconectarGoogleAgenda(idDaDona, PROVA, vi.fn(async () => new Response(null, { status: 200 })));
    expect((await linhaDaAgenda(id)).google).toBeNull();
    await conectar("sub-da-conta-b", "refresh-da-conta-b");
    const { proximas } = await rota().agenda.listar();
    expect(proximas.find(r => r.id === id)).toMatchObject({ google: null, googleConvites: true });
  });

  it("reconectar a MESMA conta mantém o estado; o Reconectar da conexão revogada escolhendo outra conta o zera", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada());
    await conectar();
    expect((await linhaDaAgenda(id)).google).toBe("ok");
    await (await getDb())!.update(googleAgendaConexoes).set({ falha: "revogada" }).where(eq(googleAgendaConexoes.userId, idDaDona));
    await conectar("sub-da-conta-b", "refresh-da-conta-b");
    expect((await linhaDaAgenda(id)).google).toBeNull();
  });

  it("desconectar e reconectar a MESMA conta: o estado zerado não impede a exclusão de tirar o evento, com o cancelamento aos convidados", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada({ googleConvites: true }));
    await conexaoGoogle.desconectarGoogleAgenda(idDaDona, PROVA, vi.fn(async () => new Response(null, { status: 200 })));
    await conectar();
    google(new Response(null, { status: 204 }));
    const antes = chamadas.length;
    expect(await rota().agenda.excluir({ id })).toEqual({ ok: true, avisarConvidados: true, naGoogle: null });
    expect(chamadas.slice(antes)).toEqual([expect.objectContaining({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${hex(id)}?sendUpdates=all` })]);
  });

  it("marcar uma reunião que já acabou: fica só na WRW, sem evento nem convite na Google", async () => {
    google();
    const { id, naGoogle } = await rota().agenda.criar(entrada({ inicioEm: Date.now() - 24 * HORA, googleConvites: true }));
    expect(naGoogle).toBeNull();
    expect(await linhaDaAgenda(id)).toMatchObject({ google: null, googleConvites: true });
    expect(chamadas).toEqual([]);
  });

  it("mudar a reunião que já acabou: só o PATCH, com sendUpdates=none, mesmo com o convite marcado", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada({ googleConvites: true }));
    await jaAcabou(id);
    google(json({ id: "evento" }));
    const antes = chamadas.length;
    const ontem = (await linhaDaAgenda(id)).inicioEm;
    expect(await rota().agenda.atualizar({ ...entrada({ titulo: "Ata da conversa", inicioEm: ontem }), googleConvites: true, id })).toEqual({ id, naGoogle: "ok" });
    expect(chamadas.slice(antes).map(c => [c.metodo, c.url])).toEqual([["PATCH", `${URL_DOS_EVENTOS}/${hex(id)}?sendUpdates=none`]]);
    expect((await linhaDaAgenda(id)).google).toBe("ok");
  });

  it("excluir a reunião que já acabou não chama a Google: o evento fica como histórico, e ninguém recebe o cancelamento", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada({ googleConvites: true }));
    await jaAcabou(id);
    google();
    const antes = chamadas.length;
    expect(await rota().agenda.excluir({ id })).toEqual({ ok: true, avisarConvidados: false, naGoogle: null });
    expect(await linhaDaAgenda(id)).toBeUndefined();
    expect(chamadas.slice(antes)).toEqual([]);
  });

  it("excluir a que foi para a Google, sem a Google Agenda agora (a conta saiu da lista do modo Teste): 'falhou' com o motivo", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().agenda.criar(entrada());
    vi.stubEnv("GOOGLE_AGENDA_LIBERADA_PARA", "");
    google();
    const antes = chamadas.length;
    expect(await rota().agenda.excluir({ id })).toEqual({ ok: true, avisarConvidados: false, naGoogle: "falhou", motivo: "nao-conectada" });
    expect(await linhaDaAgenda(id)).toBeUndefined();
    expect(chamadas.slice(antes)).toEqual([]);
  });
});
