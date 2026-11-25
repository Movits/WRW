import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

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
const servico = await import("./entidades");
const { lerRedeGlobalAnonima } = await import("./network-rede-global");
const { excluirConta } = await import("./exclusao-de-conta");
const { appRouter } = await import("./routers");

/**
 * A base das associações (N1) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES se pula): a importação em blocos com transação, os
 * repetidos entre blocos, o ensaio que não grava, a atualização, a outra
 * entidade, a lista com busca, o contato com auditoria, o convite, o que o
 * cruzamento global lê (nunca o nome nem o documento), o convênio encerrado e
 * a exclusão da conta levando tudo.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const CONTA_A = `teste-entidade-a-${sufixo}`;
const CONTA_B = `teste-entidade-b-${sufixo}`;
const STAFF = `teste-entidade-staff-${sufixo}`;
const COMUM = `teste-entidade-comum-${sufixo}`;
const EMAIL_A = `entidade-a-${sufixo}@exemplo.com`;
const EMAIL_B = `entidade-b-${sufixo}@exemplo.com`;

/** CNPJ válido a partir de 12 dígitos (os verificadores calculados aqui, não copiados de base real). */
function cnpj(base12: string): string {
  const dv = (b: string, pesos: number[]) => {
    const resto = pesos.reduce((s, p, i) => s + Number(b[i]) * p, 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}
const doc = (n: number) => cnpj(String(90_000_000_0000 + n).padStart(12, "0"));

let ids: Record<string, number> = {};
const conta = (openId: string, extra: Record<string, unknown> = {}) => ({
  user: { id: ids[openId], openId, role: "silver", onboardingCompleted: true, isEntidade: false, ...extra },
  req: { headers: {} }, res: { cookie: () => {} },
});
const rotaDe = (openId: string, extra: Record<string, unknown> = {}) => appRouter.createCaller(conta(openId, extra) as never);

async function importar(openId: string, modo: "ensaio" | "aplicar", linhas: Array<Record<string, string>>, bloco = 2) {
  const rota = rotaDe(openId, { isEntidade: true });
  const { importacaoId } = await rota.entidades.iniciarImportacao({ modo, arquivoSha256: "a".repeat(64), totalLinhas: linhas.length });
  const problemas: Array<{ linha: number; codigo: string; primeira?: number }> = [];
  let novos = 0;
  for (let inicio = 0; inicio < linhas.length; inicio += bloco) {
    const r = await rota.entidades.importarBloco({ importacaoId, inicio, linhas: linhas.slice(inicio, inicio + bloco) });
    problemas.push(...r.problemas);
    novos += r.novos;
  }
  const relatorio = await rota.entidades.concluirImportacao({ importacaoId });
  return { importacaoId, relatorio, problemas, novos };
}

describe.skipIf(!temBanco)("Base das associações (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: CONTA_A, email: EMAIL_A, onboardingCompleted: true },
      { openId: CONTA_B, email: EMAIL_B, onboardingCompleted: true },
      { openId: STAFF, role: "admin", onboardingCompleted: true },
      { openId: COMUM, onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [CONTA_A, CONTA_B, STAFF, COMUM]));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const donas = [CONTA_A, CONTA_B, STAFF, COMUM];
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

  const dados = {
    tipo: "associacao" as const, convenioEstado: "ativo" as const, convenioInicio: null, convenioFim: null,
    convenioReferencia: "Convênio de teste", mostrarNomeNoMatch: false, disponivelPorPadrao: true,
  };

  it("a equipe cria a entidade a partir de uma conta; a conta comum e a da equipe não podem", async () => {
    const staff = rotaDe(STAFF, { role: "admin" });
    await expect(rotaDe(COMUM).entidades.admin.listar()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await staff.entidades.admin.criar({ ...dados, nome: "Associação A", pais: "BR", emailDaConta: EMAIL_A });
    await staff.entidades.admin.criar({ ...dados, nome: "Associação B", pais: "BR", emailDaConta: EMAIL_B });
    await expect(staff.entidades.admin.criar({ ...dados, nome: "De novo", pais: "BR", emailDaConta: EMAIL_A }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "CONTA_JA_EH_ENTIDADE" });
    await expect(staff.entidades.admin.criar({ ...dados, nome: "Ninguém", pais: "BR", emailDaConta: `nao-existe-${sufixo}@exemplo.com` }))
      .rejects.toMatchObject({ message: "CONTA_NAO_ENCONTRADA" });
    const db = (await getDb())!;
    const [a] = await db.select({ isEntidade: users.isEntidade }).from(users).where(eq(users.openId, CONTA_A));
    expect(a.isEntidade).toBe(true);
    const lista = await staff.entidades.admin.listar();
    const minha = lista.find(e => e.nome === "Associação A")!;
    expect(minha).toMatchObject({ pais: "BR", importados: 0, contaEmail: EMAIL_A });
    // Nenhuma coluna de associado na lista da equipe.
    expect(Object.keys(minha)).not.toContain("documentoCifrado");
  });

  it("conta sem o poder de entidade leva FORBIDDEN; com a flag mas sem a linha, também", async () => {
    await expect(rotaDe(COMUM).entidades.minha()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rotaDe(COMUM, { isEntidade: true }).entidades.minha()).rejects.toMatchObject({ code: "FORBIDDEN", message: "ENTIDADE_NAO_ENCONTRADA" });
  });

  it("o ensaio relata tudo e não grava nenhum contato; o repetido é achado entre blocos", async () => {
    const linhas = [
      { documento: doc(1), nome: "Empresa Um", o_que_tem: "Café torrado", o_que_precisa: "Embalagens", data_da_declaracao: "01/11/2026" },
      { documento: doc(2), nome: "Empresa Dois", cnae_principal: "1091-1/02" },
      { documento: "123", nome: "Inválida" },
      { documento: doc(1), nome: "Empresa Um de novo" },
    ];
    const { relatorio, problemas, novos } = await importar(CONTA_A, "ensaio", linhas);
    expect(relatorio).toMatchObject({ modo: "ensaio", linhasProcessadas: 4, criados: 2, atualizados: 0, recusados: 2 });
    // Os novos (o que ainda não está na base) vão à tela, que avisa do teto já no ensaio.
    expect(novos).toBe(2);
    expect(problemas).toEqual(expect.arrayContaining([
      { linha: 4, codigo: "DOCUMENTO_INVALIDO" },
      { linha: 5, codigo: "REPETIDO_NO_ARQUIVO", primeira: 2 },
    ]));
    const db = (await getDb())!;
    expect(await db.select().from(privateContacts).where(eq(privateContacts.ownerId, CONTA_A))).toHaveLength(0);
    expect(await db.select().from(importacaoDocumentosVistos).where(eq(importacaoDocumentosVistos.ownerId, CONTA_A))).toHaveLength(0);
  });

  it("aplicar cria contatos com ID anônimo, disponíveis, com o que tem e o que precisa; documento e contato só cifrados", async () => {
    const { relatorio } = await importar(CONTA_A, "aplicar", [
      { documento: doc(1), nome: "Empresa Um", o_que_tem: "Café torrado", o_que_precisa: "Embalagens", data_da_declaracao: "01/11/2026", telefone: "(11) 3456-7890", email: "um@exemplo.com" },
      { documento: doc(2), nome: "Empresa Dois", cnae_principal: "1091-1/02", uf: "SP" },
      { documento: doc(3), nome: "Empresa Três", o_que_tem: "Frete rodoviário" },
    ]);
    expect(relatorio).toMatchObject({ criados: 3, recusados: 0 });
    const db = (await getDb())!;
    const contatos = await db.select().from(privateContacts).where(eq(privateContacts.ownerId, CONTA_A));
    expect(contatos).toHaveLength(3);
    for (const c of contatos) {
      expect(c.codigoAnonimo).toMatch(/^NW-[0-9A-F]{6}$/);
      expect(c.disponivelRedeGlobal).toBe(true);
      expect(c.nivelVisibilidade).toBe("privado");
      expect(c.phone).toBeNull();
      expect(c.email).toBeNull();
    }
    const membros = await db.select().from(entidadeMembros).where(eq(entidadeMembros.ownerId, CONTA_A));
    expect(membros).toHaveLength(3);
    const um = membros.find(m => m.contatoCifrado)!;
    expect(um.documentoCifrado).not.toContain(doc(1));
    expect(um.contatoCifrado).not.toContain("um@exemplo.com");
    expect(um.documentoHmac).not.toContain(doc(1));
    expect(um).toMatchObject({ precisoOrigem: "entidade", precisoDeclaradoEm: Date.UTC(2026, 10, 1), estado: "importado" });
    const dois = membros.find(m => m.cnaePrincipal)!;
    expect(dois.cnaePrincipal).toBe("1091102");
    // A CNAE não vira necessidade (vira oferta, pela N4: server/cnae-como-oferta.integracao.test.ts).
    const precisoDoDois = await db.select().from(contactNeeds).where(eq(contactNeeds.contactId, Number(dois.contactId)));
    expect(precisoDoDois).toHaveLength(0);
  });

  it("o cruzamento global lê só o código e os itens; nunca o nome; e o convênio encerrado tira a entidade", async () => {
    const rede = await lerRedeGlobalAnonima({ somenteDona: CONTA_A });
    expect(rede).toHaveLength(3);
    const texto = JSON.stringify(rede);
    expect(texto).not.toContain("Empresa Um");
    expect(texto).not.toContain(doc(1));
    expect(rede.find(c => c.tenho.some(t => t.label === "Café torrado"))?.preciso).toEqual([{ label: "Embalagens", category: null }]);

    const db = (await getDb())!;
    await db.update(entidades).set({ convenioEstado: "encerrado" }).where(eq(entidades.ownerId, CONTA_A));
    expect(await lerRedeGlobalAnonima({ somenteDona: CONTA_A })).toHaveLength(0);
    await expect(rotaDe(CONTA_A, { isEntidade: true }).entidades.iniciarImportacao({ modo: "ensaio", arquivoSha256: "b".repeat(64), totalLinhas: 1 }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CONVENIO_INATIVO" });
    await db.update(entidades).set({ convenioEstado: "ativo" }).where(eq(entidades.ownerId, CONTA_A));
  });

  it("reimportar atualiza o importado (troca os itens), não toca o ativado e recusa o removido", async () => {
    const db = (await getDb())!;
    await db.update(entidadeMembros).set({ estado: "ativado" })
      .where(and(eq(entidadeMembros.ownerId, CONTA_A), eq(entidadeMembros.cnaePrincipal, "1091102")));
    const [tres] = await db.select().from(entidadeMembros).where(and(eq(entidadeMembros.ownerId, CONTA_A), eq(entidadeMembros.estado, "importado")))
      .orderBy(entidadeMembros.id).limit(1);
    const { relatorio, problemas, novos } = await importar(CONTA_A, "aplicar", [
      { documento: doc(1), nome: "Empresa Um Ltda", o_que_tem: "Café especial" },
      { documento: doc(2), nome: "Empresa Dois" },
      { documento: doc(4), nome: "Empresa Quatro" },
    ]);
    expect(relatorio).toMatchObject({ criados: 1, atualizados: 1, recusados: 0 });
    expect(novos).toBe(1);
    expect(problemas).toEqual(expect.arrayContaining([{ linha: 3, codigo: "MEMBRO_ATIVADO_NAO_ALTERADO" }]));
    const [contatoUm] = await db.select().from(privateContacts).where(eq(privateContacts.id, Number(tres.contactId)));
    expect(contatoUm.fullName).toBe("Empresa Um Ltda");
    const itens = await db.select({ label: contactAssets.tagLabel }).from(contactAssets).where(eq(contactAssets.contactId, Number(tres.contactId)));
    expect(itens.map(i => i.label)).toEqual(["Café especial"]);
    expect(await db.select().from(contactNeeds).where(eq(contactNeeds.contactId, Number(tres.contactId)))).toHaveLength(0);

    await db.update(entidadeMembros).set({ estado: "removido" }).where(eq(entidadeMembros.id, tres.id));
    const removido = await importar(CONTA_A, "ensaio", [{ documento: doc(1), nome: "Empresa Um" }]);
    expect(removido.problemas).toEqual([{ linha: 2, codigo: "MEMBRO_REMOVIDO" }]);
    await db.update(entidadeMembros).set({ estado: "importado" }).where(eq(entidadeMembros.id, tres.id));
  });

  it("a mesma empresa em outra entidade é outro registro, e o relatório não conta nada à outra", async () => {
    const { relatorio, problemas } = await importar(CONTA_B, "aplicar", [{ documento: doc(1), nome: "Empresa Um" }]);
    expect(relatorio).toMatchObject({ criados: 1, atualizados: 0, recusados: 0 });
    expect(problemas).toEqual([{ linha: 2, codigo: "SEM_OFERTA_NEM_NECESSIDADE" }]);
    const b = await rotaDe(CONTA_B, { isEntidade: true }).entidades.membros({});
    expect(b.total).toBe(1);
  });

  it("bloco fora de ordem ou repetido recusa com CONFLICT, e a contagem não dobra", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const { importacaoId } = await rota.entidades.iniciarImportacao({ modo: "ensaio", arquivoSha256: "c".repeat(64), totalLinhas: 2 });
    await rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas: [{ documento: doc(9), nome: "Nove" }] });
    await expect(rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas: [{ documento: doc(9), nome: "Nove" }] }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "BLOCO_FORA_DE_ORDEM" });
    await expect(rotaDe(CONTA_B, { isEntidade: true }).entidades.importarBloco({ importacaoId, inicio: 1, linhas: [{ documento: doc(8), nome: "Oito" }] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const relatorio = await rota.entidades.concluirImportacao({ importacaoId });
    expect(relatorio.linhasProcessadas).toBe(1);
    await expect(rota.entidades.concluirImportacao({ importacaoId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("o painel lista código, nome e documento, busca por nome, código e documento, e audita", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const todos = await rota.entidades.membros({});
    expect(todos.total).toBe(4);
    expect(todos.membros.map(m => m.nome)).toEqual(["Empresa Dois", "Empresa Quatro", "Empresa Três", "Empresa Um Ltda"]);
    const um = todos.membros.find(m => m.nome === "Empresa Um Ltda")!;
    expect(um.documento).toBe(`${doc(1).slice(0, 2)}.${doc(1).slice(2, 5)}.${doc(1).slice(5, 8)}/${doc(1).slice(8, 12)}-${doc(1).slice(12)}`);
    expect((await rota.entidades.membros({ busca: "quat" })).membros.map(m => m.nome)).toEqual(["Empresa Quatro"]);
    expect((await rota.entidades.membros({ busca: um.documento! })).membros.map(m => m.id)).toEqual([um.id]);
    expect((await rota.entidades.membros({ busca: um.codigo! })).membros.map(m => m.id)).toEqual([um.id]);
    expect((await rota.entidades.membros({ busca: "100%" })).total).toBe(0);
    // A outra entidade não vê os associados desta.
    expect((await rotaDe(CONTA_B, { isEntidade: true }).entidades.membros({ busca: "Quatro" })).total).toBe(0);

    const db = (await getDb())!;
    const lidos = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, ids[CONTA_A]), eq(auditLogs.action, "ENTIDADE_MEMBROS_LISTADOS")));
    expect(lidos.length).toBeGreaterThan(0);
  });

  it("o contato do associado sai decifrado só sob pedido, com auditoria; o de outra entidade é NOT_FOUND", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const { membros } = await rota.entidades.membros({ busca: "Empresa Um" });
    const db = (await getDb())!;
    // O primeiro import gravou o contato; a reimportação sem telefone e e-mail o apagou.
    const contato = await rota.entidades.contatoDoMembro({ membroId: membros[0].id });
    expect(contato).toEqual({ telefone: null, email: null });
    const [dois] = (await rota.entidades.membros({ busca: "Dois" })).membros;
    await expect(rotaDe(CONTA_B, { isEntidade: true }).entidades.contatoDoMembro({ membroId: dois.id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const auditoria = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, ids[CONTA_A]), eq(auditLogs.action, "ENTIDADE_CONTATO_LIDO")));
    expect(auditoria).toHaveLength(1);
  });

  it("o convite: gera, mostra de novo, abre sem conta, troca invalida o anterior, revoga", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    expect(await rota.entidades.convite()).toBeNull();
    const { token } = await rota.entidades.gerarConvite();
    expect((await rota.entidades.convite())?.token).toBe(token);
    const publico = appRouter.createCaller({ user: null, req: { headers: {} }, res: { cookie: () => {} } } as never);
    expect(await publico.conviteDeEntidade.ver({ token })).toEqual({ nome: "Associação A", pais: "BR" });
    const { token: novo } = await rota.entidades.gerarConvite();
    await expect(publico.conviteDeEntidade.ver({ token })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await publico.conviteDeEntidade.ver({ token: novo })).toMatchObject({ nome: "Associação A" });
    await rota.entidades.revogarConvite();
    await expect(publico.conviteDeEntidade.ver({ token: novo })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a conta de entidade não põe contato em 'ouro' nem 'publico'", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const erro = await rota.network.create({ fullName: "Contato aberto", nivelVisibilidade: "publico" } as never).catch(e => e);
    expect(erro).toBeInstanceOf(TRPCError);
    expect(erro).toMatchObject({ code: "FORBIDDEN", message: "ENTIDADE_SO_PRIVADO" });
  });

  it("excluir a conta da entidade leva a entidade, os associados, as importações e os itens", async () => {
    const db = (await getDb())!;
    await excluirConta(db, { id: ids[CONTA_B], openId: CONTA_B, email: EMAIL_B }, { apagarArquivo: async () => {}, revogarGoogle: async () => "sem_conexao" as never });
    expect(await db.select().from(entidades).where(eq(entidades.ownerId, CONTA_B))).toHaveLength(0);
    expect(await db.select().from(entidadeMembros).where(eq(entidadeMembros.ownerId, CONTA_B))).toHaveLength(0);
    expect(await db.select().from(importacoesDeEntidade).where(eq(importacoesDeEntidade.ownerId, CONTA_B))).toHaveLength(0);
    expect(await db.select().from(privateContacts).where(eq(privateContacts.ownerId, CONTA_B))).toHaveLength(0);
  });
});
