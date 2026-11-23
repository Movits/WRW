/**
 * Editar a transcrição (H18 da auditoria de 16/11; HN-23 e HN-27 do app de
 * referência da cliente): a dona corrige o texto de um trecho, troca a voz de
 * um trecho, localiza e substitui em todos os trechos, e volta um trecho (ou
 * tudo) ao que a IA escreveu. Quem grava é server/editar-transcricao.ts; aqui
 * ficam os tetos, os códigos das recusas e as contas que a tela e o servidor
 * fazem do mesmo jeito (shared/CLAUDE.md: nada de banco, rede ou ambiente).
 *
 * A transcrição em falas (a gravação em partes e o vídeo do YouTube) se edita
 * trecho a trecho; a de texto corrido (o envio único de antes das partes), como
 * um texto só. O documento (PDF ou fotos) não se edita aqui: o texto lido segue
 * como a IA o leu.
 */

/** O texto de um trecho que a dona escreve. Um trecho da IA passa disso só numa fala de muitos minutos seguidos. */
export const TEXTO_DO_TRECHO_MAX = 20_000;
/** O texto corrido inteiro (a transcrição sem falas): o mesmo teto da entrada do resumo. */
export const TEXTO_CORRIDO_MAX = 400_000;
/** O que localizar e o que pôr no lugar. */
export const LOCALIZAR_MAX = 200;
export const SUBSTITUIR_POR_MAX = 200;
/**
 * O teto de edições por dona: cada uma regrava as falas da reunião inteira e
 * uma linha de auditoria. 200 a cada 10 minutos cabem com folga numa revisão
 * feita à mão, trecho a trecho.
 */
export const EDICOES_POR_JANELA = 200;
export const JANELA_DA_EDICAO_MS = 10 * 60_000;

/** A ação de auditoria de cada mudança na transcrição (na mesma transação dela). */
export const ACAO_TRANSCRICAO_EDITADA = "MEETING_TRANSCRIPT_EDITED";

/**
 * As recusas da edição, como CÓDIGO (a tela traduz):
 * - FORA_DO_ESTADO: a reunião não está pronta (gravando, processando, juntando
 *   ou com falha): a transcrição ainda vai ser trocada;
 * - DOCUMENTO: a reunião nasceu de um PDF ou de fotos;
 * - MUDOU: a transcrição mudou desde que a tela a leu (outra aba editou, ou a
 *   reunião foi juntada a outra e a transcrição foi refeita);
 * - TRECHO: o trecho não existe, é o trecho que não chegou, ou o pedido não
 *   serve a esta transcrição (o texto corrido numa transcrição em falas);
 * - VAZIO: o trecho, ou o texto corrido, ficaria sem texto nenhum;
 * - DEMAIS: o teto de edições por dona.
 */
export const RECUSAS_DA_EDICAO = {
  foraDoEstado: "EDICAO_FORA_DO_ESTADO",
  documento: "EDICAO_DE_DOCUMENTO",
  mudou: "EDICAO_TRANSCRICAO_MUDOU",
  trecho: "EDICAO_TRECHO_INVALIDO",
  vazio: "EDICAO_TRECHO_VAZIO",
  demais: "EDICOES_DEMAIS",
} as const;
export type CodigoDaRecusaDaEdicao = (typeof RECUSAS_DA_EDICAO)[keyof typeof RECUSAS_DA_EDICAO];

/** O que a dona pode pedir. `indice` é a posição do trecho entre as falas da transcrição (as do contrato do segmento). */
export type OperacaoDaEdicao =
  | { tipo: "texto"; indice: number; texto: string }
  | { tipo: "voz"; indice: number; falante: string }
  | { tipo: "substituir"; localizar: string; substituirPor: string; diferenciarMaiusculas?: boolean }
  | { tipo: "textoCorrido"; texto: string }
  | { tipo: "restaurar"; indice: number }
  | { tipo: "restaurarTudo" };

// Os caracteres que a expressão regular lê como sintaxe. Escapar só eles vale
// também com a flag u, que recusa o escape de qualquer outro.
const SINTAXE_DA_EXPRESSAO = /[.*+?^${}()|[\]\\]/g;

/**
 * A expressão que acha o texto literal: o que a dona digita nunca é lido como
 * expressão ("R$ 10" acha "R$ 10"). Sem diferenciar maiúsculas, "glenta" acha
 * "Glenta" e "GLENTA", em qualquer escrita (a flag u dobra as letras fora do
 * alfabeto latino básico, como "Ç" e "Ж"). Pelo construtor: o alvo do tsconfig
 * não aceita a flag u num literal.
 */
function expressaoDoLiteral(localizar: string, diferenciarMaiusculas: boolean): RegExp {
  return new RegExp(localizar.replace(SINTAXE_DA_EXPRESSAO, "\\$&"), diferenciarMaiusculas ? "gu" : "giu");
}

/** Quantas vezes o texto literal aparece (sem sobrepor), como na substituição. */
export function contarNoTexto(texto: string, localizar: string, diferenciarMaiusculas = false): number {
  if (!localizar) return 0;
  return Array.from(texto.matchAll(expressaoDoLiteral(localizar, diferenciarMaiusculas))).length;
}

/**
 * Troca cada ocorrência do texto literal pelo novo, também literal: "$&" no
 * texto novo entra como está (a troca é por função, e não por texto de troca).
 */
export function substituirNoTexto(texto: string, localizar: string, substituirPor: string, diferenciarMaiusculas = false): { texto: string; quantas: number } {
  if (!localizar) return { texto, quantas: 0 };
  let quantas = 0;
  const novo = texto.replace(expressaoDoLiteral(localizar, diferenciarMaiusculas), () => {
    quantas += 1;
    return substituirPor;
  });
  return { texto: novo, quantas };
}

/**
 * A próxima voz livre, para "Nova voz": o primeiro rótulo depois do maior já
 * usado (F1 a F99), ou null quando as 99 já existem.
 */
export function proximaVozLivre(falantes: readonly string[]): string | null {
  let maior = 0;
  for (const falante of falantes) {
    const numero = /^F([1-9][0-9]?)$/.exec(falante);
    if (numero) maior = Math.max(maior, Number(numero[1]));
  }
  return maior < 99 ? `F${maior + 1}` : null;
}
