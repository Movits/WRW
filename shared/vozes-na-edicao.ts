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
 * - no trecho que a dona não mudou, pela posição: o começo e o fim que o texto
 *   editado tem em comum com o texto exibido do original dizem onde cada voz
 *   ficou, e o rótulo volta ali, mesmo colado à palavra vizinha (o japonês e
 *   o chinês não separam as palavras: "{F1}さんが"; o árabe e o alemão colam
 *   partícula ao nome: "و{F2}", "{F1}s Vorschlag") e mesmo com duas vozes do
 *   mesmo nome. O texto que era texto continua texto. A voz encostada no
 *   trecho mudado só volta se o vizinho novo ainda a separa: "Ana" que virou
 *   "Anabela" fica como texto;
 * - no trecho mudado, pela palavra, só as vozes que o item já citava. Um nome
 *   digitado à mão fica como texto: pode ser outra pessoa com o mesmo nome de
 *   uma voz. O que a tela mostra igual para duas vozes (duas "Ana") também.
 *   E só a palavra inteira: "Ana" não vira rótulo dentro de "Anastácia", nem
 *   "Falante 1" dentro de "Falante 12";
 * - no responsável, também o campo inteiro igual ao que a tela mostra para uma
 *   voz da reunião (a dona escolheu a voz na lista).
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
const LETRA = new RegExp("^[\\p{L}\\p{N}\\p{M}]$", "u");
// As escritas sem espaço entre as palavras (o chinês e o japonês): nelas, o
// nome colado ao vizinho é o normal.
const SEM_ESPACO = new RegExp("[\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}]", "u");
// As partículas de uma letra que o árabe cola antes do nome ("و{F2}": "e Ali").
const PARTICULAS_ARABES = new Set(["و", "ف", "ب", "ل", "ك"]);

type VozExibida = { falante: string; inicio: number; fim: number };

/** O texto como a tela o mostra e onde cada voz ficou nele. */
function exibidoComVozes(texto: string, exibir: ExibirVoz): { exibido: string; vozes: VozExibida[] } {
  // Montado por partes, e não por replace com texto de troca: um nome com
  // "$&" entraria trocado.
  let exibido = "";
  let lido = 0;
  const vozes: VozExibida[] = [];
  for (const rotulo of Array.from(texto.matchAll(ROTULO_DE_VOZ))) {
    const indice = rotulo.index ?? 0;
    const nome = exibir(rotulo[1]);
    exibido += texto.slice(lido, indice);
    vozes.push({ falante: rotulo[1], inicio: exibido.length, fim: exibido.length + nome.length });
    exibido += nome;
    lido = indice + rotulo[0].length;
  }
  return { exibido: exibido + texto.slice(lido), vozes };
}

