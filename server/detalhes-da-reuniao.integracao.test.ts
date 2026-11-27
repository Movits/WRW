import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { createContext, createPrivateContact, deleteContext, getDb } = await import("./db");
const { contexts, meetings, meetingTranscripts, privateContacts, recordingNoticeAcceptances, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { RECUSAS_DOS_DETALHES } = await import("@shared/detalhes-da-reuniao");
const { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } = await import("@shared/aviso-de-gravacao");
const { VERSOES_DO_AVISO_DO_DOCUMENTO } = await import("@shared/aviso-do-documento");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * Os detalhes da reunião (H7c) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula): a posse do contato e do contexto nos quatro
 * caminhos que gravam os ponteiros, o atualizarDetalhes, o que a lista e o
 * detalhe mostram, o link aberto sem os detalhes e o deleteContext que solta as
 * reuniões. Donas com id aleatório: a limpeza só alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-detalhes-${crypto.randomUUID()}`;
const OUTRA = `teste-detalhes-outra-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

function contexto(openId: string, id = ID_DA_DONA): TrpcContext {
  return {
    user: { id, openId, role: "user", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: {}, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const daDona = () => appRouter.createCaller(contexto(DONA));
const daOutra = () => appRouter.createCaller(contexto(OUTRA, ID_DA_DONA + 1));
const publico = () => appRouter.createCaller({ user: null, req: { headers: {}, ip: "203.0.113.10", socket: { remoteAddress: "203.0.113.10" } }, res: {} } as unknown as TrpcContext);

async function db() { return (await getDb())!; }
const novaReuniao = () => ({ title: "Reunião dos detalhes", consentGranted: true as const, language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
const linha = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(() => null, e => e);
  expect(erro).toBeInstanceOf(TRPCError);
  return erro as TRPCError;
}

describe.skipIf(!temBanco)("Detalhes da reunião (integração)", () => {
  let contatoDaDona = 0;
  let contatoDaOutra = 0;
  let contextoDaDona = "";
  let contextoDaOutra = "";
  const contextoDoCatalogo = crypto.randomUUID();

  beforeAll(async () => {
    const banco = await db();
    await banco.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    contatoDaDona = await createPrivateContact(DONA, { fullName: "Carla Mendes" });
    contatoDaOutra = await createPrivateContact(OUTRA, { fullName: "Contato da Outra" });
    contextoDaDona = await createContext(DONA, { name: "Feira de Milão", visibility: "private" });
    contextoDaOutra = await createContext(OUTRA, { name: "Contexto da Outra", visibility: "private" });
    await banco.insert(contexts).values({ id: contextoDoCatalogo, ownerId: null, name: "Evento do catálogo", createdAt: Date.now(), updatedAt: Date.now() });
    // Gravar com um toque: a gravação só nasce com o aviso aceito na conta.
    await daDona().meetings.aceitarAvisoDeGravacao({ versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
  });

  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await apagarPelaChave(banco, meetingTranscripts, inArray(meetingTranscripts.ownerId, [DONA, OUTRA]));
    await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, [DONA, OUTRA]));
    await banco.delete(privateContacts).where(inArray(privateContacts.ownerId, [DONA, OUTRA]));
    await banco.delete(contexts).where(inArray(contexts.ownerId, [DONA, OUTRA]));
    await banco.delete(contexts).where(eq(contexts.id, contextoDoCatalogo));
    await banco.delete(recordingNoticeAcceptances).where(inArray(recordingNoticeAcceptances.ownerId, [DONA, OUTRA]));
    await banco.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("create, iniciarGravacao e iniciarDocumento recusam o contato e o contexto de outra conta, sem criar a reunião", async () => {
    const banco = await db();
    const antes = (await banco.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, DONA))).length;
    const pedidos = [
      () => daDona().meetings.create({ ...novaReuniao(), contactId: contatoDaOutra }),
      () => daDona().meetings.create({ ...novaReuniao(), contextId: contextoDaOutra }),
      () => daDona().meetings.iniciarGravacao({ ...novaReuniao(), contactId: contatoDaOutra }),
      () => daDona().meetings.iniciarGravacao({ ...novaReuniao(), contextId: contextoDaOutra }),
      () => daDona().meetings.iniciarDocumento({ ...novaReuniao(), consentNoticeVersion: VERSOES_DO_AVISO_DO_DOCUMENTO[VERSOES_DO_AVISO_DO_DOCUMENTO.length - 1], origem: "pdf", contactId: contatoDaOutra }),
      // O id que não existe responde igual ao de outra conta.
      () => daDona().meetings.create({ ...novaReuniao(), contactId: 999_999_999 }),
      () => daDona().meetings.create({ ...novaReuniao(), contextId: crypto.randomUUID() }),
    ];
    const codigos = [];
    for (const pedido of pedidos) {
      const erro = await recusa(pedido());
      expect(erro.code).toBe("NOT_FOUND");
      codigos.push(erro.message);
    }
    expect(codigos).toEqual([
      RECUSAS_DOS_DETALHES.contato, RECUSAS_DOS_DETALHES.contexto, RECUSAS_DOS_DETALHES.contato, RECUSAS_DOS_DETALHES.contexto,
      RECUSAS_DOS_DETALHES.contato, RECUSAS_DOS_DETALHES.contato, RECUSAS_DOS_DETALHES.contexto,
    ]);
    expect((await banco.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, DONA))).length).toBe(antes);
  });

  it("aceita o contato e o contexto da dona, e o contexto do catálogo", async () => {
    const { id } = await daDona().meetings.create({ ...novaReuniao(), contactId: contatoDaDona, contextId: contextoDaDona });
    expect(await linha(id)).toMatchObject({ contactId: contatoDaDona, contextId: contextoDaDona });
    const emPartes = await daDona().meetings.iniciarGravacao({ ...novaReuniao(), contextId: contextoDoCatalogo });
    expect((await linha(emPartes.id)).contextId).toBe(contextoDoCatalogo);
  });

  it("o envio único que a tela usa para importar um arquivo (meetings.create com a origem 'arquivo') entra no filtro 'Importadas'; sem a origem, fica nula como antes", async () => {
    const { vistaDaOrigem } = await import("@shared/pastas-de-reunioes");
    const { id: importada } = await daDona().meetings.create({ ...novaReuniao(), origem: "arquivo" });
    expect((await linha(importada)).origem).toBe("arquivo");
    expect(vistaDaOrigem((await linha(importada)).origem)).toBe("importadas");
    const { id: antiga } = await daDona().meetings.create(novaReuniao());
    expect((await linha(antiga)).origem).toBeNull();
    // Só as origens do microfone e do arquivo: as outras têm caminho próprio.
    await expect(daDona().meetings.create({ ...novaReuniao(), origem: "youtube" } as never)).rejects.toBeInstanceOf(TRPCError);
  });

  it("atualizarDetalhes muda o que veio, normaliza as etiquetas e o 'Onde foi', e devolve com os nomes", async () => {
    const { id } = await daDona().meetings.create(novaReuniao());
    const detalhes = await daDona().meetings.atualizarDetalhes({
      meetingId: id, titulo: "  Reunião com a Carla ", etiquetas: [" Clientes", "clientes", "Exportação "], ondeFoi: "  Café   da Paulista ",
      contactId: contatoDaDona, contextId: contextoDaDona,
    });
    expect(detalhes).toEqual({
      titulo: "Reunião com a Carla", etiquetas: ["Clientes", "Exportação"], ondeFoi: "Café da Paulista",
      contato: { id: contatoDaDona, nome: "Carla Mendes" }, contexto: { id: contextoDaDona, nome: "Feira de Milão" },
    });
    // Ausente não muda; nulo e lista vazia tiram.
    const depois = await daDona().meetings.atualizarDetalhes({ meetingId: id, etiquetas: [], contactId: null });
    expect(depois).toMatchObject({ titulo: "Reunião com a Carla", etiquetas: [], ondeFoi: "Café da Paulista", contato: null, contexto: { id: contextoDaDona } });
    expect(await linha(id)).toMatchObject({ etiquetas: null, contactId: null, contextId: contextoDaDona });
  });

  it("atualizarDetalhes recusa a reunião de outra conta e o contato dela, sem escrever nada", async () => {
    const { id } = await daDona().meetings.create(novaReuniao());
    expect((await recusa(daOutra().meetings.atualizarDetalhes({ meetingId: id, ondeFoi: "invadido" }))).code).toBe("NOT_FOUND");
    const erro = await recusa(daDona().meetings.atualizarDetalhes({ meetingId: id, ondeFoi: "Zoom", contactId: contatoDaOutra }));
    expect([erro.code, erro.message]).toEqual(["NOT_FOUND", RECUSAS_DOS_DETALHES.contato]);
    expect(await linha(id)).toMatchObject({ ondeFoi: null, contactId: null });
  });

  it("não mexe no updated_at, que é a ficha de quem processa a reunião, nem renomeando", async () => {
    const { id } = await daDona().meetings.create(novaReuniao());
    const ficha = Date.now() - 5_000;
    await (await db()).update(meetings).set({ status: "processing", updatedAt: ficha }).where(eq(meetings.id, id));
    await daDona().meetings.atualizarDetalhes({ meetingId: id, titulo: "Renomeada durante o processamento", etiquetas: ["Durante o processamento"] });
    expect(await linha(id)).toMatchObject({ status: "processing", updatedAt: ficha, title: "Renomeada durante o processamento", etiquetas: ["Durante o processamento"] });
  });

  it("renomear a reunião fora do processamento muda o updated_at (a Memória vê a reunião renomeada); etiqueta e lugar, não", async () => {
    const { id } = await daDona().meetings.create(novaReuniao());
    const antes = Date.now() - 60_000;
    await (await db()).update(meetings).set({ status: "ready", updatedAt: antes }).where(eq(meetings.id, id));
    await daDona().meetings.atualizarDetalhes({ meetingId: id, etiquetas: ["Só etiqueta"], ondeFoi: "Zoom" });
    expect((await linha(id)).updatedAt).toBe(antes);
    await daDona().meetings.atualizarDetalhes({ meetingId: id, titulo: novaReuniao().title });
    expect((await linha(id)).updatedAt).toBe(antes);
    await daDona().meetings.atualizarDetalhes({ meetingId: id, titulo: "Nome novo" });
    expect(Number((await linha(id)).updatedAt)).toBeGreaterThan(antes);
  });

  it("a lista e o detalhe levam as etiquetas, o 'Onde foi' e os nomes do contato e do contexto; o ponteiro alheio sai sem nome", async () => {
    const { id } = await daDona().meetings.create(novaReuniao());
    await daDona().meetings.atualizarDetalhes({ meetingId: id, etiquetas: ["Mentoria"], ondeFoi: "Zoom", contactId: contatoDaDona, contextId: contextoDaDona });
    const naLista = (await daDona().meetings.list()).find(reuniao => reuniao.id === id)!;
    expect(naLista).toMatchObject({ etiquetas: ["Mentoria"], ondeFoi: "Zoom", contatoNome: "Carla Mendes", contextoNome: "Feira de Milão" });
    const noDetalhe = (await daDona().meetings.get({ meetingId: id })).meeting;
    expect(noDetalhe).toMatchObject({ etiquetas: ["Mentoria"], ondeFoi: "Zoom", contato: { id: contatoDaDona, nome: "Carla Mendes" }, contexto: { id: contextoDaDona, nome: "Feira de Milão" } });

    // Um ponteiro gravado antes da conferência de posse, para o contato e o
    // contexto de outra conta: o nome alheio nunca chega à tela.
    const legado = crypto.randomUUID();
    await (await db()).insert(meetings).values({
      id: legado, ownerId: DONA, title: "Reunião antiga", status: "ready", consentGranted: true, language: "pt-BR",
      contactId: contatoDaOutra, contextId: contextoDaOutra, createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect((await daDona().meetings.list()).find(reuniao => reuniao.id === legado)).toMatchObject({ contatoNome: null, contextoNome: null });
    expect((await daDona().meetings.get({ meetingId: legado })).meeting).toMatchObject({ contato: null, contexto: null });
  });

  it("o link aberto não leva as etiquetas, o 'Onde foi', o contato nem o contexto", async () => {
    const banco = await db();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("base64url");
    await banco.insert(meetings).values({
      id, ownerId: DONA, title: "Reunião compartilhada", status: "ready", consentGranted: true, language: "pt-BR", shareToken: token,
      etiquetas: ["EtiquetaSecreta"], ondeFoi: "LugarSecreto", contactId: contatoDaDona, contextId: contextoDaDona,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await banco.insert(meetingTranscripts).values({ id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: "Fala.", language: "pt-BR", createdAt: Date.now(), updatedAt: Date.now() });
    const visto = JSON.stringify(await publico().reuniaoAberta.ver({ token }));
    expect(visto).toContain("Reunião compartilhada");
    for (const segredo of ["EtiquetaSecreta", "LugarSecreto", "Carla Mendes", "Feira de Milão", "etiquetas", "ondeFoi"]) expect(visto).not.toContain(segredo);
  });

  it("excluir o contexto solta as reuniões da dona que estavam nele, e as de outra conta ficam como estão", async () => {
    const banco = await db();
    const efemero = await createContext(DONA, { name: "Contexto que sai", visibility: "private" });
    const { id } = await daDona().meetings.create({ ...novaReuniao(), contextId: efemero });
    // Um ponteiro alheio para o mesmo id (legado): não é da dona, não é tocado.
    const alheia = crypto.randomUUID();
    await banco.insert(meetings).values({ id: alheia, ownerId: OUTRA, title: "Da outra", status: "ready", consentGranted: true, language: "pt-BR", contextId: efemero, createdAt: Date.now(), updatedAt: Date.now() });
    const antes = (await linha(id)).updatedAt;

    expect(await deleteContext(DONA, efemero)).toBe(true);
    expect(await linha(id)).toMatchObject({ contextId: null, updatedAt: antes });
    expect((await linha(alheia)).contextId).toBe(efemero);
    expect((await banco.select({ id: contexts.id }).from(contexts).where(eq(contexts.id, efemero))).length).toBe(0);
    // A outra conta não exclui o contexto da dona nem solta nada.
    const daDonaAinda = await createContext(DONA, { name: "Contexto que fica", visibility: "private" });
    const presa = await daDona().meetings.create({ ...novaReuniao(), contextId: daDonaAinda });
    expect(await deleteContext(OUTRA, daDonaAinda)).toBe(false);
    expect((await linha(presa.id)).contextId).toBe(daDonaAinda);
  });
});
