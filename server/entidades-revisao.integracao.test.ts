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
  auditLogs, consents, contactAssets, contactNeeds, documentVersions, entidadeMembros, entidades, importacaoDocumentosVistos,
  importacoesDeEntidade, privateContacts, users,
} = await import("../drizzle/schema");
const { lerRedeGlobalAnonima } = await import("./network-rede-global");
const { appRouter } = await import("./routers");
const { ASSOCIADOS_MAX_POR_ENTIDADE, LINHAS_POR_ARQUIVO_MAX } = await import("../shared/entidades");

/**
 * Os achados da revisão do pacote da base das associações, contra um banco
 * real DE TESTE (sem DATABASE_URL_TESTES se pula):
 * 1. apagar o contato de um associado o tira da base (removido, só o HMAC);
 * 2. a entidade não derruba a leitura global das outras donas (janela própria,
 *    filtro da autorização antes do teto) e a base tem teto até a N4b;
 * 3. a conta que vira entidade não deixa contato em ouro nem público.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const ENTIDADE = `teste-revisao-ent-${sufixo}`;
const COMUM = `teste-revisao-comum-${sufixo}`;
const QUEM_BUSCA = `teste-revisao-busca-${sufixo}`;
const STAFF = `teste-revisao-staff-${sufixo}`;
const EMAIL_ENTIDADE = `revisao-ent-${sufixo}@exemplo.com`;
const DONAS = [ENTIDADE, COMUM, QUEM_BUSCA, STAFF];

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
const conta = (openId: string, extra: Record<string, unknown> = {}) => ({
  user: { id: ids[openId], openId, role: "silver", onboardingCompleted: true, isEntidade: false, ...extra },
  req: { headers: {} }, res: { cookie: () => {} },
});
const rotaDe = (openId: string, extra: Record<string, unknown> = {}) => appRouter.createCaller(conta(openId, extra) as never);
const daEntidade = () => rotaDe(ENTIDADE, { isEntidade: true });

async function importar(modo: "ensaio" | "aplicar", linhas: Array<Record<string, string>>) {
  const rota = daEntidade();
  const { importacaoId } = await rota.entidades.iniciarImportacao({ modo, arquivoSha256: "d".repeat(64), totalLinhas: linhas.length });
  const r = await rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas });
  await rota.entidades.concluirImportacao({ importacaoId });
  return r;
}

const codigosUsados = new Set<string>();
function codigoNovo() {
  let codigo = "";
  do codigo = `NW-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; while (codigosUsados.has(codigo));
  codigosUsados.add(codigo);
  return codigo;
}

describe.skipIf(!temBanco)("Base das associações: achados da revisão (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: ENTIDADE, email: EMAIL_ENTIDADE, onboardingCompleted: true },
      { openId: COMUM, onboardingCompleted: true },
      { openId: QUEM_BUSCA, onboardingCompleted: true },
      { openId: STAFF, role: "admin", onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, DONAS));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
    // Se houver termo do Smart Match vigente neste banco, as donas o aceitam (a leitura global o exige).
    const [termo] = await db.select({ id: documentVersions.id }).from(documentVersions)
      .where(and(eq(documentVersions.type, "termo_smart_match"), eq(documentVersions.isCurrent, true))).limit(1);
    if (termo) {
      await db.insert(consents).values(DONAS.map(openId => ({
        userId: ids[openId], documentVersionId: termo.id,
      })) as never);
    }
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(importacaoDocumentosVistos).where(inArray(importacaoDocumentosVistos.ownerId, DONAS));
    await db.delete(importacoesDeEntidade).where(inArray(importacoesDeEntidade.ownerId, DONAS));
    await db.delete(entidadeMembros).where(inArray(entidadeMembros.ownerId, DONAS));
    await db.delete(contactAssets).where(inArray(contactAssets.ownerId, DONAS));
    await db.delete(contactNeeds).where(inArray(contactNeeds.ownerId, DONAS));
    await db.delete(privateContacts).where(inArray(privateContacts.ownerId, DONAS));
    await db.delete(entidades).where(inArray(entidades.ownerId, DONAS));
    await db.delete(consents).where(inArray(consents.userId, Object.values(ids)));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, Object.values(ids)));
    await db.delete(users).where(inArray(users.openId, DONAS));
  });

  it("a conta que vira entidade tem os contatos de ouro e público rebaixados a privado, na mesma transação", async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    await db.insert(privateContacts).values([
      { ownerId: ENTIDADE, fullName: "Contato público antigo", nivelVisibilidade: "publico", createdAt: agora, updatedAt: agora },
      { ownerId: ENTIDADE, fullName: "Contato ouro antigo", nivelVisibilidade: "ouro", createdAt: agora, updatedAt: agora },
    ] as never);
    await rotaDe(STAFF, { role: "admin" }).entidades.admin.criar({
      tipo: "associacao", convenioEstado: "ativo", convenioInicio: null, convenioFim: null, convenioReferencia: "Convênio de teste",
      mostrarNomeNoMatch: false, disponivelPorPadrao: true, nome: "Associação da revisão", pais: "BR", emailDaConta: EMAIL_ENTIDADE,
    });
    const contatos = await db.select({ nivel: privateContacts.nivelVisibilidade }).from(privateContacts).where(eq(privateContacts.ownerId, ENTIDADE));
    expect(contatos.map(c => c.nivel)).toEqual(["privado", "privado"]);
    const [prova] = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, ids[STAFF]), eq(auditLogs.action, "ENTIDADE_CRIADA")));
    expect(prova.details).toMatchObject({ contatosRebaixadosParaPrivado: 2 });
    await db.delete(privateContacts).where(eq(privateContacts.ownerId, ENTIDADE));
  });

  it("apagar o contato do associado o tira da base: removido, sem documento nem contato cifrados, e a reimportação recusa", async () => {
    await importar("aplicar", [{ documento: doc(1), nome: "Empresa que sai", o_que_tem: "Café torrado", telefone: "(11) 3456-7890", email: "sai@exemplo.com" }]);
    const rota = daEntidade();
    const { membros } = await rota.entidades.membros({ busca: "Empresa que sai" });
    expect(membros).toHaveLength(1);
    const db = (await getDb())!;
    const [antes] = await db.select().from(entidadeMembros).where(eq(entidadeMembros.id, membros[0].id));
    expect(await rota.entidades.contatoDoMembro({ membroId: membros[0].id })).toEqual({ telefone: "1134567890", email: "sai@exemplo.com" });

    await rota.network.delete({ id: Number(antes.contactId) });

    const [depois] = await db.select().from(entidadeMembros).where(eq(entidadeMembros.id, membros[0].id));
    expect(depois).toMatchObject({
      estado: "removido", contactId: null, documentoCifrado: null, contatoCifrado: null, cnaePrincipal: null, referenciaDaEntidade: null,
      documentoHmac: antes.documentoHmac,
    });
    await expect(rota.entidades.contatoDoMembro({ membroId: membros[0].id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rota.entidades.minha()).membros).toMatchObject({ importados: 0 });
    const r = await importar("aplicar", [{ documento: doc(1), nome: "Empresa que sai", o_que_tem: "Café torrado" }]);
    expect(r.problemas).toEqual([{ linha: 2, codigo: "MEMBRO_REMOVIDO" }]);
    expect(await db.select().from(privateContacts).where(eq(privateContacts.ownerId, ENTIDADE))).toHaveLength(0);
  });

  it("o contato do associado só sai com o contato vivo na rede da entidade (a linha órfã de antes não decifra nada)", async () => {
    await importar("aplicar", [{ documento: doc(3), nome: "Empresa órfã", o_que_tem: "Frete", telefone: "(11) 3456-7891", email: "orfa@exemplo.com" }]);
    const rota = daEntidade();
    const [membro] = (await rota.entidades.membros({ busca: "Empresa órfã" })).membros;
    const db = (await getDb())!;
    const [linha] = await db.select().from(entidadeMembros).where(eq(entidadeMembros.id, membro.id));
    // O contato some por fora do apagarRastroDoContato (o caso das linhas gravadas antes desta correção).
    await db.delete(privateContacts).where(eq(privateContacts.id, Number(linha.contactId)));
    await expect(rota.entidades.contatoDoMembro({ membroId: membro.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.delete(entidadeMembros).where(eq(entidadeMembros.id, membro.id));
    await db.delete(contactAssets).where(eq(contactAssets.ownerId, ENTIDADE));
  });

  it("o aplicar recusa a base acima do teto (50 mil desde a N4b); o ensaio lê o arquivo inteiro", async () => {
    const rota = daEntidade();
    // Desde a N4b o teto da base (50 mil) é o mesmo do arquivo: um arquivo só não passa dele (a entrada recusa
    // antes); o que passa do teto é a base que já tem associados, recusada no bloco, abaixo.
    expect(ASSOCIADOS_MAX_POR_ENTIDADE).toBe(LINHAS_POR_ARQUIVO_MAX);
    await expect(rota.entidades.iniciarImportacao({ modo: "aplicar", arquivoSha256: "e".repeat(64), totalLinhas: ASSOCIADOS_MAX_POR_ENTIDADE + 1 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ensaio = await rota.entidades.iniciarImportacao({ modo: "ensaio", arquivoSha256: "e".repeat(64), totalLinhas: ASSOCIADOS_MAX_POR_ENTIDADE });
    expect(ensaio.importacaoId).toBeGreaterThan(0);
    await rota.entidades.concluirImportacao({ importacaoId: ensaio.importacaoId });

    // A base cheia (o removido do teste anterior não conta): a linha nova recusa, sem gravar nada.
    const db = (await getDb())!;
    const [entidade] = await db.select({ id: entidades.id }).from(entidades).where(eq(entidades.ownerId, ENTIDADE));
    const agora = Date.now();
    // 50 mil linhas desde a N4b: em lotes de 2000 (o INSERT único passava do teto de parâmetros do MySQL).
    const cheia = Array.from({ length: ASSOCIADOS_MAX_POR_ENTIDADE }, (_, i) => ({
      ownerId: ENTIDADE, entidadeId: entidade.id, contactId: null, paisDocumento: "BR", tipoDocumento: "cnpj",
      documentoHmac: crypto.createHash("sha256").update(`cheio-${sufixo}-${i}`).digest("hex"), estado: "importado" as const,
      createdAt: agora, updatedAt: agora,
    }));
    for (let i = 0; i < cheia.length; i += 2000) await db.insert(entidadeMembros).values(cheia.slice(i, i + 2000));
    await expect(importar("aplicar", [{ documento: doc(2), nome: "Empresa que não cabe", o_que_tem: "Frete" }]))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "BASE_ACIMA_DO_TETO" });
    expect(await db.select().from(privateContacts).where(eq(privateContacts.ownerId, ENTIDADE))).toHaveLength(0);
    await db.delete(entidadeMembros).where(and(eq(entidadeMembros.ownerId, ENTIDADE), eq(entidadeMembros.estado, "importado")));
  }, 120_000);

  it("uma entidade com mais de 1000 contatos disponíveis não tira da leitura global os contatos das outras donas", async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    // Os da entidade entram ANTES (ids menores): a janela sem ordem os lia primeiro.
    for (let lote = 0; lote < 3; lote += 1) {
      await db.insert(privateContacts).values(Array.from({ length: 400 }, (_, i) => ({
        ownerId: ENTIDADE, fullName: `Associado ${lote}-${i}`, codigoAnonimo: codigoNovo(), nivelVisibilidade: "privado" as const,
        disponivelRedeGlobal: true, createdAt: agora, updatedAt: agora,
      })));
    }
    const codigoDaComum = codigoNovo();
    await db.insert(privateContacts).values({
      ownerId: COMUM, fullName: "Contato da outra dona", codigoAnonimo: codigoDaComum, nivelVisibilidade: "privado",
      disponivelRedeGlobal: true, createdAt: agora, updatedAt: agora,
    });
    const leComum = async () => (await lerRedeGlobalAnonima({ excetoDona: QUEM_BUSCA })).some(c => c.codigoAnonimo === codigoDaComum);

    // Convênio vigente: a leitura paginada (N4b) alcança os 1200 da entidade E o contato da outra dona.
    expect(await leComum()).toBe(true);
    const daEntidadeLidos = (await lerRedeGlobalAnonima({ somenteDona: ENTIDADE })).length;
    expect(daEntidadeLidos).toBe(1200);

    // Convênio encerrado: os da entidade saem no SQL, antes do teto, e a outra dona segue lida.
    await db.update(entidades).set({ convenioEstado: "encerrado" }).where(eq(entidades.ownerId, ENTIDADE));
    expect(await leComum()).toBe(true);
    expect(await lerRedeGlobalAnonima({ somenteDona: ENTIDADE })).toEqual([]);
    // O convênio com fim de ontem ainda vale hoje; o de anteontem, não (o corte de convenioVigente).
    await db.update(entidades).set({ convenioEstado: "ativo", convenioFim: agora - 86_400_000 + 60_000 }).where(eq(entidades.ownerId, ENTIDADE));
    expect((await lerRedeGlobalAnonima({ somenteDona: ENTIDADE })).length).toBeGreaterThan(0);
    await db.update(entidades).set({ convenioFim: agora - 2 * 86_400_000 }).where(eq(entidades.ownerId, ENTIDADE));
    expect(await lerRedeGlobalAnonima({ somenteDona: ENTIDADE })).toEqual([]);
    await db.update(entidades).set({ convenioFim: null }).where(eq(entidades.ownerId, ENTIDADE));
  });
});