/** O texto como a tela o mostra: cada rótulo trocado pelo que `exibir` devolve. */
export function textoExibido(texto: string, exibir: ExibirVoz): string {
  return exibidoComVozes(texto, exibir).exibido;
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

// O caractere inteiro (a letra fora do plano básico ocupa dois) que termina em
// `fim` e o que começa em `inicio`; vazio na ponta do texto.
const caractereAntes = (texto: string, fim: number) => Array.from(texto.slice(Math.max(0, fim - 2), fim)).pop() ?? "";
const caractereDepois = (texto: string, inicio: number) => Array.from(texto.slice(inicio, inicio + 2))[0] ?? "";

/**
 * Os dois caracteres, um de cada lado da borda, ficam em palavras diferentes:
 * a ponta do texto, um deles que não é letra (a marca conta como letra, como
 * na palavra inteira), ou um deles de escrita sem espaço.
 */
function separa(antes: string, depois: string): boolean {
  if (!antes || !depois) return true;
  return !LETRA.test(antes) || !LETRA.test(depois) || SEM_ESPACO.test(antes) || SEM_ESPACO.test(depois);
}

/** A voz que começa em `inicio` está separada do que vem antes, ou só pela partícula árabe colada. */
function separadaAntes(texto: string, inicio: number): boolean {
  const antes = caractereAntes(texto, inicio);
  if (separa(antes, caractereDepois(texto, inicio))) return true;
  return PARTICULAS_ARABES.has(antes) && separa(caractereAntes(texto, inicio - antes.length), antes);
}

/** A voz que termina em `fim` está separada do que vem depois. */
const separadaDepois = (texto: string, fim: number) => separa(caractereAntes(texto, fim), caractereDepois(texto, fim));

const ehMetadeAlta = (codigo: number) => codigo >= 0xd800 && codigo <= 0xdbff;
const ehMetadeBaixa = (codigo: number) => codigo >= 0xdc00 && codigo <= 0xdfff;

/**
 * O texto editado (já aparado) com os rótulos de volta: pela posição no
 * trecho que a dona não mudou, pela palavra no trecho mudado (a regra do
 * comentário do topo).
 */
function rotulosDeVolta(editado: string, original: string | null | undefined, exibir: ExibirVoz): string {
  if (!original) return editado;
  // O original vem aparado do banco (o da IA e o da dona), e o nome da voz
  // também: o exibido se compara direto com o editado aparado.
  const { exibido, vozes } = exibidoComVozes(original, exibir);

  // O começo e o fim em comum, sem partir a letra que ocupa dois caracteres.
  const limite = Math.min(exibido.length, editado.length);
  let comeco = 0;
  while (comeco < limite && exibido[comeco] === editado[comeco]) comeco++;
  if (comeco > 0 && ehMetadeAlta(editado.charCodeAt(comeco - 1))) comeco--;
  let fim = 0;
  while (fim < limite - comeco && exibido[exibido.length - 1 - fim] === editado[editado.length - 1 - fim]) fim++;
  if (fim > 0 && ehMetadeBaixa(editado.charCodeAt(editado.length - fim))) fim--;
  // O trecho mudado: [comeco, fimDoMudado) no editado.
  const fimDoMudado = editado.length - fim;
  const desvio = editado.length - exibido.length;

  // As vozes que voltam pela posição, pelo início delas no editado.
  const pelaPosicao = new Map<number, VozExibida>();
  for (const { falante, inicio, fim: termino } of vozes) {
    // A voz que a tela mostra vazia não tem posição.
    if (termino <= inicio) continue;
    if (termino <= comeco) {
      // No começo em comum; encostada no trecho mudado, o vizinho novo tem de separá-la.
      if (termino < comeco || separadaDepois(editado, termino)) pelaPosicao.set(inicio, { falante, inicio, fim: termino });
    } else if (inicio >= exibido.length - fim) {
      // No fim em comum, deslocada pela diferença de tamanho.
      const noEditado = inicio + desvio;
      if (noEditado > fimDoMudado || separadaAntes(editado, noEditado)) pelaPosicao.set(noEditado, { falante, inicio: noEditado, fim: termino + desvio });
    }
  }

  const pelaPalavra = trocaveis(vozesCitadas(original), exibir);
  let saida = "";
  let i = 0;
  while (i < editado.length) {
    const fixa = pelaPosicao.get(i);
    // A palavra inteira de uma voz que o item citava, dentro do trecho mudado
    // ou atravessando a borda dele. O nome mais longo vence ("Ana Paula" sobre
    // a "Ana" que estava ali).
    const palavra = pelaPalavra.find(c => i < fimDoMudado && i + c.exibido.length > comeco
      && editado.startsWith(c.exibido, i) && palavraInteira(editado, i, i + c.exibido.length));
    if (palavra && (!fixa || palavra.exibido.length > fixa.fim - fixa.inicio)) {
      saida += `{${palavra.falante}}`;
      i += palavra.exibido.length;
    } else if (fixa) {
      saida += `{${fixa.falante}}`;
      i = fixa.fim;
    } else {
      saida += editado[i];
      i += 1;
    }
  }
  return saida;
}

/**
 * O texto (ou o assunto) que a dona salvou, aparado e com os rótulos de volta
 * onde estavam as vozes do original. Sem original (o item novo), o texto fica
 * como ela escreveu.
 */
export function textoDeVolta(editado: string, original: string | null | undefined, exibir: ExibirVoz): string {
  const aparado = editado.trim();
  if (original && aparado === textoExibido(original, exibir).trim()) return original;
  return rotulosDeVolta(aparado, original, exibir);
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
  return rotulosDeVolta(aparado, original, exibir);
}
