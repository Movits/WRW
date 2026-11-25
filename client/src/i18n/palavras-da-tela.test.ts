import { describe, expect, it } from "vitest";
import { CODIGOS, opcoesBase } from "./index";

/**
 * Duas palavras que a tela não pode mais dizer, nos 10 idiomas.
 *
 * 1. "Tag" no campo de palavras-chave de Nova Oportunidade (reteste v4, item
 *    9): pt-BR e fr já diziam "palavra-chave"/"mot-clé" e os outros 8 seguiam
 *    em "Adicionar tag". Quem escreve a oportunidade não sabe o que é tag.
 * 2. "Match" fora dos nomes próprios "Business Match" e "Smart Match"
 *    (grupo "Projetos IA", 14/09/2026; pedido do Roberto, 15/09): na
 *    plataforma inteira a palavra é "conexão". O servidor já tem a trava da
 *    saída da IA (server/vocabulario-da-conexao.ts); esta é a dos textos fixos.
 *
 * A varredura vale para TODO valor dos 10 JSONs, não só para as chaves que
 * alguém lembrou de conferir: chave nova que fale em "match" derruba este
 * teste no dia em que for escrita.
 */

type Dicionario = Record<string, unknown>;

/** Os pares "caminho da chave" → texto de um idioma, achatados. */
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

function texto(idioma: string, chave: string): string {
  const achado = textos(idioma).find(([c]) => c === chave);
  if (!achado) throw new Error(`${idioma}: a chave ${chave} não existe`);
  return achado[1];
}

// Os nomes próprios da plataforma: Business Match, Smart Match e a marca
// MarquesaMatch (nome visível desde 23/11/2026), que a cliente trocou por
// Marquesa Global Match em 24/11. Saem do texto antes da conferência.
const NOMES_PROPRIOS = /\b(?:(?:business|smart)[\s-]*match(?:es)?|MarquesaMatch|Marquesa Global Match)\b/gi;
const PALAVRA_PROIBIDA = /match/i;

/**
 * As duas únicas frases que podem dizer "match": o inglês de senha, em que
 * "match" é o verbo "coincidir" e não a conexão da plataforma ("Passwords do
 * not match"). Trocar por "conexão" ali não faria sentido em inglês.
 */
const EXCECOES = new Set(["en:auth.passwordMismatch", "en:auth.passwordsMatch"]);

// O campo de palavras-chave de Nova Oportunidade, idioma por idioma. Reticências
// como cada arquivo já usava (zh com as reticências cheias, pt-BR com o caractere único).
const PALAVRA_CHAVE: Record<string, string> = {
  "pt-BR": "Adicionar palavra-chave…",
  en: "Add keyword...",
  es: "Agregar palabra clave...",
  fr: "Ajouter un mot-clé...",
  de: "Schlagwort hinzufügen...",
  ar: "إضافة كلمة مفتاحية...",
  hi: "कीवर्ड जोड़ें...",
  ja: "キーワードを追加...",
  ru: "Добавить ключевое слово...",
  zh: "添加关键词……",
};

// "Tag" como o usuário a leria em cada idioma, incluindo a transliteração.
const TAG = /\btags?\b|etiqueta|标签|タグ|टैग|тег|وسم/i;

describe("palavras que a tela não diz mais", () => {
  it("os 10 idiomas estão na lista deste teste (idioma novo não passa despercebido)", () => {
    expect([...CODIGOS].sort()).toEqual(Object.keys(PALAVRA_CHAVE).sort());
  });

  it.each(CODIGOS)("%s: o campo de Nova Oportunidade pede palavra-chave, não tag", (idioma) => {
    const placeholder = texto(idioma, "newOpportunity.tagInputPlaceholder");
    expect(placeholder, idioma).toBe(PALAVRA_CHAVE[idioma]);
    expect(placeholder, `${idioma} ainda fala em tag`).not.toMatch(TAG);
  });

  it.each(CODIGOS)("%s: nenhum texto diz 'match' fora de Business Match e Smart Match", (idioma) => {
    const sobraram = textos(idioma)
      .filter(([chave]) => !EXCECOES.has(`${idioma}:${chave}`))
      .filter(([, valor]) => PALAVRA_PROIBIDA.test(valor.replace(NOMES_PROPRIOS, "")))
      .map(([chave, valor]) => `${chave} = ${JSON.stringify(valor)}`);
    expect(sobraram, `${idioma}: diga "conexão"`).toEqual([]);
  });

  it("as exceções existem e são só o verbo inglês de senha (se sumirem, tire-as da lista)", () => {
    for (const excecao of EXCECOES) {
      const [idioma, chave] = excecao.split(":");
      expect(texto(idioma, chave), excecao).toMatch(/match/i);
    }
    expect(EXCECOES.size).toBe(2);
  });
});
