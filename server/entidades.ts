import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  auditLogs, contactAssets, contactNeeds, entidadeMembros, entidades, importacaoDocumentosVistos,
  importacoesDeEntidade, privateContacts, users,
} from "../drizzle/schema";
import { exigirDb } from "./db";
import { slugifyMatchTag } from "./match-service";
import { ORIGEM_CNAE, cnaeExiste, ofertasDasCnaes } from "./cnae";
import { gerarCodigoAnonimo, ehColisaoDeChave } from "./network-codigo-anonimo";
import {
  cifrar, decifrar, exigirChavesDaEntidade, gerarTokenDeConvite, hashDoConvite, hmacDoDocumento,
} from "./entidades-cofre";
import {
  ASSOCIADOS_MAX_ATE_N4B, DOCUMENTO_DO_PAIS, ERROS_DA_ENTIDADE, ITENS_POR_LADO_MAX, LINHAS_POR_BLOCO, LINHAS_POR_ARQUIVO_MAX, MEMBROS_POR_PAGINA,
  convenioVigente, formatarDocumento, normalizarDocumento, ordenarProblemas, validarLinha,
  type EstadoDoConvenio, type LinhaBruta, type LinhaValida, type ProblemaDaLinha, type TipoDeDocumento, type TipoDeEntidade,
} from "../shared/entidades";

/**
 * A base das associações (N1; desenho em docs/arquitetura/entidades.md).
 *
 * A entidade é UMA conta (`users.isEntidade` + a linha em `entidades`); cada
 * associado é um contato da rede dela, com o ID anônimo do Meu Network
 * Inteligente, e uma linha em `entidade_membros` com o que só a entidade vê.
 * O cruzamento global lê de private_contacts só o id, a dona e o ID anônimo
 * (network-rede-global.ts): o nome da empresa, o documento e os contatos
 * nunca saem para outra conta. Regra de consulta, não de tela.
 */

type Db = Awaited<ReturnType<typeof exigirDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const erro = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });

export type EntidadeDaConta = typeof entidades.$inferSelect;

// ─── A conta da entidade ─────────────────────────────────────────────────────

/** A entidade da conta, ou FORBIDDEN com código (a conta sem a linha não é entidade). */
export async function entidadeDaConta(openId: string): Promise<EntidadeDaConta> {
  const db = await exigirDb();
  const [linha] = await db.select().from(entidades).where(eq(entidades.ownerId, openId)).limit(1);
  if (!linha) throw erro("FORBIDDEN", ERROS_DA_ENTIDADE.naoEhEntidade);
  return linha;
}

function exigirConvenio(entidade: EntidadeDaConta, agora = Date.now()) {
  if (!convenioVigente({ estado: entidade.convenioEstado, fim: entidade.convenioFim ?? null }, agora)) {
    throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.convenioInativo);
  }
}

/** O que a tela da entidade mostra de si mesma (sem o convite: ele sai por `convite`). */
export async function resumoDaEntidade(entidade: EntidadeDaConta) {
  const db = await exigirDb();
  const porEstado = await db.select({ estado: entidadeMembros.estado, total: count() })
    .from(entidadeMembros).where(eq(entidadeMembros.entidadeId, entidade.id)).groupBy(entidadeMembros.estado);
  const total = (estado: string) => Number(porEstado.find(l => l.estado === estado)?.total ?? 0);
  return {
    nome: entidade.nome, tipo: entidade.tipo, pais: entidade.pais,
    documento: DOCUMENTO_DO_PAIS[entidade.pais] ?? null,
    convenioVigente: convenioVigente({ estado: entidade.convenioEstado, fim: entidade.convenioFim ?? null }),
    convenioFim: entidade.convenioFim ?? null,
    disponivelPorPadrao: entidade.disponivelPorPadrao,
    membros: { importados: total("importado"), ativados: total("ativado") },
  };
}

// ─── Lista dos associados ────────────────────────────────────────────────────

const escaparLike = (texto: string) => texto.replace(/[!%_]/g, c => `!${c}`);

/**
 * Os associados da entidade, 50 por página, com código, nome e documento
 * (decisão de 22/11). A busca acha pelo código (NW-...), pelo documento
 * inteiro (pelo HMAC: o número nunca fica em claro no banco) ou por parte do
 * nome. Cada leitura com documento decifrado vai à auditoria.
 */
