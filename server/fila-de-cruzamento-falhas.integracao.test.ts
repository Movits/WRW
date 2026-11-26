import crypto from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * As falhas da fila do cruzamento (N4b, revisão de 26/11) contra o banco DE
 * TESTE (sem DATABASE_URL_TESTES se pula). O lote em si é um dublê
 * (`cruzarUmLoteNaRedeGlobal`), para o teste decidir quando ele termina, quando
 * ele falha e como:
 *   - a reserva conta a tentativa (o lote que derruba o processo não volta para sempre);
 *   - com o banco fora do ar, a reserva é solta antes de o erro subir;
 *   - o erro gravado e o do log levam só o SQL, nunca os parâmetros;
 *   - o SIGTERM não devolve a reserva de um lote em andamento;
 *   - o trabalho que sai da fila no meio (a exclusão da conta) para o lote sem gravar.
 */
const lote = vi.hoisted(() => ({ cruzar: vi.fn() }));
vi.mock("./network-rede-global", async importOriginal => ({
  ...(await importOriginal<typeof import("./network-rede-global")>()),
  cruzarUmLoteNaRedeGlobal: (...args: unknown[]) => lote.cruzar(...args),
}));
vi.mock("./routers/consent", async importOriginal => ({
  ...(await importOriginal<typeof import("./routers/consent")>()),
  hasValidConsent: async () => true,
}));

const { getDb } = await import("./db");
const { filaDeCruzamento } = await import("../drizzle/schema");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const fila = await import("./fila-de-cruzamento");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-fila-falhas-${crypto.randomUUID().slice(0, 8)}`;

async function trabalhoNovo() {
  const db = (await getDb())!;
  await db.delete(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, DONA));
  await fila.enfileirarCruzamento({ ownerId: DONA, userId: 1, tipo: "global" });
  fila.religarParaTestes();
}

async function linha() {
  const db = (await getDb())!;
  const [trabalho] = await db.select().from(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, DONA));
  return trabalho;
}

/** Um lote que espera o teste mandar seguir. */
function loteQueEspera() {
  let seguir!: () => void;
  const portao = new Promise<void>(resolve => { seguir = resolve; });
  let comecou!: () => void;
  const comecouAPromessa = new Promise<void>(resolve => { comecou = resolve; });
  lote.cruzar.mockImplementationOnce(async (_quem: unknown, _cursor: unknown, _membros: unknown, opcoes: { antesDeGravar?: () => Promise<void> }) => {
    comecou();
    await portao;
    await opcoes?.antesDeGravar?.();
    return { proximoId: null, processados: 1, conexoes: 0, completa: true };
  });
  return { seguir, comecou: comecouAPromessa };
}

describe.skipIf(!temBanco)("Fila do cruzamento — falhas do lote (integração)", () => {
  afterEach(() => {
    lote.cruzar.mockReset();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) await db.delete(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, DONA));
    fila.religarParaTestes();
  });

  it("a reserva conta a tentativa enquanto o lote roda, e o lote que termina bem a zera", async () => {
    await trabalhoNovo();
    const { seguir, comecou } = loteQueEspera();
    const rodada = fila.rodarUmLote({ ownerId: DONA });
    await comecou;
    expect((await linha()).tentativas).toBe(1);
    seguir();
    expect(await rodada).toMatchObject({ terminou: true });
    expect(await linha()).toMatchObject({ tentativas: 0, estado: "concluida", vivo: null, lockToken: null });
  });

  it("com o banco fora do ar, a reserva é solta antes de o erro subir, e a tentativa não conta", async () => {
    await trabalhoNovo();
    lote.cruzar.mockRejectedValueOnce(new BancoIndisponivel());
    await expect(fila.rodarUmLote({ ownerId: DONA })).rejects.toBeInstanceOf(BancoIndisponivel);
    expect(await linha()).toMatchObject({ lockToken: null, lockedUntil: null, tentativas: 0, estado: "pendente" });
  });

  it("o erro guardado na linha e o do log levam o SQL, nunca os parâmetros da consulta", async () => {
    await trabalhoNovo();
    const segredo = "fulana.de.tal@exemplo.com";
    const erroDoDriver = Object.assign(new Error(`Failed query: select * from private_contacts where email = ?\nparams: ${segredo}`), {
      name: "DrizzleQueryError", query: "select * from private_contacts where email = ?", params: [segredo],
    });
    lote.cruzar.mockRejectedValueOnce(erroDoDriver);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fila.rodarUmLote({ ownerId: DONA })).toMatchObject({ terminou: false });
    const trabalho = await linha();
    expect(trabalho.erro).toContain("select * from private_contacts");
    expect(trabalho.erro).not.toContain(segredo);
    expect(JSON.stringify(aviso.mock.calls)).not.toContain(segredo);
  });

  it("o SIGTERM não devolve a reserva do lote em andamento: ela vence depois do fim do processo", async () => {
    await trabalhoNovo();
    const { seguir, comecou } = loteQueEspera();
    const rodada = fila.rodarUmLote({ ownerId: DONA });
    await comecou;
    const reservada = await linha();
    const antes = Date.now();
    expect(await fila.pararFilaDeCruzamento()).toEqual({ trabalhos: 1 });
    const depois = await linha();
    // A instância nova não a toma já: o token segue o mesmo e a reserva vence só passado o prazo.
    expect(depois.lockToken).toBe(reservada.lockToken);
    expect(Number(depois.lockedUntil)).toBeGreaterThanOrEqual(antes + fila.PRAZO_DO_DESLIGAMENTO_MS - 1000);
    // E a tentativa interrompida pelo desligamento não conta.
    expect(depois.tentativas).toBe(0);
    seguir();
    await rodada;
    fila.religarParaTestes();
  });

  it("o trabalho que sai da fila no meio do lote (a exclusão da conta) para sem gravar", async () => {
    await trabalhoNovo();
    const { seguir, comecou } = loteQueEspera();
    const rodada = fila.rodarUmLote({ ownerId: DONA });
    await comecou;
    const db = (await getDb())!;
    await db.delete(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, DONA));
    seguir();
    expect(await rodada).toMatchObject({ abandonado: true, conexoes: 0 });
    expect(await linha()).toBeUndefined();
  });
});
