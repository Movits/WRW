/**
 * Roda `tarefa` em cada item com no máximo `limite` em curso ao mesmo tempo e
 * devolve o resultado de cada um na ORDEM dos itens: `{ valor }` para o item que
 * rodou e `undefined` para o que nem começou porque `parar` disse que sim.
 *
 * Existe para o expurgo do áudio de reunião (server/meeting-service.ts e
 * server/exclusao-de-conta.ts): cada arquivo custa 4 a 5 chamadas ao bucket, e
 * uma reunião longa tem dezenas de partes. Um por vez, a exclusão de uma reunião
 * de 12 h passava de um minuto; todos de uma vez, seriam centenas de chamadas
 * simultâneas ao B2.
 *
 * `parar` é conferido antes de cada item COMEÇAR: o que já está em curso
 * termina. `tarefa` não deve rejeitar (quem chama trata o erro de cada item);
 * se rejeitar, nenhum item novo começa, os que estão em curso terminam e o
 * primeiro erro é relançado, sem promessa solta.
 */
export async function comConcorrenciaLimitada<T, R>(
  itens: readonly T[],
  limite: number,
  tarefa: (item: T) => Promise<R>,
  parar: () => boolean = () => false,
): Promise<Array<{ valor: R } | undefined>> {
  const resultados: Array<{ valor: R } | undefined> = itens.map(() => undefined);
  let proximo = 0;
  let falha: { erro: unknown } | null = null;
  const trabalhador = async () => {
    while (!falha && proximo < itens.length && !parar()) {
      const indice = proximo++;
      try {
        resultados[indice] = { valor: await tarefa(itens[indice]) };
      } catch (erro) {
        falha ??= { erro };
      }
    }
  };
  const quantos = Math.min(Number.isFinite(limite) && limite >= 1 ? Math.floor(limite) : 1, itens.length);
  await Promise.all(Array.from({ length: quantos }, trabalhador));
  if (falha) throw (falha as { erro: unknown }).erro;
  return resultados;
}
