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
