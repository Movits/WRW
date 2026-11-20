import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb, createPrivateContact } = await import("./db");
const {
  auditLogs, googleAgendaConexoes, lembretes, meetings, meetingSummaries, meetingSummaryItems, privateContacts, proximasAcoes, users,
} = await import("../drizzle/schema");
const conexaoGoogle = await import("./google-agenda");
const { URL_DOS_EVENTOS } = await import("./google-agenda-eventos");
const { appRouter } = await import("./routers");

/**
 * A próxima ação na Google Agenda (H5c) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Precisa da
 * migração da coluna proximas_acoes.google, que a integração do pacote gera. A
 * Google é sempre um fetch dublado: nada sai da máquina.
 *
 * Prova o que o banco falso não prova: a coluna nasce nula; as rotas gravam o
 * estado de verdade (pendente, ok, falhou, nulo) e a Google recebe o evento das
 * 9h no fuso, com o id "acao" + o id da ação; marcar feita, tirar o prazo e
 * apagar tiram o evento; desconfirmar o item no resumo também, com o id da ação
 * na resposta; a ficha (updated_at) segura o "ok" quando só o contato muda no
 * meio do envio; e a desconexão zera o estado das ações da dona, só dela.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-acoes-google-${crypto.randomUUID()}`;
// A conta Google de cada execução é única: os arquivos de integração rodam em paralelo no
// mesmo banco, e "outra conta da WRW usa esta conta Google?" (outraContaUsa) via a dos outros.
const SUFIXO_DA_CONTA_GOOGLE = crypto.randomUUID();
const contaGoogle = (nome: string) => `${nome}-${SUFIXO_DA_CONTA_GOOGLE}`;
const OUTRA = `teste-acoes-google-outra-${crypto.randomUUID()}`;
const PROVA = { ipAddress: "203.0.113.9", userAgent: "Navegador de teste" };
const HORA = 60 * 60_000;
const ROTULOS = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
const SP = "America/Sao_Paulo";
let idDaDona = 0;

/** "AAAA-MM-DD" daqui a n dias (negativo: no passado), no UTC. */
const dia = (n: number) => new Date(Date.now() + n * 24 * HORA).toISOString().slice(0, 10);

const rota = () => appRouter.createCaller({
  user: { id: idDaDona, openId: DONA, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: { remoteAddress: "203.0.113.9" }, ip: "203.0.113.9" },
  res: { cookie: () => {} },
} as never);

type Chamada = { url: string; metodo: string; corpo: Record<string, unknown> | null };
let chamadas: Chamada[] = [];

/** A Google de mentira, no fetch global: cada chamada tira a próxima resposta; uma função roda antes de responder. */
function google(...respostas: Array<Response | (() => Promise<Response>)>) {
  const duble = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, metodo: String(init?.method), corpo: init?.body ? JSON.parse(String(init.body)) : null });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    return typeof proxima === "function" ? proxima() : proxima;
  });
  vi.stubGlobal("fetch", duble);
  return duble;
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const erroDaGoogle = (status: number, reason: string) => json({ error: { code: status, errors: [{ reason }] } }, status);
const idDoEvento = (id: string) => `acao${id.replace(/-/g, "")}`;

async function linhaDaAcao(id: string) {
  const [linha] = await (await getDb())!.select().from(proximasAcoes).where(eq(proximasAcoes.id, id));
  return linha;
}

async function conectar(sub = contaGoogle("sub-da-dona"), refreshToken = "refresh-da-dona") {
  // Grava a conexão de verdade; o token de acesso dela fica em memória, e a Google só é chamada para os eventos.
  await conexaoGoogle.gravarConexaoGoogle(idDaDona, {
    refreshToken, sub, email: "dona@exemplo.com",
    escopos: ["openid", "https://www.googleapis.com/auth/calendar.events"],
    acesso: { token: "acesso-da-dona", expiraEm: Date.now() + HORA },
  }, PROVA);
}

async function desconectarNoBanco() {
  conexaoGoogle.esquecerAcesso(idDaDona);
  await apagarPelaChave((await getDb())!, googleAgendaConexoes, eq(googleAgendaConexoes.userId, idDaDona));
}

