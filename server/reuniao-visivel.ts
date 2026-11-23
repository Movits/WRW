import { and, isNull, ne, sql, type AnyColumn } from "drizzle-orm";
import { meetings } from "../drizzle/schema";

/**
 * A regra da lixeira na consulta (H7d): a reunião na lixeira está FORA, como a
 * excluída. Mora num módulo sem outras dependências (só o schema) para quem
 * consulta reuniões a importar sem ciclo: a lista, a busca, a Memória, o link
 * aberto, as filas, os motores e os serviços de cada procedimento pelo id.
 *
 * Consulta NOVA de reuniões (ou de algo que nasce de uma reunião e aparece
 * para alguém) filtra por aqui; a única leitura da lixeira é a da própria dona
 * (server/lixeira-de-reunioes.ts). Os procedimentos pelo id de server/routers/
 * meetings.ts passam também pela guarda (server/guarda-da-lixeira.ts).
 */

/** A reunião fora da lixeira (pode estar no meio da exclusão: junte com o status quando importar). */
export function foraDaLixeira() {
  return isNull(meetings.trashedAt);
}

/** A reunião que a dona vê: nem no meio da exclusão ('deleted') nem na lixeira. */
export function reuniaoVisivel() {
  return and(ne(meetings.status, "deleted"), isNull(meetings.trashedAt));
}

/**
 * O que nasceu de uma reunião e aparece fora dela (as pendências que a IA
 * tirou da reunião e esperam a dona, com o trecho da fala), pela coluna que
 * aponta a reunião: some enquanto a reunião está na lixeira. Sem reunião (a
 * coluna nula, ou a reunião que já saiu), passa. Subconsulta correlata, com
 * as colunas como parâmetro do `sql` (nunca texto colado).
 */
export function semReuniaoNaLixeira(colunaDaReuniao: AnyColumn) {
  return sql`not exists (select 1 from ${meetings} where ${meetings.id} = ${colunaDaReuniao} and ${meetings.trashedAt} is not null)`;
}

/**
 * A coluna `trashed_at` lida em JS: na lixeira é ter a hora em que foi para lá
 * (um número). Nula é fora da lixeira; o que não é um número de verdade (a
 * coluna que a leitura não trouxe) também conta como fora, como no SQL, em que
 * só o valor gravado põe a reunião na lixeira.
 */
export function estaNaLixeira(trashedAt: unknown): boolean {
  return typeof trashedAt === "number" && Number.isFinite(trashedAt);
}

/** O mesmo, lido em JS: a reunião que não existe, a excluída e a da lixeira são "não encontrada". */
export function reuniaoForaDeVista(reuniao: { status: string; trashedAt?: number | null } | null | undefined): boolean {
  return !reuniao || reuniao.status === "deleted" || estaNaLixeira(reuniao.trashedAt);
}
