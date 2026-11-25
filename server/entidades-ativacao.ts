import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  auditLogs, contactAssets, contactNeeds, entidadeMembros, entidades, privateContacts, userProfiles, users,
} from "../drizzle/schema";
import { exigirDb } from "./db";
import { filaDoBcrypt } from "./fila-do-bcrypt";
import { ehColisaoDeChave } from "./network-codigo-anonimo";
import { gerarTokenDeConvite, hashDoConvite } from "./entidades-cofre";
import type { EntidadeDaConta } from "./entidades";
import {
  ERROS_DA_ENTIDADE, FORMATO_DO_TOKEN_DE_ATIVACAO, LINKS_DE_ATIVACAO_POR_CHAMADA, VALIDADE_DA_ATIVACAO_MS,
  convenioVigente, itensConfirmados,
} from "../shared/entidades";

/**
 * A ativação do cadastro importado (N3; docs/arquitetura/entidades.md, seção 9).
 *
 * A entidade gera, por associado, um link de USO ÚNICO e com validade
 * (`/ativar/<token>`) e o distribui pelo canal dela. Quem abre vê o nome da
 * entidade, o nome da empresa e os itens que a entidade mandou; cria a conta
 * (nome, e-mail e senha) e marca o que CONFIRMA do que foi importado. A conta
 * nasce como qualquer cadastro (Bronze, cadastro por concluir): o Termo Geral e
 * a maioridade ficam na tela de cadastro, que já abre preenchida com o que ela
 * confirmou. O associado vira `ativado` e o contato da entidade sai da rede
 * global, para a empresa não cruzar duas vezes (agora ela cruza como membra).
 *
 * O token é aleatório (24 bytes) e só o hash fica no banco: saber o CNPJ, que é
 * público, não basta. Token errado, vencido, já usado, trocado ou de convênio
 * encerrado respondem igual.
 */

const erro = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });
const naoEncontrada = () => erro("NOT_FOUND", ERROS_DA_ENTIDADE.ativacaoNaoEncontrada);

export type LinkDeAtivacao = {
  membroId: number; codigo: string | null; nome: string; referencia: string | null; token: string; expiraEm: number;
};

/**
 * Gera (ou troca) os links de ativação, até 500 por chamada, numa transação com
 * a auditoria. Dois modos: os associados escolhidos (`membroIds`; o link de um
 * associado que já tinha link é TROCADO, e o anterior deixa de abrir), ou os
 * pendentes (`pendentesDepoisDoId`: importados sem link valendo, em ordem de id,
 * com o cursor `proximo` para a próxima chamada). Só associado `importado`;
 * ativado ou removido fica de fora sem erro. O token sai só aqui, uma vez.
 */
export async function gerarLinksDeAtivacao(
  entidade: EntidadeDaConta, userId: number,
  entrada: { membroIds?: number[]; pendentesDepoisDoId?: number },
  agora = Date.now(),
): Promise<{ links: LinkDeAtivacao[]; proximo: number | null }> {
  if (!convenioVigente({ estado: entidade.convenioEstado, fim: entidade.convenioFim ?? null }, agora)) {
    throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.convenioInativo);
  }
  const porIds = entrada.membroIds !== undefined;
  if (porIds && !entrada.membroIds!.length) return { links: [], proximo: null };
  const db = await exigirDb();
  return db.transaction(async tx => {
    const condicoes = [
      eq(entidadeMembros.entidadeId, entidade.id),
      eq(entidadeMembros.estado, "importado"),
      eq(privateContacts.ownerId, entidade.ownerId),
    ];
    if (porIds) {
      condicoes.push(inArray(entidadeMembros.id, entrada.membroIds!.slice(0, LINKS_DE_ATIVACAO_POR_CHAMADA)));
    } else {
      condicoes.push(gt(entidadeMembros.id, Math.max(0, Math.floor(entrada.pendentesDepoisDoId ?? 0))));
      condicoes.push(or(isNull(entidadeMembros.ativacaoHash), lte(entidadeMembros.ativacaoExpiraEm, agora))!);
    }
    const alvos = await tx.select({
      id: entidadeMembros.id, codigo: privateContacts.codigoAnonimo, nome: privateContacts.fullName,
      referencia: entidadeMembros.referenciaDaEntidade, tinha: entidadeMembros.ativacaoHash,
    }).from(entidadeMembros)
      .innerJoin(privateContacts, eq(privateContacts.id, entidadeMembros.contactId))
      .where(and(...condicoes))
      .orderBy(asc(entidadeMembros.id))
      .limit(LINKS_DE_ATIVACAO_POR_CHAMADA)
      .for("update");
    const expiraEm = agora + VALIDADE_DA_ATIVACAO_MS;
    const links: LinkDeAtivacao[] = [];
    for (const alvo of alvos) {
      const token = gerarTokenDeConvite();
      await tx.update(entidadeMembros)
        .set({ ativacaoHash: hashDoConvite(token), ativacaoExpiraEm: expiraEm, updatedAt: agora })
        .where(and(eq(entidadeMembros.id, alvo.id), eq(entidadeMembros.estado, "importado")));
      links.push({ membroId: Number(alvo.id), codigo: alvo.codigo, nome: alvo.nome, referencia: alvo.referencia, token, expiraEm });
    }
    if (links.length) {
      await tx.insert(auditLogs).values({
        userId, action: "ENTIDADE_ATIVACAO_GERADA", resource: "entidade", resourceId: String(entidade.id),
        details: {
          quantos: links.length, trocados: alvos.filter(a => a.tinha).length, modo: porIds ? "escolhidos" : "pendentes",
          membroIds: links.length <= 20 ? links.map(l => l.membroId) : undefined,
        },
        riskLevel: "medium",
      });
    }
    const proximo = !porIds && alvos.length === LINKS_DE_ATIVACAO_POR_CHAMADA ? Number(alvos[alvos.length - 1].id) : null;
    return { links, proximo };
  });
}

