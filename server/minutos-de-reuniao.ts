import crypto from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { assinaturasDeMinutos, consumoDeMinutos, planosDeMinutos } from "../drizzle/schema";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import { exigirDb } from "./db";

/**
 * Minutos de reunião — Meu Network Inteligente, spec da Glenda de 14/09,
 * itens 3, 4 e 25.
 *
 * O GRATUITO é real e já é aplicado: desde a G13b a gravação de todas é em
 * partes, sem o teto de 10 minutos, e cada reunião gravada vai até 12 horas
 * (GRAVACAO_EM_PARTES_SEGUNDOS_MAX em shared/const.ts, o teto técnico que a tela
 * e server/fatias-de-reuniao.ts conferem; o teste deste módulo amarra os dois
 * números). O arquivo de áudio ou vídeo enviado também vai em partes, até 12 h
 * (H9a, H9b e H9c); desde a G14 o envio único, com os 10 minutos e 10 MB dele
 * (meeting-service.ts), só sobra no recuo do corte do arquivo de um formato que
 * o corte não lê.
 *
 * A MENSALIDADE que amplia os minutos é ESTRUTURA, não recurso (decisão do
 * Roberto de 14/09 e item 4: "Se não existir [infraestrutura de pagamento],
 * NÃO simule cobrança"). Não existe integração de pagamento no sistema. Por
 * isso:
 * - planos_de_minutos nasce vazia: preço, minutos adicionais, limite por
 *   reunião, limite mensal, nome e periodicidade são colunas que o
 *   administrador preenche depois — nada disso é inventado aqui;
 * - assinaturas_de_minutos só ganha linha 'ativa' pela integração futura;
 *   nenhum procedimento cria assinatura;
 * - `ampliacao.disponivel` é falso enquanto INTEGRACAO_DE_PAGAMENTO_CONFIGURADA
 *   for falso, e a tela diz que a ampliação depende dessa integração.
 *
 * O contador de consumo (consumo_de_minutos) é real: uma linha por reunião
 * transcrita e por áudio curto de complemento por voz.
 *
 * O que ainda falta para um plano pago acima das 12 h valer de verdade, além do
 * pagamento: subir o teto técnico da gravação em partes
 * (GRAVACAO_EM_PARTES_SEGUNDOS_MAX, que a tela e o servidor conferem, e
 * PARTES_NO_MAXIMO em server/fatias-de-reuniao.ts).
 */

export const LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS = GRAVACAO_EM_PARTES_SEGUNDOS_MAX;

/** Não há provedor de pagamento no sistema. Virar `true` é trabalho da integração, não desta constante. */
export const INTEGRACAO_DE_PAGAMENTO_CONFIGURADA = false;

export type ResumoDeMinutos = {
  plano: "gratuito" | "pago";
  limitePorReuniaoSegundos: number;
  /** null = sem limite mensal adotado (hoje nenhum plano define). */
  limiteMensalSegundos: number | null;
  usadosNoMesSegundos: number;
  inicioDoMes: number;
  ampliacao: { disponivel: boolean; dependeDe: "integracao_de_pagamento" | null };
};

/** Primeiro instante do mês corrente, em UTC (o servidor do Render roda em UTC). */
export function inicioDoMesUtc(agora: number): number {
  const data = new Date(agora);
  return Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), 1);
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/**
 * Soma no contador. Uma linha por (dona, origem, referência): o reprocessamento
 * de uma reunião transcreve o mesmo áudio de novo e não conta outra vez.
 */
export async function registrarConsumoDeMinutos(db: Banco, entrada: {
  ownerId: string; origem: "reuniao" | "voz"; referencia: string; segundos: number;
}) {
  const segundos = Math.max(0, Math.round(entrada.segundos));
  await db.insert(consumoDeMinutos).values({
    id: crypto.randomUUID(),
    ownerId: entrada.ownerId,
    origem: entrada.origem,
    referencia: entrada.referencia,
    segundos,
    createdAt: Date.now(),
  }).onDuplicateKeyUpdate({ set: { segundos: sql`${consumoDeMinutos.segundos}` } });
}

/**
 * O plano que vale para a usuária agora. Sem assinatura ativa de um plano
 * ativo, é o gratuito. Coluna vazia no plano herda o gratuito — um plano mal
 * configurado nunca REDUZ o que a usuária já tem.
 */
export async function resolverPlanoDeMinutos(userId: number, agora = Date.now()) {
  const db = await exigirDb();
  const [assinatura] = await db
    .select({
      fimEm: assinaturasDeMinutos.fimEm,
      limitePorReuniaoSegundos: planosDeMinutos.limitePorReuniaoSegundos,
      limiteMensalSegundos: planosDeMinutos.limiteMensalSegundos,
      nome: planosDeMinutos.nome,
    })
    .from(assinaturasDeMinutos)
    .innerJoin(planosDeMinutos, eq(planosDeMinutos.id, assinaturasDeMinutos.planoId))
    .where(and(
      eq(assinaturasDeMinutos.userId, userId),
      eq(assinaturasDeMinutos.status, "ativa"),
      eq(planosDeMinutos.ativo, true),
    ))
    .orderBy(desc(assinaturasDeMinutos.inicioEm))
    .limit(1);
  const vigente = assinatura && (assinatura.fimEm === null || Number(assinatura.fimEm) > agora);
  if (!vigente) {
    return { plano: "gratuito" as const, nome: null, limitePorReuniaoSegundos: LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS, limiteMensalSegundos: null };
  }
  return {
    plano: "pago" as const,
    nome: assinatura.nome,
    limitePorReuniaoSegundos: Math.max(LIMITE_GRATUITO_POR_REUNIAO_SEGUNDOS, Number(assinatura.limitePorReuniaoSegundos ?? 0)),
    limiteMensalSegundos: assinatura.limiteMensalSegundos === null ? null : Number(assinatura.limiteMensalSegundos),
  };
}

export async function resumoDeMinutos(quem: { id: number; openId: string }, agora = Date.now()): Promise<ResumoDeMinutos> {
  const db = await exigirDb();
  const inicioDoMes = inicioDoMesUtc(agora);
  const [plano, [usados]] = await Promise.all([
    resolverPlanoDeMinutos(quem.id, agora),
    db.select({ segundos: sql<number>`COALESCE(SUM(${consumoDeMinutos.segundos}), 0)` })
      .from(consumoDeMinutos)
      .where(and(eq(consumoDeMinutos.ownerId, quem.openId), gte(consumoDeMinutos.createdAt, inicioDoMes))),
  ]);
  return {
    plano: plano.plano,
    limitePorReuniaoSegundos: plano.limitePorReuniaoSegundos,
    limiteMensalSegundos: plano.limiteMensalSegundos,
    usadosNoMesSegundos: Number(usados?.segundos ?? 0) || 0,
    inicioDoMes,
    ampliacao: INTEGRACAO_DE_PAGAMENTO_CONFIGURADA
      ? { disponivel: true, dependeDe: null }
      : { disponivel: false, dependeDe: "integracao_de_pagamento" },
  };
}
