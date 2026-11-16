/**
 * O caminho de volta dos rótulos de voz, para a dona editar um item do resumo
 * guardado (H4f do pacote do gravador). A tela mostra o item com o nome que a
 * dona deu à voz, ou "Falante n", no lugar do rótulo ({F2}:
 * shared/vozes-no-texto.ts); a dona edita o que vê, e o que ela salva volta a
 * levar o rótulo onde estava a voz. Assim o nome continua resolvido na
 * leitura: dar outro nome à voz muda o item, e o link aberto segue a regra
 * dele para as vozes.
 *
 * Só volta a rótulo o que é inequívoco:
 * - no texto e no assunto, só as vozes que o item já citava. Um nome digitado
 *   à mão fica como texto: pode ser outra pessoa com o mesmo nome de uma voz;
 * - no responsável, também o campo inteiro igual ao que a tela mostra para uma
 *   voz da reunião (a dona escolheu a voz na lista);
 * - o que a tela mostra igual para duas vozes (duas "Ana") fica como texto;
 * - só a palavra inteira: "Ana" não vira rótulo dentro de "Anastácia", nem
 *   "Falante 1" dentro de "Falante 12".
 * Sem mudança no que a tela mostrava, o original volta intacto.
 *
 * `exibir` é o que a tela mostra no lugar de uma voz (o nome ou o "Falante n"
 * traduzido): o mesmo de vozesNoTexto, vindo de quem chama, porque aqui não há
 * i18n (shared/CLAUDE.md).
 */

export type ExibirVoz = (falante: string) => string;

const ROTULO_DE_VOZ = /\{(F[1-9][0-9]?)\}/g;
const SO_O_ROTULO = /^\{(F[1-9][0-9]?)\}$/;
// Pelo construtor: o alvo do tsconfig não aceita a flag u num literal. A marca
// (\p{M}) conta como letra: o acento combinado e as vogais do híndi.
const LETRA_NO_FIM = new RegExp("[\\p{L}\\p{N}\\p{M}]$", "u");
const LETRA_NO_INICIO = new RegExp("^[\\p{L}\\p{N}\\p{M}]", "u");

/** O texto como a tela o mostra: cada rótulo trocado pelo que `exibir` devolve. */
export function textoExibido(texto: string, exibir: ExibirVoz): string {
  // Por função, e não por texto de troca: um nome com "$&" entraria trocado.
  return texto.replace(ROTULO_DE_VOZ, (_rotulo, falante: string) => exibir(falante));
}

/** As vozes que o texto cita, uma vez cada, na ordem em que aparecem. */
export function vozesCitadas(texto: string | null | undefined): string[] {
  const vozes: string[] = [];
  for (const [, falante] of Array.from((texto ?? "").matchAll(ROTULO_DE_VOZ))) {
    if (!vozes.includes(falante)) vozes.push(falante);
  }
  return vozes;
}

/** Cada texto exibido que pertence a uma voz só, do mais longo para o mais curto. */
function trocaveis(vozes: readonly string[], exibir: ExibirVoz): Array<{ falante: string; exibido: string }> {
  const porExibido = new Map<string, Set<string>>();
  for (const falante of vozes) {
    const exibido = exibir(falante).trim();
    if (!exibido) continue;
    const falantes = porExibido.get(exibido) ?? new Set<string>();
    falantes.add(falante);
    porExibido.set(exibido, falantes);
  }
  return Array.from(porExibido.entries())
    .filter(([, falantes]) => falantes.size === 1)
    .map(([exibido, falantes]) => ({ exibido, falante: Array.from(falantes)[0] }))
    .sort((a, b) => b.exibido.length - a.exibido.length);
}

function palavraInteira(texto: string, inicio: number, fim: number): boolean {
  // Dois caracteres de cada lado: a letra fora do plano básico ocupa dois.
  return !LETRA_NO_FIM.test(texto.slice(Math.max(0, inicio - 2), inicio)) && !LETRA_NO_INICIO.test(texto.slice(fim, fim + 2));
}

function trocarPorRotulos(texto: string, vozes: readonly string[], exibir: ExibirVoz): string {
  const candidatas = trocaveis(vozes, exibir);
  if (!candidatas.length) return texto;
  let saida = "";
  let i = 0;
  while (i < texto.length) {
    const voz = candidatas.find(c => texto.startsWith(c.exibido, i) && palavraInteira(texto, i, i + c.exibido.length));
    if (voz) {
      saida += `{${voz.falante}}`;
      i += voz.exibido.length;
    } else {
      saida += texto[i];
      i += 1;
    }
  }
  return saida;
}

/**
 * O texto (ou o assunto) que a dona salvou, aparado e com os rótulos de volta
 * onde estavam as vozes que o original citava. Sem original (o item novo), o
 * texto fica como ela escreveu.
 */
export function textoDeVolta(editado: string, original: string | null | undefined, exibir: ExibirVoz): string {
  const aparado = editado.trim();
  if (original && aparado === textoExibido(original, exibir).trim()) return original;
  return trocarPorRotulos(aparado, vozesCitadas(original), exibir);
}

/**
 * O responsável que a dona salvou. O campo inteiro igual ao que a tela mostra
 * para uma voz só, entre as da reunião (`vozes`) e as que o original citava,
 * vira o rótulo dela; senão vale a regra do texto. Vazio: nulo.
 */
export function responsavelDeVolta(editado: string, original: string | null | undefined, vozes: readonly string[], exibir: ExibirVoz): string | null {
  const aparado = editado.trim();
  if (!aparado) return null;
  if (original && aparado === textoExibido(original, exibir).trim()) return original;
  const todas = Array.from(new Set([...vozes, ...vozesCitadas(original)]));
  const inteira = trocarPorRotulos(aparado, todas, exibir);
  if (SO_O_ROTULO.test(inteira)) return inteira;
  return trocarPorRotulos(aparado, vozesCitadas(original), exibir);
}
