import type { IdiomaDaReuniao } from "@shared/idioma-da-reuniao";

/**
 * Ler um texto em voz alta com a voz do próprio aparelho (a speechSynthesis
 * do navegador), sem IA e sem custo: a H19 do plano do gravador, "Ouvir o
 * resumo". Aqui moram só as partes puras: qual voz do aparelho fala o idioma
 * pedido e como cortar o texto em falas curtas. Tocar, pausar e continuar
 * moram em components/OuvirOResumo.tsx.
 */

/**
 * O Chrome entrega a lista de vozes depois, pelo voiceschanged, e há navegador
 * que não avisa nada. Passado este prazo, lista vazia é "sem voz".
 */
export const PRAZO_DAS_VOZES = 2_000;

/** O que se lê de cada voz do aparelho (SpeechSynthesisVoice). */
export type VozDoAparelho = Pick<SpeechSynthesisVoice, "name" | "lang" | "default">;

// "pt_BR" (o Android às vezes escreve assim), "pt-br" e "pt-BR" são a mesma
// etiqueta.
const etiqueta = (lang: string) => lang.trim().replace(/_/g, "-").toLowerCase();

// O mandarim às vezes vem como "cmn" em vez de "zh".
const BASES: Partial<Record<IdiomaDaReuniao, readonly string[]>> = { zh: ["zh", "cmn"] };
// A região que o texto pede: o resumo em pt-BR soa melhor numa voz do Brasil,
// e o chinês simplificado numa voz do mandarim da China continental.
const PREFERIDAS: Partial<Record<IdiomaDaReuniao, readonly string[]>> = {
  "pt-BR": ["pt-br"],
  zh: ["zh-cn", "zh-hans", "zh-hans-cn", "cmn-cn", "cmn-hans-cn"],
};
// As vozes do cantonês (Hong Kong e Macau) leem o chinês com outra pronúncia:
// só quando não há outra.
const POR_ULTIMO: Partial<Record<IdiomaDaReuniao, readonly string[]>> = { zh: ["zh-hk", "zh-mo", "zh-yue"] };
// As vozes de brincadeira do macOS, que o Safari e o Chrome do Mac listam como
// inglês dos EUA: nunca a primeira escolha.
const VOZES_DE_BRINCADEIRA = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "deranged", "good news",
  "hysterical", "jester", "organ", "pipe organ", "superstar", "trinoids", "whisper", "wobble", "zarvox",
]);
// As vozes da Eloquence, robóticas, que o macOS 13 em diante traz para vários
// idiomas. A lista do Mac vem em ordem alfabética e o Safari marca toda voz
// como padrão: sem isto, "Eddy (Português (Brasil))" ganharia da Luciana.
const VOZES_DA_ELOQUENCE = new Set(["eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley"]);
// O nome sem o idioma que o Mac acrescenta: "Eddy (Português (Brasil))" é "eddy".
const nomeDaVoz = (voz: VozDoAparelho) => voz.name.split(" (")[0].trim().toLowerCase();
const vozDeSegunda = (voz: VozDoAparelho) => VOZES_DE_BRINCADEIRA.has(nomeDaVoz(voz)) || VOZES_DA_ELOQUENCE.has(nomeDaVoz(voz));

/**
 * A voz do aparelho que lê o idioma pedido, ou null quando o aparelho não tem
 * nenhuma (a tela explica, em vez de ler o texto com a pronúncia de outro
 * idioma). Entre as que servem: a da região preferida, depois uma que não seja
 * de brincadeira nem da Eloquence, depois a voz padrão do aparelho e, por fim,
 * a ordem da lista.
 */
export function escolherVoz<V extends VozDoAparelho>(vozes: readonly V[], idioma: IdiomaDaReuniao): V | null {
  const bases = BASES[idioma] ?? [idioma.split("-")[0].toLowerCase()];
  const regiao = (tag: string) => PREFERIDAS[idioma]?.includes(tag) ? 0
    : POR_ULTIMO[idioma]?.some(ultima => tag === ultima || tag.startsWith(`${ultima}-`)) ? 2 : 1;
  const candidatas = vozes
    .map((voz, ordem) => ({ voz, ordem, tag: etiqueta(voz.lang ?? "") }))
    .filter(({ tag }) => bases.includes(tag.split("-")[0]))
    .map(({ voz, ordem, tag }) => ({
      voz,
      nota: [regiao(tag), vozDeSegunda(voz) ? 1 : 0, voz.default ? 0 : 1, ordem],
    }));
  candidatas.sort((a, b) => {
    for (let i = 0; i < a.nota.length; i++) if (a.nota[i] !== b.nota[i]) return a.nota[i] - b.nota[i];
    return 0;
  });
  return candidatas[0]?.voz ?? null;
}

// Uma frase termina no ponto (seguido de espaço ou do fim: "3.5" não corta),
// na exclamação, na interrogação ou nas reticências, e nos finais do chinês,
// do japonês, do árabe e do hindi, que dispensam o espaço. Sem lookbehind de
// propósito: o Safari anterior ao 16.4 nem carrega um módulo que o use. (Sem
// a flag u: todos esses sinais cabem numa unidade de UTF-16.)
const FRASE = /[\s\S]+?(?:[.!?…]+(?=\s|$)|[。！？؟।]+|$)/g;
// Onde a voz pode respirar no meio de uma frase longa.
const PAUSAS = new Set([",", ";", ":", "，", "、", "；", "：", "،", "—", "–"]);

/** Onde cortar a janela: depois da última pausa, senão do último espaço, senão no fim. */
function pontoDeCorte(janela: string): number {
  const minimo = Math.floor(janela.length / 3);
  for (let i = janela.length - 1; i > minimo; i--) if (PAUSAS.has(janela[i])) return i + 1;
  for (let i = janela.length - 1; i > minimo; i--) if (/\s/.test(janela[i])) return i + 1;
  // Corte seco: nunca no meio de um par substituto (um emoji).
  const ultimo = janela.charCodeAt(janela.length - 1);
  return ultimo >= 0xd800 && ultimo <= 0xdbff ? janela.length - 1 : janela.length;
}

/**
 * O texto em falas curtas, na ordem: uma por frase e, frase longa, cortada
 * numa pausa ou num espaço antes do teto. Fala curta é o que deixa o
 * "Continuar" voltar só ao começo da frase em que a leitura parou, e o que
 * evita o corte do Chrome, que cala as vozes do Google depois de uns 15 s
 * numa fala só. No chinês e no japonês cada caractere leva mais tempo, e o
 * teto é menor.
 */
export function falasCurtas(texto: string, idioma: IdiomaDaReuniao): string[] {
  const teto = idioma === "zh" || idioma === "ja" ? 60 : 160;
  const falas: string[] = [];
  for (const frase of texto.match(FRASE) ?? []) {
    let resto = frase.trim();
    while (resto.length > teto) {
      const corte = pontoDeCorte(resto.slice(0, teto));
      falas.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    if (resto) falas.push(resto);
  }
  return falas.filter(Boolean);
}
