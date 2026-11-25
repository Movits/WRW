import { describe, expect, it } from "vitest";
import { CODIGOS, opcoesBase } from "./index";

/**
 * Símbolo que tem forma de emoji não pode virar emoji no meio do texto.
 *
 * O "▶" (U+25B6) da introdução do link aberto de um vídeo do YouTube aparecia
 * no Windows como o emoji azul, diferente do ícone ▶ dos botões que o texto
 * descreve (conferência de tela de 20/11/2026, captura 15e). O seletor de
 * texto U+FE0E logo depois do símbolo pede a forma de texto. A varredura vale
 * para todo valor dos 10 JSONs: o texto novo que trouxer um desses símbolos
 * sem o seletor derruba este teste.
 */

type Dicionario = Record<string, unknown>;

/**
 * Os triângulos que o texto usa para falar dos botões de tocar (▶ e ◀), e que o
 * Windows desenha como emoji quando o texto não pede a forma de texto. Os
 * emojis de propósito (o ✅ e o ⚠️ dos níveis e dos estados) ficam de fora.
 */
const COM_FORMA_DE_EMOJI = ["▶", "◀"];
const SELETOR_DE_TEXTO = "︎";

function textos(idioma: string): [string, string][] {
  const recursos = opcoesBase().resources as Record<string, { translation: Dicionario }>;
  const pares: [string, string][] = [];
  const anda = (no: Dicionario, caminho: string) => {
    for (const [chave, valor] of Object.entries(no)) {
      const inteiro = caminho ? `${caminho}.${chave}` : chave;
      if (typeof valor === "string") pares.push([inteiro, valor]);
      else if (valor && typeof valor === "object") anda(valor as Dicionario, inteiro);
    }
  };
  anda(recursos[idioma].translation, "");
  return pares;
}

describe("os símbolos com forma de emoji levam o seletor de texto (U+FE0E)", () => {
  it.each(CODIGOS)("%s: todo símbolo desses vem seguido de U+FE0E", idioma => {
    const semSeletor = textos(idioma).filter(([, valor]) =>
      COM_FORMA_DE_EMOJI.some(simbolo => valor.split(simbolo).slice(1).some(depois => !depois.startsWith(SELETOR_DE_TEXTO))));
    expect(semSeletor.map(([chave]) => chave)).toEqual([]);
  });

  it.each(CODIGOS)("%s: a introdução do link aberto do vídeo fala do ▶ na forma de texto", idioma => {
    const [, intro] = textos(idioma).find(([chave]) => chave === "meetings.youtube.linkIntro")!;
    expect(intro).toContain(`▶${SELETOR_DE_TEXTO}`);
  });
});