export async function listarMembros(entidade: EntidadeDaConta, userId: number, opcoes: { busca?: string; pagina?: number }) {
  const db = await exigirDb();
  const pagina = Math.max(0, Math.floor(opcoes.pagina ?? 0));
  const busca = (opcoes.busca ?? "").trim().slice(0, 100);
  const condicoes = [eq(entidadeMembros.entidadeId, entidade.id), ne(entidadeMembros.estado, "removido"), eq(privateContacts.ownerId, entidade.ownerId)];
  if (busca) {
    const tipo = DOCUMENTO_DO_PAIS[entidade.pais];
    const documento = normalizarDocumento(busca);
    if (/^NW-?[0-9A-F]{1,6}$/i.test(busca)) {
      const codigo = busca.toUpperCase().replace(/^NW-?/, "NW-");
      condicoes.push(sql`${privateContacts.codigoAnonimo} LIKE ${`${escaparLike(codigo)}%`} ESCAPE '!'`);
    } else if (tipo && /\d/.test(busca) && ((tipo === "cnpj" && documento.length === 14) || (tipo === "nuit" && documento.length === 9))) {
      exigirChavesDaEntidade();
      condicoes.push(eq(entidadeMembros.documentoHmac, hmacDoDocumento(entidade.pais, tipo, documento)));
    } else {
      condicoes.push(sql`${privateContacts.fullName} LIKE ${`%${escaparLike(busca)}%`} ESCAPE '!'`);
    }
  }
  const onde = and(...condicoes);
  const [{ total }] = await db.select({ total: count() }).from(entidadeMembros)
    .innerJoin(privateContacts, eq(privateContacts.id, entidadeMembros.contactId)).where(onde);
  const linhas = await db.select({
    id: entidadeMembros.id, codigo: privateContacts.codigoAnonimo, nome: privateContacts.fullName,
    tipoDocumento: entidadeMembros.tipoDocumento, documentoCifrado: entidadeMembros.documentoCifrado,
    estado: entidadeMembros.estado, uf: privateContacts.state, cnaePrincipal: entidadeMembros.cnaePrincipal,
    disponivel: privateContacts.disponivelRedeGlobal, temContato: sql<number>`${entidadeMembros.contatoCifrado} IS NOT NULL`,
    ativacaoExpiraEm: entidadeMembros.ativacaoExpiraEm,
  }).from(entidadeMembros)
    .innerJoin(privateContacts, eq(privateContacts.id, entidadeMembros.contactId))
    .where(onde)
    .orderBy(asc(privateContacts.fullName), asc(entidadeMembros.id))
    .limit(MEMBROS_POR_PAGINA).offset(pagina * MEMBROS_POR_PAGINA);
  if (linhas.length) exigirChavesDaEntidade();
  const membros = linhas.map(l => ({
    id: Number(l.id), codigo: l.codigo, nome: l.nome, estado: l.estado, uf: l.uf, cnaePrincipal: l.cnaePrincipal,
    disponivel: Boolean(l.disponivel), temContato: Boolean(Number(l.temContato)),
    // O link de ativação (N3) que ainda vale: só a validade; o token sai uma vez, ao gerar.
    ativacaoValidaAte: l.estado === "importado" && l.ativacaoExpiraEm && Number(l.ativacaoExpiraEm) > Date.now() ? Number(l.ativacaoExpiraEm) : null,
    documento: l.documentoCifrado ? formatarDocumento(l.tipoDocumento as TipoDeDocumento, decifrar(l.documentoCifrado)) : null,
  }));
  if (membros.length) {
    await db.insert(auditLogs).values({
      userId, action: "ENTIDADE_MEMBROS_LISTADOS", resource: "entidade", resourceId: String(entidade.id),
      details: { pagina, quantos: membros.length, comBusca: Boolean(busca) }, riskLevel: "low",
    });
  }
  return { total: Number(total), pagina, porPagina: MEMBROS_POR_PAGINA, membros };
}

/** O telefone e o e-mail de UM associado, decifrados sob pedido, com auditoria na mesma transação. */
export async function contatoDoMembro(entidade: EntidadeDaConta, userId: number, membroId: number) {
  exigirChavesDaEntidade();
  const db = await exigirDb();
  return db.transaction(async tx => {
    // Só o associado cujo contato ainda existe na rede da entidade: o contato apagado leva
    // o membro a "removido" (apagarRastroDoContato), e o join é a segunda trava.
    const [membro] = await tx.select({ cifrado: entidadeMembros.contatoCifrado }).from(entidadeMembros)
      .innerJoin(privateContacts, and(eq(privateContacts.id, entidadeMembros.contactId), eq(privateContacts.ownerId, entidade.ownerId)))
      .where(and(eq(entidadeMembros.id, membroId), eq(entidadeMembros.entidadeId, entidade.id), ne(entidadeMembros.estado, "removido")))
      .limit(1);
    if (!membro) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.membroNaoEncontrado);
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_CONTATO_LIDO", resource: "entidade_membro", resourceId: String(membroId),
      details: { entidadeId: entidade.id }, riskLevel: "medium",
    });
    const contato = membro.cifrado ? JSON.parse(decifrar(membro.cifrado)) as { telefone?: string | null; email?: string | null } : {};
    return { telefone: contato.telefone ?? null, email: contato.email ?? null };
  });
}

// ─── Importação em lote ──────────────────────────────────────────────────────

