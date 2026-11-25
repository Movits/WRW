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
  privateContacts, sessions, userProfiles, users,
} = await import("../drizzle/schema");
const ativacao = await import("./entidades-ativacao");
const { entidadeDaConta } = await import("./entidades");
const { excluirConta } = await import("./exclusao-de-conta");
const { appRouter } = await import("./routers");
const { VALIDADE_DA_ATIVACAO_MS } = await import("../shared/entidades");

/**
 * A ativação do cadastro importado (N3) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES se pula): o link de uso único e com validade, a troca
 * que invalida o anterior, a outra entidade, o convênio encerrado, o que a
 * página mostra (nunca o documento nem o contato), a conta que nasce com só o
 * que a pessoa confirmou, o contato que sai da rede, o e-mail repetido, os dois
 * envios ao mesmo tempo e a exclusão da conta ativada.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const CONTA_A = `teste-ativacao-a-${sufixo}`;
const CONTA_B = `teste-ativacao-b-${sufixo}`;
const STAFF = `teste-ativacao-staff-${sufixo}`;
const EMAIL_A = `ativacao-a-${sufixo}@exemplo.com`;
const EMAIL_B = `ativacao-b-${sufixo}@exemplo.com`;
const emailNovo = (n: string) => `ativou-${n}-${sufixo}@exemplo.com`;

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
const cookies: string[] = [];
const publico = () => appRouter.createCaller({
  user: null, req: { headers: {}, ip: "203.0.113.7" }, res: { cookie: (nome: string) => cookies.push(nome) },
} as never);

async function importar(openId: string, linhas: Array<Record<string, string>>) {
  const rota = rotaDe(openId, { isEntidade: true });
  const { importacaoId } = await rota.entidades.iniciarImportacao({ modo: "aplicar", arquivoSha256: "b".repeat(64), totalLinhas: linhas.length });
  await rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas });
  await rota.entidades.concluirImportacao({ importacaoId });
}

const formulario = (n: string, extra: Record<string, unknown> = {}) => ({
  nome: "Pessoa da Empresa", email: emailNovo(n), senha: "senha-forte-123", empresa: "", tenho: [] as string[], preciso: [] as string[], ...extra,
});

describe.skipIf(!temBanco)("Ativação do cadastro importado (integração)", () => {
  let membros: Array<{ id: number; nome: string }> = [];
  const membro = (nome: string) => membros.find(m => m.nome === nome)!.id;

  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: CONTA_A, email: EMAIL_A, onboardingCompleted: true },
      { openId: CONTA_B, email: EMAIL_B, onboardingCompleted: true },
      { openId: STAFF, role: "admin", onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [CONTA_A, CONTA_B, STAFF]));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
    const staff = rotaDe(STAFF, { role: "admin" });
    const dados = {
      tipo: "associacao" as const, convenioEstado: "ativo" as const, convenioInicio: null, convenioFim: null,
      convenioReferencia: null, mostrarNomeNoMatch: false, disponivelPorPadrao: true,
    };
    await staff.entidades.admin.criar({ ...dados, nome: "Associação Ativa", pais: "BR", emailDaConta: EMAIL_A });
    await staff.entidades.admin.criar({ ...dados, nome: "Associação Outra", pais: "BR", emailDaConta: EMAIL_B });
    await importar(CONTA_A, [
      { documento: doc(1), nome: "Empresa Um", o_que_tem: "Café torrado; Frete rodoviário", o_que_precisa: "Embalagens", data_da_declaracao: "01/11/2026", telefone: "(11) 3456-7890", email: "um@exemplo.com" },
      { documento: doc(2), nome: "Empresa Dois", o_que_tem: "Grãos" },
      { documento: doc(3), nome: "Empresa Três", o_que_tem: "Mel" },
      { documento: doc(4), nome: "Empresa Quatro", o_que_tem: "Leite" },
      { documento: doc(5), nome: "Empresa Cinco", o_que_tem: "Queijo" },
    ]);
    membros = (await rotaDe(CONTA_A, { isEntidade: true }).entidades.membros({})).membros;
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const donas = [CONTA_A, CONTA_B, STAFF];
    const novas = await db.select({ id: users.id }).from(users).where(inArray(users.email, ["1", "2", "3", "4", "5", "6", "7"].map(emailNovo)));
    const idsNovos = novas.map(n => n.id);
    if (idsNovos.length) {
      await db.delete(sessions).where(inArray(sessions.userId, idsNovos));
      await db.delete(userProfiles).where(inArray(userProfiles.userId, idsNovos));
      await db.delete(auditLogs).where(inArray(auditLogs.userId, idsNovos));
      await db.delete(users).where(inArray(users.id, idsNovos));
    }
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

  it("a entidade gera o link de um associado; a página mostra a entidade, a empresa e os itens, nunca o documento nem o contato", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const { links, proximo } = await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Um")] });
    expect(proximo).toBeNull();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ nome: "Empresa Um", membroId: membro("Empresa Um") });
    expect(links[0].token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const vista = await publico().ativacaoDeCadastro.ver({ token: links[0].token });
    expect(vista).toEqual({
      entidade: "Associação Ativa", pais: "BR", empresa: "Empresa Um", uf: null,
      tenho: ["Café torrado", "Frete rodoviário"], preciso: ["Embalagens"], expiraEm: links[0].expiraEm,
    });
    expect(JSON.stringify(vista)).not.toContain(doc(1));
    expect(JSON.stringify(vista)).not.toContain("3456");
    // O banco guarda só o hash; a lista mostra só a validade.
    const db = (await getDb())!;
    const [linha] = await db.select({ hash: entidadeMembros.ativacaoHash }).from(entidadeMembros).where(eq(entidadeMembros.id, membro("Empresa Um")));
    expect(linha.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(linha.hash).not.toContain(links[0].token);
    const lista = await rota.entidades.membros({ busca: "Empresa Um" });
    expect(lista.membros[0].ativacaoValidaAte).toBe(links[0].expiraEm);
    const auditoria = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, ids[CONTA_A]), eq(auditLogs.action, "ENTIDADE_ATIVACAO_GERADA")));
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].details).toMatchObject({ quantos: 1, trocados: 0, modo: "escolhidos" });
  });

  it("gerar de novo troca o link: o anterior deixa de abrir na hora", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const [antigo] = (await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Dois")] })).links;
    const [novo] = (await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Dois")] })).links;
    await expect(publico().ativacaoDeCadastro.ver({ token: antigo.token })).rejects.toMatchObject({ code: "NOT_FOUND", message: "ATIVACAO_NAO_ENCONTRADA" });
    expect(await publico().ativacaoDeCadastro.ver({ token: novo.token })).toMatchObject({ empresa: "Empresa Dois" });
  });

  it("a outra entidade não gera link para associado desta; token malformado ou inventado responde igual", async () => {
    const outra = rotaDe(CONTA_B, { isEntidade: true });
    expect((await outra.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Três")] })).links).toEqual([]);
    await expect(publico().ativacaoDeCadastro.ver({ token: "curto" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "ATIVACAO_NAO_ENCONTRADA" });
    await expect(publico().ativacaoDeCadastro.ver({ token: "x".repeat(32) })).rejects.toMatchObject({ code: "NOT_FOUND", message: "ATIVACAO_NAO_ENCONTRADA" });
  });

  it("o link vencido não abre nem ativa", async () => {
    const entidade = await entidadeDaConta(CONTA_A);
    const passado = Date.now() - VALIDADE_DA_ATIVACAO_MS - 1000;
    const [vencido] = (await ativacao.gerarLinksDeAtivacao(entidade, ids[CONTA_A], { membroIds: [membro("Empresa Quatro")] }, passado)).links;
    await expect(publico().ativacaoDeCadastro.ver({ token: vencido.token })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(publico().ativacaoDeCadastro.ativar({ token: vencido.token, ...formulario("4") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Gerar os pendentes pega de novo o vencido (e os que nunca tiveram link), não o que vale.
    const { links } = await rotaDe(CONTA_A, { isEntidade: true }).entidades.gerarLinksDeAtivacao({ pendentesDepoisDoId: 0 });
    const nomes = links.map(l => l.nome).sort();
    expect(nomes).toEqual(["Empresa Cinco", "Empresa Quatro", "Empresa Três"]);
  });

  it("ativar cria a conta com só o que a pessoa confirmou, abre a sessão, marca o associado e tira o contato da rede", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const [link] = (await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Um")] })).links;
    cookies.length = 0;
    const r = await publico().ativacaoDeCadastro.ativar({
      token: link.token,
      ...formulario("1", { empresa: "Empresa Um Ltda", tenho: ["Café torrado", "Item inventado"], preciso: ["Embalagens"] }),
    });
    expect(r).toEqual({ ok: true });
    expect(cookies).toHaveLength(1);
    const db = (await getDb())!;
    const [nova] = await db.select().from(users).where(eq(users.email, emailNovo("1")));
    expect(nova).toMatchObject({ role: "bronze", onboardingCompleted: false, name: "Pessoa da Empresa", company: "Empresa Um Ltda", country: "BR", isEntidade: false });
    expect(nova.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    const [perfil] = await db.select().from(userProfiles).where(eq(userProfiles.userId, nova.id));
    const lista = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
    // O item que não veio da entidade não entra; o que a pessoa não marcou ("Frete rodoviário") também não.
    expect(lista(perfil.whatIHave)).toEqual(["Café torrado"]);
    expect(lista(perfil.whatINeed)).toEqual(["Embalagens"]);
    expect(perfil.companyCnpj).toBeNull();
    const [m] = await db.select().from(entidadeMembros).where(eq(entidadeMembros.id, membro("Empresa Um")));
    expect(m).toMatchObject({ estado: "ativado", ativadoUserId: nova.id, ativacaoHash: null, ativacaoExpiraEm: null });
    const [c] = await db.select().from(privateContacts).where(eq(privateContacts.id, Number(m.contactId)));
    expect(c.disponivelRedeGlobal).toBe(false);
    const [prova] = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, nova.id), eq(auditLogs.action, "ENTIDADE_CADASTRO_ATIVADO")));
    expect(prova.details).toMatchObject({ tenhoConfirmados: 1, tenhoImportados: 2, precisoConfirmados: 1, empresaAlterada: true });
    expect(await db.select().from(sessions).where(eq(sessions.userId, nova.id))).toHaveLength(1);
    // Uso único: o mesmo link não abre nem ativa de novo.
    await expect(publico().ativacaoDeCadastro.ver({ token: link.token })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(publico().ativacaoDeCadastro.ativar({ token: link.token, ...formulario("2") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Ativado não ganha link novo.
    expect((await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Um")] })).links).toEqual([]);
  });

  it("e-mail que já tem conta recusa com código e não gasta o link", async () => {
    const [link] = (await rotaDe(CONTA_A, { isEntidade: true }).entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Três")] })).links;
    await expect(publico().ativacaoDeCadastro.ativar({ token: link.token, ...formulario("x", { email: EMAIL_B }) }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "ATIVACAO_EMAIL_JA_CADASTRADO" });
    expect(await publico().ativacaoDeCadastro.ver({ token: link.token })).toMatchObject({ empresa: "Empresa Três" });
  });

  it("dois envios do mesmo link ao mesmo tempo: só um cria conta", async () => {
    const [link] = (await rotaDe(CONTA_A, { isEntidade: true }).entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Cinco")] })).links;
    const resultados = await Promise.allSettled([
      publico().ativacaoDeCadastro.ativar({ token: link.token, ...formulario("5") }),
      publico().ativacaoDeCadastro.ativar({ token: link.token, ...formulario("6") }),
    ]);
    expect(resultados.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const falha = resultados.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(falha.reason).toMatchObject({ code: "NOT_FOUND" });
    const db = (await getDb())!;
    expect(await db.select().from(users).where(inArray(users.email, [emailNovo("5"), emailNovo("6")]))).toHaveLength(1);
  });

  it("com o convênio encerrado, o link não abre e a entidade não gera link", async () => {
    const rota = rotaDe(CONTA_A, { isEntidade: true });
    const [link] = (await rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Três")] })).links;
    const db = (await getDb())!;
    await db.update(entidades).set({ convenioEstado: "encerrado" }).where(eq(entidades.ownerId, CONTA_A));
    try {
      await expect(publico().ativacaoDeCadastro.ver({ token: link.token })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(publico().ativacaoDeCadastro.ativar({ token: link.token, ...formulario("7") })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(rota.entidades.gerarLinksDeAtivacao({ membroIds: [membro("Empresa Três")] }))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CONVENIO_INATIVO" });
    } finally {
      await db.update(entidades).set({ convenioEstado: "ativo" }).where(eq(entidades.ownerId, CONTA_A));
    }
  });

  it("excluir a conta ativada solta o associado da conta, sem apagar o registro da entidade", async () => {
    const db = (await getDb())!;
    const [nova] = await db.select().from(users).where(eq(users.email, emailNovo("1")));
    await excluirConta(db, { id: nova.id, openId: nova.openId, email: nova.email }, { apagarArquivo: async () => {}, revogarGoogle: async () => "sem_conexao" as never });
    const [m] = await db.select().from(entidadeMembros).where(eq(entidadeMembros.id, membro("Empresa Um")));
    expect(m).toMatchObject({ estado: "ativado", ativadoUserId: null });
  });
});
