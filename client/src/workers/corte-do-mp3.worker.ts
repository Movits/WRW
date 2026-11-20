import { atenderPedidoDeCorte, type PedidoDeCorte, type RespostaDoCorte } from "../lib/corte-do-mp3";

/**
 * O Worker que corta o MP3 importado (H9a): ler um arquivo de horas quadro a
 * quadro não trava a tela. É um módulo servido pelo próprio site
 * (lib/corte-do-mp3-no-worker.ts o cria com new URL(..., import.meta.url)),
 * e não um blob:, que a CSP de produção não deixa rodar
 * (server/_core/csp.ts: script-src só 'self').
 */

// O tsconfig do client usa a lib do DOM, e não a de Worker: o escopo leva só o que o Worker usa.
const escopo = self as unknown as {
  onmessage: ((evento: MessageEvent<PedidoDeCorte>) => void) | null;
  postMessage: (resposta: RespostaDoCorte) => void;
};

escopo.onmessage = evento => {
  void atenderPedidoDeCorte(evento.data, resposta => escopo.postMessage(resposta));
};