export async function iniciarImportacao(
  entidade: EntidadeDaConta, userId: number,
  entrada: { modo: "ensaio" | "aplicar"; arquivoSha256: string; totalLinhas: number },
) {
  exigirConvenio(entidade);
  exigirChavesDaEntidade();
  if (!DOCUMENTO_DO_PAIS[entidade.pais]) throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.paisSemDocumento);
  const totalLinhas = Math.min(Math.max(0, Math.floor(entrada.totalLinhas)), LINHAS_POR_ARQUIVO_MAX);
  // O arquivo maior que o teto nem começa a gravar (o bloco confere de novo, contando a base).
  if (entrada.modo === "aplicar" && totalLinhas > ASSOCIADOS_MAX_ATE_N4B) throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.baseAcimaDoTeto);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const agora = Date.now();
    const [resultado] = await tx.insert(importacoesDeEntidade).values({
      ownerId: entidade.ownerId, entidadeId: entidade.id, arquivoSha256: entrada.arquivoSha256, modo: entrada.modo,
      totalLinhas, porCodigo: {}, iniciadaEm: agora,
    });
    const id = Number((resultado as unknown as { insertId: number }).insertId);
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_IMPORTACAO_INICIADA", resource: "entidade", resourceId: String(entidade.id),
      details: { importacaoId: id, modo: entrada.modo, totalLinhas, arquivoSha256: entrada.arquivoSha256 },
      riskLevel: entrada.modo === "aplicar" ? "high" : "low",
    });
    return { importacaoId: id };
  });
}

type ResultadoDoBloco = {
  processadas: number; criados: number; atualizados: number; recusados: number; comAviso: number;
  /** Documentos que ainda não estão na base (sem os recriados): o ensaio soma para avisar do teto. */
  novos: number;
  problemas: ProblemaDaLinha[];
};

/**
 * Um bloco de até 500 linhas, numa transação. `inicio` é quantas linhas de
 * dados já foram processadas: o bloco fora de ordem (repetido pela rede, ou
 * de duas abas) recusa com CONFLICT, e a contagem não dobra. No ensaio nada
 * vai para a rede; só os HMACs vistos, para achar o repetido entre blocos.
 */
