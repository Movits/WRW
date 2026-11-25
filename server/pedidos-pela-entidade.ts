import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  auditLogs, conexoesParticipantes, conexoesRegistradas, entidadeMembros, entidades, pedidosPelaEntidade, privateContacts,
  userProfiles, users,
} from "../drizzle/schema";
import { exigirDb } from "./db";
import { decifrar, exigirChavesDaEntidade } from "./entidades-cofre";
import { ehColisaoDeChave } from "./network-codigo-anonimo";
import {
  MOTIVO_SEM_AUTORIZACAO_DO_OUTRO_LADO, participantesAindaAutorizados, type ConexaoParaQuemPergunta, type ItemDaConexao,
  type LadoVisivel, type Solicitante,
} from "./network-registro";
import type { EntidadeDaConta } from "./entidades";
import { mascararContatosEmTexto } from "../shared/contato-em-texto";
import { ERROS_DA_ENTIDADE, convenioVigente } from "../shared/entidades";
import {
  ESTADOS_ABERTOS, MENSAGEM_DO_PEDIDO_MAX, PEDIDOS_POR_DIA_MAX, PEDIDOS_POR_PAGINA, PRAZO_DO_PEDIDO_MS,
  camposDoCanal, estadoDeOrigem, estadoEfetivo, podePedirDeNovo, proximoEstado,
  type AcaoDaEntidade, type CanalDoPedido, type EstadoDoPedido,
} from "../shared/pedidos-pela-entidade";

/**
 * O pedido de contato pela entidade (N2; regras puras em
 * shared/pedidos-pela-entidade.ts, desenho em docs/arquitetura/entidades.md).
 *
 * Privacidade é regra de CONSULTA:
 * - quem está do outro lado de uma conexão com um associado recebe, além do que
 *   a conexão já mostrava (o código e os itens), só "membro da entidade X" — o
 *   nome da entidade, e só quando o convênio autoriza (`mostrar_nome_no_match`).
 *   Nome, documento, telefone e e-mail da empresa não são lidos nesta leitura;
 * - o telefone e o e-mail continuam cifrados (`entidade_membros.contato_cifrado`)
 *   e são decifrados em dois pontos só: para a própria entidade (N1,
 *   `contatoDoMembro`) e, no "aceito", para QUEM PEDIU, com o canal que a
 *   empresa escolheu e a auditoria na mesma transação;
 * - a entidade vê o nome de quem pede (a tela avisa antes de pedir), nunca o
 *   contato dela.
 */

type Db = Awaited<ReturnType<typeof exigirDb>>;

const erro = (code: TRPCError["code"], message: string) => new TRPCError({ code, message });

/** As origens em que o outro lado é de OUTRA conta (só nelas há associado de entidade alheia). */
const ORIGENS_DA_REDE_GLOBAL = ["NETWORK_NETWORK_MATCH", "NETWORK_PLATFORM_MATCH"] as const;

const ehDaSolicitante = (p: { tipo: string; ownerId: string | null; userId: number | null }, quem: Solicitante) =>
  p.tipo === "contato" ? p.ownerId === quem.openId : p.userId === quem.id;

type AssociadoDoLado = {
  membroId: number; contactId: number; estadoDoMembro: string;
  entidadeId: number; entidadeOwnerId: string; nome: string; mostrarNome: boolean; convenioVigente: boolean;
};

/** Os contatos (entre `contactIds`) que são associados de uma entidade, com a entidade. Só colunas não pessoais. */
async function associadosDosContatos(db: Db, contactIds: number[], agora: number): Promise<Map<number, AssociadoDoLado>> {
  if (!contactIds.length) return new Map();
  const linhas = await db.select({
    membroId: entidadeMembros.id, contactId: entidadeMembros.contactId, estado: entidadeMembros.estado,
    entidadeId: entidades.id, entidadeOwnerId: entidades.ownerId, nome: entidades.nome, mostrarNome: entidades.mostrarNomeNoMatch,
    convenioEstado: entidades.convenioEstado, convenioFim: entidades.convenioFim,
  }).from(entidadeMembros)
    .innerJoin(entidades, eq(entidades.id, entidadeMembros.entidadeId))
    .where(and(inArray(entidadeMembros.contactId, contactIds), ne(entidadeMembros.estado, "removido"),
      // O associado é contato da PRÓPRIA conta da entidade: um vínculo torto não serve.
      eq(entidadeMembros.ownerId, entidades.ownerId)));
  return new Map(linhas.map(l => [Number(l.contactId), {
    membroId: Number(l.membroId), contactId: Number(l.contactId), estadoDoMembro: l.estado,
    entidadeId: l.entidadeId, entidadeOwnerId: l.entidadeOwnerId, nome: l.nome, mostrarNome: Boolean(l.mostrarNome),
    convenioVigente: convenioVigente({ estado: l.convenioEstado, fim: l.convenioFim ?? null }, agora),
  }]));
}

