import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { meetingFolders, meetings, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { NOME_DA_PASTA_MAX, PASTAS_POR_DONA_MAX, RECUSAS_DAS_PASTAS } = await import("@shared/pastas-de-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * As pastas das reuniões (H7d) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula): criar com nome, ícone e cor; o nome aparado
 * e sem repetida; o teto por dona; editar; apagar a pasta sem apagar reunião;
 * mover várias reuniões (todas ou nenhuma); a pasta e a reunião de outra conta
 * "não encontradas". Donas com id aleatório: a limpeza só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-pastas-${crypto.randomUUID()}`;
const OUTRA = `teste-pastas-outra-${crypto.randomUUID()}`;
const CHEIA = `teste-pastas-cheia-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
const AGORA = Date.now();

function contexto(openId: string, id = ID_DA_DONA): TrpcContext {
  return {
    user: { id, openId, role: "silver", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: {}, ip: "203.0.113.41", socket: { remoteAddress: "203.0.113.41" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const caller = (openId: string, id = ID_DA_DONA) => appRouter.createCaller(contexto(openId, id));
const daDona = () => caller(DONA);
const daOutra = () => caller(OUTRA, ID_DA_DONA + 1);

async function db() { return (await getDb())!; }
const linha = async (id: string) => (await (await db()).select().from(meetings).where(eq(meetings.id, id)))[0];

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(() => null, e => e);
  expect(erro).toBeInstanceOf(TRPCError);
  return erro as TRPCError;
}

async function reuniao(ownerId: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await (await db()).insert(meetings).values({
    id, ownerId, title: "Reunião da pasta", status: "ready", consentGranted: true, language: "pt-BR", origem: "gravacao",
    createdAt: AGORA, updatedAt: AGORA, ...extra,
  });
  return id;
}

describe.skipIf(!temBanco)("Pastas das reuniões (integração)", () => {
  beforeAll(async () => {
    await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }, { openId: CHEIA }]);
  });

  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    const donas = [DONA, OUTRA, CHEIA];
    await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, donas));
    await apagarPelaChave(banco, meetingFolders, inArray(meetingFolders.ownerId, donas));
    await banco.delete(users).where(inArray(users.openId, donas));
  });

  it("criar: o nome é aparado e cortado, o ícone e a cor vêm das listas, e a pasta nasce vazia, só para a dona", async () => {
    const nomeLongo = `  Clientes   do   ${"x".repeat(80)}  `;
    const { id } = await daDona().meetings.criarPasta({ nome: nomeLongo, icone: "maleta", cor: "azul" });
    const pasta = (await daDona().meetings.pastas()).find(p => p.id === id)!;
    expect(pasta.nome.startsWith("Clientes do x")).toBe(true);
    expect(Array.from(pasta.nome).length).toBe(NOME_DA_PASTA_MAX);
    expect(pasta).toMatchObject({ icone: "maleta", cor: "azul", reunioes: 0 });
    expect((await daOutra().meetings.pastas()).map(p => p.id)).not.toContain(id);
    // Fora das listas, o zod recusa antes do serviço.
    for (const ruim of [{ icone: "foguete" }, { cor: "dourado" }]) {
      expect((await recusa(daDona().meetings.criarPasta({ nome: "Outra", icone: "pasta", cor: "ambar", ...ruim } as never))).code).toBe("BAD_REQUEST");
    }
  });

  it("o nome vazio e o nome repetido (sem caixa e sem acento) são recusados com o código; outra conta pode usar o mesmo nome", async () => {
    expect(await recusa(daDona().meetings.criarPasta({ nome: "   ", icone: "pasta", cor: "ambar" }))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DAS_PASTAS.nomeInvalido });
    await daDona().meetings.criarPasta({ nome: "Reuniões de Março", icone: "calendario", cor: "verde" });
    expect(await recusa(daDona().meetings.criarPasta({ nome: "reunioes  de marco", icone: "pasta", cor: "ambar" }))).toMatchObject({ code: "CONFLICT", message: RECUSAS_DAS_PASTAS.nomeRepetido });
    await expect(daOutra().meetings.criarPasta({ nome: "Reuniões de Março", icone: "pasta", cor: "ambar" })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("o teto de pastas por dona: a próxima é recusada com o código, e nada nasce", async () => {
    const banco = await db();
    await banco.insert(meetingFolders).values(Array.from({ length: PASTAS_POR_DONA_MAX }, (_, i) => ({
      id: crypto.randomUUID(), ownerId: CHEIA, name: `Pasta ${i}`, icon: "pasta", color: "ambar", createdAt: AGORA + i, updatedAt: AGORA + i,
    })));
    const erro = await recusa(caller(CHEIA, ID_DA_DONA + 2).meetings.criarPasta({ nome: "Uma a mais", icone: "pasta", cor: "ambar" }));
    expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DAS_PASTAS.demais });
    expect((await banco.select({ id: meetingFolders.id }).from(meetingFolders).where(eq(meetingFolders.ownerId, CHEIA))).length).toBe(PASTAS_POR_DONA_MAX);
  });

  it("editar muda o que veio e deixa o resto; a pasta de outra conta é 'não encontrada', e o nome de outra pasta da dona, repetido", async () => {
    const { id } = await daDona().meetings.criarPasta({ nome: "Mentoria", icone: "pessoas", cor: "roxo" });
    await daDona().meetings.editarPasta({ pastaId: id, cor: "rosa" });
    expect((await daDona().meetings.pastas()).find(p => p.id === id)).toMatchObject({ nome: "Mentoria", icone: "pessoas", cor: "rosa" });
    await daDona().meetings.editarPasta({ pastaId: id, nome: "  Mentoria 2026 ", icone: "estrela" });
    expect((await daDona().meetings.pastas()).find(p => p.id === id)).toMatchObject({ nome: "Mentoria 2026", icone: "estrela", cor: "rosa" });
    // Renomear para o próprio nome não é repetida.
    await expect(daDona().meetings.editarPasta({ pastaId: id, nome: "mentoria 2026" })).resolves.toEqual({ success: true });
    expect(await recusa(daOutra().meetings.editarPasta({ pastaId: id, cor: "cinza" }))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DAS_PASTAS.naoEncontrada });
    expect(await recusa(daOutra().meetings.apagarPasta({ pastaId: id }))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DAS_PASTAS.naoEncontrada });
    await daDona().meetings.criarPasta({ nome: "Vendas", icone: "maleta", cor: "verde" });
    expect(await recusa(daDona().meetings.editarPasta({ pastaId: id, nome: "VENDAS" }))).toMatchObject({ code: "CONFLICT", message: RECUSAS_DAS_PASTAS.nomeRepetido });
  });

  it("mover várias reuniões para a pasta, e de volta para nenhuma, sem mexer no updated_at (a ficha de quem as processa)", async () => {
    const { id: pasta } = await daDona().meetings.criarPasta({ nome: `Projetos ${crypto.randomUUID().slice(0, 6)}`, icone: "lampada", cor: "laranja" });
    const a = await reuniao(DONA);
    const b = await reuniao(DONA, { status: "processing" });
    await expect(daDona().meetings.moverParaPasta({ meetingIds: [a, b], pastaId: pasta })).resolves.toEqual({ movidas: 2 });
    expect((await linha(a)).folderId).toBe(pasta);
    expect((await linha(b)).folderId).toBe(pasta);
    expect(Number((await linha(b)).updatedAt)).toBe(AGORA);
    expect((await daDona().meetings.pastas()).find(p => p.id === pasta)?.reunioes).toBe(2);
    expect((await daDona().meetings.list()).filter(r => r.folderId === pasta).map(r => r.id).sort()).toEqual([a, b].sort());

    await expect(daDona().meetings.moverParaPasta({ meetingIds: [a], pastaId: null })).resolves.toEqual({ movidas: 1 });
    expect((await linha(a)).folderId).toBeNull();
    expect((await daDona().meetings.pastas()).find(p => p.id === pasta)?.reunioes).toBe(1);
  });

  it("mover é todo ou nada: a pasta de outra conta e a reunião de outra conta são 'não encontradas', e nada se move", async () => {
    const { id: minhaPasta } = await daDona().meetings.criarPasta({ nome: `Minha ${crypto.randomUUID().slice(0, 6)}`, icone: "pasta", cor: "ambar" });
    const { id: pastaDaOutra } = await daOutra().meetings.criarPasta({ nome: `Da outra ${crypto.randomUUID().slice(0, 6)}`, icone: "pasta", cor: "ambar" });
    const minha = await reuniao(DONA);
    const daOutraConta = await reuniao(OUTRA);
    expect(await recusa(daDona().meetings.moverParaPasta({ meetingIds: [minha], pastaId: pastaDaOutra }))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DAS_PASTAS.naoEncontrada });
    expect((await recusa(daDona().meetings.moverParaPasta({ meetingIds: [minha, daOutraConta], pastaId: minhaPasta }))).code).toBe("NOT_FOUND");
    expect((await linha(minha)).folderId).toBeNull();
    expect((await linha(daOutraConta)).folderId).toBeNull();
  });

  it("apagar a pasta não apaga reunião: as dela ficam sem pasta, também a que está na lixeira", async () => {
    const { id: pasta } = await daDona().meetings.criarPasta({ nome: `Temporária ${crypto.randomUUID().slice(0, 6)}`, icone: "bandeira", cor: "vermelho" });
    const viva = await reuniao(DONA, { folderId: pasta });
    const naLixeira = await reuniao(DONA, { folderId: pasta, trashedAt: AGORA });
    await expect(daDona().meetings.apagarPasta({ pastaId: pasta })).resolves.toEqual({ soltas: 2 });
    expect((await daDona().meetings.pastas()).map(p => p.id)).not.toContain(pasta);
    expect(await linha(viva)).toMatchObject({ folderId: null, status: "ready" });
    expect(await linha(naLixeira)).toMatchObject({ folderId: null });
    // Restaurada depois, ela volta sem pasta.
    await daDona().meetings.restaurarDaLixeira({ meetingIds: [naLixeira] });
    expect((await daDona().meetings.list()).find(r => r.id === naLixeira)).toMatchObject({ folderId: null });
  });
});
