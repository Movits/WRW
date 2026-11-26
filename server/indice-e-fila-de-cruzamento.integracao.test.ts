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
const { slugifyMatchTag, recalculatePrivateMatches, CONTATOS_DO_RECALCULO_NA_HORA, TETO_DE_PARES_POR_CONTATO_EM_MASSA } = await import("./match-service");
const { candidatosPelasChaves, indexarPendentes, limparOrfas, hashDaChave } = await import("./indice-de-cruzamento");
const { editarItemDaFicha } = await import("./possui-procura-da-ficha");
const { lerRedeGlobalAnonima, procurarConexoesNaRedeGlobal, tetoDeBuscaNaRedeGlobal, CONTATOS_DA_BUSCA_NA_HORA, TETO_POR_CONTRAPARTE_POR_RODADA } = await import("./network-rede-global");
const fila = await import("./fila-de-cruzamento");
const { chavesDoContato, chavesDoItem, VERSAO_DAS_CHAVES } = await import("../shared/chaves-de-cruzamento");

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
// As da revisão da N4b (o cursor da fila, o teto por trabalho, os melhores pares, a fila em si).
const CURSOR = `teste-cdc-cursor-${sufixo}`;
const TETO = `teste-cdc-teto-${sufixo}`;
const OUTRA = `teste-cdc-outra-${sufixo}`;
const MASSA = `teste-cdc-massa-${sufixo}`;
const FILA = `teste-cdc-fila-${sufixo}`;
const DONAS = [ENTIDADE, MEMBRA, GRANDE, CURSOR, TETO, OUTRA, MASSA, FILA];

let ids: Record<string, number> = {};
let codigo = 0;
const novoCodigo = () => `T${sufixo.slice(0, 5)}${(codigo++).toString(36).padStart(4, "0")}`.toUpperCase().slice(0, 16);