// ─── O lado de quem pede ─────────────────────────────────────────────────────

export type PedidoParaQuemPediu = {
  id: string; estado: EstadoDoPedido; criadoEm: number; expiraEm: number; decididoEm: number | null; canal: CanalDoPedido | null;
};

export type LadoComEntidade = LadoVisivel & {
  /** O lado alheio é associado de uma entidade: o nome dela só com a autorização do convênio. */
  entidade?: { nome: string | null };
};

export type ConexaoComEntidade = Omit<ConexaoParaQuemPergunta, "lados"> & {
  lados: LadoComEntidade[];
  pedidoPelaEntidade?: PedidoParaQuemPediu | null;
  podePedirPelaEntidade?: boolean;
};

/**
 * Anota as conexões de quem pergunta: o lado alheio que é associado de uma
 * entidade ganha "membro da entidade X", e a conexão, o pedido de contato (se
 * houver) e se ainda se pode pedir. Associado de entidade SEM convênio vigente
 * sai como a autorização retirada: sem os itens e sem o pedido (o convênio é
 * conferido a cada leitura, como no cruzamento).
 *
 * Sem conexão da rede global na lista, nenhuma consulta é feita.
 */
export async function anotarConexoesComEntidade<T extends ConexaoParaQuemPergunta>(quem: Solicitante, lista: T[], agora = Date.now()): Promise<Array<T & ConexaoComEntidade>> {
  const globais = lista.filter(c => (ORIGENS_DA_REDE_GLOBAL as readonly string[]).includes(c.origem));
  if (!globais.length) return lista;
  const db = await exigirDb();
  const participantes = await db.select().from(conexoesParticipantes)
    .where(and(inArray(conexoesParticipantes.conexaoId, globais.map(c => c.id)), eq(conexoesParticipantes.tipo, "contato")));
  const alheios = participantes.filter(p => !ehDaSolicitante(p, quem) && p.contactId != null);
  const associados = await associadosDosContatos(db, Array.from(new Set(alheios.map(p => Number(p.contactId)))), agora);
  if (!associados.size) return lista;

  const pedidos = await db.select().from(pedidosPelaEntidade)
    .where(and(eq(pedidosPelaEntidade.userId, quem.id), inArray(pedidosPelaEntidade.conexaoId, globais.map(c => c.id))));

  return lista.map(conexao => {
    const doLado = alheios.filter(p => p.conexaoId === conexao.id)
      .map(p => ({ lado: p.lado, associado: associados.get(Number(p.contactId)) }))
      .filter((x): x is { lado: "a" | "b"; associado: AssociadoDoLado } => Boolean(x.associado));
    if (!doLado.length) return conexao;
    const [{ associado }] = doLado;
    if (doLado.some(x => !x.associado.convenioVigente)) {
      return {
        ...conexao, detalhesVisiveis: false, itens: [] as ItemDaConexao[], motivo: MOTIVO_SEM_AUTORIZACAO_DO_OUTRO_LADO,
        pedidoPelaEntidade: null, podePedirPelaEntidade: false,
      };
    }
    const lados = conexao.lados.map(lado => {
      const marca = doLado.find(x => x.lado === lado.lado && !lado.meu);
      return marca ? { ...lado, entidade: { nome: marca.associado.mostrarNome ? marca.associado.nome : null } } : lado;
    });
    const linha = pedidos.find(p => p.conexaoId === conexao.id && Number(p.membroId) === associado.membroId);
    const pedido: PedidoParaQuemPediu | null = linha ? {
      id: linha.id, estado: estadoEfetivo({ estado: linha.estado, expiraEm: Number(linha.expiraEm) }, agora),
      criadoEm: Number(linha.createdAt), expiraEm: Number(linha.expiraEm),
      decididoEm: linha.decididoEm == null ? null : Number(linha.decididoEm), canal: linha.canal ?? null,
    } : null;
    const podePedir = conexao.detalhesVisiveis !== false
      && associado.entidadeOwnerId !== quem.openId
      && associado.estadoDoMembro === "importado"
      && conexao.status !== "descartada"
      && (!pedido || podePedirDeNovo(pedido.estado));
    return { ...conexao, lados, pedidoPelaEntidade: pedido, podePedirPelaEntidade: podePedir };
  });
}

