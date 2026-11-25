import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { ListaDeResultados, ReconhecimentoDeVoz } from "@/lib/legenda-ao-vivo";

/**
 * Um reconhecimento de voz de mentira para os testes da legenda ao vivo
 * (G15b): o jsdom não tem a Web Speech API. Cada `new` fica guardado, com o
 * idioma e as opções que a tela pôs, e o teste diz o que o navegador faria:
 * mandar resultados (a lista INTEIRA da sessão, como o navegador manda),
 * errar, encerrar a sessão sozinho.
 *
 * Como no Chrome: o abort() e o stop() encerram a sessão e disparam o end (o
 * abort, sem os resultados pendentes); start() com a sessão em curso lança
 * InvalidStateError.
 *
 * Instala por vi.stubGlobal (com o prefixo webkit, como no Chrome, ou sem):
 * o teste chama vi.unstubAllGlobals() no afterEach.
 */

type Trecho = string | { texto: string; final?: boolean };

export type ReconhecimentoFalso = ReconhecimentoDeVoz & {
  emCurso: boolean;
  chamadas: { start: number; stop: number; abort: number };
};

export function instalarReconhecimentoFalso({ prefixo = "webkit" }: { prefixo?: "webkit" | "" } = {}) {
  const criados: ReconhecimentoFalso[] = [];
  const falharNoStart = { vezes: 0 };

  class Reconhecimento implements ReconhecimentoFalso {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onresult: ReconhecimentoDeVoz["onresult"] = null;
    onerror: ReconhecimentoDeVoz["onerror"] = null;
    onend: ReconhecimentoDeVoz["onend"] = null;
    emCurso = false;
    chamadas = { start: 0, stop: 0, abort: 0 };
    constructor() {
      criados.push(this);
    }
    start() {
      this.chamadas.start += 1;
      if (this.emCurso) throw new DOMException("já começou", "InvalidStateError");
      if (falharNoStart.vezes > 0) {
        falharNoStart.vezes -= 1;
        throw new DOMException("recusado", "InvalidStateError");
      }
      this.emCurso = true;
    }
    stop() {
      this.chamadas.stop += 1;
      this.encerrar();
    }
    abort() {
      this.chamadas.abort += 1;
      this.encerrar();
    }
    private encerrar() {
      if (!this.emCurso) return;
      this.emCurso = false;
      this.onend?.();
    }
  }
  vi.stubGlobal(prefixo ? "webkitSpeechRecognition" : "SpeechRecognition", Reconhecimento);

  /** A lista de resultados como o navegador a monta: cada trecho é um resultado, final ou provisório. */
  const lista = (trechos: Trecho[]): ListaDeResultados => {
    const resultados = trechos.map(trecho => {
      const { texto, final } = typeof trecho === "string" ? { texto: trecho, final: true } : trecho;
      return { isFinal: final ?? true, length: 1, 0: { transcript: texto } };
    });
    return Object.assign(resultados, { length: resultados.length }) as unknown as ListaDeResultados;
  };

  const atual = () => {
    const ultimo = criados[criados.length - 1];
    if (!ultimo) throw new Error("nenhum reconhecimento foi criado");
    return ultimo;
  };

  return {
    criados,
    atual,
    /** Quantos start() seguintes o navegador recusa. */
    falharNoStart,
    /** O navegador manda a lista inteira da sessão (strings são resultados finais). */
    resultados(trechos: Trecho[], alvo = atual()) {
      act(() => alvo.onresult?.({ resultIndex: 0, results: lista(trechos) }));
    },
    /** O navegador erra (e, como ele, encerra a sessão logo depois, salvo `semFim`). */
    errar(erro: string, { semFim = false, alvo = atual() }: { semFim?: boolean; alvo?: ReconhecimentoFalso } = {}) {
      act(() => {
        alvo.onerror?.({ error: erro });
        if (!semFim && alvo.emCurso) {
          alvo.emCurso = false;
          alvo.onend?.();
        }
      });
    },
    /** O navegador encerra a sessão sozinho (o silêncio, o tempo). */
    encerrar(alvo = atual()) {
      act(() => {
        alvo.emCurso = false;
        alvo.onend?.();
      });
    },
  };
}