export async function processarBloco(
  entidade: EntidadeDaConta,
  entrada: { importacaoId: number; inicio: number; linhas: LinhaBruta[] },
  agora = Date.now(),
): Promise<ResultadoDoBloco> {
  exigirConvenio(entidade, agora);
  exigirChavesDaEntidade();
  const tipo = DOCUMENTO_DO_PAIS[entidade.pais];
  if (!tipo) throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.paisSemDocumento);
  if (entrada.linhas.length > LINHAS_POR_BLOCO) throw erro("BAD_REQUEST", ERROS_DA_ENTIDADE.blocoForaDeOrdem);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [importacao] = await tx.select().from(importacoesDeEntidade)
      .where(and(eq(importacoesDeEntidade.id, entrada.importacaoId), eq(importacoesDeEntidade.entidadeId, entidade.id)))
      .for("update");
    if (!importacao) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.importacaoNaoEncontrada);
    if (importacao.estado !== "em_andamento") throw erro("CONFLICT", ERROS_DA_ENTIDADE.importacaoEncerrada);
    if (importacao.linhasProcessadas !== entrada.inicio || entrada.inicio + entrada.linhas.length > importacao.totalLinhas) {
      throw erro("CONFLICT", ERROS_DA_ENTIDADE.blocoForaDeOrdem);
    }
    const aplicar = importacao.modo === "aplicar";
    const problemas: ProblemaDaLinha[] = [];
    const linhasComAviso = new Set<number>();
    let recusados = 0;
    // A linha recusada depois da validação (repetida, removida) não leva os avisos dela ao relatório.
    const tirarAvisos = (linha: number) => {
      for (let i = problemas.length - 1; i >= 0; i -= 1) if (problemas[i].linha === linha) problemas.splice(i, 1);
    };

    // 1. Validação, linha a linha (a linha 1 do arquivo é o cabeçalho).
    const validas: Array<LinhaValida & { hmac: string }> = [];
    entrada.linhas.forEach((bruta, i) => {
      const numero = entrada.inicio + i + 2;
      const resultado = validarLinha(bruta, numero, entidade.pais, agora, { cnaeExiste });
      if (!resultado.ok) { recusados += 1; problemas.push({ linha: numero, codigo: resultado.recusa }); return; }
      for (const aviso of resultado.avisos) { problemas.push({ linha: numero, codigo: aviso }); linhasComAviso.add(numero); }
      const v = resultado.valida;
      validas.push({ ...v, hmac: hmacDoDocumento(v.documento.pais, v.documento.tipo, v.documento.valor) });
    });

    // 2. Repetido no arquivo: no mesmo bloco ou num bloco anterior.
    const vistosAntes = validas.length
      ? await tx.select({ hmac: importacaoDocumentosVistos.documentoHmac, linha: importacaoDocumentosVistos.linha })
        .from(importacaoDocumentosVistos)
        .where(and(eq(importacaoDocumentosVistos.importacaoId, importacao.id), inArray(importacaoDocumentosVistos.documentoHmac, validas.map(v => v.hmac))))
      : [];
    const primeira = new Map(vistosAntes.map(v => [v.hmac, v.linha]));
    const unicas: typeof validas = [];
    for (const v of validas) {
      const anterior = primeira.get(v.hmac);
      if (anterior !== undefined) {
        recusados += 1; linhasComAviso.delete(v.linha); tirarAvisos(v.linha);
        problemas.push({ linha: v.linha, codigo: "REPETIDO_NO_ARQUIVO", primeira: anterior });
        continue;
      }
      primeira.set(v.hmac, v.linha);
      unicas.push(v);
    }
    if (unicas.length) {
      await tx.insert(importacaoDocumentosVistos).values(unicas.map(v => ({
        importacaoId: importacao.id, ownerId: entidade.ownerId, documentoHmac: v.hmac, linha: v.linha,
      })));
    }

    // 3. O que já existe NESTA entidade (outra entidade é outro registro, e o relatório cala).
    const existentes = unicas.length
      ? await tx.select({ id: entidadeMembros.id, hmac: entidadeMembros.documentoHmac, estado: entidadeMembros.estado, contactId: entidadeMembros.contactId })
        .from(entidadeMembros)
        .where(and(eq(entidadeMembros.entidadeId, entidade.id), inArray(entidadeMembros.documentoHmac, unicas.map(v => v.hmac))))
      : [];
    const porHmac = new Map(existentes.map(e => [e.hmac, e]));
    const contatosVivos = new Set<number>();
    const idsDeContato = existentes.map(e => e.contactId).filter((id): id is number => id !== null);
    if (idsDeContato.length) {
      const vivos = await tx.select({ id: privateContacts.id }).from(privateContacts)
        .where(and(eq(privateContacts.ownerId, entidade.ownerId), inArray(privateContacts.id, idsDeContato)));
      for (const c of vivos) contatosVivos.add(Number(c.id));
    }

    const novas: typeof unicas = [];
    const atualizar: Array<{ v: (typeof unicas)[number]; membroId: number; contactId: number }> = [];
    const recriar: Array<{ v: (typeof unicas)[number]; membroId: number }> = [];
    for (const v of unicas) {
      const e = porHmac.get(v.hmac);
      if (!e) { novas.push(v); continue; }
      if (e.estado === "removido") {
        recusados += 1; linhasComAviso.delete(v.linha); tirarAvisos(v.linha);
        problemas.push({ linha: v.linha, codigo: "MEMBRO_REMOVIDO" });
        continue;
      }
      if (e.estado === "ativado") {
        problemas.push({ linha: v.linha, codigo: "MEMBRO_ATIVADO_NAO_ALTERADO" }); linhasComAviso.add(v.linha);
        continue;
      }
      // Importado cujo contato a entidade apagou pela Rede: o contato volta, com o mesmo registro.
      if (e.contactId !== null && contatosVivos.has(Number(e.contactId))) atualizar.push({ v, membroId: Number(e.id), contactId: Number(e.contactId) });
      else recriar.push({ v, membroId: Number(e.id) });
    }

    if (aplicar && novas.length) {
      const [{ naBase }] = await tx.select({ naBase: count() }).from(entidadeMembros)
        .where(and(eq(entidadeMembros.entidadeId, entidade.id), ne(entidadeMembros.estado, "removido")));
      if (Number(naBase) + novas.length > ASSOCIADOS_MAX_ATE_N4B) throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.baseAcimaDoTeto);
    }

    if (aplicar) {
      const criadosPorHmac = await criarContatos(tx, entidade, [...novas, ...recriar.map(r => r.v)], agora);
      if (novas.length) {
        await tx.insert(entidadeMembros).values(novas.map(v => ({
          ownerId: entidade.ownerId, entidadeId: entidade.id, contactId: criadosPorHmac.get(v.hmac)!,
          ...colunasDoMembro(v, importacao.id, agora), documentoHmac: v.hmac, createdAt: agora,
        })));
      }
      for (const r of recriar) {
        await tx.update(entidadeMembros)
          .set({ contactId: criadosPorHmac.get(r.v.hmac)!, ...colunasDoMembro(r.v, importacao.id, agora) })
          .where(eq(entidadeMembros.id, r.membroId));
      }
      for (const a of atualizar) {
        await tx.update(privateContacts)
          .set({ fullName: a.v.nome, state: a.v.uf, updatedAt: agora })
          .where(and(eq(privateContacts.id, a.contactId), eq(privateContacts.ownerId, entidade.ownerId)));
        await tx.update(entidadeMembros).set(colunasDoMembro(a.v, importacao.id, agora)).where(eq(entidadeMembros.id, a.membroId));
      }
      // Os itens: a planilha é a fonte. Os do contato atualizado são trocados pelos novos.
      const idsAtualizados = atualizar.map(a => a.contactId);
      if (idsAtualizados.length) {
        await tx.delete(contactAssets).where(and(eq(contactAssets.ownerId, entidade.ownerId), inArray(contactAssets.contactId, idsAtualizados)));
        await tx.delete(contactNeeds).where(and(eq(contactNeeds.ownerId, entidade.ownerId), inArray(contactNeeds.contactId, idsAtualizados)));
      }
      const comItens = [
        ...novas.map(v => ({ v, contactId: criadosPorHmac.get(v.hmac)! })),
        ...recriar.map(r => ({ v: r.v, contactId: criadosPorHmac.get(r.v.hmac)! })),
        ...atualizar.map(a => ({ v: a.v, contactId: a.contactId })),
      ];
      const item = (contactId: number, label: string) => ({
        ownerId: entidade.ownerId, contactId, tagSlug: slugifyMatchTag(label), tagLabel: label, category: null,
        description: null, createdAt: agora, updatedAt: agora,
      });
      // "O que tem": o que a entidade escreveu e, depois, a atividade pela CNAE (N4), no mesmo teto.
      // "O que precisa": só o que a entidade declarou. A CNAE nunca entra deste lado.
      const tenho = comItens.flatMap(c => [
        ...c.v.tenho.map(label => ({ ...item(c.contactId, label), origem: "entidade" })),
        ...ofertasDaLinha(c.v).map(label => ({ ...item(c.contactId, label), origem: ORIGEM_CNAE })),
      ]);
      const preciso = comItens.flatMap(c => c.v.preciso.map(label => item(c.contactId, label)));
      if (tenho.length) await tx.insert(contactAssets).values(tenho);
      if (preciso.length) await tx.insert(contactNeeds).values(preciso);
    }

    const criados = novas.length + recriar.length;
    const atualizados = atualizar.length;
    const porCodigo: Record<string, number> = { ...(importacao.porCodigo ?? {}) };
    for (const p of problemas) porCodigo[p.codigo] = (porCodigo[p.codigo] ?? 0) + 1;
    await tx.update(importacoesDeEntidade).set({
      linhasProcessadas: importacao.linhasProcessadas + entrada.linhas.length,
      criados: importacao.criados + criados,
      atualizados: importacao.atualizados + atualizados,
      recusados: importacao.recusados + recusados,
      comAviso: importacao.comAviso + linhasComAviso.size,
      porCodigo,
    }).where(eq(importacoesDeEntidade.id, importacao.id));
    return { processadas: entrada.linhas.length, criados, atualizados, recusados, comAviso: linhasComAviso.size, novos: novas.length, problemas: ordenarProblemas(problemas) };
  });
}