/**
 * Pede o contato do associado do outro lado de uma conexão. Tudo o que não
 * serve (conexão alheia, outro lado que não é associado, convênio encerrado,
 * autorização retirada, a própria entidade pedindo) responde igual:
 * NOT_FOUND com PEDIDO_INDISPONIVEL, sem dizer qual foi o motivo.
 */
export async function pedirContatoPelaEntidade(quem: Solicitante, entrada: { conexaoId: string; mensagem?: string | null }, agora = Date.now()) {
  const db = await exigirDb();
  const indisponivel = () => erro("NOT_FOUND", ERROS_DA_ENTIDADE.pedidoIndisponivel);

  const [{ recentes }] = await db.select({ recentes: count() }).from(pedidosPelaEntidade)
    .where(and(eq(pedidosPelaEntidade.userId, quem.id), gt(pedidosPelaEntidade.createdAt, agora - 86_400_000)));
  if (Number(recentes) >= PEDIDOS_POR_DIA_MAX) throw erro("TOO_MANY_REQUESTS", ERROS_DA_ENTIDADE.pedidosDemais);

  const [cabecalho] = await db.select({ origem: conexoesRegistradas.origem, status: conexoesRegistradas.status })
    .from(conexoesRegistradas).where(eq(conexoesRegistradas.id, entrada.conexaoId)).limit(1);
  if (!cabecalho || !(ORIGENS_DA_REDE_GLOBAL as readonly string[]).includes(cabecalho.origem) || cabecalho.status === "descartada") throw indisponivel();
  const lados = await db.select().from(conexoesParticipantes).where(eq(conexoesParticipantes.conexaoId, entrada.conexaoId));
  const meus = lados.filter(p => ehDaSolicitante(p, quem));
  if (!meus.length || meus.some(p => p.descartadaEm != null)) throw indisponivel();
  const alheios = lados.filter(p => !ehDaSolicitante(p, quem) && p.tipo === "contato" && p.contactId != null);
  const associados = await associadosDosContatos(db, alheios.map(p => Number(p.contactId)), agora);
  const alvo = alheios.find(p => associados.has(Number(p.contactId)));
  const associado = alvo ? associados.get(Number(alvo.contactId)) : undefined;
  if (!alvo || !associado || !associado.convenioVigente || associado.estadoDoMembro !== "importado" || associado.entidadeOwnerId === quem.openId) {
    throw indisponivel();
  }
  // O associado ainda está na rede (SIM, termo do Smart Match da entidade, conta ativa), conferido agora.
  if (!(await participantesAindaAutorizados(db, [alvo])).has(alvo.id)) throw indisponivel();

  const mensagem = entrada.mensagem?.trim() ? mascararContatosEmTexto(entrada.mensagem.trim()).slice(0, MENSAGEM_DO_PEDIDO_MAX) : null;
  const expiraEm = agora + PRAZO_DO_PEDIDO_MS;
  try {
    return await db.transaction(async tx => {
      const [existente] = await tx.select().from(pedidosPelaEntidade)
        .where(and(eq(pedidosPelaEntidade.conexaoId, entrada.conexaoId), eq(pedidosPelaEntidade.userId, quem.id),
          eq(pedidosPelaEntidade.membroId, associado.membroId)))
        .limit(1).for("update");
      let id: string;
      if (existente) {
        if (!podePedirDeNovo(estadoEfetivo({ estado: existente.estado, expiraEm: Number(existente.expiraEm) }, agora))) {
          throw erro("CONFLICT", ERROS_DA_ENTIDADE.pedidoJaExiste);
        }
        id = existente.id;
        await tx.update(pedidosPelaEntidade).set({
          estado: "na_entidade", mensagem, canal: null, expiraEm, encaminhadoEm: null, decididoEm: null, createdAt: agora, updatedAt: agora,
        }).where(eq(pedidosPelaEntidade.id, id));
      } else {
        id = crypto.randomUUID();
        await tx.insert(pedidosPelaEntidade).values({
          id, ownerId: associado.entidadeOwnerId, entidadeId: associado.entidadeId, membroId: associado.membroId,
          conexaoId: entrada.conexaoId, userId: quem.id, mensagem, estado: "na_entidade", expiraEm, createdAt: agora, updatedAt: agora,
        });
      }
      await tx.insert(auditLogs).values({
        userId: quem.id, action: "ENTIDADE_PEDIDO_CRIADO", resource: "pedido_pela_entidade", resourceId: id,
        details: { entidadeId: associado.entidadeId, conexaoId: entrada.conexaoId, deNovo: Boolean(existente), comMensagem: Boolean(mensagem) },
        riskLevel: "low",
      });
      return { id, estado: "na_entidade" as const, expiraEm };
    });
  } catch (falha) {
    // Dois cliques ao mesmo tempo: o segundo bate no índice único e vira "já pediu".
    if (ehColisaoDeChave(falha)) throw erro("CONFLICT", ERROS_DA_ENTIDADE.pedidoJaExiste);
    throw falha;
  }
}

