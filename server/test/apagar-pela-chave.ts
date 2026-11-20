import { eq, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { getDb } from "../db";

type Banco = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type TabelaComId = MySqlTable & { id: AnyMySqlColumn };

/**
 * A limpeza dos testes de integração apaga pela chave primária, uma linha por vez.
 *
 * Os arquivos de integração rodam em paralelo no MESMO banco. Um DELETE pela
 * dona (`where owner_id = ?`) trava, em REPEATABLE READ, tudo o que a busca
 * dele percorre, e o otimizador do MariaDB VARRE a tabela inteira quando a dona
 * tem a maior parte das linhas (banco de testes pequeno: com 23 de 26 reuniões
 * de uma dona, o plano do DELETE já é "ALL"). Varrendo, o DELETE trava cada
 * linha e cada vão da tabela, na ordem da chave. Um INSERT de várias linhas de
 * outro arquivo (as três reuniões do link aberto) segura a primeira linha que
 * gravou e, na seguinte, espera por um vão que o DELETE já travou; o DELETE
 * chega àquela primeira linha e espera também: deadlock, e o INSERT é desfeito
 * (ER_LOCK_DEADLOCK num INSERT em `meetings`, no CI local da #218 e na
 * validação da N5). Nessa ordem, contra o MariaDB local, a segunda linha do
 * INSERT levou ER_LOCK_DEADLOCK 3 vezes em 3 com o DELETE pela dona e 3 em 3
 * com `id IN (...)`; com um DELETE por linha, entrou 3 em 3.
 *
 * Aqui os ids saem de uma leitura sem trava, e cada DELETE vai pela chave de
 * UMA linha: trava só ela. Não é `id IN (...)`: com a lista cobrindo quase a
 * tabela toda, o otimizador também prefere varrê-la (20 ids numa tabela de 20
 * linhas: plano "ALL"). Devolve quantas apagou.
 */
export async function apagarPelaChave(banco: Banco, tabela: TabelaComId, onde: SQL | undefined): Promise<number> {
  const linhas = await banco.select({ id: tabela.id }).from(tabela).where(onde);
  let apagadas = 0;
  for (const { id } of linhas) {
    const resultado: unknown = await banco.delete(tabela).where(eq(tabela.id, id));
    const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
    apagadas += (cabecalho as { affectedRows?: number } | null)?.affectedRows ?? 0;
  }
  return apagadas;
}
