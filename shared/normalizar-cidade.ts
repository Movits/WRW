// Normalização única de nome de cidade, usada nas DUAS pontas da busca:
// o gerador (scripts/gerar-cidades.mjs) grava a chave de busca já normalizada
// dentro do JSON, e o navegador normaliza o que a usuária digita antes de
// comparar. Se as duas normalizações divergirem, "sao paulo" deixa de achar
// "São Paulo" e ninguém percebe — por isso scripts/cidades/montagem.mjs tem
// uma cópia desta função e server/cidades-montagem.test.ts prova, numa tabela
// de casos, que as duas continuam idênticas.
//
// O que a normalização faz, nesta ordem:
//  1. troca as letras que o Unicode NÃO decompõe (ß, ø, æ, ł, ð, þ, ı, ħ...)
//     pelo equivalente latino básico — sem isto "Malmö" e "Malmo" casam, mas
//     "Gdańsk"/"Gdansk" casa e "Łódź"/"Lodz" não, o que é pior que nada. A
//     tabela é consultada com a letra em minúscula, para não depender de cada
//     letra estar escrita nas duas caixas (ver LETRAS_SEM_DECOMPOSICAO);
//  2. NFD e remoção dos diacríticos combinantes (á→a, ç→c, ü→u);
//  3. minúsculas;
//  4. pontuação (hífen, apóstrofo, ponto, vírgula, barra, parênteses) vira
//     espaço, para "Sant'Anna", "Sant Anna" e "Sant-Anna" darem a mesma chave;
//  5. espaços colapsados e aparados;
//  6. NFC no fim, para RECOMPOR o que o passo 2 desmontou e não era diacrítico
//     latino. Sem este passo, o "ド" japonês (que o NFD parte em "ト" + dakuten,
//     marca fora da faixa ̀-ͯ) ficaria guardado em pedaços: casaria
//     com ele mesmo, mas o arquivo gerado teria texto quebrado e a menor
//     mudança de ordem nos passos viraria uma busca que não acha nada.
//
// Escritas não latinas (中文, 日本語, العربية, हिन्दी, Русский) atravessam quase
// intactas, e é isso que permite guardar o nome japonês de Colônia (ケルン) na
// mesma chave do nome alemão (Köln). Cuidado com o russo: o "ё" É "е" + trema,
// então "Кёльн" normaliza para "кельн" — e a consulta "кёльн" também, que é o
// que importa. A comparação continua sendo texto contra texto.

/**
 * Letras que o NFD não decompõe; sem esta tabela elas sobrevivem à normalização.
 *
 * Só MINÚSCULAS, e a consulta é feita com o caractere já em minúscula. A tabela
 * antiga repetia cada letra nas duas caixas (ø e Ø, æ e Æ...) e esquecia três:
 * Ħ, Ŋ e Ŧ só estavam em minúscula. O "Ħ" de "Ħamrun" (Malta) escapava da
 * tabela, virava "ħ" no `toLowerCase()` que vem depois e ficava na chave — que
 * assim deixava de ser idempotente e de bater com o que o navegador calcula:
 * quem digitasse "hamrun" não achava a cidade. Com a consulta em minúscula não
 * há como esquecer uma caixa.
 */
const LETRAS_SEM_DECOMPOSICAO: Record<string, string> = {
  ß: "ss",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ŋ: "n",
  ŧ: "t",
  ħ: "h",
};

/**
 * Pontuação que separa palavras de nome próprio e não deve atrapalhar a busca.
 * O "|" entra na lista porque é o separador de apelidos dentro da chave: um "|"
 * sobrevivente num nome partiria a chave em dois e faria a busca casar pedaço de
 * um nome com pedaço de outro.
 */
const PONTUACAO = /[-–—'’‘`´.,;:/\\()[\]{}"«»|]/g;

export function normalizarCidade(texto: string): string {
  if (!texto) return "";
  let saida = "";
  for (const caractere of texto) {
    // A tabela é consultada com a letra em minúscula (ver o comentário dela):
    // "Ø" e "ø" caem na mesma entrada, e nenhuma caixa fica de fora.
    saida += LETRAS_SEM_DECOMPOSICAO[caractere.toLowerCase()] ?? caractere;
  }
  return saida
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(PONTUACAO, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}