/** As ofertas que as CNAEs da linha dão, sem repetir o que a entidade escreveu (server/cnae.ts). */
export function ofertasDaLinha(v: Pick<LinhaValida, "cnaePrincipal" | "cnaesSecundarios" | "tenho">): string[] {
  return ofertasDasCnaes({ principal: v.cnaePrincipal, secundarias: v.cnaesSecundarios }, v.tenho, ITENS_POR_LADO_MAX);
}

function colunasDoMembro(v: LinhaValida, loteId: number, agora: number) {
  const temContato = v.telefone || v.email;
  return {
    paisDocumento: v.documento.pais, tipoDocumento: v.documento.tipo,
    documentoCifrado: cifrar(v.documento.valor),
    contatoCifrado: temContato ? cifrar(JSON.stringify({ telefone: v.telefone, email: v.email })) : null,
    cnaePrincipal: v.cnaePrincipal, cnaesSecundarios: v.cnaesSecundarios,
    referenciaDaEntidade: v.referencia,
    precisoOrigem: v.preciso.length ? "entidade" : null,
    precisoDeclaradoEm: v.preciso.length ? v.declaradoEm : null,
    loteId, estado: "importado" as const, updatedAt: agora,
  };
}

/**
 * Cria os contatos de uma vez, com o ID anônimo dado na carga. O código tem 6
 * dígitos hexadecimais: com dezenas de milhares de contatos, a colisão deixa
 * de ser rara, então os candidatos que já existem são trocados ANTES do
 * INSERT; a corrida que sobrar (outro INSERT no meio) faz a transação inteira
 * do bloco cair com ER_DUP_ENTRY, e quem chama tenta de novo.
 */
async function criarContatos(tx: Tx, entidade: EntidadeDaConta, linhas: Array<LinhaValida & { hmac: string }>, agora: number) {
  const porHmac = new Map<string, number>();
  if (!linhas.length) return porHmac;
  const codigos = new Map<string, string>();
  const usados = new Set<string>();
  for (const v of linhas) {
    let codigo = gerarCodigoAnonimo();
    while (usados.has(codigo)) codigo = gerarCodigoAnonimo();
    usados.add(codigo); codigos.set(v.hmac, codigo);
  }
  for (let rodada = 0; rodada < 6; rodada += 1) {
    const ocupados = await tx.select({ codigo: privateContacts.codigoAnonimo }).from(privateContacts)
      .where(inArray(privateContacts.codigoAnonimo, Array.from(codigos.values())));
    if (!ocupados.length) break;
    const ocupado = new Set(ocupados.map(o => o.codigo));
    for (const [hmac, codigo] of Array.from(codigos.entries())) {
      if (!ocupado.has(codigo)) continue;
      let novo = gerarCodigoAnonimo();
      while (usados.has(novo)) novo = gerarCodigoAnonimo();
      usados.add(novo); codigos.set(hmac, novo);
    }
  }
  await tx.insert(privateContacts).values(linhas.map(v => ({
    ownerId: entidade.ownerId, fullName: v.nome, state: v.uf, country: v.documento.pais,
    codigoAnonimo: codigos.get(v.hmac)!, tipoPessoa: "juridica" as const, nivelVisibilidade: "privado" as const,
    disponivelRedeGlobal: entidade.disponivelPorPadrao, disponibilidadeAlteradaEm: agora,
    createdAt: agora, updatedAt: agora,
  })));
  const criados = await tx.select({ id: privateContacts.id, codigo: privateContacts.codigoAnonimo }).from(privateContacts)
    .where(and(eq(privateContacts.ownerId, entidade.ownerId), inArray(privateContacts.codigoAnonimo, Array.from(codigos.values()))));
  const idPorCodigo = new Map(criados.map(c => [c.codigo, Number(c.id)]));
  for (const [hmac, codigo] of Array.from(codigos.entries())) porHmac.set(hmac, idPorCodigo.get(codigo)!);
  return porHmac;
}