type Db = Awaited<ReturnType<typeof exigirDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** O associado do token, se o link ainda vale; com `paraGravar`, trava a linha (FOR UPDATE). */
async function membroDoToken(conexao: Db | Tx, token: string, agora: number, paraGravar = false) {
  if (!FORMATO_DO_TOKEN_DE_ATIVACAO.test(token)) throw naoEncontrada();
  const consulta = conexao.select({
    id: entidadeMembros.id, ownerId: entidadeMembros.ownerId, entidadeId: entidadeMembros.entidadeId,
    contactId: entidadeMembros.contactId, estado: entidadeMembros.estado, expiraEm: entidadeMembros.ativacaoExpiraEm,
  }).from(entidadeMembros).where(eq(entidadeMembros.ativacaoHash, hashDoConvite(token))).limit(1);
  const [membro] = paraGravar ? await consulta.for("update") : await consulta;
  if (!membro || membro.estado !== "importado" || membro.contactId === null || membro.expiraEm === null || Number(membro.expiraEm) <= agora) {
    throw naoEncontrada();
  }
  const [entidade] = await conexao.select({
    nome: entidades.nome, pais: entidades.pais, ownerId: entidades.ownerId,
    estado: entidades.convenioEstado, fim: entidades.convenioFim,
  }).from(entidades).where(eq(entidades.id, membro.entidadeId)).limit(1);
  if (!entidade || entidade.ownerId !== membro.ownerId || !convenioVigente({ estado: entidade.estado, fim: entidade.fim ?? null }, agora)) {
    throw naoEncontrada();
  }
  const [contato] = await conexao.select({ nome: privateContacts.fullName, uf: privateContacts.state })
    .from(privateContacts)
    .where(and(eq(privateContacts.id, Number(membro.contactId)), eq(privateContacts.ownerId, membro.ownerId))).limit(1);
  if (!contato) throw naoEncontrada();
  const filtro = (tabela: typeof contactAssets | typeof contactNeeds) =>
    and(eq(tabela.contactId, Number(membro.contactId)), eq(tabela.ownerId, membro.ownerId));
  const tenho = await conexao.select({ label: contactAssets.tagLabel }).from(contactAssets).where(filtro(contactAssets)).orderBy(asc(contactAssets.id));
  const preciso = await conexao.select({ label: contactNeeds.tagLabel }).from(contactNeeds).where(filtro(contactNeeds)).orderBy(asc(contactNeeds.id));
  return {
    membro: { ...membro, id: Number(membro.id), contactId: Number(membro.contactId), expiraEm: Number(membro.expiraEm) },
    entidade, contato,
    tenho: tenho.map(t => t.label), preciso: preciso.map(p => p.label),
  };
}

/**
 * O que a página da ativação mostra a quem abriu o link (sem conta): o nome da
 * entidade, o nome da empresa e os itens importados, para ela conferir. Nunca o
 * documento nem os contatos (telefone e e-mail), que só a entidade lê.
 */
export async function lerAtivacao(token: string, agora = Date.now()) {
  const db = await exigirDb();
  const { entidade, contato, tenho, preciso, membro } = await membroDoToken(db, token, agora);
  return {
    entidade: entidade.nome, pais: entidade.pais, empresa: contato.nome, uf: contato.uf,
    tenho, preciso, expiraEm: membro.expiraEm,
  };
}

export type DadosDaAtivacao = {
  nome: string; email: string; senha: string; empresa: string; tenho: string[]; preciso: string[];
};

