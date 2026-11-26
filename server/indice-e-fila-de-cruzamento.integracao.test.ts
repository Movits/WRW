import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

const { getDb } = await import("./db");
const {
  aiMatchSuggestions, chavesDeCruzamento, conexoesParticipantes, conexoesRegistradas, contactAssets, contactNeeds,
  entidades, filaDeCruzamento, privateContacts, users,
} = await import("../drizzle/schema");
const { slugifyMatchTag, recalculatePrivateMatches, CONTATOS_DO_RECALCULO_NA_HORA } = await import("./match-service");
const { candidatosPelasChaves, indexarPendentes, limparOrfas, hashDaChave } = await import("./indice-de-cruzamento");
const { lerRedeGlobalAnonima, procurarConexoesNaRedeGlobal, tetoDeBuscaNaRedeGlobal, CONTATOS_DA_BUSCA_NA_HORA } = await import("./network-rede-global");
const fila = await import("./fila-de-cruzamento");
const { chavesDoContato } = await import("../shared/chaves-de-cruzamento");

/**
 * O índice e a fila do cruzamento (N4b) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES se pula):
 *   - o índice acha o item novo na varredura e esquece o item apagado;
 *   - a leitura global não tem mais janela: o contato 1300 de uma entidade com
 *     convênio vigente cruza (antes, só os 1000 primeiros, sem ordem);
 *   - a busca grande vai para a fila, e a fila registra as conexões em lotes;
 *   - o pedido que chega com o trabalho vivo não cria outro: marca de_novo;
 *   - o motor privado da conta grande vai para a fila e, lá, roda sem o laço
 *     quadrático e grava as mesmas sugestões.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const ENTIDADE = `teste-cdc-entidade-${sufixo}`;
const MEMBRA = `teste-cdc-membra-${sufixo}`;
const GRANDE = `teste-cdc-grande-${sufixo}`;
const DONAS = [ENTIDADE, MEMBRA, GRANDE];

let ids: Record<string, number> = {};
let codigo = 0;
const novoCodigo = () => `T${sufixo.slice(0, 5)}${(codigo++).toString(36).padStart(4, "0")}`.toUpperCase().slice(0, 16);

async function contatos(ownerId: string, quantos: number, itens: (i: number) => { tem?: string[]; precisa?: string[] }) {
  const db = (await getDb())!;
  const agora = Date.now();
  for (let inicio = 0; inicio < quantos; inicio += 500) {
    const lote = Array.from({ length: Math.min(500, quantos - inicio) }, (_, k) => inicio + k);
    await db.insert(privateContacts).values(lote.map(i => ({
      ownerId, fullName: `Contato ${i}`, codigoAnonimo: novoCodigo(), disponivelRedeGlobal: true, nivelVisibilidade: "privado" as const,
      createdAt: agora, updatedAt: agora + i,
    })));
  }
  const criados = await db.select({ id: privateContacts.id }).from(privateContacts).where(eq(privateContacts.ownerId, ownerId));
  const ordenados = criados.map(c => Number(c.id)).sort((a, b) => a - b).slice(-quantos);
  const item = (contactId: number, label: string) => ({ ownerId, contactId, tagSlug: slugifyMatchTag(label), tagLabel: label, category: null, description: null, createdAt: agora, updatedAt: agora });
  const tem = ordenados.flatMap((id, i) => (itens(i).tem ?? []).map(label => item(id, label)));
  const precisa = ordenados.flatMap((id, i) => (itens(i).precisa ?? []).map(label => item(id, label)));
  for (let i = 0; i < tem.length; i += 1000) await db.insert(contactAssets).values(tem.slice(i, i + 1000));
  for (let i = 0; i < precisa.length; i += 1000) await db.insert(contactNeeds).values(precisa.slice(i, i + 1000));
  return ordenados;
}

async function indiceEmDia() {
  while ((await indexarPendentes()) + (await limparOrfas()) > 0) { /* até o índice ficar em dia */ }
}