/** O bloco, com uma nova tentativa quando a corrida do ID anônimo derruba a transação. */
export async function processarBlocoComNovaTentativa(entidade: EntidadeDaConta, entrada: Parameters<typeof processarBloco>[1]) {
  for (let tentativa = 0; ; tentativa += 1) {
    try {
      return await processarBloco(entidade, entrada);
    } catch (e) {
      if (tentativa >= 2 || !ehColisaoDeChave(e)) throw e;
    }
  }
}

export async function concluirImportacao(entidade: EntidadeDaConta, userId: number, importacaoId: number) {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [importacao] = await tx.select().from(importacoesDeEntidade)
      .where(and(eq(importacoesDeEntidade.id, importacaoId), eq(importacoesDeEntidade.entidadeId, entidade.id)))
      .for("update");
    if (!importacao) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.importacaoNaoEncontrada);
    if (importacao.estado !== "em_andamento") throw erro("CONFLICT", ERROS_DA_ENTIDADE.importacaoEncerrada);
    const agora = Date.now();
    await tx.update(importacoesDeEntidade).set({ estado: "concluida", concluidaEm: agora }).where(eq(importacoesDeEntidade.id, importacao.id));
    await tx.delete(importacaoDocumentosVistos).where(eq(importacaoDocumentosVistos.importacaoId, importacao.id));
    const relatorio = {
      importacaoId: importacao.id, modo: importacao.modo, totalLinhas: importacao.totalLinhas,
      linhasProcessadas: importacao.linhasProcessadas, criados: importacao.criados, atualizados: importacao.atualizados,
      recusados: importacao.recusados, comAviso: importacao.comAviso, porCodigo: importacao.porCodigo ?? {},
    };
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_IMPORTACAO_CONCLUIDA", resource: "entidade", resourceId: String(entidade.id),
      details: relatorio, riskLevel: importacao.modo === "aplicar" ? "high" : "low",
    });
    return relatorio;
  });
}

export async function ultimasImportacoes(entidade: EntidadeDaConta) {
  const db = await exigirDb();
  const linhas = await db.select({
    id: importacoesDeEntidade.id, modo: importacoesDeEntidade.modo, estado: importacoesDeEntidade.estado,
    totalLinhas: importacoesDeEntidade.totalLinhas, linhasProcessadas: importacoesDeEntidade.linhasProcessadas,
    criados: importacoesDeEntidade.criados, atualizados: importacoesDeEntidade.atualizados,
    recusados: importacoesDeEntidade.recusados, comAviso: importacoesDeEntidade.comAviso,
    iniciadaEm: importacoesDeEntidade.iniciadaEm, concluidaEm: importacoesDeEntidade.concluidaEm,
  }).from(importacoesDeEntidade).where(eq(importacoesDeEntidade.entidadeId, entidade.id))
    .orderBy(sql`${importacoesDeEntidade.iniciadaEm} DESC`).limit(10);
  return linhas;
}

// ─── O convite ao app ────────────────────────────────────────────────────────

/** O token do convite que está valendo, para a entidade copiar e mandar de novo. */
export async function conviteAtual(entidade: EntidadeDaConta): Promise<{ token: string; geradoEm: number } | null> {
  if (!entidade.conviteCifrado || !entidade.conviteGeradoEm) return null;
  return { token: decifrar(entidade.conviteCifrado), geradoEm: Number(entidade.conviteGeradoEm) };
}

/** Gera (ou troca) o link de convite: o anterior deixa de abrir na hora. */
export async function gerarConvite(entidade: EntidadeDaConta, userId: number) {
  exigirConvenio(entidade);
  exigirChavesDaEntidade();
  const db = await exigirDb();
  const token = gerarTokenDeConvite();
  const agora = Date.now();
  await db.transaction(async tx => {
    await tx.update(entidades).set({ conviteHash: hashDoConvite(token), conviteCifrado: cifrar(token), conviteGeradoEm: agora, updatedAt: agora })
      .where(eq(entidades.id, entidade.id));
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_CONVITE_GERADO", resource: "entidade", resourceId: String(entidade.id),
      details: { substituiuAnterior: Boolean(entidade.conviteHash) }, riskLevel: "low",
    });
  });
  return { token, geradoEm: agora };
}

export async function revogarConvite(entidade: EntidadeDaConta, userId: number) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    await tx.update(entidades).set({ conviteHash: null, conviteCifrado: null, conviteGeradoEm: null, updatedAt: Date.now() })
      .where(eq(entidades.id, entidade.id));
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_CONVITE_REVOGADO", resource: "entidade", resourceId: String(entidade.id), riskLevel: "low",
    });
  });
}

