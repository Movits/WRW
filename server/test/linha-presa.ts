import type { getDb } from "../db";

type Banco = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type Transacao = Parameters<Parameters<Banco["transaction"]>[0]>[0];

/**
 * Roda `trabalho` enquanto outra transação segura, sem commit, a linha que
 * `segurar` gravou, e desfaz essa transação no fim. Devolve se o trabalho
 * terminou com a linha ainda presa: quem trava só pela chave das linhas que
 * mexe não espera por ela; quem varre um intervalo do índice (ou a tabela)
 * espera até o desfazer. Os testes de integração rodam em paralelo no mesmo
 * banco, e é assim que um arquivo travava o outro.
 *
 * Os 3 s só limitam a espera do caso que falha: o que passa não espera nada.
 */
export async function terminaComALinhaPresa(
  banco: Banco,
  segurar: (tx: Transacao) => Promise<unknown>,
  trabalho: () => Promise<unknown>,
): Promise<boolean> {
  const desfazer = new Error("desfazer a transação que segura a linha");
  let terminou = false;
  let terminouComALinhaPresa = false;
  let emCurso: Promise<unknown> = Promise.resolve();
  await banco.transaction(async tx => {
    await segurar(tx);
    emCurso = trabalho().then(() => { terminou = true; });
    await Promise.race([emCurso, new Promise(resolve => setTimeout(resolve, 3_000))]);
    terminouComALinhaPresa = terminou;
    throw desfazer;
  }).catch(erro => { if (erro !== desfazer) throw erro; });
  await emCurso;
  return terminouComALinhaPresa;
}