/**
 * No "aceito", quem pediu vê o nome da empresa e o canal que ela escolheu,
 * decifrados agora, com a auditoria na mesma transação. Pedido de outra conta,
 * não aceito ou de associado removido: NOT_FOUND. Convênio encerrado: a
 * entidade não trata mais a base, e nada é decifrado.
 */
export async function contatoPeloPedido(quem: Solicitante, pedidoId: string) {
  exigirChavesDaEntidade();
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [linha] = await tx.select({
      estado: pedidosPelaEntidade.estado, canal: pedidosPelaEntidade.canal, entidadeId: pedidosPelaEntidade.entidadeId,
      convenioEstado: entidades.convenioEstado, convenioFim: entidades.convenioFim,
      empresa: privateContacts.fullName, cifrado: entidadeMembros.contatoCifrado,
    }).from(pedidosPelaEntidade)
      .innerJoin(entidades, eq(entidades.id, pedidosPelaEntidade.entidadeId))
      .innerJoin(entidadeMembros, and(eq(entidadeMembros.id, pedidosPelaEntidade.membroId), ne(entidadeMembros.estado, "removido")))
      .innerJoin(privateContacts, and(eq(privateContacts.id, entidadeMembros.contactId), eq(privateContacts.ownerId, pedidosPelaEntidade.ownerId)))
      .where(and(eq(pedidosPelaEntidade.id, pedidoId), eq(pedidosPelaEntidade.userId, quem.id)))
      .limit(1);
    if (!linha || linha.estado !== "aceito" || !linha.canal) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.pedidoNaoEncontrado);
    if (!convenioVigente({ estado: linha.convenioEstado, fim: linha.convenioFim ?? null })) {
      throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.convenioInativo);
    }
    await tx.insert(auditLogs).values({
      userId: quem.id, action: "ENTIDADE_PEDIDO_CONTATO_REVELADO", resource: "pedido_pela_entidade", resourceId: pedidoId,
      details: { entidadeId: linha.entidadeId, canal: linha.canal }, riskLevel: "medium",
    });
    const contato = linha.cifrado ? JSON.parse(decifrar(linha.cifrado)) as { telefone?: string | null; email?: string | null } : {};
    const campos = camposDoCanal(linha.canal);
    return {
      empresa: linha.empresa,
      telefone: campos.telefone ? contato.telefone ?? null : null,
      email: campos.email ? contato.email ?? null : null,
    };
  });
}

// ─── O lado da entidade ──────────────────────────────────────────────────────

/** O pedido aberto com o prazo vencido vira "expirado" na linha (só os desta entidade). */
async function expirarVencidos(db: Db, entidadeId: number, agora: number) {
  await db.update(pedidosPelaEntidade).set({ estado: "expirado", updatedAt: agora })
    .where(and(eq(pedidosPelaEntidade.entidadeId, entidadeId), inArray(pedidosPelaEntidade.estado, [...ESTADOS_ABERTOS]),
      lte(pedidosPelaEntidade.expiraEm, agora)));
}

const solicitanteEntidade = alias(entidades, "entidade_solicitante");

