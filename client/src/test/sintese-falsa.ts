import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Uma speechSynthesis de mentira para os testes de "Ouvir o resumo" (H19): o
 * jsdom não lê em voz alta. Guarda cada fala pedida, enfileira como o
 * navegador e deixa o teste dizer quando a fala da vez termina ou falha.
 * Como no Chrome e no WebKit, a fala seguinte da fila começa mesmo depois de
 * um erro na fala da vez.
 *
 * O cancel() imita o navegador escolhido: "erro" é o que a especificação
 * manda (interrupted na fala da vez, canceled nas da fila); "fim" é o
 * navegador que dispara o end da fala da vez em vez do erro. A tela tem de
 * aguentar os dois.
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

  // Cada fala começa uma vez só, mesmo quando a tela pede a seguinte de
  // dentro do fim da anterior.
  let comecada: FalaFalsa | undefined;
  const comecarAPrimeira = () => {
    const primeira = fila[0];
    if (!primeira || primeira === comecada) return;
    comecada = primeira;
    primeira.onstart?.({});
  };
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

  const terminar = () => {
    const atual = fila.shift();
    atual?.onend?.({});
    comecarAPrimeira();
  };

  return {
    sintese,
    /** Toda fala que a tela pediu, na ordem, com a voz e o idioma. */
    pedidas,
    chamadas,
    /** Os textos na fila agora: o da vez primeiro. */
    fila: () => fila.map(fala => fala.text),
    /** A fala da vez termina, e a seguinte começa. */
    terminar,
    /**
     * A fala da vez falha (synthesis-failed, network...) ou é interrompida de
     * fora (interrupted, canceled: no Chrome, o cancel() de outra aba), e a
     * seguinte da fila começa, como no navegador.
     */
    falhar(erro: string) {
      const atual = fila.shift();
      atual?.onerror?.({ error: erro });
      comecarAPrimeira();
    },
    /**
     * A fala da vez e as que a tela pedir depois terminam, uma a uma, até a
     * fila esvaziar (dentro de um act). Devolve o que a voz leu, na ordem.
     */
    lerAteOFim() {
      const lidas: string[] = [];
      act(() => {
        while (fila.length) {
          if (lidas.length > 1_000) throw new Error("A leitura não acaba: a tela pede fala sem parar.");
          lidas.push(fila[0].text);
          terminar();
        }
      });
      return lidas;
    },
    /** A lista de vozes muda, e o navegador avisa (voiceschanged). */
    trocarVozes(novas: VozFalsa[]) {
      lista = novas.map(comoVoz);
      ouvintes.forEach(ouvinte => ouvinte());
    },
  };
}
