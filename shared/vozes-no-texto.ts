/**
 * Os rótulos de voz que a IA escreve no resumo guardado ("{F2} ficou de enviar
 * a proposta"), trocados pelo que a tela mostra (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md). O servidor nunca resolve o nome:
 * o banco guarda o rótulo, e quem lê decide.
 *
 * - O nome que a dona deu à voz (o mapa de meetings.speaker_names, lido por
 *   nomesDosFalantes, de shared/const.ts): na tela dela e no link aberto, que
 *   recebe os nomes só quando foi ligado com a confirmação que fala deles (H3b,
 *   o `vozes` de reuniaoAberta.ver).
 * - Sem nome: o rótulo traduzido ("Falante 2"). Ele chega pronto, de quem
 *   chama: aqui não há i18n, porque o mesmo código roda no servidor
 *   (shared/CLAUDE.md).
 *
 * Só o rótulo exato vira nome: {F1} a {F99}, com as chaves. "F1" solto, {F0} e
 * {f1} ficam como estão.
 */
const ROTULO_DE_VOZ = /\{(F[1-9][0-9]?)\}/g;

export function vozesNoTexto(
  texto: string,
  nomes: Readonly<Record<string, string>>,
  rotuloDaVoz: (numero: number) => string,
): string {
  // A troca é por função, e não por texto: um nome com "$&" ou "$1" sairia
  // trocado pelo próprio rótulo.
  return texto.replace(ROTULO_DE_VOZ, (_rotulo, falante: string) => nomes[falante]?.trim() || rotuloDaVoz(Number(falante.slice(1))));
}

/** Um pedaço do texto: o que a IA escreveu, ou o nome (ou o rótulo traduzido) de uma voz. */
export type ParteDoTextoComVozes = { texto: string; voz: boolean };

/**
 * A mesma troca de vozesNoTexto, em pedaços: cada voz vem separada do resto,
 * para a tela isolar a direção dela (<bdi>). O rótulo traduzido de uma voz num
 * idioma da direita para a esquerda ("المتحدث 2") no começo de um item escrito
 * em inglês viraria a direção do parágrafo inteiro, e o ponto final iria para o
 * lado errado. Juntos, os pedaços dão o mesmo texto que vozesNoTexto.
 */
export function partesComVozes(
  texto: string,
  nomes: Readonly<Record<string, string>>,
  rotuloDaVoz: (numero: number) => string,
): ParteDoTextoComVozes[] {
  const partes: ParteDoTextoComVozes[] = [];
  let de = 0;
  for (const achado of Array.from(texto.matchAll(ROTULO_DE_VOZ))) {
    const inicio = achado.index ?? 0;
    if (inicio > de) partes.push({ texto: texto.slice(de, inicio), voz: false });
    const falante = achado[1];
    partes.push({ texto: nomes[falante]?.trim() || rotuloDaVoz(Number(falante.slice(1))), voz: true });
    de = inicio + achado[0].length;
  }
  if (de < texto.length) partes.push({ texto: texto.slice(de), voz: false });
  return partes;
}