/**
 * Ativa: cria a conta e o perfil com o que a pessoa confirmou, numa transação
 * com o associado travado. Dois envios do mesmo link: o segundo espera o
 * primeiro e cai em NOT_FOUND (o link já foi usado). E-mail que já tem conta
 * recusa com código, sem gastar o link.
 */
export async function ativarCadastro(token: string, dados: DadosDaAtivacao, agora = Date.now()) {
  const db = await exigirDb();
  // Antes do bcrypt: link inválido não paga o custo da senha.
  await membroDoToken(db, token, agora);
  const email = dados.email.trim().toLowerCase();
  const [existente] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existente) throw erro("CONFLICT", ERROS_DA_ENTIDADE.ativacaoEmailJaCadastrado);
  const passwordHash = await filaDoBcrypt.executar(() => bcrypt.hash(dados.senha, 12));
  const openId = "email_" + crypto.randomBytes(16).toString("hex");
  const nome = dados.nome.trim();
  // Dois envios do mesmo link ao mesmo tempo podem cair num impasse do InnoDB
  // (as duas travas no índice único do hash): a vítima tenta de novo e, com o
  // link já gasto pela outra, cai em NOT_FOUND como manda a regra do uso único.
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      return await gravarAtivacao(db, token, dados, agora, { openId, nome, email, passwordHash });
    } catch (e) {
      if (ehImpasseDoBanco(e) && tentativa < TENTATIVAS_NO_IMPASSE) continue;
      // Outro cadastro com o mesmo e-mail no meio: a transação cai, e o link segue valendo.
      if (ehColisaoDeChave(e)) throw erro("CONFLICT", ERROS_DA_ENTIDADE.ativacaoEmailJaCadastrado);
      throw e;
    }
  }
}

/** Quantas vezes a ativação roda de novo quando o banco a escolhe como vítima de um impasse. */
export const TENTATIVAS_NO_IMPASSE = 3;

/** O erro (ou a causa dele) é o impasse de travas do MySQL (ER_LOCK_DEADLOCK, 1213). */
export function ehImpasseDoBanco(erro: unknown): boolean {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_LOCK_DEADLOCK" || errno === 1213) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

async function gravarAtivacao(
  db: Db, token: string, dados: DadosDaAtivacao, agora: number,
  conta: { openId: string; nome: string; email: string; passwordHash: string },
) {
  const { openId, nome, email, passwordHash } = conta;
  return await db.transaction(async tx => {
    const lido = await membroDoToken(tx, token, agora, true);
    const tenho = itensConfirmados(lido.tenho, dados.tenho);
    const preciso = itensConfirmados(lido.preciso, dados.preciso);
    const empresa = dados.empresa.trim() || lido.contato.nome;
    const [resultado] = await tx.insert(users).values({
      openId, name: nome, email, passwordHash, emailVerified: false, loginMethod: "email",
      // Como todo cadastro: Bronze, cadastro por concluir (o Termo Geral e a maioridade vêm na tela de cadastro).
      role: "bronze", isActive: true, isVerified: false, onboardingCompleted: false,
      country: lido.entidade.pais, company: empresa, lastSignedIn: new Date(agora),
    });
    const userId = Number((resultado as unknown as { insertId: number }).insertId);
    await tx.insert(userProfiles).values({
      userId, displayName: nome, company: empresa, country: lido.entidade.pais,
      whatIHave: tenho, whatINeed: preciso,
    });
    const [gasto] = await tx.update(entidadeMembros).set({
      estado: "ativado", ativadoUserId: userId, ativadoEm: agora, ativacaoHash: null, ativacaoExpiraEm: null, updatedAt: agora,
    }).where(and(eq(entidadeMembros.id, lido.membro.id), eq(entidadeMembros.estado, "importado"), isNotNull(entidadeMembros.ativacaoHash)));
    if (Number((gasto as unknown as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw naoEncontrada();
    // A empresa cruza agora como membra; o contato da entidade sai da rede global.
    await tx.update(privateContacts).set({ disponivelRedeGlobal: false, disponibilidadeAlteradaEm: agora, updatedAt: agora })
      .where(and(eq(privateContacts.id, lido.membro.contactId), eq(privateContacts.ownerId, lido.membro.ownerId)));
    await tx.insert(auditLogs).values({
      userId, action: "ENTIDADE_CADASTRO_ATIVADO", resource: "entidade_membro", resourceId: String(lido.membro.id),
      details: {
        entidadeId: lido.membro.entidadeId,
        tenhoConfirmados: tenho.length, tenhoImportados: lido.tenho.length,
        precisoConfirmados: preciso.length, precisoImportados: lido.preciso.length,
        empresaAlterada: empresa !== lido.contato.nome,
      },
      riskLevel: "medium",
    });
    return { userId, openId, name: nome, email };
  });
}
