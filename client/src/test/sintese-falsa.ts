import { vi } from "vitest";

/**
 * Uma speechSynthesis de mentira para os testes de "Ouvir o resumo" (H19): o
 * jsdom não lê em voz alta. Guarda cada fala pedida, enfileira como o
 * navegador e deixa o teste dizer quando a fala da vez termina ou falha.
 *
 * O cancel() imita o navegador escolhido: "erro" é o que a especificação
 * manda (interrupted na fala da vez, canceled nas da fila); "fim" é o Chrome,
 * que dispara o end da fala da vez. A tela tem de aguentar os dois.
 *
 * Instala por vi.stubGlobal: o teste chama vi.unstubAllGlobals() no afterEach.
 */

type Evento = { error?: string };
export type FalaFalsa = {
  text: string;
  lang: string;
  voice: SpeechSynthesisVoice | null;
  onstart: ((evento: Evento) => void) | null;
  onend: ((evento: Evento) => void) | null;
  onerror: ((evento: Evento) => void) | null;
};
type VozFalsa = Pick<SpeechSynthesisVoice, "name" | "lang"> & Partial<SpeechSynthesisVoice>;

export function instalarSinteseFalsa({ vozes = [], cancelarComo = "erro" }: { vozes?: VozFalsa[]; cancelarComo?: "erro" | "fim" } = {}) {
  const comoVoz = (voz: VozFalsa) => ({ default: false, localService: true, voiceURI: voz.name, ...voz }) as SpeechSynthesisVoice;
  let lista = vozes.map(comoVoz);
  const pedidas: FalaFalsa[] = [];
  let fila: FalaFalsa[] = [];
  const ouvintes = new Set<() => void>();
  const chamadas = { cancel: 0 };

  class Fala implements FalaFalsa {
    text: string;
    lang = "";
    voice: SpeechSynthesisVoice | null = null;
    onstart: FalaFalsa["onstart"] = null;
    onend: FalaFalsa["onend"] = null;
    onerror: FalaFalsa["onerror"] = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const comecarAPrimeira = () => fila[0]?.onstart?.({});
  const sintese = {
    paused: false,
    getVoices: () => lista,
    speak(fala: FalaFalsa) {
      pedidas.push(fala);
      fila.push(fala);
      if (fila.length === 1) comecarAPrimeira();
    },
    cancel() {
      chamadas.cancel += 1;
      const [atual, ...resto] = fila;
      fila = [];
      if (!atual) return;
      if (cancelarComo === "fim") atual.onend?.({});
      else atual.onerror?.({ error: "interrupted" });
      for (const fala of resto) fala.onerror?.({ error: "canceled" });
    },
    pause() {},
    resume() {},
    addEventListener(tipo: string, ouvinte: () => void) {
      if (tipo === "voiceschanged") ouvintes.add(ouvinte);
    },
    removeEventListener(tipo: string, ouvinte: () => void) {
      if (tipo === "voiceschanged") ouvintes.delete(ouvinte);
    },
  };
  vi.stubGlobal("speechSynthesis", sintese);
  vi.stubGlobal("SpeechSynthesisUtterance", Fala);

  return {
    sintese,
    /** Toda fala que a tela pediu, na ordem, com a voz e o idioma. */
    pedidas,
    chamadas,
    /** Os textos na fila agora: o da vez primeiro. */
    fila: () => fila.map(fala => fala.text),
    /** A fala da vez termina, e a seguinte começa. */
    terminar() {
      const atual = fila.shift();
      atual?.onend?.({});
      comecarAPrimeira();
    },
    /** A fala da vez falha (synthesis-failed, network...). */
    falhar(erro: string) {
      const atual = fila.shift();
      atual?.onerror?.({ error: erro });
      comecarAPrimeira();
    },
    /** A lista de vozes muda, e o navegador avisa (voiceschanged). */
    trocarVozes(novas: VozFalsa[]) {
      lista = novas.map(comoVoz);
      ouvintes.forEach(ouvinte => ouvinte());
    },
  };
}