type ItemDoTeste = string | { label: string; category: string };
async function contatos(ownerId: string, quantos: number, itens: (i: number) => { tem?: ItemDoTeste[]; precisa?: ItemDoTeste[] }) {
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
  const item = (contactId: number, dado: ItemDoTeste) => {
    const { label, category } = typeof dado === "string" ? { label: dado, category: null } : dado;
    return { ownerId, contactId, tagSlug: slugifyMatchTag(label), tagLabel: label, category, description: null, createdAt: agora, updatedAt: agora };
  };
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
      ...[CURSOR, TETO, OUTRA, MASSA, FILA].map(openId => ({ openId, onboardingCompleted: true })),
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

  it("editar o item na ficha refaz as chaves do contato: o rótulo novo cruza, o antigo não", async () => {
    const db = (await getDb())!;
    const [contato] = await contatos(MEMBRA, 1, () => ({ tem: ["Mel de laranjeira"] }));
    await indiceEmDia();
    const [item] = await db.select({ id: contactAssets.id }).from(contactAssets).where(and(eq(contactAssets.ownerId, MEMBRA), eq(contactAssets.contactId, contato)));
    await editarItemDaFicha(MEMBRA, Number(item.id), "possui", "Própolis verde");
    // Logo depois da edição, e também depois da varredura (que só acha item sem chave e chave sem item).
    for (const passo of ["edição", "varredura"]) {
      if (passo === "varredura") await indiceEmDia();
      expect(await candidatosPelasChaves(db, chavesDoContato({ tenho: [], preciso: [{ label: "Própolis verde" }] })), passo).toContain(contato);
      expect(await candidatosPelasChaves(db, chavesDoContato({ tenho: [], preciso: [{ label: "Mel de laranjeira" }] })), passo).not.toContain(contato);
    }
  });

  it("a chave gravada por outra VERSAO_DAS_CHAVES é refeita pela varredura", async () => {
    const db = (await getDb())!;
    const [contato] = await contatos(MEMBRA, 1, () => ({ tem: ["Cera de abelha pura"] }));
    await indiceEmDia();
    // Como se as linhas tivessem sido gravadas pelo cálculo antigo, que dava outra chave.
    const [item] = await db.select({ id: contactAssets.id }).from(contactAssets).where(and(eq(contactAssets.ownerId, MEMBRA), eq(contactAssets.contactId, contato)));
    await db.delete(chavesDeCruzamento).where(and(eq(chavesDeCruzamento.ownerId, MEMBRA), eq(chavesDeCruzamento.contactId, contato)));
    await db.insert(chavesDeCruzamento).values({ lado: "tem", itemId: Number(item.id), contactId: contato, ownerId: MEMBRA, chave: hashDaChave("s:calculo-antigo"), versao: VERSAO_DAS_CHAVES - 1 });
    await indiceEmDia();
    const linhas = await db.select({ chave: chavesDeCruzamento.chave, versao: chavesDeCruzamento.versao }).from(chavesDeCruzamento)
      .where(and(eq(chavesDeCruzamento.ownerId, MEMBRA), eq(chavesDeCruzamento.contactId, contato)));
    expect(linhas.every(l => l.versao === VERSAO_DAS_CHAVES)).toBe(true);
    expect(linhas.map(l => l.chave).sort()).toEqual(Array.from(new Set(chavesDoItem({ label: "Cera de abelha pura" }, "tem").map(hashDaChave))).sort());
  });

  it("dois pedidos ao mesmo tempo deixam um trabalho vivo só", async () => {
    const db = (await getDb())!;
    await Promise.all(Array.from({ length: 6 }, () => fila.enfileirarCruzamento({ ownerId: FILA, userId: ids[FILA], tipo: "global" })));
    const vivos = await db.select().from(filaDeCruzamento).where(and(eq(filaDeCruzamento.ownerId, FILA), eq(filaDeCruzamento.estado, "pendente")));
    expect(vivos).toHaveLength(1);
    expect(vivos[0].deNovo).toBe(true);
    // A garantia é do banco, não da ordem das consultas: um segundo vivo da mesma dona e tipo é recusado.
    const agora = Date.now();
    await expect(db.insert(filaDeCruzamento).values({ ownerId: FILA, userId: ids[FILA], tipo: "global", vivo: true, criadaEm: agora, atualizadaEm: agora }))
      .rejects.toThrow();
    await db.delete(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, FILA));
  });

  it("o trabalho que derrubou o processo nas três reservas desiste, em vez de voltar para sempre", async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    // A terceira reserva venceu sem o lote terminar (o processo caiu): a tentativa dela já foi contada.
    await db.insert(filaDeCruzamento).values({
      ownerId: FILA, userId: ids[FILA], tipo: "privado", tentativas: fila.TENTATIVAS_DO_CRUZAMENTO,
      lockToken: crypto.randomUUID(), lockedUntil: agora - 1, criadaEm: agora, atualizadaEm: agora,
    });
    fila.religarParaTestes();
    expect(await fila.rodarUmLote({ ownerId: FILA })).toBeNull();
    const [trabalho] = await db.select().from(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, FILA));
    expect(trabalho).toMatchObject({ estado: "falhou", vivo: null, lockToken: null });
    // Com o morto fora, um pedido novo abre outro trabalho vivo.
    expect((await fila.enfileirarCruzamento({ ownerId: FILA, userId: ids[FILA], tipo: "privado" })).novo).toBe(true);
    await db.delete(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, FILA));
  });

  it("a fila não pula contatos quando o lote para no orçamento: o cursor só anda até o último cruzado por inteiro", async () => {
    const db = (await getDb())!;
    // Cada contato da dona tem 20 serviços que COMPARTILHAM a chave de categoria com os 20 de cada contato da
    // outra, mas não casam (categoria não vale para serviço): 25 × 400 comparações por contato, e o orçamento
    // de um lote acaba depois de uns 10 contatos. Só o contato 12 tem o que a outra procura.
    const servicoDela = { label: "Consultoria jurídica", category: "Serviços" };
    const servicoDaOutra = { label: "Consultoria em marketing", category: "Serviços" };
    const daDona = await contatos(CURSOR, 15, i => ({ tem: i === 12 ? ["Rolhas de cortiça natural"] : Array(20).fill(servicoDela) }));
    await contatos(OUTRA, 26, i => ({ precisa: i === 25 ? ["Rolhas de cortiça natural"] : Array(20).fill(servicoDaOutra) }));
    await indiceEmDia();
    await fila.enfileirarCruzamento({ ownerId: CURSOR, userId: ids[CURSOR], tipo: "global" });
    fila.religarParaTestes();
    const feito = await fila.rodarFilaAteEsvaziar({ ownerId: CURSOR });
    expect(feito.lotes).toBeGreaterThan(1);
    const [doDoze] = await db.select({ codigo: privateContacts.codigoAnonimo }).from(privateContacts).where(eq(privateContacts.id, daDona[12]));
    const registradas = await db.select({ conexaoId: conexoesParticipantes.conexaoId }).from(conexoesParticipantes)
      .where(and(eq(conexoesParticipantes.ownerId, CURSOR), eq(conexoesParticipantes.contactId, daDona[12])));
    expect(registradas.length, `o contato ${doDoze.codigo} ficou sem cruzar`).toBeGreaterThan(0);
  }, 300_000);

  it("os tetos de registro da busca pela fila valem pelo trabalho inteiro, não por lote", async () => {
    const db = (await getDb())!;
    // 250 contatos (dois lotes) com o que UM contato da outra dona procura: a contraparte é uma só.
    await contatos(TETO, 250, () => ({ tem: ["Barris de carvalho francês"] }));
    const [daOutra] = await contatos(OUTRA, 1, () => ({ precisa: ["Barris de carvalho francês"] }));
    await indiceEmDia();
    await fila.enfileirarCruzamento({ ownerId: TETO, userId: ids[TETO], tipo: "global" });
    fila.religarParaTestes();
    await fila.rodarFilaAteEsvaziar({ ownerId: TETO });
    const comAOutra = await db.select({ conexaoId: conexoesParticipantes.conexaoId }).from(conexoesParticipantes)
      .where(and(eq(conexoesParticipantes.ownerId, OUTRA), eq(conexoesParticipantes.contactId, daOutra)));
    expect(comAOutra).toHaveLength(TETO_POR_CONTRAPARTE_POR_RODADA);
    const [trabalho] = await db.select().from(filaDeCruzamento).where(eq(filaDeCruzamento.ownerId, TETO));
    expect(trabalho).toMatchObject({ estado: "concluida", conexoes: TETO_POR_CONTRAPARTE_POR_RODADA });
  }, 300_000);

  it("em massa, cada contato que procura fica com os MELHORES pares, e o par que já existia não some pelo corte", async () => {
    const db = (await getDb())!;
    // i = 0 procura; 1..25 casam só pela categoria (60) e vêm primeiro na ordem dos ids; 26..30 casam pelo
    // rótulo (100). O resto enche o laço para passar de PARES_DO_LACO_DIRETO sem casar com ninguém.
    const ids_ = await contatos(MASSA, 1001, i => {
      if (i === 0) return { precisa: [{ label: "Embalagens de vidro", category: "Embalagens" }] };
      if (i <= 25) return { tem: [{ label: "Caixas de papelão", category: "Embalagens" }] };
      if (i <= 30) return { tem: [{ label: "Embalagens de vidro", category: "Embalagens" }] };
      if (i <= 560) return { tem: [`Parafusos lote A${i}`] };
      return { precisa: [`Tecidos rolo B${i}`] };
    });
    const procura = ids_[0];
    const cortado = ids_[25];
    const agora = Date.now();
    // A sugestão que já estava na tela para um par que o teto cortaria (o 25º de nota 60).
    await db.insert(aiMatchSuggestions).values({
      id: crypto.randomUUID(), ownerId: MASSA, contactAId: cortado, contactBId: procura,
      pairLowContactId: Math.min(cortado, procura), pairHighContactId: Math.max(cortado, procura),
      matchScore: 60, matchType: "category", matchedAssets: [{ slug: "caixas-de-papelao", label: "Caixas de papelão" }],
      matchedNeeds: [{ slug: "embalagens-de-vidro", label: "Embalagens de vidro" }], reasonText: "Contato 25 possui Caixas de papelão.",
      status: "pending", createdAt: agora, updatedAt: agora,
    });
    await recalculatePrivateMatches(MASSA, null, { naFila: true });
    const sugestoes = await db.select({ a: aiMatchSuggestions.contactAId, b: aiMatchSuggestions.contactBId, score: aiMatchSuggestions.matchScore })
      .from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, MASSA));
    const doQueProcura = sugestoes.filter(s => s.a === procura || s.b === procura);
    // Os cinco de 100 entram (antes, os 20 primeiros eram todos de 60).
    expect(doQueProcura.filter(s => s.score === 100)).toHaveLength(5);
    // O par que já existia continua lá, além dos 20.
    expect(doQueProcura.some(s => s.a === cortado || s.b === cortado)).toBe(true);
    expect(doQueProcura).toHaveLength(TETO_DE_PARES_POR_CONTATO_EM_MASSA + 1);
  }, 300_000);

  it("o recálculo na fila para sem gravar quando o trabalho sai da fila no meio (a exclusão da conta)", async () => {
    const db = (await getDb())!;
    await contatos(FILA, 2, i => (i === 0 ? { tem: ["Azeite extravirgem"] } : { precisa: ["Azeite extravirgem"] }));
    const { ReservaPerdida } = fila;
    await expect(recalculatePrivateMatches(FILA, null, { naFila: true, antesDeGravar: async () => { throw new ReservaPerdida(); } }))
      .rejects.toBeInstanceOf(ReservaPerdida);
    expect(await db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, FILA))).toHaveLength(0);
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