/**
 * Os pedidos que chegaram à entidade, os abertos primeiro. Leva o nome de quem
 * pede (e a empresa do perfil dela; se quem pede é outra entidade, o nome da
 * entidade), a mensagem, o associado (código e nome, que já são da entidade) e
 * os itens da conexão. Nunca o contato de quem pede. Leitura com auditoria.
 */
export async function listarPedidosDaEntidade(entidade: EntidadeDaConta, userId: number, opcoes: { abertos?: boolean; pagina?: number }, agora = Date.now()) {
  const db = await exigirDb();
  await expirarVencidos(db, entidade.id, agora);
  const pagina = Math.max(0, Math.floor(opcoes.pagina ?? 0));
  const onde = and(
    eq(pedidosPelaEntidade.entidadeId, entidade.id), eq(pedidosPelaEntidade.ownerId, entidade.ownerId),
    opcoes.abertos ? inArray(pedidosPelaEntidade.estado, [...ESTADOS_ABERTOS]) : undefined,
  );
  const [[{ total }], [{ abertos }]] = await Promise.all([
    db.select({ total: count() }).from(pedidosPelaEntidade).where(onde),
    db.select({ abertos: count() }).from(pedidosPelaEntidade)
      .where(and(eq(pedidosPelaEntidade.entidadeId, entidade.id), inArray(pedidosPelaEntidade.estado, [...ESTADOS_ABERTOS]))),
  ]);
  const linhas = await db.select({
    id: pedidosPelaEntidade.id, estado: pedidosPelaEntidade.estado, canal: pedidosPelaEntidade.canal,
    mensagem: pedidosPelaEntidade.mensagem, expiraEm: pedidosPelaEntidade.expiraEm, encaminhadoEm: pedidosPelaEntidade.encaminhadoEm,
    decididoEm: pedidosPelaEntidade.decididoEm, criadoEm: pedidosPelaEntidade.createdAt,
    membroId: pedidosPelaEntidade.membroId, codigo: privateContacts.codigoAnonimo, associado: privateContacts.fullName,
    solicitanteNome: users.name, solicitanteEmpresa: userProfiles.company, solicitanteEntidade: solicitanteEntidade.nome,
    itens: conexoesRegistradas.itens,
  }).from(pedidosPelaEntidade)
    .leftJoin(entidadeMembros, eq(entidadeMembros.id, pedidosPelaEntidade.membroId))
    .leftJoin(privateContacts, and(eq(privateContacts.id, entidadeMembros.contactId), eq(privateContacts.ownerId, entidade.ownerId)))
    .leftJoin(users, eq(users.id, pedidosPelaEntidade.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, pedidosPelaEntidade.userId))
    .leftJoin(solicitanteEntidade, eq(solicitanteEntidade.ownerId, users.openId))
    .leftJoin(conexoesRegistradas, eq(conexoesRegistradas.id, pedidosPelaEntidade.conexaoId))
    .where(onde)
    .orderBy(desc(inArray(pedidosPelaEntidade.estado, [...ESTADOS_ABERTOS])), desc(pedidosPelaEntidade.createdAt))
    .limit(PEDIDOS_POR_PAGINA).offset(pagina * PEDIDOS_POR_PAGINA);
  if (linhas.length) {
    await db.insert(auditLogs).values({
      userId, action: "ENTIDADE_PEDIDOS_LISTADOS", resource: "entidade", resourceId: String(entidade.id),
      details: { pagina, quantos: linhas.length, abertos: Boolean(opcoes.abertos) }, riskLevel: "low",
    });
  }
  return {
    total: Number(total), abertos: Number(abertos), pagina, porPagina: PEDIDOS_POR_PAGINA,
    pedidos: linhas.map(l => ({
      id: l.id, estado: l.estado, canal: l.canal ?? null, mensagem: l.mensagem ?? null,
      criadoEm: Number(l.criadoEm), expiraEm: Number(l.expiraEm),
      encaminhadoEm: l.encaminhadoEm == null ? null : Number(l.encaminhadoEm), decididoEm: l.decididoEm == null ? null : Number(l.decididoEm),
      associado: { membroId: Number(l.membroId), codigo: l.codigo ?? null, nome: l.associado ?? null },
      solicitante: {
        nome: l.solicitanteEntidade ?? l.solicitanteNome ?? null,
        empresa: l.solicitanteEntidade ? null : l.solicitanteEmpresa ?? null,
        ehEntidade: Boolean(l.solicitanteEntidade),
      },
      itens: (Array.isArray(l.itens) ? l.itens as ItemDaConexao[] : []).slice(0, 20)
        .map(item => ({ tem: mascararContatosEmTexto(String(item.tem ?? "")), precisa: mascararContatosEmTexto(String(item.precisa ?? "")) })),
    })),
  };
}

