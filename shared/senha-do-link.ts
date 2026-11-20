/**
 * A senha de 6 dígitos do link aberto da reunião (H23, HN-57 do HiNoter): o
 * que a página do link e o servidor precisam combinar. O resto (gerar, guardar
 * o hash, o cookie e o freio da força bruta) mora em server/senha-do-link-aberto.ts.
 */

export const DIGITOS_DA_SENHA_DO_LINK = 6;

/** A senha que o servidor aceita, depois de normalizada: só os 6 algarismos de 0 a 9. */
export const FORMATO_DA_SENHA_DO_LINK = /^[0-9]{6}$/;

// O zero de cada sequência de algarismos que um teclado dos 10 idiomas da tela
// digita além do 0-9: o arábico-índico (árabe), o arábico-índico estendido (o
// teclado persa, comum em aparelho que lê árabe), o devanágari (hindi) e o de
// largura cheia (o método de entrada do chinês e do japonês).
const ZEROS_DOS_ALGARISMOS = [0x0660, 0x06f0, 0x0966, 0xff10];

/**
 * A senha como o servidor a confere: os algarismos de outros sistemas viram
 * 0-9, e espaço, hífen e ponto saem ("123 456" e "123-456" valem). O resto fica
 * como veio, e a conferência do formato o recusa.
 */
export function normalizarSenhaDoLink(texto: string): string {
  let saida = "";
  for (const caractere of texto) {
    const codigo = caractere.codePointAt(0)!;
    const zero = ZEROS_DOS_ALGARISMOS.find(inicio => codigo >= inicio && codigo <= inicio + 9);
    if (zero !== undefined) saida += String(codigo - zero);
    else if (!/[\s.\-‐-―]/.test(caractere)) saida += caractere;
  }
  return saida;
}

/**
 * O que a entrada no link responde (reuniaoAberta.entrar). A senha errada, o
 * link que não existe, o desligado e o que não tem senha respondem o mesmo
 * "senha": a página da senha não diz se o link existe. "espera" é o freio da
 * força bruta, com os segundos que faltam.
 */
export type ResultadoDaEntradaNoLink =
  | { entrou: true }
  | { entrou: false; motivo: "senha" }
  | { entrou: false; motivo: "espera"; segundos: number };
