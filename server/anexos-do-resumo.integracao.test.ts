import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// O bucket é dublê: o envio, o expurgo e a assinatura nunca falam com um bucket de verdade.
const subir = vi.hoisted(() => vi.fn(async (chave: string) => ({ key: chave, url: `/manus-storage/${chave}` })));
const apagar = vi.hoisted(() => vi.fn(async (_chave: string) => {}));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storagePut: (...args: unknown[]) => subir(...(args as [string])),
  storageApagarTodasAsVersoes: (...args: unknown[]) => apagar(...(args as [string])),
}));

const { getDb } = await import("./db");
const { auditLogs, meetingAttachments, meetingTranscripts, meetings, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { gerarTokenDoLink, novaSenhaDoLink } = await import("./link-aberto-da-reuniao");
const { entrarNoLink } = await import("./entrada-no-link-aberto");
const { chaveDoAnexoDoLink, tetoDosAnexos } = await import("./anexos-do-resumo");
const { comCookiesDoPedido } = await import("./senha-do-link-aberto");
const { deletePrivateMeeting, limparGravacoesVencidas } = await import("./meeting-service");
const { ANEXOS_POR_REUNIAO_MAX, RECUSAS_DOS_ANEXOS } = await import("@shared/anexos-do-resumo");
const { RECUSAS_DA_LIXEIRA } = await import("@shared/lixeira-de-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * Os anexos do resumo (H4g e H4h) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula): anexar, listar e tirar pela dona; a outra
 * conta não alcança; o teto por reunião; a lixeira esconde; o link aberto
 * mostra e respeita a senha (H23); a exclusão da reunião e a varredura dos 30
 * dias tiram o objeto do bucket e só então a linha. Donas com id aleatório.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-anexos-${crypto.randomUUID()}`;
const OUTRA = `teste-anexos-outra-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_100_000_000 + Math.floor(Math.random() * 10_000_000);
const AGORA = Date.now();

// Um JPEG mínimo e sintético, com um EXIF de mentira (o "GPS" tem de sumir).
function jpegSintetico(): string {
  const segmento = (marcador: number, corpo: Buffer) => {
    const cabecalho = Buffer.alloc(4);
    cabecalho[0] = 0xff; cabecalho[1] = marcador; cabecalho.writeUInt16BE(corpo.length + 2, 2);
    return Buffer.concat([cabecalho, corpo]);
  };
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]), segmento(0xe1, Buffer.from("Exif\0\0GPS-SINTETICO", "latin1")),
    segmento(0xda, Buffer.from([1, 2, 3])), Buffer.from([5, 5, 0xff, 0xd9]),
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function contexto(openId: string, id = ID_DA_DONA, cookie?: string): TrpcContext {
  return {
    user: openId ? { id, openId, role: "silver", name: "Dona Teste", onboardingCompleted: true } : null,
    req: { headers: { "user-agent": "vitest-anexos", ...(cookie ? { cookie } : {}) }, ip: "203.0.113.51", socket: { remoteAddress: "203.0.113.51" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const daDona = () => appRouter.createCaller(contexto(DONA));
const daOutra = () => appRouter.createCaller(contexto(OUTRA, ID_DA_DONA + 1));
const publico = (cookie?: string) => appRouter.createCaller(contexto("", 0, cookie));
async function db() { return (await getDb())!; }

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(() => null, e => e);
  expect(erro).toBeInstanceOf(TRPCError);
  return erro as TRPCError;
}

async function reuniaoPronta(ownerId: string, opcoes: { link?: boolean } = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const token = opcoes.link ? gerarTokenDoLink() : null;
  await banco.insert(meetings).values({
    id, ownerId, title: "Reunião com fotos", status: "ready", consentGranted: true, consentAt: AGORA, language: "pt-BR",
    origem: "gravacao", shareToken: token, createdAt: AGORA, updatedAt: AGORA,
  });
  await banco.insert(meetingTranscripts).values({ id: crypto.randomUUID(), meetingId: id, ownerId, transcript: "Texto sintético.", language: "pt-BR", createdAt: AGORA, updatedAt: AGORA });
  return { id, token };
}

const anexar = (meetingId: string, tipo: "photo" | "drawing" = "photo") => daDona().meetings.anexarAoResumo({ meetingId, tipo, dataBase64: jpegSintetico() });

describe.skipIf(!temBanco)("Anexos do resumo (integração)", () => {
  beforeAll(async () => {
    await (await db()).insert(users).values([{ openId: DONA, name: "Dona Anexos" }, { openId: OUTRA }]);
  });
  beforeEach(() => {
    subir.mockClear();
    apagar.mockReset();
    apagar.mockImplementation(async () => {});
  });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    const donas = [DONA, OUTRA];
    await apagarPelaChave(banco, meetingAttachments, inArray(meetingAttachments.ownerId, donas));
    await apagarPelaChave(banco, meetingTranscripts, inArray(meetingTranscripts.ownerId, donas));
    await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, donas));
    await apagarPelaChave(banco, auditLogs, inArray(auditLogs.userId, [ID_DA_DONA, ID_DA_DONA + 1]));
    await banco.delete(users).where(inArray(users.openId, donas));
  });

  it("anexa a foto e o desenho: sobem sem o EXIF, com a chave da dona, 30 dias de prazo e a auditoria; a lista os devolve na ordem", async () => {
    const { id } = await reuniaoPronta(DONA);
    const foto = await anexar(id);
    const desenho = await anexar(id, "drawing");
    expect(foto).toMatchObject({ tipo: "photo", mimeType: "image/jpeg", url: `/manus-storage/meetings/${DONA}/${id}/anexo-${foto.id}.jpg` });
    expect(foto.expiraEm - foto.criadoEm).toBe(30 * 24 * 60 * 60_000);
    const [chave, bytes, tipo, opcoes] = subir.mock.calls[0] as unknown as [string, Buffer, string, { chaveExata: boolean }];
    expect(chave).toBe(`meetings/${DONA}/${id}/anexo-${foto.id}.jpg`);
    expect(tipo).toBe("image/jpeg");
    expect(opcoes.chaveExata).toBe(true);
    expect(bytes.includes(Buffer.from("GPS-SINTETICO"))).toBe(false);
    expect((await daDona().meetings.anexos({ meetingId: id })).map(a => [a.id, a.tipo])).toEqual([[foto.id, "photo"], [desenho.id, "drawing"]]);
    const auditoria = await (await db()).select().from(auditLogs).where(and(eq(auditLogs.resourceId, id), eq(auditLogs.action, "MEETING_ATTACHMENT_ADDED")));
    expect(auditoria).toHaveLength(2);
    expect(JSON.stringify(auditoria[0].details)).not.toContain("GPS");
  });

  it("a outra conta não lista, não anexa e não tira: NOT_FOUND, sem subir nada", async () => {
    const { id } = await reuniaoPronta(DONA);
    const foto = await anexar(id);
    subir.mockClear();
    expect(await recusa(daOutra().meetings.anexos({ meetingId: id }))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DOS_ANEXOS.naoEncontrado });
    expect(await recusa(daOutra().meetings.anexarAoResumo({ meetingId: id, tipo: "photo", dataBase64: jpegSintetico() }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await recusa(daOutra().meetings.apagarAnexo({ meetingId: id, anexoId: foto.id }))).toMatchObject({ code: "NOT_FOUND" });
    expect(subir).not.toHaveBeenCalled();
    expect(await daDona().meetings.anexos({ meetingId: id })).toHaveLength(1);
  });

  it("o teto por reunião recusa o anexo a mais sem subir nada (ANEXOS_DEMAIS)", async () => {
    const { id } = await reuniaoPronta(DONA);
    const banco = await db();
    await banco.insert(meetingAttachments).values(Array.from({ length: ANEXOS_POR_REUNIAO_MAX }, (_, i) => ({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, kind: "photo" as const, storageKey: `meetings/${DONA}/${id}/anexo-${i}.jpg`,
      storageUrl: `/manus-storage/meetings/${DONA}/${id}/anexo-${i}.jpg`, mimeType: "image/jpeg", sizeBytes: 10, expiresAt: AGORA + 60_000, createdAt: AGORA + i,
    })));
    subir.mockClear();
    expect(await recusa(anexar(id))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_ANEXOS.demais });
    expect(subir).not.toHaveBeenCalled();
  });

  it("tirar um anexo: o objeto sai com todas as versões e a linha também; com o bucket recusando, a linha vence e some da lista", async () => {
    const { id } = await reuniaoPronta(DONA);
    const a = await anexar(id);
    const b = await anexar(id);
    await expect(daDona().meetings.apagarAnexo({ meetingId: id, anexoId: a.id })).resolves.toEqual({ saiuDoBucket: true });
    expect(apagar).toHaveBeenCalledWith(`meetings/${DONA}/${id}/anexo-${a.id}.jpg`);
    expect(await (await db()).select().from(meetingAttachments).where(eq(meetingAttachments.id, a.id))).toEqual([]);
    apagar.mockRejectedValueOnce(new Error("bucket fora"));
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    await expect(daDona().meetings.apagarAnexo({ meetingId: id, anexoId: b.id })).resolves.toEqual({ saiuDoBucket: false });
    const [ponteiro] = await (await db()).select().from(meetingAttachments).where(eq(meetingAttachments.id, b.id));
    expect(Number(ponteiro.expiresAt)).toBeLessThanOrEqual(Date.now());
    expect(await daDona().meetings.anexos({ meetingId: id })).toEqual([]);
    // A varredura acha o ponteiro e tenta de novo.
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(await (await db()).select().from(meetingAttachments).where(eq(meetingAttachments.id, b.id))).toEqual([]);
  });

  it("a reunião na lixeira: a guarda recusa listar e anexar (REUNIAO_NA_LIXEIRA), e o link não mostra; restaurada, os anexos voltam", async () => {
    const { id } = await reuniaoPronta(DONA);
    const foto = await anexar(id);
    await daDona().meetings.mandarParaALixeira({ meetingIds: [id] });
    expect(await recusa(daDona().meetings.anexos({ meetingId: id }))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_LIXEIRA.naLixeira });
    expect(await recusa(anexar(id))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_LIXEIRA.naLixeira });
    await daDona().meetings.restaurarDaLixeira({ meetingIds: [id] });
    expect((await daDona().meetings.anexos({ meetingId: id })).map(a => a.id)).toEqual([foto.id]);
  });

  it("o link aberto mostra os anexos só pela rota dele (sem a chave), e a reunião na lixeira não abre", async () => {
    const { id, token } = await reuniaoPronta(DONA, { link: true });
    const foto = await anexar(id);
    const pelaRota = await publico().reuniaoAberta.anexos({ token: token! });
    expect(pelaRota).toEqual([{ id: foto.id, tipo: "photo", url: `/reuniao-aberta/${token}/anexo/${foto.id}` }]);
    expect(JSON.stringify(pelaRota)).not.toContain(DONA);
    expect(await chaveDoAnexoDoLink(token!, foto.id)).toBe(`meetings/${DONA}/${id}/anexo-${foto.id}.jpg`);
    // O id de um anexo de outra reunião não abre por este link.
    const outra = await reuniaoPronta(DONA);
    const deOutra = await anexar(outra.id);
    expect(await chaveDoAnexoDoLink(token!, deOutra.id)).toBeNull();
    // Na lixeira (o link desliga), nada abre.
    await (await db()).update(meetings).set({ trashedAt: Date.now() }).where(eq(meetings.id, id));
    expect(await recusa(publico().reuniaoAberta.anexos({ token: token! }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await chaveDoAnexoDoLink(token!, foto.id)).toBeNull();
  });

  it("o link com senha (H23): sem a entrada, UNAUTHORIZED e nenhuma imagem; com a senha certa, abre", async () => {
    const { id, token } = await reuniaoPronta(DONA, { link: true });
    const foto = await anexar(id);
    const senha = await novaSenhaDoLink(DONA, id, { userId: ID_DA_DONA, ipAddress: "203.0.113.51", userAgent: "vitest" });
    expect(await recusa(publico().reuniaoAberta.anexos({ token: token! }))).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await chaveDoAnexoDoLink(token!, foto.id)).toBeNull();
    const entrada = await entrarNoLink(token!, senha, "203.0.113.52");
    if (!entrada.entrou) throw new Error("a senha não entrou");
    const cookie = `${entrada.cookie.nome}=${entrada.cookie.valor}`;
    expect((await publico(cookie).reuniaoAberta.anexos({ token: token! })).map(a => a.id)).toEqual([foto.id]);
    expect(await comCookiesDoPedido(cookie, () => chaveDoAnexoDoLink(token!, foto.id))).toContain(foto.id);
  });

  it("tirar o áudio do link não tira os anexos (decisão vetável: são o resumo, não a voz)", async () => {
    const { id, token } = await reuniaoPronta(DONA, { link: true });
    const foto = await anexar(id);
    await (await db()).update(meetings).set({ shareAudio: false }).where(eq(meetings.id, id));
    expect((await publico().reuniaoAberta.anexos({ token: token! })).map(a => a.id)).toEqual([foto.id]);
  });

  it("excluir a reunião tira os anexos do bucket e as linhas; o que o bucket recusou fica vencido para a varredura", async () => {
    const { id } = await reuniaoPronta(DONA);
    const a = await anexar(id);
    const b = await anexar(id);
    apagar.mockImplementation(async chave => { if (chave.includes(b.id)) throw new Error("bucket recusou"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await deletePrivateMeeting(DONA, id);
    const restantes = await (await db()).select().from(meetingAttachments).where(eq(meetingAttachments.meetingId, id));
    expect(restantes.map(r => r.id)).not.toContain(a.id);
    // A recusa para os outros (tirarDoBucket), então o que não saiu fica vencido.
    for (const linha of restantes) expect(Number(linha.expiresAt)).toBeLessThanOrEqual(Date.now());
    apagar.mockImplementation(async () => {});
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(await (await db()).select().from(meetingAttachments).where(eq(meetingAttachments.meetingId, id))).toEqual([]);
  });

  it("a varredura dos 30 dias tira o anexo vencido da reunião que segue no ar, e deixa o que ainda vale", async () => {
    const { id } = await reuniaoPronta(DONA);
    const velho = await anexar(id);
    const novo = await anexar(id);
    await (await db()).update(meetingAttachments).set({ expiresAt: Date.now() - 1 }).where(eq(meetingAttachments.id, velho.id));
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(apagar).toHaveBeenCalledWith(`meetings/${DONA}/${id}/anexo-${velho.id}.jpg`);
    expect((await (await db()).select({ id: meetingAttachments.id }).from(meetingAttachments).where(eq(meetingAttachments.meetingId, id))).map(r => r.id)).toEqual([novo.id]);
  });

  it("o teto de envios por dona recusa com o código, sem subir nada", async () => {
    const { id } = await reuniaoPronta(DONA);
    const conferir = vi.spyOn(tetoDosAnexos, "conferir").mockImplementationOnce(() => { throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DOS_ANEXOS.muitosEnvios }); });
    subir.mockClear();
    expect(await recusa(anexar(id))).toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DOS_ANEXOS.muitosEnvios });
    expect(subir).not.toHaveBeenCalled();
    conferir.mockRestore();
  });
});
