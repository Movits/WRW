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
  auditLogs, conexoesParticipantes, conexoesRegistradas, contactAssets, contactNeeds, entidadeMembros, entidades,
  importacaoDocumentosVistos, importacoesDeEntidade, pedidosPelaEntidade, privateContacts, userProfiles, users,
} = await import("../drizzle/schema");
const { registrarConexao } = await import("./network-registro");
const { excluirConta } = await import("./exclusao-de-conta");
const { appRouter } = await import("./routers");
const { PEDIDOS_POR_DIA_MAX } = await import("../shared/pedidos-pela-entidade");

/**
 * O pedido de contato pela entidade (N2) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES se pula): o que quem está do outro lado vê ("membro da
 * entidade", com ou sem o nome), o pedido e as recusas iguais, a fila da
 * entidade, as passagens com o estado no WHERE, o canal no "aceito", o prazo,
 * o convênio encerrado, o teto por dia e a exclusão da conta.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = crypto.randomUUID().slice(0, 8);
const ENT_A = `teste-n2-entidade-a-${sufixo}`;
const ENT_B = `teste-n2-entidade-b-${sufixo}`;
const STAFF = `teste-n2-staff-${sufixo}`;
const MEMBRA = `teste-n2-membra-${sufixo}`;
const DONA = `teste-n2-dona-${sufixo}`;
const ESTRANHA = `teste-n2-estranha-${sufixo}`;
const CONTAS = [ENT_A, ENT_B, STAFF, MEMBRA, DONA, ESTRANHA];
const EMAIL_A = `n2-a-${sufixo}@exemplo.com`;
const EMAIL_B = `n2-b-${sufixo}@exemplo.com`;
const TELEFONE = "(11) 3456-7890";
const EMAIL_DA_EMPRESA = `empresa-um-${sufixo}@exemplo.com`;

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
const daEntidade = (openId: string) => rotaDe(openId, { isEntidade: true });

const dados = {
  tipo: "associacao" as const, convenioEstado: "ativo" as const, convenioInicio: null, convenioFim: null,
  convenioReferencia: "Convênio de teste", mostrarNomeNoMatch: false, disponivelPorPadrao: true,
};

let entidadeAId = 0;
let contatoUm = 0;
let contatoDois = 0;
let conexaoMembra = "";
let conexaoDona = "";

async function conexoesDe(openId: string) {
  const r = await rotaDe(openId).networkInteligente.conexoes();
  if (!r.termoAceito) throw new Error("sem termo");
  return r.lista;
}

describe.skipIf(!temBanco)("Pedido de contato pela entidade (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: ENT_A, email: EMAIL_A, name: "Conta da Associação", onboardingCompleted: true },
      { openId: ENT_B, email: EMAIL_B, name: "Conta da Federação", onboardingCompleted: true },
      { openId: STAFF, role: "admin", onboardingCompleted: true },
      { openId: MEMBRA, name: "Marta Membra", onboardingCompleted: true },
      { openId: DONA, name: "Dora Dona", onboardingCompleted: true },
      { openId: ESTRANHA, name: "Estela", onboardingCompleted: true },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, CONTAS));
    ids = Object.fromEntries(linhas.map(l => [l.openId, l.id]));
    await db.insert(userProfiles).values({ userId: ids[MEMBRA], company: "Torrefação da Marta" });

    const staff = rotaDe(STAFF, { role: "admin" });
    entidadeAId = (await staff.entidades.admin.criar({ ...dados, nome: "Associação N2", pais: "BR", emailDaConta: EMAIL_A })).id;
    await staff.entidades.admin.criar({ ...dados, nome: "Federação N2", pais: "BR", emailDaConta: EMAIL_B });

    const rota = daEntidade(ENT_A);
    const planilha = [
      { documento: doc(1), nome: "Empresa Um", o_que_tem: "Café torrado", telefone: TELEFONE, email: EMAIL_DA_EMPRESA },
      { documento: doc(2), nome: "Empresa Dois", o_que_tem: "Frete rodoviário" },
    ];
    const { importacaoId } = await rota.entidades.iniciarImportacao({ modo: "aplicar", arquivoSha256: "b".repeat(64), totalLinhas: planilha.length });
    await rota.entidades.importarBloco({ importacaoId, inicio: 0, linhas: planilha });
    await rota.entidades.concluirImportacao({ importacaoId });
    const contatos = await db.select({ id: privateContacts.id, nome: privateContacts.fullName, codigo: privateContacts.codigoAnonimo })
      .from(privateContacts).where(eq(privateContacts.ownerId, ENT_A));
    const um = contatos.find(c => c.nome === "Empresa Um")!;
    const dois = contatos.find(c => c.nome === "Empresa Dois")!;
    contatoUm = Number(um.id);
    contatoDois = Number(dois.id);

    // Um contato da dona, disponível na rede, do outro lado do associado "Empresa Dois".
    const [criado] = await db.insert(privateContacts).values({
      ownerId: DONA, fullName: "Contato da Dora", disponivelRedeGlobal: true, createdAt: Date.now(), updatedAt: Date.now(), codigoAnonimo: `NW-D${sufixo.slice(0, 5).toUpperCase()}`,
    });
    const contatoDaDona = Number((criado as unknown as { insertId: number }).insertId);

    conexaoMembra = await registrarConexao(db, {
      origem: "NETWORK_PLATFORM_MATCH",
      a: { tipo: "contato", ownerId: ENT_A, contactId: contatoUm, codigoAnonimo: um.codigo, originador: true },
      b: { tipo: "membro", userId: ids[MEMBRA] },
      motivo: `${um.codigo} tem Café torrado, que um membro da plataforma procura.`,
      itens: [{ tem: "Café torrado", precisa: "Café para revenda", deCodigo: um.codigo, paraCodigo: null }],
      pontuacao: 100,
    });
    conexaoDona = await registrarConexao(db, {
      origem: "NETWORK_NETWORK_MATCH",
      a: { tipo: "contato", ownerId: DONA, contactId: contatoDaDona, codigoAnonimo: `NW-D${sufixo.slice(0, 5).toUpperCase()}`, originador: true },
      b: { tipo: "contato", ownerId: ENT_A, contactId: contatoDois, codigoAnonimo: dois.codigo, originador: true },
      motivo: "frete", itens: [{ tem: "Frete rodoviário", precisa: "Transporte de carga", deCodigo: dois.codigo, paraCodigo: null }],
      pontuacao: 100,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(pedidosPelaEntidade).where(inArray(pedidosPelaEntidade.userId, Object.values(ids)));
    await db.delete(pedidosPelaEntidade).where(inArray(pedidosPelaEntidade.ownerId, CONTAS));
    await db.delete(conexoesParticipantes).where(inArray(conexoesParticipantes.conexaoId, [conexaoMembra, conexaoDona].filter(Boolean)));
    await db.delete(conexoesRegistradas).where(inArray(conexoesRegistradas.id, [conexaoMembra, conexaoDona].filter(Boolean)));
    await db.delete(importacaoDocumentosVistos).where(inArray(importacaoDocumentosVistos.ownerId, CONTAS));
    await db.delete(importacoesDeEntidade).where(inArray(importacoesDeEntidade.ownerId, CONTAS));
    await db.delete(entidadeMembros).where(inArray(entidadeMembros.ownerId, CONTAS));
    await db.delete(contactAssets).where(inArray(contactAssets.ownerId, CONTAS));
    await db.delete(contactNeeds).where(inArray(contactNeeds.ownerId, CONTAS));
    await db.delete(privateContacts).where(inArray(privateContacts.ownerId, CONTAS));
    await db.delete(entidades).where(inArray(entidades.ownerId, CONTAS));
    await db.delete(userProfiles).where(inArray(userProfiles.userId, Object.values(ids)));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, Object.values(ids)));
    await db.delete(users).where(inArray(users.openId, CONTAS));
  });

  it("quem está do outro lado vê só 'membro de uma entidade', sem nome, documento nem contato da empresa", async () => {
    const [conexao] = (await conexoesDe(MEMBRA)).filter(c => c.id === conexaoMembra);
    const alheio = conexao.lados.find(l => !l.meu)!;
    expect(alheio).toMatchObject({ tipo: "contato", entidade: { nome: null } });
    expect(conexao).toMatchObject({ podePedirPelaEntidade: true, pedidoPelaEntidade: null });
    const tudo = JSON.stringify(conexao);
    for (const proibido of ["Empresa Um", "Associação N2", TELEFONE, EMAIL_DA_EMPRESA, doc(1)]) expect(tudo).not.toContain(proibido);
  });

  it("com a autorização do convênio, aparece o nome da entidade (e só ele)", async () => {
    await rotaDe(STAFF, { role: "admin" }).entidades.admin.atualizar({ ...dados, id: entidadeAId, nome: "Associação N2", mostrarNomeNoMatch: true });
    const [conexao] = (await conexoesDe(MEMBRA)).filter(c => c.id === conexaoMembra);
    expect(conexao.lados.find(l => !l.meu)).toMatchObject({ entidade: { nome: "Associação N2" } });
    expect(JSON.stringify(conexao)).not.toContain("Empresa Um");
  });

  it("o pedido exige a ciência do nome; quem não participa e a própria entidade levam a mesma recusa", async () => {
    await expect(rotaDe(MEMBRA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoMembra, cienteDoNome: false as never }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rotaDe(ESTRANHA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoMembra, cienteDoNome: true }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "PEDIDO_INDISPONIVEL" });
    await expect(daEntidade(ENT_A).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoMembra, cienteDoNome: true }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "PEDIDO_INDISPONIVEL" });
  });

  let pedidoDaMembra = "";
  it("a membra pede; a mensagem esconde contato; pedir de novo dá CONFLICT; a auditoria fica", async () => {
    const r = await rotaDe(MEMBRA).networkInteligente.pedirContatoPelaEntidade({
      conexaoId: conexaoMembra, cienteDoNome: true, mensagem: "Quero comprar café. Meu fone: (21) 99876-5432",
    });
    expect(r.estado).toBe("na_entidade");
    pedidoDaMembra = r.id;
    await expect(rotaDe(MEMBRA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoMembra, cienteDoNome: true }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "PEDIDO_JA_EXISTE" });
    const db = (await getDb())!;
    const [linha] = await db.select().from(pedidosPelaEntidade).where(eq(pedidosPelaEntidade.id, pedidoDaMembra));
    expect(linha.mensagem).not.toContain("99876");
    // O contato sai inteiro, trocado pelo marcador: nada de "(2***********32" com o parêntese aberto.
    expect(linha.mensagem).toBe("Quero comprar café. Meu fone: [•••]");
    const trilha = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "ENTIDADE_PEDIDO_CRIADO"), eq(auditLogs.resourceId, pedidoDaMembra)));
    expect(trilha).toHaveLength(1);
    const [conexao] = (await conexoesDe(MEMBRA)).filter(c => c.id === conexaoMembra);
    expect(conexao).toMatchObject({ podePedirPelaEntidade: false, pedidoPelaEntidade: { id: pedidoDaMembra, estado: "na_entidade" } });
  });

  it("a entidade vê o pedido com o nome de quem pede; a outra entidade não vê nada", async () => {
    const lista = await daEntidade(ENT_A).entidades.pedidos({ abertos: true });
    const pedido = lista.pedidos.find(p => p.id === pedidoDaMembra)!;
    expect(pedido).toMatchObject({
      estado: "na_entidade",
      solicitante: { nome: "Marta Membra", empresa: "Torrefação da Marta", ehEntidade: false },
      associado: { nome: "Empresa Um" },
    });
    expect(pedido.itens).toEqual([{ tem: "Café torrado", precisa: "Café para revenda" }]);
    expect(lista.abertos).toBeGreaterThanOrEqual(1);
    expect((await daEntidade(ENT_B).entidades.pedidos({})).pedidos).toHaveLength(0);
    await expect(daEntidade(ENT_B).entidades.decidirPedido({ pedidoId: pedidoDaMembra, acao: "encaminhar" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "PEDIDO_NAO_ENCONTRADO" });
    await expect(rotaDe(MEMBRA).entidades.pedidos({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("as passagens seguem a ordem; o contato só sai no aceito, com o canal escolhido e auditoria", async () => {
    const ent = daEntidade(ENT_A).entidades;
    await expect(rotaDe(MEMBRA).networkInteligente.contatoPeloPedido({ pedidoId: pedidoDaMembra }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "PEDIDO_NAO_ENCONTRADO" });
    await expect(ent.decidirPedido({ pedidoId: pedidoDaMembra, acao: "aceitar", canal: "email" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "PEDIDO_JA_DECIDIDO" });
    expect(await ent.decidirPedido({ pedidoId: pedidoDaMembra, acao: "encaminhar" })).toEqual({ estado: "encaminhado" });
    await expect(ent.decidirPedido({ pedidoId: pedidoDaMembra, acao: "encaminhar" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "PEDIDO_JA_DECIDIDO" });
    await expect(ent.decidirPedido({ pedidoId: pedidoDaMembra, acao: "aceitar" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "CANAL_INDISPONIVEL" });
    expect(await ent.decidirPedido({ pedidoId: pedidoDaMembra, acao: "aceitar", canal: "email" })).toEqual({ estado: "aceito" });

    const contato = await rotaDe(MEMBRA).networkInteligente.contatoPeloPedido({ pedidoId: pedidoDaMembra });
    expect(contato).toEqual({ empresa: "Empresa Um", telefone: null, email: EMAIL_DA_EMPRESA });
    await expect(rotaDe(ESTRANHA).networkInteligente.contatoPeloPedido({ pedidoId: pedidoDaMembra }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const db = (await getDb())!;
    const trilha = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.action, "ENTIDADE_PEDIDO_CONTATO_REVELADO"), eq(auditLogs.resourceId, pedidoDaMembra)));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].userId).toBe(ids[MEMBRA]);
  });

  let pedidoDaDona = "";
  it("o canal que a entidade não tem não pode ser o escolhido", async () => {
    pedidoDaDona = (await rotaDe(DONA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoDona, cienteDoNome: true })).id;
    const ent = daEntidade(ENT_A).entidades;
    await ent.decidirPedido({ pedidoId: pedidoDaDona, acao: "encaminhar" });
    await expect(ent.decidirPedido({ pedidoId: pedidoDaDona, acao: "aceitar", canal: "telefone" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "CANAL_INDISPONIVEL" });
  });

  it("passado o prazo, o pedido expira: a entidade não decide mais e quem pediu pode pedir de novo", async () => {
    const db = (await getDb())!;
    await db.update(pedidosPelaEntidade).set({ expiraEm: Date.now() - 1000 }).where(eq(pedidosPelaEntidade.id, pedidoDaDona));
    const [daDona] = (await conexoesDe(DONA)).filter(c => c.id === conexaoDona);
    expect(daDona).toMatchObject({ pedidoPelaEntidade: { estado: "expirado" }, podePedirPelaEntidade: true });
    await expect(daEntidade(ENT_A).entidades.decidirPedido({ pedidoId: pedidoDaDona, acao: "recusar" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "PEDIDO_JA_DECIDIDO" });
    const lista = await daEntidade(ENT_A).entidades.pedidos({});
    expect(lista.pedidos.find(p => p.id === pedidoDaDona)?.estado).toBe("expirado");
    const [linha] = await db.select({ estado: pedidosPelaEntidade.estado }).from(pedidosPelaEntidade).where(eq(pedidosPelaEntidade.id, pedidoDaDona));
    expect(linha.estado).toBe("expirado");

    const deNovo = await rotaDe(DONA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoDona, cienteDoNome: true });
    expect(deNovo).toMatchObject({ id: pedidoDaDona, estado: "na_entidade" });
    // "Não encaminhado" é resposta: não se pede de novo.
    await daEntidade(ENT_A).entidades.decidirPedido({ pedidoId: pedidoDaDona, acao: "nao_encaminhar" });
    await expect(rotaDe(DONA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoDona, cienteDoNome: true }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "PEDIDO_JA_EXISTE" });
  });

  it("o teto de pedidos por dia vale por conta", async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    await db.insert(pedidosPelaEntidade).values(Array.from({ length: PEDIDOS_POR_DIA_MAX }, () => ({
      id: crypto.randomUUID(), ownerId: ENT_B, entidadeId: 0, membroId: 0, conexaoId: crypto.randomUUID(),
      userId: ids[ESTRANHA], estado: "nao_encaminhado" as const, expiraEm: agora, createdAt: agora, updatedAt: agora,
    })));
    await expect(rotaDe(ESTRANHA).networkInteligente.pedirContatoPelaEntidade({ conexaoId: conexaoMembra, cienteDoNome: true }))
      .rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "PEDIDOS_DEMAIS" });
  });

  it("convênio encerrado: a conexão perde os itens e o pedido, e o contato aceito não é mais decifrado", async () => {
    await rotaDe(STAFF, { role: "admin" }).entidades.admin.atualizar({ ...dados, id: entidadeAId, nome: "Associação N2", convenioEstado: "encerrado" });
    const [conexao] = (await conexoesDe(MEMBRA)).filter(c => c.id === conexaoMembra);
    expect(conexao).toMatchObject({ detalhesVisiveis: false, itens: [], podePedirPelaEntidade: false });
    await expect(rotaDe(MEMBRA).networkInteligente.contatoPeloPedido({ pedidoId: pedidoDaMembra }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CONVENIO_INATIVO" });
    await expect(daEntidade(ENT_A).entidades.decidirPedido({ pedidoId: pedidoDaMembra, acao: "recusar" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CONVENIO_INATIVO" });
    await rotaDe(STAFF, { role: "admin" }).entidades.admin.atualizar({ ...dados, id: entidadeAId, nome: "Associação N2" });
  });

  it("excluir a conta de quem pediu leva os pedidos dela; a da entidade leva os que recebeu", async () => {
    const db = (await getDb())!;
    await excluirConta(db, { id: ids[MEMBRA], openId: MEMBRA, email: null }, { apagarArquivo: async () => {}, revogarGoogle: async () => "sem_conexao" as never });
    expect(await db.select().from(pedidosPelaEntidade).where(eq(pedidosPelaEntidade.userId, ids[MEMBRA]))).toHaveLength(0);
    await excluirConta(db, { id: ids[ENT_A], openId: ENT_A, email: EMAIL_A }, { apagarArquivo: async () => {}, revogarGoogle: async () => "sem_conexao" as never });
    expect(await db.select().from(pedidosPelaEntidade).where(eq(pedidosPelaEntidade.ownerId, ENT_A))).toHaveLength(0);
  });
});