/**
 * O convite visto por quem recebeu o link (sem conta): só o nome e o país da
 * entidade, e só com o convênio vigente. Token errado, revogado ou de convênio
 * encerrado respondem igual (NOT_FOUND).
 */
export async function lerConvite(token: string) {
  const db = await exigirDb();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.conviteNaoEncontrado);
  const [entidade] = await db.select({
    nome: entidades.nome, pais: entidades.pais, estado: entidades.convenioEstado, fim: entidades.convenioFim,
  }).from(entidades).where(eq(entidades.conviteHash, hashDoConvite(token))).limit(1);
  if (!entidade || !convenioVigente({ estado: entidade.estado, fim: entidade.fim ?? null })) {
    throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.conviteNaoEncontrado);
  }
  return { nome: entidade.nome, pais: entidade.pais };
}

// ─── A equipe da WRW ─────────────────────────────────────────────────────────

/** As entidades com as contagens; nenhuma coluna pessoal de associado. */
export async function listarEntidadesParaAEquipe() {
  const db = await exigirDb();
  const linhas = await db.select({
    id: entidades.id, nome: entidades.nome, tipo: entidades.tipo, pais: entidades.pais,
    convenioEstado: entidades.convenioEstado, convenioInicio: entidades.convenioInicio, convenioFim: entidades.convenioFim,
    convenioReferencia: entidades.convenioReferencia, mostrarNomeNoMatch: entidades.mostrarNomeNoMatch,
    disponivelPorPadrao: entidades.disponivelPorPadrao, contaEmail: users.email, createdAt: entidades.createdAt,
  }).from(entidades).leftJoin(users, eq(users.openId, entidades.ownerId)).orderBy(asc(entidades.nome));
  const contagens = linhas.length
    ? await db.select({ entidadeId: entidadeMembros.entidadeId, estado: entidadeMembros.estado, total: count() })
      .from(entidadeMembros).where(inArray(entidadeMembros.entidadeId, linhas.map(l => l.id)))
      .groupBy(entidadeMembros.entidadeId, entidadeMembros.estado)
    : [];
  return linhas.map(l => {
    const da = (estado: string) => Number(contagens.find(c => c.entidadeId === l.id && c.estado === estado)?.total ?? 0);
    return { ...l, importados: da("importado"), ativados: da("ativado"), removidos: da("removido") };
  });
}

/**
 * Refaz as ofertas da CNAE de todos os associados importados de uma entidade
 * (R-49: começar pela CNAE e refinar depois). Quando a tabela muda (versão nova
 * do IBGE, rótulo revisado), os itens de origem "cnae" saem e voltam pelos
 * códigos guardados em entidade_membros; o que a entidade escreveu e o que a
 * dona mudou à mão (origem nula) ficam. O associado ativado decide sozinho e
 * não é tocado. Blocos de LINHAS_POR_BLOCO, cada um numa transação com a sua
 * auditoria; nada é lido além do código da CNAE e dos rótulos já gravados.
 */
export async function refazerOfertasDaCnae(staffUserId: number, entidadeId: number, agora = Date.now()) {
  const db = await exigirDb();
  const [entidade] = await db.select({ id: entidades.id, ownerId: entidades.ownerId }).from(entidades).where(eq(entidades.id, entidadeId)).limit(1);
  if (!entidade) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.naoEhEntidade);
  let depoisDe = 0;
  let membros = 0;
  let ofertas = 0;
  for (;;) {
    const bloco = await db.select({
      id: entidadeMembros.id, contactId: entidadeMembros.contactId,
      cnaePrincipal: entidadeMembros.cnaePrincipal, cnaesSecundarios: entidadeMembros.cnaesSecundarios,
    }).from(entidadeMembros)
      .where(and(eq(entidadeMembros.entidadeId, entidade.id), eq(entidadeMembros.estado, "importado"), gt(entidadeMembros.id, depoisDe)))
      .orderBy(asc(entidadeMembros.id)).limit(LINHAS_POR_BLOCO);
    if (!bloco.length) break;
    depoisDe = Number(bloco[bloco.length - 1].id);
    const comContato = bloco.filter((m): m is typeof m & { contactId: number } => m.contactId !== null);
    if (!comContato.length) continue;
    const ids = comContato.map(m => Number(m.contactId));
    const criadas = await db.transaction(async tx => {
      await tx.delete(contactAssets).where(and(
        eq(contactAssets.ownerId, entidade.ownerId), inArray(contactAssets.contactId, ids), eq(contactAssets.origem, ORIGEM_CNAE),
      ));
      const ficam = await tx.select({ contactId: contactAssets.contactId, label: contactAssets.tagLabel }).from(contactAssets)
        .where(and(eq(contactAssets.ownerId, entidade.ownerId), inArray(contactAssets.contactId, ids)));
      const escritas = new Map<number, string[]>();
      for (const f of ficam) escritas.set(Number(f.contactId), [...(escritas.get(Number(f.contactId)) ?? []), f.label]);
      const novas = comContato.flatMap(m => ofertasDaLinha({
        cnaePrincipal: m.cnaePrincipal, cnaesSecundarios: m.cnaesSecundarios ?? [], tenho: escritas.get(Number(m.contactId)) ?? [],
      }).map(label => ({
        ownerId: entidade.ownerId, contactId: Number(m.contactId), tagSlug: slugifyMatchTag(label), tagLabel: label,
        category: null, description: null, origem: ORIGEM_CNAE, createdAt: agora, updatedAt: agora,
      })));
      if (novas.length) await tx.insert(contactAssets).values(novas);
      await tx.insert(auditLogs).values({
        userId: staffUserId, action: "ENTIDADE_OFERTAS_DA_CNAE_REFEITAS", resource: "entidade", resourceId: String(entidade.id),
        details: { membros: comContato.length, ofertas: novas.length }, riskLevel: "low",
      });
      return novas.length;
    });
    membros += comContato.length;
    ofertas += criadas;
  }
  return { membros, ofertas };
}

