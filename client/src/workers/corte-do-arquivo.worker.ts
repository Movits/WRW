import { atenderPedidoDeCorte, type PedidoDeCorte, type RespostaDoCorte } from "../lib/corte-do-arquivo";

/**
 * O Worker que corta o arquivo importado em partes (H9a, H9b e H9c): ler um
 * arquivo de horas quadro a quadro não trava a tela. É um módulo servido pelo
 * próprio site (lib/corte-do-arquivo-no-worker.ts o cria com
 * new URL(..., import.meta.url)), e não um blob:, que a CSP de produção não
 * deixa rodar (server/_core/csp.ts: script-src só 'self'). As partes voltam
 * à página transferidas, sem cópia dos bytes novos.
 */

// O tsconfig do client usa a lib do DOM, e não a de Worker: o escopo leva só o que o Worker usa.
const escopo = self as unknown as {
  onmessage: ((evento: MessageEvent<PedidoDeCorte>) => void) | null;
  postMessage: (resposta: RespostaDoCorte, transferir?: Transferable[]) => void;
};

escopo.onmessage = evento => {
  void atenderPedidoDeCorte(evento.data, (resposta, transferir) => escopo.postMessage(resposta, transferir ?? []));
};
