import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
  process.env.ENTIDADES_HMAC_KEY = "chave-hmac-das-entidades-so-para-testes-0123456789";
  process.env.VAULT_ENCRYPTION_KEY = "chave-do-cofre-so-para-testes-0123456789abcdef";
});

const { getDb } = await import("./db");
const {
  auditLogs, contactAssets, contactNeeds, entidadeMembros, entidades, importacaoDocumentosVistos, importacoesDeEntidade,
  privateContacts, users,
} = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { lerRedeGlobalAnonima, encontrosEntre } = await import("./network-rede-global");

/**
 * A CNAE como "o que tem" (N4) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES se pula): a importação grava a oferta da CNAE com a
 * origem "cnae", nunca uma necessidade; o código que não existe não entra;
 * o cruzamento global lê a oferta e só casa com a necessidade declarada; e o
 * "refazer" (R-49) troca só os itens "cnae" dos importados.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const CONTA = `teste-cnae-entidade-${sufixo}`;
const STAFF = `teste-cnae-staff-${sufixo}`;
const EMAIL = `cnae-entidade-${sufixo}@exemplo.com`;

function cnpj(base12: string): string {
  const dv = (b: string, pesos: number[]) => {
    const resto = pesos.reduce((s, p, i) => s + Number(b[i]) * p, 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}
const doc = (n: number) => cnpj(String(80_000_000_0000 + n).padStart(12, "0"));

let ids: Record<string, number> = {};
const rotaDe = (openId: string, extra: Record<string, unknown> = {}) => appRouter.createCaller({
  user: { id: ids[openId], openId, role: "silver", onboardingCompleted: true, isEntidade: false, ...extra },
  req: { headers: {} }, res: { cookie: () => {} },
} as never);

async function importar(linhas: Array<Record<string, string>>) {
  const rota = rotaDe(CONTA, { isEntidade: true });
  const { importacaoId } = await rota.entidades.iniciarImportacao({ modo: "aplicar", arquivoSha256: "c".repeat(64), totalLinhas: linhas.length });
  const r = await rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas });
  await rota.entidades.concluirImportacao({ importacaoId });
  return r;
}

async function itensDe(contactId: number) {
  const db = (await getDb())!;
  const tenho = await db.select({ label: contactAssets.tagLabel, origem: contactAssets.origem, category: contactAssets.category })
    .from(contactAssets).where(eq(contactAssets.contactId, contactId));
  const preciso = await db.select({ label: contactNeeds.tagLabel }).from(contactNeeds).where(eq(contactNeeds.contactId, contactId));
  return { tenho, preciso };
}

async function contatoDoDocumento(n: number) {
  const db = (await getDb())!;
  const membros = await db.select({ contactId: entidadeMembros.contactId, id: entidadeMembros.id, referencia: entidadeMembros.referenciaDaEntidade })
    .from(entidadeMembros).where(eq(entidadeMembros.ownerId, CONTA));
  const m = membros.find(x => x.referencia === `ref-${n}`)!;
  return { contactId: Number(m.contactId), membroId: Number(m.id) };
}

describe.skipIf(!temBanco)("CNAE como oferta (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: CONTA, email: EMAIL, onboardingCompleted: true },
      { openId: STAFF, role: "admin", onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [CONTA, STAFF]));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
    await rotaDe(STAFF, { role: "admin" }).entidades.admin.criar({
      nome: "Associação CNAE", tipo: "associacao", pais: "BR", emailDaConta: EMAIL, convenioEstado: "ativo",
      convenioInicio: null, convenioFim: null, convenioReferencia: "Convênio de teste", mostrarNomeNoMatch: false,
      disponivelPorPadrao: true,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const donas = [CONTA, STAFF];
    await db.delete(importacaoDocumentosVistos).where(inArray(importacaoDocumentosVistos.ownerId, donas));
    await db.delete(importacoesDeEntidade).where(inArray(importacoesDeEntidade.ownerId, donas));
    await db.delete(entidadeMembros).where(inArray(entidadeMembros.ownerId, donas));
    await db.delete(contactAssets).where(inArray(contactAssets.ownerId, donas));
    await db.delete(contactNeeds).where(inArray(contactNeeds.ownerId, donas));
    await db.delete(privateContacts).where(inArray(privateContacts.ownerId, donas));
    await db.delete(entidades).where(inArray(entidades.ownerId, donas));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, Object.values(ids)));
    await db.delete(users).where(inArray(users.openId, donas));
  });

  it("a CNAE vira \"o que tem\" com a origem \"cnae\", sem categoria, e nunca necessidade", async () => {
    const r = await importar([
      // Advocacia: a CNAE principal dá a oferta; a secundária repete a mesma oferta (municipal e intermunicipal) e entra uma vez.
      { documento: doc(1), nome: "Empresa Um", referencia_da_entidade: "ref-1", cnae_principal: "6911-7/01", cnaes_secundarios: "4930201;4930202" },
      // O que a entidade escreveu vem antes, com a origem "entidade"; a necessidade é só a declarada.
      { documento: doc(2), nome: "Empresa Dois", referencia_da_entidade: "ref-2", cnae_principal: "0111301", o_que_tem: "Cultivo de arroz", o_que_precisa: "Serviços advocatícios" },
      // Residual e inexistente: o código residual fica guardado, mas não vira oferta; o inexistente nem fica.
      { documento: doc(3), nome: "Empresa Três", referencia_da_entidade: "ref-3", cnae_principal: "4789099", cnaes_secundarios: "9999999" },
    ]);
    expect(r.problemas.filter(p => p.codigo.startsWith("CNAE"))).toEqual([{ linha: 4, codigo: "CNAE_INEXISTENTE" }]);

    const um = await itensDe((await contatoDoDocumento(1)).contactId);
    expect(um.tenho).toEqual(expect.arrayContaining([
      { label: "Serviços advocatícios", origem: "cnae", category: null },
      { label: "Transporte rodoviário de carga", origem: "cnae", category: null },
    ]));
    expect(um.tenho).toHaveLength(2);
    expect(um.preciso).toEqual([]);

    const dois = await itensDe((await contatoDoDocumento(2)).contactId);
    expect(dois.tenho).toEqual([{ label: "Cultivo de arroz", origem: "entidade", category: null }]);
    expect(dois.preciso).toEqual([{ label: "Serviços advocatícios" }]);

    const tres = await contatoDoDocumento(3);
    expect(await itensDe(tres.contactId)).toEqual({ tenho: [], preciso: [] });
    const db = (await getDb())!;
    const [membro] = await db.select({ principal: entidadeMembros.cnaePrincipal, secundarias: entidadeMembros.cnaesSecundarios })
      .from(entidadeMembros).where(eq(entidadeMembros.id, tres.membroId));
    expect(membro).toEqual({ principal: "4789099", secundarias: [] });

    // Nenhuma linha de necessidade da entidade além da declarada.
    const todas = await db.select({ label: contactNeeds.tagLabel }).from(contactNeeds).where(eq(contactNeeds.ownerId, CONTA));
    expect(todas).toEqual([{ label: "Serviços advocatícios" }]);
  });

  it("o cruzamento global lê a oferta da CNAE e só casa com a necessidade declarada", async () => {
    const rede = await lerRedeGlobalAnonima({ somenteDona: CONTA });
    const advocacia = rede.find(c => c.tenho.some(t => t.label === "Serviços advocatícios"))!;
    const pedido = rede.find(c => c.preciso.some(p => p.label === "Serviços advocatícios"))!;
    expect(advocacia).toBeTruthy();
    expect(encontrosEntre(advocacia, pedido).encontros.map(e => e.tem)).toEqual(["Serviços advocatícios"]);
    // Duas empresas só com CNAE (sem nada declarado) não se encontram.
    const semPedido = rede.filter(c => c.preciso.length === 0);
    for (const a of semPedido) for (const b of semPedido) expect(encontrosEntre(a, b).encontros).toEqual([]);
  });

  it("refazer as ofertas (R-49) troca só os itens \"cnae\" e não toca no ativado; só a equipe pode", async () => {
    const db = (await getDb())!;
    const um = await contatoDoDocumento(1);
    const dois = await contatoDoDocumento(2);
    // A tabela "mudou": a oferta antiga de outra versão fica no banco e precisa sair.
    await db.insert(contactAssets).values({
      ownerId: CONTA, contactId: um.contactId, tagSlug: "rotulo-antigo", tagLabel: "Rótulo antigo", category: null,
      description: null, origem: "cnae", createdAt: 1, updatedAt: 1,
    });
    // A dona mudou à mão (origem nula): fica.
    await db.insert(contactAssets).values({
      ownerId: CONTA, contactId: um.contactId, tagSlug: "servicos-advocaticios", tagLabel: "Serviços advocatícios", category: null,
      description: null, origem: null, createdAt: 1, updatedAt: 1,
    });
    // O ativado decide sozinho: a CNAE dele não volta.
    await db.update(entidadeMembros).set({ estado: "ativado" }).where(eq(entidadeMembros.id, dois.membroId));
    await db.update(entidadeMembros).set({ cnaesSecundarios: ["6201501"] }).where(eq(entidadeMembros.id, dois.membroId));

    await expect(rotaDe(CONTA, { isEntidade: true }).entidades.admin.refazerOfertasDaCnae({ id: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const [entidade] = await db.select({ id: entidades.id }).from(entidades).where(eq(entidades.ownerId, CONTA));
    const r = await rotaDe(STAFF, { role: "admin" }).entidades.admin.refazerOfertasDaCnae({ id: entidade.id });
    expect(r).toEqual({ membros: 2, ofertas: 1 });

    const depois = await itensDe(um.contactId);
    expect(depois.tenho).toEqual(expect.arrayContaining([
      { label: "Serviços advocatícios", origem: null, category: null },
      { label: "Transporte rodoviário de carga", origem: "cnae", category: null },
    ]));
    expect(depois.tenho).toHaveLength(2);
    expect((await itensDe(dois.contactId)).tenho).toEqual([{ label: "Cultivo de arroz", origem: "entidade", category: null }]);
    const auditoria = await db.select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.userId, ids[STAFF]), eq(auditLogs.action, "ENTIDADE_OFERTAS_DA_CNAE_REFEITAS")));
    expect(auditoria).toEqual([{ details: { membros: 2, ofertas: 1 } }]);
    await expect(rotaDe(STAFF, { role: "admin" }).entidades.admin.refazerOfertasDaCnae({ id: 999_999_999 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
