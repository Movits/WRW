import { describe, expect, it } from "vitest";
import { comConcorrenciaLimitada } from "./concorrencia-limitada";

/**
 * comConcorrenciaLimitada: o expurgo do áudio de reunião numa requisição da tela
 * (a leitura vencida, a exclusão da reunião e a da conta) roda alguns arquivos
 * por vez, nunca um por vez (passava de um minuto numa reunião longa) nem todos
 * de uma vez (centenas de chamadas simultâneas ao bucket).
 */

/** Uma tarefa que só termina quando o teste manda, e conta quantas estão em curso. */
function bancada() {
  let emCurso = 0;
  let maximo = 0;
  const pendentes = new Map<number, { terminar: (valor: string) => void; falhar: (erro: unknown) => void }>();
  const tarefa = (item: number) => new Promise<string>((terminar, falhar) => {
    emCurso += 1;
    maximo = Math.max(maximo, emCurso);
    pendentes.set(item, {
      terminar: valor => { emCurso -= 1; pendentes.delete(item); terminar(valor); },
      falhar: erro => { emCurso -= 1; pendentes.delete(item); falhar(erro); },
    });
  });
  return { tarefa, pendentes, maximo: () => maximo };
}
const esvaziar = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("comConcorrenciaLimitada", () => {
  it("nunca passa do limite em curso, roda todos e devolve na ORDEM dos itens, mesmo terminando fora de ordem", async () => {
    const { tarefa, pendentes, maximo } = bancada();
    const itens = [0, 1, 2, 3, 4, 5, 6, 7];
    const resultado = comConcorrenciaLimitada(itens, 3, tarefa);
    await esvaziar();
    expect([...pendentes.keys()]).toEqual([0, 1, 2]);
    // Termina de trás para a frente: a ordem do resultado é a dos itens.
    while (pendentes.size) {
      const ultimo = Math.max(...pendentes.keys());
      pendentes.get(ultimo)!.terminar(`item ${ultimo}`);
      await esvaziar();
    }
    expect(await resultado).toEqual(itens.map(item => ({ valor: `item ${item}` })));
    expect(maximo()).toBe(3);
  });

  it("`parar` impede os próximos de começarem; os que estavam em curso terminam, e os que nem começaram voltam undefined", async () => {
    const { tarefa, pendentes } = bancada();
    let parar = false;
    const resultado = comConcorrenciaLimitada([0, 1, 2, 3, 4], 2, tarefa, () => parar);
    await esvaziar();
    parar = true;
    pendentes.get(0)!.terminar("zero");
    await esvaziar();
    expect([...pendentes.keys()]).toEqual([1]);
    pendentes.get(1)!.terminar("um");
    expect(await resultado).toEqual([{ valor: "zero" }, { valor: "um" }, undefined, undefined, undefined]);
  });

  it("tarefa que rejeita: nenhuma nova começa, a que estava em curso termina, e o primeiro erro sobe depois dela", async () => {
    const { tarefa, pendentes } = bancada();
    const resultado = comConcorrenciaLimitada([0, 1, 2, 3], 2, tarefa);
    let rejeitou: unknown = null;
    resultado.catch(erro => { rejeitou = erro; });
    await esvaziar();
    pendentes.get(0)!.falhar(new Error("bucket fora"));
    await esvaziar();
    // A 1 ainda está em curso: o erro só sobe quando ela termina.
    expect(rejeitou).toBeNull();
    expect([...pendentes.keys()]).toEqual([1]);
    pendentes.get(1)!.terminar("um");
    await expect(resultado).rejects.toThrow("bucket fora");
  });

  it("lista vazia não chama nada; limite inválido vale 1, e limite maior que a lista não cria tarefa a mais", async () => {
    let chamadas = 0;
    expect(await comConcorrenciaLimitada([], 6, async () => { chamadas++; })).toEqual([]);
    expect(chamadas).toBe(0);

    const { tarefa, pendentes, maximo } = bancada();
    const umPorVez = comConcorrenciaLimitada([0, 1], Number.NaN, tarefa);
    await esvaziar();
    expect([...pendentes.keys()]).toEqual([0]);
    pendentes.get(0)!.terminar("a");
    await esvaziar();
    pendentes.get(1)!.terminar("b");
    expect(await umPorVez).toEqual([{ valor: "a" }, { valor: "b" }]);
    expect(maximo()).toBe(1);

    expect(await comConcorrenciaLimitada([1, 2], 50, async item => item * 2)).toEqual([{ valor: 2 }, { valor: 4 }]);
  });
});