/**
 * A entidade registra o que houve com o pedido. Cada passo leva o estado
 * anterior e o prazo no WHERE: dois cliques, duas abas ou o prazo vencido no
 * meio dão CONFLICT, sem efeito. No "aceitar", o canal tem de existir no
 * contato que a entidade mandou na carga (conferido decifrando, sem devolver).
 */
export async function decidirPedido(
  entidade: EntidadeDaConta, userId: number,
  entrada: { pedidoId: string; acao: AcaoDaEntidade; canal?: CanalDoPedido },
  agora = Date.now(),
) {
  if (!convenioVigente({ estado: entidade.convenioEstado, fim: entidade.convenioFim ?? null }, agora)) {
    throw erro("PRECONDITION_FAILED", ERROS_DA_ENTIDADE.convenioInativo);
  }
  if (entrada.acao === "aceitar") {
    if (!entrada.canal) throw erro("BAD_REQUEST", ERROS_DA_ENTIDADE.canalIndisponivel);
    exigirChavesDaEntidade();
  }
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [pedido] = await tx.select({
      estado: pedidosPelaEntidade.estado, expiraEm: pedidosPelaEntidade.expiraEm, membroId: pedidosPelaEntidade.membroId,
    }).from(pedidosPelaEntidade)
      .where(and(eq(pedidosPelaEntidade.id, entrada.pedidoId), eq(pedidosPelaEntidade.entidadeId, entidade.id)))
      .limit(1).for("update");
    if (!pedido) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.pedidoNaoEncontrado);
    const destino = proximoEstado(estadoEfetivo({ estado: pedido.estado, expiraEm: Number(pedido.expiraEm) }, agora), entrada.acao);
    if (!destino) throw erro("CONFLICT", ERROS_DA_ENTIDADE.pedidoJaDecidido);

    if (entrada.acao === "aceitar") {
      const [membro] = await tx.select({ cifrado: entidadeMembros.contatoCifrado }).from(entidadeMembros)
        .where(and(eq(entidadeMembros.id, pedido.membroId), eq(entidadeMembros.entidadeId, entidade.id), ne(entidadeMembros.estado, "removido")))
        .limit(1);
      if (!membro) throw erro("NOT_FOUND", ERROS_DA_ENTIDADE.membroNaoEncontrado);
      const contato = membro.cifrado ? JSON.parse(decifrar(membro.cifrado)) as { telefone?: string | null; email?: string | null } : {};
      const campos = camposDoCanal(entrada.canal!);
      if ((campos.telefone && !contato.telefone) || (campos.email && !contato.email)) {
        throw erro("BAD_REQUEST", ERROS_DA_ENTIDADE.canalIndisponivel);
      }
    }

    const marcas = entrada.acao === "encaminhar"
      ? { encaminhadoEm: agora, expiraEm: agora + PRAZO_DO_PEDIDO_MS }
      : { decididoEm: agora, ...(entrada.acao === "aceitar" ? { canal: entrada.canal } : {}) };
    const [resultado] = await tx.update(pedidosPelaEntidade).set({ ...marcas, estado: destino, updatedAt: agora })
      .where(and(
        eq(pedidosPelaEntidade.id, entrada.pedidoId), eq(pedidosPelaEntidade.entidadeId, entidade.id),
        eq(pedidosPelaEntidade.estado, estadoDeOrigem(entrada.acao)), gt(pedidosPelaEntidade.expiraEm, agora),
      ));
    if (!((resultado as { affectedRows?: number } | undefined)?.affectedRows)) throw erro("CONFLICT", ERROS_DA_ENTIDADE.pedidoJaDecidido);
    await tx.insert(auditLogs).values({
      userId, action: `ENTIDADE_PEDIDO_${entrada.acao.toUpperCase()}`, resource: "pedido_pela_entidade", resourceId: entrada.pedidoId,
      details: { entidadeId: entidade.id, de: pedido.estado, para: destino, canal: entrada.acao === "aceitar" ? entrada.canal : null },
      riskLevel: entrada.acao === "aceitar" ? "medium" : "low",
    });
    return { estado: destino };
  });
}
