/**
 * Corta um texto longo (a transcrição de uma reunião longa) em janelas de até
 * `tamanho` caracteres, para a IA ler a reunião INTEIRA em partes, em vez de
 * cortar em silêncio o que passava do teto (24 mil na extração, 48 mil na
 * tradução, 20 mil no embedding da Memória). G8 do desenho do gravador
 * (docs/arquitetura/gravador-de-reunioes.md).
 *
 * O corte procura, de trás para a frente dentro da janela, uma quebra de linha;
 * sem ela, um fim de frase; sem ele, um espaço. Só corta no meio de uma palavra
 * quando a janela inteira é uma palavra só. Juntar as janelas devolve o texto
 * original (nenhum caractere some nem se repete).
 */
export function dividirEmJanelas(texto: string, tamanho: number): string[] {
  if (!Number.isInteger(tamanho) || tamanho < 100) throw new Error("Janela pequena demais.");
  if (texto.length <= tamanho) return texto ? [texto] : [];
  const janelas: string[] = [];
  let inicio = 0;
  // Não aceita corte antes da metade da janela: uma quebra de linha logo no
  // começo geraria uma janela minúscula e janelas demais.
  const minimo = Math.floor(tamanho / 2);
  while (texto.length - inicio > tamanho) {
    const trecho = texto.slice(inicio, inicio + tamanho);
    let corte = trecho.lastIndexOf("\n");
    if (corte < minimo) corte = Math.max(trecho.lastIndexOf(". "), trecho.lastIndexOf("? "), trecho.lastIndexOf("! "), trecho.lastIndexOf("。")) + 1;
    if (corte < minimo) corte = trecho.lastIndexOf(" ");
    if (corte < minimo) corte = tamanho - 1;
    janelas.push(texto.slice(inicio, inicio + corte + 1));
    inicio += corte + 1;
  }
  if (inicio < texto.length) janelas.push(texto.slice(inicio));
  return janelas;
}