export type DadosDaEntidade = {
  nome: string; tipo: TipoDeEntidade; convenioEstado: EstadoDoConvenio;
  convenioInicio: number | null; convenioFim: number | null; convenioReferencia: string | null;
  mostrarNomeNoMatch: boolean; disponivelPorPadrao: boolean;
};

/**
 * A equipe transforma uma conta JÁ CRIADA (a associação se cadastra como
 * qualquer pessoa) em entidade. Conta da equipe (admin, presidência, Ouro) não
 * vira entidade: os poderes não se misturam.
 */
export async function criarEntidade(staffUserId: number, entrada: DadosDaEntidade & { emailDaConta: string; pais: string }) {
  if (!DOCUMENTO_DO_PAIS[entrada.pais]) throw erro("BAD_REQUEST", ERROS_DA_ENTIDADE.paisSemDocumento);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [conta] = await tx.select({ id: users.id, openId: users.openId, role: users.role, isEntidade: users.isEntidade })
      .from(users).where(eq(users.email, entrada.emailDaConta.trim().toLowerCase())).for("update").limit(1);
    if (!conta) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.contaNaoEncontrada);
    if (["admin", "president", "gold"].includes(conta.role)) throw erro("BAD_REQUEST", ERROS_DA_ENTIDADE.contaDaEquipe);
    if (conta.isEntidade) throw erro("CONFLICT", ERROS_DA_ENTIDADE.contaJaEhEntidade);
    const agora = Date.now();
    const { emailDaConta: _email, ...dados } = entrada;
    const [resultado] = await tx.insert(entidades).values({ ...dados, ownerId: conta.openId, createdAt: agora, updatedAt: agora });
    const id = Number((resultado as unknown as { insertId: number }).insertId);
    await tx.update(users).set({ isEntidade: true }).where(eq(users.id, conta.id));
    // A conta de entidade só tem contato privado (docs/arquitetura/entidades.md, seção 1). As
    // rotas network.create e network.update recusam ouro e público; os contatos que a conta
    // já tinha nesses níveis voltam a privado aqui, na mesma transação.
    const [rebaixados] = await tx.update(privateContacts).set({ nivelVisibilidade: "privado", updatedAt: agora })
      .where(and(eq(privateContacts.ownerId, conta.openId), ne(privateContacts.nivelVisibilidade, "privado")));
    await tx.insert(auditLogs).values({
      userId: staffUserId, action: "ENTIDADE_CRIADA", resource: "entidade", resourceId: String(id),
      details: {
        contaUserId: conta.id, nome: entrada.nome, pais: entrada.pais, convenioEstado: entrada.convenioEstado,
        contatosRebaixadosParaPrivado: Number((rebaixados as unknown as { affectedRows?: number }).affectedRows ?? 0),
      }, riskLevel: "high",
    });
    return { id };
  });
}

export async function atualizarEntidade(staffUserId: number, id: number, dados: DadosDaEntidade) {
  const db = await exigirDb();
  await db.transaction(async tx => {
    const [resultado] = await tx.update(entidades).set({ ...dados, updatedAt: Date.now() }).where(eq(entidades.id, id));
    if (!(resultado as unknown as { affectedRows: number }).affectedRows) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.naoEhEntidade);
    await tx.insert(auditLogs).values({
      userId: staffUserId, action: "ENTIDADE_ATUALIZADA", resource: "entidade", resourceId: String(id),
      details: { convenioEstado: dados.convenioEstado, mostrarNomeNoMatch: dados.mostrarNomeNoMatch, disponivelPorPadrao: dados.disponivelPorPadrao },
      riskLevel: "high",
    });
  });
}

/**
 * As contas de entidade cujo convênio NÃO vale hoje, entre `openIds`. O
 * cruzamento global tira os associados delas (o convênio encerrado tira a base
 * do match na leitura seguinte, sem apagar nada).
 */
export async function entidadesSemConvenio(db: Db, openIds: string[], agora = Date.now()): Promise<Set<string>> {
  if (!openIds.length) return new Set();
  const linhas = await db.select({ ownerId: entidades.ownerId, estado: entidades.convenioEstado, fim: entidades.convenioFim })
    .from(entidades).where(inArray(entidades.ownerId, openIds));
  return new Set(linhas.filter(l => !convenioVigente({ estado: l.estado, fim: l.fim ?? null }, agora)).map(l => l.ownerId));
}