describe.skipIf(!temBanco)("Índice e fila do cruzamento (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: ENTIDADE, onboardingCompleted: true, isEntidade: true },
      { openId: MEMBRA, onboardingCompleted: true },
      { openId: GRANDE, onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, DONAS));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
    const agora = Date.now();
    await db.insert(entidades).values({
      ownerId: ENTIDADE, nome: "Entidade do índice", tipo: "associacao", pais: "BR", convenioEstado: "ativo",
      mostrarNomeNoMatch: false, disponivelPorPadrao: true, createdAt: agora, updatedAt: agora,
    } as never);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const conexoes = await db.select({ id: conexoesParticipantes.conexaoId }).from(conexoesParticipantes).where(inArray(conexoesParticipantes.ownerId, DONAS));
    if (conexoes.length) {
      const idsDasConexoes = Array.from(new Set(conexoes.map(c => c.id)));
      await db.delete(conexoesParticipantes).where(inArray(conexoesParticipantes.conexaoId, idsDasConexoes));
      await db.delete(conexoesRegistradas).where(inArray(conexoesRegistradas.id, idsDasConexoes));
    }
    await db.delete(chavesDeCruzamento).where(inArray(chavesDeCruzamento.ownerId, DONAS));
    await db.delete(filaDeCruzamento).where(inArray(filaDeCruzamento.ownerId, DONAS));
    await db.delete(aiMatchSuggestions).where(inArray(aiMatchSuggestions.ownerId, DONAS));
    await db.delete(contactAssets).where(inArray(contactAssets.ownerId, DONAS));
    await db.delete(contactNeeds).where(inArray(contactNeeds.ownerId, DONAS));
    await db.delete(privateContacts).where(inArray(privateContacts.ownerId, DONAS));
    await db.delete(entidades).where(eq(entidades.ownerId, ENTIDADE));
    await db.delete(users).where(inArray(users.openId, DONAS));
  });

  it("o índice acha o item novo e esquece o item apagado; a chave é hash, nunca o texto", async () => {
    const db = (await getDb())!;
    const [contato] = await contatos(MEMBRA, 1, () => ({ tem: ["Mel orgânico de florada"] }));
    await indiceEmDia();
    const chaves = chavesDoContato({ tenho: [], preciso: [{ label: "Mel orgânico de florada" }] });
    expect(await candidatosPelasChaves(db, chaves)).toContain(contato);
    const linhas = await db.select({ chave: chavesDeCruzamento.chave }).from(chavesDeCruzamento).where(eq(chavesDeCruzamento.contactId, contato));
    expect(linhas.length).toBeGreaterThan(0);
    for (const linha of linhas) expect(linha.chave).toMatch(/^[0-9a-f]{16}$/);
    expect(linhas.map(l => l.chave)).toContain(hashDaChave("s:mel-organico-de-florada"));
    // Palavra solta não é chave: "Mel" sozinho não acha o contato.
    expect(await candidatosPelasChaves(db, chavesDoContato({ tenho: [], preciso: [{ label: "Mel" }] }))).not.toContain(contato);

    await db.delete(contactAssets).where(eq(contactAssets.contactId, contato));
    await indiceEmDia();
    expect(await db.select().from(chavesDeCruzamento).where(eq(chavesDeCruzamento.contactId, contato))).toHaveLength(0);
  });

  it("sem janela: o associado 1300 de uma entidade com convênio vigente cruza com a busca da membra", async () => {
    const db = (await getDb())!;
    // 1300 associados; só o último tem o que a membra procura.
    const daEntidade = await contatos(ENTIDADE, 1300, i => (i === 1299 ? { tem: ["Rolhas de cortiça natural"] } : { tem: ["Parafusos sextavados"] }));
    await contatos(MEMBRA, 1, () => ({ precisa: ["Rolhas de cortiça natural"] }));
    await indiceEmDia();
    // A leitura paginada alcança todos (antes, a janela de 1000 sem ordem).
    const todos = await lerRedeGlobalAnonima({ excetoDona: MEMBRA });
    expect(todos.filter(c => c.ownerId === ENTIDADE)).toHaveLength(1300);
    tetoDeBuscaNaRedeGlobal.esquecer();
    const r = await procurarConexoesNaRedeGlobal({ id: ids[MEMBRA], openId: MEMBRA });
    expect(r.emFila).toBeUndefined();
    const doUltimo = await db.select({ codigo: privateContacts.codigoAnonimo }).from(privateContacts).where(eq(privateContacts.id, daEntidade[1299]));
    expect(r.conexoes.map(c => c.outroLado.codigoAnonimo)).toContain(doUltimo[0].codigo);
    // Nenhuma coluna pessoal sai da leitura global.
    for (const contato of todos.slice(0, 3)) expect(Object.keys(contato).sort()).toEqual(["codigoAnonimo", "contactId", "ownerId", "preciso", "tenho"]);
  }, 120_000);

  it("a busca grande vai para a fila, um trabalho vivo por dona, e a fila registra as conexões em lotes", async () => {
    const db = (await getDb())!;
    tetoDeBuscaNaRedeGlobal.esquecer();
    const r = await procurarConexoesNaRedeGlobal({ id: ids[ENTIDADE], openId: ENTIDADE });
    expect(r.contatosDisponiveis).toBeGreaterThan(CONTATOS_DA_BUSCA_NA_HORA);
    expect(r).toMatchObject({ emFila: true, conexoes: [], completa: false });
    // O segundo pedido não cria outro trabalho: marca de_novo.
    const segundo = await fila.enfileirarCruzamento({ ownerId: ENTIDADE, userId: ids[ENTIDADE], tipo: "global" });
    expect(segundo.novo).toBe(false);
    const vivos = await db.select().from(filaDeCruzamento).where(and(eq(filaDeCruzamento.ownerId, ENTIDADE), eq(filaDeCruzamento.estado, "pendente")));
    expect(vivos).toHaveLength(1);
    expect(vivos[0].deNovo).toBe(true);

    fila.religarParaTestes();
    const feito = await fila.rodarFilaAteEsvaziar({ ownerId: ENTIDADE });
    // 1300 contatos em lotes de 200 (7 lotes), duas vezes por causa do de_novo.
    expect(feito.lotes).toBeGreaterThanOrEqual(14);
    expect(feito.conexoes).toBeGreaterThan(0);
    const [trabalho] = await db.select().from(filaDeCruzamento).where(eq(filaDeCruzamento.id, vivos[0].id));
    expect(trabalho).toMatchObject({ estado: "concluida", deNovo: false, lockToken: null });
  }, 300_000);

  it("o motor privado da conta grande vai para a fila e lá grava as sugestões sem o laço quadrático", async () => {
    const db = (await getDb())!;
    // Mais contatos que o recálculo na hora aceita; "tem" × "precisa" passa do laço direto (em massa).
    const quantos = CONTATOS_DO_RECALCULO_NA_HORA + 50;
    await contatos(GRANDE, quantos, i => (i % 2 === 0
      ? { tem: [`Embalagem modelo ${i % 300}`] }
      : { precisa: [`Embalagem modelo ${(i - 1) % 300}`] }));
    const r = await recalculatePrivateMatches(GRANDE);
    expect(r).toMatchObject({ emFila: true, total: 0 });
    expect(await db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, GRANDE))).toHaveLength(0);

    fila.religarParaTestes();
    await fila.rodarFilaAteEsvaziar({ ownerId: GRANDE });
    const sugestoes = await db.select({ score: aiMatchSuggestions.matchScore }).from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, GRANDE));
    // Cada "precisa" casa com os "tem" do mesmo modelo (uns 3 por modelo).
    expect(sugestoes.length).toBeGreaterThan(quantos);
    expect(sugestoes.every(s => s.score >= 50)).toBe(true);
    // A segunda rodada em massa não regrava o que não mudou e não cria repetidas.
    const de_novo = await recalculatePrivateMatches(GRANDE, null, { naFila: true });
    expect(de_novo.created).toBe(0);
    expect(await db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, GRANDE))).toHaveLength(sugestoes.length);
  }, 300_000);
});
