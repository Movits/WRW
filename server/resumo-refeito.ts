import { ORDEM_DAS_SECOES, SECOES_DE_UM_ITEM, type ItemDoResumo, type SecaoDoResumo } from "./resumo-da-reuniao";
import { normalizarParaComparar } from "./trecho-da-transcricao";

/**
 * O resumo refeito com outro modelo (H4d, "Refazer como…"): os itens que a
 * dona confirmou, as ações que marcou como feitas e os que ela escreveu (H4f)
 * ficam; os pendentes e os ignorados da IA saem, e entram os itens novos da
 * IA. Esta função só decide a ordem e o que entra; quem lê e grava é a fila
 * do resumo (server/fila-do-resumo.ts), numa transação.
 */

// O status vem quando o item que fica pode estar ignorado: o item que a dona
// escreveu (H4f) fica no resumo refeito mesmo ignorado, recolhido.
export type ItemQueFica = { id: string; section: SecaoDoResumo; position: number; text: string; status?: string };

const chave = (secao: SecaoDoResumo, texto: string) => `${secao}\u0000${normalizarParaComparar(texto)}`;

/**
 * A numeração nova do resumo, na ordem das seções do formato: em cada seção,
 * primeiro os itens que ficam (na ordem em que já estavam), depois os novos
 * (na ordem da IA). Um item novo que repete um que fica (mesma seção e o mesmo
 * texto, sem contar maiúsculas, pontuação e espaços) não entra: a dona já o
 * confirmou, ou escreveu e ignorou. Na seção de um item só (o foco), o que
 * fica à vista ocupa o lugar: o foco novo, escrito com outras palavras, também
 * não entra; o foco que a dona ignorou não ocupa.
 *
 * O item novo que repete um ignorado da IA que sai (mesma seção e mesmo texto,
 * pela mesma comparação) volta como pendente, marcado `voltouDoIgnorado`
 * (decisão 3 da PR #217): a tela avisa que a dona o tinha ignorado e que a IA
 * o trouxe de novo. Sem a marca, ele chegava como um item novo qualquer, e a
 * lista dos ignorados sumia sem explicação (defeito do teste manual T29,
 * 25/11). O repetido com outras palavras não é reconhecido: entra como novo.
 */
export function numeracaoDoResumoRefeito(
  queFicam: readonly ItemQueFica[],
  novos: readonly ItemDoResumo[],
  ignoradosQueSaem: ReadonlyArray<{ section: SecaoDoResumo; text: string }> = [],
): { queFicam: Array<{ id: string; position: number }>; novos: Array<ItemDoResumo & { position: number; voltouDoIgnorado: boolean }> } {
  const ignorados = new Set(ignoradosQueSaem.map(item => chave(item.section, item.text)));
  const jaNoResumo = new Set(queFicam.map(item => chave(item.section, item.text)));
  const secoesOcupadas = new Set(queFicam.filter(item => item.status !== "ignored").map(item => item.section).filter(secao => SECOES_DE_UM_ITEM.has(secao)));
  const entram = novos.filter(item => !jaNoResumo.has(chave(item.section, item.text)) && !secoesOcupadas.has(item.section));
  const numerados = { queFicam: [] as Array<{ id: string; position: number }>, novos: [] as Array<ItemDoResumo & { position: number; voltouDoIgnorado: boolean }> };
  let position = 0;
  for (const secao of ORDEM_DAS_SECOES) {
    const ficamNaSecao = queFicam.filter(item => item.section === secao).sort((a, b) => a.position - b.position);
    for (const item of ficamNaSecao) numerados.queFicam.push({ id: item.id, position: position++ });
    for (const item of entram.filter(novo => novo.section === secao)) numerados.novos.push({ ...item, position: position++, voltouDoIgnorado: ignorados.has(chave(item.section, item.text)) });
  }
  return numerados;
}