/** Uma reunião pronta da dona com o resumo pronto e uma ação confirmada; devolve o item. */
async function itemConfirmado() {
  const banco = (await getDb())!;
  const agora = Date.now();
  const meetingId = crypto.randomUUID();
  const summaryId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  await banco.insert(meetings).values({
    id: meetingId, ownerId: DONA, title: "Reunião da agenda", status: "ready", consentGranted: true, consentAt: agora, language: "pt-BR",
    speakerNames: { F2: "Carla" }, createdAt: agora, updatedAt: agora,
  });
  await banco.insert(meetingSummaries).values({ id: summaryId, meetingId, ownerId: DONA, status: "ready", createdAt: agora, updatedAt: agora });
  await banco.insert(meetingSummaryItems).values({
    id: itemId, summaryId, meetingId, ownerId: DONA, section: "action", position: 0, subject: null, text: "{F2} envia a proposta",
    assignee: "{F2}", due: "até sexta", excerpt: "eu mando a proposta", startSeconds: 10, confidence: "0.900", status: "pending",
    decidedAt: null, createdAt: agora, updatedAt: agora,
  });
  await rota().meetings.decidirItemDoResumo({ itemId, status: "confirmed" });
  const [acao] = await banco.select().from(proximasAcoes).where(eq(proximasAcoes.itemId, itemId));
  return { itemId, acaoId: acao.id };
}

async function limpar() {
  const banco = (await getDb())!;
  for (const dona of [DONA, OUTRA]) {
    await apagarPelaChave(banco, proximasAcoes, eq(proximasAcoes.ownerId, dona));
    await apagarPelaChave(banco, lembretes, eq(lembretes.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
    await apagarPelaChave(banco, privateContacts, eq(privateContacts.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Próximas ações na Google Agenda (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId: DONA, onboardingCompleted: true });
    const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
    idDaDona = conta.id;
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await limpar();
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
    await limpar();
    await conectar();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await desconectarNoBanco();
  });

  it("sem a Google Agenda, a ação com prazo nasce fora dela: google nulo, e nada vai à Google", async () => {
    await desconectarNoBanco();
    google();
    const { id, naGoogle } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    expect(naGoogle).toBeNull();
    expect(await linhaDaAcao(id)).toMatchObject({ google: null });
    expect(chamadas).toEqual([]);
  });

  it("com a Google Agenda: a ação com prazo vira o evento das 9h no fuso, com o id dela, e a linha fica 'ok'", async () => {
    google(json({ id: "evento" }));
    const prazo = dia(3);
    const { id, naGoogle } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", responsavel: "Bia", prazo, fuso: SP, rotulos: ROTULOS });
    expect(naGoogle).toBe("ok");
    expect(await linhaDaAcao(id)).toMatchObject({ google: "ok", prazo });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ metodo: "POST", url: `${URL_DOS_EVENTOS}?sendUpdates=none` });
    expect(chamadas[0].corpo).toMatchObject({
      id: idDoEvento(id), summary: "Mandar o contrato", transparency: "transparent",
      start: { timeZone: SP }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    });
    expect(String(chamadas[0].corpo!.description)).toContain("Responsável: Bia");
    expect(String(chamadas[0].corpo!.description)).toContain(`https://wrwglobal.org/proximas-acoes?acao=${id}`);
    // 9h em São Paulo é 12h em UTC.
    expect((chamadas[0].corpo!.start as { dateTime: string }).dateTime).toBe(`${prazo}T12:00:00.000Z`);
    // A tela lê o estado pela lista.
    const { acoes } = await rota().proximasAcoes.listar({ filtro: "abertas" });
    expect(acoes.find(a => a.id === id)).toMatchObject({ google: "ok" });
  });

  it("sem prazo, ou com o dia do prazo já encerrado: a ação fica só na WRW, sem chamar a Google", async () => {
    google();
    const semPrazo = await rota().proximasAcoes.criar({ texto: "Ligar para a Bia", fuso: SP, rotulos: ROTULOS });
    const vencida = await rota().proximasAcoes.criar({ texto: "Ligar para a Ana", prazo: dia(-3), fuso: SP, rotulos: ROTULOS });
    expect([semPrazo.naGoogle, vencida.naGoogle]).toEqual([null, null]);
    expect((await linhaDaAcao(semPrazo.id)).google).toBeNull();
    expect((await linhaDaAcao(vencida.id)).google).toBeNull();
    expect(chamadas).toEqual([]);
  });

  it("editar o texto manda a versão nova (409 vira PATCH); a Google fora do ar deixa 'falhou', e o Tentar de novo a deixa 'ok'", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().proximasAcoes.editar({ id, texto: "Mandar o contrato assinado", fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "ok" });
    expect(chamadas.at(-1)).toMatchObject({ metodo: "PATCH", url: `${URL_DOS_EVENTOS}/${idDoEvento(id)}?sendUpdates=none` });
    expect(chamadas.at(-1)!.corpo).toMatchObject({ summary: "Mandar o contrato assinado" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google(new Response("", { status: 503 }));
    expect(await rota().proximasAcoes.editar({ id, detalhe: "Com o desconto", fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "falhou", motivo: "google" });
    expect((await linhaDaAcao(id)).google).toBe("falhou");
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().proximasAcoes.mandarParaGoogle({ id, fuso: SP, rotulos: ROTULOS })).toEqual({ naGoogle: "ok" });
    expect((await linhaDaAcao(id)).google).toBe("ok");
  });

  it("sem a Google Agenda, editar a ação que estava lá a deixa 'falhou' (a Google ficou com a versão antiga)", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    await desconectarNoBanco();
    // A desconexão de verdade zeraria o estado; aqui a conexão some só do banco, para provar o CASE da escrita.
    await (await getDb())!.update(proximasAcoes).set({ google: "ok" }).where(eq(proximasAcoes.id, id));
    // Só a edição conta: o POST do criar, acima, já foi.
    chamadas = [];
    google();
    expect(await rota().proximasAcoes.editar({ id, texto: "Outro", fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: null });
    expect((await linhaDaAcao(id)).google).toBe("falhou");
    expect(chamadas).toEqual([]);
  });

  it("marcar feita tira o evento e zera o estado; reabrir manda de novo; tirar o prazo tira; apagar tira", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    google(new Response(null, { status: 204 }));
    expect(await rota().proximasAcoes.marcarFeita({ id, feita: true, fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "ok" });
    expect(await linhaDaAcao(id)).toMatchObject({ feita: true, google: null });
    expect(chamadas.at(-1)).toMatchObject({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${idDoEvento(id)}?sendUpdates=none` });
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().proximasAcoes.marcarFeita({ id, feita: false, fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "ok" });
    expect(await linhaDaAcao(id)).toMatchObject({ feita: false, google: "ok" });
    // O PATCH traz de volta o evento que a feita tirou (status confirmado).
    expect(chamadas.at(-1)!.corpo).toMatchObject({ status: "confirmed" });
    google(new Response(null, { status: 204 }));
    expect(await rota().proximasAcoes.editar({ id, prazo: "", fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "ok" });
    expect(await linhaDaAcao(id)).toMatchObject({ prazo: null, google: null });
    expect(chamadas.at(-1)).toMatchObject({ metodo: "DELETE" });
    // Sem prazo, apagar nem pergunta à Google.
    google();
    expect(await rota().proximasAcoes.apagar({ id })).toEqual({ ok: true, naGoogle: null });
    expect(await linhaDaAcao(id)).toBeUndefined();
  });

  it("apagar a ação que está lá tira o evento; quando a Google falha, o Tentar de novo só vale para a ação que saiu", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google(new Response(null, { status: 503 }));
    expect(await rota().proximasAcoes.apagar({ id })).toEqual({ ok: true, naGoogle: "falhou", motivo: "google" });
    expect(await linhaDaAcao(id)).toBeUndefined();
    google(erroDaGoogle(410, "deleted"));
    expect(await rota().proximasAcoes.tirarDaGoogle({ id })).toEqual({ naGoogle: "ok" });
    google(json({ id: "evento" }));
    const { id: aberta } = await rota().proximasAcoes.criar({ texto: "Outra", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    await expect(rota().proximasAcoes.tirarDaGoogle({ id: aberta })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("pelo resumo: o prazo posto na ação do item a leva à Google com o nome da voz; desconfirmar o item tira o evento, com o id da ação na resposta", async () => {
    const { itemId, acaoId } = await itemConfirmado();
    google(json({ id: "evento" }));
    expect(await rota().proximasAcoes.editar({ id: acaoId, prazo: dia(3), fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, naGoogle: "ok" });
    expect(chamadas.at(-1)!.corpo).toMatchObject({ summary: "Carla envia a proposta" });
    expect(String(chamadas.at(-1)!.corpo!.description)).toContain("Responsável: Carla");
    google(new Response(null, { status: 204 }));
    expect(await rota().meetings.decidirItemDoResumo({ itemId, status: "pending" })).toEqual({ ok: true, acaoId, naGoogle: "ok" });
    expect(await linhaDaAcao(acaoId)).toBeUndefined();
    expect(chamadas.at(-1)).toMatchObject({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${idDoEvento(acaoId)}?sendUpdates=none` });
  });

  it("pelo resumo: marcar a ação feita na caixa do resumo tira o evento; desmarcar a manda de novo", async () => {
    const { itemId, acaoId } = await itemConfirmado();
    google(json({ id: "evento" }));
    await rota().proximasAcoes.editar({ id: acaoId, prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    google(new Response(null, { status: 204 }));
    expect(await rota().meetings.marcarAcaoFeita({ itemId, feito: true })).toEqual({ ok: true, acaoId, naGoogle: "ok" });
    expect(await linhaDaAcao(acaoId)).toMatchObject({ feita: true, google: null });
    google(erroDaGoogle(409, "duplicate"), json({ id: "evento" }));
    expect(await rota().meetings.marcarAcaoFeita({ itemId, feito: false, fuso: SP, rotulos: ROTULOS })).toEqual({ ok: true, acaoId, naGoogle: "ok" });
    expect(await linhaDaAcao(acaoId)).toMatchObject({ feita: false, google: "ok" });
  });

  it("a ficha: ligar um contato no meio do envio muda a linha e não o evento, e o 'ok' fica", async () => {
    const banco = (await getDb())!;
    const contato = { id: await createPrivateContact(DONA, { fullName: "Bia Lima" }) };
    google(async () => {
      const id = String(chamadas.at(-1)!.corpo!.id).slice(4);
      const [acao] = (await banco.select({ id: proximasAcoes.id }).from(proximasAcoes).where(eq(proximasAcoes.ownerId, DONA)))
        .filter(a => a.id.replace(/-/g, "") === id);
      await new Promise(resolver => setTimeout(resolver, 5));
      await rota().proximasAcoes.ligarContato({ id: acao.id, contactId: contato.id });
      return json({ id: "evento" });
    });
    const { id, naGoogle } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    expect(naGoogle).toBe("ok");
    expect(await linhaDaAcao(id)).toMatchObject({ google: "ok", contactId: contato.id });
  });

  it("desconectar zera o estado das ações da dona, e só dela; reconectar a mesma conta Google não zera", async () => {
    google(json({ id: "evento" }));
    const { id } = await rota().proximasAcoes.criar({ texto: "Mandar o contrato", prazo: dia(3), fuso: SP, rotulos: ROTULOS });
    const agora = Date.now();
    const daOutra = crypto.randomUUID();
    await (await getDb())!.insert(proximasAcoes).values({
      id: daOutra, ownerId: OUTRA, texto: "Da outra dona", origem: "manual", feita: false, prazo: dia(3), google: "ok", createdAt: agora, updatedAt: agora,
    });
    await conectar();
    expect((await linhaDaAcao(id)).google).toBe("ok");
    await conexaoGoogle.desconectarGoogleAgenda(idDaDona, PROVA, vi.fn(async () => new Response(null, { status: 200 })));
    expect((await linhaDaAcao(id)).google).toBeNull();
    expect((await linhaDaAcao(daOutra)).google).toBe("ok");
  });
});
